import { describe, expect, expectTypeOf, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { createGit, type GitMaintenanceResult } from "../src/git/client.js";
import { Workspace } from "../src/runtime/workspace.js";
import { GC_GRACE_MS } from "../src/sqlite/maintenance/sweep.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Maintenance Fixture", email: "maintenance@example.com" };
const RESULT_KEYS = [
  "status",
  "phase",
  "runId",
  "restarted",
  "reachableObjects",
  "queuedObjects",
  "repackedObjects",
  "reclaimedObjects",
  "reclaimedPacks",
  "reclaimedBytes",
  "nextEligibleAt",
];

class CountingClock {
  calls = 0;

  constructor(public value: number) {}

  readonly now = (): number => {
    this.calls++;
    return this.value;
  };
}

function runtime(
  storage: SqliteTestStorage,
  clock: CountingClock,
  yieldNow?: () => Promise<void>,
): Workspace {
  if (yieldNow === undefined) {
    return new Workspace({
      storage,
      git: createGit(),
      now: clock.now,
      defaultGitIdentity: IDENTITY,
    });
  }
  return new Workspace({
    storage,
    git: createGit(),
    now: clock.now,
    defaultGitIdentity: IDENTITY,
    yieldNow,
  });
}

function inspect(storage: SqliteTestStorage): TestDatabase {
  return new TestDatabase(storage);
}

async function call(
  storage: SqliteTestStorage,
  clock: CountingClock,
  dir = "/repo",
): Promise<GitMaintenanceResult> {
  const reopened = runtime(storage, clock);
  storage.resetCounters();
  clock.calls = 0;
  const result = await reopened.git.maintenance({ dir });
  expect(clock.calls).toBe(1);
  expect(storage.statementCount).toBeLessThan(1_000);
  expect(Object.keys(result)).toEqual(RESULT_KEYS);
  expect(inspect(storage).scalar<string>("SELECT phase FROM git_maintenance_runs")).toBe(
    result.phase,
  );
  if (result.status === "progress") expect(result.nextEligibleAt).toBeNull();
  return result;
}

async function createCommittedRepository(
  storage: SqliteTestStorage,
  clock: CountingClock,
): Promise<string> {
  const opened = runtime(storage, clock);
  await opened.git.init({ dir: "/repo" });
  opened.filesystem.writeFiles([{ path: "/repo/file.txt", bytes: utf8.encode("reachable\n") }]);
  await opened.git.add({ dir: "/repo", paths: ["file.txt"] });
  return (await opened.git.commit({ dir: "/repo", message: "reachable" })).oid;
}

async function advanceToRepack(
  storage: SqliteTestStorage,
  clock: CountingClock,
): Promise<GitMaintenanceResult> {
  for (let calls = 0; calls < 100; calls++) {
    const result = await call(storage, clock);
    if (result.phase === "repack") return result;
  }
  throw new Error("maintenance did not reach repack");
}

function mutateRoot(storage: SqliteTestStorage, oid: string): void {
  const database = new SqliteGitDatabase(inspect(storage));
  const checkout = database.findCheckout("/repo");
  if (checkout === null) throw new Error("maintenance checkout is missing");
  database.openCheckout(checkout).setRef("refs/tags/drift", oid);
}

describe("public maintenance lifecycle", () => {
  it("exposes finish only as a complete result", () => {
    expectTypeOf<
      Extract<GitMaintenanceResult, { status: "progress"; phase: "finish" }>
    >().toEqualTypeOf<never>();
    expectTypeOf<Extract<GitMaintenanceResult, { phase: "finish" }>>().toEqualTypeOf<
      Extract<GitMaintenanceResult, { status: "complete" }>
    >();
  });

  it("completes through cold Workspace/Git calls and shares one run across linked checkouts", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(1_800_000_000_000);
    const commitOid = await createCommittedRepository(storage, clock);
    const opened = runtime(storage, clock);
    await opened.git.worktreeAdd({
      dir: "/repo",
      root: "/linked",
      target: { kind: "new-branch", name: "linked" },
    });

    const first = await call(storage, clock, "/repo");
    const second = await call(storage, clock, "/linked");
    expect(second.runId).toBe(first.runId);
    const phases = new Set<string>([first.phase, second.phase]);
    let complete: GitMaintenanceResult | null = null;
    for (let calls = 2; calls < 100; calls++) {
      const result = await call(storage, clock, calls % 2 === 0 ? "/repo" : "/linked");
      phases.add(result.phase);
      if (result.status === "complete") {
        complete = result;
        break;
      }
    }
    if (complete === null) throw new Error("maintenance did not finish");

    for (const phase of [
      "roots",
      "mark",
      "classify-loose",
      "repack",
      "classify-packs",
      "sweep-loose",
      "sweep-packs",
      "finish",
    ]) {
      expect(phases.has(phase)).toBe(true);
    }
    expect(complete.runId).toBe(first.runId);
    expect(complete.repackedObjects).toBeGreaterThan(0);
    expect(complete.queuedObjects).toBe(0);
    expect(complete.nextEligibleAt).toBeNull();
    await expect(
      runtime(storage, clock).git.catFile({ dir: "/linked", oid: commitOid }),
    ).resolves.toMatchObject({
      oid: commitOid,
    });

    const rollover = await call(storage, clock, "/linked");
    expect(rollover).toMatchObject({
      status: "progress",
      phase: "roots",
      runId: complete.runId + 1,
      restarted: false,
      reachableObjects: 0,
      queuedObjects: 0,
      repackedObjects: 0,
      reclaimedObjects: 0,
      reclaimedPacks: 0,
      reclaimedBytes: 0,
      nextEligibleAt: null,
    });
    expect(
      inspect(storage).one<{
        root_source: string;
        cursor_checkout_id: number | null;
        cursor_text: string | null;
        cursor_ordinal: number | null;
      }>(
        `SELECT root_source, cursor_checkout_id, cursor_text, cursor_ordinal
           FROM git_maintenance_runs`,
      ),
    ).toEqual({
      root_source: "refs",
      cursor_checkout_id: null,
      cursor_text: null,
      cursor_ordinal: null,
    });
  });

  it("gates a future eligibility time and rolls exactly at its boundary", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(100);
    const opened = runtime(storage, clock);
    await opened.git.init({ dir: "/repo" });
    await opened.git.hashObject({ dir: "/repo", content: "unreachable", write: true });

    let complete: GitMaintenanceResult | null = null;
    for (let calls = 0; calls < 100; calls++) {
      const result = await call(storage, clock);
      if (result.status === "complete") {
        complete = result;
        break;
      }
    }
    if (complete === null || complete.nextEligibleAt === null) {
      throw new Error("maintenance did not publish future eligibility");
    }
    expect(complete.nextEligibleAt).toBe(100 + GC_GRACE_MS);
    const runId = complete.runId;
    const db = inspect(storage);
    expect(db.scalar<number>("SELECT count(*) FROM git_loose_gc_candidates")).toBe(1);

    clock.value = complete.nextEligibleAt - 1;
    expect(await call(storage, clock)).toEqual(complete);
    expect(db.scalar<number>("SELECT run_id FROM git_maintenance_runs")).toBe(runId);

    clock.value = complete.nextEligibleAt;
    expect(await call(storage, clock)).toMatchObject({
      status: "progress",
      phase: "roots",
      runId: runId + 1,
      reachableObjects: 0,
      queuedObjects: 0,
      repackedObjects: 0,
      reclaimedObjects: 0,
      reclaimedPacks: 0,
      reclaimedBytes: 0,
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_loose_gc_candidates")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_objects")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_shallow")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
  });

  it("rolls a future finished run immediately after root drift", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(500);
    const commitOid = await createCommittedRepository(storage, clock);
    await runtime(storage, clock).git.hashObject({
      dir: "/repo",
      content: "unreachable",
      write: true,
    });

    let complete: GitMaintenanceResult | null = null;
    for (let calls = 0; calls < 100; calls++) {
      const result = await call(storage, clock);
      if (result.status === "complete") {
        complete = result;
        break;
      }
    }
    if (complete === null || complete.nextEligibleAt === null) {
      throw new Error("maintenance did not publish future eligibility");
    }
    const db = inspect(storage);
    expect(db.scalar<number>("SELECT count(*) FROM git_loose_gc_candidates")).toBe(1);
    mutateRoot(storage, commitOid);
    clock.value = complete.nextEligibleAt - 1;

    expect(await call(storage, clock)).toMatchObject({
      status: "progress",
      phase: "roots",
      runId: complete.runId + 1,
      restarted: false,
      reachableObjects: 0,
      queuedObjects: 0,
      repackedObjects: 0,
      reclaimedObjects: 0,
      reclaimedPacks: 0,
      reclaimedBytes: 0,
      nextEligibleAt: null,
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_loose_gc_candidates")).toBe(1);
    expect(
      db.one<{
        root_source: string;
        cursor_checkout_id: number | null;
        cursor_text: string | null;
        cursor_ordinal: number | null;
      }>(
        `SELECT root_source, cursor_checkout_id, cursor_text, cursor_ordinal
           FROM git_maintenance_runs`,
      ),
    ).toEqual({
      root_source: "refs",
      cursor_checkout_id: null,
      cursor_text: null,
      cursor_ordinal: null,
    });
  });

  it("uses only the public clock override and rejects an invalid sample without mutation", async () => {
    const storage = new SqliteTestStorage();
    const setupClock = new CountingClock(1);
    await runtime(storage, setupClock).git.init({ dir: "/repo" });
    const bindingClock = new CountingClock(2);
    const invalidClock = new CountingClock(-1);
    const opened = new Workspace({
      storage,
      git: createGit({ now: invalidClock.now }),
      now: bindingClock.now,
      defaultGitIdentity: IDENTITY,
    });
    storage.resetCounters();
    bindingClock.calls = 0;
    invalidClock.calls = 0;

    await expect(opened.git.maintenance({ dir: "/repo" })).rejects.toMatchObject({
      code: "EINVAL",
    });
    expect(invalidClock.calls).toBe(1);
    expect(bindingClock.calls).toBe(0);
    expect(storage.statementCount).toBeLessThan(1_000);
    expect(inspect(storage).scalar<number>("SELECT count(*) FROM git_maintenance_control")).toBe(0);
    expect(inspect(storage).scalar<number>("SELECT count(*) FROM git_maintenance_runs")).toBe(0);
  });

  it.each(["roots", "mark"])(
    "routes %s drift through root restart and advances its first page",
    async (phase) => {
      const storage = new SqliteTestStorage();
      const clock = new CountingClock(5);
      const commitOid = await createCommittedRepository(storage, clock);
      let before = await call(storage, clock);
      for (let calls = 1; before.phase !== phase && calls < 30; calls++) {
        before = await call(storage, clock);
      }
      expect(before.phase).toBe(phase);
      mutateRoot(storage, commitOid);

      const restarted = await call(storage, clock);
      expect(restarted).toMatchObject({
        status: "progress",
        phase: "roots",
        runId: before.runId,
        restarted: true,
      });
      expect(inspect(storage).scalar<string>("SELECT root_source FROM git_maintenance_runs")).toBe(
        "heads",
      );
    },
  );

  it.each(["selected", "pending", "published"])(
    "settles a %s repack batch before a same-run root reset",
    async (boundary) => {
      const storage = new SqliteTestStorage();
      const clock = new CountingClock(10);
      const commitOid = await createCommittedRepository(storage, clock);
      const repack = await advanceToRepack(storage, clock);
      expect(await call(storage, clock)).toMatchObject({ phase: "repack" });

      if (boundary === "pending") {
        const crashing = runtime(storage, clock, () => Promise.reject(new Error("pending crash")));
        storage.resetCounters();
        clock.calls = 0;
        await expect(crashing.git.maintenance({ dir: "/repo" })).rejects.toThrow(/pending crash/);
        expect(clock.calls).toBe(1);
        expect(storage.statementCount).toBeLessThan(1_000);
      } else if (boundary === "published") {
        expect(await call(storage, clock)).toMatchObject({ phase: "repack" });
      }
      const db = inspect(storage);
      expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(boundary);
      const packId = db.scalar<number>("SELECT pack_id FROM git_maintenance_repack_batches");
      db.run(
        `UPDATE git_maintenance_runs
            SET repacked_objects = 7, reclaimed_objects = 3,
                reclaimed_packs = 2, reclaimed_bytes = 99`,
      );
      db.run(
        `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
         SELECT repo_id, ?, 1 FROM git_objects WHERE oid = ?`,
        commitOid,
        commitOid,
      );
      mutateRoot(storage, commitOid);

      const reset = await call(storage, clock);
      expect(reset).toMatchObject({
        status: "progress",
        phase: "roots",
        runId: repack.runId,
        restarted: true,
        reachableObjects: 0,
        queuedObjects: 0,
        repackedObjects: 7,
        reclaimedObjects: 3,
        reclaimedPacks: 2,
        reclaimedBytes: 99,
      });
      expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
      expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_objects")).toBe(0);
      expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_shallow")).toBe(0);
      expect(db.scalar<number>("SELECT count(*) FROM git_loose_gc_candidates")).toBe(1);
      expect(
        db.one<{
          root_source: string;
          cursor_checkout_id: number | null;
          cursor_text: string | null;
          cursor_ordinal: number | null;
        }>(
          `SELECT root_source, cursor_checkout_id, cursor_text, cursor_ordinal
             FROM git_maintenance_runs`,
        ),
      ).toEqual({
        root_source: "refs",
        cursor_checkout_id: null,
        cursor_text: null,
        cursor_ordinal: null,
      });
      if (boundary === "pending") {
        expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
      } else if (boundary === "published") {
        expect(db.scalar<string>("SELECT state FROM git_pack_meta WHERE pack_id = ?", packId)).toBe(
          "complete",
        );
      } else {
        expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
      }
      await expect(
        runtime(storage, clock).git.catFile({ dir: "/repo", oid: commitOid }),
      ).resolves.toMatchObject({
        oid: commitOid,
      });
    },
  );

  it("fails closed when common run metadata violates a phase invariant", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(1);
    await runtime(storage, clock).git.init({ dir: "/repo" });
    await call(storage, clock);
    const db = inspect(storage);
    db.run("UPDATE git_maintenance_runs SET root_source = 'done'");
    const before = db.one<Record<string, unknown>>("SELECT * FROM git_maintenance_runs");

    await expect(runtime(storage, clock).git.maintenance({ dir: "/repo" })).rejects.toMatchObject({
      code: "ECORRUPT",
    });
    expect(db.one("SELECT * FROM git_maintenance_runs")).toEqual(before);
  });

  it("rejects an advanced allocator without a run and does not mutate it", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(1);
    await runtime(storage, clock).git.init({ dir: "/repo" });
    const db = inspect(storage);
    const repoId = db.scalar<number>("SELECT id FROM git_repositories");
    if (repoId === undefined) throw new Error("maintenance repository is missing");
    db.run(
      "INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id) VALUES (?, 0, 2)",
      repoId,
    );
    const before = db.one<Record<string, unknown>>("SELECT * FROM git_maintenance_control");

    await expect(runtime(storage, clock).git.maintenance({ dir: "/repo" })).rejects.toMatchObject({
      code: "ECORRUPT",
    });
    expect(db.one("SELECT * FROM git_maintenance_control")).toEqual(before);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_runs")).toBe(0);
  });

  it("rejects an allocator that skipped past the active run and does not mutate it", async () => {
    const storage = new SqliteTestStorage();
    const clock = new CountingClock(1);
    await runtime(storage, clock).git.init({ dir: "/repo" });
    const run = await call(storage, clock);
    const db = inspect(storage);
    db.run("UPDATE git_maintenance_control SET next_run_id = ?", run.runId + 2);
    const beforeControl = db.one<Record<string, unknown>>("SELECT * FROM git_maintenance_control");
    const beforeRun = db.one<Record<string, unknown>>("SELECT * FROM git_maintenance_runs");

    await expect(runtime(storage, clock).git.maintenance({ dir: "/repo" })).rejects.toMatchObject({
      code: "ECORRUPT",
    });
    expect(db.one("SELECT * FROM git_maintenance_control")).toEqual(beforeControl);
    expect(db.one("SELECT * FROM git_maintenance_runs")).toEqual(beforeRun);
  });

  it.each(["reachable_objects", "queued_objects"])(
    "rejects a roots run with a nonzero %s counter and does not mutate it",
    async (column) => {
      const storage = new SqliteTestStorage();
      const clock = new CountingClock(1);
      await runtime(storage, clock).git.init({ dir: "/repo" });
      const run = await call(storage, clock);
      expect(run.phase).toBe("roots");
      const db = inspect(storage);
      db.run(`UPDATE git_maintenance_runs SET ${column} = 1`);
      const before = db.one<Record<string, unknown>>("SELECT * FROM git_maintenance_runs");

      await expect(runtime(storage, clock).git.maintenance({ dir: "/repo" })).rejects.toMatchObject(
        { code: "ECORRUPT" },
      );
      expect(db.one("SELECT * FROM git_maintenance_runs")).toEqual(before);
    },
  );
});
