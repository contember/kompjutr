import { CorruptError } from "../../common/errors.js";
import { blob, int, nullable, oneOf, RowShape, text } from "../../common/rows.js";
import type { SparseWorktreeLeaf } from "../../store/core/contracts.js";
import type { IndexEntry } from "../../store/index.js";
import { requireStoredIndexEntry } from "../../store/indexes/index-table.js";

const encoder = new TextEncoder();

const SPARSE_WORKTREE_ROW = new RowShape({
  path: text(),
  relative: text(),
  path_inode: int(1),
  inode: int(1),
  type: oneOf(["file", "dir", "symlink"]),
  mode: int(0, 0o7777),
  size: int(0),
  mtime: int(),
  rev: int(0),
  nlink: int(1),
  target: nullable(text()),
  content_id: nullable(blob()),
});

export function validatedSparseIndexEntry(row: unknown): IndexEntry {
  return requireStoredIndexEntry(row);
}

export function decodeSparseWorktreeRow(
  row: unknown,
  root: string,
): { path: string; stat: SparseWorktreeLeaf } {
  const decoded = SPARSE_WORKTREE_ROW.decode(row);
  const expected = root === "/" ? `/${decoded.relative}` : `${root}/${decoded.relative}`;
  if (decoded.path !== expected || decoded.path_inode !== decoded.inode) {
    throw new CorruptError("sparse worktree lookup returned an unrelated row");
  }
  if (decoded.type === "dir") {
    if (decoded.size !== 0 || decoded.target !== null || decoded.content_id !== null) {
      throw new CorruptError("sparse worktree lookup returned malformed directory metadata");
    }
  } else if (decoded.type === "file") {
    if (decoded.target !== null) {
      throw new CorruptError("sparse worktree lookup returned malformed file metadata");
    }
  } else if (
    decoded.target === null ||
    encoder.encode(decoded.target).byteLength !== decoded.size
  ) {
    throw new CorruptError("sparse worktree lookup returned malformed symlink metadata");
  }
  return {
    path: decoded.relative,
    stat: {
      type: decoded.type,
      mode: decoded.mode,
      size: decoded.size,
      mtime: decoded.mtime,
      ino: decoded.inode,
      nlink: decoded.nlink,
      rev: decoded.rev,
      target: decoded.target,
      contentId: decoded.content_id,
    },
  };
}
