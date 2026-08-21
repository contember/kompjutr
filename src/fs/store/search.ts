// Content search as a SQL predicate.
//
// `discoverFiles` narrows by path; this narrows by *content*, so the bytes of
// a file that cannot match never leave the database. Over 6,000 files the
// difference measured 24 statements against 1, and — the part that matters
// more on a Durable Object — the whole tree no longer passes through the
// isolate's heap to be tested.
//
// `instr()` over a BLOB is a byte search, so the needle is compared exactly
// and no encoding is involved on either side.
//
// The one thing it cannot decide is a needle that straddles a chunk
// boundary. Content is stored in CHUNK_SIZE pieces and `instr` sees one
// piece at a time, so a file of more than one chunk may contain the needle
// without any single chunk containing it. Those files come back as
// `undecided` rather than being dropped: a false negative here would be a
// search that silently misses a file, which is worse than a slow one.

import type { SqlDatabase } from "../../sqlite/db.js";
import { comparePaths } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type {
  ContentSearchOptions,
  ContentSearchPage,
  RealPath,
  RegularFileHandle,
} from "../types.js";

/** The longest needle worth pushing down. Longer ones are rare and the */
/** straddle risk grows with length. */
export const NEEDLE_MAX_BYTES = 1024;

/**
 * One page of files under `root` whose path matches `pattern`, split by what
 * `instr` could prove.
 *
 * `size <= CHUNK_SIZE` is the decidable case: the file is a single chunk, so
 * a chunk that does not contain the needle proves the file does not either.
 * Anything larger is reported undecided and the caller reads it.
 */
function searchSql(excludeBinary: boolean): string {
  // `X'00'` is a one-byte blob, and `instr` over two blobs is a byte search,
  // so this is the same NUL test the isolate would run — one row earlier.
  const binary = excludeBinary
    ? `,
       max(CASE WHEN instr(fs_chunks.bytes, X'00') > 0 THEN 1 ELSE 0 END) AS nul`
    : "";
  const having = excludeBinary
    ? "(hit = 1 AND nul = 0) OR single_chunk = 0"
    : "hit = 1 OR single_chunk = 0";
  return `SELECT fs_paths.path AS path,
       fs_paths.inode AS inode,
       fs_nodes.size AS size,
       fs_nodes.rev AS rev,
       CASE WHEN fs_nodes.size <= ? THEN 1 ELSE 0 END AS single_chunk,
       max(CASE WHEN instr(fs_chunks.bytes, ?) > 0 THEN 1 ELSE 0 END) AS hit${binary}
  FROM fs_paths
  JOIN fs_nodes ON fs_nodes.inode = fs_paths.inode
  LEFT JOIN fs_chunks ON fs_chunks.inode = fs_paths.inode
 WHERE fs_paths.path > ? AND fs_paths.path < ?
   AND fs_paths.path GLOB ?
   AND fs_nodes.type = 'file'
 GROUP BY fs_paths.path, fs_paths.inode, fs_nodes.size, fs_nodes.rev
HAVING ${having}
 ORDER BY fs_paths.path
 LIMIT ?`;
}

// Two statements rather than one that always computes the NUL aggregate:
// the extra `instr` per chunk is only worth paying when the caller asked.
const SEARCH_SQL = searchSql(false);
const SEARCH_SQL_TEXT_ONLY = searchSql(true);

interface SearchRow {
  path: RealPath;
  inode: number;
  size: number;
  rev: number;
  single_chunk: number;
  hit: number;
}

export function discoverFilesContaining(
  db: SqlDatabase,
  root: RealPath,
  pattern: string,
  needle: Uint8Array,
  options: ContentSearchOptions = {},
): ContentSearchPage {
  if (needle.length === 0) {
    throw new Error("discoverFilesContaining: needle must not be empty");
  }
  if (needle.length > NEEDLE_MAX_BYTES) {
    throw new Error(
      `discoverFilesContaining: needle is ${needle.length} bytes; the ceiling is ${NEEDLE_MAX_BYTES}`,
    );
  }

  const lower = root === "/" ? "/" : `${root}/`;
  const upper = root === "/" ? "0" : `${root}0`;
  const limit = options.limit ?? 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error(`discoverFilesContaining: limit must be an integer from 1 to 1000`);
  }

  // Keyset paging, exclusive of the cursor, exactly as `discoverFiles`
  // pages. No real path equals the bare `root + "/"` bound, so `>` loses
  // nothing on the first page.
  const after =
    options.after !== undefined && comparePaths(options.after, lower) > 0 ? options.after : lower;

  const sql = options.excludeBinary === true ? SEARCH_SQL_TEXT_ONLY : SEARCH_SQL;
  const rows = db.all<SearchRow>(sql, CHUNK_SIZE, needle, after, upper, pattern, limit + 1);

  const page = rows.slice(0, limit);
  const matched: RegularFileHandle[] = [];
  const undecided: RegularFileHandle[] = [];
  for (const row of page) {
    const handle: RegularFileHandle = {
      path: row.path,
      ino: row.inode,
      size: row.size,
      rev: row.rev,
    };
    // A single-chunk hit is proven. Everything else the caller verifies.
    if (row.single_chunk === 1 && row.hit === 1) matched.push(handle);
    else undecided.push(handle);
  }

  return {
    matched,
    undecided,
    next: rows.length > limit ? (page[page.length - 1]?.path ?? null) : null,
  };
}
