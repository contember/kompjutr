import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { isCanonicalGitPath } from "../../common/paths.js";
import {
  int,
  nullable,
  OptionsSchema,
  oneOf,
  optional,
  RowShape,
  text,
} from "../../common/rows.js";
import { comparePaths } from "../../common/streams.js";
import type { IndexEntry, IndexScanOptions, IndexStore } from "../core/contracts.js";
import { JSON_ENCODER } from "../core/json-pages.js";
import { nextPrefix } from "../refs/config.js";
import { MAX_INDEX_PATH_BYTES } from "../schema/schema.js";

/** Index rows per round trip. This is the memory bound of a scan. */
export const DEFAULT_INDEX_PAGE = 1000;
export const MAX_INDEX_SCAN_PAGE = 2048;

/** Index mutations buffered before a batch is applied. */
export const DEFAULT_INDEX_FLUSH = 512;

/** Non-refusing JSON page target with framing headroom below 2 MiB. */
export const INDEX_MUTATION_JSON_FLUSH_BYTES = 1_500_000;

const INDEX_ENTRY_FIELDS = {
  path: text(),
  stage: int(0, 3),
  mode: oneOf([0o100644, 0o100755, 0o120000, 0o160000]),
  oid: text(),
  size: nullable(int(0)),
  mtime: nullable(int(0)),
  ino: nullable(int(0)),
};

const INDEX_ENTRY_ROW = new RowShape({ ...INDEX_ENTRY_FIELDS, rev: nullable(int(0)) });
const INDEX_ENTRY_INPUT = new OptionsSchema(
  { ...INDEX_ENTRY_FIELDS, rev: optional(nullable(int(0))) },
  "index scan row is invalid",
);
// Checkout facades relay these exact objects, so ephemeral provenance survives
// composition without exposing a forgeable capability on IndexStore.
const PERSISTED_INDEX_SCAN = new WeakMap<object, object>();
const PERSISTED_INDEX_ORDINAL = new WeakMap<object, number>();

export interface BufferedIndexMutation {
  kind: "p" | "r";
  json: string;
  bytes: number;
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

/** Internal ordered scan that does not re-decode rows from the persisted index path. */
export function indexScanOwned(
  index: IndexStore,
  options: IndexScanOptions = {},
): IterableIterator<IndexEntry> {
  return scanGenericIndexOwned(index.indexScan(options));
}

export function* scanGenericIndexOwned(
  entries: IterableIterator<IndexEntry>,
): Generator<IndexEntry> {
  let previousPath: string | null = null;
  let previousStage = -1;
  let persistedScan: object | undefined;
  let persistedOrdinal = 0;
  let generic = false;
  for (const raw of entries) {
    if (!generic) {
      const scan = PERSISTED_INDEX_SCAN.get(raw);
      const ordinal = PERSISTED_INDEX_ORDINAL.get(raw);
      if (
        scan !== undefined &&
        ordinal === persistedOrdinal &&
        (persistedScan === undefined || scan === persistedScan)
      ) {
        persistedScan = scan;
        persistedOrdinal++;
        yield raw;
        continue;
      }
      if (persistedScan !== undefined) {
        throw new CorruptError("persisted index scan lost its row provenance");
      }
      generic = true;
    }

    const entry = INDEX_ENTRY_INPUT.decode(raw);
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

export function requireScratchIndexPath(path: string): void {
  if (!isCanonicalGitPath(path)) {
    throw new GitError("EINVAL", "scratch index entry has an invalid path");
  }
  let bytes = 0;
  for (let index = 0; index < path.length; index++) {
    const unit = path.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      index++;
      bytes += 4;
    } else if (unit < 0x80) {
      bytes++;
    } else if (unit < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_INDEX_PATH_BYTES) {
      throw new GitError("E2BIG", `scratch index path exceeds ${MAX_INDEX_PATH_BYTES} UTF-8 bytes`);
    }
  }
}

export function requireScratchIndexEntry(row: unknown): IndexEntry {
  const entry = INDEX_ENTRY_INPUT.decode(row);
  requireScratchIndexPath(entry.path);
  if (!isOid(entry.oid)) {
    throw new GitError("EINVAL", "scratch index entry has an invalid object id");
  }
  return entry;
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
  const scan = {};
  let persistedOrdinal = 0;
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
    let issued: IndexEntry | undefined;
    const rows = db.iterate(query, ...bindings)[Symbol.iterator]();
    try {
      for (;;) {
        requireActive();
        const next = rows.next();
        if (next.done) break;
        if (pageRows >= pageSize) {
          throw new CorruptError("index scan returned invalid page cardinality");
        }
        const entry = requireStoredIndexEntry(next.value);
        Object.freeze(entry);
        PERSISTED_INDEX_SCAN.set(entry, scan);
        PERSISTED_INDEX_ORDINAL.set(entry, persistedOrdinal++);
        issued = entry;
        last = entry;
        pageRows++;
        yield entry;
        PERSISTED_INDEX_SCAN.delete(entry);
        PERSISTED_INDEX_ORDINAL.delete(entry);
        issued = undefined;
      }
    } finally {
      if (issued !== undefined) {
        PERSISTED_INDEX_SCAN.delete(issued);
        PERSISTED_INDEX_ORDINAL.delete(issued);
      }
      if (rows.return !== undefined) rows.return();
    }
    if (pageRows === 0) return;
    if (last === undefined) throw new CorruptError("index scan page lost its last row");
    path = last.path;
    stage = last.stage;
    if (pageRows < pageSize) return;
  }
}
