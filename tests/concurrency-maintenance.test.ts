import { describe, expect, it } from "vitest";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit, type GitMaintenanceResult } from "../packages/git/src/client.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { fetchHttpClient } from "../packages/git/src/protocol/transport.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { TestDatabase } from "./helpers/db.js";
import { lifecycleDelta, lifecyclePack, packMaintenance } from "./helpers/pack-maintenance.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Concurrency Fixture", email: "concurrency@example.com" };

function workspace(storage: SqliteTestStorage): Workspace {
  return new Workspace({
    storage,
    git: createGit(),
    now: () => 100,
    defaultGitIdentity: IDENTITY,
    http: fetchHttpClient,
  });
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

function sharedStore(storage: SqliteTestStorage) {
  const database = new SqliteGitDatabase(new TestDatabase(storage), { objectCacheBytes: 0 });
  const checkout = database.findCheckout("/repo");
  if (checkout === null) throw new Error("maintenance fixture checkout is missing");
  return database.openCheckout(checkout);
}

function generations(storage: SqliteTestStorage): { source: number; observed: number } {
  const db = new TestDatabase(storage);
  return {
    source: db.scalar<number>("SELECT source_generation FROM git_repositories") ?? -1,
    observed:
      db.scalar<number>("SELECT observed_source_generation FROM git_maintenance_runs") ?? -1,
  };
}

async function ingestPack(
  storage: SqliteTestStorage,
  bytes: Uint8Array,
  lifecycle?: { reserved(packId: number): void; published(): void },
): Promise<number> {
  async function* source(): AsyncGenerator<Uint8Array> {
    yield bytes;
  }
  const result = await sharedStore(storage).packs.ingest(
    source(),
    lifecycle === undefined ? undefined : { lifecycle },
  );
  return result.packId;
}

/** Advance past the mark, where drift must reset the run instead of re-snapshotting roots. */
async function reachClassification(storage: SqliteTestStorage): Promise<GitMaintenanceResult> {
  for (let calls = 0; calls < 200; calls++) {
    const result = await measuredMaintenance(storage);
    if (result.phase === "packs") return result;
  }
  throw new Error("maintenance did not reach pack classification");
}

describe("maintenance concurrency", () => {
  it("public sweep collects a crossed pack whose objects the reachable pack owns", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    const x = utf8.encode("sweep crossed X\n");
    const y = utf8.encode("sweep crossed Y\n");
    const xOid = hashObject("blob", x);
    const yOid = hashObject("blob", y);
    const owner = await fixture.ingest(
      lifecyclePack((writer) => {
        writer.object("blob", y);
        writer.refDelta(yOid, lifecycleDelta(y.length, x));
      }, 2),
    );
    const crossed = await fixture.ingest(
      lifecyclePack((writer) => {
        writer.object("blob", x);
        writer.refDelta(xOid, lifecycleDelta(x.length, y));
      }, 2),
    );
    const dead = await fixture.full(utf8.encode("sweep crossed dead\n"));
    await fixture.runtime().git.updateRef({ dir: "/repo", ref: "refs/tags/live", value: xOid });
    await fixture.until("finish");
    fixture.clock.value += GC_GRACE_MS;
    await fixture.until("packs");
    await fixture.until("finish", 2 * 3 + 2);
    expect(fixture.db.all("SELECT pack_id FROM git_pack_meta ORDER BY pack_id")).toEqual([
      { pack_id: owner.packId },
    ]);
    for (const packId of [crossed.packId, dead.packId]) {
      expect(
        fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", packId),
      ).toBe(0);
    }
    expect(fixture.store().read(xOid)?.data).toEqual(x);
    expect(fixture.store().read(yOid)?.data).toEqual(y);
    expect(
      (await fixture.runtime().git.catFile({ dir: "/repo", oid: "refs/tags/live" })).bytes,
    ).toEqual(x);
  });

  it("restarts after sibling checkout creation and removal without losing shared objects", async () => {
    const storage = new SqliteTestStorage();
    const commitOid = await committedRepository(storage);
    const selected = await reachClassification(storage);
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

    await reachClassification(storage);
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

  it("restarts a classifying run after an exact ref mutation and roots the new ref", async () => {
    const storage = new SqliteTestStorage();
    const commitOid = await committedRepository(storage);
    const selected = await reachClassification(storage);
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

  it("restarts a classifying run after a loose write that moves no root", async () => {
    const storage = new SqliteTestStorage();
    await committedRepository(storage);
    const selected = await reachClassification(storage);
    const db = new TestDatabase(storage);
    const rootEpoch = db.scalar<number>("SELECT root_epoch FROM git_maintenance_control");
    const before = generations(storage);
    expect(before.observed).toBe(before.source);

    sharedStore(storage).write("blob", utf8.encode("source-only drift\n"));

    const after = generations(storage);
    expect(after.source).toBe(before.source + 1);
    expect(after.observed).toBe(before.observed);
    expect(db.scalar<number>("SELECT root_epoch FROM git_maintenance_control")).toBe(rootEpoch);

    await expect(measuredMaintenance(storage)).resolves.toMatchObject({
      runId: selected.runId,
      phase: "roots",
      restarted: true,
      reclaimedObjects: 0,
      reclaimedPacks: 0,
    });
    expect(generations(storage)).toEqual({ source: after.source, observed: after.source });
  });

  it("does not restart for a pending pack whose reclamation promotes nothing", async () => {
    const storage = new SqliteTestStorage();
    await committedRepository(storage);
    const selected = await reachClassification(storage);
    const db = new TestDatabase(storage);
    const before = generations(storage);
    expect(before.observed).toBe(before.source);

    // An interrupted ingest leaves a pending pack owning canonical rows that no
    // complete read can see, so reclaiming it changes no visible source.
    let pendingPackId = -1;
    await expect(
      ingestPack(
        storage,
        lifecyclePack((writer) => writer.object("blob", utf8.encode("invisible pending\n")), 1),
        {
          reserved(packId) {
            pendingPackId = packId;
          },
          published() {
            throw new Error("interrupted publication");
          },
        },
      ),
    ).rejects.toThrow(/interrupted publication/);
    expect(generations(storage)).toEqual(before);
    // The next reservation reclaims it; a checksum failure keeps that ingest from publishing.
    const corrupt = lifecyclePack((writer) => writer.object("blob", utf8.encode("probe\n")), 1);
    corrupt[corrupt.length - 1]! ^= 0xff;
    await expect(ingestPack(storage, corrupt)).rejects.toThrow(/checksum/);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", pendingPackId),
    ).toBe(0);

    expect(generations(storage)).toEqual(before);
    await expect(measuredMaintenance(storage)).resolves.toMatchObject({
      runId: selected.runId,
      restarted: false,
    });
    expect(db.scalar<string>("SELECT phase FROM git_maintenance_runs")).not.toBe("roots");
  });

  it("restarts when a pack deletion promotes a complete fallback", async () => {
    const storage = new SqliteTestStorage();
    await committedRepository(storage);
    const shared = utf8.encode("promoted fallback\n");
    const other = utf8.encode("fallback sibling\n");
    const owner = await ingestPack(
      storage,
      lifecyclePack((writer) => writer.object("blob", shared), 1),
    );
    const fallback = await ingestPack(
      storage,
      lifecyclePack((writer) => {
        writer.object("blob", shared);
        writer.object("blob", other);
      }, 2),
    );
    const selected = await reachClassification(storage);
    const before = generations(storage);
    expect(before.observed).toBe(before.source);

    expect(sharedStore(storage).packs.deleteCompletePacks([owner])).toBe(1);

    expect(generations(storage).source).toBe(before.source + 1);
    await expect(measuredMaintenance(storage)).resolves.toMatchObject({
      runId: selected.runId,
      phase: "roots",
      restarted: true,
    });
    expect(generations(storage).observed).toBe(generations(storage).source);

    // The survivor is now the sole canonical owner, so deleting it promotes
    // nothing: only the pre-promotion ownership probe can see that change.
    const promoted = generations(storage).source;
    expect(sharedStore(storage).packs.deleteCompletePacks([fallback])).toBe(1);
    expect(generations(storage).source).toBe(promoted + 1);
  });

  it("reaches finish cold at every durable boundary without restarting", async () => {
    const storage = new SqliteTestStorage();
    await committedRepository(storage);
    const seen = new Set<string>();
    let runId: number | null = null;
    for (let calls = 0; calls < 400; calls++) {
      // Each call builds a fresh Workspace over the same storage: a cold reopen.
      const result = await measuredMaintenance(storage);
      seen.add(result.phase);
      runId ??= result.runId;
      expect(result.runId).toBe(runId);
      expect(result.restarted).toBe(false);
      expect(generations(storage).observed).toBe(generations(storage).source);
      if (result.phase === "finish") break;
    }
    expect([...seen].sort()).toEqual(["finish", "loose", "mark", "packs", "roots"]);
  });
});
