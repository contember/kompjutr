import type { SqlDatabase } from "../../../db/db.js";
import { filesystemError } from "../../errors.js";
import { comparePaths, dirname } from "../../path.js";
import { CHUNK_SIZE } from "../../schema.js";
import { utf8Length } from "../write/write-batches.js";
import {
  type InitialChunkRow as ChunkRow,
  flushInitialChunks,
  flushInitialMetadata,
  type InitialNodeRow as NodeRow,
  type InitialPathRow as PathRow,
} from "./initial-write-batches.js";
import type {
  InitialSymlinkOptions,
  InitialWorktreeSession,
  InitialWriteOptions,
} from "./initial-write-types.js";
import {
  checkedContentId,
  checkedMode,
  checkedSize,
  jsonStringCodeUnits,
  MAX_PATH_SEGMENTS,
  validateRelative,
} from "./initial-write-validation.js";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const DEFAULT_SYMLINK_MODE = 0o777;
const PAYLOAD_PAGE_BYTES = 1024 * 1024;
const METADATA_JSON_FLUSH_BYTES = 128 * 1024;
const MAX_METADATA_ID_BYTES = 512 * 1024;
const MAX_CHUNK_JSON_BYTES = 128 * 1024;

/** One synchronous, create-only write session. Instances never escape tryRun. */
export class InitialWorktreeSessionImpl implements InitialWorktreeSession {
  #nodes: NodeRow[] = [];
  #paths: PathRow[] = [];
  #chunks: ChunkRow[] = [];
  #nodeJsonBytes = 2;
  #pathJsonBytes = 2;
  #contentIdBytes = 0;
  #chunkBytes = 0;
  #chunkJsonBytes = 2;
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
    private readonly rootSegments: number,
    nextInode: number,
  ) {
    this.#nextInode = nextInode;
  }

  writeSymlink(path: string, target: string, options: InitialSymlinkOptions = {}): void {
    try {
      if (target.includes("\0")) {
        throw filesystemError("EINVAL", "initial worktree symlink target contains NUL", path);
      }
      const size = utf8Length(target);
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
      let buffer = new Uint8Array(CHUNK_SIZE);
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
            this.#prepareChunk(buffer.length);
            this.#pushChunk(inode, index++, buffer);
            buffer = new Uint8Array(0);
            if (offset < chunk.length || observed < expected) {
              buffer = new Uint8Array(CHUNK_SIZE);
            }
            filled = 0;
          }
        }
      }
      if (observed !== expected) {
        throw filesystemError("EINVAL", "initial worktree stream is shorter than declared", path);
      }
      if (filled > 0) {
        this.#prepareChunk(filled);
        const final = buffer.slice(0, filled);
        this.#pushChunk(inode, index, final);
      }
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
    this.#chunkBytes = 0;
    this.#chunkJsonBytes = 2;
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
    const segmentCount = validateRelative(relative);
    if (segmentCount > MAX_PATH_SEGMENTS - this.rootSegments) {
      throw filesystemError("E2BIG", "initial worktree path exceeds the path limit", relative);
    }
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
      relative.startsWith(this.#lastPath) &&
      relative.charCodeAt(this.#lastPath.length) === 0x2f
    ) {
      throw filesystemError(
        "ENOTDIR",
        "initial worktree parent is not a directory",
        this.#lastPath,
      );
    }
    if (!this.rootExists && this.#created === 0) {
      this.#createPrepared(
        this.root,
        this.root === "/" ? "" : dirname(this.root),
        "dir",
        DEFAULT_DIR_MODE,
        0,
        null,
        null,
      );
    }

    const segments = relative.split("/");

    let common = 0;
    while (
      common < segments.length - 1 &&
      common < this.#openDirectorySegments.length &&
      segments[common] === this.#openDirectorySegments[common]
    ) {
      common++;
    }
    let boundary = 0;
    for (let index = common; index < segments.length - 1; index++) {
      if (index === common) {
        for (let prior = 0; prior <= index; prior++) {
          boundary += (prior === 0 ? 0 : 1) + segments[prior]!.length;
        }
      } else {
        boundary += 1 + segments[index]!.length;
      }
      this.#createRelative(relative, boundary, "dir", DEFAULT_DIR_MODE, 0, null, null);
    }

    const inode = this.#createRelative(
      relative,
      relative.length,
      type,
      mode,
      size,
      target,
      contentId,
    );
    if (type !== "dir") segments.pop();
    this.#openDirectorySegments = segments;
    this.#lastPath = relative;
    this.#lastType = type;
    return inode;
  }

  #createRelative(
    relative: string,
    end: number,
    type: NodeRow["type"],
    mode: number,
    size: number,
    target: string | null,
    contentId: Uint8Array | null,
  ): number {
    const parentSlash =
      this.root === "/"
        ? relative.lastIndexOf("/", end - 1) + 1
        : this.root.length + 1 + relative.lastIndexOf("/", end - 1);
    const parentLength = Math.max(1, parentSlash);
    const parentIsRoot = parentLength === this.root.length;
    const selected = end === relative.length ? relative : relative.slice(0, end);
    const path = this.root === "/" ? `/${selected}` : `${this.root}/${selected}`;
    const parent = parentIsRoot ? this.root : path.slice(0, parentSlash);
    const inode = this.#createPrepared(path, parent, type, mode, size, target, contentId);
    return inode;
  }

  #createPrepared(
    path: string,
    parent: string,
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
    const nodeJsonBytes = 384 + 2 * jsonStringCodeUnits(target);
    const pathJsonBytes = 128 + 2 * jsonStringCodeUnits(path) + 2 * jsonStringCodeUnits(parent);
    const idBytes = contentId?.length ?? 0;
    if (
      this.#nodes.length > 0 &&
      (this.#nodeJsonBytes + nodeJsonBytes > METADATA_JSON_FLUSH_BYTES ||
        this.#pathJsonBytes + pathJsonBytes > METADATA_JSON_FLUSH_BYTES ||
        this.#contentIdBytes + idBytes > MAX_METADATA_ID_BYTES)
    ) {
      this.#flushMetadata();
    }
    const ownedContentId = contentId?.slice() ?? null;
    const pathRow = { path, parent, inode };
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
    this.#created++;
    if (
      this.#nodeJsonBytes >= METADATA_JSON_FLUSH_BYTES ||
      this.#pathJsonBytes >= METADATA_JSON_FLUSH_BYTES ||
      this.#contentIdBytes >= MAX_METADATA_ID_BYTES
    ) {
      this.#flushMetadata();
    }
    return inode;
  }

  #prepareChunk(length: number): void {
    const itemBytes = 192;
    if (
      this.#chunks.length > 0 &&
      (this.#chunkBytes + length > PAYLOAD_PAGE_BYTES ||
        this.#chunkJsonBytes + itemBytes > MAX_CHUNK_JSON_BYTES)
    ) {
      this.#flushChunks();
    }
  }

  #queueCopiedChunk(inode: number, index: number, source: Uint8Array): void {
    this.#prepareChunk(source.length);
    this.#pushChunk(inode, index, source.slice());
  }

  #pushChunk(inode: number, index: number, bytes: Uint8Array): void {
    this.#chunks.push({ inode, index, bytes });
    this.#chunkBytes += bytes.length;
    this.#chunkJsonBytes += 192;
    if (this.#chunkBytes >= PAYLOAD_PAGE_BYTES || this.#chunkJsonBytes >= MAX_CHUNK_JSON_BYTES) {
      this.#flushChunks();
    }
  }

  #flushMetadata(): void {
    if (this.#nodes.length === 0) return;
    flushInitialMetadata(this.db, this.#nodes, this.#paths, this.#contentIdBytes, this.revision);
    this.#nodes = [];
    this.#paths = [];
    this.#nodeJsonBytes = 2;
    this.#pathJsonBytes = 2;
    this.#contentIdBytes = 0;
  }

  #flushChunks(): void {
    if (this.#chunks.length === 0) return;
    flushInitialChunks(this.db, this.#chunks, this.#chunkBytes);
    this.#chunks = [];
    this.#chunkBytes = 0;
    this.#chunkJsonBytes = 2;
  }

  #assertOpen(): void {
    if (this.#closed || this.#failed) throw new Error("initial worktree session is closed");
  }
}
