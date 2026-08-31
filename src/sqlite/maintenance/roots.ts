import { isOid } from "../../core/bytes.js";
import { CorruptError, GitError } from "../../core/errors.js";
import type { ObjectType } from "../../core/objects.js";
import type { OperationJournal } from "../../core/ops/operation-state.js";
import { comparePaths } from "../../core/streams.js";
import type { SqlDatabase } from "../db.js";
import { requireRawRefTarget, requireRefName } from "../ref-validation.js";
import { ensureMaintenanceControl } from "./control.js";

const RETAINED_REFLOG_SECONDS = 90 * 24 * 60 * 60;
const RETAINED_REFLOG_ROWS = 1_024;
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

export interface MaintenanceRootInput {
  oid: string;
  expectedType: ObjectType;
}

export type ValidatedOperationRootReader = (checkoutId: number) => readonly MaintenanceRootInput[];

export interface AdvanceMaintenanceRootSnapshotOptions {
  repoId: number;
  nowMs: number;
  pageRows?: number;
  readOperationRoots: ValidatedOperationRootReader;
}

export interface MaintenanceRootSnapshotProgress {
  runId: number;
  rootSource: MaintenanceRootSource;
  complete: boolean;
  restarted: boolean;
}

interface RunState {
  repoId: number;
  runId: number;
  observedRootEpoch: number;
  phase: string;
  startedMs: number;
  rootSource: MaintenanceRootSource;
  cursorCheckoutId: number | null;
  cursorText: string | null;
  cursorOrdinal: number | null;
  restarted: boolean;
}

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

function requireSource(value: unknown): MaintenanceRootSource {
  for (const source of ROOT_SOURCES) {
    if (value === source) return source;
  }
  throw new CorruptError("maintenance root source is invalid");
}

function requireNullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : requireSafeInteger(value, label, 0);
}

function requireCursorMetadata(row: Record<string, unknown>): number | null {
  if (row.cursor_text_type === "null") {
    if (row.cursor_text_bytes !== null) {
      throw new CorruptError("absent maintenance text cursor returned byte metadata");
    }
    return null;
  }
  if (row.cursor_text_type !== "text") {
    throw new CorruptError("maintenance text cursor storage type is invalid");
  }
  return requireSafeInteger(row.cursor_text_bytes, "maintenance text cursor bytes", 0);
}

function requireNullableText(
  value: unknown,
  label: string,
  admittedBytes: number | null,
): string | null {
  if (admittedBytes === null) {
    if (value !== null) throw new CorruptError(`${label} appeared after metadata preflight`);
    return null;
  }
  if (typeof value !== "string" || utf8Bytes(value, Number.MAX_SAFE_INTEGER) !== admittedBytes) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

function requireRun(
  row: Record<string, unknown>,
  repoId: number,
  admittedCursorBytes: number | null,
): RunState {
  if (row.repo_id !== repoId) throw new CorruptError("maintenance run crossed repositories");
  const phase = row.phase;
  if (
    phase !== "roots" &&
    phase !== "mark" &&
    phase !== "classify-loose" &&
    phase !== "repack" &&
    phase !== "classify-packs" &&
    phase !== "sweep-loose" &&
    phase !== "sweep-packs" &&
    phase !== "finish"
  ) {
    throw new CorruptError("maintenance run phase is invalid");
  }
  if (row.restarted !== 0 && row.restarted !== 1) {
    throw new CorruptError("maintenance root restart marker is invalid");
  }
  const run: RunState = {
    repoId,
    runId: requireSafeInteger(row.run_id, "maintenance run id", 1),
    observedRootEpoch: requireSafeInteger(
      row.observed_root_epoch,
      "maintenance observed root epoch",
      0,
    ),
    phase,
    startedMs: requireSafeInteger(row.started_ms, "maintenance start time", 0),
    rootSource: requireSource(row.root_source),
    cursorCheckoutId: requireNullableInteger(row.cursor_checkout_id, "maintenance checkout cursor"),
    cursorText: requireNullableText(
      row.cursor_text,
      "maintenance text cursor",
      admittedCursorBytes,
    ),
    cursorOrdinal: requireNullableInteger(row.cursor_ordinal, "maintenance ordinal cursor"),
    restarted: row.restarted === 1,
  };
  validateMaintenanceRootCursor(run);
  return run;
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
      !validIndexPath(run.cursorText) ||
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
  const metadata = db.one<Record<string, unknown>>(
    `SELECT typeof(cursor_text) AS cursor_text_type,
            length(CAST(cursor_text AS BLOB)) AS cursor_text_bytes
       FROM git_maintenance_runs WHERE repo_id = ?`,
    repoId,
  );
  if (metadata === undefined) return null;
  const cursorBytes = requireCursorMetadata(metadata);
  const row = db.one<Record<string, unknown>>(
    `SELECT repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
            cursor_checkout_id, cursor_text, typeof(cursor_text) AS cursor_text_type,
            length(CAST(cursor_text AS BLOB)) AS cursor_text_bytes, cursor_ordinal, restarted
       FROM git_maintenance_runs WHERE repo_id = ?`,
    repoId,
  );
  if (row === undefined) throw new CorruptError("maintenance run changed after metadata preflight");
  if (requireCursorMetadata(row) !== cursorBytes) {
    throw new CorruptError("maintenance text cursor changed after metadata preflight");
  }
  return requireRun(row, repoId, cursorBytes);
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
      RETURNING repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
                cursor_checkout_id, cursor_text, typeof(cursor_text) AS cursor_text_type,
                length(CAST(cursor_text AS BLOB)) AS cursor_text_bytes,
                cursor_ordinal, restarted`,
    rootEpoch,
    run.repoId,
    run.runId,
  );
  if (row === undefined) throw new CorruptError("maintenance root restart lost its run");
  const cursorBytes = requireCursorMetadata(row);
  if (cursorBytes !== null) throw new CorruptError("maintenance root restart retained its cursor");
  return requireRun(row, run.repoId, cursorBytes);
}

function utf8Bytes(value: string, maximum = Number.MAX_SAFE_INTEGER): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) return -1;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (low < 0xdc00 || low > 0xdfff) return -1;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return -1;
    } else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (bytes > maximum) return -1;
  }
  return bytes;
}

function requireNullableOid(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

function requireReflogEndpoint(rawValue: unknown, oidValue: unknown): string | null {
  if (rawValue === null) {
    if (oidValue !== null) throw new CorruptError("absent reflog endpoint retained an OID");
    return null;
  }
  const raw = requireRawRefTarget(rawValue, "stored reflog target", "stored");
  const oid = requireNullableOid(oidValue, "reflog endpoint OID");
  if (isOid(raw) && oid !== raw) {
    throw new CorruptError("direct reflog endpoint OID does not match");
  }
  return oid;
}

function validIndexPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.endsWith("/") || utf8Bytes(path) < 0) {
    return false;
  }
  let segmentStart = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index !== path.length && path.charCodeAt(index) !== 0x2f) continue;
    const segmentLength = index - segmentStart;
    if (
      segmentLength === 0 ||
      (segmentLength === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
      (segmentLength === 2 &&
        path.charCodeAt(segmentStart) === 0x2e &&
        path.charCodeAt(segmentStart + 1) === 0x2e)
    ) {
      return false;
    }
    segmentStart = index + 1;
  }
  return true;
}

interface RootPageMetadata {
  rows: number;
  textBytes: number;
}

function requireRootPageMetadata(
  row: Record<string, unknown> | undefined,
  label: string,
  maximumRows: number,
): RootPageMetadata {
  if (row === undefined) throw new CorruptError(`${label} metadata row is missing`);
  const rows = requireSafeInteger(row.row_count, `${label} row count`, 0, maximumRows);
  if (row.invalid_types !== 0) throw new CorruptError(`${label} text metadata is invalid`);
  const textBytes = requireSafeInteger(row.text_bytes, `${label} text bytes`, 0);
  return { rows, textBytes };
}

function requirePageText(
  row: Record<string, unknown>,
  valueField: string,
  typeField: string,
  bytesField: string,
  label: string,
): { value: string; bytes: number } {
  const bytes = requireSafeInteger(row[bytesField], `${label} bytes`, 0);
  const value = row[valueField];
  if (row[typeField] !== "text" || typeof value !== "string" || utf8Bytes(value) !== bytes) {
    throw new CorruptError(`${label} changed after metadata preflight`);
  }
  return { value, bytes };
}

function requireNullablePageText(
  row: Record<string, unknown>,
  valueField: string,
  typeField: string,
  bytesField: string,
  label: string,
): { value: string | null; bytes: number } {
  if (row[typeField] === "null") {
    if (row[valueField] !== null || row[bytesField] !== null) {
      throw new CorruptError(`${label} changed after metadata preflight`);
    }
    return { value: null, bytes: 0 };
  }
  return requirePageText(row, valueField, typeField, bytesField, label);
}

function rootsFromRefs(
  db: SqlDatabase,
  repoId: number,
  cursor: string | null,
  pageRows: number,
): RootPage {
  const metadata = requireRootPageMetadata(
    db.one<Record<string, unknown>>(
      `SELECT count(*) AS row_count,
              coalesce(sum(CASE WHEN typeof(name) = 'text' AND typeof(target) = 'text'
                THEN 0 ELSE 1 END), 0) AS invalid_types,
              coalesce(sum(length(CAST(name AS BLOB)) +
                           length(CAST(target AS BLOB))), 0) AS text_bytes
         FROM (
           SELECT name, target FROM git_refs
            WHERE repo_id = ? AND (? IS NULL OR name > ? COLLATE BINARY)
            ORDER BY name COLLATE BINARY LIMIT ?
         )`,
      repoId,
      cursor,
      cursor,
      pageRows + 1,
    ),
    "maintenance ref root page",
    pageRows + 1,
  );
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let payloadRows = 0;
  let textBytes = 0;
  let last = cursor;
  let hasMore = false;
  for (const row of db.iterate(
    `SELECT repo_id, name, typeof(name) AS name_type,
            length(CAST(name AS BLOB)) AS name_bytes,
            target, typeof(target) AS target_type,
            length(CAST(target AS BLOB)) AS target_bytes
       FROM git_refs
      WHERE repo_id = ? AND (? IS NULL OR name > ? COLLATE BINARY)
      ORDER BY name COLLATE BINARY LIMIT ?`,
    repoId,
    cursor,
    cursor,
    pageRows + 1,
  )) {
    payloadRows++;
    const storedName = requirePageText(row, "name", "name_type", "name_bytes", "stored ref name");
    const storedTarget = requirePageText(
      row,
      "target",
      "target_type",
      "target_bytes",
      "stored ref target",
    );
    textBytes += storedName.bytes + storedTarget.bytes;
    if (row.repo_id !== repoId) throw new CorruptError("ref root crossed repositories");
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    const name = requireRefName(storedName.value, "stored ref name", "stored");
    if (last !== null && comparePaths(last, name) >= 0) {
      throw new CorruptError("ref roots are not in strict byte order");
    }
    const target = requireRawRefTarget(storedTarget.value, `stored target of ${name}`, "stored");
    if (isOid(target)) candidates.push({ oid: target, expectedType: null, optionalMissing: false });
    last = name;
    rows++;
  }
  if (payloadRows !== metadata.rows || textBytes !== metadata.textBytes) {
    throw new CorruptError("maintenance ref root page changed after metadata preflight");
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
  const metadata = requireRootPageMetadata(
    db.one<Record<string, unknown>>(
      `SELECT count(*) AS row_count,
              coalesce(sum(CASE WHEN typeof(head) = 'text' THEN 0 ELSE 1 END), 0)
                AS invalid_types,
              coalesce(sum(length(CAST(head AS BLOB))), 0) AS text_bytes
         FROM (
           SELECT head FROM git_checkouts
            WHERE repo_id = ? AND id > ? ORDER BY id LIMIT ?
         )`,
      repoId,
      after,
      pageRows + 1,
    ),
    "maintenance HEAD root page",
    pageRows + 1,
  );
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let payloadRows = 0;
  let textBytes = 0;
  let last = after;
  let hasMore = false;
  for (const row of db.iterate(
    `SELECT id AS checkout_id, repo_id, head, typeof(head) AS head_type,
            length(CAST(head AS BLOB)) AS head_bytes
       FROM git_checkouts
      WHERE repo_id = ? AND id > ? ORDER BY id LIMIT ?`,
    repoId,
    last,
    pageRows + 1,
  )) {
    payloadRows++;
    const storedHead = requirePageText(
      row,
      "head",
      "head_type",
      "head_bytes",
      "stored checkout HEAD",
    );
    textBytes += storedHead.bytes;
    if (row.repo_id !== repoId) throw new CorruptError("checkout HEAD crossed repositories");
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    const checkoutId = requireSafeInteger(row.checkout_id, "checkout HEAD id", 1);
    if (checkoutId <= last) throw new CorruptError("checkout HEAD roots are unordered");
    const head = requireRawRefTarget(storedHead.value, "stored HEAD target", "stored");
    if (isOid(head)) candidates.push({ oid: head, expectedType: null, optionalMissing: false });
    last = checkoutId;
    rows++;
  }
  if (payloadRows !== metadata.rows || textBytes !== metadata.textBytes) {
    throw new CorruptError("maintenance HEAD root page changed after metadata preflight");
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
  const cutoff = Math.max(0, Math.floor(startedMs / 1_000) - RETAINED_REFLOG_SECONDS);
  const after = cursor ?? 0;
  const metadata = requireRootPageMetadata(
    db.one<Record<string, unknown>>(
      `SELECT count(*) AS row_count,
              coalesce(sum(CASE
                WHEN typeof(ref_key) = 'text'
                 AND typeof(old_raw) IN ('null', 'text')
                 AND typeof(new_raw) IN ('null', 'text')
                 AND typeof(old_oid) IN ('null', 'text')
                 AND typeof(new_oid) IN ('null', 'text')
                THEN 0 ELSE 1 END), 0) AS invalid_types,
              coalesce(sum(length(CAST(ref_key AS BLOB)) +
                           coalesce(length(CAST(old_raw AS BLOB)), 0) +
                           coalesce(length(CAST(new_raw AS BLOB)), 0) +
                           coalesce(length(CAST(old_oid AS BLOB)), 0) +
                           coalesce(length(CAST(new_oid AS BLOB)), 0)), 0) AS text_bytes
         FROM (
           SELECT source_kind, ref_key, checkout_id, ordinal, old_raw, new_raw,
                  old_oid, new_oid, timestamp
             FROM (
               SELECT 0 AS source_kind, entry.ref_name AS ref_key, NULL AS checkout_id,
                      entry.ordinal, entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                      entry.timestamp
                 FROM git_reflog_entries entry
                WHERE entry.repo_id = ? AND entry.timestamp >= ?
               UNION ALL
               SELECT 1 AS source_kind, 'HEAD' AS ref_key, entry.checkout_id,
                      entry.ordinal, entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                      entry.timestamp
                 FROM git_checkout_reflog_entries entry
                WHERE entry.repo_id = ? AND entry.timestamp >= ?
             ) retained
            WHERE ordinal > ? ORDER BY ordinal LIMIT ?
         )`,
      repoId,
      cutoff,
      repoId,
      cutoff,
      after,
      pageRows + 1,
    ),
    "maintenance reflog root page",
    pageRows + 1,
  );
  const candidates: RootCandidate[] = [];
  const directThresholds = new Map<string, number>();
  const checkoutThresholds = new Map<number, number>();
  let rows = 0;
  let payloadRows = 0;
  let textBytes = 0;
  let last = after;
  let hasMore = false;
  for (const row of db.iterate(
    `SELECT source_kind, ref_key, typeof(ref_key) AS ref_key_type,
            length(CAST(ref_key AS BLOB)) AS ref_key_bytes,
            checkout_id, ordinal,
            old_raw, typeof(old_raw) AS old_raw_type,
            length(CAST(old_raw AS BLOB)) AS old_raw_bytes,
            new_raw, typeof(new_raw) AS new_raw_type,
            length(CAST(new_raw AS BLOB)) AS new_raw_bytes,
            old_oid, typeof(old_oid) AS old_oid_type,
            length(CAST(old_oid AS BLOB)) AS old_oid_bytes,
            new_oid, typeof(new_oid) AS new_oid_type,
            length(CAST(new_oid AS BLOB)) AS new_oid_bytes, timestamp
       FROM (
         SELECT 0 AS source_kind, entry.ref_name AS ref_key, NULL AS checkout_id,
                entry.ordinal, entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                entry.timestamp
           FROM git_reflog_entries entry
          WHERE entry.repo_id = ? AND entry.timestamp >= ?
         UNION ALL
         SELECT 1 AS source_kind, 'HEAD' AS ref_key, entry.checkout_id,
                entry.ordinal, entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                entry.timestamp
           FROM git_checkout_reflog_entries entry
          WHERE entry.repo_id = ? AND entry.timestamp >= ?
       ) retained
      WHERE ordinal > ? ORDER BY ordinal LIMIT ?`,
    repoId,
    cutoff,
    repoId,
    cutoff,
    last,
    pageRows + 1,
  )) {
    payloadRows++;
    const refKey = requirePageText(
      row,
      "ref_key",
      "ref_key_type",
      "ref_key_bytes",
      "stored reflog ref key",
    );
    const oldRaw = requireNullablePageText(
      row,
      "old_raw",
      "old_raw_type",
      "old_raw_bytes",
      "stored reflog old target",
    );
    const newRaw = requireNullablePageText(
      row,
      "new_raw",
      "new_raw_type",
      "new_raw_bytes",
      "stored reflog new target",
    );
    const oldOid = requireNullablePageText(
      row,
      "old_oid",
      "old_oid_type",
      "old_oid_bytes",
      "stored reflog old OID",
    );
    const newOid = requireNullablePageText(
      row,
      "new_oid",
      "new_oid_type",
      "new_oid_bytes",
      "stored reflog new OID",
    );
    textBytes += refKey.bytes + oldRaw.bytes + newRaw.bytes + oldOid.bytes + newOid.bytes;
    const ordinal = requireSafeInteger(row.ordinal, "retained reflog ordinal", 1);
    if (ordinal <= last) throw new CorruptError("retained reflog roots are unordered");
    requireSafeInteger(row.timestamp, "retained reflog timestamp", cutoff);
    let threshold: number;
    if (row.source_kind === 0) {
      const refName = requireRefName(refKey.value, "stored reflog ref name", "stored");
      if (row.checkout_id !== null) {
        throw new CorruptError("direct reflog root retained a checkout id");
      }
      const cached = directThresholds.get(refName);
      if (cached !== undefined) {
        threshold = cached;
      } else {
        const value = db.scalar<unknown>(
          `SELECT ordinal FROM git_reflog_entries INDEXED BY git_reflog_entries_by_ref
            WHERE repo_id = ? AND ref_name = ? AND timestamp >= ?
            ORDER BY ordinal DESC LIMIT 1 OFFSET ${RETAINED_REFLOG_ROWS - 1}`,
          repoId,
          refName,
          cutoff,
        );
        threshold =
          value === undefined
            ? 0
            : requireSafeInteger(value, "retained direct reflog threshold", 1);
        directThresholds.set(refName, threshold);
      }
    } else if (row.source_kind === 1) {
      if (refKey.value !== "HEAD") throw new CorruptError("checkout reflog root is not HEAD");
      const checkoutId = requireSafeInteger(row.checkout_id, "checkout reflog root id", 1);
      const cached = checkoutThresholds.get(checkoutId);
      if (cached !== undefined) {
        threshold = cached;
      } else {
        const value = db.scalar<unknown>(
          `SELECT ordinal FROM git_checkout_reflog_entries
            WHERE checkout_id = ? AND timestamp >= ?
            ORDER BY ordinal DESC LIMIT 1 OFFSET ${RETAINED_REFLOG_ROWS - 1}`,
          checkoutId,
          cutoff,
        );
        threshold =
          value === undefined
            ? 0
            : requireSafeInteger(value, "retained checkout reflog threshold", 1);
        checkoutThresholds.set(checkoutId, threshold);
      }
    } else {
      throw new CorruptError("retained reflog root source is invalid");
    }
    const oldRoot = requireReflogEndpoint(oldRaw.value, oldOid.value);
    const newRoot = requireReflogEndpoint(newRaw.value, newOid.value);
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (ordinal >= threshold) {
      if (oldRoot !== null) {
        candidates.push({ oid: oldRoot, expectedType: null, optionalMissing: false });
      }
      if (newRoot !== null) {
        candidates.push({ oid: newRoot, expectedType: null, optionalMissing: false });
      }
    }
    last = ordinal;
    rows++;
  }
  if (payloadRows !== metadata.rows || textBytes !== metadata.textBytes) {
    throw new CorruptError("maintenance reflog root page changed after metadata preflight");
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
  const metadata = requireRootPageMetadata(
    db.one<Record<string, unknown>>(
      `SELECT count(*) AS row_count,
              coalesce(sum(CASE WHEN typeof(path) = 'text' AND typeof(oid) = 'text'
                THEN 0 ELSE 1 END), 0) AS invalid_types,
              coalesce(sum(length(CAST(path AS BLOB)) +
                           length(CAST(oid AS BLOB))), 0) AS text_bytes
         FROM (
           SELECT entry.path, entry.oid
             FROM git_index entry
             JOIN git_checkouts checkout ON checkout.id = entry.checkout_id
            WHERE checkout.repo_id = ? AND (
              checkout.id > ? OR (
                checkout.id = ? AND (
                  entry.path > ? COLLATE BINARY OR (entry.path = ? AND entry.stage > ?)
                )
              )
            )
            ORDER BY checkout.id, entry.path COLLATE BINARY, entry.stage LIMIT ?
         )`,
      repoId,
      checkoutId,
      checkoutId,
      path,
      path,
      stage,
      pageRows + 1,
    ),
    "maintenance index root page",
    pageRows + 1,
  );
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let payloadRows = 0;
  let textBytes = 0;
  let hasMore = false;
  for (const row of db.iterate(
    `SELECT checkout.id AS checkout_id, checkout.repo_id, entry.path,
            typeof(entry.path) AS path_type,
            length(CAST(entry.path AS BLOB)) AS path_bytes,
            entry.stage, entry.mode, entry.oid, typeof(entry.oid) AS oid_type,
            length(CAST(entry.oid AS BLOB)) AS oid_bytes
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
    payloadRows++;
    const storedPath = requirePageText(
      row,
      "path",
      "path_type",
      "path_bytes",
      "stored index root path",
    );
    const storedOid = requirePageText(row, "oid", "oid_type", "oid_bytes", "stored index root OID");
    textBytes += storedPath.bytes + storedOid.bytes;
    if (row.repo_id !== repoId) throw new CorruptError("index root crossed repositories");
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    const nextCheckoutId = requireSafeInteger(row.checkout_id, "index root checkout id", 1);
    if (!validIndexPath(storedPath.value)) {
      throw new CorruptError("index root path is invalid");
    }
    const nextStage = requireSafeInteger(row.stage, "index root stage", 0, 3);
    if (
      nextCheckoutId < checkoutId ||
      (nextCheckoutId === checkoutId &&
        (comparePaths(storedPath.value, path) < 0 ||
          (storedPath.value === path && nextStage <= stage)))
    ) {
      throw new CorruptError("index roots are not in strict key order");
    }
    if (
      row.mode !== 0o100644 &&
      row.mode !== 0o100755 &&
      row.mode !== 0o120000 &&
      row.mode !== 0o160000
    ) {
      throw new CorruptError("index root mode is invalid");
    }
    const oid = requireNullableOid(storedOid.value, "index root OID");
    if (oid === null) throw new CorruptError("index root OID is absent");
    const gitlink = row.mode === 0o160000;
    candidates.push({
      oid,
      expectedType: gitlink ? "commit" : "blob",
      optionalMissing: gitlink,
    });
    checkoutId = nextCheckoutId;
    path = storedPath.value;
    stage = nextStage;
    rows++;
  }
  if (payloadRows !== metadata.rows || textBytes !== metadata.textBytes) {
    throw new CorruptError("maintenance index root page changed after metadata preflight");
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
  const metadata = requireRootPageMetadata(
    db.one<Record<string, unknown>>(
      `SELECT count(*) AS row_count,
              coalesce(sum(CASE WHEN typeof(baseline_tree_oid) IN ('null', 'text')
                THEN 0 ELSE 1 END), 0) AS invalid_types,
              coalesce(sum(coalesce(length(CAST(baseline_tree_oid AS BLOB)), 0)), 0)
                AS text_bytes
         FROM (
           SELECT state.baseline_tree_oid
             FROM git_index_state state
             JOIN git_checkouts checkout ON checkout.id = state.checkout_id
            WHERE checkout.repo_id = ? AND checkout.id > ? AND state.complete = 1
            ORDER BY checkout.id LIMIT ?
         )`,
      repoId,
      after,
      pageRows + 1,
    ),
    "maintenance index baseline root page",
    pageRows + 1,
  );
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let payloadRows = 0;
  let textBytes = 0;
  let last = after;
  let hasMore = false;
  for (const row of db.iterate(
    `SELECT checkout.id AS checkout_id, checkout.repo_id, state.baseline_tree_oid,
            typeof(state.baseline_tree_oid) AS baseline_tree_oid_type,
            length(CAST(state.baseline_tree_oid AS BLOB)) AS baseline_tree_oid_bytes,
            state.format, state.complete
       FROM git_index_state state
       JOIN git_checkouts checkout ON checkout.id = state.checkout_id
      WHERE checkout.repo_id = ? AND checkout.id > ? AND state.complete = 1
      ORDER BY checkout.id LIMIT ?`,
    repoId,
    last,
    pageRows + 1,
  )) {
    payloadRows++;
    const baseline = requireNullablePageText(
      row,
      "baseline_tree_oid",
      "baseline_tree_oid_type",
      "baseline_tree_oid_bytes",
      "stored index baseline tree OID",
    );
    textBytes += baseline.bytes;
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (row.repo_id !== repoId) throw new CorruptError("index baseline crossed repositories");
    const checkoutId = requireSafeInteger(row.checkout_id, "index baseline checkout id", 1);
    if (checkoutId <= last) throw new CorruptError("index baselines are unordered");
    if (row.format !== 1 || row.complete !== 1) {
      throw new CorruptError("complete index baseline state is invalid");
    }
    if (baseline.value !== null) {
      const oid = requireNullableOid(baseline.value, "index baseline tree OID");
      if (oid === null) throw new CorruptError("index baseline tree OID is absent");
      candidates.push({ oid, expectedType: "tree", optionalMissing: false });
    }
    last = checkoutId;
    rows++;
  }
  if (payloadRows !== metadata.rows || textBytes !== metadata.textBytes) {
    throw new CorruptError("maintenance index baseline root page changed after metadata preflight");
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
  const metadata = requireRootPageMetadata(
    db.one<Record<string, unknown>>(
      `SELECT count(*) AS row_count,
              coalesce(sum(CASE WHEN typeof(oid) = 'text' THEN 0 ELSE 1 END), 0)
                AS invalid_types,
              coalesce(sum(length(CAST(oid AS BLOB))), 0) AS text_bytes
         FROM (
           SELECT oid FROM git_shallow
            WHERE repo_id = ? AND (? IS NULL OR oid > ? COLLATE BINARY)
            ORDER BY oid COLLATE BINARY LIMIT ?
         )`,
      repoId,
      cursor,
      cursor,
      pageRows + 1,
    ),
    "maintenance shallow root page",
    pageRows + 1,
  );
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let payloadRows = 0;
  let textBytes = 0;
  let last = cursor;
  let hasMore = false;
  for (const row of db.iterate(
    `SELECT repo_id, oid, typeof(oid) AS oid_type,
            length(CAST(oid AS BLOB)) AS oid_bytes
       FROM git_shallow
      WHERE repo_id = ? AND (? IS NULL OR oid > ? COLLATE BINARY)
      ORDER BY oid COLLATE BINARY LIMIT ?`,
    repoId,
    cursor,
    cursor,
    pageRows + 1,
  )) {
    payloadRows++;
    const storedOid = requirePageText(
      row,
      "oid",
      "oid_type",
      "oid_bytes",
      "stored shallow root OID",
    );
    textBytes += storedOid.bytes;
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (row.repo_id !== repoId) throw new CorruptError("shallow root crossed repositories");
    const oid = requireNullableOid(storedOid.value, "shallow root OID");
    if (oid === null) throw new CorruptError("shallow root OID is absent");
    if (last !== null && comparePaths(last, oid) >= 0) {
      throw new CorruptError("shallow roots are unordered");
    }
    candidates.push({ oid, expectedType: "commit", optionalMissing: false });
    last = oid;
    rows++;
  }
  if (payloadRows !== metadata.rows || textBytes !== metadata.textBytes) {
    throw new CorruptError("maintenance shallow root page changed after metadata preflight");
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
  readOperationRoots: ValidatedOperationRootReader,
): RootPage {
  const candidates: RootCandidate[] = [];
  const after = cursorCheckoutId ?? 0;
  let checkoutId: number | null = null;
  const query =
    cursorOrdinal === null
      ? `SELECT id AS checkout_id, repo_id FROM git_checkouts
          WHERE repo_id = ? AND id > ? ORDER BY id LIMIT 1`
      : `SELECT id AS checkout_id, repo_id FROM git_checkouts
          WHERE repo_id = ? AND id = ? LIMIT 1`;
  for (const row of db.iterate(query, repoId, after)) {
    if (row.repo_id !== repoId) throw new CorruptError("operation root crossed repositories");
    checkoutId = requireSafeInteger(row.checkout_id, "operation root checkout id", 1);
    if (
      (cursorOrdinal === null && checkoutId <= after) ||
      (cursorOrdinal !== null && checkoutId !== cursorCheckoutId)
    ) {
      throw new CorruptError("operation root checkouts are unordered");
    }
  }
  if (checkoutId === null) {
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
  const roots = readOperationRoots(checkoutId);
  const offset = cursorOrdinal ?? 0;
  if (offset > roots.length) {
    throw new CorruptError("operation root cursor exceeds its validated journal");
  }
  const end = Math.min(roots.length, offset + pageRows);
  for (let ordinal = offset; ordinal < end; ordinal++) {
    const root = roots[ordinal];
    if (root === undefined || !isOid(root.oid)) {
      throw new CorruptError("validated operation root is invalid");
    }
    if (!isObjectType(root.expectedType)) {
      throw new CorruptError("validated operation root type is invalid");
    }
    candidates.push({
      oid: root.oid,
      expectedType: root.expectedType,
      optionalMissing: false,
    });
  }
  if (end < roots.length) {
    return {
      candidates,
      cursorCheckoutId: checkoutId,
      cursorText: null,
      cursorOrdinal: end,
      hasMore: true,
    };
  }
  let nextCheckout = false;
  for (const row of db.iterate(
    `SELECT id AS checkout_id, repo_id FROM git_checkouts
      WHERE repo_id = ? AND id > ? ORDER BY id LIMIT 1`,
    repoId,
    checkoutId,
  )) {
    if (row.repo_id !== repoId) throw new CorruptError("operation root crossed repositories");
    const nextId = requireSafeInteger(row.checkout_id, "next operation root checkout id", 1);
    if (nextId <= checkoutId) throw new CorruptError("operation root checkouts are unordered");
    nextCheckout = true;
  }
  return {
    candidates,
    cursorCheckoutId: checkoutId,
    cursorText: null,
    cursorOrdinal: null,
    hasMore: nextCheckout,
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
            loose.type AS loose_type, packed.type AS packed_type
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
      ORDER BY CAST(input.key AS INTEGER)`,
    payload,
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
  readOperationRoots: ValidatedOperationRootReader,
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
      readOperationRoots,
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
        RETURNING repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
                  cursor_checkout_id, cursor_text, typeof(cursor_text) AS cursor_text_type,
                  length(CAST(cursor_text AS BLOB)) AS cursor_text_bytes,
                  cursor_ordinal, restarted`,
      queuedObjects,
      repoId,
      run.runId,
      rootEpoch,
    );
    if (row === undefined) throw new CorruptError("maintenance root completion lost its epoch");
    const cursorBytes = requireCursorMetadata(row);
    if (cursorBytes !== null)
      throw new CorruptError("completed maintenance roots retained a cursor");
    return requireRun(row, repoId, cursorBytes);
  }
  const nextCursor = page.hasMore ? page.cursorText : null;
  const nextCursorBytes =
    nextCursor === null ? null : utf8Bytes(nextCursor, Number.MAX_SAFE_INTEGER);
  if (nextCursorBytes === -1) throw new CorruptError("maintenance text cursor is invalid");
  const row = db.one<Record<string, unknown>>(
    `UPDATE git_maintenance_runs
        SET root_source = ?, cursor_checkout_id = ?, cursor_text = ?, cursor_ordinal = ?
      WHERE repo_id = ? AND run_id = ? AND observed_root_epoch = ? AND phase = 'roots'
      RETURNING repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
                cursor_checkout_id, cursor_text, typeof(cursor_text) AS cursor_text_type,
                length(CAST(cursor_text AS BLOB)) AS cursor_text_bytes,
                cursor_ordinal, restarted`,
    source,
    page.hasMore ? page.cursorCheckoutId : null,
    page.hasMore ? page.cursorText : null,
    page.hasMore ? page.cursorOrdinal : null,
    repoId,
    run.runId,
    rootEpoch,
  );
  if (row === undefined) throw new CorruptError("maintenance root cursor lost its epoch");
  const returnedCursorBytes = requireCursorMetadata(row);
  if (returnedCursorBytes !== nextCursorBytes) {
    throw new CorruptError("maintenance root cursor changed while it was published");
  }
  return requireRun(row, repoId, returnedCursorBytes);
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
    const page = pageForSource(db, options.repoId, run, pageRows, options.readOperationRoots);
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

/** Extract roots only from a journal already accepted by CheckoutStore validation. */
export function validatedOperationJournalRoots(
  journal: OperationJournal,
): readonly MaintenanceRootInput[] {
  const roots: MaintenanceRootInput[] = [
    { oid: journal.state.originalHeadOid, expectedType: "commit" },
  ];
  if (journal.state.kind === "merge") {
    roots.push({ oid: journal.state.currentParentOid, expectedType: "commit" });
    roots.push({ oid: journal.state.incomingParentOid, expectedType: "commit" });
  } else if (journal.state.kind === "rebase") {
    roots.push({ oid: journal.state.upstreamOid, expectedType: "commit" });
    roots.push({ oid: journal.state.baseOid, expectedType: "commit" });
    roots.push({ oid: journal.state.currentParentOid, expectedType: "commit" });
  }
  for (const step of journal.steps) {
    roots.push({ oid: step.sourceOid, expectedType: "commit" });
    if (step.selectedParentOid !== null) {
      roots.push({ oid: step.selectedParentOid, expectedType: "commit" });
    }
    if (step.resultOid !== null) roots.push({ oid: step.resultOid, expectedType: "commit" });
  }
  for (const entry of journal.touched) {
    if (entry.index !== null) {
      roots.push({
        oid: entry.index.oid,
        expectedType: entry.index.mode === 0o160000 ? "commit" : "blob",
      });
    }
    if (entry.worktree.kind === "file" || entry.worktree.kind === "symlink") {
      roots.push({ oid: entry.worktree.oid, expectedType: "blob" });
    }
  }
  return roots;
}
