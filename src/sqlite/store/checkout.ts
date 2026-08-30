// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import pako from "pako";
import { concat, isOid, toHex } from "../../core/bytes.js";
import { CorruptError, GitError, hasErrorCode, ObjectNotFoundError } from "../../core/errors.js";
import type { ByteLru } from "../../core/lru.js";
import { hashObject, type ObjectType, objectHeader, type RawObject } from "../../core/objects.js";
import {
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_PATH_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  type MergeIndexSnapshot,
  type MergeJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  type MergeWorktreeSnapshot,
  requireMergeInteger,
  requireMergeMode,
  requireMergeNullableInteger,
  requireMergeOid,
  requireMergeOrigin,
  requireMergePhase,
  requireMergePurpose,
  requireMergeText,
} from "../../core/ops/merge-state.js";
import {
  type CherryPickJournal,
  MAX_OPERATION_STEPS,
  type MergeOperationJournal,
  mergeJournalFromOperation,
  mergeOperationState,
  type OperationJournal,
  type OperationKind,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationAlreadyActive,
  operationJournalIntegrityOid,
  operationJournalRetainedBytes,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type RebaseJournal,
  type RebaseStateMetadata,
  type RevertJournal,
} from "../../core/ops/operation-state.js";
import { hasCanonicalRefSyntax } from "../../core/ref-name.js";
import { retainedStringBytes } from "../../core/retained.js";
import { Sha1 } from "../../core/sha1.js";
import { comparePaths } from "../../core/streams.js";
import { deflate, InflateInto, InflateSizeError, InflateStream } from "../../core/zlib.js";
import type { MemoryCoordinator, MemoryReservation } from "../../memory.js";
import { BLOB_ID_CACHE_ELIGIBILITY_BYTES, BLOB_ID_GENERATION_EXHAUSTED } from "../blob-id-cache.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  commitCacheFlushTransientBytes,
  commitPreparationTransientBytes,
  indexCommitSource,
  insertCommitCaches,
  prepareCommitCache,
  prepareCommitCacheOwned,
  readCommitCache,
  readCommitGraph,
} from "../commits.js";
import { blob, readBlob, type SqlDatabase } from "../db.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";
import {
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_ROW_CACHE_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  type PackReadOwnership,
  PackStore,
} from "../packs.js";
import {
  rawSymbolicTarget,
  refTextBytes,
  requireRawRefTarget,
  requireRefName,
} from "../ref-validation.js";
import {
  MAX_REFLOG_ORDINAL,
  MAX_REFLOG_STATE_ROWS,
  MAX_REFLOG_TIMEZONE_MINUTES,
} from "../reflog-schema.js";
import {
  MAX_CHECKOUTS_PER_REPOSITORY,
  MAX_INDEX_PATH_BYTES,
  MAX_SCRATCH_INDEX_NAME_BYTES,
  MAX_TRACKING_REF_REVISIONS,
} from "../schema.js";
import { indexSeededTreeSource, indexSeededTreeSources } from "../tree-index.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "../tree-walk.js";
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
  OwnedObjectBatch,
  RefLogActor,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefMutationExpected,
  RefRow,
  RepositoryLifecycle,
  StoreOptions,
} from "./contracts.js";
import {
  FetchPublicationToken,
  REF_MUTATION_MEMORY_OWNER_TOKEN,
  RefMutationMemoryOwner,
  retainedStringUnits,
  TrackingRefPublicationToken,
} from "./contracts.js";
import type { SharedRepoOwnedOperations, SharedRepoStore } from "./shared.js";

/** Bytes per `git_object_chunks` row. */
export const OBJECT_CHUNK = 1024 * 1024;

/** Small loose objects cost more to deflate than storing their bytes directly. */
export const RAW_OBJECT_MAX = 4 * 1024;

/** Deflate output chunk, and one row, for a streamed write. Smaller than
 *  OBJECT_CHUNK so a streamed object's peak is a chunk, not a megabyte. */
export const STREAM_CHUNK = 64 * 1024;

/** Compressed bytes fed to the inflater at a time when streaming a read. */
export const INFLATE_FEED = 16 * 1024;

/** Compressed bytes gathered into one `substr()` payload, and the trigger
 *  that flushes a batch. Well under the 2 MB ceiling on a bound value. */
export const OBJECT_PAYLOAD = 1024 * 1024;

/** Objects buffered before a batch flushes. The JSON arrays are bound
 *  values too, so the row count is capped as well as the byte count. */
export const DEFAULT_OBJECT_FLUSH = 4096;

/** Oids per existence-probe statement, bounding the same JSON parameter. */
export const OID_PROBE_PAGE = 4096;

/** Opaque content ids encoded into one SQL BLOB parameter per statement. */
export const CONTENT_ID_PAYLOAD = 1024 * 1024;
export const CONTENT_ID_PAGE = 4096;

export const MAX_BLOB_BATCH_OIDS = 4096;

/** Index rows per round trip. This is the memory bound of a scan. */
export const DEFAULT_INDEX_PAGE = 1000;
export const MAX_INDEX_SCAN_PAGE = 2048;

/** Index mutations buffered before a batch is applied. */
export const DEFAULT_INDEX_FLUSH = 512;

/** Non-refusing JSON page target with framing headroom below 2 MiB. */
export const INDEX_MUTATION_JSON_FLUSH_BYTES = 1_500_000;
export const INDEX_MUTATION_ROW_BYTES = 192;
export const INITIAL_STATE_FIXED_BYTES = 64 * 1024;
export const INITIAL_BLOB_ROW_JSON_BYTES = 96;
export const INITIAL_INDEX_EMPTY_RESERVED_BYTES = 8;
export const INITIAL_BLOB_EMPTY_RESERVED_BYTES = 32;
export const INITIAL_STATE_CONSTRUCTOR_BYTES =
  INITIAL_STATE_FIXED_BYTES +
  INITIAL_INDEX_EMPTY_RESERVED_BYTES +
  INITIAL_BLOB_EMPTY_RESERVED_BYTES;

/** Parsed commits staged beside encoded object bytes before a batch flush. */
export const COMMIT_STAGE_CACHE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
export const REFLOG_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const REFLOG_RETENTION_ROWS = 1_024;
export const MAX_REFLOG_ROOT_RETAINED_BYTES = 100 * 1024 * 1024 - 1;
export const REFLOG_ROOT_OBJECT_CACHE_BYTES = DEFAULT_OBJECT_CACHE_BYTES;
export const REFLOG_ROOT_PACK_ROW_CACHE_BYTES = MAX_PACK_ROW_CACHE_BYTES;
export const REFLOG_ROOT_JS_HEADROOM_BYTES = 4 * 1024 * 1024;
export const MAX_REFLOG_ROOT_SCAN_BYTES =
  MAX_REFLOG_ROOT_RETAINED_BYTES -
  REFLOG_ROOT_OBJECT_CACHE_BYTES -
  REFLOG_ROOT_PACK_ROW_CACHE_BYTES -
  REFLOG_ROOT_JS_HEADROOM_BYTES;
export const REFLOG_ROOT_SCAN_FIXED_BYTES = 8 * 1024 * 1024;
/** Legacy per-row envelope retained only to preserve the reviewed structural row cap. */
export const REFLOG_ROOT_ENDPOINT_BYTES = 4_096;
/** Numeric slots, row handles, and sort/group metadata retained per physical row. */
export const REFLOG_ROOT_ROW_FIXED_BYTES = 512;
export const MAX_REFLOG_ROOT_SCAN_ENTRIES = Math.floor(
  (MAX_REFLOG_ROOT_SCAN_BYTES - REFLOG_ROOT_SCAN_FIXED_BYTES) / (2 * REFLOG_ROOT_ENDPOINT_BYTES),
);
export const MAX_REF_MUTATION_INPUTS = 100_000;
export const MAX_FETCH_NAMESPACES = 1_024;
export const MAX_FETCH_PUBLICATION_INPUTS = 100_000;
export const CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES = 1_024;
export const CHECKOUT_RESULT_ARRAY_BYTES = 128;
export const CHECKOUT_RESULT_ARRAY_SLOT_BYTES = 8;
export const CHECKOUT_RESULT_ROW_BYTES = 128;
export const CHECKOUT_ROUTING_MAP_BYTES = 128;
export const CHECKOUT_ROUTING_MAP_ENTRY_BYTES = 72;
export const MAX_CONFIG_SECTION_MOVE_ROWS = 1_024;
export const CONFIG_SECTION_MOVE_UPDATE_SQL = `UPDATE git_config
       SET path = ? || substr(path, length(?) + 1)
     WHERE repo_id = ? AND path >= ? AND path < ?
       AND EXISTS (
         SELECT 1 FROM json_each(?) AS wanted
          WHERE json_extract(wanted.value, '$.path') = git_config.path
            AND json_extract(wanted.value, '$.seq') = git_config.seq
       )`;
export const PROVISIONAL_CLONE_LEASE_MS = 5 * 60 * 1_000;
export const PROVISIONAL_CLONE_RENEW_WINDOW_MS = PROVISIONAL_CLONE_LEASE_MS / 2;
export const REF_ROW_RETAINED_BYTES = 256;
export const REF_MUTATION_ITEM_RETAINED_BYTES = 512;
export const REF_MUTATION_EVENT_RETAINED_BYTES = 2_048;
export const REF_MUTATION_METADATA_RETAINED_BYTES = 256;
export const REF_MUTATION_SQL_HEADROOM_BYTES = 8 * 1024 * 1024;
export const MAX_REF_MUTATION_RETAINED_BYTES = 64 * 1024 * 1024;
export const REF_MUTATION_STATE_FIXED_RETAINED_BYTES = REF_ROW_RETAINED_BYTES;
export const REF_MUTATION_FIXED_RETAINED_BYTES =
  REF_MUTATION_SQL_HEADROOM_BYTES + REF_MUTATION_STATE_FIXED_RETAINED_BYTES;
/** Conservative SQL ceiling for one direct-ref or raw-HEAD publication. */

export interface ConfigSectionCandidateMetadata {
  readonly path: string;
  readonly seq: number;
  readonly pathBytes: number;
  readonly valueType: unknown;
  readonly valueBytes: number | null;
}

export interface ConfigSectionMoveMetadata extends ConfigSectionCandidateMetadata {
  readonly valueBytes: number;
}

export function createRefMutationMemoryOwner(store: SharedRepoStore): RefMutationMemoryOwner {
  const reservation = store.reserveMemory();
  try {
    return new RefMutationMemoryOwner(REF_MUTATION_MEMORY_OWNER_TOKEN, reservation);
  } catch (error) {
    reservation.dispose();
    throw error;
  }
}

export function validateRefMutationMemoryOwner(
  store: SharedRepoStore,
  owner: RefMutationMemoryOwner,
  operation: string,
): MemoryReservation {
  if (!(owner instanceof RefMutationMemoryOwner)) {
    throw new GitError("EINVAL", `${operation} memory owner was not issued by the store`);
  }
  const reservation = owner.memoryReservation();
  if (reservation.disposed) {
    throw new GitError("EINVAL", `${operation} memory owner is disposed`);
  }
  if (!store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", `${operation} memory owner belongs to another repository`);
  }
  return reservation;
}

export type OwnedRefMutation = (
  mutation: RefMutation,
  metadata: RefLogMetadata,
  owner: RefMutationMemoryOwner,
) => boolean;

export const OWNED_REF_MUTATIONS = new WeakMap<CheckoutStore, OwnedRefMutation>();

export function mutateRefsOwned(
  store: CheckoutStore,
  mutation: RefMutation,
  metadata: RefLogMetadata,
  owner: RefMutationMemoryOwner,
): boolean {
  const mutate = OWNED_REF_MUTATIONS.get(store);
  if (mutate === undefined) throw new GitError("EINVAL", "checkout store is not active");
  return mutate(mutation, metadata, owner);
}

export type OwnedConfigGet = (path: string, owner: RefMutationMemoryOwner) => string | undefined;

export const OWNED_CONFIG_GETTERS = new WeakMap<SharedRepoStore, OwnedConfigGet>();

/** Internal last-value config read retained by an existing ref-mutation owner. */
export function configGetOwned(
  store: SharedRepoStore,
  path: string,
  owner: RefMutationMemoryOwner,
): string | undefined {
  const get = OWNED_CONFIG_GETTERS.get(store);
  if (get === undefined)
    throw new GitError("EINVAL", "shared repository operations are unavailable");
  return get(path, owner);
}

export interface OwnedOperationJournalAccess {
  read(reservation: MemoryReservation): OperationJournal | null;
  write(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
    reservation: MemoryReservation,
  ): void;
  replaceState(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    reservation: MemoryReservation,
  ): void;
  replaceJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
    reservation: MemoryReservation,
  ): void;
}

export const OWNED_OPERATION_JOURNALS = new WeakMap<CheckoutStore, OwnedOperationJournalAccess>();

export function operationJournalAccess(store: CheckoutStore): OwnedOperationJournalAccess {
  const access = OWNED_OPERATION_JOURNALS.get(store);
  if (access === undefined) throw new GitError("EINVAL", "checkout store is not active");
  return access;
}

/** Internal journal read retained under an existing repository operation. */
export function readOperationStateOwned(
  store: CheckoutStore,
  reservation: MemoryReservation,
): OperationJournal | null {
  return operationJournalAccess(store).read(reservation);
}

/** Internal journal creation retained under an existing repository operation. */
export function writeOperationJournalOwned(
  store: CheckoutStore,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
  reservation: MemoryReservation,
): void {
  operationJournalAccess(store).write(state, steps, touched, reservation);
}

/** Internal metadata replacement retained under an existing repository operation. */
export function replaceOperationStateOwned(
  store: CheckoutStore,
  expectedIntegrityOid: string,
  state: OperationStateMetadata,
  reservation: MemoryReservation,
): void {
  operationJournalAccess(store).replaceState(expectedIntegrityOid, state, reservation);
}

/** Internal whole-journal replacement retained under an existing repository operation. */
export function replaceOperationJournalOwned(
  store: CheckoutStore,
  expectedIntegrityOid: string,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
  reservation: MemoryReservation,
): void {
  operationJournalAccess(store).replaceJournal(
    expectedIntegrityOid,
    state,
    steps,
    touched,
    reservation,
  );
}

export interface RefLogEvent {
  refName: string;
  ordinal: number;
  oldRaw: string | null;
  newRaw: string | null;
  oldOid: string | null;
  newOid: string | null;
  actorName: string | null;
  actorEmail: string | null;
  timestamp: number;
  timezoneOffset: number;
  reason: string;
}

export interface CheckoutRefLogEvent extends RefLogEvent {
  checkoutId: number;
}

export interface NormalizedRefMutation {
  puts: Map<string, string>;
  deletes: Set<string>;
  head: string | undefined;
  expected: RefMutationExpected | undefined;
  budget: RefMutationBudget;
}

export interface FetchPublicationState {
  readonly generation: number;
  readonly trackingPrefix: string;
  readonly namespaceRevision: number;
  readonly shallowRevision: number;
  readonly trackingRefs: ReadonlyMap<string, string>;
  readonly exactRefs: ReadonlyMap<string, string | null>;
  readonly checkoutRevision: number;
  readonly budget: RefMutationBudget;
  readonly reservation: MemoryReservation;
  readonly owner: RefMutationMemoryOwner | undefined;
  disposed: boolean;
}

export interface TrackingRefPublicationState {
  readonly refName: string;
  readonly target: string | null;
  readonly refRevision: number;
  readonly budget: RefMutationBudget;
  readonly reservation: MemoryReservation;
  disposed: boolean;
}

export interface NormalizedFetchPublication {
  readonly refs: NormalizedRefMutation;
  readonly shallowAdd: readonly string[];
  readonly shallowRemove: readonly string[];
}

export interface OperationStateRow {
  kind: unknown;
  original_head_ref: unknown;
  original_head_oid: unknown;
  phase: unknown;
  empty_reason: unknown;
  current_parent_oid: unknown;
  incoming_parent_oid: unknown;
  upstream_oid: unknown;
  base_oid: unknown;
  mode: unknown;
  merge_origin: unknown;
  current_step: unknown;
  step_count: unknown;
  current_label: unknown;
  incoming_label: unknown;
  message: unknown;
  author_name: unknown;
  author_email: unknown;
  committer_name: unknown;
  committer_email: unknown;
  touched_count: unknown;
  retained_bytes: unknown;
  integrity_oid: unknown;
}

export interface OperationStepRow {
  ordinal: unknown;
  source_oid: unknown;
  selected_parent_oid: unknown;
  mainline: unknown;
  outcome: unknown;
  result_oid: unknown;
}

export interface OperationTouchedRow {
  ordinal: unknown;
  path: unknown;
  logical_path: unknown;
  purpose: unknown;
  index_stage: unknown;
  index_mode: unknown;
  index_oid: unknown;
  index_size: unknown;
  index_mtime: unknown;
  index_ino: unknown;
  index_rev: unknown;
  worktree_kind: unknown;
  worktree_mode: unknown;
  worktree_oid: unknown;
  worktree_revision: unknown;
}

export interface PersistedOperationTouched {
  ordinal: number;
  path: string;
  logicalPath: string;
  purpose: string;
  indexStage: number | null;
  indexMode: number | null;
  indexOid: string | null;
  indexSize: number | null;
  indexMtime: number | null;
  indexIno: number | null;
  indexRev: number | null;
  worktreeKind: string;
  worktreeMode: number | null;
  worktreeOid: string | null;
  worktreeRevision: number | null;
}

export interface PersistedOperationStep {
  ordinal: number;
  sourceOid: string;
  selectedParentOid: string | null;
  mainline: number | null;
  outcome: string;
  resultOid: string | null;
}

export interface ObjectReadMetadata {
  ordinal: number;
  oid: string;
  source: "loose" | "pack";
  type: ObjectType;
  size: number;
  stored: "raw" | "zlib" | null;
}

export interface ExpectedOperationObject {
  oid: string;
  type: "blob" | "commit";
  label: string;
}

/** Stable, collision-free key for an opaque binary content id. */
export function contentIdKey(contentId: Uint8Array): string {
  return toHex(contentId);
}

export type OwnedObjectBatchFactory = (
  reservation: MemoryReservation,
  options: ObjectBatchOptions,
) => OwnedObjectBatch;

export type OwnedAuthenticatedObjectReader = (
  oid: string,
  expectedType: ObjectType,
  reservation: MemoryReservation,
) => RawObject | null;

export const OWNED_OBJECT_BATCHES = new WeakMap<SharedRepoStore, OwnedObjectBatchFactory>();
export const OWNED_AUTHENTICATED_OBJECT_READERS = new WeakMap<
  SharedRepoStore,
  OwnedAuthenticatedObjectReader
>();

export function ownedObjectBatchFactory(store: SharedRepoStore): OwnedObjectBatchFactory {
  const factory = OWNED_OBJECT_BATCHES.get(store);
  if (factory === undefined)
    throw new GitError("EINVAL", "repository object writer is unavailable");
  return factory;
}

/** Internal object batch whose staged allocations remain charged until flush. */
export function writeBatchOwned(
  store: SharedRepoStore,
  reservation: MemoryReservation,
  options: ObjectBatchOptions = {},
): OwnedObjectBatch {
  return ownedObjectBatchFactory(store)(reservation, options);
}

/** Internal scoped object writer retained under an existing operation owner. */
export function writeObjectsOwned<T>(
  store: SharedRepoStore,
  reservation: MemoryReservation,
  body: (batch: ObjectBatch) => T,
  options: ObjectBatchOptions = {},
): T {
  const batch = writeBatchOwned(store, reservation, options);
  try {
    const result = body(batch);
    if (isThenableResult(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new GitError("EINVAL", "object batch callback must be synchronous");
    }
    batch.flush();
    return result;
  } finally {
    batch.dispose();
  }
}

/** Internal authenticated read covered by a caller's pre-admitted live-set owner. */
export function readAuthenticatedObjectOwned(
  store: SharedRepoStore,
  oid: string,
  expectedType: ObjectType,
  reservation: MemoryReservation,
): RawObject | null {
  const read = OWNED_AUTHENTICATED_OBJECT_READERS.get(store);
  if (read === undefined) {
    throw new GitError("EINVAL", "repository authenticated object reader is unavailable");
  }
  return read(oid, expectedType, reservation);
}

/** Internal shallow-boundary snapshot retained under an existing graph owner. */
export function readShallowOwned(
  store: SharedRepoStore,
  reservation: MemoryReservation,
): Set<string> {
  if (!store.ownsMemoryReservation(reservation)) {
    throw new GitError("EINVAL", "shallow reservation belongs to another repository");
  }
  const metadata = store.db.one<{
    rows: unknown;
    text_bytes: unknown;
    max_oid_bytes: unknown;
  }>(
    `SELECT count(*) AS rows,
            coalesce(sum(length(CAST(oid AS BLOB))), 0) AS text_bytes,
            coalesce(max(length(CAST(oid AS BLOB))), 0) AS max_oid_bytes
       FROM git_shallow WHERE repo_id = ?`,
    store.repoId,
  );
  if (
    metadata === undefined ||
    typeof metadata.rows !== "number" ||
    !Number.isSafeInteger(metadata.rows) ||
    metadata.rows < 0 ||
    typeof metadata.text_bytes !== "number" ||
    !Number.isSafeInteger(metadata.text_bytes) ||
    metadata.text_bytes < 0 ||
    typeof metadata.max_oid_bytes !== "number" ||
    !Number.isSafeInteger(metadata.max_oid_bytes) ||
    metadata.max_oid_bytes < 0 ||
    (metadata.rows === 0) !== (metadata.max_oid_bytes === 0)
  ) {
    throw new CorruptError("shallow boundary metadata is invalid");
  }
  const retainedBytes = 256 + metadata.rows * (64 + 48) + 2 * metadata.text_bytes;
  const peakBytes =
    retainedBytes +
    (metadata.max_oid_bytes === 0 ? 0 : currentTextRowRetainedBytes(metadata.max_oid_bytes));
  if (!Number.isSafeInteger(retainedBytes) || !Number.isSafeInteger(peakBytes)) {
    throw new GitError("E2BIG", "shallow boundary retained-memory accounting overflow");
  }
  reservation.set("other", peakBytes);
  const boundary = new Set<string>();
  let previous: string | null = null;
  let observedBytes = 0;
  for (const row of store.db.iterate(
    `SELECT repo_id, typeof(oid) AS oid_type,
            length(CAST(oid AS BLOB)) AS oid_bytes,
            CAST(oid AS BLOB) AS oid_blob
       FROM git_shallow WHERE repo_id = ? ORDER BY oid`,
    store.repoId,
  )) {
    if (row.repo_id !== store.repoId || boundary.size >= metadata.rows) {
      throw new CorruptError("shallow boundary crossed repositories or changed cardinality");
    }
    const oidBytes = requireStoredTextByteLength(
      row.oid_type,
      row.oid_bytes,
      "stored shallow object id",
    );
    if (oidBytes > metadata.max_oid_bytes) {
      throw new CorruptError("shallow boundary changed after metadata preflight");
    }
    const oid = requireCanonicalStoredText(row.oid_type, row.oid_blob, "stored shallow object id");
    if (!isOid(oid)) throw new CorruptError(`invalid shallow object id ${oid}`);
    if (previous !== null && comparePaths(previous, oid) >= 0) {
      throw new CorruptError("shallow object ids are not in strict byte order");
    }
    boundary.add(oid);
    previous = oid;
    observedBytes += oidBytes;
  }
  if (boundary.size !== metadata.rows || observedBytes !== metadata.text_bytes) {
    throw new CorruptError("shallow boundary changed after metadata preflight");
  }
  reservation.set("other", retainedBytes);
  return boundary;
}

export type LooseEncoding = "raw" | "zlib";

/** One object staged in a batch, already hashed and encoded for storage. */
export interface StagedObject {
  oid: string;
  type: ObjectType;
  size: number;
  stored: LooseEncoding;
  storedData: Uint8Array;
  treeData?: Uint8Array;
  commitEntry?: CommitCacheEntry;
}

/** One `substr()` payload: the bytes, and the rows cut out of them. */
export interface ChunkPayload {
  parts: Uint8Array[];
  length: number;
  rows: { o: string; q: number; a: number; n: number }[];
}

export interface ContentIdPage {
  payload: Uint8Array;
  rows: { a: number; n: number }[];
}

export interface ExpectedContentIdPage {
  payload: Uint8Array;
  rows: { i: number; a: number; n: number; o: string }[];
}

export interface ExpectedBlobIdMapping extends BlobIdMapping {
  ordinal: number;
}

export interface BlobIdWriteRow {
  a: number;
  n: number;
  o: string;
}

export const BLOB_ID_MISMATCH_ROW_BYTES = 384;

export function blobIdMismatchRetainedBytes(mapping: BlobIdMapping): number {
  return BLOB_ID_MISMATCH_ROW_BYTES + mapping.contentId.length + mapping.oid.length * 2;
}

export function blobIdRetainedTotal(current: number, addition: number, label: string): number {
  const next = current + addition;
  if (!Number.isSafeInteger(next)) {
    throw new GitError("E2BIG", `${label} retained-memory accounting overflow`);
  }
  return next;
}

export function* contentIdPages(
  contentIds: Iterable<Uint8Array>,
  reservation: MemoryReservation,
): Generator<ContentIdPage> {
  const unique = new Map<string, Uint8Array>();
  let retainedBytes = 0;
  const inputMemory = reservation.scope();
  const pageMemory = reservation.scope();
  try {
    for (const contentId of contentIds) {
      if (contentId.length > BLOB_ID_CACHE_ELIGIBILITY_BYTES) continue;
      const keyBytes = contentId.length * 4;
      const nextBytes = blobIdRetainedTotal(
        retainedBytes,
        BLOB_ID_MISMATCH_ROW_BYTES + contentId.length + keyBytes,
        "blob id lookup",
      );
      inputMemory.set("other", nextBytes);
      const snapshot = contentId.slice();
      const key = contentIdKey(snapshot);
      if (!unique.has(key)) {
        retainedBytes = nextBytes;
        unique.set(key, snapshot);
      } else {
        unique.set(key, snapshot);
        inputMemory.set("other", retainedBytes);
      }
    }
    let parts: Uint8Array[] = [];
    let rows: { a: number; n: number }[] = [];
    let length = 0;
    let pageBytes = 256;
    for (const contentId of unique.values()) {
      if (
        rows.length > 0 &&
        (rows.length >= CONTENT_ID_PAGE || length + contentId.length > CONTENT_ID_PAYLOAD)
      ) {
        pageMemory.set("other", blobIdRetainedTotal(pageBytes, length, "blob id lookup page"));
        yield { payload: concat(parts), rows };
        parts = [];
        rows = [];
        length = 0;
        pageBytes = 256;
        pageMemory.set("other", pageBytes);
      }
      pageBytes = blobIdRetainedTotal(pageBytes, 96, "blob id lookup page");
      pageMemory.set("other", pageBytes);
      rows.push({ a: length + 1, n: contentId.length });
      parts.push(contentId);
      length += contentId.length;
    }
    if (rows.length > 0) {
      pageMemory.set("other", blobIdRetainedTotal(pageBytes, length, "blob id lookup page"));
      yield { payload: concat(parts), rows };
    }
  } finally {
    pageMemory.dispose();
    inputMemory.dispose();
  }
}

export function writeBlobIdPage(
  db: SqlDatabase,
  repoId: number,
  payload: Uint8Array,
  rows: readonly BlobIdWriteRow[],
  begin: boolean,
  finish: boolean,
): void {
  try {
    db.run(
      `WITH input(repo_id, payload, batch) AS MATERIALIZED (VALUES (?, ?, ?))
       INSERT INTO git_blob_id_updates (repo_id, content_id, oid, operation, ordinal)
       SELECT repo_id, content_id, oid, operation, ordinal
         FROM (
           SELECT CAST(repo_id AS INTEGER) AS repo_id, zeroblob(0) AS content_id, '' AS oid,
                  'begin' AS operation, -1 AS ordinal
             FROM input WHERE json_extract(batch, '$.b') = 1
           UNION ALL
           SELECT CAST(repo_id AS INTEGER),
                  CASE WHEN json_extract(j.value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(payload, json_extract(j.value, '$.a'),
                                            json_extract(j.value, '$.n'))
                   END,
                  json_extract(j.value, '$.o'), 'mapping', CAST(j.key AS INTEGER)
             FROM input, json_each(input.batch, '$.r') j
           UNION ALL
           SELECT CAST(repo_id AS INTEGER), zeroblob(0), '', 'finish',
                  json_array_length(batch, '$.r')
             FROM input WHERE json_extract(batch, '$.f') = 1
         )
        ORDER BY ordinal`,
      repoId,
      blob(payload),
      JSON.stringify({ b: begin ? 1 : 0, f: finish ? 1 : 0, r: rows }),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes(BLOB_ID_GENERATION_EXHAUSTED)) {
      throw new GitError("E2BIG", BLOB_ID_GENERATION_EXHAUSTED, { cause: error });
    }
    throw error;
  }
}

/** Expected mappings in pages whose BLOB and JSON inputs stay bounded. */
export function* expectedContentIdPages(
  mappings: readonly ExpectedBlobIdMapping[],
  reservation: MemoryReservation,
): Generator<ExpectedContentIdPage> {
  let parts: Uint8Array[] = [];
  let rows: { i: number; a: number; n: number; o: string }[] = [];
  let length = 0;
  let retainedBytes = 256;
  const pageMemory = reservation.scope();

  try {
    pageMemory.set("other", retainedBytes);
    for (const mapping of mappings) {
      if (mapping === undefined) continue;
      if (
        rows.length > 0 &&
        (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
      ) {
        pageMemory.set(
          "other",
          blobIdRetainedTotal(retainedBytes, length, "blob id comparison page"),
        );
        yield { payload: concat(parts), rows };
        parts = [];
        rows = [];
        length = 0;
        retainedBytes = 256;
        pageMemory.set("other", retainedBytes);
      }
      retainedBytes = blobIdRetainedTotal(
        retainedBytes,
        160 + mapping.oid.length * 2,
        "blob id comparison page",
      );
      pageMemory.set("other", retainedBytes);
      rows.push({
        i: mapping.ordinal,
        a: length + 1,
        n: mapping.contentId.length,
        o: mapping.oid,
      });
      parts.push(mapping.contentId);
      length += mapping.contentId.length;
    }
    if (rows.length > 0) {
      pageMemory.set(
        "other",
        blobIdRetainedTotal(retainedBytes, length, "blob id comparison page"),
      );
      yield { payload: concat(parts), rows };
    }
  } finally {
    pageMemory.dispose();
  }
}

export function requireCommitCacheWrites(result: CommitCacheWriteResult, expected: number): void {
  if (result.written !== result.eligible || result.eligible + result.skipped !== expected) {
    throw new CorruptError(`commit cache wrote ${result.written} of ${expected} required rows`);
  }
}

export interface BufferedIndexMutation {
  kind: "p" | "r";
  json: string;
  bytes: number;
}

export function looseEncoding(size: number): LooseEncoding {
  return size <= RAW_OBJECT_MAX ? "raw" : "zlib";
}

export function encodeLoose(data: Uint8Array, stored: LooseEncoding): Uint8Array {
  return stored === "raw" ? data : deflate(data);
}

export function maximumDeflatedBytes(bytes: number): number {
  const maximum =
    bytes +
    Math.floor(bytes / 4_096) +
    Math.floor(bytes / 16_384) +
    Math.floor(bytes / 33_554_432) +
    13;
  if (!Number.isSafeInteger(maximum)) {
    throw new GitError("E2BIG", "object compression memory accounting overflow");
  }
  return maximum;
}

export function* stagedCommitEntries(objects: Iterable<StagedObject>): Generator<CommitCacheEntry> {
  for (const object of objects) {
    if (object.commitEntry !== undefined) yield object.commitEntry;
  }
}

export function objectFlushInitialRetainedBytes(objectCount: number): number {
  const retained = 64 + objectCount * 8;
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "object flush memory accounting overflow");
  }
  return retained;
}

export function objectFlushTransientBytes(
  objects: readonly StagedObject[],
  payloadBytes: number,
): number {
  let metadataUnits = 2;
  let metadataBytes = 2;
  let oidUnits = 2;
  let oidBytes = 2;
  let treeCount = 0;
  let commitCount = 0;
  let chunkRows = 0;
  let payloadCount = 1;
  let currentPayloadBytes = 0;
  let currentPayloadRows = 0;
  let largestPayloadBytes = 0;
  let largestPayloadRows = 0;
  let maximumPayloadRowUnits = 0;
  let maximumPayloadRowBytes = 0;
  for (let objectIndex = 0; objectIndex < objects.length; objectIndex++) {
    const object = objects[objectIndex];
    if (object === undefined) throw new CorruptError("object flush input is sparse");
    const separator = objectIndex === 0 ? 0 : 1;
    metadataUnits +=
      separator +
      64 +
      jsonStringMaxUnits(object.oid) +
      jsonStringMaxUnits(object.type) +
      jsonStringMaxUnits(object.stored) +
      24;
    metadataBytes +=
      separator +
      64 +
      jsonStringEncodedBytes(object.oid) +
      jsonStringEncodedBytes(object.type) +
      jsonStringEncodedBytes(object.stored) +
      24;
    oidUnits += separator + jsonStringMaxUnits(object.oid);
    oidBytes += separator + jsonStringEncodedBytes(object.oid);
    if (object.treeData !== undefined) treeCount++;
    if (object.commitEntry !== undefined) commitCount++;
    maximumPayloadRowUnits = Math.max(
      maximumPayloadRowUnits,
      64 + jsonStringMaxUnits(object.oid) + 3 * 24,
    );
    maximumPayloadRowBytes = Math.max(
      maximumPayloadRowBytes,
      64 + jsonStringEncodedBytes(object.oid) + 3 * 24,
    );
    for (
      let offset = 0, sequence = 0;
      offset < object.storedData.length || sequence === 0;
      offset += OBJECT_CHUNK, sequence++
    ) {
      const partBytes = Math.min(OBJECT_CHUNK, Math.max(0, object.storedData.length - offset));
      if (currentPayloadBytes > 0 && currentPayloadBytes + partBytes > payloadBytes) {
        largestPayloadBytes = Math.max(largestPayloadBytes, currentPayloadBytes);
        largestPayloadRows = Math.max(largestPayloadRows, currentPayloadRows);
        payloadCount++;
        currentPayloadBytes = 0;
        currentPayloadRows = 0;
      }
      currentPayloadBytes += partBytes;
      currentPayloadRows++;
      chunkRows++;
    }
  }
  largestPayloadBytes = Math.max(largestPayloadBytes, currentPayloadBytes);
  largestPayloadRows = Math.max(largestPayloadRows, currentPayloadRows);
  const payloadRowUnits =
    2 + largestPayloadRows * maximumPayloadRowUnits + Math.max(0, largestPayloadRows - 1);
  const payloadRowBytes =
    2 + largestPayloadRows * maximumPayloadRowBytes + Math.max(0, largestPayloadRows - 1);
  const collections =
    1_024 +
    objects.length * (256 + 128 + 8 + 8) +
    commitCount * 8 +
    payloadCount * 384 +
    chunkRows * (96 + 192) +
    treeCount * 384;
  const retained =
    collections +
    retainedStringUnits(metadataUnits) +
    metadataBytes +
    retainedStringUnits(oidUnits) +
    oidBytes +
    retainedStringUnits(payloadRowUnits) +
    payloadRowBytes +
    largestPayloadBytes +
    commitCacheFlushTransientBytes(stagedCommitEntries(objects));
  if (
    !Number.isSafeInteger(metadataUnits) ||
    !Number.isSafeInteger(metadataBytes) ||
    !Number.isSafeInteger(oidUnits) ||
    !Number.isSafeInteger(oidBytes) ||
    !Number.isSafeInteger(collections) ||
    !Number.isSafeInteger(retained)
  ) {
    throw new GitError("E2BIG", "object flush memory accounting overflow");
  }
  return retained;
}

export function parseLooseEncoding(stored: string): LooseEncoding {
  if (stored === "raw" || stored === "zlib") return stored;
  throw new CorruptError(`loose object has unknown storage encoding '${stored}'`);
}

export function isObjectType(value: string | null): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

export const JSON_ENCODER = new TextEncoder();
export const CANONICAL_TEXT_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
export const JSON_BATCH_ROWS = 2_048;
export const JSON_BATCH_BYTES = 1_500_000;
export const CONFIG_READ_FIXED_RETAINED_BYTES = 512;

export interface JsonPageMemory<T> {
  readonly reservation: MemoryReservation;
  readonly maxUnits: (item: T) => number;
}

export function currentTextRowRetainedBytes(textBytes: number, stringSlots = 1): number {
  if (
    !Number.isSafeInteger(textBytes) ||
    textBytes < 0 ||
    !Number.isSafeInteger(stringSlots) ||
    stringSlots < 0
  ) {
    throw new CorruptError("stored text row metadata is invalid");
  }
  return REF_ROW_RETAINED_BYTES + textBytes + stringSlots * 48 + 2 * textBytes;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) index++;
      bytes += low >= 0xdc00 && low <= 0xdfff ? 4 : 3;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 3;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

export function checkoutRootInputRetainedBytes(value: string): number {
  const relativePrefix = value.startsWith("/") ? 0 : 1;
  const sourceUnits = value.length + relativePrefix;
  let parts = 1 + relativePrefix;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 0x2f) parts++;
  }
  const sourceBytes = utf8ByteLength(value) + relativePrefix;
  const retained =
    1_024 +
    retainedStringUnits(value.length) +
    (relativePrefix === 0 ? 0 : retainedStringUnits(sourceUnits)) +
    128 +
    parts * 64 +
    2 * sourceUnits +
    2 * retainedStringUnits(sourceUnits + 1) +
    2 * (256 + sourceBytes);
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "checkout root memory accounting overflow");
  }
  return retained;
}

export function checkoutRootSqlRetainedBytes(input: string, normalized: string): number {
  const normalizedBytes = utf8ByteLength(normalized);
  const retained =
    512 +
    retainedStringUnits(input.length) +
    retainedStringUnits(normalized.length) +
    2 * (256 + normalizedBytes);
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "checkout root memory accounting overflow");
  }
  return retained;
}

export function checkoutResultRowRetainedBytes(row: CheckoutRow): number {
  return (
    CHECKOUT_RESULT_ARRAY_SLOT_BYTES +
    CHECKOUT_RESULT_ROW_BYTES +
    retainedStringBytes(row.root) +
    retainedStringBytes(row.head)
  );
}

export function checkoutRootResultRetainedBytes(root: string): number {
  return CHECKOUT_RESULT_ARRAY_SLOT_BYTES + retainedStringBytes(root);
}

export function requireCheckoutRootInput(value: unknown): string {
  if (typeof value !== "string") {
    throw new GitError("EINVAL", "checkout root is invalid");
  }
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 0) {
      throw new GitError("EINVAL", "checkout root is invalid");
    }
  }
  return value;
}

export function requireStoredTextByteLength(
  type: unknown,
  bytes: unknown,
  label: string,
  minimum = 1,
): number {
  if (
    type !== "text" ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < minimum
  ) {
    throw new CorruptError(`${label} has invalid text metadata`);
  }
  return bytes;
}

export function requireMaximumStoredTextBytes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError(`${label} metadata is invalid`);
  }
  return value;
}

export function jsonStringMaxUnits(value: string): number {
  let units = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      units += 2;
    } else if (unit < 0x20) {
      units += 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        units += 2;
        index++;
      } else {
        units += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      units += 6;
    } else {
      units++;
    }
  }
  return units;
}

export function jsonStringEncodedBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      bytes += 2;
    } else if (unit < 0x20) {
      bytes += 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

export function refRowJsonMaxUnits(row: RefRow): number {
  return 19 + jsonStringMaxUnits(row.name) + jsonStringMaxUnits(row.target);
}

export function* jsonPages<T>(
  items: Iterable<T>,
  _label: string,
  memory?: JsonPageMemory<T>,
): Generator<string> {
  let rows: string[] = [];
  let bytes = 2;
  let retained = 256;
  const pageMemory = memory?.reservation.scope();
  const emit = function* (pendingBytes = 0): Generator<string> {
    const joinedUnits = Math.max(0, bytes - 2);
    pageMemory?.set(
      "other",
      retained +
        pendingBytes +
        retainedStringUnits(joinedUnits) +
        retainedStringUnits(joinedUnits + 2),
    );
    const joined = rows.join(",");
    yield `[${joined}]`;
  };
  try {
    pageMemory?.set("other", retained);
    for (const item of items) {
      if (memory !== undefined) {
        pageMemory?.set("other", retained + retainedStringUnits(memory.maxUnits(item)));
      }
      const row = JSON.stringify(item);
      const rowBytes = refTextBytes(row, "JSON batch row", "input");
      const separator = rows.length === 0 ? 0 : 1;
      if (
        rows.length > 0 &&
        (rows.length >= JSON_BATCH_ROWS || bytes + separator + rowBytes > JSON_BATCH_BYTES)
      ) {
        const pendingBytes = retainedStringBytes(row);
        yield* emit(pendingBytes);
        rows = [];
        bytes = 2;
        retained = 256;
        pageMemory?.set("other", retained + pendingBytes);
      }
      bytes += (rows.length === 0 ? 0 : 1) + rowBytes;
      rows.push(row);
      retained += 8 + retainedStringBytes(row);
      pageMemory?.set("other", retained);
      if (bytes >= JSON_BATCH_BYTES) {
        yield* emit();
        rows = [];
        bytes = 2;
        retained = 256;
        pageMemory?.set("other", retained);
      }
    }
    if (rows.length > 0) yield* emit();
  } finally {
    pageMemory?.dispose();
  }
}

export function requireNullableRawRefTarget(value: unknown, label: string): string | null {
  return value === null ? null : requireRawRefTarget(value, label, "stored");
}

export function requireNullableRefLogOid(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`${label} is not a valid object id`);
  }
  return value;
}

export function requireStoredRefLogEndpoint(
  rawValue: unknown,
  oidValue: unknown,
  label: string,
): { raw: string | null; oid: string | null } {
  const raw = requireNullableRawRefTarget(rawValue, `reflog ${label} raw target`);
  const oid = requireNullableRefLogOid(oidValue, `reflog ${label} OID`);
  if (raw === null) {
    if (oid !== null) throw new CorruptError(`reflog ${label} absent endpoint has an OID`);
    return { raw, oid };
  }
  if (isOid(raw)) {
    if (oid !== raw) throw new CorruptError(`reflog ${label} direct endpoint OID does not match`);
    return { raw, oid };
  }
  if (rawSymbolicTarget(raw) === null) {
    throw new CorruptError(`reflog ${label} symbolic endpoint is invalid`);
  }
  return { raw, oid };
}

export function requireSafeRefLogInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

export function requireRefLogIdentityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CorruptError(`${label} is invalid`);
  }
  refTextBytes(value, label, "stored");
  if (value.includes("<") || value.includes(">")) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function requireStoredRefLogEntry(
  row: Record<string, unknown>,
  repoId: number,
): RefLogEntry {
  if (row.repo_id !== repoId) throw new CorruptError("reflog row belongs to another repository");
  const refName = requireRefName(
    requireCanonicalStoredText(row.ref_name_type, row.ref_name_blob, "reflog ref name"),
    "reflog ref name",
    "stored",
    true,
  );
  const ordinal = requireSafeRefLogInteger(row.ordinal, "reflog ordinal", 1, MAX_REFLOG_ORDINAL);
  const oldEndpoint = requireStoredRefLogEndpoint(
    requireNullableCanonicalStoredText(row.old_raw_type, row.old_raw_blob, "reflog old raw target"),
    requireNullableCanonicalStoredText(row.old_oid_type, row.old_oid_blob, "reflog old OID"),
    "old",
  );
  const newEndpoint = requireStoredRefLogEndpoint(
    requireNullableCanonicalStoredText(row.new_raw_type, row.new_raw_blob, "reflog new raw target"),
    requireNullableCanonicalStoredText(row.new_oid_type, row.new_oid_blob, "reflog new OID"),
    "new",
  );
  if (
    refName !== "HEAD" &&
    oldEndpoint.raw === newEndpoint.raw &&
    oldEndpoint.oid === newEndpoint.oid
  ) {
    throw new CorruptError("reflog row does not change either endpoint");
  }
  let actor: RefLogActor | null;
  if (
    row.actor_name_type === "null" &&
    row.actor_name_blob === null &&
    row.actor_email_type === "null" &&
    row.actor_email_blob === null
  ) {
    actor = null;
  } else if (
    row.actor_name_type === "text" &&
    row.actor_name_blob !== null &&
    row.actor_email_type === "text" &&
    row.actor_email_blob !== null
  ) {
    actor = {
      name: requireRefLogIdentityText(
        requireCanonicalStoredText(row.actor_name_type, row.actor_name_blob, "reflog actor name"),
        "reflog actor name",
      ),
      email: requireRefLogIdentityText(
        requireCanonicalStoredText(
          row.actor_email_type,
          row.actor_email_blob,
          "reflog actor email",
        ),
        "reflog actor email",
      ),
    };
  } else {
    throw new CorruptError("reflog actor is incomplete");
  }
  const timestamp = requireSafeRefLogInteger(
    row.timestamp,
    "reflog timestamp",
    0,
    MAX_REFLOG_ORDINAL,
  );
  const timezoneOffset = requireSafeRefLogInteger(
    row.timezone,
    "reflog timezone",
    -MAX_REFLOG_TIMEZONE_MINUTES,
    MAX_REFLOG_TIMEZONE_MINUTES,
  );
  const reason = requireCanonicalStoredText(row.reason_type, row.reason_blob, "reflog reason");
  if (reason === "") {
    throw new CorruptError("reflog reason is invalid");
  }
  refTextBytes(reason, "reflog reason", "stored");
  return {
    refName,
    ordinal,
    oldRaw: oldEndpoint.raw,
    newRaw: newEndpoint.raw,
    oldOid: oldEndpoint.oid,
    newOid: newEndpoint.oid,
    actor,
    timestamp,
    timezoneOffset,
    reason,
  };
}

export function requireRefLogReadInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new GitError("EINVAL", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function requireRefLogLimit(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 1_000) {
    throw new GitError("E2BIG", "reflog limit exceeds 1,000 entries");
  }
  return requireRefLogReadInteger(value, "reflog limit", 0, 1_000);
}

export function validateRefLogRootScanBudget(
  value:
    | { rows: unknown; text_bytes: unknown; max_row_bytes: unknown; head_bytes: unknown }
    | undefined,
): void {
  if (
    value === undefined ||
    typeof value.rows !== "number" ||
    !Number.isSafeInteger(value.rows) ||
    value.rows < 0 ||
    typeof value.text_bytes !== "number" ||
    !Number.isSafeInteger(value.text_bytes) ||
    value.text_bytes < 0 ||
    typeof value.max_row_bytes !== "number" ||
    !Number.isSafeInteger(value.max_row_bytes) ||
    value.max_row_bytes < 0 ||
    value.max_row_bytes > value.text_bytes ||
    typeof value.head_bytes !== "number" ||
    !Number.isSafeInteger(value.head_bytes) ||
    value.head_bytes < 1
  ) {
    throw new CorruptError("reflog root budget query returned invalid metadata");
  }
  const rowStateBytes = value.rows * REFLOG_ROOT_ROW_FIXED_BYTES;
  const payloadBytes = value.text_bytes + value.head_bytes;
  const sqlSlotBytes = rowStateBytes + payloadBytes;
  const currentRowBytes = Math.max(value.max_row_bytes, value.head_bytes);
  // The current BLOB coexists with a worst-case two-byte-per-input-byte JS string.
  const currentRowRetainedBytes = 3 * currentRowBytes;
  const scanRetainedBytes =
    REFLOG_ROOT_SCAN_FIXED_BYTES + 2 * sqlSlotBytes + currentRowRetainedBytes;
  if (
    value.rows > MAX_REFLOG_ROOT_SCAN_ENTRIES ||
    !Number.isSafeInteger(rowStateBytes) ||
    !Number.isSafeInteger(payloadBytes) ||
    !Number.isSafeInteger(sqlSlotBytes) ||
    !Number.isSafeInteger(currentRowRetainedBytes) ||
    !Number.isSafeInteger(scanRetainedBytes) ||
    scanRetainedBytes > MAX_REFLOG_ROOT_SCAN_BYTES
  ) {
    throw new GitError("E2BIG", "active reflog root scan exceeds its bounded SQL state");
  }
}

export function isAttachedBranchUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: git_checkouts.repo_id, git_checkouts.head")
  );
}

export function isCheckoutRootUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed: git_checkouts.root")
  );
}

export function requireRefLogHeader(row: Record<string, unknown>, repoId: number): number {
  if (row.repo_id !== repoId) throw new CorruptError("reflog header belongs to another repository");
  requireRawRefTarget(
    requireCanonicalStoredText(row.head_type, row.head_blob, "stored HEAD target"),
    "stored HEAD target",
    "stored",
  );
  const nextOrdinal = requireSafeRefLogInteger(
    row.next_ordinal,
    "reflog next ordinal",
    0,
    MAX_REFLOG_ORDINAL,
  );
  const latest =
    row.latest_ordinal === null
      ? null
      : requireSafeRefLogInteger(
          row.latest_ordinal,
          "newest reflog ordinal",
          1,
          MAX_REFLOG_ORDINAL,
        );
  if ((nextOrdinal === 0 && latest !== null) || (latest ?? 0) > nextOrdinal) {
    throw new CorruptError("reflog state precedes its newest entry");
  }
  return nextOrdinal;
}

export function validateRefLogMetadata(metadata: RefLogMetadata): RefLogMetadata {
  if (
    !Number.isSafeInteger(metadata.timestamp) ||
    metadata.timestamp < 0 ||
    metadata.timestamp > MAX_REFLOG_ORDINAL
  ) {
    throw new GitError("EINVAL", "reflog timestamp must be a safe nonnegative epoch second");
  }
  if (
    !Number.isSafeInteger(metadata.timezoneOffset) ||
    metadata.timezoneOffset < -MAX_REFLOG_TIMEZONE_MINUTES ||
    metadata.timezoneOffset > MAX_REFLOG_TIMEZONE_MINUTES
  ) {
    throw new GitError("EINVAL", "reflog timezone offset is outside its bounded range");
  }
  if (typeof metadata.reason !== "string" || metadata.reason === "") {
    throw new GitError("EINVAL", "reflog reason is required");
  }
  refTextBytes(metadata.reason, "reflog reason", "input");
  if (metadata.actor !== null) {
    if (metadata.actor.name === "" || metadata.actor.email === "") {
      throw new GitError("EINVAL", "reflog actor name and email are required together");
    }
    refTextBytes(metadata.actor.name, "reflog actor name", "input");
    refTextBytes(metadata.actor.email, "reflog actor email", "input");
    if (
      metadata.actor.name.includes("<") ||
      metadata.actor.name.includes(">") ||
      metadata.actor.email.includes("<") ||
      metadata.actor.email.includes(">")
    ) {
      throw new GitError("EINVAL", "reflog actor identity contains an invalid character");
    }
  }
  return metadata;
}

export function invalidFetchTrackingPrefix(source: "input" | "stored"): never {
  if (source === "stored") throw new CorruptError("stored fetch tracking prefix is invalid");
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

export function requireRefReadMetadata(
  value: { rows: unknown; name_bytes: unknown; target_bytes: unknown } | undefined,
  label: string,
): { rows: number; nameBytes: number; targetBytes: number } {
  if (
    value === undefined ||
    typeof value.rows !== "number" ||
    !Number.isSafeInteger(value.rows) ||
    value.rows < 0 ||
    typeof value.name_bytes !== "number" ||
    !Number.isSafeInteger(value.name_bytes) ||
    value.name_bytes < 0 ||
    typeof value.target_bytes !== "number" ||
    !Number.isSafeInteger(value.target_bytes) ||
    value.target_bytes < 0
  ) {
    throw new CorruptError(`${label} metadata is invalid`);
  }
  return {
    rows: value.rows,
    nameBytes: value.name_bytes,
    targetBytes: value.target_bytes,
  };
}

export function requireRefLogReadMetadata(
  value: { rows: unknown; text_bytes: unknown; head_bytes: unknown } | undefined,
): { rows: number; textBytes: number; headBytes: number } {
  if (
    value === undefined ||
    typeof value.rows !== "number" ||
    !Number.isSafeInteger(value.rows) ||
    value.rows < 0 ||
    typeof value.text_bytes !== "number" ||
    !Number.isSafeInteger(value.text_bytes) ||
    value.text_bytes < 0 ||
    typeof value.head_bytes !== "number" ||
    !Number.isSafeInteger(value.head_bytes) ||
    value.head_bytes < 1
  ) {
    throw new CorruptError("reflog read metadata is invalid");
  }
  return { rows: value.rows, textBytes: value.text_bytes, headBytes: value.head_bytes };
}

export function readCheckoutRevision(db: SqlDatabase, repoId: number): number {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("checkout revision repository id is invalid");
  }
  const stored = db.one<{ repo_id: unknown; checkout_revision: unknown }>(
    "SELECT id AS repo_id, checkout_revision FROM git_repositories WHERE id = ?",
    repoId,
  );
  if (stored === undefined) throw new CorruptError("checkout revision repository is missing");
  if (requireSafeId(stored.repo_id, "checkout revision repository id") !== repoId) {
    throw new CorruptError("checkout revision crossed repository boundaries");
  }
  return requireFetchGeneration(stored.checkout_revision, "stored checkout revision", 0);
}

export function advanceCheckoutRevision(
  db: SqlDatabase,
  repoId: number,
  amount = 1,
  expectedRevision?: number,
): number {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new CorruptError("checkout revision increment is invalid");
  }
  const current =
    expectedRevision === undefined
      ? readCheckoutRevision(db, repoId)
      : requireFetchGeneration(expectedRevision, "expected checkout revision", 0);
  if (amount > Number.MAX_SAFE_INTEGER - current) {
    throw new GitError("E2BIG", "checkout revision is exhausted");
  }
  const next = current + amount;
  const updated = db.one<{ checkout_revision: unknown }>(
    `UPDATE git_repositories SET checkout_revision = ?
      WHERE id = ? AND checkout_revision = ?
      RETURNING checkout_revision`,
    next,
    repoId,
    current,
  );
  if (
    updated === undefined ||
    requireFetchGeneration(updated.checkout_revision, "updated checkout revision", 1) !== next
  ) {
    throw new CorruptError("checkout revision changed during atomic advancement");
  }
  return next;
}

export function staleFetch(message: string): GitError {
  return new GitError("ESTALEFETCH", message);
}

export class RefMutationBudget {
  readonly #reservation: MemoryReservation;
  #retained = 0;
  #hasSqlHeadroom: boolean;

  constructor(reservation: MemoryReservation, deferSqlHeadroom = false) {
    this.#reservation = reservation;
    this.#hasSqlHeadroom = !deferSqlHeadroom;
    this.charge(
      deferSqlHeadroom
        ? REF_MUTATION_STATE_FIXED_RETAINED_BYTES
        : REF_MUTATION_FIXED_RETAINED_BYTES,
    );
  }

  requireSqlHeadroom(): void {
    if (this.#hasSqlHeadroom) return;
    this.charge(REF_MUTATION_SQL_HEADROOM_BYTES);
    this.#hasSqlHeadroom = true;
  }

  memoryReservation(): MemoryReservation {
    return this.#reservation;
  }

  charge(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_REF_MUTATION_RETAINED_BYTES - this.#retained
    ) {
      throw new GitError("E2BIG", "ref mutation exceeds its 64 MiB retained-memory bound");
    }
    const retained = this.#retained + bytes;
    this.#reservation.set("other", retained);
    this.#retained = retained;
  }
}

export function refMutationCreateRetainedBytes(row: RefRow): number {
  const name = requireRefName(row.name, "updated ref name", "input");
  const target = requireRawRefTarget(row.target, "updated ref target", "input");
  return (
    REF_MUTATION_ITEM_RETAINED_BYTES +
    REF_MUTATION_EVENT_RETAINED_BYTES +
    retainedStringBytes(name) +
    retainedStringBytes(target)
  );
}

export function refMutationCheckoutRetainedBytes(checkout: { root: string; head: string }): number {
  const root = requireCheckoutRoot(checkout.root, "stored");
  const head = requireRawRefTarget(checkout.head, "stored HEAD target", "stored");
  const retained = 1_024 + retainedStringBytes(root) + retainedStringBytes(head);
  return Math.ceil(retained / 4) * 4;
}

export function normalizeRefMutation(
  mutation: RefMutation,
  budget: RefMutationBudget,
  owner?: RefMutationMemoryOwner,
): NormalizedRefMutation {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  const chargedStrings: string[] = [];
  const stringBytes = (value: string): number => {
    if (owner?.owns(value) === true || chargedStrings.includes(value)) return 0;
    chargedStrings.push(value);
    return retainedStringBytes(value);
  };
  let inputs = 0;
  const charge = (name: string, target?: string): void => {
    inputs++;
    if (inputs > MAX_REF_MUTATION_INPUTS) {
      throw new GitError("E2BIG", "ref mutation exceeds its retained input count bound");
    }
    budget.charge(
      REF_MUTATION_ITEM_RETAINED_BYTES +
        stringBytes(name) +
        (target === undefined ? 0 : stringBytes(target)),
    );
  };
  for (const value of mutation.deletes ?? []) {
    const name = requireRefName(value, "deleted ref name", "input");
    charge(name);
    deletes.add(name);
  }
  for (const row of mutation.puts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "ref update row is invalid");
    }
    const name = requireRefName(row.name, "updated ref name", "input");
    const target = requireRawRefTarget(row.target, "updated ref target", "input");
    charge(name, target);
    puts.set(name, target);
  }
  const head =
    mutation.head === undefined
      ? undefined
      : requireRawRefTarget(mutation.head, "HEAD target", "input");
  if (head !== undefined) {
    charge("HEAD", head);
  }
  let expected: RefMutationExpected | undefined;
  if (mutation.expected !== undefined) {
    const name = requireRefName(mutation.expected.name, "conditional ref name", "input");
    const target =
      mutation.expected.target === null
        ? null
        : requireRawRefTarget(mutation.expected.target, "expected ref target", "input");
    budget.charge(
      REF_MUTATION_ITEM_RETAINED_BYTES +
        stringBytes(name) +
        (target === null ? 0 : stringBytes(target)),
    );
    expected = { name, target };
    if (puts.has(name) === deletes.has(name)) {
      throw new GitError(
        "EINVAL",
        "conditional ref update must include exactly one destination put or delete",
      );
    }
  }
  return { puts, deletes, head, expected, budget };
}

export function normalizeFetchPublication(
  state: FetchPublicationState,
  plan: FetchPublicationPlan,
  budget: RefMutationBudget,
  owner?: RefMutationMemoryOwner,
): NormalizedFetchPublication {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  const keep = new Set<string>();
  const chargedStrings: string[] = [];
  const stringBytes = (value: string): number => {
    if (owner?.owns(value) === true || chargedStrings.includes(value)) return 0;
    chargedStrings.push(value);
    return retainedStringBytes(value);
  };
  budget.charge(48 + 2 * (state.trackingPrefix.length + "HEAD".length));
  const remoteHeadName = `${state.trackingPrefix}HEAD`;
  let inputs = 0;
  const charge = (name: string, label: string, target?: string, nameAlreadyOwned = false): void => {
    inputs++;
    if (inputs > MAX_FETCH_PUBLICATION_INPUTS) {
      throw new GitError("E2BIG", "fetch publication exceeds its retained input count bound");
    }
    refTextBytes(name, label, "input");
    if (target !== undefined) refTextBytes(target, "fetch ref target", "input");
    budget.charge(
      REF_MUTATION_ITEM_RETAINED_BYTES +
        (nameAlreadyOwned ? 0 : stringBytes(name)) +
        (target === undefined ? 0 : stringBytes(target)),
    );
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
    charge(name, "fetch tracking ref name", target);
    puts.set(name, target);
    keep.add(name);
  }
  const prune = plan.trackingKeep !== undefined;
  for (const value of plan.trackingKeep ?? []) {
    const name = trackingName(value, "advertised tracking ref name");
    charge(name, "advertised tracking ref name");
    keep.add(name);
  }
  if (prune) {
    for (const name of state.trackingRefs.keys()) {
      if (name !== remoteHeadName && !keep.has(name)) deletes.add(name);
    }
  }

  if (plan.remoteHead !== undefined) {
    if (plan.remoteHead === null) {
      charge(remoteHeadName, "remote HEAD ref name", undefined, true);
      deletes.add(remoteHeadName);
    } else {
      const target = requireRawRefTarget(plan.remoteHead, "remote HEAD target", "input");
      charge(remoteHeadName, "remote HEAD ref name", target, true);
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
    charge(name, `${label} name`, target);
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
    charge(value, label);
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
    budget,
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

export function refLogEventRetainedBytes(
  refName: string,
  oldRaw: string | null,
  newRaw: string | null,
): number {
  refTextBytes(refName, "reflog ref name", "input");
  if (oldRaw !== null) refTextBytes(oldRaw, "reflog old raw target", "input");
  if (newRaw !== null) refTextBytes(newRaw, "reflog new raw target", "input");
  return REF_MUTATION_EVENT_RETAINED_BYTES;
}

export function refLogMetadataRetainedBytes(
  metadata: RefLogMetadata,
  owner?: RefMutationMemoryOwner,
): number {
  return (
    REF_MUTATION_METADATA_RETAINED_BYTES +
    (owner?.owns(metadata.reason) === true ? 0 : retainedStringBytes(metadata.reason)) +
    (metadata.actor === null
      ? 0
      : (owner?.owns(metadata.actor.name) === true ? 0 : retainedStringBytes(metadata.actor.name)) +
        (owner?.owns(metadata.actor.email) === true
          ? 0
          : retainedStringBytes(metadata.actor.email)))
  );
}

export function refLogEventJsonMaxUnits(event: RefLogEvent | CheckoutRefLogEvent): number {
  return (
    512 +
    6 *
      (event.refName.length +
        (event.oldRaw?.length ?? 0) +
        (event.newRaw?.length ?? 0) +
        (event.oldOid?.length ?? 0) +
        (event.newOid?.length ?? 0) +
        (event.actorName?.length ?? 0) +
        (event.actorEmail?.length ?? 0) +
        event.reason.length)
  );
}

export function serializeIndexMutation(
  item: IndexEntry | string,
  sequence: number,
): BufferedIndexMutation {
  const kind = typeof item === "string" ? "r" : "p";
  const json = JSON.stringify(
    typeof item === "string"
      ? { q: sequence, k: kind, p: item }
      : {
          q: sequence,
          k: kind,
          p: item.path,
          g: item.stage,
          m: item.mode,
          o: item.oid,
          s: item.size,
          t: item.mtime,
          i: item.ino,
          r: item.rev ?? null,
        },
  );
  return { kind, json, bytes: JSON_ENCODER.encode(json).byteLength };
}

export class IndexMutationBuffer {
  #pending: BufferedIndexMutation[] = [];
  #bytes = 2;

  constructor(
    private readonly flushEvery: number,
    private readonly apply: (pending: readonly BufferedIndexMutation[]) => void,
  ) {}

  get retainedBytes(): number {
    return this.#bytes * 2 + this.#pending.length * INDEX_MUTATION_ROW_BYTES;
  }

  get reservedBytes(): number {
    return this.retainedBytes + this.#bytes * 2 + this.#pending.length * 8;
  }

  add(item: IndexEntry | string): void {
    let mutation = serializeIndexMutation(item, this.#pending.length);
    const separator = this.#pending.length === 0 ? 0 : 1;
    if (
      this.#pending.length > 0 &&
      this.#bytes + separator + mutation.bytes > INDEX_MUTATION_JSON_FLUSH_BYTES
    ) {
      this.flush();
      mutation = serializeIndexMutation(item, 0);
    }
    this.#bytes += (this.#pending.length === 0 ? 0 : 1) + mutation.bytes;
    this.#pending.push(mutation);
    if (this.#pending.length >= this.flushEvery || this.#bytes >= INDEX_MUTATION_JSON_FLUSH_BYTES) {
      this.flush();
    }
  }

  flush(): void {
    if (this.#pending.length === 0) return;
    this.apply(this.#pending);
    this.#pending = [];
    this.#bytes = 2;
  }

  dispose(): void {
    this.#pending = [];
    this.#bytes = 2;
  }
}

export function validNullableIndexInteger(value: number | null | undefined): boolean {
  return value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

export function initialPathJsonBytes(path: string, maxUtf8Bytes?: number): number {
  if (path.length === 0 || path.charCodeAt(0) === 0x2f) {
    throw new CorruptError("initial index entry has an invalid path");
  }
  let utf8Bytes = 0;
  let jsonBytes = 0;
  let segmentStart = 0;
  for (let at = 0; at < path.length; at++) {
    const unit = path.charCodeAt(at);
    if (unit === 0) throw new CorruptError("initial index entry has an invalid path");
    if (unit === 0x2f) {
      const segmentLength = at - segmentStart;
      if (
        segmentLength === 0 ||
        (segmentLength === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
        (segmentLength === 2 &&
          path.charCodeAt(segmentStart) === 0x2e &&
          path.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        throw new CorruptError("initial index entry has an invalid path");
      }
      segmentStart = at + 1;
      utf8Bytes++;
      jsonBytes++;
    } else if ((unit & 0xfc00) === 0xd800) {
      const low = path.charCodeAt(at + 1);
      if ((low & 0xfc00) !== 0xdc00) {
        throw new CorruptError("initial index entry path is not canonical UTF-16");
      }
      at++;
      utf8Bytes += 4;
      jsonBytes += 4;
    } else if ((unit & 0xfc00) === 0xdc00) {
      throw new CorruptError("initial index entry path is not canonical UTF-16");
    } else {
      utf8Bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
      if (
        unit === 0x22 ||
        unit === 0x5c ||
        unit === 0x08 ||
        unit === 0x09 ||
        unit === 0x0a ||
        unit === 0x0c ||
        unit === 0x0d
      ) {
        jsonBytes += 2;
      } else if (unit < 0x20) {
        jsonBytes += 6;
      } else {
        jsonBytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
      }
    }
    if (maxUtf8Bytes !== undefined && utf8Bytes > maxUtf8Bytes) {
      throw new GitError("E2BIG", `initial index path exceeds ${maxUtf8Bytes} UTF-8 bytes`);
    }
  }
  const segmentLength = path.length - segmentStart;
  if (
    segmentLength === 0 ||
    (segmentLength === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
    (segmentLength === 2 &&
      path.charCodeAt(segmentStart) === 0x2e &&
      path.charCodeAt(segmentStart + 1) === 0x2e)
  ) {
    throw new CorruptError("initial index entry has an invalid path");
  }
  return jsonBytes;
}

export function validateInitialIndexEntry(entry: IndexEntry): number {
  const pathJsonBytes = initialPathJsonBytes(entry.path);
  if (entry.stage !== 0) throw new CorruptError("initial index entry must be stage 0");
  if (
    entry.mode !== 0o100644 &&
    entry.mode !== 0o100755 &&
    entry.mode !== 0o120000 &&
    entry.mode !== 0o160000
  ) {
    throw new CorruptError("initial index entry has an invalid mode");
  }
  if (!isOid(entry.oid)) throw new CorruptError("initial index entry has an invalid oid");
  if (
    !validNullableIndexInteger(entry.size) ||
    !validNullableIndexInteger(entry.mtime) ||
    !validNullableIndexInteger(entry.ino) ||
    !validNullableIndexInteger(entry.rev)
  ) {
    throw new CorruptError("initial index entry has invalid filesystem metadata");
  }
  return pathJsonBytes;
}

export function operationIdentityFromRow(
  name: unknown,
  email: unknown,
  label: string,
): MergeSavedIdentity | null {
  if (name === null && email === null) return null;
  if (name === null || email === null) {
    throw new CorruptError(`operation ${label} identity row is incomplete`);
  }
  return {
    name: requireMergeText(name, `${label} name`),
    email: requireMergeText(email, `${label} email`),
  };
}

export function requireOperationKind(value: unknown): OperationKind {
  if (value === "merge" || value === "cherry-pick" || value === "revert" || value === "rebase") {
    return value;
  }
  throw new CorruptError("operation journal has an invalid kind");
}

export function requireNullableOperationOid(value: unknown, label: string): string | null {
  return value === null ? null : requireMergeOid(value, label);
}

export function requireNullableMainline(value: unknown): number | null {
  if (value === null) return null;
  const mainline = requireMergeInteger(value, "mainline");
  if (mainline === 0) throw new CorruptError("replay mainline is not positive");
  return mainline;
}

export function operationStepFromRow(row: OperationStepRow): OperationStepMetadata {
  const outcome = row.outcome;
  if (outcome !== "pending" && outcome !== "applied" && outcome !== "skipped") {
    throw new CorruptError("operation step row has an invalid outcome");
  }
  return {
    sourceOid: requireMergeOid(row.source_oid, "step source"),
    selectedParentOid: requireNullableOperationOid(row.selected_parent_oid, "step parent"),
    mainline: requireNullableMainline(row.mainline),
    outcome,
    resultOid: requireNullableOperationOid(row.result_oid, "step result"),
  };
}

export function operationJournalReadBytes(
  retainedBytes: number,
  stateTextBytes: number,
  stepTextBytes: number,
  touchedTextBytes: number,
): number {
  const currentRowBytes = Math.max(
    currentTextRowRetainedBytes(stateTextBytes, 19),
    stepTextBytes === 0 ? 0 : currentTextRowRetainedBytes(stepTextBytes, 4),
    touchedTextBytes === 0 ? 0 : currentTextRowRetainedBytes(touchedTextBytes, 6),
  );
  const retained = retainedBytes + currentRowBytes;
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "operation journal retained-memory accounting overflow");
  }
  return retained;
}

export function operationJournalIntegrityBytes(
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
  retainedBytes: number,
): number {
  let jsonUnits = 2_048 + steps.length * 256 + touched.length * 512;
  let jsonBytes = jsonUnits;
  const add = (value: string | null): void => {
    if (value === null) {
      jsonUnits += 4;
      jsonBytes += 4;
      return;
    }
    jsonUnits += jsonStringMaxUnits(value);
    jsonBytes += jsonStringEncodedBytes(value);
  };
  add(state.kind);
  add(state.originalHeadRef);
  add(state.originalHeadOid);
  add(state.currentLabel);
  add(state.incomingLabel);
  add(state.message);
  add(state.author?.name ?? null);
  add(state.author?.email ?? null);
  add(state.committer?.name ?? null);
  add(state.committer?.email ?? null);
  if (state.kind === "merge") {
    add(state.currentParentOid);
    add(state.incomingParentOid);
    add(state.phase);
    add(state.mode);
    add(state.mergeOrigin);
  } else if (state.kind === "rebase") {
    add(state.phase);
    add(state.upstreamOid);
    add(state.baseOid);
    add(state.currentParentOid);
  } else {
    add(state.phase);
    add(state.emptyReason);
    add(state.sourceOid);
    add(state.selectedParentOid);
  }
  for (const step of steps) {
    add(step.sourceOid);
    add(step.selectedParentOid);
    add(step.outcome);
    add(step.resultOid);
  }
  for (const entry of touched) {
    add(entry.path);
    add(entry.logicalPath);
    add(entry.purpose);
    add(entry.index?.oid ?? null);
    add(entry.worktree.kind);
    add(
      entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
        ? entry.worktree.oid
        : null,
    );
  }
  const bytes = retainedBytes + retainedStringUnits(jsonUnits) + jsonBytes + 512;
  if (!Number.isSafeInteger(bytes)) {
    throw new GitError("E2BIG", "operation journal integrity accounting overflow");
  }
  return bytes;
}

export function operationMetadataFromRow(
  row: OperationStateRow,
  steps: readonly OperationStepMetadata[],
): OperationStateMetadata {
  const kind = requireOperationKind(row.kind);
  const currentStep = requireMergeInteger(row.current_step, "current step");
  const stepCount = requireMergeInteger(row.step_count, "step count");
  if (stepCount !== steps.length) {
    throw new CorruptError("operation step count does not match its rows");
  }
  const common = {
    originalHeadRef: requireMergeText(row.original_head_ref, "original HEAD ref"),
    originalHeadOid: requireMergeOid(row.original_head_oid, "original HEAD"),
    currentLabel: requireMergeText(row.current_label, "current label"),
    incomingLabel: requireMergeText(row.incoming_label, "incoming label"),
    message: requireMergeText(row.message, "message"),
    author: operationIdentityFromRow(row.author_name, row.author_email, "author"),
    committer: operationIdentityFromRow(row.committer_name, row.committer_email, "committer"),
  };
  if (kind === "merge") {
    if (
      row.empty_reason !== null ||
      row.upstream_oid !== null ||
      row.base_oid !== null ||
      currentStep !== 0 ||
      stepCount !== 0
    ) {
      throw new CorruptError("merge journal retained replay metadata");
    }
    return {
      kind,
      ...common,
      currentParentOid: requireMergeOid(row.current_parent_oid, "current parent"),
      incomingParentOid: requireMergeOid(row.incoming_parent_oid, "incoming parent"),
      phase: requireMergePhase(row.phase),
      mode: requireMergeMode(row.mode),
      mergeOrigin: requireMergeOrigin(row.merge_origin),
    };
  }
  if (kind === "rebase") {
    if (
      row.empty_reason !== null ||
      row.incoming_parent_oid !== null ||
      row.mode !== null ||
      row.merge_origin !== null
    ) {
      throw new CorruptError("rebase journal retained one-shot operation metadata");
    }
    const phase = row.phase;
    if (phase !== "running" && phase !== "conflicted") {
      throw new CorruptError("rebase journal has an invalid phase");
    }
    return {
      kind,
      ...common,
      phase,
      upstreamOid: requireMergeOid(row.upstream_oid, "upstream"),
      baseOid: requireMergeOid(row.base_oid, "base"),
      currentParentOid: requireMergeOid(row.current_parent_oid, "current parent"),
      currentStep,
    };
  }
  if (
    row.current_parent_oid !== null ||
    row.incoming_parent_oid !== null ||
    row.upstream_oid !== null ||
    row.base_oid !== null ||
    row.mode !== null ||
    row.merge_origin !== null ||
    currentStep !== 0 ||
    stepCount !== 1
  ) {
    throw new CorruptError("replay journal retained merge metadata");
  }
  const phase = row.phase;
  if (phase !== "conflicted" && phase !== "empty") {
    throw new CorruptError("replay journal has an invalid phase");
  }
  const emptyReason = row.empty_reason;
  if (emptyReason !== null && emptyReason !== "source" && emptyReason !== "result") {
    throw new CorruptError("replay journal has an invalid empty reason");
  }
  const step = steps[0];
  if (step === undefined) throw new CorruptError("one-commit replay journal lost its source step");
  return {
    kind,
    ...common,
    phase,
    emptyReason,
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    mainline: step.mainline,
  };
}

export function operationJournal(
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
  retainedBytes: number,
  integrityOid: string,
): OperationJournal {
  const fields = { steps, touched, retainedBytes, integrityOid };
  if (state.kind === "merge") return { kind: state.kind, state, ...fields };
  if (state.kind === "cherry-pick") return { kind: state.kind, state, ...fields };
  if (state.kind === "revert") return { kind: state.kind, state, ...fields };
  return { kind: state.kind, state, ...fields };
}

export function sameOperationStep(
  left: OperationStepMetadata,
  right: OperationStepMetadata,
): boolean {
  return (
    left.sourceOid === right.sourceOid &&
    left.selectedParentOid === right.selectedParentOid &&
    left.mainline === right.mainline &&
    left.outcome === right.outcome &&
    left.resultOid === right.resultOid
  );
}

export function requireInitialRebaseJournal(
  state: RebaseStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  if (
    state.phase !== "running" ||
    state.currentStep !== 0 ||
    touched.length !== 0 ||
    steps.some((step) => step.outcome !== "pending")
  ) {
    throw new CorruptError("initial rebase journal is not an untouched pending sequence");
  }
}

export function requireRebaseJournalTransition(
  current: RebaseJournal,
  state: RebaseStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  if (
    state.originalHeadRef !== current.state.originalHeadRef ||
    state.originalHeadOid !== current.state.originalHeadOid ||
    state.upstreamOid !== current.state.upstreamOid ||
    state.baseOid !== current.state.baseOid ||
    steps.length !== current.steps.length
  ) {
    throw new GitError("EOPMISMATCH", "rebase anchors or replay queue changed during transition");
  }
  for (let ordinal = 0; ordinal < steps.length; ordinal++) {
    const before = current.steps[ordinal];
    const after = steps[ordinal];
    if (
      before === undefined ||
      after === undefined ||
      before.sourceOid !== after.sourceOid ||
      before.selectedParentOid !== after.selectedParentOid ||
      before.mainline !== after.mainline
    ) {
      throw new GitError("EOPMISMATCH", "rebase replay queue changed during transition");
    }
  }
  if (
    state.currentStep === current.state.currentStep &&
    current.state.phase === "running" &&
    state.phase === "conflicted" &&
    touched.length > 0 &&
    steps.every((step, ordinal) => {
      const before = current.steps[ordinal];
      return before !== undefined && sameOperationStep(before, step);
    })
  ) {
    return;
  }
  if (
    state.currentStep === current.state.currentStep + 1 &&
    state.phase === "running" &&
    touched.length === 0
  ) {
    for (let ordinal = 0; ordinal < steps.length; ordinal++) {
      const before = current.steps[ordinal];
      const after = steps[ordinal];
      if (before === undefined || after === undefined) {
        throw new GitError("EOPMISMATCH", "rebase replay queue changed during transition");
      }
      if (ordinal === current.state.currentStep) {
        if (
          before.outcome !== "pending" ||
          (after.outcome !== "applied" && after.outcome !== "skipped")
        ) {
          throw new GitError("EOPMISMATCH", "rebase current step has an invalid transition");
        }
      } else if (!sameOperationStep(before, after)) {
        throw new GitError("EOPMISMATCH", "rebase completed or pending steps changed");
      }
    }
    return;
  }
  throw new GitError("EOPMISMATCH", "rebase journal transition is not contiguous");
}

export function operationIndexFromRow(row: OperationTouchedRow): MergeIndexSnapshot | null {
  const values = [
    row.index_stage,
    row.index_mode,
    row.index_oid,
    row.index_size,
    row.index_mtime,
    row.index_ino,
    row.index_rev,
  ];
  if (values.every((value) => value === null)) return null;
  if (row.index_stage !== 0) throw new CorruptError("merge index snapshot has an invalid stage");
  return {
    stage: 0,
    mode: requireMergeInteger(row.index_mode, "index mode"),
    oid: requireMergeOid(row.index_oid, "index oid"),
    size: requireMergeNullableInteger(row.index_size, "index size"),
    mtime: requireMergeNullableInteger(row.index_mtime, "index mtime"),
    ino: requireMergeNullableInteger(row.index_ino, "index inode"),
    rev: requireMergeNullableInteger(row.index_rev, "index revision"),
  };
}

export function operationWorktreeFromRow(row: OperationTouchedRow): MergeWorktreeSnapshot {
  const kind = requireMergeText(row.worktree_kind, "worktree kind");
  if (kind === "absent") {
    if (row.worktree_mode !== null || row.worktree_oid !== null || row.worktree_revision !== null) {
      throw new CorruptError("absent merge worktree snapshot retained metadata");
    }
    return { kind };
  }
  const mode = requireMergeInteger(row.worktree_mode, "worktree mode");
  const revision = requireMergeInteger(row.worktree_revision, "worktree revision");
  if (kind === "directory") {
    if (row.worktree_oid !== null) {
      throw new CorruptError("merge directory snapshot retained an object id");
    }
    return { kind, mode, revision };
  }
  if (kind === "file" || kind === "symlink") {
    return { kind, mode, oid: requireMergeOid(row.worktree_oid, "worktree oid"), revision };
  }
  throw new CorruptError("merge journal has an invalid worktree kind");
}

export function operationTouchedFromRow(row: OperationTouchedRow): MergeTouchedPath {
  return {
    path: requireMergeText(row.path, "touched path"),
    logicalPath: requireMergeText(row.logical_path, "logical path"),
    purpose: requireMergePurpose(row.purpose),
    index: operationIndexFromRow(row),
    worktree: operationWorktreeFromRow(row),
  };
}

export function persistedOperationTouched(
  entry: MergeTouchedPath,
  ordinal: number,
): PersistedOperationTouched {
  const index = entry.index;
  const worktree = entry.worktree;
  return {
    ordinal,
    path: entry.path,
    logicalPath: entry.logicalPath,
    purpose: entry.purpose,
    indexStage: index?.stage ?? null,
    indexMode: index?.mode ?? null,
    indexOid: index?.oid ?? null,
    indexSize: index?.size ?? null,
    indexMtime: index?.mtime ?? null,
    indexIno: index?.ino ?? null,
    indexRev: index?.rev ?? null,
    worktreeKind: worktree.kind,
    worktreeMode: worktree.kind === "absent" ? null : worktree.mode,
    worktreeOid: worktree.kind === "file" || worktree.kind === "symlink" ? worktree.oid : null,
    worktreeRevision: worktree.kind === "absent" ? null : worktree.revision,
  };
}

export function persistedOperationStep(
  step: OperationStepMetadata,
  ordinal: number,
): PersistedOperationStep {
  return {
    ordinal,
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    mainline: step.mainline,
    outcome: step.outcome,
    resultOid: step.resultOid,
  };
}

export function requireBooleanProbe(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} returned an invalid value`);
  return value === 1;
}

export class InitialBlobIdBuffer {
  #payload: Uint8Array | null = null;
  #rows: BlobIdWriteRow[] = [];
  #length = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  get retainedBytes(): number {
    return (this.#payload?.length ?? 0) + this.#rows.length * BLOB_ID_MISMATCH_ROW_BYTES;
  }

  get reservedBytes(): number {
    return this.retainedBytes + this.#rows.length * INITIAL_BLOB_ROW_JSON_BYTES * 2 + 32;
  }

  additionalReservedBytes(): number {
    return (
      (this.#payload === null ? CONTENT_ID_PAYLOAD : 0) +
      BLOB_ID_MISMATCH_ROW_BYTES +
      INITIAL_BLOB_ROW_JSON_BYTES * 2
    );
  }

  willCache(mapping: BlobIdMapping): boolean {
    return mapping.contentId.length <= BLOB_ID_CACHE_ELIGIBILITY_BYTES;
  }

  needsFlush(mapping: BlobIdMapping): boolean {
    if (!this.willCache(mapping)) return false;
    return (
      this.#rows.length >= CONTENT_ID_PAGE ||
      this.#length + mapping.contentId.length > CONTENT_ID_PAYLOAD
    );
  }

  validate(mapping: BlobIdMapping): void {
    if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
  }

  add(mapping: BlobIdMapping): void {
    this.validate(mapping);
    if (!this.willCache(mapping)) return;
    if (
      this.#rows.length > 0 &&
      (this.#rows.length >= CONTENT_ID_PAGE ||
        this.#length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      this.flush();
    }
    if (this.#payload === null) this.#payload = new Uint8Array(CONTENT_ID_PAYLOAD);
    const payload = this.#payload;
    payload.set(mapping.contentId, this.#length);
    this.#rows.push({ a: this.#length + 1, n: mapping.contentId.length, o: mapping.oid });
    this.#length += mapping.contentId.length;
  }

  flush(): void {
    if (this.#rows.length === 0) return;
    const payload = this.#payload;
    if (payload === null) throw new Error("initial blob id buffer is disposed");
    writeBlobIdPage(this.db, this.repoId, payload, this.#rows, true, true);
    this.#rows = [];
    this.#length = 0;
  }

  finish(): void {
    this.flush();
  }

  dispose(): void {
    this.#payload = null;
    this.#rows = [];
    this.#length = 0;
  }
}

export function isThenableResult(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}

export type OwnedIndexScan = (
  reservation: MemoryReservation,
  options: IndexScanOptions,
) => IterableIterator<IndexEntry>;

export const OWNED_INDEX_SCANS = new WeakMap<IndexStore, OwnedIndexScan>();

/** Internal ordered scan whose current persisted row is charged to the caller. */
export function indexScanOwned(
  index: IndexStore,
  reservation: MemoryReservation,
  options: IndexScanOptions = {},
): IterableIterator<IndexEntry> {
  const scan = OWNED_INDEX_SCANS.get(index);
  return scan === undefined
    ? scanGenericIndexOwned(index.indexScan(options), reservation)
    : scan(reservation, options);
}

export function* scanGenericIndexOwned(
  entries: IterableIterator<IndexEntry>,
  reservation: MemoryReservation,
): Generator<IndexEntry> {
  const rowMemory = reservation.scope();
  let previousPath: string | null = null;
  let previousStage = -1;
  try {
    for (const raw of entries) {
      const entry = requireStoredIndexEntry({
        path: raw.path,
        stage: raw.stage,
        mode: raw.mode,
        oid: raw.oid,
        size: raw.size,
        mtime: raw.mtime,
        ino: raw.ino,
        rev: raw.rev ?? null,
      });
      if (
        previousPath !== null &&
        (comparePaths(previousPath, entry.path) > 0 ||
          (previousPath === entry.path && previousStage >= entry.stage))
      ) {
        throw new CorruptError("index scan rows are not in strict path and stage order");
      }
      rowMemory.set(
        "other",
        256 + retainedStringBytes(entry.path) + retainedStringBytes(entry.oid),
      );
      previousPath = entry.path;
      previousStage = entry.stage;
      yield entry;
      rowMemory.clear("other");
    }
  } finally {
    rowMemory.dispose();
  }
}

export function requireIndexPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INDEX_SCAN_PAGE) {
    throw new GitError("EINVAL", `index scan page size must be from 1 to ${MAX_INDEX_SCAN_PAGE}`);
  }
  return value;
}

export function requireStoredIndexFact(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError(`stored index ${label} is invalid`);
  }
  return value;
}

export function requireStoredIndexEntry(row: Record<string, unknown>): IndexEntry {
  const path = row.path;
  if (typeof path !== "string") throw new CorruptError("stored index path is invalid");
  try {
    initialPathJsonBytes(path, MAX_INDEX_PATH_BYTES);
  } catch {
    throw new CorruptError("stored index path is invalid");
  }
  const stage = row.stage;
  if (typeof stage !== "number" || !Number.isSafeInteger(stage) || stage < 0 || stage > 3) {
    throw new CorruptError("stored index stage is invalid");
  }
  const mode = row.mode;
  if (mode !== 0o100644 && mode !== 0o100755 && mode !== 0o120000 && mode !== 0o160000) {
    throw new CorruptError("stored index mode is invalid");
  }
  const oid = row.oid;
  if (typeof oid !== "string" || !isOid(oid)) {
    throw new CorruptError("stored index oid is invalid");
  }
  return {
    path,
    stage,
    mode,
    oid,
    size: requireStoredIndexFact(row.size, "size"),
    mtime: requireStoredIndexFact(row.mtime, "mtime"),
    ino: requireStoredIndexFact(row.ino, "inode"),
    rev: requireStoredIndexFact(row.rev, "revision"),
  };
}

export type OwnedIndexSource =
  | { kind: "checkout"; repoId: number; checkoutId: number }
  | { kind: "scratch"; repoId: number; name: string };

export function* scanIndexOwned(
  db: SqlDatabase,
  source: OwnedIndexSource,
  reservation: MemoryReservation,
  ownsReservation: (reservation: MemoryReservation) => boolean,
  requireActive: () => void,
  options: IndexScanOptions,
): Generator<IndexEntry> {
  requireActive();
  if (!ownsReservation(reservation)) {
    throw new GitError("EINVAL", "index scan reservation belongs to another repository");
  }
  const rowMemory = reservation.scope();
  const progressMemory = reservation.scope();
  try {
    const pageSize = requireIndexPageSize(options.pageSize ?? DEFAULT_INDEX_PAGE);
    const prefix = options.prefix;
    let path = options.after?.path ?? "";
    let stage = options.after?.stage ?? -1;
    let previousPath: string | null = null;
    let previousStage = -1;
    for (;;) {
      requireActive();
      const query =
        source.kind === "checkout"
          ? prefix === undefined || prefix === ""
            ? `SELECT checkout.repo_id,
                      typeof(entry.path) AS path_type,
                      length(CAST(entry.path AS BLOB)) AS path_bytes,
                      CAST(entry.path AS BLOB) AS path_blob,
                      entry.stage, entry.mode,
                      typeof(entry.oid) AS oid_type,
                      length(CAST(entry.oid AS BLOB)) AS oid_bytes,
                      CAST(entry.oid AS BLOB) AS oid_blob,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_index entry
                 JOIN git_checkouts checkout ON checkout.id = entry.checkout_id
                WHERE entry.checkout_id = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                ORDER BY entry.path, entry.stage LIMIT ?`
            : `SELECT checkout.repo_id,
                      typeof(entry.path) AS path_type,
                      length(CAST(entry.path AS BLOB)) AS path_bytes,
                      CAST(entry.path AS BLOB) AS path_blob,
                      entry.stage, entry.mode,
                      typeof(entry.oid) AS oid_type,
                      length(CAST(entry.oid AS BLOB)) AS oid_bytes,
                      CAST(entry.oid AS BLOB) AS oid_blob,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_index entry
                 JOIN git_checkouts checkout ON checkout.id = entry.checkout_id
                WHERE entry.checkout_id = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                  AND (entry.path = ? OR (entry.path >= ? AND entry.path < ?))
                ORDER BY entry.path, entry.stage LIMIT ?`
          : prefix === undefined || prefix === ""
            ? `SELECT entry.repo_id,
                      typeof(entry.path) AS path_type,
                      length(CAST(entry.path AS BLOB)) AS path_bytes,
                      CAST(entry.path AS BLOB) AS path_blob,
                      entry.stage, entry.mode,
                      typeof(entry.oid) AS oid_type,
                      length(CAST(entry.oid AS BLOB)) AS oid_bytes,
                      CAST(entry.oid AS BLOB) AS oid_blob,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_scratch_index_entries entry
                WHERE entry.repo_id = ? AND entry.name = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                ORDER BY entry.path, entry.stage LIMIT ?`
            : `SELECT entry.repo_id,
                      typeof(entry.path) AS path_type,
                      length(CAST(entry.path AS BLOB)) AS path_bytes,
                      CAST(entry.path AS BLOB) AS path_blob,
                      entry.stage, entry.mode,
                      typeof(entry.oid) AS oid_type,
                      length(CAST(entry.oid AS BLOB)) AS oid_bytes,
                      CAST(entry.oid AS BLOB) AS oid_blob,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_scratch_index_entries entry
                WHERE entry.repo_id = ? AND entry.name = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                  AND (entry.path = ? OR (entry.path >= ? AND entry.path < ?))
                ORDER BY entry.path, entry.stage LIMIT ?`;
      const bindings: (string | number)[] =
        source.kind === "checkout"
          ? prefix === undefined || prefix === ""
            ? [source.checkoutId, path, path, stage, pageSize]
            : [
                source.checkoutId,
                path,
                path,
                stage,
                prefix,
                `${prefix}/`,
                nextPrefix(`${prefix}/`),
                pageSize,
              ]
          : prefix === undefined || prefix === ""
            ? [source.repoId, source.name, path, path, stage, pageSize]
            : [
                source.repoId,
                source.name,
                path,
                path,
                stage,
                prefix,
                `${prefix}/`,
                nextPrefix(`${prefix}/`),
                pageSize,
              ];
      let pageRows = 0;
      let last: IndexEntry | undefined;
      const maximumRowBytes = currentTextRowRetainedBytes(MAX_INDEX_PATH_BYTES + 40, 2);
      rowMemory.set("other", maximumRowBytes);
      const rows = db.iterate(query, ...bindings)[Symbol.iterator]();
      try {
        for (;;) {
          requireActive();
          rowMemory.set("other", maximumRowBytes);
          const next = rows.next();
          if (next.done) {
            rowMemory.clear("other");
            break;
          }
          const row = next.value;
          if (row.repo_id !== source.repoId || pageRows >= pageSize) {
            throw new CorruptError("index scan returned invalid repository or page cardinality");
          }
          const pathBytes = requireStoredTextByteLength(
            row.path_type,
            row.path_bytes,
            "stored index path",
          );
          const oidBytes = requireStoredTextByteLength(
            row.oid_type,
            row.oid_bytes,
            "stored index oid",
          );
          if (pathBytes > MAX_INDEX_PATH_BYTES || oidBytes !== 40) {
            throw new CorruptError("stored index path or oid exceeds its structural bound");
          }
          rowMemory.set("other", currentTextRowRetainedBytes(pathBytes + oidBytes, 2));
          const entry = requireStoredIndexEntry({
            path: requireCanonicalStoredText(row.path_type, row.path_blob, "stored index path"),
            stage: row.stage,
            mode: row.mode,
            oid: requireCanonicalStoredText(row.oid_type, row.oid_blob, "stored index oid"),
            size: row.size,
            mtime: row.mtime,
            ino: row.ino,
            rev: row.rev,
          });
          if (
            previousPath !== null &&
            (comparePaths(previousPath, entry.path) > 0 ||
              (previousPath === entry.path && previousStage >= entry.stage))
          ) {
            throw new CorruptError("index scan rows are not in strict path and stage order");
          }
          previousPath = entry.path;
          previousStage = entry.stage;
          progressMemory.set("other", 128 + retainedStringBytes(entry.path));
          last = entry;
          pageRows++;
          yield entry;
        }
      } finally {
        if (rows.return !== undefined) rows.return();
        rowMemory.clear("other");
      }
      if (pageRows === 0) return;
      if (last === undefined) throw new CorruptError("index scan page lost its last row");
      path = last.path;
      stage = last.stage;
      if (pageRows < pageSize) return;
    }
  } finally {
    progressMemory.dispose();
    rowMemory.dispose();
  }
}

/** Canonicalise an absolute workspace path without consulting the filesystem. */
export function normalizeRoot(path: string): string {
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function requireScratchIndexName(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new GitError("EINVAL", "scratch index name must be non-empty UTF-8 text");
  }
  const bytes = JSON_ENCODER.encode(value).byteLength;
  if (bytes < 1 || bytes > MAX_SCRATCH_INDEX_NAME_BYTES) {
    throw new GitError(
      "EINVAL",
      `scratch index name must be from 1 to ${MAX_SCRATCH_INDEX_NAME_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export function requireSafeId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CorruptError(`${label} is not a safe positive integer`);
  }
  return value;
}

export function requireIdentityCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError(`${label} is not a safe nonnegative integer`);
  }
  return value;
}

export function requireStoredIdentityMaximum(value: unknown, label: string): number {
  return value === null ? 0 : requireSafeId(value, label);
}

export function nextIdentity(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new GitError("E2BIG", `${label} space is exhausted`);
  }
  return value + 1;
}

export function requireMilliseconds(
  value: unknown,
  label: string,
  source: "input" | "stored",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    if (source === "stored") throw new CorruptError(`${label} is invalid`);
    throw new GitError("EINVAL", `${label} must be a safe nonnegative integer`);
  }
  return value;
}

export function provisionalCloneExpiry(nowMs: number): number {
  if (nowMs > Number.MAX_SAFE_INTEGER - PROVISIONAL_CLONE_LEASE_MS) {
    throw new GitError("E2BIG", "clone lease clock exceeds its safe range");
  }
  return nowMs + PROVISIONAL_CLONE_LEASE_MS;
}

export interface StoredRepositoryLifecycle {
  repoId: number;
  lifecycle: RepositoryLifecycle;
  cloneGeneration: number | null;
  cloneExpiresMs: number | null;
}

export function requireStoredRepositoryLifecycle(
  row: Record<string, unknown>,
): StoredRepositoryLifecycle {
  const repoId = requireSafeId(row.repo_id, "repository id");
  const lifecycle = row.lifecycle;
  if (lifecycle !== "ready" && lifecycle !== "provisional") {
    throw new CorruptError("repository lifecycle is invalid");
  }
  const cloneGeneration =
    row.clone_generation === null ? null : requireSafeId(row.clone_generation, "clone generation");
  const cloneExpiresMs =
    row.clone_expires_ms === null
      ? null
      : requireMilliseconds(row.clone_expires_ms, "clone lease expiry", "stored");
  if (
    (lifecycle === "ready" && (cloneGeneration !== null || cloneExpiresMs !== null)) ||
    (lifecycle === "provisional" && (cloneGeneration === null || cloneExpiresMs === null))
  ) {
    throw new CorruptError("repository lifecycle fields are inconsistent");
  }
  return { repoId, lifecycle, cloneGeneration, cloneExpiresMs };
}

export interface StoredCheckoutLifecycle extends StoredRepositoryLifecycle {
  checkout: CheckoutRow;
}

export const CHECKOUT_LIFECYCLE_CARDINALITY_SQL = `
  (SELECT COUNT(*) FROM (
     SELECT 1 FROM git_checkouts membership
      WHERE membership.repo_id = checkout.repo_id
      LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}
   )) AS lifecycle_checkout_count,
  (SELECT COUNT(*) FROM (
     SELECT 1 FROM git_checkouts membership
      WHERE membership.repo_id = checkout.repo_id AND membership.is_primary = 1
      LIMIT 2
   )) AS lifecycle_primary_count`;

export function requireStoredCheckoutLifecycle(
  row: Record<string, unknown>,
  admittedRootBytes: number,
  admittedHeadBytes: number,
): StoredCheckoutLifecycle {
  const checkout = requireStoredCheckoutRow(row, admittedRootBytes, admittedHeadBytes);
  const repository = requireStoredRepositoryLifecycle(row);
  if (checkout.repoId !== repository.repoId) {
    throw new CorruptError("checkout lifecycle crossed repository boundaries");
  }
  return { ...repository, checkout };
}

export function requireCheckoutLifecycleCardinality(
  row: Record<string, unknown>,
  stored: StoredCheckoutLifecycle,
): void {
  const checkoutCount = requireSafeRefLogInteger(
    row.lifecycle_checkout_count,
    "repository checkout count",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
    throw new GitError("E2BIG", "repository exceeds 1,024 checkouts");
  }
  const primaryCount = requireSafeRefLogInteger(
    row.lifecycle_primary_count,
    "repository primary checkout count",
    0,
    checkoutCount,
  );
  if (primaryCount !== 1) {
    throw new CorruptError("repository must have exactly one primary checkout");
  }
  if (stored.lifecycle === "provisional" && (checkoutCount !== 1 || !stored.checkout.isPrimary)) {
    throw new CorruptError("provisional repository must have exactly one primary checkout");
  }
}

export function requireCheckoutRoot(value: unknown, source: "input" | "stored"): string {
  if (typeof value !== "string" || value.includes("\0")) {
    if (source === "stored") throw new CorruptError("checkout root is invalid");
    throw new GitError("EINVAL", "checkout root is invalid");
  }
  if (source === "stored") {
    if (
      !value.startsWith("/") ||
      (value.length > 1 && value.endsWith("/")) ||
      value.includes("//")
    ) {
      throw new CorruptError("checkout root is not canonical");
    }
    let segmentStart = 1;
    for (let index = 1; index <= value.length; index++) {
      if (index !== value.length && value.charCodeAt(index) !== 0x2f) continue;
      const segmentLength = index - segmentStart;
      if (
        (segmentLength === 1 && value.charCodeAt(segmentStart) === 0x2e) ||
        (segmentLength === 2 &&
          value.charCodeAt(segmentStart) === 0x2e &&
          value.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        throw new CorruptError("checkout root is not canonical");
      }
      segmentStart = index + 1;
    }
    return value;
  }
  return normalizeRoot(value);
}

export function requireStoredCheckoutRow(
  row: Record<string, unknown>,
  admittedRootBytes: number,
  admittedHeadBytes: number,
): CheckoutRow {
  const id = requireSafeId(row.checkout_id, "checkout id");
  const repoId = requireSafeId(row.repo_id, "checkout repository id");
  const rootBytes = requireStoredTextByteLength(
    row.root_type,
    row.root_bytes,
    "stored checkout root",
  );
  if (rootBytes > admittedRootBytes) {
    throw new CorruptError("stored checkout root changed after metadata preflight");
  }
  const root = requireCheckoutRoot(row.root, "stored");
  if (utf8ByteLength(root) !== rootBytes) {
    throw new CorruptError("stored checkout root changed after metadata preflight");
  }
  const headBytes = requireStoredTextByteLength(
    row.head_type,
    row.head_bytes,
    "stored HEAD target",
  );
  if (headBytes > admittedHeadBytes) {
    throw new CorruptError("stored HEAD target changed after metadata preflight");
  }
  const headBlob = requireStoredTextBytes(row.head_type, row.head_blob, "stored HEAD target");
  if (headBlob.byteLength !== headBytes) {
    throw new CorruptError("stored HEAD target changed after metadata preflight");
  }
  const head = requireRawRefTarget(
    decodeCanonicalText(headBlob, "stored HEAD target"),
    "stored HEAD target",
    "stored",
  );
  if (row.is_primary !== 0 && row.is_primary !== 1) {
    throw new CorruptError("checkout primary marker is invalid");
  }
  return { id, repoId, root, head, isPrimary: row.is_primary === 1 };
}

/** Every ancestor of `path`, nearest first, ending at "/". */
export function ancestors(path: string): string[] {
  const normalized = normalizeRoot(path);
  const out: string[] = [];
  let current = normalized;
  while (current !== "/") {
    out.push(current);
    const slash = current.lastIndexOf("/");
    current = slash <= 0 ? "/" : current.slice(0, slash);
  }
  out.push("/");
  return out;
}

export function enforceForeignKeys(db: SqlDatabase): void {
  db.run("PRAGMA foreign_keys = ON");
  if (db.scalar<unknown>("PRAGMA foreign_keys") !== 1) {
    throw new Error("SQLite adapter did not enable foreign-key enforcement");
  }
}

export class CheckoutStoreLifetime {
  #active = true;

  requireActive(): void {
    if (!this.#active) {
      throw new GitError("EWORKTREENOTFOUND", "checkout is no longer active");
    }
  }

  revoke(): void {
    this.#active = false;
  }
}

/** Repository-scoped index rows whose lifetime is one synchronous callback. */
export class ScratchIndexStore implements IndexStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #name: string;
  readonly #shared: SharedRepoStore;
  #active = true;

  constructor(shared: SharedRepoStore, name: string) {
    this.#shared = shared;
    this.#db = shared.db;
    this.#repoId = shared.repoId;
    this.#name = name;
    OWNED_INDEX_SCANS.set(this, (reservation, options) =>
      scanIndexOwned(
        this.#db,
        { kind: "scratch", repoId: this.#repoId, name: this.#name },
        reservation,
        (candidate) => this.#shared.ownsMemoryReservation(candidate),
        () => this.#requireActive(),
        options,
      ),
    );
  }

  revoke(): void {
    this.#active = false;
  }

  #requireActive(): void {
    if (!this.#active) {
      throw new GitError("EINVAL", "scratch index session is no longer active");
    }
  }

  #applyIndexMutations(pending: readonly BufferedIndexMutation[]): void {
    this.#requireActive();
    const hasRemoves = pending.some((item) => item.kind === "r");
    const hasPuts = pending.some((item) => item.kind === "p");
    const mutations = `[${pending.map((item) => item.json).join(",")}]`;
    if (hasRemoves) {
      this.#db.run(
        `DELETE FROM git_scratch_index_entries
          WHERE repo_id = ? AND name = ?
            AND path IN (
              SELECT json_extract(value, '$.p') FROM json_each(?)
               WHERE json_extract(value, '$.k') = 'r'
            )`,
        this.#repoId,
        this.#name,
        mutations,
      );
    }
    if (!hasPuts) return;
    this.#db.run(
      `WITH mutation AS (
         SELECT CAST(j.key AS INTEGER) AS q,
                json_extract(j.value, '$.k') AS kind,
                json_extract(j.value, '$.p') AS path,
                json_extract(j.value, '$.g') AS stage,
                json_extract(j.value, '$.m') AS mode,
                json_extract(j.value, '$.o') AS oid,
                json_extract(j.value, '$.s') AS size,
                json_extract(j.value, '$.t') AS mtime,
                json_extract(j.value, '$.i') AS ino,
                json_extract(j.value, '$.r') AS rev
           FROM json_each(?) j
       ), ranked AS (
         SELECT mutation.*,
                max(CASE WHEN kind = 'r' THEN q ELSE -1 END)
                  OVER (PARTITION BY path) AS last_remove,
                max(CASE WHEN kind = 'p' THEN q ELSE -1 END)
                  OVER (PARTITION BY path, stage) AS last_put
           FROM mutation
       )
       INSERT INTO git_scratch_index_entries
         (repo_id, name, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, ?, current.path, current.stage, current.mode, current.oid,
              current.size, current.mtime, current.ino, current.rev
         FROM ranked current
        WHERE current.kind = 'p'
          AND current.q = current.last_put
          AND current.q > current.last_remove
        ORDER BY current.q
       ON CONFLICT(repo_id, name, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      mutations,
      this.#repoId,
      this.#name,
    );
  }

  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    this.#requireActive();
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    let first = true;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.#db.transactionSync(() => {
        this.#requireActive();
        if (first) {
          this.#db.run(
            "DELETE FROM git_scratch_index_entries WHERE repo_id = ? AND name = ?",
            this.#repoId,
            this.#name,
          );
        }
        this.#applyIndexMutations(mutations);
      });
      first = false;
    });
    for (const entry of entries) pending.add(entry);
    pending.flush();
    if (first) {
      this.#db.run(
        "DELETE FROM git_scratch_index_entries WHERE repo_id = ? AND name = ?",
        this.#repoId,
        this.#name,
      );
    }
  }

  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    this.#requireActive();
    const pageSize = requireIndexPageSize(options.pageSize ?? DEFAULT_INDEX_PAGE);
    const prefix = options.prefix;
    let path = options.after?.path ?? "";
    let stage = options.after?.stage ?? -1;

    for (;;) {
      this.#requireActive();
      const page =
        prefix === undefined || prefix === ""
          ? this.#db.all<Record<string, unknown>>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev
                 FROM git_scratch_index_entries
                WHERE repo_id = ? AND name = ?
                  AND (path > ? OR (path = ? AND stage > ?))
                ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              this.#name,
              path,
              path,
              stage,
              pageSize,
            )
          : this.#db.all<Record<string, unknown>>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev
                 FROM git_scratch_index_entries
                WHERE repo_id = ? AND name = ?
                  AND (path > ? OR (path = ? AND stage > ?))
                  AND (path = ? OR (path >= ? AND path < ?))
                ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              this.#name,
              path,
              path,
              stage,
              prefix,
              `${prefix}/`,
              nextPrefix(`${prefix}/`),
              pageSize,
            );
      if (page.length === 0) return;
      let last: IndexEntry | undefined;
      for (const row of page) {
        const entry = requireStoredIndexEntry(row);
        last = entry;
        yield entry;
      }
      if (last === undefined) throw new CorruptError("scratch index page lost its last row");
      path = last.path;
      stage = last.stage;
      if (page.length < pageSize) return;
    }
  }

  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    this.#requireActive();
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.#db.transactionSync(() => this.#applyIndexMutations(mutations));
    });
    let sinkActive = true;
    const requireSinkActive = (): void => {
      this.#requireActive();
      if (!sinkActive) throw new GitError("EINVAL", "index mutation sink is no longer active");
    };
    const sink: IndexSink = {
      put: (entry) => {
        requireSinkActive();
        pending.add(entry);
      },
      remove: (path) => {
        requireSinkActive();
        pending.add(path);
      },
      flush: () => {
        requireSinkActive();
        pending.flush();
      },
    };
    try {
      const result = body(sink);
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "index mutation callback must be synchronous");
      }
      pending.flush();
      return result;
    } finally {
      sinkActive = false;
      pending.dispose();
    }
  }

  hasConflicts(): boolean {
    this.#requireActive();
    return requireBooleanProbe(
      this.#db.scalar<unknown>(
        `SELECT EXISTS(
           SELECT 1 FROM git_scratch_index_entries
            WHERE repo_id = ? AND name = ? AND stage > 0 LIMIT 1
         )`,
        this.#repoId,
        this.#name,
      ),
      "scratch index conflict probe",
    );
  }
}

/** Checkout-bound storage view. */
export class CheckoutStore implements IndexStore {
  readonly #sharedStore: SharedRepoStore;
  readonly #database: SqlDatabase;
  readonly #repoId: number;
  readonly #checkoutId: number;
  readonly #root: string;
  readonly #isPrimary: boolean;
  readonly #objectCache: ByteLru<string, RawObject>;
  readonly #packStore: PackStore;
  readonly #memoryCoordinator: MemoryCoordinator;
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
      requireSafeId(checkout.repoId, "checkout repository id") !== shared.repoId ||
      requireCheckoutRoot(checkout.root, "stored") !== checkout.root ||
      requireRawRefTarget(checkout.head, "stored HEAD target", "stored") !== checkout.head
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
    this.#objectCache = shared.objects;
    this.#memoryCoordinator = shared.memory;
    this.#packStore = shared.installPacks(
      new PackStore(
        this.#database,
        this.#repoId,
        this.#objectCache,
        shared.packRows,
        this.#memoryCoordinator,
        (reservation) => shared.scopeMemoryReservation(reservation),
        shared.cacheNamespace,
        (oids: readonly string[], ownership: PackReadOwnership) =>
          this.#readLooseObjects(oids, ownership),
        (oids) => this.#looseObjectMetadata(oids),
        options,
      ),
    );
    OWNED_REF_MUTATIONS.set(this, (mutation, metadata, owner) =>
      this.#mutateRefsOwned(mutation, metadata, owner),
    );
    OWNED_INDEX_SCANS.set(this, (reservation, scanOptions) =>
      scanIndexOwned(
        this.#db,
        { kind: "checkout", repoId: this.#repoId, checkoutId: this.#checkoutId },
        reservation,
        (candidate) => this.#sharedStore.ownsMemoryReservation(candidate),
        () => this.#requireActive(),
        scanOptions,
      ),
    );
    OWNED_OPERATION_JOURNALS.set(this, {
      read: (reservation) => this.#readOperationStateOwned(reservation),
      write: (state, steps, touched, reservation) =>
        this.#writeOperationJournalOwned(state, steps, touched, reservation),
      replaceState: (expectedIntegrityOid, state, reservation) =>
        this.#replaceOperationStateOwned(expectedIntegrityOid, state, reservation),
      replaceJournal: (expectedIntegrityOid, state, steps, touched, reservation) =>
        this.#replaceOperationJournalOwned(
          expectedIntegrityOid,
          state,
          steps,
          touched,
          reservation,
        ),
    });
    const ownedOperations: SharedRepoOwnedOperations = {
      objectBatch: (reservation, batchOptions) =>
        this.#writeBatchOwned(reservation, batchOptions),
      authenticatedObject: (oid, expectedType, reservation) =>
        this.#readAuthenticatedObjectOwned(oid, expectedType, reservation),
      configValue: (path, owner) => this.#configGetOwned(path, owner),
    };
    shared.installOperations(this, ownedOperations);
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

  get #objects(): ByteLru<string, RawObject> {
    this.#requireActive();
    return this.#objectCache;
  }

  get #packs(): PackStore {
    this.#requireActive();
    return this.#packStore;
  }

  get #memory(): MemoryCoordinator {
    this.#requireActive();
    return this.#memoryCoordinator;
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
    return this.#packs;
  }

  /** Bytes currently held by this database's two shared bounded caches. */
  cacheBytes(): { objects: number; chunks: number } {
    return { objects: this.#objects.bytes, chunks: this.#packs.cachedChunkBytes };
  }

  /** Reserve operation state against this database's shared memory budget. */
  reserveMemory(): MemoryReservation {
    return this.#sharedStore.reserveMemory();
  }

  // -- objects --------------------------------------------------------

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    const reservation = this.reserveMemory();
    const resultMemory = reservation.scope();
    const found = new Map<string, string>();
    let resultBytes = 128;
    try {
      resultMemory.set("other", resultBytes);
      for (const page of contentIdPages(contentIds, reservation)) {
        for (const row of this.#db.iterate(
          `WITH ids(content_id) AS MATERIALIZED (
             SELECT CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                         ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                     END
               FROM json_each(?)
           )
           SELECT lower(hex(ids.content_id)) AS content_key, b.oid
             FROM ids
             JOIN git_blob_ids b ON b.repo_id = ? AND b.content_id = ids.content_id`,
          blob(page.payload),
          JSON.stringify(page.rows),
          this.#repoId,
        )) {
          const contentKey = row.content_key;
          const oid = row.oid;
          if (typeof contentKey !== "string" || typeof oid !== "string" || !isOid(oid)) {
            throw new CorruptError("blob id lookup returned an invalid mapping");
          }
          resultBytes = blobIdRetainedTotal(
            resultBytes,
            BLOB_ID_MISMATCH_ROW_BYTES + contentKey.length * 2 + oid.length * 2,
            "blob id lookup result",
          );
          resultMemory.set("other", resultBytes);
          found.set(contentKey, oid);
        }
      }
      return found;
    } finally {
      resultMemory.dispose();
      reservation.dispose();
    }
  }

  /**
   * Return the ordinals of expected mappings that are absent or disagree.
   *
   * An absent result proves the stored mapping equals the expected oid. A
   * `null` value means there is no stored mapping, so callers must identify
   * the content instead of trusting it.
   */
  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    const reservation = this.reserveMemory();
    const stateMemory = reservation.scope();
    const retained: ExpectedBlobIdMapping[] = [];
    const mismatches = new Map<number, string | null>();
    let retainedBytes = 256;
    let capturedCount = 0;
    try {
      stateMemory.set("other", retainedBytes);
      for (const mapping of expected) {
        if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
        const cacheable = mapping.contentId.length <= BLOB_ID_CACHE_ELIGIBILITY_BYTES;
        retainedBytes = blobIdRetainedTotal(
          retainedBytes,
          cacheable ? blobIdMismatchRetainedBytes(mapping) : BLOB_ID_MISMATCH_ROW_BYTES,
          "blob id comparison",
        );
        stateMemory.set("other", retainedBytes);
        if (cacheable) {
          retained.push({
            ordinal: capturedCount,
            contentId: mapping.contentId.slice(),
            oid: mapping.oid,
          });
        } else {
          mismatches.set(capturedCount, null);
        }
        capturedCount++;
      }

      for (const page of expectedContentIdPages(retained, reservation)) {
        for (const row of this.#db.iterate(
          `WITH expected(ordinal, content_id, expected_oid) AS MATERIALIZED (
             SELECT json_extract(value, '$.i'),
                    CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                         ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                     END,
                    json_extract(value, '$.o')
               FROM json_each(?)
           )
           SELECT expected.ordinal, b.oid
             FROM expected
             LEFT JOIN git_blob_ids b
               ON b.repo_id = ? AND b.content_id = expected.content_id
            WHERE b.oid IS NULL OR b.oid <> expected.expected_oid`,
          blob(page.payload),
          JSON.stringify(page.rows),
          this.#repoId,
        )) {
          const returnedOrdinal = row.ordinal;
          const oid = row.oid;
          if (
            typeof returnedOrdinal !== "number" ||
            !Number.isSafeInteger(returnedOrdinal) ||
            returnedOrdinal < 0 ||
            returnedOrdinal >= capturedCount ||
            !page.rows.some((candidate) => candidate.i === returnedOrdinal) ||
            (oid !== null && (typeof oid !== "string" || !isOid(oid)))
          ) {
            throw new CorruptError("blob id comparison returned an invalid mapping");
          }
          if (mismatches.has(returnedOrdinal)) {
            throw new CorruptError("blob id comparison returned a duplicate ordinal");
          }
          mismatches.set(returnedOrdinal, oid);
        }
      }
      return mismatches;
    } finally {
      stateMemory.dispose();
      reservation.dispose();
    }
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    const reservation = this.reserveMemory();
    const inputMemory = reservation.scope();
    const pageMemory = reservation.scope();
    const unique = new Map<string, BlobIdMapping>();
    let retainedBytes = 256;
    try {
      inputMemory.set("other", retainedBytes);
      for (const mapping of mappings) {
        if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
        if (mapping.contentId.length > BLOB_ID_CACHE_ELIGIBILITY_BYTES) continue;
        const addition = blobIdMismatchRetainedBytes(mapping) + mapping.contentId.length * 4;
        const nextBytes = blobIdRetainedTotal(retainedBytes, addition, "blob id update");
        inputMemory.set("other", nextBytes);
        const snapshot: BlobIdMapping = {
          contentId: mapping.contentId.slice(),
          oid: mapping.oid,
        };
        const key = contentIdKey(snapshot.contentId);
        if (!unique.has(key)) {
          retainedBytes = nextBytes;
          unique.set(key, snapshot);
        } else {
          unique.set(key, snapshot);
          inputMemory.set("other", retainedBytes);
        }
      }
      if (unique.size === 0) return;
      this.#db.transactionSync(() => {
        let parts: Uint8Array[] = [];
        let rows: { a: number; n: number; o: string }[] = [];
        let length = 0;
        let pageBytes = 256;
        const flush = (): void => {
          if (rows.length === 0) return;
          pageMemory.set("other", blobIdRetainedTotal(pageBytes, length, "blob id update page"));
          writeBlobIdPage(this.#db, this.#repoId, concat(parts), rows, true, true);
          parts = [];
          rows = [];
          length = 0;
          pageBytes = 256;
          pageMemory.set("other", pageBytes);
        };
        pageMemory.set("other", pageBytes);
        for (const mapping of unique.values()) {
          if (
            rows.length > 0 &&
            (rows.length >= CONTENT_ID_PAGE ||
              length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
          ) {
            flush();
          }
          pageBytes = blobIdRetainedTotal(
            pageBytes,
            160 + mapping.oid.length * 2,
            "blob id update page",
          );
          pageMemory.set("other", pageBytes);
          rows.push({ a: length + 1, n: mapping.contentId.length, o: mapping.oid });
          parts.push(mapping.contentId);
          length += mapping.contentId.length;
        }
        flush();
      });
    } finally {
      pageMemory.dispose();
      inputMemory.dispose();
      reservation.dispose();
    }
  }

  has(oid: string): boolean {
    if (this.shared.hasLoose && this.#looseRow(oid) !== null) return true;
    return this.#packs.typeAndSize(oid) !== null;
  }

  /**
   * Which of `oids` this repository already holds, in one statement per
   * page. Both tables, deliberately: an `ON CONFLICT` on `git_objects`
   * alone cannot see a packed object, so after a clone an unchanged tree
   * would be re-written loose and shadow the packed copy.
   */
  hasAll(oids: Iterable<string>): Set<string> {
    const found = new Set<string>();
    let page: string[] = [];
    const probe = (): void => {
      if (page.length === 0) return;
      for (const row of this.#db.all<{ oid: string }>(
        `SELECT j.value AS oid FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM git_objects o WHERE o.repo_id = ? AND o.oid = j.value)
             OR EXISTS (
               SELECT 1 FROM git_pack_objects p
               JOIN git_pack_meta m
                 ON m.repo_id = p.repo_id AND m.pack_id = p.pack_id AND m.state = 'complete'
                WHERE p.repo_id = ? AND p.oid = j.value
             )`,
        JSON.stringify(page),
        this.#repoId,
        this.#repoId,
      )) {
        found.add(row.oid);
      }
      page = [];
    };
    for (const oid of oids) {
      page.push(oid);
      if (page.length >= OID_PROBE_PAGE) probe();
    }
    probe();
    return found;
  }

  /** The oids this repository does not hold, in input order, deduplicated. */
  missing(oids: Iterable<string>): string[] {
    const wanted = [...new Set(oids)];
    const present = this.hasAll(wanted);
    return wanted.filter((oid) => !present.has(oid));
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    if (this.shared.hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return { type: row.type, size: row.size };
    }
    return this.#packs.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    const cached = this.#objects.get(this.#objectCacheKey(oid));
    if (cached !== undefined) return cached;
    return this.#readLoose(oid) ?? this.#packs.read(oid);
  }

  /** Cold-read and hash one authoritative loose or complete-pack object. */
  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#readAuthenticatedObject(oid, expectedType);
  }

  #readAuthenticatedObjectOwned(
    oid: string,
    expectedType: ObjectType,
    reservation: MemoryReservation,
  ): RawObject | null {
    if (reservation.disposed) {
      throw new GitError("EINVAL", "authenticated object read reservation is disposed");
    }
    if (!this.#sharedStore.ownsMemoryReservation(reservation)) {
      throw new GitError(
        "EINVAL",
        "authenticated object read reservation belongs to another repository",
      );
    }
    if (reservation.currentBytes === 0) {
      throw new GitError("EINVAL", "authenticated object read reservation is not pre-admitted");
    }
    return this.#readAuthenticatedObject(oid, expectedType, reservation);
  }

  #readAuthenticatedObject(
    oid: string,
    expectedType: ObjectType,
    owningReservation?: MemoryReservation,
  ): RawObject | null {
    if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    const loose = this.#looseRow(oid);
    const operation = owningReservation?.scope();
    const output = owningReservation?.scope();
    try {
      if (loose === null) {
        if (operation === undefined || output === undefined || owningReservation === undefined) {
          return this.#packs.readAuthenticatedObject(oid, expectedType);
        }
        const admittedBytes = owningReservation.currentBytes;
        owningReservation.clear("other");
        if (owningReservation.currentBytes !== 0) {
          owningReservation.set("other", admittedBytes - owningReservation.currentBytes);
          throw new GitError(
            "EINVAL",
            "authenticated object read reservation must use a dedicated scope",
          );
        }
        let aggregateRestored = false;
        try {
          const object = this.#packs.readAuthenticatedObject(oid, expectedType, {
            operation,
            output,
          });
          output.transfer("flat", owningReservation, "other");
          owningReservation.set("other", admittedBytes);
          aggregateRestored = true;
          return object;
        } finally {
          if (!aggregateRestored) {
            output.dispose();
            operation.dispose();
            owningReservation.set("other", admittedBytes);
          }
        }
      }
      const cacheKey = this.#objectCacheKey(oid);
      try {
        const object = this.#readLooseObjectRows(
          [{ oid, ...loose }],
          operation === undefined || output === undefined ? undefined : { operation, output },
          owningReservation !== undefined,
        ).get(oid);
        if (object === undefined)
          throw new CorruptError(`loose ${expectedType} ${oid} disappeared`);
        if (object.type !== expectedType) {
          throw new CorruptError(`${oid} is a ${object.type}, not a ${expectedType}`);
        }
        if (hashObject(object.type, object.data) !== oid) {
          throw new CorruptError(`loose ${expectedType} ${oid} does not match its bytes`);
        }
        return object;
      } finally {
        this.#objects.delete(cacheKey);
      }
    } finally {
      output?.dispose();
      operation?.dispose();
    }
  }

  /** Validate bounded object metadata without reading payload bytes. */
  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    const wanted = [...new Set(oids)];
    if (wanted.length > MAX_BLOB_BATCH_OIDS) {
      throw new GitError("E2BIG", `object metadata batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
    }
    for (const oid of wanted) {
      if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    }
    const rows = this.#db.all<{
      ordinal: number;
      oid: string;
      source: string | null;
      type: string | null;
      size: number | null;
      stored: string | null;
      chunk_rows: number;
      first_chunk: number | null;
      last_chunk: number | null;
      largest_chunk: number;
      stored_bytes: number;
    }>(
      `WITH wanted(ordinal, oid) AS MATERIALIZED (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       ), chunks AS MATERIALIZED (
         SELECT chunk.oid, COUNT(*) AS chunk_rows, MIN(chunk.seq) AS first_chunk,
                MAX(chunk.seq) AS last_chunk, MAX(length(chunk.data)) AS largest_chunk,
                SUM(length(chunk.data)) AS stored_bytes
           FROM git_object_chunks chunk
           JOIN wanted ON wanted.oid = chunk.oid
          WHERE chunk.repo_id = ?
          GROUP BY chunk.oid
       )
       SELECT w.ordinal, w.oid,
              CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                   WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
              CASE WHEN loose.oid IS NOT NULL
                         AND typeof(loose.type) = 'text'
                         AND length(CAST(loose.type AS BLOB)) <= 6 THEN loose.type
                   WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                         AND typeof(packed.type) = 'text'
                         AND length(CAST(packed.type AS BLOB)) <= 6 THEN packed.type END AS type,
              CASE WHEN loose.oid IS NOT NULL AND typeof(loose.size) = 'integer' THEN loose.size
                   WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                         AND typeof(packed.size) = 'integer' THEN packed.size END AS size,
              CASE WHEN loose.oid IS NOT NULL
                         AND typeof(loose.stored) = 'text'
                         AND length(CAST(loose.stored AS BLOB)) <= 4 THEN loose.stored END AS stored,
              CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.chunk_rows, 0) END AS chunk_rows,
              CASE WHEN loose.oid IS NULL THEN NULL ELSE chunks.first_chunk END AS first_chunk,
              CASE WHEN loose.oid IS NULL THEN NULL ELSE chunks.last_chunk END AS last_chunk,
              CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.largest_chunk, 0) END AS largest_chunk,
              CASE WHEN loose.oid IS NULL THEN 0 ELSE COALESCE(chunks.stored_bytes, 0) END AS stored_bytes
         FROM wanted w
         LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
         LEFT JOIN chunks ON chunks.oid = w.oid
         LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
          AND pack.state = 'complete'
        ORDER BY w.ordinal`,
      JSON.stringify(wanted),
      this.#repoId,
      this.#repoId,
      this.#repoId,
    );
    if (rows.length !== wanted.length) {
      throw new CorruptError("object metadata lookup returned the wrong row count");
    }
    return rows.map((row, ordinal) => {
      if (
        row.ordinal !== ordinal ||
        row.oid !== wanted[ordinal] ||
        (row.source !== "loose" && row.source !== "pack") ||
        (row.type !== "blob" &&
          row.type !== "tree" &&
          row.type !== "commit" &&
          row.type !== "tag") ||
        !Number.isSafeInteger(row.size) ||
        row.size === null ||
        row.size < 0 ||
        !Number.isSafeInteger(row.chunk_rows) ||
        row.chunk_rows < 0 ||
        !Number.isSafeInteger(row.largest_chunk) ||
        row.largest_chunk < 0 ||
        !Number.isSafeInteger(row.stored_bytes) ||
        row.stored_bytes < 0 ||
        (row.source === "loose" && row.stored !== "raw" && row.stored !== "zlib") ||
        (row.source === "loose" && row.chunk_rows <= 0) ||
        (row.source === "loose" && row.first_chunk !== 0) ||
        (row.source === "loose" && row.last_chunk !== row.chunk_rows - 1) ||
        (row.source === "loose" && row.largest_chunk > OBJECT_CHUNK) ||
        (row.source === "loose" && row.stored === "raw" && row.stored_bytes !== row.size) ||
        (row.source === "loose" && row.stored === "zlib" && row.stored_bytes === 0) ||
        (row.source === "pack" &&
          (row.stored !== null ||
            row.chunk_rows !== 0 ||
            row.first_chunk !== null ||
            row.last_chunk !== null ||
            row.largest_chunk !== 0 ||
            row.stored_bytes !== 0))
      ) {
        if (row.source === null) throw new ObjectNotFoundError(wanted[ordinal]!);
        throw new CorruptError("object metadata lookup returned an invalid row");
      }
      return {
        oid: row.oid,
        type: row.type,
        size: row.size,
        source: row.source,
        chunkRows: row.chunk_rows,
      };
    });
  }

  /** Read a deduplicated prefix of mixed objects under an explicit byte budget. */
  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    const reservation = this.reserveMemory();
    try {
      return this.#readObjectsOwned(oids, options, reservation);
    } finally {
      reservation.dispose();
    }
  }

  #readObjectsOwned(
    oids: readonly string[],
    options: { budgetBytes?: number },
    reservation: MemoryReservation,
  ): ObjectReadBatch {
    const budget = options.budgetBytes ?? PACK_BLOB_BATCH_TARGET_BYTES;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new RangeError("object read budget must be a positive safe integer");
    }
    const inputLength = oids.length;
    if (!Number.isSafeInteger(inputLength) || inputLength > MAX_BLOB_BATCH_OIDS) {
      throw new GitError("E2BIG", `object batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
    }
    const inputMemory = reservation.scope();
    let inputBytes = 512 + inputLength * 8;
    inputMemory.set("other", inputBytes);
    const captured: string[] = [];
    for (let index = 0; index < inputLength; index++) {
      const oid = oids[index];
      if (typeof oid !== "string") throw new CorruptError("invalid object id input");
      inputBytes = blobIdRetainedTotal(
        inputBytes,
        retainedStringBytes(oid) + 8,
        "object read input",
      );
      inputMemory.set("other", inputBytes);
      captured.push(oid);
      if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    }
    const seen = new Set<string>();
    const wanted: string[] = [];
    for (const oid of captured) {
      if (seen.has(oid)) continue;
      inputBytes = blobIdRetainedTotal(inputBytes, 160, "object read input");
      inputMemory.set("other", inputBytes);
      seen.add(oid);
      wanted.push(oid);
    }
    if (wanted.length === 0) return { objects: new Map(), remaining: [], bytes: 0 };

    const jsonMemory = reservation.scope();
    const jsonUnits = 2 + Math.max(0, wanted.length - 1) + wanted.length * 42;
    jsonMemory.set("other", 128 + retainedStringUnits(jsonUnits));
    const encodedWanted = JSON.stringify(wanted);

    const metadataMemory = reservation.scope();
    metadataMemory.set("other", 512 + wanted.length * 768);
    const rawMetadata = this.#db.all<Record<string, unknown>>(
      `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.ordinal, w.oid,
               CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                    WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
               CASE WHEN loose.oid IS NOT NULL
                          AND typeof(loose.type) = 'text'
                          AND length(CAST(loose.type AS BLOB)) <= 6 THEN loose.type
                    WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                          AND typeof(packed.type) = 'text'
                          AND length(CAST(packed.type AS BLOB)) <= 6 THEN packed.type END AS type,
               CASE WHEN loose.oid IS NOT NULL AND typeof(loose.size) = 'integer' THEN loose.size
                    WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                          AND typeof(packed.size) = 'integer' THEN packed.size END AS size,
               CASE WHEN loose.oid IS NOT NULL
                          AND typeof(loose.stored) = 'text'
                          AND length(CAST(loose.stored AS BLOB)) <= 4 THEN loose.stored END AS stored
          FROM wanted w
          LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
          LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
           AND pack.state = 'complete'
         ORDER BY w.ordinal`,
      encodedWanted,
      this.#repoId,
      this.#repoId,
    );
    if (rawMetadata.length !== wanted.length) {
      throw new CorruptError("object metadata lookup returned the wrong row count");
    }

    const metadata: ObjectReadMetadata[] = [];
    for (let index = 0; index < rawMetadata.length; index++) {
      const row = rawMetadata[index];
      if (row === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
      const oid = row.oid;
      const source = row.source;
      if (row.ordinal !== index || typeof oid !== "string" || oid !== wanted[index]) {
        throw new CorruptError("object metadata lookup returned an invalid identity");
      }
      if (source !== "loose" && source !== "pack") {
        if (source === null) throw new ObjectNotFoundError(oid);
        throw new CorruptError("object metadata lookup returned an invalid source");
      }
      if (
        row.type !== "blob" &&
        row.type !== "tree" &&
        row.type !== "commit" &&
        row.type !== "tag"
      ) {
        throw new CorruptError(`object ${oid} has an invalid indexed type`);
      }
      const { size } = row;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new CorruptError(`object ${oid} has an invalid indexed size`);
      }
      let stored: "raw" | "zlib" | null;
      if (source === "loose") {
        if (row.stored !== "raw" && row.stored !== "zlib") {
          throw new CorruptError(`object ${oid} has invalid storage metadata`);
        }
        stored = row.stored;
      } else {
        if (row.stored !== null) {
          throw new CorruptError(`object ${oid} has invalid storage metadata`);
        }
        stored = null;
      }
      metadata.push({
        ordinal: index,
        oid,
        source,
        type: row.type,
        size,
        stored,
      });
    }

    const selectionMemory = reservation.scope();
    let selectionBytes = 256;
    selectionMemory.set("other", selectionBytes);
    const selected: ObjectReadMetadata[] = [];
    let bytes = 0;
    for (const row of metadata) {
      if (row.size > Number.MAX_SAFE_INTEGER - bytes) {
        throw new GitError("E2BIG", "object read retained-memory accounting overflow");
      }
      if (selected.length > 0 && bytes + row.size > budget) break;
      selectionBytes = blobIdRetainedTotal(selectionBytes, 200, "object read selection");
      selectionMemory.set("other", selectionBytes);
      selected.push(row);
      bytes += row.size;
      if (bytes >= budget) break;
    }

    let sourceArrayBytes = selectionBytes;
    let looseOutputBytes = 0;
    let packedOutputBytes = 0;
    const looseRows: ObjectReadMetadata[] = [];
    const packedOids: string[] = [];
    for (const row of selected) {
      sourceArrayBytes = blobIdRetainedTotal(
        sourceArrayBytes,
        row.source === "loose" ? 8 : 8 + retainedStringBytes(row.oid),
        "object read source arrays",
      );
      selectionMemory.set("other", sourceArrayBytes);
      if (row.source === "loose") {
        looseOutputBytes = blobIdRetainedTotal(looseOutputBytes, row.size, "loose object output");
        looseRows.push(row);
      } else {
        packedOutputBytes = blobIdRetainedTotal(
          packedOutputBytes,
          row.size,
          "packed object output",
        );
        packedOids.push(row.oid);
      }
    }

    const remainingCount = wanted.length - selected.length;
    const outputBytes =
      512 + selected.length * 256 + remainingCount * 8 + looseOutputBytes + packedOutputBytes;
    if (!Number.isSafeInteger(outputBytes)) {
      throw new GitError("E2BIG", "object read output memory accounting overflow");
    }
    const outputMemory = reservation.scope();
    const initialOutputBytes = 512 + selected.length * 256 + remainingCount * 8 + looseOutputBytes;
    outputMemory.set("other", initialOutputBytes);
    const remaining = wanted.slice(selected.length);
    const looseOperation = reservation.scope();
    const packedOperation = reservation.scope();
    const packedOutput = reservation.scope();
    try {
      const looseObjects = this.#readLooseObjectRows(looseRows, {
        operation: looseOperation,
        output: outputMemory,
      });
      const packed =
        packedOids.length === 0
          ? new Map<string, RawObject>()
          : this.#packs.readObjects(packedOids, null, {
              operation: packedOperation,
              output: packedOutput,
            });
      const objects = new Map<string, RawObject>();
      for (const row of selected) {
        const object = (row.source === "loose" ? looseObjects : packed).get(row.oid);
        if (object === undefined || object.type !== row.type || object.data.length !== row.size) {
          throw new CorruptError(`object ${row.oid} did not produce its indexed bytes`);
        }
        objects.set(row.oid, object);
      }
      packed.clear();
      packedOutput.transfer("flat", outputMemory, "other");
      outputMemory.set("other", outputBytes);
      return { objects, remaining, bytes };
    } finally {
      packedOutput.dispose();
      packedOperation.dispose();
      looseOperation.dispose();
    }
  }

  /** Read a deduplicated prefix of blobs under an explicit byte budget. */
  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    const reservation = this.reserveMemory();
    try {
      const batch = this.#readObjectsOwned(oids, options, reservation);
      reservation.set("metadata", 128 + batch.objects.size * 128);
      const blobs = new Map<string, Uint8Array>();
      for (const [oid, object] of batch.objects) {
        if (object.type !== "blob")
          throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
        blobs.set(oid, object.data);
      }
      return { blobs, remaining: batch.remaining, bytes: batch.bytes };
    } finally {
      reservation.dispose();
    }
  }

  /** Stream every non-tree entry in raw Git DFS order with one SQL statement. */
  *walkTree(treeOid: string, owningReservation?: MemoryReservation): Generator<WalkTreeEntry> {
    if (
      owningReservation !== undefined &&
      !this.#sharedStore.ownsMemoryReservation(owningReservation)
    ) {
      throw new GitError("EINVAL", "tree walk reservation belongs to another repository");
    }
    const reservation = owningReservation?.scope() ?? this.reserveMemory();
    try {
      yield* iterateTree(this.#db, this.#repoId, treeOid, reservation);
    } finally {
      reservation.dispose();
    }
  }

  /** Stream changed leaves between two trees while pruning equal subtrees. */
  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
    owningReservation?: MemoryReservation,
  ): Generator<WalkTreeDiffEntry> {
    if (
      owningReservation !== undefined &&
      !this.#sharedStore.ownsMemoryReservation(owningReservation)
    ) {
      throw new GitError("EINVAL", "tree diff reservation belongs to another repository");
    }
    const reservation = owningReservation?.scope() ?? this.reserveMemory();
    try {
      yield* iterateTreeDiff(this.#db, this.#repoId, beforeTreeOid, afterTreeOid, reservation);
    } finally {
      reservation.dispose();
    }
  }

  /** Stream objects introduced by one tree transition. */
  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
    owningReservation?: MemoryReservation,
  ): Generator<WalkTreeDiffObject> {
    if (
      owningReservation !== undefined &&
      !this.#sharedStore.ownsMemoryReservation(owningReservation)
    ) {
      throw new GitError("EINVAL", "tree diff reservation belongs to another repository");
    }
    const reservation = owningReservation?.scope() ?? this.reserveMemory();
    try {
      yield* iterateTreeDiffObjects(
        this.#db,
        this.#repoId,
        beforeTreeOid,
        afterTreeOid,
        reservation,
      );
    } finally {
      reservation.dispose();
    }
  }

  write(type: ObjectType, data: Uint8Array): string {
    const reservation = this.reserveMemory();
    const commitMemory = reservation.scope();
    const storageMemory = reservation.scope();
    try {
      const oid = hashObject(type, data);
      const commitEntry =
        type === "commit"
          ? prepareCommitCacheOwned({ repoId: this.#repoId, oid, data }, commitMemory)
          : undefined;
      if (this.has(oid)) {
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
        return oid;
      }
      const stored = looseEncoding(data.length);
      storageMemory.set(
        "other",
        stored === "raw" ? data.length : maximumDeflatedBytes(data.length),
      );
      const storedData = encodeLoose(data, stored);
      storageMemory.set("other", storedData.length);
      const createdMs = this.#nowMilliseconds();
      this.#db.transactionSync(() => {
        this.#db.run(
          "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, ?)",
          this.#repoId,
          oid,
          type,
          data.length,
          stored,
        );
        this.#db.run(
          `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         VALUES (?, ?, ?)`,
          this.#repoId,
          oid,
          createdMs,
        );
        this.#db.run(
          "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
          this.#repoId,
          oid,
        );
        for (
          let seq = 0, offset = 0;
          offset < storedData.length || seq === 0;
          seq++, offset += OBJECT_CHUNK
        ) {
          const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
          if (part.length === 0) {
            this.#db.run(
              "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, zeroblob(0))",
              this.#repoId,
              oid,
              seq,
            );
          } else {
            this.#db.run(
              "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
              this.#repoId,
              oid,
              seq,
              blob(part),
            );
          }
        }
        if (type === "tree") {
          const treeMemory = reservation.scope();
          try {
            indexSeededTreeSource(
              this.#db,
              {
                repoId: this.#repoId,
                treeOid: oid,
                storage: "loose",
                sourceId: 0,
                objectSize: data.length,
              },
              [data],
              treeMemory,
            );
          } finally {
            treeMemory.dispose();
          }
        }
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
      });
      this.shared.markLoose();
      this.#objects.set(this.#objectCacheKey(oid), { type, data });
      return oid;
    } finally {
      storageMemory.dispose();
      commitMemory.dispose();
      reservation.dispose();
    }
  }

  /**
   * Write a loose object from a stream of chunks. `chunks` is a factory
   * because the content is read twice: once to hash it, which is how the oid
   * is known and how `has` can short-circuit before a single row is written,
   * and once to deflate and store it. Nothing larger than one chunk is ever
   * live, so the peak does not follow the object's size.
   */
  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitError("EINVAL", "streamed object size must be a safe nonnegative integer");
    }
    const reservation = this.reserveMemory();
    const sourceMemory = reservation.scope();
    const parserMemory = reservation.scope();
    const storageMemory = reservation.scope();
    try {
      const hash = new Sha1().update(objectHeader(type, size));
      if (type === "commit") sourceMemory.set("other", size);
      const commitData = type === "commit" ? new Uint8Array(size) : undefined;
      let hashed = 0;
      for (const chunk of chunks()) {
        if (hashed + chunk.length <= size) commitData?.set(chunk, hashed);
        hashed += chunk.length;
        hash.update(chunk);
      }
      if (hashed !== size) {
        throw new CorruptError(`streamed ${hashed} bytes for a ${type} declared as ${size}`);
      }
      const oid = toHex(hash.digest());
      const commitEntry =
        commitData === undefined
          ? undefined
          : prepareCommitCacheOwned({ repoId: this.#repoId, oid, data: commitData }, parserMemory);
      if (this.has(oid)) {
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
        return oid;
      }

      const stored = looseEncoding(size);
      if (stored === "raw") {
        if (commitData === undefined) storageMemory.set("other", size);
        const data = commitData ?? new Uint8Array(size);
        const storageHash = new Sha1().update(objectHeader(type, size));
        let offset = 0;
        for (const chunk of chunks()) {
          if (offset + chunk.length > size) {
            throw new CorruptError(`stream changed after hashing ${oid}`);
          }
          data.set(chunk, offset);
          storageHash.update(chunk);
          offset += chunk.length;
        }
        if (offset !== size) throw new CorruptError(`stream changed after hashing ${oid}`);
        if (toHex(storageHash.digest()) !== oid) {
          throw new CorruptError(`stream changed after hashing ${oid}`);
        }
        const createdMs = this.#nowMilliseconds();
        this.#db.transactionSync(() => {
          this.#db.run(
            "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'raw')",
            this.#repoId,
            oid,
            type,
            size,
          );
          this.#db.run(
            `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
           VALUES (?, ?, ?)`,
            this.#repoId,
            oid,
            createdMs,
          );
          this.#db.run(
            "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
            this.#repoId,
            oid,
          );
          if (data.length === 0) {
            this.#db.run(
              "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, zeroblob(0))",
              this.#repoId,
              oid,
            );
          } else {
            this.#db.run(
              "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
              this.#repoId,
              oid,
              blob(data),
            );
          }
          if (type === "tree") {
            const treeMemory = reservation.scope();
            try {
              indexSeededTreeSource(
                this.#db,
                {
                  repoId: this.#repoId,
                  treeOid: oid,
                  storage: "loose",
                  sourceId: 0,
                  objectSize: size,
                },
                [data],
                treeMemory,
              );
            } finally {
              treeMemory.dispose();
            }
          }
          if (commitEntry !== undefined) {
            requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
          }
        });
        this.shared.markLoose();
        return oid;
      }

      const rows: Uint8Array[] = [];
      storageMemory.set("other", 2 * STREAM_CHUNK);
      const deflate = new pako.Deflate({ chunkSize: STREAM_CHUNK });
      deflate.onData = (chunk) => {
        if (!(chunk instanceof Uint8Array))
          throw new CorruptError("deflate produced a non-binary chunk");
        rows.push(chunk);
      };

      const createdMs = this.#nowMilliseconds();
      this.#db.transactionSync(() => {
        this.#db.run(
          "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'zlib')",
          this.#repoId,
          oid,
          type,
          size,
        );
        this.#db.run(
          `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         VALUES (?, ?, ?)`,
          this.#repoId,
          oid,
          createdMs,
        );
        this.#db.run(
          "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
          this.#repoId,
          oid,
        );
        let seq = 0;
        const drain = (): void => {
          for (const row of rows) {
            this.#db.run(
              "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
              this.#repoId,
              oid,
              seq++,
              blob(row),
            );
          }
          rows.length = 0;
        };
        const storageChunks = function* (): Generator<Uint8Array> {
          const storageHash = new Sha1().update(objectHeader(type, size));
          let streamed = 0;
          for (const chunk of chunks()) {
            const offset = streamed;
            streamed += chunk.length;
            if (streamed > size) throw new CorruptError(`stream changed after hashing ${oid}`);
            commitData?.set(chunk, offset);
            storageHash.update(chunk);
            deflate.push(chunk, false);
            if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
            drain();
            yield chunk;
          }
          deflate.push(new Uint8Array(0), true);
          if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
          drain();
          if (streamed !== size || toHex(storageHash.digest()) !== oid) {
            throw new CorruptError(`stream changed after hashing ${oid}`);
          }
        };
        const storage = storageChunks();
        if (type === "tree") {
          const treeMemory = reservation.scope();
          try {
            indexSeededTreeSource(
              this.#db,
              {
                repoId: this.#repoId,
                treeOid: oid,
                storage: "loose",
                sourceId: 0,
                objectSize: size,
              },
              storage,
              treeMemory,
            );
          } finally {
            treeMemory.dispose();
          }
        } else {
          for (const _chunk of storage) {
            // Storage and hashing advance together without retaining the object.
          }
        }
        // An empty object still deserves one row, matching `write`.
        if (seq === 0) {
          this.#db.run(
            "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
            this.#repoId,
            oid,
            0,
            blob(new Uint8Array(0)),
          );
        }
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
      });
      this.shared.markLoose();
      return oid;
    } finally {
      storageMemory.dispose();
      parserMemory.dispose();
      sourceMemory.dispose();
      reservation.dispose();
    }
  }

  /**
   * Open a batch of loose object writes. However many objects go in, a
   * flush costs one existence probe, one delete, one insert per payload
   * budget and one metadata insert — not five statements per object.
   *
   * The caller owns the lifecycle; `writeObjects` is the scoped form that
   * cannot forget the final flush.
   */
  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.#createWriteBatch(options);
  }

  #writeBatchOwned(reservation: MemoryReservation, options: ObjectBatchOptions): OwnedObjectBatch {
    if (!this.#sharedStore.ownsMemoryReservation(reservation)) {
      throw new GitError("EINVAL", "object batch reservation belongs to another repository");
    }
    return this.#createWriteBatch(options, reservation);
  }

  #createWriteBatch(
    options: ObjectBatchOptions,
    reservation?: MemoryReservation,
  ): OwnedObjectBatch {
    const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
    const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
    // Keyed by oid: a tree build re-emits identical subtrees, and one
    // (oid, seq) may appear at most once in a payload.
    const staged = new Map<string, StagedObject>();
    let bytes = 0;
    let commitBytes = 0;
    let active = true;
    const stageMemory = reservation?.scope();
    const requireActive = (): void => {
      if (!active) throw new GitError("EINVAL", "object batch is disposed");
    };
    const charge = (
      nextBytes = bytes,
      nextCommitBytes = commitBytes,
      count = staged.size,
    ): void => {
      const retained = 512 + count * 256 + nextBytes + nextCommitBytes;
      if (!Number.isSafeInteger(retained)) {
        throw new GitError("E2BIG", "object batch retained-memory accounting overflow");
      }
      stageMemory?.set("other", retained);
    };
    const clear = (): void => {
      staged.clear();
      bytes = 0;
      commitBytes = 0;
      stageMemory?.clear("other");
    };
    const flush = (): void => {
      requireActive();
      if (staged.size === 0) return;
      const flushMemory = reservation?.scope();
      try {
        flushMemory?.set("other", objectFlushInitialRetainedBytes(staged.size));
        this.#flushObjects([...staged.values()], payloadBytes, flushMemory);
      } finally {
        flushMemory?.dispose();
        clear();
      }
    };
    return {
      write: (type: ObjectType, data: Uint8Array): string => {
        requireActive();
        try {
          const oid = hashObject(type, data);
          if (staged.has(oid)) return oid;
          const stored = looseEncoding(data.length);
          const maximumStoredBytes =
            stored === "raw" ? data.length : maximumDeflatedBytes(data.length);
          const maximumTreeBytes = type === "tree" && stored !== "raw" ? data.length : 0;
          const commitPreparationBytes =
            type === "commit" ? commitPreparationTransientBytes(data.length) : 0;
          charge(
            bytes + maximumStoredBytes + maximumTreeBytes,
            commitBytes + commitPreparationBytes,
            staged.size + 1,
          );
          const storedData = stored === "raw" ? data.slice() : encodeLoose(data, stored);
          const object: StagedObject = { oid, type, size: data.length, stored, storedData };
          if (type === "tree") object.treeData = stored === "raw" ? storedData : data.slice();
          if (type === "commit") {
            const commitEntry = prepareCommitCache({ repoId: this.#repoId, oid, data });
            object.commitEntry = commitEntry;
          }
          const nextBytes =
            bytes +
            storedData.length +
            (object.treeData !== undefined && object.treeData !== storedData
              ? object.treeData.length
              : 0);
          const nextCommitBytes = commitBytes + (object.commitEntry?.cacheBytes ?? 0);
          charge(nextBytes, nextCommitBytes, staged.size + 1);
          staged.set(oid, object);
          bytes = nextBytes;
          commitBytes = nextCommitBytes;
          // After staging, never before: an object's chunks and its metadata
          // row have to land in the same flush, whatever its size.
          if (
            bytes >= payloadBytes ||
            commitBytes >= COMMIT_STAGE_CACHE_BYTES ||
            staged.size >= flushEvery
          ) {
            flush();
          }
          return oid;
        } catch (error) {
          clear();
          throw error;
        }
      },
      flush,
      dispose: (): void => {
        if (!active) return;
        clear();
        active = false;
        stageMemory?.dispose();
      },
    };
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    const reservation = this.reserveMemory();
    const batch = this.#createWriteBatch(options, reservation);
    try {
      const result = body(batch);
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "object batch callback must be synchronous");
      }
      batch.flush();
      return result;
    } finally {
      batch.dispose();
      reservation.dispose();
    }
  }

  #flushObjects(
    staged: StagedObject[],
    payloadBytes: number,
    transientMemory?: MemoryReservation,
  ): void {
    transientMemory?.set("other", objectFlushTransientBytes(staged, payloadBytes));
    const byOid = new Map(staged.map((object) => [object.oid, object]));
    const commitEntries = staged.flatMap((object) =>
      object.commitEntry === undefined ? [] : [object.commitEntry],
    );
    const meta = JSON.stringify(
      staged.map((object) => ({ o: object.oid, t: object.type, s: object.size, e: object.stored })),
    );
    let wroteLoose = false;
    this.#db.transactionSync(() => {
      const fresh: StagedObject[] = [];
      for (const row of this.#db.iterate(
        `INSERT INTO git_objects (repo_id, oid, type, size, stored)
         SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.t'),
                json_extract(j.value, '$.s'), json_extract(j.value, '$.e')
           FROM json_each(?) j
          WHERE NOT EXISTS (
            SELECT 1
              FROM git_pack_objects packed
              JOIN git_pack_meta pack
                ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
               AND pack.state = 'complete'
             WHERE packed.repo_id = ?
               AND packed.oid = json_extract(j.value, '$.o')
          )
         ON CONFLICT(repo_id, oid) DO NOTHING
         RETURNING oid`,
        this.#repoId,
        meta,
        this.#repoId,
      )) {
        if (typeof row.oid !== "string") {
          throw new CorruptError("object metadata insert returned an invalid oid");
        }
        const object = byOid.get(row.oid);
        if (object === undefined) {
          throw new CorruptError("object metadata insert returned an unknown oid");
        }
        fresh.push(object);
      }
      if (fresh.length === 0) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, commitEntries), commitEntries.length);
        return;
      }
      wroteLoose = true;

      const payloads: ChunkPayload[] = [{ parts: [], length: 0, rows: [] }];
      for (const object of fresh) {
        const storedData = object.storedData;
        for (
          let seq = 0, offset = 0;
          offset < storedData.length || seq === 0;
          seq++, offset += OBJECT_CHUNK
        ) {
          const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
          let current = payloads[payloads.length - 1]!;
          if (current.length > 0 && current.length + part.length > payloadBytes) {
            current = { parts: [], length: 0, rows: [] };
            payloads.push(current);
          }
          // `a` is a 1-based byte offset: substr() counts bytes over a BLOB.
          current.rows.push({ o: object.oid, q: seq, a: current.length + 1, n: part.length });
          current.parts.push(part);
          current.length += part.length;
        }
      }

      const oids = JSON.stringify(fresh.map((object) => object.oid));
      this.#db.run(
        `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         SELECT ?, value, ? FROM json_each(?)`,
        this.#repoId,
        this.#nowMilliseconds(),
        oids,
      );
      // The transaction keeps metadata invisible until all chunks and parsed
      // tree rows are ready, while RETURNING replaces a separate probe.
      this.#db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
        this.#repoId,
        oids,
      );
      for (const payload of payloads) {
        this.#db.run(
          `INSERT INTO git_object_chunks (repo_id, oid, seq, data)
           SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.q'),
                  CASE WHEN json_extract(j.value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.n'))
                   END
             FROM json_each(?) j
            WHERE true
           ON CONFLICT(repo_id, oid, seq) DO UPDATE SET data = excluded.data`,
          this.#repoId,
          blob(concat(payload.parts)),
          JSON.stringify(payload.rows),
        );
      }
      let treeMemory = transientMemory;
      let localTreeMemory: MemoryReservation | null = null;
      if (treeMemory === undefined) {
        localTreeMemory = this.reserveMemory();
        treeMemory = localTreeMemory;
      }
      try {
        indexSeededTreeSources(
          this.#db,
          fresh.flatMap((object) => {
            if (object.type !== "tree" || object.treeData === undefined) return [];
            return [
              {
                repoId: this.#repoId,
                treeOid: object.oid,
                storage: "loose",
                sourceId: 0,
                objectSize: object.size,
                chunks: [object.treeData],
              },
            ];
          }),
          treeMemory,
        );
      } finally {
        localTreeMemory?.dispose();
      }
      requireCommitCacheWrites(insertCommitCaches(this.#db, commitEntries), commitEntries.length);
    });
    if (wroteLoose) this.shared.markLoose();
  }

  /**
   * Inflated object bytes, chunk by chunk. A loose object really streams: its
   * rows are read one at a time and inflated incrementally. A packed object
   * yields exactly one chunk holding the whole thing, because a delta cannot
   * be reconstructed without its full base in memory. Null when unknown.
   */
  readChunks(oid: string): Iterable<Uint8Array> | null {
    const cached = this.#objects.get(this.#objectCacheKey(oid));
    if (cached !== undefined) return [cached.data];
    if (this.shared.hasLoose) {
      const row = this.#looseRow(oid);
      if (row !== null) return this.#looseChunks(oid, parseLooseEncoding(row.stored));
    }
    const packed = this.#packs.read(oid);
    return packed === null ? null : [packed.data];
  }

  *#looseChunks(oid: string, stored: LooseEncoding): Generator<Uint8Array> {
    if (stored === "raw") {
      for (let seq = 0; ; seq++) {
        const row = this.#db.one<{ data: unknown }>(
          "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
          this.#repoId,
          oid,
          seq,
        );
        if (row === undefined) return;
        yield readBlob(row.data);
      }
    }
    const ready: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => ready.push(chunk));
    for (let seq = 0; ; seq++) {
      const row = this.#db.one<{ data: unknown }>(
        "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq = ?",
        this.#repoId,
        oid,
        seq,
      );
      if (row === undefined) break;
      const compressed = readBlob(row.data);
      for (let offset = 0; offset < compressed.length; offset += INFLATE_FEED) {
        stream.push(compressed.subarray(offset, offset + INFLATE_FEED));
        for (const chunk of ready) yield chunk;
        ready.length = 0;
      }
      if (compressed.length === 0) {
        for (const chunk of ready) yield chunk;
        ready.length = 0;
      }
    }
    for (const chunk of ready) yield chunk;
  }

  /** Resolve an abbreviated oid. Null when unknown or ambiguous. */
  resolvePrefix(prefix: string): string | null {
    if (prefix.length === 40) return this.has(prefix) ? prefix : null;
    const found = new Set<string>();
    if (this.shared.hasLoose) {
      const upper = nextPrefix(prefix);
      for (const row of this.#db.all<{ oid: string }>(
        "SELECT oid FROM git_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT 2",
        this.#repoId,
        prefix,
        upper,
      )) {
        found.add(row.oid);
      }
    }
    for (const oid of this.#packs.findPrefix(prefix, 2)) found.add(oid);
    return found.size === 1 ? [...found][0]! : null;
  }

  objectCount(): number {
    const loose =
      this.#db.scalar<number>("SELECT COUNT(*) FROM git_objects WHERE repo_id = ?", this.#repoId) ??
      0;
    return loose + this.#packs.count();
  }

  #looseRow(oid: string): { type: ObjectType; size: number; stored: string } | null {
    return (
      this.#db.one<{ type: ObjectType; size: number; stored: string }>(
        "SELECT type, size, stored FROM git_objects WHERE repo_id = ? AND oid = ?",
        this.#repoId,
        oid,
      ) ?? null
    );
  }

  #readLoose(oid: string): RawObject | null {
    if (!this.shared.hasLoose) return null;
    const row = this.#looseRow(oid);
    if (row === null) return null;
    return this.#readLooseObjectRows([{ oid, ...row }]).get(oid) ?? null;
  }

  #readLooseObjects(oids: readonly string[], ownership: PackReadOwnership): Map<string, RawObject> {
    this.#validateLooseReadOwnership(ownership);
    if (oids.length === 0) return new Map();
    const rows = this.#db.all<{
      oid: string;
      type: string;
      size: number;
      stored: string;
    }>(
      `SELECT wanted.value AS oid, object.type, object.size, object.stored
         FROM json_each(?) wanted
         JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.value`,
      JSON.stringify(oids),
      this.#repoId,
    );
    return this.#readLooseObjectRows(rows, ownership);
  }

  #looseObjectMetadata(oids: readonly string[]): Map<string, { type: ObjectType; size: number }> {
    if (oids.length === 0) return new Map();
    const result = new Map<string, { type: ObjectType; size: number }>();
    for (const row of this.#db.all<{ oid: string; type: string; size: number }>(
      `SELECT wanted.value AS oid, object.type, object.size
         FROM json_each(?) wanted
         JOIN git_objects object ON object.repo_id = ? AND object.oid = wanted.value`,
      JSON.stringify(oids),
      this.#repoId,
    )) {
      if (
        !isOid(row.oid) ||
        !isObjectType(row.type) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > MAX_PACK_DELTA_WORKING_BYTES ||
        result.has(row.oid)
      ) {
        throw new CorruptError("loose object metadata query returned an invalid row");
      }
      result.set(row.oid, { type: row.type, size: row.size });
    }
    return result;
  }

  #readLooseObjectRows(
    rows: readonly {
      oid: string;
      type: string | null;
      size: number | null;
      stored: string | null;
    }[],
    ownership?: PackReadOwnership,
    callerOwnsLiveSet = false,
  ): Map<string, RawObject> {
    if (rows.length === 0) return new Map();
    if (callerOwnsLiveSet && ownership === undefined) {
      throw new GitError("EINVAL", "pre-admitted loose object read ownership is missing");
    }
    let localOperation: MemoryReservation | undefined;
    let localOutput: MemoryReservation | undefined;
    if (ownership === undefined) {
      let outputBytes = 512 + rows.length * 256;
      for (const row of rows) {
        if (typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0) {
          throw new CorruptError(`loose blob ${row.oid} has an invalid size`);
        }
        outputBytes = blobIdRetainedTotal(outputBytes, row.size, "loose object output");
      }
      localOperation = this.reserveMemory();
      localOutput = localOperation.scope();
      try {
        localOutput.set("other", outputBytes);
      } catch (error) {
        localOutput.dispose();
        localOperation.dispose();
        throw error;
      }
      ownership = { operation: localOperation, output: localOutput };
    } else {
      this.#validateLooseReadOwnership(ownership);
    }
    const reservation = ownership.operation.scope();
    try {
      const inputMemory = reservation.scope();
      if (!callerOwnsLiveSet) inputMemory.set("other", 256 + rows.length * 512);
      const wanted = rows.map((row) => row.oid);
      let wantedJsonUnits = 2 + Math.max(0, wanted.length - 1);
      for (const oid of wanted) {
        wantedJsonUnits = blobIdRetainedTotal(
          wantedJsonUnits,
          jsonStringMaxUnits(oid),
          "loose object input JSON",
        );
      }
      const jsonMemory = reservation.scope();
      if (!callerOwnsLiveSet) {
        jsonMemory.set("other", 128 + retainedStringUnits(wantedJsonUnits));
      }
      const encodedWanted = JSON.stringify(wanted);
      const gateMemory = reservation.scope();
      if (!callerOwnsLiveSet) gateMemory.set("other", 256 + rows.length * 384);
      const gate = this.#db.all<{
        oid: string;
        chunks: number;
        first_seq: number | null;
        last_seq: number | null;
        largest_chunk: number;
        stored_bytes: number;
      }>(
        `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.oid, COUNT(c.seq) AS chunks, MIN(c.seq) AS first_seq,
              MAX(c.seq) AS last_seq, COALESCE(MAX(length(c.data)), 0) AS largest_chunk,
              COALESCE(SUM(length(c.data)), 0) AS stored_bytes
         FROM wanted w
         LEFT JOIN git_object_chunks c ON c.repo_id = ? AND c.oid = w.oid
        GROUP BY w.ordinal, w.oid
        ORDER BY w.ordinal`,
        encodedWanted,
        this.#repoId,
      );
      let storedBytes = 0;
      let rawOutputBytes = 0;
      let inflatedOutputBytes = 0;
      if (gate.length !== rows.length) throw new CorruptError("loose blob gate lost an object");
      for (let index = 0; index < gate.length; index++) {
        const checked = gate[index]!;
        const source = rows[index]!;
        const chunks = Number(checked.chunks);
        const size = source.size;
        const stored = parseLooseEncoding(source.stored ?? "");
        if (
          checked.oid !== source.oid ||
          !isObjectType(source.type) ||
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_PACK_DELTA_WORKING_BYTES ||
          !Number.isSafeInteger(chunks) ||
          chunks <= 0 ||
          checked.first_seq !== 0 ||
          checked.last_seq !== chunks - 1 ||
          !Number.isSafeInteger(checked.largest_chunk) ||
          checked.largest_chunk < 0 ||
          checked.largest_chunk > OBJECT_CHUNK ||
          !Number.isSafeInteger(checked.stored_bytes) ||
          checked.stored_bytes < 0 ||
          (stored === "raw" && checked.stored_bytes !== size) ||
          (stored === "zlib" && checked.stored_bytes === 0)
        ) {
          throw new CorruptError(`loose blob ${source.oid} has invalid chunk metadata`);
        }
        storedBytes += checked.stored_bytes;
        if (!Number.isSafeInteger(storedBytes)) {
          throw new GitError("E2BIG", "loose object storage memory accounting overflow");
        }
        if (stored === "raw") rawOutputBytes += size;
        else inflatedOutputBytes += size;
        if (!Number.isSafeInteger(rawOutputBytes) || !Number.isSafeInteger(inflatedOutputBytes)) {
          throw new GitError("E2BIG", "loose object output memory accounting overflow");
        }
      }
      const materializationBytes = 1_024 + rows.length * 512 + 2 * storedBytes - rawOutputBytes;
      if (!Number.isSafeInteger(materializationBytes)) {
        throw new GitError("E2BIG", "loose object materialization memory accounting overflow");
      }
      if (!callerOwnsLiveSet) reservation.set("other", materializationBytes);

      const parts = new Map<string, Uint8Array[]>();
      for (const row of this.#db.iterate(
        `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.oid, c.seq, c.data
         FROM wanted w
         JOIN git_object_chunks c ON c.repo_id = ? AND c.oid = w.oid
        ORDER BY w.ordinal, c.seq`,
        encodedWanted,
        this.#repoId,
      )) {
        if (typeof row.oid !== "string" || !Number.isSafeInteger(row.seq)) {
          throw new CorruptError("loose blob query returned invalid chunk metadata");
        }
        const list = parts.get(row.oid);
        if (list === undefined) parts.set(row.oid, [readBlob(row.data)]);
        else list.push(readBlob(row.data));
      }

      const result = new Map<string, RawObject>();
      for (const row of rows) {
        if (!isObjectType(row.type))
          throw new CorruptError(`${row.oid} has an invalid object type`);
        const size = row.size;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
          throw new CorruptError(`loose blob ${row.oid} has an invalid size`);
        }
        if (size > MAX_PACK_DELTA_WORKING_BYTES) {
          throw new GitError("E2BIG", `loose blob ${row.oid} exceeds the bounded inflate limit`);
        }
        const stored = parseLooseEncoding(row.stored ?? "");
        const encoded = concat(parts.get(row.oid) ?? []);
        let data: Uint8Array;
        if (stored === "raw") {
          data = encoded;
        } else {
          const stream = new InflateInto(size);
          let consumed = 0;
          while (!stream.ended && consumed < encoded.length) {
            const input = encoded.subarray(consumed, consumed + INFLATE_FEED);
            let used: number;
            try {
              used = stream.push(input);
            } catch (error) {
              if (error instanceof InflateSizeError) {
                throw new CorruptError(`loose object ${row.oid} exceeds its indexed size`, {
                  cause: error,
                });
              }
              throw error;
            }
            consumed += used;
            if (!stream.ended && used !== input.length) {
              throw new CorruptError(`loose object ${row.oid} inflater made no progress`);
            }
          }
          if (!stream.ended || consumed !== encoded.length) {
            throw new CorruptError(`loose object ${row.oid} size does not match its metadata`);
          }
          try {
            data = stream.finish();
          } catch (error) {
            throw new CorruptError(`loose object ${row.oid} size does not match its metadata`, {
              cause: error,
            });
          }
        }
        if (data.length !== size) {
          throw new CorruptError(`loose blob ${row.oid} size does not match its metadata`);
        }
        const object: RawObject = { type: row.type, data };
        this.#objects.set(this.#objectCacheKey(row.oid), object);
        result.set(row.oid, object);
      }
      return result;
    } finally {
      reservation.dispose();
      localOutput?.dispose();
      localOperation?.dispose();
    }
  }

  #validateLooseReadOwnership(ownership: PackReadOwnership): void {
    if (
      ownership.operation === ownership.output ||
      ownership.operation.disposed ||
      ownership.output.disposed ||
      !this.#memoryCoordinator.owns(ownership.operation) ||
      !this.#memoryCoordinator.owns(ownership.output)
    ) {
      throw new GitError("EINVAL", "loose object read ownership is invalid");
    }
  }

  // -- refs -----------------------------------------------------------

  /** Raw ref value: an oid, or "ref: <name>" for a symbolic ref. */
  getRef(name: string): string | null {
    const checkedName = requireRefName(name, "ref name", "input", true);
    if (checkedName === "HEAD") return this.head();
    const metadata = this.#db.one<{
      repo_id: unknown;
      name_type: unknown;
      name_bytes: unknown;
      target_type: unknown;
      target_bytes: unknown;
    }>(
      `SELECT repo_id, typeof(name) AS name_type,
              length(CAST(name AS BLOB)) AS name_bytes,
              typeof(target) AS target_type,
              length(CAST(target AS BLOB)) AS target_bytes
         FROM git_refs WHERE repo_id = ? AND name = ?`,
      this.#repoId,
      checkedName,
    );
    if (metadata === undefined) return null;
    if (
      metadata.repo_id !== this.#repoId ||
      metadata.name_type !== "text" ||
      typeof metadata.name_bytes !== "number" ||
      !Number.isSafeInteger(metadata.name_bytes) ||
      metadata.name_bytes < 1 ||
      metadata.target_type !== "text" ||
      typeof metadata.target_bytes !== "number" ||
      !Number.isSafeInteger(metadata.target_bytes) ||
      metadata.target_bytes < 1
    ) {
      throw new CorruptError(`stored target of ${checkedName} has invalid text metadata`);
    }
    const reservation = this.#sharedStore.reserveMemory();
    try {
      reservation.set(
        "other",
        256 +
          metadata.name_bytes +
          metadata.target_bytes +
          retainedStringUnits(metadata.name_bytes) +
          retainedStringUnits(metadata.target_bytes),
      );
      const row = this.#db.one<Record<string, unknown>>(
        `SELECT repo_id, typeof(name) AS name_type,
                length(CAST(name AS BLOB)) AS name_bytes,
                CAST(name AS BLOB) AS name_blob,
                typeof(target) AS target_type,
                length(CAST(target AS BLOB)) AS target_bytes,
                CAST(target AS BLOB) AS target_blob
           FROM git_refs WHERE repo_id = ? AND name = ?`,
        this.#repoId,
        checkedName,
      );
      if (
        row === undefined ||
        row.repo_id !== this.#repoId ||
        row.name_type !== "text" ||
        row.name_bytes !== metadata.name_bytes ||
        row.target_type !== "text" ||
        row.target_bytes !== metadata.target_bytes
      ) {
        throw new CorruptError(`stored ref ${checkedName} changed after validation`);
      }
      const storedName = requireRefName(
        decodeCanonicalStoredText(row.name_blob, "stored ref name"),
        "stored ref name",
        "stored",
      );
      if (storedName !== checkedName) {
        throw new CorruptError(`stored ref ${checkedName} crossed a ref boundary`);
      }
      const checked = requireRawRefTarget(
        decodeCanonicalStoredText(row.target_blob, `stored target of ${checkedName}`),
        `stored target of ${checkedName}`,
        "stored",
      );
      reservation.set(
        "other",
        256 +
          metadata.name_bytes +
          metadata.target_bytes +
          retainedStringBytes(storedName) +
          retainedStringBytes(checked),
      );
      return checked;
    } finally {
      reservation.dispose();
    }
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
    const metadata = this.#db.one<{
      ref_name_type: unknown;
      ref_name_bytes: unknown;
    }>(
      `SELECT typeof(ref_name) AS ref_name_type,
              length(CAST(ref_name AS BLOB)) AS ref_name_bytes
         FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND ref_name = ?`,
      this.#repoId,
      refName,
    );
    if (metadata === undefined) return null;
    if (
      metadata.ref_name_type !== "text" ||
      typeof metadata.ref_name_bytes !== "number" ||
      !Number.isSafeInteger(metadata.ref_name_bytes) ||
      metadata.ref_name_bytes < 1
    ) {
      throw new CorruptError("stored tracking revision ref metadata is invalid");
    }
    const reservation = this.#sharedStore.reserveMemory();
    try {
      reservation.set(
        "other",
        256 + metadata.ref_name_bytes + retainedStringUnits(metadata.ref_name_bytes),
      );
      const row = this.#db.one<Record<string, unknown>>(
        `SELECT repo_id, typeof(ref_name) AS ref_name_type,
                length(CAST(ref_name AS BLOB)) AS ref_name_bytes,
                CAST(ref_name AS BLOB) AS ref_name_blob, revision
           FROM git_tracking_ref_revisions
          WHERE repo_id = ? AND ref_name = ?`,
        this.#repoId,
        refName,
      );
      if (
        row === undefined ||
        row.repo_id !== this.#repoId ||
        row.ref_name_type !== "text" ||
        row.ref_name_bytes !== metadata.ref_name_bytes
      ) {
        throw new CorruptError("tracking revision changed after metadata preflight");
      }
      const storedName = requireRefName(
        decodeCanonicalStoredText(row.ref_name_blob, "stored tracking revision ref"),
        "stored tracking revision ref",
        "stored",
      );
      if (storedName !== refName) {
        throw new CorruptError("tracking revision crossed repository or ref boundaries");
      }
      return requireFetchGeneration(row.revision, "stored tracking ref revision", 0);
    } finally {
      reservation.dispose();
    }
  }

  #trackingRefRevisionCount(): number {
    const row = this.#db.one<{ repo_id: unknown; revision_rows: unknown }>(
      `SELECT id AS repo_id,
              (SELECT count(*) FROM (
                 SELECT 1 FROM git_tracking_ref_revisions
                  WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
               )) AS revision_rows
         FROM git_repositories WHERE id = ?`,
      this.#repoId,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("tracking repository is missing");
    if (requireSafeId(row.repo_id, "tracking repository id") !== this.#repoId) {
      throw new CorruptError("tracking revision count crossed repository boundaries");
    }
    const count = row.revision_rows;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_TRACKING_REF_REVISIONS
    ) {
      throw new CorruptError("tracking revision count is invalid");
    }
    return count;
  }

  #ensureTrackingRefRevision(refName: string): number {
    const count = this.#trackingRefRevisionCount();
    const existing = this.#readTrackingRefRevision(refName);
    if (existing !== null) return existing;
    if (count === MAX_TRACKING_REF_REVISIONS) {
      throw new GitError("E2BIG", "repository tracking revision count exceeds 100,000");
    }
    this.#db.run(
      "INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision) VALUES (?, ?, 0)",
      this.#repoId,
      refName,
    );
    const created = this.#readTrackingRefRevision(refName);
    if (created !== 0) throw new CorruptError("tracking revision creation failed");
    return created;
  }

  #advanceTrackingRefObservations(trackingPrefix: string, count: number): void {
    if (count === 0) return;
    const metadata = this.#db.one<{ rows: unknown; ref_name_bytes: unknown }>(
      `SELECT count(*) AS rows,
              coalesce(max(length(CAST(ref_name AS BLOB))), 0) AS ref_name_bytes
         FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?`,
      this.#repoId,
      trackingPrefix,
      trackingPrefix,
    );
    if (
      metadata === undefined ||
      typeof metadata.rows !== "number" ||
      !Number.isSafeInteger(metadata.rows) ||
      metadata.rows < 0 ||
      metadata.rows > count ||
      typeof metadata.ref_name_bytes !== "number" ||
      !Number.isSafeInteger(metadata.ref_name_bytes) ||
      metadata.ref_name_bytes < 0
    ) {
      throw new CorruptError("tracking observation metadata is invalid");
    }
    const reservation = this.#sharedStore.reserveMemory();
    let matched = 0;
    let previousNameBytes: Uint8Array | null = null;
    try {
      reservation.set(
        "other",
        256 + 2 * metadata.ref_name_bytes + retainedStringUnits(metadata.ref_name_bytes),
      );
      for (const row of this.#db.iterate(
        `SELECT repo_id, typeof(ref_name) AS ref_name_type,
                CAST(ref_name AS BLOB) AS ref_name_blob, revision
           FROM git_tracking_ref_revisions
          WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?
          ORDER BY ref_name`,
        this.#repoId,
        trackingPrefix,
        trackingPrefix,
      )) {
        const nameBytes = requireStoredTextBytes(
          row.ref_name_type,
          row.ref_name_blob,
          "stored tracking revision ref",
        );
        const name = requireRefName(
          decodeCanonicalText(nameBytes, "stored tracking revision ref"),
          "stored tracking revision ref",
          "stored",
        );
        if (
          row.repo_id !== this.#repoId ||
          !name.startsWith(trackingPrefix) ||
          (previousNameBytes !== null && compareByteArrays(previousNameBytes, nameBytes) >= 0)
        ) {
          throw new CorruptError("tracking observation scan crossed or reordered repositories");
        }
        previousNameBytes = nameBytes;
        matched++;
        if (matched > metadata.rows) {
          throw new CorruptError("tracking observation count is invalid");
        }
        const revision = requireFetchGeneration(row.revision, "stored tracking ref revision", 0);
        if (revision === Number.MAX_SAFE_INTEGER) {
          throw new GitError("E2BIG", "tracking ref revision is exhausted");
        }
      }
      if (matched !== metadata.rows) {
        throw new CorruptError("tracking observation changed after metadata preflight");
      }
    } finally {
      reservation.dispose();
    }
    if (matched === 0) return;
    this.#db.run(
      `UPDATE git_tracking_ref_revisions SET revision = revision + 1
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?`,
      this.#repoId,
      trackingPrefix,
      trackingPrefix,
    );
  }

  #bumpTrackingRefRevisions(changedNames: ReadonlySet<string>, budget: RefMutationBudget): void {
    if (changedNames.size === 0) return;
    const affected: string[] = [];
    for (const page of jsonPages(changedNames, "tracking ref revision lookup", {
      reservation: budget.memoryReservation(),
      maxUnits: jsonStringMaxUnits,
    })) {
      const metadata = this.#db.one<{ max_ref_name_bytes: unknown }>(
        `SELECT coalesce(max(length(CAST(ref_name AS BLOB))), 0) AS max_ref_name_bytes
           FROM git_tracking_ref_revisions
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))`,
        this.#repoId,
        page,
      );
      const maxRefNameBytes = requireMaximumStoredTextBytes(
        metadata?.max_ref_name_bytes,
        "tracking revision scan",
      );
      const rowMemory = budget.memoryReservation().scope();
      rowMemory.set(
        "other",
        maxRefNameBytes === 0 ? 0 : currentTextRowRetainedBytes(maxRefNameBytes),
      );
      let observedMaxRefNameBytes = 0;
      try {
        for (const row of this.#db.iterate(
          `SELECT repo_id, typeof(ref_name) AS ref_name_type,
                  length(CAST(ref_name AS BLOB)) AS ref_name_bytes,
                  CAST(ref_name AS BLOB) AS ref_name_blob, revision
             FROM git_tracking_ref_revisions
            WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))
            ORDER BY ref_name`,
          this.#repoId,
          page,
        )) {
          if (row.repo_id !== this.#repoId) {
            throw new CorruptError("tracking revision scan crossed repository boundaries");
          }
          const nameByteLength = requireStoredTextByteLength(
            row.ref_name_type,
            row.ref_name_bytes,
            "stored tracking revision ref",
          );
          if (nameByteLength > maxRefNameBytes) {
            throw new CorruptError("tracking revision scan changed after metadata preflight");
          }
          const nameBytes = requireStoredTextBytes(
            row.ref_name_type,
            row.ref_name_blob,
            "stored tracking revision ref",
          );
          if (nameBytes.byteLength !== nameByteLength) {
            throw new CorruptError("stored tracking revision ref changed after validation");
          }
          const name = requireRefName(
            decodeCanonicalText(nameBytes, "stored tracking revision ref"),
            "stored tracking revision ref",
            "stored",
          );
          if (!changedNames.has(name)) {
            throw new CorruptError("tracking revision scan crossed ref boundaries");
          }
          const revision = requireFetchGeneration(row.revision, "stored tracking ref revision", 0);
          if (revision === Number.MAX_SAFE_INTEGER) {
            throw new GitError("E2BIG", "tracking ref revision is exhausted");
          }
          observedMaxRefNameBytes = Math.max(observedMaxRefNameBytes, nameByteLength);
          budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + retainedStringBytes(name));
          affected.push(name);
        }
        if (observedMaxRefNameBytes !== maxRefNameBytes) {
          throw new CorruptError("tracking revision scan changed after metadata preflight");
        }
      } finally {
        rowMemory.dispose();
      }
    }
    for (const page of jsonPages(affected, "tracking ref revision update", {
      reservation: budget.memoryReservation(),
      maxUnits: jsonStringMaxUnits,
    })) {
      this.#db.run(
        `UPDATE git_tracking_ref_revisions SET revision = revision + 1
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))`,
        this.#repoId,
        page,
      );
    }
  }

  /** Snapshot one exact tracking ref after every earlier fetch observation. */
  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    const reservation = this.#sharedStore.reserveMemory();
    try {
      const budget = new RefMutationBudget(reservation, true);
      const prefix = requireFetchTrackingPrefix(trackingPrefix, "input");
      const name = requireRefName(refName, "tracking publication ref", "input");
      budget.charge(
        REF_MUTATION_ITEM_RETAINED_BYTES + retainedStringBytes(prefix) + retainedStringBytes(name),
      );
      if (
        !name.startsWith(prefix) ||
        (name.length === prefix.length + 4 && name.endsWith("HEAD"))
      ) {
        throw new GitError("EINVAL", "tracking publication ref is outside its branch namespace");
      }
      const snapshot = this.#db.transactionSync(() => {
        const refRevision = this.#ensureTrackingRefRevision(name);
        const targetMetadata = this.#db.one<{ target_type: unknown; target_bytes: unknown }>(
          `SELECT typeof(target) AS target_type,
                  length(CAST(target AS BLOB)) AS target_bytes
             FROM git_refs WHERE repo_id = ? AND name = ?`,
          this.#repoId,
          name,
        );
        const targetMemory = reservation.scope();
        if (targetMetadata !== undefined) {
          if (
            targetMetadata.target_type !== "text" ||
            typeof targetMetadata.target_bytes !== "number" ||
            !Number.isSafeInteger(targetMetadata.target_bytes) ||
            targetMetadata.target_bytes < 1
          ) {
            throw new CorruptError("tracking publication target metadata is invalid");
          }
          targetMemory.set("other", currentTextRowRetainedBytes(targetMetadata.target_bytes));
        }
        let target: string | null;
        try {
          const row = this.#db.one<Record<string, unknown>>(
            `SELECT typeof(target) AS target_type,
                    length(CAST(target AS BLOB)) AS target_bytes,
                    CAST(target AS BLOB) AS target_blob
               FROM git_refs WHERE repo_id = ? AND name = ?`,
            this.#repoId,
            name,
          );
          target =
            row === undefined
              ? null
              : requireRawRefTarget(
                  requireCanonicalStoredText(
                    row.target_type,
                    row.target_blob,
                    "stored tracking target",
                  ),
                  "stored tracking target",
                  "stored",
                );
          if (
            row !== undefined &&
            (row.target_type !== "text" || row.target_bytes !== targetMetadata?.target_bytes)
          ) {
            throw new CorruptError("tracking publication target changed after metadata preflight");
          }
          targetMemory.clear("other");
          if (target !== null) budget.charge(retainedStringBytes(target));
        } finally {
          targetMemory.dispose();
        }
        const state: TrackingRefPublicationState = {
          refName: name,
          target,
          refRevision,
          budget,
          reservation,
          disposed: false,
        };
        return state;
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
          snapshot.reservation.dispose();
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
    } catch (error) {
      reservation.dispose();
      throw error;
    }
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
    const publicationReservation = state.reservation.scope();
    try {
      const budget = new RefMutationBudget(publicationReservation);
      const normalized = normalizeRefMutation(
        {
          puts: target === null ? [] : [{ name: state.refName, target }],
          deletes: target === null ? [state.refName] : [],
          expected: { name: state.refName, target: state.target },
        },
        budget,
      );
      const checkedMetadata = validateRefLogMetadata(metadata);
      budget.charge(refLogMetadataRetainedBytes(checkedMetadata));
      const changed = this.#db.transactionSync(() => {
        const refRevision = this.#readTrackingRefRevision(state.refName);
        if (refRevision !== state.refRevision) {
          throw staleFetch("the tracking ref changed after observation");
        }
        const refChanged = this.#mutateRefs(normalized, checkedMetadata);
        if (!refChanged) {
          this.#bumpTrackingRefRevisions(new Set([state.refName]), budget);
          this.#bumpFetchNamespaceRevisions(new Set([state.refName]), budget);
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
    } finally {
      publicationReservation.dispose();
    }
  }

  /** Fence one remote-tracking namespace and retain its exact publication snapshot. */
  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
    owningReservation?: MemoryReservation,
    owner?: RefMutationMemoryOwner,
  ): FetchPublicationToken {
    if (owner !== undefined) {
      validateRefMutationMemoryOwner(this.#sharedStore, owner, "fetch publication");
    }
    if (owningReservation !== undefined) {
      if (owningReservation.disposed) {
        throw new GitError("EINVAL", "fetch publication reservation is disposed");
      }
      if (!this.#sharedStore.ownsMemoryReservation(owningReservation)) {
        throw new GitError("EINVAL", "fetch publication reservation belongs to another repository");
      }
    }
    const reservation = owningReservation?.scope() ?? this.#sharedStore.reserveMemory();
    const budget = (() => {
      try {
        return new RefMutationBudget(reservation, true);
      } catch (error) {
        reservation.dispose();
        throw error;
      }
    })();
    try {
      const prefix = requireFetchTrackingPrefix(trackingPrefix, "input");
      budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + retainedStringBytes(prefix));
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
        budget.charge(
          REF_MUTATION_ITEM_RETAINED_BYTES +
            (owner?.owns(name) === true ? 0 : retainedStringBytes(name)),
        );
        candidates.set(name, null);
      }

      const snapshot = this.#db.transactionSync(() => {
        const repository = this.#db.one<{
          repo_id: unknown;
          fetch_generation: unknown;
          shallow_revision: unknown;
          checkout_revision: unknown;
          tracking_ref_revision_rows: unknown;
        }>(
          `SELECT id AS repo_id, fetch_generation, shallow_revision, checkout_revision,
                  (SELECT count(*) FROM (
                     SELECT 1 FROM git_tracking_ref_revisions
                      WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
                   )) AS tracking_ref_revision_rows
             FROM git_repositories WHERE id = ?`,
          this.#repoId,
          this.#repoId,
        );
        if (repository === undefined) throw new CorruptError("fetch repository is missing");
        if (requireSafeId(repository.repo_id, "fetch repository id") !== this.#repoId) {
          throw new CorruptError("fetch generation crossed repository boundaries");
        }
        const currentGeneration = requireFetchGeneration(
          repository.fetch_generation,
          "stored fetch generation",
          0,
        );
        const shallowRevision = requireFetchGeneration(
          repository.shallow_revision,
          "stored shallow revision",
          0,
        );
        const checkoutRevision = requireFetchGeneration(
          repository.checkout_revision,
          "stored checkout revision",
          0,
        );
        if (currentGeneration === Number.MAX_SAFE_INTEGER) {
          throw new GitError("E2BIG", "fetch publication generation is exhausted");
        }
        const trackingRefRevisionCount = requireFetchGeneration(
          repository.tracking_ref_revision_rows,
          "stored tracking ref revision count",
          0,
        );
        if (trackingRefRevisionCount > MAX_TRACKING_REF_REVISIONS) {
          throw new CorruptError("tracking ref revision count exceeds its bound");
        }

        this.#advanceTrackingRefObservations(prefix, trackingRefRevisionCount);

        const namespaces = this.#readFetchNamespaces(budget);
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
        for (const { name, target } of this.#iterateStoredRefs(
          budget.memoryReservation(),
          "fetch ref snapshot",
        )) {
          rows++;
          if (rows > MAX_REFLOG_STATE_ROWS) {
            throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
          }
          if (name.startsWith(prefix)) {
            if (candidateInputs + tracking.size >= MAX_FETCH_PUBLICATION_INPUTS) {
              throw new GitError("E2BIG", "fetch snapshot exceeds its retained input count bound");
            }
            budget.charge(
              REF_MUTATION_ITEM_RETAINED_BYTES +
                retainedStringBytes(name) +
                retainedStringBytes(target),
            );
            tracking.set(name, target);
            trackingRows.push(Object.freeze({ name, target }));
          }
          if (candidates.has(name)) {
            if (!isOid(target)) {
              throw new GitError("EINVAL", `fetch exact ref candidate ${name} is symbolic`);
            }
            candidates.set(name, target);
            budget.charge(retainedStringBytes(target));
          }
        }

        const shallowRows: string[] = [];
        let previousShallow: string | null = null;
        for (const row of this.#db.iterate(
          "SELECT repo_id, oid FROM git_shallow WHERE repo_id = ? ORDER BY oid",
          this.#repoId,
        )) {
          if (row.repo_id !== this.#repoId || typeof row.oid !== "string" || !isOid(row.oid)) {
            throw new CorruptError("fetch shallow snapshot contains an invalid row");
          }
          if (previousShallow !== null && comparePaths(previousShallow, row.oid) >= 0) {
            throw new CorruptError("stored shallow boundaries are not in strict object-id order");
          }
          previousShallow = row.oid;
          if (
            candidateInputs + tracking.size + shallowRows.length >=
            MAX_FETCH_PUBLICATION_INPUTS
          ) {
            throw new GitError("E2BIG", "fetch snapshot exceeds its retained input count bound");
          }
          budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + retainedStringBytes(row.oid));
          shallowRows.push(row.oid);
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
        for (const page of jsonPages(overlapping, "overlapping fetch namespace", {
          reservation: budget.memoryReservation(),
          maxUnits: jsonStringMaxUnits,
        })) {
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
          budget,
          reservation,
          owner,
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
        () =>
          snapshot.state.disposed ||
          snapshot.state.reservation.disposed ||
          snapshot.state.owner?.memoryReservation().disposed === true,
        () => {
          if (snapshot.state.disposed) return;
          snapshot.state.disposed = true;
          snapshot.state.reservation.dispose();
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
    } catch (error) {
      reservation.dispose();
      throw error;
    }
  }

  /** Publish a fetch snapshot atomically, or reject it after any conflicting observation. */
  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
    owner?: RefMutationMemoryOwner,
  ): boolean {
    if (!this.#issuedFetchPublications.has(token)) {
      throw staleFetch("fetch publication token was not issued by this repository");
    }
    const state = this.#fetchPublicationStates.get(token);
    if (state === undefined || state.disposed || state.reservation.disposed) {
      throw staleFetch("fetch publication token is no longer active");
    }
    if (state.owner?.memoryReservation().disposed === true) {
      throw staleFetch("fetch publication memory owner is no longer active");
    }
    if (owner !== state.owner) {
      throw new GitError("EINVAL", "fetch publication requires its issued memory owner");
    }
    const ownerReservation =
      owner === undefined
        ? undefined
        : validateRefMutationMemoryOwner(this.#sharedStore, owner, "fetch publication");
    const publicationReservation =
      ownerReservation === undefined ? state.reservation.scope() : ownerReservation.scope();
    try {
      const budget = new RefMutationBudget(publicationReservation);
      const normalized = normalizeFetchPublication(state, plan, budget, owner);
      const checkedMetadata = validateRefLogMetadata(metadata);
      budget.charge(refLogMetadataRetainedBytes(checkedMetadata));
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
        if (shallowTouched) this.#advanceShallowRevision(state.shallowRevision);
        if (shallowTouched && !changed) bumpMaintenanceRootEpoch(this.#db, this.#repoId);
        return changed;
      });
      if (shallowTouched) this.shared.invalidateShallow();
      this.#issuedFetchPublications.delete(token);
      this.#fetchPublicationStates.delete(token);
      return refChanged || shallowTouched;
    } finally {
      publicationReservation.dispose();
    }
  }

  #readFetchNamespaces(budget: RefMutationBudget): {
    trackingPrefix: string;
    latestGeneration: number;
    revision: number;
  }[] {
    const namespaces: {
      trackingPrefix: string;
      latestGeneration: number;
      revision: number;
    }[] = [];
    const metadata = this.#db.one<{ rows: unknown; tracking_prefix_bytes: unknown }>(
      `SELECT count(*) AS rows,
              coalesce(max(length(CAST(tracking_prefix AS BLOB))), 0) AS tracking_prefix_bytes
         FROM git_fetch_namespaces WHERE repo_id = ?`,
      this.#repoId,
    );
    if (
      metadata === undefined ||
      typeof metadata.rows !== "number" ||
      !Number.isSafeInteger(metadata.rows) ||
      metadata.rows < 0 ||
      typeof metadata.tracking_prefix_bytes !== "number" ||
      !Number.isSafeInteger(metadata.tracking_prefix_bytes) ||
      metadata.tracking_prefix_bytes < 0
    ) {
      throw new CorruptError("fetch namespace metadata is invalid");
    }
    if (metadata.rows > MAX_FETCH_NAMESPACES) {
      throw new GitError("E2BIG", "repository fetch namespace count exceeds 1,024");
    }
    const rowMemory = budget.memoryReservation().scope();
    rowMemory.set(
      "other",
      256 + metadata.tracking_prefix_bytes + retainedStringUnits(metadata.tracking_prefix_bytes),
    );
    let previousPrefix: string | null = null;
    try {
      for (const row of this.#db.iterate(
        `SELECT repo_id, typeof(tracking_prefix) AS tracking_prefix_type,
                CAST(tracking_prefix AS BLOB) AS tracking_prefix_blob,
                latest_generation, revision
           FROM git_fetch_namespaces WHERE repo_id = ? ORDER BY tracking_prefix
           LIMIT ${MAX_FETCH_NAMESPACES + 1}`,
        this.#repoId,
      )) {
        if (row.repo_id !== this.#repoId) {
          throw new CorruptError("fetch namespace scan crossed repository boundaries");
        }
        const storedPrefix = requireFetchTrackingPrefix(
          requireCanonicalStoredText(
            row.tracking_prefix_type,
            row.tracking_prefix_blob,
            "stored fetch tracking prefix",
          ),
          "stored",
        );
        if (previousPrefix !== null && comparePaths(previousPrefix, storedPrefix) >= 0) {
          throw new CorruptError("fetch namespaces are not in strict Git byte order");
        }
        previousPrefix = storedPrefix;
        budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + retainedStringBytes(storedPrefix));
        namespaces.push({
          trackingPrefix: storedPrefix,
          latestGeneration: requireFetchGeneration(
            row.latest_generation,
            "stored fetch namespace generation",
            1,
          ),
          revision: requireFetchGeneration(row.revision, "stored fetch namespace revision", 0),
        });
        if (namespaces.length > metadata.rows) {
          throw new CorruptError("fetch namespace count changed after metadata preflight");
        }
      }
      if (namespaces.length !== metadata.rows) {
        throw new CorruptError("fetch namespaces changed after metadata preflight");
      }
    } finally {
      rowMemory.dispose();
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
      const repository = this.#db.one<{ repo_id: unknown; checkout_revision: unknown }>(
        "SELECT id AS repo_id, checkout_revision FROM git_repositories WHERE id = ?",
        this.#repoId,
      );
      if (repository === undefined) {
        throw new CorruptError("fetch checkout revision repository is missing");
      }
      if (
        requireSafeId(repository.repo_id, "fetch checkout revision repository id") !== this.#repoId
      ) {
        throw new CorruptError("fetch checkout revision crossed repository boundaries");
      }
      const checkoutRevision = requireFetchGeneration(
        repository.checkout_revision,
        "stored checkout revision",
        0,
      );
      if (checkoutRevision !== state.checkoutRevision) {
        throw staleFetch("the repository checkout state changed after fetch preflight");
      }
      const checkoutMetadata = this.#db.one<{
        max_root_bytes: unknown;
        max_head_bytes: unknown;
      }>(
        `SELECT coalesce(max(length(CAST(root AS BLOB))), 0) AS max_root_bytes,
                coalesce(max(length(CAST(head AS BLOB))), 0) AS max_head_bytes
           FROM git_checkouts WHERE repo_id = ?`,
        this.#repoId,
      );
      if (checkoutMetadata === undefined) {
        throw new CorruptError("fetch checkout text metadata row is missing");
      }
      const maxRootBytes = requireMaximumStoredTextBytes(
        checkoutMetadata.max_root_bytes,
        "fetch checkout root maximum",
      );
      const maxHeadBytes = requireMaximumStoredTextBytes(
        checkoutMetadata.max_head_bytes,
        "fetch checkout HEAD maximum",
      );
      const checkoutRowMemory = state.budget.memoryReservation().scope();
      checkoutRowMemory.set("other", currentTextRowRetainedBytes(maxRootBytes + maxHeadBytes, 2));
      let checkoutRows = 0;
      let previousCheckoutId = 0;
      try {
        for (const row of this.#db.iterate(
          `SELECT id AS checkout_id, repo_id, root, typeof(root) AS root_type,
                  length(CAST(root AS BLOB)) AS root_bytes, typeof(head) AS head_type,
                  length(CAST(head AS BLOB)) AS head_bytes,
                  CAST(head AS BLOB) AS head_blob, is_primary
             FROM git_checkouts WHERE repo_id = ? ORDER BY id
             LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
          this.#repoId,
        )) {
          const checkout = requireStoredCheckoutRow(row, maxRootBytes, maxHeadBytes);
          if (checkout.repoId !== this.#repoId || checkout.id <= previousCheckoutId) {
            throw new CorruptError("fetch checkout scan crossed or reordered repositories");
          }
          previousCheckoutId = checkout.id;
          checkoutRows++;
          if (checkoutRows > MAX_CHECKOUTS_PER_REPOSITORY) {
            throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
          }
          const attached = rawSymbolicTarget(checkout.head);
          if (attached !== null && selectedBranches.has(attached)) {
            throw staleFetch(`branch ${attached} became attached after fetch preflight`);
          }
        }
      } finally {
        checkoutRowMemory.dispose();
      }
    }
    const presentExactRefs = new Set<string>();
    let rows = 0;
    let trackingRows = 0;
    for (const { name, target } of this.#iterateStoredRefs(
      state.budget.memoryReservation(),
      "fetch publication preflight",
    )) {
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

  #advanceShallowRevision(expected: number): void {
    if (expected === Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "shallow revision is exhausted");
    }
    const updated = this.#db.one<{ shallow_revision: unknown }>(
      `UPDATE git_repositories SET shallow_revision = shallow_revision + 1
        WHERE id = ? AND shallow_revision = ?
        RETURNING shallow_revision`,
      this.#repoId,
      expected,
    );
    if (
      updated === undefined ||
      requireFetchGeneration(updated.shallow_revision, "updated shallow revision", 1) !==
        expected + 1
    ) {
      const current = this.#db.scalar<unknown>(
        "SELECT shallow_revision FROM git_repositories WHERE id = ?",
        this.#repoId,
      );
      requireFetchGeneration(current, "stored shallow revision", 0);
      throw new CorruptError("shallow revision changed during synchronous publication");
    }
  }

  #bumpFetchNamespaceRevisions(changedNames: ReadonlySet<string>, budget: RefMutationBudget): void {
    if (changedNames.size === 0) return;
    const affected: string[] = [];
    for (const namespace of this.#readFetchNamespaces(budget)) {
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
    for (const page of jsonPages(affected, "fetch namespace revision", {
      reservation: budget.memoryReservation(),
      maxUnits: jsonStringMaxUnits,
    })) {
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

  #mutateRefsOwned(
    mutation: RefMutation,
    metadata: RefLogMetadata,
    owner?: RefMutationMemoryOwner,
  ): boolean {
    if (owner !== undefined && !(owner instanceof RefMutationMemoryOwner)) {
      throw new GitError("EINVAL", "ref mutation memory owner was not issued by the store");
    }
    const reservation =
      owner === undefined
        ? this.#sharedStore.reserveMemory()
        : this.#sharedStore.scopeMemoryReservation(owner.memoryReservation());
    try {
      const budget = new RefMutationBudget(reservation);
      const normalized = normalizeRefMutation(mutation, budget, owner);
      const checkedMetadata = validateRefLogMetadata(metadata);
      budget.charge(refLogMetadataRetainedBytes(checkedMetadata, owner));
      return this.#mutateRefs(normalized, checkedMetadata);
    } finally {
      reservation.dispose();
    }
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
      let previousCheckoutId = 0;
      const checkoutMetadata = this.#db.one<{
        max_root_bytes: unknown;
        max_head_bytes: unknown;
      }>(
        `SELECT coalesce(max(length(CAST(root AS BLOB))), 0) AS max_root_bytes,
                coalesce(max(length(CAST(head AS BLOB))), 0) AS max_head_bytes
           FROM git_checkouts WHERE repo_id = ?`,
        this.#repoId,
      );
      if (checkoutMetadata === undefined) {
        throw new CorruptError("ref mutation checkout text metadata row is missing");
      }
      const maxCheckoutRootBytes = requireMaximumStoredTextBytes(
        checkoutMetadata.max_root_bytes,
        "ref mutation checkout root maximum",
      );
      const maxCheckoutHeadBytes = requireMaximumStoredTextBytes(
        checkoutMetadata.max_head_bytes,
        "ref mutation checkout HEAD maximum",
      );
      const checkoutRowMemory = normalized.budget.memoryReservation().scope();
      checkoutRowMemory.set(
        "other",
        currentTextRowRetainedBytes(maxCheckoutRootBytes + maxCheckoutHeadBytes, 2),
      );
      try {
        for (const raw of this.#db.iterate(
          `SELECT id AS checkout_id, repo_id, root, typeof(root) AS root_type,
                  length(CAST(root AS BLOB)) AS root_bytes, typeof(head) AS head_type,
                  length(CAST(head AS BLOB)) AS head_bytes,
                  CAST(head AS BLOB) AS head_blob, is_primary
             FROM git_checkouts WHERE repo_id = ? ORDER BY id
             LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
          this.#repoId,
        )) {
          const checkout = requireStoredCheckoutRow(
            raw,
            maxCheckoutRootBytes,
            maxCheckoutHeadBytes,
          );
          if (checkout.repoId !== this.#repoId || checkout.id <= previousCheckoutId) {
            throw new CorruptError("reflog checkout scan crossed or reordered repositories");
          }
          previousCheckoutId = checkout.id;
          normalized.budget.charge(refMutationCheckoutRetainedBytes(checkout));
          checkouts.push(checkout);
          if (checkout.id === this.#checkoutId) selected = checkout;
          if (checkouts.length > MAX_CHECKOUTS_PER_REPOSITORY) {
            throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
          }
        }
      } finally {
        checkoutRowMemory.dispose();
      }
      if (selected === null)
        throw new CorruptError("selected checkout disappeared during ref mutation");
      const oldHead = selected.head;

      const before = new Map<string, string>();
      let rows = 0;
      for (const { name, target } of this.#iterateStoredRefs(
        normalized.budget.memoryReservation(),
        "ref state query",
      )) {
        rows++;
        if (rows > MAX_REFLOG_STATE_ROWS) {
          throw new GitError("E2BIG", "repository ref state exceeds its structural row bound");
        }
        normalized.budget.charge(
          REF_ROW_RETAINED_BYTES + retainedStringBytes(name) + retainedStringBytes(target),
        );
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
        const metadata = this.#db.one<{
          root_type: unknown;
          root_bytes: unknown;
          head_type: unknown;
          head_bytes: unknown;
        }>(
          `SELECT typeof(root) AS root_type,
                  length(CAST(root AS BLOB)) AS root_bytes,
                  typeof(head) AS head_type,
                  length(CAST(head AS BLOB)) AS head_bytes
             FROM git_checkouts
            WHERE repo_id = ? AND head = ? AND id != ?
            LIMIT 1`,
          this.#repoId,
          newHead,
          this.#checkoutId,
        );
        if (metadata === undefined) return null;
        const rootBytes = requireStoredTextByteLength(
          metadata.root_type,
          metadata.root_bytes,
          "attached checkout root",
        );
        const headBytes = requireStoredTextByteLength(
          metadata.head_type,
          metadata.head_bytes,
          "attached checkout HEAD",
        );
        const ownerMemory = normalized.budget.memoryReservation().scope();
        ownerMemory.set("other", currentTextRowRetainedBytes(rootBytes + headBytes, 2));
        try {
          const owner = this.#db.one<Record<string, unknown>>(
            `SELECT id AS checkout_id, repo_id, root, typeof(root) AS root_type,
                    length(CAST(root AS BLOB)) AS root_bytes, typeof(head) AS head_type,
                    length(CAST(head AS BLOB)) AS head_bytes,
                    CAST(head AS BLOB) AS head_blob, is_primary
               FROM git_checkouts
              WHERE repo_id = ? AND head = ? AND id != ?
              LIMIT 1`,
            this.#repoId,
            newHead,
            this.#checkoutId,
          );
          if (owner === undefined) {
            throw new CorruptError("attached checkout changed after metadata preflight");
          }
          const checkedOwner = requireStoredCheckoutRow(owner, rootBytes, headBytes);
          if (checkedOwner.repoId !== this.#repoId || checkedOwner.head !== newHead) {
            throw new CorruptError("attached branch ownership crossed a repository boundary");
          }
          return checkedOwner;
        } finally {
          ownerMemory.dispose();
        }
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
          normalized.budget.charge(refLogEventRetainedBytes(name, oldRaw, newRaw));
          changedNames.add(name);
        }
      }
      for (const name of normalized.puts.keys()) {
        const oldRaw = beforeTarget(name);
        const newRaw = afterTarget(name);
        if (oldRaw !== newRaw && !changedNames.has(name)) {
          normalized.budget.charge(refLogEventRetainedBytes(name, oldRaw, newRaw));
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
          normalized.budget.charge(
            refLogEventRetainedBytes("HEAD", checkout.head, checkoutNewHead),
          );
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
      for (const page of jsonPages(deleted, "ref deletion", {
        reservation: normalized.budget.memoryReservation(),
        maxUnits: jsonStringMaxUnits,
      })) {
        this.#db.run(
          `DELETE FROM git_refs
            WHERE repo_id = ? AND name IN (SELECT value FROM json_each(?))`,
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(put, "ref update", {
        reservation: normalized.budget.memoryReservation(),
        maxUnits: refRowJsonMaxUnits,
      })) {
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
        const updatedRootBytes = utf8ByteLength(this.#root);
        const updatedHeadBytes = refTextBytes(newHead, "updated HEAD target", "input");
        const updatedHeadMemory = normalized.budget.memoryReservation().scope();
        updatedHeadMemory.set(
          "other",
          currentTextRowRetainedBytes(updatedRootBytes + updatedHeadBytes, 2),
        );
        let updated: Record<string, unknown> | undefined;
        try {
          try {
            updated = this.#db.one<Record<string, unknown>>(
              `UPDATE git_checkouts SET head = ?
                WHERE id = ? AND repo_id = ? AND head = ?
                RETURNING id AS checkout_id, repo_id, root, typeof(root) AS root_type,
                          length(CAST(root AS BLOB)) AS root_bytes,
                          typeof(head) AS head_type,
                          length(CAST(head AS BLOB)) AS head_bytes,
                          CAST(head AS BLOB) AS head_blob, is_primary`,
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
          const checked = requireStoredCheckoutRow(updated, updatedRootBytes, updatedHeadBytes);
          if (checked.id !== this.#checkoutId || checked.repoId !== this.#repoId) {
            throw new CorruptError("HEAD update crossed a checkout boundary");
          }
        } finally {
          updatedHeadMemory.dispose();
        }
        advanceCheckoutRevision(this.#db, this.#repoId, 1, checkoutRevision);
      }
      for (const page of jsonPages(events, "reflog entry", {
        reservation: normalized.budget.memoryReservation(),
        maxUnits: refLogEventJsonMaxUnits,
      })) {
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
      for (const page of jsonPages(checkoutEvents, "checkout reflog entry", {
        reservation: normalized.budget.memoryReservation(),
        maxUnits: refLogEventJsonMaxUnits,
      })) {
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
      for (const page of jsonPages(touchedRefs, "reflog retention ref", {
        reservation: normalized.budget.memoryReservation(),
        maxUnits: jsonStringMaxUnits,
      })) {
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
        this.#bumpTrackingRefRevisions(changedNames, normalized.budget);
      }
      if (fetchNamespacePresent) {
        this.#bumpFetchNamespaceRevisions(changedNames, normalized.budget);
      }
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      return true;
    });
  }

  *#iterateStoredRefs(reservation: MemoryReservation, label: string): Generator<RefRow> {
    const metadata = this.#db.one<{
      rows: unknown;
      name_bytes: unknown;
      target_bytes: unknown;
    }>(
      `SELECT count(*) AS rows,
              coalesce(max(length(CAST(name AS BLOB))), 0) AS name_bytes,
              coalesce(max(length(CAST(target AS BLOB))), 0) AS target_bytes
         FROM git_refs WHERE repo_id = ?`,
      this.#repoId,
    );
    const measured = requireRefReadMetadata(metadata, label);
    if (measured.rows > MAX_REFLOG_STATE_ROWS) {
      throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
    }
    const rowMemory = reservation.scope();
    let rows = 0;
    let previousNameBytes: Uint8Array | null = null;
    try {
      rowMemory.set(
        "other",
        256 +
          2 * measured.nameBytes +
          measured.targetBytes +
          retainedStringUnits(measured.nameBytes) +
          retainedStringUnits(measured.targetBytes),
      );
      for (const row of this.#db.iterate(
        `SELECT repo_id, typeof(name) AS name_type, CAST(name AS BLOB) AS name_blob,
                typeof(target) AS target_type, CAST(target AS BLOB) AS target_blob
           FROM git_refs
          WHERE repo_id = ?
          ORDER BY name
          LIMIT ${MAX_REFLOG_STATE_ROWS + 1}`,
        this.#repoId,
      )) {
        if (row.repo_id !== this.#repoId) {
          throw new CorruptError(`${label} crossed repository boundaries`);
        }
        const nameBytes = requireStoredTextBytes(row.name_type, row.name_blob, "stored ref name");
        const name = requireRefName(
          decodeCanonicalText(nameBytes, "stored ref name"),
          "stored ref name",
          "stored",
        );
        const target = requireRawRefTarget(
          requireCanonicalStoredText(row.target_type, row.target_blob, `stored target of ${name}`),
          `stored target of ${name}`,
          "stored",
        );
        if (previousNameBytes !== null && compareByteArrays(previousNameBytes, nameBytes) >= 0) {
          throw new CorruptError("stored refs are not in strict Git byte order");
        }
        rows++;
        if (rows > MAX_REFLOG_STATE_ROWS) {
          throw new GitError("E2BIG", "repository ref state exceeds its retained row bound");
        }
        previousNameBytes = nameBytes;
        yield { name, target };
      }
      if (rows !== measured.rows) {
        throw new CorruptError(`${label} changed after metadata preflight`);
      }
    } finally {
      rowMemory.dispose();
    }
  }

  listRefs(prefix = ""): RefRow[] {
    const reservation = this.#sharedStore.reserveMemory();
    reservation.set("other", 512);
    try {
      let upper: string | undefined;
      if (prefix !== "") {
        reservation.set("other", 512 + retainedStringUnits(prefix.length));
        upper = nextPrefix(prefix);
        reservation.set("other", 512 + retainedStringBytes(upper));
      }
      const metadata = this.#db.one<{
        rows: unknown;
        name_bytes: unknown;
        target_bytes: unknown;
        max_row_bytes: unknown;
      }>(
        prefix === ""
          ? `SELECT count(*) AS rows,
                    coalesce(sum(length(CAST(name AS BLOB))), 0) AS name_bytes,
                    coalesce(sum(length(CAST(target AS BLOB))), 0) AS target_bytes,
                    coalesce(max(
                      length(CAST(name AS BLOB)) + length(CAST(target AS BLOB))
                    ), 0) AS max_row_bytes
               FROM git_refs WHERE repo_id = ?`
          : `SELECT count(*) AS rows,
                    coalesce(sum(length(CAST(name AS BLOB))), 0) AS name_bytes,
                    coalesce(sum(length(CAST(target AS BLOB))), 0) AS target_bytes,
                    coalesce(max(
                      length(CAST(name AS BLOB)) + length(CAST(target AS BLOB))
                    ), 0) AS max_row_bytes
               FROM git_refs WHERE repo_id = ? AND name >= ? AND name < ?`,
        this.#repoId,
        ...(upper === undefined ? [] : [prefix, upper]),
      );
      const measured = requireRefReadMetadata(metadata, "ref list");
      if (measured.rows > MAX_REFLOG_STATE_ROWS) {
        throw new GitError("E2BIG", "repository ref state exceeds 100,000 rows");
      }
      const maxRowBytes = requireMaximumStoredTextBytes(metadata?.max_row_bytes, "ref list row");
      if ((measured.rows === 0) !== (maxRowBytes === 0)) {
        throw new CorruptError("ref list row metadata is inconsistent");
      }
      reservation.set(
        "other",
        512 +
          measured.rows * (REF_ROW_RETAINED_BYTES + 2 * 48 + 8) +
          2 * (measured.nameBytes + measured.targetBytes),
      );
      const rowMemory = reservation.scope();
      rowMemory.set("other", maxRowBytes === 0 ? 0 : currentTextRowRetainedBytes(maxRowBytes, 2));
      const result: RefRow[] = [];
      const sql =
        prefix === ""
          ? `SELECT repo_id, typeof(name) AS name_type,
                    length(CAST(name AS BLOB)) AS name_bytes, CAST(name AS BLOB) AS name_blob,
                    typeof(target) AS target_type,
                    length(CAST(target AS BLOB)) AS target_bytes,
                    CAST(target AS BLOB) AS target_blob
               FROM git_refs WHERE repo_id = ? ORDER BY name`
          : `SELECT repo_id, typeof(name) AS name_type,
                    length(CAST(name AS BLOB)) AS name_bytes, CAST(name AS BLOB) AS name_blob,
                    typeof(target) AS target_type,
                    length(CAST(target AS BLOB)) AS target_bytes,
                    CAST(target AS BLOB) AS target_blob
               FROM git_refs WHERE repo_id = ? AND name >= ? AND name < ? ORDER BY name`;
      let actualNameBytes = 0;
      let actualTargetBytes = 0;
      let previousNameBytes: Uint8Array | null = null;
      try {
        for (const row of this.#db.iterate(
          sql,
          this.#repoId,
          ...(upper === undefined ? [] : [prefix, upper]),
        )) {
          if (row.repo_id !== this.#repoId) {
            throw new CorruptError("ref list crossed repository boundaries");
          }
          const nameByteLength = requireStoredTextByteLength(
            row.name_type,
            row.name_bytes,
            "stored ref name",
          );
          const targetByteLength = requireStoredTextByteLength(
            row.target_type,
            row.target_bytes,
            "stored ref target",
          );
          const currentRowBytes = nameByteLength + targetByteLength;
          if (!Number.isSafeInteger(currentRowBytes) || currentRowBytes > maxRowBytes) {
            throw new CorruptError("ref list row changed after metadata preflight");
          }
          const nameBytes = requireStoredTextBytes(row.name_type, row.name_blob, "stored ref name");
          if (nameBytes.byteLength !== nameByteLength) {
            throw new CorruptError("stored ref name changed after validation");
          }
          if (previousNameBytes !== null && compareByteArrays(previousNameBytes, nameBytes) >= 0) {
            throw new CorruptError("stored refs are not in strict Git byte order");
          }
          const name = requireRefName(
            decodeCanonicalText(nameBytes, "stored ref name"),
            "stored ref name",
            "stored",
          );
          const targetBytes = requireStoredTextBytes(
            row.target_type,
            row.target_blob,
            `stored target of ${name}`,
          );
          if (targetBytes.byteLength !== targetByteLength) {
            throw new CorruptError(`stored target of ${name} changed after validation`);
          }
          const target = requireRawRefTarget(
            decodeCanonicalText(targetBytes, `stored target of ${name}`),
            `stored target of ${name}`,
            "stored",
          );
          actualNameBytes += nameByteLength;
          actualTargetBytes += targetByteLength;
          if (!Number.isSafeInteger(actualNameBytes) || !Number.isSafeInteger(actualTargetBytes)) {
            throw new CorruptError("ref list byte totals are invalid");
          }
          previousNameBytes = nameBytes;
          result.push({ name, target });
        }
        if (
          result.length !== measured.rows ||
          actualNameBytes !== measured.nameBytes ||
          actualTargetBytes !== measured.targetBytes
        ) {
          throw new CorruptError("ref list changed after metadata preflight");
        }
      } finally {
        rowMemory.dispose();
      }
      return result;
    } finally {
      reservation.dispose();
    }
  }

  /** Stream all raw refs without materializing repository ref state. */
  *iterateRefs(): Generator<RefRow> {
    const metadata = this.#db.one<{
      rows: unknown;
      name_bytes: unknown;
      target_bytes: unknown;
    }>(
      `SELECT count(*) AS rows,
              coalesce(max(length(CAST(name AS BLOB))), 0) AS name_bytes,
              coalesce(max(length(CAST(target AS BLOB))), 0) AS target_bytes
         FROM git_refs WHERE repo_id = ?`,
      this.#repoId,
    );
    const measured = requireRefReadMetadata(metadata, "ref iteration");
    if (measured.rows > MAX_REFLOG_STATE_ROWS) {
      throw new GitError("E2BIG", "repository ref state exceeds 100,000 rows");
    }
    const reservation = this.#sharedStore.reserveMemory();
    reservation.set(
      "other",
      2 * REF_ROW_RETAINED_BYTES + 4 * 48 + 4 * (measured.nameBytes + measured.targetBytes),
    );
    try {
      yield* this.#iterateStoredRefs(reservation, "ref iteration");
    } finally {
      reservation.dispose();
    }
  }

  head(): string {
    const metadata = this.#db.one<Record<string, unknown>>(
      `SELECT id AS checkout_id, repo_id, typeof(head) AS head_type,
              length(CAST(head AS BLOB)) AS head_bytes
         FROM git_checkouts WHERE id = ? AND repo_id = ?`,
      this.#checkoutId,
      this.#repoId,
    );
    if (metadata === undefined) throw new CorruptError("checkout HEAD row is missing");
    if (
      metadata.checkout_id !== this.#checkoutId ||
      metadata.repo_id !== this.#repoId ||
      metadata.head_type !== "text" ||
      typeof metadata.head_bytes !== "number" ||
      !Number.isSafeInteger(metadata.head_bytes) ||
      metadata.head_bytes < 1
    ) {
      throw new CorruptError("HEAD read crossed a checkout boundary");
    }
    const reservation = this.#sharedStore.reserveMemory();
    try {
      reservation.set("other", currentTextRowRetainedBytes(metadata.head_bytes));
      const row = this.#db.one<Record<string, unknown>>(
        `SELECT id AS checkout_id, repo_id, typeof(head) AS head_type,
                length(CAST(head AS BLOB)) AS head_bytes,
                CAST(head AS BLOB) AS head_blob
           FROM git_checkouts WHERE id = ? AND repo_id = ?`,
        this.#checkoutId,
        this.#repoId,
      );
      if (
        row === undefined ||
        row.checkout_id !== this.#checkoutId ||
        row.repo_id !== this.#repoId ||
        row.head_type !== "text" ||
        row.head_bytes !== metadata.head_bytes
      ) {
        throw new CorruptError("checkout HEAD changed after validation");
      }
      const checked = requireRawRefTarget(
        decodeCanonicalStoredText(row.head_blob, "stored HEAD target"),
        "stored HEAD target",
        "stored",
      );
      reservation.set("other", 256 + metadata.head_bytes + retainedStringBytes(checked));
      return checked;
    } finally {
      reservation.dispose();
    }
  }

  setHead(value: string): void {
    this.mutateRefs({ head: value }, this.#genericRefLogMetadata("HEAD update"));
  }

  /** Active stored entries for one exact ref, newest first. */
  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    const name = requireRefName(refName, "reflog ref name", "input", true);
    const now = this.#nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_REFLOG_ORDINAL) {
      throw new GitError("EINVAL", "reflog clock must return a safe nonnegative epoch time");
    }
    const limit =
      options.limit === undefined ? REFLOG_RETENTION_ROWS : requireRefLogLimit(options.limit);
    const before =
      options.before === undefined
        ? undefined
        : requireRefLogReadInteger(options.before, "reflog cursor", 1, MAX_REFLOG_ORDINAL);
    const cutoff = Math.max(0, now - REFLOG_RETENTION_SECONDS);
    const metadata = this.#db.one<{
      rows: unknown;
      text_bytes: unknown;
      max_text_bytes: unknown;
      head_bytes: unknown;
    }>(
      name === "HEAD"
        ? `SELECT count(*) AS rows,
                  coalesce(sum(
                    length(CAST('HEAD' AS BLOB)) +
                    coalesce(length(CAST(old_raw AS BLOB)), 0) +
                    coalesce(length(CAST(new_raw AS BLOB)), 0) +
                    coalesce(length(CAST(old_oid AS BLOB)), 0) +
                    coalesce(length(CAST(new_oid AS BLOB)), 0) +
                    coalesce(length(CAST(actor_name AS BLOB)), 0) +
                    coalesce(length(CAST(actor_email AS BLOB)), 0) +
                    length(CAST(reason AS BLOB))
                  ), 0) AS text_bytes,
                  coalesce(max(
                    length(CAST('HEAD' AS BLOB)) +
                    coalesce(length(CAST(old_raw AS BLOB)), 0) +
                    coalesce(length(CAST(new_raw AS BLOB)), 0) +
                    coalesce(length(CAST(old_oid AS BLOB)), 0) +
                    coalesce(length(CAST(new_oid AS BLOB)), 0) +
                    coalesce(length(CAST(actor_name AS BLOB)), 0) +
                    coalesce(length(CAST(actor_email AS BLOB)), 0) +
                    length(CAST(reason AS BLOB))
                  ), 0) AS max_text_bytes,
                  (SELECT length(CAST(head AS BLOB)) FROM git_checkouts
                    WHERE id = ? AND repo_id = ?) AS head_bytes
             FROM git_checkout_reflog_entries
            WHERE repo_id = ? AND checkout_id = ?`
        : `SELECT count(*) AS rows,
                  coalesce(sum(
                    length(CAST(ref_name AS BLOB)) +
                    coalesce(length(CAST(old_raw AS BLOB)), 0) +
                    coalesce(length(CAST(new_raw AS BLOB)), 0) +
                    coalesce(length(CAST(old_oid AS BLOB)), 0) +
                    coalesce(length(CAST(new_oid AS BLOB)), 0) +
                    coalesce(length(CAST(actor_name AS BLOB)), 0) +
                    coalesce(length(CAST(actor_email AS BLOB)), 0) +
                    length(CAST(reason AS BLOB))
                  ), 0) AS text_bytes,
                  coalesce(max(
                    length(CAST(ref_name AS BLOB)) +
                    coalesce(length(CAST(old_raw AS BLOB)), 0) +
                    coalesce(length(CAST(new_raw AS BLOB)), 0) +
                    coalesce(length(CAST(old_oid AS BLOB)), 0) +
                    coalesce(length(CAST(new_oid AS BLOB)), 0) +
                    coalesce(length(CAST(actor_name AS BLOB)), 0) +
                    coalesce(length(CAST(actor_email AS BLOB)), 0) +
                    length(CAST(reason AS BLOB))
                  ), 0) AS max_text_bytes,
                  (SELECT length(CAST(head AS BLOB)) FROM git_checkouts
                    WHERE id = ? AND repo_id = ?) AS head_bytes
             FROM git_reflog_entries
            WHERE repo_id = ? AND ref_name = ?`,
      this.#checkoutId,
      this.#repoId,
      this.#repoId,
      name === "HEAD" ? this.#checkoutId : name,
    );
    const measured = requireRefLogReadMetadata(metadata);
    if (measured.rows > REFLOG_RETENTION_ROWS) {
      throw new CorruptError("reflog row count exceeds its retained history bound");
    }
    const maxTextBytes = requireMaximumStoredTextBytes(
      metadata?.max_text_bytes,
      "reflog retained entry",
    );
    if ((measured.rows === 0) !== (maxTextBytes === 0)) {
      throw new CorruptError("reflog retained entry metadata is inconsistent");
    }
    const reservation = this.#sharedStore.reserveMemory();
    reservation.set(
      "other",
      512 +
        retainedStringUnits(measured.headBytes) +
        measured.rows * (512 + 9 * 48 + 16) +
        2 * measured.textBytes +
        currentTextRowRetainedBytes(measured.headBytes) +
        (maxTextBytes === 0 ? 0 : currentTextRowRetainedBytes(maxTextBytes, 8)),
    );
    try {
      const active: RefLogEntry[] = [];
      let headerSeen = false;
      let nextOrdinal = 0;
      let previousOrdinal: number | null = null;
      const headerSql = `SELECT 0 AS kind, repository.id AS repo_id,
              typeof(checkout.head) AS head_type,
              CAST(checkout.head AS BLOB) AS head_blob,
              state.next_ordinal,
              (SELECT max(ordinal) FROM (
                 SELECT direct.ordinal FROM git_reflog_entries direct
                  WHERE direct.repo_id = repository.id
                 UNION ALL
                 SELECT local.ordinal FROM git_checkout_reflog_entries local
                  WHERE local.repo_id = repository.id
               )) AS latest_ordinal,
              NULL AS ref_name_type, NULL AS ref_name_blob, NULL AS ordinal,
              NULL AS old_raw_type, NULL AS old_raw_blob,
              NULL AS new_raw_type, NULL AS new_raw_blob,
              NULL AS old_oid_type, NULL AS old_oid_blob,
              NULL AS new_oid_type, NULL AS new_oid_blob,
              NULL AS actor_name_type, NULL AS actor_name_blob,
              NULL AS actor_email_type, NULL AS actor_email_blob,
              NULL AS timestamp, NULL AS timezone,
              NULL AS reason_type, NULL AS reason_blob
         FROM git_repositories repository
         JOIN git_reflog_state state ON state.repo_id = repository.id
         JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? AND checkout.id = ?`;
      const rows =
        name === "HEAD"
          ? this.#db.iterate(
              `${headerSql}
             UNION ALL
             SELECT 1 AS kind, entry.repo_id, NULL AS head_type, NULL AS head_blob,
                    NULL AS next_ordinal,
                    NULL AS latest_ordinal, 'text' AS ref_name_type,
                    CAST('HEAD' AS BLOB) AS ref_name_blob, entry.ordinal,
                    typeof(entry.old_raw) AS old_raw_type,
                    CAST(entry.old_raw AS BLOB) AS old_raw_blob,
                    typeof(entry.new_raw) AS new_raw_type,
                    CAST(entry.new_raw AS BLOB) AS new_raw_blob,
                    typeof(entry.old_oid) AS old_oid_type,
                    CAST(entry.old_oid AS BLOB) AS old_oid_blob,
                    typeof(entry.new_oid) AS new_oid_type,
                    CAST(entry.new_oid AS BLOB) AS new_oid_blob,
                    typeof(entry.actor_name) AS actor_name_type,
                    CAST(entry.actor_name AS BLOB) AS actor_name_blob,
                    typeof(entry.actor_email) AS actor_email_type,
                    CAST(entry.actor_email AS BLOB) AS actor_email_blob,
                    entry.timestamp, entry.timezone, typeof(entry.reason) AS reason_type,
                    CAST(entry.reason AS BLOB) AS reason_blob
               FROM git_checkout_reflog_entries entry
              WHERE entry.repo_id = ? AND entry.checkout_id = ?
              ORDER BY kind, ordinal DESC
              LIMIT ${REFLOG_RETENTION_ROWS + 1}`,
              this.#repoId,
              this.#checkoutId,
              this.#repoId,
              this.#checkoutId,
            )
          : this.#db.iterate(
              `${headerSql}
             UNION ALL
             SELECT 1 AS kind, entry.repo_id, NULL AS head_type, NULL AS head_blob,
              NULL AS next_ordinal,
              NULL AS latest_ordinal, typeof(entry.ref_name) AS ref_name_type,
              CAST(entry.ref_name AS BLOB) AS ref_name_blob, entry.ordinal,
              typeof(entry.old_raw) AS old_raw_type,
              CAST(entry.old_raw AS BLOB) AS old_raw_blob,
              typeof(entry.new_raw) AS new_raw_type,
              CAST(entry.new_raw AS BLOB) AS new_raw_blob,
              typeof(entry.old_oid) AS old_oid_type,
              CAST(entry.old_oid AS BLOB) AS old_oid_blob,
              typeof(entry.new_oid) AS new_oid_type,
              CAST(entry.new_oid AS BLOB) AS new_oid_blob,
              typeof(entry.actor_name) AS actor_name_type,
              CAST(entry.actor_name AS BLOB) AS actor_name_blob,
              typeof(entry.actor_email) AS actor_email_type,
              CAST(entry.actor_email AS BLOB) AS actor_email_blob,
              entry.timestamp, entry.timezone, typeof(entry.reason) AS reason_type,
              CAST(entry.reason AS BLOB) AS reason_blob
               FROM git_reflog_entries entry INDEXED BY git_reflog_entries_by_ref
              WHERE entry.repo_id = ? AND entry.ref_name = ?
              ORDER BY kind, ordinal DESC
              LIMIT ${REFLOG_RETENTION_ROWS + 1}`,
              this.#repoId,
              this.#checkoutId,
              this.#repoId,
              name,
            );
      for (const row of rows) {
        if (row.kind === 0) {
          if (headerSeen) throw new CorruptError("reflog query returned duplicate headers");
          headerSeen = true;
          nextOrdinal = requireRefLogHeader(row, this.#repoId);
          continue;
        }
        if (row.kind !== 1 || !headerSeen) {
          throw new CorruptError("reflog query returned an invalid row sequence");
        }
        const entry = requireStoredRefLogEntry(row, this.#repoId);
        if (entry.refName !== name) throw new CorruptError("reflog query returned another ref");
        if (entry.ordinal > nextOrdinal) {
          throw new CorruptError("reflog entry exceeds the repository allocation state");
        }
        if (previousOrdinal !== null && previousOrdinal <= entry.ordinal) {
          throw new CorruptError("reflog entries are not in strict descending ordinal order");
        }
        previousOrdinal = entry.ordinal;
        if (entry.timestamp >= cutoff) active.push(entry);
      }
      if (!headerSeen) throw new CorruptError("repository is missing its reflog state");
      const page: RefLogEntry[] = [];
      for (const entry of active) {
        if (before !== undefined && entry.ordinal >= before) continue;
        if (page.length < limit) page.push(entry);
      }
      return page;
    } finally {
      reservation.dispose();
    }
  }

  /** Distinct active reflog roots in strict byte order. */
  *activeRefLogOids(): Generator<string> {
    const now = this.#nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_REFLOG_ORDINAL) {
      throw new GitError("EINVAL", "reflog clock must return a safe nonnegative epoch time");
    }
    const cutoff = Math.max(0, now - REFLOG_RETENTION_SECONDS);
    const scanMetadata = this.#db.one<{
      rows: unknown;
      text_bytes: unknown;
      max_row_bytes: unknown;
      head_bytes: unknown;
    }>(
      `SELECT direct.rows + local.rows AS rows,
              direct.text_bytes + local.text_bytes AS text_bytes,
              max(direct.max_row_bytes, local.max_row_bytes) AS max_row_bytes,
              (SELECT length(CAST(head AS BLOB)) FROM git_checkouts
                WHERE id = ? AND repo_id = ?) AS head_bytes
         FROM (
           SELECT count(*) AS rows,
                  coalesce(sum(row_bytes), 0) AS text_bytes,
                  coalesce(max(CASE WHEN retained_rank <= ${REFLOG_RETENTION_ROWS}
                                    THEN row_bytes END), 0) AS max_row_bytes
             FROM (
               SELECT coalesce(length(CAST(ref_name AS BLOB)), 0) +
                      coalesce(length(CAST(old_raw AS BLOB)), 0) +
                      coalesce(length(CAST(new_raw AS BLOB)), 0) +
                      coalesce(length(CAST(old_oid AS BLOB)), 0) +
                      coalesce(length(CAST(new_oid AS BLOB)), 0) +
                      coalesce(length(CAST(actor_name AS BLOB)), 0) +
                      coalesce(length(CAST(actor_email AS BLOB)), 0) +
                      coalesce(length(CAST(reason AS BLOB)), 0) AS row_bytes,
                      row_number() OVER (
                        PARTITION BY ref_name ORDER BY ordinal DESC
                      ) AS retained_rank
                 FROM git_reflog_entries INDEXED BY git_reflog_entries_by_ref
                WHERE repo_id = ?
             ) direct_ranked
         ) direct
         CROSS JOIN (
           SELECT count(*) AS rows,
                  coalesce(sum(row_bytes), 0) AS text_bytes,
                  coalesce(max(CASE WHEN retained_rank <= ${REFLOG_RETENTION_ROWS}
                                    THEN row_bytes END), 0) AS max_row_bytes
             FROM (
               SELECT 4 +
                      coalesce(length(CAST(old_raw AS BLOB)), 0) +
                      coalesce(length(CAST(new_raw AS BLOB)), 0) +
                      coalesce(length(CAST(old_oid AS BLOB)), 0) +
                      coalesce(length(CAST(new_oid AS BLOB)), 0) +
                      coalesce(length(CAST(actor_name AS BLOB)), 0) +
                      coalesce(length(CAST(actor_email AS BLOB)), 0) +
                      coalesce(length(CAST(reason AS BLOB)), 0) AS row_bytes,
                      row_number() OVER (
                        PARTITION BY checkout_id ORDER BY ordinal DESC
                      ) AS retained_rank
                 FROM git_checkout_reflog_entries
                WHERE repo_id = ?
             ) local_ranked
         ) local`,
      this.#checkoutId,
      this.#repoId,
      this.#repoId,
      this.#repoId,
    );
    validateRefLogRootScanBudget(scanMetadata);
    const header = this.#db.one<Record<string, unknown>>(
      `SELECT repository.id AS repo_id, typeof(checkout.head) AS head_type,
              CAST(checkout.head AS BLOB) AS head_blob,
              state.next_ordinal,
              (SELECT max(ordinal) FROM (
                 SELECT direct.ordinal FROM git_reflog_entries direct
                  WHERE direct.repo_id = repository.id
                 UNION ALL
                 SELECT local.ordinal FROM git_checkout_reflog_entries local
                  WHERE local.repo_id = repository.id
               )) AS latest_ordinal
         FROM git_repositories repository
         JOIN git_reflog_state state ON state.repo_id = repository.id
         JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? AND checkout.id = ?`,
      this.#repoId,
      this.#checkoutId,
    );
    if (header === undefined) throw new CorruptError("repository is missing its reflog state");
    const nextOrdinal = requireRefLogHeader(header, this.#repoId);
    let previousRef: string | null = null;
    let previousDirectOrdinal: number | null = null;
    let directEntriesForRef = 0;
    let previousCheckoutId = 0;
    let previousCheckoutOrdinal: number | null = null;
    let checkoutEntries = 0;
    let previousOid: string | null = null;
    for (const row of this.#db.iterate(
      `WITH direct_ranked AS (
         SELECT entry.*, NULL AS checkout_id, NULL AS owner_repo_id,
                row_number() OVER (
                  PARTITION BY entry.ref_name ORDER BY entry.ordinal DESC
                ) AS retained_rank
           FROM git_reflog_entries entry INDEXED BY git_reflog_entries_by_ref
          WHERE entry.repo_id = ?
       ), checkout_ranked AS (
         SELECT entry.*, 'HEAD' AS ref_name, checkout.repo_id AS owner_repo_id,
                row_number() OVER (
                  PARTITION BY entry.checkout_id ORDER BY entry.ordinal DESC
                ) AS retained_rank
           FROM git_checkout_reflog_entries entry
           LEFT JOIN git_checkouts checkout ON checkout.id = entry.checkout_id
          WHERE entry.repo_id = ?
       ), retained AS (
         SELECT 0 AS kind, repo_id, checkout_id, owner_repo_id, ref_name, ordinal,
                old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason
           FROM direct_ranked WHERE retained_rank <= ${REFLOG_RETENTION_ROWS}
         UNION ALL
         SELECT 1 AS kind, repo_id, checkout_id, owner_repo_id, ref_name, ordinal,
                old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason
           FROM checkout_ranked WHERE retained_rank <= ${REFLOG_RETENTION_ROWS}
       ), output AS (
         SELECT retained.*, NULL AS root_oid FROM retained
         UNION ALL
         SELECT 2 AS kind, NULL AS repo_id, NULL AS checkout_id, NULL AS owner_repo_id,
                NULL AS ref_name, NULL AS ordinal, NULL AS old_raw, NULL AS new_raw,
                NULL AS old_oid, NULL AS new_oid, NULL AS actor_name, NULL AS actor_email,
                NULL AS timestamp, NULL AS timezone, NULL AS reason, endpoint.oid AS root_oid
           FROM (
             SELECT oid FROM (
               SELECT old_oid AS oid FROM retained WHERE timestamp >= ?
               UNION ALL
               SELECT new_oid AS oid FROM retained WHERE timestamp >= ?
             ) WHERE oid IS NOT NULL GROUP BY oid
           ) endpoint
       )
       SELECT kind, repo_id, checkout_id, owner_repo_id,
              typeof(ref_name) AS ref_name_type, CAST(ref_name AS BLOB) AS ref_name_blob, ordinal,
              typeof(old_raw) AS old_raw_type,
              CAST(old_raw AS BLOB) AS old_raw_blob,
              typeof(new_raw) AS new_raw_type,
              CAST(new_raw AS BLOB) AS new_raw_blob,
              typeof(old_oid) AS old_oid_type,
              CAST(old_oid AS BLOB) AS old_oid_blob,
              typeof(new_oid) AS new_oid_type,
              CAST(new_oid AS BLOB) AS new_oid_blob,
              typeof(actor_name) AS actor_name_type,
              CAST(actor_name AS BLOB) AS actor_name_blob,
              typeof(actor_email) AS actor_email_type,
              CAST(actor_email AS BLOB) AS actor_email_blob,
              timestamp, timezone, typeof(reason) AS reason_type,
              CAST(reason AS BLOB) AS reason_blob,
              CAST(root_oid AS BLOB) AS root_oid_blob
         FROM output
       ORDER BY kind, ref_name COLLATE BINARY, checkout_id, ordinal DESC, root_oid COLLATE BINARY`,
      this.#repoId,
      this.#repoId,
      cutoff,
      cutoff,
    )) {
      if (row.kind === 0) {
        const entry = requireStoredRefLogEntry(row, this.#repoId);
        if (entry.ordinal > nextOrdinal) {
          throw new CorruptError("reflog entry exceeds the repository allocation state");
        }
        if (previousRef === null || entry.refName !== previousRef) {
          if (previousRef !== null && comparePaths(previousRef, entry.refName) >= 0) {
            throw new CorruptError("reflog entries are not in strict ref byte order");
          }
          previousRef = entry.refName;
          previousDirectOrdinal = null;
          directEntriesForRef = 0;
        }
        if (previousDirectOrdinal !== null && previousDirectOrdinal <= entry.ordinal) {
          throw new CorruptError("reflog entries are not in strict descending ordinal order");
        }
        previousDirectOrdinal = entry.ordinal;
        directEntriesForRef++;
        if (directEntriesForRef > REFLOG_RETENTION_ROWS) {
          throw new CorruptError("reflog root query exceeded its retained row bound");
        }
        continue;
      }
      if (row.kind === 1) {
        const checkoutId = requireSafeId(row.checkout_id, "checkout reflog owner id");
        if (row.owner_repo_id !== this.#repoId) {
          throw new CorruptError("checkout reflog owner belongs to another repository");
        }
        const entry = requireStoredRefLogEntry(row, this.#repoId);
        if (entry.refName !== "HEAD" || entry.ordinal > nextOrdinal) {
          throw new CorruptError("checkout reflog entry is invalid");
        }
        if (checkoutId !== previousCheckoutId) {
          if (checkoutId <= previousCheckoutId) {
            throw new CorruptError("checkout reflog owners are not in strict order");
          }
          previousCheckoutId = checkoutId;
          previousCheckoutOrdinal = null;
          checkoutEntries = 0;
        }
        if (previousCheckoutOrdinal !== null && previousCheckoutOrdinal <= entry.ordinal) {
          throw new CorruptError("checkout reflog entries are not in descending ordinal order");
        }
        previousCheckoutOrdinal = entry.ordinal;
        checkoutEntries++;
        if (checkoutEntries > REFLOG_RETENTION_ROWS) {
          throw new CorruptError("checkout reflog query exceeded its retained row bound");
        }
        continue;
      }
      if (row.kind !== 2) {
        throw new CorruptError("reflog root query returned an invalid object id");
      }
      const rootOid = decodeCanonicalStoredText(row.root_oid_blob, "reflog root object id");
      if (!isOid(rootOid)) {
        throw new CorruptError("reflog root query returned an invalid object id");
      }
      if (previousOid !== null && comparePaths(previousOid, rootOid) >= 0) {
        throw new CorruptError("reflog roots are not in strict byte order");
      }
      previousOid = rootOid;
      yield rootOid;
    }
  }

  // -- config ---------------------------------------------------------

  configGetAll(path: string): string[] {
    return this.#db
      .all<{ value: string }>(
        "SELECT value FROM git_config WHERE repo_id = ? AND path = ? ORDER BY seq",
        this.#repoId,
        path,
      )
      .map((row) => row.value);
  }

  configGet(path: string): string | undefined {
    // git's `--get` reports the last value for a multi-valued key.
    const values = this.configGetAll(path);
    return values.length === 0 ? undefined : values[values.length - 1];
  }

  #configGetOwned(path: string, owner: RefMutationMemoryOwner): string | undefined {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "config path must be a non-empty string");
    }
    const owningReservation = owner.memoryReservation();
    const transientMemory = this.#sharedStore.scopeMemoryReservation(owningReservation);
    try {
      transientMemory.set("other", CONFIG_READ_FIXED_RETAINED_BYTES);
      const info = this.#db.one<{
        repo_id: unknown;
        seq_type: unknown;
        seq: unknown;
        value_type: unknown;
        value_bytes: unknown;
      }>(
        `SELECT repo_id, typeof(seq) AS seq_type,
                CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
                typeof(value) AS value_type,
                length(CAST(value AS BLOB)) AS value_bytes
           FROM git_config
          WHERE repo_id = ? AND path = ?
          ORDER BY seq DESC
          LIMIT 1`,
        this.#repoId,
        path,
      );
      if (info === undefined) return undefined;
      if (
        info.repo_id !== this.#repoId ||
        info.seq_type !== "integer" ||
        typeof info.seq !== "number" ||
        !Number.isSafeInteger(info.seq) ||
        info.seq < 0 ||
        info.value_type !== "text" ||
        typeof info.value_bytes !== "number" ||
        !Number.isSafeInteger(info.value_bytes) ||
        info.value_bytes < 0
      ) {
        throw new CorruptError(`config ${path} has invalid text metadata`);
      }
      if (info.value_bytes > (Number.MAX_SAFE_INTEGER - CONFIG_READ_FIXED_RETAINED_BYTES) / 2) {
        throw new GitError("E2BIG", "config read memory accounting overflow");
      }
      transientMemory.set("other", CONFIG_READ_FIXED_RETAINED_BYTES + 2 * info.value_bytes);
      return owner.construct(info.value_bytes, () => {
        const row = this.#db.one<Record<string, unknown>>(
          `SELECT repo_id, typeof(seq) AS seq_type,
                  CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
                  typeof(value) AS value_type,
                  length(CAST(value AS BLOB)) AS value_bytes,
                  CAST(value AS BLOB) AS value_blob
             FROM git_config
            WHERE repo_id = ? AND path = ? AND seq = ?
            LIMIT 1`,
          this.#repoId,
          path,
          info.seq,
        );
        if (
          row === undefined ||
          row.repo_id !== this.#repoId ||
          row.seq_type !== "integer" ||
          row.seq !== info.seq ||
          row.value_type !== "text" ||
          row.value_bytes !== info.value_bytes
        ) {
          throw new CorruptError(`config ${path} changed after validation`);
        }
        const bytes = readBlob(row.value_blob);
        if (bytes.byteLength !== info.value_bytes) {
          throw new CorruptError(`config ${path} changed after validation`);
        }
        return decodeCanonicalText(bytes, `config ${path}`);
      });
    } finally {
      transientMemory.dispose();
    }
  }

  /** Read one config value only after SQLite proves its text metadata. */
  configGetBounded(path: string, maxBytes?: number): string | undefined {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }
    const reservation = this.#sharedStore.reserveMemory();
    reservation.set("other", CONFIG_READ_FIXED_RETAINED_BYTES);
    try {
      const info = this.#db.one<{
        repo_id: unknown;
        seq_type: unknown;
        seq: unknown;
        value_type: unknown;
        value_bytes: unknown;
      }>(
        `SELECT repo_id, typeof(seq) AS seq_type,
              CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
              typeof(value) AS value_type,
              length(CAST(value AS BLOB)) AS value_bytes
         FROM git_config
        WHERE repo_id = ? AND path = ?
        ORDER BY seq DESC
        LIMIT 1`,
        this.#repoId,
        path,
      );
      if (info === undefined) return undefined;
      if (
        info.repo_id !== this.#repoId ||
        info.seq_type !== "integer" ||
        typeof info.seq !== "number" ||
        !Number.isSafeInteger(info.seq) ||
        info.seq < 0 ||
        info.value_type !== "text" ||
        typeof info.value_bytes !== "number" ||
        !Number.isSafeInteger(info.value_bytes) ||
        info.value_bytes < 0
      ) {
        throw new CorruptError(`config ${path} has invalid text metadata`);
      }
      if (maxBytes !== undefined && info.value_bytes > maxBytes) {
        throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
      }
      reservation.set(
        "other",
        CONFIG_READ_FIXED_RETAINED_BYTES + info.value_bytes + 48 + 2 * info.value_bytes,
      );
      const row = this.#db.one<Record<string, unknown>>(
        `SELECT repo_id, typeof(seq) AS seq_type,
                CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
                typeof(value) AS value_type,
                length(CAST(value AS BLOB)) AS value_bytes,
                CAST(value AS BLOB) AS value_blob
           FROM git_config
          WHERE repo_id = ? AND path = ? AND seq = ?
          LIMIT 1`,
        this.#repoId,
        path,
        info.seq,
      );
      if (
        row === undefined ||
        row.repo_id !== this.#repoId ||
        row.seq_type !== "integer" ||
        row.seq !== info.seq ||
        row.value_type !== "text" ||
        row.value_bytes !== info.value_bytes
      ) {
        throw new CorruptError(`config ${path} changed after validation`);
      }
      const bytes = readBlob(row.value_blob);
      if (bytes.byteLength !== info.value_bytes) {
        throw new CorruptError(`config ${path} changed after validation`);
      }
      const value = decodeCanonicalText(bytes, `config ${path}`);
      reservation.set(
        "other",
        CONFIG_READ_FIXED_RETAINED_BYTES + bytes.byteLength + retainedStringBytes(value),
      );
      return value;
    } finally {
      reservation.dispose();
    }
  }

  /** Read zero or one canonical value without materialising a multi-valued key. */
  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "bounded config path must be a non-empty string");
    }
    boundedCanonicalUtf8Bytes(path, MAX_INDEX_PATH_BYTES, "bounded config path");
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }

    const reservation = this.#sharedStore.reserveMemory();
    reservation.set("other", CONFIG_READ_FIXED_RETAINED_BYTES + 2 * 128);
    try {
      const metadata: { seq: number; bytes: number }[] = [];
      for (const row of this.#db.iterate(
        `SELECT repo_id, typeof(seq) AS seq_type,
              CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
              typeof(value) AS value_type,
              length(CAST(value AS BLOB)) AS value_bytes
         FROM git_config
        WHERE repo_id = ? AND path = ?
        ORDER BY seq
        LIMIT 2`,
        this.#repoId,
        path,
      )) {
        if (row.repo_id !== this.#repoId) {
          throw new CorruptError(`config ${path} crossed repository boundaries`);
        }
        if (
          row.seq_type !== "integer" ||
          typeof row.seq !== "number" ||
          !Number.isSafeInteger(row.seq) ||
          row.seq < 0 ||
          row.value_type !== "text" ||
          typeof row.value_bytes !== "number" ||
          !Number.isSafeInteger(row.value_bytes) ||
          row.value_bytes < 0
        ) {
          throw new CorruptError(`config ${path} has invalid value metadata`);
        }
        if (maxBytes !== undefined && row.value_bytes > maxBytes) {
          throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
        }
        metadata.push({ seq: row.seq, bytes: row.value_bytes });
      }
      const expected = metadata[0];
      if (expected === undefined) return { kind: "missing" };
      if (metadata.length !== 1) return { kind: "multiple" };

      reservation.set(
        "other",
        CONFIG_READ_FIXED_RETAINED_BYTES + 2 * 128 + expected.bytes + 48 + 2 * expected.bytes,
      );

      const row = this.#db.one<Record<string, unknown>>(
        `SELECT repo_id, typeof(seq) AS seq_type,
              CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
              typeof(value) AS value_type,
              length(CAST(value AS BLOB)) AS value_bytes,
              CAST(value AS BLOB) AS value_blob
         FROM git_config
        WHERE repo_id = ? AND path = ? AND seq = ?
        LIMIT 1`,
        this.#repoId,
        path,
        expected.seq,
      );
      if (
        row === undefined ||
        row.repo_id !== this.#repoId ||
        row.seq_type !== "integer" ||
        row.seq !== expected.seq ||
        row.value_type !== "text" ||
        row.value_bytes !== expected.bytes
      ) {
        throw new CorruptError(`config ${path} changed after validation`);
      }
      let bytes: Uint8Array;
      try {
        bytes = readBlob(row.value_blob);
      } catch (error) {
        throw new CorruptError(`config ${path} has an invalid value BLOB`, { cause: error });
      }
      if (bytes.byteLength !== expected.bytes) {
        throw new CorruptError(`config ${path} changed after validation`);
      }
      const value = decodeCanonicalText(bytes, `config ${path}`);
      reservation.set(
        "other",
        CONFIG_READ_FIXED_RETAINED_BYTES + 2 * 128 + bytes.byteLength + retainedStringBytes(value),
      );
      return { kind: "single", value };
    } finally {
      reservation.dispose();
    }
  }

  /** Inspect zero, one, or multiple values without materialising their payloads. */
  configCardinality(path: string): ConfigValueCardinality {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "config path must be a non-empty string");
    }
    boundedCanonicalUtf8Bytes(path, MAX_INDEX_PATH_BYTES, "config path");
    let rows = 0;
    for (const row of this.#db.iterate(
      `SELECT repo_id, typeof(seq) AS seq_type,
              CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
              typeof(value) AS value_type,
              length(CAST(value AS BLOB)) AS value_bytes
         FROM git_config
        WHERE repo_id = ? AND path = ?
        ORDER BY seq
        LIMIT 2`,
      this.#repoId,
      path,
    )) {
      if (
        row.repo_id !== this.#repoId ||
        row.seq_type !== "integer" ||
        typeof row.seq !== "number" ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 0 ||
        row.value_type !== "text" ||
        typeof row.value_bytes !== "number" ||
        !Number.isSafeInteger(row.value_bytes) ||
        row.value_bytes < 0
      ) {
        throw new CorruptError(`config ${path} has invalid value metadata`);
      }
      rows++;
    }
    return rows === 0 ? "missing" : rows === 1 ? "single" : "multiple";
  }

  configSet(path: string, value: string): void {
    this.#db.transactionSync(() => {
      this.#db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.#repoId, path);
      this.#db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, 0, ?)",
        this.#repoId,
        path,
        value,
      );
    });
  }

  configAdd(path: string, value: string): void {
    this.#db.transactionSync(() => {
      const seq =
        (this.#db.scalar<number | null>(
          "SELECT MAX(seq) FROM git_config WHERE repo_id = ? AND path = ?",
          this.#repoId,
          path,
        ) ?? -1) + 1;
      this.#db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, ?, ?)",
        this.#repoId,
        path,
        seq,
        value,
      );
    });
  }

  configUnset(path: string): void {
    this.#db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.#repoId, path);
  }

  /** Distinct config paths under a dotted prefix, e.g. "remote.". */
  configPaths(prefix: string): string[] {
    return this.#db
      .all<{ path: string }>(
        "SELECT DISTINCT path FROM git_config WHERE repo_id = ? AND path >= ? AND path < ? ORDER BY path",
        this.#repoId,
        prefix,
        nextPrefix(prefix),
      )
      .map((row) => row.path);
  }

  /** Validate and move one exact dotted config section without changing value order. */
  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    const source = requireConfigSectionPrefix(sourcePrefix, "source");
    const destination = requireConfigSectionPrefix(destinationPrefix, "destination");
    if (source === destination) {
      throw new GitError("EINVAL", "config section source and destination must differ");
    }

    const reservation = this.reserveMemory();
    const metadataMemory = reservation.scope();
    const valueMemory = reservation.scope();
    try {
      reservation.set(
        "other",
        512 + retainedStringBytes(source) + retainedStringBytes(destination),
      );
      this.#db.transactionSync(() => {
        let destinationCandidates = 0;
        valueMemory.set("other", currentTextRowRetainedBytes(MAX_INDEX_PATH_BYTES, 2));
        for (const row of this.#db.iterate(
          configSectionMetadataSql(),
          this.#repoId,
          destination,
          nextPrefix(destination),
        )) {
          destinationCandidates++;
          if (destinationCandidates > MAX_CONFIG_SECTION_MOVE_ROWS) {
            throw new GitError(
              "E2BIG",
              `config section ${destination} exceeds ${MAX_CONFIG_SECTION_MOVE_ROWS} inspected rows`,
            );
          }
          const candidate = requireConfigSectionMetadata(row, this.#repoId, destination);
          if (configSectionVariable(candidate.path, destination) !== null) {
            throw new GitError("EEXIST", `config section ${destination} already exists`);
          }
        }
        valueMemory.clear("other");

        const metadata: ConfigSectionMoveMetadata[] = [];
        let sourceCandidates = 0;
        let metadataBytes = 256;
        metadataMemory.set("other", metadataBytes);
        valueMemory.set("other", currentTextRowRetainedBytes(MAX_INDEX_PATH_BYTES, 2));
        for (const row of this.#db.iterate(
          configSectionMetadataSql(),
          this.#repoId,
          source,
          nextPrefix(source),
        )) {
          sourceCandidates++;
          if (sourceCandidates > MAX_CONFIG_SECTION_MOVE_ROWS) {
            throw new GitError(
              "E2BIG",
              `config section ${source} exceeds ${MAX_CONFIG_SECTION_MOVE_ROWS} inspected rows`,
            );
          }
          const candidate = requireConfigSectionMetadata(row, this.#repoId, source);
          const variable = configSectionVariable(candidate.path, source);
          if (variable === null) continue;
          if (
            candidate.valueType !== "text" ||
            candidate.valueBytes === null ||
            candidate.valueBytes < 0
          ) {
            throw new CorruptError(`config section ${source} has an invalid stored value`);
          }
          configSectionDestinationBytes(destination, variable);
          metadataBytes = blobIdRetainedTotal(
            metadataBytes,
            192 + retainedStringBytes(candidate.path),
            "config section metadata",
          );
          metadataMemory.set("other", metadataBytes);
          metadata.push({ ...candidate, valueBytes: candidate.valueBytes });
        }
        valueMemory.clear("other");

        function* validationRows(): Generator<{
          ordinal: number;
          path: string;
          seq: number;
          valueBytes: number;
        }> {
          for (let ordinal = 0; ordinal < metadata.length; ordinal++) {
            const candidate = metadata[ordinal];
            if (candidate === undefined)
              throw new CorruptError("config section metadata is sparse");
            yield {
              ordinal,
              path: candidate.path,
              seq: candidate.seq,
              valueBytes: candidate.valueBytes,
            };
          }
        }
        let validatedValues = 0;
        for (const page of jsonPages(validationRows(), "config section value validation", {
          reservation,
          maxUnits: (row) => 128 + jsonStringMaxUnits(row.path),
        })) {
          valueMemory.set("other", 512 + 4 * OBJECT_PAYLOAD);
          let currentOrdinal = -1;
          let expectedOffset = 0;
          let decoder = new TextDecoder("utf-8", { fatal: true });
          const finishDecoder = (candidate: ConfigSectionMoveMetadata): void => {
            try {
              decoder.decode();
            } catch (error) {
              throw new CorruptError(`config value at ${candidate.path} is not canonical UTF-8`, {
                cause: error,
              });
            }
          };
          try {
            for (const row of this.#db.iterate(
              `WITH RECURSIVE wanted(ordinal, path, seq, value_bytes) AS MATERIALIZED (
                 SELECT json_extract(value, '$.ordinal'), json_extract(value, '$.path'),
                        json_extract(value, '$.seq'), json_extract(value, '$.valueBytes')
                   FROM json_each(?)
               ), chunks(ordinal, path, seq, value_bytes, offset) AS (
                 SELECT ordinal, path, seq, value_bytes, 0 FROM wanted
                 UNION ALL
                 SELECT ordinal, path, seq, value_bytes, offset + ${OBJECT_PAYLOAD}
                   FROM chunks WHERE offset + ${OBJECT_PAYLOAD} < value_bytes
               )
               SELECT chunks.ordinal, chunks.path, chunks.seq, chunks.offset,
                      typeof(config.value) AS value_type,
                      length(CAST(config.value AS BLOB)) AS value_bytes,
                      substr(CAST(config.value AS BLOB), chunks.offset + 1,
                             min(${OBJECT_PAYLOAD}, chunks.value_bytes - chunks.offset)) AS chunk
                 FROM chunks
                 JOIN git_config config
                   ON config.repo_id = ? AND config.path = chunks.path AND config.seq = chunks.seq
                ORDER BY chunks.ordinal, chunks.offset`,
              page,
              this.#repoId,
            )) {
              const ordinal = row.ordinal;
              if (
                typeof ordinal !== "number" ||
                !Number.isSafeInteger(ordinal) ||
                ordinal < 0 ||
                ordinal >= metadata.length
              ) {
                throw new CorruptError(`config section ${source} changed after validation`);
              }
              const candidate = metadata[ordinal];
              if (candidate === undefined) {
                throw new CorruptError(`config section ${source} changed after validation`);
              }
              if (ordinal !== currentOrdinal) {
                if (currentOrdinal >= 0) {
                  const previous = metadata[currentOrdinal];
                  if (previous === undefined || expectedOffset !== previous.valueBytes) {
                    throw new CorruptError(`config section ${source} changed after validation`);
                  }
                  finishDecoder(previous);
                }
                currentOrdinal = ordinal;
                expectedOffset = 0;
                decoder = new TextDecoder("utf-8", { fatal: true });
                validatedValues++;
              }
              const chunk = readBlob(row.chunk);
              const expectedChunkBytes = Math.min(
                OBJECT_PAYLOAD,
                candidate.valueBytes - expectedOffset,
              );
              if (
                row.path !== candidate.path ||
                row.seq !== candidate.seq ||
                row.offset !== expectedOffset ||
                row.value_type !== "text" ||
                row.value_bytes !== candidate.valueBytes ||
                chunk.byteLength !== expectedChunkBytes
              ) {
                throw new CorruptError(`config section ${source} changed after validation`);
              }
              try {
                decoder.decode(chunk, { stream: true });
              } catch (error) {
                throw new CorruptError(`config value at ${candidate.path} is not canonical UTF-8`, {
                  cause: error,
                });
              }
              expectedOffset += chunk.byteLength;
            }
            if (currentOrdinal >= 0) {
              const current = metadata[currentOrdinal];
              if (current === undefined || expectedOffset !== current.valueBytes) {
                throw new CorruptError(`config section ${source} changed after validation`);
              }
              finishDecoder(current);
            }
          } finally {
            valueMemory.clear("other");
          }
        }
        if (validatedValues !== metadata.length) {
          throw new CorruptError(`config section ${source} changed after validation`);
        }
        if (metadata.length === 0) return;

        function* updateRows(): Generator<{ path: string; seq: number }> {
          for (const row of metadata) yield { path: row.path, seq: row.seq };
        }
        let changedRows = 0;
        for (const page of jsonPages(updateRows(), "config section move", {
          reservation,
          maxUnits: (row) => 64 + jsonStringMaxUnits(row.path),
        })) {
          this.#db.run(
            CONFIG_SECTION_MOVE_UPDATE_SQL,
            destination,
            source,
            this.#repoId,
            source,
            nextPrefix(source),
            page,
          );
          const changed = this.#db.scalar<unknown>("SELECT changes()");
          if (typeof changed !== "number" || !Number.isSafeInteger(changed) || changed < 0) {
            throw new CorruptError(`config section ${source} returned an invalid change count`);
          }
          changedRows += changed;
        }
        if (changedRows !== metadata.length) {
          throw new CorruptError(`config section ${source} changed during its move`);
        }
      });
    } finally {
      valueMemory.dispose();
      metadataMemory.dispose();
      reservation.dispose();
    }
  }

  // -- integration operation journal --------------------------------

  /** Read and validate the one durable incomplete integration operation. */
  readOperationState(): OperationJournal | null {
    const reservation = this.reserveMemory();
    try {
      return this.#readOperationStateOwned(reservation);
    } finally {
      reservation.dispose();
    }
  }

  #readOperationStateOwned(reservation: MemoryReservation): OperationJournal | null {
    if (!this.#sharedStore.ownsMemoryReservation(reservation)) {
      throw new GitError("EINVAL", "operation journal reservation belongs to another repository");
    }
    const metadata = this.#db.one<{
      step_count: unknown;
      touched_count: unknown;
      retained_bytes: unknown;
      state_text_bytes: unknown;
      step_text_bytes: unknown;
      touched_text_bytes: unknown;
    }>(
      `SELECT state.step_count, state.touched_count, state.retained_bytes,
              coalesce(length(CAST(state.kind AS BLOB)), 0) +
              coalesce(length(CAST(state.original_head_ref AS BLOB)), 0) +
              coalesce(length(CAST(state.original_head_oid AS BLOB)), 0) +
              coalesce(length(CAST(state.current_parent_oid AS BLOB)), 0) +
              coalesce(length(CAST(state.incoming_parent_oid AS BLOB)), 0) +
              coalesce(length(CAST(state.upstream_oid AS BLOB)), 0) +
              coalesce(length(CAST(state.base_oid AS BLOB)), 0) +
              coalesce(length(CAST(state.phase AS BLOB)), 0) +
              coalesce(length(CAST(state.empty_reason AS BLOB)), 0) +
              coalesce(length(CAST(state.mode AS BLOB)), 0) +
              coalesce(length(CAST(state.merge_origin AS BLOB)), 0) +
              coalesce(length(CAST(state.current_label AS BLOB)), 0) +
              coalesce(length(CAST(state.incoming_label AS BLOB)), 0) +
              coalesce(length(CAST(state.message AS BLOB)), 0) +
              coalesce(length(CAST(state.author_name AS BLOB)), 0) +
              coalesce(length(CAST(state.author_email AS BLOB)), 0) +
              coalesce(length(CAST(state.committer_name AS BLOB)), 0) +
              coalesce(length(CAST(state.committer_email AS BLOB)), 0) +
              coalesce(length(CAST(state.integrity_oid AS BLOB)), 0)
                AS state_text_bytes,
              coalesce((SELECT max(
                coalesce(length(CAST(source_oid AS BLOB)), 0) +
                coalesce(length(CAST(selected_parent_oid AS BLOB)), 0) +
                coalesce(length(CAST(outcome AS BLOB)), 0) +
                coalesce(length(CAST(result_oid AS BLOB)), 0)
              ) FROM git_operation_steps WHERE checkout_id = state.checkout_id), 0)
                AS step_text_bytes,
              coalesce((SELECT max(
                coalesce(length(CAST(path AS BLOB)), 0) +
                coalesce(length(CAST(logical_path AS BLOB)), 0) +
                coalesce(length(CAST(purpose AS BLOB)), 0) +
                coalesce(length(CAST(index_oid AS BLOB)), 0) +
                coalesce(length(CAST(worktree_kind AS BLOB)), 0) +
                coalesce(length(CAST(worktree_oid AS BLOB)), 0)
              ) FROM git_operation_touched WHERE checkout_id = state.checkout_id), 0)
                AS touched_text_bytes
         FROM git_operation_state state WHERE state.checkout_id = ?`,
      this.#checkoutId,
    );
    if (metadata !== undefined) {
      const stepCount = requireMergeInteger(metadata.step_count, "step count");
      const touchedCount = requireMergeInteger(metadata.touched_count, "touched-path count");
      const retainedBytes = requireMergeInteger(metadata.retained_bytes, "retained-byte count");
      const stateTextBytes = requireMergeInteger(
        metadata.state_text_bytes,
        "state text byte count",
      );
      const stepTextBytes = requireMergeInteger(metadata.step_text_bytes, "step text byte count");
      const touchedTextBytes = requireMergeInteger(
        metadata.touched_text_bytes,
        "touched-path text byte count",
      );
      if (stepCount > MAX_OPERATION_STEPS) {
        throw new GitError("E2BIG", `operation journal exceeds ${MAX_OPERATION_STEPS} steps`);
      }
      if (touchedCount > MAX_MERGE_TOUCHED_PATHS) {
        throw new GitError(
          "E2BIG",
          `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`,
        );
      }
      reservation.set(
        "other",
        operationJournalReadBytes(retainedBytes, stateTextBytes, stepTextBytes, touchedTextBytes),
      );
    }
    const row = this.#db.one<OperationStateRow>(
      `SELECT
              CASE WHEN typeof(kind) = 'text' AND length(CAST(kind AS BLOB)) <= 11
                   THEN kind END AS kind,
              CASE WHEN typeof(original_head_ref) = 'text'
                         AND length(CAST(original_head_ref AS BLOB)) <= ${MAX_MERGE_REF_BYTES}
                   THEN original_head_ref END AS original_head_ref,
              CASE WHEN typeof(original_head_oid) = 'text'
                         AND length(CAST(original_head_oid AS BLOB)) = 40
                   THEN original_head_oid END AS original_head_oid,
              CASE WHEN current_parent_oid IS NULL THEN NULL
                   WHEN typeof(current_parent_oid) = 'text'
                         AND length(CAST(current_parent_oid AS BLOB)) = 40
                   THEN current_parent_oid ELSE 0 END AS current_parent_oid,
              CASE WHEN incoming_parent_oid IS NULL THEN NULL
                   WHEN typeof(incoming_parent_oid) = 'text'
                         AND length(CAST(incoming_parent_oid AS BLOB)) = 40
                   THEN incoming_parent_oid ELSE 0 END AS incoming_parent_oid,
              CASE WHEN upstream_oid IS NULL THEN NULL
                   WHEN typeof(upstream_oid) = 'text'
                         AND length(CAST(upstream_oid AS BLOB)) = 40
                   THEN upstream_oid ELSE 0 END AS upstream_oid,
              CASE WHEN base_oid IS NULL THEN NULL
                   WHEN typeof(base_oid) = 'text' AND length(CAST(base_oid AS BLOB)) = 40
                   THEN base_oid ELSE 0 END AS base_oid,
              CASE WHEN typeof(phase) = 'text' AND length(CAST(phase AS BLOB)) <= 10
                   THEN phase END AS phase,
              CASE WHEN empty_reason IS NULL THEN NULL
                   WHEN typeof(empty_reason) = 'text'
                         AND length(CAST(empty_reason AS BLOB)) <= 6
                   THEN empty_reason ELSE 0 END AS empty_reason,
              CASE WHEN mode IS NULL THEN NULL
                   WHEN typeof(mode) = 'text' AND length(CAST(mode AS BLOB)) <= 9
                   THEN mode ELSE 0 END AS mode,
              CASE WHEN merge_origin IS NULL THEN NULL
                   WHEN typeof(merge_origin) = 'text' AND length(CAST(merge_origin AS BLOB)) <= 5
                   THEN merge_origin ELSE 0 END AS merge_origin,
              CASE WHEN typeof(current_step) = 'integer'
                         AND current_step >= 0 AND current_step <= ${MAX_OPERATION_STEPS}
                   THEN current_step END AS current_step,
              CASE WHEN typeof(step_count) = 'integer'
                         AND step_count >= 0 AND step_count <= ${MAX_OPERATION_STEPS}
                   THEN step_count END AS step_count,
              CASE WHEN typeof(current_label) = 'text'
                         AND length(CAST(current_label AS BLOB)) <= ${MAX_MERGE_LABEL_BYTES}
                   THEN current_label END AS current_label,
              CASE WHEN typeof(incoming_label) = 'text'
                         AND length(CAST(incoming_label AS BLOB)) <= ${MAX_MERGE_LABEL_BYTES}
                   THEN incoming_label END AS incoming_label,
              CASE WHEN typeof(message) = 'text'
                         AND length(CAST(message AS BLOB)) <= ${MAX_MERGE_MESSAGE_BYTES}
                   THEN message END AS message,
              CASE WHEN author_name IS NULL THEN NULL
                   WHEN typeof(author_name) = 'text'
                         AND length(CAST(author_name AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN author_name ELSE 0 END AS author_name,
              CASE WHEN author_email IS NULL THEN NULL
                   WHEN typeof(author_email) = 'text'
                         AND length(CAST(author_email AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN author_email ELSE 0 END AS author_email,
              CASE WHEN committer_name IS NULL THEN NULL
                   WHEN typeof(committer_name) = 'text'
                         AND length(CAST(committer_name AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN committer_name ELSE 0 END AS committer_name,
              CASE WHEN committer_email IS NULL THEN NULL
                   WHEN typeof(committer_email) = 'text'
                         AND length(CAST(committer_email AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN committer_email ELSE 0 END AS committer_email,
              touched_count, retained_bytes,
              CASE WHEN typeof(integrity_oid) = 'text'
                         AND length(CAST(integrity_oid AS BLOB)) = 40
                   THEN integrity_oid END AS integrity_oid
         FROM git_operation_state WHERE checkout_id = ?`,
      this.#checkoutId,
    );
    if (row === undefined) {
      const orphaned = requireBooleanProbe(
        this.#db.scalar<unknown>(
          `SELECT EXISTS(
             SELECT 1 FROM git_operation_steps WHERE checkout_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_touched WHERE checkout_id = ? LIMIT 1
           )`,
          this.#checkoutId,
          this.#checkoutId,
        ),
        "operation child-row orphan probe",
      );
      if (orphaned) throw new CorruptError("operation child rows exist without operation state");
      return null;
    }

    const stepCount = requireMergeInteger(row.step_count, "step count");
    if (stepCount > MAX_OPERATION_STEPS) {
      throw new GitError("E2BIG", `operation journal exceeds ${MAX_OPERATION_STEPS} steps`);
    }
    const touchedCount = requireMergeInteger(row.touched_count, "touched-path count");
    const storedBytes = requireMergeInteger(row.retained_bytes, "retained-byte count");
    if (touchedCount > MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    const steps: OperationStepMetadata[] = [];
    for (const raw of this.#db.iterate(
      `SELECT CASE WHEN typeof(ordinal) = 'integer'
                            AND ordinal >= 0 AND ordinal < ${MAX_OPERATION_STEPS}
                   THEN ordinal END AS ordinal,
              CASE WHEN typeof(source_oid) = 'text'
                         AND length(CAST(source_oid AS BLOB)) = 40
                   THEN source_oid END AS source_oid,
              CASE WHEN selected_parent_oid IS NULL THEN NULL
                   WHEN typeof(selected_parent_oid) = 'text'
                         AND length(CAST(selected_parent_oid AS BLOB)) = 40
                   THEN selected_parent_oid ELSE 0 END AS selected_parent_oid,
              CASE WHEN mainline IS NULL THEN NULL
                   WHEN typeof(mainline) = 'integer' AND mainline >= 1
                        AND mainline <= ${Number.MAX_SAFE_INTEGER}
                   THEN mainline ELSE -1 END AS mainline,
              CASE WHEN typeof(outcome) = 'text' AND length(CAST(outcome AS BLOB)) <= 7
                   THEN outcome END AS outcome,
              CASE WHEN result_oid IS NULL THEN NULL
                   WHEN typeof(result_oid) = 'text' AND length(CAST(result_oid AS BLOB)) = 40
                   THEN result_oid ELSE 0 END AS result_oid
         FROM git_operation_steps WHERE checkout_id = ? ORDER BY ordinal`,
      this.#checkoutId,
    )) {
      const stepRow: OperationStepRow = {
        ordinal: raw.ordinal,
        source_oid: raw.source_oid,
        selected_parent_oid: raw.selected_parent_oid,
        mainline: raw.mainline,
        outcome: raw.outcome,
        result_oid: raw.result_oid,
      };
      const ordinal = requireMergeInteger(stepRow.ordinal, "step ordinal");
      if (ordinal !== steps.length) {
        throw new CorruptError("operation step ordinals are not contiguous");
      }
      if (steps.length >= stepCount || steps.length >= MAX_OPERATION_STEPS) {
        throw new CorruptError("operation journal yielded too many steps");
      }
      steps.push(operationStepFromRow(stepRow));
    }
    if (steps.length !== stepCount) {
      throw new CorruptError("operation step count does not match its rows");
    }
    const state = operationMetadataFromRow(row, steps);

    const touched: MergeTouchedPath[] = [];
    let previousPath: string | null = null;
    for (const raw of this.#db.iterate(
      `SELECT ordinal,
              CASE WHEN typeof(path) = 'text'
                         AND length(CAST(path AS BLOB)) <= ${MAX_MERGE_PATH_BYTES}
                   THEN path END AS path,
              CASE WHEN typeof(logical_path) = 'text'
                         AND length(CAST(logical_path AS BLOB)) <= ${MAX_MERGE_PATH_BYTES}
                   THEN logical_path END AS logical_path,
              CASE WHEN typeof(purpose) = 'text' AND length(CAST(purpose AS BLOB)) <= 19
                   THEN purpose END AS purpose,
              index_stage, index_mode,
              CASE WHEN index_oid IS NULL THEN NULL
                   WHEN typeof(index_oid) = 'text' AND length(CAST(index_oid AS BLOB)) = 40
                   THEN index_oid ELSE 0 END AS index_oid,
              index_size, index_mtime, index_ino, index_rev,
              CASE WHEN typeof(worktree_kind) = 'text'
                         AND length(CAST(worktree_kind AS BLOB)) <= 9
                   THEN worktree_kind END AS worktree_kind,
              worktree_mode,
              CASE WHEN worktree_oid IS NULL THEN NULL
                   WHEN typeof(worktree_oid) = 'text'
                         AND length(CAST(worktree_oid AS BLOB)) = 40
                   THEN worktree_oid ELSE 0 END AS worktree_oid,
              worktree_revision
         FROM git_operation_touched WHERE checkout_id = ? ORDER BY ordinal`,
      this.#checkoutId,
    )) {
      const touchedRow: OperationTouchedRow = {
        ordinal: raw.ordinal,
        path: raw.path,
        logical_path: raw.logical_path,
        purpose: raw.purpose,
        index_stage: raw.index_stage,
        index_mode: raw.index_mode,
        index_oid: raw.index_oid,
        index_size: raw.index_size,
        index_mtime: raw.index_mtime,
        index_ino: raw.index_ino,
        index_rev: raw.index_rev,
        worktree_kind: raw.worktree_kind,
        worktree_mode: raw.worktree_mode,
        worktree_oid: raw.worktree_oid,
        worktree_revision: raw.worktree_revision,
      };
      const ordinal = requireMergeInteger(touchedRow.ordinal, "touched-path ordinal");
      if (ordinal !== touched.length) {
        throw new CorruptError("merge touched-path ordinals are not contiguous");
      }
      if (touched.length >= touchedCount || touched.length >= MAX_MERGE_TOUCHED_PATHS) {
        throw new CorruptError("merge journal yielded too many touched paths");
      }
      const entry = operationTouchedFromRow(touchedRow);
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("merge touched paths are not in strict Git path order");
      }
      touched.push(entry);
      previousPath = entry.path;
    }
    if (touched.length !== touchedCount) {
      throw new CorruptError("merge journal touched-path count does not match its rows");
    }
    const retainedBytes = operationJournalRetainedBytes(state, touched, steps);
    if (retainedBytes !== storedBytes) {
      throw new CorruptError("merge journal retained-byte count does not match its rows");
    }
    const integrityOid = requireMergeOid(row.integrity_oid, "journal integrity oid");
    reservation.set("other", operationJournalIntegrityBytes(state, steps, touched, retainedBytes));
    if (operationJournalIntegrityOid(state, touched, steps) !== integrityOid) {
      throw new CorruptError("operation journal integrity identity does not match its rows");
    }
    const journal = operationJournal(state, steps, touched, retainedBytes, integrityOid);
    this.#validateOperationObjects(journal, reservation);
    reservation.set("other", retainedBytes);
    return journal;
  }

  /** Atomically create one bounded operation journal; an existing operation wins. */
  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    if (state.kind === "rebase") {
      throw new CorruptError("rebase creation requires an explicit replay sequence");
    }
    this.writeOperationJournal(state, operationStepsForState(state), touched);
  }

  /** Atomically create a complete authenticated operation header and child rows. */
  writeOperationJournal(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    const reservation = this.reserveMemory();
    try {
      this.#writeOperationJournalOwned(state, steps, touched, reservation);
    } finally {
      reservation.dispose();
    }
  }

  #writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
    reservation: MemoryReservation,
  ): void {
    if (!this.#sharedStore.ownsMemoryReservation(reservation)) {
      throw new GitError("EINVAL", "operation journal reservation belongs to another repository");
    }
    if (state.kind === "rebase") requireInitialRebaseJournal(state, steps, touched);
    const retainedBytes = operationJournalRetainedBytes(state, touched, steps);
    reservation.set("other", operationJournalIntegrityBytes(state, steps, touched, retainedBytes));
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    reservation.set("other", retainedBytes);
    let previousPath: string | null = null;
    for (const entry of touched) {
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("operation touched paths are not in strict Git path order");
      }
      previousPath = entry.path;
    }

    this.#db.transactionSync(() => {
      const activeMemory = reservation.scope();
      try {
        const active = this.#readOperationStateOwned(activeMemory);
        if (active !== null) throw operationAlreadyActive(active.state.kind);
        const journal = operationJournal(state, steps, touched, retainedBytes, integrityOid);
        this.#validateOperationObjects(journal, reservation);
        this.#insertOperationHeader(
          state,
          steps.length,
          touched.length,
          retainedBytes,
          integrityOid,
        );
        this.#insertOperationSteps(steps, reservation);
        this.#insertOperationTouched(touched, reservation);
        bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      } finally {
        activeMemory.dispose();
      }
    });
  }

  #insertOperationHeader(
    state: OperationStateMetadata,
    stepCount: number,
    touchedCount: number,
    retainedBytes: number,
    integrityOid: string,
  ): void {
    this.#db.run(
      `INSERT INTO git_operation_state
         (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
          current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
          current_step, step_count, current_label, incoming_label, message,
          author_name, author_email, committer_name, committer_email,
          touched_count, retained_bytes, integrity_oid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.#checkoutId,
      state.kind,
      state.originalHeadRef,
      state.originalHeadOid,
      state.phase,
      state.kind === "cherry-pick" || state.kind === "revert" ? state.emptyReason : null,
      state.kind === "merge" || state.kind === "rebase" ? state.currentParentOid : null,
      state.kind === "merge" ? state.incomingParentOid : null,
      state.kind === "rebase" ? state.upstreamOid : null,
      state.kind === "rebase" ? state.baseOid : null,
      state.kind === "merge" ? state.mode : null,
      state.kind === "merge" ? state.mergeOrigin : null,
      state.kind === "rebase" ? state.currentStep : 0,
      stepCount,
      state.currentLabel,
      state.incomingLabel,
      state.message,
      state.author?.name ?? null,
      state.author?.email ?? null,
      state.committer?.name ?? null,
      state.committer?.email ?? null,
      touchedCount,
      retainedBytes,
      integrityOid,
    );
  }

  #insertOperationSteps(
    steps: readonly OperationStepMetadata[],
    reservation: MemoryReservation,
  ): void {
    function* rows(): Generator<PersistedOperationStep> {
      for (let ordinal = 0; ordinal < steps.length; ordinal++) {
        const step = steps[ordinal];
        if (step === undefined) throw new CorruptError("operation step sequence is sparse");
        yield persistedOperationStep(step, ordinal);
      }
    }
    for (const page of jsonPages(rows(), "operation step", {
      reservation,
      maxUnits: (row) =>
        256 +
        jsonStringMaxUnits(row.sourceOid) +
        (row.selectedParentOid === null ? 4 : jsonStringMaxUnits(row.selectedParentOid)) +
        jsonStringMaxUnits(row.outcome) +
        (row.resultOid === null ? 4 : jsonStringMaxUnits(row.resultOid)),
    })) {
      this.#db.run(
        `INSERT INTO git_operation_steps
           (checkout_id, ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid)
         SELECT ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.sourceOid'),
                json_extract(value, '$.selectedParentOid'),
                json_extract(value, '$.mainline'),
                json_extract(value, '$.outcome'),
                json_extract(value, '$.resultOid')
           FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
        this.#checkoutId,
        page,
      );
    }
  }

  #insertOperationTouched(
    touched: readonly MergeTouchedPath[],
    reservation: MemoryReservation,
  ): void {
    function* rows(): Generator<PersistedOperationTouched> {
      for (let ordinal = 0; ordinal < touched.length; ordinal++) {
        const entry = touched[ordinal];
        if (entry === undefined) throw new CorruptError("operation touched sequence is sparse");
        yield persistedOperationTouched(entry, ordinal);
      }
    }
    for (const page of jsonPages(rows(), "operation touched path", {
      reservation,
      maxUnits: (row) =>
        512 +
        jsonStringMaxUnits(row.path) +
        jsonStringMaxUnits(row.logicalPath) +
        jsonStringMaxUnits(row.purpose) +
        (row.indexOid === null ? 4 : jsonStringMaxUnits(row.indexOid)) +
        jsonStringMaxUnits(row.worktreeKind) +
        (row.worktreeOid === null ? 4 : jsonStringMaxUnits(row.worktreeOid)),
    })) {
      this.#db.run(
        `INSERT INTO git_operation_touched
           (checkout_id, ordinal, path, logical_path, purpose,
            index_stage, index_mode, index_oid, index_size, index_mtime,
            index_ino, index_rev, worktree_kind, worktree_mode,
            worktree_oid, worktree_revision)
         SELECT ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.path'),
                json_extract(value, '$.logicalPath'),
                json_extract(value, '$.purpose'),
                json_extract(value, '$.indexStage'),
                json_extract(value, '$.indexMode'),
                json_extract(value, '$.indexOid'),
                json_extract(value, '$.indexSize'),
                json_extract(value, '$.indexMtime'),
                json_extract(value, '$.indexIno'),
                json_extract(value, '$.indexRev'),
                json_extract(value, '$.worktreeKind'),
                json_extract(value, '$.worktreeMode'),
                json_extract(value, '$.worktreeOid'),
                json_extract(value, '$.worktreeRevision')
           FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
        this.#checkoutId,
        page,
      );
    }
  }

  #validateOperationObjects(journal: OperationJournal, reservation: MemoryReservation): void {
    const validationMemory = reservation.scope();
    const rowMemory = reservation.scope();
    const candidateCount =
      1 +
      (journal.state.kind === "merge" ? 2 : journal.state.kind === "rebase" ? 3 : 0) +
      journal.steps.length * 3 +
      journal.touched.length * 2;
    validationMemory.set("other", 512 + candidateCount * 256);
    const expected = new Map<string, ExpectedOperationObject>();
    const objectSizes = new Map<string, number>();
    const add = (object: ExpectedOperationObject): void => {
      const previous = expected.get(object.oid);
      if (previous !== undefined && previous.type !== object.type) {
        throw new CorruptError(
          `operation journal object ${object.oid} has conflicting expected types`,
        );
      }
      if (previous === undefined) expected.set(object.oid, object);
    };
    add({ oid: journal.state.originalHeadOid, type: "commit", label: "original HEAD" });
    if (journal.state.kind === "merge") {
      add({ oid: journal.state.currentParentOid, type: "commit", label: "current parent" });
      add({ oid: journal.state.incomingParentOid, type: "commit", label: "incoming parent" });
    } else if (journal.state.kind === "rebase") {
      add({ oid: journal.state.upstreamOid, type: "commit", label: "upstream" });
      add({ oid: journal.state.baseOid, type: "commit", label: "base" });
      add({ oid: journal.state.currentParentOid, type: "commit", label: "current parent" });
    }
    for (const step of journal.steps) {
      add({ oid: step.sourceOid, type: "commit", label: "step source" });
      if (step.selectedParentOid !== null) {
        add({
          oid: step.selectedParentOid,
          type: "commit",
          label: "step selected parent",
        });
      }
      if (step.resultOid !== null) {
        add({ oid: step.resultOid, type: "commit", label: "step result" });
      }
    }
    for (const entry of journal.touched) {
      if (entry.index !== null) {
        add({
          oid: entry.index.oid,
          type: entry.index.mode === 0o160000 ? "commit" : "blob",
          label: `saved index path ${entry.path}`,
        });
      }
      if (entry.worktree.kind === "file" || entry.worktree.kind === "symlink") {
        add({
          oid: entry.worktree.oid,
          type: "blob",
          label: `saved worktree path ${entry.path}`,
        });
      }
    }

    try {
      let page: string[] = [];
      const validatePage = (): void => {
        if (page.length === 0) return;
        const jsonUnits = 2 + page.length * 43 - 1;
        rowMemory.set("other", 512 + page.length * 256 + retainedStringUnits(jsonUnits));
        let info: ObjectReadInfo[];
        try {
          info = this.objectInfo(page);
        } catch (error) {
          if (hasErrorCode(error, "ENOTFOUND")) {
            throw new CorruptError("operation journal references a missing object", {
              cause: error,
            });
          }
          throw error;
        }
        for (const object of info) {
          const wanted = expected.get(object.oid);
          if (wanted === undefined || object.type !== wanted.type) {
            throw new CorruptError(
              `operation ${wanted?.label ?? "journal"} references ${object.type} object ${object.oid}`,
            );
          }
          objectSizes.set(object.oid, object.size);
        }
        page = [];
        rowMemory.clear("other");
      };
      for (const oid of expected.keys()) {
        page.push(oid);
        if (page.length === MAX_BLOB_BATCH_OIDS) validatePage();
      }
      validatePage();
      if (journal.kind !== "merge") {
        this.#validateReplayTopology(journal, reservation, objectSizes);
      }
    } finally {
      rowMemory.dispose();
      validationMemory.dispose();
    }
  }

  #validateReplayTopology(
    journal: CherryPickJournal | RevertJournal | RebaseJournal,
    reservation: MemoryReservation,
    objectSizes: ReadonlyMap<string, number>,
  ): void {
    if (journal.kind !== "rebase") {
      const step = journal.steps[0];
      if (step === undefined) throw new CorruptError("one-commit replay lost its source step");
      this.#validateOperationCommitBodies(
        [step.sourceOid],
        (_oid, source) => {
          this.#validateReplayParentSelection(step, source.commit.parent);
        },
        reservation,
        objectSizes,
      );
      return;
    }
    let expectedSourceParent = journal.state.baseOid;
    let sourceOrdinal = 0;
    this.#validateOperationCommitBodies(
      journal.steps.map((step) => step.sourceOid),
      (_oid, source) => {
        const step = journal.steps[sourceOrdinal++];
        if (step === undefined) throw new CorruptError("rebase source sequence is incomplete");
        const parents = source.commit.parent;
        if (
          parents.length !== 1 ||
          parents[0] !== expectedSourceParent ||
          step.selectedParentOid !== expectedSourceParent ||
          step.mainline !== null
        ) {
          throw new CorruptError("rebase source steps are not an oldest-first linear sequence");
        }
        expectedSourceParent = step.sourceOid;
      },
      reservation,
      objectSizes,
    );
    if (expectedSourceParent !== journal.state.originalHeadOid) {
      throw new CorruptError("rebase source sequence does not end at the original HEAD");
    }

    const applied = journal.steps.filter((step) => step.outcome === "applied");
    let expectedResultParent = journal.state.upstreamOid;
    let resultOrdinal = 0;
    this.#validateOperationCommitBodies(
      applied.map((step) => {
        if (step.resultOid === null) throw new CorruptError("applied rebase step lost its result");
        return step.resultOid;
      }),
      (_oid, result) => {
        const step = applied[resultOrdinal++];
        if (step === undefined || step.resultOid === null) {
          throw new CorruptError("rebase result sequence is incomplete");
        }
        if (result.commit.parent.length !== 1 || result.commit.parent[0] !== expectedResultParent) {
          throw new CorruptError("applied rebase result has an invalid replay parent");
        }
        expectedResultParent = step.resultOid;
      },
      reservation,
      objectSizes,
    );
  }

  #validateOperationCommitBodies(
    oids: readonly string[],
    visit: (oid: string, commit: CommitCacheEntry) => void,
    reservation: MemoryReservation,
    objectSizes: ReadonlyMap<string, number>,
  ): void {
    const seen = new Set<string>();
    const objectMemory = reservation.scope();
    const parserMemory = reservation.scope();
    try {
      for (let offset = 0; offset < oids.length; offset += MAX_BLOB_BATCH_OIDS) {
        const page = oids.slice(offset, offset + MAX_BLOB_BATCH_OIDS);
        objectMemory.set(
          "other",
          256 +
            page.length * (8 + 160) +
            page.reduce((bytes, oid) => bytes + retainedStringBytes(oid), 0),
        );
        for (const oid of page) {
          if (seen.has(oid)) throw new CorruptError("operation commit sequence contains a cycle");
          seen.add(oid);
        }
        let remaining = page;
        while (remaining.length > 0) {
          for (const oid of remaining) {
            if (objectSizes.get(oid) === undefined) {
              throw new CorruptError(`operation commit ${oid} lost its validated size`);
            }
          }
          const batchMemory = objectMemory.scope();
          try {
            const batch = this.#readObjectsOwned(
              remaining,
              { budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES },
              batchMemory,
            );
            remaining = [];
            objectMemory.clear("other");
            if (batch.objects.size === 0 || batch.bytes <= 0) {
              throw new CorruptError("operation commit validation made no progress");
            }
            for (const [oid, object] of batch.objects) {
              if (object.type !== "commit") {
                throw new CorruptError("operation step did not produce a complete commit object");
              }
              visit(
                oid,
                prepareCommitCacheOwned(
                  { repoId: this.#repoId, oid, data: object.data },
                  parserMemory,
                ),
              );
              parserMemory.clear("commit");
            }
            const nextRemaining = batch.remaining;
            objectMemory.set(
              "other",
              256 +
                nextRemaining.length * (8 + 160) +
                nextRemaining.reduce((bytes, oid) => bytes + retainedStringBytes(oid), 0),
            );
            remaining = nextRemaining;
          } finally {
            batchMemory.dispose();
          }
        }
        objectMemory.clear("other");
      }
    } finally {
      parserMemory.dispose();
      objectMemory.dispose();
    }
  }

  #validateReplayParentSelection(step: OperationStepMetadata, parents: readonly string[]): void {
    if (parents.length === 0) {
      if (step.selectedParentOid !== null || step.mainline !== null) {
        throw new CorruptError("root replay source retained a selected parent or mainline");
      }
      return;
    }
    if (parents.length === 1) {
      if (
        step.selectedParentOid !== parents[0] ||
        (step.mainline !== null && step.mainline !== 1)
      ) {
        throw new CorruptError("single-parent replay selection differs from its source commit");
      }
      return;
    }
    if (
      step.mainline === null ||
      step.mainline > parents.length ||
      step.selectedParentOid !== parents[step.mainline - 1]
    ) {
      throw new CorruptError("merge replay selection differs from its source commit");
    }
  }

  /** Replace authenticated metadata while retaining the exact touched snapshot. */
  replaceOperationState(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    const reservation = this.reserveMemory();
    try {
      this.#replaceOperationStateOwned(expectedIntegrityOid, state, reservation);
    } finally {
      reservation.dispose();
    }
  }

  #replaceOperationStateOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    reservation: MemoryReservation,
  ): void {
    if (!this.#sharedStore.ownsMemoryReservation(reservation)) {
      throw new GitError("EINVAL", "operation journal reservation belongs to another repository");
    }
    if (state.kind === "rebase") {
      throw new GitError("EOPMISMATCH", "rebase replacement requires a whole-journal transition");
    }
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    this.#db.transactionSync(() => {
      const currentMemory = reservation.scope();
      try {
        const current = this.#readOperationStateOwned(currentMemory);
        if (current === null) throw operationNotActive(state.kind);
        if (current.state.kind !== state.kind) {
          throw operationKindMismatch(state.kind, current.state.kind);
        }
        if (current.integrityOid !== expectedIntegrityOid) {
          throw new GitError("EOPMISMATCH", "operation state changed before replacement");
        }
        const retainedBytes = operationJournalRetainedBytes(state, current.touched, current.steps);
        reservation.set(
          "other",
          operationJournalIntegrityBytes(state, current.steps, current.touched, retainedBytes),
        );
        const integrityOid = operationJournalIntegrityOid(state, current.touched, current.steps);
        reservation.set("other", retainedBytes);
        this.#validateOperationObjects(
          operationJournal(state, current.steps, current.touched, retainedBytes, integrityOid),
          reservation,
        );
        this.#db.run(
          `UPDATE git_operation_state
            SET original_head_ref = ?, original_head_oid = ?, phase = ?, empty_reason = ?,
                current_parent_oid = ?, incoming_parent_oid = ?, upstream_oid = ?, base_oid = ?,
                mode = ?, merge_origin = ?, current_step = ?, current_label = ?, incoming_label = ?,
                message = ?, author_name = ?, author_email = ?, committer_name = ?,
                committer_email = ?, retained_bytes = ?, integrity_oid = ?
          WHERE checkout_id = ? AND integrity_oid = ?`,
          state.originalHeadRef,
          state.originalHeadOid,
          state.phase,
          state.kind === "cherry-pick" || state.kind === "revert" ? state.emptyReason : null,
          state.kind === "merge" ? state.currentParentOid : null,
          state.kind === "merge" ? state.incomingParentOid : null,
          null,
          null,
          state.kind === "merge" ? state.mode : null,
          state.kind === "merge" ? state.mergeOrigin : null,
          0,
          state.currentLabel,
          state.incomingLabel,
          state.message,
          state.author?.name ?? null,
          state.author?.email ?? null,
          state.committer?.name ?? null,
          state.committer?.email ?? null,
          retainedBytes,
          integrityOid,
          this.#checkoutId,
          expectedIntegrityOid,
        );
        bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      } finally {
        currentMemory.dispose();
      }
    });
  }

  /** Compare-and-swap one complete journal transition, including child rows. */
  replaceOperationJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    const reservation = this.reserveMemory();
    try {
      this.#replaceOperationJournalOwned(expectedIntegrityOid, state, steps, touched, reservation);
    } finally {
      reservation.dispose();
    }
  }

  #replaceOperationJournalOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
    reservation: MemoryReservation,
  ): void {
    if (!this.#sharedStore.ownsMemoryReservation(reservation)) {
      throw new GitError("EINVAL", "operation journal reservation belongs to another repository");
    }
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    const retainedBytes = operationJournalRetainedBytes(state, touched, steps);
    reservation.set("other", operationJournalIntegrityBytes(state, steps, touched, retainedBytes));
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    reservation.set("other", retainedBytes);
    let previousPath: string | null = null;
    for (const entry of touched) {
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("operation touched paths are not in strict Git path order");
      }
      previousPath = entry.path;
    }
    this.#db.transactionSync(() => {
      const currentMemory = reservation.scope();
      try {
        const current = this.#readOperationStateOwned(currentMemory);
        if (current === null) throw operationNotActive(state.kind);
        if (current.kind !== state.kind) throw operationKindMismatch(state.kind, current.kind);
        if (current.integrityOid !== expectedIntegrityOid) {
          throw new GitError("EOPMISMATCH", "operation state changed before replacement");
        }
        if (current.kind === "rebase") {
          if (state.kind !== "rebase") throw operationKindMismatch(state.kind, current.kind);
          requireRebaseJournalTransition(current, state, steps, touched);
        }
        const journal = operationJournal(state, steps, touched, retainedBytes, integrityOid);
        this.#validateOperationObjects(journal, reservation);
        this.#db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.#checkoutId);
        this.#db.run("DELETE FROM git_operation_steps WHERE checkout_id = ?", this.#checkoutId);
        this.#db.run(
          "DELETE FROM git_operation_state WHERE checkout_id = ? AND integrity_oid = ?",
          this.#checkoutId,
          expectedIntegrityOid,
        );
        this.#insertOperationHeader(
          state,
          steps.length,
          touched.length,
          retainedBytes,
          integrityOid,
        );
        this.#insertOperationSteps(steps, reservation);
        this.#insertOperationTouched(touched, reservation);
        bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      } finally {
        currentMemory.dispose();
      }
    });
  }

  /** Clear operation metadata and touched snapshots, including corrupt orphans. */
  clearOperationState(): boolean {
    return this.#db.transactionSync(() => {
      const existed = requireBooleanProbe(
        this.#db.scalar<unknown>(
          `SELECT EXISTS(
             SELECT 1 FROM git_operation_state WHERE checkout_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_steps WHERE checkout_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_touched WHERE checkout_id = ? LIMIT 1
           )`,
          this.#checkoutId,
          this.#checkoutId,
          this.#checkoutId,
        ),
        "operation state clear probe",
      );
      this.#db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.#checkoutId);
      this.#db.run("DELETE FROM git_operation_steps WHERE checkout_id = ?", this.#checkoutId);
      this.#db.run("DELETE FROM git_operation_state WHERE checkout_id = ?", this.#checkoutId);
      if (existed) bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      return existed;
    });
  }

  /** Refuse an operation that cannot coexist with an incomplete operation. */
  requireNoOperationState(): void {
    const active = this.readOperationState();
    if (active !== null) throw operationAlreadyActive(active.state.kind);
  }

  requireOperationState(kind: "merge"): MergeOperationJournal;
  requireOperationState(kind: "cherry-pick"): CherryPickJournal;
  requireOperationState(kind: "revert"): RevertJournal;
  requireOperationState(kind: "rebase"): RebaseJournal;
  requireOperationState(kind: OperationKind): OperationJournal;
  requireOperationState(kind: OperationKind): OperationJournal {
    const journal = this.readOperationState();
    if (journal === null) throw operationNotActive(kind);
    if (journal.kind !== kind) throw operationKindMismatch(kind, journal.kind);
    if (journal.kind === "merge") return journal;
    if (journal.kind === "cherry-pick") return journal;
    if (journal.kind === "revert") return journal;
    return journal;
  }

  /** Merge-specific compatibility wrappers preserve the existing surface. */
  readMergeState(): MergeJournal | null {
    const journal = this.readOperationState();
    if (journal === null) return null;
    if (journal.kind !== "merge") {
      throw operationKindMismatch("merge", journal.kind);
    }
    return mergeJournalFromOperation(journal);
  }

  writeMergeState(state: MergeStateMetadata, touched: readonly MergeTouchedPath[]): void {
    this.writeOperationState(mergeOperationState(state), touched);
  }

  clearMergeState(): boolean {
    return this.clearOperationState();
  }

  requireNoMergeState(): void {
    this.requireNoOperationState();
  }

  requireMergeState(): MergeJournal {
    return mergeJournalFromOperation(this.requireOperationState("merge"));
  }

  // -- index ----------------------------------------------------------

  /** Create clone state only while every index stage is still empty. */
  tryCreateInitialState<T>(body: (session: InitialStateSession) => T): InitialStateResult<T> {
    return this.#db.transactionSync(() => {
      const exists = this.#db.scalar<number>(
        "SELECT EXISTS(SELECT 1 FROM git_index WHERE checkout_id = ? LIMIT 1)",
        this.#checkoutId,
      );
      if (exists !== 0 && exists !== 1) {
        throw new CorruptError("initial index availability probe returned an invalid value");
      }
      if (exists === 1) return { available: false };

      const reservation = this.reserveMemory();
      let active = true;
      let failed = false;
      let failure: unknown;
      let previousPath: string | null = null;
      let pending: IndexMutationBuffer | null = null;
      let blobIds: InitialBlobIdBuffer | null = null;
      try {
        reservation.set("other", INITIAL_STATE_CONSTRUCTOR_BYTES);
        pending = new IndexMutationBuffer(DEFAULT_INDEX_FLUSH, (mutations) => {
          this.#applyIndexMutations(mutations);
        });
        blobIds = new InitialBlobIdBuffer(this.#db, this.#repoId);
        const mutationBuffer = pending;
        const blobBuffer = blobIds;
        const requireActive = (): void => {
          if (!active) throw new Error("initial state session is no longer active");
          if (failed) throw failure;
        };
        const attempt = (operation: () => void): void => {
          requireActive();
          try {
            operation();
          } catch (error) {
            failed = true;
            failure = error;
            throw error;
          }
        };
        const reservedBytes = (): number =>
          INITIAL_STATE_FIXED_BYTES +
          mutationBuffer.reservedBytes +
          blobBuffer.reservedBytes +
          (previousPath?.length ?? 0) * 2;
        const reserve = (bytes: number): boolean => {
          try {
            reservation.set("other", bytes);
            return true;
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              Reflect.get(error, "code") === "E2BIG"
            ) {
              return false;
            }
            throw error;
          }
        };
        const requireRoom = (additional: number, first: "index" | "blob"): void => {
          if (reserve(reservedBytes() + additional)) return;
          if (first === "index") mutationBuffer.flush();
          else blobBuffer.flush();
          if (reserve(reservedBytes() + additional)) return;
          if (first === "index") blobBuffer.flush();
          else mutationBuffer.flush();
          reservation.set("other", reservedBytes() + additional);
        };
        const session: InitialStateSession = {
          get retainedBytes() {
            return active ? reservedBytes() : 0;
          },
          put: (entry) => {
            attempt(() => {
              const pathJsonBytes = validateInitialIndexEntry(entry);
              if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
                throw new CorruptError("initial index entries are not in strict Git path order");
              }
              const mutationJsonBytes = pathJsonBytes + 512;
              requireRoom(
                mutationJsonBytes * 4 + INDEX_MUTATION_ROW_BYTES + entry.path.length * 2,
                "index",
              );
              mutationBuffer.add(entry);
              previousPath = entry.path;
              reservation.set("other", reservedBytes());
            });
          },
          addBlobId: (mapping) => {
            attempt(() => {
              blobBuffer.validate(mapping);
              if (!blobBuffer.willCache(mapping)) return;
              if (blobBuffer.needsFlush(mapping)) blobBuffer.flush();
              requireRoom(blobBuffer.additionalReservedBytes(), "blob");
              blobBuffer.add(mapping);
              reservation.set("other", reservedBytes());
            });
          },
        };
        const finish = (): void => {
          attempt(() => mutationBuffer.flush());
          reservation.set("other", reservedBytes());
          attempt(() => blobBuffer.finish());
          reservation.set("other", reservedBytes());
        };

        const value = body(session);
        requireActive();
        if (isThenableResult(value)) {
          void Promise.resolve(value).catch(() => {});
          throw new Error("initial state body returned an asynchronous result");
        }
        finish();
        // Blob-id cache writes alone do not change maintenance roots.
        if (previousPath !== null) bumpMaintenanceRootEpoch(this.#db, this.#repoId);
        return { available: true, value };
      } finally {
        active = false;
        pending?.dispose();
        blobIds?.dispose();
        previousPath = null;
        failure = undefined;
        reservation.dispose();
      }
    });
  }

  indexEntries(): IndexEntry[] {
    return this.#db
      .all<Record<string, unknown>>(
        "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id = ? ORDER BY path, stage",
        this.#checkoutId,
      )
      .map(requireStoredIndexEntry);
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    const row = this.#db.one<Record<string, unknown>>(
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id = ? AND path = ? AND stage = ?",
      this.#checkoutId,
      path,
      stage,
    );
    return row === undefined ? null : requireStoredIndexEntry(row);
  }

  indexPut(entry: IndexEntry): void {
    this.#db.transactionSync(() => {
      this.#db.run(
        `INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkout_id, path, stage) DO UPDATE SET
           mode = excluded.mode, oid = excluded.oid, size = excluded.size,
           mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
        this.#checkoutId,
        entry.path,
        entry.stage,
        entry.mode,
        entry.oid,
        entry.size,
        entry.mtime,
        entry.ino,
        entry.rev ?? null,
      );
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
    });
  }

  /** Remove every stage of `path`. */
  indexRemove(path: string): void {
    this.#db.transactionSync(() => {
      this.#db.run(
        "DELETE FROM git_index WHERE checkout_id = ? AND path = ?",
        this.#checkoutId,
        path,
      );
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
    });
  }

  indexClear(): void {
    this.#db.transactionSync(() => {
      this.#db.run("DELETE FROM git_index WHERE checkout_id = ?", this.#checkoutId);
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
    });
  }

  #applyIndexMutations(pending: readonly BufferedIndexMutation[]): void {
    // Delete touched paths first, then retain only puts after their last remove.
    const hasRemoves = pending.some((item) => item.kind === "r");
    const hasPuts = pending.some((item) => item.kind === "p");
    const mutations = `[${pending.map((item) => item.json).join(",")}]`;
    if (hasRemoves) {
      this.#db.run(
        `DELETE FROM git_index
          WHERE checkout_id = ?
            AND path IN (
              SELECT json_extract(value, '$.p') FROM json_each(?)
               WHERE json_extract(value, '$.k') = 'r'
            )`,
        this.#checkoutId,
        mutations,
      );
    }
    if (!hasPuts) return;
    this.#db.run(
      `WITH mutation AS (
         SELECT CAST(j.key AS INTEGER) AS q,
                json_extract(j.value, '$.k') AS kind,
                json_extract(j.value, '$.p') AS path,
                json_extract(j.value, '$.g') AS stage,
                json_extract(j.value, '$.m') AS mode,
                json_extract(j.value, '$.o') AS oid,
                json_extract(j.value, '$.s') AS size,
                json_extract(j.value, '$.t') AS mtime,
                json_extract(j.value, '$.i') AS ino,
                json_extract(j.value, '$.r') AS rev
           FROM json_each(?) j
       ), ranked AS (
         SELECT mutation.*,
                max(CASE WHEN kind = 'r' THEN q ELSE -1 END)
                  OVER (PARTITION BY path) AS last_remove,
                max(CASE WHEN kind = 'p' THEN q ELSE -1 END)
                  OVER (PARTITION BY path, stage) AS last_put
           FROM mutation
       )
       INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, current.path, current.stage, current.mode, current.oid,
              current.size, current.mtime, current.ino, current.rev
         FROM ranked current
        WHERE current.kind = 'p'
          AND current.q = current.last_put
          AND current.q > current.last_remove
        ORDER BY current.q
       ON CONFLICT(checkout_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      mutations,
      this.#checkoutId,
    );
  }

  /**
   * Replace the whole index from a stream. Bounded by the flush size, not by
   * the length of `entries`, so a full reset never materialises the tree.
   */
  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    let first = true;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.#db.transactionSync(() => {
        if (first) this.#db.run("DELETE FROM git_index WHERE checkout_id = ?", this.#checkoutId);
        this.#applyIndexMutations(mutations);
        bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      });
      first = false;
    });
    for (const entry of entries) pending.add(entry);
    pending.flush();
    if (first) this.indexClear();
  }

  /**
   * Index rows in (path, stage) order, one bounded page at a time.
   *
   * Keyset paging must carry the stage: the key is (path, stage), so a page
   * boundary falling between stage 0 and stage 2 of one path would drop a row
   * if the cursor were the path alone.
   *
   * CONTRACT: a caller may mutate only paths at or behind the frontier it has
   * already been handed. Each page is a fresh query, so a row written ahead of
   * the frontier would be observed by this scan; a row written behind it would
   * not. `indexApply` is the shape that makes obeying this the easy path.
   */
  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    const pageSize = requireIndexPageSize(options.pageSize ?? DEFAULT_INDEX_PAGE);
    const prefix = options.prefix;
    let path = options.after?.path ?? "";
    let stage = options.after?.stage ?? -1;

    for (;;) {
      const page =
        prefix === undefined || prefix === ""
          ? this.#db.all<Record<string, unknown>>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index
               WHERE checkout_id = ? AND (path > ? OR (path = ? AND stage > ?))
               ORDER BY path, stage LIMIT ?`,
              this.#checkoutId,
              path,
              path,
              stage,
              pageSize,
            )
          : this.#db.all<Record<string, unknown>>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index
               WHERE checkout_id = ? AND (path > ? OR (path = ? AND stage > ?))
                 AND (path = ? OR (path >= ? AND path < ?))
               ORDER BY path, stage LIMIT ?`,
              this.#checkoutId,
              path,
              path,
              stage,
              prefix,
              `${prefix}/`,
              nextPrefix(`${prefix}/`),
              pageSize,
            );
      if (page.length === 0) return;
      let last: IndexEntry | undefined;
      for (const row of page) {
        const entry = requireStoredIndexEntry(row);
        last = entry;
        yield entry;
      }
      if (last === undefined) throw new CorruptError("checkout index page lost its last row");
      path = last.path;
      stage = last.stage;
      if (page.length < pageSize) return;
    }
  }

  /**
   * Run `body` with a bounded, ordered mutation sink. Mutations are buffered
   * and applied in batches of `flushEvery`, each batch one transaction, so a
   * staging pass over a large index never holds every change it made.
   */
  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.#db.transactionSync(() => {
        this.#applyIndexMutations(mutations);
        bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      });
    });
    const sink: IndexSink = {
      put: (entry) => pending.add(entry),
      remove: (path) => pending.add(path),
      flush: () => pending.flush(),
    };
    const result = body(sink);
    pending.flush();
    return result;
  }

  /** True when any entry sits at a merge stage. */
  hasConflicts(): boolean {
    return (
      (this.#db.scalar<number>(
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_index WHERE checkout_id = ? AND stage > 0 LIMIT 1)",
        this.#checkoutId,
      ) ?? 0) > 0
    );
  }

  /** True when checkout would encounter a merge stage or stage-zero gitlink. */
  hasCheckoutBlockingIndexEntries(): boolean {
    return (
      (this.#db.scalar<number>(
        `SELECT COUNT(*) FROM (
           SELECT 1 FROM git_index
            WHERE checkout_id = ? AND (stage > 0 OR (stage = 0 AND mode = 57344)) LIMIT 1
         )`,
        this.#checkoutId,
      ) ?? 0) > 0
    );
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
    return new Set(
      this.#db
        .all<{ oid: string }>("SELECT oid FROM git_shallow WHERE repo_id = ?", this.#repoId)
        .map((row) => row.oid),
    );
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    const checked = function* (oids: Iterable<string>): Generator<string> {
      for (const oid of oids) {
        if (!isOid(oid)) throw new CorruptError(`invalid shallow object id ${oid}`);
        yield oid;
      }
    };
    this.#db.transactionSync(() => {
      const shallowRevision = requireFetchGeneration(
        this.#db.scalar<unknown>(
          "SELECT shallow_revision FROM git_repositories WHERE id = ?",
          this.#repoId,
        ),
        "stored shallow revision",
        0,
      );
      let mutated = false;
      for (const page of jsonPages(checked(remove), "shallow deletion")) {
        mutated = true;
        this.#db.run(
          "DELETE FROM git_shallow WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(checked(add), "shallow update")) {
        mutated = true;
        this.#db.run(
          `INSERT OR IGNORE INTO git_shallow (repo_id, oid)
           SELECT ?, value FROM json_each(?)`,
          this.#repoId,
          page,
        );
      }
      if (mutated) {
        this.#advanceShallowRevision(shallowRevision);
        bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      }
    });
    this.shared.invalidateShallow();
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

  #objectCacheKey(oid: string): string {
    return this.shared.objectCacheKey(oid);
  }
}

/** The exclusive upper bound of a string prefix range. */
export function nextPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

export function requireConfigSectionPrefix(value: string, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError("EINVAL", `config section ${label} is required`);
  }
  boundedCanonicalUtf8Bytes(value, MAX_INDEX_PATH_BYTES, `config section ${label}`);
  if (value === "." || value.startsWith(".") || !value.endsWith(".") || value.includes("..")) {
    throw new GitError("EINVAL", `config section ${label} is not a canonical dotted prefix`);
  }
  return value;
}

export function boundedCanonicalUtf8Bytes(value: string, limit: number, label: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new GitError("EINVAL", `${label} contains an invalid character`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
      }
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) throw new GitError("E2BIG", `${label} exceeds ${limit} UTF-8 bytes`);
  }
  return bytes;
}

export function configSectionMetadataSql(): string {
  return `SELECT
                CASE WHEN typeof(repo_id) = 'integer' THEN repo_id END AS repo_id,
                typeof(path) AS path_type,
                length(CAST(path AS BLOB)) AS path_bytes,
                CASE WHEN typeof(path) = 'text'
                           AND length(CAST(path AS BLOB)) BETWEEN 1 AND ${MAX_INDEX_PATH_BYTES}
                     THEN path END AS path,
                typeof(seq) AS seq_type,
                CASE WHEN typeof(seq) = 'integer' THEN seq END AS seq,
                typeof(value) AS value_type,
                length(CAST(value AS BLOB)) AS value_bytes
           FROM git_config
          WHERE repo_id = ? AND path >= ? AND path < ?
          ORDER BY path COLLATE BINARY, seq
          LIMIT ${MAX_CONFIG_SECTION_MOVE_ROWS + 1}`;
}

export function requireConfigSectionMetadata(
  row: Record<string, unknown>,
  repoId: number,
  prefix: string,
): ConfigSectionCandidateMetadata {
  if (row.repo_id !== repoId) {
    throw new CorruptError("config section scan crossed repository boundaries");
  }
  if (
    row.path_type !== "text" ||
    typeof row.path !== "string" ||
    typeof row.path_bytes !== "number" ||
    !Number.isSafeInteger(row.path_bytes) ||
    row.path_bytes < 1 ||
    row.path_bytes > MAX_INDEX_PATH_BYTES ||
    !row.path.startsWith(prefix)
  ) {
    throw new CorruptError(`config section ${prefix} has an invalid stored path`);
  }
  if (
    row.seq_type !== "integer" ||
    typeof row.seq !== "number" ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 0
  ) {
    throw new CorruptError(`config section ${prefix} has an invalid sequence`);
  }
  const valueBytes =
    typeof row.value_bytes === "number" && Number.isSafeInteger(row.value_bytes)
      ? row.value_bytes
      : null;
  return {
    path: row.path,
    seq: row.seq,
    pathBytes: row.path_bytes,
    valueType: row.value_type,
    valueBytes,
  };
}

export function configSectionVariable(path: string, prefix: string): string | null {
  const variable = path.slice(prefix.length);
  if (variable === "") {
    throw new CorruptError(`config section ${prefix} has an empty variable name`);
  }
  return variable.includes(".") ? null : variable;
}

export function configSectionDestinationBytes(destination: string, variable: string): number {
  const destinationBytes = boundedCanonicalUtf8Bytes(
    destination,
    MAX_INDEX_PATH_BYTES,
    "config section destination",
  );
  const remaining = MAX_INDEX_PATH_BYTES - destinationBytes;
  let variableBytes: number;
  try {
    variableBytes = boundedCanonicalUtf8Bytes(variable, remaining, "moved config variable");
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    throw new CorruptError("config section has an invalid stored variable name", { cause: error });
  }
  return destinationBytes + variableBytes;
}

export function decodeCanonicalText(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = CANONICAL_TEXT_DECODER.decode(bytes);
  } catch (error) {
    throw new CorruptError(`${label} is not canonical UTF-8`, { cause: error });
  }
  const canonical = JSON_ENCODER.encode(value);
  if (canonical.byteLength !== bytes.byteLength) {
    throw new CorruptError(`${label} is not canonical UTF-8`);
  }
  for (let index = 0; index < canonical.byteLength; index++) {
    if (canonical[index] !== bytes[index]) {
      throw new CorruptError(`${label} is not canonical UTF-8`);
    }
  }
  return value;
}

export function requireStoredTextBytes(type: unknown, value: unknown, label: string): Uint8Array {
  if (type !== "text") throw new CorruptError(`${label} has an invalid stored type`);
  try {
    return readBlob(value);
  } catch (error) {
    throw new CorruptError(`${label} has an invalid text BLOB`, { cause: error });
  }
}

export function compareByteArrays(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index++) {
    const leftByte = left[index] ?? -1;
    const rightByte = right[index] ?? -1;
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}

export function decodeCanonicalStoredText(value: unknown, label: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readBlob(value);
  } catch (error) {
    throw new CorruptError(`${label} has an invalid text BLOB`, { cause: error });
  }
  return decodeCanonicalText(bytes, label);
}

export function requireCanonicalStoredText(type: unknown, value: unknown, label: string): string {
  if (type !== "text") throw new CorruptError(`${label} has an invalid stored type`);
  return decodeCanonicalStoredText(value, label);
}

export function requireNullableCanonicalStoredText(
  type: unknown,
  value: unknown,
  label: string,
): string | null {
  if (type === "null" && value === null) return null;
  if (type !== "text" || value === null) {
    throw new CorruptError(`${label} has an invalid stored type`);
  }
  return decodeCanonicalStoredText(value, label);
}
