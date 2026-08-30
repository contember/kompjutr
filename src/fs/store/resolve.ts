// `realpath` — the sole producer of a `RealPath`, and the choke point the
// whole schema hangs on.
//
// `fs_paths.path` is always a real path: if `/a` is a symlink to `/b`, then
// `/a/c` is stored as `/b/c`. A lexical path reaching the store would
// shadow its own target and diverge from every POSIX filesystem. Every path
// entering the store passes through here first.

import type { MemoryReservation } from "../../memory.js";
import type { SqlDatabase } from "../../sqlite/db.js";
import type { RealPath } from "../types.js";

/** POSIX's own guidance; dofs counts follows the same way. */
const MAX_FOLLOWS = 40;

/** Bounds the quadratic prefix set below to comfortably less than 100 MB. */
export const MAX_PATH_CODE_UNITS = 4096;

/** Keeps every `json_each` binding below the platform BLOB/TEXT ceiling. */
const PATH_BATCH_BYTES = 1_500_000;

const ENCODER = new TextEncoder();
const ARRAY_FIXED_BYTES = 64;
const ARRAY_SLOT_BYTES = 8;
const STRING_FIXED_BYTES = 48;
const BYTE_ARRAY_FIXED_BYTES = 64;
const SET_FIXED_BYTES = 128;
const SET_ENTRY_BYTES = 48;
const MAP_FIXED_BYTES = 128;
const MAP_ENTRY_BYTES = 48;
const NODE_ROW_BYTES = 128;
// SQLite substr() counts code points; each returned point may occupy two UTF-16 units.
const MAX_STORED_LINK_TARGET_UNITS = (MAX_PATH_CODE_UNITS + 1) * 2;
const RESOLVE_FIXED_BYTES = 512;

interface NodeRow {
  path: string;
  type: string;
  link_target: string | null;
}

function retainedStringUnits(units: number): number {
  return STRING_FIXED_BYTES + units * 2;
}

function componentCount(path: string): number {
  if (path === "" || /^\/+$/u.test(path)) return 0;
  let count = 1;
  for (let index = path.startsWith("/") ? 1 : 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) count++;
  }
  return count;
}

function componentsAllocationBytes(path: string): number {
  const count = componentCount(path);
  return (
    ARRAY_FIXED_BYTES +
    count * (ARRAY_SLOT_BYTES + STRING_FIXED_BYTES) +
    path.length * 2 +
    retainedStringUnits(path.length)
  );
}

function componentStateBytes(resolved: readonly string[], pending: readonly string[]): number {
  let bytes = 2 * ARRAY_FIXED_BYTES;
  for (const component of resolved) {
    bytes += ARRAY_SLOT_BYTES + retainedStringUnits(component.length);
  }
  for (const component of pending) {
    bytes += ARRAY_SLOT_BYTES + retainedStringUnits(component.length);
  }
  return bytes;
}

function componentStateMaximumBytes(
  resolved: readonly string[],
  pending: readonly string[],
): number {
  return componentStateBytes(resolved, pending) + pending.length * ARRAY_SLOT_BYTES;
}

function pathLength(parts: readonly string[]): number {
  if (parts.length === 0) return 1;
  let units = parts.length;
  for (const part of parts) units += part.length;
  return units;
}

function plannedPathsAllocationBytes(
  resolved: readonly string[],
  pending: readonly string[],
): number {
  let currentUnits = pathLength(resolved);
  let stringBytes = retainedStringUnits(currentUnits);
  let retainedPaths = 1;
  for (const component of pending) {
    if (component === "" || component === ".") continue;
    if (component !== "..") {
      currentUnits = Math.min(
        MAX_PATH_CODE_UNITS,
        currentUnits + (currentUnits === 1 ? 0 : 1) + component.length,
      );
    }
    stringBytes += retainedStringUnits(currentUnits);
    retainedPaths++;
  }
  return (
    2 * ARRAY_FIXED_BYTES +
    (resolved.length + retainedPaths) * ARRAY_SLOT_BYTES +
    SET_FIXED_BYTES +
    retainedPaths * SET_ENTRY_BYTES +
    stringBytes +
    2 * retainedStringUnits(MAX_PATH_CODE_UNITS)
  );
}

function jsonStringSize(value: string): { bytes: number; units: number } {
  let bytes = 2;
  let units = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
      units += 2;
    } else if (code < 0x20) {
      bytes += 6;
      units += 6;
    } else if (code < 0x80) {
      bytes++;
      units++;
    } else if (code < 0x800) {
      bytes += 2;
      units++;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        units += 2;
        index++;
      } else {
        bytes += 6;
        units += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
      units += 6;
    } else {
      bytes += 3;
      units++;
    }
  }
  return { bytes, units };
}

function nodesAllocationBytes(paths: readonly string[]): number {
  let retainedRows = MAP_FIXED_BYTES;
  let batchBytes = 2;
  let batchItems = 0;
  let batchItemUnits = 0;
  let maximumBatchBytes = 0;
  let maximumItemBytes = 0;
  const flush = (): void => {
    if (batchItems === 0) return;
    const jsonUnits = batchItemUnits + batchItems - 1 + 2;
    maximumBatchBytes = Math.max(
      maximumBatchBytes,
      ARRAY_FIXED_BYTES +
        batchItems * ARRAY_SLOT_BYTES +
        batchItems * STRING_FIXED_BYTES +
        batchItemUnits * 2 +
        2 * retainedStringUnits(jsonUnits) +
        ARRAY_FIXED_BYTES +
        batchItems * ARRAY_SLOT_BYTES,
    );
    batchBytes = 2;
    batchItems = 0;
    batchItemUnits = 0;
  };

  for (const path of paths) {
    const item = jsonStringSize(path);
    if (batchItems > 0 && batchBytes + item.bytes + 1 > PATH_BATCH_BYTES) flush();
    batchItems++;
    batchBytes += item.bytes + 1;
    batchItemUnits += item.units;
    maximumItemBytes = Math.max(maximumItemBytes, item.bytes);
    retainedRows +=
      MAP_ENTRY_BYTES +
      NODE_ROW_BYTES +
      retainedStringUnits(path.length) +
      retainedStringUnits("symlink".length) +
      retainedStringUnits(MAX_STORED_LINK_TARGET_UNITS);
  }
  flush();
  return retainedRows + maximumBatchBytes + BYTE_ARRAY_FIXED_BYTES + maximumItemBytes;
}

function symlinkTransitionBytes(target: string, suffixCount: number): number {
  const targetComponents = componentCount(target);
  return (
    componentsAllocationBytes(target) +
    3 * ARRAY_FIXED_BYTES +
    (2 * targetComponents + 2 * suffixCount) * ARRAY_SLOT_BYTES +
    (targetComponents + suffixCount) * ARRAY_SLOT_BYTES
  );
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
      `SELECT p.path AS path,
              CASE
                WHEN typeof(n.type) = 'text' AND n.type = 'dir' THEN 'dir'
                WHEN typeof(n.type) = 'text' AND n.type = 'file' THEN 'file'
                WHEN typeof(n.type) = 'text' AND n.type = 'symlink' THEN 'symlink'
                ELSE ''
              END AS type,
              substr(n.link_target, 1, 4097) AS link_target
         FROM fs_paths p
         JOIN fs_nodes n ON n.inode = p.inode
        WHERE p.path IN (SELECT value FROM json_each(?))`,
      `[${items.join(",")}]`,
    )) {
      if (row.type !== "dir" && row.type !== "file" && row.type !== "symlink") {
        throw new Error("fs_nodes.type is not a known entry type");
      }
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
  reservation?: MemoryReservation,
): RealPath {
  requireAcceptedLength(path, path);
  const stateMemory = reservation?.scope() ?? null;
  stateMemory?.set(
    "other",
    RESOLVE_FIXED_BYTES + ARRAY_FIXED_BYTES + componentsAllocationBytes(path),
  );
  let resolved: string[] = [];
  let pending: string[];
  try {
    pending = componentsOf(path);
    stateMemory?.set("other", RESOLVE_FIXED_BYTES + componentStateMaximumBytes(resolved, pending));
  } catch (error) {
    stateMemory?.dispose();
    throw error;
  }
  let follows = 0;
  let missingPrefix: string | undefined;

  try {
    for (;;) {
      const iterationMemory = reservation?.scope() ?? null;
      try {
        stateMemory?.set(
          "other",
          RESOLVE_FIXED_BYTES + componentStateMaximumBytes(resolved, pending),
        );
        iterationMemory?.set("other", plannedPathsAllocationBytes(resolved, pending));
        const paths = plannedPaths(resolved, pending);
        iterationMemory?.set(
          "other",
          plannedPathsAllocationBytes(resolved, pending) + nodesAllocationBytes(paths),
        );
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
          requireAcceptedLength(target, path);
          const transitionMemory = reservation?.scope() ?? null;
          try {
            transitionMemory?.set(
              "other",
              symlinkTransitionBytes(target, pending.length - index - 1),
            );
            if (target.startsWith("/")) resolved = [];
            pending = [...componentsOf(target), ...pending.slice(index + 1)];
            stateMemory?.set(
              "other",
              RESOLVE_FIXED_BYTES + componentStateMaximumBytes(resolved, pending),
            );
            requireAcceptedComponents(resolved, pending, path);
          } finally {
            transitionMemory?.dispose();
          }
          missingPrefix = undefined;
          expanded = true;
          break;
        }

        if (!expanded) {
          const result = pathOf(resolved) as RealPath;
          iterationMemory?.dispose();
          stateMemory?.dispose();
          reservation?.set("other", retainedStringUnits(result.length));
          return result;
        }
      } finally {
        iterationMemory?.dispose();
      }
    }
  } finally {
    stateMemory?.dispose();
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

/** Native resolver whose live prefix, JSON, row and component state is caller-owned. */
export function realpathOwned(
  db: SqlDatabase,
  path: string,
  reservation: MemoryReservation,
): RealPath {
  return resolve(db, path, true, undefined, reservation);
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
