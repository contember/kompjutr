import { describe, expect, expectTypeOf, it } from "vitest";
import { Database } from "../src/db/db.js";
import { createFilesystem } from "../src/fs/filesystem.js";
import { utf8 } from "../src/git/common/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../src/git/common/objects.js";
import type { MergeStateMetadata, MergeTouchedPath } from "../src/git/ops/merge-state.js";
import type { CheckoutStore } from "../src/git/store/checkout.js";
import type { CheckoutRow } from "../src/git/store/contracts.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
import {
  advanceIndexTrackerBaseline,
  initializeIndexTracker,
  invalidateIndexTracker,
  resealIndexTracker,
} from "../src/git/store/index-tracker.js";
import {
  MAINTENANCE_ROOT_EPOCH_EXHAUSTED,
  readMaintenanceRootEpoch,
} from "../src/git/store/maintenance/control.js";
import type { MaintenanceRootSource } from "../src/git/store/maintenance/roots.js";
import { TestDatabase } from "./helpers/db.js";

const NOW = 1_800_000_000_123;
const PERSON = {
  name: "Fixture",
  email: "fixture@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};
const EMPTY_TREE_BYTES = serializeTree([]);

interface MaintenanceRootFixture {
  db: TestDatabase;
  database: SqliteGitDatabase;
  checkout: CheckoutRow;
  store: CheckoutStore;
}
function installRootRun(db: TestDatabase, repoId: number, source: MaintenanceRootSource): void {
  const rootEpoch = db.scalar<number>(
    "SELECT root_epoch FROM git_maintenance_control WHERE repo_id = ?",
    repoId,
  );
  if (rootEpoch === undefined) {
    db.run(
      `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
       VALUES (?, 0, 2)`,
      repoId,
    );
  } else {
    db.run("UPDATE git_maintenance_control SET next_run_id = 2 WHERE repo_id = ?", repoId);
  }
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
     VALUES (?, 1, ?, 'roots', ?, ?)`,
    repoId,
    rootEpoch ?? 0,
    NOW,
    source,
  );
}

function commitBytes(message: string, parent: string[] = []): Uint8Array {
  return serializeCommit({
    tree: hashObject("tree", EMPTY_TREE_BYTES),
    parent,
    author: PERSON,
    committer: PERSON,
    message: `${message}\n`,
  });
}

function open(now = NOW): MaintenanceRootFixture {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db, { now: () => now });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { db, database, checkout, store };
}

function mergeMetadata(original: string, incoming: string): MergeStateMetadata {
  return {
    originalHeadRef: "refs/heads/main",
    originalHeadOid: original,
    currentParentOid: original,
    incomingParentOid: incoming,
    phase: "conflicted",
    mode: "commit",
    mergeOrigin: "merge",
    currentLabel: "HEAD",
    incomingLabel: "topic",
    message: "Merge topic\n",
    author: null,
    committer: null,
  };
}

function rootMask(db: TestDatabase, repoId: number, oid: string): number | undefined {
  return db.scalar<number>(
    "SELECT source_mask FROM git_maintenance_objects WHERE repo_id = ? AND oid = ?",
    repoId,
    oid,
  );
}

function hasRootSource(db: TestDatabase, repoId: number, oid: string, source: number): boolean {
  const mask = rootMask(db, repoId, oid);
  return mask !== undefined && (mask & source) === source;
}

function projectionCount(db: TestDatabase, fragment: string): number {
  let count = 0;
  for (const [query, calls] of db.storage.histogram ?? []) {
    if (query.includes(fragment)) count += calls;
  }
  return count;
}

describe("maintenance roots", () => {
  it("keeps reservation ownership out of the public database method", () => {
    const { database } = open();

    expectTypeOf(database.advanceMaintenanceRootSnapshot)
      .parameter(1)
      .toEqualTypeOf<{ nowMs: number; pageRows?: number }>();
  });

  it("uses one retained SQL fingerprint for each bounded root-source projection", () => {
    const expectSingleProjection = (
      source: MaintenanceRootSource,
      setup: (opened: MaintenanceRootFixture) => void,
      fingerprint: string,
    ): string => {
      const opened = open();
      setup(opened);
      installRootRun(opened.db, opened.checkout.repoId, source);
      opened.db.storage.histogram = new Map();
      opened.db.storage.resetCounters();

      opened.database.advanceMaintenanceRootSnapshot(opened.checkout.repoId, {
        nowMs: NOW,
        pageRows: 1,
      });

      const queries = [...(opened.db.storage.histogram?.keys() ?? [])].join("\n");
      expect(projectionCount(opened.db, fingerprint)).toBe(1);
      expect(queries).not.toContain("SELECT count(*) AS row_count");
      return queries;
    };

    expectSingleProjection(
      "refs",
      ({ store }) => {
        const oid = store.write("blob", utf8.encode("ref projection"));
        store.setRef("refs/heads/main", oid);
      },
      "SELECT repo_id, name, target FROM git_refs",
    );
    expectSingleProjection(
      "heads",
      ({ store }) => {
        store.setHead(store.write("blob", utf8.encode("HEAD projection")));
      },
      "SELECT id AS checkout_id, repo_id, head FROM git_checkouts",
    );
    expectSingleProjection(
      "reflogs",
      ({ store }) => {
        const oid = store.write("blob", utf8.encode("reflog projection"));
        store.setRef("refs/heads/main", oid);
      },
      "WITH direct_page AS MATERIALIZED ( SELECT 0 AS source_kind, entry.repo_id",
    );
    expectSingleProjection(
      "index",
      ({ store }) => {
        store.indexPut({
          path: "projection.txt",
          stage: 0,
          mode: 0o100644,
          oid: store.write("blob", utf8.encode("index projection")),
          size: null,
          mtime: null,
          ino: null,
        });
      },
      "SELECT checkout.id AS checkout_id, checkout.repo_id, entry.path",
    );
    expectSingleProjection(
      "index-baseline",
      ({ db, checkout, store }) => {
        const tree = store.write("tree", EMPTY_TREE_BYTES);
        db.run(
          `UPDATE git_index_state
              SET baseline_tree_oid = ?, format = 1, complete = 1
            WHERE checkout_id = ?`,
          tree,
          checkout.id,
        );
      },
      "SELECT checkout.id AS checkout_id, checkout.repo_id, state.baseline_tree_oid",
    );
    expectSingleProjection(
      "shallow",
      ({ store }) => {
        store.setShallow([store.write("commit", commitBytes("shallow projection"))]);
      },
      "SELECT repo_id, oid FROM git_shallow",
    );
    const operationQueries = expectSingleProjection(
      "operations",
      ({ store }) => {
        const original = store.write("commit", commitBytes("operation original"));
        const incoming = store.write("commit", commitBytes("operation incoming", [original]));
        store.writeMergeState(
          {
            ...mergeMetadata(original, incoming),
            phase: "ready",
            mode: "no-commit",
          },
          [],
        );
      },
      "SELECT oid, expected_type FROM ( SELECT original_head_oid AS oid",
    );
    expect(operationQueries).not.toContain(
      "SELECT kind, original_head_ref, original_head_oid, phase",
    );
    expect(operationQueries).not.toContain(
      "SELECT ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid",
    );
    expect(operationQueries).not.toContain(
      "SELECT ordinal, path, logical_path, purpose, index_stage, index_mode, index_oid",
    );
  });

  it("resumes index discovery from a path beyond the former local cursor ceiling", () => {
    const { db, database, checkout, store } = open();
    const oid = store.write("blob", utf8.encode("long index root\n"));
    const firstPath = "a".repeat(4_097);
    const secondPath = "b".repeat(4_097);
    for (const path of [firstPath, secondPath]) {
      store.indexPut({
        path,
        stage: 0,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      });
    }
    installRootRun(db, checkout.repoId, "index");

    expect(
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toMatchObject({ rootSource: "index", complete: false });
    expect(
      db.scalar<string>(
        "SELECT cursor_text FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(firstPath);
    expect(
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toMatchObject({ rootSource: "index-baseline", complete: false });
    expect(hasRootSource(db, checkout.repoId, oid, 8)).toBe(true);
  });

  it("snapshots every authoritative root across cold bounded resumes", () => {
    const { db, database, checkout, store } = open();
    const tree = store.write("tree", EMPTY_TREE_BYTES);
    const originalBytes = commitBytes("original");
    const original = store.write("commit", originalBytes);
    const incoming = store.write("commit", commitBytes("incoming", [original]));
    const shallow = store.write("commit", commitBytes("shallow"));
    const refOld = store.write("blob", utf8.encode("old ref\n"));
    const refCurrent = store.write("blob", utf8.encode("current ref\n"));
    const indexBlob = store.write("blob", utf8.encode("index\n"));
    const operationBlob = store.write("blob", utf8.encode("operation\n"));
    const missingGitlink = "f".repeat(40);

    store.setRef("refs/heads/main", refOld);
    store.setRef("refs/heads/main", refCurrent);
    store.setRef("refs/remotes/origin/HEAD", "ref: refs/heads/main");
    store.setHead(original);
    store.indexPut({
      path: "file.txt",
      stage: 2,
      mode: 0o100644,
      oid: indexBlob,
      size: null,
      mtime: null,
      ino: null,
    });
    store.indexPut({
      path: "submodule",
      stage: 0,
      mode: 0o160000,
      oid: missingGitlink,
      size: null,
      mtime: null,
      ino: null,
    });
    db.run(
      `UPDATE git_index_state
          SET baseline_tree_oid = ?, format = 1, complete = 1
        WHERE checkout_id = ?`,
      tree,
      checkout.id,
    );
    store.setShallow([shallow]);
    const touched: readonly MergeTouchedPath[] = [
      {
        path: "saved.txt",
        logicalPath: "saved.txt",
        purpose: "primary",
        index: {
          stage: 0,
          mode: 0o100644,
          oid: operationBlob,
          size: 10,
          mtime: 1,
          ino: 2,
          rev: 3,
        },
        worktree: { kind: "file", mode: 0o100644, oid: operationBlob, revision: 4 },
      },
    ];
    store.writeMergeState(mergeMetadata(original, incoming), touched);

    let active = database;
    db.storage.resetCounters();
    let progress = active.advanceMaintenanceRootSnapshot(checkout.repoId, {
      nowMs: NOW,
      pageRows: 1,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    for (let calls = 1; !progress.complete && calls < 40; calls++) {
      active = new SqliteGitDatabase(db, { now: () => NOW + 200 * 24 * 60 * 60 * 1_000 });
      db.storage.resetCounters();
      progress = active.advanceMaintenanceRootSnapshot(checkout.repoId, {
        nowMs: NOW + 200 * 24 * 60 * 60 * 1_000,
        pageRows: 1,
      });
      expect(db.storage.statementCount).toBeLessThan(1_000);
    }

    expect(progress.complete).toBe(true);
    expect(progress.rootSource).toBe("done");
    expect(
      db.one<{ phase: string; started_ms: number; queued_objects: number }>(
        `SELECT phase, started_ms, queued_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({
      phase: "mark",
      started_ms: NOW,
      queued_objects: db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ?",
        checkout.repoId,
      ),
    });
    expect(hasRootSource(db, checkout.repoId, refCurrent, 1)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, refOld, 4)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, original, 2)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, indexBlob, 8)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, tree, 16)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, shallow, 32)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, incoming, 64)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, operationBlob, 64)).toBe(true);
    expect(rootMask(db, checkout.repoId, missingGitlink)).toBeUndefined();
    expect(
      db.all<{ oid: string }>(
        "SELECT oid FROM git_maintenance_shallow WHERE repo_id = ? ORDER BY oid",
        checkout.repoId,
      ),
    ).toEqual([{ oid: shallow }]);
  });

  it("restarts the same run and clears partial roots after epoch drift", () => {
    const { db, database, checkout, store } = open();
    const first = store.write("blob", utf8.encode("first"));
    const second = store.write("blob", utf8.encode("second"));
    store.setRef("refs/heads/a", first);
    store.setRef("refs/heads/b", second);

    const before = database.advanceMaintenanceRootSnapshot(checkout.repoId, {
      nowMs: NOW,
      pageRows: 1,
    });
    expect(before).toMatchObject({ rootSource: "refs", complete: false, restarted: false });
    expect(rootMask(db, checkout.repoId, first)).toBe(1);
    store.deleteRef("refs/heads/a");

    const after = database.advanceMaintenanceRootSnapshot(checkout.repoId, {
      nowMs: NOW,
      pageRows: 1,
    });
    expect(after).toMatchObject({
      runId: before.runId,
      rootSource: "heads",
      complete: false,
      restarted: true,
    });
    expect(rootMask(db, checkout.repoId, first)).toBeUndefined();
    expect(rootMask(db, checkout.repoId, second)).toBe(1);
  });

  it("pages retained reflogs beyond the old aggregate cap at the fixed cutoff", () => {
    const { db, database, checkout, store } = open();
    const left = store.write("blob", utf8.encode("left"));
    const right = store.write("blob", utf8.encode("right"));
    const expired = store.write("blob", utf8.encode("expired"));
    const boundary = store.write("blob", utf8.encode("boundary"));
    const cutoff = Math.floor(NOW / 1_000) - 90 * 24 * 60 * 60;
    db.run(
      `WITH RECURSIVE sequence(ordinal) AS (
         VALUES (1) UNION ALL SELECT ordinal + 1 FROM sequence WHERE ordinal < 8192
       )
       INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       SELECT ?, 'refs/heads/r' || CAST((ordinal - 1) / 1024 AS INTEGER), ordinal,
              CASE WHEN ordinal % 2 = 0 THEN ? ELSE ? END,
              CASE WHEN ordinal % 2 = 0 THEN ? ELSE ? END,
              CASE WHEN ordinal % 2 = 0 THEN ? ELSE ? END,
              CASE WHEN ordinal % 2 = 0 THEN ? ELSE ? END,
              NULL, NULL, ?, 0, 'bulk retention witness'
         FROM sequence`,
      checkout.repoId,
      right,
      left,
      left,
      right,
      right,
      left,
      left,
      right,
      cutoff,
    );
    db.run(
      `INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, 'refs/heads/expired', 8193, ?, ?, ?, ?, NULL, NULL, ?, 0, 'expired'),
              (?, 'refs/heads/boundary', 8194, ?, ?, ?, ?, NULL, NULL, ?, 0, 'boundary')`,
      checkout.repoId,
      left,
      expired,
      left,
      expired,
      cutoff - 1,
      checkout.repoId,
      left,
      boundary,
      left,
      boundary,
      cutoff,
    );
    db.run("UPDATE git_reflog_state SET next_ordinal = 8194 WHERE repo_id = ?", checkout.repoId);

    db.storage.resetCounters();
    let progress = database.advanceMaintenanceRootSnapshot(checkout.repoId, {
      nowMs: NOW,
      pageRows: 128,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    for (let calls = 1; !progress.complete && calls < 100; calls++) {
      db.storage.resetCounters();
      progress = database.advanceMaintenanceRootSnapshot(checkout.repoId, {
        nowMs: NOW,
        pageRows: 128,
      });
      expect(db.storage.statementCount).toBeLessThan(1_000);
    }

    expect(progress.complete).toBe(true);
    expect(hasRootSource(db, checkout.repoId, left, 4)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, right, 4)).toBe(true);
    expect(hasRootSource(db, checkout.repoId, boundary, 4)).toBe(true);
    expect(rootMask(db, checkout.repoId, expired)).toBeUndefined();
  });

  it("advances bounded reflog pages through expired rows before a retained endpoint", () => {
    const { db, database, checkout, store } = open();
    const expired = store.write("blob", utf8.encode("expired page"));
    const boundary = store.write("blob", utf8.encode("retained page"));
    const cutoff = Math.floor(NOW / 1_000) - 90 * 24 * 60 * 60;
    db.run(
      `INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, 'refs/heads/main', 1, NULL, ?, NULL, ?, NULL, NULL, ?, 0, 'expired one'),
              (?, 'refs/heads/main', 2, ?, NULL, ?, NULL, NULL, NULL, ?, 0, 'expired two'),
              (?, 'refs/heads/main', 3, NULL, ?, NULL, ?, NULL, NULL, ?, 0, 'boundary')`,
      checkout.repoId,
      expired,
      expired,
      cutoff - 1,
      checkout.repoId,
      expired,
      expired,
      cutoff - 1,
      checkout.repoId,
      boundary,
      boundary,
      cutoff,
    );
    installRootRun(db, checkout.repoId, "reflogs");
    db.storage.histogram = new Map();

    for (const ordinal of [1, 2]) {
      db.storage.resetCounters();
      expect(
        database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
      ).toMatchObject({ rootSource: "reflogs", complete: false });
      expect(
        db.scalar<number>(
          "SELECT cursor_ordinal FROM git_maintenance_runs WHERE repo_id = ?",
          checkout.repoId,
        ),
      ).toBe(ordinal);
      expect(
        projectionCount(
          db,
          "WITH direct_page AS MATERIALIZED ( SELECT 0 AS source_kind, entry.repo_id",
        ),
      ).toBe(1);
      expect(rootMask(db, checkout.repoId, expired)).toBeUndefined();
    }

    expect(
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toMatchObject({ rootSource: "index", complete: false });
    expect(hasRootSource(db, checkout.repoId, boundary, 4)).toBe(true);
  });

  it("increments the epoch in root-changing transactions and rolls back on exhaustion", () => {
    const { db, database, checkout, store } = open();
    const oid = store.write("blob", utf8.encode("root"));
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(0);

    const linked = database.createCheckout(checkout.repoId, "/linked", "ref: refs/heads/linked");
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(1);
    database.removeCheckout(linked.id, () => undefined);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(2);
    store.setRef("refs/heads/main", oid);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(3);
    store.indexPut({
      path: "root.txt",
      stage: 3,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(4);
    store.setShallow([oid]);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(5);
    db.run(
      `UPDATE git_index_state SET baseline_tree_oid = ?, complete = 1
        WHERE checkout_id = ?`,
      oid,
      checkout.id,
    );
    expect(advanceIndexTrackerBaseline(db, checkout.id, null)).toBe(true);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(6);
    store.write("tree", EMPTY_TREE_BYTES);
    const original = store.write("commit", commitBytes("epoch original"));
    const incoming = store.write("commit", commitBytes("epoch incoming", [original]));
    const ready: MergeStateMetadata = {
      ...mergeMetadata(original, incoming),
      phase: "ready",
      mode: "no-commit",
    };
    store.writeMergeState(ready, []);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(7);
    expect(store.requireOperationState("merge").state).toEqual({ kind: "merge", ...ready });
    expect(store.clearOperationState()).toBe(true);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(8);

    db.run(
      "UPDATE git_maintenance_control SET root_epoch = ? WHERE repo_id = ?",
      Number.MAX_SAFE_INTEGER,
      checkout.repoId,
    );
    expect(() =>
      store.indexPut({
        path: "rolled-back.txt",
        stage: 0,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: MAINTENANCE_ROOT_EPOCH_EXHAUSTED }),
    );
    expect(store.indexGet("rolled-back.txt")).toBeNull();
  });

  it("bumps the epoch for every public root mutation shape", () => {
    const { db, database, checkout, store } = open();
    const oid = store.write("blob", utf8.encode("witness"));
    const entry = (path: string) => ({
      path,
      stage: 0,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });
    const increases = (mutation: () => void): void => {
      const before = readMaintenanceRootEpoch(db, checkout.repoId);
      mutation();
      expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBeGreaterThan(before);
    };

    increases(() => {
      expect(
        store.tryCreateInitialState((session) => session.put(entry("initial"))).available,
      ).toBe(true);
    });
    increases(() => store.setHead(oid));
    store.indexPut(entry("remove"));
    increases(() => store.indexRemove("remove"));
    store.indexPut(entry("clear"));
    increases(() => store.indexClear());
    increases(() => store.indexApply((sink) => sink.put(entry("apply")), { flushEvery: 1 }));
    increases(() =>
      store.indexReplace([entry("replace-a"), entry("replace-b")], { flushEvery: 1 }),
    );
    store.setShallow([oid]);
    increases(() => store.setShallow([], [oid]));
    const first = database.createCheckout(checkout.repoId, "/bulk-a", oid);
    const second = database.createCheckout(checkout.repoId, "/bulk-b", oid);
    increases(() => {
      database.removeCheckouts(checkout.repoId, [first.id, second.id]);
    });
  });

  it("maps trigger epoch exhaustion to E2BIG and rolls back invalidation", () => {
    const { db, checkout, store } = open();
    const adapter = new Database(db.storage);
    const worktree = createFilesystem(adapter);
    worktree.mkdir("/repo", { recursive: true });
    initializeIndexTracker(adapter);
    const first = store.write("blob", utf8.encode("first"));
    const tree = store.write("tree", EMPTY_TREE_BYTES);
    store.indexPut({
      path: "tracked",
      stage: 0,
      mode: 0o100644,
      oid: first,
      size: null,
      mtime: null,
      ino: null,
    });
    let before = readMaintenanceRootEpoch(db, checkout.repoId);
    expect(resealIndexTracker(adapter, checkout.id, tree, [])).toBe(true);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBeGreaterThan(before);
    before = readMaintenanceRootEpoch(db, checkout.repoId);
    invalidateIndexTracker(adapter, checkout.id);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBeGreaterThan(before);
    expect(resealIndexTracker(adapter, checkout.id, tree, [])).toBe(true);
    before = readMaintenanceRootEpoch(db, checkout.repoId);
    worktree.writeFile("/repo/.gitignore", utf8.encode("first\n"));
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBeGreaterThan(before);
    expect(resealIndexTracker(adapter, checkout.id, tree, [])).toBe(true);
    db.run(
      "UPDATE git_maintenance_control SET root_epoch = ? WHERE repo_id = ?",
      Number.MAX_SAFE_INTEGER,
      checkout.repoId,
    );
    expect(() => worktree.writeFile("/repo/.gitignore", utf8.encode("ignored\n"))).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: MAINTENANCE_ROOT_EPOCH_EXHAUSTED }),
    );
    expect(store.indexGet("tracked")?.oid).toBe(first);
    expect(
      db.scalar<number>("SELECT complete FROM git_index_state WHERE checkout_id = ?", checkout.id),
    ).toBe(1);
  });

  it("rejects a missing bounded operation root without advancing its cursor", () => {
    const { db, database, checkout, store } = open();
    const tree = store.write("tree", EMPTY_TREE_BYTES);
    const original = store.write("commit", commitBytes("original"));
    const incoming = store.write("commit", commitBytes("incoming", [original]));
    expect(tree).toBe(hashObject("tree", EMPTY_TREE_BYTES));
    const ready: MergeStateMetadata = {
      ...mergeMetadata(original, incoming),
      phase: "ready",
      mode: "no-commit",
    };
    store.writeMergeState(ready, []);
    db.run(
      `INSERT INTO git_maintenance_runs
         (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
       SELECT repo_id, 1, root_epoch, 'roots', ?, 'operations'
         FROM git_maintenance_control WHERE repo_id = ?`,
      NOW,
      checkout.repoId,
    );
    db.run(
      "UPDATE git_operation_state SET original_head_oid = ? WHERE checkout_id = ?",
      "e".repeat(40),
      checkout.id,
    );

    expect(() =>
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_objects")).toBe(0);
    expect(
      db.one<{ root_source: string; cursor_checkout_id: number | null }>(
        "SELECT root_source, cursor_checkout_id FROM git_maintenance_runs",
      ),
    ).toEqual({ root_source: "operations", cursor_checkout_id: null });
  });

  it("rejects a duplicate global reflog ordinal at a page boundary", () => {
    const { db, database, checkout } = open();
    const oid = "a".repeat(40);
    db.run(
      `INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid, timestamp, timezone, reason)
       VALUES (?, 'refs/heads/main', 1, NULL, ?, NULL, ?, ?, 0, 'duplicate')`,
      checkout.repoId,
      oid,
      oid,
      Math.floor(NOW / 1_000),
    );
    db.run(
      `INSERT INTO git_checkout_reflog_entries
         (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid, timestamp, timezone, reason)
       VALUES (?, ?, 1, NULL, ?, NULL, ?, ?, 0, 'duplicate')`,
      checkout.id,
      checkout.repoId,
      oid,
      oid,
      Math.floor(NOW / 1_000),
    );
    database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 });
    database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 });
    expect(() =>
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("leaves downstream maintenance state untouched on epoch drift", () => {
    const { db, database, checkout, store } = open();
    const oid = store.write("blob", utf8.encode("downstream"));
    const first = database.advanceMaintenanceRootSnapshot(checkout.repoId, {
      nowMs: NOW,
      pageRows: 1,
    });
    db.run(
      `UPDATE git_maintenance_runs
          SET phase = 'repack', root_source = 'done', cursor_checkout_id = NULL,
              cursor_text = NULL, cursor_ordinal = NULL, reachable_objects = 7,
              queued_objects = 0, repacked_objects = 3
        WHERE repo_id = ?`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
       VALUES (?, ?, ?, 1, 0, 0, 0, 0)`,
      checkout.repoId,
      first.runId,
      oid,
    );
    store.setHead(oid);
    const before = db.one<Record<string, unknown>>(
      "SELECT * FROM git_maintenance_runs WHERE repo_id = ?",
      checkout.repoId,
    );
    expect(() =>
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(db.one("SELECT * FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId)).toEqual(
      before,
    );
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1);
  });

  it("treats a promised missing blob in the index as a leaf, not a root", () => {
    const { db, database, checkout, store } = open();
    const promised = hashObject("blob", utf8.encode("omitted by blob:none\n"));
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    store.addPromisedBlobs("origin", [promised]);
    store.indexPut({
      path: "omitted.txt",
      stage: 0,
      mode: 0o100644,
      oid: promised,
      size: null,
      mtime: null,
      ino: null,
    });
    installRootRun(db, checkout.repoId, "index");

    expect(
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 128 }),
    ).toMatchObject({ rootSource: "index-baseline", complete: false });
    expect(rootMask(db, checkout.repoId, promised)).toBeUndefined();
  });

  it("still rejects a missing index root that no promise covers", () => {
    const { db, database, checkout, store } = open();
    const missing = hashObject("blob", utf8.encode("never promised\n"));
    store.indexPut({
      path: "gone.txt",
      stage: 0,
      mode: 0o100644,
      oid: missing,
      size: null,
      mtime: null,
      ino: null,
    });
    installRootRun(db, checkout.repoId, "index");

    expect(() =>
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 128 }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(rootMask(db, checkout.repoId, missing)).toBeUndefined();
  });
});
