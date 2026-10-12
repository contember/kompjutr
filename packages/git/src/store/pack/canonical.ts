/** SQL expressions passed here are internal; caller values stay in bindings. */
export function completePackEntriesSql(repo: string, oid: string): string {
  return `FROM git_pack_entries candidate INDEXED BY git_pack_entries_by_oid
          JOIN git_pack_meta owner
            ON owner.repo_id = candidate.repo_id AND owner.pack_id = candidate.pack_id
           AND owner.state = 'complete'
         WHERE candidate.repo_id = ${repo} AND candidate.oid = ${oid}`;
}

/** The index hint prevents ORDER BY from choosing a repository-wide primary-key scan. */
export function canonicalPackEntrySql(repo: string, oid: string): string {
  return `SELECT candidate.pack_id, candidate.offset
          ${completePackEntriesSql(repo, oid)}
          ORDER BY candidate.pack_id, candidate.offset LIMIT 1`;
}
