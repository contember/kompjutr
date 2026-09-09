import type { SqlDatabase } from "@kompjutr/sqlite";
import { GitError } from "../../../common/errors.js";

export function assertTerminatingPromotions(
  db: SqlDatabase,
  repoId: number,
  promotedOids: ReadonlySet<unknown>,
  deletingPackIds: readonly number[],
): void {
  if (promotedOids.size === 0) return;
  const unsafe = db.scalar<number>(
    `WITH RECURSIVE closure(oid, base_oid) AS (
       SELECT object.oid, object.base_oid FROM json_each(?) promoted
        CROSS JOIN git_pack_objects object ON object.repo_id = ? AND object.oid = promoted.value
       UNION
       SELECT base.oid, base.base_oid FROM closure child
        CROSS JOIN git_pack_objects base ON base.repo_id = ? AND base.oid = child.base_oid
       JOIN git_pack_meta pack USING (repo_id, pack_id)
       WHERE pack.state = 'complete'
         AND base.pack_id NOT IN (SELECT value FROM json_each(?))
     ), terminating(oid) AS (
       SELECT child.oid FROM closure child
       WHERE child.base_oid IS NULL OR (
         NOT EXISTS (SELECT 1 FROM git_pack_objects base
           JOIN git_pack_meta pack USING (repo_id, pack_id)
           WHERE base.repo_id = ? AND base.oid = child.base_oid AND pack.state = 'complete'
             AND base.pack_id NOT IN (SELECT value FROM json_each(?)))
         AND EXISTS (SELECT 1 FROM git_objects loose
           WHERE loose.repo_id = ? AND loose.oid = child.base_oid)
       )
       UNION
       SELECT child.oid FROM terminating resolved
       JOIN closure child ON child.base_oid = resolved.oid
     )
     SELECT EXISTS (SELECT oid FROM closure EXCEPT SELECT oid FROM terminating)`,
    JSON.stringify([...promotedOids]),
    repoId,
    repoId,
    JSON.stringify(deletingPackIds),
    repoId,
    JSON.stringify(deletingPackIds),
    repoId,
  );
  if (unsafe !== 0) throw new GitError("EBUSY", "pack promotion has no terminating delta path");
}
