/**
 * Rows one admission page materializes: the bound on both recursive CTEs, on
 * the JavaScript that consumes a page, and on each batched JSON write. It is
 * the same page the pack read graph walks (`MAX_PACK_BLOB_GRAPH_ENTRIES`),
 * because both traverse the same delta graph. Statements per admission are
 * affected objects divided by this page, so a page that is small relative to a
 * published pack turns a clone into hundreds of round trips.
 */
export const GRAPH_PAGE = 4_096;

const nextChild = (parent: string, cursor: string) => `(SELECT c.oid
  FROM git_pack_objects c INDEXED BY git_pack_objects_reverse
  JOIN git_pack_meta m ON m.repo_id = c.repo_id AND m.pack_id = c.pack_id
  WHERE c.repo_id = ?1 AND c.base_oid = ${parent} AND c.oid > ${cursor}
    AND m.state = 'complete'
  ORDER BY c.oid LIMIT 1)`;

const joins = `
  LEFT JOIN git_pack_objects p ON p.repo_id = ?1 AND p.oid = w.oid
  LEFT JOIN git_pack_meta v ON v.repo_id = p.repo_id AND v.pack_id = p.pack_id
    AND v.state = 'complete'
  LEFT JOIN git_objects l ON l.repo_id = ?1 AND l.oid = w.oid
  LEFT JOIN git_pack_graph_memo m ON m.repo_id = ?1 AND m.op_id = ?2 AND m.oid = w.oid
  LEFT JOIN git_pack_graph_path h ON h.repo_id = ?1 AND h.op_id = ?2 AND h.oid = w.oid`;
const nextRoot = `(SELECT a.oid FROM git_pack_graph_affected a
  WHERE a.repo_id = ?1 AND a.op_id = ?2 AND a.oid > w.root ORDER BY a.oid LIMIT 1)`;
const terminal = `(m.oid IS NOT NULL OR v.pack_id IS NULL OR p.base_oid IS NULL)`;
const descend = `(lane.child IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM git_pack_graph_affected a
  WHERE a.repo_id = ?1 AND a.op_id = ?2 AND a.oid = lane.child))`;
const ancestor = `(SELECT p.base_oid FROM git_pack_objects p
  JOIN git_pack_meta v ON v.repo_id = p.repo_id AND v.pack_id = p.pack_id
  WHERE p.repo_id = ?1 AND p.oid = lane.parent AND v.state = 'complete')`;
const reverseParent = `CASE WHEN ${descend} THEN lane.child
  WHEN lane.child IS NOT NULL THEN lane.parent ELSE ${ancestor} END`;
const reverseCursor = `CASE WHEN ${descend} THEN ''
  WHEN lane.child IS NOT NULL THEN lane.child ELSE lane.parent END`;

export interface GraphSql {
  readonly reverse: string;
  readonly seed: string;
  readonly advance: string;
  readonly firstRoot: string;
  readonly forward: string;
  readonly memo: string;
  readonly path: string;
  readonly unwind: string;
  readonly trim: string;
}

export function graphSql(page: number): GraphSql {
  return {
    reverse: `WITH RECURSIVE
    seeds AS MATERIALIZED (
      SELECT oid, cursor FROM git_pack_graph_affected INDEXED BY git_pack_graph_pending
      WHERE repo_id = ?1 AND op_id = ?2 AND pending = 1 ORDER BY oid LIMIT ${page}
    ),
    lane(root, parent, child) AS (
      SELECT oid, oid, ${nextChild("seeds.oid", "seeds.cursor")} FROM seeds
      UNION ALL
      SELECT root, ${reverseParent}, ${nextChild(reverseParent, reverseCursor)}
      FROM lane WHERE child IS NOT NULL OR parent != root
      LIMIT ${page}
    ) SELECT parent, child FROM lane`,
    seed: `INSERT OR IGNORE INTO git_pack_graph_affected
    SELECT ?1, ?2, value, 1, '' FROM json_each(?3)`,
    advance: `INSERT INTO git_pack_graph_affected
    SELECT ?1, ?2, json_extract(value, '$.oid'), json_extract(value, '$.pending'),
      json_extract(value, '$.cursor') FROM json_each(?3) WHERE 1
    ON CONFLICT(repo_id, op_id, oid) DO UPDATE SET
      cursor = excluded.cursor, pending = excluded.pending`,
    firstRoot: `SELECT a.oid FROM git_pack_graph_affected a
    WHERE a.repo_id = ?1 AND a.op_id = ?2 AND a.oid > ?3
      AND (EXISTS (
        SELECT 1 FROM git_pack_objects p
        JOIN git_pack_meta v ON v.repo_id = p.repo_id AND v.pack_id = p.pack_id
        WHERE p.repo_id = a.repo_id AND p.oid = a.oid AND v.state = 'complete'
      ) OR EXISTS (
        SELECT 1 FROM git_objects l WHERE l.repo_id = a.repo_id AND l.oid = a.oid
      ))
    ORDER BY a.oid LIMIT 1`,
    forward: `WITH RECURSIVE w(oid, root) AS (
    SELECT ?3, ?4
    UNION ALL
    SELECT CASE WHEN ${terminal} THEN ${nextRoot} ELSE p.base_oid END,
           CASE WHEN ${terminal} THEN ${nextRoot} ELSE w.root END
    FROM w ${joins}
    WHERE w.oid IS NOT NULL AND NOT (w.root = ?4 AND h.oid IS NOT NULL)
    LIMIT ${page}
  )
  SELECT w.oid, w.root,
    CASE WHEN v.pack_id IS NOT NULL THEN p.type ELSE l.type END AS type,
    CASE WHEN v.pack_id IS NOT NULL THEN p.base_oid ELSE NULL END AS base,
    m.depth, m.type AS memo_type,
    CASE WHEN w.root = ?4 AND h.oid IS NOT NULL THEN 1 ELSE 0 END AS active
  FROM w ${joins} WHERE w.oid IS NOT NULL`,
    memo: `INSERT OR IGNORE INTO git_pack_graph_memo
    SELECT ?1, ?2, json_extract(value, '$.oid'), json_extract(value, '$.depth'),
      json_extract(value, '$.type') FROM json_each(?3)`,
    path: `INSERT INTO git_pack_graph_path
    SELECT ?1, ?2, json_extract(value, '$.oid'), json_extract(value, '$.position')
    FROM json_each(?3)`,
    unwind: `INSERT INTO git_pack_graph_memo
    SELECT repo_id, op_id, oid, ?3 + ?4 - position, ?5
    FROM git_pack_graph_path
    WHERE repo_id = ?1 AND op_id = ?2 AND position >= ?6 AND position < ?7
    ORDER BY position DESC LIMIT ${page}
    ON CONFLICT(repo_id, op_id, oid) DO NOTHING`,
    trim: `DELETE FROM git_pack_graph_path
    WHERE repo_id = ?1 AND op_id = ?2 AND position >= ?3 AND position < ?4`,
  };
}
