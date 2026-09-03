import type { SqlDatabase } from "../../../../db/db.js";
import { CorruptError } from "../../../common/errors.js";
import { int, nullable, oneOf, RowShape, text } from "../../../common/rows.js";
import { comparePaths } from "../../../common/streams.js";
import type { OperationRootPageReader, RootCandidate, RootPage } from "./root-contracts.js";

const INDEX_ROOT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  path: text(),
  stage: int(0, 3),
  mode: oneOf([0o100644, 0o100755, 0o120000, 0o160000]),
  oid: text(),
});
const INDEX_BASELINE_ROOT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  baseline_tree_oid: nullable(text()),
  format: oneOf([1]),
  complete: oneOf([1]),
});
const SHALLOW_ROOT_ROW = new RowShape({
  repo_id: int(1),
  oid: text(),
});
const OPERATION_CHECKOUT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
});

export function rootsFromIndex(
  db: SqlDatabase,
  repoId: number,
  cursorCheckoutId: number | null,
  cursorText: string | null,
  cursorOrdinal: number | null,
  pageRows: number,
): RootPage {
  let checkoutId = cursorCheckoutId ?? 0;
  let path = cursorText ?? "";
  let stage = cursorOrdinal ?? -1;
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let hasMore = false;
  for (const raw of db.iterate(
    `SELECT checkout.id AS checkout_id, checkout.repo_id, entry.path,
            entry.stage, entry.mode, entry.oid
       FROM git_index entry
       JOIN git_checkouts checkout ON checkout.id = entry.checkout_id
      WHERE checkout.repo_id = ? AND (
        checkout.id > ? OR (
          checkout.id = ? AND (
            entry.path > ? COLLATE BINARY OR (entry.path = ? AND entry.stage > ?)
          )
        )
      )
      ORDER BY checkout.id, entry.path COLLATE BINARY, entry.stage LIMIT ?`,
    repoId,
    checkoutId,
    checkoutId,
    path,
    path,
    stage,
    pageRows + 1,
  )) {
    const row = INDEX_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("index root crossed repositories");
    if (
      row.checkout_id < checkoutId ||
      (row.checkout_id === checkoutId &&
        (comparePaths(row.path, path) < 0 || (row.path === path && row.stage <= stage)))
    ) {
      throw new CorruptError("index roots are not in strict key order");
    }
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    const gitlink = row.mode === 0o160000;
    candidates.push({
      oid: row.oid,
      expectedType: gitlink ? "commit" : "blob",
      optionalMissing: gitlink,
    });
    checkoutId = row.checkout_id;
    path = row.path;
    stage = row.stage;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: rows === 0 ? cursorCheckoutId : checkoutId,
    cursorText: rows === 0 ? cursorText : path,
    cursorOrdinal: rows === 0 ? cursorOrdinal : stage,
    hasMore,
  };
}

export function rootsFromIndexBaselines(
  db: SqlDatabase,
  repoId: number,
  cursor: number | null,
  pageRows: number,
): RootPage {
  const after = cursor ?? 0;
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let last = after;
  let hasMore = false;
  for (const raw of db.iterate(
    `SELECT checkout.id AS checkout_id, checkout.repo_id, state.baseline_tree_oid,
            state.format, state.complete
       FROM git_index_state state
       JOIN git_checkouts checkout ON checkout.id = state.checkout_id
      WHERE checkout.repo_id = ? AND checkout.id > ? AND state.complete = 1
      ORDER BY checkout.id LIMIT ?`,
    repoId,
    after,
    pageRows + 1,
  )) {
    const row = INDEX_BASELINE_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("index baseline crossed repositories");
    if (row.checkout_id <= last) throw new CorruptError("index baselines are unordered");
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (row.baseline_tree_oid !== null) {
      candidates.push({
        oid: row.baseline_tree_oid,
        expectedType: "tree",
        optionalMissing: false,
      });
    }
    last = row.checkout_id;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: rows === 0 ? cursor : last,
    cursorText: null,
    cursorOrdinal: null,
    hasMore,
  };
}

export function rootsFromShallow(
  db: SqlDatabase,
  repoId: number,
  cursor: string | null,
  pageRows: number,
): RootPage {
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let last = cursor;
  let hasMore = false;
  for (const raw of db.iterate(
    `SELECT repo_id, oid
       FROM git_shallow
      WHERE repo_id = ? AND (? IS NULL OR oid > ? COLLATE BINARY)
      ORDER BY oid COLLATE BINARY LIMIT ?`,
    repoId,
    cursor,
    cursor,
    pageRows + 1,
  )) {
    const row = SHALLOW_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("shallow root crossed repositories");
    if (last !== null && comparePaths(last, row.oid) >= 0) {
      throw new CorruptError("shallow roots are unordered");
    }
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    candidates.push({ oid: row.oid, expectedType: "commit", optionalMissing: false });
    last = row.oid;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: null,
    cursorText: last,
    cursorOrdinal: null,
    hasMore,
  };
}

export function rootsFromOperations(
  db: SqlDatabase,
  repoId: number,
  cursorCheckoutId: number | null,
  cursorOrdinal: number | null,
  pageRows: number,
  readOperationRootPage: OperationRootPageReader,
): RootPage {
  const candidates: RootCandidate[] = [];
  const after = cursorCheckoutId ?? 0;
  const checkouts: number[] = [];
  const query =
    cursorOrdinal === null
      ? `SELECT id AS checkout_id, repo_id FROM git_checkouts
          WHERE repo_id = ? AND id > ? ORDER BY id LIMIT 2`
      : `SELECT id AS checkout_id, repo_id FROM git_checkouts
          WHERE repo_id = ? AND id >= ? ORDER BY id LIMIT 2`;
  for (const raw of db.iterate(query, repoId, after)) {
    const row = OPERATION_CHECKOUT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("operation root crossed repositories");
    const previous = checkouts[checkouts.length - 1];
    if (previous !== undefined && row.checkout_id <= previous) {
      throw new CorruptError("operation root checkouts are unordered");
    }
    checkouts.push(row.checkout_id);
  }
  const checkoutId = checkouts[0];
  if (checkoutId === undefined) {
    if (cursorOrdinal !== null) {
      throw new CorruptError("operation root cursor checkout is missing");
    }
    return {
      candidates,
      cursorCheckoutId: null,
      cursorText: null,
      cursorOrdinal: null,
      hasMore: false,
    };
  }
  if (
    (cursorOrdinal === null && checkoutId <= after) ||
    (cursorOrdinal !== null && checkoutId !== cursorCheckoutId)
  ) {
    throw new CorruptError("operation root checkouts are unordered");
  }
  const offset = cursorOrdinal ?? 0;
  const page = readOperationRootPage(checkoutId, offset, pageRows);
  if (page.roots.length > pageRows) {
    throw new CorruptError("operation root page exceeded its row limit");
  }
  for (const root of page.roots) {
    candidates.push({
      oid: root.oid,
      expectedType: root.type,
      optionalMissing: false,
    });
  }
  if (page.nextCursor !== null) {
    if (
      page.roots.length !== pageRows ||
      !Number.isSafeInteger(page.nextCursor) ||
      page.nextCursor !== offset + page.roots.length
    ) {
      throw new CorruptError("operation root cursor did not progress strictly");
    }
    return {
      candidates,
      cursorCheckoutId: checkoutId,
      cursorText: null,
      cursorOrdinal: page.nextCursor,
      hasMore: true,
    };
  }
  return {
    candidates,
    cursorCheckoutId: checkoutId,
    cursorText: null,
    cursorOrdinal: null,
    hasMore: checkouts.length > 1,
  };
}
