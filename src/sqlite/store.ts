// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import pako from "pako";

import { concat, isOid, toHex } from "../core/bytes.js";
import { CorruptError, GitError, hasErrorCode, ObjectNotFoundError } from "../core/errors.js";
import { ByteLru } from "../core/lru.js";
import { hashObject, type ObjectType, objectHeader, type RawObject } from "../core/objects.js";
import {
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_PATH_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_STATE_BYTES,
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
} from "../core/ops/merge-state.js";
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
} from "../core/ops/operation-state.js";
import { Sha1 } from "../core/sha1.js";
import { comparePaths } from "../core/streams.js";
import { deflate, InflateInto, InflateSizeError, InflateStream, inflate } from "../core/zlib.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  indexCommitSource,
  insertCommitCaches,
  MAX_INDEXED_COMMIT_BYTES,
  prepareCommitCache,
  readCommitCache,
  readCommitGraph,
} from "./commits.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import {
  advanceMaintenanceRootSnapshot as advanceRootSnapshot,
  type MaintenanceRootSnapshotProgress,
  validatedOperationJournalRoots,
} from "./maintenance/roots.js";
import { MemoryCoordinator, type MemoryReservation } from "./memory.js";
import {
  MAX_PACK_BLOB_BATCH_BYTES,
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_ROW_CACHE_BYTES,
  type PackCacheOptions,
  PackStore,
} from "./packs.js";
import {
  boundedRefText,
  rawSymbolicTarget,
  requireRawRefTarget,
  requireRefName,
} from "./ref-validation.js";

export { PACK_BLOB_CALLER_HEADROOM_BYTES } from "./packs.js";

import { BLOB_ID_GENERATION_EXHAUSTED, MAX_CACHED_CONTENT_ID_BYTES } from "./blob-id-cache.js";
import {
  MAX_REFLOG_IDENTITY_BYTES,
  MAX_REFLOG_ORDINAL,
  MAX_REFLOG_RAW_TARGET_BYTES,
  MAX_REFLOG_REASON_BYTES,
  MAX_REFLOG_REF_BYTES,
  MAX_REFLOG_STATE_BYTES,
  MAX_REFLOG_STATE_ROWS,
  MAX_REFLOG_TIMEZONE_MINUTES,
} from "./reflog-schema.js";
import {
  initializeGitSchema,
  MAX_CHECKOUT_ROOT_BYTES,
  MAX_CHECKOUTS_PER_REPOSITORY,
} from "./schema.js";
import { indexSeededTreeSource, indexSeededTreeSources } from "./tree-index.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  TREE_WALK_PATH_BYTES,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "./tree-walk.js";

export type { WalkTreeDiffEntry, WalkTreeDiffObject, WalkTreeEntry } from "./tree-walk.js";
export { WALK_TREE_SQL } from "./tree-walk.js";

/** Bytes per `git_object_chunks` row. */
const OBJECT_CHUNK = 1024 * 1024;

/** Small loose objects cost more to deflate than storing their bytes directly. */
const RAW_OBJECT_MAX = 4 * 1024;

/** Deflate output chunk, and one row, for a streamed write. Smaller than
 *  OBJECT_CHUNK so a streamed object's peak is a chunk, not a megabyte. */
const STREAM_CHUNK = 64 * 1024;

/** Compressed bytes fed to the inflater at a time when streaming a read. */
const INFLATE_FEED = 16 * 1024;

/** Compressed bytes gathered into one `substr()` payload, and the trigger
 *  that flushes a batch. Well under the 2 MB ceiling on a bound value. */
const OBJECT_PAYLOAD = 1024 * 1024;

/** Objects buffered before a batch flushes. The JSON arrays are bound
 *  values too, so the row count is capped as well as the byte count. */
const DEFAULT_OBJECT_FLUSH = 4096;

/** Oids per existence-probe statement, bounding the same JSON parameter. */
const OID_PROBE_PAGE = 4096;

/** Opaque content ids encoded into one SQL BLOB parameter per statement. */
const CONTENT_ID_PAYLOAD = 1024 * 1024;
const CONTENT_ID_PAGE = 4096;

/** A blob batch shares the pack reader's conservative memory budget. */
export const MAX_BLOB_BATCH_BYTES = MAX_PACK_BLOB_BATCH_BYTES;
const MAX_BLOB_BATCH_OIDS = 4096;
export const MAX_LOG_STATE_BYTES = 32 * 1024 * 1024;

/** Index rows per round trip. This is the memory bound of a scan. */
const DEFAULT_INDEX_PAGE = 1000;

/** Index mutations buffered before a batch is applied. */
const DEFAULT_INDEX_FLUSH = 512;

/** Bound JSON stays below the Durable Object SQLite 2 MiB value ceiling. */
const INDEX_MUTATION_PAYLOAD = 1024 * 1024;
const INDEX_MUTATION_ROW_BYTES = 192;
const INITIAL_STATE_MEMORY_BYTES = 4 * 1024 * 1024;
const INITIAL_STATE_FIXED_BYTES = 64 * 1024;
const INITIAL_BLOB_ROW_JSON_BYTES = 96;

/** Parsed commits staged beside encoded object bytes before a batch flush. */
const COMMIT_STAGE_CACHE_BYTES = 16 * 1024 * 1024;

const DEFAULT_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
const REFLOG_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const REFLOG_RETENTION_ROWS = 1_024;
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
/** Two conservative SQL slots per row bound validation, grouping, and ordering together. */
export const REFLOG_ROOT_ENDPOINT_BYTES = 4_096;
export const MAX_REFLOG_ROOT_SCAN_ENTRIES = Math.floor(
  (MAX_REFLOG_ROOT_SCAN_BYTES - REFLOG_ROOT_SCAN_FIXED_BYTES) / (2 * REFLOG_ROOT_ENDPOINT_BYTES),
);
const MAX_REF_MUTATION_INPUTS = 100_000;
const MAX_FETCH_NAMESPACES = 1_024;
const MAX_FETCH_PUBLICATION_INPUTS = 100_000;
const MAX_GLOBAL_CHECKOUT_LIST = 8_192;
const CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES = 1_024;
export const MAX_CHECKOUT_LIST_RETAINED_BYTES = 6 * 1024 * 1024;
export const PROVISIONAL_CLONE_LEASE_MS = 5 * 60 * 1_000;
const PROVISIONAL_CLONE_RENEW_WINDOW_MS = PROVISIONAL_CLONE_LEASE_MS / 2;
const REF_ROW_RETAINED_BYTES = 256;
const REF_MUTATION_ITEM_RETAINED_BYTES = 512;
const REF_MUTATION_EVENT_RETAINED_BYTES = 2_048;
const REF_MUTATION_SQL_HEADROOM_BYTES = 8 * 1024 * 1024;
export const MAX_REF_MUTATION_RETAINED_BYTES = 64 * 1024 * 1024;
const REF_MUTATION_STATE_FIXED_RETAINED_BYTES =
  REF_ROW_RETAINED_BYTES + 2 * MAX_REFLOG_RAW_TARGET_BYTES;
export const REF_MUTATION_FIXED_RETAINED_BYTES =
  REF_MUTATION_SQL_HEADROOM_BYTES + REF_MUTATION_STATE_FIXED_RETAINED_BYTES;
/** Conservative SQL ceiling for one direct-ref or raw-HEAD publication. */
export const MAX_SINGLE_REF_MUTATION_SQL_STATEMENTS = 11;

export interface StoreOptions extends PackCacheOptions {
  /** Database-wide bytes of inflated objects held hot across reads. */
  objectCacheBytes?: number;
  /** Clock in milliseconds since the Unix epoch. */
  now?: () => number;
}

export interface CheckoutRow {
  readonly id: number;
  readonly repoId: number;
  readonly root: string;
  readonly head: string;
  readonly isPrimary: boolean;
}

export interface ProvisionalCloneOwner {
  readonly checkout: CheckoutRow;
  readonly generation: number;
  readonly store: CheckoutStore;
}

export type RepositoryLifecycle = "ready" | "provisional";

export interface RefRow {
  name: string;
  target: string;
}

export interface RefLogActor {
  name: string;
  email: string;
}

export interface RefLogMetadata {
  actor: RefLogActor | null;
  reason: string;
  timestamp: number;
  timezoneOffset: number;
}

interface RefMutationExpected {
  name: string;
  target: string | null;
}

export interface RefMutation {
  puts?: Iterable<RefRow>;
  deletes?: Iterable<string>;
  head?: string;
  expected?: RefMutationExpected;
}

export interface FetchPublicationExpectedRef {
  readonly name: string;
  readonly target: string | null;
}

export class FetchPublicationToken {
  readonly #isDisposed: () => boolean;
  readonly #dispose: () => void;

  constructor(
    readonly generation: number,
    readonly trackingPrefix: string,
    readonly namespaceRevision: number,
    readonly shallowRevision: number,
    readonly shallow: readonly string[],
    readonly trackingRefs: readonly Readonly<RefRow>[],
    readonly globalRefs: readonly FetchPublicationExpectedRef[],
    isDisposed: () => boolean,
    dispose: () => void,
  ) {
    this.#isDisposed = isDisposed;
    this.#dispose = dispose;
  }

  get disposed(): boolean {
    return this.#isDisposed();
  }

  dispose(): void {
    this.#dispose();
  }
}

export interface FetchPublicationPlan {
  /** Tracking refs learned from the advertisement, excluding the remote HEAD symref. */
  trackingPuts?: Iterable<RefRow>;
  /** When present, prune tracking refs absent from this advertised keep-set. */
  trackingKeep?: Iterable<string>;
  /** `undefined` leaves remote HEAD alone; `null` deletes it. */
  remoteHead?: string | null;
  /** Global tags selected from the candidates supplied when the token was issued. */
  globalTagPuts?: Iterable<RefRow>;
  shallowAdd?: Iterable<string>;
  shallowRemove?: Iterable<string>;
}

export interface RefLogEntry {
  refName: string;
  ordinal: number;
  oldRaw: string | null;
  newRaw: string | null;
  oldOid: string | null;
  newOid: string | null;
  actor: RefLogActor | null;
  timestamp: number;
  timezoneOffset: number;
  reason: string;
}

export interface RefLogReadOptions {
  /** Maximum rows returned. Public reads cap this at 1,000. */
  limit?: number;
  /** Resume strictly before this repository-wide ordinal. */
  before?: number;
}

interface RefLogEvent {
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

interface CheckoutRefLogEvent extends RefLogEvent {
  checkoutId: number;
}

interface NormalizedRefMutation {
  puts: Map<string, string>;
  deletes: Set<string>;
  head: string | undefined;
  expected: RefMutationExpected | undefined;
  budget: RefMutationBudget;
}

interface FetchPublicationState {
  readonly generation: number;
  readonly trackingPrefix: string;
  readonly namespaceRevision: number;
  readonly shallowRevision: number;
  readonly trackingRefs: ReadonlyMap<string, string>;
  readonly globalRefs: ReadonlyMap<string, string | null>;
  readonly budget: RefMutationBudget;
  readonly reservation: MemoryReservation;
  disposed: boolean;
}

interface NormalizedFetchPublication {
  readonly refs: NormalizedRefMutation;
  readonly shallowAdd: readonly string[];
  readonly shallowRemove: readonly string[];
}

export interface IndexEntry {
  path: string;
  stage: number;
  /** Full git mode, e.g. 0o100644. */
  mode: number;
  oid: string;
  /** Working-tree facts recorded when the entry was written, for status. */
  size: number | null;
  mtime: number | null;
  ino: number | null;
  /** Monotonic filesystem revision, absent on indexes created before schema v5. */
  rev?: number | null;
}

export interface IndexScanOptions {
  /** Resume strictly after this (path, stage). */
  after?: { path: string; stage: number };
  /** Only the path equal to, or under, this repo-relative prefix. */
  prefix?: string;
  /** Rows per round trip. This is the memory bound of the scan. */
  pageSize?: number;
}

export interface IndexApplyOptions {
  /** Mutations buffered before a batch is written. */
  flushEvery?: number;
}

export interface ObjectBatchOptions {
  /** Stored bytes buffered before a flush, and the cap on one payload. */
  payloadBytes?: number;
  /** Objects buffered before a flush. */
  flushEvery?: number;
}

export interface BlobIdMapping {
  contentId: Uint8Array;
  oid: string;
}

export interface InitialStateSession {
  readonly retainedBytes: number;
  put(entry: IndexEntry): void;
  addBlobId(mapping: BlobIdMapping): void;
}

interface OperationStateRow {
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

interface OperationStepRow {
  ordinal: unknown;
  source_oid: unknown;
  selected_parent_oid: unknown;
  mainline: unknown;
  outcome: unknown;
  result_oid: unknown;
}

interface OperationTouchedRow {
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

interface PersistedOperationTouched {
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

interface PersistedOperationStep {
  ordinal: number;
  sourceOid: string;
  selectedParentOid: string | null;
  mainline: number | null;
  outcome: string;
  resultOid: string | null;
}

export type InitialStateResult<T> = { available: false } | { available: true; value: T };

export interface BlobReadBatch {
  /** Complete blob contents, keyed by oid in first-occurrence input order. */
  blobs: Map<string, Uint8Array>;
  /** Deduplicated oids deferred to the next call. */
  remaining: string[];
  /** Sum of the returned blob sizes. */
  bytes: number;
}

export interface ObjectReadBatch {
  /** Complete objects, keyed by oid in first-occurrence input order. */
  objects: Map<string, RawObject>;
  /** Deduplicated oids deferred to the next call. */
  remaining: string[];
  /** Sum of the returned inflated object sizes. */
  bytes: number;
}

export interface ObjectReadInfo {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
  /** Stored loose rows; zero for packed objects. */
  chunkRows: number;
}

interface ExpectedOperationObject {
  oid: string;
  type: "blob" | "commit";
  label: string;
}

/** Stable, collision-free key for an opaque binary content id. */
export function contentIdKey(contentId: Uint8Array): string {
  return toHex(contentId);
}

/**
 * A bounded sink for loose object writes. `write` hashes and encodes, so
 * the oid it returns is final, but no row exists until `flush`: a staged
 * object is invisible to `read`, `has` and `readChunks` until then.
 */
export interface ObjectBatch {
  write(type: ObjectType, data: Uint8Array): string;
  /** Write whatever is staged. Called for you when `writeObjects` returns. */
  flush(): void;
}

type LooseEncoding = "raw" | "zlib";

/** One object staged in a batch, already hashed and encoded for storage. */
interface StagedObject {
  oid: string;
  type: ObjectType;
  size: number;
  stored: LooseEncoding;
  storedData: Uint8Array;
  treeData?: Uint8Array;
  commitEntry?: CommitCacheEntry;
}

/** One `substr()` payload: the bytes, and the rows cut out of them. */
interface ChunkPayload {
  parts: Uint8Array[];
  length: number;
  rows: { o: string; q: number; a: number; n: number }[];
}

interface ContentIdPage {
  payload: Uint8Array;
  rows: { a: number; n: number }[];
}

interface ExpectedContentIdPage {
  payload: Uint8Array;
  rows: { i: number; a: number; n: number; o: string }[];
}

interface BlobIdWriteRow {
  a: number;
  n: number;
  o: string;
}

export const MAX_BLOB_ID_MISMATCH_RETAINED_BYTES = 16 * 1024 * 1024;
export const MAX_BLOB_ID_INPUT_RETAINED_BYTES = 16 * 1024 * 1024;
const BLOB_ID_MISMATCH_ROW_BYTES = 384;

export function blobIdMismatchRetainedBytes(mapping: BlobIdMapping): number {
  return BLOB_ID_MISMATCH_ROW_BYTES + mapping.contentId.length + mapping.oid.length * 2;
}

function contentIdPages(contentIds: Iterable<Uint8Array>): ContentIdPage[] {
  const unique = new Map<string, Uint8Array>();
  let retainedBytes = 0;
  for (const contentId of contentIds) {
    if (contentId.length > MAX_CACHED_CONTENT_ID_BYTES) continue;
    const key = contentIdKey(contentId);
    if (!unique.has(key)) {
      const bytes = BLOB_ID_MISMATCH_ROW_BYTES + contentId.length + key.length * 2;
      if (bytes > MAX_BLOB_ID_INPUT_RETAINED_BYTES - retainedBytes) {
        throw new GitError(
          "E2BIG",
          `blob id lookup state exceeds ${MAX_BLOB_ID_INPUT_RETAINED_BYTES} bytes`,
        );
      }
      retainedBytes += bytes;
    }
    unique.set(key, contentId);
  }
  const pages: ContentIdPage[] = [];
  let parts: Uint8Array[] = [];
  let rows: { a: number; n: number }[] = [];
  let length = 0;
  const flush = (): void => {
    if (rows.length === 0) return;
    pages.push({ payload: concat(parts), rows });
    parts = [];
    rows = [];
    length = 0;
  };
  for (const contentId of unique.values()) {
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      flush();
    }
    rows.push({ a: length + 1, n: contentId.length });
    parts.push(contentId);
    length += contentId.length;
  }
  flush();
  return pages;
}

function writeBlobIdPage(
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
function* expectedContentIdPages(
  mappings: readonly BlobIdMapping[],
): Generator<ExpectedContentIdPage> {
  let parts: Uint8Array[] = [];
  let rows: { i: number; a: number; n: number; o: string }[] = [];
  let length = 0;

  for (let ordinal = 0; ordinal < mappings.length; ordinal++) {
    const mapping = mappings[ordinal];
    if (mapping === undefined) continue;
    if (mapping.contentId.length > MAX_CACHED_CONTENT_ID_BYTES) continue;
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      yield { payload: concat(parts), rows };
      parts = [];
      rows = [];
      length = 0;
    }
    rows.push({ i: ordinal, a: length + 1, n: mapping.contentId.length, o: mapping.oid });
    parts.push(mapping.contentId);
    length += mapping.contentId.length;
  }
  if (rows.length > 0) yield { payload: concat(parts), rows };
}

function requireCommitCacheWrites(result: CommitCacheWriteResult, expected: number): void {
  if (result.written !== expected || result.eligible !== expected || result.skipped !== 0) {
    throw new CorruptError(`commit cache wrote ${result.written} of ${expected} required rows`);
  }
}

interface BufferedIndexMutation {
  kind: "p" | "r";
  json: string;
  bytes: number;
}

function looseEncoding(size: number): LooseEncoding {
  return size <= RAW_OBJECT_MAX ? "raw" : "zlib";
}

function encodeLoose(data: Uint8Array, stored: LooseEncoding): Uint8Array {
  return stored === "raw" ? data : deflate(data);
}

function parseLooseEncoding(stored: string): LooseEncoding {
  if (stored === "raw" || stored === "zlib") return stored;
  throw new CorruptError(`loose object has unknown storage encoding '${stored}'`);
}

function isObjectType(value: string | null): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

const JSON_ENCODER = new TextEncoder();
const JSON_BATCH_ROWS = 2_048;
const JSON_BATCH_BYTES = 1024 * 1024;

function* jsonPages<T>(items: Iterable<T>, label: string): Generator<string> {
  let rows: string[] = [];
  let bytes = 2;
  for (const item of items) {
    const row = JSON.stringify(item);
    const rowBytes = JSON_ENCODER.encode(row).byteLength;
    const separator = rows.length === 0 ? 0 : 1;
    if (
      rows.length > 0 &&
      (rows.length >= JSON_BATCH_ROWS || bytes + separator + rowBytes > JSON_BATCH_BYTES)
    ) {
      yield `[${rows.join(",")}]`;
      rows = [];
      bytes = 2;
    }
    if (2 + rowBytes > JSON_BATCH_BYTES) {
      throw new GitError("E2BIG", `one ${label} exceeds the 1 MiB JSON batch limit`);
    }
    bytes += (rows.length === 0 ? 0 : 1) + rowBytes;
    rows.push(row);
  }
  if (rows.length > 0) yield `[${rows.join(",")}]`;
}

function requireNullableRawRefTarget(value: unknown, label: string): string | null {
  return value === null ? null : requireRawRefTarget(value, label, "stored");
}

function requireNullableRefLogOid(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`${label} is not a valid object id`);
  }
  return value;
}

function requireStoredRefLogEndpoint(
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

function requireSafeRefLogInteger(
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

function requireRefLogIdentityText(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new CorruptError(`${label} is invalid`);
  }
  boundedRefText(value, label, MAX_REFLOG_IDENTITY_BYTES, "stored");
  return value;
}

function requireStoredRefLogEntry(row: Record<string, unknown>, repoId: number): RefLogEntry {
  if (row.repo_id !== repoId) throw new CorruptError("reflog row belongs to another repository");
  const refName = requireRefName(row.ref_name, "reflog ref name", "stored", true);
  const ordinal = requireSafeRefLogInteger(row.ordinal, "reflog ordinal", 1, MAX_REFLOG_ORDINAL);
  const oldEndpoint = requireStoredRefLogEndpoint(row.old_raw, row.old_oid, "old");
  const newEndpoint = requireStoredRefLogEndpoint(row.new_raw, row.new_oid, "new");
  if (
    refName !== "HEAD" &&
    oldEndpoint.raw === newEndpoint.raw &&
    oldEndpoint.oid === newEndpoint.oid
  ) {
    throw new CorruptError("reflog row does not change either endpoint");
  }
  let actor: RefLogActor | null;
  if (row.actor_name === null && row.actor_email === null) {
    actor = null;
  } else if (row.actor_name !== null && row.actor_email !== null) {
    actor = {
      name: requireRefLogIdentityText(row.actor_name, "reflog actor name"),
      email: requireRefLogIdentityText(row.actor_email, "reflog actor email"),
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
  if (typeof row.reason !== "string" || row.reason === "") {
    throw new CorruptError("reflog reason is invalid");
  }
  boundedRefText(row.reason, "reflog reason", MAX_REFLOG_REASON_BYTES, "stored");
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
    reason: row.reason,
  };
}

function requireRefLogReadInteger(
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

function requireRefLogLimit(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 1_000) {
    throw new GitError("E2BIG", "reflog limit exceeds 1,000 entries");
  }
  return requireRefLogReadInteger(value, "reflog limit", 0, 1_000);
}

function validateRefLogRootScanBudget(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError("reflog root budget query returned an invalid row count");
  }
  if (value > MAX_REFLOG_ROOT_SCAN_ENTRIES) {
    throw new GitError("E2BIG", "active reflog root scan exceeds its bounded SQL state");
  }
}

function isAttachedBranchUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: git_checkouts.repo_id, git_checkouts.head")
  );
}

function isCheckoutRootUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed: git_checkouts.root")
  );
}

function requireRefLogHeader(row: Record<string, unknown>, repoId: number): number {
  if (row.repo_id !== repoId) throw new CorruptError("reflog header belongs to another repository");
  requireRawRefTarget(row.head, "stored HEAD target", "stored");
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

function validateRefLogMetadata(metadata: RefLogMetadata): RefLogMetadata {
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
  boundedRefText(metadata.reason, "reflog reason", MAX_REFLOG_REASON_BYTES, "input");
  if (metadata.actor !== null) {
    if (metadata.actor.name === "" || metadata.actor.email === "") {
      throw new GitError("EINVAL", "reflog actor name and email are required together");
    }
    boundedRefText(metadata.actor.name, "reflog actor name", MAX_REFLOG_IDENTITY_BYTES, "input");
    boundedRefText(metadata.actor.email, "reflog actor email", MAX_REFLOG_IDENTITY_BYTES, "input");
  }
  return metadata;
}

function invalidFetchTrackingPrefix(source: "input" | "stored"): never {
  if (source === "stored") throw new CorruptError("stored fetch tracking prefix is invalid");
  throw new GitError("EINVAL", "fetch tracking prefix must identify refs/remotes/<remote>/");
}

function requireFetchTrackingPrefix(value: unknown, source: "input" | "stored"): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("refs/remotes/") ||
    value === "refs/remotes/" ||
    !value.endsWith("/")
  ) {
    invalidFetchTrackingPrefix(source);
  }
  boundedRefText(value, "fetch tracking prefix", MAX_REFLOG_REF_BYTES - 1, source);
  requireRefName(`${value}x`, "fetch tracking namespace", source);
  return value;
}

function requireFetchGeneration(value: unknown, label: string, minimum: number): number {
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

function staleFetch(message: string): GitError {
  return new GitError("ESTALEFETCH", message);
}

class RefMutationBudget {
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
  const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
  const nameBytes = boundedRefText(name, "updated ref name", MAX_REFLOG_REF_BYTES, "input");
  const targetBytes = boundedRefText(
    target,
    `target of ${name}`,
    MAX_REFLOG_RAW_TARGET_BYTES,
    "input",
  );
  return (
    REF_MUTATION_ITEM_RETAINED_BYTES +
    REF_MUTATION_EVENT_RETAINED_BYTES +
    4 * (nameBytes + targetBytes)
  );
}

export function refMutationCheckoutRetainedBytes(checkout: { root: string; head: string }): number {
  const root = requireCheckoutRoot(checkout.root, "stored");
  const head = requireRawRefTarget(checkout.head, "stored HEAD target", "stored");
  const retained =
    1_024 +
    2 *
      (checkoutTextEncoder.encode(root).byteLength +
        boundedRefText(head, "stored HEAD target", MAX_REFLOG_RAW_TARGET_BYTES, "stored"));
  return Math.ceil(retained / 4) * 4;
}

function normalizeRefMutation(
  mutation: RefMutation,
  budget: RefMutationBudget,
): NormalizedRefMutation {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  let inputs = 0;
  const charge = (nameBytes: number, targetBytes = 0): void => {
    inputs++;
    if (inputs > MAX_REF_MUTATION_INPUTS) {
      throw new GitError("E2BIG", "ref mutation exceeds its retained input count bound");
    }
    budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + nameBytes * 2 + targetBytes * 2);
  };
  for (const value of mutation.deletes ?? []) {
    const name = requireRefName(value, "deleted ref name", "input");
    charge(boundedRefText(name, "deleted ref name", MAX_REFLOG_REF_BYTES, "input"));
    deletes.add(name);
  }
  for (const row of mutation.puts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "ref update row is invalid");
    }
    const name = requireRefName(row.name, "updated ref name", "input");
    const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
    charge(
      boundedRefText(name, "updated ref name", MAX_REFLOG_REF_BYTES, "input"),
      boundedRefText(target, `target of ${name}`, MAX_REFLOG_RAW_TARGET_BYTES, "input"),
    );
    puts.set(name, target);
  }
  const head =
    mutation.head === undefined
      ? undefined
      : requireRawRefTarget(mutation.head, "HEAD target", "input");
  if (head !== undefined) {
    charge(4, boundedRefText(head, "HEAD target", MAX_REFLOG_RAW_TARGET_BYTES, "input"));
  }
  let expected: RefMutationExpected | undefined;
  if (mutation.expected !== undefined) {
    const name = requireRefName(mutation.expected.name, "conditional ref name", "input");
    const nameBytes = boundedRefText(name, "conditional ref name", MAX_REFLOG_REF_BYTES, "input");
    const target =
      mutation.expected.target === null
        ? null
        : requireRawRefTarget(mutation.expected.target, `expected target of ${name}`, "input");
    const targetBytes =
      target === null
        ? 0
        : boundedRefText(
            target,
            `expected target of ${name}`,
            MAX_REFLOG_RAW_TARGET_BYTES,
            "input",
          );
    budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + 2 * (nameBytes + targetBytes));
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

function normalizeFetchPublication(
  state: FetchPublicationState,
  plan: FetchPublicationPlan,
): NormalizedFetchPublication {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  const keep = new Set<string>();
  const remoteHeadName = `${state.trackingPrefix}HEAD`;
  let inputs = 0;
  const charge = (name: string, label: string, target?: string): void => {
    inputs++;
    if (inputs > MAX_FETCH_PUBLICATION_INPUTS) {
      throw new GitError("E2BIG", "fetch publication exceeds its retained input count bound");
    }
    const nameBytes = boundedRefText(name, label, MAX_REFLOG_REF_BYTES, "input");
    const targetBytes =
      target === undefined
        ? 0
        : boundedRefText(target, `target of ${name}`, MAX_REFLOG_RAW_TARGET_BYTES, "input");
    state.budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + 2 * (nameBytes + targetBytes));
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
      charge(remoteHeadName, "remote HEAD ref name");
      deletes.add(remoteHeadName);
    } else {
      const target = requireRawRefTarget(plan.remoteHead, "remote HEAD target", "input");
      charge(remoteHeadName, "remote HEAD ref name", target);
      puts.set(remoteHeadName, target);
    }
  }

  for (const row of plan.globalTagPuts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "fetch global tag update row is invalid");
    }
    const name = requireRefName(row.name, "fetch global tag name", "input");
    if (!name.startsWith("refs/tags/") || !state.globalRefs.has(name)) {
      throw new GitError("EINVAL", `global tag ${name} was not included in the issued snapshot`);
    }
    const target = requireRawRefTarget(row.target, `target of ${name}`, "input");
    charge(name, "fetch global tag name", target);
    puts.set(name, target);
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
    budget: state.budget,
  };
  return {
    refs,
    shallowAdd: [...shallowAdd],
    shallowRemove: [...shallowRemove],
  };
}

function resolveRawRef(raw: string | null, lookup: (name: string) => string | null): string | null {
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

function refLogEventRetainedBytes(
  refName: string,
  oldRaw: string | null,
  newRaw: string | null,
): number {
  const refBytes = boundedRefText(refName, "reflog ref name", MAX_REFLOG_REF_BYTES, "input");
  const oldBytes =
    oldRaw === null
      ? 0
      : boundedRefText(oldRaw, "reflog old raw target", MAX_REFLOG_RAW_TARGET_BYTES, "input");
  const newBytes =
    newRaw === null
      ? 0
      : boundedRefText(newRaw, "reflog new raw target", MAX_REFLOG_RAW_TARGET_BYTES, "input");
  return REF_MUTATION_EVENT_RETAINED_BYTES + 2 * (refBytes + oldBytes + newBytes);
}

function serializeIndexMutation(
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

class IndexMutationBuffer {
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
      this.#bytes + separator + mutation.bytes > INDEX_MUTATION_PAYLOAD
    ) {
      this.flush();
      mutation = serializeIndexMutation(item, 0);
    }
    if (2 + mutation.bytes > INDEX_MUTATION_PAYLOAD) {
      throw new GitError("E2BIG", "one index mutation exceeds the 1 MiB JSON batch limit");
    }
    this.#bytes += (this.#pending.length === 0 ? 0 : 1) + mutation.bytes;
    this.#pending.push(mutation);
    if (this.#pending.length >= this.flushEvery) this.flush();
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

function validNullableIndexInteger(value: number | null | undefined): boolean {
  return value === null || value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function initialPathJsonBytes(path: string): number {
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
    if (utf8Bytes > TREE_WALK_PATH_BYTES) {
      throw new GitError("E2BIG", `initial index path exceeds ${TREE_WALK_PATH_BYTES} UTF-8 bytes`);
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

function validateInitialIndexEntry(entry: IndexEntry): number {
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

function operationIdentityFromRow(
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

function requireOperationKind(value: unknown): OperationKind {
  if (value === "merge" || value === "cherry-pick" || value === "revert" || value === "rebase") {
    return value;
  }
  throw new CorruptError("operation journal has an invalid kind");
}

function requireNullableOperationOid(value: unknown, label: string): string | null {
  return value === null ? null : requireMergeOid(value, label);
}

function requireNullableMainline(value: unknown): number | null {
  if (value === null) return null;
  const mainline = requireMergeInteger(value, "mainline");
  if (mainline === 0) throw new CorruptError("replay mainline is not positive");
  return mainline;
}

function operationStepFromRow(row: OperationStepRow): OperationStepMetadata {
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

function operationMetadataFromRow(
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

function operationJournal(
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

function sameOperationStep(left: OperationStepMetadata, right: OperationStepMetadata): boolean {
  return (
    left.sourceOid === right.sourceOid &&
    left.selectedParentOid === right.selectedParentOid &&
    left.mainline === right.mainline &&
    left.outcome === right.outcome &&
    left.resultOid === right.resultOid
  );
}

function requireInitialRebaseJournal(
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

function requireRebaseJournalTransition(
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

function operationIndexFromRow(row: OperationTouchedRow): MergeIndexSnapshot | null {
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

function operationWorktreeFromRow(row: OperationTouchedRow): MergeWorktreeSnapshot {
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

function operationTouchedFromRow(row: OperationTouchedRow): MergeTouchedPath {
  return {
    path: requireMergeText(row.path, "touched path"),
    logicalPath: requireMergeText(row.logical_path, "logical path"),
    purpose: requireMergePurpose(row.purpose),
    index: operationIndexFromRow(row),
    worktree: operationWorktreeFromRow(row),
  };
}

function persistedOperationTouched(
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

function persistedOperationStep(
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

function requireBooleanProbe(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} returned an invalid value`);
  return value === 1;
}

class InitialBlobIdBuffer {
  #payload: Uint8Array | null = new Uint8Array(CONTENT_ID_PAYLOAD);
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
    return BLOB_ID_MISMATCH_ROW_BYTES + INITIAL_BLOB_ROW_JSON_BYTES * 2;
  }

  willCache(mapping: BlobIdMapping): boolean {
    return mapping.contentId.length <= MAX_CACHED_CONTENT_ID_BYTES;
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
    const payload = this.#payload;
    if (payload === null) throw new Error("initial blob id buffer is disposed");
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

function isThenableResult(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}

/** A bounded, ordered mutation sink over the index. */
export interface IndexSink {
  put(entry: IndexEntry): void;
  remove(path: string): void;
  /** Apply whatever is buffered. Called for you when `indexApply` returns. */
  flush(): void;
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

const checkoutTextEncoder = new TextEncoder();

function requireSafeId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CorruptError(`${label} is not a safe positive integer`);
  }
  return value;
}

function requireIdentityCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError(`${label} is not a safe nonnegative integer`);
  }
  return value;
}

function requireStoredIdentityMaximum(value: unknown, label: string): number {
  return value === null ? 0 : requireSafeId(value, label);
}

function nextIdentity(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new GitError("E2BIG", `${label} space is exhausted`);
  }
  return value + 1;
}

function requireMilliseconds(value: unknown, label: string, source: "input" | "stored"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    if (source === "stored") throw new CorruptError(`${label} is invalid`);
    throw new GitError("EINVAL", `${label} must be a safe nonnegative integer`);
  }
  return value;
}

function provisionalCloneExpiry(nowMs: number): number {
  if (nowMs > Number.MAX_SAFE_INTEGER - PROVISIONAL_CLONE_LEASE_MS) {
    throw new GitError("E2BIG", "clone lease clock exceeds its safe range");
  }
  return nowMs + PROVISIONAL_CLONE_LEASE_MS;
}

interface StoredRepositoryLifecycle {
  repoId: number;
  lifecycle: RepositoryLifecycle;
  cloneGeneration: number | null;
  cloneExpiresMs: number | null;
}

function requireStoredRepositoryLifecycle(row: Record<string, unknown>): StoredRepositoryLifecycle {
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

interface StoredCheckoutLifecycle extends StoredRepositoryLifecycle {
  checkout: CheckoutRow;
}

const CHECKOUT_LIFECYCLE_CARDINALITY_SQL = `
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

function requireStoredCheckoutLifecycle(row: Record<string, unknown>): StoredCheckoutLifecycle {
  const checkout = requireStoredCheckoutRow(row);
  const repository = requireStoredRepositoryLifecycle(row);
  if (checkout.repoId !== repository.repoId) {
    throw new CorruptError("checkout lifecycle crossed repository boundaries");
  }
  return { ...repository, checkout };
}

function requireCheckoutLifecycleCardinality(
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

function requireCheckoutRoot(value: unknown, source: "input" | "stored"): string {
  if (typeof value !== "string" || value.includes("\0")) {
    if (source === "stored") throw new CorruptError("checkout root is invalid");
    throw new GitError("EINVAL", "checkout root is invalid");
  }
  const canonical = normalizeRoot(value);
  const bytes = checkoutTextEncoder.encode(canonical).byteLength;
  if (bytes > MAX_CHECKOUT_ROOT_BYTES) {
    if (source === "stored") throw new CorruptError("checkout root exceeds its stored byte bound");
    throw new GitError("E2BIG", `checkout root exceeds ${MAX_CHECKOUT_ROOT_BYTES} UTF-8 bytes`);
  }
  if (source === "stored" && canonical !== value) {
    throw new CorruptError("checkout root is not canonical");
  }
  return canonical;
}

function requireStoredCheckoutRow(row: Record<string, unknown>): CheckoutRow {
  const id = requireSafeId(row.checkout_id, "checkout id");
  const repoId = requireSafeId(row.repo_id, "checkout repository id");
  const root = requireCheckoutRoot(row.root, "stored");
  const head = requireRawRefTarget(row.head, "stored HEAD target", "stored");
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

function enforceForeignKeys(db: SqlDatabase): void {
  db.run("PRAGMA foreign_keys = ON");
  if (db.scalar<unknown>("PRAGMA foreign_keys") !== 1) {
    throw new Error("SQLite adapter did not enable foreign-key enforcement");
  }
}

class CheckoutStoreLifetime {
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

/** Canonical resources shared by every checkout view of one Git store. */
export class SharedRepoStore {
  readonly db: SqlDatabase;
  readonly repoId: number;
  readonly objects: ByteLru<string, RawObject>;
  readonly packRows: ByteLru<string, Uint8Array>;
  readonly memory: MemoryCoordinator;
  readonly cacheNamespace: string;
  #packs: PackStore | null = null;
  #operations: CheckoutStore | null = null;
  #cacheGeneration = 0;
  #hasLoose: boolean;
  #shallow: Set<string> | null = null;

  constructor(
    db: SqlDatabase,
    repoId: number,
    storeGeneration: number,
    objects: ByteLru<string, RawObject>,
    packRows: ByteLru<string, Uint8Array>,
    memory: MemoryCoordinator,
  ) {
    this.db = db;
    this.repoId = repoId;
    this.objects = objects;
    this.packRows = packRows;
    this.memory = memory;
    this.cacheNamespace = `${repoId}:${storeGeneration}`;
    const availability = db.one<{ has_loose: unknown }>(
      `SELECT
         (SELECT COUNT(*) FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)) AS has_loose`,
      repoId,
    );
    if (
      availability === undefined ||
      (availability.has_loose !== 0 && availability.has_loose !== 1)
    ) {
      throw new CorruptError("shared store availability probe returned an invalid value");
    }
    this.#hasLoose = availability.has_loose === 1;
  }

  installPacks(packs: PackStore): PackStore {
    if (this.#packs === null) this.#packs = packs;
    return this.#packs;
  }

  installOperations(operations: CheckoutStore): void {
    if (operations.sharedRepoId !== this.repoId) {
      throw new CorruptError("shared operations facade belongs to another repository");
    }
    if (this.#operations === null) this.#operations = operations;
  }

  #ops(): CheckoutStore {
    if (this.#operations === null) {
      throw new CorruptError("shared repository operations facade is unavailable");
    }
    return this.#operations;
  }

  get packs(): PackStore {
    if (this.#packs === null) {
      throw new CorruptError("shared pack facade is unavailable");
    }
    return this.#packs;
  }

  get hasLoose(): boolean {
    return this.#hasLoose;
  }

  markLoose(): void {
    this.#hasLoose = true;
  }

  objectCacheKey(oid: string): string {
    return `${this.cacheNamespace}:${this.#cacheGeneration}:loose:${oid}`;
  }

  clearCaches(): void {
    this.#cacheGeneration++;
    this.#packs?.clearCaches();
    this.#hasLoose = false;
    this.#shallow = null;
  }

  /** Invalidate storage caches and re-read current loose-object availability. */
  revalidateStorageCaches(): void {
    this.#cacheGeneration++;
    this.#packs?.clearCaches();
    this.#hasLoose = true;
    this.#shallow = null;
    let availability: boolean | undefined;
    let rows = 0;
    for (const row of this.db.iterate(
      `SELECT /* loose-storage-availability */
              COUNT(*) AS has_loose
         FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)`,
      this.repoId,
    )) {
      if ((row.has_loose !== 0 && row.has_loose !== 1) || rows !== 0) {
        throw new CorruptError("loose object availability probe returned an invalid value");
      }
      availability = row.has_loose === 1;
      rows++;
    }
    if (rows !== 1 || availability === undefined) {
      throw new CorruptError("loose object availability probe returned an invalid value");
    }
    this.#hasLoose = availability;
  }

  cacheBytes(): { objects: number; chunks: number } {
    return this.#ops().cacheBytes();
  }

  reserveMemory(): MemoryReservation {
    return this.memory.reserve();
  }

  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.#ops().lookupBlobIds(contentIds);
  }

  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    return this.#ops().blobIdMismatches(expected);
  }

  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    this.#ops().upsertBlobIds(mappings);
  }

  has(oid: string): boolean {
    return this.#ops().has(oid);
  }

  hasAll(oids: Iterable<string>): Set<string> {
    return this.#ops().hasAll(oids);
  }

  missing(oids: Iterable<string>): string[] {
    return this.#ops().missing(oids);
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.#ops().typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    return this.#ops().read(oid);
  }

  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return this.#ops().objectInfo(oids);
  }

  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.#ops().readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.#ops().readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* this.#ops().walkTree(treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* this.#ops().walkTreeDiff(beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* this.#ops().walkTreeDiffObjects(beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    return this.#ops().write(type, data);
  }

  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return this.#ops().writeStream(type, size, chunks);
  }

  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.#ops().writeBatch(options);
  }

  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return this.#ops().writeObjects(body, options);
  }

  readChunks(oid: string): Iterable<Uint8Array> | null {
    return this.#ops().readChunks(oid);
  }

  resolvePrefix(prefix: string): string | null {
    return this.#ops().resolvePrefix(prefix);
  }

  objectCount(): number {
    return this.#ops().objectCount();
  }

  getRef(name: string): string | null {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#ops().getRef(name);
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.#ops().setRef(name, target);
  }

  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    this.#ops().updateRefExpected(name, expectedOid, targetOid);
  }

  deleteRef(name: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.#ops().deleteRef(name);
  }

  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.#ops().updateRefs(puts, deletes);
  }

  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    if (mutation.head !== undefined) throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#ops().mutateRefs(mutation, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateGlobalRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.#ops().beginFetchPublication(trackingPrefix, candidateGlobalRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return this.#ops().publishFetchRefs(token, plan, metadata);
  }

  listRefs(prefix = ""): RefRow[] {
    return this.#ops().listRefs(prefix);
  }

  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    if (refName === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#ops().reflog(refName, options);
  }

  activeRefLogOids(): Generator<string> {
    return this.#ops().activeRefLogOids();
  }

  configGetAll(path: string): string[] {
    return this.#ops().configGetAll(path);
  }

  configGet(path: string): string | undefined {
    return this.#ops().configGet(path);
  }

  configGetBounded(path: string, maxBytes: number): string | undefined {
    return this.#ops().configGetBounded(path, maxBytes);
  }

  configSet(path: string, value: string): void {
    this.#ops().configSet(path, value);
  }

  configAdd(path: string, value: string): void {
    this.#ops().configAdd(path, value);
  }

  configUnset(path: string): void {
    this.#ops().configUnset(path);
  }

  configPaths(prefix: string): string[] {
    return this.#ops().configPaths(prefix);
  }

  cachedCommit(oid: string): CommitCacheEntry | null {
    return this.#ops().cachedCommit(oid);
  }

  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return this.#ops().prepareCommit(oid, data);
  }

  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return this.#ops().cacheCommit(oid, data);
  }

  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return this.#ops().cacheCommits(entries);
  }

  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return this.#ops().commitGraph(rootOid, limits);
  }

  shallow(): Set<string> {
    if (this.#shallow === null) this.#shallow = this.#ops().shallow();
    return new Set(this.#shallow);
  }

  invalidateShallow(): void {
    this.#shallow = null;
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.#ops().setShallow(add, remove);
    this.#shallow = null;
  }

  destroy(): void {
    this.#ops().destroy();
  }
}

interface ProvisionalStoreRecord {
  generation: number;
  repoId: number;
  checkoutId: number;
  shared: SharedRepoStore;
  store: CheckoutStore;
  lifetime: CheckoutStoreLifetime;
}

interface AllocatedIdentity {
  repoId: number;
  checkoutId: number;
  cloneGeneration: number;
}

/** Owns the schema plus shared-store and checkout facade registries. */
export class SqliteGitDatabase {
  readonly #db: SqlDatabase;
  readonly #options: StoreOptions;
  readonly #sharedStores = new Map<number, SharedRepoStore>();
  readonly #checkoutStores = new Map<number, CheckoutStore>();
  readonly #checkoutLifetimes = new Map<number, CheckoutStoreLifetime>();
  readonly #validatedCheckoutRows = new WeakMap<CheckoutRow, number>();
  readonly #checkoutRowGenerations = new Map<number, number>();
  readonly #provisionalStores = new Map<number, ProvisionalStoreRecord>();
  readonly #issuedProvisionalOwners = new WeakSet<ProvisionalCloneOwner>();
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packRows: ByteLru<string, Uint8Array>;
  readonly #memory = new MemoryCoordinator();
  #nextStoreGeneration = 1;
  #nextCheckoutRowGeneration = 1;

  constructor(db: SqlDatabase, options: StoreOptions = {}) {
    this.#db = db;
    this.#options = options;
    this.#objects = new ByteLru(
      Math.min(options.objectCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES, DEFAULT_OBJECT_CACHE_BYTES),
      (object) => object.data.length,
    );
    this.#packRows = new ByteLru(
      Math.min(options.chunkBytes ?? MAX_PACK_ROW_CACHE_BYTES, MAX_PACK_ROW_CACHE_BYTES),
      (row) => row.length,
    );
    enforceForeignKeys(db);
    initializeGitSchema(db);
    this.#readIdentityControl();
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  #readIdentityControl(): AllocatedIdentity {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT control.singleton, control.last_repo_id, control.last_checkout_id,
              control.last_clone_generation,
              (SELECT MAX(id) FROM git_repositories) AS max_repo_id,
              (SELECT MAX(id) FROM git_checkouts) AS max_checkout_id,
              (SELECT MAX(clone_generation) FROM git_repositories) AS max_clone_generation
         FROM git_identity_control control WHERE control.singleton = 1`,
    );
    if (row === undefined || row.singleton !== 1) {
      throw new CorruptError("Git identity control singleton is missing");
    }
    const control: AllocatedIdentity = {
      repoId: requireIdentityCounter(row.last_repo_id, "last repository id"),
      checkoutId: requireIdentityCounter(row.last_checkout_id, "last checkout id"),
      cloneGeneration: requireIdentityCounter(row.last_clone_generation, "last clone generation"),
    };
    const maxRepoId = requireStoredIdentityMaximum(row.max_repo_id, "maximum repository id");
    const maxCheckoutId = requireStoredIdentityMaximum(row.max_checkout_id, "maximum checkout id");
    const maxCloneGeneration = requireStoredIdentityMaximum(
      row.max_clone_generation,
      "maximum clone generation",
    );
    if (
      maxRepoId > control.repoId ||
      maxCheckoutId > control.checkoutId ||
      maxCloneGeneration > control.cloneGeneration
    ) {
      throw new CorruptError("Git identity control trails stored identities");
    }
    return control;
  }

  #allocateIdentities(
    allocateRepo: boolean,
    allocateCheckout: boolean,
    allocateClone: boolean,
  ): AllocatedIdentity {
    const previous = this.#readIdentityControl();
    const next: AllocatedIdentity = {
      repoId: allocateRepo ? nextIdentity(previous.repoId, "repository id") : previous.repoId,
      checkoutId: allocateCheckout
        ? nextIdentity(previous.checkoutId, "checkout id")
        : previous.checkoutId,
      cloneGeneration: allocateClone
        ? nextIdentity(previous.cloneGeneration, "clone generation")
        : previous.cloneGeneration,
    };
    const updated = this.#db.one<Record<string, unknown>>(
      `UPDATE git_identity_control
          SET last_repo_id = ?, last_checkout_id = ?, last_clone_generation = ?
        WHERE singleton = 1
          AND last_repo_id = ? AND last_checkout_id = ? AND last_clone_generation = ?
      RETURNING singleton, last_repo_id, last_checkout_id, last_clone_generation`,
      next.repoId,
      next.checkoutId,
      next.cloneGeneration,
      previous.repoId,
      previous.checkoutId,
      previous.cloneGeneration,
    );
    if (updated === undefined || updated.singleton !== 1) {
      throw new CorruptError("Git identity control changed during allocation");
    }
    const checked: AllocatedIdentity = {
      repoId: requireIdentityCounter(updated.last_repo_id, "allocated repository id"),
      checkoutId: requireIdentityCounter(updated.last_checkout_id, "allocated checkout id"),
      cloneGeneration: requireIdentityCounter(
        updated.last_clone_generation,
        "allocated clone generation",
      ),
    };
    if (
      checked.repoId !== next.repoId ||
      checked.checkoutId !== next.checkoutId ||
      checked.cloneGeneration !== next.cloneGeneration
    ) {
      throw new CorruptError("Git identity allocation returned unexpected counters");
    }
    return checked;
  }

  #repositoryAtRoot(root: string): StoredCheckoutLifecycle | null {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        WHERE checkout.root = ?`,
      root,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored;
  }

  #requireReadyRepository(repoId: number): StoredRepositoryLifecycle {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT id AS repo_id, lifecycle, clone_generation, clone_expires_ms
         FROM git_repositories WHERE id = ?`,
      repoId,
    );
    if (row === undefined) throw new GitError("ENOTFOUND", "repository does not exist");
    const stored = requireStoredRepositoryLifecycle(row);
    if (stored.repoId !== repoId) {
      throw new CorruptError("repository lookup returned another repository");
    }
    if (stored.lifecycle !== "ready") {
      throw new GitError("ENOTFOUND", "repository is not published");
    }
    return stored;
  }

  #storedProvisionalOwner(owner: ProvisionalCloneOwner): StoredCheckoutLifecycle {
    if (!this.#issuedProvisionalOwners.has(owner)) {
      throw new GitError("ESTALE", "provisional clone owner was not issued by this database");
    }
    const repoId = requireSafeId(owner.checkout.repoId, "provisional repository id");
    const checkoutId = requireSafeId(owner.checkout.id, "provisional checkout id");
    const generation = requireSafeId(owner.generation, "provisional clone generation");
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_repositories repository
         JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? AND checkout.id = ? AND checkout.is_primary = 1`,
      repoId,
      checkoutId,
    );
    if (row === undefined) throw new GitError("ESTALE", "provisional clone owner is stale");
    const stored = requireStoredCheckoutLifecycle(row);
    if (
      stored.lifecycle !== "provisional" ||
      stored.cloneGeneration !== generation ||
      stored.checkout.root !== owner.checkout.root ||
      stored.checkout.repoId !== repoId ||
      stored.checkout.id !== checkoutId
    ) {
      throw new GitError("ESTALE", "provisional clone owner is stale");
    }
    requireCheckoutLifecycleCardinality(row, stored);
    return stored;
  }

  #requireProvisionalOwner(owner: ProvisionalCloneOwner, nowMs: number): StoredCheckoutLifecycle {
    const stored = this.#storedProvisionalOwner(owner);
    const generation = owner.generation;
    const expiry = stored.cloneExpiresMs;
    if (expiry === null) throw new CorruptError("provisional clone lease is missing");
    if (nowMs >= expiry) throw new GitError("ESTALE", "provisional clone lease has expired");
    const record = this.#provisionalStores.get(generation);
    if (record === undefined || record.store !== owner.store) {
      throw new GitError("ESTALE", "provisional clone facade is no longer active");
    }
    if (record.repoId !== stored.repoId || record.checkoutId !== stored.checkout.id) {
      throw new CorruptError("provisional clone facade has mismatched identity");
    }
    return stored;
  }

  #provisionalStore(checkout: CheckoutRow, generation: number): ProvisionalStoreRecord {
    const existing = this.#provisionalStores.get(generation);
    if (existing !== undefined) {
      if (existing.repoId !== checkout.repoId || existing.checkoutId !== checkout.id) {
        throw new CorruptError("provisional clone generation belongs to another repository");
      }
      return existing;
    }
    if (this.#nextStoreGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const shared = new SharedRepoStore(
      this.#db,
      checkout.repoId,
      this.#nextStoreGeneration++,
      this.#objects,
      this.#packRows,
      this.#memory,
    );
    const lifetime = new CheckoutStoreLifetime();
    const store = new CheckoutStore(
      shared,
      checkout,
      this.#options,
      () => {
        throw new GitError("EINVAL", "provisional clone requires exact-owner discard");
      },
      lifetime,
    );
    const record: ProvisionalStoreRecord = {
      generation,
      repoId: checkout.repoId,
      checkoutId: checkout.id,
      shared,
      store,
      lifetime,
    };
    this.#provisionalStores.set(generation, record);
    return record;
  }

  #evictProvisional(generation: number): void {
    const record = this.#provisionalStores.get(generation);
    if (record === undefined) return;
    this.#evictProvisionalRecord(record);
  }

  #evictProvisionalRecord(record: ProvisionalStoreRecord): void {
    if (this.#provisionalStores.get(record.generation) !== record) return;
    record.lifetime.revoke();
    record.shared.clearCaches();
    this.#provisionalStores.delete(record.generation);
  }

  #provisionalRecordForOwner(owner: ProvisionalCloneOwner): ProvisionalStoreRecord | null {
    if (!this.#issuedProvisionalOwners.has(owner)) return null;
    if (!Number.isSafeInteger(owner.generation) || owner.generation < 1) return null;
    const record = this.#provisionalStores.get(owner.generation);
    return record !== undefined && record.store === owner.store ? record : null;
  }

  #evictProvisionalOwner(owner: ProvisionalCloneOwner): void {
    const record = this.#provisionalRecordForOwner(owner);
    if (record === null) return;
    this.#evictProvisionalRecord(record);
  }

  /** The checkout whose root is the nearest registered ancestor of `dir`. */
  findCheckout(dir: string): CheckoutRow | null {
    const path = normalizeRoot(dir);
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        WHERE checkout.root = '/' OR checkout.root = ?
           OR substr(?, 1, length(checkout.root) + 1) = checkout.root || '/'
        ORDER BY length(CAST(checkout.root AS BLOB)) DESC, checkout.id DESC
        LIMIT 1`,
      path,
      path,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored.lifecycle === "provisional" ? null : this.#rememberCheckout(stored.checkout);
  }

  checkoutAt(root: string): CheckoutRow | null {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        WHERE checkout.root = ?`,
      requireCheckoutRoot(root, "input"),
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored.lifecycle === "provisional" ? null : this.#rememberCheckout(stored.checkout);
  }

  listCheckouts(repoId: number): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.#requireReadyRepository(repoId);
    const rows: CheckoutRow[] = [];
    let primaryCount = 0;
    let previousRoot: string | null = null;
    let retainedBytes = 0;
    for (const raw of this.#db.iterate(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE repo_id = ?
         ORDER BY root COLLATE BINARY LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
      repoId,
    )) {
      const row = requireStoredCheckoutRow(raw);
      if (row.repoId !== repoId) {
        throw new CorruptError("checkout listing crossed repository boundaries");
      }
      if (previousRoot !== null && comparePaths(previousRoot, row.root) >= 0) {
        throw new CorruptError("checkout roots are not in strict byte order");
      }
      previousRoot = row.root;
      retainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES +
        checkoutTextEncoder.encode(row.root).byteLength +
        boundedRefText(row.head, "stored HEAD target", MAX_REFLOG_RAW_TARGET_BYTES, "stored");
      if (retainedBytes > MAX_CHECKOUT_LIST_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout listing exceeds its 6 MiB retained bound");
      }
      rows.push(this.#rememberCheckout(row));
      if (row.isPrimary) primaryCount++;
      if (rows.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "checkout listing exceeds its retained bound");
      }
    }
    if (rows.length > 0 && primaryCount !== 1) {
      throw new CorruptError("repository must have exactly one primary checkout");
    }
    return Object.freeze(rows);
  }

  listRoutingCheckouts(): CheckoutRow[] {
    const rows: CheckoutRow[] = [];
    const primaryCounts = new Map<number, number>();
    const checkoutCounts = new Map<number, number>();
    let previousRoot: string | null = null;
    let retainedBytes = 0;
    let routingCount = 0;
    for (const raw of this.#db.iterate(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        ORDER BY checkout.root COLLATE BINARY LIMIT ${MAX_GLOBAL_CHECKOUT_LIST + 1}`,
    )) {
      const stored = requireStoredCheckoutLifecycle(raw);
      requireCheckoutLifecycleCardinality(raw, stored);
      const row = stored.checkout;
      routingCount++;
      if (previousRoot !== null && comparePaths(previousRoot, row.root) >= 0) {
        throw new CorruptError("checkout roots are not in strict byte order");
      }
      previousRoot = row.root;
      retainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES +
        checkoutTextEncoder.encode(row.root).byteLength +
        boundedRefText(row.head, "stored HEAD target", MAX_REFLOG_RAW_TARGET_BYTES, "stored");
      if (retainedBytes > MAX_CHECKOUT_LIST_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout routing exceeds its 6 MiB retained bound");
      }
      if (stored.lifecycle === "ready") rows.push(this.#rememberCheckout(row));
      primaryCounts.set(row.repoId, (primaryCounts.get(row.repoId) ?? 0) + (row.isPrimary ? 1 : 0));
      const checkoutCount = (checkoutCounts.get(row.repoId) ?? 0) + 1;
      if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout routing exceeds its retained bound");
      }
      checkoutCounts.set(row.repoId, checkoutCount);
      if (routingCount > MAX_GLOBAL_CHECKOUT_LIST) {
        throw new GitError("E2BIG", "checkout routing exceeds its retained bound");
      }
    }
    for (const count of primaryCounts.values()) {
      if (count !== 1) throw new CorruptError("repository must have exactly one primary checkout");
    }
    return rows;
  }

  /** All routing roots, including provisional roots that block parent traversal. */
  listRoutingRoots(): string[] {
    const roots: string[] = [];
    const primaryCounts = new Map<number, number>();
    const checkoutCounts = new Map<number, number>();
    let previousRoot: string | null = null;
    let retainedBytes = 0;
    for (const raw of this.#db.iterate(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        ORDER BY checkout.root COLLATE BINARY LIMIT ${MAX_GLOBAL_CHECKOUT_LIST + 1}`,
    )) {
      const stored = requireStoredCheckoutLifecycle(raw);
      requireCheckoutLifecycleCardinality(raw, stored);
      const row = stored.checkout;
      if (previousRoot !== null && comparePaths(previousRoot, row.root) >= 0) {
        throw new CorruptError("checkout roots are not in strict byte order");
      }
      previousRoot = row.root;
      primaryCounts.set(row.repoId, (primaryCounts.get(row.repoId) ?? 0) + (row.isPrimary ? 1 : 0));
      const checkoutCount = (checkoutCounts.get(row.repoId) ?? 0) + 1;
      if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout routing exceeds its retained bound");
      }
      checkoutCounts.set(row.repoId, checkoutCount);
      retainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES +
        checkoutTextEncoder.encode(row.root).byteLength +
        boundedRefText(row.head, "stored HEAD target", MAX_REFLOG_RAW_TARGET_BYTES, "stored");
      if (retainedBytes > MAX_CHECKOUT_LIST_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout routing exceeds its 6 MiB retained bound");
      }
      roots.push(row.root);
      if (roots.length > MAX_GLOBAL_CHECKOUT_LIST) {
        throw new GitError("E2BIG", "checkout routing exceeds its retained bound");
      }
    }
    for (const count of primaryCounts.values()) {
      if (count !== 1) throw new CorruptError("repository must have exactly one primary checkout");
    }
    return roots;
  }

  beginProvisionalClone(
    root: string,
    head: string,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): ProvisionalCloneOwner {
    const normalized = requireCheckoutRoot(root, "input");
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    const expiresMs = provisionalCloneExpiry(nowMs);
    let cleanupGeneration: number | null = null;
    let created: {
      checkout: CheckoutRow;
      generation: number;
      evictedGeneration: number | null;
    };
    try {
      created = this.#db.transactionSync(() => {
        const existing = this.#repositoryAtRoot(normalized);
        let evictedGeneration: number | null = null;
        if (existing !== null) {
          if (existing.lifecycle === "ready") {
            throw new GitError("EALREADYINIT", `repository already exists at ${normalized}`);
          }
          const oldGeneration = existing.cloneGeneration;
          const oldExpiry = existing.cloneExpiresMs;
          if (oldGeneration === null || oldExpiry === null) {
            throw new CorruptError("provisional clone owner is incomplete");
          }
          if (nowMs < oldExpiry) {
            throw new GitError("EBUSY", `clone at ${normalized} is still in progress`);
          }
          cleanupGeneration = oldGeneration;
          const oldStore = this.#provisionalStore(existing.checkout, oldGeneration).store;
          const result = cleanup(oldStore);
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
          }
          const deleted = this.#db.one<Record<string, unknown>>(
            `DELETE FROM git_repositories
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ? AND clone_expires_ms = ? AND clone_expires_ms <= ?
          RETURNING id AS repo_id`,
            existing.repoId,
            oldGeneration,
            oldExpiry,
            nowMs,
          );
          if (
            deleted === undefined ||
            requireSafeId(deleted.repo_id, "deleted provisional repository id") !== existing.repoId
          ) {
            throw new GitError("ESTALE", "provisional clone ownership changed during takeover");
          }
          evictedGeneration = oldGeneration;
        }

        const identity = this.#allocateIdentities(true, true, true);
        this.#db.run(
          `INSERT INTO git_repositories
             (id, lifecycle, clone_generation, clone_expires_ms)
           VALUES (?, 'provisional', ?, ?)`,
          identity.repoId,
          identity.cloneGeneration,
          expiresMs,
        );
        this.#db.run(
          `INSERT INTO git_pack_ingest_control
             (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
           VALUES (?, 0, 0, NULL, NULL)`,
          identity.repoId,
        );
        this.#db.run(
          `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
           VALUES (?, ?, ?, ?, 1)`,
          identity.checkoutId,
          identity.repoId,
          normalized,
          checkedHead,
        );
        this.#db.run(
          "INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (?, 0)",
          identity.repoId,
        );
        this.#db.run(
          `INSERT OR IGNORE INTO git_index_state
               (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
          identity.checkoutId,
        );
        const checkout: CheckoutRow = {
          id: identity.checkoutId,
          repoId: identity.repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: true,
        };
        return { checkout, generation: identity.cloneGeneration, evictedGeneration };
      });
    } catch (error) {
      if (cleanupGeneration !== null) {
        this.#evictProvisional(cleanupGeneration);
      }
      throw error;
    }

    if (created.evictedGeneration !== null) {
      this.#evictProvisional(created.evictedGeneration);
    }
    const checkout = Object.freeze(created.checkout);
    const record = this.#provisionalStore(checkout, created.generation);
    const owner = Object.freeze({ checkout, generation: created.generation, store: record.store });
    this.#issuedProvisionalOwners.add(owner);
    return owner;
  }

  renewProvisionalClone(owner: ProvisionalCloneOwner, now: number): number {
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    try {
      return this.#db.transactionSync(() => {
        const stored = this.#requireProvisionalOwner(owner, nowMs);
        const currentExpiry = stored.cloneExpiresMs;
        if (currentExpiry === null) throw new CorruptError("provisional clone lease is missing");
        if (currentExpiry - nowMs > PROVISIONAL_CLONE_RENEW_WINDOW_MS) return currentExpiry;
        const nextExpiry = provisionalCloneExpiry(nowMs);
        const updated = this.#db.one<Record<string, unknown>>(
          `UPDATE git_repositories SET clone_expires_ms = ?
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ? AND clone_expires_ms = ? AND clone_expires_ms > ?
          RETURNING clone_expires_ms`,
          nextExpiry,
          stored.repoId,
          owner.generation,
          currentExpiry,
          nowMs,
        );
        if (updated === undefined) {
          throw new GitError("ESTALE", "provisional clone ownership changed during renewal");
        }
        const checked = requireMilliseconds(
          updated.clone_expires_ms,
          "renewed clone lease expiry",
          "stored",
        );
        if (checked !== nextExpiry) {
          throw new CorruptError("clone lease renewal returned an unexpected expiry");
        }
        return checked;
      });
    } catch (error) {
      if (hasErrorCode(error, "ESTALE")) this.#evictProvisionalOwner(owner);
      throw error;
    }
  }

  publishProvisionalClone(
    owner: ProvisionalCloneOwner,
    now: number,
    prepare?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    let prepareStarted = false;
    let synchronousPrepareFailure = false;
    try {
      const published = this.#db.transactionSync(() => {
        const stored = this.#requireProvisionalOwner(owner, nowMs);
        const expiry = stored.cloneExpiresMs;
        if (expiry === null) throw new CorruptError("provisional clone lease is missing");
        if (prepare !== undefined) {
          prepareStarted = true;
          let result: undefined;
          try {
            result = prepare(owner.store);
          } catch (error) {
            synchronousPrepareFailure = true;
            throw error;
          }
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone preparation must be synchronous");
          }
        }
        const updated = this.#db.one<Record<string, unknown>>(
          `UPDATE git_repositories
              SET lifecycle = 'ready', clone_generation = NULL, clone_expires_ms = NULL
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ? AND clone_expires_ms = ? AND clone_expires_ms > ?
          RETURNING id AS repo_id, lifecycle, clone_generation, clone_expires_ms`,
          stored.repoId,
          owner.generation,
          expiry,
          nowMs,
        );
        if (updated === undefined) {
          throw new GitError("ESTALE", "provisional clone ownership changed before publication");
        }
        const lifecycle = requireStoredRepositoryLifecycle(updated);
        if (lifecycle.repoId !== stored.repoId || lifecycle.lifecycle !== "ready") {
          throw new CorruptError("clone publication returned an unexpected repository");
        }
        return stored.checkout;
      });
      this.#evictProvisionalOwner(owner);
      this.#issuedProvisionalOwners.delete(owner);
      return this.#rememberCheckout(published, true);
    } catch (error) {
      const record = this.#provisionalRecordForOwner(owner);
      if (synchronousPrepareFailure && record !== null) {
        // The rollback preserves this exact owner for the bounded native-to-fallback retry.
        record.shared.revalidateStorageCaches();
      } else if (prepareStarted || hasErrorCode(error, "ESTALE")) {
        this.#evictProvisionalOwner(owner);
      }
      throw error;
    }
  }

  discardProvisionalClone(
    owner: ProvisionalCloneOwner,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): void {
    requireMilliseconds(now, "clone lease clock", "input");
    let cleanupRecord: ProvisionalStoreRecord | null = null;
    try {
      this.#db.transactionSync(() => {
        const stored = this.#storedProvisionalOwner(owner);
        const generation = owner.generation;
        const existing = this.#provisionalStores.get(generation);
        if (existing !== undefined && existing.store !== owner.store) {
          throw new GitError("ESTALE", "provisional clone facade belongs to another owner");
        }
        cleanupRecord = existing ?? this.#provisionalStore(stored.checkout, generation);
        const result = cleanup(cleanupRecord.store);
        if (isThenableResult(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
        }
        const deleted = this.#db.one<Record<string, unknown>>(
          `DELETE FROM git_repositories
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ?
          RETURNING id AS repo_id`,
          stored.repoId,
          generation,
        );
        if (
          deleted === undefined ||
          requireSafeId(deleted.repo_id, "discarded provisional repository id") !== stored.repoId
        ) {
          throw new GitError("ESTALE", "provisional clone ownership changed before discard");
        }
      });
    } catch (error) {
      if (cleanupRecord !== null) this.#evictProvisionalRecord(cleanupRecord);
      else if (hasErrorCode(error, "ESTALE")) this.#evictProvisionalOwner(owner);
      throw error;
    }
    if (cleanupRecord === null) {
      throw new CorruptError("provisional clone cleanup facade was not created");
    }
    this.#evictProvisionalRecord(cleanupRecord);
    this.#issuedProvisionalOwners.delete(owner);
  }

  createRepository(root: string, head: string): CheckoutRow {
    const normalized = requireCheckoutRoot(root, "input");
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    return this.#db.transactionSync(() => {
      const existing = this.#repositoryAtRoot(normalized);
      if (existing !== null) {
        if (existing.lifecycle === "provisional") {
          throw new GitError("EBUSY", `clone at ${normalized} is still in progress`);
        }
        throw new GitError("EALREADYINIT", `repository already exists at ${normalized}`);
      }
      const identity = this.#allocateIdentities(true, true, false);
      const repoId = identity.repoId;
      const checkoutId = identity.checkoutId;
      try {
        this.#db.run("INSERT INTO git_repositories (id) VALUES (?)", repoId);
      } catch (error) {
        throw new CorruptError("repository identity control precedes stored repositories", {
          cause: error,
        });
      }
      this.#db.run(
        `INSERT INTO git_pack_ingest_control
           (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
         VALUES (?, 0, 0, NULL, NULL)`,
        repoId,
      );
      this.#db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (?, ?, ?, ?, 1)`,
        checkoutId,
        repoId,
        normalized,
        checkedHead,
      );
      this.#db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (?, 0)", repoId);
      this.#db.run(
        `INSERT OR IGNORE INTO git_index_state
           (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
        checkoutId,
      );
      return this.#rememberCheckout(
        {
          id: checkoutId,
          repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: true,
        },
        true,
      );
    });
  }

  /** Create one non-primary checkout and initialize its private state atomically. */
  createCheckout(
    repoId: number,
    root: string,
    head: string,
    initialize?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    const normalized = requireCheckoutRoot(root, "input");
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    const attached = rawSymbolicTarget(checkedHead);
    const shared = this.openShared(repoId);

    const lifetime = new CheckoutStoreLifetime();
    let created: {
      row: CheckoutRow;
      store: CheckoutStore;
      lifetime: CheckoutStoreLifetime;
    };
    try {
      created = this.#db.transactionSync(() => {
        const count = this.#db.scalar<unknown>(
          "SELECT count(*) FROM git_checkouts WHERE repo_id = ?",
          repoId,
        );
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
          throw new CorruptError("repository checkout count is invalid");
        }
        if (count >= MAX_CHECKOUTS_PER_REPOSITORY) {
          throw new GitError(
            "EWORKTREELIMIT",
            `repository already has ${MAX_CHECKOUTS_PER_REPOSITORY} checkouts`,
          );
        }

        const rootOwner = this.#db.one<Record<string, unknown>>(
          `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE root = ?`,
          normalized,
        );
        if (rootOwner !== undefined) {
          const owner = requireStoredCheckoutRow(rootOwner);
          if (owner.root !== normalized) {
            throw new CorruptError("checkout root lookup returned another root");
          }
          throw new GitError(
            "EWORKTREEEXISTS",
            `checkout root is already registered: ${normalized}`,
          );
        }
        if (attached?.startsWith("refs/heads/")) {
          const branchOwner = this.#db.one<Record<string, unknown>>(
            `SELECT id AS checkout_id, repo_id, root, head, is_primary
             FROM git_checkouts WHERE repo_id = ? AND head = ?`,
            repoId,
            checkedHead,
          );
          if (branchOwner !== undefined) {
            const owner = requireStoredCheckoutRow(branchOwner);
            if (owner.repoId !== repoId) {
              throw new CorruptError("attached branch lookup crossed repository boundaries");
            }
            if (owner.head !== checkedHead) {
              throw new CorruptError("attached branch lookup returned another branch");
            }
            throw new GitError(
              "EBRANCHINUSE",
              `branch ${attached} is already attached to checkout ${owner.root}`,
            );
          }
        }

        const checkoutId = this.#allocateIdentities(false, true, false).checkoutId;
        try {
          this.#db.run(
            `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
           VALUES (?, ?, ?, ?, 0)`,
            checkoutId,
            repoId,
            normalized,
            checkedHead,
          );
        } catch (error) {
          if (isCheckoutRootUniqueConstraint(error)) {
            throw new GitError(
              "EWORKTREEEXISTS",
              `checkout root is already registered: ${normalized}`,
              { cause: error },
            );
          }
          if (isAttachedBranchUniqueConstraint(error)) {
            throw new GitError(
              "EBRANCHINUSE",
              `branch ${attached ?? checkedHead} is already attached to another checkout`,
              { cause: error },
            );
          }
          throw error;
        }
        this.#db.run(
          `INSERT OR IGNORE INTO git_index_state
           (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
          checkoutId,
        );
        const initial: CheckoutRow = {
          id: checkoutId,
          repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: false,
        };
        const store = new CheckoutStore(
          shared,
          initial,
          this.#options,
          () => this.destroyRepository(repoId),
          lifetime,
        );
        if (initialize !== undefined) {
          const result = initialize(store);
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "checkout initialization must be synchronous");
          }
        }
        const stored = this.#db.one<Record<string, unknown>>(
          `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE id = ? AND repo_id = ?`,
          checkoutId,
          repoId,
        );
        if (stored === undefined) throw new CorruptError("initialized checkout row is missing");
        const row = requireStoredCheckoutRow(stored);
        if (
          row.id !== checkoutId ||
          row.repoId !== repoId ||
          row.root !== normalized ||
          row.isPrimary
        ) {
          throw new CorruptError("initialized checkout identity changed");
        }
        bumpMaintenanceRootEpoch(this.#db, repoId);
        return { row, store, lifetime };
      });
    } catch (error) {
      lifetime.revoke();
      shared.revalidateStorageCaches();
      throw error;
    }

    const remembered = this.#rememberCheckout(created.row, true);
    this.#checkoutStores.set(remembered.id, created.store);
    this.#checkoutLifetimes.set(remembered.id, created.lifetime);
    return remembered;
  }

  /** Remove one non-primary checkout after the caller deletes its root. */
  removeCheckout(
    checkoutId: number,
    removeRoot: (checkout: CheckoutRow) => undefined,
  ): CheckoutRow {
    if (!Number.isSafeInteger(checkoutId) || checkoutId < 1) {
      throw new GitError("EINVAL", "checkout id must be a safe positive integer");
    }
    const removed = this.#db.transactionSync(() => {
      const raw = this.#db.one<Record<string, unknown>>(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE id = ?`,
        checkoutId,
      );
      if (raw === undefined) throw new GitError("EWORKTREENOTFOUND", "checkout does not exist");
      const row = requireStoredCheckoutRow(raw);
      if (row.id !== checkoutId) throw new CorruptError("checkout lookup returned another row");
      if (row.isPrimary) {
        throw new GitError("EPRIMARYWORKTREE", "the primary checkout cannot be removed");
      }
      this.#requireCheckoutsIdle(row.repoId, [row.id]);
      const result = removeRoot(Object.freeze(row));
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "checkout removal must be synchronous");
      }
      const deleted = this.#db.one<Record<string, unknown>>(
        `DELETE FROM git_checkouts
          WHERE id = ? AND repo_id = ? AND is_primary = 0
          RETURNING id AS checkout_id`,
        row.id,
        row.repoId,
      );
      if (
        deleted === undefined ||
        requireSafeId(deleted.checkout_id, "deleted checkout id") !== row.id
      ) {
        throw new CorruptError("checkout disappeared during removal");
      }
      bumpMaintenanceRootEpoch(this.#db, row.repoId);
      return Object.freeze(row);
    });
    this.#evictCheckout(removed.id);
    return removed;
  }

  /** Remove a bounded set of non-primary checkouts in one atomic delete. */
  removeCheckouts(repoId: number, checkoutIds: readonly number[]): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    if (checkoutIds.length > MAX_CHECKOUTS_PER_REPOSITORY) {
      throw new GitError("E2BIG", "checkout removal exceeds 1,024 inputs");
    }
    const uniqueIds: number[] = [];
    const seen = new Set<number>();
    for (const checkoutId of checkoutIds) {
      if (!Number.isSafeInteger(checkoutId) || checkoutId < 1) {
        throw new GitError("EINVAL", "checkout id must be a safe positive integer");
      }
      if (!seen.has(checkoutId)) {
        seen.add(checkoutId);
        uniqueIds.push(checkoutId);
      }
    }
    if (uniqueIds.length === 0) return Object.freeze([]);
    this.openShared(repoId);
    const idsJson = JSON.stringify(uniqueIds);
    const removed = this.#db.transactionSync(() => {
      const rows: CheckoutRow[] = [];
      const selectedIds = new Set<number>();
      let previousRoot: string | null = null;
      for (const raw of this.#db.iterate(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts
          WHERE id IN (SELECT value FROM json_each(?))
          ORDER BY root COLLATE BINARY
          LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
        idsJson,
      )) {
        const row = requireStoredCheckoutRow(raw);
        if (!seen.has(row.id)) {
          throw new CorruptError("checkout removal query returned an unrequested checkout");
        }
        if (selectedIds.has(row.id)) {
          throw new CorruptError("checkout removal query returned a duplicate checkout");
        }
        selectedIds.add(row.id);
        if (row.repoId !== repoId) {
          throw new GitError("EWORKTREENOTFOUND", "checkout belongs to another repository");
        }
        if (row.isPrimary) {
          throw new GitError("EPRIMARYWORKTREE", "the primary checkout cannot be removed");
        }
        if (previousRoot !== null && comparePaths(previousRoot, row.root) >= 0) {
          throw new CorruptError("checkout removal roots are not in strict byte order");
        }
        previousRoot = row.root;
        rows.push(row);
      }
      if (rows.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new CorruptError("checkout removal query exceeded its bounded result");
      }
      if (rows.length === 0) return Object.freeze(rows);
      const existingIds = rows.map((row) => row.id);
      this.#requireCheckoutsIdle(repoId, existingIds);
      const existingJson = JSON.stringify(existingIds);
      const deleted = this.#db.all<Record<string, unknown>>(
        `DELETE FROM git_checkouts
          WHERE repo_id = ? AND is_primary = 0
            AND id IN (SELECT value FROM json_each(?))
          RETURNING id AS checkout_id`,
        repoId,
        existingJson,
      );
      const deletedIds = new Set<number>();
      for (const row of deleted) {
        deletedIds.add(requireSafeId(row.checkout_id, "deleted checkout id"));
      }
      if (deletedIds.size !== rows.length || rows.some((row) => !deletedIds.has(row.id))) {
        throw new CorruptError("bulk checkout removal deleted an unexpected set");
      }
      bumpMaintenanceRootEpoch(this.#db, repoId);
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    });
    for (const row of removed) this.#evictCheckout(row.id);
    return removed;
  }

  openShared(repoId: number): SharedRepoStore {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.#requireReadyRepository(repoId);
    const existing = this.#sharedStores.get(repoId);
    if (existing !== undefined) return existing;
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT repository.id AS repo_id,
              count(checkout.id) AS checkout_count,
              coalesce(sum(checkout.is_primary), 0) AS primary_count
         FROM git_repositories repository
         LEFT JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? GROUP BY repository.id`,
      repoId,
    );
    if (row === undefined) throw new GitError("ENOTFOUND", "repository does not exist");
    if (requireSafeId(row.repo_id, "repository id") !== repoId) {
      throw new CorruptError("repository lookup returned another repository");
    }
    const checkoutCount = requireSafeRefLogInteger(
      row.checkout_count,
      "repository checkout count",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
      throw new GitError("E2BIG", "repository exceeds 1,024 checkouts");
    }
    const primaryCount = requireSafeRefLogInteger(
      row.primary_count,
      "repository primary checkout count",
      0,
      checkoutCount,
    );
    if (primaryCount !== 1)
      throw new CorruptError("repository must have exactly one primary checkout");
    if (!Number.isSafeInteger(this.#nextStoreGeneration)) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const generation = this.#nextStoreGeneration++;
    const store = new SharedRepoStore(
      this.#db,
      repoId,
      generation,
      this.#objects,
      this.#packRows,
      this.#memory,
    );
    this.#sharedStores.set(repoId, store);
    const primaryRaw = this.#db.one<Record<string, unknown>>(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE repo_id = ? AND is_primary = 1`,
      repoId,
    );
    if (primaryRaw === undefined) throw new CorruptError("repository primary checkout is missing");
    const primary = requireStoredCheckoutRow(primaryRaw);
    if (primary.repoId !== repoId || !primary.isPrimary) {
      throw new CorruptError("repository primary checkout lookup returned another checkout");
    }
    // The non-removable primary keeps shared operations and pack callbacks live.
    const lifetime = new CheckoutStoreLifetime();
    const primaryStore = new CheckoutStore(
      store,
      primary,
      this.#options,
      () => this.destroyRepository(repoId),
      lifetime,
    );
    this.#checkoutStores.set(primary.id, primaryStore);
    this.#checkoutLifetimes.set(primary.id, lifetime);
    return store;
  }

  openCheckout(checkout: CheckoutRow | number): CheckoutStore {
    const checkoutId =
      typeof checkout === "number" ? checkout : requireSafeId(checkout.id, "checkout id");
    if (typeof checkout !== "number") this.#rejectStaleCheckoutRow(checkout, checkoutId);
    const durable = this.#checkoutById(checkoutId);
    if (
      typeof checkout !== "number" &&
      (checkout.repoId !== durable.repoId ||
        checkout.root !== durable.root ||
        checkout.isPrimary !== durable.isPrimary)
    ) {
      throw new CorruptError("checkout identity changed before it was opened");
    }
    const existing = this.#checkoutStores.get(checkoutId);
    if (existing !== undefined) {
      if (
        typeof checkout !== "number" &&
        (checkout.repoId !== existing.sharedRepoId ||
          checkout.root !== existing.root ||
          checkout.isPrimary !== existing.isPrimary)
      ) {
        throw new CorruptError("cached checkout identity does not match its requested row");
      }
      return existing;
    }
    const stored = durable;
    const shared = this.openShared(stored.repoId);
    const installed = this.#checkoutStores.get(checkoutId);
    if (installed !== undefined) return installed;
    const lifetime = new CheckoutStoreLifetime();
    const store = new CheckoutStore(
      shared,
      stored,
      this.#options,
      () => this.destroyRepository(stored.repoId),
      lifetime,
    );
    this.#checkoutStores.set(checkoutId, store);
    this.#checkoutLifetimes.set(checkoutId, lifetime);
    return store;
  }

  #checkoutById(checkoutId: number): CheckoutRow {
    const raw = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head, checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        WHERE checkout.id = ?`,
      checkoutId,
    );
    if (raw === undefined) throw new GitError("ENOTFOUND", "checkout does not exist");
    const stored = requireStoredCheckoutLifecycle(raw);
    requireCheckoutLifecycleCardinality(raw, stored);
    if (stored.lifecycle !== "ready") {
      throw new GitError("ENOTFOUND", "checkout is not published");
    }
    return stored.checkout;
  }

  #rejectStaleCheckoutRow(checkout: CheckoutRow, checkoutId: number): void {
    const rememberedGeneration = this.#validatedCheckoutRows.get(checkout);
    if (
      rememberedGeneration !== undefined &&
      rememberedGeneration !== this.#checkoutRowGenerations.get(checkoutId)
    ) {
      throw new GitError("EWORKTREENOTFOUND", "checkout identity is no longer active");
    }
  }

  #rememberCheckout(row: CheckoutRow, replaceIdentity = false): CheckoutRow {
    let generation = replaceIdentity ? undefined : this.#checkoutRowGenerations.get(row.id);
    if (generation === undefined) {
      if (!Number.isSafeInteger(this.#nextCheckoutRowGeneration)) {
        throw new GitError("E2BIG", "checkout row generation is exhausted");
      }
      generation = this.#nextCheckoutRowGeneration++;
      this.#checkoutRowGenerations.set(row.id, generation);
    }
    const remembered = Object.freeze(row);
    this.#validatedCheckoutRows.set(remembered, generation);
    return remembered;
  }

  #requireCheckoutsIdle(repoId: number, checkoutIds: readonly number[]): void {
    if (checkoutIds.length === 0) return;
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT operation.checkout_id
         FROM git_operation_state operation
         JOIN git_checkouts checkout ON checkout.id = operation.checkout_id
        WHERE checkout.repo_id = ?
          AND operation.checkout_id IN (SELECT value FROM json_each(?))
        LIMIT 1`,
      repoId,
      JSON.stringify(checkoutIds),
    );
    if (row === undefined) return;
    const busyId = requireSafeId(row.checkout_id, "busy checkout id");
    if (!checkoutIds.includes(busyId)) {
      throw new CorruptError("checkout operation probe returned another checkout");
    }
    throw new GitError("EWORKTREEBUSY", `checkout ${busyId} has a live operation`);
  }

  #evictCheckout(checkoutId: number): void {
    this.#checkoutLifetimes.get(checkoutId)?.revoke();
    this.#checkoutLifetimes.delete(checkoutId);
    this.#checkoutStores.delete(checkoutId);
    this.#checkoutRowGenerations.delete(checkoutId);
  }

  /** Advance one internal maintenance root page after validating every live journal. */
  advanceMaintenanceRootSnapshot(
    repoId: number,
    options: { nowMs: number; pageRows?: number },
  ): MaintenanceRootSnapshotProgress {
    this.openShared(repoId);
    const rootOptions = {
      repoId,
      nowMs: options.nowMs,
      readOperationRoots: (checkoutId: number) => {
        const checkout = this.#checkoutById(checkoutId);
        if (checkout.repoId !== repoId) {
          throw new CorruptError("maintenance operation root crossed repositories");
        }
        const journal = this.openCheckout(checkout).readOperationState();
        return journal === null ? [] : validatedOperationJournalRoots(journal);
      },
    };
    if (options.pageRows === undefined) return advanceRootSnapshot(this.#db, rootOptions);
    return advanceRootSnapshot(this.#db, { ...rootOptions, pageRows: options.pageRows });
  }

  destroyRepository(repoId: number): void {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.#requireReadyRepository(repoId);
    this.#db.run("DELETE FROM git_repositories WHERE id = ? AND lifecycle = 'ready'", repoId);
    const shared = this.#sharedStores.get(repoId);
    shared?.clearCaches();
    this.#sharedStores.delete(repoId);
    for (const [checkoutId, store] of this.#checkoutStores) {
      if (store.sharedRepoId === repoId) this.#evictCheckout(checkoutId);
    }
  }
}

/** Checkout-bound storage view. */
export class CheckoutStore {
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
        shared.cacheNamespace,
        (oid) => this.#readLoose(oid),
        (oids) => this.#readLooseObjects(oids),
        (oids) => this.#looseObjectMetadata(oids),
        options,
      ),
    );
    shared.installOperations(this);
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
    return this.#memory.reserve();
  }

  // -- objects --------------------------------------------------------

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    const found = new Map<string, string>();
    for (const page of contentIdPages(contentIds)) {
      for (const row of this.#db.all<{ content_key: string; oid: string }>(
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
        if (typeof row.content_key !== "string" || !isOid(row.oid)) {
          throw new CorruptError("blob id lookup returned an invalid mapping");
        }
        found.set(row.content_key, row.oid);
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
    const retained: BlobIdMapping[] = [];
    const mismatches = new Map<number, string | null>();
    let retainedBytes = 0;
    for (const mapping of expected) {
      if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
      const cacheable = mapping.contentId.length <= MAX_CACHED_CONTENT_ID_BYTES;
      const bytes = cacheable ? blobIdMismatchRetainedBytes(mapping) : BLOB_ID_MISMATCH_ROW_BYTES;
      if (bytes > MAX_BLOB_ID_MISMATCH_RETAINED_BYTES - retainedBytes) {
        throw new GitError(
          "E2BIG",
          `blob id comparison state exceeds ${MAX_BLOB_ID_MISMATCH_RETAINED_BYTES} bytes`,
        );
      }
      retainedBytes += bytes;
      retained.push(mapping);
      if (!cacheable) mismatches.set(retained.length - 1, null);
    }

    for (const page of expectedContentIdPages(retained)) {
      for (const row of this.#db.all<{ ordinal: number; oid: string | null }>(
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
        if (
          !Number.isSafeInteger(row.ordinal) ||
          row.ordinal < 0 ||
          row.ordinal >= retained.length ||
          (row.oid !== null && !isOid(row.oid))
        ) {
          throw new CorruptError("blob id comparison returned an invalid mapping");
        }
        if (mismatches.has(row.ordinal)) {
          throw new CorruptError("blob id comparison returned a duplicate ordinal");
        }
        mismatches.set(row.ordinal, row.oid);
      }
    }
    return mismatches;
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    const unique = new Map<string, BlobIdMapping>();
    let retainedBytes = 0;
    for (const mapping of mappings) {
      if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > MAX_CACHED_CONTENT_ID_BYTES) continue;
      const key = contentIdKey(mapping.contentId);
      const previous = unique.get(key);
      if (previous === undefined) {
        const bytes = blobIdMismatchRetainedBytes(mapping) + key.length * 2;
        if (bytes > MAX_BLOB_ID_INPUT_RETAINED_BYTES - retainedBytes) {
          throw new GitError(
            "E2BIG",
            `blob id update state exceeds ${MAX_BLOB_ID_INPUT_RETAINED_BYTES} bytes`,
          );
        }
        retainedBytes += bytes;
      }
      unique.set(key, mapping);
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
    const budget = options.budgetBytes ?? MAX_BLOB_BATCH_BYTES;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > MAX_BLOB_BATCH_BYTES) {
      throw new RangeError(
        `object read budget must be an integer from 1 to ${MAX_BLOB_BATCH_BYTES}`,
      );
    }
    const wanted = [...new Set(oids)];
    if (wanted.length > MAX_BLOB_BATCH_OIDS) {
      throw new GitError("E2BIG", `object batch exceeds ${MAX_BLOB_BATCH_OIDS} inputs`);
    }
    for (const oid of wanted) {
      if (!isOid(oid)) throw new CorruptError(`invalid object id ${oid}`);
    }
    if (wanted.length === 0) return { objects: new Map(), remaining: [], bytes: 0 };

    const metadata = this.#db.all<{
      ordinal: number;
      oid: string;
      source: string | null;
      type: string | null;
      size: number | null;
      stored: string | null;
    }>(
      `WITH wanted(ordinal, oid) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT w.ordinal, w.oid,
              CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                   WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
              CASE WHEN loose.oid IS NOT NULL THEN loose.type
                   WHEN pack.pack_id IS NOT NULL THEN packed.type END AS type,
              CASE WHEN loose.oid IS NOT NULL THEN loose.size
                   WHEN pack.pack_id IS NOT NULL THEN packed.size END AS size,
              loose.stored
         FROM wanted w
         LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = w.oid
         LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = w.oid
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
          AND pack.state = 'complete'
        ORDER BY w.ordinal`,
      JSON.stringify(wanted),
      this.#repoId,
      this.#repoId,
    );
    if (metadata.length !== wanted.length) {
      throw new CorruptError("object metadata lookup returned the wrong row count");
    }

    const selected: typeof metadata = [];
    let bytes = 0;
    for (let index = 0; index < metadata.length; index++) {
      const row = metadata[index]!;
      if (
        row.ordinal !== index ||
        row.oid !== wanted[index] ||
        (row.source !== "loose" && row.source !== "pack")
      ) {
        if (row.source === null) throw new ObjectNotFoundError(wanted[index]!);
        throw new CorruptError("object metadata lookup returned an invalid source");
      }
      if (
        row.type !== "blob" &&
        row.type !== "tree" &&
        row.type !== "commit" &&
        row.type !== "tag"
      ) {
        throw new CorruptError(`object ${row.oid} has an invalid indexed type`);
      }
      const size = row.size;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new CorruptError(`object ${row.oid} has an invalid indexed size`);
      }
      if (bytes + size > budget) {
        if (selected.length === 0) {
          throw new GitError("EFBIG", `object ${row.oid} exceeds the ${budget}-byte read budget`);
        }
        break;
      }
      selected.push(row);
      bytes += size;
    }

    const looseRows = selected.filter((row) => row.source === "loose");
    const packedOids = selected.filter((row) => row.source === "pack").map((row) => row.oid);
    const looseObjects = this.#readLooseObjectRows(looseRows);
    const packed = this.#packs.readObjects(packedOids);
    const objects = new Map<string, RawObject>();
    for (const row of selected) {
      const object = (row.source === "loose" ? looseObjects : packed).get(row.oid);
      if (object === undefined || object.type !== row.type || object.data.length !== row.size) {
        throw new CorruptError(`object ${row.oid} did not produce its indexed bytes`);
      }
      objects.set(row.oid, object);
    }
    return { objects, remaining: wanted.slice(selected.length), bytes };
  }

  /** Read a deduplicated prefix of blobs under an explicit byte budget. */
  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    const batch = this.readObjects(oids, options);
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
    if (type === "commit" && size > MAX_INDEXED_COMMIT_BYTES) {
      throw new GitError("E2BIG", "commit exceeds the 1 MiB cache limit");
    }
    const hash = new Sha1().update(objectHeader(type, size));
    const commitData =
      type === "commit" && size <= MAX_INDEXED_COMMIT_BYTES ? new Uint8Array(size) : undefined;
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
    const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
    const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
    // Keyed by oid: a tree build re-emits identical subtrees, and one
    // (oid, seq) may appear at most once in a payload.
    const staged = new Map<string, StagedObject>();
    let bytes = 0;
    let commitBytes = 0;
    const flush = (): void => {
      if (staged.size === 0) return;
      this.#flushObjects([...staged.values()], payloadBytes);
      staged.clear();
      bytes = 0;
      commitBytes = 0;
    };
    return {
      write: (type: ObjectType, data: Uint8Array): string => {
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
        staged.set(oid, object);
        bytes += storedData.length;
        if (object.treeData !== undefined && object.treeData !== storedData) {
          bytes += object.treeData.length;
        }
        if (object.commitEntry !== undefined) commitBytes += object.commitEntry.cacheBytes;
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
      },
      flush,
    };
  }

  /** Run `body` with a batch, flushing what it staged when it returns. */
  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    const batch = this.writeBatch(options);
    const result = body(batch);
    batch.flush();
    return result;
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
    const chunks = this.#db.all<{ data: unknown }>(
      "SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ? ORDER BY seq",
      this.#repoId,
      oid,
    );
    const object: RawObject = {
      type: row.type,
      data:
        parseLooseEncoding(row.stored) === "raw"
          ? concat(chunks.map((chunk) => readBlob(chunk.data)))
          : inflate(concat(chunks.map((chunk) => readBlob(chunk.data)))),
    };
    this.#objects.set(this.#objectCacheKey(oid), object);
    return object;
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
      JSON.stringify(wanted),
      this.#repoId,
    );
    let storedBytes = 0;
    let outputBytes = 0;
    if (gate.length !== rows.length) throw new CorruptError("loose blob gate lost an object");
    for (let index = 0; index < gate.length; index++) {
      const checked = gate[index]!;
      const source = rows[index]!;
      const chunks = Number(checked.chunks);
      const size = source.size;
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
        checked.stored_bytes < 0
      ) {
        throw new CorruptError(`loose blob ${source.oid} has invalid chunk metadata`);
      }
      storedBytes += checked.stored_bytes;
      if (!Number.isSafeInteger(storedBytes) || storedBytes > MAX_BLOB_BATCH_BYTES + 64 * 1024) {
        throw new GitError("E2BIG", "loose blob storage exceeds the bounded batch limit");
      }
      outputBytes += size;
      if (
        !Number.isSafeInteger(outputBytes) ||
        (rows.length > 1 && outputBytes > MAX_BLOB_BATCH_BYTES)
      ) {
        throw new GitError("E2BIG", "loose object output exceeds the bounded batch limit");
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
      JSON.stringify(wanted),
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
    const target = this.#db.scalar<unknown>(
      "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
      this.#repoId,
      checkedName,
    );
    return target === undefined
      ? null
      : requireRawRefTarget(target, `stored target of ${checkedName}`, "stored");
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

  /** Fence one remote-tracking namespace and retain its exact publication snapshot. */
  beginFetchPublication(
    trackingPrefix: string,
    candidateGlobalRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    const prefix = requireFetchTrackingPrefix(trackingPrefix, "input");
    const reservation = this.#memory.reserve();
    try {
      const budget = new RefMutationBudget(reservation, true);
      const candidates = new Map<string, string | null>();
      let candidateInputs = 0;
      for (const value of candidateGlobalRefs) {
        candidateInputs++;
        if (candidateInputs > MAX_FETCH_PUBLICATION_INPUTS) {
          throw new GitError("E2BIG", "fetch snapshot exceeds its retained input count bound");
        }
        const name = requireRefName(value, "fetch global ref candidate", "input");
        if (!name.startsWith("refs/tags/")) {
          throw new GitError("EINVAL", "fetch global ref candidates must be tag refs");
        }
        budget.charge(
          REF_MUTATION_ITEM_RETAINED_BYTES +
            2 * boundedRefText(name, "fetch global ref candidate", MAX_REFLOG_REF_BYTES, "input"),
        );
        candidates.set(name, null);
      }

      const snapshot = this.#db.transactionSync(() => {
        const repository = this.#db.one<{
          repo_id: unknown;
          fetch_generation: unknown;
          shallow_revision: unknown;
        }>(
          `SELECT id AS repo_id, fetch_generation, shallow_revision
             FROM git_repositories WHERE id = ?`,
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
        if (currentGeneration === Number.MAX_SAFE_INTEGER) {
          throw new GitError("E2BIG", "fetch publication generation is exhausted");
        }

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
        let previousName: string | null = null;
        for (const row of this.#db.iterate(
          "SELECT repo_id, name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
          this.#repoId,
        )) {
          if (row.repo_id !== this.#repoId) {
            throw new CorruptError("fetch ref snapshot crossed repository boundaries");
          }
          const name = requireRefName(row.name, "stored ref name", "stored");
          const target = requireRawRefTarget(row.target, `stored target of ${name}`, "stored");
          if (previousName !== null && comparePaths(previousName, name) >= 0) {
            throw new CorruptError("stored refs are not in strict Git byte order");
          }
          previousName = name;
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
                2 *
                  (boundedRefText(
                    name,
                    "stored tracking ref name",
                    MAX_REFLOG_REF_BYTES,
                    "stored",
                  ) +
                    boundedRefText(
                      target,
                      `stored target of ${name}`,
                      MAX_REFLOG_RAW_TARGET_BYTES,
                      "stored",
                    )),
            );
            tracking.set(name, target);
            trackingRows.push(Object.freeze({ name, target }));
          }
          if (candidates.has(name)) {
            candidates.set(name, target);
            budget.charge(
              2 *
                boundedRefText(
                  target,
                  `stored target of ${name}`,
                  MAX_REFLOG_RAW_TARGET_BYTES,
                  "stored",
                ),
            );
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
          budget.charge(REF_MUTATION_ITEM_RETAINED_BYTES + 2 * row.oid.length);
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
        const globalRows = [...candidates].map(([name, target]) => Object.freeze({ name, target }));
        const state: FetchPublicationState = {
          generation,
          trackingPrefix: prefix,
          namespaceRevision,
          shallowRevision,
          trackingRefs: tracking,
          globalRefs: candidates,
          budget,
          reservation,
          disposed: false,
        };
        return {
          state,
          shallowRows: Object.freeze(shallowRows),
          trackingRows: Object.freeze(trackingRows),
          globalRows: Object.freeze(globalRows),
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
        snapshot.globalRows,
        () => snapshot.state.disposed,
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
  ): boolean {
    if (!this.#issuedFetchPublications.has(token)) {
      throw staleFetch("fetch publication token was not issued by this repository");
    }
    const state = this.#fetchPublicationStates.get(token);
    if (state === undefined || state.disposed) {
      throw staleFetch("fetch publication token is no longer active");
    }
    state.budget.requireSqlHeadroom();
    const normalized = normalizeFetchPublication(state, plan);
    const checkedMetadata = validateRefLogMetadata(metadata);
    const shallowTouched = normalized.shallowAdd.length > 0 || normalized.shallowRemove.length > 0;
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
    let previousPrefix: string | null = null;
    for (const row of this.#db.iterate(
      `SELECT repo_id, tracking_prefix, latest_generation, revision
         FROM git_fetch_namespaces WHERE repo_id = ? ORDER BY tracking_prefix
         LIMIT ${MAX_FETCH_NAMESPACES + 1}`,
      this.#repoId,
    )) {
      if (row.repo_id !== this.#repoId) {
        throw new CorruptError("fetch namespace scan crossed repository boundaries");
      }
      const storedPrefix = requireFetchTrackingPrefix(row.tracking_prefix, "stored");
      if (previousPrefix !== null && comparePaths(previousPrefix, storedPrefix) >= 0) {
        throw new CorruptError("fetch namespaces are not in strict Git byte order");
      }
      previousPrefix = storedPrefix;
      budget.charge(
        REF_MUTATION_ITEM_RETAINED_BYTES +
          2 *
            boundedRefText(
              storedPrefix,
              "stored fetch tracking prefix",
              MAX_REFLOG_REF_BYTES,
              "stored",
            ),
      );
      namespaces.push({
        trackingPrefix: storedPrefix,
        latestGeneration: requireFetchGeneration(
          row.latest_generation,
          "stored fetch namespace generation",
          1,
        ),
        revision: requireFetchGeneration(row.revision, "stored fetch namespace revision", 0),
      });
      if (namespaces.length > MAX_FETCH_NAMESPACES) {
        throw new GitError("E2BIG", "repository fetch namespace count exceeds 1,024");
      }
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

    const selectedGlobalRefs = new Set<string>();
    for (const name of publication.puts.keys()) {
      if (name.startsWith("refs/tags/") && state.globalRefs.has(name)) {
        selectedGlobalRefs.add(name);
      }
    }
    const presentGlobalRefs = new Set<string>();
    let rows = 0;
    let trackingRows = 0;
    let previousName: string | null = null;
    for (const row of this.#db.iterate(
      "SELECT repo_id, name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
      this.#repoId,
    )) {
      if (row.repo_id !== this.#repoId) {
        throw new CorruptError("fetch publication preflight crossed repository boundaries");
      }
      const name = requireRefName(row.name, "stored ref name", "stored");
      const target = requireRawRefTarget(row.target, `stored target of ${name}`, "stored");
      if (previousName !== null && comparePaths(previousName, name) >= 0) {
        throw new CorruptError("stored refs are not in strict Git byte order");
      }
      previousName = name;
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
      if (selectedGlobalRefs.has(name)) {
        const expected = state.globalRefs.get(name);
        if (expected !== target && publication.puts.get(name) !== target) {
          throw staleFetch(`global ref ${name} changed after fetch discovery`);
        }
        presentGlobalRefs.add(name);
      }
    }
    if (trackingRows !== state.trackingRefs.size) {
      throw staleFetch("the tracking ref set changed after fetch discovery");
    }
    for (const name of selectedGlobalRefs) {
      if (state.globalRefs.get(name) !== null && !presentGlobalRefs.has(name)) {
        throw staleFetch(`global ref ${name} changed after fetch discovery`);
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
    const reservation = this.#memory.reserve();
    try {
      const budget = new RefMutationBudget(reservation);
      const normalized = normalizeRefMutation(mutation, budget);
      const checkedMetadata = validateRefLogMetadata(metadata);
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
      }>(
        `SELECT repository.id AS repo_id, checkout.id AS checkout_id, state.next_ordinal,
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

      const checkouts: CheckoutRow[] = [];
      let selected: CheckoutRow | null = null;
      let previousCheckoutId = 0;
      for (const raw of this.#db.iterate(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE repo_id = ? ORDER BY id
           LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
        this.#repoId,
      )) {
        const checkout = requireStoredCheckoutRow(raw);
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
      if (selected === null)
        throw new CorruptError("selected checkout disappeared during ref mutation");
      const oldHead = selected.head;

      const before = new Map<string, string>();
      let rows = 0;
      let retainedBytes = REF_ROW_RETAINED_BYTES + oldHead.length * 2;
      let previousName: string | null = null;
      for (const row of this.#db.iterate(
        "SELECT repo_id, name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
        this.#repoId,
      )) {
        if (row.repo_id !== this.#repoId) {
          throw new CorruptError("ref state query crossed repository boundaries");
        }
        const name = requireRefName(row.name, "stored ref name", "stored");
        const target = requireRawRefTarget(row.target, `stored target of ${name}`, "stored");
        if (previousName !== null && comparePaths(previousName, name) >= 0) {
          throw new CorruptError("stored refs are not in strict Git byte order");
        }
        previousName = name;
        rows++;
        retainedBytes += REF_ROW_RETAINED_BYTES + name.length * 2 + target.length * 2;
        if (rows > MAX_REFLOG_STATE_ROWS || retainedBytes > MAX_REFLOG_STATE_BYTES) {
          throw new GitError("E2BIG", "repository ref state exceeds its retained bound");
        }
        normalized.budget.charge(
          REF_ROW_RETAINED_BYTES +
            2 *
              (boundedRefText(name, "stored ref name", MAX_REFLOG_REF_BYTES, "stored") +
                boundedRefText(
                  target,
                  `stored target of ${name}`,
                  MAX_REFLOG_RAW_TARGET_BYTES,
                  "stored",
                )),
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
      this.#bumpFetchNamespaceRevisions(changedNames, normalized.budget);
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
      return true;
    });
  }

  listRefs(prefix = ""): RefRow[] {
    if (prefix === "") {
      return this.#db.all<RefRow>(
        "SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
        this.#repoId,
      );
    }
    return this.#db.all<RefRow>(
      "SELECT name, target FROM git_refs WHERE repo_id = ? AND name >= ? AND name < ? ORDER BY name",
      this.#repoId,
      prefix,
      nextPrefix(prefix),
    );
  }

  head(): string {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE id = ? AND repo_id = ?`,
      this.#checkoutId,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("checkout HEAD row is missing");
    const checkout = requireStoredCheckoutRow(row);
    if (checkout.id !== this.#checkoutId || checkout.repoId !== this.#repoId) {
      throw new CorruptError("HEAD read crossed a checkout boundary");
    }
    return checkout.head;
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
    let previousOrdinal: number | null = null;
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
             SELECT 1 AS kind, entry.repo_id, NULL AS head, NULL AS next_ordinal,
                    NULL AS latest_ordinal, 'HEAD' AS ref_name, entry.ordinal,
                    entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                    entry.actor_name, entry.actor_email, entry.timestamp, entry.timezone, entry.reason
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
             SELECT 1 AS kind, entry.repo_id, NULL AS head, NULL AS next_ordinal,
              NULL AS latest_ordinal, entry.ref_name, entry.ordinal,
              entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
              entry.actor_name, entry.actor_email, entry.timestamp, entry.timezone, entry.reason
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
  }

  /** Distinct active reflog roots in strict byte order. */
  *activeRefLogOids(): Generator<string> {
    const now = this.#nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_REFLOG_ORDINAL) {
      throw new GitError("EINVAL", "reflog clock must return a safe nonnegative epoch time");
    }
    const cutoff = Math.max(0, now - REFLOG_RETENTION_SECONDS);
    const physicalRows = this.#db.scalar<unknown>(
      `SELECT (SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?)
            + (SELECT count(*) FROM git_checkout_reflog_entries WHERE repo_id = ?)`,
      this.#repoId,
      this.#repoId,
    );
    validateRefLogRootScanBudget(physicalRows);
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
       SELECT * FROM output
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
      if (row.kind !== 2 || typeof row.root_oid !== "string" || !isOid(row.root_oid)) {
        throw new CorruptError("reflog root query returned an invalid object id");
      }
      if (previousOid !== null && comparePaths(previousOid, row.root_oid) >= 0) {
        throw new CorruptError("reflog roots are not in strict byte order");
      }
      previousOid = row.root_oid;
      yield row.root_oid;
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

  /** Read one config value only after SQLite proves its type and byte bound. */
  configGetBounded(path: string, maxBytes: number): string | undefined {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }
    const info = this.#db.one<{ value_type: unknown; value_bytes: unknown }>(
      `SELECT typeof(value) AS value_type,
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
      info.value_type !== "text" ||
      typeof info.value_bytes !== "number" ||
      !Number.isSafeInteger(info.value_bytes) ||
      info.value_bytes < 0
    ) {
      throw new CorruptError(`config ${path} has invalid text metadata`);
    }
    if (info.value_bytes > maxBytes) {
      throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
    }
    const value = this.#db.scalar<unknown>(
      `SELECT value
         FROM git_config
        WHERE repo_id = ? AND path = ?
        ORDER BY seq DESC
        LIMIT 1`,
      this.#repoId,
      path,
    );
    if (typeof value !== "string") {
      throw new CorruptError(`config ${path} has a non-text value`);
    }
    return value;
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

  // -- integration operation journal --------------------------------

  /** Read and validate the one durable incomplete integration operation. */
  readOperationState(): OperationJournal | null {
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
    if (storedBytes > MAX_MERGE_STATE_BYTES) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_STATE_BYTES} retained bytes`);
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
    if (operationJournalIntegrityOid(state, touched, steps) !== integrityOid) {
      throw new CorruptError("operation journal integrity identity does not match its rows");
    }
    const journal = operationJournal(state, steps, touched, retainedBytes, integrityOid);
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
    if (state.kind === "rebase") requireInitialRebaseJournal(state, steps, touched);
    const retainedBytes = operationJournalRetainedBytes(state, touched, steps);
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    let previousPath: string | null = null;
    for (const entry of touched) {
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("operation touched paths are not in strict Git path order");
      }
      previousPath = entry.path;
    }

    this.#db.transactionSync(() => {
      this.requireNoOperationState();
      const journal = operationJournal(state, steps, touched, retainedBytes, integrityOid);
      this.#validateOperationObjects(journal);
      this.#insertOperationHeader(state, steps.length, touched.length, retainedBytes, integrityOid);
      this.#insertOperationSteps(steps);
      this.#insertOperationTouched(touched);
      bumpMaintenanceRootEpoch(this.#db, this.#repoId);
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
          throw new CorruptError("operation journal references a missing object", { cause: error });
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
      }
      page = [];
    };
    for (const oid of expected.keys()) {
      page.push(oid);
      if (page.length === MAX_BLOB_BATCH_OIDS) validatePage();
    }
    validatePage();
    if (journal.kind !== "merge") this.#validateReplayTopology(journal);
  }

  #validateReplayTopology(journal: CherryPickJournal | RevertJournal | RebaseJournal): void {
    if (journal.kind !== "rebase") {
      const step = journal.steps[0];
      if (step === undefined) throw new CorruptError("one-commit replay lost its source step");
      this.#validateOperationCommitBodies([step.sourceOid], 0, (_oid, source) => {
        this.#validateReplayParentSelection(step, source.commit.parent);
      });
      return;
    }
    let expectedSourceParent = journal.state.baseOid;
    let sourceOrdinal = 0;
    let retainedBytes = this.#validateOperationCommitBodies(
      journal.steps.map((step) => step.sourceOid),
      0,
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
    );
    if (expectedSourceParent !== journal.state.originalHeadOid) {
      throw new CorruptError("rebase source sequence does not end at the original HEAD");
    }

    const applied = journal.steps.filter((step) => step.outcome === "applied");
    let expectedResultParent = journal.state.upstreamOid;
    let resultOrdinal = 0;
    retainedBytes = this.#validateOperationCommitBodies(
      applied.map((step) => {
        if (step.resultOid === null) throw new CorruptError("applied rebase step lost its result");
        return step.resultOid;
      }),
      retainedBytes,
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
    );
    if (retainedBytes > MAX_LOG_STATE_BYTES) {
      throw new GitError(
        "E2BIG",
        `operation journal commit bodies exceed ${MAX_LOG_STATE_BYTES} bytes`,
      );
    }
  }

  #validateOperationCommitBodies(
    oids: readonly string[],
    initialBytes: number,
    visit: (oid: string, commit: CommitCacheEntry) => void,
  ): number {
    let retainedBytes = initialBytes;
    const seen = new Set<string>();
    for (let offset = 0; offset < oids.length; offset += MAX_BLOB_BATCH_OIDS) {
      const page = oids.slice(offset, offset + MAX_BLOB_BATCH_OIDS);
      for (const oid of page) {
        if (seen.has(oid)) throw new CorruptError("operation commit sequence contains a cycle");
        seen.add(oid);
      }
      let remaining = page;
      while (remaining.length > 0) {
        const available = MAX_LOG_STATE_BYTES - retainedBytes;
        if (available <= 0) {
          throw new GitError(
            "E2BIG",
            `operation journal commit bodies exceed ${MAX_LOG_STATE_BYTES} bytes`,
          );
        }
        let batch: ObjectReadBatch;
        try {
          batch = this.readObjects(remaining, {
            budgetBytes: Math.min(MAX_BLOB_BATCH_BYTES, available),
          });
        } catch (error) {
          if (hasErrorCode(error, "EFBIG")) {
            throw new GitError(
              "E2BIG",
              `operation journal commit bodies exceed ${MAX_LOG_STATE_BYTES} bytes`,
              { cause: error },
            );
          }
          throw error;
        }
        if (batch.objects.size === 0 || batch.bytes <= 0) {
          throw new CorruptError("operation commit validation made no progress");
        }
        retainedBytes += batch.bytes;
        for (const [oid, object] of batch.objects) {
          if (object.type !== "commit") {
            throw new CorruptError("operation step did not produce a complete commit object");
          }
          visit(oid, prepareCommitCache({ repoId: this.#repoId, oid, data: object.data }));
        }
        remaining = batch.remaining;
      }
    }
    return retainedBytes;
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
    if (state.kind === "rebase") {
      throw new GitError("EOPMISMATCH", "rebase replacement requires a whole-journal transition");
    }
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    this.#db.transactionSync(() => {
      const current = this.readOperationState();
      if (current === null) throw operationNotActive(state.kind);
      if (current.state.kind !== state.kind) {
        throw operationKindMismatch(state.kind, current.state.kind);
      }
      if (current.integrityOid !== expectedIntegrityOid) {
        throw new GitError("EOPMISMATCH", "operation state changed before replacement");
      }
      const retainedBytes = operationJournalRetainedBytes(state, current.touched, current.steps);
      const integrityOid = operationJournalIntegrityOid(state, current.touched, current.steps);
      this.#validateOperationObjects(
        operationJournal(state, current.steps, current.touched, retainedBytes, integrityOid),
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
    });
  }

  /** Compare-and-swap one complete journal transition, including child rows. */
  replaceOperationJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    const retainedBytes = operationJournalRetainedBytes(state, touched, steps);
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    let previousPath: string | null = null;
    for (const entry of touched) {
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("operation touched paths are not in strict Git path order");
      }
      previousPath = entry.path;
    }
    this.#db.transactionSync(() => {
      const current = this.readOperationState();
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
      this.#validateOperationObjects(journal);
      this.#db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.#checkoutId);
      this.#db.run("DELETE FROM git_operation_steps WHERE checkout_id = ?", this.#checkoutId);
      this.#db.run(
        "DELETE FROM git_operation_state WHERE checkout_id = ? AND integrity_oid = ?",
        this.#checkoutId,
        expectedIntegrityOid,
      );
      this.#insertOperationHeader(state, steps.length, touched.length, retainedBytes, integrityOid);
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
      const pending = new IndexMutationBuffer(DEFAULT_INDEX_FLUSH, (mutations) => {
        this.#applyIndexMutations(mutations);
      });
      const blobIds = new InitialBlobIdBuffer(this.#db, this.#repoId);
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
        pending.reservedBytes +
        blobIds.reservedBytes +
        (previousPath?.length ?? 0) * 2;
      const requireRoom = (additional: number, first: "index" | "blob"): void => {
        if (reservedBytes() + additional <= INITIAL_STATE_MEMORY_BYTES) return;
        if (first === "index") pending.flush();
        else blobIds.flush();
        if (reservedBytes() + additional <= INITIAL_STATE_MEMORY_BYTES) return;
        if (first === "index") blobIds.flush();
        else pending.flush();
        if (reservedBytes() + additional > INITIAL_STATE_MEMORY_BYTES) {
          throw new GitError("E2BIG", "initial state session exceeds its 4 MiB memory limit");
        }
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
            pending.add(entry);
            previousPath = entry.path;
            if (reservedBytes() > INITIAL_STATE_MEMORY_BYTES) {
              throw new CorruptError("initial index reservation exceeded its preflight");
            }
          });
        },
        addBlobId: (mapping) => {
          attempt(() => {
            blobIds.validate(mapping);
            if (!blobIds.willCache(mapping)) return;
            if (blobIds.needsFlush(mapping)) blobIds.flush();
            requireRoom(blobIds.additionalReservedBytes(), "blob");
            blobIds.add(mapping);
            if (reservedBytes() > INITIAL_STATE_MEMORY_BYTES) {
              throw new CorruptError("initial blob reservation exceeded its preflight");
            }
          });
        },
      };
      const finish = (): void => {
        attempt(() => pending.flush());
        attempt(() => blobIds.finish());
      };

      try {
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
        pending.dispose();
        blobIds.dispose();
        previousPath = null;
        failure = undefined;
      }
    });
  }

  indexEntries(): IndexEntry[] {
    return this.#db.all<IndexEntry>(
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id = ? ORDER BY path, stage",
      this.#checkoutId,
    );
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return (
      this.#db.one<IndexEntry>(
        "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id = ? AND path = ? AND stage = ?",
        this.#checkoutId,
        path,
        stage,
      ) ?? null
    );
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
    const pageSize = options.pageSize ?? DEFAULT_INDEX_PAGE;
    const prefix = options.prefix;
    let path = options.after?.path ?? "";
    let stage = options.after?.stage ?? -1;

    for (;;) {
      const page =
        prefix === undefined || prefix === ""
          ? this.#db.all<IndexEntry>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index
               WHERE checkout_id = ? AND (path > ? OR (path = ? AND stage > ?))
               ORDER BY path, stage LIMIT ?`,
              this.#checkoutId,
              path,
              path,
              stage,
              pageSize,
            )
          : this.#db.all<IndexEntry>(
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
      for (const entry of page) yield entry;
      const last = page[page.length - 1]!;
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
function nextPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}
