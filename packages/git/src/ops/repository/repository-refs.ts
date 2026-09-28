import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import type { CheckoutStore, SharedRepoStore } from "../../store/index.js";

interface RefRepository {
  readonly checkout: Pick<CheckoutStore, "head">;
  readonly store: Pick<SharedRepoStore, "expandRefName" | "getRef">;
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
  return name === "HEAD" ? "HEAD" : repo.store.expandRefName(name);
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
