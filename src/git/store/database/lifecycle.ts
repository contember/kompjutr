import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { expectSafeInteger, int, oneOf, RowShape, text } from "../../common/rows.js";
import type { CheckoutRow, RepositoryLifecycle } from "../core/contracts.js";
import { JSON_ENCODER } from "../core/json-pages.js";
import { MAX_CHECKOUTS_PER_REPOSITORY, MAX_SCRATCH_INDEX_NAME_BYTES } from "../schema/schema.js";

export const CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES = 1_024;
export const PROVISIONAL_CLONE_LEASE_MS = 5 * 60 * 1_000;
export const PROVISIONAL_CLONE_RENEW_WINDOW_MS = PROVISIONAL_CLONE_LEASE_MS / 2;

const CHECKOUT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  root: text(),
  head: text(),
  is_primary: oneOf([0, 1]),
});

export function requireCheckoutRootInput(value: unknown): string {
  if (typeof value !== "string") {
    throw new GitError("EINVAL", "checkout root is invalid");
  }
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 0) {
      throw new GitError("EINVAL", "checkout root is invalid");
    }
  }
  return value;
}

export function isAttachedBranchUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: git_checkouts.repo_id, git_checkouts.head")
  );
}

export function isCheckoutRootUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed: git_checkouts.root")
  );
}

function requireCheckoutGeneration(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function readCheckoutRevision(db: SqlDatabase, repoId: number): number {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new CorruptError("checkout revision repository id is invalid");
  }
  const stored = db.scalar<unknown>(
    "SELECT checkout_revision FROM git_repositories WHERE id = ?",
    repoId,
  );
  if (stored === undefined) throw new CorruptError("checkout revision repository is missing");
  return expectSafeInteger(stored, 0, Number.MAX_SAFE_INTEGER, "stored checkout revision");
}

export function advanceCheckoutRevision(
  db: SqlDatabase,
  repoId: number,
  amount = 1,
  expectedRevision?: number,
): number {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new CorruptError("checkout revision increment is invalid");
  }
  const current =
    expectedRevision === undefined
      ? readCheckoutRevision(db, repoId)
      : requireCheckoutGeneration(expectedRevision, "expected checkout revision", 0);
  if (amount > Number.MAX_SAFE_INTEGER - current) {
    throw new GitError("E2BIG", "checkout revision is exhausted");
  }
  const next = current + amount;
  const updated = db.one<{ checkout_revision: unknown }>(
    `UPDATE git_repositories SET checkout_revision = ?
      WHERE id = ? AND checkout_revision = ?
      RETURNING checkout_revision`,
    next,
    repoId,
    current,
  );
  if (
    updated === undefined ||
    requireCheckoutGeneration(updated.checkout_revision, "updated checkout revision", 1) !== next
  ) {
    throw new CorruptError("checkout revision changed during atomic advancement");
  }
  return next;
}

/** Canonicalise an absolute workspace path without consulting the filesystem. */
export function normalizeRoot(path: string): string {
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function requireScratchIndexName(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new GitError("EINVAL", "scratch index name must be non-empty UTF-8 text");
  }
  const bytes = JSON_ENCODER.encode(value).byteLength;
  if (bytes < 1 || bytes > MAX_SCRATCH_INDEX_NAME_BYTES) {
    throw new GitError(
      "EINVAL",
      `scratch index name must be from 1 to ${MAX_SCRATCH_INDEX_NAME_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

export function requireSafeId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CorruptError(`${label} is not a safe positive integer`);
  }
  return value;
}

export function requireIdentityCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CorruptError(`${label} is not a safe nonnegative integer`);
  }
  return value;
}

export function requireStoredIdentityMaximum(value: unknown, label: string): number {
  return value === null ? 0 : requireSafeId(value, label);
}

export function nextIdentity(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new GitError("E2BIG", `${label} space is exhausted`);
  }
  return value + 1;
}

export function requireMilliseconds(
  value: unknown,
  label: string,
  source: "input" | "stored",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    if (source === "stored") throw new CorruptError(`${label} is invalid`);
    throw new GitError("EINVAL", `${label} must be a safe nonnegative integer`);
  }
  return value;
}

export function provisionalCloneExpiry(nowMs: number): number {
  if (nowMs > Number.MAX_SAFE_INTEGER - PROVISIONAL_CLONE_LEASE_MS) {
    throw new GitError("E2BIG", "clone lease clock exceeds its safe range");
  }
  return nowMs + PROVISIONAL_CLONE_LEASE_MS;
}

export interface StoredRepositoryLifecycle {
  repoId: number;
  lifecycle: RepositoryLifecycle;
  cloneGeneration: number | null;
  cloneExpiresMs: number | null;
}

export function requireStoredRepositoryLifecycle(
  row: Record<string, unknown>,
): StoredRepositoryLifecycle {
  const repoId = requireSafeId(row.repo_id, "repository id");
  const lifecycle = row.lifecycle;
  if (lifecycle !== "ready" && lifecycle !== "provisional") {
    throw new CorruptError("repository lifecycle is invalid");
  }
  const cloneGeneration =
    row.clone_generation === null ? null : requireSafeId(row.clone_generation, "clone generation");
  const cloneExpiresMs =
    row.clone_expires_ms === null
      ? null
      : requireMilliseconds(row.clone_expires_ms, "clone lease expiry", "stored");
  if (
    (lifecycle === "ready" && (cloneGeneration !== null || cloneExpiresMs !== null)) ||
    (lifecycle === "provisional" && (cloneGeneration === null || cloneExpiresMs === null))
  ) {
    throw new CorruptError("repository lifecycle fields are inconsistent");
  }
  return { repoId, lifecycle, cloneGeneration, cloneExpiresMs };
}

export interface StoredCheckoutLifecycle extends StoredRepositoryLifecycle {
  checkout: CheckoutRow;
}

export const CHECKOUT_LIFECYCLE_CARDINALITY_SQL = `
  (SELECT COUNT(*) FROM (
     SELECT 1 FROM git_checkouts membership
      WHERE membership.repo_id = checkout.repo_id
      LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}
   )) AS lifecycle_checkout_count,
  (SELECT COUNT(*) FROM (
     SELECT 1 FROM git_checkouts membership
      WHERE membership.repo_id = checkout.repo_id AND membership.is_primary = 1
      LIMIT 2
   )) AS lifecycle_primary_count`;

export function requireStoredCheckoutLifecycle(
  row: Record<string, unknown>,
): StoredCheckoutLifecycle {
  const checkout = requireStoredCheckoutRow(row);
  const repository = requireStoredRepositoryLifecycle(row);
  if (checkout.repoId !== repository.repoId) {
    throw new CorruptError("checkout lifecycle crossed repository boundaries");
  }
  return { ...repository, checkout };
}

export function requireCheckoutLifecycleCardinality(
  row: Record<string, unknown>,
  stored: StoredCheckoutLifecycle,
): void {
  const checkoutCount = expectSafeInteger(
    row.lifecycle_checkout_count,
    1,
    Number.MAX_SAFE_INTEGER,
    "repository checkout count",
  );
  if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
    throw new GitError("E2BIG", "repository exceeds 1,024 checkouts");
  }
  const primaryCount = expectSafeInteger(
    row.lifecycle_primary_count,
    0,
    checkoutCount,
    "repository primary checkout count",
  );
  if (primaryCount !== 1) {
    throw new CorruptError("repository must have exactly one primary checkout");
  }
  if (stored.lifecycle === "provisional" && (checkoutCount !== 1 || !stored.checkout.isPrimary)) {
    throw new CorruptError("provisional repository must have exactly one primary checkout");
  }
}

export function requireCheckoutRoot(value: unknown, source: "input" | "stored"): string {
  if (typeof value !== "string" || value.includes("\0")) {
    if (source === "stored") throw new CorruptError("checkout root is invalid");
    throw new GitError("EINVAL", "checkout root is invalid");
  }
  if (source === "stored") {
    if (
      !value.startsWith("/") ||
      (value.length > 1 && value.endsWith("/")) ||
      value.includes("//")
    ) {
      throw new CorruptError("checkout root is not canonical");
    }
    let segmentStart = 1;
    for (let index = 1; index <= value.length; index++) {
      if (index !== value.length && value.charCodeAt(index) !== 0x2f) continue;
      const segmentLength = index - segmentStart;
      if (
        (segmentLength === 1 && value.charCodeAt(segmentStart) === 0x2e) ||
        (segmentLength === 2 &&
          value.charCodeAt(segmentStart) === 0x2e &&
          value.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        throw new CorruptError("checkout root is not canonical");
      }
      segmentStart = index + 1;
    }
    return value;
  }
  return normalizeRoot(value);
}

export function requireStoredCheckoutRow(row: unknown): CheckoutRow {
  const stored = CHECKOUT_ROW.decode(row);
  return {
    id: stored.checkout_id,
    repoId: stored.repo_id,
    root: stored.root,
    head: stored.head,
    isPrimary: stored.is_primary === 1,
  };
}

/** Every ancestor of `path`, nearest first, ending at "/". */
export function ancestors(path: string): string[] {
  const normalized = normalizeRoot(path);
  const out: string[] = [];
  let current = normalized;
  while (current !== "/") {
    out.push(current);
    const slash = current.lastIndexOf("/");
    current = slash <= 0 ? "/" : current.slice(0, slash);
  }
  out.push("/");
  return out;
}

export function enforceForeignKeys(db: SqlDatabase): void {
  db.run("PRAGMA foreign_keys = ON");
  if (db.scalar<unknown>("PRAGMA foreign_keys") !== 1) {
    throw new Error("SQLite adapter did not enable foreign-key enforcement");
  }
}

export class CheckoutStoreLifetime {
  #active = true;

  requireActive(): void {
    if (!this.#active) {
      throw new GitError("EWORKTREENOTFOUND", "checkout is no longer active");
    }
  }

  revoke(): void {
    this.#active = false;
  }
}
