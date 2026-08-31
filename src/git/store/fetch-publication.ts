import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { hasCanonicalRefSyntax } from "../common/ref-name.js";
import { expectSafeInteger, expectText } from "../common/rows.js";
import type { FetchPublicationPlan, RefLogMetadata, RefRow } from "./contracts.js";
import { FetchPublicationToken, TrackingRefPublicationToken } from "./contracts.js";
import { jsonPages } from "./json-pages.js";
import {
  rawSymbolicTarget,
  refTextBytes,
  requireRawRefTarget,
  requireRefName,
} from "./ref-validation.js";
import { validateRefLogMetadata } from "./reflog.js";
import { MAX_REFLOG_STATE_ROWS } from "./reflog-schema.js";
import type {
  HeadOwner,
  NormalizedRefMutation,
  RefMutationRevisionState,
  RefMutationRevisions,
} from "./refs.js";
import { normalizeRefMutation, type RefTable } from "./refs.js";
import { MAX_TRACKING_REF_REVISIONS } from "./schema.js";
import { advanceShallowRevision } from "./shallow.js";

export const MAX_FETCH_NAMESPACES = 1_024;
export const MAX_FETCH_PUBLICATION_INPUTS = 100_000;

export interface FetchPublicationState {
  readonly generation: number;
  readonly trackingPrefix: string;
  readonly namespaceRevision: number;
  readonly shallowRevision: number;
  readonly shallow: readonly string[];
  readonly trackingRefs: ReadonlyMap<string, string>;
  readonly exactRefs: ReadonlyMap<string, string | null>;
  readonly checkoutRevision: number;
  disposed: boolean;
}

export interface TrackingRefPublicationState {
  readonly refName: string;
  readonly target: string | null;
  readonly refRevision: number;
  disposed: boolean;
}

export interface NormalizedFetchPublication {
  readonly refs: NormalizedRefMutation;
  readonly shallowAdd: readonly string[];
  readonly shallowRemove: readonly string[];
}

export interface FetchPublicationOptions {
  readonly headOwner: () => HeadOwner;
  readonly invalidateShallow: () => void;
  readonly bumpMaintenanceRootEpoch: () => void;
}

export function invalidFetchTrackingPrefix(_source: "input" | "stored"): never {
  throw new GitError("EINVAL", "fetch tracking prefix must identify refs/remotes/<remote>/");
}

export function requireFetchTrackingPrefix(value: unknown, source: "input" | "stored"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("refs/remotes/") ||
    value === "refs/remotes/" ||
    !value.endsWith("/")
  ) {
    invalidFetchTrackingPrefix(source);
  }
  refTextBytes(value, "fetch tracking prefix", source);
  if (!hasCanonicalRefSyntax(value, 0, value.length - 1)) {
    invalidFetchTrackingPrefix(source);
  }
  return value;
}

export function requireFetchGeneration(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function staleFetch(message: string): GitError {
  return new GitError("ESTALEFETCH", message);
}

export function normalizeFetchPublication(
  state: FetchPublicationState,
  plan: FetchPublicationPlan,
): NormalizedFetchPublication {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  const keep = new Set<string>();
  const remoteHeadName = `${state.trackingPrefix}HEAD`;
  let inputs = 0;
  const countInput = (name: string, label: string, target?: string): void => {
    inputs++;
    if (inputs > MAX_FETCH_PUBLICATION_INPUTS) {
      throw new GitError("E2BIG", "fetch publication exceeds its retained input count bound");
    }
    refTextBytes(name, label, "input");
    if (target !== undefined) refTextBytes(target, "fetch ref target", "input");
  };
  const trackingName = (value: unknown, label: string): string => {
    const name = requireRefName(value, label, "input");
    if (!name.startsWith(state.trackingPrefix) || name === remoteHeadName) {
      throw new GitError("EINVAL", `${label} is outside the issued tracking namespace`);
    }
    return name;
  };

  for (const row of plan.trackingPuts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "fetch tracking update row is invalid");
    }
    const name = trackingName(row.name, "fetch tracking ref name");
    const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
    countInput(name, "fetch tracking ref name", target);
    puts.set(name, target);
    keep.add(name);
  }
  const prune = plan.trackingKeep !== undefined;
  for (const value of plan.trackingKeep ?? []) {
    const name = trackingName(value, "advertised tracking ref name");
    countInput(name, "advertised tracking ref name");
    keep.add(name);
  }
  if (prune) {
    for (const name of state.trackingRefs.keys()) {
      if (name !== remoteHeadName && !keep.has(name)) deletes.add(name);
    }
  }

  if (plan.remoteHead !== undefined) {
    if (plan.remoteHead === null) {
      countInput(remoteHeadName, "remote HEAD ref name");
      deletes.add(remoteHeadName);
    } else {
      const target = requireRawRefTarget(plan.remoteHead, "remote HEAD target", "input");
      countInput(remoteHeadName, "remote HEAD ref name", target);
      puts.set(remoteHeadName, target);
    }
  }

  const exactPut = (row: RefRow, label: string, requireTag: boolean): void => {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", `${label} update row is invalid`);
    }
    const name = requireRefName(row.name, `${label} name`, "input");
    if (requireTag && !name.startsWith("refs/tags/")) {
      throw new GitError("EINVAL", `${label} ${name} is not a tag ref`);
    }
    const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
    if (!isOid(target)) {
      throw new GitError("EINVAL", `${label} ${name} must target an object id`);
    }
    if (!state.exactRefs.has(name)) {
      throw new GitError("EINVAL", `${label} ${name} was not included in the issued snapshot`);
    }
    if (puts.has(name) || deletes.has(name)) {
      throw new GitError("EINVAL", `fetch publication contains duplicate destination ${name}`);
    }
    countInput(name, `${label} name`, target);
    puts.set(name, target);
  };
  for (const row of plan.globalTagPuts ?? []) exactPut(row, "fetch global tag", true);
  for (const row of plan.exactPuts ?? []) exactPut(row, "fetch exact ref", false);

  const shallowAdd = new Set<string>();
  const shallowRemove = new Set<string>();
  const shallowOid = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !isOid(value)) {
      throw new GitError("EINVAL", `${label} must be a full object id`);
    }
    countInput(value, label);
    return value;
  };
  for (const value of plan.shallowAdd ?? []) {
    const oid = shallowOid(value, "shallow addition");
    if (shallowAdd.has(oid)) {
      throw new GitError("EINVAL", `duplicate shallow addition ${oid}`);
    }
    shallowAdd.add(oid);
  }
  for (const value of plan.shallowRemove ?? []) {
    const oid = shallowOid(value, "shallow deletion");
    if (shallowRemove.has(oid)) {
      throw new GitError("EINVAL", `duplicate shallow deletion ${oid}`);
    }
    if (!state.shallow.includes(oid)) {
      throw new GitError(
        "EINVAL",
        `shallow deletion ${oid} was not included in the issued snapshot`,
      );
    }
    if (shallowAdd.has(oid)) {
      throw new GitError("EINVAL", `fetch publication both adds and deletes shallow ${oid}`);
    }
    shallowRemove.add(oid);
  }

  return {
    refs: { puts, deletes, head: undefined, expected: undefined },
    shallowAdd: [...shallowAdd],
    shallowRemove: [...shallowRemove],
  };
}

export class FetchPublicationTable implements RefMutationRevisions {
  readonly #issuedFetchPublications = new WeakSet<FetchPublicationToken>();
  readonly #fetchPublicationStates = new WeakMap<FetchPublicationToken, FetchPublicationState>();
  readonly #issuedTrackingRefPublications = new WeakSet<TrackingRefPublicationToken>();
  readonly #trackingRefPublicationStates = new WeakMap<
    TrackingRefPublicationToken,
    TrackingRefPublicationState
  >();

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly refs: RefTable,
    private readonly options: FetchPublicationOptions,
  ) {}

  #readTrackingRefRevision(refName: string): number | null {
    const revision = this.db.scalar<unknown>(
      `SELECT revision FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND ref_name = ?`,
      this.repoId,
      refName,
    );
    return revision === undefined
      ? null
      : expectSafeInteger(revision, 0, Number.MAX_SAFE_INTEGER, "stored tracking ref revision");
  }

  #trackingRefRevisionCount(): number {
    const stored = this.db.scalar<unknown>(
      `SELECT count(*) FROM (
         SELECT 1 FROM git_tracking_ref_revisions
          WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
       )`,
      this.repoId,
    );
    return expectSafeInteger(stored, 0, MAX_TRACKING_REF_REVISIONS + 1, "tracking revision count");
  }

  #ensureTrackingRefRevision(refName: string): number {
    const count = this.#trackingRefRevisionCount();
    const existing = this.#readTrackingRefRevision(refName);
    if (existing !== null) return existing;
    if (count >= MAX_TRACKING_REF_REVISIONS) {
      throw new GitError("E2BIG", "repository tracking revision count exceeds 100,000");
    }
    this.db.run(
      `INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision)
       SELECT ?, ?, 0 WHERE EXISTS (SELECT 1 FROM git_repositories WHERE id = ?)`,
      this.repoId,
      refName,
      this.repoId,
    );
    const created = this.#readTrackingRefRevision(refName);
    if (created !== 0) throw new CorruptError("tracking revision creation failed");
    return created;
  }

  #advanceTrackingRefObservations(trackingPrefix: string, count: number): void {
    if (count === 0) return;
    const matched = expectSafeInteger(
      this.db.scalar<unknown>(
        `SELECT count(*) FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?`,
        this.repoId,
        trackingPrefix,
        trackingPrefix,
      ),
      0,
      count,
      "tracking observation count",
    );
    if (matched === 0) return;
    this.db.run(
      `UPDATE git_tracking_ref_revisions SET revision = revision + 1
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?
          AND revision < ${Number.MAX_SAFE_INTEGER}`,
      this.repoId,
      trackingPrefix,
      trackingPrefix,
    );
    const changed = expectSafeInteger(this.db.scalar<unknown>("SELECT changes()"), 0, matched);
    if (changed !== matched) throw new GitError("E2BIG", "tracking ref revision is exhausted");
  }

  bumpTrackingRefRevisions(changedNames: ReadonlySet<string>): void {
    if (changedNames.size === 0) return;
    for (const page of jsonPages(changedNames, "tracking ref revision lookup")) {
      const affected = expectSafeInteger(
        this.db.scalar<unknown>(
          `SELECT count(*) FROM git_tracking_ref_revisions
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))`,
          this.repoId,
          page,
        ),
        0,
      );
      if (affected === 0) continue;
      this.db.run(
        `UPDATE git_tracking_ref_revisions SET revision = revision + 1
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))
            AND revision < ${Number.MAX_SAFE_INTEGER}`,
        this.repoId,
        page,
      );
      const changed = expectSafeInteger(this.db.scalar<unknown>("SELECT changes()"), 0, affected);
      if (changed !== affected) throw new GitError("E2BIG", "tracking ref revision is exhausted");
    }
  }

  /** Snapshot one exact tracking ref after every earlier fetch observation. */
  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    const prefix = requireFetchTrackingPrefix(trackingPrefix, "input");
    const name = requireRefName(refName, "tracking publication ref", "input");
    if (!name.startsWith(prefix) || (name.length === prefix.length + 4 && name.endsWith("HEAD"))) {
      throw new GitError("EINVAL", "tracking publication ref is outside its branch namespace");
    }
    const snapshot = this.db.transactionSync(() => {
      const refRevision = this.#ensureTrackingRefRevision(name);
      const target = this.refs.getRef(name, "stored tracking target");
      return { refName: name, target, refRevision, disposed: false };
    });
    let issuedToken: TrackingRefPublicationToken | null = null;
    const token = new TrackingRefPublicationToken(
      prefix,
      snapshot.refName,
      snapshot.target,
      () => snapshot.disposed,
      () => {
        if (snapshot.disposed) return;
        snapshot.disposed = true;
        if (issuedToken !== null) {
          this.#issuedTrackingRefPublications.delete(issuedToken);
          this.#trackingRefPublicationStates.delete(issuedToken);
        }
      },
    );
    issuedToken = token;
    this.#issuedTrackingRefPublications.add(token);
    this.#trackingRefPublicationStates.set(token, snapshot);
    return token;
  }

  /** Publish one tracking result unless its exact observation is stale. */
  publishTrackingRef(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    if (!this.#issuedTrackingRefPublications.has(token)) {
      throw staleFetch("tracking publication token was not issued by this repository");
    }
    const state = this.#trackingRefPublicationStates.get(token);
    if (state === undefined || state.disposed) {
      throw staleFetch("tracking publication token is no longer active");
    }
    try {
      const normalized = normalizeRefMutation({
        puts: target === null ? [] : [{ name: state.refName, target }],
        deletes: target === null ? [state.refName] : [],
        expected: { name: state.refName, target: state.target },
      });
      const checkedMetadata = validateRefLogMetadata(metadata);
      const changed = this.db.transactionSync(() => {
        const refRevision = this.#readTrackingRefRevision(state.refName);
        if (refRevision !== state.refRevision) {
          throw staleFetch("the tracking ref changed after observation");
        }
        const refChanged = this.refs.mutateNormalized(
          this.options.headOwner(),
          normalized,
          checkedMetadata,
        );
        if (!refChanged) {
          this.bumpTrackingRefRevisions(new Set([state.refName]));
          this.bumpFetchNamespaceRevisions(new Set([state.refName]));
        }
        return refChanged;
      });
      this.#issuedTrackingRefPublications.delete(token);
      this.#trackingRefPublicationStates.delete(token);
      return changed;
    } catch (error) {
      if (hasErrorCode(error, "ESTALEHEAD")) {
        throw staleFetch(`tracking ref ${state.refName} changed after observation`);
      }
      throw error;
    }
  }

  /** Fence one remote-tracking namespace and retain its exact publication snapshot. */
  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    const prefix = requireFetchTrackingPrefix(trackingPrefix, "input");
    const candidates = new Map<string, string | null>();
    let candidateInputs = 0;
    for (const value of candidateExactRefs) {
      candidateInputs++;
      if (candidateInputs > MAX_FETCH_PUBLICATION_INPUTS) {
        throw new GitError("E2BIG", "fetch exact candidate count exceeds 100,000");
      }
      const name = requireRefName(value, "fetch exact ref candidate", "input");
      if (!name.startsWith("refs/")) {
        throw new GitError("EINVAL", "fetch exact ref candidates must be full refs");
      }
      if (candidates.has(name)) {
        throw new GitError("EINVAL", `duplicate fetch exact ref candidate ${name}`);
      }
      candidates.set(name, null);
    }

    const snapshot = this.db.transactionSync(() => {
      const repository = this.db.one<Record<string, unknown>>(
        `SELECT fetch_generation, shallow_revision, checkout_revision,
                  (SELECT count(*) FROM (
                     SELECT 1 FROM git_tracking_ref_revisions
                      WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
                   )) AS tracking_ref_revision_rows
             FROM git_repositories WHERE id = ?`,
        this.repoId,
        this.repoId,
      );
      if (repository === undefined) throw new CorruptError("fetch repository is missing");
      const currentGeneration = expectSafeInteger(
        repository.fetch_generation,
        0,
        Number.MAX_SAFE_INTEGER,
        "stored fetch generation",
      );
      const shallowRevision = expectSafeInteger(
        repository.shallow_revision,
        0,
        Number.MAX_SAFE_INTEGER,
        "stored shallow revision",
      );
      const checkoutRevision = expectSafeInteger(
        repository.checkout_revision,
        0,
        Number.MAX_SAFE_INTEGER,
        "stored checkout revision",
      );
      if (currentGeneration === Number.MAX_SAFE_INTEGER) {
        throw new GitError("E2BIG", "fetch publication generation is exhausted");
      }
      const trackingRefRevisionCount = expectSafeInteger(
        repository.tracking_ref_revision_rows,
        0,
        MAX_TRACKING_REF_REVISIONS + 1,
        "stored tracking ref revision count",
      );
      if (trackingRefRevisionCount > MAX_TRACKING_REF_REVISIONS) {
        throw new CorruptError("tracking ref revision count exceeds its bound");
      }

      this.#advanceTrackingRefObservations(prefix, trackingRefRevisionCount);

      const namespaces = this.#readFetchNamespaces();
      for (const namespace of namespaces) {
        if (namespace.latestGeneration > currentGeneration) {
          throw new CorruptError("fetch namespace generation exceeds its repository control");
        }
      }
      const exact = namespaces.find((namespace) => namespace.trackingPrefix === prefix);
      if (exact === undefined && namespaces.length >= MAX_FETCH_NAMESPACES) {
        throw new GitError("E2BIG", "repository fetch namespace count exceeds 1,024");
      }

      const tracking = new Map<string, string>();
      const trackingRows: Readonly<RefRow>[] = [];
      let rows = 0;
      for (const { name, target } of this.refs.iterateRefs()) {
        rows++;
        if (rows > MAX_REFLOG_STATE_ROWS) {
          throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
        }
        if (name.startsWith(prefix)) {
          if (candidateInputs + tracking.size >= MAX_FETCH_PUBLICATION_INPUTS) {
            throw new GitError("E2BIG", "fetch snapshot exceeds its retained input count bound");
          }
          tracking.set(name, target);
          trackingRows.push(Object.freeze({ name, target }));
        }
        if (candidates.has(name)) {
          if (!isOid(target)) {
            throw new GitError("EINVAL", `fetch exact ref candidate ${name} is symbolic`);
          }
          candidates.set(name, target);
        }
      }

      const shallowRows: string[] = [];
      for (const row of this.db.iterate(
        "SELECT oid FROM git_shallow WHERE repo_id = ? ORDER BY oid",
        this.repoId,
      )) {
        const oid = expectText(row.oid, "stored shallow object id");
        if (candidateInputs + tracking.size + shallowRows.length >= MAX_FETCH_PUBLICATION_INPUTS) {
          throw new GitError("E2BIG", "fetch snapshot exceeds its retained input count bound");
        }
        shallowRows.push(oid);
      }

      const generation = currentGeneration + 1;
      const updated = this.db.one<{ fetch_generation: unknown }>(
        `UPDATE git_repositories SET fetch_generation = ?
            WHERE id = ? AND fetch_generation = ?
            RETURNING fetch_generation`,
        generation,
        this.repoId,
        currentGeneration,
      );
      if (
        updated === undefined ||
        requireFetchGeneration(updated.fetch_generation, "updated fetch generation", 1) !==
          generation
      ) {
        throw new CorruptError("fetch generation changed during atomic allocation");
      }

      const overlapping = namespaces
        .filter(
          (namespace) =>
            namespace.trackingPrefix.startsWith(prefix) ||
            prefix.startsWith(namespace.trackingPrefix),
        )
        .map((namespace) => namespace.trackingPrefix);
      for (const page of jsonPages(overlapping, "overlapping fetch namespace")) {
        this.db.run(
          `UPDATE git_fetch_namespaces SET latest_generation = ?
              WHERE repo_id = ? AND tracking_prefix IN (SELECT value FROM json_each(?))`,
          generation,
          this.repoId,
          page,
        );
      }
      this.db.run(
        `INSERT INTO git_fetch_namespaces
             (repo_id, tracking_prefix, latest_generation, revision)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(repo_id, tracking_prefix)
           DO UPDATE SET latest_generation = excluded.latest_generation`,
        this.repoId,
        prefix,
        generation,
      );
      const issued = this.db.one<{ latest_generation: unknown; revision: unknown }>(
        `SELECT latest_generation, revision FROM git_fetch_namespaces
            WHERE repo_id = ? AND tracking_prefix = ?`,
        this.repoId,
        prefix,
      );
      if (issued === undefined) throw new CorruptError("issued fetch namespace is missing");
      const latestGeneration = requireFetchGeneration(
        issued.latest_generation,
        "issued fetch namespace generation",
        1,
      );
      if (latestGeneration !== generation) {
        throw new CorruptError("issued fetch namespace has the wrong generation");
      }
      const namespaceRevision = requireFetchGeneration(
        issued.revision,
        "issued fetch namespace revision",
        0,
      );
      const exactRows = [...candidates].map(([name, target]) => Object.freeze({ name, target }));
      const state: FetchPublicationState = {
        generation,
        trackingPrefix: prefix,
        namespaceRevision,
        shallowRevision,
        shallow: shallowRows,
        trackingRefs: tracking,
        exactRefs: candidates,
        checkoutRevision,
        disposed: false,
      };
      return {
        state,
        shallowRows: Object.freeze(shallowRows),
        trackingRows: Object.freeze(trackingRows),
        exactRows: Object.freeze(exactRows),
      };
    });
    let issuedToken: FetchPublicationToken | null = null;
    const token = new FetchPublicationToken(
      snapshot.state.generation,
      snapshot.state.trackingPrefix,
      snapshot.state.namespaceRevision,
      snapshot.state.shallowRevision,
      snapshot.shallowRows,
      snapshot.trackingRows,
      snapshot.exactRows,
      () => snapshot.state.disposed,
      () => {
        if (snapshot.state.disposed) return;
        snapshot.state.disposed = true;
        if (issuedToken !== null) {
          this.#issuedFetchPublications.delete(issuedToken);
          this.#fetchPublicationStates.delete(issuedToken);
        }
      },
    );
    issuedToken = token;
    this.#issuedFetchPublications.add(token);
    this.#fetchPublicationStates.set(token, snapshot.state);
    return token;
  }

  /** Publish a fetch snapshot atomically, or reject it after any conflicting observation. */
  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    if (!this.#issuedFetchPublications.has(token)) {
      throw staleFetch("fetch publication token was not issued by this repository");
    }
    const state = this.#fetchPublicationStates.get(token);
    if (state === undefined || state.disposed) {
      throw staleFetch("fetch publication token is no longer active");
    }
    const normalized = normalizeFetchPublication(state, plan);
    const checkedMetadata = validateRefLogMetadata(metadata);
    const shallowTouched = normalized.shallowAdd.length > 0 || normalized.shallowRemove.length > 0;
    const refChanged = this.db.transactionSync(() => {
      this.#preflightFetchPublication(state, normalized.refs, shallowTouched);
      const changed = this.refs.mutateNormalized(
        this.options.headOwner(),
        normalized.refs,
        checkedMetadata,
      );
      for (const page of jsonPages(normalized.shallowRemove, "shallow deletion")) {
        this.db.run(
          "DELETE FROM git_shallow WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
          this.repoId,
          page,
        );
      }
      for (const page of jsonPages(normalized.shallowAdd, "shallow update")) {
        this.db.run(
          `INSERT OR IGNORE INTO git_shallow (repo_id, oid)
           SELECT ?, value FROM json_each(?)`,
          this.repoId,
          page,
        );
      }
      if (shallowTouched) advanceShallowRevision(this.db, this.repoId, state.shallowRevision);
      if (shallowTouched && !changed) this.options.bumpMaintenanceRootEpoch();
      return changed;
    });
    if (shallowTouched) this.options.invalidateShallow();
    this.#issuedFetchPublications.delete(token);
    this.#fetchPublicationStates.delete(token);
    return refChanged || shallowTouched;
  }

  readRefMutationRevisionState(): RefMutationRevisionState {
    const state = this.db.one<{
      tracking_ref_revision_rows: unknown;
      fetch_generation: unknown;
      fetch_namespace_present: unknown;
    }>(
      `SELECT repository.fetch_generation,
              EXISTS(
                SELECT 1 FROM git_fetch_namespaces namespace
                 WHERE namespace.repo_id = ? LIMIT 1
              ) AS fetch_namespace_present,
              (SELECT count(*) FROM (
                 SELECT 1 FROM git_tracking_ref_revisions
                  WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
               )) AS tracking_ref_revision_rows
         FROM git_repositories repository WHERE repository.id = ?`,
      this.repoId,
      this.repoId,
      this.repoId,
    );
    if (state === undefined) throw new CorruptError("repository is missing its reflog state");
    const trackingRefRevisionCount = requireFetchGeneration(
      state.tracking_ref_revision_rows,
      "stored tracking ref revision count",
      0,
    );
    if (trackingRefRevisionCount > MAX_TRACKING_REF_REVISIONS) {
      throw new CorruptError("tracking ref revision count exceeds its bound");
    }
    const fetchGeneration = requireFetchGeneration(
      state.fetch_generation,
      "stored fetch generation",
      0,
    );
    const fetchNamespacePresent =
      state.fetch_namespace_present === 1
        ? true
        : state.fetch_namespace_present === 0
          ? false
          : null;
    if (
      fetchNamespacePresent === null ||
      (fetchGeneration === 0) !== (fetchNamespacePresent === false)
    ) {
      throw new CorruptError("fetch generation and namespace state disagree");
    }
    return { trackingRefRevisionCount, fetchNamespacePresent };
  }

  #readFetchNamespaces(): {
    trackingPrefix: string;
    latestGeneration: number;
    revision: number;
  }[] {
    const namespaces: {
      trackingPrefix: string;
      latestGeneration: number;
      revision: number;
    }[] = [];
    for (const row of this.db.iterate(
      `SELECT tracking_prefix, latest_generation, revision
           FROM git_fetch_namespaces WHERE repo_id = ? ORDER BY tracking_prefix
           LIMIT ${MAX_FETCH_NAMESPACES + 1}`,
      this.repoId,
    )) {
      if (namespaces.length >= MAX_FETCH_NAMESPACES) {
        throw new GitError("E2BIG", "repository fetch namespace count exceeds 1,024");
      }
      namespaces.push({
        trackingPrefix: expectText(row.tracking_prefix, "stored fetch tracking prefix"),
        latestGeneration: expectSafeInteger(
          row.latest_generation,
          1,
          Number.MAX_SAFE_INTEGER,
          "stored fetch namespace generation",
        ),
        revision: expectSafeInteger(
          row.revision,
          0,
          Number.MAX_SAFE_INTEGER,
          "stored fetch namespace revision",
        ),
      });
    }
    return namespaces;
  }

  #preflightFetchPublication(
    state: FetchPublicationState,
    publication: NormalizedRefMutation,
    shallowTouched: boolean,
  ): void {
    const namespace = this.db.one<{ latest_generation: unknown; revision: unknown }>(
      `SELECT latest_generation, revision FROM git_fetch_namespaces
        WHERE repo_id = ? AND tracking_prefix = ?`,
      this.repoId,
      state.trackingPrefix,
    );
    if (namespace === undefined) throw staleFetch("fetch tracking namespace disappeared");
    const latestGeneration = requireFetchGeneration(
      namespace.latest_generation,
      "stored fetch namespace generation",
      1,
    );
    const revision = requireFetchGeneration(
      namespace.revision,
      "stored fetch namespace revision",
      0,
    );
    if (latestGeneration !== state.generation) {
      throw staleFetch("a newer fetch has fenced this tracking namespace");
    }
    if (revision !== state.namespaceRevision) {
      throw staleFetch("the tracking namespace changed after fetch discovery");
    }
    if (shallowTouched) {
      const shallowRevision = this.db.scalar<unknown>(
        "SELECT shallow_revision FROM git_repositories WHERE id = ?",
        this.repoId,
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
      const checkoutRevision = this.db.scalar<unknown>(
        "SELECT checkout_revision FROM git_repositories WHERE id = ?",
        this.repoId,
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
      for (const checkout of this.options.headOwner().readRefMutationHeads()) {
        const attached = rawSymbolicTarget(checkout.head);
        if (attached !== null && selectedBranches.has(attached)) {
          throw staleFetch(`branch ${attached} became attached after fetch preflight`);
        }
      }
    }
    const presentExactRefs = new Set<string>();
    let rows = 0;
    let trackingRows = 0;
    for (const { name, target } of this.refs.iterateRefs()) {
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

  bumpFetchNamespaceRevisions(changedNames: ReadonlySet<string>): void {
    if (changedNames.size === 0) return;
    const affected: string[] = [];
    for (const namespace of this.#readFetchNamespaces()) {
      let changed = false;
      for (const name of changedNames) {
        if (name.startsWith(namespace.trackingPrefix)) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      if (namespace.revision === Number.MAX_SAFE_INTEGER) {
        throw new GitError("E2BIG", "fetch namespace revision is exhausted");
      }
      affected.push(namespace.trackingPrefix);
    }
    for (const page of jsonPages(affected, "fetch namespace revision")) {
      this.db.run(
        `UPDATE git_fetch_namespaces SET revision = revision + 1
          WHERE repo_id = ? AND tracking_prefix IN (SELECT value FROM json_each(?))`,
        this.repoId,
        page,
      );
    }
  }
}
