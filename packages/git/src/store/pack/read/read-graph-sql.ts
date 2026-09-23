// Shared pieces of the packed delta-closure queries. They expect a recursive
// `reachable(pack_id, offset)` CTE, a `seeds(oid)` CTE and a `starts` CTE built
// by `packGraphStartsSql`.

/**
 * Where each requested OID's chain starts. A read on behalf of a pending pack
 * starts at that pack's own entry, so its bases never depend on another pack's
 * canonical copy; every other OID starts at its complete canonical row. Binds
 * repository, pending pack, repository, pending pack.
 */
export function packGraphStartsSql(source: string): string {
  return `starts(pack_id, offset) AS MATERIALIZED (
       SELECT own.pack_id, own.offset
         FROM ${source} requested
         CROSS JOIN git_pack_entries own
        WHERE own.repo_id = ? AND own.oid = requested.oid AND own.pack_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries earlier
             WHERE earlier.repo_id = own.repo_id AND earlier.oid = own.oid
               AND earlier.pack_id = own.pack_id AND earlier.offset < own.offset
          )
       UNION ALL
       SELECT object.pack_id, object.offset
         FROM ${source} requested
         CROSS JOIN git_pack_objects object
         CROSS JOIN git_pack_meta pack
        WHERE object.repo_id = ? AND object.oid = requested.oid
          AND pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries own
             WHERE own.repo_id = object.repo_id AND own.oid = requested.oid AND own.pack_id = ?
          )
     )`;
}

/** Follow a reachable entry to its in-pack base, stopping at a seeded OID. */
export const PACK_GRAPH_BASE_STEP = `SELECT base.pack_id, base.offset
      FROM reachable
      CROSS JOIN git_pack_entries child
      CROSS JOIN git_pack_entries base
     WHERE child.repo_id = ? AND child.pack_id = reachable.pack_id AND child.offset = reachable.offset
       AND base.repo_id = child.repo_id AND base.pack_id = child.pack_id
       AND base.offset = child.base_offset
       AND NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)`;

/** Each reachable entry with its base's OID and whether a requested chain starts there. */
export const PACK_GRAPH_ENTRY_SELECT = `SELECT entry.oid, entry.pack_id, entry.offset,
         entry.data_off, entry.data_len, entry.type, entry.size, entry.entry_size,
         entry.base_offset, base.oid AS base_oid,
         EXISTS (
           SELECT 1 FROM starts
            WHERE starts.pack_id = entry.pack_id AND starts.offset = entry.offset
         ) AS start
    FROM reachable
    CROSS JOIN git_pack_entries entry
      ON entry.repo_id = ? AND entry.pack_id = reachable.pack_id AND entry.offset = reachable.offset
    LEFT JOIN git_pack_entries base
      ON base.repo_id = entry.repo_id AND base.pack_id = entry.pack_id
     AND base.offset = entry.base_offset`;
