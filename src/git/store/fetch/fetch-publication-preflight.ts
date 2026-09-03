import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { expectSafeInteger } from "../../common/rows.js";
import { rawSymbolicTarget } from "../refs/ref-validation.js";
import type { NormalizedRefMutation, RefTable } from "../refs/refs.js";
import { MAX_REFLOG_STATE_ROWS } from "../schema/reflog-schema.js";
import type { FetchPublicationOptions, FetchPublicationState } from "./fetch-publication-state.js";
import { requireFetchGeneration, staleFetch } from "./fetch-publication-state.js";

export function preflightFetchPublication(
  db: SqlDatabase,
  repoId: number,
  refs: RefTable,
  options: FetchPublicationOptions,
  state: FetchPublicationState,
  publication: NormalizedRefMutation,
  shallowTouched: boolean,
): void {
  const namespace = db.one<{ latest_generation: unknown; revision: unknown }>(
    `SELECT latest_generation, revision FROM git_fetch_namespaces
        WHERE repo_id = ? AND tracking_prefix = ?`,
    repoId,
    state.trackingPrefix,
  );
  if (namespace === undefined) throw staleFetch("fetch tracking namespace disappeared");
  const latestGeneration = requireFetchGeneration(
    namespace.latest_generation,
    "stored fetch namespace generation",
    1,
  );
  const revision = requireFetchGeneration(namespace.revision, "stored fetch namespace revision", 0);
  if (latestGeneration !== state.generation) {
    throw staleFetch("a newer fetch has fenced this tracking namespace");
  }
  if (revision !== state.namespaceRevision) {
    throw staleFetch("the tracking namespace changed after fetch discovery");
  }
  if (shallowTouched) {
    const shallowRevision = db.scalar<unknown>(
      "SELECT shallow_revision FROM git_repositories WHERE id = ?",
      repoId,
    );
    if (
      requireFetchGeneration(shallowRevision, "stored shallow revision", 0) !==
      state.shallowRevision
    ) {
      throw staleFetch("the shallow boundary changed after fetch discovery");
    }
  }

  const selectedExactRefs = new Set<string>();
  for (const name of publication.puts.keys()) {
    if (state.exactRefs.has(name)) selectedExactRefs.add(name);
  }
  const selectedBranches = new Set(
    [...selectedExactRefs].filter((name) => name.startsWith("refs/heads/")),
  );
  if (selectedBranches.size > 0) {
    const checkoutRevision = db.scalar<unknown>(
      "SELECT checkout_revision FROM git_repositories WHERE id = ?",
      repoId,
    );
    if (checkoutRevision === undefined) {
      throw new CorruptError("fetch checkout revision repository is missing");
    }
    if (
      expectSafeInteger(
        checkoutRevision,
        0,
        Number.MAX_SAFE_INTEGER,
        "stored checkout revision",
      ) !== state.checkoutRevision
    ) {
      throw staleFetch("the repository checkout state changed after fetch preflight");
    }
    for (const checkout of options.headOwner().readRefMutationHeads()) {
      const attached = rawSymbolicTarget(checkout.head);
      if (attached !== null && selectedBranches.has(attached)) {
        throw staleFetch(`branch ${attached} became attached after fetch preflight`);
      }
    }
  }
  const presentExactRefs = new Set<string>();
  let rows = 0;
  let trackingRows = 0;
  for (const { name, target } of refs.iterateRefs()) {
    rows++;
    if (rows > MAX_REFLOG_STATE_ROWS) {
      throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
    }
    if (name.startsWith(state.trackingPrefix)) {
      trackingRows++;
      if (state.trackingRefs.get(name) !== target) {
        throw staleFetch(`tracking ref ${name} changed after fetch discovery`);
      }
    }
    if (selectedExactRefs.has(name)) {
      const expected = state.exactRefs.get(name);
      if (expected !== target && publication.puts.get(name) !== target) {
        throw staleFetch(`exact ref ${name} changed after fetch discovery`);
      }
      presentExactRefs.add(name);
    }
  }
  if (trackingRows !== state.trackingRefs.size) {
    throw staleFetch("the tracking ref set changed after fetch discovery");
  }
  for (const name of selectedExactRefs) {
    if (state.exactRefs.get(name) !== null && !presentExactRefs.has(name)) {
      throw staleFetch(`exact ref ${name} changed after fetch discovery`);
    }
  }
}
