import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import { requireRefName } from "./ref-validation.js";

/** Where a short ref name is looked up, in git's own order. */
function refSearchCandidate(name: string, index: number): string {
  if (index === 0) return name;
  if (index === 1) return `refs/${name}`;
  if (index === 2) return `refs/tags/${name}`;
  if (index === 3) return `refs/heads/${name}`;
  if (index === 4) return `refs/remotes/${name}`;
  return `refs/remotes/${name}/HEAD`;
}

// The candidate is built in SQL so only the matching one is allocated here.
function refSearchExpression(index: number): string {
  if (index === 0) return "?";
  if (index === 1) return "'refs/' || ?";
  if (index === 2) return "'refs/tags/' || ?";
  if (index === 3) return "'refs/heads/' || ?";
  if (index === 4) return "'refs/remotes/' || ?";
  return "'refs/remotes/' || ? || '/HEAD'";
}

/** The first stored ref a short name names, or null. HEAD belongs to a checkout. */
export function expandRefName(db: SqlDatabase, repoId: number, name: string): string | null {
  const checkedName = requireRefName(name, "ref name", "input");
  for (let index = 0; index < 6; index++) {
    const present = db.scalar<unknown>(
      `SELECT 1 FROM git_refs
        WHERE repo_id = ? AND name = ${refSearchExpression(index)} LIMIT 1`,
      repoId,
      checkedName,
    );
    if (present === 1) return refSearchCandidate(checkedName, index);
    if (present !== undefined) {
      throw new CorruptError("ref existence query returned invalid state");
    }
  }
  return null;
}
