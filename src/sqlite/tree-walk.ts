import { CorruptError, GitError } from "../core/errors.js";
import type { SqlDatabase } from "./db.js";
import { TREE_QUEUE_ROW_FIXED_BYTES } from "./schema.js";

const TREE_WALK_STATE_BYTES = 8 * 1024 * 1024;
export const TREE_WALK_PATH_BYTES = 2_200;
const TREE_WALK_QUEUE_BYTES = 16 * 1024 * 1024;

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

export const WALK_TREE_SQL = `WITH RECURSIVE
  params(repo_id, root_oid, path_cap, state_cap, queue_cap, queue_fixed)
    AS (VALUES (?, ?, ?, ?, ?, ?)),
  source_valid(repo_id, tree_oid, storage, source_id, object_size,
               entry_count, base_cost) AS NOT MATERIALIZED (
    SELECT x.repo_id, x.tree_oid, x.storage, x.source_id, s.object_size,
           s.entry_count, s.base_cost
      FROM git_tree_effective x
      CROSS JOIN params p
      CROSS JOIN git_tree_sources s
     WHERE x.repo_id = p.repo_id
       AND length(x.tree_oid) = 40 AND x.tree_oid NOT GLOB '*[^0-9a-f]*'
       AND s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.storage = x.storage AND s.source_id = x.source_id
       AND s.entry_count >= 0 AND s.object_size >= 0
       AND s.base_cost = s.object_size + (p.queue_fixed + 18) * s.entry_count
       AND (
         (x.storage = 'loose' AND x.source_id = 0 AND EXISTS (
           SELECT 1 FROM git_objects o
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.type = 'tree' AND o.size = s.object_size
         ))
         OR
         (x.storage = 'pack' AND EXISTS (
           SELECT 1
             FROM git_pack_objects o
             JOIN git_pack_meta m
               ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND m.state = 'complete'
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.pack_id = x.source_id AND o.type = 'tree'
              AND o.size = s.object_size
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM git_tree_entries e
          WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
            AND e.storage = s.storage AND e.source_id = s.source_id
            AND e.ordinal IN (-1, s.entry_count)
       )
       AND (
         (s.entry_count = 0 AND s.base_cost = 0)
         OR EXISTS (
           SELECT 1 FROM git_tree_entries e
            WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
              AND e.storage = s.storage AND e.source_id = s.source_id
              AND e.ordinal = s.entry_count - 1
              AND e.cumulative_base = s.base_cost
         )
       )
  ),
  walk(path, mode, oid, ancestry, sort_key, error, error_code,
       path_bytes, state_bytes, descend, reserved_bytes) AS (
    SELECT CASE
             WHEN length(e.name_bytes) <= p.path_cap
               AND length(CAST(e.name AS BLOB)) <= p.path_cap THEN e.name
             ELSE NULL
           END,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           '/' || p.root_oid || '/', printf('%08x', e.ordinal),
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree path exceeds 2200 bytes'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             WHEN length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal state exceeds 8 MiB'
             ELSE NULL
           END,
           CASE WHEN length(e.name_bytes) > p.path_cap
                  OR length(CAST(e.name AS BLOB)) > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           length(e.name_bytes), length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND length(e.oid) = 40 AND e.oid NOT GLOB '*[^0-9a-f]*'
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
       AND e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
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
               AND length(CAST(w.path AS BLOB)) + 1 + length(CAST(e.name AS BLOB))
                     <= p.path_cap
               THEN w.path || '/' || e.name
             ELSE NULL
           END,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           w.ancestry || w.oid || '/', w.sort_key || printf('%08x', e.ordinal),
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree entry name exceeds the path limit'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
               THEN 'tree path exceeds 2200 bytes'
             WHEN w.state_bytes + 1 + length(e.name_bytes) + 41 + 8 > p.state_cap
               THEN 'tree traversal state exceeds 8 MiB'
             ELSE NULL
           END,
           CASE WHEN w.path_bytes + 1 + length(e.name_bytes) > p.path_cap
                  OR length(CAST(w.path AS BLOB)) + 1 + length(CAST(e.name AS BLOB))
                       > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END,
           w.path_bytes + 1 + length(e.name_bytes),
           w.state_bytes + 1 + length(e.name_bytes) + 41 + 8,
           CASE WHEN e.mode IN ('40000', '040000')
                  AND length(e.oid) = 40 AND e.oid NOT GLOB '*[^0-9a-f]*'
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
       AND e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
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

const WALK_TREE_DIFF_SQL = `WITH RECURSIVE
  params(repo_id, before_root, after_root, path_cap, state_cap, queue_cap, queue_fixed,
         emit_objects)
    AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?)),
  source_valid(repo_id, tree_oid, storage, source_id, object_size,
               entry_count, base_cost) AS NOT MATERIALIZED (
    SELECT x.repo_id, x.tree_oid, x.storage, x.source_id, s.object_size,
           s.entry_count, s.base_cost
      FROM git_tree_effective x
      CROSS JOIN params p
      CROSS JOIN git_tree_sources s
     WHERE x.repo_id = p.repo_id
       AND length(x.tree_oid) = 40 AND x.tree_oid NOT GLOB '*[^0-9a-f]*'
       AND s.repo_id = x.repo_id AND s.tree_oid = x.tree_oid
       AND s.storage = x.storage AND s.source_id = x.source_id
       AND s.entry_count >= 0 AND s.object_size >= 0
       AND s.base_cost = s.object_size + (p.queue_fixed + 18) * s.entry_count
       AND (
         (x.storage = 'loose' AND x.source_id = 0 AND EXISTS (
           SELECT 1 FROM git_objects o
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.type = 'tree' AND o.size = s.object_size
         ))
         OR
         (x.storage = 'pack' AND EXISTS (
           SELECT 1 FROM git_pack_objects o
             JOIN git_pack_meta m
               ON m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND m.state = 'complete'
            WHERE o.repo_id = x.repo_id AND o.oid = x.tree_oid
              AND o.pack_id = x.source_id AND o.type = 'tree'
              AND o.size = s.object_size
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM git_tree_entries e
          WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
            AND e.storage = s.storage AND e.source_id = s.source_id
            AND e.ordinal IN (-1, s.entry_count)
       )
       AND (
         (s.entry_count = 0 AND s.base_cost = 0)
         OR EXISTS (
           SELECT 1 FROM git_tree_entries e
            WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
              AND e.storage = s.storage AND e.source_id = s.source_id
              AND e.ordinal = s.entry_count - 1
              AND e.cumulative_base = s.base_cost
         )
       )
  ),
  edge(repo_id, tree_oid, storage, source_id, ordinal, cumulative_base, name, name_bytes,
       mode, oid, error, error_code) AS NOT MATERIALIZED (
    SELECT e.repo_id, e.tree_oid, e.storage, e.source_id, e.ordinal, e.cumulative_base,
           CASE WHEN length(e.name_bytes) <= p.path_cap
                  AND length(CAST(e.name AS BLOB)) <= p.path_cap THEN e.name ELSE NULL END,
           e.name_bytes,
           CASE WHEN length(e.mode) <= 6 THEN e.mode ELSE NULL END,
           CASE WHEN length(e.oid) <= 40 THEN e.oid ELSE NULL END,
           CASE
             WHEN e.ordinal < 0 OR e.ordinal >= s.entry_count
               THEN 'tree entries do not match the parsed source marker'
             WHEN e.ordinal > 0 AND NOT EXISTS (
               SELECT 1 FROM git_tree_entries previous
                WHERE previous.repo_id = e.repo_id AND previous.tree_oid = e.tree_oid
                  AND previous.storage = e.storage AND previous.source_id = e.source_id
                  AND previous.ordinal = e.ordinal - 1
             ) THEN 'tree entries contain an ordinal gap'
             WHEN e.cumulative_base != p.queue_fixed + length(e.name_bytes)
                    + length(CAST(e.mode AS BLOB)) + length(CAST(e.oid AS BLOB))
                    + COALESCE((
                        SELECT previous.cumulative_base FROM git_tree_entries previous
                         WHERE previous.repo_id = e.repo_id
                           AND previous.tree_oid = e.tree_oid
                           AND previous.storage = e.storage
                           AND previous.source_id = e.source_id
                           AND previous.ordinal = e.ordinal - 1
                      ), 0)
               THEN 'tree queue metadata is inconsistent'
             WHEN length(e.name_bytes) > p.path_cap
               OR length(CAST(e.name AS BLOB)) > p.path_cap
               THEN 'tree entry name exceeds the path limit'
             WHEN length(e.raw_entry) > p.path_cap + 64
               THEN 'tree entry integrity payload is too large'
             WHEN e.mode NOT IN ('40000', '040000', '100644', '100755', '120000', '160000')
               THEN 'tree entry has an invalid mode'
             WHEN length(e.name_bytes) = 0 OR instr(CAST(e.name_bytes AS TEXT), '/') != 0
               OR CAST(e.name_bytes AS TEXT) != e.name
               THEN 'tree entry has an invalid name'
             WHEN length(e.oid) != 40 OR e.oid GLOB '*[^0-9a-f]*'
               THEN 'tree entry has an invalid oid'
             WHEN length(e.raw_entry) != length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 22
               OR CAST(substr(e.raw_entry, 1, length(CAST(e.mode AS BLOB))) AS BLOB)
                    != CAST(e.mode AS BLOB)
               OR hex(substr(e.raw_entry, length(CAST(e.mode AS BLOB)) + 1, 1)) != '20'
               OR CAST(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + 2, length(e.name_bytes)
                  ) AS BLOB) != e.name_bytes
               OR hex(substr(
                    e.raw_entry, length(CAST(e.mode AS BLOB)) + length(e.name_bytes) + 2, 1
                  )) != '00'
               OR lower(hex(substr(e.raw_entry, -20))) != e.oid
               THEN 'tree entry integrity check failed'
             ELSE NULL
           END,
           CASE WHEN length(e.name_bytes) > p.path_cap
                  OR length(CAST(e.name AS BLOB)) > p.path_cap
                THEN 'E2BIG' ELSE 'ECORRUPT' END
      FROM params p
      CROSS JOIN source_valid s
      CROSS JOIN git_tree_entries e
     WHERE e.repo_id = s.repo_id AND e.tree_oid = s.tree_oid
       AND e.storage = s.storage AND e.source_id = s.source_id
  ),
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
             WHEN p.before_root IS NOT NULL AND p.before_root IS NOT p.after_root AND NOT EXISTS (
               SELECT 1 FROM source_valid s
                WHERE s.repo_id = p.repo_id AND s.tree_oid = p.before_root
             ) THEN 'tree source is invalid; reimport or reclone'
             WHEN p.after_root IS NOT NULL AND p.before_root IS NOT p.after_root AND NOT EXISTS (
               SELECT 1 FROM source_valid s
                WHERE s.repo_id = p.repo_id AND s.tree_oid = p.after_root
             ) THEN 'tree source is invalid; reimport or reclone'
             WHEN COALESCE((SELECT s.base_cost + s.object_size + s.entry_count * 51
                              FROM source_valid s
                             WHERE s.repo_id = p.repo_id AND s.tree_oid = p.before_root), 0)
                    + COALESCE((SELECT s.base_cost + s.object_size + s.entry_count * 51
                                  FROM source_valid s
                                 WHERE s.repo_id = p.repo_id AND s.tree_oid = p.after_root), 0)
                    > p.queue_cap
               THEN 'tree traversal queue exceeds 16 MiB'
             ELSE NULL
           END,
           CASE WHEN COALESCE((SELECT s.base_cost + s.object_size + s.entry_count * 51
                                 FROM source_valid s
                                WHERE s.repo_id = p.repo_id AND s.tree_oid = p.before_root), 0)
                           + COALESCE((SELECT s.base_cost + s.object_size + s.entry_count * 51
                                       FROM source_valid s
                                      WHERE s.repo_id = p.repo_id AND s.tree_oid = p.after_root), 0)
                           > p.queue_cap THEN 'E2BIG' ELSE 'ECORRUPT' END
      FROM params p
     WHERE p.before_root IS NOT p.after_root
    UNION ALL
    SELECT w.path, w.path_bytes, w.sort_key,
           w.before_mode, w.before_oid, w.after_mode, w.after_oid,
           w.before_ancestry, w.after_ancestry, w.state_bytes, w.reserved_bytes,
           'tree traversal queue exceeds 16 MiB', 'E2BIG'
      FROM walk w
      CROSS JOIN params p
      LEFT JOIN source_valid bps
        ON bps.repo_id = p.repo_id AND bps.tree_oid = w.before_oid
       AND w.before_mode IN ('40000', '040000')
       AND NOT (COALESCE(w.after_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
      LEFT JOIN source_valid aps
        ON aps.repo_id = p.repo_id AND aps.tree_oid = w.after_oid
       AND w.after_mode IN ('40000', '040000')
       AND NOT (COALESCE(w.before_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
     WHERE w.error IS NULL
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
    SELECT CASE WHEN w.path = '' THEN be.name ELSE w.path || '/' || be.name END,
           w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END + length(be.name_bytes),
           CAST(CAST(CASE WHEN w.path = '' THEN be.name ELSE w.path || '/' || be.name END AS BLOB)
                || CASE WHEN be.mode NOT IN ('40000', '040000')
                          OR ae.mode NOT IN ('40000', '040000') THEN x'00' ELSE x'2f' END AS BLOB),
           be.mode, be.oid, ae.mode, ae.oid,
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
           COALESCE(be.error, ae.error,
             CASE WHEN w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                                + length(be.name_bytes) > p.path_cap
                    THEN 'tree path exceeds 2200 bytes'
                  WHEN w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
                                + length(be.name_bytes)) + 100 > p.state_cap
                    THEN 'tree traversal state exceeds 8 MiB'
                  WHEN be.mode IN ('40000', '040000')
                       AND instr(CASE WHEN w.path = '' THEN w.before_ancestry
                                      ELSE w.before_ancestry || w.before_oid || '/' END,
                                 '/' || be.oid || '/') != 0
                    THEN 'tree cycle at ' || be.oid
                  WHEN ae.mode IN ('40000', '040000')
                       AND instr(CASE WHEN w.path = '' THEN w.after_ancestry
                                      WHEN w.after_mode IN ('40000', '040000')
                                        THEN w.after_ancestry || w.after_oid || '/'
                                      ELSE w.after_ancestry END,
                                 '/' || ae.oid || '/') != 0
                    THEN 'tree cycle at ' || ae.oid
                  WHEN be.mode IN ('40000', '040000')
                       AND NOT (COALESCE(ae.mode IN ('40000', '040000'), 0) AND be.oid = ae.oid)
                       AND bs.tree_oid IS NULL
                    THEN 'tree ' || be.oid || ' has no valid v3 parsed source; reimport or reclone'
                  WHEN ae.mode IN ('40000', '040000')
                       AND NOT (COALESCE(be.mode IN ('40000', '040000'), 0) AND be.oid = ae.oid)
                       AND ats.tree_oid IS NULL
                    THEN 'tree ' || ae.oid || ' has no valid v3 parsed source; reimport or reclone'
                  ELSE NULL END),
           CASE WHEN be.error_code = 'E2BIG' OR ae.error_code = 'E2BIG'
                       OR w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                            + length(be.name_bytes) > p.path_cap
                  THEN 'E2BIG' ELSE 'ECORRUPT' END
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN edge be
      LEFT JOIN edge ae
        ON ae.repo_id = p.repo_id AND ae.tree_oid = w.after_oid
       AND ae.name_bytes = be.name_bytes
      LEFT JOIN source_valid bs
        ON bs.repo_id = p.repo_id AND bs.tree_oid = be.oid
       AND be.mode IN ('40000', '040000')
       AND NOT (COALESCE(ae.mode IN ('40000', '040000'), 0) AND be.oid = ae.oid)
      LEFT JOIN source_valid ats
        ON ats.repo_id = p.repo_id AND ats.tree_oid = ae.oid
       AND ae.mode IN ('40000', '040000')
       AND NOT (COALESCE(be.mode IN ('40000', '040000'), 0) AND be.oid = ae.oid)
      CROSS JOIN source_valid bps
      LEFT JOIN source_valid aps
        ON aps.repo_id = p.repo_id AND aps.tree_oid = w.after_oid
       AND w.after_mode IN ('40000', '040000')
     WHERE w.error IS NULL
       AND (w.before_mode IN ('40000', '040000'))
       AND NOT (COALESCE(w.after_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
       AND be.repo_id = p.repo_id AND be.tree_oid = w.before_oid
       AND bps.repo_id = p.repo_id AND bps.tree_oid = w.before_oid
       AND w.reserved_bytes
             + bps.base_cost + bps.object_size + bps.entry_count * (w.state_bytes + 51)
             + COALESCE(aps.base_cost + aps.object_size
                          + aps.entry_count * (w.state_bytes + 51), 0)
           <= p.queue_cap
    UNION ALL
    SELECT CASE WHEN w.path = '' THEN ae.name ELSE w.path || '/' || ae.name END,
           w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END + length(ae.name_bytes),
           CAST(CAST(CASE WHEN w.path = '' THEN ae.name ELSE w.path || '/' || ae.name END AS BLOB)
                || CASE WHEN ae.mode NOT IN ('40000', '040000') THEN x'00' ELSE x'2f' END AS BLOB),
           NULL, NULL, ae.mode, ae.oid,
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
           COALESCE(ae.error,
             CASE WHEN w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                                + length(ae.name_bytes) > p.path_cap
                    THEN 'tree path exceeds 2200 bytes'
                  WHEN w.state_bytes + 2 * (CASE WHEN w.path = '' THEN 0 ELSE 1 END
                                + length(ae.name_bytes)) + 55 > p.state_cap
                    THEN 'tree traversal state exceeds 8 MiB'
                  WHEN ae.mode IN ('40000', '040000')
                       AND instr(CASE WHEN w.path = '' THEN w.after_ancestry
                                      ELSE w.after_ancestry || w.after_oid || '/' END,
                                 '/' || ae.oid || '/') != 0
                    THEN 'tree cycle at ' || ae.oid
                  WHEN ae.mode IN ('40000', '040000') AND ats.tree_oid IS NULL
                    THEN 'tree ' || ae.oid || ' has no valid v3 parsed source; reimport or reclone'
                  ELSE NULL END),
           CASE WHEN ae.error_code = 'E2BIG'
                       OR w.path_bytes + CASE WHEN w.path = '' THEN 0 ELSE 1 END
                            + length(ae.name_bytes) > p.path_cap
                  THEN 'E2BIG' ELSE 'ECORRUPT' END
      FROM walk w
      CROSS JOIN params p
      CROSS JOIN edge ae
      LEFT JOIN edge be
        ON be.repo_id = p.repo_id AND be.tree_oid = w.before_oid
       AND be.name_bytes = ae.name_bytes
      LEFT JOIN source_valid ats
       ON ats.repo_id = p.repo_id AND ats.tree_oid = ae.oid
       AND ae.mode IN ('40000', '040000')
      CROSS JOIN source_valid aps
      LEFT JOIN source_valid bps
        ON bps.repo_id = p.repo_id AND bps.tree_oid = w.before_oid
       AND w.before_mode IN ('40000', '040000')
     WHERE w.error IS NULL
       AND w.after_mode IN ('40000', '040000')
       AND NOT (COALESCE(w.before_mode IN ('40000', '040000'), 0)
                AND w.before_oid = w.after_oid)
       AND ae.repo_id = p.repo_id AND ae.tree_oid = w.after_oid
       AND aps.repo_id = p.repo_id AND aps.tree_oid = w.after_oid
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
       error, error_code
  FROM walk
  CROSS JOIN params p
 WHERE error IS NOT NULL
    OR ((before_mode NOT IN ('40000', '040000') OR after_mode NOT IN ('40000', '040000'))
        AND NOT (before_mode IS after_mode AND before_oid IS after_oid))
    OR (p.emit_objects != 0 AND after_mode IN ('40000', '040000')
        AND NOT (COALESCE(before_mode IN ('40000', '040000'), 0)
                 AND before_oid = after_oid))`;

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
    const error = row.error;
    if (typeof error === "string") {
      if (row.error_code === "E2BIG") throw new GitError("E2BIG", error);
      throw new CorruptError(error);
    }
    const path = row.path;
    const mode = row.mode;
    const oid = row.oid;
    if (typeof path !== "string" || typeof mode !== "string" || typeof oid !== "string") {
      throw new CorruptError("tree traversal yielded an invalid row");
    }
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
    const error = row.error;
    if (typeof error === "string") {
      if (row.error_code === "E2BIG") throw new GitError("E2BIG", error);
      throw new CorruptError(error);
    }
    const mode = row.object_mode;
    const oid = row.object_oid;
    if (mode === null && oid === null) continue;
    if (typeof mode !== "string" || typeof oid !== "string") {
      throw new CorruptError("tree diff object traversal yielded an invalid row");
    }
    if (mode === "160000") continue;
    yield { oid, type: mode === "40000" || mode === "040000" ? "tree" : "blob" };
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
    const error = row.error;
    if (typeof error === "string") {
      if (row.error_code === "E2BIG") throw new GitError("E2BIG", error);
      throw new CorruptError(error);
    }
    const path = row.path;
    const beforeMode = row.before_mode;
    const beforeOid = row.before_oid;
    const afterMode = row.after_mode;
    const afterOid = row.after_oid;
    if (
      typeof path !== "string" ||
      (beforeMode !== null && typeof beforeMode !== "string") ||
      (beforeOid !== null && typeof beforeOid !== "string") ||
      (afterMode !== null && typeof afterMode !== "string") ||
      (afterOid !== null && typeof afterOid !== "string") ||
      (beforeMode === null) !== (beforeOid === null) ||
      (afterMode === null) !== (afterOid === null)
    ) {
      throw new CorruptError("tree diff yielded an invalid row");
    }
    yield { path, beforeMode, beforeOid, afterMode, afterOid };
  }
}
