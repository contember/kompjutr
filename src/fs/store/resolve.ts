// `realpath` — the sole producer of a `RealPath`, and the choke point the
// whole schema hangs on.
//
// `fs_paths.path` is always a real path: if `/a` is a symlink to `/b`, then
// `/a/c` is stored as `/b/c`. A lexical path reaching the store would
// shadow its own target and diverge from every POSIX filesystem. Every path
// entering the store passes through here first.

import type { SqlDatabase } from "../../sqlite/db.js";
import { join, normalize, segments } from "../path.js";
import type { RealPath } from "../types.js";

/** POSIX's own guidance; dofs counts follows the same way. */
const MAX_FOLLOWS = 40;

interface SymlinkRow {
  path: string;
  link_target: string;
}

/**
 * Every symlink among a path's own ancestors, shallowest first. One
 * statement regardless of depth — `json_each` binds the whole prefix list
 * as a single parameter, so the 100-parameter ceiling is never approached.
 */
function symlinksOn(db: SqlDatabase, prefixes: string[]): SymlinkRow[] {
  if (prefixes.length === 0) return [];
  return db.all<SymlinkRow>(
    `SELECT p.path AS path, n.link_target AS link_target
       FROM fs_paths p
       JOIN fs_nodes n ON n.inode = p.inode
      WHERE p.path IN (SELECT value FROM json_each(?))
        AND n.type = 'symlink'
      ORDER BY length(p.path)`,
    JSON.stringify(prefixes),
  );
}

/** Every ancestor prefix of `path`, root first, `path` itself last. */
function prefixesOf(path: string): string[] {
  const parts = segments(path);
  const out: string[] = ["/"];
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    out.push(current);
  }
  return out;
}

/**
 * Canonicalise `path` and resolve every symlink on the way.
 *
 * One statement when nothing on the path is a symlink, which is the common
 * case; one more per symlink actually encountered.
 *
 * A trailing symlink IS resolved — this is `realpath(3)`, not `lstat`. A
 * caller that wants the link itself takes `dirname` through here and
 * appends the basename.
 */
export function realpath(db: SqlDatabase, path: string): RealPath {
  let current = normalize(path);

  for (let follows = 0; follows <= MAX_FOLLOWS; follows++) {
    const links = symlinksOn(db, prefixesOf(current));
    const shallowest = links[0];
    if (shallowest === undefined) return current as RealPath;

    // Everything below the link keeps its shape; only the prefix moves.
    const rest = current.slice(shallowest.path.length);
    const target = shallowest.link_target.startsWith("/")
      ? normalize(shallowest.link_target)
      : join(shallowest.path.slice(0, shallowest.path.lastIndexOf("/")), shallowest.link_target);
    current = rest === "" ? target : join(target, rest.slice(1));
  }

  throw Object.assign(new Error(`ELOOP: too many symbolic links, '${path}'`), {
    code: "ELOOP",
  });
}

/**
 * Resolve the parent through symlinks but leave the last segment alone.
 * This is what `lstat`, `symlink` and `unlink` need: they act on the link,
 * not on what it points at.
 */
export function realpathNoFollow(db: SqlDatabase, path: string): RealPath {
  const normalized = normalize(path);
  if (normalized === "/") return normalized as RealPath;
  const slash = normalized.lastIndexOf("/");
  const parent = slash === 0 ? "/" : normalized.slice(0, slash);
  const leaf = normalized.slice(slash + 1);
  return join(realpath(db, parent), leaf) as RealPath;
}
