import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError } from "../common/errors.js";
import { expectNullable, expectText } from "../common/rows.js";
import { TREE_QUEUE_ROW_FIXED_BYTES } from "./schema.js";

const TREE_WALK_QUEUE_BYTES = 16 * 1024 * 1024;
// Caller-unbounded traversal state must fail before the recursive CTE expands it.
export const TREE_WALK_PATH_BYTES = 7_456_512;
export const TREE_WALK_STATE_BYTES = 64 * 1024 * 1024;

export interface WalkTreeEntry {
  path: string;
  mode: string;
  oid: string;
}

export interface WalkTreeDiffEntry {
  path: string;
  beforeMode: string | null;
  beforeOid: string | null;
  afterMode: string | null;
  afterOid: string | null;
}

export interface WalkTreeDiffObject {
  oid: string;
  type: "tree" | "blob";
}

function throwTraversalError(row: Record<string, unknown>, label: string): void {
  const error = row.error;
  if (error === null) return;
  const message = expectText(error, `${label} error`);
  const errorCode = expectText(row.error_code, `${label} error code`);
  if (errorCode === "E2BIG") throw new GitError("E2BIG", message);
  throw new CorruptError(message);
}

function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

export const WALK_TREE_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, path_cap, state_cap, queue_cap, queue_fixed)
    AS (VALUES (?, ?, ?, ?, ?, ?)),
  source_valid(repo_id, tree_oid, source_key, entry_count, base_cost) AS NOT MATERIALIZED (
    SELECT x.repo_id, x.tree_oid, s.source_key, s.entry_count, s.base_cost
      FROM git_tree_effective x
      CROSS JOIN params p
      CROSS JOIN git_tree_sources s
     WHERE x.repo_id = p.repo_id
       AND s.source_key = x.source_key
       AND s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.complete = 1
  ),
  walk(path, mode, oid, ancestry, sort_key, error, error_code,
       path_bytes, state_bytes, descend, reserved_bytes) AS (
    SELECT CASE
             WHEN length(e.name_bytes) <= p.path_cap THEN CAST(e.name_bytes AS TEXT)
             ELSE NULL
           END,
           e.mode, e.oid,
           '/' || p.root_oid || '/', printf('%08x', e.ordinal),
           CASE
             WHEN length(e.name_bytes) > p.path_cap
               THEN 'tree traversal row exceeds its fixed state capacity'
             WHEN length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal row exceeds its fixed state capacity'
             ELSE NULL
           END,
           CASE WHEN length(e.name_bytes) > p.path_cap
                  OR length(e.name_bytes) + 41 + 8 > p.state_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           length(e.name_bytes), length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND EXISTS (
                    SELECT 1 FROM source_valid child
                     WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  )
             THEN CASE WHEN EXISTS (
               SELECT 1 FROM source_valid child
                WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  AND s.base_cost - e.cumulative_base
                        + (s.entry_count - e.ordinal - 1) * 50
                        + child.base_cost
                        + child.entry_count * (length(e.name_bytes) + 49 + 51)
                      > p.queue_cap
             ) THEN 2 ELSE 1 END
             ELSE 0
           END,
           s.base_cost - e.cumulative_base
             + (s.entry_count - e.ordinal - 1) * 50
      FROM params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
       AND s.base_cost + s.entry_count * 50 <= p.queue_cap
       AND e.source_key = s.source_key
    UNION ALL
    SELECT NULL, NULL, NULL, '/', '',
           'tree traversal queue exceeds 16 MiB', 'E2BIG', 0, 0, 0, 0
      FROM params p CROSS JOIN source_valid s
     WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
       AND s.base_cost + s.entry_count * 50 > p.queue_cap
    UNION ALL
    SELECT NULL, NULL, NULL, '/', '',
           CASE WHEN length(p.root_oid) = 40 AND p.root_oid NOT GLOB '*[^0-9a-f]*'
                THEN 'tree source is invalid; reimport or reclone'
                ELSE 'tree oid is invalid'
           END,
           'ECORRUPT', 0, 0, 0, 0
      FROM params p
     WHERE NOT EXISTS (
       SELECT 1 FROM source_valid s
        WHERE s.repo_id = p.repo_id AND s.tree_oid = p.root_oid
     )
    UNION ALL
    SELECT CASE
             WHEN w.path_bytes + 1 + length(e.name_bytes) <= p.path_cap
               THEN w.path || '/' || CAST(e.name_bytes AS TEXT)
             ELSE NULL
           END,
           e.mode, e.oid,
           w.ancestry || w.oid || '/', w.sort_key || printf('%08x', e.ordinal),
           CASE
             WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
               THEN 'tree traversal row exceeds its fixed state capacity'
             WHEN w.state_bytes + 1 + length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal row exceeds its fixed state capacity'
             ELSE NULL
           END,
           CASE WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
                  OR w.state_bytes + 1 + length(e.name_bytes) + 41 + 8 > p.state_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           w.path_bytes + 1 + length(e.name_bytes),
           w.state_bytes + 1 + length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND EXISTS (
                    SELECT 1 FROM source_valid child
                     WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  )
             THEN CASE WHEN EXISTS (
               SELECT 1 FROM source_valid child
                WHERE child.repo_id = p.repo_id AND child.tree_oid = e.oid
                  AND w.reserved_bytes + s.base_cost - e.cumulative_base
                        + (s.entry_count - e.ordinal - 1) * (w.state_bytes + 51)
                        + child.base_cost
                        + child.entry_count
                          * (w.state_bytes + 1 + length(e.name_bytes) + 49 + 51)
                      > p.queue_cap
             ) THEN 2 ELSE 1 END
             ELSE 0
           END,
           w.reserved_bytes + s.base_cost - e.cumulative_base
             + (s.entry_count - e.ordinal - 1) * (w.state_bytes + 51)
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE w.error IS NULL AND w.descend = 1
       AND instr(w.ancestry, '/' || w.oid || '/') = 0
       AND s.repo_id = p.repo_id AND s.tree_oid = w.oid
       AND e.source_key = s.source_key
     ORDER BY 5
  )
SELECT path, mode, oid,
       CASE
         WHEN error IS NOT NULL THEN error
         WHEN mode IN ('40000', '040000') AND instr(ancestry, '/' || oid || '/') != 0
           THEN 'tree cycle at ' || oid
         WHEN mode IN ('40000', '040000') AND descend = 2
           THEN 'tree traversal queue exceeds 16 MiB'
         WHEN mode IN ('40000', '040000') AND descend = 0
           THEN 'tree ' || oid || ' has no valid v3 parsed source; reimport or reclone'
         ELSE NULL
       END AS error,
       CASE WHEN error_code = 'E2BIG' OR descend = 2 THEN 'E2BIG'
            ELSE 'ECORRUPT' END AS error_code
  FROM walk
 WHERE error IS NOT NULL
    OR mode NOT IN ('40000', '040000')
    OR instr(ancestry, '/' || oid || '/') != 0
    OR (mode IN ('40000', '040000') AND descend != 1)`;

function diffSourceValidSql(effective: string, source: string): string {
  return `((${effective}.source_key IS NOT NULL
    AND ${source}.source_key = ${effective}.source_key
    AND ${source}.repo_id = ${effective}.repo_id
    AND ${source}.tree_oid = ${effective}.tree_oid
    AND ${source}.complete = 1) IS TRUE)`;
}

function diffEntryNameSql(entry: string): string {
  return `CASE WHEN length(${entry}.name_bytes) <= p.path_cap
                THEN CAST(${entry}.name_bytes AS TEXT) ELSE NULL END`;
}

function diffEntryModeSql(entry: string): string {
  return `${entry}.mode`;
}

function diffEntryOidSql(entry: string): string {
  return `${entry}.oid`;
}

function diffEntryTooBigSql(entry: string): string {
  return `length(${entry}.name_bytes) > p.path_cap`;
}

const WALK_TREE_DIFF_SQL = `WITH RECURSIVE
  params(repo_id, before_root, after_root, path_cap, state_cap, queue_cap, queue_fixed,
         emit_objects)
    AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?)),
  walk(path, path_bytes, sort_key, before_mode, before_oid, after_mode, after_oid,
       before_ancestry, after_ancestry, state_bytes, reserved_bytes, error, error_code) AS (
    SELECT '', 0, CAST('' AS BLOB),
           CASE WHEN p.before_root IS NULL THEN NULL ELSE '40000' END, p.before_root,
           CASE WHEN p.after_root IS NULL THEN NULL ELSE '40000' END, p.after_root,
           CASE WHEN p.before_root IS NULL THEN '/' ELSE '/' || p.before_root || '/' END,
           CASE WHEN p.after_root IS NULL THEN '/' ELSE '/' || p.after_root || '/' END,
           0, 0,
           CASE
             WHEN p.before_root IS NOT NULL AND
                  (length(p.before_root) != 40 OR p.before_root GLOB '*[^0-9a-f]*')
               THEN 'tree oid is invalid'
             WHEN p.after_root IS NOT NULL AND
                  (length(p.after_root) != 40 OR p.after_root GLOB '*[^0-9a-f]*')
               THEN 'tree oid is invalid'
             ELSE NULL
           END,
           CASE
             WHEN p.before_root IS NOT NULL AND
                  (length(p.before_root) != 40 OR p.before_root GLOB '*[^0-9a-f]*')
               THEN 'ECORRUPT'
             WHEN p.after_root IS NOT NULL AND
                  (length(p.after_root) != 40 OR p.after_root GLOB '*[^0-9a-f]*')
               THEN 'ECORRUPT'
             ELSE 'PENDING'
           END
      FROM params p
     WHERE p.before_root IS NOT p.after_root
    UNION ALL
    SELECT w.path, w.path_bytes, w.sort_key,
           w.before_mode, w.before_oid, w.after_mode, w.after_oid,
           w.before_ancestry, w.after_ancestry, w.state_bytes, w.reserved_bytes,
           CASE
             WHEN w.before_mode IN ('40000', '040000')
                  AND NOT (COALESCE(w.after_mode IN ('40000', '040000'), 0)
                           AND w.before_oid = w.after_oid)
                  AND NOT ${diffSourceValidSql("bx", "bps")}
               THEN CASE WHEN w.path = '' THEN 'tree source is invalid; reimport or reclone'
                         ELSE 'tree ' || w.before_oid
                           || ' has no valid v3 parsed source; reimport or reclone' END
             WHEN w.after_mode IN ('40000', '040000')
                  AND NOT (COALESCE(w.before_mode IN ('40000', '040000'), 0)
                           AND w.before_oid = w.after_oid)
                  AND NOT ${diffSourceValidSql("ax", "aps")}
               THEN CASE WHEN w.path = '' THEN 'tree source is invalid; reimport or reclone'
                         ELSE 'tree ' || w.after_oid
                           || ' has no valid v3 parsed source; reimport or reclone' END
             ELSE NULL
           END,
           'ECORRUPT'
      FROM walk w
      CROSS JOIN params p
      LEFT JOIN git_tree_effective bx
        ON bx.repo_id = p.repo_id AND bx.tree_oid = w.before_oid
      LEFT JOIN git_tree_sources bps
        ON bps.source_key = bx.source_key
      LEFT JOIN git_tree_effective ax
        ON ax.repo_id = p.repo_id AND ax.tree_oid = w.after_oid
      LEFT JOIN git_tree_sources aps
        ON aps.source_key = ax.source_key
     WHERE w.error IS NULL AND w.error_code = 'PENDING'
    UNION ALL
    SELECT w.path, w.path_bytes, w.sort_key,
           w.before_mode, w.before_oid, w.after_mode, w.after_oid,
           w.before_ancestry, w.after_ancestry, w.state_bytes, w.reserved_bytes,
           'tree traversal queue exceeds 16 MiB', 'E2BIG'
      FROM walk w
      CROSS JOIN params p
      LEFT JOIN git_tree_effective bx
        ON bx.repo_id = p.repo_id AND bx.tree_oid = w.before_oid
       AND w.before_mode IN ('40000', '040000')
       AND NOT (COALESCE(w.after_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
      LEFT JOIN git_tree_sources bps ON bps.source_key = bx.source_key
      LEFT JOIN git_tree_effective ax
        ON ax.repo_id = p.repo_id AND ax.tree_oid = w.after_oid
       AND w.after_mode IN ('40000', '040000')
       AND NOT (COALESCE(w.before_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
      LEFT JOIN git_tree_sources aps ON aps.source_key = ax.source_key
     WHERE w.error IS NULL
       AND w.error_code = 'ECORRUPT'
       AND (w.before_mode IN ('40000', '040000') OR w.after_mode IN ('40000', '040000'))
       AND NOT (COALESCE(w.before_mode IN ('40000', '040000'), 0)
                AND COALESCE(w.after_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
       AND w.reserved_bytes
             + COALESCE(bps.base_cost + bps.object_size
                          + bps.entry_count * (w.state_bytes + 51), 0)
             + COALESCE(aps.base_cost + aps.object_size
                          + aps.entry_count * (w.state_bytes + 51), 0)
           > p.queue_cap
    UNION ALL
    SELECT CASE WHEN w.path = '' THEN ${diffEntryNameSql("be")}
                ELSE w.path || '/' || ${diffEntryNameSql("be")} END,
           w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END + length(be.name_bytes),
           CAST(CAST(CASE WHEN w.path = '' THEN ${diffEntryNameSql("be")}
                          ELSE w.path || '/' || ${diffEntryNameSql("be")} END AS BLOB)
                || CASE WHEN be.mode NOT IN ('40000', '040000')
                          OR ae.mode NOT IN ('40000', '040000')
                        THEN x'00' ELSE x'2f' END AS BLOB),
           ${diffEntryModeSql("be")}, ${diffEntryOidSql("be")},
           ${diffEntryModeSql("ae")}, ${diffEntryOidSql("ae")},
           CASE WHEN w.path = '' THEN w.before_ancestry
                ELSE w.before_ancestry || w.before_oid || '/' END,
           CASE WHEN w.path = '' THEN w.after_ancestry
                WHEN w.after_mode IN ('40000', '040000')
                  THEN w.after_ancestry || w.after_oid || '/'
                ELSE w.after_ancestry END,
           w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
             + length(be.name_bytes)) + 100,
           w.reserved_bytes
             + CASE WHEN ae.ordinal IS NOT NULL
                            AND (be.mode IN ('40000', '040000'))
                                  != (ae.mode IN ('40000', '040000'))
                 THEN bps.base_cost + bps.entry_count * (w.state_bytes + 51)
                   + bps.object_size
                 ELSE 2 * (bps.base_cost - be.cumulative_base)
                   + (bps.entry_count - be.ordinal - 1)
                       * (w.state_bytes + 51 - p.queue_fixed - 18)
               END
             + CASE WHEN ae.ordinal IS NULL
                          OR (be.mode IN ('40000', '040000'))
                               != (ae.mode IN ('40000', '040000'))
                 THEN COALESCE(aps.base_cost + aps.object_size
                         + aps.entry_count * (w.state_bytes + 51), 0)
                 ELSE 2 * (aps.base_cost - ae.cumulative_base)
                   + (aps.entry_count - ae.ordinal - 1)
                       * (w.state_bytes + 51 - p.queue_fixed - 18)
               END,
           CASE WHEN w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                              + length(be.name_bytes) > p.path_cap
                  THEN 'tree traversal row exceeds its fixed state capacity'
                WHEN w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
                              + length(be.name_bytes)) + 100 > p.state_cap
                  THEN 'tree traversal row exceeds its fixed state capacity'
                WHEN be.mode IN ('40000', '040000')
                     AND instr(CASE WHEN w.path = '' THEN w.before_ancestry
                                    ELSE w.before_ancestry || w.before_oid || '/' END,
                               '/' || ${diffEntryOidSql("be")} || '/') != 0
                  THEN 'tree cycle at ' || ${diffEntryOidSql("be")}
                WHEN ae.mode IN ('40000', '040000')
                     AND instr(CASE WHEN w.path = '' THEN w.after_ancestry
                                    WHEN w.after_mode IN ('40000', '040000')
                                      THEN w.after_ancestry || w.after_oid || '/'
                                    ELSE w.after_ancestry END,
                               '/' || ${diffEntryOidSql("ae")} || '/') != 0
                  THEN 'tree cycle at ' || ${diffEntryOidSql("ae")}
                ELSE NULL END,
           CASE WHEN ${diffEntryTooBigSql("be")}
                       OR (ae.ordinal IS NOT NULL AND ${diffEntryTooBigSql("ae")})
                       OR w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                            + length(be.name_bytes) > p.path_cap
                       OR w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
                            + length(be.name_bytes)) + 100 > p.state_cap
                  THEN 'E2BIG'
                WHEN (be.mode IN ('40000', '040000') OR ae.mode IN ('40000', '040000'))
                     AND NOT (
                       COALESCE(be.mode IN ('40000', '040000'), 0)
                       AND COALESCE(ae.mode IN ('40000', '040000'), 0)
                       AND be.oid = ae.oid
                     )
                  THEN 'PENDING'
                ELSE 'ECORRUPT' END
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN git_tree_effective bx
      CROSS JOIN git_tree_sources bps
      CROSS JOIN git_tree_entries be
      LEFT JOIN git_tree_effective ax
        ON ax.repo_id = p.repo_id AND ax.tree_oid = w.after_oid
       AND w.after_mode IN ('40000', '040000')
      LEFT JOIN git_tree_sources aps ON aps.source_key = ax.source_key
      LEFT JOIN git_tree_entries ae
        ON ae.source_key = aps.source_key AND ae.name_bytes = be.name_bytes
       AND length(ae.name_bytes) <= p.path_cap
     WHERE w.error IS NULL
       AND w.error_code = 'ECORRUPT'
       AND (w.before_mode IN ('40000', '040000'))
       AND NOT (COALESCE(w.after_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
       AND bx.repo_id = p.repo_id AND bx.tree_oid = w.before_oid
       AND bps.source_key = bx.source_key
       AND be.source_key = bps.source_key
       AND w.reserved_bytes
             + bps.base_cost + bps.object_size + bps.entry_count * (w.state_bytes + 51)
             + COALESCE(aps.base_cost + aps.object_size
                          + aps.entry_count * (w.state_bytes + 51), 0)
           <= p.queue_cap
    UNION ALL
    SELECT CASE WHEN w.path = '' THEN ${diffEntryNameSql("ae")}
                ELSE w.path || '/' || ${diffEntryNameSql("ae")} END,
           w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END + length(ae.name_bytes),
           CAST(CAST(CASE WHEN w.path = '' THEN ${diffEntryNameSql("ae")}
                          ELSE w.path || '/' || ${diffEntryNameSql("ae")} END AS BLOB)
                || CASE WHEN ae.mode NOT IN ('40000', '040000')
                        THEN x'00' ELSE x'2f' END AS BLOB),
           NULL, NULL, ${diffEntryModeSql("ae")}, ${diffEntryOidSql("ae")},
           w.before_ancestry,
           CASE WHEN w.path = '' THEN w.after_ancestry
                ELSE w.after_ancestry || w.after_oid || '/' END,
           w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
             + length(ae.name_bytes)) + 55,
           w.reserved_bytes
             + 2 * (aps.base_cost - ae.cumulative_base)
             + (aps.entry_count - ae.ordinal - 1)
                 * (w.state_bytes + 51 - p.queue_fixed - 18)
             + COALESCE(bps.base_cost + bps.object_size
                          + bps.entry_count * (w.state_bytes + 51), 0),
           CASE WHEN w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                              + length(ae.name_bytes) > p.path_cap
                  THEN 'tree traversal row exceeds its fixed state capacity'
                WHEN w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
                              + length(ae.name_bytes)) + 55 > p.state_cap
                  THEN 'tree traversal row exceeds its fixed state capacity'
                WHEN ae.mode IN ('40000', '040000')
                     AND instr(CASE WHEN w.path = '' THEN w.after_ancestry
                                    ELSE w.after_ancestry || w.after_oid || '/' END,
                               '/' || ${diffEntryOidSql("ae")} || '/') != 0
                  THEN 'tree cycle at ' || ${diffEntryOidSql("ae")}
                ELSE NULL END,
           CASE WHEN ${diffEntryTooBigSql("ae")}
                       OR w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                            + length(ae.name_bytes) > p.path_cap
                       OR w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
                            + length(ae.name_bytes)) + 55 > p.state_cap
                  THEN 'E2BIG'
                WHEN ae.mode IN ('40000', '040000') THEN 'PENDING'
                ELSE 'ECORRUPT' END
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN git_tree_effective ax
      CROSS JOIN git_tree_sources aps
      CROSS JOIN git_tree_entries ae
      LEFT JOIN git_tree_effective bx
        ON bx.repo_id = p.repo_id AND bx.tree_oid = w.before_oid
       AND w.before_mode IN ('40000', '040000')
      LEFT JOIN git_tree_sources bps ON bps.source_key = bx.source_key
      LEFT JOIN git_tree_entries be
        ON be.source_key = bps.source_key AND be.name_bytes = ae.name_bytes
       AND length(be.name_bytes) <= p.path_cap
     WHERE w.error IS NULL
       AND w.error_code = 'ECORRUPT'
       AND w.after_mode IN ('40000', '040000')
       AND NOT (COALESCE(w.before_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
       AND ax.repo_id = p.repo_id AND ax.tree_oid = w.after_oid
       AND aps.source_key = ax.source_key
       AND ae.source_key = aps.source_key
       AND be.ordinal IS NULL
       AND w.reserved_bytes
             + aps.base_cost + aps.object_size + aps.entry_count * (w.state_bytes + 51)
             + COALESCE(bps.base_cost + bps.object_size
                          + bps.entry_count * (w.state_bytes + 51), 0)
           <= p.queue_cap
     ORDER BY 3
  )
SELECT path,
       CASE WHEN before_mode IN ('40000', '040000') THEN NULL ELSE before_mode END AS before_mode,
       CASE WHEN before_mode IN ('40000', '040000') THEN NULL ELSE before_oid END AS before_oid,
       CASE WHEN after_mode IN ('40000', '040000') THEN NULL ELSE after_mode END AS after_mode,
       CASE WHEN after_mode IN ('40000', '040000') THEN NULL ELSE after_oid END AS after_oid,
       after_mode AS object_mode, after_oid AS object_oid,
       error, CASE WHEN error_code = 'PENDING' THEN 'ECORRUPT'
                   ELSE error_code END AS error_code
  FROM walk
  CROSS JOIN params p
 WHERE error IS NOT NULL
    OR error_code != 'PENDING' AND (
       ((before_mode NOT IN ('40000', '040000') OR after_mode NOT IN ('40000', '040000'))
        AND NOT (before_mode IS after_mode AND before_oid IS after_oid))
    OR (p.emit_objects != 0 AND after_mode IN ('40000', '040000')
        AND NOT (COALESCE(before_mode IN ('40000', '040000'), 0)
                 AND before_oid = after_oid)))
 ORDER BY CASE WHEN error IS NULL THEN 1 ELSE 0 END, sort_key`;

/** Stream every non-tree entry in raw Git DFS order with one SQL statement. */
export function* iterateTree(
  db: SqlDatabase,
  repoId: number,
  treeOid: string,
): Generator<WalkTreeEntry> {
  for (const row of db.iterate(
    WALK_TREE_SQL,
    repoId,
    treeOid,
    TREE_WALK_PATH_BYTES,
    TREE_WALK_STATE_BYTES,
    TREE_WALK_QUEUE_BYTES,
    TREE_QUEUE_ROW_FIXED_BYTES,
  )) {
    throwTraversalError(row, "tree traversal");
    const path = expectText(row.path, "tree traversal path");
    const mode = expectText(row.mode, "tree traversal mode");
    const oid = expectText(row.oid, "tree traversal oid");
    yield { path, mode, oid };
  }
}

/** Stream the tree and blob objects introduced by one tree transition. */
export function* iterateTreeDiffObjects(
  db: SqlDatabase,
  repoId: number,
  beforeTreeOid: string | null,
  afterTreeOid: string,
): Generator<WalkTreeDiffObject> {
  if (beforeTreeOid === afterTreeOid) return;
  for (const row of db.iterate(
    WALK_TREE_DIFF_SQL,
    repoId,
    beforeTreeOid,
    afterTreeOid,
    TREE_WALK_PATH_BYTES,
    TREE_WALK_STATE_BYTES,
    TREE_WALK_QUEUE_BYTES,
    TREE_QUEUE_ROW_FIXED_BYTES,
    1,
  )) {
    throwTraversalError(row, "tree diff object traversal");
    if (row.object_mode === null && row.object_oid === null) continue;
    const mode = expectText(row.object_mode, "tree diff object mode");
    const oid = expectText(row.object_oid, "tree diff object oid");
    if (mode === "160000") continue;
    yield { oid, type: isTreeMode(mode) ? "tree" : "blob" };
  }
}

/** Stream changed leaves between two trees while pruning equal subtrees. */
export function* iterateTreeDiff(
  db: SqlDatabase,
  repoId: number,
  beforeTreeOid: string | null,
  afterTreeOid: string | null,
): Generator<WalkTreeDiffEntry> {
  if (beforeTreeOid === afterTreeOid) return;
  for (const row of db.iterate(
    WALK_TREE_DIFF_SQL,
    repoId,
    beforeTreeOid,
    afterTreeOid,
    TREE_WALK_PATH_BYTES,
    TREE_WALK_STATE_BYTES,
    TREE_WALK_QUEUE_BYTES,
    TREE_QUEUE_ROW_FIXED_BYTES,
    0,
  )) {
    throwTraversalError(row, "tree diff traversal");
    const path = expectText(row.path, "tree diff path");
    const beforeMode = expectNullable(row.before_mode, (value) =>
      expectText(value, "tree diff before mode"),
    );
    const beforeOid = expectNullable(row.before_oid, (value) =>
      expectText(value, "tree diff before oid"),
    );
    const afterMode = expectNullable(row.after_mode, (value) =>
      expectText(value, "tree diff after mode"),
    );
    const afterOid = expectNullable(row.after_oid, (value) =>
      expectText(value, "tree diff after oid"),
    );
    yield { path, beforeMode, beforeOid, afterMode, afterOid };
  }
}
