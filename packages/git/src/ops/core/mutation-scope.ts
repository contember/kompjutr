import type { SqlDatabase } from "@kompjutr/sqlite";
import { GitError } from "../../common/errors.js";
import type { Worktree } from "../worktree/worktree.js";

function mutationScope(database: SqlDatabase): object {
  return database.mutationScope ?? database;
}

export function requireSharedDatabaseScope(
  contextDatabase: SqlDatabase,
  repositoryDatabase: SqlDatabase,
): void {
  if (mutationScope(contextDatabase) !== mutationScope(repositoryDatabase)) {
    throw new GitError("EUNSUPPORTED", "repository does not belong to the Git context database");
  }
}

export function requireSharedMutationScope(database: SqlDatabase, worktree: Worktree): void {
  if (worktree.mutationScope === undefined || worktree.mutationScope !== mutationScope(database)) {
    throw new GitError(
      "EUNSUPPORTED",
      "worktree mutation requires the drive and Git store to share one atomic mutation scope",
    );
  }
}
