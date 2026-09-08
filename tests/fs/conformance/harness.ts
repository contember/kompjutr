// A dofs-shaped façade over `Filesystem`, so the inherited conformance
// suite ports nearly mechanically and no production code carries dofs'
// argument order or return shapes.
//
// This exists because six of the nine porting blockers found by the wave-A
// survey are interface mismatches, not schema ones. Bending `Filesystem` to
// match a test suite would be letting the tests design the product; bending
// the tests here costs thirty lines.
//
// The inherited tests are MIT, from cloudflare/computer's `packages/dofs`.
// See LICENSES/ and the file headers on the ported files.

import type { Dirent, Filesystem, Stat } from "../../../packages/do/src/fs/types.js";

/** dofs' stat shape: `fs/stat.ts:8-23`. Permission bits only, no S_IF*. */
export interface WorkspaceStatResult {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: number;
  rev: number;
}

/** dofs' dirent shape: `fs/readdir.ts:7-15`. */
export interface WorkspaceDirentResult {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

const PERMISSION_BITS = 0o7777;

function toStatResult(path: string, stat: Stat): WorkspaceStatResult {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    isFile: stat.type === "file",
    isDirectory: stat.type === "dir",
    isSymbolicLink: stat.type === "symlink",
    // dofs reports permission bits; `Filesystem` reports full st_mode.
    mode: stat.mode & PERMISSION_BITS,
    size: stat.size,
    mtime: stat.mtime,
    rev: stat.rev,
  };
}

function toDirentResult(entry: Dirent): WorkspaceDirentResult {
  return {
    name: entry.name,
    isFile: entry.type === "file",
    isDirectory: entry.type === "dir",
    isSymbolicLink: entry.type === "symlink",
  };
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: "ENOENT",
  });
}

/**
 * The free functions the ported tests call. `dofs` threads `db` as the
 * first argument and a clock as the last; we bind a `Filesystem` instead
 * and let the caller pin time through `FilesystemOptions.now`.
 */
export function conformance(fs: Pick<Filesystem, "stat" | "statTarget" | "readdir" | "readFile">) {
  return {
    /**
     * dofs throws ENOENT; `Filesystem.stat` returns null. Inverting it here
     * is what lets every ENOENT-on-stat assertion port unchanged.
     */
    lstat(path: string): WorkspaceStatResult {
      const stat = fs.stat(path);
      if (stat === null) throw enoent(path);
      return toStatResult(path, stat);
    },

    stat(path: string): WorkspaceStatResult {
      const stat = fs.statTarget(path);
      if (stat === null) throw enoent(path);
      return toStatResult(path, stat);
    },

    /** dofs takes `{limit, offset}`; paging is `scan`'s job now. */
    readdir(
      path: string,
      options: { limit?: number; offset?: number } = {},
    ): WorkspaceDirentResult[] {
      const limit = options.limit;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        throw new TypeError("readdir limit must be a non-negative safe integer");
      }
      const offset = options.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError("readdir offset must be a non-negative safe integer");
      }
      const all = fs.readdir(path).map(toDirentResult);
      return all.slice(offset, limit === undefined ? undefined : offset + limit);
    },

    /**
     * The assertion vehicle for 41 inherited cases. `followSymlinks: false`
     * splits into `stat` vs `statTarget`.
     */
    resolveInode(path: string, options: { followSymlinks?: boolean } = {}): number {
      const follow = options.followSymlinks ?? true;
      const stat = follow ? fs.statTarget(path) : fs.stat(path);
      if (stat === null) throw enoent(path);
      return stat.ino;
    },

    /**
     * `writeFile.test.ts:12-13`'s deliberately minimal read-back, so those
     * tests stand alone without depending on readFile. In dofs it reaches
     * into `vfs_chunks` and `vfs_blob_bytes` directly; here it does not
     * need to, which is the entire point.
     */
    readBack(path: string): Uint8Array {
      return fs.readFile(path);
    },
  };
}

export type Conformance = ReturnType<typeof conformance>;
