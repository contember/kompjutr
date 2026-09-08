import {
  type ExactPathState,
  type ExactPathStateSource,
  registerExactPathStates,
} from "@kompjutr/drive";
import type { SqlDatabase } from "../db/db.js";
import { filesystemError } from "./errors.js";

export type { ExactPathState, ExactPathStateSource } from "@kompjutr/drive";

const MAX_PATHS = 1_024;
const MAX_JSON_BYTES = 1_500_000;

const STATES_SQL = `
WITH requested AS (
  SELECT CAST(key AS INTEGER) AS ordinal, value AS path
    FROM json_each(?)
)
SELECT requested.ordinal AS ordinal,
       requested.path AS path,
       stored.path AS stored_path,
       stored.inode AS path_inode,
       node.inode AS node_inode,
       typeof(node.type) AS node_type_storage,
       length(CAST(node.type AS BLOB)) AS node_type_bytes,
       CASE
         WHEN node.type = 'file' THEN 'file'
         WHEN node.type = 'dir' THEN 'dir'
         WHEN node.type = 'symlink' THEN 'symlink'
         WHEN node.type IS NULL THEN NULL
         ELSE 'invalid'
       END AS node_type
  FROM requested
  LEFT JOIN fs_paths stored ON stored.path = requested.path
  LEFT JOIN fs_nodes node ON node.inode = stored.inode
 ORDER BY requested.ordinal`;

function jsonStringBytes(value: string): number {
  let bytes = 2;
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
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes++;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isCanonical(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  let segmentStart = 1;
  for (let index = 1; index <= path.length; index++) {
    if (index < path.length && path.charCodeAt(index) !== 0x2f) continue;
    const length = index - segmentStart;
    if (
      length === 0 ||
      (length === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
      (length === 2 &&
        path.charCodeAt(segmentStart) === 0x2e &&
        path.charCodeAt(segmentStart + 1) === 0x2e)
    ) {
      return false;
    }
    segmentStart = index + 1;
  }
  return true;
}

function validatePath(path: unknown): string {
  if (typeof path !== "string") {
    throw filesystemError("EINVAL", "exact path must be a string");
  }
  if (!isCanonical(path)) {
    throw filesystemError("EINVAL", "exact path is not canonical", path);
  }
  return path;
}

function validateRow(
  row: Record<string, unknown>,
  paths: readonly string[],
  expectedOrdinal: number,
): ExactPathState {
  if (row.ordinal !== expectedOrdinal || row.path !== paths[expectedOrdinal]) {
    throw filesystemError("EIO", "exact path state query returned an invalid row order");
  }
  if (row.stored_path === null) {
    if (
      row.path_inode !== null ||
      row.node_inode !== null ||
      row.node_type_storage !== "null" ||
      row.node_type_bytes !== null ||
      row.node_type !== null
    ) {
      throw filesystemError("EIO", "missing exact path returned persisted node state");
    }
    return "missing";
  }
  if (row.stored_path !== row.path) {
    throw filesystemError("EIO", "exact path state query crossed path boundaries");
  }
  const expectedTypeBytes =
    row.node_type === "file"
      ? 4
      : row.node_type === "dir"
        ? 3
        : row.node_type === "symlink"
          ? 7
          : null;
  if (
    typeof row.path_inode !== "number" ||
    !Number.isSafeInteger(row.path_inode) ||
    row.path_inode < 1 ||
    row.node_inode !== row.path_inode ||
    row.node_type_storage !== "text" ||
    typeof row.node_type_bytes !== "number" ||
    !Number.isSafeInteger(row.node_type_bytes) ||
    expectedTypeBytes === null ||
    row.node_type_bytes !== expectedTypeBytes
  ) {
    throw filesystemError("EIO", "exact path state query returned an invalid node");
  }
  return "present";
}

function states(db: SqlDatabase, paths: readonly string[]): readonly ExactPathState[] {
  if (paths.length > MAX_PATHS) {
    throw filesystemError("E2BIG", `exact path lookup accepts at most ${MAX_PATHS} paths`);
  }

  const validated: string[] = [];
  const pagePaths: string[] = [];
  const pageItems: string[] = [];
  const result: ExactPathState[] = [];
  let pageBytes = 2;

  const flush = (): void => {
    if (pagePaths.length === 0) return;
    let ordinal = 0;
    const joined = pageItems.join(",");
    const framed = `[${joined}]`;
    for (const row of db.iterate(STATES_SQL, framed)) {
      result.push(validateRow(row, pagePaths, ordinal));
      ordinal++;
    }
    if (ordinal !== pagePaths.length) {
      throw filesystemError("EIO", "exact path state query returned an incomplete page");
    }
    pagePaths.length = 0;
    pageItems.length = 0;
    pageBytes = 2;
  };

  for (const path of paths) validated.push(validatePath(path));
  for (const path of validated) {
    const itemBytes = jsonStringBytes(path);
    const separatorBytes = pageItems.length === 0 ? 0 : 1;
    const nextBytes = pageBytes + separatorBytes + itemBytes;
    if (pageItems.length > 0 && nextBytes > MAX_JSON_BYTES) flush();
    pagePaths.push(path);
    pageItems.push(JSON.stringify(path));
    pageBytes += (pageItems.length === 1 ? 0 : 1) + itemBytes;
  }
  flush();

  if (result.length !== validated.length) {
    throw filesystemError("EIO", "exact path state query returned an invalid result length");
  }
  return Object.freeze(result);
}

export function createExactPathStateSource(db: SqlDatabase): ExactPathStateSource {
  const source: ExactPathStateSource = {
    states: (paths) => states(db, paths),
  };
  registerExactPathStates(source, (paths) => states(db, paths));
  return source;
}
