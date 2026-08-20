// `realpath` — the sole producer of a `RealPath`, and the choke point the
// whole schema hangs on.
//
// `fs_paths.path` is always a real path: if `/a` is a symlink to `/b`, then
// `/a/c` is stored as `/b/c`. A lexical path reaching the store would
// shadow its own target and diverge from every POSIX filesystem. Every path
// entering the store passes through here first.

import type { SqlDatabase } from "../../sqlite/db.js";
import type { RealPath } from "../types.js";

/** POSIX's own guidance; dofs counts follows the same way. */
const MAX_FOLLOWS = 40;

/** Bounds the quadratic prefix set below to comfortably less than 100 MB. */
const MAX_PATH_CODE_UNITS = 4096;

interface NodeRow {
  path: string;
  type: string;
  link_target: string | null;
}

/**
 * Fetch every node the ordered walk may inspect. `json_each` keeps this one
 * indexed statement regardless of depth; a symlink expansion starts a new
 * batch because only then is the next set of real prefixes known.
 */
function nodesOn(db: SqlDatabase, paths: readonly string[]): Map<string, NodeRow> {
  const rows = db.all<NodeRow>(
    `SELECT p.path AS path, n.type AS type,
            substr(n.link_target, 1, 4097) AS link_target
       FROM fs_paths p
       JOIN fs_nodes n ON n.inode = p.inode
      WHERE p.path IN (SELECT value FROM json_each(?))`,
    JSON.stringify(paths),
  );
  return new Map(rows.map((row) => [row.path, row]));
}

/** Preserve separators and dot segments; their order carries type semantics. */
function componentsOf(path: string): string[] {
  const rooted = path.startsWith("/") ? path.replace(/^\/+/, "") : path;
  return rooted === "" ? [] : rooted.split("/");
}

function pathOf(parts: readonly string[]): string {
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/** Prefixes needed to process one no-symlink batch in source order. */
function plannedPaths(resolved: readonly string[], pending: readonly string[]): string[] {
  const parts = [...resolved];
  const paths = new Set<string>([pathOf(parts)]);

  for (const component of pending) {
    paths.add(pathOf(parts));
    if (component === "" || component === ".") continue;
    if (component === "..") {
      parts.pop();
      paths.add(pathOf(parts));
      continue;
    }
    parts.push(component);
    paths.add(pathOf(parts));
  }

  return [...paths];
}

function enotdir(path: string): Error {
  return Object.assign(new Error(`ENOTDIR: not a directory, '${path}'`), {
    code: "ENOTDIR",
    path,
  });
}

function eloop(path: string): Error {
  return Object.assign(new Error(`ELOOP: too many symbolic links, '${path}'`), {
    code: "ELOOP",
    path,
  });
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: "ENOENT",
    path,
  });
}

function enametoolong(path: string): Error {
  return Object.assign(new Error("ENAMETOOLONG: path exceeds 4096 UTF-16 code units"), {
    code: "ENAMETOOLONG",
    path,
  });
}

function requireAcceptedLength(path: string, sourcePath: string): void {
  if (path.length > MAX_PATH_CODE_UNITS) throw enametoolong(sourcePath);
}

function requireAcceptedComponents(
  resolved: readonly string[],
  pending: readonly string[],
  sourcePath: string,
): void {
  const componentLength = [...resolved, ...pending].reduce(
    (total, component) => total + component.length,
    0,
  );
  const componentCount = resolved.length + pending.length;
  const pathLength = 1 + componentLength + Math.max(0, componentCount - 1);
  if (pathLength > MAX_PATH_CODE_UNITS) throw enametoolong(sourcePath);
}

function requireDirectory(row: NodeRow | undefined, sourcePath: string): void {
  if (row !== undefined && row.type !== "dir") throw enotdir(sourcePath);
}

/**
 * Resolve in component order. This matters for `file/..` and for a symlink
 * followed by `..`: lexical normalization before lookup gets both wrong.
 */
function resolve(db: SqlDatabase, path: string, followFinal: boolean): RealPath {
  requireAcceptedLength(path, path);
  let resolved: string[] = [];
  let pending = componentsOf(path);
  let follows = 0;
  let missingPrefix: string | undefined;

  for (;;) {
    const nodes = nodesOn(db, plannedPaths(resolved, pending));
    let expanded = false;

    for (let index = 0; index < pending.length; index++) {
      const component = pending[index];
      if (component === undefined) continue;

      const current = pathOf(resolved);
      requireDirectory(nodes.get(current), path);

      if (component === "" || component === ".") continue;
      if (component === "..") {
        if (missingPrefix !== undefined) throw enoent(missingPrefix);
        resolved.pop();
        continue;
      }

      resolved.push(component);
      const candidate = pathOf(resolved);
      const node = nodes.get(candidate);
      if (node === undefined && missingPrefix === undefined) missingPrefix = candidate;
      const isFinal = index === pending.length - 1;
      if (node?.type !== "symlink" || (!followFinal && isFinal)) continue;

      if (follows >= MAX_FOLLOWS) throw eloop(path);
      follows++;

      resolved.pop();
      const target = node.link_target ?? "";
      requireAcceptedLength(target, path);
      if (target.startsWith("/")) resolved = [];
      pending = [...componentsOf(target), ...pending.slice(index + 1)];
      requireAcceptedComponents(resolved, pending, path);
      missingPrefix = undefined;
      expanded = true;
      break;
    }

    if (!expanded) return pathOf(resolved) as RealPath;
  }
}

/**
 * Canonicalise `path` and resolve every symlink on the way.
 *
 * One statement when nothing on the path is a symlink, which is the common
 * case; one more per symlink actually encountered.
 */
export function realpath(db: SqlDatabase, path: string): RealPath {
  return resolve(db, path, true);
}

/** Resolve ancestors through symlinks but leave a final named link alone. */
export function realpathNoFollow(db: SqlDatabase, path: string): RealPath {
  return resolve(db, path, false);
}
