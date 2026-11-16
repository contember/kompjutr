// Working-tree edits and reads shared by both sides. The two roots are plain
// host directories — kompjutr's local composition keeps no state inside its
// root — so one function writes both and one function reads both.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { comparePaths } from "../../../packages/git/src/common/streams.js";

export interface DiskEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  executable?: boolean;
  /** File bytes as hex. */
  content?: string;
  target?: string;
}

/**
 * Make `path` writable as a leaf: an ancestor that is not a real directory
 * (a file or a symlink, which is never followed) and a directory standing at
 * the leaf are removed first, so a generated write always lands.
 */
function clearFor(root: string, path: string): string {
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat !== null && !stat.isDirectory()) rmSync(current, { force: true });
  }
  const full = join(root, path);
  const leaf = lstatOrNull(full);
  if (leaf !== null) rmSync(full, { recursive: true, force: true });
  mkdirSync(join(full, ".."), { recursive: true });
  return full;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function writeFile(root: string, path: string, bytes: Buffer, executable: boolean): void {
  const full = clearFor(root, path);
  writeFileSync(full, bytes);
  chmodSync(full, executable ? 0o755 : 0o644);
}

export function writeSymlink(root: string, path: string, target: string): void {
  symlinkSync(target, clearFor(root, path));
}

export function removePath(root: string, path: string): void {
  rmSync(join(root, path), { recursive: true, force: true });
}

/** `mv` on disk; a missing source or an occupied destination is a no-op. */
export function movePath(root: string, from: string, to: string): void {
  const source = join(root, from);
  if (lstatOrNull(source) === null || lstatOrNull(join(root, to)) !== null) return;
  mkdirSync(join(root, to, ".."), { recursive: true });
  renameSync(source, join(root, to));
}

/** Every entry under `root` in Git byte order, skipping `skip` at the top. */
export function readDisk(root: string, skip?: string): DiskEntry[] {
  const out: DiskEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      if (prefix === "" && name === skip) continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(directory, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        out.push({ path, type: "symlink", target: readlinkSync(full) });
      } else if (stat.isDirectory()) {
        out.push({ path, type: "dir" });
        visit(full, path);
      } else {
        out.push({
          path,
          type: "file",
          executable: (stat.mode & 0o111) !== 0,
          content: readFileSync(full).toString("hex"),
        });
      }
    }
  };
  visit(root, "");
  return out.sort((left, right) => comparePaths(left.path, right.path));
}
