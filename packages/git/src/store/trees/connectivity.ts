import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import { expectText } from "../../common/rows.js";
import type { WalkTreeDiffObject } from "./tree-walk.js";

// UNION deduplicates tree identities, not paths: shared history expands each tree once.
const CONNECTIVITY_OBJECTS_SQL = `WITH RECURSIVE
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
  )
  SELECT t.oid, 'tree' AS type, source.complete
    FROM trees t
    CROSS JOIN params p
    LEFT JOIN git_tree_sources source ON source.repo_id = p.repo_id AND source.tree_oid = t.oid
  UNION ALL
  SELECT entry.oid, 'blob' AS type, 1 AS complete
    FROM trees t
    CROSS JOIN params p
    JOIN git_tree_sources source ON source.repo_id = p.repo_id AND source.tree_oid = t.oid
    JOIN git_tree_entries entry ON entry.source_key = source.source_key
   WHERE source.complete = 1 AND entry.mode NOT IN ('40000', '040000', '160000')`;

/** Commit roots must first pass readCommitTreeRoots' parent and shallow checks. */
export function* readConnectivityObjects(
  db: SqlDatabase,
  repoId: number,
  roots: readonly { oid: string; type: "commit" | "tree" }[],
  shallow: readonly string[],
): Generator<WalkTreeDiffObject> {
  for (const row of db.iterate(
    CONNECTIVITY_OBJECTS_SQL,
    repoId,
    JSON.stringify(roots),
    JSON.stringify(shallow),
  )) {
    const oid = expectText(row.oid, "connectivity object oid");
    if (row.complete !== 1) throw new CorruptError(`tree ${oid} has no complete parsed source`);
    const type = expectText(row.type, "connectivity object type");
    if (type !== "tree" && type !== "blob") {
      throw new CorruptError("connectivity object has an invalid type");
    }
    yield { oid, type };
  }
}
