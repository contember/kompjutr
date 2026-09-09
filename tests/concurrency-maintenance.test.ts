import { describe, expect, it } from "vitest";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit, type GitMaintenanceResult } from "../packages/git/src/client.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { fetchHttpClient } from "../packages/git/src/protocol/transport.js";
import { PACK_DEPENDENCY_QUERY } from "../packages/git/src/store/maintenance/sweep/sweep-pack-dependencies.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";
import { lifecycleDelta, lifecyclePack, packMaintenance } from "./helpers/pack-maintenance.js";
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
  it.each([false, true])(
    "public sweep checks the first fallback rather than a later safe copy (loose: %s)",
    async (looseDuplicate) => {
      const fixture = packMaintenance();
      await fixture.runtime().git.init({ dir: "/repo" });
      const a = utf8.encode("first fallback A\n");
      const b = utf8.encode("first fallback B\n");
      const aOid = hashObject("blob", a);
      if (looseDuplicate) fixture.store().writeObjects((batch) => batch.write("blob", a));
      const original = await fixture.full(a);
      for (const ordinal of [0, 1, 2]) {
        const live = utf8.encode(`first fallback live ${ordinal}\n`);
        await fixture.ingest(
          lifecyclePack((writer) => {
            if (ordinal === 0) writer.refDelta(aOid, lifecycleDelta(a.length, b));
            else if (ordinal === 1)
              writer.refDelta(hashObject("blob", b), lifecycleDelta(b.length, a));
            else writer.object("blob", a);
            writer.object("blob", live);
          }, 2),
        );
        await fixture.runtime().git.updateRef({
          dir: "/repo",
          ref: `refs/tags/live-${ordinal}`,
          value: hashObject("blob", live),
        });
      }
      const dead = await fixture.full(utf8.encode("first fallback unrelated dead\n"));
      await fixture.until("finish");
      fixture.clock.value += GC_GRACE_MS;
      await fixture.until("sweep-packs");
      await fixture.until("finish", 1 + 1 + 1);
      expect(
        fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", dead.packId),
      ).toBe(0);
      expect(fixture.store().packs.completePackedEntry(aOid)?.packId).toBe(original.packId);
      expect(fixture.store().read(aOid)?.data).toEqual(a);
      expect(fixture.store().read(hashObject("blob", b))?.data).toEqual(b);
    },
  );

  it.each(["full", "delta"])(
    "public sweep collects crossed pack dependencies with a safe %s fallback",
    async (variant) => {
      const fixture = packMaintenance();
      await fixture.runtime().git.init({ dir: "/repo" });
      const a = utf8.encode("crossed A\n");
      const b = utf8.encode("crossed B\n");
      const c = utf8.encode("crossed C\n");
      const d = utf8.encode("crossed D\n");
      const x = utf8.encode("crossed X\n");
      const p0 = await fixture.full(c);
      await fixture.ingest(
        lifecyclePack((writer) => {
          writer.object("blob", a);
          writer.refDelta(hashObject("blob", c), lifecycleDelta(c.length, d));
        }, 2),
      );
      await fixture.ingest(
        lifecyclePack(
          (writer) => {
            writer.object("blob", c);
            if (variant === "full") writer.object("blob", a);
            else {
              writer.object("blob", x);
              writer.refDelta(hashObject("blob", x), lifecycleDelta(x.length, a));
            }
            writer.refDelta(hashObject("blob", a), lifecycleDelta(a.length, b));
          },
          variant === "full" ? 3 : 4,
        ),
      );
      expect(fixture.store().packs.deleteCompletePacks([p0.packId])).toBe(1);
      const plan = fixture.db
        .all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${PACK_DEPENDENCY_QUERY}`,
          fixture.store().sharedRepoId,
          2,
        )
        .map((row) => row.detail);
      expect(plan.filter((detail) => detail === "MATERIALIZE closure")).toHaveLength(1);
      expect(plan.filter((detail) => detail === "MATERIALIZE replacements")).toHaveLength(1);
      expect(plan.join("\n")).toContain(
        "SEARCH candidate USING COVERING INDEX git_pack_entries_by_oid (repo_id=? AND oid=?)",
      );
      expect(plan.join("\n")).toContain(
        "SEARCH current USING INDEX sqlite_autoindex_git_pack_objects_1 (repo_id=? AND oid=?)",
      );
      expect(plan.join("\n")).toContain(
        "SEARCH replacement USING AUTOMATIC COVERING INDEX (oid=?)",
      );
      for (const bytes of [a, b, c, d])
        expect(fixture.store().read(hashObject("blob", bytes))?.data).toEqual(bytes);
      await fixture.until("finish");
      fixture.clock.value += GC_GRACE_MS;
      await fixture.until("sweep-packs");
      await fixture.call();
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(1);
      for (const bytes of [a, b, c])
        expect(fixture.store().read(hashObject("blob", bytes))?.data).toEqual(bytes);
      await fixture.until("finish", 1 + 1 + 1);
      expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
      for (const bytes of [a, b, c, d])
        expect(fixture.store().read(hashObject("blob", bytes))).toBeNull();
    },
  );

  it("public sweep collects an entirely dead fallback, child, and canonical base", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    const a = utf8.encode("dead fallback A\n");
    const b = utf8.encode("dead fallback B\n");
    await fixture.full(a);
    await fixture.ingest(
      lifecyclePack(
        (writer) => writer.refDelta(hashObject("blob", a), lifecycleDelta(a.length, b)),
        1,
      ),
    );
    await fixture.ingest(
      lifecyclePack(
        (writer) => writer.refDelta(hashObject("blob", b), lifecycleDelta(b.length, a)),
        1,
      ),
    );
    await fixture.until("finish");
    fixture.clock.value += GC_GRACE_MS;
    await fixture.until("sweep-packs");
    await fixture.until("finish", 3 * 2 + 1);
    expect(fixture.db.scalar("SELECT count(*) FROM git_pack_meta")).toBe(0);
    expect(fixture.store().read(hashObject("blob", a))).toBeNull();
    expect(fixture.store().read(hashObject("blob", b))).toBeNull();
  });

  it("public sweep retains the reachable canonical pack before a promotion cycle can form", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    const a = utf8.encode("public cycle A\n");
    const b = utf8.encode("public cycle B\n");
    const aOid = hashObject("blob", a);
    const canonical = await fixture.full(a);
    await fixture.ingest(
      lifecyclePack((writer) => writer.refDelta(aOid, lifecycleDelta(a.length, b)), 1),
    );
    await fixture.ingest(
      lifecyclePack(
        (writer) => writer.refDelta(hashObject("blob", b), lifecycleDelta(b.length, a)),
        1,
      ),
    );
    await fixture.runtime().git.updateRef({ dir: "/repo", ref: "refs/tags/live", value: aOid });
    await fixture.until("finish");
    fixture.clock.value += GC_GRACE_MS;
    await fixture.until("finish");
    expect(fixture.db.scalar("SELECT pack_id FROM git_pack_objects WHERE oid = ?", aOid)).toBe(
      canonical.packId,
    );
    expect(fixture.store().read(aOid)?.data).toEqual(a);
    expect(
      (await fixture.runtime().git.catFile({ dir: "/repo", oid: "refs/tags/live" })).bytes,
    ).toEqual(a);
  });

  it.each([false, true])(
    "public sweep passes a blocked lowest pack and collects dead dependency pairs (loose duplicate: %s)",
    async (looseDuplicate) => {
      const fixture = packMaintenance();
      await fixture.runtime().git.init({ dir: "/repo" });
      const base = utf8.encode("mixed pack external base\n");
      const baseOid = hashObject("blob", base);
      const target = utf8.encode("dead delta in surviving mixed pack\n");
      const live = utf8.encode("live mixed pack object\n");
      if (looseDuplicate) fixture.store().writeObjects((batch) => batch.write("blob", base));
      const required = await fixture.full(base);
      const mixed = await fixture.ingest(
        lifecyclePack((writer) => {
          writer.refDelta(baseOid, lifecycleDelta(base.length, target));
          writer.object("blob", live);
        }, 2),
      );
      await fixture
        .runtime()
        .git.updateRef({ dir: "/repo", ref: "refs/tags/live", value: hashObject("blob", live) });
      const cyclicFallback = await fixture.ingest(
        lifecyclePack((writer) => {
          writer.refDelta(hashObject("blob", target), lifecycleDelta(target.length, base));
        }, 1),
      );
      const deadBase = utf8.encode("entirely dead base\n");
      const deadTarget = utf8.encode("entirely dead child\n");
      const deadParent = await fixture.full(deadBase);
      const deadChild = await fixture.ingest(
        lifecyclePack((writer) => {
          writer.refDelta(
            hashObject("blob", deadBase),
            lifecycleDelta(deadBase.length, deadTarget),
          );
        }, 1),
      );
      const unrelated = await fixture.full(utf8.encode("unrelated dead pack\n"));
      await fixture.until("finish");
      fixture.clock.value += GC_GRACE_MS;
      await fixture.until("sweep-packs");
      await fixture.until("finish", 2 * 6 + 2);
      expect(fixture.db.all("SELECT pack_id FROM git_pack_meta ORDER BY pack_id")).toEqual([
        ...(looseDuplicate ? [] : [{ pack_id: required.packId }]),
        { pack_id: mixed.packId },
      ]);
      for (const packId of [
        cyclicFallback.packId,
        deadParent.packId,
        deadChild.packId,
        unrelated.packId,
      ]) {
        expect(
          fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", packId),
        ).toBe(0);
      }
      expect(fixture.store().read(hashObject("blob", target))?.data).toEqual(target);
      expect(fixture.store().read(baseOid)?.data).toEqual(base);
      expect(
        (await fixture.runtime().git.catFile({ dir: "/repo", oid: "refs/tags/live" })).bytes,
      ).toEqual(live);
    },
  );

  it("public fetch keeps the external base of a flushed pending delta during sweep", async () => {
    const remote = new GitFixture().init();
    const base = Array.from(
      { length: 4000 },
      (_, i) => `line ${i}: deterministic delta fixture\n`,
    ).join("");
    remote.write("base.txt", base);
    remote.write("target.txt", `${base}changed tail\n`);
    for (let i = 0; i < 1100; i++) remote.write(`filler-${i}.txt`, `filler ${i}\n`);
    const head = remote.commit("delta fixture");
    remote.git("repack", "-adf", "--window=10", "--depth=10");
    const server = await startGitServer(remote.dir);
    const fixture = packMaintenance();
    let owner: Promise<unknown> | undefined;
    const barrier = checkpointBarrier<boolean>("resolved pending fetch delta", Boolean);
    try {
      await fixture.runtime().git.init({ dir: "/repo" });
      await fixture.full(utf8.encode(`${base}changed tail\n`));
      await fixture.until("finish");
      fixture.clock.value += GC_GRACE_MS;
      await fixture.until("sweep-packs");
      await fixture.runtime().git.remoteAdd({ dir: "/repo", name: "origin", url: server.url });
      const fetching = fixture.runtime(async () => {
        const flushed = fixture.db.scalar<number>(`SELECT count(*) FROM git_pack_entries entry
          JOIN git_pack_meta pack USING (repo_id, pack_id)
          WHERE pack.state = 'pending' AND entry.base_oid IS NOT NULL`);
        await barrier.checkpoint((flushed ?? 0) > 0);
      });
      owner = fetching.git.fetch({ dir: "/repo", tags: false });
      await awaitBarrierEntry(barrier, owner);
      const dependency = fixture.db.one<{
        base_oid: string;
        pack_id: number;
      }>(`SELECT entry.base_oid, base.pack_id
        FROM git_pack_entries entry JOIN git_pack_meta pack USING (repo_id, pack_id)
        JOIN git_pack_objects base ON base.repo_id = entry.repo_id AND base.oid = entry.base_oid
        WHERE pack.state = 'pending' AND entry.base_oid IS NOT NULL LIMIT 1`);
      if (dependency === undefined) throw new Error("fetch did not flush an external delta");
      expect(dependency.base_oid).toBe(hashObject("blob", utf8.encode(`${base}changed tail\n`)));
      await fixture.until("finish", 10);
      expect(
        fixture.db.scalar(
          "SELECT count(*) FROM git_pack_meta WHERE pack_id = ?",
          dependency.pack_id,
        ),
      ).toBe(1);
      barrier.release();
      await owner;
      expect((await fixture.runtime().git.catFile({ dir: "/repo", oid: head })).oid).toBe(head);
      expect(fixture.store().read(hashObject("blob", utf8.encode(base)))?.data).toEqual(
        utf8.encode(base),
      );
      expect(
        fixture.store().read(hashObject("blob", utf8.encode(`${base}changed tail\n`)))?.data,
      ).toEqual(utf8.encode(`${base}changed tail\n`));
    } finally {
      barrier.release();
      if (owner !== undefined) await Promise.allSettled([owner]);
      await server.close();
      remote.dispose();
    }
  });
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
