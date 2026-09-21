import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import { type CommitCacheEntry, writeCommitCachePages } from "./commits-cache.js";

const COLUMNS = `repo_id, oid, parents, tree,
  author_name, author_email, author_time, author_timezone,
  committer_name, committer_email, committer_time, committer_timezone,
  message, gpgsig, object_size, cache_bytes`;

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
      `INSERT INTO git_pack_commit_staging (${COLUMNS}, pack_id)
       SELECT json_extract(j.value, '$.r'), json_extract(j.value, '$.o'),
              json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
              CAST(json_extract(j.value, '$.an') AS BLOB),
              CAST(json_extract(j.value, '$.ae') AS BLOB),
              json_extract(j.value, '$.at'), json_extract(j.value, '$.az'),
              CAST(json_extract(j.value, '$.cn') AS BLOB),
              CAST(json_extract(j.value, '$.ce') AS BLOB),
              json_extract(j.value, '$.ct'), json_extract(j.value, '$.cz'),
              CAST(json_extract(j.value, '$.m') AS BLOB),
              CASE WHEN json_type(j.value, '$.g') = 'null' THEN NULL
                   ELSE CAST(json_extract(j.value, '$.g') AS BLOB) END,
              json_extract(j.value, '$.s'), json_extract(j.value, '$.b'), ?
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
  const staged = db.scalar<number>(
    "SELECT count(*) FROM git_pack_commit_staging WHERE repo_id = ? AND pack_id = ?",
    repoId,
    packId,
  );
  db.run(
    `INSERT INTO git_commits (${COLUMNS})
     SELECT ${COLUMNS} FROM git_pack_commit_staging WHERE repo_id = ? AND pack_id = ?
     ON CONFLICT(repo_id, oid) DO NOTHING`,
    repoId,
    packId,
  );
  const covered = db.scalar<number>(
    `SELECT count(*) FROM git_pack_commit_staging s
      JOIN git_commits c ON c.repo_id = s.repo_id AND c.oid = s.oid
     WHERE s.repo_id = ? AND s.pack_id = ?`,
    repoId,
    packId,
  );
  if (staged === undefined || covered !== staged) {
    throw new CorruptError("packed commit promotion did not cover every staged key");
  }
  db.run("DELETE FROM git_pack_commit_staging WHERE repo_id = ? AND pack_id = ?", repoId, packId);
}
