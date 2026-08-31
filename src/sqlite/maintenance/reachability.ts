import { isOid, toHex } from "../../core/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../../core/errors.js";
import type { ObjectType } from "../../core/objects.js";
import { InflateStream } from "../../core/zlib.js";
import type { SqlDatabase } from "../db.js";
import { MAX_DELTA_DEPTH } from "../packs.js";
import type { ObjectReadInfo, SharedRepoStore } from "../store.js";
import { TREE_QUEUE_ROW_FIXED_BYTES } from "../tree-index.js";

const EDGE_PAGE = 256;
const HEADER_LINE_PREFIX_BYTES = 128;

export type MaintenanceReachabilityStatus = "progress" | "complete" | "root-changed";

export interface MaintenanceReachabilityProgress {
  runId: number;
  status: MaintenanceReachabilityStatus;
  processedOid: string | null;
  discoveredObjects: number;
  discoveredLogicalObjects: number;
}

interface RunState {
  runId: number;
  observedRootEpoch: number;
  rootEpoch: number;
  phase: string;
  rootSource: string;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  reachableObjects: number;
  queuedObjects: number;
}

interface QueueObject {
  oid: string;
  sourceMask: number;
  shallowBoundary: boolean;
  physicalOnly: boolean;
  edgeCursor: number;
}

interface ReachabilityEdge {
  oid: string;
  type: ObjectType;
  optionalMissing: boolean;
  physicalOnly: boolean;
}

interface ObjectExpansion {
  edges: ReachabilityEdge[];
  nextCursor: number;
  complete: boolean;
}

interface HeaderScanResult {
  treeOid: string | null;
  parentOids: string[];
  parentCount: number;
  tagOid: string | null;
  tagType: ObjectType | null;
}

interface NormalizedEdge extends ReachabilityEdge {
  present: boolean;
}

interface ExistingMark {
  exists: boolean;
  physicalOnly: boolean;
  expanded: boolean;
  edgeCursor: number;
}

interface PublicationResult {
  discoveredObjects: number;
  discoveredLogicalObjects: number;
}

interface TreeEdgeMetadata {
  sourceKey: number;
  ordinal: number;
  mode: string;
  nameLength: number;
  oid: string;
  rawLength: number;
  cumulativeBase: number;
}

interface ReachabilityObjectInfo extends ObjectReadInfo {
  stored: "raw" | "zlib" | null;
  largestChunk: number;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
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

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label, 0);
}

function booleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} is not boolean`);
  return value === 1;
}

function objectType(value: unknown, label: string): ObjectType {
  if (value !== "blob" && value !== "tree" && value !== "commit" && value !== "tag") {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

function oidField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

function readRun(db: SqlDatabase, repoId: number): RunState {
  const row = db.one<Record<string, unknown>>(
    `SELECT run.repo_id, run.run_id, run.observed_root_epoch, run.phase, run.root_source,
            run.cursor_checkout_id, run.cursor_text, run.cursor_ordinal,
            run.reachable_objects, run.queued_objects, control.root_epoch
       FROM git_maintenance_runs run
       JOIN git_maintenance_control control ON control.repo_id = run.repo_id
      WHERE run.repo_id = ?`,
    repoId,
  );
  if (row === undefined) throw new GitError("ENOTFOUND", "maintenance run does not exist");
  if (row.repo_id !== repoId) throw new CorruptError("maintenance run crossed repositories");
  const cursorText = row.cursor_text;
  if (cursorText !== null && typeof cursorText !== "string") {
    throw new CorruptError("maintenance run text cursor is invalid");
  }
  const run: RunState = {
    runId: safeInteger(row.run_id, "maintenance run id", 1),
    observedRootEpoch: safeInteger(row.observed_root_epoch, "maintenance observed root epoch", 0),
    rootEpoch: safeInteger(row.root_epoch, "maintenance root epoch", 0),
    phase: typeof row.phase === "string" ? row.phase : "",
    rootSource: typeof row.root_source === "string" ? row.root_source : "",
    cursorCheckoutId: nullableInteger(row.cursor_checkout_id, "maintenance checkout cursor"),
    cursorText,
    cursorOrdinal: nullableInteger(row.cursor_ordinal, "maintenance ordinal cursor"),
    reachableObjects: safeInteger(row.reachable_objects, "maintenance reachable count", 0),
    queuedObjects: safeInteger(row.queued_objects, "maintenance queued count", 0),
  };
  if (
    run.phase !== "roots" &&
    run.phase !== "mark" &&
    run.phase !== "classify-loose" &&
    run.phase !== "repack" &&
    run.phase !== "classify-packs" &&
    run.phase !== "sweep-loose" &&
    run.phase !== "sweep-packs" &&
    run.phase !== "finish"
  ) {
    throw new CorruptError("maintenance run phase is invalid");
  }
  if (
    run.rootSource !== "done" ||
    run.cursorCheckoutId !== null ||
    run.cursorText !== null ||
    run.cursorOrdinal !== null
  ) {
    throw new CorruptError("maintenance mark run retained a root cursor");
  }
  return run;
}

function initializeAndValidateCounters(db: SqlDatabase, repoId: number, run: RunState): RunState {
  if (run.reachableObjects !== 0 || run.queuedObjects === 0) return run;
  const counts = db.one<Record<string, unknown>>(
    `SELECT coalesce(sum(CASE WHEN expanded = 0 THEN 1 ELSE 0 END), 0) AS queued,
            coalesce(sum(CASE WHEN physical_only = 0 THEN 1 ELSE 0 END), 0) AS logical,
            coalesce(sum(CASE WHEN physical_only != 0 OR expanded != 0 OR edge_cursor != 0
                              THEN 1 ELSE 0 END), 0) AS invalid
       FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?`,
    repoId,
    run.runId,
  );
  if (counts === undefined) {
    throw new CorruptError("maintenance initialization count returned no row");
  }
  const queued = safeInteger(counts.queued, "initial maintenance queued count", 0);
  const logical = safeInteger(counts.logical, "initial maintenance logical count", 0);
  const invalid = safeInteger(counts.invalid, "invalid initialized maintenance count", 0);
  if (queued !== run.queuedObjects || logical !== queued) {
    throw new CorruptError("initial maintenance counters disagree with their root marks");
  }
  if (invalid !== 0) {
    throw new CorruptError("uninitialized maintenance roots already contain traversal state");
  }
  const updated = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET reachable_objects = ?
      WHERE repo_id = ? AND run_id = ? AND phase = 'mark'
        AND reachable_objects = 0 AND queued_objects = ?
      RETURNING repo_id, run_id, reachable_objects, queued_objects`,
    logical,
    repoId,
    run.runId,
    run.queuedObjects,
  );
  if (
    updated === undefined ||
    updated.repo_id !== repoId ||
    updated.run_id !== run.runId ||
    updated.reachable_objects !== logical ||
    updated.queued_objects !== run.queuedObjects
  ) {
    throw new CorruptError("maintenance root counters were not initialized atomically");
  }
  return { ...run, reachableObjects: logical };
}

function readNextObject(db: SqlDatabase, repoId: number, runId: number): QueueObject | null {
  let result: QueueObject | null = null;
  let previous: { oid: string; physicalOnly: boolean } | null = null;
  let rows = 0;
  for (const row of db.iterate(
    `SELECT object.repo_id, object.run_id, object.oid, object.source_mask,
            object.expanded, object.shallow_boundary, object.physical_only,
            object.edge_cursor,
            EXISTS (
              SELECT 1 FROM git_maintenance_shallow shallow
               WHERE shallow.repo_id = object.repo_id AND shallow.run_id = object.run_id
                 AND shallow.oid = object.oid
            ) AS stored_shallow
       FROM git_maintenance_objects object
      WHERE object.repo_id = ? AND object.run_id = ? AND object.expanded = 0
      ORDER BY object.physical_only ASC, object.oid COLLATE BINARY LIMIT 2`,
    repoId,
    runId,
  )) {
    rows++;
    if (row.repo_id !== repoId || row.run_id !== runId) {
      throw new CorruptError("maintenance mark queue crossed run boundaries");
    }
    const oid = oidField(row.oid, "maintenance queued OID");
    const physicalOnly = booleanInteger(row.physical_only, "maintenance physical-only marker");
    const expanded = booleanInteger(row.expanded, "maintenance expanded marker");
    const shallowBoundary = booleanInteger(row.shallow_boundary, "maintenance shallow marker");
    const storedShallow = booleanInteger(row.stored_shallow, "maintenance shallow membership");
    if (expanded || shallowBoundary !== storedShallow || (physicalOnly && shallowBoundary)) {
      throw new CorruptError("maintenance queued object has inconsistent state");
    }
    const edgeCursor = safeInteger(row.edge_cursor, "maintenance edge cursor", 0);
    if (physicalOnly && edgeCursor !== 0) {
      throw new CorruptError("physical-only maintenance object retained a semantic cursor");
    }
    if (
      previous !== null &&
      ((previous.physicalOnly === physicalOnly && oid <= previous.oid) ||
        (previous.physicalOnly && !physicalOnly))
    ) {
      throw new CorruptError("maintenance mark queue is not in deterministic order");
    }
    previous = { oid, physicalOnly };
    if (result === null) {
      result = {
        oid,
        sourceMask: safeInteger(row.source_mask, "maintenance source mask", 0),
        shallowBoundary,
        physicalOnly,
        edgeCursor,
      };
    }
  }
  if (rows > 2) throw new CorruptError("maintenance mark queue exceeded its sentinel");
  return result;
}

class StreamingHeaders {
  readonly #prefix = new Uint8Array(HEADER_LINE_PREFIX_BYTES);
  #prefixLength = 0;
  #lineLength = 0;
  #header = true;
  #previousStructural = false;
  #received = 0;
  #treeOid: string | null = null;
  #parentCount = 0;
  readonly #parentOids: string[] = [];
  #tagOid: string | null = null;
  #tagType: ObjectType | null = null;

  constructor(
    private readonly kind: "commit" | "tag",
    private readonly parentStart: number,
    private readonly parentLimit: number,
  ) {}

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      this.#received++;
      if (!Number.isSafeInteger(this.#received)) {
        throw new CorruptError(`${this.kind} object size exceeds the safe integer range`);
      }
      if (!this.#header) continue;
      if (byte === 0x0a) {
        if (this.#lineLength === 0) this.#header = false;
        else this.#finishLine();
        this.#prefixLength = 0;
        this.#lineLength = 0;
        continue;
      }
      if (this.#prefixLength < this.#prefix.length) {
        this.#prefix[this.#prefixLength++] = byte;
      }
      this.#lineLength++;
    }
  }

  finish(expectedSize: number): HeaderScanResult {
    if (this.#header && this.#lineLength !== 0) this.#finishLine();
    if (this.#received !== expectedSize) {
      throw new CorruptError(
        `${this.kind} object yielded ${this.#received} bytes, expected ${expectedSize}`,
      );
    }
    return {
      treeOid: this.#treeOid,
      parentOids: this.#parentOids,
      parentCount: this.#parentCount,
      tagOid: this.#tagOid,
      tagType: this.#tagType,
    };
  }

  #finishLine(): void {
    if (this.#prefix[0] === 0x20) {
      if (this.#previousStructural) {
        throw new CorruptError(`${this.kind} structural header has a continuation`);
      }
      this.#previousStructural = false;
      return;
    }
    let space = -1;
    for (let index = 0; index < this.#prefixLength; index++) {
      if (this.#prefix[index] === 0x20) {
        space = index;
        break;
      }
    }
    if (space <= 0) {
      this.#previousStructural = false;
      return;
    }
    const key = this.#ascii(0, space);
    const structural =
      (this.kind === "commit" && (key === "tree" || key === "parent")) ||
      (this.kind === "tag" && (key === "object" || key === "type"));
    this.#previousStructural = structural;
    if (!structural) return;
    if (this.#lineLength > this.#prefixLength) {
      throw new CorruptError(`${this.kind} structural header is too long`);
    }
    const value = this.#ascii(space + 1, this.#prefixLength);
    if (key === "tree") {
      if (!isOid(value)) throw new CorruptError("commit has a malformed tree oid");
      this.#treeOid = value;
      return;
    }
    if (key === "parent") {
      if (!isOid(value)) throw new CorruptError("commit has a malformed parent oid");
      if (this.#parentCount >= this.parentStart && this.#parentOids.length < this.parentLimit) {
        this.#parentOids.push(value);
      }
      this.#parentCount++;
      return;
    }
    if (key === "object") {
      if (!isOid(value)) throw new CorruptError("tag has a malformed object oid");
      this.#tagOid = value;
      return;
    }
    this.#tagType = objectType(value, "tag target type");
  }

  #ascii(start: number, end: number): string {
    let result = "";
    for (let index = start; index < end; index++) {
      const byte = this.#prefix[index];
      if (byte === undefined || byte < 0x20 || byte > 0x7e) {
        throw new CorruptError(`${this.kind} structural header is not ASCII`);
      }
      result += String.fromCharCode(byte);
    }
    return result;
  }
}

function requireObjectInfo(store: SharedRepoStore, oid: string): ReachabilityObjectInfo {
  let result: ReachabilityObjectInfo | null = null;
  let rows = 0;
  for (const row of store.db.iterate(
    `SELECT /* maintenance-object-info */ input.oid,
             CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                  WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.type) = 'text'
                       AND length(CAST(loose.type AS BLOB)) <= 6 THEN loose.type
                  WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                       AND typeof(packed.type) = 'text'
                       AND length(CAST(packed.type AS BLOB)) <= 6 THEN packed.type END AS type,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.size) = 'integer'
                       AND loose.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN loose.size
                  WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                       AND typeof(packed.size) = 'integer'
                       AND packed.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                       THEN packed.size END AS size,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.stored) = 'text'
                       AND length(CAST(loose.stored AS BLOB)) <= 4 THEN loose.stored END AS stored,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE (
               SELECT CASE WHEN count(*) <= ${Number.MAX_SAFE_INTEGER} THEN count(*) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.oid
             ) END AS chunk_rows,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE (
               SELECT CASE WHEN count(*) <= ${Number.MAX_SAFE_INTEGER} THEN count(*) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.oid
                  AND (typeof(chunk.seq) != 'integer'
                       OR chunk.seq NOT BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                       OR typeof(chunk.data) != 'blob' OR length(chunk.data) > 1048576)
             ) END AS invalid_chunk_rows,
             CASE WHEN loose.oid IS NULL THEN NULL ELSE (
               SELECT min(CASE WHEN typeof(seq) = 'integer'
                                     AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN seq END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.oid
             ) END AS first_chunk,
             CASE WHEN loose.oid IS NULL THEN NULL ELSE (
               SELECT max(CASE WHEN typeof(seq) = 'integer'
                                     AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN seq END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.oid
             ) END AS last_chunk,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE coalesce((
               SELECT max(CASE WHEN typeof(data) = 'blob' AND length(data) <= 1048576
                               THEN length(data) END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.oid
             ), 0) END AS largest_chunk,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE coalesce((
               SELECT CASE WHEN typeof(sum(length(data))) = 'integer'
                                  AND sum(length(data)) BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                           THEN sum(length(data)) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.oid
             ), 0) END AS stored_bytes
       FROM (SELECT ? AS oid) input
       LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = input.oid
       LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = input.oid
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
        AND pack.state = 'complete'
      LIMIT 2`,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    oid,
    store.repoId,
    store.repoId,
  )) {
    rows++;
    if (rows > 1 || row.oid !== oid) {
      throw new CorruptError("reachable object metadata returned inconsistent rows");
    }
    if (row.source !== "loose" && row.source !== "pack") {
      if (row.source === null) throw new CorruptError(`reachable object ${oid} is missing`);
      throw new CorruptError("reachable object metadata returned an invalid source");
    }
    const type = objectType(row.type, "reachable object type");
    const size = safeInteger(row.size, "reachable object size", 0);
    const chunkRows = safeInteger(row.chunk_rows, "reachable object chunk count", 0);
    const invalidChunkRows = safeInteger(
      row.invalid_chunk_rows,
      "reachable object invalid chunk count",
      0,
    );
    const largestChunk = safeInteger(row.largest_chunk, "reachable object chunk size", 0);
    const storedBytes = safeInteger(row.stored_bytes, "reachable object stored size", 0);
    if (
      (row.source === "loose" && row.stored !== "raw" && row.stored !== "zlib") ||
      (row.source === "loose" && chunkRows <= 0) ||
      (row.source === "loose" && invalidChunkRows !== 0) ||
      (row.source === "loose" && row.first_chunk !== 0) ||
      (row.source === "loose" && row.last_chunk !== chunkRows - 1) ||
      (row.source === "loose" && largestChunk > 1024 * 1024) ||
      (row.source === "loose" && row.stored === "raw" && storedBytes !== size) ||
      (row.source === "loose" && row.stored === "zlib" && storedBytes === 0) ||
      (row.source === "pack" &&
        (row.stored !== null ||
          chunkRows !== 0 ||
          row.first_chunk !== null ||
          row.last_chunk !== null ||
          largestChunk !== 0 ||
          storedBytes !== 0))
    ) {
      throw new CorruptError("reachable object metadata returned invalid fields");
    }
    result = {
      oid,
      type,
      size,
      source: row.source,
      chunkRows,
      stored:
        row.source === "loose" && (row.stored === "raw" || row.stored === "zlib")
          ? row.stored
          : null,
      largestChunk,
    };
  }
  if (rows !== 1 || result === null) {
    throw new CorruptError("reachable object metadata returned an incomplete result");
  }
  return result;
}

function scanHeaders(
  store: SharedRepoStore,
  info: ReachabilityObjectInfo,
  kind: "commit" | "tag",
  parentStart: number,
  parentLimit: number,
): HeaderScanResult {
  const parser = new StreamingHeaders(kind, parentStart, parentLimit);
  if (info.source === "loose") streamLooseHeaders(store, info, parser);
  else {
    const objects = store.packs.readObjects([info.oid], kind);
    const object = objects.get(info.oid);
    if (object === undefined) throw new CorruptError(`reachable ${kind} ${info.oid} disappeared`);
    if (objects.size !== 1 || object.type !== kind || object.data.length !== info.size) {
      throw new CorruptError(`reachable packed ${kind} disagrees with its indexed metadata`);
    }
    parser.push(object.data);
  }
  return parser.finish(info.size);
}

function streamLooseHeaders(
  store: SharedRepoStore,
  info: ReachabilityObjectInfo,
  parser: StreamingHeaders,
): void {
  if (info.stored === null) throw new CorruptError("loose header stream lost its encoding");
  let rows = 0;
  let stored: "raw" | "zlib" | null = null;
  let inflater: InflateStream | null = null;
  let iterator: Iterator<Record<string, unknown>> | null = null;
  let finished = false;
  try {
    const source = store.db.iterate(
      `SELECT /* maintenance-loose-headers */ object.repo_id, object.oid,
             CASE WHEN typeof(object.stored) = 'text'
                       AND length(CAST(object.stored AS BLOB)) <= 4 THEN object.stored END AS stored,
             CASE WHEN typeof(chunk.seq) = 'integer'
                       AND chunk.seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                  THEN chunk.seq END AS seq,
             CASE WHEN typeof(chunk.data) = 'blob' AND length(chunk.data) <= ?
                  THEN chunk.data END AS data
       FROM git_objects object
       JOIN git_object_chunks chunk
         ON chunk.repo_id = object.repo_id AND chunk.oid = object.oid
      WHERE object.repo_id = ? AND object.oid = ?
      ORDER BY chunk.seq LIMIT ?`,
      info.largestChunk,
      store.repoId,
      info.oid,
      info.chunkRows + 1,
    );
    iterator = source[Symbol.iterator]();
    for (;;) {
      const next = iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      const row = next.value;
      if (row.repo_id !== store.repoId || row.oid !== info.oid || row.seq !== rows) {
        throw new CorruptError("loose header stream returned inconsistent rows");
      }
      if (row.stored !== "raw" && row.stored !== "zlib") {
        throw new CorruptError("loose header stream has an invalid encoding");
      }
      if (row.stored !== info.stored || (stored !== null && row.stored !== stored)) {
        throw new CorruptError("loose header stream changed encoding between rows");
      }
      stored = row.stored;
      const data = bytesField(row.data, "loose header chunk");
      if (data.length > info.largestChunk) {
        throw new CorruptError("loose header chunk exceeds its admitted metadata");
      }
      if (stored === "raw") parser.push(data);
      else {
        if (inflater === null) {
          inflater = new InflateStream((chunk) => parser.push(chunk));
        }
        try {
          if (inflater.push(data) !== data.length) {
            throw new CorruptError("loose header inflater stopped before its final chunk");
          }
        } catch (error) {
          if (hasErrorCode(error, "ECORRUPT")) throw error;
          throw new CorruptError("loose header object has invalid compressed bytes", {
            cause: error,
          });
        }
      }
      rows++;
    }
  } finally {
    if (!finished) iterator?.return?.();
  }
  if (rows !== info.chunkRows || stored === null) {
    throw new CorruptError("loose header stream returned an incomplete chunk sequence");
  }
  if (stored === "zlib" && inflater?.ended !== true) {
    throw new CorruptError("loose header object ended before its compressed stream");
  }
}

interface PackedBaseChain {
  sourceType: ObjectType;
  baseOid: string | null;
}

interface PackedChainRow {
  oid: string;
  type: ObjectType;
  baseOid: string | null;
  looseType: ObjectType | null;
}

function nullableOidField(value: unknown, label: string): string | null {
  return value === null ? null : oidField(value, label);
}

function validatedPackedBaseChain(store: SharedRepoStore, oid: string): PackedBaseChain | null {
  const chain = new Map<string, PackedChainRow>();
  for (const row of store.db.iterate(
    `WITH RECURSIVE /* maintenance-pack-chain */ packed_chain(
       repo_id, oid, pack_id, type, size, base_oid, pack_repo_id, pack_state
     ) AS (
       SELECT object.repo_id, object.oid, object.pack_id, object.type,
              CASE WHEN typeof(object.size) = 'integer'
                        AND object.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN object.size END,
              object.base_oid, pack.repo_id, pack.state
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
        WHERE object.repo_id = ? AND object.oid = ? AND pack.state = 'complete'
       UNION
       SELECT next.repo_id, next.oid, next.pack_id, next.type,
              CASE WHEN typeof(next.size) = 'integer'
                        AND next.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                   THEN next.size END,
              next.base_oid, pack.repo_id, pack.state
         FROM packed_chain current
         JOIN git_pack_objects next
           ON next.repo_id = ? AND next.oid = current.base_oid
         JOIN git_pack_meta pack
           ON pack.repo_id = next.repo_id AND pack.pack_id = next.pack_id
          AND pack.state = 'complete'
     )
     SELECT CASE WHEN typeof(chain.repo_id) = 'integer'
                       AND chain.repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
                  THEN chain.repo_id END AS repo_id,
             CASE WHEN typeof(chain.oid) = 'text' AND length(CAST(chain.oid AS BLOB)) = 40
                  THEN chain.oid END AS oid,
             CASE WHEN typeof(chain.pack_id) = 'integer'
                       AND chain.pack_id BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                  THEN chain.pack_id END AS pack_id,
             CASE WHEN typeof(chain.type) = 'text' AND length(CAST(chain.type AS BLOB)) <= 6
                  THEN chain.type END AS type,
             CASE WHEN typeof(chain.size) = 'integer'
                       AND chain.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                  THEN chain.size END AS size,
             CASE WHEN chain.base_oid IS NULL THEN NULL
                  WHEN typeof(chain.base_oid) = 'text'
                       AND length(CAST(chain.base_oid AS BLOB)) = 40 THEN chain.base_oid END AS base_oid,
             chain.base_oid IS NOT NULL AS has_base_oid,
             CASE WHEN typeof(chain.pack_repo_id) = 'integer'
                       AND chain.pack_repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
                  THEN chain.pack_repo_id END AS pack_repo_id,
             CASE WHEN typeof(chain.pack_state) = 'text'
                       AND length(CAST(chain.pack_state AS BLOB)) <= 8 THEN chain.pack_state END AS pack_state,
             CASE WHEN loose.repo_id IS NULL THEN NULL
                  WHEN typeof(loose.repo_id) = 'integer'
                       AND loose.repo_id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}
                  THEN loose.repo_id END AS loose_repo_id,
             CASE WHEN loose.oid IS NULL THEN NULL
                  WHEN typeof(loose.oid) = 'text' AND length(CAST(loose.oid AS BLOB)) = 40
                  THEN loose.oid END AS loose_oid,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.type) = 'text'
                       AND length(CAST(loose.type AS BLOB)) <= 6 THEN loose.type END AS loose_type,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.size) = 'integer'
                       AND loose.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                  THEN loose.size END AS loose_size,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.stored) = 'text'
                       AND length(CAST(loose.stored AS BLOB)) <= 4 THEN loose.stored END AS loose_stored,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE (
               SELECT CASE WHEN count(*) <= ${Number.MAX_SAFE_INTEGER} THEN count(*) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = chain.base_oid
             ) END AS loose_chunk_rows,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE (
               SELECT CASE WHEN count(*) <= ${Number.MAX_SAFE_INTEGER} THEN count(*) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = chain.base_oid
                  AND (typeof(chunk.seq) != 'integer'
                       OR chunk.seq NOT BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                       OR typeof(chunk.data) != 'blob' OR length(chunk.data) > 1048576)
             ) END AS loose_invalid_chunk_rows,
             CASE WHEN loose.oid IS NULL THEN NULL ELSE (
               SELECT min(CASE WHEN typeof(seq) = 'integer'
                                     AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN seq END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = chain.base_oid
             ) END AS loose_first_chunk,
             CASE WHEN loose.oid IS NULL THEN NULL ELSE (
               SELECT max(CASE WHEN typeof(seq) = 'integer'
                                     AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN seq END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = chain.base_oid
             ) END AS loose_last_chunk,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE coalesce((
               SELECT max(CASE WHEN typeof(data) = 'blob' AND length(data) <= 1048576
                               THEN length(data) END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = chain.base_oid
             ), 0) END AS loose_largest_chunk,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE coalesce((
               SELECT CASE WHEN typeof(sum(length(data))) = 'integer'
                                  AND sum(length(data)) BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                           THEN sum(length(data)) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = chain.base_oid
             ), 0) END AS loose_stored_bytes
       FROM packed_chain chain
       LEFT JOIN git_objects loose
         ON loose.repo_id = ? AND loose.oid = chain.base_oid
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_objects next
          JOIN git_pack_meta pack
            ON pack.repo_id = next.repo_id AND pack.pack_id = next.pack_id
           AND pack.state = 'complete'
          WHERE next.repo_id = ? AND next.oid = chain.base_oid
        )
      LIMIT ${MAX_DELTA_DEPTH + 2}`,
    store.repoId,
    oid,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
  )) {
    if (chain.size >= MAX_DELTA_DEPTH + 1) {
      throw new CorruptError(`packed delta chain for ${oid} exceeds its depth bound`);
    }
    if (row.repo_id !== store.repoId || row.pack_repo_id !== store.repoId) {
      throw new CorruptError("packed delta chain crossed repository boundaries");
    }
    if (row.pack_state !== "complete") {
      throw new CorruptError("packed delta chain contains an incomplete pack");
    }
    const rowOid = oidField(row.oid, "packed delta chain OID");
    if (chain.has(rowOid)) throw new CorruptError("packed delta chain returned duplicate rows");
    safeInteger(row.pack_id, "packed delta chain pack id", 0);
    const type = objectType(row.type, "packed delta chain type");
    safeInteger(row.size, "packed delta chain size", 0);
    const baseOid = nullableOidField(row.base_oid, "packed delta chain base OID");
    if (booleanInteger(row.has_base_oid, "packed delta chain base marker") !== (baseOid !== null)) {
      throw new CorruptError("packed delta chain base OID projection is invalid");
    }
    let looseType: ObjectType | null = null;
    if (row.loose_oid !== null) {
      if (row.loose_repo_id !== store.repoId || row.loose_oid !== baseOid) {
        throw new CorruptError("packed delta terminal crossed object boundaries");
      }
      looseType = objectType(row.loose_type, "packed delta terminal type");
      const looseSize = safeInteger(row.loose_size, "packed delta terminal size", 0);
      const chunkRows = safeInteger(row.loose_chunk_rows, "packed delta terminal chunks", 1);
      const invalidChunkRows = safeInteger(
        row.loose_invalid_chunk_rows,
        "packed delta terminal invalid chunks",
        0,
      );
      const largestChunk = safeInteger(
        row.loose_largest_chunk,
        "packed delta terminal chunk size",
        0,
      );
      const storedBytes = safeInteger(
        row.loose_stored_bytes,
        "packed delta terminal stored size",
        0,
      );
      if (
        (row.loose_stored !== "raw" && row.loose_stored !== "zlib") ||
        invalidChunkRows !== 0 ||
        row.loose_first_chunk !== 0 ||
        row.loose_last_chunk !== chunkRows - 1 ||
        largestChunk > 1024 * 1024 ||
        (row.loose_stored === "raw" && storedBytes !== looseSize) ||
        (row.loose_stored === "zlib" && storedBytes === 0)
      ) {
        throw new CorruptError("packed delta terminal has invalid loose metadata");
      }
    } else if (
      row.loose_repo_id !== null ||
      row.loose_type !== null ||
      row.loose_size !== null ||
      row.loose_stored !== null ||
      row.loose_chunk_rows !== 0 ||
      row.loose_invalid_chunk_rows !== 0 ||
      row.loose_first_chunk !== null ||
      row.loose_last_chunk !== null ||
      row.loose_largest_chunk !== 0 ||
      row.loose_stored_bytes !== 0
    ) {
      throw new CorruptError("absent packed delta terminal returned loose metadata");
    }
    chain.set(rowOid, { oid: rowOid, type, baseOid, looseType });
  }
  const source = chain.get(oid);
  if (source === undefined) {
    if (chain.size !== 0) throw new CorruptError("packed delta chain omitted its source");
    return null;
  }
  const seen = new Set<string>();
  let current = source;
  let deltaDepth = 0;
  while (true) {
    if (seen.has(current.oid)) {
      throw new CorruptError(`packed delta chain for ${oid} contains a cycle`);
    }
    seen.add(current.oid);
    if (current.type !== source.type) {
      throw new CorruptError(`packed delta base ${current.oid} has the wrong type`);
    }
    if (current.baseOid === null) break;
    if (deltaDepth >= MAX_DELTA_DEPTH) {
      throw new CorruptError(`packed delta chain for ${oid} exceeds its depth bound`);
    }
    deltaDepth++;
    const next = chain.get(current.baseOid);
    if (next !== undefined) {
      current = next;
      continue;
    }
    if (current.looseType === null) {
      throw new CorruptError(`packed delta base ${current.baseOid} is missing`);
    }
    if (current.looseType !== source.type) {
      throw new CorruptError(`packed delta base ${current.baseOid} has the wrong type`);
    }
    break;
  }
  return { sourceType: source.type, baseOid: source.baseOid };
}

function packedBaseEdge(
  store: SharedRepoStore,
  oid: string,
  expectedType: ObjectType,
): ReachabilityEdge | null {
  const packed = validatedPackedBaseChain(store, oid);
  if (packed === null) return null;
  if (packed.sourceType !== expectedType) {
    throw new CorruptError(`packed copy of ${oid} disagrees with its authoritative type`);
  }
  if (packed.baseOid === null) return null;
  return {
    oid: packed.baseOid,
    type: expectedType,
    optionalMissing: false,
    physicalOnly: true,
  };
}

function headerExpansion(
  store: SharedRepoStore,
  object: QueueObject,
  info: ReachabilityObjectInfo,
): ObjectExpansion {
  if (info.type === "blob") {
    if (object.edgeCursor !== 0) throw new CorruptError("blob retained a semantic edge cursor");
    const base = packedBaseEdge(store, object.oid, info.type);
    return { edges: base === null ? [] : [base], nextCursor: 0, complete: true };
  }
  if (info.type === "tag") {
    if (object.edgeCursor !== 0) throw new CorruptError("tag retained a semantic edge cursor");
    const parsed = scanHeaders(store, info, "tag", 0, 0);
    if (parsed.tagOid === null) throw new CorruptError("tag is missing its object header");
    if (parsed.tagType === null) throw new CorruptError("tag is missing its type header");
    const edges: ReachabilityEdge[] = [
      {
        oid: parsed.tagOid,
        type: parsed.tagType,
        optionalMissing: false,
        physicalOnly: false,
      },
    ];
    const base = packedBaseEdge(store, object.oid, info.type);
    if (base !== null) edges.push(base);
    return { edges, nextCursor: 0, complete: true };
  }
  if (info.type !== "commit") {
    throw new CorruptError(`header expansion received unexpected ${info.type} object`);
  }
  if (object.shallowBoundary && object.edgeCursor > 1) {
    throw new CorruptError("shallow commit retained a parent cursor");
  }
  const parentStart = Math.max(0, object.edgeCursor - 1);
  const semanticCapacity = EDGE_PAGE - (object.edgeCursor === 0 ? 1 : 0);
  const parsed = scanHeaders(store, info, "commit", parentStart, semanticCapacity + 1);
  if (parsed.treeOid === null) throw new CorruptError("commit is missing its tree header");
  const semanticCount = 1 + (object.shallowBoundary ? 0 : parsed.parentCount);
  if (object.edgeCursor > semanticCount) {
    throw new CorruptError("commit edge cursor exceeds its header edges");
  }
  const edges: ReachabilityEdge[] = [];
  if (object.edgeCursor === 0) {
    edges.push({
      oid: parsed.treeOid,
      type: "tree",
      optionalMissing: false,
      physicalOnly: false,
    });
  }
  if (!object.shallowBoundary) {
    for (const parent of parsed.parentOids) {
      if (edges.length >= EDGE_PAGE) break;
      edges.push({
        oid: parent,
        type: "commit",
        optionalMissing: false,
        physicalOnly: false,
      });
    }
  }
  const nextCursor = Math.min(semanticCount, object.edgeCursor + edges.length);
  const semanticComplete = nextCursor === semanticCount;
  let complete = semanticComplete;
  if (semanticComplete) {
    const base = packedBaseEdge(store, object.oid, info.type);
    if (base !== null) {
      if (edges.length < EDGE_PAGE) edges.push(base);
      else complete = false;
    }
  }
  return { edges, nextCursor, complete };
}

function bytesField(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new CorruptError(`${label} is not a BLOB`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateTreeEntryMetadata(
  row: Record<string, unknown>,
  sourceKey: number,
  ordinal: number,
  previousBase: number,
): TreeEdgeMetadata {
  if (row.source_key !== sourceKey) throw new CorruptError("tree edge crossed source boundaries");
  if (row.ordinal !== ordinal) throw new CorruptError("tree edge ordinals are not contiguous");
  const mode = row.mode;
  if (
    mode !== "40000" &&
    mode !== "040000" &&
    mode !== "100644" &&
    mode !== "100755" &&
    mode !== "120000" &&
    mode !== "160000"
  ) {
    throw new CorruptError("tree edge mode is invalid");
  }
  if (row.name_type !== "blob") {
    throw new CorruptError("tree edge name is invalid");
  }
  const nameLength = safeInteger(row.name_length, "tree edge name length", 1);
  const oid = oidField(row.oid, "tree edge OID");
  if (row.raw_type !== "blob") {
    throw new CorruptError("tree raw edge is invalid");
  }
  const rawLength = safeInteger(row.raw_length, "tree raw edge length", 0);
  const cumulativeBase = safeInteger(row.cumulative_base, "tree cumulative edge cost", 0);
  const expectedBase =
    previousBase + TREE_QUEUE_ROW_FIXED_BYTES + nameLength + mode.length + oid.length;
  if (!Number.isSafeInteger(expectedBase) || cumulativeBase !== expectedBase) {
    throw new CorruptError("tree cumulative edge cost is inconsistent");
  }
  return { sourceKey, ordinal, mode, nameLength, oid, rawLength, cumulativeBase };
}

function validateTreeEntryPayload(
  row: Record<string, unknown>,
  metadata: TreeEdgeMetadata,
): ReachabilityEdge {
  if (row.source_key !== metadata.sourceKey || row.ordinal !== metadata.ordinal) {
    throw new CorruptError("tree edge payload changed its metadata order");
  }
  const name = bytesField(row.name_bytes, "tree edge name");
  if (name.length !== metadata.nameLength || name.includes(0) || name.includes(0x2f)) {
    throw new CorruptError("tree edge name is invalid");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(name);
  } catch (error) {
    throw new CorruptError("tree edge name is not valid UTF-8", { cause: error });
  }
  const raw = bytesField(row.raw_entry, "tree raw edge");
  if (raw.length !== metadata.rawLength) {
    throw new CorruptError("tree raw edge length changed after its metadata read");
  }
  const modeBytes = new TextEncoder().encode(metadata.mode);
  const expectedLength = modeBytes.length + name.length + 22;
  const nameAt = modeBytes.length + 1;
  const oidAt = nameAt + name.length + 1;
  if (
    raw.length !== expectedLength ||
    !equalBytes(raw.subarray(0, modeBytes.length), modeBytes) ||
    raw[modeBytes.length] !== 0x20 ||
    !equalBytes(raw.subarray(nameAt, oidAt - 1), name) ||
    raw[oidAt - 1] !== 0 ||
    toHex(raw.subarray(oidAt)) !== metadata.oid
  ) {
    throw new CorruptError("tree raw edge disagrees with its indexed fields");
  }
  return {
    oid: metadata.oid,
    type:
      metadata.mode === "40000" || metadata.mode === "040000"
        ? "tree"
        : metadata.mode === "160000"
          ? "commit"
          : "blob",
    optionalMissing: metadata.mode === "160000",
    physicalOnly: false,
  };
}

function treeExpansion(
  db: SqlDatabase,
  store: SharedRepoStore,
  object: QueueObject,
  info: ObjectReadInfo,
): ObjectExpansion {
  let source: Record<string, unknown> | null = null;
  let sourceRows = 0;
  for (const row of db.iterate(
    `SELECT effective.repo_id, effective.tree_oid, effective.source_key AS effective_source_key,
            source.source_key, source.storage, source.source_id, source.complete,
            source.object_size, source.entry_count, source.base_cost
       FROM git_tree_effective effective
       JOIN git_tree_sources source ON source.source_key = effective.source_key
      WHERE effective.repo_id = ? AND effective.tree_oid = ? LIMIT 2`,
    store.repoId,
    object.oid,
  )) {
    sourceRows++;
    if (sourceRows > 1) throw new CorruptError("effective tree source is not unique");
    source = row;
  }
  if (source === null) throw new CorruptError(`tree ${object.oid} has no effective parsed source`);
  if (source.repo_id !== store.repoId || source.tree_oid !== object.oid) {
    throw new CorruptError("effective tree source crossed object boundaries");
  }
  const sourceKey = safeInteger(source.source_key, "tree source key", 1);
  if (source.effective_source_key !== sourceKey) {
    throw new CorruptError("effective tree marker disagrees with its source");
  }
  const storage = source.storage;
  if (storage !== "loose" && storage !== "pack") {
    throw new CorruptError("tree source storage is invalid");
  }
  if (storage !== info.source) throw new CorruptError("tree source is not authoritative");
  const sourceId = safeInteger(source.source_id, "tree source id", 0);
  if (storage === "loose" && sourceId !== 0) {
    throw new CorruptError("loose tree source has a pack id");
  }
  if (storage === "pack") {
    const packed = store.packs.completePackedEntry(object.oid);
    if (packed === null || packed.packId !== sourceId || packed.type !== "tree") {
      throw new CorruptError("packed tree source is not complete and source-qualified");
    }
  }
  if (!booleanInteger(source.complete, "tree source completion marker")) {
    throw new CorruptError("tree source is incomplete");
  }
  const objectSize = safeInteger(source.object_size, "tree source object size", 0);
  if (objectSize !== info.size) throw new CorruptError("tree source size is stale");
  const entryCount = safeInteger(source.entry_count, "tree source entry count", 0);
  const baseCost = safeInteger(source.base_cost, "tree source base cost", 0);
  if (object.edgeCursor > entryCount) throw new CorruptError("tree edge cursor exceeds its marker");

  let previousBase = 0;
  if (object.edgeCursor > 0) {
    const previous = db.one<Record<string, unknown>>(
      `SELECT source_key, ordinal, cumulative_base FROM git_tree_entries
        WHERE source_key = ? AND ordinal = ?`,
      sourceKey,
      object.edgeCursor - 1,
    );
    if (
      previous === undefined ||
      previous.source_key !== sourceKey ||
      previous.ordinal !== object.edgeCursor - 1
    ) {
      throw new CorruptError("tree edge cursor lost its preceding row");
    }
    previousBase = safeInteger(previous.cumulative_base, "preceding tree cumulative cost", 0);
  }

  const metadata: TreeEdgeMetadata[] = [];
  for (const row of db.iterate(
    `SELECT /* maintenance-tree-edge-metadata */ source_key, ordinal,
            CASE WHEN typeof(mode) = 'text' AND length(CAST(mode AS BLOB)) <= 6
                 THEN mode ELSE NULL END AS mode,
            typeof(name_bytes) AS name_type, length(name_bytes) AS name_length,
            CASE WHEN typeof(oid) = 'text' AND length(oid) <= 40
                 THEN oid ELSE NULL END AS oid,
            typeof(raw_entry) AS raw_type, length(raw_entry) AS raw_length,
            cumulative_base
       FROM git_tree_entries WHERE source_key = ? AND ordinal >= ?
      ORDER BY ordinal LIMIT ${EDGE_PAGE + 1}`,
    sourceKey,
    object.edgeCursor,
  )) {
    const checked = validateTreeEntryMetadata(
      row,
      sourceKey,
      object.edgeCursor + metadata.length,
      previousBase,
    );
    previousBase = checked.cumulativeBase;
    metadata.push(checked);
    if (object.edgeCursor + metadata.length > entryCount) {
      throw new CorruptError("tree source has rows beyond its completion marker");
    }
  }
  const remaining = entryCount - object.edgeCursor;
  if (metadata.length !== Math.min(remaining, EDGE_PAGE + 1)) {
    throw new CorruptError("tree source rows are incomplete");
  }
  const nextCursor = object.edgeCursor + Math.min(remaining, EDGE_PAGE);
  const semanticComplete = nextCursor === entryCount;
  if (semanticComplete && previousBase !== baseCost) {
    throw new CorruptError("tree source completion cost is inconsistent");
  }
  const expectedPayloads = JSON.stringify(
    metadata.map((entry) => ({ q: entry.ordinal, n: entry.nameLength, r: entry.rawLength })),
  );
  const edges: ReachabilityEdge[] = [];
  let payloadOrdinal = 0;
  for (const row of db.iterate(
    `WITH expected AS (
       SELECT CAST(json_extract(value, '$.q') AS INTEGER) AS ordinal,
              CAST(json_extract(value, '$.n') AS INTEGER) AS name_length,
              CAST(json_extract(value, '$.r') AS INTEGER) AS raw_length
         FROM json_each(?)
     )
     SELECT /* maintenance-tree-edge-payloads */ entry.source_key, entry.ordinal,
            CASE WHEN typeof(entry.name_bytes) = 'blob'
                       AND length(entry.name_bytes) = expected.name_length
                 THEN entry.name_bytes ELSE NULL END AS name_bytes,
            CASE WHEN typeof(entry.raw_entry) = 'blob'
                       AND length(entry.raw_entry) = expected.raw_length
                 THEN entry.raw_entry ELSE NULL END AS raw_entry
       FROM expected
       JOIN git_tree_entries entry
         ON entry.source_key = ? AND entry.ordinal = expected.ordinal
      ORDER BY entry.ordinal`,
    expectedPayloads,
    sourceKey,
  )) {
    const expected = metadata[payloadOrdinal];
    if (expected === undefined) {
      throw new CorruptError("tree edge payloads exceed their metadata page");
    }
    const edge = validateTreeEntryPayload(row, expected);
    if (edges.length < EDGE_PAGE) edges.push(edge);
    payloadOrdinal++;
  }
  if (payloadOrdinal !== metadata.length) {
    throw new CorruptError("tree edge payload page is incomplete");
  }
  let complete = semanticComplete;
  if (semanticComplete) {
    const base = packedBaseEdge(store, object.oid, info.type);
    if (base !== null) {
      if (edges.length < EDGE_PAGE) edges.push(base);
      else complete = false;
    }
  }
  return { edges, nextCursor, complete };
}

function physicalExpansion(store: SharedRepoStore, object: QueueObject): ObjectExpansion {
  const packed = validatedPackedBaseChain(store, object.oid);
  if (packed === null) {
    requireObjectInfo(store, object.oid);
    return { edges: [], nextCursor: 0, complete: true };
  }
  if (packed.baseOid === null) return { edges: [], nextCursor: 0, complete: true };
  return {
    edges: [
      {
        oid: packed.baseOid,
        type: packed.sourceType,
        optionalMissing: false,
        physicalOnly: true,
      },
    ],
    nextCursor: 0,
    complete: true,
  };
}

function normalizeAndValidateEdges(
  store: SharedRepoStore,
  edges: readonly ReachabilityEdge[],
): NormalizedEdge[] {
  if (edges.length > EDGE_PAGE)
    throw new CorruptError("reachability slice exceeded its edge bound");
  const unique = new Map<string, NormalizedEdge>();
  for (const edge of edges) {
    if (!isOid(edge.oid)) throw new CorruptError("reachable edge has an invalid OID");
    const previous = unique.get(edge.oid);
    if (previous !== undefined && previous.type !== edge.type) {
      throw new CorruptError(`reachable object ${edge.oid} has conflicting required types`);
    }
    unique.set(edge.oid, {
      oid: edge.oid,
      type: edge.type,
      optionalMissing: (previous?.optionalMissing ?? true) && edge.optionalMissing,
      physicalOnly: (previous?.physicalOnly ?? true) && edge.physicalOnly,
      present: true,
    });
  }
  const normalized = [...unique.values()];
  const optional = normalized.filter((edge) => edge.optionalMissing).map((edge) => edge.oid);
  if (optional.length > 0) {
    const present = store.hasAll(optional);
    for (const oid of present) {
      if (!optional.includes(oid)) {
        throw new CorruptError("optional object probe returned an unknown OID");
      }
    }
    for (const edge of normalized) {
      if (edge.optionalMissing) edge.present = present.has(edge.oid);
    }
  }
  const wanted = normalized.filter((edge) => edge.present && !edge.physicalOnly);
  if (wanted.length === 0) return normalized;
  validateEdgeTargets(store, wanted);
  return normalized;
}

function validateEdgeTargets(store: SharedRepoStore, wanted: readonly NormalizedEdge[]): void {
  let ordinal = 0;
  for (const row of store.db.iterate(
    `SELECT /* maintenance-edge-targets */ CAST(input.key AS INTEGER) AS ordinal, input.value AS oid,
             CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                  WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.type) = 'text'
                       AND length(CAST(loose.type AS BLOB)) <= 6 THEN loose.type
                  WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                       AND typeof(packed.type) = 'text'
                       AND length(CAST(packed.type AS BLOB)) <= 6 THEN packed.type END AS type,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.size) = 'integer'
                       AND loose.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN loose.size
                  WHEN loose.oid IS NULL AND pack.pack_id IS NOT NULL
                       AND typeof(packed.size) = 'integer'
                       AND packed.size BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                       THEN packed.size END AS size,
             CASE WHEN loose.oid IS NOT NULL AND typeof(loose.stored) = 'text'
                       AND length(CAST(loose.stored AS BLOB)) <= 4 THEN loose.stored END AS stored,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE (
               SELECT CASE WHEN count(*) <= ${Number.MAX_SAFE_INTEGER} THEN count(*) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.value
             ) END AS chunk_rows,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE (
               SELECT CASE WHEN count(*) <= ${Number.MAX_SAFE_INTEGER} THEN count(*) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.value
                  AND (typeof(chunk.seq) != 'integer'
                       OR chunk.seq NOT BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                       OR typeof(chunk.data) != 'blob' OR length(chunk.data) > 1048576)
             ) END AS invalid_chunk_rows,
             CASE WHEN loose.oid IS NULL THEN NULL ELSE (
               SELECT min(CASE WHEN typeof(seq) = 'integer'
                                     AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN seq END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.value
             ) END AS first_chunk,
             CASE WHEN loose.oid IS NULL THEN NULL ELSE (
               SELECT max(CASE WHEN typeof(seq) = 'integer'
                                     AND seq BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} THEN seq END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.value
             ) END AS last_chunk,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE coalesce((
               SELECT max(CASE WHEN typeof(data) = 'blob' AND length(data) <= 1048576
                               THEN length(data) END)
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.value
             ), 0) END AS largest_chunk,
             CASE WHEN loose.oid IS NULL THEN 0 ELSE coalesce((
               SELECT CASE WHEN typeof(sum(length(data))) = 'integer'
                                  AND sum(length(data)) BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
                           THEN sum(length(data)) END
                 FROM git_object_chunks chunk
                WHERE chunk.repo_id = ? AND chunk.oid = input.value
             ), 0) END AS stored_bytes
       FROM json_each(?) input
       LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = input.value
       LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = input.value
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
        AND pack.state = 'complete'
      ORDER BY CAST(input.key AS INTEGER)`,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    store.repoId,
    JSON.stringify(wanted.map((edge) => edge.oid)),
    store.repoId,
    store.repoId,
  )) {
    const edge = wanted[ordinal];
    if (row.ordinal !== ordinal || edge === undefined || row.oid !== edge.oid) {
      throw new CorruptError("reachable edge validation changed its order");
    }
    if (row.source !== "loose" && row.source !== "pack") {
      if (row.source === null) {
        throw new CorruptError(`reachable edge references a missing object ${edge.oid}`);
      }
      throw new CorruptError("reachable edge validation returned an invalid source");
    }
    const type = objectType(row.type, "reachable edge type");
    const size = safeInteger(row.size, "reachable edge size", 0);
    const chunkRows = safeInteger(row.chunk_rows, "reachable edge chunk count", 0);
    const invalidChunkRows = safeInteger(
      row.invalid_chunk_rows,
      "reachable edge invalid chunk count",
      0,
    );
    const largestChunk = safeInteger(row.largest_chunk, "reachable edge chunk size", 0);
    const storedBytes = safeInteger(row.stored_bytes, "reachable edge stored size", 0);
    if (type !== edge.type) {
      throw new CorruptError(`reachable object ${edge.oid} is ${type}, expected ${edge.type}`);
    }
    if (
      (row.source === "loose" && row.stored !== "raw" && row.stored !== "zlib") ||
      (row.source === "loose" && chunkRows <= 0) ||
      (row.source === "loose" && invalidChunkRows !== 0) ||
      (row.source === "loose" && row.first_chunk !== 0) ||
      (row.source === "loose" && row.last_chunk !== chunkRows - 1) ||
      (row.source === "loose" && largestChunk > 1024 * 1024) ||
      (row.source === "loose" && row.stored === "raw" && storedBytes !== size) ||
      (row.source === "loose" && row.stored === "zlib" && storedBytes === 0) ||
      (row.source === "pack" &&
        (row.stored !== null ||
          chunkRows !== 0 ||
          row.first_chunk !== null ||
          row.last_chunk !== null ||
          largestChunk !== 0 ||
          storedBytes !== 0))
    ) {
      throw new CorruptError("reachable edge validation returned invalid object metadata");
    }
    ordinal++;
  }
  if (ordinal !== wanted.length) {
    throw new CorruptError("reachable edge validation returned an incomplete page");
  }
}

function existingMarks(
  db: SqlDatabase,
  repoId: number,
  runId: number,
  edges: readonly NormalizedEdge[],
): Map<string, ExistingMark> {
  const present = edges.filter((edge) => edge.present);
  if (present.length === 0) return new Map();
  const result = new Map<string, ExistingMark>();
  let ordinal = 0;
  for (const row of db.iterate(
    `SELECT CAST(input.key AS INTEGER) AS ordinal, input.value AS oid,
            object.oid AS stored_oid, object.physical_only, object.expanded, object.edge_cursor
       FROM json_each(?) input
       LEFT JOIN git_maintenance_objects object
         ON object.repo_id = ? AND object.run_id = ? AND object.oid = input.value
      ORDER BY CAST(input.key AS INTEGER)`,
    JSON.stringify(present.map((edge) => edge.oid)),
    repoId,
    runId,
  )) {
    const expected = present[ordinal];
    if (row.ordinal !== ordinal || expected === undefined || row.oid !== expected.oid) {
      throw new CorruptError("maintenance mark probe changed edge order");
    }
    if (row.stored_oid === null) {
      if (row.physical_only !== null || row.expanded !== null || row.edge_cursor !== null) {
        throw new CorruptError("absent maintenance mark returned stored state");
      }
      result.set(expected.oid, {
        exists: false,
        physicalOnly: false,
        expanded: false,
        edgeCursor: 0,
      });
    } else {
      if (row.stored_oid !== expected.oid) {
        throw new CorruptError("maintenance mark probe returned another OID");
      }
      result.set(expected.oid, {
        exists: true,
        physicalOnly: booleanInteger(row.physical_only, "existing physical marker"),
        expanded: booleanInteger(row.expanded, "existing expanded marker"),
        edgeCursor: safeInteger(row.edge_cursor, "existing edge cursor", 0),
      });
      const stored = result.get(expected.oid);
      if (stored?.physicalOnly === true && stored.edgeCursor !== 0) {
        throw new CorruptError("existing physical mark retained a semantic cursor");
      }
    }
    ordinal++;
  }
  if (ordinal !== present.length || result.size !== present.length) {
    throw new CorruptError("maintenance mark probe returned an incomplete page");
  }
  return result;
}

function publishExpansion(
  db: SqlDatabase,
  store: SharedRepoStore,
  run: RunState,
  object: QueueObject,
  expansion: ObjectExpansion,
): PublicationResult {
  return publishExpansionOwned(db, store, run, object, expansion);
}

function publishExpansionOwned(
  db: SqlDatabase,
  store: SharedRepoStore,
  run: RunState,
  object: QueueObject,
  expansion: ObjectExpansion,
): PublicationResult {
  const edges = normalizeAndValidateEdges(store, expansion.edges);
  const marks = existingMarks(db, store.repoId, run.runId, edges);
  let discoveredObjects = 0;
  let discoveredLogicalObjects = 0;
  let requeuedObjects = 0;
  const rows: { o: string; p: number }[] = [];
  for (const edge of edges) {
    if (!edge.present) continue;
    const mark = marks.get(edge.oid);
    if (mark === undefined) throw new CorruptError("maintenance edge lost its mark probe");
    if (!mark.exists) {
      discoveredObjects++;
      if (!edge.physicalOnly) discoveredLogicalObjects++;
    } else if (mark.physicalOnly && !edge.physicalOnly) {
      discoveredLogicalObjects++;
      if (mark.expanded) requeuedObjects++;
    }
    rows.push({ o: edge.oid, p: edge.physicalOnly ? 1 : 0 });
  }
  if (
    run.queuedObjects > Number.MAX_SAFE_INTEGER - discoveredObjects - requeuedObjects ||
    run.reachableObjects > Number.MAX_SAFE_INTEGER - discoveredLogicalObjects
  ) {
    throw new GitError("E2BIG", "maintenance reachability counters are exhausted");
  }
  if (rows.length > 0) {
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
       SELECT ?, ?, json_extract(input.value, '$.o'), 0, 0,
              EXISTS (
                SELECT 1 FROM git_maintenance_shallow shallow
                 WHERE shallow.repo_id = ? AND shallow.run_id = ?
                   AND shallow.oid = json_extract(input.value, '$.o')
              ), json_extract(input.value, '$.p'), 0
         FROM json_each(?) input
        WHERE true
       ON CONFLICT(repo_id, run_id, oid) DO UPDATE SET
         physical_only = min(physical_only, excluded.physical_only),
         expanded = CASE WHEN physical_only = 1 AND excluded.physical_only = 0
                         THEN 0 ELSE expanded END,
         edge_cursor = CASE WHEN physical_only = 1 AND excluded.physical_only = 0
                            THEN 0 ELSE edge_cursor END`,
      store.repoId,
      run.runId,
      store.repoId,
      run.runId,
      JSON.stringify(rows),
    );
  }
  const updatedObject = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_objects
        SET expanded = ?, edge_cursor = ?
      WHERE repo_id = ? AND run_id = ? AND oid = ? AND expanded = 0
        AND physical_only = ? AND edge_cursor = ?
      RETURNING oid, expanded, physical_only, edge_cursor`,
    expansion.complete ? 1 : 0,
    expansion.nextCursor,
    store.repoId,
    run.runId,
    object.oid,
    object.physicalOnly ? 1 : 0,
    object.edgeCursor,
  );
  if (
    updatedObject === undefined ||
    updatedObject.oid !== object.oid ||
    updatedObject.expanded !== (expansion.complete ? 1 : 0) ||
    updatedObject.physical_only !== (object.physicalOnly ? 1 : 0) ||
    updatedObject.edge_cursor !== expansion.nextCursor
  ) {
    throw new CorruptError("maintenance object progress was not published atomically");
  }
  const queueDelta = discoveredObjects + requeuedObjects - (expansion.complete ? 1 : 0);
  if (run.queuedObjects + queueDelta < 0) {
    throw new CorruptError("maintenance queued count would become negative");
  }
  const nextQueued = run.queuedObjects + queueDelta;
  const nextReachable = run.reachableObjects + discoveredLogicalObjects;
  const updatedRun = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET queued_objects = queued_objects + ?,
            reachable_objects = reachable_objects + ?
      WHERE repo_id = ? AND run_id = ? AND phase = 'mark'
        AND queued_objects = ? AND reachable_objects = ?
      RETURNING repo_id, run_id, queued_objects, reachable_objects`,
    queueDelta,
    discoveredLogicalObjects,
    store.repoId,
    run.runId,
    run.queuedObjects,
    run.reachableObjects,
  );
  if (
    updatedRun === undefined ||
    updatedRun.repo_id !== store.repoId ||
    updatedRun.run_id !== run.runId ||
    updatedRun.queued_objects !== nextQueued ||
    updatedRun.reachable_objects !== nextReachable
  ) {
    throw new CorruptError("maintenance counters were not published atomically");
  }
  return { discoveredObjects, discoveredLogicalObjects };
}

function auditCompletedMark(db: SqlDatabase, repoId: number, run: RunState): void {
  if (run.queuedObjects !== 0) {
    throw new CorruptError("maintenance mark queue is empty but its counter is not zero");
  }
  const counts = db.one<Record<string, unknown>>(
    `SELECT coalesce(sum(CASE WHEN expanded = 0 THEN 1 ELSE 0 END), 0) AS queued,
            coalesce(sum(CASE WHEN physical_only = 0 THEN 1 ELSE 0 END), 0) AS logical
       FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?`,
    repoId,
    run.runId,
  );
  if (counts === undefined) throw new CorruptError("maintenance completion count returned no row");
  const queued = safeInteger(counts.queued, "completed maintenance queued count", 0);
  const logical = safeInteger(counts.logical, "completed maintenance logical count", 0);
  if (queued !== 0 || logical !== run.reachableObjects) {
    throw new CorruptError("completed maintenance counters disagree with their mark rows");
  }
}

function finishMark(db: SqlDatabase, repoId: number, run: RunState): void {
  auditCompletedMark(db, repoId, run);
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs SET phase = 'classify-loose'
      WHERE repo_id = ? AND run_id = ? AND phase = 'mark' AND observed_root_epoch = ?
        AND NOT EXISTS (
          SELECT 1 FROM git_maintenance_objects object
           WHERE object.repo_id = ? AND object.run_id = ? AND object.expanded = 0
        )
      RETURNING repo_id, run_id, phase, reachable_objects, queued_objects`,
    repoId,
    run.runId,
    run.observedRootEpoch,
    repoId,
    run.runId,
  );
  if (
    row === undefined ||
    row.repo_id !== repoId ||
    row.run_id !== run.runId ||
    row.phase !== "classify-loose" ||
    row.reachable_objects !== run.reachableObjects ||
    row.queued_objects !== run.queuedObjects
  ) {
    throw new CorruptError("maintenance mark completion was not published atomically");
  }
}

/** Advance one durable reachability edge page or the stable mark completion transition. */
export function advanceMaintenanceReachability(
  store: SharedRepoStore,
): MaintenanceReachabilityProgress {
  if (!Number.isSafeInteger(store.repoId) || store.repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
  return store.db.transactionSync(() => {
    let run = readRun(store.db, store.repoId);
    if (run.observedRootEpoch !== run.rootEpoch) {
      return {
        runId: run.runId,
        status: "root-changed",
        processedOid: null,
        discoveredObjects: 0,
        discoveredLogicalObjects: 0,
      };
    }
    if (run.phase === "classify-loose") {
      auditCompletedMark(store.db, store.repoId, run);
      return {
        runId: run.runId,
        status: "complete",
        processedOid: null,
        discoveredObjects: 0,
        discoveredLogicalObjects: 0,
      };
    }
    if (run.phase !== "mark") {
      throw new GitError("EINVAL", `maintenance reachability cannot advance phase ${run.phase}`);
    }
    run = initializeAndValidateCounters(store.db, store.repoId, run);
    const object = readNextObject(store.db, store.repoId, run.runId);
    if (object === null) {
      finishMark(store.db, store.repoId, run);
      return {
        runId: run.runId,
        status: "complete",
        processedOid: null,
        discoveredObjects: 0,
        discoveredLogicalObjects: 0,
      };
    }
    if (run.queuedObjects === 0) {
      throw new CorruptError("maintenance queued count omitted an unexpanded mark");
    }
    let expansion: ObjectExpansion;
    if (object.physicalOnly) {
      expansion = physicalExpansion(store, object);
    } else {
      const info = requireObjectInfo(store, object.oid);
      if (object.shallowBoundary && info.type !== "commit") {
        throw new CorruptError("maintenance shallow boundary is not a commit");
      }
      expansion =
        info.type === "tree"
          ? treeExpansion(store.db, store, object, info)
          : headerExpansion(store, object, info);
    }
    const published = publishExpansion(store.db, store, run, object, expansion);
    return {
      runId: run.runId,
      status: "progress",
      processedOid: object.oid,
      discoveredObjects: published.discoveredObjects,
      discoveredLogicalObjects: published.discoveredLogicalObjects,
    };
  });
}
