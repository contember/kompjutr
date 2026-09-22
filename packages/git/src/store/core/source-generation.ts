import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";

export const SOURCE_GENERATION_EXHAUSTED = "repository source generation is exhausted";

/**
 * Identity of the source set an ordinary complete read sees: for every OID,
 * which loose row or which complete pack serves it and which canonical delta
 * edge it carries. Pending sources are covered by ingest ownership instead.
 */
function requireRepositoryId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
}

function requireGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError("repository source generation is invalid");
  }
  return value;
}

/** Read the current source generation without creating any state. */
export function readRepositorySourceGeneration(db: SqlDatabase, repoId: number): number {
  requireRepositoryId(repoId);
  const stored = db.scalar<unknown>(
    "SELECT source_generation FROM git_repositories WHERE id = ?",
    repoId,
  );
  if (stored === undefined) throw new CorruptError("source generation repository is missing");
  return requireGeneration(stored);
}

/** Increment the source generation inside the caller's source-changing transaction. */
export function bumpRepositorySourceGeneration(db: SqlDatabase, repoId: number): number {
  requireRepositoryId(repoId);
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_repositories SET source_generation = source_generation + 1
      WHERE id = ? AND source_generation < ?
      RETURNING id, source_generation`,
    repoId,
    Number.MAX_SAFE_INTEGER,
  );
  if (row === undefined) {
    // Only the failure path pays for telling an absent repository from an
    // exhausted counter; the success path stays one statement.
    const present = db.scalar<unknown>(
      "SELECT EXISTS(SELECT 1 FROM git_repositories WHERE id = ?)",
      repoId,
    );
    if (present === 0) throw new CorruptError("source generation repository is missing");
    throw new GitError("E2BIG", SOURCE_GENERATION_EXHAUSTED);
  }
  if (row.id !== repoId) {
    throw new CorruptError("source generation belongs to another repository");
  }
  return requireGeneration(row.source_generation);
}
