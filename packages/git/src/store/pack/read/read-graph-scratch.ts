// SQL and row decoders for the owner-scoped discovery frontier of one paged
// packed read. Every statement is a primary-key prefix seek or a page-sized
// JSON batch on `git_pack_read_*`: one statement reads a whole step's frontier
// and one advances it, so scratch cost follows pages, never origin count.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import { int, RowShape, text } from "../../../common/rows.js";
import { jsonPages } from "../../core/json-pages.js";
import { MAX_DELTA_DEPTH, MAX_PACK_BLOB_GRAPH_ENTRIES, MAX_PACK_BLOB_INPUTS } from "../shared.js";
import {
  PACK_GRAPH_BASE_STEP,
  PACK_GRAPH_ENTRY_SELECT,
  packGraphStartsSql,
} from "./read-graph-sql.js";
import type { PackReadScope } from "./read-scope.js";

const INVALID_FRONTIER = "paged pack frontier state is invalid";

const ROOT_ROW = new RowShape(
  { oid: text(INVALID_FRONTIER).where(isOid, INVALID_FRONTIER) },
  INVALID_FRONTIER,
);

const FRONTIER_ROW = new RowShape(
  {
    oid: text(INVALID_FRONTIER).where(isOid, INVALID_FRONTIER),
    origin_id: int(0, MAX_PACK_BLOB_INPUTS - 1, INVALID_FRONTIER),
    depth: int(0, MAX_DELTA_DEPTH, INVALID_FRONTIER),
  },
  INVALID_FRONTIER,
);

const ADVANCED_ROW = new RowShape(
  {
    oid: text(INVALID_FRONTIER).where(isOid, INVALID_FRONTIER),
    origin_id: int(0, MAX_PACK_BLOB_INPUTS - 1, INVALID_FRONTIER),
  },
  INVALID_FRONTIER,
);

const PAGE_ROW = new RowShape(
  {
    step: int(0, MAX_DELTA_DEPTH, INVALID_FRONTIER),
    entry_limit: int(1, MAX_PACK_BLOB_GRAPH_ENTRIES, INVALID_FRONTIER),
  },
  INVALID_FRONTIER,
);

export interface FrontierOrigin {
  readonly originId: number;
  readonly depth: number;
}

/** One frontier OID with every origin standing on it at that step. */
export interface FrontierGroup {
  readonly oid: string;
  readonly origins: readonly FrontierOrigin[];
}

export interface FrontierMove {
  readonly originId: number;
  readonly exit: string;
  readonly depth: number;
}

export interface ScratchPage {
  readonly step: number;
  readonly entryLimit: number;
}

interface GroupBuilder {
  readonly oid: string;
  readonly order: number;
  readonly origins: FrontierOrigin[];
}

/** Page 0 carries request order through `min(origin_id)`; later pages need none. */
const PAGE_ZERO_ROOTS = `SELECT /* pack-read-roots */ oid
     FROM git_pack_read_frontier
    WHERE repo_id = ? AND read_id = ? AND step = 0
    GROUP BY oid ORDER BY min(origin_id)`;

const PAGE_ROOTS = `SELECT /* pack-read-roots */ DISTINCT oid
     FROM git_pack_read_frontier
    WHERE repo_id = ? AND read_id = ? AND step = ?`;

const PAGE_FRONTIER = `SELECT /* pack-read-frontier */ oid, origin_id, depth
     FROM git_pack_read_frontier
    WHERE repo_id = ? AND read_id = ? AND step = ?
    ORDER BY oid, origin_id`;

const ADVANCE = `INSERT /* pack-read-advance */ INTO git_pack_read_frontier
       (repo_id, read_id, step, oid, origin_id, depth)
     SELECT ?, ?, ?, json_extract(move.value, '$.o'), json_extract(move.value, '$.i'),
            json_extract(move.value, '$.d')
       FROM json_each(?) move WHERE 1
       ON CONFLICT (repo_id, read_id, origin_id, oid) DO NOTHING
    RETURNING origin_id, oid`;

export function seedFrontier(
  db: SqlDatabase,
  repoId: number,
  readId: string,
  wanted: readonly string[],
): void {
  db.run(
    `INSERT INTO git_pack_read_frontier (repo_id, read_id, step, oid, origin_id, depth)
     SELECT ?, ?, 0, input.value, CAST(input.key AS INTEGER), 0 FROM json_each(?) input`,
    repoId,
    readId,
    JSON.stringify(wanted),
  );
}

export function readFrontierRoots(
  db: SqlDatabase,
  repoId: number,
  scope: PackReadScope,
  step: number,
): string[] {
  const roots: string[] = [];
  const rows =
    step === 0
      ? scope.scoped(db.iterate(PAGE_ZERO_ROOTS, repoId, scope.readId))
      : scope.scoped(db.iterate(PAGE_ROOTS, repoId, scope.readId, step));
  for (const row of rows) roots.push(ROOT_ROW.decode(row).oid);
  if (roots.length === 0) throw new CorruptError(INVALID_FRONTIER);
  return roots;
}

/**
 * Read one step's whole frontier in a single ordered primary-key seek. Rows
 * arrive grouped by `oid`, so a page's per-origin metadata costs one statement
 * instead of one per frontier row. A step can never carry more origins than the
 * read asked for, which is what `maxOrigins` enforces while the cursor streams.
 */
export function readFrontierGroups(
  db: SqlDatabase,
  repoId: number,
  scope: PackReadScope,
  step: number,
  maxOrigins: number,
): FrontierGroup[] {
  const groups: GroupBuilder[] = [];
  let current: GroupBuilder | null = null;
  let origins = 0;
  for (const row of scope.scoped(db.iterate(PAGE_FRONTIER, repoId, scope.readId, step))) {
    const decoded = FRONTIER_ROW.decode(row);
    if (++origins > maxOrigins) throw new CorruptError(INVALID_FRONTIER);
    if (current === null || current.oid !== decoded.oid) {
      current = { oid: decoded.oid, order: decoded.origin_id, origins: [] };
      groups.push(current);
    }
    current.origins.push({ originId: decoded.origin_id, depth: decoded.depth });
  }
  if (groups.length === 0) throw new CorruptError(INVALID_FRONTIER);
  if (step === 0) groups.sort((left, right) => left.order - right.order);
  return groups;
}

function moveKey(originId: number, oid: string): string {
  return `${originId} ${oid}`;
}

function* moveRows(moves: readonly FrontierMove[]): Generator<{ o: string; i: number; d: number }> {
  for (const move of moves) yield { o: move.exit, i: move.originId, d: move.depth };
}

/**
 * Advance one page of origins onto their exits. The `UNIQUE (repo_id, read_id,
 * origin_id, oid)` index *is* the per-origin checkpoint set, so a move the batch
 * did not insert means that origin already visited the exit: a cycle. Consuming
 * one returned row per move, in `moves` order, names the exit that a
 * row-at-a-time insert would have rejected first; it is returned rather than
 * thrown so the pager keeps the wording. Null means every move advanced.
 */
export function advanceFrontier(
  db: SqlDatabase,
  repoId: number,
  scope: PackReadScope,
  step: number,
  moves: readonly FrontierMove[],
): string | null {
  const inserted = new Set<string>();
  for (const page of jsonPages(moveRows(moves), "paged pack frontier move")) {
    for (const row of scope.scoped(db.iterate(ADVANCE, repoId, scope.readId, step, page))) {
      const decoded = ADVANCED_ROW.decode(row);
      inserted.add(moveKey(decoded.origin_id, decoded.oid));
    }
  }
  for (const move of moves) {
    if (!inserted.delete(moveKey(move.originId, move.exit))) return move.exit;
  }
  if (inserted.size !== 0) throw new CorruptError(INVALID_FRONTIER);
  return null;
}

export function insertScratchPage(
  db: SqlDatabase,
  repoId: number,
  readId: string,
  step: number,
  entryLimit: number,
): void {
  db.run(
    `INSERT INTO git_pack_read_pages (repo_id, read_id, step, entry_limit)
     VALUES (?, ?, ?, ?)`,
    repoId,
    readId,
    step,
    entryLimit,
  );
}

/** Walk the recorded pages backwards by keyset; the reverse pass holds no array. */
export function readPreviousScratchPage(
  db: SqlDatabase,
  repoId: number,
  readId: string,
  before: number,
): ScratchPage | null {
  const row = db.one<Record<string, unknown>>(
    `SELECT /* pack-read-page */ step, entry_limit FROM git_pack_read_pages
      WHERE repo_id = ? AND read_id = ? AND step < ?
      ORDER BY step DESC LIMIT 1`,
    repoId,
    readId,
    before,
  );
  if (row === undefined) return null;
  const decoded = PAGE_ROW.decode(row);
  return { step: decoded.step, entryLimit: decoded.entry_limit };
}

/** One bounded union-graph page, seeded from the frontier rows of `step`. */
export function packGraphPageSql(entryLimit: number): string {
  // CROSS JOIN keeps frontier-driven OID seeks ahead of repository-wide scans.
  return `WITH RECURSIVE /* pack-graph-page */
       frontier(oid) AS MATERIALIZED (
         SELECT DISTINCT oid FROM git_pack_read_frontier
          WHERE repo_id = ? AND read_id = ? AND step = ?
       ),
       seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
       ${packGraphStartsSql("frontier")},
       reachable(pack_id, offset) AS (
         SELECT pack_id, offset FROM starts
         UNION
         ${PACK_GRAPH_BASE_STEP}
          LIMIT ${entryLimit}
       )
     ${PACK_GRAPH_ENTRY_SELECT}`;
}
