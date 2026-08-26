import type { SqlDatabase } from "../sqlite/db.js";
import { filesystemError } from "./errors.js";
import { normalize } from "./path.js";

export type ExactPathState = "present" | "missing";

/** Optional bulk capability for consumers that already hold canonical real paths. */
export interface ExactPathStateSource {
  states(paths: readonly string[]): readonly ExactPathState[];
}

const MAX_PATHS = 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_JSON_BYTES = 1_500_000;
const ENCODER = new TextEncoder();

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
       node.type AS node_type
  FROM requested
  LEFT JOIN fs_paths stored ON stored.path = requested.path
  LEFT JOIN fs_nodes node ON node.inode = stored.inode
 ORDER BY requested.ordinal`;

function utf8Length(value: string): number {
  return ENCODER.encode(value).byteLength;
}

function validatePath(path: unknown): string {
  if (typeof path !== "string") {
    throw filesystemError("EINVAL", "exact path must be a string");
  }
  if (path.length > MAX_PATH_BYTES) {
    throw filesystemError("E2BIG", `exact path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, path);
  }
  if (utf8Length(path) > MAX_PATH_BYTES) {
    throw filesystemError("E2BIG", `exact path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, path);
  }
  if (path.includes("\0") || !path.startsWith("/") || normalize(path) !== path) {
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
    if (row.path_inode !== null || row.node_inode !== null || row.node_type !== null) {
      throw filesystemError("EIO", "missing exact path returned persisted node state");
    }
    return "missing";
  }
  if (row.stored_path !== row.path) {
    throw filesystemError("EIO", "exact path state query crossed path boundaries");
  }
  if (
    typeof row.path_inode !== "number" ||
    !Number.isSafeInteger(row.path_inode) ||
    row.path_inode < 1 ||
    row.node_inode !== row.path_inode ||
    (row.node_type !== "file" && row.node_type !== "dir" && row.node_type !== "symlink")
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
  for (const path of paths) validated.push(validatePath(path));
  const result: ExactPathState[] = [];
  let pagePaths: string[] = [];
  let pageItems: string[] = [];
  let pageBytes = 2;

  const flush = (): void => {
    if (pagePaths.length === 0) return;
    let ordinal = 0;
    for (const row of db.iterate(STATES_SQL, `[${pageItems.join(",")}]`)) {
      result.push(validateRow(row, pagePaths, ordinal));
      ordinal++;
    }
    if (ordinal !== pagePaths.length) {
      throw filesystemError("EIO", "exact path state query returned an incomplete page");
    }
    pagePaths = [];
    pageItems = [];
    pageBytes = 2;
  };

  for (const path of validated) {
    const item = JSON.stringify(path);
    const separatorBytes = pageItems.length === 0 ? 0 : 1;
    const nextBytes = pageBytes + separatorBytes + utf8Length(item);
    if (pageItems.length > 0 && nextBytes > MAX_JSON_BYTES) flush();
    pagePaths.push(path);
    pageItems.push(item);
    pageBytes += (pageItems.length === 1 ? 0 : 1) + utf8Length(item);
  }
  flush();

  if (result.length !== validated.length) {
    throw filesystemError("EIO", "exact path state query returned an invalid result length");
  }
  return Object.freeze(result);
}

export function createExactPathStateSource(db: SqlDatabase): ExactPathStateSource {
  return { states: (paths) => states(db, paths) };
}
