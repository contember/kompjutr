// The working tree, as the git core sees it. Every method is synchronous:
// status and checkout walk thousands of paths, and the DOFS provider
// already offers a synchronous surface.

export type WorktreeEntryType = "file" | "directory" | "symlink";

export interface WorktreeStat {
  type: WorktreeEntryType;
  /** Full st_mode, including permission bits. */
  mode: number;
  size: number;
  /** Milliseconds. */
  mtime: number;
  /** Inode number, when the backing store has one. Zero otherwise. */
  ino: number;
}

export interface WorktreeDirent {
  name: string;
  type: WorktreeEntryType;
}

/**
 * Absolute workspace paths throughout. The repository joins its root onto
 * repo-relative paths before calling in.
 */
export interface Worktree {
  /** lstat semantics: a symlink reports as a symlink, not its target. */
  stat(path: string): WorktreeStat | null;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array, mode: number): void;
  readlink(path: string): string;
  symlink(target: string, path: string): void;
  readdir(path: string): WorktreeDirent[];
  mkdirp(path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
  /** Read up to `length` bytes at `offset`. Short only at EOF. */
  readRange(path: string, offset: number, length: number): Uint8Array;
  /** Create or truncate `path` with `mode`, ready for writeRange. Creates parents. */
  createFile(path: string, mode: number): void;
  /** Write `data` at `offset`. The file must already exist. */
  writeRange(path: string, data: Uint8Array, offset: number): void;
}

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

/** The git tree mode for a working-tree entry. */
export function gitModeFor(stat: WorktreeStat): string {
  if (stat.type === "symlink") return "120000";
  if (stat.type === "directory") return "40000";
  return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

/** The filesystem mode a git tree mode should be materialised with. */
export function fileModeFor(gitMode: string): number {
  return gitMode === "100755" ? 0o755 : 0o644;
}
