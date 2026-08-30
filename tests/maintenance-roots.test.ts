import { describe, expect, expectTypeOf, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { hashObject, serializeCommit, serializeTree } from "../src/core/objects.js";
import type { MergeStateMetadata, MergeTouchedPath } from "../src/core/ops/merge-state.js";
import { mergeOperationState } from "../src/core/ops/operation-state.js";
import { createFilesystem } from "../src/fs/filesystem.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import { Database, type SqlDatabase } from "../src/sqlite/db.js";
import {
  advanceIndexTrackerBaseline,
  initializeIndexTracker,
  invalidateIndexTracker,
  resealIndexTracker,
} from "../src/sqlite/index-tracker.js";
import {
  MAINTENANCE_ROOT_EPOCH_EXHAUSTED,
  readMaintenanceRootEpoch,
} from "../src/sqlite/maintenance/control.js";
import {
  type MaintenanceRootSource,
  validatedOperationJournalRoots,
} from "../src/sqlite/maintenance/roots.js";
import { advanceMaintenanceRootSnapshotOwned, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

const NOW = 1_800_000_000_123;
const PERSON = {
  name: "Fixture",
  email: "fixture@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};
const EMPTY_TREE_BYTES = serializeTree([]);

class MaintenanceCursorDatabase implements SqlDatabase {
  cursorPayloadReads = 0;
  refPayloadReads = 0;
  headPayloadReads = 0;
  reflogPayloadReads = 0;
  indexPayloadReads = 0;
  indexBaselinePayloadReads = 0;
  shallowPayloadReads = 0;
  operationCheckoutReads = 0;

  constructor(readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    if (
      query.includes("SELECT repo_id, run_id, observed_root_epoch") &&
      query.includes("cursor_checkout_id, cursor_text")
    ) {
      this.cursorPayloadReads++;
    }
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    if (query.includes("typeof(name) AS name_type")) this.refPayloadReads++;
    if (query.includes("typeof(head) AS head_type")) this.headPayloadReads++;
    if (query.includes("typeof(ref_key) AS ref_key_type")) this.reflogPayloadReads++;
    if (query.includes("typeof(entry.path) AS path_type")) this.indexPayloadReads++;
    if (query.includes("typeof(state.baseline_tree_oid) AS baseline_tree_oid_type")) {
      this.indexBaselinePayloadReads++;
    }
    if (query.includes("typeof(oid) AS oid_type") && query.includes("FROM git_shallow")) {
      this.shallowPayloadReads++;
    }
    if (query.includes("SELECT id AS checkout_id, repo_id FROM git_checkouts")) {
      this.operationCheckoutReads++;
    }
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
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

function rootPayloadReads(
  database: MaintenanceCursorDatabase,
  source: Exclude<MaintenanceRootSource, "operations" | "done">,
): number {
  if (source === "refs") return database.refPayloadReads;
  if (source === "heads") return database.headPayloadReads;
  if (source === "reflogs") return database.reflogPayloadReads;
  if (source === "index") return database.indexPayloadReads;
  if (source === "index-baseline") return database.indexBaselinePayloadReads;
  return database.shallowPayloadReads;
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

function open(now = NOW) {
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

describe("maintenance roots", () => {
  it("keeps reservation ownership out of the public database method", () => {
    const { database } = open();

    expectTypeOf(database.advanceMaintenanceRootSnapshot)
      .parameter(1)
      .toEqualTypeOf<{ nowMs: number; pageRows?: number }>();
  });

  it("admits a cold text cursor from metadata before materializing its payload", () => {
    const inner = new TestDatabase();
    const observed = new MaintenanceCursorDatabase(inner);
    const database = new SqliteGitDatabase(observed, { now: () => NOW });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const cursor = `refs/heads/${"c".repeat(4_086)}`;
    expect(utf8.encode(cursor)).toHaveLength(4_097);
    inner.run(
      `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
       VALUES (?, 0, 2)`,
      checkout.repoId,
    );
    inner.run(
      `INSERT INTO git_maintenance_runs
         (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source, cursor_text)
       VALUES (?, 1, 0, 'roots', ?, 'refs', ?)`,
      checkout.repoId,
      NOW,
      cursor,
    );
    const shared = database.openShared(checkout.repoId);
    const cursorBytes = utf8.encode(cursor).byteLength;
    const cursorMemoryBytes = 256 + 3 * cursorBytes;
    const emptyPageMemoryBytes = 2_048 + 2 * (256 + cursorBytes);
    const exactExternalBytes =
      MAX_OPERATION_MEMORY_BYTES - cursorMemoryBytes - emptyPageMemoryBytes - 4_096;

    const exactBlocker = shared.reserveMemory();
    exactBlocker.set("other", exactExternalBytes);
    const exactOwner = shared.reserveMemory();
    observed.cursorPayloadReads = 0;
    try {
      expect(
        advanceMaintenanceRootSnapshotOwned(
          database,
          checkout.repoId,
          { nowMs: NOW, pageRows: 1 },
          exactOwner,
        ),
      ).toMatchObject({ rootSource: "heads", complete: false });
      expect(observed.cursorPayloadReads).toBe(1);
      expect(exactOwner.highWaterBytes + exactBlocker.currentBytes).toBe(
        MAX_OPERATION_MEMORY_BYTES,
      );
    } finally {
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    inner.run(
      `UPDATE git_maintenance_runs
          SET root_source = 'refs', cursor_text = ?
        WHERE repo_id = ?`,
      cursor,
      checkout.repoId,
    );
    const restored = inner.one(
      "SELECT * FROM git_maintenance_runs WHERE repo_id = ?",
      checkout.repoId,
    );

    const overBlocker = shared.reserveMemory();
    overBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - cursorMemoryBytes + 1);
    const overOwner = shared.reserveMemory();
    observed.cursorPayloadReads = 0;
    try {
      expect(() =>
        advanceMaintenanceRootSnapshotOwned(
          database,
          checkout.repoId,
          { nowMs: NOW, pageRows: 1 },
          overOwner,
        ),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(observed.cursorPayloadReads).toBe(0);
      expect(
        inner.one("SELECT * FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId),
      ).toEqual(restored);
    } finally {
      overOwner.dispose();
      overBlocker.dispose();
    }
    shared.memory.assertIdle();
  });

  it("admits stored root pages before reading their payloads", () => {
    const sources: readonly (
      | "refs"
      | "heads"
      | "reflogs"
      | "index"
      | "index-baseline"
      | "shallow"
    )[] = ["refs", "heads", "reflogs", "index", "index-baseline", "shallow"];
    for (const source of sources) {
      const inner = new TestDatabase();
      const observed = new MaintenanceCursorDatabase(inner);
      const database = new SqliteGitDatabase(observed, { now: () => NOW });
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout);
      let textBytes: number;
      if (source === "refs") {
        store.setRef("refs/heads/topic", "ref: refs/heads/missing");
        textBytes =
          utf8.encode("refs/heads/topic").byteLength +
          utf8.encode("ref: refs/heads/missing").byteLength;
      } else if (source === "heads") {
        textBytes = utf8.encode(checkout.head).byteLength;
      } else if (source === "reflogs") {
        inner.run(
          `INSERT INTO git_reflog_entries
             (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
              actor_name, actor_email, timestamp, timezone, reason)
           VALUES (?, 'refs/heads/topic', 1, NULL, 'ref: refs/heads/missing', NULL, NULL,
                   NULL, NULL, ?, 0, 'maintenance boundary')`,
          checkout.repoId,
          Math.floor(NOW / 1_000),
        );
        textBytes =
          utf8.encode("refs/heads/topic").byteLength +
          utf8.encode("ref: refs/heads/missing").byteLength;
      } else if (source === "index") {
        const path = "index.txt";
        store.indexPut({
          path,
          stage: 0,
          mode: 0o160000,
          oid: "f".repeat(40),
          size: null,
          mtime: null,
          ino: null,
        });
        textBytes = utf8.encode(path).byteLength + 40;
      } else if (source === "index-baseline") {
        const tree = store.write("tree", EMPTY_TREE_BYTES);
        inner.run(
          `UPDATE git_index_state SET baseline_tree_oid = ?, format = 1, complete = 1
            WHERE checkout_id = ?`,
          tree,
          checkout.id,
        );
        textBytes = 40;
      } else {
        const commit = store.write("commit", commitBytes("shallow boundary"));
        store.setShallow([commit]);
        textBytes = 40;
      }
      installRootRun(inner, checkout.repoId, source);
      observed.refPayloadReads = 0;
      observed.headPayloadReads = 0;
      observed.reflogPayloadReads = 0;
      observed.indexPayloadReads = 0;
      observed.indexBaselinePayloadReads = 0;
      observed.shallowPayloadReads = 0;
      const shared = database.openShared(checkout.repoId);
      const pageBytes = 2_048 + 1_024 + 3 * textBytes + (source === "index" ? 512 : 0);
      const futureBytes = source === "reflogs" ? 7_168 : 5_888;
      const externalBytes = MAX_OPERATION_MEMORY_BYTES - pageBytes - futureBytes;

      const exactBlocker = shared.reserveMemory();
      exactBlocker.set("other", externalBytes);
      const exactOwner = shared.reserveMemory();
      try {
        expect(
          advanceMaintenanceRootSnapshotOwned(
            database,
            checkout.repoId,
            { nowMs: NOW, pageRows: 1 },
            exactOwner,
          ),
        ).toMatchObject({ complete: false });
        expect(rootPayloadReads(observed, source)).toBe(1);
        expect(exactOwner.highWaterBytes + exactBlocker.currentBytes).toBe(
          MAX_OPERATION_MEMORY_BYTES,
        );
      } finally {
        exactOwner.dispose();
        exactBlocker.dispose();
      }

      inner.run(
        `UPDATE git_maintenance_runs
            SET root_source = ?, cursor_checkout_id = NULL,
                cursor_text = NULL, cursor_ordinal = NULL
          WHERE repo_id = ?`,
        source,
        checkout.repoId,
      );
      const restored = inner.one(
        "SELECT * FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      );
      observed.refPayloadReads = 0;
      observed.headPayloadReads = 0;
      observed.reflogPayloadReads = 0;
      observed.indexPayloadReads = 0;
      observed.indexBaselinePayloadReads = 0;
      observed.shallowPayloadReads = 0;
      const overBlocker = shared.reserveMemory();
      overBlocker.set("other", externalBytes + 1);
      const overOwner = shared.reserveMemory();
      try {
        expect(() =>
          advanceMaintenanceRootSnapshotOwned(
            database,
            checkout.repoId,
            { nowMs: NOW, pageRows: 1 },
            overOwner,
          ),
        ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
        expect(rootPayloadReads(observed, source)).toBe(0);
        expect(
          inner.one("SELECT * FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId),
        ).toEqual(restored);
      } finally {
        overOwner.dispose();
        overBlocker.dispose();
      }
      shared.memory.assertIdle();
    }
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
         VALUES (1) UNION ALL SELECT ordinal + 1 FROM sequence WHERE ordinal < 8200
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
       VALUES (?, 'refs/heads/expired', 8201, ?, ?, ?, ?, NULL, NULL, ?, 0, 'expired'),
              (?, 'refs/heads/boundary', 8202, ?, ?, ?, ?, NULL, NULL, ?, 0, 'boundary')`,
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
    db.run("UPDATE git_reflog_state SET next_ordinal = 8202 WHERE repo_id = ?", checkout.repoId);

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
    const journal = store.requireOperationState("merge");
    store.replaceOperationState(
      journal.integrityOid,
      mergeOperationState({ ...ready, message: "Updated merge\n" }),
    );
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(8);
    expect(store.clearOperationState()).toBe(true);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBe(9);
    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO git_operation_steps
         (checkout_id, ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid)
       VALUES (?, 0, ?, NULL, NULL, 'pending', NULL)`,
      checkout.id,
      original,
    );
    db.run("PRAGMA foreign_keys = ON");
    const beforeOrphanClear = readMaintenanceRootEpoch(db, checkout.repoId);
    expect(store.clearOperationState()).toBe(true);
    expect(readMaintenanceRootEpoch(db, checkout.repoId)).toBeGreaterThan(beforeOrphanClear);

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

  it("rejects an active operation unless the full journal validates", () => {
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
      "UPDATE git_operation_state SET integrity_oid = ? WHERE checkout_id = ?",
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

  it("admits operation source and derived roots before their construction", () => {
    const inner = new TestDatabase();
    const observed = new MaintenanceCursorDatabase(inner);
    const database = new SqliteGitDatabase(observed, { now: () => NOW });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout);
    store.write("tree", EMPTY_TREE_BYTES);
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
    const journal = store.requireOperationState("merge");
    const derivedBytes = 512 + 3 * 192;
    const shared = database.openShared(checkout.repoId);

    const exactBlocker = shared.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - derivedBytes);
    const exactOwner = shared.reserveMemory();
    try {
      expect(validatedOperationJournalRoots(journal, exactOwner)).toEqual([
        { oid: original, expectedType: "commit" },
        { oid: original, expectedType: "commit" },
        { oid: incoming, expectedType: "commit" },
      ]);
      expect(exactOwner.currentBytes).toBe(derivedBytes);
      expect(shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    shared.memory.assertIdle();

    const overBlocker = shared.reserveMemory();
    overBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - derivedBytes + 1);
    const overOwner = shared.reserveMemory();
    try {
      expect(() => validatedOperationJournalRoots(journal, overOwner)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(overOwner.currentBytes).toBe(0);
    } finally {
      overOwner.dispose();
      overBlocker.dispose();
    }
    shared.memory.assertIdle();

    installRootRun(inner, checkout.repoId, "operations");
    const restored = inner.one(
      "SELECT * FROM git_maintenance_runs WHERE repo_id = ?",
      checkout.repoId,
    );
    const pageBlocker = shared.reserveMemory();
    pageBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - 512 + 1);
    const pageOwner = shared.reserveMemory();
    observed.operationCheckoutReads = 0;
    try {
      expect(() =>
        advanceMaintenanceRootSnapshotOwned(
          database,
          checkout.repoId,
          { nowMs: NOW, pageRows: 1 },
          pageOwner,
        ),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(observed.operationCheckoutReads).toBe(0);
      expect(
        inner.one("SELECT * FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId),
      ).toEqual(restored);
    } finally {
      pageOwner.dispose();
      pageBlocker.dispose();
    }
    shared.memory.assertIdle();
  });

  it.each([
    "refs/heads/bad..name",
    "refs/heads/bad.lock",
    "refs/heads/bad@{name",
    "refs/heads/bad name",
    "refs/heads/bad~name",
  ])("rejects invalid stored symbolic ref name %s", (name) => {
    const { db, database, checkout } = open();
    db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (?, 'refs/heads/source', ?)",
      checkout.repoId,
      `ref: ${name}`,
    );
    expect(() =>
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it.each([
    "refs/heads/bad..name",
    "refs/heads/bad.lock",
    "refs/heads/bad@{name",
    "refs/heads/bad name",
    "refs/heads/bad:name",
  ])("rejects invalid stored symbolic HEAD name %s", (name) => {
    const { db, database, checkout } = open();
    db.run("UPDATE git_checkouts SET head = ? WHERE id = ?", `ref: ${name}`, checkout.id);
    database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 });
    expect(() =>
      database.advanceMaintenanceRootSnapshot(checkout.repoId, { nowMs: NOW, pageRows: 1 }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
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
              queued_objects = 5, repacked_objects = 3
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
});
