import { isOid } from "../../../common/bytes.js";
import { CorruptError, hasErrorCode } from "../../../common/errors.js";
import { MAX_OBJECT_BYTES, type ObjectType } from "../../../common/objects.js";
import { InflateStream } from "../../../common/zlib.js";
import type { SharedRepoStore } from "../../index.js";
import { maximumDeflatedBytes, STREAM_CHUNK } from "../../objects/objects.js";
import { bytesField, objectType, safeInteger } from "./reachability-codecs.js";
import type { HeaderScanResult, ReachabilityObjectInfo } from "./reachability-contracts.js";

const HEADER_LINE_PREFIX_BYTES = 128;
// Streamed writes use the smallest loose payload rows, so they set the legitimate row ceiling.
const MAX_LOOSE_PAYLOAD_ROWS = Math.ceil(maximumDeflatedBytes(MAX_OBJECT_BYTES) / STREAM_CHUNK);

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

export function requireObjectInfo(store: SharedRepoStore, oid: string): ReachabilityObjectInfo {
  const row = store.db.one<Record<string, unknown>>(
    `SELECT /* maintenance-object-info */ input.oid,
            CASE WHEN loose.oid IS NOT NULL THEN 'loose'
                 WHEN pack.pack_id IS NOT NULL THEN 'pack' ELSE NULL END AS source,
            CASE WHEN loose.oid IS NOT NULL THEN loose.type ELSE packed.type END AS type,
            CASE WHEN loose.oid IS NOT NULL THEN loose.size ELSE packed.size END AS size,
            loose.stored
       FROM (SELECT ? AS oid) input
       LEFT JOIN git_objects loose ON loose.repo_id = ? AND loose.oid = input.oid
       LEFT JOIN git_pack_objects packed ON packed.repo_id = ? AND packed.oid = input.oid
       LEFT JOIN git_pack_meta pack
         ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
        AND pack.state = 'complete'`,
    oid,
    store.repoId,
    store.repoId,
  );
  if (row === undefined || row.oid !== oid) {
    throw new CorruptError("reachable object metadata returned an incomplete result");
  }
  if (row.source !== "loose" && row.source !== "pack") {
    throw new CorruptError(`reachable object ${oid} is missing`);
  }
  let stored: "raw" | "zlib" | null = null;
  if (row.source === "loose") {
    if (row.stored !== "raw" && row.stored !== "zlib") {
      throw new CorruptError("reachable loose object encoding is invalid");
    }
    stored = row.stored;
  }
  return {
    oid,
    type: objectType(row.type, "reachable object type"),
    size: safeInteger(row.size, "reachable object size", 0),
    source: row.source,
    stored,
  };
}
export function scanHeaders(
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
             object.stored, chunk.seq, chunk.data
       FROM git_objects object
       JOIN git_object_chunks chunk
         ON chunk.repo_id = object.repo_id AND chunk.oid = object.oid
      WHERE object.repo_id = ? AND object.oid = ?
      ORDER BY chunk.seq LIMIT ?`,
      store.repoId,
      info.oid,
      MAX_LOOSE_PAYLOAD_ROWS + 1,
    );
    iterator = source[Symbol.iterator]();
    for (;;) {
      const next = iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      const row = next.value;
      if (rows >= MAX_LOOSE_PAYLOAD_ROWS) {
        throw new CorruptError("loose header stream exceeded its payload-row bound");
      }
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
  if (rows === 0 || stored === null) {
    throw new CorruptError("loose header stream returned an incomplete chunk sequence");
  }
  if (stored === "zlib" && inflater?.ended !== true) {
    throw new CorruptError("loose header object ended before its compressed stream");
  }
}
