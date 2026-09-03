import type { SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { ensureMaintenanceControl } from "./control.js";
import {
  type AdvanceMaintenanceRootSnapshotOptions,
  DEFAULT_PAGE_ROWS,
  isObjectType,
  MAINTENANCE_ROOT_EPOCH_DRIFTED,
  MAX_PAGE_ROWS,
  type MaintenanceRootSnapshotProgress,
  type MaintenanceRootSource,
  type OperationRootPageReader,
  ROOT_HEADS,
  ROOT_INDEX,
  ROOT_INDEX_BASELINE,
  ROOT_OPERATIONS,
  ROOT_REFLOGS,
  ROOT_REFS,
  ROOT_SHALLOW,
  ROOT_SOURCES,
  type RootCandidate,
  type RootPage,
  requireSafeInteger,
} from "./root-contracts.js";
import { rootsFromHeads, rootsFromReflogs, rootsFromRefs } from "./root-ref-pages.js";
import {
  rootsFromIndex,
  rootsFromIndexBaselines,
  rootsFromOperations,
  rootsFromShallow,
} from "./root-worktree-pages.js";
import type { MaintenanceRunView } from "./state-contracts.js";
import { readMaintenanceRunView } from "./state-view.js";

type RunState = MaintenanceRunView;

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
