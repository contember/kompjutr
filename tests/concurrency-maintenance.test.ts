import { describe, expect, it } from "vitest";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit, type GitMaintenanceResult } from "../packages/git/src/client.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { fetchHttpClient } from "../packages/git/src/protocol/transport.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { PACK_DEPENDENCY_QUERY } from "../packages/git/src/store/maintenance/sweep/sweep-pack-dependencies.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";
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
      await fixture.until("packs");
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
      await fixture.until("packs");
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
    await fixture.until("packs");
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
      await fixture.until("packs");
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
      await fixture.until("packs");
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
