import type { SqlDatabase } from "@kompjutr/sqlite";

// Selection must use the same lowest-pack/offset fallback as canonical promotion.
export const PACK_DEPENDENCY_QUERY = `WITH RECURSIVE target(repo_id, pack_id) AS (VALUES (?, ?)),
  replacements AS MATERIALIZED (
    SELECT base.oid, alternative.base_oid,
      (alternative.oid IS NOT NULL OR loose.oid IS NOT NULL) AS available
    FROM target pack CROSS JOIN git_pack_objects base
    LEFT JOIN git_pack_entries alternative
      ON alternative.repo_id = base.repo_id
      AND (alternative.pack_id, alternative.offset) = (
        SELECT candidate.pack_id, candidate.offset FROM git_pack_entries candidate
        JOIN git_pack_meta owner USING (repo_id, pack_id)
        WHERE candidate.repo_id = base.repo_id AND candidate.oid = base.oid
          AND candidate.pack_id != pack.pack_id AND owner.state = 'complete'
        ORDER BY candidate.pack_id, candidate.offset LIMIT 1
      )
    LEFT JOIN git_objects loose ON loose.repo_id = base.repo_id AND loose.oid = base.oid
    WHERE base.repo_id = pack.repo_id AND base.pack_id = pack.pack_id
  ), closure(oid, base_oid, available) AS (
    SELECT replacement.oid, replacement.base_oid, replacement.available
    FROM target pack CROSS JOIN replacements replacement
    WHERE replacement.base_oid IS NOT NULL
      OR EXISTS (SELECT 1 FROM git_pack_entries child
        WHERE child.repo_id = pack.repo_id AND child.base_oid = replacement.oid
          AND child.pack_id != pack.pack_id)
      OR EXISTS (SELECT 1 FROM git_pack_pending child
        WHERE child.repo_id = pack.repo_id AND child.base_oid = replacement.oid
          AND child.pack_id != pack.pack_id)
    UNION
    SELECT child.base_oid,
      CASE WHEN current.pack_id = pack.pack_id THEN replacement.base_oid
        WHEN owner.state = 'complete' THEN current.base_oid ELSE NULL END,
      CASE WHEN current.pack_id = pack.pack_id THEN replacement.available
        WHEN owner.state = 'complete' THEN 1 ELSE loose.oid IS NOT NULL END
    FROM closure child CROSS JOIN target pack
    LEFT JOIN git_pack_objects current
      ON current.repo_id = pack.repo_id AND current.oid = child.base_oid
    LEFT JOIN git_pack_meta owner
      ON owner.repo_id = current.repo_id AND owner.pack_id = current.pack_id
    LEFT JOIN replacements replacement ON replacement.oid = child.base_oid
    LEFT JOIN git_objects loose ON loose.repo_id = pack.repo_id AND loose.oid = child.base_oid
    WHERE child.available = 1 AND child.base_oid IS NOT NULL
  ), terminating(oid) AS (
    SELECT oid FROM closure WHERE available = 1 AND base_oid IS NULL
    UNION
    SELECT child.oid FROM terminating resolved
    JOIN closure child ON child.base_oid = resolved.oid AND child.available = 1
  )
  SELECT EXISTS (SELECT oid FROM closure EXCEPT SELECT oid FROM terminating) AS required`;

export function hasRequiredPackDependency(
  db: SqlDatabase,
  repoId: number,
  packId: number,
): boolean {
  return db.scalar<number>(PACK_DEPENDENCY_QUERY, repoId, packId) !== 0;
}
