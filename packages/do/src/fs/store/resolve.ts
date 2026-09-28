// `realpath` — the sole producer of a `RealPath`, and the choke point the
// whole schema hangs on.
//
// `fs_paths.path` is always a real path: if `/a` is a symlink to `/b`, then
// `/a/c` is stored as `/b/c`. A lexical path reaching the store would
// shadow its own target and diverge from every POSIX filesystem. Every path
// entering the store passes through here first, so this is also where a
// caller path is rejected for not being well-formed UTF-8.

import type { SqlDatabase } from "../../db/db.js";
import { assertWellFormedPath, isCanonicalPath, prefixesOf } from "../path.js";
import type { RealPath } from "../types.js";
import { utf8Length } from "./write/write-batches.js";

/** POSIX's own guidance; dofs counts follows the same way. */
const MAX_FOLLOWS = 40;

/** Keeps every `json_each` binding below the platform BLOB/TEXT ceiling. */
const PATH_BATCH_BYTES = 1_500_000;

interface NodeRow {
  type: "dir" | "file" | "symlink";
  link_target: string | null;
}

interface NodeLookupRow {
  ordinal: unknown;
  type: unknown;
  link_target: unknown;
}

// Rows name their path by binding ordinal, so no stored path is copied back.
const NODES_ON_SQL = `SELECT j.key AS ordinal,
       CASE
         WHEN typeof(n.type) = 'text' AND n.type = 'dir' THEN 'dir'
         WHEN typeof(n.type) = 'text' AND n.type = 'file' THEN 'file'
         WHEN typeof(n.type) = 'text' AND n.type = 'symlink' THEN 'symlink'
         ELSE ''
       END AS type,
       n.link_target AS link_target
  FROM json_each(?) j
  JOIN fs_paths p ON p.path = j.value
  JOIN fs_nodes n ON n.inode = p.inode`;

function jsonItemBytes(path: string): number {
  return utf8Length(JSON.stringify(path)) + 1;
}

/**
 * Fetch every node the ordered walk may inspect. `json_each` keeps this one
 * indexed statement regardless of depth; a symlink expansion starts a new
 * batch because only then is the next set of real prefixes known.
 */
function nodesOn(db: SqlDatabase, paths: readonly string[]): Map<string, NodeRow> {
  const out = new Map<string, NodeRow>();
  let batch: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (batch.length === 0) return;
    for (const row of db.all<NodeLookupRow>(NODES_ON_SQL, JSON.stringify(batch))) {
      const path = typeof row.ordinal === "number" ? batch[row.ordinal] : undefined;
      const type = row.type;
      const target = row.link_target;
      if (
        path === undefined ||
        (type !== "dir" && type !== "file" && type !== "symlink") ||
        (target !== null && typeof target !== "string")
      ) {
        throw new Error("path resolution row is invalid");
      }
      out.set(path, { type, link_target: target });
    }
    batch = [];
    bytes = 2;
  };

  for (const path of paths) {
    const itemBytes = jsonItemBytes(path);
    if (batch.length > 0 && bytes + itemBytes > PATH_BATCH_BYTES) flush();
    batch.push(path);
    bytes += itemBytes;
  }
  flush();
  return out;
}

/** Whether the ordered walk of a canonical path must expand a symlink. */
function followsSymlink(
  path: string,
  prefixes: readonly string[],
  followFinal: boolean,
  nodes: ReadonlyMap<string, NodeRow>,
): boolean {
  for (let index = 1; index < prefixes.length; index++) {
    const parent = prefixes[index - 1];
    const candidate = prefixes[index];
    if (parent === undefined || candidate === undefined) continue;
    requireDirectory(nodes.get(parent), path);
    const isFinal = index === prefixes.length - 1;
    if (nodes.get(candidate)?.type === "symlink" && (followFinal || !isFinal)) return true;
  }
  return false;
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
  assertWellFormedPath(path);
  let nodes = initialNodes;
  let real: string | null = null;
  if (isCanonicalPath(path)) {
    const prefixes = prefixesOf(path);
    nodes ??= nodesOn(db, prefixes);
    if (!followsSymlink(path, prefixes, followFinal, nodes)) real = path;
  }
  return (real ?? resolveComponents(db, path, followFinal, nodes)) as RealPath;
}

function resolveComponents(
  db: SqlDatabase,
  path: string,
  followFinal: boolean,
  initialNodes: ReadonlyMap<string, NodeRow> | undefined,
): string {
  let resolved: string[] = [];
  let pending = componentsOf(path);
  let follows = 0;
  let missingPrefix: string | undefined;

  for (;;) {
    const paths = plannedPaths(resolved, pending);
    const nodes = initialNodes ?? nodesOn(db, paths);
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
      if (target.startsWith("/")) resolved = [];
      pending = [...componentsOf(target), ...pending.slice(index + 1)];
      missingPrefix = undefined;
      expanded = true;
      break;
    }

    if (!expanded) return pathOf(resolved);
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
    // Ahead of the planning binding, so a malformed path never reaches SQL.
    assertWellFormedPath(path);
    const candidates = isCanonicalPath(path)
      ? prefixesOf(path)
      : plannedPaths([], componentsOf(path));
    const candidateBytes = candidates.map(jsonItemBytes);
    let addedBytes = 0;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate !== undefined && !planned.has(candidate)) {
        addedBytes += candidateBytes[index] ?? 0;
      }
    }
    if (group.length > 0 && plannedBytes + addedBytes > PATH_BATCH_BYTES) flush();
    group.push(path);
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate === undefined || planned.has(candidate)) continue;
      planned.add(candidate);
      plannedBytes += candidateBytes[index] ?? 0;
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
