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
  requireMergePhase,
  requireMergePurpose,
  requireMergeText,
} from "../core/ops/merge-state.js";
import {
  type CherryPickJournal,
  type MergeOperationJournal,
  mergeJournalFromOperation,
  mergeOperationState,
  type OperationJournal,
  type OperationKind,
  type OperationStateMetadata,
  operationAlreadyActive,
  operationJournalIntegrityOid,
  operationJournalRetainedBytes,
  operationKindMismatch,
  operationNotActive,
  type ReplayStateMetadata,
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
import { MemoryCoordinator, type MemoryReservation } from "./memory.js";
import {
  MAX_PACK_BLOB_BATCH_BYTES,
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_ROW_CACHE_BYTES,
  type PackCacheOptions,
  PackStore,
} from "./packs.js";

export { PACK_BLOB_CALLER_HEADROOM_BYTES } from "./packs.js";

import { indexTreeSource, indexTreeSources, initializeGitSchema } from "./schema.js";
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

export interface StoreOptions extends PackCacheOptions {
  /** Database-wide bytes of inflated objects held hot across reads. */
  objectCacheBytes?: number;
  now?: () => number;
}

export interface RepositoryRow {
  id: number;
  root: string;
  head: string;
}

export interface RefRow {
  name: string;
  target: string;
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
  mode: unknown;
  source_oid: unknown;
  selected_parent_oid: unknown;
  mainline: unknown;
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

export const MAX_BLOB_ID_MISMATCH_RETAINED_BYTES = 16 * 1024 * 1024;
const BLOB_ID_MISMATCH_ROW_BYTES = 384;

export function blobIdMismatchRetainedBytes(mapping: BlobIdMapping): number {
  return BLOB_ID_MISMATCH_ROW_BYTES + mapping.contentId.length + mapping.oid.length * 2;
}

function contentIdPages(contentIds: Iterable<Uint8Array>): ContentIdPage[] {
  const unique = new Map<string, Uint8Array>();
  for (const contentId of contentIds) {
    if (contentId.length > CONTENT_ID_PAYLOAD) {
      throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
    }
    unique.set(contentIdKey(contentId), contentId);
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
  if (value === "merge" || value === "cherry-pick" || value === "revert") return value;
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

function operationMetadataFromRow(row: OperationStateRow): OperationStateMetadata {
  const kind = requireOperationKind(row.kind);
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
      row.source_oid !== null ||
      row.selected_parent_oid !== null ||
      row.mainline !== null
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
    };
  }
  if (row.current_parent_oid !== null || row.incoming_parent_oid !== null || row.mode !== null) {
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
  return {
    kind,
    ...common,
    phase,
    emptyReason,
    sourceOid: requireMergeOid(row.source_oid, "source"),
    selectedParentOid: requireNullableOperationOid(row.selected_parent_oid, "selected parent"),
    mainline: requireNullableMainline(row.mainline),
  };
}

function operationJournal(
  state: OperationStateMetadata,
  touched: readonly MergeTouchedPath[],
  retainedBytes: number,
  integrityOid: string,
): OperationJournal {
  const fields = { touched, retainedBytes, integrityOid };
  if (state.kind === "merge") return { kind: state.kind, state, ...fields };
  if (state.kind === "cherry-pick") return { kind: state.kind, state, ...fields };
  return { kind: state.kind, state, ...fields };
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

function requireBooleanProbe(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} returned an invalid value`);
  return value === 1;
}

class InitialBlobIdBuffer {
  #payload: Uint8Array | null = new Uint8Array(CONTENT_ID_PAYLOAD);
  #rows: { a: number; n: number; o: string }[] = [];
  #length = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  get retainedBytes(): number {
    return (this.#payload?.length ?? 0) + this.#rows.length * BLOB_ID_MISMATCH_ROW_BYTES;
  }

  get reservedBytes(): number {
    return this.retainedBytes + this.#rows.length * INITIAL_BLOB_ROW_JSON_BYTES * 2 + 4;
  }

  additionalReservedBytes(): number {
    return BLOB_ID_MISMATCH_ROW_BYTES + INITIAL_BLOB_ROW_JSON_BYTES * 2;
  }

  needsFlush(mapping: BlobIdMapping): boolean {
    return (
      this.#rows.length >= CONTENT_ID_PAGE ||
      this.#length + mapping.contentId.length > CONTENT_ID_PAYLOAD
    );
  }

  validate(mapping: BlobIdMapping): void {
    if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
    if (mapping.contentId.length > CONTENT_ID_PAYLOAD) {
      throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
    }
  }

  add(mapping: BlobIdMapping): void {
    this.validate(mapping);
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
    this.db.run(
      `INSERT INTO git_blob_ids (repo_id, content_id, oid)
       SELECT ?,
              CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                   ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
               END,
              json_extract(value, '$.o')
         FROM json_each(?)
        WHERE true
       ON CONFLICT(repo_id, content_id) DO UPDATE SET oid = excluded.oid`,
      this.repoId,
      blob(payload),
      JSON.stringify(this.#rows),
    );
    this.#rows = [];
    this.#length = 0;
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

/** Normalise an absolute workspace path: no trailing slash, always leading. */
export function normalizeRoot(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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

/**
 * Owns the schema and the repository registry. One instance per
 * workspace database; `open()` hands out per-repository stores over the
 * database-wide object and pack-row caches.
 */
export class SqliteGitDatabase {
  readonly #db: SqlDatabase;
  readonly #options: StoreOptions;
  readonly #stores = new Map<number, RepoStore>();
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packRows: ByteLru<string, Uint8Array>;
  readonly #memory = new MemoryCoordinator();
  #nextStoreGeneration = 1;

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
    initializeGitSchema(db);
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  /** The repository whose root is the nearest registered ancestor of `dir`. */
  find(dir: string): RepositoryRow | null {
    for (const candidate of ancestors(dir)) {
      const row = this.#db.one<RepositoryRow>(
        "SELECT id, root, head FROM git_repositories WHERE root = ?",
        candidate,
      );
      if (row !== undefined) return row;
    }
    return null;
  }

  at(root: string): RepositoryRow | null {
    return (
      this.#db.one<RepositoryRow>(
        "SELECT id, root, head FROM git_repositories WHERE root = ?",
        normalizeRoot(root),
      ) ?? null
    );
  }

  list(): RepositoryRow[] {
    return this.#db.all<RepositoryRow>("SELECT id, root, head FROM git_repositories ORDER BY root");
  }

  create(root: string, head: string): RepositoryRow {
    const normalized = normalizeRoot(root);
    return this.#db.transactionSync(() => {
      const nextId =
        (this.#db.scalar<number | null>("SELECT MAX(id) FROM git_repositories") ?? 0) + 1;
      this.#db.run(
        "INSERT INTO git_repositories (id, root, head) VALUES (?, ?, ?)",
        nextId,
        normalized,
        head,
      );
      return { id: nextId, root: normalized, head };
    });
  }

  open(repository: RepositoryRow): RepoStore {
    const existing = this.#stores.get(repository.id);
    if (existing !== undefined) return existing;
    if (!Number.isSafeInteger(this.#nextStoreGeneration)) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const generation = this.#nextStoreGeneration++;
    // Destroying a repository evicts its store, so a reused id can never
    // hand back the previous repository's caches.
    const store = new RepoStore(
      this.#db,
      repository,
      generation,
      this.#objects,
      this.#packRows,
      this.#memory,
      this.#options,
      () => this.#stores.delete(repository.id),
    );
    this.#stores.set(repository.id, store);
    return store;
  }
}

/** Objects, refs, config and index for one repository. */
export class RepoStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #root: string;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packs: PackStore;
  readonly #memory: MemoryCoordinator;
  readonly #cacheNamespace: string;
  #cacheGeneration = 0;
  #hasLoose: boolean;
  readonly #onDestroy: (() => void) | undefined;

  constructor(
    db: SqlDatabase,
    repository: RepositoryRow,
    storeGeneration: number,
    objects: ByteLru<string, RawObject>,
    packRows: ByteLru<string, Uint8Array>,
    memory: MemoryCoordinator,
    options: StoreOptions = {},
    onDestroy?: () => void,
  ) {
    this.#onDestroy = onDestroy;
    this.#db = db;
    this.#repoId = repository.id;
    this.#root = repository.root;
    this.#objects = objects;
    this.#memory = memory;
    this.#cacheNamespace = `${repository.id}:${storeGeneration}`;
    this.#packs = new PackStore(
      db,
      repository.id,
      this.#objects,
      packRows,
      memory,
      this.#cacheNamespace,
      (oid) => this.#readLoose(oid),
      (oids) => this.#readLooseObjects(oids),
      (oids) => this.#looseObjectMetadata(oids),
      options,
    );
    this.#hasLoose =
      (this.#db.scalar<number>(
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)",
        this.#repoId,
      ) ?? 0) > 0;
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  get repoId(): number {
    return this.#repoId;
  }

  get root(): string {
    return this.#root;
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
    let retainedBytes = 0;
    for (const mapping of expected) {
      if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > CONTENT_ID_PAYLOAD) {
        throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
      }
      const bytes = blobIdMismatchRetainedBytes(mapping);
      if (bytes > MAX_BLOB_ID_MISMATCH_RETAINED_BYTES - retainedBytes) {
        throw new GitError(
          "E2BIG",
          `blob id comparison state exceeds ${MAX_BLOB_ID_MISMATCH_RETAINED_BYTES} bytes`,
        );
      }
      retainedBytes += bytes;
      retained.push(mapping);
    }

    const mismatches = new Map<number, string | null>();
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
    for (const mapping of mappings) {
      if (!isOid(mapping.oid)) throw new CorruptError(`invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > CONTENT_ID_PAYLOAD) {
        throw new GitError("E2BIG", "content id exceeds the 1 MiB batch value limit");
      }
      unique.set(contentIdKey(mapping.contentId), mapping);
    }
    if (unique.size === 0) return;
    this.#db.transactionSync(() => {
      let parts: Uint8Array[] = [];
      let rows: { a: number; n: number; o: string }[] = [];
      let length = 0;
      const flush = (): void => {
        if (rows.length === 0) return;
        this.#db.run(
          `INSERT INTO git_blob_ids (repo_id, content_id, oid)
         SELECT ?,
                CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                     ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                 END,
                json_extract(value, '$.o')
           FROM json_each(?)
          WHERE true
         ON CONFLICT(repo_id, content_id) DO UPDATE SET oid = excluded.oid`,
          this.#repoId,
          blob(concat(parts)),
          JSON.stringify(rows),
        );
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
    if (this.#hasLoose && this.#looseRow(oid) !== null) return true;
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
    if (this.#hasLoose) {
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
        indexTreeSource(
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
    this.#hasLoose = true;
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
      this.#db.transactionSync(() => {
        this.#db.run(
          "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'raw')",
          this.#repoId,
          oid,
          type,
          size,
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
          indexTreeSource(
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
      this.#hasLoose = true;
      return oid;
    }

    const rows: Uint8Array[] = [];
    const deflate = new pako.Deflate({ chunkSize: STREAM_CHUNK });
    deflate.onData = (chunk) => {
      if (!(chunk instanceof Uint8Array))
        throw new CorruptError("deflate produced a non-binary chunk");
      rows.push(chunk);
    };

    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'zlib')",
        this.#repoId,
        oid,
        type,
        size,
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
        indexTreeSource(
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
    this.#hasLoose = true;
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
      indexTreeSources(
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
    if (wroteLoose) this.#hasLoose = true;
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
    if (this.#hasLoose) {
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
    if (this.#hasLoose) {
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
    if (!this.#hasLoose) return null;
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
    if (name === "HEAD") return this.head();
    return (
      this.#db.scalar<string>(
        "SELECT target FROM git_refs WHERE repo_id = ? AND name = ?",
        this.#repoId,
        name,
      ) ?? null
    );
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") {
      this.setHead(target);
      return;
    }
    this.#db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?) ON CONFLICT(repo_id, name) DO UPDATE SET target = excluded.target",
      this.#repoId,
      name,
      target,
    );
  }

  deleteRef(name: string): void {
    this.#db.run("DELETE FROM git_refs WHERE repo_id = ? AND name = ?", this.#repoId, name);
  }

  /** Apply bounded ref deletions and updates atomically. */
  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    const checkedPuts = function* (): Generator<RefRow> {
      for (const row of puts) {
        if (row.name === "HEAD") throw new GitError("EINVAL", "HEAD is not a git_refs row");
        yield row;
      }
    };
    this.#db.transactionSync(() => {
      for (const page of jsonPages(deletes, "ref deletion")) {
        this.#db.run(
          `DELETE FROM git_refs
            WHERE repo_id = ? AND name IN (SELECT value FROM json_each(?))`,
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(checkedPuts(), "ref update")) {
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
    return (
      this.#db.scalar<string>("SELECT head FROM git_repositories WHERE id = ?", this.#repoId) ??
      "ref: refs/heads/main"
    );
  }

  setHead(value: string): void {
    this.#db.run("UPDATE git_repositories SET head = ? WHERE id = ?", value, this.#repoId);
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
              CASE WHEN typeof(phase) = 'text' AND length(CAST(phase AS BLOB)) <= 10
                   THEN phase END AS phase,
              CASE WHEN empty_reason IS NULL THEN NULL
                   WHEN typeof(empty_reason) = 'text'
                         AND length(CAST(empty_reason AS BLOB)) <= 6
                   THEN empty_reason ELSE 0 END AS empty_reason,
              CASE WHEN mode IS NULL THEN NULL
                   WHEN typeof(mode) = 'text' AND length(CAST(mode AS BLOB)) <= 9
                   THEN mode ELSE 0 END AS mode,
              CASE WHEN source_oid IS NULL THEN NULL
                   WHEN typeof(source_oid) = 'text' AND length(CAST(source_oid AS BLOB)) = 40
                   THEN source_oid ELSE 0 END AS source_oid,
              CASE WHEN selected_parent_oid IS NULL THEN NULL
                   WHEN typeof(selected_parent_oid) = 'text'
                         AND length(CAST(selected_parent_oid AS BLOB)) = 40
                   THEN selected_parent_oid ELSE 0 END AS selected_parent_oid,
              mainline,
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
         FROM git_operation_state WHERE repo_id = ?`,
      this.#repoId,
    );
    if (row === undefined) {
      const orphaned = requireBooleanProbe(
        this.#db.scalar<unknown>(
          "SELECT EXISTS(SELECT 1 FROM git_operation_touched WHERE repo_id = ? LIMIT 1)",
          this.#repoId,
        ),
        "operation touched-path orphan probe",
      );
      if (orphaned) throw new CorruptError("touched paths exist without operation state");
      return null;
    }

    const touchedCount = requireMergeInteger(row.touched_count, "touched-path count");
    const storedBytes = requireMergeInteger(row.retained_bytes, "retained-byte count");
    if (touchedCount > MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    if (storedBytes > MAX_MERGE_STATE_BYTES) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_STATE_BYTES} retained bytes`);
    }
    const state = operationMetadataFromRow(row);

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
         FROM git_operation_touched WHERE repo_id = ? ORDER BY ordinal`,
      this.#repoId,
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
    const retainedBytes = operationJournalRetainedBytes(state, touched);
    if (retainedBytes !== storedBytes) {
      throw new CorruptError("merge journal retained-byte count does not match its rows");
    }
    const integrityOid = requireMergeOid(row.integrity_oid, "journal integrity oid");
    if (operationJournalIntegrityOid(state, touched) !== integrityOid) {
      throw new CorruptError("operation journal integrity identity does not match its rows");
    }
    const journal = operationJournal(state, touched, retainedBytes, integrityOid);
    this.#validateOperationObjects(journal);
    return journal;
  }

  /** Atomically create one bounded operation journal; an existing operation wins. */
  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    const retainedBytes = operationJournalRetainedBytes(state, touched);
    const integrityOid = operationJournalIntegrityOid(state, touched);
    let previousPath: string | null = null;
    for (const entry of touched) {
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("operation touched paths are not in strict Git path order");
      }
      previousPath = entry.path;
    }

    this.#db.transactionSync(() => {
      this.requireNoOperationState();
      this.#validateOperationObjects(operationJournal(state, touched, retainedBytes, integrityOid));
      this.#db.run(
        `INSERT INTO git_operation_state
           (repo_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
            current_parent_oid, incoming_parent_oid, mode, source_oid,
            selected_parent_oid, mainline, current_label, incoming_label,
            message, author_name, author_email, committer_name, committer_email,
            touched_count, retained_bytes, integrity_oid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.#repoId,
        state.kind,
        state.originalHeadRef,
        state.originalHeadOid,
        state.phase,
        state.kind === "merge" ? null : state.emptyReason,
        state.kind === "merge" ? state.currentParentOid : null,
        state.kind === "merge" ? state.incomingParentOid : null,
        state.kind === "merge" ? state.mode : null,
        state.kind === "merge" ? null : state.sourceOid,
        state.kind === "merge" ? null : state.selectedParentOid,
        state.kind === "merge" ? null : state.mainline,
        state.currentLabel,
        state.incomingLabel,
        state.message,
        state.author?.name ?? null,
        state.author?.email ?? null,
        state.committer?.name ?? null,
        state.committer?.email ?? null,
        touched.length,
        retainedBytes,
        integrityOid,
      );

      function* rows(): Generator<PersistedOperationTouched> {
        for (let ordinal = 0; ordinal < touched.length; ordinal++) {
          yield persistedOperationTouched(touched[ordinal]!, ordinal);
        }
      }
      for (const page of jsonPages(rows(), "operation touched path")) {
        this.#db.run(
          `INSERT INTO git_operation_touched
             (repo_id, ordinal, path, logical_path, purpose,
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
          this.#repoId,
          page,
        );
      }
    });
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
    } else {
      add({ oid: journal.state.sourceOid, type: "commit", label: "source" });
      if (journal.state.selectedParentOid !== null) {
        add({
          oid: journal.state.selectedParentOid,
          type: "commit",
          label: "selected parent",
        });
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

    let info: ObjectReadInfo[];
    try {
      info = this.objectInfo([...expected.keys()]);
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
    if (journal.kind !== "merge") this.#validateReplayParentSelection(journal.state);
  }

  #validateReplayParentSelection(state: ReplayStateMetadata): void {
    const batch = this.readObjects([state.sourceOid], { budgetBytes: MAX_INDEXED_COMMIT_BYTES });
    const object = batch.objects.get(state.sourceOid);
    if (object === undefined || batch.remaining.length !== 0 || object.type !== "commit") {
      throw new CorruptError("replay source did not produce one complete commit object");
    }
    const source = prepareCommitCache({
      repoId: this.#repoId,
      oid: state.sourceOid,
      data: object.data,
    });
    const parents = source.commit.parent;
    if (parents.length === 0) {
      if (state.selectedParentOid !== null || state.mainline !== null) {
        throw new CorruptError("root replay source retained a selected parent or mainline");
      }
      return;
    }
    if (parents.length === 1) {
      if (
        state.selectedParentOid !== parents[0] ||
        (state.mainline !== null && state.mainline !== 1)
      ) {
        throw new CorruptError("single-parent replay selection differs from its source commit");
      }
      return;
    }
    if (
      state.mainline === null ||
      state.mainline > parents.length ||
      state.selectedParentOid !== parents[state.mainline - 1]
    ) {
      throw new CorruptError("merge replay selection differs from its source commit");
    }
  }

  /** Replace authenticated metadata while retaining the exact touched snapshot. */
  replaceOperationState(expectedIntegrityOid: string, state: OperationStateMetadata): void {
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
      const retainedBytes = operationJournalRetainedBytes(state, current.touched);
      const integrityOid = operationJournalIntegrityOid(state, current.touched);
      this.#validateOperationObjects(
        operationJournal(state, current.touched, retainedBytes, integrityOid),
      );
      this.#db.run(
        `UPDATE git_operation_state
            SET original_head_ref = ?, original_head_oid = ?, phase = ?, empty_reason = ?,
                current_parent_oid = ?, incoming_parent_oid = ?, mode = ?, source_oid = ?,
                selected_parent_oid = ?, mainline = ?, current_label = ?, incoming_label = ?,
                message = ?, author_name = ?, author_email = ?, committer_name = ?,
                committer_email = ?, retained_bytes = ?, integrity_oid = ?
          WHERE repo_id = ? AND integrity_oid = ?`,
        state.originalHeadRef,
        state.originalHeadOid,
        state.phase,
        state.kind === "merge" ? null : state.emptyReason,
        state.kind === "merge" ? state.currentParentOid : null,
        state.kind === "merge" ? state.incomingParentOid : null,
        state.kind === "merge" ? state.mode : null,
        state.kind === "merge" ? null : state.sourceOid,
        state.kind === "merge" ? null : state.selectedParentOid,
        state.kind === "merge" ? null : state.mainline,
        state.currentLabel,
        state.incomingLabel,
        state.message,
        state.author?.name ?? null,
        state.author?.email ?? null,
        state.committer?.name ?? null,
        state.committer?.email ?? null,
        retainedBytes,
        integrityOid,
        this.#repoId,
        expectedIntegrityOid,
      );
    });
  }

  /** Clear operation metadata and touched snapshots, including corrupt orphans. */
  clearOperationState(): boolean {
    return this.#db.transactionSync(() => {
      const existed = requireBooleanProbe(
        this.#db.scalar<unknown>(
          `SELECT EXISTS(
             SELECT 1 FROM git_operation_state WHERE repo_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_touched WHERE repo_id = ? LIMIT 1
           )`,
          this.#repoId,
          this.#repoId,
        ),
        "operation state clear probe",
      );
      this.#db.run("DELETE FROM git_operation_touched WHERE repo_id = ?", this.#repoId);
      this.#db.run("DELETE FROM git_operation_state WHERE repo_id = ?", this.#repoId);
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
  requireOperationState(kind: OperationKind): OperationJournal;
  requireOperationState(kind: OperationKind): OperationJournal {
    const journal = this.readOperationState();
    if (journal === null) throw operationNotActive(kind);
    if (journal.kind !== kind) throw operationKindMismatch(kind, journal.kind);
    if (journal.kind === "merge") return journal;
    if (journal.kind === "cherry-pick") return journal;
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
        "SELECT EXISTS(SELECT 1 FROM git_index WHERE repo_id = ? LIMIT 1)",
        this.#repoId,
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
        attempt(() => blobIds.flush());
      };

      try {
        const value = body(session);
        requireActive();
        if (isThenableResult(value)) {
          void Promise.resolve(value).catch(() => {});
          throw new Error("initial state body returned an asynchronous result");
        }
        finish();
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
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE repo_id = ? ORDER BY path, stage",
      this.#repoId,
    );
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return (
      this.#db.one<IndexEntry>(
        "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE repo_id = ? AND path = ? AND stage = ?",
        this.#repoId,
        path,
        stage,
      ) ?? null
    );
  }

  indexPut(entry: IndexEntry): void {
    this.#db.run(
      `INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      this.#repoId,
      entry.path,
      entry.stage,
      entry.mode,
      entry.oid,
      entry.size,
      entry.mtime,
      entry.ino,
      entry.rev ?? null,
    );
  }

  /** Remove every stage of `path`. */
  indexRemove(path: string): void {
    this.#db.run("DELETE FROM git_index WHERE repo_id = ? AND path = ?", this.#repoId, path);
  }

  indexClear(): void {
    this.#db.run("DELETE FROM git_index WHERE repo_id = ?", this.#repoId);
  }

  #applyIndexMutations(pending: readonly BufferedIndexMutation[]): void {
    // Delete touched paths first, then retain only puts after their last remove.
    const hasRemoves = pending.some((item) => item.kind === "r");
    const hasPuts = pending.some((item) => item.kind === "p");
    const mutations = `[${pending.map((item) => item.json).join(",")}]`;
    if (hasRemoves) {
      this.#db.run(
        `DELETE FROM git_index
          WHERE repo_id = ?
            AND path IN (
              SELECT json_extract(value, '$.p') FROM json_each(?)
               WHERE json_extract(value, '$.k') = 'r'
            )`,
        this.#repoId,
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
       INSERT INTO git_index (repo_id, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, current.path, current.stage, current.mode, current.oid,
              current.size, current.mtime, current.ino, current.rev
         FROM ranked current
        WHERE current.kind = 'p'
          AND current.q = current.last_put
          AND current.q > current.last_remove
        ORDER BY current.q
       ON CONFLICT(repo_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      mutations,
      this.#repoId,
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
        if (first) this.indexClear();
        this.#applyIndexMutations(mutations);
      });
      first = false;
    });
    for (const entry of entries) pending.add(entry);
    pending.flush();
    if (first) this.#db.transactionSync(() => this.indexClear());
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
               WHERE repo_id = ? AND (path > ? OR (path = ? AND stage > ?))
               ORDER BY path, stage LIMIT ?`,
              this.#repoId,
              path,
              path,
              stage,
              pageSize,
            )
          : this.#db.all<IndexEntry>(
              `SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index
               WHERE repo_id = ? AND (path > ? OR (path = ? AND stage > ?))
                 AND (path = ? OR (path >= ? AND path < ?))
               ORDER BY path, stage LIMIT ?`,
              this.#repoId,
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
        "SELECT COUNT(*) FROM (SELECT 1 FROM git_index WHERE repo_id = ? AND stage > 0 LIMIT 1)",
        this.#repoId,
      ) ?? 0) > 0
    );
  }

  /** True when checkout would encounter a merge stage or stage-zero gitlink. */
  hasCheckoutBlockingIndexEntries(): boolean {
    return (
      (this.#db.scalar<number>(
        `SELECT COUNT(*) FROM (
           SELECT 1 FROM git_index
            WHERE repo_id = ? AND (stage > 0 OR (stage = 0 AND mode = 57344)) LIMIT 1
         )`,
        this.#repoId,
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
      for (const page of jsonPages(checked(remove), "shallow deletion")) {
        this.#db.run(
          "DELETE FROM git_shallow WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
          this.#repoId,
          page,
        );
      }
      for (const page of jsonPages(checked(add), "shallow update")) {
        this.#db.run(
          `INSERT OR IGNORE INTO git_shallow (repo_id, oid)
           SELECT ?, value FROM json_each(?)`,
          this.#repoId,
          page,
        );
      }
    });
  }

  // -- lifecycle ------------------------------------------------------

  /** Drop every row belonging to this repository. */
  destroy(): void {
    this.#db.transactionSync(() => {
      for (const table of [
        "git_index_dirty",
        "git_index_state",
        "git_operation_touched",
        "git_operation_state",
        "git_refs",
        "git_blob_ids",
        "git_config",
        "git_index",
        "git_shallow",
        "git_commits",
        "git_tree_effective",
        "git_tree_entries",
        "git_tree_sources",
        "git_objects",
        "git_object_chunks",
        "git_pack_meta",
        "git_pack_data",
        "git_pack_objects",
        "git_pack_pending",
      ]) {
        this.#db.run(`DELETE FROM ${table} WHERE repo_id = ?`, this.#repoId);
      }
      this.#db.run("DELETE FROM git_repositories WHERE id = ?", this.#repoId);
    });
    this.#cacheGeneration++;
    this.#packs.clearCaches();
    this.#hasLoose = false;
    this.#onDestroy?.();
  }

  #objectCacheKey(oid: string): string {
    return `${this.#cacheNamespace}:${this.#cacheGeneration}:loose:${oid}`;
  }
}

/** The exclusive upper bound of a string prefix range. */
function nextPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}
