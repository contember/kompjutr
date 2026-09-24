import type { SqlDatabase } from "@kompjutr/sqlite";
import {
  COMMIT_ROW_COLUMNS,
  COMMIT_ROW_JSON_COLUMNS,
  type CommitCacheEntry,
  writeCommitCachePages,
} from "./commits-cache.js";

export function stageCommitCaches(
  db: SqlDatabase,
  repoId: number,
  packId: number,
  entries: Iterable<CommitCacheEntry>,
) {
  return writeCommitCachePages(entries, (json) => {
    let admitted = 0;
    // Updating the same key still returns each admitted physical occurrence.
    for (const _row of db.iterate(
      `INSERT INTO git_pack_commit_staging (${COMMIT_ROW_COLUMNS}, pack_id)
       SELECT ${COMMIT_ROW_JSON_COLUMNS}, ?
         FROM json_each(?) j
        WHERE json_extract(j.value, '$.r') = ? AND EXISTS (
           SELECT 1 FROM git_pack_entries e INDEXED BY git_pack_entries_by_oid
          JOIN git_pack_meta m ON m.repo_id = e.repo_id AND m.pack_id = e.pack_id
           WHERE e.repo_id = json_extract(j.value, '$.r') AND e.pack_id = ?
             AND e.oid = json_extract(j.value, '$.o') AND e.type = 'commit'
             AND e.size = json_extract(j.value, '$.s') AND m.state = 'pending'
        )
       ON CONFLICT(repo_id, pack_id, oid) DO UPDATE SET oid = excluded.oid
       RETURNING oid`,
      packId,
      json,
      repoId,
      packId,
    ))
      admitted++;
    return admitted;
  });
}

export function promoteCommitCaches(db: SqlDatabase, repoId: number, packId: number): void {
  // Staging shares `git_commits`' columns and checks, and DO NOTHING absorbs only
  // the key conflict, so every staged key is inserted, already present, or aborts.
  db.run(
    `INSERT INTO git_commits (${COMMIT_ROW_COLUMNS})
     SELECT ${COMMIT_ROW_COLUMNS} FROM git_pack_commit_staging WHERE repo_id = ? AND pack_id = ?
     ON CONFLICT(repo_id, oid) DO NOTHING`,
    repoId,
    packId,
  );
  db.run("DELETE FROM git_pack_commit_staging WHERE repo_id = ? AND pack_id = ?", repoId, packId);
}
