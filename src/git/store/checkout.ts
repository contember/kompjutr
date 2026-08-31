import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import type { ObjectType, RawObject } from "../common/objects.js";
import { hasCanonicalRefSyntax } from "../common/ref-name.js";
import { expectSafeInteger, expectText, RowShape, text } from "../common/rows.js";
import { comparePaths } from "../common/streams.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  indexCommitSource,
  insertCommitCaches,
  prepareCommitCache,
  readCommitCache,
  readCommitGraph,
} from "./commits.js";
import { nextPrefix } from "./config.js";
import type {
  BlobIdMapping,
  BlobReadBatch,
  BoundedSingleConfigValue,
  CheckoutRow,
  ConfigValueCardinality,
  FetchPublicationPlan,
  IndexApplyOptions,
  IndexEntry,
  IndexScanOptions,
  IndexSink,
  IndexStore,
  InitialStateResult,
  InitialStateSession,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefMutationExpected,
  RefRow,
  StoreOptions,
} from "./contracts.js";
import { FetchPublicationToken, TrackingRefPublicationToken } from "./contracts.js";
import { IndexTable } from "./index-table.js";
import { jsonPages } from "./json-pages.js";
import {
  advanceCheckoutRevision,
  CheckoutStoreLifetime,
  isAttachedBranchUniqueConstraint,
  requireSafeId,
  requireStoredCheckoutRow,
} from "./lifecycle.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import { OperationJournalTable } from "./operation-journal.js";
import type {
  CherryPickJournal,
  MergeJournal,
  MergeOperationJournal,
  MergeStateMetadata,
  MergeTouchedPath,
  OperationJournal,
  OperationKind,
  OperationStateMetadata,
  OperationStepMetadata,
  RebaseJournal,
  RevertJournal,
} from "./operations.js";
import type { PackStore } from "./packs.js";
import {
  rawSymbolicTarget,
  refTextBytes,
  requireRawRefTarget,
  requireRefName,
} from "./ref-validation.js";
import {
  activeRefLogOids,
  type CheckoutRefLogEvent,
  REFLOG_RETENTION_ROWS,
  REFLOG_RETENTION_SECONDS,
  type RefLogEvent,
  readRefLog,
  requireSafeRefLogInteger,
  validateRefLogMetadata,
} from "./reflog.js";
import { MAX_REFLOG_ORDINAL, MAX_REFLOG_STATE_ROWS } from "./reflog-schema.js";
import { MAX_CHECKOUTS_PER_REPOSITORY, MAX_TRACKING_REF_REVISIONS } from "./schema.js";
import { advanceShallowRevision } from "./shallow.js";
import type { SharedRepoStore } from "./shared.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "./tree-walk.js";

export const DEFAULT_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_REF_MUTATION_INPUTS = 100_000;
export const MAX_FETCH_NAMESPACES = 1_024;
export const MAX_FETCH_PUBLICATION_INPUTS = 100_000;
/** Conservative SQL ceiling for one direct-ref or raw-HEAD publication. */

export type OwnedRefMutation = (mutation: RefMutation, metadata: RefLogMetadata) => boolean;

export const OWNED_REF_MUTATIONS = new WeakMap<CheckoutStore, OwnedRefMutation>();

export function mutateRefsOwned(
  store: CheckoutStore,
  mutation: RefMutation,
  metadata: RefLogMetadata,
): boolean {
  const mutate = OWNED_REF_MUTATIONS.get(store);
  if (mutate === undefined) throw new GitError("EINVAL", "checkout store is not active");
  return mutate(mutation, metadata);
}

export interface NormalizedRefMutation {
  puts: Map<string, string>;
  deletes: Set<string>;
  head: string | undefined;
  expected: RefMutationExpected | undefined;
}

export interface FetchPublicationState {
  readonly generation: number;
  readonly trackingPrefix: string;
  readonly namespaceRevision: number;
  readonly shallowRevision: number;
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

const REF_ROW = new RowShape({ name: text(), target: text() });

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

export function normalizeRefMutation(mutation: RefMutation): NormalizedRefMutation {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  let inputs = 0;
  const countInput = (): void => {
    inputs++;
    if (inputs > MAX_REF_MUTATION_INPUTS) {
      throw new GitError("E2BIG", "ref mutation exceeds its retained input count bound");
    }
  };
  for (const value of mutation.deletes ?? []) {
    const name = requireRefName(value, "deleted ref name", "input");
    countInput();
    deletes.add(name);
  }
  for (const row of mutation.puts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "ref update row is invalid");
    }
    const name = requireRefName(row.name, "updated ref name", "input");
    const target = requireRawRefTarget(row.target, "updated ref target", "input");
    countInput();
    puts.set(name, target);
  }
  const head =
    mutation.head === undefined
      ? undefined
      : requireRawRefTarget(mutation.head, "HEAD target", "input");
  if (head !== undefined) {
    countInput();
  }
  let expected: RefMutationExpected | undefined;
  if (mutation.expected !== undefined) {
    const name = requireRefName(mutation.expected.name, "conditional ref name", "input");
    const target =
      mutation.expected.target === null
        ? null
        : requireRawRefTarget(mutation.expected.target, "expected ref target", "input");
    countInput();
    expected = { name, target };
    if (puts.has(name) === deletes.has(name)) {
      throw new GitError(
        "EINVAL",
        "conditional ref update must include exactly one destination put or delete",
      );
    }
  }
  return { puts, deletes, head, expected };
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
  for (const row of plan.globalTagPuts ?? []) {
    exactPut(row, "fetch global tag", true);
  }
  for (const row of plan.exactPuts ?? []) {
    exactPut(row, "fetch exact ref", false);
  }

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
    shallowAdd.add(shallowOid(value, "shallow addition"));
  }
  for (const value of plan.shallowRemove ?? []) {
    shallowRemove.add(shallowOid(value, "shallow deletion"));
  }

  const refs: NormalizedRefMutation = {
    puts,
    deletes,
    head: undefined,
    expected: undefined,
  };
  return {
    refs,
    shallowAdd: [...shallowAdd],
    shallowRemove: [...shallowRemove],
  };
}

export function resolveRawRef(
  raw: string | null,
  lookup: (name: string) => string | null,
): string | null {
  let value = raw;
  const seen = new Set<string>();
  for (let hops = 0; hops < 8; hops++) {
    if (value === null) return null;
    if (isOid(value)) return value;
    const target = rawSymbolicTarget(value);
    if (target === null) throw new CorruptError("stored ref target has an invalid shape");
    if (seen.has(target)) return null;
    seen.add(target);
    value = lookup(target);
  }
  return null;
}

/** Checkout-bound storage view. */
export class CheckoutStore implements IndexStore {
  readonly #sharedStore: SharedRepoStore;
  readonly #database: SqlDatabase;
  readonly #repoId: number;
  readonly #checkoutId: number;
  readonly #root: string;
  readonly #isPrimary: boolean;
  readonly #indexTable: IndexTable;
  readonly #operationJournals: OperationJournalTable;
  readonly #onDestroy: (() => void) | undefined;
  readonly #now: () => number;
  readonly #lifetime: CheckoutStoreLifetime;
  readonly #issuedFetchPublications = new WeakSet<FetchPublicationToken>();
  readonly #fetchPublicationStates = new WeakMap<FetchPublicationToken, FetchPublicationState>();
  readonly #issuedTrackingRefPublications = new WeakSet<TrackingRefPublicationToken>();
  readonly #trackingRefPublicationStates = new WeakMap<
    TrackingRefPublicationToken,
    TrackingRefPublicationState
  >();

  constructor(
    shared: SharedRepoStore,
    checkout: CheckoutRow,
    options: StoreOptions = {},
    onDestroy?: () => void,
    lifetime = new CheckoutStoreLifetime(),
  ) {
    if (
      requireSafeId(checkout.id, "checkout id") < 1 ||
      requireSafeId(checkout.repoId, "checkout repository id") !== shared.repoId
    ) {
      throw new CorruptError("checkout facade identity is invalid");
    }
    this.#sharedStore = shared;
    this.#onDestroy = onDestroy;
    this.#now = options.now ?? Date.now;
    this.#lifetime = lifetime;
    this.#database = shared.db;
    this.#repoId = shared.repoId;
    this.#checkoutId = checkout.id;
    this.#root = checkout.root;
    this.#isPrimary = checkout.isPrimary;
    this.#indexTable = new IndexTable(
      this.#database,
      { kind: "checkout", repoId: this.#repoId, checkoutId: this.#checkoutId },
      () => this.#requireActive(),
    );
    this.#operationJournals = new OperationJournalTable(
      this.#database,
      this.#repoId,
      this.#checkoutId,
      shared.objectTable,
    );
    OWNED_REF_MUTATIONS.set(this, (mutation, metadata) =>
      this.#mutateRefsOwned(mutation, metadata),
    );
    shared.bindCheckoutOperations(this);
  }

  #requireActive(): void {
    this.#lifetime.requireActive();
  }

  get shared(): SharedRepoStore {
    this.#requireActive();
    return this.#sharedStore;
  }

  get #db(): SqlDatabase {
    this.#requireActive();
    return this.#database;
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  get repoId(): number {
    return this.#repoId;
  }

  get sharedRepoId(): number {
    return this.#repoId;
  }

  get checkoutId(): number {
    return this.#checkoutId;
  }

  get root(): string {
    return this.#root;
  }

  get isPrimary(): boolean {
    return this.#isPrimary;
  }

  get packs(): PackStore {
    return this.shared.packs;
  }

  /** Bytes currently held by this database's two shared bounded caches. */
  cacheBytes(): { objects: number; chunks: number } {
    return this.shared.cacheBytes();
  }

  // -- objects --------------------------------------------------------

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.shared.lookupBlobIds(contentIds);
  }

  /**
   * Return the ordinals of expected mappings that are absent or disagree.
   *
   * An absent result proves the stored mapping equals the expected oid. A
   * `null` value means there is no stored mapping, so callers must identify
   * the content instead of trusting it.
   */
  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    return this.shared.blobIdMismatches(expected);
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    this.shared.upsertBlobIds(mappings);
  }

  has(oid: string): boolean {
    return this.shared.has(oid);
  }

  hasAll(oids: Iterable<string>): Set<string> {
    return this.shared.hasAll(oids);
  }

  missing(oids: Iterable<string>): string[] {
    return this.shared.missing(oids);
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.shared.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    return this.shared.read(oid);
  }

  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.shared.readAuthenticatedObject(oid, expectedType);
  }

  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return this.shared.objectInfo(oids);
  }

  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.shared.readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.shared.readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* iterateTree(this.#db, this.#repoId, treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* iterateTreeDiff(this.#db, this.#repoId, beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* iterateTreeDiffObjects(this.#db, this.#repoId, beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    return this.shared.write(type, data);
  }

  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return this.shared.writeStream(type, size, chunks);
  }

  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.shared.writeBatch(options);
  }

  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return this.shared.writeObjects(body, options);
  }

  readChunks(oid: string): Iterable<Uint8Array> | null {
    return this.shared.readChunks(oid);
  }

  resolvePrefix(prefix: string): string | null {
    return this.shared.resolvePrefix(prefix);
  }

  objectCount(): number {
    return this.shared.objectCount();
  }

  // -- refs -----------------------------------------------------------

  /** Raw ref value: an oid, or "ref: <name>" for a symbolic ref. */
  getRef(name: string): string | null {
    const checkedName = requireRefName(name, "ref name", "input", true);
    if (checkedName === "HEAD") return this.head();
    const row = this.#db.one<Record<string, unknown>>(
      "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
      this.#repoId,
      checkedName,
    );
    return row === undefined ? null : expectText(row.target, `stored target of ${checkedName}`);
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") {
      this.setHead(target);
      return;
    }
    this.mutateRefs({ puts: [{ name, target }] }, this.#genericRefLogMetadata("ref update"));
  }

  /** Move one direct ref only if it still contains the caller's observed OID. */
  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    if (name === "HEAD" || !isOid(expectedOid) || !isOid(targetOid)) {
      throw new GitError("EINVAL", "conditional ref update requires a direct ref and full OIDs");
    }
    this.mutateRefs(
      {
        puts: [{ name, target: targetOid }],
        expected: { name, target: expectedOid },
      },
      this.#genericRefLogMetadata("conditional ref update"),
    );
  }

  deleteRef(name: string): void {
    this.mutateRefs({ deletes: [name] }, this.#genericRefLogMetadata("ref delete"));
  }

  /** Apply bounded ref deletions and updates atomically. */
  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.mutateRefs({ puts, deletes }, this.#genericRefLogMetadata("ref batch update"));
  }

  #readTrackingRefRevision(refName: string): number | null {
    const revision = this.#db.scalar<unknown>(
      `SELECT revision FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND ref_name = ?`,
      this.#repoId,
      refName,
    );
    return revision === undefined
      ? null
      : expectSafeInteger(revision, 0, Number.MAX_SAFE_INTEGER, "stored tracking ref revision");
  }

  #trackingRefRevisionCount(): number {
    const stored = this.#db.scalar<unknown>(
      `SELECT count(*) FROM (
         SELECT 1 FROM git_tracking_ref_revisions
          WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
       )`,
      this.#repoId,
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
    this.#db.run(
      `INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision)
       SELECT ?, ?, 0 WHERE EXISTS (SELECT 1 FROM git_repositories WHERE id = ?)`,
      this.#repoId,
      refName,
      this.#repoId,
    );
    const created = this.#readTrackingRefRevision(refName);
    if (created !== 0) throw new CorruptError("tracking revision creation failed");
    return created;
  }

  #advanceTrackingRefObservations(trackingPrefix: string, count: number): void {
    if (count === 0) return;
    const matched = expectSafeInteger(
      this.#db.scalar<unknown>(
        `SELECT count(*) FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?`,
        this.#repoId,
        trackingPrefix,
        trackingPrefix,
      ),
      0,
      count,
      "tracking observation count",
    );
    if (matched === 0) return;
    this.#db.run(
      `UPDATE git_tracking_ref_revisions SET revision = revision + 1
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?
          AND revision < ${Number.MAX_SAFE_INTEGER}`,
      this.#repoId,
      trackingPrefix,
      trackingPrefix,
    );
    const changed = expectSafeInteger(this.#db.scalar<unknown>("SELECT changes()"), 0, matched);
    if (changed !== matched) throw new GitError("E2BIG", "tracking ref revision is exhausted");
  }

  #bumpTrackingRefRevisions(changedNames: ReadonlySet<string>): void {
    if (changedNames.size === 0) return;
    for (const page of jsonPages(changedNames, "tracking ref revision lookup")) {
      const affected = expectSafeInteger(
        this.#db.scalar<unknown>(
          `SELECT count(*) FROM git_tracking_ref_revisions
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))`,
          this.#repoId,
          page,
        ),
        0,
      );
      if (affected === 0) continue;
      this.#db.run(
        `UPDATE git_tracking_ref_revisions SET revision = revision + 1
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))
            AND revision < ${Number.MAX_SAFE_INTEGER}`,
        this.#repoId,
        page,
      );
      const changed = expectSafeInteger(this.#db.scalar<unknown>("SELECT changes()"), 0, affected);
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
    const snapshot = this.#db.transactionSync(() => {
      const refRevision = this.#ensureTrackingRefRevision(name);
      const row = this.#db.one<Record<string, unknown>>(
        "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
        this.#repoId,
        name,
      );
      const target = row === undefined ? null : expectText(row.target, "stored tracking target");
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
      const changed = this.#db.transactionSync(() => {
        const refRevision = this.#readTrackingRefRevision(state.refName);
        if (refRevision !== state.refRevision) {
          throw staleFetch("the tracking ref changed after observation");
        }
        const refChanged = this.#mutateRefs(normalized, checkedMetadata);
        if (!refChanged) {
          this.#bumpTrackingRefRevisions(new Set([state.refName]));
          this.#bumpFetchNamespaceRevisions(new Set([state.refName]));
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

    const snapshot = this.#db.transactionSync(() => {
      const repository = this.#db.one<Record<string, unknown>>(
        `SELECT fetch_generation, shallow_revision, checkout_revision,
                  (SELECT count(*) FROM (
                     SELECT 1 FROM git_tracking_ref_revisions
                      WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
                   )) AS tracking_ref_revision_rows
             FROM git_repositories WHERE id = ?`,
        this.#repoId,
        this.#repoId,
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
      for (const { name, target } of this.#iterateStoredRefs()) {
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
      for (const row of this.#db.iterate(
        "SELECT oid FROM git_shallow WHERE repo_id = ? ORDER BY oid",
        this.#repoId,
      )) {
        const oid = expectText(row.oid, "stored shallow object id");
        if (candidateInputs + tracking.size + shallowRows.length >= MAX_FETCH_PUBLICATION_INPUTS) {
          throw new GitError("E2BIG", "fetch snapshot exceeds its retained input count bound");
        }
        shallowRows.push(oid);
      }

      const generation = currentGeneration + 1;
      const updated = this.#db.one<{ fetch_generation: unknown }>(
        `UPDATE git_repositories SET fetch_generation = ?
            WHERE id = ? AND fetch_generation = ?
            RETURNING fetch_generation`,
        generation,
        this.#repoId,
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
        this.#db.run(
          `UPDATE git_fetch_namespaces SET latest_generation = ?
              WHERE repo_id = ? AND tracking_prefix IN (SELECT value FROM json_each(?))`,
          generation,
          this.#repoId,
          page,
        );
      }
      this.#db.run(
        `INSERT INTO git_fetch_namespaces
             (repo_id, tracking_prefix, latest_generation, revision)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(repo_id, tracking_prefix)
           DO UPDATE SET latest_generation = excluded.latest_generation`,
        this.#repoId,
        prefix,
        generation,
      );
      const issued = this.#db.one<{
        latest_generation: unknown;
        revision: unknown;
      }>(
        `SELECT latest_generation, revision FROM git_fetch_namespaces
            WHERE repo_id = ? AND tracking_prefix = ?`,
        this.#repoId,
        prefix,
      );
      if (issued === undefined) {
        throw new CorruptError("issued fetch namespace is missing");
      }
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
    {
      const normalized = normalizeFetchPublication(state, plan);
      const checkedMetadata = validateRefLogMetadata(metadata);
      const shallowTouched =
        normalized.shallowAdd.length > 0 || normalized.shallowRemove.length > 0;
      const refChanged = this.#db.transactionSync(() => {
        this.#preflightFetchPublication(state, normalized.refs, shallowTouched);
        const changed = this.#mutateRefs(normalized.refs, checkedMetadata);
        for (const page of jsonPages(normalized.shallowRemove, "shallow deletion")) {
          this.#db.run(
            "DELETE FROM git_shallow WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
            this.#repoId,
            page,
          );
        }
        for (const page of jsonPages(normalized.shallowAdd, "shallow update")) {
          this.#db.run(
            `INSERT OR IGNORE INTO git_shallow (repo_id, oid)
           SELECT ?, value FROM json_each(?)`,
            this.#repoId,
            page,
          );
        }
        if (shallowTouched) advanceShallowRevision(this.#db, this.#repoId, state.shallowRevision);
        if (shallowTouched && !changed) bumpMaintenanceRootEpoch(this.#db, this.#repoId);
        return changed;
      });
      if (shallowTouched) this.shared.invalidateShallow();
      this.#issuedFetchPublications.delete(token);
      this.#fetchPublicationStates.delete(token);
      return refChanged || shallowTouched;
    }
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
    for (const row of this.#db.iterate(
      `SELECT tracking_prefix, latest_generation, revision
           FROM git_fetch_namespaces WHERE repo_id = ? ORDER BY tracking_prefix
           LIMIT ${MAX_FETCH_NAMESPACES + 1}`,
      this.#repoId,
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
    const namespace = this.#db.one<{
      latest_generation: unknown;
      revision: unknown;
    }>(
      `SELECT latest_generation, revision FROM git_fetch_namespaces
        WHERE repo_id = ? AND tracking_prefix = ?`,
      this.#repoId,
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
      const shallowRevision = this.#db.scalar<unknown>(
        "SELECT shallow_revision FROM git_repositories WHERE id = ?",
        this.#repoId,
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
      const checkoutRevision = this.#db.scalar<unknown>(
        "SELECT checkout_revision FROM git_repositories WHERE id = ?",
        this.#repoId,
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
      let checkoutRows = 0;
      for (const row of this.#db.iterate(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
             FROM git_checkouts WHERE repo_id = ? ORDER BY id
             LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
        this.#repoId,
      )) {
        const checkout = requireStoredCheckoutRow(row);
        checkoutRows++;
        if (checkoutRows > MAX_CHECKOUTS_PER_REPOSITORY) {
          throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
        }
        const attached = rawSymbolicTarget(checkout.head);
        if (attached !== null && selectedBranches.has(attached)) {
          throw staleFetch(`branch ${attached} became attached after fetch preflight`);
        }
      }
    }
    const presentExactRefs = new Set<string>();
    let rows = 0;
    let trackingRows = 0;
    for (const { name, target } of this.#iterateStoredRefs()) {
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

  #bumpFetchNamespaceRevisions(changedNames: ReadonlySet<string>): void {
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
      this.#db.run(
        `UPDATE git_fetch_namespaces SET revision = revision + 1
          WHERE repo_id = ? AND tracking_prefix IN (SELECT value FROM json_each(?))`,
        this.#repoId,
        page,
      );
    }
  }

  /** Apply current ref state and its bounded history through one atomic seam. */
  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    return this.#mutateRefsOwned(mutation, metadata);
  }

  #mutateRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    const normalized = normalizeRefMutation(mutation);
    const checkedMetadata = validateRefLogMetadata(metadata);
    return this.#mutateRefs(normalized, checkedMetadata);
  }

  #mutateRefs(normalized: NormalizedRefMutation, checkedMetadata: RefLogMetadata): boolean {
    return this.#db.transactionSync(() => {
      const header = this.#db.one<{
        repo_id: unknown;
        checkout_id: unknown;
        next_ordinal: unknown;
        latest_ordinal: unknown;
        tracking_ref_revision_rows: unknown;
        fetch_generation: unknown;
        fetch_namespace_present: unknown;
        checkout_revision: unknown;
      }>(
        `SELECT repository.id AS repo_id, checkout.id AS checkout_id, state.next_ordinal,
                repository.fetch_generation, repository.checkout_revision,
                EXISTS(
                  SELECT 1 FROM git_fetch_namespaces namespace
                   WHERE namespace.repo_id = ? LIMIT 1
                ) AS fetch_namespace_present,
                (SELECT count(*) FROM (
                   SELECT 1 FROM git_tracking_ref_revisions
                    WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
                 )) AS tracking_ref_revision_rows,
                (SELECT max(ordinal) FROM (
                   SELECT entry.ordinal FROM git_reflog_entries entry
                    WHERE entry.repo_id = repository.id
                   UNION ALL
                   SELECT entry.ordinal FROM git_checkout_reflog_entries entry
                    WHERE entry.repo_id = repository.id
                 )) AS latest_ordinal
           FROM git_repositories repository
           JOIN git_reflog_state state ON state.repo_id = repository.id
           JOIN git_checkouts checkout ON checkout.repo_id = repository.id
          WHERE repository.id = ? AND checkout.id = ?`,
        this.#repoId,
        this.#repoId,
        this.#repoId,
        this.#checkoutId,
      );
      if (header === undefined) {
        throw new CorruptError("repository is missing its reflog state");
      }
      if (
        requireSafeId(header.repo_id, "reflog repository id") !== this.#repoId ||
        requireSafeId(header.checkout_id, "reflog checkout id") !== this.#checkoutId
      ) {
        throw new CorruptError("reflog header crossed a checkout boundary");
      }
      const nextOrdinal = requireSafeRefLogInteger(
        header.next_ordinal,
        "reflog next ordinal",
        0,
        MAX_REFLOG_ORDINAL,
      );
      const latestOrdinal =
        header.latest_ordinal === null
          ? null
          : requireSafeRefLogInteger(
              header.latest_ordinal,
              "newest reflog ordinal",
              1,
              MAX_REFLOG_ORDINAL,
            );
      if ((nextOrdinal === 0 && latestOrdinal !== null) || (latestOrdinal ?? 0) > nextOrdinal) {
        throw new CorruptError("reflog state precedes its newest entry");
      }
      const trackingRefRevisionCount = requireFetchGeneration(
        header.tracking_ref_revision_rows,
        "stored tracking ref revision count",
        0,
      );
      if (trackingRefRevisionCount > MAX_TRACKING_REF_REVISIONS) {
        throw new CorruptError("tracking ref revision count exceeds its bound");
      }
      const fetchGeneration = requireFetchGeneration(
        header.fetch_generation,
        "stored fetch generation",
        0,
      );
      const checkoutRevision = requireFetchGeneration(
        header.checkout_revision,
        "stored checkout revision",
        0,
      );
      const fetchNamespacePresent =
        header.fetch_namespace_present === 1
          ? true
          : header.fetch_namespace_present === 0
            ? false
            : null;
      if (
        fetchNamespacePresent === null ||
        (fetchGeneration === 0) !== (fetchNamespacePresent === false)
      ) {
        throw new CorruptError("fetch generation and namespace state disagree");
      }

      const checkouts: CheckoutRow[] = [];
      let selected: CheckoutRow | null = null;
      for (const raw of this.#db.iterate(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
             FROM git_checkouts WHERE repo_id = ? ORDER BY id
             LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
        this.#repoId,
      )) {
        const checkout = requireStoredCheckoutRow(raw);
        if (checkout.repoId !== this.#repoId) {
          throw new CorruptError("reflog checkout scan crossed repositories");
        }
        checkouts.push(checkout);
        if (checkout.id === this.#checkoutId) selected = checkout;
        if (checkouts.length > MAX_CHECKOUTS_PER_REPOSITORY) {
          throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
        }
      }
      if (selected === null)
        throw new CorruptError("selected checkout disappeared during ref mutation");
      const oldHead = selected.head;

      const before = new Map<string, string>();
      let rows = 0;
      for (const { name, target } of this.#iterateStoredRefs()) {
        rows++;
        if (rows > MAX_REFLOG_STATE_ROWS) {
          throw new GitError("E2BIG", "repository ref state exceeds its structural row bound");
        }
        before.set(name, target);
      }

      const beforeTarget = (name: string): string | null => before.get(name) ?? null;
      if (
        normalized.expected !== undefined &&
        beforeTarget(normalized.expected.name) !== normalized.expected.target
      ) {
        throw new GitError(
          "ESTALEHEAD",
          `ref ${normalized.expected.name} changed before conditional update`,
        );
      }

      const afterTarget = (name: string): string | null => {
        const put = normalized.puts.get(name);
        if (put !== undefined) return put;
        if (normalized.deletes.has(name)) return null;
        return beforeTarget(name);
      };
      const newHead = normalized.head ?? oldHead;
      const newAttachedBranch = rawSymbolicTarget(newHead);
      const attachedBranchOwner = (): CheckoutRow | null => {
        if (newAttachedBranch?.startsWith("refs/heads/") !== true) return null;
        const owner = this.#db.one<Record<string, unknown>>(
          `SELECT id AS checkout_id, repo_id, root, head, is_primary
               FROM git_checkouts
              WHERE repo_id = ? AND head = ? AND id != ?
              LIMIT 1`,
          this.#repoId,
          newHead,
          this.#checkoutId,
        );
        if (owner === undefined) return null;
        const checkedOwner = requireStoredCheckoutRow(owner);
        if (checkedOwner.repoId !== this.#repoId || checkedOwner.head !== newHead) {
          throw new CorruptError("attached branch ownership crossed a repository boundary");
        }
        return checkedOwner;
      };
      if (newHead !== oldHead) {
        const owner = attachedBranchOwner();
        if (owner !== null) {
          throw new GitError(
            "EBRANCHINUSE",
            `branch ${newAttachedBranch} is already attached to checkout ${owner.root}`,
          );
        }
      }

      const changedNames = new Set<string>();
      for (const name of normalized.deletes) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        if (oldRaw !== newRaw && !changedNames.has(name)) {
          changedNames.add(name);
        }
      }
      for (const name of normalized.puts.keys()) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        if (oldRaw !== newRaw && !changedNames.has(name)) {
          changedNames.add(name);
        }
      }
      const orderedNames = [...changedNames].sort(comparePaths);
      const pendingDirect: Omit<RefLogEvent, "ordinal">[] = [];
      for (const name of orderedNames) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        const oldOid = resolveRawRef(oldRaw, beforeTarget);
        const newOid = resolveRawRef(newRaw, afterTarget);
        pendingDirect.push({
          refName: name,
          oldRaw,
          newRaw,
          oldOid,
          newOid,
          actorName: checkedMetadata.actor?.name ?? null,
          actorEmail: checkedMetadata.actor?.email ?? null,
          timestamp: checkedMetadata.timestamp,
          timezoneOffset: checkedMetadata.timezoneOffset,
          reason: checkedMetadata.reason,
        });
      }
      const pendingHeads: { checkoutId: number; event: Omit<RefLogEvent, "ordinal"> }[] = [];
      for (const checkout of checkouts) {
        const checkoutNewHead = checkout.id === this.#checkoutId ? newHead : checkout.head;
        const attached = rawSymbolicTarget(checkout.head);
        const causalHeadChange = attached?.startsWith("refs/heads/") && changedNames.has(attached);
        const oldHeadOid = resolveRawRef(checkout.head, beforeTarget);
        const newHeadOid = resolveRawRef(checkoutNewHead, afterTarget);
        if (checkout.head !== checkoutNewHead || oldHeadOid !== newHeadOid || causalHeadChange) {
          pendingHeads.push({
            checkoutId: checkout.id,
            event: {
              refName: "HEAD",
              oldRaw: checkout.head,
              newRaw: checkoutNewHead,
              oldOid: oldHeadOid,
              newOid: newHeadOid,
              actorName: checkedMetadata.actor?.name ?? null,
              actorEmail: checkedMetadata.actor?.email ?? null,
              timestamp: checkedMetadata.timestamp,
              timezoneOffset: checkedMetadata.timezoneOffset,
              reason: checkedMetadata.reason,
            },
          });
        }
      }
      const eventCount = pendingDirect.length + pendingHeads.length;
      if (eventCount === 0) return false;
      if (eventCount > MAX_REFLOG_ORDINAL - nextOrdinal) {
        throw new GitError("E2BIG", "repository reflog ordinal is exhausted");
      }

      const events: RefLogEvent[] = pendingDirect.map((event, index) => ({
        ...event,
        ordinal: nextOrdinal + index + 1,
      }));
      const checkoutEvents: CheckoutRefLogEvent[] = pendingHeads.map((pending, index) => ({
        ...pending.event,
        checkoutId: pending.checkoutId,
        ordinal: nextOrdinal + events.length + index + 1,
      }));
      const deleted = events.filter((event) => event.newRaw === null).map((event) => event.refName);
      const put: RefRow[] = [];
      for (const event of events) {
        if (event.newRaw !== null) {
          put.push({ name: event.refName, target: event.newRaw });
        }
      }
      for (const page of jsonPages(deleted, "ref deletion")) {
        this.#db.run(
          `DELETE FROM git_refs
            WHERE repo_id = ? AND name IN (SELECT value FROM json_each(?))`,
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(put, "ref update")) {
        this.#db.run(
          `INSERT INTO git_refs (repo_id, name, target)
           SELECT ?, json_extract(value, '$.name'), json_extract(value, '$.target')
             FROM json_each(?)
            WHERE true
           ON CONFLICT(repo_id, name) DO UPDATE SET target = excluded.target`,
          this.#repoId,
          page,
        );
      }
      if (newHead !== oldHead) {
        let updated: Record<string, unknown> | undefined;
        {
          try {
            updated = this.#db.one<Record<string, unknown>>(
              `UPDATE git_checkouts SET head = ?
                WHERE id = ? AND repo_id = ? AND head = ?
                RETURNING id AS checkout_id, repo_id, root, head, is_primary`,
              newHead,
              this.#checkoutId,
              this.#repoId,
              oldHead,
            );
          } catch (error) {
            if (isAttachedBranchUniqueConstraint(error)) {
              const owner = attachedBranchOwner();
              if (owner !== null) {
                throw new GitError(
                  "EBRANCHINUSE",
                  `branch ${newAttachedBranch} is already attached to checkout ${owner.root}`,
                  { cause: error },
                );
              }
            }
            throw error;
          }
          if (updated === undefined)
            throw new CorruptError("selected checkout HEAD changed during ref mutation");
          const checked = requireStoredCheckoutRow(updated);
          if (checked.id !== this.#checkoutId || checked.repoId !== this.#repoId) {
            throw new CorruptError("HEAD update crossed a checkout boundary");
          }
        }
        advanceCheckoutRevision(this.#db, this.#repoId, 1, checkoutRevision);
      }
      for (const page of jsonPages(events, "reflog entry")) {
        this.#db.run(
          `INSERT INTO git_reflog_entries
             (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
              actor_name, actor_email, timestamp, timezone, reason)
           SELECT ?,
                  json_extract(value, '$.refName'),
                  json_extract(value, '$.ordinal'),
                  json_extract(value, '$.oldRaw'),
                  json_extract(value, '$.newRaw'),
                  json_extract(value, '$.oldOid'),
                  json_extract(value, '$.newOid'),
                  json_extract(value, '$.actorName'),
                  json_extract(value, '$.actorEmail'),
                  json_extract(value, '$.timestamp'),
                  json_extract(value, '$.timezoneOffset'),
                  json_extract(value, '$.reason')
             FROM json_each(?)`,
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(checkoutEvents, "checkout reflog entry")) {
        this.#db.run(
          `INSERT INTO git_checkout_reflog_entries
             (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
              actor_name, actor_email, timestamp, timezone, reason)
           SELECT json_extract(value, '$.checkoutId'), ?,
                  json_extract(value, '$.ordinal'),
                  json_extract(value, '$.oldRaw'),
                  json_extract(value, '$.newRaw'),
                  json_extract(value, '$.oldOid'),
                  json_extract(value, '$.newOid'),
                  json_extract(value, '$.actorName'),
                  json_extract(value, '$.actorEmail'),
                  json_extract(value, '$.timestamp'),
                  json_extract(value, '$.timezoneOffset'),
                  json_extract(value, '$.reason')
             FROM json_each(?)`,
          this.#repoId,
          page,
        );
      }
      const finalOrdinal = nextOrdinal + eventCount;
      const state = this.#db.one<{ next_ordinal: unknown }>(
        `UPDATE git_reflog_state SET next_ordinal = ?
          WHERE repo_id = ? AND next_ordinal = ?
          RETURNING next_ordinal`,
        finalOrdinal,
        this.#repoId,
        nextOrdinal,
      );
      if (state === undefined || state.next_ordinal !== finalOrdinal) {
        throw new CorruptError("reflog state changed during atomic ref mutation");
      }

      const cutoff = Math.max(0, checkedMetadata.timestamp - REFLOG_RETENTION_SECONDS);
      this.#db.run(
        "DELETE FROM git_reflog_entries WHERE repo_id = ? AND timestamp < ?",
        this.#repoId,
        cutoff,
      );
      this.#db.run(
        "DELETE FROM git_checkout_reflog_entries WHERE repo_id = ? AND timestamp < ?",
        this.#repoId,
        cutoff,
      );
      const touchedRefs = events.map((event) => event.refName);
      for (const page of jsonPages(touchedRefs, "reflog retention ref")) {
        this.#db.run(
          `DELETE FROM git_reflog_entries AS entry
            WHERE entry.repo_id = ?
              AND entry.ref_name IN (SELECT value FROM json_each(?))
              AND entry.ordinal < coalesce((
                SELECT retained.ordinal
                  FROM git_reflog_entries retained INDEXED BY git_reflog_entries_by_ref
                 WHERE retained.repo_id = entry.repo_id
                   AND retained.ref_name = entry.ref_name
                 ORDER BY retained.ordinal DESC
                 LIMIT 1 OFFSET ${REFLOG_RETENTION_ROWS - 1}
              ), 0)`,
          this.#repoId,
          page,
        );
      }
      const touchedCheckouts = checkoutEvents.map((event) => event.checkoutId);
      for (const page of jsonPages(touchedCheckouts, "checkout reflog retention")) {
        this.#db.run(
          `DELETE FROM git_checkout_reflog_entries AS entry
            WHERE entry.repo_id = ?
              AND entry.checkout_id IN (SELECT value FROM json_each(?))
              AND entry.ordinal < coalesce((
                SELECT retained.ordinal
                  FROM git_checkout_reflog_entries retained
                 WHERE retained.checkout_id = entry.checkout_id
                 ORDER BY retained.ordinal DESC
                 LIMIT 1 OFFSET ${REFLOG_RETENTION_ROWS - 1}
              ), 0)`,
          this.#repoId,
          page,
        );
      }
      if (trackingRefRevisionCount > 0) {
        this.#bumpTrackingRefRevisions(changedNames);
      }
      if (fetchNamespacePresent) {
        this.#bumpFetchNamespaceRevisions(changedNames);
      }
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      return true;
    });
  }

  *#iterateStoredRefs(): Generator<RefRow> {
    let rows = 0;
    for (const row of this.#db.iterate(
      `SELECT name, target FROM git_refs
          WHERE repo_id = ?
          ORDER BY name
          LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`,
      this.#repoId,
    )) {
      rows++;
      if (rows > MAX_REFLOG_STATE_ROWS) {
        throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
      }
      yield REF_ROW.decode(row);
    }
  }

  listRefs(prefix = ""): RefRow[] {
    let upper: string | undefined;
    if (prefix !== "") upper = nextPrefix(prefix);
    const result: RefRow[] = [];
    const sql =
      prefix === ""
        ? `SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name
             LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`
        : `SELECT name, target FROM git_refs
            WHERE repo_id = ? AND name >= ? AND name < ? ORDER BY name
            LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`;
    for (const row of this.#db.iterate(
      sql,
      this.#repoId,
      ...(upper === undefined ? [] : [prefix, upper]),
    )) {
      if (result.length >= MAX_REFLOG_STATE_ROWS) {
        throw new GitError("E2BIG", "repository ref state exceeds 100,000 rows");
      }
      result.push(REF_ROW.decode(row));
    }
    return result;
  }

  /** Stream all raw refs without materializing repository ref state. */
  *iterateRefs(): Generator<RefRow> {
    yield* this.#iterateStoredRefs();
  }

  head(): string {
    const row = this.#db.one<Record<string, unknown>>(
      "SELECT head FROM git_checkouts WHERE id = ? AND repo_id = ?",
      this.#checkoutId,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("checkout HEAD row is missing");
    return expectText(row.head, "stored HEAD target");
  }

  setHead(value: string): void {
    this.mutateRefs({ head: value }, this.#genericRefLogMetadata("HEAD update"));
  }

  /** Active stored entries for one exact ref, newest first. */
  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    return readRefLog(this.#db, this.#repoId, this.#checkoutId, this.#now, refName, options);
  }

  /** Distinct active reflog roots in strict byte order. */
  *activeRefLogOids(): Generator<string> {
    yield* activeRefLogOids(this.#db, this.#repoId, this.#checkoutId, this.#now);
  }

  // -- config ---------------------------------------------------------

  configGetAll(path: string): string[] {
    return this.shared.configGetAll(path);
  }

  configGet(path: string): string | undefined {
    return this.shared.configGet(path);
  }

  /** Read one config value with an optional payload limit. */
  configGetBounded(path: string, maxBytes?: number): string | undefined {
    return this.shared.configGetBounded(path, maxBytes);
  }

  /** Read zero or one value without materialising an unbounded multi-valued key. */
  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    return this.shared.configGetSingleBounded(path, maxBytes);
  }

  /** Inspect zero, one, or multiple values without materialising their payloads. */
  configCardinality(path: string): ConfigValueCardinality {
    return this.shared.configCardinality(path);
  }

  configSet(path: string, value: string): void {
    this.shared.configSet(path, value);
  }

  configAdd(path: string, value: string): void {
    this.shared.configAdd(path, value);
  }

  configUnset(path: string): void {
    this.shared.configUnset(path);
  }

  /** Distinct config paths under a dotted prefix, e.g. "remote.". */
  configPaths(prefix: string): string[] {
    return this.shared.configPaths(prefix);
  }

  /** Validate and move one exact dotted config section without changing value order. */
  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    this.shared.configMoveSection(sourcePrefix, destinationPrefix);
  }

  // -- integration operation journal --------------------------------

  /** Read and validate the one durable incomplete integration operation. */
  readOperationState(): OperationJournal | null {
    this.#requireActive();
    return this.#operationJournals.readOperationState();
  }

  readOperationStateOwned(): OperationJournal | null {
    return this.readOperationState();
  }

  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    this.#requireActive();
    this.#operationJournals.writeOperationState(state, touched);
  }

  writeOperationJournal(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#requireActive();
    this.#operationJournals.writeOperationJournal(state, steps, touched);
  }

  writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.writeOperationJournal(state, steps, touched);
  }

  replaceOperationState(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    this.#requireActive();
    this.#operationJournals.replaceOperationState(expectedIntegrityOid, state);
  }

  replaceOperationStateOwned(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    this.replaceOperationState(expectedIntegrityOid, state);
  }

  replaceOperationJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#requireActive();
    this.#operationJournals.replaceOperationJournal(expectedIntegrityOid, state, steps, touched);
  }

  replaceOperationJournalOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.replaceOperationJournal(expectedIntegrityOid, state, steps, touched);
  }

  clearOperationState(): boolean {
    this.#requireActive();
    return this.#operationJournals.clearOperationState();
  }

  requireNoOperationState(): void {
    this.#requireActive();
    this.#operationJournals.requireNoOperationState();
  }

  requireOperationState(kind: "merge"): MergeOperationJournal;
  requireOperationState(kind: "cherry-pick"): CherryPickJournal;
  requireOperationState(kind: "revert"): RevertJournal;
  requireOperationState(kind: "rebase"): RebaseJournal;
  requireOperationState(kind: OperationKind): OperationJournal;
  requireOperationState(kind: OperationKind): OperationJournal {
    this.#requireActive();
    return this.#operationJournals.requireOperationState(kind);
  }

  readMergeState(): MergeJournal | null {
    this.#requireActive();
    return this.#operationJournals.readMergeState();
  }

  writeMergeState(state: MergeStateMetadata, touched: readonly MergeTouchedPath[]): void {
    this.#requireActive();
    this.#operationJournals.writeMergeState(state, touched);
  }

  clearMergeState(): boolean {
    this.#requireActive();
    return this.#operationJournals.clearMergeState();
  }

  requireNoMergeState(): void {
    this.#requireActive();
    this.#operationJournals.requireNoMergeState();
  }

  requireMergeState(): MergeJournal {
    this.#requireActive();
    return this.#operationJournals.requireMergeState();
  }

  // -- index ----------------------------------------------------------

  /** Create clone state only while every index stage is still empty. */
  tryCreateInitialState<T>(body: (session: InitialStateSession) => T): InitialStateResult<T> {
    return this.#indexTable.tryCreateInitialState(body);
  }

  indexEntries(): IndexEntry[] {
    return this.#indexTable.indexEntries();
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return this.#indexTable.indexGet(path, stage);
  }

  indexPut(entry: IndexEntry): void {
    this.#indexTable.indexPut(entry);
  }

  indexRemove(path: string): void {
    this.#indexTable.indexRemove(path);
  }

  indexClear(): void {
    this.#indexTable.indexClear();
  }

  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    this.#indexTable.indexReplace(entries, options);
  }

  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    yield* this.#indexTable.indexScan(options);
  }

  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    return this.#indexTable.indexApply(body, options);
  }

  hasConflicts(): boolean {
    return this.#indexTable.hasConflicts();
  }

  hasCheckoutBlockingIndexEntries(): boolean {
    return this.#indexTable.hasCheckoutBlockingIndexEntries();
  }

  /** Read a complete parsed commit while its exact raw source remains valid. */
  cachedCommit(oid: string): CommitCacheEntry | null {
    return readCommitCache(this.#db, this.#repoId, oid);
  }

  /** Validate raw bytes and prepare an opaque point-cache entry without writing it. */
  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return prepareCommitCache({ repoId: this.#repoId, oid, data });
  }

  /** Lazily add one derived commit row from bytes the caller already read. */
  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return indexCommitSource(this.#db, { repoId: this.#repoId, oid, data });
  }

  /** Insert prepared point misses with the shared row and JSON byte bounds. */
  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return insertCommitCaches(this.#db, entries);
  }

  /** Parsed commits reachable from `rootOid`, read by one bounded recursive cursor. */
  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return readCommitGraph(this.#db, this.#repoId, rootOid, limits);
  }

  // -- shallow --------------------------------------------------------

  shallow(): Set<string> {
    return this.shared.shallow();
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.shared.setShallow(add, remove);
  }

  #nowMilliseconds(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new GitError("EINVAL", "Git store clock must return non-negative integer milliseconds");
    }
    return now;
  }

  #nowSeconds(): number {
    return Math.floor(this.#nowMilliseconds() / 1_000);
  }

  #genericRefLogMetadata(reason: string): RefLogMetadata {
    return {
      actor: null,
      reason,
      timestamp: this.#nowSeconds(),
      timezoneOffset: 0,
    };
  }

  // -- lifecycle ------------------------------------------------------

  /** Drop the shared store and every checkout through foreign-key cascades. */
  destroy(): void {
    this.#requireActive();
    if (this.#onDestroy !== undefined) {
      this.#db.transactionSync(this.#onDestroy);
      return;
    }
    this.#db.transactionSync(() => {
      this.#db.run("DELETE FROM git_repositories WHERE id = ?", this.#repoId);
    });
    this.shared.clearCaches();
  }
}
