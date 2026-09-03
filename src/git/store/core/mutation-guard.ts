import type { SqlDatabase } from "../../../db/db.js";
import { GitError } from "../../common/errors.js";
import { isThenableResult } from "./json-pages.js";

const GIT_MUTATION_GUARD_KEY = "mutation_guard";

/** Run one synchronous public Git mutation under the database-local guard row. */
export function withGitMutationGuard<T>(db: SqlDatabase, body: () => T): T {
  return db.transactionSync(() => {
    const acquired = db.one<{ key: unknown }>(
      `INSERT INTO git_meta (key, value) VALUES (?, '')
       ON CONFLICT(key) DO NOTHING RETURNING key`,
      GIT_MUTATION_GUARD_KEY,
    );
    if (acquired === undefined) {
      throw new GitError("EREENTRANT", "synchronous Git mutation reentry is not allowed");
    }
    const result = body();
    if (isThenableResult(result)) {
      throw new GitError("EINVAL", "a synchronous Git mutation returned a promise");
    }
    db.run("DELETE FROM git_meta WHERE key = ?", GIT_MUTATION_GUARD_KEY);
    return result;
  });
}
