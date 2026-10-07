// `realpath` — the sole producer of a `RealPath`, and the choke point the
// whole schema hangs on.
//
// `fs_paths.path` is always a real path: if `/a` is a symlink to `/b`, then
// `/a/c` is stored as `/b/c`. A lexical path reaching the store would
// shadow its own target and diverge from every POSIX filesystem. Every path
// entering the store passes through here first, so this is also where a
// caller path is rejected for not being well-formed UTF-8.

import { jsonStringEncodedBytes } from "@kompjutr/sqlite";
import type { SqlDatabase } from "../../db/db.js";
import { assertWellFormedPath, isCanonicalPath, prefixesOf } from "../path.js";
import type { RealPath } from "../types.js";

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
  return jsonStringEncodedBytes(path) + 1;
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
 * One resolution: an absolute `path`, optionally confined to `root`, a
 * canonical real directory that `path` lies in or under.
 */
interface Walk {
  readonly path: string;
  readonly root: string | null;
  /**
   * The root is the top of the namespace, as a chroot's is: `..` at it stays
   * and an absolute target starts from it. Otherwise both are breaches.
   */
  readonly top?: boolean;
}

function rootDepth(root: string): number {
  return root === "/" ? 0 : componentsOf(root).length;
}

function isUnder(path: string, root: string): boolean {
  return root === "/" ? path.startsWith("/") : path === root || path.startsWith(`${root}/`);
}

/** Every path the walk may look up, for the batched planning query. */
function candidatesOf(walk: Walk): string[] {
  const { path, root } = walk;
  if (root === null) {
    return isCanonicalPath(path) ? prefixesOf(path) : plannedPaths([], componentsOf(path));
  }
  if (isCanonicalPath(path)) return prefixesOf(path).slice(rootDepth(root));
  return plannedPaths(componentsOf(root), componentsOf(path.slice(root.length)));
}

/**
 * Resolve in component order. This matters for `file/..` and for a symlink
 * followed by `..`: lexical normalization before lookup gets both wrong.
 */
function resolveWalk(
  db: SqlDatabase,
  walk: Walk,
  followFinal: boolean,
  initialNodes?: ReadonlyMap<string, NodeRow>,
): RealPath | ConfinementBreach {
  const { path, root } = walk;
  assertWellFormedPath(path);
  if (root !== null && !isUnder(path, root)) return OUTSIDE;
  let nodes = initialNodes;
  if (isCanonicalPath(path)) {
    const prefixes = root === null ? prefixesOf(path) : prefixesOf(path).slice(rootDepth(root));
    nodes ??= nodesOn(db, prefixes);
    if (!followsSymlink(path, prefixes, followFinal, nodes)) return asRealPath(path);
  }
  const resolved =
    root === null
      ? resolveComponents(db, path, [], componentsOf(path), followFinal, nodes, null)
      : resolveComponents(
          db,
          path,
          componentsOf(root),
          componentsOf(path.slice(root.length)),
          followFinal,
          nodes,
          { depth: rootDepth(root), top: walk.top === true },
        );
  return typeof resolved === "string" ? asRealPath(resolved) : resolved;
}

function resolve(db: SqlDatabase, path: string, followFinal: boolean): RealPath {
  return confinedOrThrow(resolveWalk(db, { path, root: null }, followFinal), path);
}

function confinedOrThrow(resolved: RealPath | ConfinementBreach, path: string): RealPath {
  if (typeof resolved !== "string") throw enoent(path);
  return resolved;
}

/** The single place a string becomes a `RealPath`; every caller has resolved it. */
function asRealPath(path: string): RealPath {
  return path as RealPath;
}

/**
 * Where a confined walk would have left its root. `parent` is a `..` the
 * caller wrote at the root, with the caller components still pending after
 * it; `outside` is anything else — a symlink target that climbs out or is
 * absolute — and is never followed.
 */
export type ConfinementBreach =
  | { readonly breach: "parent"; readonly rest: readonly string[] }
  | { readonly breach: "outside" };

const OUTSIDE: ConfinementBreach = { breach: "outside" };

function resolveComponents(
  db: SqlDatabase,
  path: string,
  start: readonly string[],
  components: readonly string[],
  followFinal: boolean,
  initialNodes: ReadonlyMap<string, NodeRow> | undefined,
  confine: { readonly depth: number; readonly top: boolean } | null,
): string | ConfinementBreach {
  let resolved = [...start];
  let pending = [...components];
  // The caller's own components are always a suffix of `pending`.
  let callerTail = pending.length;
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
        if (confine !== null && resolved.length <= confine.depth) {
          if (confine.top) continue;
          if (index < pending.length - callerTail) return OUTSIDE;
          return { breach: "parent", rest: pending.slice(index + 1) };
        }
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
      if (target.startsWith("/")) {
        if (confine !== null && !confine.top) return OUTSIDE;
        resolved = confine === null ? [] : resolved.slice(0, confine.depth);
      }
      callerTail = Math.min(callerTail, pending.length - index - 1);
      pending = [...componentsOf(target), ...pending.slice(index + 1)];
      missingPrefix = undefined;
      expanded = true;
      break;
    }

    if (!expanded) return pathOf(resolved);
  }
}

function resolveMany(
  db: SqlDatabase,
  walks: readonly Walk[],
  followFinal: boolean,
): (RealPath | ConfinementBreach)[] {
  if (walks.length === 0) return [];
  const out: (RealPath | ConfinementBreach)[] = [];
  let group: Walk[] = [];
  const planned = new Set<string>();
  let plannedBytes = 2;

  const flush = (): void => {
    if (group.length === 0) return;
    const initialNodes = nodesOn(db, [...planned]);
    for (const walk of group) out.push(resolveWalk(db, walk, followFinal, initialNodes));
    group = [];
    planned.clear();
    plannedBytes = 2;
  };

  for (const walk of walks) {
    // Ahead of the planning binding, so a malformed path never reaches SQL.
    assertWellFormedPath(walk.path);
    const candidates =
      walk.root === null || isUnder(walk.path, walk.root) ? candidatesOf(walk) : [];
    const candidateBytes = candidates.map(jsonItemBytes);
    let addedBytes = 0;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate !== undefined && !planned.has(candidate)) {
        addedBytes += candidateBytes[index] ?? 0;
      }
    }
    if (group.length > 0 && plannedBytes + addedBytes > PATH_BATCH_BYTES) flush();
    group.push(walk);
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

function resolveAll(db: SqlDatabase, paths: readonly string[], followFinal: boolean): RealPath[] {
  const resolved = resolveMany(
    db,
    paths.map((path) => ({ path, root: null })),
    followFinal,
  );
  return resolved.map((real, index) => confinedOrThrow(real, paths[index] ?? ""));
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
  return resolveAll(db, paths, true);
}

/** Resolve many ancestors while leaving every final named symlink intact. */
export function realpathsNoFollow(db: SqlDatabase, paths: readonly string[]): RealPath[] {
  return resolveAll(db, paths, false);
}

/** Path resolution as the single-path operations and batch writes consume it. */
export interface PathResolver {
  realpath(path: string): RealPath;
  realpathNoFollow(path: string): RealPath;
  realpathsNoFollow(paths: readonly string[]): RealPath[];
}

export function storeResolver(db: SqlDatabase): PathResolver {
  return {
    realpath: (path) => realpath(db, path),
    realpathNoFollow: (path) => realpathNoFollow(db, path),
    realpathsNoFollow: (paths) => realpathsNoFollow(db, paths),
  };
}

/**
 * Resolve `path`, which lies in or under the real directory `root`, without
 * ever leaving `root`. The walk starts at `root`, so the root's own
 * ancestors are not looked up, and it costs what an unconfined resolution
 * costs. A symlink that climbs out or is absolute is a breach, not a follow.
 */
export function resolveWithin(
  db: SqlDatabase,
  root: string,
  path: string,
  followFinal: boolean,
  top = false,
): RealPath | ConfinementBreach {
  return resolveWalk(db, { path, root, top }, followFinal);
}

/** `resolveWithin` for many paths, each under its own root, in one batch. */
export function resolveManyWithin(
  db: SqlDatabase,
  walks: readonly { readonly root: string; readonly path: string; readonly top?: boolean }[],
  followFinal: boolean,
): (RealPath | ConfinementBreach)[] {
  return resolveMany(db, walks, followFinal);
}

/** A resolver whose every breach reads as an absent path. */
export function confinedResolver(db: SqlDatabase, root: string, top = false): PathResolver {
  const one = (path: string, followFinal: boolean): RealPath =>
    confinedOrThrow(resolveWalk(db, { path, root, top }, followFinal), path);
  return {
    realpath: (path) => one(path, true),
    realpathNoFollow: (path) => one(path, false),
    realpathsNoFollow: (paths) =>
      resolveMany(
        db,
        paths.map((path) => ({ path, root, top })),
        false,
      ).map((real, index) => confinedOrThrow(real, paths[index] ?? "")),
  };
}

/**
 * A canonical path no stored symlink can affect, such as a mounted view's
 * synthetic directory or a path the view reports as absent.
 */
export function unstoredRealPath(path: string): RealPath {
  if (!isCanonicalPath(path)) throw enoent(path);
  return asRealPath(path);
}

/**
 * Move a resolved path from under `from` to the same place under `to`. Both
 * are canonical directories with no symlink between them and the path, so
 * the result is resolved too.
 */
export function rebaseRealPath(path: RealPath, from: string, to: string): RealPath {
  const rest = from === "/" ? (path === "/" ? "" : path) : path.slice(from.length);
  if (to === "/") return asRealPath(rest === "" ? "/" : rest);
  return asRealPath(`${to}${rest}`);
}
