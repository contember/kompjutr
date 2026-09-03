import type { SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { expectSafeInteger, expectText } from "../../common/rows.js";
import type { FetchPublicationPlan, RefLogMetadata, RefRow } from "../core/contracts.js";
import { FetchPublicationToken, TrackingRefPublicationToken } from "../core/contracts.js";
import { jsonPages } from "../core/json-pages.js";
import { requireRefName } from "../refs/ref-validation.js";
import { validateRefLogMetadata } from "../refs/reflog.js";
import type { RefMutationRevisionState, RefMutationRevisions } from "../refs/refs.js";
import { normalizeRefMutation, type RefTable } from "../refs/refs.js";
import { advanceShallowRevision } from "../refs/shallow.js";
import { MAX_REFLOG_STATE_ROWS } from "../schema/reflog-schema.js";
import { MAX_TRACKING_REF_REVISIONS } from "../schema/schema.js";
import { preflightFetchPublication } from "./fetch-publication-preflight.js";
import { FetchPublicationRevisions } from "./fetch-publication-revisions.js";
import type {
  FetchPublicationOptions,
  FetchPublicationState,
  TrackingRefPublicationState,
} from "./fetch-publication-state.js";
import {
  MAX_FETCH_NAMESPACES,
  MAX_FETCH_PUBLICATION_INPUTS,
  normalizeFetchPublication,
  requireFetchGeneration,
  requireFetchTrackingPrefix,
  staleFetch,
} from "./fetch-publication-state.js";

export type {
  FetchPublicationOptions,
  FetchPublicationState,
  NormalizedFetchPublication,
  TrackingRefPublicationState,
} from "./fetch-publication-state.js";
export {
  invalidFetchTrackingPrefix,
  MAX_FETCH_NAMESPACES,
  MAX_FETCH_PUBLICATION_INPUTS,
  normalizeFetchPublication,
  requireFetchGeneration,
  requireFetchTrackingPrefix,
  staleFetch,
} from "./fetch-publication-state.js";

export class FetchPublicationTable implements RefMutationRevisions {
  readonly #issuedFetchPublications = new WeakSet<FetchPublicationToken>();
  readonly #fetchPublicationStates = new WeakMap<FetchPublicationToken, FetchPublicationState>();
  readonly #issuedTrackingRefPublications = new WeakSet<TrackingRefPublicationToken>();
  readonly #trackingRefPublicationStates = new WeakMap<
    TrackingRefPublicationToken,
    TrackingRefPublicationState
  >();
  readonly #revisions: FetchPublicationRevisions;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly refs: RefTable,
    private readonly options: FetchPublicationOptions,
  ) {
    this.#revisions = new FetchPublicationRevisions(db, repoId);
  }

  bumpTrackingRefRevisions(changedNames: ReadonlySet<string>): void {
    this.#revisions.bumpTrackingRefRevisions(changedNames);
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
      const refRevision = this.#revisions.ensureTrackingRefRevision(name);
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
        const refRevision = this.#revisions.readTrackingRefRevision(state.refName);
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

      this.#revisions.advanceTrackingRefObservations(prefix, trackingRefRevisionCount);

      const namespaces = this.#revisions.readFetchNamespaces();
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
      preflightFetchPublication(
        this.db,
        this.repoId,
        this.refs,
        this.options,
        state,
        normalized.refs,
        shallowTouched,
      );
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
    return this.#revisions.readRefMutationRevisionState();
  }

  bumpFetchNamespaceRevisions(changedNames: ReadonlySet<string>): void {
    this.#revisions.bumpFetchNamespaceRevisions(changedNames);
  }
}
