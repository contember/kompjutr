// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import pako from "pako";
import { blob, readBlob, type SqlDatabase } from "../../db/db.js";
import { concat, isOid, toHex } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode, ObjectNotFoundError } from "../common/errors.js";
import type { ByteLru } from "../common/lru.js";
import { hashObject, type ObjectType, objectHeader, type RawObject } from "../common/objects.js";
import { hasCanonicalRefSyntax } from "../common/ref-name.js";
import {
  expectSafeInteger,
  expectText,
  int,
  nullable,
  OptionsSchema,
  oneOf,
  RowShape,
  text,
} from "../common/rows.js";
import { Sha1 } from "../common/sha1.js";
import { comparePaths } from "../common/streams.js";
import { deflate, InflateInto, InflateSizeError, InflateStream } from "../common/zlib.js";
import { BLOB_ID_CACHE_ELIGIBILITY_BYTES, BLOB_ID_GENERATION_EXHAUSTED } from "./blob-id-cache.js";
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
import { FetchPublicationToken, TrackingRefPublicationToken } from "./contracts.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import {
  type CherryPickJournal,
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_PATH_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  MAX_OPERATION_STEPS,
  type MergeIndexSnapshot,
  type MergeJournal,
  type MergeOperationJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  type MergeWorktreeSnapshot,
  mergeJournalFromOperation,
  mergeOperationState,
  type OperationJournal,
  type OperationKind,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationAlreadyActive,
  operationJournalIntegrityOid,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type RebaseJournal,
  type RebaseStateMetadata,
  type RevertJournal,
  requireMergeInteger,
  requireMergeMode,
  requireMergeNullableInteger,
  requireMergeOid,
  requireMergeOrigin,
  requireMergePhase,
  requireMergePurpose,
  requireMergeText,
} from "./operations.js";
import { MAX_PACK_DELTA_WORKING_BYTES, PACK_BLOB_BATCH_TARGET_BYTES, PackStore } from "./packs.js";
import {
  rawSymbolicTarget,
  refTextBytes,
  requireRawRefTarget,
  requireRefName,
} from "./ref-validation.js";
import {
  MAX_REFLOG_ORDINAL,
  MAX_REFLOG_STATE_ROWS,
  MAX_REFLOG_TIMEZONE_MINUTES,
} from "./reflog-schema.js";
import {
  MAX_CHECKOUTS_PER_REPOSITORY,
  MAX_INDEX_PATH_BYTES,
  MAX_SCRATCH_INDEX_NAME_BYTES,
  MAX_TRACKING_REF_REVISIONS,
} from "./schema.js";
import type { SharedRepoOwnedOperations, SharedRepoStore } from "./shared.js";
import { indexSeededTreeSource, indexSeededTreeSources } from "./tree-index.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "./tree-walk.js";

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
/** Parsed commits staged beside encoded object bytes before a batch flush. */
export const COMMIT_STAGE_CACHE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
export const REFLOG_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const REFLOG_RETENTION_ROWS = 1_024;
export const MAX_REFLOG_ROOT_SCAN_ENTRIES = 9_727;
export const MAX_REF_MUTATION_INPUTS = 100_000;
export const MAX_FETCH_NAMESPACES = 1_024;
export const MAX_FETCH_PUBLICATION_INPUTS = 100_000;
export const CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES = 1_024;
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
/** Conservative SQL ceiling for one direct-ref or raw-HEAD publication. */

export interface ConfigSectionCandidateMetadata {
  readonly path: string;
  readonly seq: number;
}

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

export type OwnedConfigGet = (path: string) => string | undefined;

export const OWNED_CONFIG_GETTERS = new WeakMap<SharedRepoStore, OwnedConfigGet>();

/** Internal last-value config read through the shared repository seam. */
export function configGetOwned(store: SharedRepoStore, path: string): string | undefined {
  const get = OWNED_CONFIG_GETTERS.get(store);
  if (get === undefined)
    throw new GitError("EINVAL", "shared repository operations are unavailable");
  return get(path);
}

export interface OwnedOperationJournalAccess {
  read(): OperationJournal | null;
  write(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void;
  replaceState(expectedIntegrityOid: string, state: OperationStateMetadata): void;
  replaceJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void;
}

export const OWNED_OPERATION_JOURNALS = new WeakMap<CheckoutStore, OwnedOperationJournalAccess>();

export function operationJournalAccess(store: CheckoutStore): OwnedOperationJournalAccess {
  const access = OWNED_OPERATION_JOURNALS.get(store);
  if (access === undefined) throw new GitError("EINVAL", "checkout store is not active");
  return access;
}

/** Internal journal read through the installed checkout seam. */
export function readOperationStateOwned(store: CheckoutStore): OperationJournal | null {
  return operationJournalAccess(store).read();
}

/** Internal journal creation through the installed checkout seam. */
export function writeOperationJournalOwned(
  store: CheckoutStore,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  operationJournalAccess(store).write(state, steps, touched);
}

/** Internal metadata replacement through the installed checkout seam. */
export function replaceOperationStateOwned(
  store: CheckoutStore,
  expectedIntegrityOid: string,
  state: OperationStateMetadata,
): void {
  operationJournalAccess(store).replaceState(expectedIntegrityOid, state);
}

/** Internal whole-journal replacement through the installed checkout seam. */
export function replaceOperationJournalOwned(
  store: CheckoutStore,
  expectedIntegrityOid: string,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  operationJournalAccess(store).replaceJournal(expectedIntegrityOid, state, steps, touched);
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

const CHECKOUT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  root: text(),
  head: text(),
  is_primary: oneOf([0, 1]),
});

const REFLOG_ENTRY_ROW = new RowShape({
  ref_name: text(),
  ordinal: int(1, MAX_REFLOG_ORDINAL),
  old_raw: nullable(text()),
  new_raw: nullable(text()),
  old_oid: nullable(text()),
  new_oid: nullable(text()),
  actor_name: nullable(text()),
  actor_email: nullable(text()),
  timestamp: int(0, MAX_REFLOG_ORDINAL),
  timezone: int(-MAX_REFLOG_TIMEZONE_MINUTES, MAX_REFLOG_TIMEZONE_MINUTES),
  reason: text(),
});

const INDEX_ENTRY_FIELDS = {
  path: text(),
  stage: int(0, 3),
  mode: oneOf([0o100644, 0o100755, 0o120000, 0o160000]),
  oid: text(),
  size: nullable(int(0)),
  mtime: nullable(int(0)),
  ino: nullable(int(0)),
  rev: nullable(int(0)),
};

const INDEX_ENTRY_ROW = new RowShape(INDEX_ENTRY_FIELDS);
const INDEX_ENTRY_INPUT = new OptionsSchema(INDEX_ENTRY_FIELDS, "index scan row is invalid");

const REF_ROW = new RowShape({ name: text(), target: text() });
const CONFIG_SECTION_ROW = new RowShape({ path: text(), seq: int(0) });
const OBJECT_READ_ROW = new RowShape({
  source: nullable(oneOf(["loose", "pack"])),
  type: nullable(oneOf(["blob", "tree", "commit", "tag"])),
  size: nullable(int(0)),
  stored: nullable(oneOf(["raw", "zlib"])),
});
const OBJECT_INFO_ROW = new RowShape({
  source: nullable(oneOf(["loose", "pack"])),
  type: nullable(oneOf(["blob", "tree", "commit", "tag"])),
  size: nullable(int(0)),
  stored: nullable(oneOf(["raw", "zlib"])),
  chunk_rows: int(0),
  first_chunk: nullable(int(0)),
  last_chunk: nullable(int(0)),
  largest_chunk: int(0),
  stored_bytes: int(0),
});

/** Stable, collision-free key for an opaque binary content id. */
export function contentIdKey(contentId: Uint8Array): string {
  return toHex(contentId);
}

export type OwnedObjectBatchFactory = (options: ObjectBatchOptions) => OwnedObjectBatch;

export type OwnedAuthenticatedObjectReader = (
  oid: string,
  expectedType: ObjectType,
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

/** Internal object batch whose staged allocations remain bounded until flush. */
export function writeBatchOwned(
  store: SharedRepoStore,
  options: ObjectBatchOptions = {},
): OwnedObjectBatch {
  return ownedObjectBatchFactory(store)(options);
}

/** Internal scoped object writer used by shared repository operations. */
export function writeObjectsOwned<T>(
  store: SharedRepoStore,
  body: (batch: ObjectBatch) => T,
  options: ObjectBatchOptions = {},
): T {
  const batch = writeBatchOwned(store, options);
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

/** Internal authenticated read through the installed shared-store seam. */
export function readAuthenticatedObjectOwned(
  store: SharedRepoStore,
  oid: string,
  expectedType: ObjectType,
): RawObject | null {
  const read = OWNED_AUTHENTICATED_OBJECT_READERS.get(store);
  if (read === undefined) {
    throw new GitError("EINVAL", "repository authenticated object reader is unavailable");
  }
  return read(oid, expectedType);
}

/** Internal shallow-boundary snapshot through the installed shared-store seam. */
export function readShallowOwned(store: SharedRepoStore): Set<string> {
  const boundary = new Set<string>();
  for (const row of store.db.iterate(
    "SELECT oid FROM git_shallow WHERE repo_id = ? ORDER BY oid",
    store.repoId,
  )) {
    boundary.add(expectText(row.oid, "stored shallow object id"));
  }
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

export function* contentIdPages(contentIds: Iterable<Uint8Array>): Generator<ContentIdPage> {
  const unique = new Map<string, Uint8Array>();
  for (const contentId of contentIds) {
    if (contentId.length > BLOB_ID_CACHE_ELIGIBILITY_BYTES) continue;
    const snapshot = contentId.slice();
    const key = contentIdKey(snapshot);
    unique.set(key, snapshot);
  }
  let parts: Uint8Array[] = [];
  let rows: { a: number; n: number }[] = [];
  let length = 0;
  for (const contentId of unique.values()) {
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      yield { payload: concat(parts), rows };
      parts = [];
      rows = [];
      length = 0;
    }
    rows.push({ a: length + 1, n: contentId.length });
    parts.push(contentId);
    length += contentId.length;
  }
  if (rows.length > 0) yield { payload: concat(parts), rows };
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
): Generator<ExpectedContentIdPage> {
  let parts: Uint8Array[] = [];
  let rows: { i: number; a: number; n: number; o: string }[] = [];
  let length = 0;
  for (const mapping of mappings) {
    if (mapping === undefined) continue;
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      yield { payload: concat(parts), rows };
      parts = [];
      rows = [];
      length = 0;
    }
    rows.push({
      i: mapping.ordinal,
      a: length + 1,
      n: mapping.contentId.length,
      o: mapping.oid,
    });
    parts.push(mapping.contentId);
    length += mapping.contentId.length;
  }
  if (rows.length > 0) yield { payload: concat(parts), rows };
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

export function parseLooseEncoding(stored: string): LooseEncoding {
  if (stored === "raw" || stored === "zlib") return stored;
  throw new CorruptError(`loose object has unknown storage encoding '${stored}'`);
}

export function isObjectType(value: string | null): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

export const JSON_ENCODER = new TextEncoder();
export const JSON_BATCH_ROWS = 2_048;
export const JSON_BATCH_BYTES = 1_500_000;
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

export function* jsonPages<T>(items: Iterable<T>, _label: string): Generator<string> {
  let rows: string[] = [];
  let bytes = 2;
  const emit = function* (): Generator<string> {
    const joined = rows.join(",");
    yield `[${joined}]`;
  };
  for (const item of items) {
    const row = JSON.stringify(item);
    const rowBytes = refTextBytes(row, "JSON batch row", "input");
    const separator = rows.length === 0 ? 0 : 1;
    if (
      rows.length > 0 &&
      (rows.length >= JSON_BATCH_ROWS || bytes + separator + rowBytes > JSON_BATCH_BYTES)
    ) {
      yield* emit();
      rows = [];
      bytes = 2;
    }
    bytes += (rows.length === 0 ? 0 : 1) + rowBytes;
    rows.push(row);
    if (bytes >= JSON_BATCH_BYTES) {
      yield* emit();
      rows = [];
      bytes = 2;
    }
  }
  if (rows.length > 0) yield* emit();
}

export function requireSafeRefLogInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  return expectSafeInteger(value, minimum, maximum, label);
}

export function requireStoredRefLogEntry(row: unknown): RefLogEntry {
  const stored = REFLOG_ENTRY_ROW.decode(row);
  const actor: RefLogActor | null =
    stored.actor_name === null
      ? null
      : {
          name: stored.actor_name,
          email: expectText(stored.actor_email, "reflog actor email"),
        };
  return {
    refName: stored.ref_name,
    ordinal: stored.ordinal,
    oldRaw: stored.old_raw,
    newRaw: stored.new_raw,
    oldOid: stored.old_oid,
    newOid: stored.new_oid,
    actor,
    timestamp: stored.timestamp,
    timezoneOffset: stored.timezone,
    reason: stored.reason,
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
  const stored = new RowShape({
    repo_id: int(1),
    head: text(),
    next_ordinal: int(0, MAX_REFLOG_ORDINAL),
    latest_ordinal: nullable(int(1, MAX_REFLOG_ORDINAL)),
  }).decode(row);
  if (stored.repo_id !== repoId) {
    throw new CorruptError("reflog header belongs to another repository");
  }
  const nextOrdinal = stored.next_ordinal;
  const latest = stored.latest_ordinal;
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

export function readCheckoutRevision(db: SqlDatabase, repoId: number): number {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("checkout revision repository id is invalid");
  }
  const stored = db.scalar<unknown>(
    "SELECT checkout_revision FROM git_repositories WHERE id = ?",
    repoId,
  );
  if (stored === undefined) throw new CorruptError("checkout revision repository is missing");
  return expectSafeInteger(stored, 0, Number.MAX_SAFE_INTEGER, "stored checkout revision");
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

export function validateInitialIndexEntry(entry: IndexEntry): void {
  initialPathJsonBytes(entry.path);
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
  integrityOid: string,
): OperationJournal {
  const fields = { steps, touched, integrityOid };
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
    if (!isOid(mapping.oid)) throw new GitError("EINVAL", `invalid blob oid ${mapping.oid}`);
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

export type OwnedIndexScan = (options: IndexScanOptions) => IterableIterator<IndexEntry>;

export const OWNED_INDEX_SCANS = new WeakMap<IndexStore, OwnedIndexScan>();

/** Internal ordered scan over validated persisted rows. */
export function indexScanOwned(
  index: IndexStore,
  options: IndexScanOptions = {},
): IterableIterator<IndexEntry> {
  const scan = OWNED_INDEX_SCANS.get(index);
  return scan === undefined ? scanGenericIndexOwned(index.indexScan(options)) : scan(options);
}

export function* scanGenericIndexOwned(
  entries: IterableIterator<IndexEntry>,
): Generator<IndexEntry> {
  let previousPath: string | null = null;
  let previousStage = -1;
  for (const raw of entries) {
    const entry = INDEX_ENTRY_INPUT.decode({
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
    previousPath = entry.path;
    previousStage = entry.stage;
    yield entry;
  }
}

export function requireIndexPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INDEX_SCAN_PAGE) {
    throw new GitError("EINVAL", `index scan page size must be from 1 to ${MAX_INDEX_SCAN_PAGE}`);
  }
  return value;
}

export function requireStoredIndexEntry(row: unknown): IndexEntry {
  return INDEX_ENTRY_ROW.decode(row);
}

export type OwnedIndexSource =
  | { kind: "checkout"; repoId: number; checkoutId: number }
  | { kind: "scratch"; repoId: number; name: string };

export function* scanIndexOwned(
  db: SqlDatabase,
  source: OwnedIndexSource,
  requireActive: () => void,
  options: IndexScanOptions,
): Generator<IndexEntry> {
  requireActive();
  const pageSize = requireIndexPageSize(options.pageSize ?? DEFAULT_INDEX_PAGE);
  const prefix = options.prefix;
  let path = options.after?.path ?? "";
  let stage = options.after?.stage ?? -1;
  for (;;) {
    requireActive();
    const query =
      source.kind === "checkout"
        ? prefix === undefined || prefix === ""
          ? `SELECT entry.path, entry.stage, entry.mode, entry.oid,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_index entry
                WHERE entry.checkout_id = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                ORDER BY entry.path, entry.stage LIMIT ?`
          : `SELECT entry.path, entry.stage, entry.mode, entry.oid,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_index entry
                WHERE entry.checkout_id = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                  AND (entry.path = ? OR (entry.path >= ? AND entry.path < ?))
                ORDER BY entry.path, entry.stage LIMIT ?`
        : prefix === undefined || prefix === ""
          ? `SELECT entry.path, entry.stage, entry.mode, entry.oid,
                      entry.size, entry.mtime, entry.ino, entry.rev
                 FROM git_scratch_index_entries entry
                WHERE entry.repo_id = ? AND entry.name = ?
                  AND (entry.path > ? OR (entry.path = ? AND entry.stage > ?))
                ORDER BY entry.path, entry.stage LIMIT ?`
          : `SELECT entry.path, entry.stage, entry.mode, entry.oid,
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
    const rows = db.iterate(query, ...bindings)[Symbol.iterator]();
    try {
      for (;;) {
        requireActive();
        const next = rows.next();
        if (next.done) {
          break;
        }
        const row = next.value;
        if (pageRows >= pageSize) {
          throw new CorruptError("index scan returned invalid page cardinality");
        }
        const entry = requireStoredIndexEntry(row);
        last = entry;
        pageRows++;
        yield entry;
      }
    } finally {
      if (rows.return !== undefined) rows.return();
    }
    if (pageRows === 0) return;
    if (last === undefined) throw new CorruptError("index scan page lost its last row");
    path = last.path;
    stage = last.stage;
    if (pageRows < pageSize) return;
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
): StoredCheckoutLifecycle {
  const checkout = requireStoredCheckoutRow(row);
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

export function requireStoredCheckoutRow(row: unknown): CheckoutRow {
  const stored = CHECKOUT_ROW.decode(row);
  return {
    id: stored.checkout_id,
    repoId: stored.repo_id,
    root: stored.root,
    head: stored.head,
    isPrimary: stored.is_primary === 1,
  };
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
  #active = true;

  constructor(shared: SharedRepoStore, name: string) {
    this.#db = shared.db;
    this.#repoId = shared.repoId;
    this.#name = name;
    OWNED_INDEX_SCANS.set(this, (options) =>
      scanIndexOwned(
        this.#db,
        { kind: "scratch", repoId: this.#repoId, name: this.#name },
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
    this.#objectCache = shared.objects;
    this.#packStore = shared.installPacks(
      new PackStore(
        this.#database,
        this.#repoId,
        this.#objectCache,
        shared.packRows,
        shared.cacheNamespace,
        (oids: readonly string[]) => this.#readLooseObjects(oids),
        (oids) => this.#looseObjectMetadata(oids),
        options,
      ),
    );
    OWNED_REF_MUTATIONS.set(this, (mutation, metadata) =>
      this.#mutateRefsOwned(mutation, metadata),
    );
    OWNED_INDEX_SCANS.set(this, (scanOptions) =>
      scanIndexOwned(
        this.#db,
        { kind: "checkout", repoId: this.#repoId, checkoutId: this.#checkoutId },
        () => this.#requireActive(),
        scanOptions,
      ),
    );
    OWNED_OPERATION_JOURNALS.set(this, {
      read: () => this.#readOperationStateOwned(),
      write: (state, steps, touched) => this.#writeOperationJournalOwned(state, steps, touched),
      replaceState: (expectedIntegrityOid, state) =>
        this.#replaceOperationStateOwned(expectedIntegrityOid, state),
      replaceJournal: (expectedIntegrityOid, state, steps, touched) =>
        this.#replaceOperationJournalOwned(expectedIntegrityOid, state, steps, touched),
    });
    const ownedOperations: SharedRepoOwnedOperations = {
      objectBatch: (batchOptions) => this.#writeBatchOwned(batchOptions),
      authenticatedObject: (oid, expectedType) =>
        this.#readAuthenticatedObjectOwned(oid, expectedType),
      configValue: (path) => this.#configGetOwned(path),
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

  // -- objects --------------------------------------------------------

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    const found = new Map<string, string>();
    for (const page of contentIdPages(contentIds)) {
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
        const contentKey = expectText(row.content_key, "blob content key");
        const oid = expectText(row.oid, "stored blob object id");
        found.set(contentKey, oid);
      }
    }
    return found;
  }

  /**
   * Return the ordinals of expected mappings that are absent or disagree.
   *
   * An absent result proves the stored mapping equals the expected oid. A
   * `null` value means there is no stored mapping, so callers must identify
   * the content instead of trusting it.
   */
  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    const retained: ExpectedBlobIdMapping[] = [];
    const mismatches = new Map<number, string | null>();
    let capturedCount = 0;
    for (const mapping of expected) {
      if (!isOid(mapping.oid)) throw new GitError("EINVAL", `invalid blob oid ${mapping.oid}`);
      const cacheable = mapping.contentId.length <= BLOB_ID_CACHE_ELIGIBILITY_BYTES;
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

    for (const page of expectedContentIdPages(retained)) {
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
        const returnedOrdinal = expectSafeInteger(row.ordinal, 0, capturedCount - 1);
        const oid = row.oid === null ? null : expectText(row.oid, "stored blob object id");
        mismatches.set(returnedOrdinal, oid);
      }
    }
    return mismatches;
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    const unique = new Map<string, BlobIdMapping>();
    for (const mapping of mappings) {
      if (!isOid(mapping.oid)) throw new GitError("EINVAL", `invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > BLOB_ID_CACHE_ELIGIBILITY_BYTES) continue;
      const snapshot: BlobIdMapping = {
        contentId: mapping.contentId.slice(),
        oid: mapping.oid,
      };
      const key = contentIdKey(snapshot.contentId);
      unique.set(key, snapshot);
    }
    if (unique.size === 0) return;
    this.#db.transactionSync(() => {
      let parts: Uint8Array[] = [];
      let rows: { a: number; n: number; o: string }[] = [];
      let length = 0;
      const flush = (): void => {
        if (rows.length === 0) return;
        writeBlobIdPage(this.#db, this.#repoId, concat(parts), rows, true, true);
        parts = [];
        rows = [];
        length = 0;
      };
      for (const mapping of unique.values()) {
        if (
          rows.length > 0 &&
          (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
        ) {
          flush();
        }
        rows.push({ a: length + 1, n: mapping.contentId.length, o: mapping.oid });
        parts.push(mapping.contentId);
        length += mapping.contentId.length;
      }
      flush();
    });
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

  #readAuthenticatedObjectOwned(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#readAuthenticatedObject(oid, expectedType);
  }

  #readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    const loose = this.#looseRow(oid);
    if (loose === null) {
      return this.#packs.readAuthenticatedObject(oid, expectedType);
    }
    const cacheKey = this.#objectCacheKey(oid);
    try {
      const object = this.#readLooseObjectRows([{ oid, ...loose }]).get(oid);
      if (object === undefined) throw new CorruptError(`loose ${expectedType} ${oid} disappeared`);
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
    const rows = this.#db.all<Record<string, unknown>>(
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
       SELECT CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                   WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
              CASE WHEN loose.oid IS NOT NULL THEN loose.type
                   WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
              CASE WHEN loose.oid IS NOT NULL THEN loose.size
                   WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size,
              CASE WHEN loose.oid IS NOT NULL THEN loose.stored END AS stored,
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
    return rows.map((raw, ordinal) => {
      const row = OBJECT_INFO_ROW.decode(raw);
      const oid = wanted[ordinal];
      if (oid === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
      if (
        row.source === null ||
        row.type === null ||
        row.size === null ||
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
        if (row.source === null) throw new ObjectNotFoundError(oid);
        throw new CorruptError("object metadata lookup returned an invalid row");
      }
      return {
        oid,
        type: row.type,
        size: row.size,
        source: row.source,
        chunkRows: row.chunk_rows,
      };
    });
  }

  /** Read a deduplicated prefix of mixed objects under an explicit byte budget. */
  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.#readObjectsOwned(oids, options);
  }

  #readObjectsOwned(oids: readonly string[], options: { budgetBytes?: number }): ObjectReadBatch {
    const budget = options.budgetBytes ?? PACK_BLOB_BATCH_TARGET_BYTES;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new RangeError("object read budget must be a positive safe integer");
    }
    const inputLength = oids.length;
    if (!Number.isSafeInteger(inputLength) || inputLength > MAX_BLOB_BATCH_OIDS) {
      throw new GitError("E2BIG", `object batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
    }
    const captured: string[] = [];
    for (let index = 0; index < inputLength; index++) {
      const oid = oids[index];
      if (typeof oid !== "string") throw new CorruptError("invalid object id input");
      captured.push(oid);
      if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    }
    const seen = new Set<string>();
    const wanted: string[] = [];
    for (const oid of captured) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      wanted.push(oid);
    }
    if (wanted.length === 0) return { objects: new Map(), remaining: [], bytes: 0 };

    const encodedWanted = JSON.stringify(wanted);

    const rawMetadata = this.#db.all<Record<string, unknown>>(
      `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                    WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
               CASE WHEN loose.oid IS NOT NULL THEN loose.type
                    WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
               CASE WHEN loose.oid IS NOT NULL THEN loose.size
                    WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size,
               CASE WHEN loose.oid IS NOT NULL THEN loose.stored END AS stored
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
      const raw = rawMetadata[index];
      if (raw === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
      const row = OBJECT_READ_ROW.decode(raw);
      const oid = wanted[index];
      if (oid === undefined) throw new CorruptError("object metadata lookup returned a sparse row");
      if (row.source === null) throw new ObjectNotFoundError(oid);
      if (row.type === null || row.size === null) {
        throw new CorruptError(`object ${oid} has invalid indexed metadata`);
      }
      let stored: "raw" | "zlib" | null;
      if (row.source === "loose") {
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
        source: row.source,
        type: row.type,
        size: row.size,
        stored,
      });
    }

    const selected: ObjectReadMetadata[] = [];
    let bytes = 0;
    for (const row of metadata) {
      if (row.size > Number.MAX_SAFE_INTEGER - bytes) {
        throw new GitError("E2BIG", "object read size accounting overflow");
      }
      if (selected.length > 0 && bytes + row.size > budget) break;
      selected.push(row);
      bytes += row.size;
      if (bytes >= budget) break;
    }

    const looseRows: ObjectReadMetadata[] = [];
    const packedOids: string[] = [];
    for (const row of selected) {
      if (row.source === "loose") {
        looseRows.push(row);
      } else {
        packedOids.push(row.oid);
      }
    }

    const remaining = wanted.slice(selected.length);
    const looseObjects = this.#readLooseObjectRows(looseRows);
    const packed =
      packedOids.length === 0 ? new Map<string, RawObject>() : this.#packs.readObjects(packedOids);
    const objects = new Map<string, RawObject>();
    for (const row of selected) {
      const object = (row.source === "loose" ? looseObjects : packed).get(row.oid);
      if (object === undefined || object.type !== row.type || object.data.length !== row.size) {
        throw new CorruptError(`object ${row.oid} did not produce its indexed bytes`);
      }
      objects.set(row.oid, object);
    }
    return { objects, remaining, bytes };
  }

  /** Read a deduplicated prefix of blobs under an explicit byte budget. */
  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    const batch = this.#readObjectsOwned(oids, options);
    const blobs = new Map<string, Uint8Array>();
    for (const [oid, object] of batch.objects) {
      if (object.type !== "blob") throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
      blobs.set(oid, object.data);
    }
    return { blobs, remaining: batch.remaining, bytes: batch.bytes };
  }

  /** Stream every non-tree entry in raw Git DFS order with one SQL statement. */
  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* iterateTree(this.#db, this.#repoId, treeOid);
  }

  /** Stream changed leaves between two trees while pruning equal subtrees. */
  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* iterateTreeDiff(this.#db, this.#repoId, beforeTreeOid, afterTreeOid);
  }

  /** Stream objects introduced by one tree transition. */
  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* iterateTreeDiffObjects(this.#db, this.#repoId, beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    const commitEntry =
      type === "commit" ? prepareCommitCache({ repoId: this.#repoId, oid, data }) : undefined;
    if (this.has(oid)) {
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
      return oid;
    }
    const stored = looseEncoding(data.length);
    const storedData = encodeLoose(data, stored);
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
        );
      }
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
    });
    this.shared.markLoose();
    this.#objects.set(this.#objectCacheKey(oid), { type, data });
    return oid;
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
    const hash = new Sha1().update(objectHeader(type, size));
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
        : prepareCommitCache({ repoId: this.#repoId, oid, data: commitData });
    if (this.has(oid)) {
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
      }
      return oid;
    }

    const stored = looseEncoding(size);
    if (stored === "raw") {
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
          );
        }
        if (commitEntry !== undefined) {
          requireCommitCacheWrites(insertCommitCaches(this.#db, [commitEntry]), 1);
        }
      });
      this.shared.markLoose();
      return oid;
    }

    const rows: Uint8Array[] = [];
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
        );
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

  #writeBatchOwned(options: ObjectBatchOptions): OwnedObjectBatch {
    return this.#createWriteBatch(options);
  }

  #createWriteBatch(options: ObjectBatchOptions): OwnedObjectBatch {
    const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
    const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
    // Keyed by oid: a tree build re-emits identical subtrees, and one
    // (oid, seq) may appear at most once in a payload.
    const staged = new Map<string, StagedObject>();
    let bytes = 0;
    let commitBytes = 0;
    let active = true;
    const requireActive = (): void => {
      if (!active) throw new GitError("EINVAL", "object batch is disposed");
    };
    const clear = (): void => {
      staged.clear();
      bytes = 0;
      commitBytes = 0;
    };
    const flush = (): void => {
      requireActive();
      if (staged.size === 0) return;
      try {
        this.#flushObjects([...staged.values()], payloadBytes);
      } finally {
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
      },
    };
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    const batch = this.#createWriteBatch(options);
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

  #flushObjects(staged: StagedObject[], payloadBytes: number): void {
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
      );
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

  #readLooseObjects(oids: readonly string[]): Map<string, RawObject> {
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
    return this.#readLooseObjectRows(rows);
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
  ): Map<string, RawObject> {
    if (rows.length === 0) return new Map();
    const wanted = rows.map((row) => row.oid);
    const encodedWanted = JSON.stringify(wanted);
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
    }

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
      if (!isObjectType(row.type)) throw new CorruptError(`${row.oid} has an invalid object type`);
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
        if (shallowTouched) this.#advanceShallowRevision(state.shallowRevision);
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
    const active: RefLogEntry[] = [];
    let headerSeen = false;
    let nextOrdinal = 0;
    let entryCount = 0;
    const headerSql = `SELECT 0 AS kind, repository.id AS repo_id, checkout.head,
              state.next_ordinal,
              (SELECT max(ordinal) FROM (
                 SELECT direct.ordinal FROM git_reflog_entries direct
                  WHERE direct.repo_id = repository.id
                 UNION ALL
                 SELECT local.ordinal FROM git_checkout_reflog_entries local
                  WHERE local.repo_id = repository.id
               )) AS latest_ordinal,
              NULL AS ref_name, NULL AS ordinal, NULL AS old_raw, NULL AS new_raw,
              NULL AS old_oid, NULL AS new_oid, NULL AS actor_name, NULL AS actor_email,
              NULL AS timestamp, NULL AS timezone, NULL AS reason
         FROM git_repositories repository
         JOIN git_reflog_state state ON state.repo_id = repository.id
         JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? AND checkout.id = ?`;
    const rows =
      name === "HEAD"
        ? this.#db.iterate(
            `${headerSql}
             UNION ALL
             SELECT 1 AS kind, NULL AS repo_id, NULL AS head, NULL AS next_ordinal,
                    NULL AS latest_ordinal, 'HEAD' AS ref_name, entry.ordinal,
                    entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                    entry.actor_name, entry.actor_email, entry.timestamp, entry.timezone,
                    entry.reason
               FROM git_checkout_reflog_entries entry
              WHERE entry.repo_id = ? AND entry.checkout_id = ?
              ORDER BY kind, ordinal DESC
              LIMIT ${REFLOG_RETENTION_ROWS + 2}`,
            this.#repoId,
            this.#checkoutId,
            this.#repoId,
            this.#checkoutId,
          )
        : this.#db.iterate(
            `${headerSql}
             UNION ALL
             SELECT 1 AS kind, NULL AS repo_id, NULL AS head, NULL AS next_ordinal,
                    NULL AS latest_ordinal, entry.ref_name, entry.ordinal,
                    entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                    entry.actor_name, entry.actor_email, entry.timestamp, entry.timezone,
                    entry.reason
               FROM git_reflog_entries entry INDEXED BY git_reflog_entries_by_ref
              WHERE entry.repo_id = ? AND entry.ref_name = ?
              ORDER BY kind, ordinal DESC
              LIMIT ${REFLOG_RETENTION_ROWS + 2}`,
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
      entryCount++;
      if (entryCount > REFLOG_RETENTION_ROWS) {
        throw new GitError("E2BIG", "reflog row count exceeds its retained history bound");
      }
      const entry = requireStoredRefLogEntry(row);
      if (entry.refName !== name) throw new CorruptError("reflog query returned another ref");
      if (entry.ordinal > nextOrdinal) {
        throw new CorruptError("reflog entry exceeds the repository allocation state");
      }
      if (entry.timestamp >= cutoff) active.push(entry);
    }
    if (!headerSeen) throw new CorruptError("repository is missing its reflog state");
    const page: RefLogEntry[] = [];
    for (const entry of active) {
      if (before !== undefined && entry.ordinal >= before) continue;
      if (page.length < limit) page.push(entry);
    }
    return page;
  }

  /** Distinct active reflog roots in strict byte order. */
  *activeRefLogOids(): Generator<string> {
    const now = this.#nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_REFLOG_ORDINAL) {
      throw new GitError("EINVAL", "reflog clock must return a safe nonnegative epoch time");
    }
    const cutoff = Math.max(0, now - REFLOG_RETENTION_SECONDS);
    const header = this.#db.one<Record<string, unknown>>(
      `SELECT repository.id AS repo_id, checkout.head, state.next_ordinal,
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
    let directEntriesForRef = 0;
    let previousCheckoutId: number | null = null;
    let checkoutEntries = 0;
    let scannedEntries = 0;
    for (const row of this.#db.iterate(
      `WITH direct_ranked AS (
         SELECT entry.*, NULL AS checkout_id,
                row_number() OVER (
                  PARTITION BY entry.ref_name ORDER BY entry.ordinal DESC
                ) AS retained_rank
           FROM git_reflog_entries entry INDEXED BY git_reflog_entries_by_ref
          WHERE entry.repo_id = ?
       ), checkout_ranked AS (
         SELECT entry.*, 'HEAD' AS ref_name,
                row_number() OVER (
                  PARTITION BY entry.checkout_id ORDER BY entry.ordinal DESC
                ) AS retained_rank
           FROM git_checkout_reflog_entries entry
          WHERE entry.repo_id = ?
       ), retained AS (
         SELECT 0 AS kind, checkout_id, ref_name, ordinal,
                old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason
           FROM direct_ranked WHERE retained_rank <= ${REFLOG_RETENTION_ROWS}
         UNION ALL
         SELECT 1 AS kind, checkout_id, ref_name, ordinal,
                old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason
           FROM checkout_ranked WHERE retained_rank <= ${REFLOG_RETENTION_ROWS}
       ), retained_limited AS MATERIALIZED (
         SELECT * FROM retained
          ORDER BY kind, ref_name COLLATE BINARY, checkout_id, ordinal DESC
          LIMIT ${MAX_REFLOG_ROOT_SCAN_ENTRIES + 1}
       ), output AS (
         SELECT retained_limited.*, NULL AS root_oid FROM retained_limited
         UNION ALL
         SELECT 2 AS kind, NULL AS checkout_id, NULL AS ref_name, NULL AS ordinal,
                NULL AS old_raw, NULL AS new_raw,
                NULL AS old_oid, NULL AS new_oid, NULL AS actor_name, NULL AS actor_email,
                NULL AS timestamp, NULL AS timezone, NULL AS reason, endpoint.oid AS root_oid
           FROM (
             SELECT oid FROM (
               SELECT old_oid AS oid FROM retained_limited WHERE timestamp >= ?
               UNION ALL
               SELECT new_oid AS oid FROM retained_limited WHERE timestamp >= ?
             ) WHERE oid IS NOT NULL GROUP BY oid
           ) endpoint
       )
       SELECT kind, checkout_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
              actor_name, actor_email, timestamp, timezone, reason, root_oid
         FROM output
       ORDER BY kind, ref_name COLLATE BINARY, checkout_id, ordinal DESC, root_oid COLLATE BINARY`,
      this.#repoId,
      this.#repoId,
      cutoff,
      cutoff,
    )) {
      if (row.kind === 0) {
        scannedEntries++;
        if (scannedEntries > MAX_REFLOG_ROOT_SCAN_ENTRIES) {
          throw new GitError("E2BIG", "reflog root scan exceeds its structural row bound");
        }
        const entry = requireStoredRefLogEntry(row);
        if (entry.ordinal > nextOrdinal) {
          throw new CorruptError("reflog entry exceeds the repository allocation state");
        }
        if (previousRef === null || entry.refName !== previousRef) {
          previousRef = entry.refName;
          directEntriesForRef = 0;
        }
        directEntriesForRef++;
        if (directEntriesForRef > REFLOG_RETENTION_ROWS) {
          throw new CorruptError("reflog root query exceeded its retained row bound");
        }
        continue;
      }
      if (row.kind === 1) {
        scannedEntries++;
        if (scannedEntries > MAX_REFLOG_ROOT_SCAN_ENTRIES) {
          throw new GitError("E2BIG", "reflog root scan exceeds its structural row bound");
        }
        const checkoutId = requireSafeId(row.checkout_id, "checkout reflog owner id");
        const entry = requireStoredRefLogEntry(row);
        if (entry.refName !== "HEAD" || entry.ordinal > nextOrdinal) {
          throw new CorruptError("checkout reflog entry is invalid");
        }
        if (checkoutId !== previousCheckoutId) {
          previousCheckoutId = checkoutId;
          checkoutEntries = 0;
        }
        checkoutEntries++;
        if (checkoutEntries > REFLOG_RETENTION_ROWS) {
          throw new CorruptError("checkout reflog query exceeded its retained row bound");
        }
        continue;
      }
      if (row.kind !== 2) {
        throw new CorruptError("reflog root query returned an invalid object id");
      }
      yield expectText(row.root_oid, "reflog root object id");
    }
  }

  // -- config ---------------------------------------------------------

  configGetAll(path: string): string[] {
    return this.#db
      .all<{ value: unknown }>(
        "SELECT value FROM git_config WHERE repo_id = ? AND path = ? ORDER BY seq",
        this.#repoId,
        path,
      )
      .map((row) => expectText(row.value, `config ${path}`));
  }

  configGet(path: string): string | undefined {
    // git's `--get` reports the last value for a multi-valued key.
    const values = this.configGetAll(path);
    return values.length === 0 ? undefined : values[values.length - 1];
  }

  #configGetOwned(path: string): string | undefined {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "config path must be a non-empty string");
    }
    return this.configGetBounded(path);
  }

  /** Read one config value with an optional payload limit. */
  configGetBounded(path: string, maxBytes?: number): string | undefined {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }
    const row = this.#db.one<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq DESC LIMIT 1`,
      this.#repoId,
      path,
    );
    if (row === undefined) return undefined;
    const value = expectText(row.value, `config ${path}`);
    if (maxBytes !== undefined && utf8ByteLength(value) > maxBytes) {
      throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
    }
    return value;
  }

  /** Read zero or one value without materialising an unbounded multi-valued key. */
  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "bounded config path must be a non-empty string");
    }
    boundedCanonicalUtf8Bytes(path, MAX_INDEX_PATH_BYTES, "bounded config path");
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }

    const rows = this.#db.all<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq LIMIT 2`,
      this.#repoId,
      path,
    );
    if (rows.length === 0) return { kind: "missing" };
    if (rows.length !== 1) return { kind: "multiple" };
    const value = expectText(rows[0]?.value, `config ${path}`);
    if (maxBytes !== undefined && utf8ByteLength(value) > maxBytes) {
      throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
    }
    return { kind: "single", value };
  }

  /** Inspect zero, one, or multiple values without materialising their payloads. */
  configCardinality(path: string): ConfigValueCardinality {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "config path must be a non-empty string");
    }
    boundedCanonicalUtf8Bytes(path, MAX_INDEX_PATH_BYTES, "config path");
    const rows = this.#db.all<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq LIMIT 2`,
      this.#repoId,
      path,
    ).length;
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
      .all<{ path: unknown }>(
        "SELECT DISTINCT path FROM git_config WHERE repo_id = ? AND path >= ? AND path < ? ORDER BY path",
        this.#repoId,
        prefix,
        nextPrefix(prefix),
      )
      .map((row) => expectText(row.path, "stored config path"));
  }

  /** Validate and move one exact dotted config section without changing value order. */
  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    const source = requireConfigSectionPrefix(sourcePrefix, "source");
    const destination = requireConfigSectionPrefix(destinationPrefix, "destination");
    if (source === destination) {
      throw new GitError("EINVAL", "config section source and destination must differ");
    }

    this.#db.transactionSync(() => {
      let destinationCandidates = 0;
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
        const candidate = requireConfigSectionMetadata(row);
        if (configSectionVariable(candidate.path, destination) !== null) {
          throw new GitError("EEXIST", `config section ${destination} already exists`);
        }
      }

      const metadata: ConfigSectionCandidateMetadata[] = [];
      let sourceCandidates = 0;
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
        const candidate = requireConfigSectionMetadata(row);
        const variable = configSectionVariable(candidate.path, source);
        if (variable === null) continue;
        configSectionDestinationBytes(destination, variable);
        metadata.push(candidate);
      }
      if (metadata.length === 0) return;

      function* updateRows(): Generator<{ path: string; seq: number }> {
        for (const row of metadata) yield { path: row.path, seq: row.seq };
      }
      let changedRows = 0;
      for (const page of jsonPages(updateRows(), "config section move")) {
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
  }

  // -- integration operation journal --------------------------------

  /** Read and validate the one durable incomplete integration operation. */
  readOperationState(): OperationJournal | null {
    return this.#readOperationStateOwned();
  }

  #readOperationStateOwned(): OperationJournal | null {
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
              touched_count,
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
      touched.push(entry);
    }
    if (touched.length !== touchedCount) {
      throw new CorruptError("merge journal touched-path count does not match its rows");
    }
    const integrityOid = requireMergeOid(row.integrity_oid, "journal integrity oid");
    if (operationJournalIntegrityOid(state, touched, steps) !== integrityOid) {
      throw new CorruptError("operation journal integrity identity does not match its rows");
    }
    const journal = operationJournal(state, steps, touched, integrityOid);
    this.#validateOperationObjects(journal);
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
    this.#writeOperationJournalOwned(state, steps, touched);
  }

  #writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    if (state.kind === "rebase") requireInitialRebaseJournal(state, steps, touched);
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);

    this.#db.transactionSync(() => {
      const active = this.#readOperationStateOwned();
      if (active !== null) throw operationAlreadyActive(active.state.kind);
      const journal = operationJournal(state, steps, touched, integrityOid);
      this.#validateOperationObjects(journal);
      this.#insertOperationHeader(state, steps.length, touched.length, integrityOid);
      this.#insertOperationSteps(steps);
      this.#insertOperationTouched(touched);
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
    });
  }

  #insertOperationHeader(
    state: OperationStateMetadata,
    stepCount: number,
    touchedCount: number,
    integrityOid: string,
  ): void {
    this.#db.run(
      `INSERT INTO git_operation_state
         (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
          current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
          current_step, step_count, current_label, incoming_label, message,
          author_name, author_email, committer_name, committer_email,
          touched_count, integrity_oid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      integrityOid,
    );
  }

  #insertOperationSteps(steps: readonly OperationStepMetadata[]): void {
    function* rows(): Generator<PersistedOperationStep> {
      for (let ordinal = 0; ordinal < steps.length; ordinal++) {
        const step = steps[ordinal];
        if (step === undefined) throw new CorruptError("operation step sequence is sparse");
        yield persistedOperationStep(step, ordinal);
      }
    }
    for (const page of jsonPages(rows(), "operation step")) {
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

  #insertOperationTouched(touched: readonly MergeTouchedPath[]): void {
    function* rows(): Generator<PersistedOperationTouched> {
      for (let ordinal = 0; ordinal < touched.length; ordinal++) {
        const entry = touched[ordinal];
        if (entry === undefined) throw new CorruptError("operation touched sequence is sparse");
        yield persistedOperationTouched(entry, ordinal);
      }
    }
    for (const page of jsonPages(rows(), "operation touched path")) {
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

  #validateOperationObjects(journal: OperationJournal): void {
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

    let page: string[] = [];
    const validatePage = (): void => {
      if (page.length === 0) return;
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
    };
    for (const oid of expected.keys()) {
      page.push(oid);
      if (page.length === MAX_BLOB_BATCH_OIDS) validatePage();
    }
    validatePage();
    if (journal.kind !== "merge") {
      this.#validateReplayTopology(journal, objectSizes);
    }
  }

  #validateReplayTopology(
    journal: CherryPickJournal | RevertJournal | RebaseJournal,
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
      objectSizes,
    );
  }

  #validateOperationCommitBodies(
    oids: readonly string[],
    visit: (oid: string, commit: CommitCacheEntry) => void,
    objectSizes: ReadonlyMap<string, number>,
  ): void {
    const seen = new Set<string>();
    for (let offset = 0; offset < oids.length; offset += MAX_BLOB_BATCH_OIDS) {
      const page = oids.slice(offset, offset + MAX_BLOB_BATCH_OIDS);
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
        const batch = this.#readObjectsOwned(remaining, {
          budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES,
        });
        remaining = [];
        if (batch.objects.size === 0 || batch.bytes <= 0) {
          throw new CorruptError("operation commit validation made no progress");
        }
        for (const [oid, object] of batch.objects) {
          if (object.type !== "commit") {
            throw new CorruptError("operation step did not produce a complete commit object");
          }
          visit(oid, prepareCommitCache({ repoId: this.#repoId, oid, data: object.data }));
        }
        remaining = batch.remaining;
      }
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
    this.#replaceOperationStateOwned(expectedIntegrityOid, state);
  }

  #replaceOperationStateOwned(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    if (state.kind === "rebase") {
      throw new GitError("EOPMISMATCH", "rebase replacement requires a whole-journal transition");
    }
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    this.#db.transactionSync(() => {
      const current = this.#readOperationStateOwned();
      if (current === null) throw operationNotActive(state.kind);
      if (current.state.kind !== state.kind) {
        throw operationKindMismatch(state.kind, current.state.kind);
      }
      if (current.integrityOid !== expectedIntegrityOid) {
        throw new GitError("EOPMISMATCH", "operation state changed before replacement");
      }
      const integrityOid = operationJournalIntegrityOid(state, current.touched, current.steps);
      this.#validateOperationObjects(
        operationJournal(state, current.steps, current.touched, integrityOid),
      );
      this.#db.run(
        `UPDATE git_operation_state
            SET original_head_ref = ?, original_head_oid = ?, phase = ?, empty_reason = ?,
                current_parent_oid = ?, incoming_parent_oid = ?, upstream_oid = ?, base_oid = ?,
                mode = ?, merge_origin = ?, current_step = ?, current_label = ?, incoming_label = ?,
                message = ?, author_name = ?, author_email = ?, committer_name = ?,
                committer_email = ?, integrity_oid = ?
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
        integrityOid,
        this.#checkoutId,
        expectedIntegrityOid,
      );
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
    });
  }

  /** Compare-and-swap one complete journal transition, including child rows. */
  replaceOperationJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#replaceOperationJournalOwned(expectedIntegrityOid, state, steps, touched);
  }

  #replaceOperationJournalOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    this.#db.transactionSync(() => {
      const current = this.#readOperationStateOwned();
      if (current === null) throw operationNotActive(state.kind);
      if (current.kind !== state.kind) throw operationKindMismatch(state.kind, current.kind);
      if (current.integrityOid !== expectedIntegrityOid) {
        throw new GitError("EOPMISMATCH", "operation state changed before replacement");
      }
      if (current.kind === "rebase") {
        if (state.kind !== "rebase") throw operationKindMismatch(state.kind, current.kind);
        requireRebaseJournalTransition(current, state, steps, touched);
      }
      const journal = operationJournal(state, steps, touched, integrityOid);
      this.#validateOperationObjects(journal);
      this.#db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.#checkoutId);
      this.#db.run("DELETE FROM git_operation_steps WHERE checkout_id = ?", this.#checkoutId);
      this.#db.run(
        "DELETE FROM git_operation_state WHERE checkout_id = ? AND integrity_oid = ?",
        this.#checkoutId,
        expectedIntegrityOid,
      );
      this.#insertOperationHeader(state, steps.length, touched.length, integrityOid);
      this.#insertOperationSteps(steps);
      this.#insertOperationTouched(touched);
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
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

      let active = true;
      let failed = false;
      let failure: unknown;
      let previousPath: string | null = null;
      let pending: IndexMutationBuffer | null = null;
      let blobIds: InitialBlobIdBuffer | null = null;
      try {
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
        const session: InitialStateSession = {
          put: (entry) => {
            attempt(() => {
              validateInitialIndexEntry(entry);
              if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
                throw new CorruptError("initial index entries are not in strict Git path order");
              }
              mutationBuffer.add(entry);
              previousPath = entry.path;
            });
          },
          addBlobId: (mapping) => {
            attempt(() => {
              blobBuffer.validate(mapping);
              if (!blobBuffer.willCache(mapping)) return;
              if (blobBuffer.needsFlush(mapping)) blobBuffer.flush();
              blobBuffer.add(mapping);
            });
          },
        };
        const finish = (): void => {
          attempt(() => mutationBuffer.flush());
          attempt(() => blobBuffer.finish());
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
        .all<{ oid: unknown }>("SELECT oid FROM git_shallow WHERE repo_id = ?", this.#repoId)
        .map((row) => expectText(row.oid, "stored shallow object id")),
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
  return `SELECT path, seq FROM git_config
          WHERE repo_id = ? AND path >= ? AND path < ?
          ORDER BY path COLLATE BINARY, seq
          LIMIT ${MAX_CONFIG_SECTION_MOVE_ROWS + 1}`;
}

export function requireConfigSectionMetadata(row: unknown): ConfigSectionCandidateMetadata {
  return CONFIG_SECTION_ROW.decode(row);
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
