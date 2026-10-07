import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import { expectSafeInteger, expectText } from "../../common/rows.js";

// UNION deduplicates tree identities, not paths: shared history expands each tree once.
// Blobs are deduplicated too, and only failures leave SQLite: a missing source
// ranks before a missing object, which ranks before a wrong type.
export const CONNECTIVITY_FAILURES_SQL = `WITH RECURSIVE
  params(repo_id) AS (VALUES (?)),
  roots(oid, type) AS (
    SELECT json_extract(value, '$.oid'), json_extract(value, '$.type') FROM json_each(?)
  ),
  boundaries(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
  reachable(oid) AS (
    SELECT oid FROM roots WHERE type = 'commit'
    UNION
    SELECT parent.value FROM reachable r
      CROSS JOIN params p
      JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
      JOIN json_each(c.parents) parent
     WHERE r.oid NOT IN (SELECT oid FROM boundaries)
  ),
  trees(oid) AS (
    SELECT c.tree FROM reachable r
      CROSS JOIN params p
      JOIN git_commits c ON c.repo_id = p.repo_id AND c.oid = r.oid
    UNION
    SELECT oid FROM roots WHERE type = 'tree'
    UNION
    SELECT entry.oid FROM trees t
      CROSS JOIN params p
      JOIN git_tree_sources source ON source.repo_id = p.repo_id AND source.tree_oid = t.oid
      JOIN git_tree_entries entry ON entry.source_key = source.source_key
     WHERE source.complete = 1 AND entry.mode IN ('40000', '040000')
  ),
  tree_sources(oid, source_key, complete) AS MATERIALIZED (
    SELECT t.oid, source.source_key, source.complete
      FROM trees t
      CROSS JOIN params p
      LEFT JOIN git_tree_sources source ON source.repo_id = p.repo_id AND source.tree_oid = t.oid
  ),
  blobs(oid) AS MATERIALIZED (
    SELECT DISTINCT entry.oid
      FROM tree_sources t
      CROSS JOIN git_tree_entries entry
     WHERE t.complete = 1 AND entry.source_key = t.source_key
       AND entry.mode NOT IN ('40000', '040000', '160000')
  ),
  objects(oid, type, complete) AS (
    SELECT oid, 'tree', complete FROM tree_sources
    UNION ALL
    SELECT oid, 'blob', 1 FROM blobs
  ),
  ranked(oid, type, rank) AS (
    SELECT o.oid, o.type,
           CASE WHEN o.complete IS NOT 1 THEN 0 ELSE (
             SELECT CASE
                      WHEN stored.type IS NULL THEN
                        CASE WHEN o.type = 'blob' AND EXISTS (
                          SELECT 1 FROM git_promised_blobs promised
                           WHERE promised.repo_id = p.repo_id AND promised.oid = o.oid
                        ) THEN NULL ELSE 1 END
                      WHEN stored.type = o.type THEN NULL
                      ELSE 2
                    END
               FROM (
                 SELECT COALESCE(
                   (SELECT loose.type FROM git_objects loose
                     WHERE loose.repo_id = p.repo_id AND loose.oid = o.oid),
                   (SELECT packed.type FROM git_pack_objects packed
                      JOIN git_pack_meta pack
                        ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
                       AND pack.state = 'complete'
                     WHERE packed.repo_id = p.repo_id AND packed.oid = o.oid)
                 ) AS type
               ) stored
           ) END
      FROM objects o
      CROSS JOIN params p
     -- LIMIT -1 keeps this a co-routine so each rank is computed once.
     LIMIT -1
  )
  SELECT oid, type, rank FROM ranked
   WHERE rank IS NOT NULL
   ORDER BY rank, oid
   LIMIT ?`;

export type ConnectivityFailure =
  | { kind: "source"; oid: string }
  | { kind: "missing"; oid: string }
  | { kind: "type"; oid: string; expected: "tree" | "blob" };

export const MAX_CONNECTIVITY_FAILURES = 4_096;

/** Commit roots must first pass readCommitTreeRoots' parent and shallow checks. */
export function readConnectivityFailures(
  db: SqlDatabase,
  repoId: number,
  roots: readonly { oid: string; type: "commit" | "tree" }[],
  shallow: readonly string[],
  limit: number,
): ConnectivityFailure[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONNECTIVITY_FAILURES) {
    throw new RangeError(`connectivity failure limit must be 1..${MAX_CONNECTIVITY_FAILURES}`);
  }
  return db
    .all<Record<string, unknown>>(
      CONNECTIVITY_FAILURES_SQL,
      repoId,
      JSON.stringify(roots),
      JSON.stringify(shallow),
      limit,
    )
    .map((row): ConnectivityFailure => {
      const oid = expectText(row.oid, "connectivity failure oid");
      const rank = expectSafeInteger(row.rank, 0, 2, "connectivity failure rank");
      if (rank === 0) return { kind: "source", oid };
      if (rank === 1) return { kind: "missing", oid };
      const expected = expectText(row.type, "connectivity failure type");
      if (expected !== "tree" && expected !== "blob") {
        throw new CorruptError("connectivity failure has an invalid type");
      }
      return { kind: "type", oid, expected };
    });
}
