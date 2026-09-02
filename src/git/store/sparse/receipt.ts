import type { SqlDatabase } from "../../../db/db.js";

export type SparseSourceKind = "workspace" | "selected-paths" | "commit-tree";

interface SparseSourceReceipt {
  readonly database: SqlDatabase;
  readonly kind: SparseSourceKind;
}

const RECEIPTS = new WeakMap<object, SparseSourceReceipt>();

/** Bind one native source object to the exact database that produced it. */
export function bindSparseSource<T extends object>(
  database: SqlDatabase,
  kind: SparseSourceKind,
  source: T,
): T {
  Object.freeze(source);
  RECEIPTS.set(source, Object.freeze({ database, kind }));
  return source;
}

/** Internal provenance check. Structural copies and wrappers have no receipt. */
export function hasSparseSourceReceipt(
  database: SqlDatabase,
  kind: SparseSourceKind,
  source: object,
): boolean {
  const receipt = RECEIPTS.get(source);
  return receipt?.database === database && receipt.kind === kind;
}
