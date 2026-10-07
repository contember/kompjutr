import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError, ObjectNotFoundError } from "../../common/errors.js";
import { expectNullable, expectText } from "../../common/rows.js";
import { TREE_QUEUE_ROW_FIXED_BYTES } from "../schema/schema.js";
import { ensureTreeClosure, type TreeObjectReader } from "./tree-closure.js";
import { WALK_TREE_DIFF_SQL, WALK_TREE_SQL } from "./tree-walk-sql.js";

export { WALK_TREE_SQL } from "./tree-walk-sql.js";

const TREE_WALK_QUEUE_BYTES = 16 * 1024 * 1024;
// Caller-unbounded traversal state must fail before the recursive CTE expands it.
export const TREE_WALK_PATH_BYTES = 7_456_512;
export const TREE_WALK_STATE_BYTES = 64 * 1024 * 1024;
export const CHECKED_TREE_CACHE_SIZE = 128;

export interface WalkTreeEntry {
  path: string;
  mode: string;
  oid: string;
}

export interface WalkTreeDiffEntry {
  path: string;
  beforeMode: string | null;
  beforeOid: string | null;
  afterMode: string | null;
  afterOid: string | null;
}

export interface WalkTreeDiffObject {
  oid: string;
  type: "tree" | "blob";
}

/**
 * A walk row's error. Under the downward-closed invariant (ADR-0030), a
 * subtree with no source row is an absent tree; one whose source is
 * incomplete cannot be projected. A root without a row is retried first.
 */
function throwTraversalError(row: Record<string, unknown>, label: string): void {
  const error = row.error;
  if (error === null) return;
  const message = expectText(error, `${label} error`);
  const errorCode = expectText(row.error_code, `${label} error code`);
  if (errorCode === "E2BIG") throw new GitError("E2BIG", message);
  const kind = expectNullable(row.error_kind, (value) => expectText(value, `${label} error kind`));
  if (kind === "missing_source") {
    throw new ObjectNotFoundError(expectText(row.error_oid, `${label} error oid`));
  }
  if (kind === "missing_root") throw new CorruptError(`${label} root is still not projected`);
  if (kind !== null && kind !== "incomplete_source") {
    throw new CorruptError(`${label} error kind is invalid`);
  }
  throw new CorruptError(message);
}

function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

function isMissingRoot(row: Record<string, unknown>): boolean {
  return row.error !== null && row.error_kind === "missing_root";
}

/**
 * Run a walk statement and yield its rows. A first row reporting that a root
 * has no projection closes the cursor, projects the roots' closures and runs
 * the statement once more (ADR-0030); a walk over projected trees costs no
 * extra statement.
 */
function* projectedWalk(
  db: SqlDatabase,
  repoId: number,
  objects: TreeObjectReader,
  roots: readonly (string | null)[],
  run: () => Iterable<Record<string, unknown>>,
): Generator<Record<string, unknown>> {
  let cursor = run()[Symbol.iterator]();
  try {
    let step = cursor.next();
    if (!step.done && isMissingRoot(step.value)) {
      cursor.return?.();
      ensureTreeClosure(
        db,
        repoId,
        objects,
        roots.filter((root) => root !== null),
      );
      cursor = run()[Symbol.iterator]();
      step = cursor.next();
    }
    while (!step.done) {
      yield step.value;
      step = cursor.next();
    }
  } finally {
    cursor.return?.();
  }
}

/** Stream every non-tree entry in raw Git DFS order with one SQL statement. */
export function* iterateTree(
  db: SqlDatabase,
  repoId: number,
  objects: TreeObjectReader,
  treeOid: string,
): Generator<WalkTreeEntry> {
  const run = () =>
    db.iterate(
      WALK_TREE_SQL,
      repoId,
      treeOid,
      TREE_WALK_PATH_BYTES,
      TREE_WALK_STATE_BYTES,
      TREE_WALK_QUEUE_BYTES,
      TREE_QUEUE_ROW_FIXED_BYTES,
    );
  for (const row of projectedWalk(db, repoId, objects, [treeOid], run)) {
    throwTraversalError(row, "tree traversal");
    const path = expectText(row.path, "tree traversal path");
    const mode = expectText(row.mode, "tree traversal mode");
    const oid = expectText(row.oid, "tree traversal oid");
    yield { path, mode, oid };
  }
}

/** Stream the tree and blob objects introduced by one tree transition. */
export function* iterateTreeDiffObjects(
  db: SqlDatabase,
  repoId: number,
  objects: TreeObjectReader,
  beforeTreeOid: string | null,
  afterTreeOid: string,
  checkedTrees: ReadonlySet<string> = new Set(),
): Generator<WalkTreeDiffObject> {
  if (beforeTreeOid === afterTreeOid) return;
  // Only the per-pack reference check, inside its publication transaction, reuses checked subtrees.
  const snapshot: string[] = [];
  if (beforeTreeOid === null) {
    let examined = 0;
    for (const oid of checkedTrees) {
      if (examined === CHECKED_TREE_CACHE_SIZE) break;
      examined++;
      if (oid.length === 40) snapshot.push(oid);
    }
  }
  const run = () =>
    db.iterate(
      WALK_TREE_DIFF_SQL,
      repoId,
      beforeTreeOid,
      afterTreeOid,
      TREE_WALK_PATH_BYTES,
      TREE_WALK_STATE_BYTES,
      TREE_WALK_QUEUE_BYTES,
      TREE_QUEUE_ROW_FIXED_BYTES,
      1,
      JSON.stringify(snapshot),
    );
  for (const row of projectedWalk(db, repoId, objects, [beforeTreeOid, afterTreeOid], run)) {
    throwTraversalError(row, "tree diff object traversal");
    if (row.object_mode === null && row.object_oid === null) continue;
    const mode = expectText(row.object_mode, "tree diff object mode");
    const oid = expectText(row.object_oid, "tree diff object oid");
    if (mode === "160000") continue;
    yield { oid, type: isTreeMode(mode) ? "tree" : "blob" };
  }
}

/** Stream changed leaves between two trees while pruning equal subtrees. */
export function* iterateTreeDiff(
  db: SqlDatabase,
  repoId: number,
  objects: TreeObjectReader,
  beforeTreeOid: string | null,
  afterTreeOid: string | null,
): Generator<WalkTreeDiffEntry> {
  if (beforeTreeOid === afterTreeOid) return;
  const run = () =>
    db.iterate(
      WALK_TREE_DIFF_SQL,
      repoId,
      beforeTreeOid,
      afterTreeOid,
      TREE_WALK_PATH_BYTES,
      TREE_WALK_STATE_BYTES,
      TREE_WALK_QUEUE_BYTES,
      TREE_QUEUE_ROW_FIXED_BYTES,
      0,
      "[]",
    );
  for (const row of projectedWalk(db, repoId, objects, [beforeTreeOid, afterTreeOid], run)) {
    throwTraversalError(row, "tree diff traversal");
    const path = expectText(row.path, "tree diff path");
    const beforeMode = expectNullable(row.before_mode, (value) =>
      expectText(value, "tree diff before mode"),
    );
    const beforeOid = expectNullable(row.before_oid, (value) =>
      expectText(value, "tree diff before oid"),
    );
    const afterMode = expectNullable(row.after_mode, (value) =>
      expectText(value, "tree diff after mode"),
    );
    const afterOid = expectNullable(row.after_oid, (value) =>
      expectText(value, "tree diff after oid"),
    );
    yield { path, beforeMode, beforeOid, afterMode, afterOid };
  }
}
