import { describe, expect, it } from "vitest";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit, type GitMaintenanceResult } from "../packages/git/src/client.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { fetchHttpClient } from "../packages/git/src/protocol/transport.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Concurrency Fixture", email: "concurrency@example.com" };

function workspace(storage: SqliteTestStorage, yieldNow?: () => Promise<void>): Workspace {
  return new Workspace({
    storage,
    git: createGit(),
    now: () => 100,
    defaultGitIdentity: IDENTITY,
    http: fetchHttpClient,
    ...(yieldNow === undefined ? {} : { yieldNow }),
  });
}

function pendingMaintenance(
  storage: SqliteTestStorage,
  name: string,
): {
  readonly barrier: ReturnType<typeof checkpointBarrier<number>>;
  readonly owner: Promise<GitMaintenanceResult>;
  readonly runtime: Workspace;
} {
  const barrier = checkpointBarrier<number>(name, (yielded) => yielded === 1);
  let yields = 0;
  const runtime = workspace(storage, () => barrier.checkpoint(++yields));
  storage.resetCounters();
  const owner = runtime.git.maintenance({ dir: "/repo" });
  return { barrier, owner, runtime };
}

async function measuredMaintenance(
  storage: SqliteTestStorage,
  runtime = workspace(storage),
): Promise<GitMaintenanceResult> {
  storage.resetCounters();
  const result = await runtime.git.maintenance({ dir: "/repo" });
  expect(storage.statementCount).toBeLessThan(1_000);
  return result;
}

async function committedRepository(storage: SqliteTestStorage): Promise<string> {
  const opened = workspace(storage);
  await opened.git.init({ dir: "/repo" });
  opened.filesystem.writeFiles([
    { path: "/repo/file.txt", bytes: utf8.encode("maintenance concurrency\n") },
  ]);
  await opened.git.add({ dir: "/repo", paths: ["file.txt"] });
  return (await opened.git.commit({ dir: "/repo", message: "maintenance fixture" })).oid;
}

async function reachSelected(storage: SqliteTestStorage): Promise<GitMaintenanceResult> {
  for (let calls = 0; calls < 200; calls++) {
    const result = await measuredMaintenance(storage);
    if (result.phase !== "repack") continue;
    await measuredMaintenance(storage);
    const state = new TestDatabase(storage).scalar<string>(
      "SELECT state FROM git_maintenance_repack_batches",
    );
    if (state === "selected") return result;
  }
  throw new Error("maintenance did not select a repack batch");
}

describe("maintenance concurrency", () => {
  it("admits one selected owner, fences a pending rival, and finalizes published state once", async () => {
    const storage = new SqliteTestStorage();
    const commitOid = await committedRepository(storage);
    await reachSelected(storage);
    const first = pendingMaintenance(storage, "maintenance pending pack");
    await awaitBarrierEntry(first.barrier, first.owner);
    const ownerPrefixStatements = storage.statementCount;
    const db = new TestDatabase(storage);
    const pendingPackId = db.scalar<number>(
      "SELECT pack_id FROM git_maintenance_repack_batches WHERE state = 'pending'",
    );
    if (pendingPackId === undefined)
      throw new Error("maintenance did not publish pending ownership");

    try {
      const rivalStart = storage.statementCount;
      await expect(first.runtime.git.maintenance({ dir: "/repo" })).rejects.toMatchObject({
        code: "EBUSY",
      });
      expect(storage.statementCount - rivalStart).toBeLessThan(1_000);
      expect(
        db.one<{ pack_id: number; state: string }>(
          "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = 1 AND pack_id = ?",
          pendingPackId,
        ),
      ).toEqual({ pack_id: pendingPackId, state: "pending" });
    } finally {
      const ownerTailStart = storage.statementCount;
      first.barrier.release();
      await expect(first.owner).resolves.toMatchObject({ phase: "repack" });
      expect(ownerPrefixStatements + storage.statementCount - ownerTailStart).toBeLessThan(1_000);
    }

    expect(
      db.one<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = 1 AND pack_id = ?",
        pendingPackId,
      ),
    ).toEqual({ pack_id: pendingPackId, state: "complete" });
    // Published finalization and cache revalidation are synchronous before this call yields.
    storage.resetCounters();
    const finalized = first.runtime.git.maintenance({ dir: "/repo" });
    const follower = first.runtime.git.maintenance({ dir: "/repo" });
    await expect(finalized).resolves.toMatchObject({ phase: "classify-packs" });
    await expect(follower).resolves.toMatchObject({ phase: "classify-packs" });
    expect(storage.statementCount).toBeLessThan(1_000);
    expect(db.scalar<number>("SELECT repacked_objects FROM git_maintenance_runs")).toBe(3);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    await expect(
      workspace(storage).git.catFile({ dir: "/repo", oid: commitOid }),
    ).resolves.toMatchObject({
      oid: commitOid,
    });
    await expect(workspace(storage).git.status({ dir: "/repo" })).resolves.toEqual([]);
  });

  it("lets a fetch and read-only operations proceed after maintenance owns a pending pack", async () => {
    const fixture = new GitFixture().init();
    fixture.write("remote.txt", "remote maintenance race\n");
    const remoteOid = fixture.commit("remote maintenance race");
    const server = await startGitServer(fixture.dir);
    const storage = new SqliteTestStorage();
    let active: ReturnType<typeof pendingMaintenance> | null = null;
    try {
      const localOid = await committedRepository(storage);
      await workspace(storage).git.remoteAdd({ dir: "/repo", name: "origin", url: server.url });
      await reachSelected(storage);
      active = pendingMaintenance(storage, "maintenance before fetch pack");
      await awaitBarrierEntry(active.barrier, active.owner);
      const ownerPrefixStatements = storage.statementCount;
      const db = new TestDatabase(storage);
      const maintenancePackId = db.scalar<number>(
        "SELECT pack_id FROM git_maintenance_repack_batches WHERE state = 'pending'",
      );
      if (maintenancePackId === undefined) throw new Error("maintenance pending pack is missing");

      await expect(active.runtime.git.status({ dir: "/repo" })).resolves.toEqual([]);
      await expect(
        active.runtime.git.catFile({ dir: "/repo", oid: localOid }),
      ).resolves.toMatchObject({
        oid: localOid,
      });
      await expect(
        active.runtime.git.fetch({ dir: "/repo", remote: "origin", tags: false }),
      ).resolves.toBeDefined();
      expect(
        db.one<{ pack_id: number; state: string }>(
          "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = 1 AND pack_id = ?",
          maintenancePackId,
        ),
      ).toEqual({ pack_id: maintenancePackId, state: "pending" });
      expect(
        db.scalar<string>("SELECT target FROM git_refs WHERE name = ?", "refs/remotes/origin/main"),
      ).toBe(remoteOid);

      const ownerTailStart = storage.statementCount;
      active.barrier.release();
      await expect(active.owner).resolves.toMatchObject({ phase: "repack" });
      expect(ownerPrefixStatements + storage.statementCount - ownerTailStart).toBeLessThan(1_000);
      await expect(measuredMaintenance(storage)).resolves.toMatchObject({
        phase: "roots",
        restarted: true,
      });
      expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM git_pack_meta WHERE pack_id = ?",
          maintenancePackId,
        ),
      ).toBe(0);
      await expect(
        workspace(storage).git.catFile({ dir: "/repo", oid: remoteOid }),
      ).resolves.toMatchObject({
        oid: remoteOid,
      });
      await expect(
        workspace(storage).git.catFile({ dir: "/repo", oid: localOid }),
      ).resolves.toMatchObject({
        oid: localOid,
      });
      await expect(workspace(storage).git.status({ dir: "/repo" })).resolves.toEqual([]);
    } finally {
      active?.barrier.release();
      if (active !== null) await Promise.allSettled([active.owner]);
      await server.close();
      fixture.dispose();
    }
  });

  it("keeps a confirmed push while the older maintenance owner restarts for root drift", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "push baseline\n");
    fixture.commit("push baseline");
    fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
    const server = await startGitServer(fixture.dir);
    const storage = new SqliteTestStorage();
    let active: ReturnType<typeof pendingMaintenance> | null = null;
    try {
      const opened = workspace(storage);
      await opened.git.clone({ url: server.url, dir: "/repo" });
      opened.filesystem.writeFiles([
        { path: "/repo/pushed.txt", bytes: utf8.encode("pushed during maintenance\n") },
      ]);
      await opened.git.add({ dir: "/repo", paths: ["pushed.txt"] });
      const pushedOid = (await opened.git.commit({ dir: "/repo", message: "push race" })).oid;
      await reachSelected(storage);
      active = pendingMaintenance(storage, "maintenance before push");
      await awaitBarrierEntry(active.barrier, active.owner);
      const ownerPrefixStatements = storage.statementCount;
      const db = new TestDatabase(storage);
      const maintenancePackId = db.scalar<number>(
        "SELECT pack_id FROM git_maintenance_repack_batches WHERE state = 'pending'",
      );
      if (maintenancePackId === undefined) throw new Error("maintenance pending pack is missing");

      await expect(active.runtime.git.push({ dir: "/repo" })).resolves.toMatchObject({
        ok: true,
      });
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(pushedOid);
      expect(
        db.scalar<string>("SELECT target FROM git_refs WHERE name = ?", "refs/remotes/origin/main"),
      ).toBe(pushedOid);
      expect(
        db.scalar<string>("SELECT state FROM git_pack_meta WHERE pack_id = ?", maintenancePackId),
      ).toBe("pending");

      const ownerTailStart = storage.statementCount;
      active.barrier.release();
      await expect(active.owner).resolves.toMatchObject({ phase: "repack" });
      expect(ownerPrefixStatements + storage.statementCount - ownerTailStart).toBeLessThan(1_000);
      await expect(measuredMaintenance(storage)).resolves.toMatchObject({
        phase: "roots",
        restarted: true,
      });
      expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM git_pack_meta WHERE pack_id = ?",
          maintenancePackId,
        ),
      ).toBe(0);
      await expect(
        workspace(storage).git.catFile({ dir: "/repo", oid: pushedOid }),
      ).resolves.toMatchObject({
        oid: pushedOid,
      });
      await expect(workspace(storage).git.status({ dir: "/repo" })).resolves.toEqual([]);
    } finally {
      active?.barrier.release();
      if (active !== null) await Promise.allSettled([active.owner]);
      await server.close();
      fixture.dispose();
    }
  });

  it("settles selected, abandoned pending, and published owners exactly once after cold reopen", async () => {
    const boundaries: readonly ("selected" | "pending" | "published")[] = [
      "selected",
      "pending",
      "published",
    ];
    for (const boundary of boundaries) {
      const storage = new SqliteTestStorage();
      const commitOid = await committedRepository(storage);
      await reachSelected(storage);
      const db = new TestDatabase(storage);

      if (boundary === "pending") {
        const failure = new Error("abandoned maintenance owner");
        storage.resetCounters();
        await expect(
          workspace(storage, () => Promise.reject(failure)).git.maintenance({ dir: "/repo" }),
        ).rejects.toBe(failure);
        expect(storage.statementCount).toBeLessThan(1_000);
        expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(
          "pending",
        );
        expect(await measuredMaintenance(storage)).toMatchObject({
          phase: "repack",
          repackedObjects: 0,
        });
        expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(
          "selected",
        );
        expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
      } else if (boundary === "published") {
        expect(await measuredMaintenance(storage)).toMatchObject({
          phase: "repack",
          repackedObjects: 0,
        });
        expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(
          "published",
        );
      } else {
        expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(
          "selected",
        );
      }

      if (boundary !== "published") {
        expect(await measuredMaintenance(storage)).toMatchObject({
          phase: "repack",
          repackedObjects: 0,
        });
      }
      expect(db.scalar<string>("SELECT state FROM git_maintenance_repack_batches")).toBe(
        "published",
      );
      expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
        1,
      );

      expect(await measuredMaintenance(storage)).toMatchObject({
        phase: "repack",
        repackedObjects: 3,
      });
      expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
      expect(db.scalar<number>("SELECT repacked_objects FROM git_maintenance_runs")).toBe(3);
      expect(await measuredMaintenance(storage)).toMatchObject({
        phase: "classify-packs",
        repackedObjects: 3,
      });
      expect(db.scalar<number>("SELECT repacked_objects FROM git_maintenance_runs")).toBe(3);
      await expect(
        workspace(storage).git.catFile({ dir: "/repo", oid: commitOid }),
      ).resolves.toMatchObject({
        oid: commitOid,
      });
      await expect(workspace(storage).git.status({ dir: "/repo" })).resolves.toEqual([]);
    }
  });

  it("restarts after sibling checkout creation and removal without losing shared objects", async () => {
    const storage = new SqliteTestStorage();
    const commitOid = await committedRepository(storage);
    const selected = await reachSelected(storage);
    await workspace(storage).git.worktreeAdd({
      dir: "/repo",
      root: "/linked",
      target: { kind: "new-branch", name: "linked" },
    });
    await expect(measuredMaintenance(storage)).resolves.toMatchObject({
      runId: selected.runId,
      phase: "roots",
      restarted: true,
    });
    await expect(
      workspace(storage).git.catFile({ dir: "/linked", oid: commitOid }),
    ).resolves.toMatchObject({
      oid: commitOid,
    });
    await expect(workspace(storage).git.status({ dir: "/linked" })).resolves.toEqual([]);

    await reachSelected(storage);
    await workspace(storage).git.worktreeRemove({ dir: "/repo", root: "/linked", force: true });
    await expect(measuredMaintenance(storage)).resolves.toMatchObject({
      phase: "roots",
      restarted: true,
    });
    expect(new TestDatabase(storage).scalar<number>("SELECT count(*) FROM git_checkouts")).toBe(1);
    await expect(
      workspace(storage).git.catFile({ dir: "/repo", oid: commitOid }),
    ).resolves.toMatchObject({
      oid: commitOid,
    });
    await expect(workspace(storage).git.status({ dir: "/repo" })).resolves.toEqual([]);
  });

  it("restarts a selected batch after an exact ref mutation and roots the new ref", async () => {
    const storage = new SqliteTestStorage();
    const commitOid = await committedRepository(storage);
    const selected = await reachSelected(storage);
    await workspace(storage).git.updateRef({
      dir: "/repo",
      ref: "refs/tags/during-maintenance",
      value: commitOid,
    });
    const db = new TestDatabase(storage);

    await expect(measuredMaintenance(storage)).resolves.toMatchObject({
      runId: selected.runId,
      phase: "roots",
      restarted: true,
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(
      db.scalar<string>(
        "SELECT target FROM git_refs WHERE name = ?",
        "refs/tags/during-maintenance",
      ),
    ).toBe(commitOid);
    for (let calls = 0; calls < 30; calls++) {
      const result = await measuredMaintenance(storage);
      if (result.phase === "mark") break;
      if (calls === 29) throw new Error("maintenance did not finish the restarted root snapshot");
    }
    expect(
      db.scalar<number>(
        "SELECT source_mask & 1 FROM git_maintenance_objects WHERE oid = ?",
        commitOid,
      ),
    ).toBe(1);
    await expect(
      workspace(storage).git.catFile({ dir: "/repo", oid: commitOid }),
    ).resolves.toMatchObject({
      oid: commitOid,
    });
    await expect(workspace(storage).git.status({ dir: "/repo" })).resolves.toEqual([]);
  });
});
