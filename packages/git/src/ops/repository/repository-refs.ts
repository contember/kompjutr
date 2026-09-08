import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import type { CheckoutStore, SharedRepoStore } from "../../store/index.js";
import { requireRefName } from "../../store/refs/ref-validation.js";

/** Where a short ref name is looked up, in git's own order. */
function refSearchCandidate(name: string, index: number): string {
  if (index === 0) return name;
  if (index === 1) return `refs/${name}`;
  if (index === 2) return `refs/tags/${name}`;
  if (index === 3) return `refs/heads/${name}`;
  if (index === 4) return `refs/remotes/${name}`;
  return `refs/remotes/${name}/HEAD`;
}

function refSearchExpression(index: number): string {
  if (index === 0) return "?";
  if (index === 1) return "'refs/' || ?";
  if (index === 2) return "'refs/tags/' || ?";
  if (index === 3) return "'refs/heads/' || ?";
  if (index === 4) return "'refs/remotes/' || ?";
  return "'refs/remotes/' || ? || '/HEAD'";
}

interface RefRepository {
  readonly checkout: Pick<CheckoutStore, "head">;
  readonly store: Pick<SharedRepoStore, "db" | "getRef" | "repoId">;
}

export interface ResolvedHead {
  /** Full ref name HEAD points at, or null when detached. */
  ref: string | null;
  /** The commit HEAD resolves to, or null on an unborn branch. */
  oid: string | null;
}

/** Internal ref read that retains the exact stored target in its caller's lifetime. */
export function readRawRefOwned(repo: RefRepository, name: string): string | null {
  return name === "HEAD" ? repo.checkout.head() : repo.store.getRef(name);
}

/** Internal symbolic-target allocation charged before the slice exists. */
export function symbolicTargetOwned(raw: string): string | null {
  return raw.startsWith("ref: ") ? raw.slice(5) : null;
}

/** Internal ref expansion whose constructed candidate stays in the caller's lifetime. */
export function expandRefOwned(repo: RefRepository, name: string): string | null {
  if (name === "HEAD") return "HEAD";
  const checkedName = requireRefName(name, "ref name", "input", true);
  for (let index = 0; index < 6; index++) {
    const present = repo.store.db.scalar<unknown>(
      `SELECT 1 FROM git_refs
        WHERE repo_id = ? AND name = ${refSearchExpression(index)} LIMIT 1`,
      repo.store.repoId,
      checkedName,
    );
    if (present === 1) return refSearchCandidate(checkedName, index);
    if (present !== undefined) {
      throw new CorruptError("ref existence query returned invalid state");
    }
  }
  return null;
}

/** Internal symbolic resolution that retains every stored hop and derived target. */
export function resolveRefOwned(repo: RefRepository, name: string): string | null {
  let current = name;
  for (let hops = 0; hops < 8; hops++) {
    const full = expandRefOwned(repo, current);
    if (full === null) return null;
    const value = readRawRefOwned(repo, full);
    if (value === null) return null;
    const target = symbolicTargetOwned(value);
    if (target !== null) {
      current = target;
      continue;
    }
    return value;
  }
  throw new CorruptError(`symbolic ref loop at ${name}`);
}

/** Internal HEAD resolution retained through the caller's graph work. */
export function resolveHeadOwned(repo: RefRepository): ResolvedHead {
  const raw = readRawRefOwned(repo, "HEAD");
  if (raw === null) throw new CorruptError("checkout HEAD is missing");
  const ref = symbolicTargetOwned(raw);
  if (ref !== null) {
    const value = readRawRefOwned(repo, ref);
    return { ref, oid: value };
  }
  return { ref: null, oid: isOid(raw) ? raw : null };
}
