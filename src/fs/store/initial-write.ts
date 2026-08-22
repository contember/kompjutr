// Clone-only create path for an absent or provably empty worktree. The caller
// gets no overwrite semantics: eligibility is settled before the body runs,
// and every row written by the session is a plain INSERT.

import { blob, type SqlDatabase } from "../../sqlite/db.js";
import { filesystemError } from "../errors.js";
import { comparePaths, dirname, normalize, subtreeSuccessor } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const DEFAULT_SYMLINK_MODE = 0o777;
const MODE_BITS = 0o7777;
const MAX_JSON_BYTES = 1_500_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_SMALL_FILE_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_PATH_SEGMENTS = 128;
export const MAX_INITIAL_WORKTREE_SESSION_BYTES = 4 * 1024 * 1024;
const SESSION_FIXED_BYTES = 512 * 1024;
const MAX_METADATA_JSON_BYTES = 128 * 1024;
const MAX_METADATA_ID_BYTES = 512 * 1024;
const MAX_CHUNK_BATCH_BYTES = MAX_PAYLOAD_BYTES;
const MAX_CHUNK_JSON_BYTES = 128 * 1024;
const ROW_WRAPPER_BYTES = 256;

export interface InitialWriteOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialSymlinkOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialWorktreeSession {
  readonly highWaterBytes: number;
  writeSymlink(path: string, target: string, options?: InitialSymlinkOptions): void;
  writeFile(path: string, bytes: Uint8Array, options?: InitialWriteOptions): void;
  writeFileStream(
    path: string,
    size: number,
    chunks: Iterable<Uint8Array>,
    options?: InitialWriteOptions,
  ): void;
}

export type InitialWriteResult<T> = { kind: "committed"; value: T } | { kind: "unavailable" };

interface NodeRow {
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  target: string | null;
  contentId: Uint8Array | null;
}

interface PathRow {
  path: string;
  parent: string;
  inode: number;
}

interface ChunkRow {
  inode: number;
  index: number;
  bytes: Uint8Array;
}

interface PreflightRow {
  ordinal: number;
  requested: string;
  path: string | null;
  type: string | null;
}

interface Preflight {
  rootExists: boolean;
  revision: number;
  nextInode: number;
}

const INSERT_NODES = `
WITH rows(value) AS (SELECT value FROM json_each(?))
INSERT INTO fs_nodes
       (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
SELECT json_extract(value, '$.i'),
       json_extract(value, '$.t'),
       json_extract(value, '$.m'),
       json_extract(value, '$.mt'),
       json_extract(value, '$.s'),
       ?, 1,
       json_extract(value, '$.l'),
       CASE WHEN json_extract(value, '$.ca') > 0
            THEN substr(?, json_extract(value, '$.ca'), json_extract(value, '$.cn'))
            ELSE NULL END
  FROM rows`;

const INSERT_PATHS = `
INSERT INTO fs_paths (path, parent, inode)
SELECT json_extract(value, '$.p'),
       json_extract(value, '$.pa'),
       json_extract(value, '$.i')
  FROM json_each(?)`;

const INSERT_CHUNKS = `
INSERT INTO fs_chunks (inode, idx, bytes)
SELECT json_extract(value, '$.i'),
       json_extract(value, '$.x'),
       substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
  FROM json_each(?)`;

function utf8Length(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) total++;
    else if (unit < 0x800) total += 2;
    else if (unit >= 0xd800 && unit < 0xdc00) {
      total += 4;
      index++;
    } else total += 3;
  }
  return total;
}

function canonicalRoot(root: string): string {
  if (utf8Length(root) > MAX_PATH_BYTES || root.split("/").length - 1 > MAX_PATH_SEGMENTS) {
    throw filesystemError("E2BIG", "initial worktree root exceeds the path limit", root);
  }
  if (
    !root.startsWith("/") ||
    root.includes("\0") ||
    normalize(root) !== root ||
    (root.length > 1 && root.endsWith("/"))
  ) {
    throw filesystemError("EINVAL", "initial worktree root is not canonical", root);
  }
  return root;
}

function rootAncestors(root: string): string[] {
  const ancestors = ["/"];
  if (root === "/") return ancestors;
  let slash = root.indexOf("/", 1);
  while (slash > 0) {
    ancestors.push(root.slice(0, slash));
    slash = root.indexOf("/", slash + 1);
  }
  ancestors.push(root);
  return ancestors;
}

function pathSegmentCount(path: string): number {
  return path === "/" ? 0 : path.split("/").length - 1;
}

function validateRelative(path: string): string[] {
  if (utf8Length(path) > MAX_PATH_BYTES) {
    throw filesystemError("E2BIG", "initial worktree path exceeds the path limit", path);
  }
  if (path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("\0")) {
    throw filesystemError("EINVAL", "initial worktree path escapes or is not canonical", path);
  }
  const segments = path.split("/");
  if (
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    const code = segments.length > MAX_PATH_SEGMENTS ? "E2BIG" : "EINVAL";
    throw filesystemError(code, "initial worktree path escapes or is not canonical", path);
  }
  return segments;
}

function checkedMode(mode: number | undefined, fallback: number, path: string): number {
  if (mode === undefined) return fallback;
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw filesystemError("EINVAL", "initial worktree mode is invalid", path);
  }
  return mode & MODE_BITS;
}

function checkedSize(size: number, path: string): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw filesystemError("EINVAL", "initial worktree file size is invalid", path);
  }
  return size;
}

function checkedContentId(contentId: Uint8Array | undefined, path: string): Uint8Array | null {
  if (contentId === undefined) return null;
  if (!(contentId instanceof Uint8Array)) {
    throw filesystemError("EINVAL", "initial worktree content id is invalid", path);
  }
  if (contentId.length > MAX_PAYLOAD_BYTES) {
    throw filesystemError("E2BIG", "initial worktree content id exceeds the payload limit", path);
  }
  return contentId;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}

/** One synchronous, create-only write session. Instances never escape tryRun. */
class InitialWorktreeSessionImpl implements InitialWorktreeSession {
  #nodes: NodeRow[] = [];
  #paths: PathRow[] = [];
  #chunks: ChunkRow[] = [];
  #nodeJsonBytes = 2;
  #pathJsonBytes = 2;
  #contentIdBytes = 0;
  #metadataRetainedBytes = 0;
  #chunkBytes = 0;
  #chunkJsonBytes = 2;
  #assemblerBytes = 0;
  #pathStateBytes = 0;
  #highWaterBytes: number;
  #lastPath: string | null = null;
  #lastType: NodeRow["type"] | null = null;
  #openDirectorySegments: string[] = [];
  #nextInode: number;
  #created = 0;
  #closed = false;
  #failed = false;

  constructor(
    private readonly db: SqlDatabase,
    private readonly root: string,
    private readonly rootExists: boolean,
    private readonly timestamp: number,
    private readonly revision: number,
    nextInode: number,
  ) {
    this.#nextInode = nextInode;
    this.#highWaterBytes = SESSION_FIXED_BYTES + 2 * root.length;
  }

  get highWaterBytes(): number {
    return this.#highWaterBytes;
  }

  writeSymlink(path: string, target: string, options: InitialSymlinkOptions = {}): void {
    try {
      if (target.includes("\0")) {
        throw filesystemError("EINVAL", "initial worktree symlink target contains NUL", path);
      }
      const size = utf8Length(target);
      if (size > MAX_METADATA_JSON_BYTES / 2) {
        throw filesystemError(
          "E2BIG",
          "initial worktree symlink target exceeds the session limit",
          path,
        );
      }
      this.#entry(
        path,
        "symlink",
        checkedMode(options.mode, DEFAULT_SYMLINK_MODE, path),
        size,
        target,
        checkedContentId(options.contentId, path),
      );
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  writeFile(path: string, bytes: Uint8Array, options: InitialWriteOptions = {}): void {
    try {
      if (!(bytes instanceof Uint8Array)) {
        throw filesystemError("EINVAL", "initial worktree file bytes are invalid", path);
      }
      if (bytes.length > MAX_SMALL_FILE_BYTES) {
        throw filesystemError("E2BIG", "initial worktree small write exceeds 1 MiB", path);
      }
      const inode = this.#entry(
        path,
        "file",
        checkedMode(options.mode, DEFAULT_FILE_MODE, path),
        bytes.length,
        null,
        checkedContentId(options.contentId, path),
      );
      for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_SIZE, index++) {
        this.#queueCopiedChunk(inode, index, bytes.subarray(offset, offset + CHUNK_SIZE));
      }
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  writeFileStream(
    path: string,
    size: number,
    chunks: Iterable<Uint8Array>,
    options: InitialWriteOptions = {},
  ): void {
    try {
      const expected = checkedSize(size, path);
      const inode = this.#entry(
        path,
        "file",
        checkedMode(options.mode, DEFAULT_FILE_MODE, path),
        expected,
        null,
        checkedContentId(options.contentId, path),
      );
      this.#ensurePeak(CHUNK_SIZE, path);
      let buffer = new Uint8Array(CHUNK_SIZE);
      this.#assemblerBytes = CHUNK_SIZE;
      this.#recordState(path);
      let filled = 0;
      let observed = 0;
      let index = 0;
      for (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) {
          throw filesystemError("EINVAL", "initial worktree stream yielded invalid bytes", path);
        }
        if (chunk.length > expected - observed) {
          throw filesystemError(
            "EINVAL",
            "initial worktree stream exceeds its declared size",
            path,
          );
        }
        observed += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const length = Math.min(CHUNK_SIZE - filled, chunk.length - offset);
          buffer.set(chunk.subarray(offset, offset + length), filled);
          filled += length;
          offset += length;
          if (filled === CHUNK_SIZE) {
            this.#prepareChunk(buffer.length, path);
            this.#assemblerBytes = 0;
            this.#pushChunk(inode, index++, buffer);
            buffer = new Uint8Array(0);
            if (offset < chunk.length || observed < expected) {
              this.#ensurePeak(CHUNK_SIZE, path);
              buffer = new Uint8Array(CHUNK_SIZE);
              this.#assemblerBytes = CHUNK_SIZE;
              this.#recordState(path);
            }
            filled = 0;
          }
        }
      }
      if (observed !== expected) {
        throw filesystemError("EINVAL", "initial worktree stream is shorter than declared", path);
      }
      if (filled > 0) {
        this.#prepareChunk(filled, path);
        this.#ensurePeak(filled, path);
        const final = buffer.slice(0, filled);
        this.#assemblerBytes = 0;
        this.#pushChunk(inode, index, final);
      } else {
        this.#assemblerBytes = 0;
      }
      this.#recordState(path);
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  close(startRevision: number, startInode: number): void {
    this.#assertOpen();
    this.#closed = true;
    if (this.#created === 0) return;
    this.#flushChunks();
    this.#flushMetadata();
    const inode = this.db.scalar<number>(
      "UPDATE fs_meta SET v = ? WHERE k = 'next_inode' AND v = ? RETURNING v",
      this.#nextInode,
      startInode,
    );
    if (inode !== this.#nextInode) throw new Error("fs next_inode changed during initial write");
    const revision = this.db.scalar<number>(
      "UPDATE fs_meta SET v = ? WHERE k = 'rev' AND v = ? RETURNING v",
      this.revision,
      startRevision,
    );
    if (revision !== this.revision) throw new Error("fs revision changed during initial write");
  }

  invalidate(): void {
    this.#closed = true;
    this.#nodes = [];
    this.#paths = [];
    this.#chunks = [];
    this.#openDirectorySegments = [];
    this.#lastPath = null;
    this.#lastType = null;
    this.#nodeJsonBytes = 2;
    this.#pathJsonBytes = 2;
    this.#contentIdBytes = 0;
    this.#metadataRetainedBytes = 0;
    this.#chunkBytes = 0;
    this.#chunkJsonBytes = 2;
    this.#assemblerBytes = 0;
    this.#pathStateBytes = 0;
    this.#failed = true;
  }

  #entry(
    relative: string,
    type: NodeRow["type"],
    mode: number,
    size: number,
    target: string | null,
    contentId: Uint8Array | null,
  ): number {
    this.#assertOpen();
    const segments = validateRelative(relative);
    if (this.#lastPath !== null && comparePaths(this.#lastPath, relative) >= 0) {
      throw filesystemError(
        "EINVAL",
        "initial worktree entries are not strictly ordered",
        relative,
      );
    }
    if (
      this.#lastPath !== null &&
      this.#lastType !== "dir" &&
      relative.startsWith(`${this.#lastPath}/`)
    ) {
      throw filesystemError(
        "ENOTDIR",
        "initial worktree parent is not a directory",
        this.#lastPath,
      );
    }
    if (!this.rootExists && this.#created === 0) {
      this.#create(this.root, "dir", DEFAULT_DIR_MODE, 0, null, null);
    }

    let common = 0;
    while (
      common < segments.length - 1 &&
      common < this.#openDirectorySegments.length &&
      segments[common] === this.#openDirectorySegments[common]
    ) {
      common++;
    }
    for (let index = common; index < segments.length - 1; index++) {
      const ancestor = segments.slice(0, index + 1).join("/");
      this.#create(this.#absolute(ancestor), "dir", DEFAULT_DIR_MODE, 0, null, null);
    }

    const inode = this.#create(this.#absolute(relative), type, mode, size, target, contentId);
    const openDirectories = type === "dir" ? segments : segments.slice(0, segments.length - 1);
    const pathStateBytes =
      2 * relative.length +
      openDirectories.reduce((total, segment) => total + 2 * segment.length + 16, 0);
    this.#ensurePeak(Math.max(0, pathStateBytes - this.#pathStateBytes), relative);
    this.#openDirectorySegments = openDirectories;
    this.#lastPath = relative;
    this.#lastType = type;
    this.#pathStateBytes = pathStateBytes;
    this.#recordState(relative);
    return inode;
  }

  #create(
    path: string,
    type: NodeRow["type"],
    mode: number,
    size: number,
    target: string | null,
    contentId: Uint8Array | null,
  ): number {
    if (
      !Number.isSafeInteger(this.#nextInode) ||
      this.#nextInode <= 0 ||
      this.#nextInode >= Number.MAX_SAFE_INTEGER
    ) {
      throw filesystemError("E2BIG", "initial worktree inode range is exhausted", path);
    }
    const inode = this.#nextInode++;
    const pathRow = { path, parent: dirname(path), inode };
    const nodeJsonBytes = 384 + 2 * JSON.stringify(target).length;
    const pathJsonBytes = 128 + 2 * path.length + 2 * pathRow.parent.length;
    if (nodeJsonBytes > MAX_JSON_BYTES || pathJsonBytes > MAX_JSON_BYTES) {
      throw filesystemError("E2BIG", "initial worktree metadata row exceeds the JSON limit", path);
    }
    const idBytes = contentId?.length ?? 0;
    if (
      this.#nodes.length > 0 &&
      (this.#nodeJsonBytes + nodeJsonBytes > MAX_METADATA_JSON_BYTES ||
        this.#pathJsonBytes + pathJsonBytes > MAX_METADATA_JSON_BYTES ||
        this.#contentIdBytes + idBytes > MAX_METADATA_ID_BYTES)
    ) {
      this.#flushMetadata();
    }
    const retainedBytes =
      2 * ROW_WRAPPER_BYTES +
      2 * path.length +
      2 * pathRow.parent.length +
      (target === null ? 0 : 2 * target.length) +
      idBytes;
    this.#ensurePeak(retainedBytes, path);
    const ownedContentId = contentId?.slice() ?? null;
    const node: NodeRow = {
      inode,
      type,
      mode,
      mtime: this.timestamp,
      size,
      target,
      contentId: ownedContentId,
    };
    this.#nodes.push(node);
    this.#paths.push(pathRow);
    this.#nodeJsonBytes += nodeJsonBytes;
    this.#pathJsonBytes += pathJsonBytes;
    this.#contentIdBytes += idBytes;
    this.#metadataRetainedBytes += retainedBytes;
    this.#created++;
    this.#recordState(path);
    return inode;
  }

  #prepareChunk(length: number, path: string): void {
    const itemBytes = 192;
    if (
      this.#chunks.length > 0 &&
      (this.#chunkBytes + length > MAX_CHUNK_BATCH_BYTES ||
        this.#chunkJsonBytes + itemBytes > MAX_CHUNK_JSON_BYTES)
    ) {
      this.#flushChunks();
    }
    if (length > MAX_CHUNK_BATCH_BYTES) {
      throw filesystemError("E2BIG", "initial worktree chunk exceeds the session limit", path);
    }
  }

  #queueCopiedChunk(inode: number, index: number, source: Uint8Array): void {
    this.#prepareChunk(source.length, "initial worktree file");
    this.#ensurePeak(source.length, "initial worktree file");
    this.#pushChunk(inode, index, source.slice());
  }

  #pushChunk(inode: number, index: number, bytes: Uint8Array): void {
    this.#chunks.push({ inode, index, bytes });
    this.#chunkBytes += bytes.length;
    this.#chunkJsonBytes += 192;
    this.#recordState("initial worktree content");
    if (this.#chunkBytes === MAX_CHUNK_BATCH_BYTES) this.#flushChunks();
  }

  #flushMetadata(): void {
    if (this.#nodes.length === 0) return;
    this.#ensurePeak(
      this.#contentIdBytes + 2 * (this.#nodeJsonBytes + this.#pathJsonBytes),
      "initial worktree metadata",
    );
    const ids = new Uint8Array(this.#contentIdBytes);
    const nodeItems: string[] = [];
    const pathItems: string[] = [];
    let at = 0;
    for (let index = 0; index < this.#nodes.length; index++) {
      const node = this.#nodes[index]!;
      const path = this.#paths[index]!;
      const contentId = node.contentId;
      let contentAt = 0;
      if (contentId !== null) {
        ids.set(contentId, at);
        contentAt = at + 1;
        at += contentId.length;
      }
      nodeItems.push(
        JSON.stringify({
          i: node.inode,
          t: node.type,
          m: node.mode,
          mt: node.mtime,
          s: node.size,
          l: node.target,
          ca: contentAt,
          cn: contentId?.length ?? 0,
        }),
      );
      pathItems.push(JSON.stringify({ p: path.path, pa: path.parent, i: path.inode }));
    }
    const nodeJson = `[${nodeItems.join(",")}]`;
    const pathJson = `[${pathItems.join(",")}]`;
    if (utf8Length(nodeJson) > MAX_JSON_BYTES || utf8Length(pathJson) > MAX_JSON_BYTES) {
      throw filesystemError("E2BIG", "initial worktree metadata batch exceeds the JSON limit");
    }
    this.db.run(INSERT_NODES, nodeJson, this.revision, blob(ids));
    this.db.run(INSERT_PATHS, pathJson);
    this.#nodes = [];
    this.#paths = [];
    this.#nodeJsonBytes = 2;
    this.#pathJsonBytes = 2;
    this.#contentIdBytes = 0;
    this.#metadataRetainedBytes = 0;
    this.#recordState("initial worktree metadata");
  }

  #flushChunks(): void {
    if (this.#chunks.length === 0) return;
    this.#ensurePeak(this.#chunkBytes + 2 * this.#chunkJsonBytes, "initial worktree content");
    const payload = new Uint8Array(this.#chunkBytes);
    const items: string[] = [];
    let at = 0;
    for (const row of this.#chunks) {
      payload.set(row.bytes, at);
      items.push(JSON.stringify({ i: row.inode, x: row.index, a: at + 1, n: row.bytes.length }));
      at += row.bytes.length;
    }
    const json = `[${items.join(",")}]`;
    if (payload.length > MAX_PAYLOAD_BYTES || utf8Length(json) > MAX_JSON_BYTES) {
      throw filesystemError("E2BIG", "initial worktree content batch exceeds its bound");
    }
    this.db.run(INSERT_CHUNKS, blob(payload), json);
    this.#chunks = [];
    this.#chunkBytes = 0;
    this.#chunkJsonBytes = 2;
    this.#recordState("initial worktree content");
  }

  #absolute(relative: string): string {
    const path = this.root === "/" ? `/${relative}` : `${this.root}/${relative}`;
    if (utf8Length(path) > MAX_PATH_BYTES || pathSegmentCount(path) > MAX_PATH_SEGMENTS) {
      throw filesystemError("E2BIG", "initial worktree path exceeds the path limit", path);
    }
    return path;
  }

  #assertOpen(): void {
    if (this.#closed || this.#failed) throw new Error("initial worktree session is closed");
  }

  #ownedStateBytes(): number {
    return (
      SESSION_FIXED_BYTES +
      2 * this.root.length +
      this.#metadataRetainedBytes +
      this.#chunkBytes +
      this.#chunks.length * ROW_WRAPPER_BYTES +
      this.#assemblerBytes +
      this.#pathStateBytes
    );
  }

  #ensurePeak(extraBytes: number, path: string): void {
    const current = this.#ownedStateBytes();
    if (
      !Number.isSafeInteger(extraBytes) ||
      extraBytes < 0 ||
      current > MAX_INITIAL_WORKTREE_SESSION_BYTES - extraBytes
    ) {
      throw filesystemError("E2BIG", "initial worktree session exceeds 4 MiB", path);
    }
    this.#highWaterBytes = Math.max(this.#highWaterBytes, current + extraBytes);
  }

  #recordState(path: string): void {
    this.#ensurePeak(0, path);
  }
}

/** Internal clone-only writer. Ordinary filesystem writes must not use this path. */
export class InitialWorktreeWriter {
  constructor(
    private readonly db: SqlDatabase,
    private readonly clock: () => number = Date.now,
  ) {}

  tryRun<T>(
    rootInput: string,
    body: (session: InitialWorktreeSession) => T,
  ): InitialWriteResult<T> {
    const root = canonicalRoot(rootInput);
    return this.db.transactionSync(() => {
      const preflight = this.#preflight(root);
      if (preflight === null) return { kind: "unavailable" };
      const timestamp = this.clock();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw filesystemError("EINVAL", "initial worktree clock returned an invalid timestamp");
      }
      if (preflight.revision === Number.MAX_SAFE_INTEGER) {
        throw filesystemError("E2BIG", "filesystem revision is exhausted");
      }
      const revision = preflight.revision + 1;
      const session = new InitialWorktreeSessionImpl(
        this.db,
        root,
        preflight.rootExists,
        timestamp,
        revision,
        preflight.nextInode,
      );
      try {
        const value = body(session);
        if (isThenable(value)) {
          throw filesystemError("EINVAL", "initial worktree body must be synchronous");
        }
        session.close(preflight.revision, preflight.nextInode);
        return { kind: "committed", value };
      } finally {
        session.invalidate();
      }
    });
  }

  #preflight(root: string): Preflight | null {
    const ancestors = rootAncestors(root);
    const rows = this.db.all<PreflightRow>(
      `WITH requested(ordinal, path) AS (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT requested.ordinal, requested.path AS requested,
              path.path, node.type
         FROM requested
         LEFT JOIN fs_paths path ON path.path = requested.path
         LEFT JOIN fs_nodes node ON node.inode = path.inode
        ORDER BY requested.ordinal`,
      JSON.stringify(ancestors),
    );
    if (rows.length !== ancestors.length) throw new Error("initial worktree preflight lost a row");
    let rootExists = false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const expected = ancestors[index]!;
      if (row.ordinal !== index || row.requested !== expected) {
        throw new Error("initial worktree preflight returned invalid path metadata");
      }
      const final = index === rows.length - 1;
      if (row.path === null) {
        if (!final) return null;
        continue;
      }
      if (row.path !== expected || row.type !== "dir") return null;
      if (final) rootExists = true;
    }
    const descendants =
      root === "/"
        ? this.db.scalar<number>("SELECT count(*) FROM fs_paths WHERE path > '/' AND path < '0'")
        : this.db.scalar<number>(
            "SELECT count(*) FROM fs_paths WHERE path >= ? AND path < ?",
            `${root}/`,
            subtreeSuccessor(root),
          );
    if (typeof descendants !== "number" || !Number.isSafeInteger(descendants) || descendants < 0) {
      throw new Error("initial worktree preflight returned an invalid subtree count");
    }
    if (descendants !== 0) return null;
    const revision = this.db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'");
    const nextInode = this.db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'");
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof nextInode !== "number" ||
      !Number.isSafeInteger(nextInode) ||
      nextInode <= 0
    ) {
      throw new Error("filesystem metadata is invalid");
    }
    return { rootExists, revision, nextInode };
  }
}

export function createInitialWorktreeWriter(
  db: SqlDatabase,
  clock: () => number = Date.now,
): InitialWorktreeWriter {
  return new InitialWorktreeWriter(db, clock);
}
