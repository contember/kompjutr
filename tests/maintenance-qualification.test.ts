import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { type ObjectType, serializeCommit } from "../src/core/objects.js";
import type { MergeStateMetadata, MergeTouchedPath } from "../src/core/ops/merge-state.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { fetchHttpClient } from "../src/core/protocol/transport.js";
import { createGit, type GitMaintenanceResult } from "../src/git/client.js";
import { Workspace } from "../src/runtime/workspace.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { advanceMaintenanceRepack } from "../src/sqlite/maintenance/repack.js";
import { advanceMaintenanceSweep, GC_GRACE_MS } from "../src/sqlite/maintenance/sweep.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Qualification Fixture", email: "qualification@example.com" };
const PERSON = {
  name: IDENTITY.name,
  email: IDENTITY.email,
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

class CountingClock {
  calls = 0;

  constructor(public value: number) {}

  readonly now = (): number => {
    this.calls++;
    return this.value;
  };
}

class AvailabilityFailureDatabase implements SqlDatabase {
  corruptAvailability = false;

  constructor(readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  *iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    for (const row of this.inner.iterate(query, ...bindings)) {
      if (this.corruptAvailability && query.includes("loose-storage-availability")) {
        yield { ...row, has_loose: 2 };
      } else {
        yield row;
      }
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function workspace(
  storage: SqliteTestStorage,
  clock: CountingClock,
  yieldNow?: () => Promise<void>,
): Workspace {
  return new Workspace({
    storage,
    git: createGit(),
    now: clock.now,
    defaultGitIdentity: IDENTITY,
    http: fetchHttpClient,
    ...(yieldNow === undefined ? {} : { yieldNow }),
  });
}

function inspect(storage: SqliteTestStorage): TestDatabase {
  return new TestDatabase(storage);
}

async function maintenance(
  storage: SqliteTestStorage,
  clock: CountingClock,
): Promise<GitMaintenanceResult> {
  const reopened = workspace(storage, clock);
  storage.resetCounters();
  clock.calls = 0;
  try {
    return await reopened.git.maintenance({ dir: "/repo" });
  } finally {
    expect(clock.calls).toBe(1);
    expect(storage.statementCount).toBeLessThan(1_000);
  }
}

async function rejectedMaintenance(
  storage: SqliteTestStorage,
  clock: CountingClock,
  message: RegExp,
): Promise<void> {
  const reopened = workspace(storage, clock);
  storage.resetCounters();
  clock.calls = 0;
  await expect(reopened.git.maintenance({ dir: "/repo" })).rejects.toThrow(message);
  expect(clock.calls).toBe(1);
  expect(storage.statementCount).toBeLessThan(1_000);
}

async function committedRepository(
  storage: SqliteTestStorage,
  clock: CountingClock,
): Promise<string> {
  const opened = workspace(storage, clock);
  await opened.git.init({ dir: "/repo" });
  opened.filesystem.writeFiles([{ path: "/repo/file.txt", bytes: utf8.encode("committed\n") }]);
  await opened.git.add({ dir: "/repo", paths: ["file.txt"] });
  return (await opened.git.commit({ dir: "/repo", message: "qualification" })).oid;
}

async function reachPhase(
  storage: SqliteTestStorage,
  clock: CountingClock,
  phase: GitMaintenanceResult["phase"],
): Promise<GitMaintenanceResult> {
  for (let calls = 0; calls < 200; calls++) {
    const result = await maintenance(storage, clock);
    if (result.phase === phase) return result;
  }
  throw new Error(`maintenance did not reach ${phase}`);
}

async function finish(
  storage: SqliteTestStorage,
  clock: CountingClock,
): Promise<Extract<GitMaintenanceResult, { status: "complete" }>> {
  for (let calls = 0; calls < 300; calls++) {
    const result = await maintenance(storage, clock);
    if (result.status === "complete") return result;
  }
  throw new Error("maintenance did not finish");
}

function runRows(db: TestDatabase): Record<string, unknown>[] {
  return db.all<Record<string, unknown>>("SELECT * FROM git_maintenance_runs ORDER BY repo_id");
}

function markRows(db: TestDatabase): Record<string, unknown>[] {
  return db.all<Record<string, unknown>>(
    "SELECT * FROM git_maintenance_objects ORDER BY repo_id, run_id, oid COLLATE BINARY",
  );
}

function fullPack(objects: readonly { type: ObjectType; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(objects.length);
  for (const object of objects) writer.object(object.type, object.data);
  writer.finish();
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const pack = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    pack.set(chunk, offset);
    offset += chunk.length;
  }
  return pack;
}

function seedRepack(db: SqlDatabase, repoId: number, oids: readonly string[]): void {
  db.run(
    `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 2)`,
    repoId,
  );
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
        reachable_objects, queued_objects)
     VALUES (?, 1, 0, 'repack', 1, 'done', ?, 0)`,
    repoId,
    oids.length,
  );
  db.run(
    `INSERT INTO git_maintenance_objects
       (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
        physical_only, edge_cursor)
     SELECT ?, 1, value, 1, 1, 0, 0, 0 FROM json_each(?)`,
    repoId,
    JSON.stringify(oids),
  );
}

function seedSweepLoose(
  db: SqlDatabase,
  repoId: number,
  survivorOid: string,
  doomedOid: string,
): void {
  db.run(
    `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 2)`,
    repoId,
  );
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
        reachable_objects, queued_objects)
     VALUES (?, 1, 0, 'sweep-loose', 0, 'done', 1, 0)`,
    repoId,
  );
  db.run(
    `INSERT INTO git_maintenance_objects
       (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
        physical_only, edge_cursor)
     VALUES (?, 1, ?, 1, 1, 0, 0, 0)`,
    repoId,
    survivorOid,
  );
  db.run(
    `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
     VALUES (?, ?, 0)`,
    repoId,
    doomedOid,
  );
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

describe("maintenance crash and restart qualification", () => {
  it("rolls initial allocation back and resumes one response-lost allocation cold", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(10);
    await workspace(storage, clock).git.init({ dir: "/repo" });
    const db = inspect(storage);
    db.run(
      `CREATE TEMP TRIGGER qualification_initial_run_fault
       BEFORE INSERT ON git_maintenance_runs
       BEGIN SELECT RAISE(ABORT, 'qualification initial run fault'); END`,
    );

    await rejectedMaintenance(storage, clock, /qualification initial run fault/);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_control")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_runs")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_objects")).toBe(0);

    db.run("DROP TRIGGER qualification_initial_run_fault");
    const lost = await maintenance(storage, clock);
    const retried = await maintenance(storage, clock);
    expect(retried.runId).toBe(lost.runId);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_control")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_runs")).toBe(1);
  });

  it("rolls root pages, roots-to-mark, and mark counter CAS back before cold retries", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(20);
    const commitOid = await committedRepository(storage, clock);
    const db = inspect(storage);
    const database = new SqliteGitDatabase(db, { now: clock.now });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("qualification checkout is missing");
    const store = database.openCheckout(checkout);
    const commit = store.cachedCommit(commitOid);
    if (commit === null) throw new Error("qualification commit cache is missing");
    const detachedOid = store.write(
      "commit",
      serializeCommit({
        tree: commit.commit.tree,
        parent: [],
        author: PERSON,
        committer: PERSON,
        message: "detached root\n",
      }),
    );
    store.setHead(detachedOid);
    expect(await maintenance(storage, clock)).toMatchObject({ phase: "roots" });
    expect(db.scalar<string>("SELECT root_source FROM git_maintenance_runs")).toBe("heads");
    expect(
      db.scalar<number>(
        "SELECT source_mask FROM git_maintenance_objects WHERE oid = ?",
        detachedOid,
      ),
    ).toBeUndefined();

    db.run(
      `CREATE TEMP TRIGGER qualification_root_cursor_fault
       BEFORE UPDATE ON git_maintenance_runs
       WHEN OLD.phase = 'roots' AND NEW.phase = 'roots'
       BEGIN SELECT RAISE(ABORT, 'qualification root cursor fault'); END`,
    );
    const beforeRootRun = runRows(db);
    const beforeRootMarks = markRows(db);
    await rejectedMaintenance(storage, clock, /qualification root cursor fault/);
    expect(runRows(db)).toEqual(beforeRootRun);
    expect(markRows(db)).toEqual(beforeRootMarks);
    expect(
      db.scalar<number>(
        "SELECT source_mask FROM git_maintenance_objects WHERE oid = ?",
        detachedOid,
      ),
    ).toBeUndefined();
    db.run("DROP TRIGGER qualification_root_cursor_fault");
    await maintenance(storage, clock);
    expect(
      db.scalar<number>(
        "SELECT source_mask & 2 FROM git_maintenance_objects WHERE oid = ?",
        detachedOid,
      ),
    ).toBe(2);

    db.run(
      `CREATE TEMP TRIGGER qualification_roots_mark_fault
       BEFORE UPDATE OF phase ON git_maintenance_runs
       WHEN OLD.phase = 'roots' AND NEW.phase = 'mark'
       BEGIN SELECT RAISE(ABORT, 'qualification roots mark fault'); END`,
    );
    let transitionFaulted = false;
    for (let calls = 0; calls < 30 && !transitionFaulted; calls++) {
      const beforeRun = runRows(db);
      const beforeMarks = markRows(db);
      try {
        await maintenance(storage, clock);
      } catch (error) {
        if (!(error instanceof Error) || !/qualification roots mark fault/.test(error.message)) {
          throw error;
        }
        transitionFaulted = true;
        expect(runRows(db)).toEqual(beforeRun);
        expect(markRows(db)).toEqual(beforeMarks);
      }
    }
    expect(transitionFaulted).toBe(true);
    db.run("DROP TRIGGER qualification_roots_mark_fault");
    expect(await maintenance(storage, clock)).toMatchObject({ phase: "mark" });

    db.run(
      `CREATE TEMP TRIGGER qualification_mark_counter_fault
       BEFORE UPDATE OF reachable_objects, queued_objects ON git_maintenance_runs
       WHEN OLD.phase = 'mark'
       BEGIN SELECT RAISE(ABORT, 'qualification mark counter fault'); END`,
    );
    const beforeMarkRun = runRows(db);
    const beforeMarkRows = markRows(db);
    await rejectedMaintenance(storage, clock, /qualification mark counter fault/);
    expect(runRows(db)).toEqual(beforeMarkRun);
    expect(markRows(db)).toEqual(beforeMarkRows);
    db.run("DROP TRIGGER qualification_mark_counter_fault");
    expect((await maintenance(storage, clock)).phase).toBe("mark");
    expect(markRows(db)).not.toEqual(beforeMarkRows);
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: commitOid }),
    ).resolves.toMatchObject({ oid: commitOid });
  });

  it("rolls a partially inserted repack selection back and retries it cold", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(30);
    const commitOid = await committedRepository(storage, clock);
    await reachPhase(storage, clock, "repack");
    const db = inspect(storage);
    const beforeRun = runRows(db);
    const looseCount = db.scalar<number>("SELECT count(*) FROM git_objects");
    db.run(
      `CREATE TEMP TRIGGER qualification_repack_selection_fault
       AFTER INSERT ON git_maintenance_repack_objects
       WHEN NEW.ordinal = 0
       BEGIN SELECT RAISE(ABORT, 'qualification repack selection fault'); END`,
    );

    await rejectedMaintenance(storage, clock, /qualification repack selection fault/);
    expect(runRows(db)).toEqual(beforeRun);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_objects")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_objects")).toBe(looseCount);
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: commitOid }),
    ).resolves.toMatchObject({ oid: commitOid });

    db.run("DROP TRIGGER qualification_repack_selection_fault");
    expect(await maintenance(storage, clock)).toMatchObject({ phase: "repack" });
    expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe("selected");
  });

  it("recovers an owned pending pack after data and index checkpoints", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout);
    const oids: string[] = [];
    store.writeObjects(
      (batch) => {
        for (let index = 0; index < 1_024; index++) {
          oids.push(batch.write("blob", utf8.encode(`checkpoint-${index}\n`)));
        }
      },
      { flushEvery: 1_024 },
    );
    seedRepack(db, checkout.repoId, oids);
    expect(await advanceMaintenanceRepack(store.shared, { nowMs: 1 })).toMatchObject({
      boundary: "selected",
      objectCount: 1_024,
    });
    let checkpointSeen = false;

    await expect(
      advanceMaintenanceRepack(store.shared, {
        nowMs: 1,
        yieldNow: async () => {
          const row = db.one<{ data_rows: number; object_rows: number }>(
            `SELECT (SELECT count(*) FROM git_pack_data) AS data_rows,
                    (SELECT count(*) FROM git_pack_objects) AS object_rows`,
          );
          if (row?.data_rows !== undefined && row.data_rows > 0 && row.object_rows === 1_024) {
            checkpointSeen = true;
            throw new Error("qualification indexed pending fault");
          }
        },
      }),
    ).rejects.toThrow(/qualification indexed pending fault/);
    expect(checkpointSeen).toBe(true);
    expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe("pending");
    expect(db.scalar<string>("SELECT state FROM git_pack_meta")).toBe("pending");
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_data")).toBeGreaterThan(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_objects")).toBe(1_024);
    expect(store.read(oids[0] ?? "")).not.toBeNull();

    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout.id);
    db.storage.resetCounters();
    expect(await advanceMaintenanceRepack(reopened.shared, { nowMs: 1 })).toMatchObject({
      boundary: "selected",
      packId: null,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_data")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_objects")).toBe(0);
    db.storage.resetCounters();
    expect(await advanceMaintenanceRepack(reopened.shared, { nowMs: 1 })).toMatchObject({
      boundary: "published",
      objectCount: 1_024,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    db.storage.resetCounters();
    expect(await advanceMaintenanceRepack(reopened.shared, { nowMs: 1 })).toMatchObject({
      boundary: "finalized",
      objectCount: 1_024,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(
      db.scalar<number>(
        "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1_024);
    expect(reopened.read(oids[0] ?? "")).not.toBeNull();
    expect(reopened.read(oids[1_023] ?? "")).not.toBeNull();
  });

  it("settles downstream pending drift once across response loss and a cold retry", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(40);
    const commitOid = await committedRepository(storage, clock);
    const repack = await reachPhase(storage, clock, "repack");
    await maintenance(storage, clock);
    const crashing = workspace(storage, clock, () => Promise.reject(new Error("pending drift")));
    storage.resetCounters();
    clock.calls = 0;
    await expect(crashing.git.maintenance({ dir: "/repo" })).rejects.toThrow(/pending drift/);
    expect(clock.calls).toBe(1);
    expect(storage.statementCount).toBeLessThan(1_000);
    const db = inspect(storage);
    expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe("pending");
    const database = new SqliteGitDatabase(db);
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("qualification checkout is missing");
    database.openCheckout(checkout).setRef("refs/tags/drift", commitOid);

    const lost = await maintenance(storage, clock);
    expect(lost).toMatchObject({ phase: "roots", runId: repack.runId, restarted: true });
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
    const retried = await maintenance(storage, clock);
    expect(retried).toMatchObject({ phase: "roots", runId: repack.runId, restarted: true });
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: commitOid }),
    ).resolves.toMatchObject({ oid: commitOid });
  });

  it("keeps committed sweep-loose deletion once-only after cache probe response loss", () => {
    const inner = new TestDatabase();
    const failing = new AvailabilityFailureDatabase(inner);
    const database = new SqliteGitDatabase(failing, { objectCacheBytes: 8 * 1024 * 1024 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout);
    const doomedData = utf8.encode("deleted sweep authority\n");
    const staleData = new Uint8Array(doomedData.length).fill(0x78);
    const survivorData = utf8.encode("unrelated sweep survivor\n");
    const doomedOid = store.write("blob", doomedData);
    const survivorOid = store.write("blob", survivorData);
    seedSweepLoose(failing, checkout.repoId, survivorOid, doomedOid);
    const doomedStoredBytes = inner.scalar<number>(
      "SELECT sum(length(data)) FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
      checkout.repoId,
      doomedOid,
    );
    if (doomedStoredBytes === undefined) throw new Error("doomed loose storage is missing");
    inner.run(
      "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ? AND seq = 0",
      staleData,
      checkout.repoId,
      doomedOid,
    );
    store.shared.clearCaches();
    store.shared.markLoose();
    expect(store.read(doomedOid)?.data).toEqual(staleData);
    expect(store.read(survivorOid)?.data).toEqual(survivorData);
    failing.corruptAvailability = true;

    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: GC_GRACE_MS })).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
        checkout.repoId,
        doomedOid,
      ),
    ).toBe(0);
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_loose_object_lifecycle WHERE repo_id = ? AND oid = ?",
        checkout.repoId,
        doomedOid,
      ),
    ).toBe(0);
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_loose_gc_candidates WHERE repo_id = ? AND oid = ?",
        checkout.repoId,
        doomedOid,
      ),
    ).toBe(0);
    expect(
      inner.one<{
        reclaimed_objects: number;
        reclaimed_packs: number;
        reclaimed_bytes: number;
      }>(
        `SELECT reclaimed_objects, reclaimed_packs, reclaimed_bytes
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({
      reclaimed_objects: 1,
      reclaimed_packs: 0,
      reclaimed_bytes: doomedStoredBytes,
    });
    expect(store.read(doomedOid)).toBeNull();
    expect(store.read(survivorOid)?.data).toEqual(survivorData);

    failing.corruptAvailability = false;
    const cold = new SqliteGitDatabase(failing, { objectCacheBytes: 0 }).openCheckout(checkout.id);
    let phase = "sweep-loose";
    for (let calls = 0; calls < 10 && phase !== "finish"; calls++) {
      phase = advanceMaintenanceSweep(cold.shared, { nowMs: GC_GRACE_MS }).phase;
      expect(
        inner.one<{ reclaimed_objects: number; reclaimed_packs: number; reclaimed_bytes: number }>(
          `SELECT reclaimed_objects, reclaimed_packs, reclaimed_bytes
             FROM git_maintenance_runs WHERE repo_id = ?`,
          checkout.repoId,
        ),
      ).toEqual({
        reclaimed_objects: 1,
        reclaimed_packs: 0,
        reclaimed_bytes: doomedStoredBytes,
      });
    }
    expect(phase).toBe("finish");
    expect(cold.read(doomedOid)).toBeNull();
    expect(cold.read(survivorOid)?.data).toEqual(survivorData);
  });

  it("rolls finished rollover back, then survives response loss without duplicate allocation", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(50);
    const opened = workspace(storage, clock);
    await opened.git.init({ dir: "/repo" });
    await opened.git.hashObject({ dir: "/repo", content: "candidate", write: true });
    const complete = await finish(storage, clock);
    if (complete.nextEligibleAt === null) throw new Error("qualification candidate has no grace");
    clock.value = complete.nextEligibleAt;
    const db = inspect(storage);
    const beforeControl = db.all<Record<string, unknown>>("SELECT * FROM git_maintenance_control");
    const beforeRun = runRows(db);
    const beforeCandidates = db.all<Record<string, unknown>>(
      "SELECT * FROM git_loose_gc_candidates ORDER BY oid COLLATE BINARY",
    );
    db.run(
      `CREATE TEMP TRIGGER qualification_rollover_fault
       BEFORE INSERT ON git_maintenance_runs
       WHEN NEW.run_id > 1
       BEGIN SELECT RAISE(ABORT, 'qualification rollover fault'); END`,
    );

    await rejectedMaintenance(storage, clock, /qualification rollover fault/);
    expect(db.all("SELECT * FROM git_maintenance_control")).toEqual(beforeControl);
    expect(runRows(db)).toEqual(beforeRun);
    expect(db.all("SELECT * FROM git_loose_gc_candidates ORDER BY oid COLLATE BINARY")).toEqual(
      beforeCandidates,
    );
    db.run("DROP TRIGGER qualification_rollover_fault");
    const lost = await maintenance(storage, clock);
    expect(lost).toMatchObject({ phase: "roots", runId: complete.runId + 1 });
    const retried = await maintenance(storage, clock);
    expect(retried.runId).toBe(lost.runId);
    expect(db.scalar<number>("SELECT next_run_id FROM git_maintenance_control")).toBe(
      lost.runId + 1,
    );
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_runs")).toBe(1);
    expect(db.all("SELECT * FROM git_loose_gc_candidates ORDER BY oid COLLATE BINARY")).toEqual(
      beforeCandidates,
    );
  });

  it("restarts a selected downstream batch after an index mutation and roots the new entry", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(60);
    await committedRepository(storage, clock);
    const repack = await reachPhase(storage, clock, "repack");
    await maintenance(storage, clock);
    const db = inspect(storage);
    expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe("selected");
    const opened = workspace(storage, clock);
    opened.filesystem.writeFiles([
      { path: "/repo/downstream-index.txt", bytes: utf8.encode("downstream index\n") },
    ]);
    await opened.git.add({ dir: "/repo", paths: ["downstream-index.txt"] });
    const database = new SqliteGitDatabase(db);
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("qualification checkout is missing");
    const store = database.openCheckout(checkout);
    const staged = store.indexGet("downstream-index.txt");
    if (staged === null) throw new Error("qualification downstream index root is missing");

    expect(await maintenance(storage, clock)).toMatchObject({
      phase: "roots",
      runId: repack.runId,
      restarted: true,
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    await reachPhase(storage, clock, "mark");
    expect(
      db.scalar<number>(
        "SELECT source_mask & 8 FROM git_maintenance_objects WHERE oid = ?",
        staged.oid,
      ),
    ).toBe(8);
    expect(new SqliteGitDatabase(db).openCheckout(checkout.id).read(staged.oid)).not.toBeNull();
  });

  it("restarts a selected downstream batch after a valid operation journal and resumes it cold", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(61);
    const commitOid = await committedRepository(storage, clock);
    const repack = await reachPhase(storage, clock, "repack");
    await maintenance(storage, clock);
    const db = inspect(storage);
    expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe("selected");
    const database = new SqliteGitDatabase(db, { now: clock.now });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("qualification checkout is missing");
    const store = database.openCheckout(checkout);
    const commit = store.cachedCommit(commitOid);
    if (commit === null) throw new Error("qualification commit cache is missing");
    const operationData = utf8.encode("downstream operation snapshot\n");
    const operationOid = store.write("blob", operationData);
    const incoming = store.write(
      "commit",
      serializeCommit({
        tree: commit.commit.tree,
        parent: [],
        author: PERSON,
        committer: PERSON,
        message: "incoming\n",
      }),
    );
    const touched: readonly MergeTouchedPath[] = [
      {
        path: "operation.txt",
        logicalPath: "operation.txt",
        purpose: "primary",
        index: {
          stage: 0,
          mode: 0o100644,
          oid: operationOid,
          size: operationData.length,
          mtime: null,
          ino: null,
          rev: null,
        },
        worktree: { kind: "absent" },
      },
    ];
    store.writeMergeState(mergeMetadata(commitOid, incoming), touched);

    expect(await maintenance(storage, clock)).toMatchObject({
      phase: "roots",
      runId: repack.runId,
      restarted: true,
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    await reachPhase(storage, clock, "mark");
    expect(
      db.scalar<number>(
        "SELECT source_mask & 64 FROM git_maintenance_objects WHERE oid = ?",
        operationOid,
      ),
    ).toBe(64);
    expect(
      db.scalar<number>(
        "SELECT source_mask & 64 FROM git_maintenance_objects WHERE oid = ?",
        incoming,
      ),
    ).toBe(64);
    const cold = new SqliteGitDatabase(db).openCheckout(checkout.id);
    expect(cold.requireOperationState("merge").state.incomingParentOid).toBe(incoming);
    expect(cold.read(operationOid)?.data).toEqual(operationData);
    expect(cold.read(incoming)).not.toBeNull();
  });

  it("restarts a selected downstream batch after a public commit and roots the new commit", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(62);
    await committedRepository(storage, clock);
    const repack = await reachPhase(storage, clock, "repack");
    await maintenance(storage, clock);
    const db = inspect(storage);
    expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe("selected");
    const opened = workspace(storage, clock);
    opened.filesystem.writeFiles([
      { path: "/repo/public-commit.txt", bytes: utf8.encode("public downstream commit\n") },
    ]);
    await opened.git.add({ dir: "/repo", paths: ["public-commit.txt"] });
    const committed = await opened.git.commit({ dir: "/repo", message: "downstream public" });

    expect(await maintenance(storage, clock)).toMatchObject({
      phase: "roots",
      runId: repack.runId,
      restarted: true,
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    await reachPhase(storage, clock, "mark");
    expect(
      db.scalar<number>(
        "SELECT source_mask & 1 FROM git_maintenance_objects WHERE oid = ?",
        committed.oid,
      ),
    ).toBe(1);
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: committed.oid }),
    ).resolves.toMatchObject({ oid: committed.oid });
  });

  it("preserves a concurrent pending fetch while public maintenance publishes its own pack", async () => {
    const fixture = new GitFixture().init();
    fixture.write("remote.txt", "remote\n");
    const remoteOid = fixture.commit("remote");
    const server = await startGitServer(fixture.dir);
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(70);
    let signalPaused = (): void => {};
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let releaseFetch = (): void => {};
    const released = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let waiting = false;

    try {
      const localOid = await committedRepository(storage, clock);
      await reachPhase(storage, clock, "repack");
      await maintenance(storage, clock);
      const db = inspect(storage);
      expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(
        "selected",
      );
      const setup = workspace(storage, clock);
      await setup.git.remoteAdd({ dir: "/repo", name: "origin", url: server.url });
      const fetching = workspace(storage, clock, async () => {
        if (waiting) return;
        waiting = true;
        signalPaused();
        await released;
      });
      const fetchPromise = fetching.git.fetch({ dir: "/repo", remote: "origin" });
      await paused;
      const pendingPackId = db.scalar<number>(
        "SELECT pack_id FROM git_pack_meta WHERE state = 'pending'",
      );
      if (pendingPackId === undefined) throw new Error("fetch did not reserve a pending pack");

      const progress = await maintenance(storage, clock);
      expect(progress).toMatchObject({ status: "progress", phase: "repack" });
      expect(
        db.one<{ pack_id: number; state: string }>(
          "SELECT pack_id, state FROM git_pack_meta WHERE pack_id = ?",
          pendingPackId,
        ),
      ).toEqual({ pack_id: pendingPackId, state: "pending" });
      const maintenancePack = db.one<{ state: string; pack_id: number; pack_state: string }>(
        `SELECT batch.state, batch.pack_id, pack.state AS pack_state
           FROM git_maintenance_repack_batches batch
           JOIN git_pack_meta pack
             ON pack.repo_id = batch.repo_id AND pack.pack_id = batch.pack_id`,
      );
      if (maintenancePack === undefined) {
        throw new Error("maintenance did not publish its owned pack");
      }
      expect(maintenancePack).toMatchObject({ state: "published", pack_state: "complete" });
      expect(maintenancePack.pack_id).not.toBe(pendingPackId);
      await expect(
        workspace(storage, clock).git.catFile({ dir: "/repo", oid: localOid }),
      ).resolves.toMatchObject({ oid: localOid });
      releaseFetch();
      await fetchPromise;
      expect(
        db.scalar<string>("SELECT state FROM git_pack_meta WHERE pack_id = ?", pendingPackId),
      ).toBe("complete");
      await expect(
        workspace(storage, clock).git.catFile({ dir: "/repo", oid: remoteOid }),
      ).resolves.toMatchObject({ oid: remoteOid });
      await expect(
        workspace(storage, clock).git.catFile({ dir: "/repo", oid: localOid }),
      ).resolves.toMatchObject({ oid: localOid });
    } finally {
      releaseFetch();
      await server.close();
      fixture.dispose();
    }
  });

  it("composes retained reflog reachability with the exact fourteen-day grace boundary", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(1_800_000_000_000);
    const reflogTime = clock.value;
    const opened = workspace(storage, clock);
    await opened.git.init({ dir: "/repo" });
    const db = inspect(storage);
    const database = new SqliteGitDatabase(db, { now: clock.now });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("qualification checkout is missing");
    const store = database.openCheckout(checkout);
    const oldData = utf8.encode("reflog retained\n");
    const currentData = utf8.encode("current root\n");
    const oldPack = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: oldData }]), 17),
    );
    const currentPack = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: currentData }]), 17),
    );
    const oldOid = db.scalar<string>(
      "SELECT oid FROM git_pack_objects WHERE pack_id = ?",
      oldPack.packId,
    );
    const currentOid = db.scalar<string>(
      "SELECT oid FROM git_pack_objects WHERE pack_id = ?",
      currentPack.packId,
    );
    if (oldOid === undefined || currentOid === undefined) {
      throw new Error("qualification pack fixture is empty");
    }
    await opened.git.updateRef({
      dir: "/repo",
      ref: "refs/heads/ephemeral",
      value: oldOid,
      force: true,
    });
    await opened.git.updateRef({
      dir: "/repo",
      ref: "refs/heads/ephemeral",
      value: currentOid,
      force: true,
    });

    const retained = await finish(storage, clock);
    expect(retained.nextEligibleAt).toBeNull();
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_gc_candidates")).toBe(0);
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: oldOid }),
    ).resolves.toMatchObject({ oid: oldOid });

    clock.value = reflogTime + 90 * 24 * 60 * 60 * 1_000;
    const cutoffStart = await maintenance(storage, clock);
    expect(cutoffStart).toMatchObject({ phase: "roots", runId: retained.runId + 1 });
    const cutoffRetained = await finish(storage, clock);
    expect(cutoffRetained.nextEligibleAt).toBeNull();
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_gc_candidates")).toBe(0);
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: oldOid }),
    ).resolves.toMatchObject({ oid: oldOid });

    clock.value += 1_000;
    const expiredStart = await maintenance(storage, clock);
    expect(expiredStart).toMatchObject({
      phase: "roots",
      runId: cutoffRetained.runId + 1,
    });
    const classified = await finish(storage, clock);
    const graceBoundary = classified.nextEligibleAt;
    if (graceBoundary === null) throw new Error("qualification pack has no grace boundary");
    expect(graceBoundary).toBe(clock.value + GC_GRACE_MS);
    expect(
      db.scalar<number>(
        "SELECT unreachable_since_ms FROM git_pack_gc_candidates WHERE pack_id = ?",
        oldPack.packId,
      ),
    ).toBe(clock.value);

    clock.value = graceBoundary - 1;
    expect(await maintenance(storage, clock)).toEqual(classified);
    expect(
      db.scalar<string>("SELECT state FROM git_pack_meta WHERE pack_id = ?", oldPack.packId),
    ).toBe("complete");
    clock.value = graceBoundary;
    await maintenance(storage, clock);
    const reclaimed = await finish(storage, clock);
    expect(reclaimed.reclaimedPacks).toBe(1);
    expect(reclaimed.reclaimedObjects).toBe(1);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", oldPack.packId),
    ).toBe(0);
    expect(
      db.scalar<string>("SELECT state FROM git_pack_meta WHERE pack_id = ?", currentPack.packId),
    ).toBe("complete");
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: oldOid }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(
      workspace(storage, clock).git.catFile({ dir: "/repo", oid: currentOid }),
    ).resolves.toMatchObject({ oid: currentOid });
  });
});
