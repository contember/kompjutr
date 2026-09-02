import type { SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { isCanonicalGitPath } from "../../common/paths.js";
import { int, nullable, oneOf, RowShape, text } from "../../common/rows.js";
import { comparePaths } from "../../common/streams.js";
import type { OperationRootPage } from "../operation-journal.js";
import { requireRefName } from "../ref-validation.js";
import { REFLOG_RETENTION_SECONDS } from "../reflog.js";
import { ensureMaintenanceControl } from "./control.js";
import { type MaintenanceRunView, readMaintenanceRunView } from "./state.js";

const DEFAULT_PAGE_ROWS = 128;
const MAX_PAGE_ROWS = 128;
export const MAINTENANCE_ROOT_EPOCH_DRIFTED = "maintenance roots changed after root discovery";

const ROOT_REFS = 1;
const ROOT_HEADS = 2;
const ROOT_REFLOGS = 4;
const ROOT_INDEX = 8;
const ROOT_INDEX_BASELINE = 16;
const ROOT_SHALLOW = 32;
const ROOT_OPERATIONS = 64;

export type MaintenanceRootSource =
  | "refs"
  | "heads"
  | "reflogs"
  | "index"
  | "index-baseline"
  | "shallow"
  | "operations"
  | "done";

export type OperationRootPageReader = (
  checkoutId: number,
  cursor: number,
  limit: number,
) => OperationRootPage;

export interface AdvanceMaintenanceRootSnapshotOptions {
  repoId: number;
  nowMs: number;
  pageRows?: number;
  readOperationRootPage: OperationRootPageReader;
}

export interface MaintenanceRootSnapshotProgress {
  runId: number;
  rootSource: MaintenanceRootSource;
  complete: boolean;
  restarted: boolean;
}

type RunState = MaintenanceRunView;

export interface MaintenanceRootCursorState {
  phase: string;
  rootSource: MaintenanceRootSource;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
}

interface RootCandidate {
  oid: string;
  expectedType: ObjectType | null;
  optionalMissing: boolean;
}

interface RootPage {
  candidates: RootCandidate[];
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  hasMore: boolean;
}

const ROOT_SOURCES: readonly MaintenanceRootSource[] = [
  "refs",
  "heads",
  "reflogs",
  "index",
  "index-baseline",
  "shallow",
  "operations",
  "done",
];

const REF_ROOT_ROW = new RowShape({
  repo_id: int(1),
  name: text(),
  target: text(),
});
const HEAD_ROOT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  head: text(),
});
const REFLOG_ROOT_ROW = new RowShape({
  source_kind: oneOf([0, 1]),
  repo_id: int(1),
  ref_key: text(),
  checkout_id: nullable(int(1)),
  ordinal: int(1),
  old_oid: nullable(text()),
  new_oid: nullable(text()),
  timestamp: int(0),
});
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

function isObjectType(value: unknown): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

function requireSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

/** Validate the phase-specific durable root cursor shape. */
export function validateMaintenanceRootCursor(run: MaintenanceRootCursorState): void {
  const none =
    run.cursorCheckoutId === null && run.cursorText === null && run.cursorOrdinal === null;
  if (run.phase !== "roots") {
    if (run.rootSource !== "done" || !none) {
      throw new CorruptError("completed maintenance roots retained a cursor");
    }
    return;
  }
  if (run.rootSource === "done") {
    throw new CorruptError("incomplete maintenance roots are marked done");
  }
  if (run.rootSource === "refs") {
    if (run.cursorCheckoutId !== null || run.cursorOrdinal !== null) {
      throw new CorruptError("ref root cursor has unrelated fields");
    }
    if (run.cursorText !== null) requireRefName(run.cursorText, "maintenance ref cursor", "stored");
    return;
  }
  if (run.rootSource === "heads" || run.rootSource === "index-baseline") {
    if (run.cursorText !== null || run.cursorOrdinal !== null) {
      throw new CorruptError("checkout root cursor has unrelated fields");
    }
    if (run.cursorCheckoutId !== null && run.cursorCheckoutId < 1) {
      throw new CorruptError("checkout root cursor is invalid");
    }
    return;
  }
  if (run.rootSource === "operations") {
    if (run.cursorText !== null) {
      throw new CorruptError("operation root cursor has unrelated fields");
    }
    if (run.cursorCheckoutId === null) {
      if (run.cursorOrdinal !== null) {
        throw new CorruptError("operation root cursor lost its checkout");
      }
      return;
    }
    if (run.cursorCheckoutId < 1 || run.cursorOrdinal === 0) {
      throw new CorruptError("operation root cursor is invalid");
    }
    return;
  }
  if (run.rootSource === "reflogs") {
    if (run.cursorCheckoutId !== null || run.cursorText !== null) {
      throw new CorruptError("reflog root cursor has unrelated fields");
    }
    if (run.cursorOrdinal !== null && run.cursorOrdinal < 1) {
      throw new CorruptError("reflog root cursor is invalid");
    }
    return;
  }
  if (run.rootSource === "index") {
    if (none) return;
    if (
      run.cursorCheckoutId === null ||
      run.cursorCheckoutId < 1 ||
      run.cursorText === null ||
      !isCanonicalGitPath(run.cursorText) ||
      run.cursorOrdinal === null ||
      run.cursorOrdinal > 3
    ) {
      throw new CorruptError("index root cursor is invalid");
    }
    return;
  }
  if (run.cursorCheckoutId !== null || run.cursorOrdinal !== null) {
    throw new CorruptError("shallow root cursor has unrelated fields");
  }
  if (run.cursorText !== null && !isOid(run.cursorText)) {
    throw new CorruptError("shallow root cursor is invalid");
  }
}

function readRun(db: SqlDatabase, repoId: number): RunState | null {
  return readMaintenanceRunView(db, repoId);
}

function createRun(
  db: SqlDatabase,
  repoId: number,
  rootEpoch: number,
  startedMs: number,
): RunState {
  const allocated = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_control
        SET next_run_id = next_run_id + 1
      WHERE repo_id = ? AND next_run_id < ?
      RETURNING repo_id, root_epoch, next_run_id`,
    repoId,
    Number.MAX_SAFE_INTEGER,
  );
  if (allocated === undefined) {
    throw new GitError("E2BIG", "maintenance run id space is exhausted");
  }
  if (allocated.repo_id !== repoId || allocated.root_epoch !== rootEpoch) {
    throw new CorruptError("maintenance run allocation changed its root epoch");
  }
  const nextRunId = requireSafeInteger(allocated.next_run_id, "maintenance next run id", 2);
  const runId = nextRunId - 1;
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
     VALUES (?, ?, ?, 'roots', ?, 'refs')`,
    repoId,
    runId,
    rootEpoch,
    startedMs,
  );
  const run = readRun(db, repoId);
  if (run === null || run.runId !== runId) {
    throw new CorruptError("new maintenance run was not published");
  }
  return run;
}

function restartRun(db: SqlDatabase, run: RunState, rootEpoch: number): RunState {
  db.run(
    "DELETE FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?",
    run.repoId,
    run.runId,
  );
  db.run(
    "DELETE FROM git_maintenance_shallow WHERE repo_id = ? AND run_id = ?",
    run.repoId,
    run.runId,
  );
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET observed_root_epoch = ?, phase = 'roots', root_source = 'refs',
            cursor_checkout_id = NULL, cursor_text = NULL, cursor_ordinal = NULL,
            reachable_objects = 0, queued_objects = 0, restarted = 1
      WHERE repo_id = ? AND run_id = ?
      RETURNING run_id`,
    rootEpoch,
    run.repoId,
    run.runId,
  );
  if (row === undefined) throw new CorruptError("maintenance root restart lost its run");
  const restarted = readRun(db, run.repoId);
  if (restarted === null || restarted.runId !== run.runId) {
    throw new CorruptError("maintenance root restart lost its run");
  }
  return restarted;
}

function rootsFromRefs(
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
    `SELECT repo_id, name, target
       FROM git_refs
      WHERE repo_id = ? AND (? IS NULL OR name > ? COLLATE BINARY)
      ORDER BY name COLLATE BINARY LIMIT ?`,
    repoId,
    cursor,
    cursor,
    pageRows + 1,
  )) {
    const row = REF_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("ref root crossed repositories");
    if (last !== null && comparePaths(last, row.name) >= 0) {
      throw new CorruptError("ref roots are not in strict byte order");
    }
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (isOid(row.target)) {
      candidates.push({ oid: row.target, expectedType: null, optionalMissing: false });
    }
    last = row.name;
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

function rootsFromHeads(
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
    `SELECT id AS checkout_id, repo_id, head
       FROM git_checkouts
      WHERE repo_id = ? AND id > ? ORDER BY id LIMIT ?`,
    repoId,
    after,
    pageRows + 1,
  )) {
    const row = HEAD_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("checkout HEAD crossed repositories");
    if (row.checkout_id <= last) throw new CorruptError("checkout HEAD roots are unordered");
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (isOid(row.head)) {
      candidates.push({ oid: row.head, expectedType: null, optionalMissing: false });
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

function rootsFromReflogs(
  db: SqlDatabase,
  repoId: number,
  startedMs: number,
  cursor: number | null,
  pageRows: number,
): RootPage {
  const cutoff = Math.max(0, Math.floor(startedMs / 1_000) - REFLOG_RETENTION_SECONDS);
  const after = cursor ?? 0;
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let last = after;
  let hasMore = false;
  for (const raw of db.iterate(
    `WITH direct_page AS MATERIALIZED (
       SELECT 0 AS source_kind, entry.repo_id, entry.ref_name AS ref_key,
              NULL AS checkout_id, entry.ordinal, entry.old_oid, entry.new_oid,
              entry.timestamp
         FROM git_reflog_entries entry NOT INDEXED
        WHERE entry.repo_id = ? AND entry.ordinal > ?
        ORDER BY entry.ordinal LIMIT ?
     ), checkout_page AS MATERIALIZED (
       SELECT 1 AS source_kind, entry.repo_id, 'HEAD' AS ref_key,
              entry.checkout_id, entry.ordinal, entry.old_oid, entry.new_oid,
              entry.timestamp
         FROM git_checkout_reflog_entries entry
              INDEXED BY git_checkout_reflog_entries_by_ordinal
        WHERE entry.repo_id = ? AND entry.ordinal > ?
        ORDER BY entry.ordinal LIMIT ?
     )
     SELECT source_kind, repo_id, ref_key, checkout_id, ordinal, old_oid, new_oid, timestamp
       FROM (
         SELECT source_kind, repo_id, ref_key, checkout_id, ordinal, old_oid, new_oid, timestamp
           FROM direct_page
         UNION ALL
         SELECT source_kind, repo_id, ref_key, checkout_id, ordinal, old_oid, new_oid, timestamp
           FROM checkout_page
       )
      ORDER BY ordinal LIMIT ?`,
    repoId,
    after,
    pageRows + 1,
    repoId,
    after,
    pageRows + 1,
    pageRows + 1,
  )) {
    const row = REFLOG_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("reflog root crossed repositories");
    if (row.ordinal <= last) throw new CorruptError("retained reflog roots are unordered");
    if (row.source_kind === 0) {
      if (row.checkout_id !== null) {
        throw new CorruptError("direct reflog root retained a checkout id");
      }
    } else {
      if (row.ref_key !== "HEAD") throw new CorruptError("checkout reflog root is not HEAD");
      if (row.checkout_id === null) {
        throw new CorruptError("checkout reflog root is missing its checkout id");
      }
    }
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (row.timestamp >= cutoff) {
      if (row.old_oid !== null) {
        candidates.push({ oid: row.old_oid, expectedType: null, optionalMissing: false });
      }
      if (row.new_oid !== null) {
        candidates.push({ oid: row.new_oid, expectedType: null, optionalMissing: false });
      }
    }
    last = row.ordinal;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: null,
    cursorText: null,
    cursorOrdinal: rows === 0 ? cursor : last,
    hasMore,
  };
}

function rootsFromIndex(
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

function rootsFromIndexBaselines(
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

function rootsFromShallow(
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

function rootsFromOperations(
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

function validateObjectRoots(db: SqlDatabase, repoId: number, roots: RootCandidate[]): string[] {
  const unique = new Map<
    string,
    { oid: string; expectedType: ObjectType | null; optionalMissing: boolean }
  >();
  for (const root of roots) {
    if (!isOid(root.oid)) throw new CorruptError("maintenance root OID is invalid");
    const previous = unique.get(root.oid);
    if (
      previous !== undefined &&
      previous.expectedType !== null &&
      root.expectedType !== null &&
      previous.expectedType !== root.expectedType
    ) {
      throw new CorruptError(`maintenance root ${root.oid} has conflicting object types`);
    }
    unique.set(root.oid, {
      oid: root.oid,
      expectedType: previous?.expectedType ?? root.expectedType,
      optionalMissing: (previous?.optionalMissing ?? true) && root.optionalMissing,
    });
  }
  if (unique.size === 0) return [];
  const payload = JSON.stringify([...unique.values()]);
  const present: string[] = [];
  const seen = new Set<string>();
  for (const row of db.iterate(
    `SELECT json_extract(input.value, '$.oid') AS oid,
            json_extract(input.value, '$.expectedType') AS expected_type,
            json_extract(input.value, '$.optionalMissing') AS optional_missing,
            loose.type AS loose_type, packed.type AS packed_type,
            promised.oid AS promised_oid
       FROM json_each(?) input
       LEFT JOIN git_objects loose
         ON loose.repo_id = ? AND loose.oid = json_extract(input.value, '$.oid')
       LEFT JOIN git_pack_objects packed
         ON packed.repo_id = ? AND packed.oid = json_extract(input.value, '$.oid')
        AND EXISTS (
          SELECT 1 FROM git_pack_meta meta
           WHERE meta.repo_id = packed.repo_id AND meta.pack_id = packed.pack_id
             AND meta.state = 'complete'
        )
       LEFT JOIN git_promised_blobs promised
         ON promised.repo_id = ? AND promised.oid = json_extract(input.value, '$.oid')
      ORDER BY CAST(input.key AS INTEGER)`,
    payload,
    repoId,
    repoId,
    repoId,
  )) {
    if (typeof row.oid !== "string" || !isOid(row.oid) || !unique.has(row.oid)) {
      throw new CorruptError("maintenance object validation returned an invalid OID");
    }
    if (seen.has(row.oid)) {
      throw new CorruptError("maintenance object validation returned a duplicate OID");
    }
    seen.add(row.oid);
    const wanted = unique.get(row.oid);
    if (wanted === undefined) throw new CorruptError("maintenance object root disappeared");
    if (row.expected_type !== wanted.expectedType) {
      throw new CorruptError("maintenance object validation changed its expected type");
    }
    const optional = row.optional_missing;
    if ((optional !== 0 && optional !== 1) || (optional === 1) !== wanted.optionalMissing) {
      throw new CorruptError("maintenance object validation changed its missing policy");
    }
    const looseType = row.loose_type;
    const packedType = row.packed_type;
    if (looseType !== null && !isObjectType(looseType)) {
      throw new CorruptError("maintenance loose root type is invalid");
    }
    if (packedType !== null && !isObjectType(packedType)) {
      throw new CorruptError("maintenance packed root type is invalid");
    }
    if (looseType !== null && packedType !== null && looseType !== packedType) {
      throw new CorruptError(`maintenance root ${row.oid} has conflicting stored types`);
    }
    const actual = looseType ?? packedType;
    if (actual === null) {
      if (wanted.optionalMissing) continue;
      // A promised blob is a terminal leaf, not a root and not corruption (ADR-0020).
      if (wanted.expectedType === "blob" && row.promised_oid === row.oid) continue;
      throw new CorruptError(`maintenance root ${row.oid} references a missing object`);
    }
    if (wanted.expectedType !== null && actual !== wanted.expectedType) {
      throw new CorruptError(
        `maintenance root ${row.oid} is ${actual}, expected ${wanted.expectedType}`,
      );
    }
    present.push(row.oid);
  }
  if (seen.size !== unique.size) {
    throw new CorruptError("maintenance object validation returned an incomplete page");
  }
  return present;
}

function insertRoots(
  db: SqlDatabase,
  repoId: number,
  runId: number,
  sourceMask: number,
  roots: string[],
  shallow: boolean,
): void {
  if (roots.length === 0) return;
  const payload = JSON.stringify(roots);
  db.run(
    `INSERT INTO git_maintenance_objects
       (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
     SELECT ?, ?, value, ?, 0, ?, 0, 0 FROM json_each(?)
     WHERE true
     ON CONFLICT(repo_id, run_id, oid) DO UPDATE SET
       source_mask = source_mask | excluded.source_mask,
       shallow_boundary = max(shallow_boundary, excluded.shallow_boundary)`,
    repoId,
    runId,
    sourceMask,
    shallow ? 1 : 0,
    payload,
  );
  if (shallow) {
    db.run(
      `INSERT OR IGNORE INTO git_maintenance_shallow (repo_id, run_id, oid)
       SELECT ?, ?, value FROM json_each(?)`,
      repoId,
      runId,
      payload,
    );
  }
}

function nextSource(source: MaintenanceRootSource): MaintenanceRootSource {
  const index = ROOT_SOURCES.indexOf(source);
  const next = ROOT_SOURCES[index + 1];
  if (next === undefined) return "done";
  return next;
}

function sourceMask(source: MaintenanceRootSource): number {
  if (source === "refs") return ROOT_REFS;
  if (source === "heads") return ROOT_HEADS;
  if (source === "reflogs") return ROOT_REFLOGS;
  if (source === "index") return ROOT_INDEX;
  if (source === "index-baseline") return ROOT_INDEX_BASELINE;
  if (source === "shallow") return ROOT_SHALLOW;
  if (source === "operations") return ROOT_OPERATIONS;
  return 0;
}

function pageForSource(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  pageRows: number,
  readOperationRootPage: OperationRootPageReader,
): RootPage {
  if (run.rootSource === "refs") {
    return rootsFromRefs(db, repoId, run.cursorText, pageRows);
  }
  if (run.rootSource === "heads") {
    return rootsFromHeads(db, repoId, run.cursorCheckoutId, pageRows);
  }
  if (run.rootSource === "reflogs") {
    return rootsFromReflogs(db, repoId, run.startedMs, run.cursorOrdinal, pageRows);
  }
  if (run.rootSource === "index") {
    return rootsFromIndex(
      db,
      repoId,
      run.cursorCheckoutId,
      run.cursorText,
      run.cursorOrdinal,
      pageRows,
    );
  }
  if (run.rootSource === "index-baseline") {
    return rootsFromIndexBaselines(db, repoId, run.cursorCheckoutId, pageRows);
  }
  if (run.rootSource === "shallow") {
    return rootsFromShallow(db, repoId, run.cursorText, pageRows);
  }
  if (run.rootSource === "operations") {
    return rootsFromOperations(
      db,
      repoId,
      run.cursorCheckoutId,
      run.cursorOrdinal,
      pageRows,
      readOperationRootPage,
    );
  }
  return {
    candidates: [],
    cursorCheckoutId: null,
    cursorText: null,
    cursorOrdinal: null,
    hasMore: false,
  };
}

function publishPage(
  db: SqlDatabase,
  repoId: number,
  run: RunState,
  rootEpoch: number,
  page: RootPage,
): RunState {
  const source = page.hasMore ? run.rootSource : nextSource(run.rootSource);
  if (source === "done") {
    const queued = db.scalar<unknown>(
      `SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?`,
      repoId,
      run.runId,
    );
    const queuedObjects = requireSafeInteger(queued, "maintenance queued root count", 0);
    const row = db.one<Record<string, unknown>>(
      `UPDATE git_maintenance_runs
          SET phase = 'mark', root_source = 'done', cursor_checkout_id = NULL,
              cursor_text = NULL, cursor_ordinal = NULL, queued_objects = ?
        WHERE repo_id = ? AND run_id = ? AND observed_root_epoch = ? AND phase = 'roots'
        RETURNING run_id`,
      queuedObjects,
      repoId,
      run.runId,
      rootEpoch,
    );
    if (row === undefined) throw new CorruptError("maintenance root completion lost its epoch");
    const completed = readRun(db, repoId);
    if (completed === null || completed.runId !== run.runId) {
      throw new CorruptError("maintenance root completion lost its run");
    }
    return completed;
  }
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET root_source = ?, cursor_checkout_id = ?, cursor_text = ?, cursor_ordinal = ?
      WHERE repo_id = ? AND run_id = ? AND observed_root_epoch = ? AND phase = 'roots'
      RETURNING run_id`,
    source,
    page.hasMore ? page.cursorCheckoutId : null,
    page.hasMore ? page.cursorText : null,
    page.hasMore ? page.cursorOrdinal : null,
    repoId,
    run.runId,
    rootEpoch,
  );
  if (row === undefined) throw new CorruptError("maintenance root cursor lost its epoch");
  const advanced = readRun(db, repoId);
  if (advanced === null || advanced.runId !== run.runId) {
    throw new CorruptError("maintenance root cursor lost its run");
  }
  return advanced;
}

/** Advance one durable, bounded root-discovery page. */
export function advanceMaintenanceRootSnapshot(
  db: SqlDatabase,
  options: AdvanceMaintenanceRootSnapshotOptions,
): MaintenanceRootSnapshotProgress {
  if (!Number.isSafeInteger(options.repoId) || options.repoId < 1) {
    throw new GitError("EINVAL", "repository id must be a safe positive integer");
  }
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) {
    throw new GitError("EINVAL", "maintenance clock must return non-negative integer milliseconds");
  }
  const pageRows = options.pageRows ?? DEFAULT_PAGE_ROWS;
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > MAX_PAGE_ROWS) {
    throw new GitError("EINVAL", `maintenance root page size must be from 1 to ${MAX_PAGE_ROWS}`);
  }
  return db.transactionSync(() => {
    const control = ensureMaintenanceControl(db, options.repoId);
    let run = readRun(db, options.repoId);
    if (run === null) {
      run = createRun(db, options.repoId, control.rootEpoch, options.nowMs);
    }
    if (run.observedRootEpoch !== control.rootEpoch) {
      if (run.phase !== "roots" && run.phase !== "mark") {
        throw new GitError("ESTALE", MAINTENANCE_ROOT_EPOCH_DRIFTED);
      }
      run = restartRun(db, run, control.rootEpoch);
    }
    if (run.phase !== "roots") {
      return {
        runId: run.runId,
        rootSource: run.rootSource,
        complete: true,
        restarted: run.restarted,
      };
    }
    const page = pageForSource(db, options.repoId, run, pageRows, options.readOperationRootPage);
    const roots = validateObjectRoots(db, options.repoId, page.candidates);
    insertRoots(
      db,
      options.repoId,
      run.runId,
      sourceMask(run.rootSource),
      roots,
      run.rootSource === "shallow",
    );
    run = publishPage(db, options.repoId, run, control.rootEpoch, page);
    return {
      runId: run.runId,
      rootSource: run.rootSource,
      complete: run.phase !== "roots",
      restarted: run.restarted,
    };
  });
}
