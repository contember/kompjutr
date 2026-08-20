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

/** Keeps every `json_each` binding below the platform BLOB/TEXT ceiling. */
const PATH_BATCH_BYTES = 1_500_000;

const ENCODER = new TextEncoder();

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
  const out = new Map<string, NodeRow>();
  let items: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (items.length === 0) return;
    for (const row of db.all<NodeRow>(
      `SELECT p.path AS path, n.type AS type,
              substr(n.link_target, 1, 4097) AS link_target
         FROM fs_paths p
         JOIN fs_nodes n ON n.inode = p.inode
        WHERE p.path IN (SELECT value FROM json_each(?))`,
      `[${items.join(",")}]`,
    )) {
      out.set(row.path, row);
    }
    items = [];
    bytes = 2;
  };

  for (const path of paths) {
    const item = JSON.stringify(path);
    const itemBytes = ENCODER.encode(item).byteLength;
    if (items.length > 0 && bytes + itemBytes + 1 > PATH_BATCH_BYTES) flush();
    items.push(item);
    bytes += itemBytes + 1;
  }
  flush();
  return out;
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
function resolve(
  db: SqlDatabase,
  path: string,
  followFinal: boolean,
  initialNodes?: ReadonlyMap<string, NodeRow>,
): RealPath {
  requireAcceptedLength(path, path);
  let resolved: string[] = [];
  let pending = componentsOf(path);
  let follows = 0;
  let missingPrefix: string | undefined;

  for (;;) {
    const nodes = initialNodes ?? nodesOn(db, plannedPaths(resolved, pending));
    initialNodes = undefined;
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

function resolveMany(db: SqlDatabase, paths: readonly string[], followFinal: boolean): RealPath[] {
  if (paths.length === 0) return [];
  const out: RealPath[] = [];
  let group: string[] = [];
  const planned = new Set<string>();
  let plannedBytes = 2;

  const flush = (): void => {
    if (group.length === 0) return;
    const initialNodes = nodesOn(db, [...planned]);
    for (const path of group) out.push(resolve(db, path, followFinal, initialNodes));
    group = [];
    planned.clear();
    plannedBytes = 2;
  };

  for (const path of paths) {
    requireAcceptedLength(path, path);
    const candidates = plannedPaths([], componentsOf(path));
    let addedBytes = 0;
    for (const candidate of candidates) {
      if (!planned.has(candidate))
        addedBytes += ENCODER.encode(JSON.stringify(candidate)).byteLength + 1;
    }
    if (group.length > 0 && plannedBytes + addedBytes > PATH_BATCH_BYTES) flush();
    group.push(path);
    for (const candidate of candidates) {
      if (planned.has(candidate)) continue;
      planned.add(candidate);
      plannedBytes += ENCODER.encode(JSON.stringify(candidate)).byteLength + 1;
    }
  }
  flush();
  return out;
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

/** Resolve many paths with one indexed ancestor query in the common case. */
export function realpaths(db: SqlDatabase, paths: readonly string[]): RealPath[] {
  return resolveMany(db, paths, true);
}

/** Resolve many ancestors while leaving every final named symlink intact. */
export function realpathsNoFollow(db: SqlDatabase, paths: readonly string[]): RealPath[] {
  return resolveMany(db, paths, false);
}
