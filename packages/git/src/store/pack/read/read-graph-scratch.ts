// SQL and row decoders for the owner-scoped discovery frontier of one paged
// packed read. Every statement is a primary-key prefix seek or point insert on
// `git_pack_read_*`; nothing here reads more rows than one bounded page.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import { int, RowShape, text } from "../../../common/rows.js";
import { MAX_DELTA_DEPTH, MAX_PACK_BLOB_GRAPH_ENTRIES, MAX_PACK_BLOB_INPUTS } from "../shared.js";
import type { PackReadScope } from "./read-scope.js";

const INVALID_FRONTIER = "paged pack frontier state is invalid";

const ROOT_ROW = new RowShape(
  {
    oid: text(INVALID_FRONTIER).where(isOid, INVALID_FRONTIER),
    origins: int(1, MAX_PACK_BLOB_INPUTS, INVALID_FRONTIER),
  },
  INVALID_FRONTIER,
);

const ORIGIN_ROW = new RowShape(
  {
    origin_id: int(0, MAX_PACK_BLOB_INPUTS - 1, INVALID_FRONTIER),
    depth: int(0, MAX_DELTA_DEPTH, INVALID_FRONTIER),
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

export interface FrontierRoot {
  readonly oid: string;
  readonly origins: number;
}

export interface FrontierOrigin {
  readonly originId: number;
  readonly depth: number;
}

export interface ScratchPage {
  readonly step: number;
  readonly entryLimit: number;
}

/** Page 0 carries request order through `min(origin_id)`; later pages need none. */
const PAGE_ZERO_ROOTS = `SELECT /* pack-read-roots */ oid, min(origin_id) AS ord, count(*) AS origins
     FROM git_pack_read_frontier
    WHERE repo_id = ? AND read_id = ? AND step = 0
    GROUP BY oid ORDER BY ord`;

const PAGE_ROOTS = `SELECT /* pack-read-roots */ oid, count(*) AS origins
     FROM git_pack_read_frontier
    WHERE repo_id = ? AND read_id = ? AND step = ?
    GROUP BY oid`;

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
): FrontierRoot[] {
  const roots: FrontierRoot[] = [];
  const rows =
    step === 0
      ? scope.scoped(db.iterate(PAGE_ZERO_ROOTS, repoId, scope.readId))
      : scope.scoped(db.iterate(PAGE_ROOTS, repoId, scope.readId, step));
  for (const row of rows) {
    const decoded = ROOT_ROW.decode(row);
    roots.push({ oid: decoded.oid, origins: decoded.origins });
  }
  if (roots.length === 0) throw new CorruptError(INVALID_FRONTIER);
  return roots;
}

export function readFrontierOrigins(
  db: SqlDatabase,
  repoId: number,
  scope: PackReadScope,
  step: number,
  oid: string,
): FrontierOrigin[] {
  const origins: FrontierOrigin[] = [];
  for (const row of scope.scoped(
    db.iterate(
      `SELECT /* pack-read-origins */ origin_id, depth FROM git_pack_read_frontier
        WHERE repo_id = ? AND read_id = ? AND step = ? AND oid = ?`,
      repoId,
      scope.readId,
      step,
      oid,
    ),
  )) {
    const decoded = ORIGIN_ROW.decode(row);
    origins.push({ originId: decoded.origin_id, depth: decoded.depth });
  }
  if (origins.length === 0) throw new CorruptError(INVALID_FRONTIER);
  return origins;
}

/**
 * Advance one origin onto its exit. The `UNIQUE (repo_id, read_id, origin_id,
 * oid)` index *is* the per-origin checkpoint set, so an absent returned row
 * means this origin already visited the exit: a cycle.
 */
export function advanceFrontier(
  db: SqlDatabase,
  repoId: number,
  readId: string,
  step: number,
  oid: string,
  originId: number,
  depth: number,
): boolean {
  const row = db.one<{ oid: unknown }>(
    `INSERT INTO git_pack_read_frontier (repo_id, read_id, step, oid, origin_id, depth)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, read_id, origin_id, oid) DO NOTHING
     RETURNING oid`,
    repoId,
    readId,
    step,
    oid,
    originId,
    depth,
  );
  if (row === undefined) return false;
  if (row.oid !== oid) throw new CorruptError(INVALID_FRONTIER);
  return true;
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
       reachable(oid) AS (
         SELECT object.oid
           FROM frontier
           CROSS JOIN git_pack_objects object
             ON object.repo_id = ? AND object.oid = frontier.oid
           CROSS JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND (pack.state = 'complete' OR object.pack_id = ?)
         UNION
         SELECT base.oid
           FROM reachable
           CROSS JOIN git_pack_objects child
             ON child.repo_id = ? AND child.oid = reachable.oid
           CROSS JOIN git_pack_meta child_pack
             ON child_pack.repo_id = child.repo_id
            AND child_pack.pack_id = child.pack_id
            AND (child_pack.state = 'complete' OR child.pack_id = ?)
           CROSS JOIN git_pack_objects base
             ON base.repo_id = child.repo_id AND base.oid = child.base_oid
           CROSS JOIN git_pack_meta base_pack
             ON base_pack.repo_id = base.repo_id AND base_pack.pack_id = base.pack_id
            AND (base_pack.state = 'complete' OR base.pack_id = ?)
          WHERE NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)
          LIMIT ${entryLimit}
       )
     SELECT object.oid, object.base_oid
       FROM reachable
       CROSS JOIN git_pack_objects object
         ON object.repo_id = ? AND object.oid = reachable.oid`;
}
