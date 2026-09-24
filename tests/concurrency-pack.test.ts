import { describe, expect, it, vi } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { type CheckoutStore, SqliteGitDatabase } from "../packages/git/src/store/index.js";
import {
  PACK_INGEST_LEASE_MS,
  type PackIngestResult,
} from "../packages/git/src/store/pack/packs.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";
import { lifecycleDelta, lifecyclePack } from "./helpers/pack-maintenance.js";
import { completePackMatches, type PackMember, reclaimPending } from "./helpers/pack-store.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const INDEX_CHECKPOINT_OBJECTS = 1_024;
const PACK_INPUT_YIELD_BYTES = 4 * 1024 * 1024;

interface OpenedStore {
  readonly db: TestDatabase;
  readonly storage: SqliteTestStorage;
  readonly store: CheckoutStore;
}

interface CheckpointPack {
  readonly bytes: Uint8Array;
  readonly members: readonly PackMember[];
  readonly targetData: Uint8Array;
  readonly targetOid: string;
  readonly uniqueData: Uint8Array;
  readonly uniqueOid: string;
}

interface PausedIngest {
  readonly barrier: {
    readonly name: string;
    readonly entered: Promise<void>;
    release(): void;
  };
  readonly publicationFailure: Error | null;
  readonly owner: Promise<PackIngestResult>;
  readonly packId: () => number;
}

function createStore(now: () => number = Date.now): OpenedStore {
  const storage = new SqliteTestStorage();
  const db = new TestDatabase(storage);
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024, now });
  const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
  return { db, storage, store };
}

function reopenStore(storage: SqliteTestStorage, now: () => number = Date.now): OpenedStore {
  const db = new TestDatabase(storage);
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024, now });
  const checkout = database.findCheckout("/repo");
  if (checkout === null) throw new Error("repository disappeared during cold reopen");
  return { db, storage, store: database.openCheckout(checkout) };
}

function fullObjectPack(data: readonly Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(data.length);
  for (const object of data) writer.object("blob", object);
  writer.finish();
  return concat(chunks);
}

async function* singleChunk(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data;
}

function checkpointPack(targetData: Uint8Array, prefix: string): CheckpointPack {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(INDEX_CHECKPOINT_OBJECTS);
  writer.object("blob", targetData);
  const members: PackMember[] = [blobMembership(targetData)];
  let uniqueData: Uint8Array | undefined;
  for (let index = 1; index < INDEX_CHECKPOINT_OBJECTS; index++) {
    const data = utf8.encode(`${prefix}-${index}\n`);
    if (index === 1) uniqueData = data;
    writer.object("blob", data);
    const oid = hashObject("blob", data);
    members.push({ oid, type: "blob", size: data.length });
  }
  writer.finish();
  if (uniqueData === undefined) throw new Error("checkpoint pack has no unique object");
  return {
    bytes: concat(chunks),
    members,
    targetData,
    targetOid: hashObject("blob", targetData),
    uniqueData,
    uniqueOid: hashObject("blob", uniqueData),
  };
}

function startReservationPausedIngest(
  store: CheckoutStore,
  fixture: CheckpointPack,
  name: string,
): PausedIngest {
  const barrier = checkpointBarrier<number>(name, (checkpoint) => checkpoint === 1);
  let reservedPackId: number | undefined;
  const source = async function* (): AsyncGenerator<Uint8Array> {
    await barrier.checkpoint(1);
    yield fixture.bytes;
  };
  const owner = store.packs.ingest(source(), {
    lifecycle: {
      reserved(packId) {
        reservedPackId = packId;
      },
      published() {},
    },
  });
  return {
    barrier,
    publicationFailure: null,
    owner,
    packId() {
      if (reservedPackId === undefined) throw new Error(`${name} did not reserve a pack`);
      return reservedPackId;
    },
  };
}

function startPausedIngest(
  store: CheckoutStore,
  fixture: CheckpointPack,
  name: string,
  failPublication = false,
): PausedIngest {
  if (fixture.bytes.length >= PACK_INPUT_YIELD_BYTES) {
    throw new Error(`${name} fixture must reach the object-index checkpoint on its second yield`);
  }
  const barrier = checkpointBarrier<number>(name, (checkpoint) => checkpoint === 2);
  const publicationFailure = failPublication ? new Error(`${name} publication failed`) : null;
  let yields = 0;
  let reservedPackId: number | undefined;
  const owner = store.packs.ingest(singleChunk(fixture.bytes), {
    yieldNow: () => barrier.checkpoint(++yields),
    lifecycle: {
      reserved(packId) {
        reservedPackId = packId;
      },
      published() {
        if (publicationFailure !== null) throw publicationFailure;
      },
    },
  });
  return {
    barrier,
    publicationFailure,
    owner,
    packId() {
      if (reservedPackId === undefined) throw new Error(`${name} did not reserve a pack`);
      return reservedPackId;
    },
  };
}

function blobMembership(data: Uint8Array): PackMember {
  return { oid: hashObject("blob", data), type: "blob", size: data.length };
}

function packedOwner(store: CheckoutStore, oid: string): number | null {
  return (
    store.db.scalar<number>(
      "SELECT pack_id FROM git_pack_objects WHERE repo_id = ? AND oid = ?",
      store.sharedRepoId,
      oid,
    ) ?? null
  );
}

function expectCheckpointReadable(store: CheckoutStore, fixture: CheckpointPack): void {
  const batch = store.readObjects(
    fixture.members.map((object) => object.oid),
    { budgetBytes: 4 * 1024 * 1024 },
  );
  expect(batch.remaining).toEqual([]);
  expect(batch.objects.size).toBe(fixture.members.length);
  for (const expected of fixture.members) {
    const object = batch.objects.get(expected.oid);
    expect(object?.type).toBe(expected.type);
    expect(object?.data.length).toBe(expected.size);
    if (object === undefined) throw new Error(`checkpoint object ${expected.oid} disappeared`);
    expect(hashObject(object.type, object.data)).toBe(expected.oid);
  }
}

describe("concurrent pack ownership", () => {
  it.each(["publication", "lease release"])(
    "rolls back commit promotion after %s failure",
    async (seam) => {
      const opened = createStore();
      const data = utf8.encode(
        `tree ${"0".repeat(40)}\nauthor Fixture <fixture@example.com> 1577836800 +0000\ncommitter Fixture <fixture@example.com> 1577836800 +0000\n\nrollback\n`,
      );
      const oid = hashObject("commit", data);
      const bytes = lifecyclePack((writer) => writer.object("commit", data), 1);
      const failure = new Error(`injected ${seam}`);
      let published = false;
      const originalOne = opened.db.one.bind(opened.db);
      const fault = vi
        .spyOn(opened.db, "one")
        .mockImplementation(
          <Row extends object>(query: string, ...bindings: unknown[]): Row | undefined => {
            const row = originalOne<Row>(query, ...bindings);
            if (
              seam === "lease release" &&
              published &&
              query.includes("SET active_pack_id = NULL")
            ) {
              published = false;
              throw failure;
            }
            return row;
          },
        );
      try {
        await expect(
          opened.store.packs.ingest(singleChunk(bytes), {
            lifecycle: {
              reserved() {},
              published() {
                expect(opened.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(1);
                expect(
                  opened.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging"),
                ).toBe(0);
                published = true;
                if (seam === "publication") throw failure;
              },
            },
          }),
        ).rejects.toBe(failure);
      } finally {
        fault.mockRestore();
      }
      const cold = reopenStore(opened.storage);
      expect(cold.db.scalar<string>("SELECT state FROM git_pack_meta")).toBe("pending");
      expect(cold.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging")).toBe(1);
      expect(cold.store.cachedCommit(oid)).toBeNull();
      expect(cold.store.read(oid)).toBeNull();
      expect(
        cold.db.scalar<number | null>("SELECT active_pack_id FROM git_pack_ingest_control"),
      ).toBeNull();
      // The retry's reservation reclaims the abandoned pack and its staging.
      await cold.store.packs.ingest(singleChunk(bytes));
      expect(cold.db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE pack_id = 1")).toBe(
        0,
      );
      expect(cold.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging")).toBe(0);
      expect(reopenStore(opened.storage).store.cachedCommit(oid)?.commit.message).toBe(
        "rollback\n",
      );
    },
  );

  it("counts repeated small and oversized physical commits while preserving published duplicates", async () => {
    const opened = createStore();
    const fixture = new GitFixture().init();
    const header = `tree ${"0".repeat(40)}\nauthor Fixture <fixture@example.com> 1577836800 +0000\ncommitter Fixture <fixture@example.com> 1577836800 +0000\n\n`;
    const eligible = utf8.encode(`${header}eligible\n`);
    const loose = utf8.encode(`${header}loose\n`);
    const oversized = utf8.encode(`${header}${"x".repeat(4 * 1024 * 1024)}\n`);
    const oversizedOid = hashObject("commit", oversized);
    const eligibleOid = hashObject("commit", eligible);
    const looseOid = opened.store.write("commit", loose);
    await opened.store.packs.ingest(
      singleChunk(lifecyclePack((writer) => writer.object("commit", eligible), 1)),
    );
    const before = opened.db.all<Record<string, unknown>>("SELECT * FROM git_commits ORDER BY oid");
    const bytes = lifecyclePack((writer) => {
      for (let i = 0; i < 3073; i++) writer.object("commit", eligible);
      writer.object("commit", loose);
      writer.object("commit", loose);
      writer.object("commit", oversized);
      writer.object("commit", oversized);
    }, 3077);
    try {
      fixture.write("duplicates.pack", bytes);
      expect(fixture.git("index-pack", "duplicates.pack")).toMatch(/^[0-9a-f]{40}$/);
      let observed = false;
      const result = await opened.store.packs.ingest(singleChunk(bytes), {
        async yieldNow() {
          if (opened.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging") === 0)
            return;
          observed = true;
          const reader = reopenStore(opened.storage);
          expect(reader.store.cachedCommit(eligibleOid)?.commit.message).toBe("eligible\n");
          expect(reader.store.cachedCommit(looseOid)?.commit.message).toBe("loose\n");
          expect(
            reader.db.all<Record<string, unknown>>("SELECT * FROM git_commits ORDER BY oid"),
          ).toEqual(before);
        },
      });
      expect(observed).toBe(true);
      expect(result.count).toBe(3077);
      expect(
        opened.db.scalar<number>(
          "SELECT count(*) FROM git_pack_entries WHERE pack_id = ?",
          result.packId,
        ),
      ).toBe(3077);
      expect(opened.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging")).toBe(0);
      const cold = reopenStore(opened.storage);
      const after = cold.db.all<Record<string, unknown>>("SELECT * FROM git_commits ORDER BY oid");
      expect(after.filter((row) => row.oid !== oversizedOid)).toEqual(before);
      expect(after.find((row) => row.oid === oversizedOid)).toMatchObject({
        message: null,
        gpgsig: null,
        object_size: oversized.length,
      });
      const object = cold.store.read(oversizedOid);
      expect(object?.type).toBe("commit");
      if (object === null) throw new Error("published oversized commit is missing");
      expect(Buffer.from(object.data).equals(oversized)).toBe(true);
      expect(cold.store.cachedCommit(oversizedOid)).toMatchObject({ messageStored: false });
    } finally {
      fixture.dispose();
    }
  });

  it("reclaims expired commit staging through pack ownership from another handle", async () => {
    const clock = { value: 10_000 };
    const now = () => clock.value;
    const opened = createStore(now);
    const data = utf8.encode(
      `tree ${"0".repeat(40)}\nauthor Fixture <fixture@example.com> 1577836800 +0000\ncommitter Fixture <fixture@example.com> 1577836800 +0000\n\nexpired\n`,
    );
    const bytes = lifecyclePack((writer) => {
      for (let i = 0; i < 3073; i++) writer.object("commit", data);
    }, 3073);
    const barrier = checkpointBarrier<boolean>("staged lease expiry", Boolean);
    const owner = opened.store.packs.ingest(singleChunk(bytes), {
      async yieldNow() {
        await barrier.checkpoint(
          opened.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging") === 1,
        );
      },
    });
    try {
      await awaitBarrierEntry(barrier, owner);
      const cold = reopenStore(opened.storage, now);
      await expect(reclaimPending(cold.store)).rejects.toMatchObject({ code: "EBUSY" });
      clock.value += PACK_INGEST_LEASE_MS;
      expect(await reclaimPending(cold.store)).toBe(1);
      expect(cold.db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging")).toBe(0);
      expect(cold.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(0);
      barrier.release();
      await expect(owner).rejects.toMatchObject({ code: "ESTALE" });
      await cold.store.packs.ingest(singleChunk(bytes));
      expect(
        reopenStore(opened.storage, now).store.cachedCommit(hashObject("commit", data))?.commit
          .message,
      ).toBe("expired\n");
    } finally {
      barrier.release();
      await Promise.allSettled([owner]);
    }
  });

  it("resolves a pending delta from its own base while another pack's copy is deleted", async () => {
    const opened = createStore();
    const base = utf8.encode("duplicated in-pack base\n");
    const target = utf8.encode("delta target over the duplicated base\n");
    const baseOid = hashObject("blob", base);
    const duplicate = await opened.store.packs.ingest(singleChunk(fullObjectPack([base])));
    const cold = reopenStore(opened.storage);
    // The delta precedes its base, so it stays pending until the drain reads the base.
    const bytes = lifecyclePack((writer) => {
      writer.refDelta(baseOid, lifecycleDelta(base.length, target));
      writer.object("blob", base);
      for (let i = 0; i < 1022; i++) writer.object("blob", utf8.encode(`own base filler ${i}\n`));
    }, 1024);
    let deleted = 0;
    // The pending pack's own base resolves the delta; only publication notices that
    // the base's canonical owner vanished, and that is the retryable ESTALE.
    await expect(
      cold.store.packs.ingest(singleChunk(bytes), {
        async yieldNow() {
          const pending = cold.db.scalar<number>("SELECT count(*) FROM git_pack_pending") ?? 0;
          if (deleted === 0 && pending > 0) {
            deleted = reopenStore(opened.storage).store.packs.deleteCompletePacks([
              duplicate.packId,
            ]);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "ESTALE" });
    expect(deleted).toBe(1);
    expect(cold.db.scalar<number>("SELECT count(*) FROM git_pack_pending")).toBe(0);
    await cold.store.packs.ingest(singleChunk(bytes));
    const reader = reopenStore(opened.storage).store;
    expect(reader.read(baseOid)?.data).toEqual(base);
    expect(reader.read(hashObject("blob", target))?.data).toEqual(target);
    expect(await reclaimPending(reader)).toBe(0);
  });

  it("fences a same-store overlap and preserves its duplicate fallback after retry", async () => {
    const opened = createStore();
    const targetData = utf8.encode("shared same-store target\n");
    const pending = checkpointPack(targetData, "active-same-store");
    opened.storage.resetCounters();
    const active = startPausedIngest(opened.store, pending, "same-store index checkpoint");
    await awaitBarrierEntry(active.barrier, active.owner);
    const activePrefixStatements = opened.storage.statementCount;
    const activePackId = active.packId();
    let rejectedStatements = 0;
    let activeTailStart = opened.storage.statementCount;
    try {
      expect(
        opened.db.one<{ pack_id: number; state: string }>(
          "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          opened.store.sharedRepoId,
          activePackId,
        ),
      ).toEqual({ pack_id: activePackId, state: "pending" });
      expect(packedOwner(opened.store, pending.targetOid)).toBe(activePackId);
      expect(opened.store.packs.completePackedEntry(pending.targetOid)).toBeNull();
      expect(opened.store.read(pending.targetOid)).toBeNull();
      const rejectedStart = opened.storage.statementCount;
      await expect(
        opened.store.packs.ingest(slices(fullObjectPack([targetData]), 4 * 1024)),
      ).rejects.toMatchObject({ code: "EBUSY" });
      rejectedStatements = opened.storage.statementCount - rejectedStart;
      activeTailStart = opened.storage.statementCount;
    } finally {
      active.barrier.release();
    }
    const first = await active.owner;
    const activeStatements =
      activePrefixStatements + opened.storage.statementCount - activeTailStart;
    expect(activeStatements).toBeLessThan(1_000);
    expect(rejectedStatements).toBeLessThan(1_000);
    const retryStart = opened.storage.statementCount;
    const retry = await opened.store.packs.ingest(slices(fullObjectPack([targetData]), 4 * 1024));
    expect(opened.storage.statementCount - retryStart).toBeLessThan(1_000);

    const cold = reopenStore(opened.storage);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(completePackMatches(cold.store, retry.packId, [blobMembership(targetData)])).toBe(true);
    expect(completePackMatches(cold.store, first.packId, pending.members)).toBe(true);
    expectCheckpointReadable(cold.store, pending);
    expect(cold.store.packs.deleteCompletePacks([first.packId])).toBe(1);
    expect(cold.store.read(pending.targetOid)?.data).toEqual(targetData);
    expect(
      cold.db.all<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        cold.store.sharedRepoId,
      ),
    ).toEqual([{ pack_id: retry.packId, state: "complete" }]);
  });

  it("does not let a separate store reclaim an ordinary pack paused after reservation", async () => {
    const first = createStore();
    const pending = checkpointPack(utf8.encode("active cross-store target\n"), "cross-store-b");
    first.storage.resetCounters();
    const active = startReservationPausedIngest(first.store, pending, "cross-store reservation");
    await awaitBarrierEntry(active.barrier, active.owner);
    const activePrefixStatements = first.storage.statementCount;
    const activePackId = active.packId();

    const competing = reopenStore(first.storage);
    const competitorOnly = utf8.encode("separate store competitor-only\n");
    let activeStateAfterWinner: string | null = null;
    let targetOwnerAfterWinner: number | null = null;
    let rejectedStatements = 0;
    let activeResumeStart = first.storage.statementCount;
    try {
      expect(
        first.db.one<{ pack_id: number; state: string }>(
          "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          first.store.sharedRepoId,
          activePackId,
        ),
      ).toEqual({ pack_id: activePackId, state: "pending" });
      expect(packedOwner(first.store, pending.targetOid)).toBeNull();
      expect(first.store.packs.completePackedEntry(pending.targetOid)).toBeNull();
      const rejectedStart = first.storage.statementCount;
      await expect(
        competing.store.packs.ingest(
          slices(fullObjectPack([pending.targetData, competitorOnly]), 4 * 1024),
        ),
      ).rejects.toMatchObject({ code: "EBUSY" });
      rejectedStatements = first.storage.statementCount - rejectedStart;
      activeStateAfterWinner =
        first.db.scalar<string>(
          "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          first.store.sharedRepoId,
          activePackId,
        ) ?? null;
      targetOwnerAfterWinner = packedOwner(first.store, pending.targetOid);
      activeResumeStart = first.storage.statementCount;
    } finally {
      active.barrier.release();
    }
    const completed = await active.owner;
    const activeStatements =
      activePrefixStatements + first.storage.statementCount - activeResumeStart;
    expect(rejectedStatements).toBeLessThan(1_000);
    expect(activeStatements).toBeLessThan(1_000);

    const cold = reopenStore(first.storage);
    const reclaimed = await reclaimPending(cold.store);
    expect({
      activePackId,
      activeStateAfterWinner,
      targetOwnerAfterWinner,
      winnerPackId: completed.packId,
      reclaimed,
      activeReadable: cold.store.read(pending.targetOid)?.data,
      competingReadable: cold.store.read(hashObject("blob", competitorOnly)),
    }).toEqual({
      activePackId: 1,
      activeStateAfterWinner: "pending",
      targetOwnerAfterWinner: null,
      winnerPackId: 1,
      reclaimed: 0,
      activeReadable: pending.targetData,
      competingReadable: null,
    });
    expect(completePackMatches(cold.store, completed.packId, pending.members)).toBe(true);
    expectCheckpointReadable(cold.store, pending);
  });

  it("fails closed when a paused owner's durable control row disappears", async () => {
    const opened = createStore();
    const pending = checkpointPack(utf8.encode("missing control target\n"), "missing-control");
    const active = startReservationPausedIngest(opened.store, pending, "missing control owner");
    await awaitBarrierEntry(active.barrier, active.owner);
    const activePackId = active.packId();
    opened.db.run(
      "DELETE FROM git_pack_ingest_control WHERE repo_id = ?",
      opened.store.sharedRepoId,
    );
    const competing = reopenStore(opened.storage);
    try {
      await expect(
        competing.store.packs.ingest(
          slices(fullObjectPack([utf8.encode("must not reserve\n")]), 64),
        ),
      ).rejects.toThrow(/pack ingest control is missing/);
      expect(
        opened.db.all<{ pack_id: number; state: string }>(
          "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
          opened.store.sharedRepoId,
        ),
      ).toEqual([{ pack_id: activePackId, state: "pending" }]);
    } finally {
      active.barrier.release();
    }
    await expect(active.owner).rejects.toMatchObject({ code: "ESTALE" });
    expect(
      opened.db.all<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        opened.store.sharedRepoId,
      ),
    ).toEqual([{ pack_id: activePackId, state: "pending" }]);
  });

  it("releases a failed owner so a separate store reclaims and retries its partial overlap", async () => {
    const opened = createStore();
    const targetData = utf8.encode("shared target already complete\n");
    const winnerOnlyData = utf8.encode("winner-only object\n");
    opened.storage.resetCounters();
    const winner = await opened.store.packs.ingest(
      slices(fullObjectPack([targetData, winnerOnlyData]), 4 * 1024),
    );
    const winnerStatements = opened.storage.statementCount;
    const pending = checkpointPack(targetData, "later-pending-b");
    const loserStart = opened.storage.statementCount;
    const loser = startPausedIngest(opened.store, pending, "later B index checkpoint", true);
    await awaitBarrierEntry(loser.barrier, loser.owner);
    const loserBeforeRelease = opened.storage.statementCount - loserStart;
    const loserPackId = loser.packId();
    let loserResumeStart = opened.storage.statementCount;
    try {
      expect(packedOwner(opened.store, pending.targetOid)).toBe(winner.packId);
      expect(packedOwner(opened.store, pending.uniqueOid)).toBe(loserPackId);
      expect(
        opened.db.scalar<string>(
          "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          opened.store.sharedRepoId,
          loserPackId,
        ),
      ).toBe("pending");
      loserResumeStart = opened.storage.statementCount;
    } finally {
      loser.barrier.release();
      await expect(loser.owner).rejects.toBe(loser.publicationFailure);
    }
    const loserStatements = loserBeforeRelease + (opened.storage.statementCount - loserResumeStart);
    expect(winnerStatements).toBeLessThan(1_000);
    expect(loserStatements).toBeLessThan(1_000);

    const retryStore = reopenStore(opened.storage);
    const retryStart = opened.storage.statementCount;
    let packsAtRetryReservation: { pack_id: number; state: string }[] = [];
    const retry = await retryStore.store.packs.ingest(slices(pending.bytes, 4 * 1024), {
      lifecycle: {
        reserved() {
          packsAtRetryReservation = retryStore.db.all<{ pack_id: number; state: string }>(
            "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
            retryStore.store.sharedRepoId,
          );
        },
        published() {},
      },
    });
    expect(opened.storage.statementCount - retryStart).toBeLessThan(1_000);
    expect(retry.packId).toBe(loserPackId + 1);
    expect(packsAtRetryReservation).toEqual([
      { pack_id: winner.packId, state: "complete" },
      { pack_id: retry.packId, state: "pending" },
    ]);

    const cold = reopenStore(opened.storage);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(
      completePackMatches(cold.store, winner.packId, [
        blobMembership(targetData),
        blobMembership(winnerOnlyData),
      ]),
    ).toBe(true);
    expect(completePackMatches(cold.store, retry.packId, pending.members)).toBe(true);
    expectCheckpointReadable(cold.store, pending);
    expect(cold.store.read(hashObject("blob", targetData))?.data).toEqual(targetData);
    expect(cold.store.read(hashObject("blob", winnerOnlyData))?.data).toEqual(winnerOnlyData);
    expect(cold.store.read(pending.uniqueOid)?.data).toEqual(pending.uniqueData);
    expect(
      cold.db.all<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        cold.store.sharedRepoId,
      ),
    ).toEqual([
      { pack_id: winner.packId, state: "complete" },
      { pack_id: retry.packId, state: "complete" },
    ]);
  });

  it("allows reentrant deletion during ingest", async () => {
    const opened = createStore();
    const retained = utf8.encode("retained during reentrant deletion\n");
    const published = utf8.encode("reentrant publication\n");
    const first = await opened.store.packs.ingest(slices(fullObjectPack([retained]), 64));
    let deleted = 0;
    opened.storage.resetCounters();
    const second = await opened.store.packs.ingest(slices(fullObjectPack([published]), 64), {
      lifecycle: {
        reserved() {},
        published() {
          deleted = opened.store.packs.deleteCompletePacks([first.packId]);
        },
      },
    });
    expect(deleted).toBe(1);
    expect(second.packId).toBe(first.packId + 1);
    expect(opened.storage.statementCount).toBeLessThan(1_000);
    expect(opened.store.read(hashObject("blob", retained))).toBeNull();
    expect(opened.store.read(hashObject("blob", published))?.data).toEqual(published);

    const cold = reopenStore(opened.storage);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(cold.store.read(hashObject("blob", retained))).toBeNull();
    expect(cold.store.read(hashObject("blob", published))?.data).toEqual(published);
    expect(completePackMatches(cold.store, second.packId, [blobMembership(published)])).toBe(true);
    expect(
      cold.db.all<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        cold.store.sharedRepoId,
      ),
    ).toEqual([{ pack_id: second.packId, state: "complete" }]);
  });

  it("reports ESTALE when a reentrant progress callback expires and reclaims its lease", async () => {
    const clock = { value: 20_000 };
    const now = () => clock.value;
    const first = createStore(now);
    const competing = reopenStore(first.storage, now);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(65_536);
    for (let index = 0; index < 65_536; index++) {
      writer.object("blob", utf8.encode(`reentrant-${index}\n`));
    }
    writer.finish();
    const pack = concat(chunks);
    let progressCalls = 0;
    const emptyPack = lifecyclePack(() => {}, 0);
    const probes: ReturnType<typeof competing.store.packs.ingest>[] = [];
    let reclaimed = false;
    first.storage.resetCounters();

    await expect(
      first.store.packs.ingest(singleChunk(pack), {
        now,
        onProgress(message) {
          if (!message.startsWith("Resolving deltas:")) return;
          progressCalls++;
          clock.value += PACK_INGEST_LEASE_MS;
          // Reservation runs synchronously, so the competitor reclaims the expired pack here.
          probes.push(competing.store.packs.ingest(singleChunk(emptyPack)));
          reclaimed =
            first.db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE pack_id = 1") === 0;
        },
      }),
    ).rejects.toMatchObject({ code: "ESTALE" });

    expect(progressCalls).toBe(1);
    expect(reclaimed).toBe(true);
    const [probe] = probes;
    if (probe === undefined) throw new Error("competitor did not reserve");
    competing.store.packs.deleteCompletePacks([(await probe).packId]);
    expect(first.storage.statementCount).toBeLessThan(1_000);
    const cold = reopenStore(first.storage, now);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(cold.db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
  });

  it("renews a progressing lease beyond its original expiry", async () => {
    const clock = { value: 30_000 };
    const startedAt = clock.value;
    const now = () => clock.value;
    const opened = createStore(now);
    const data = utf8.encode("lease renewal target\n");
    const pack = fullObjectPack([data]);
    const middle = Math.floor(pack.length / 2);
    const source = async function* (): AsyncGenerator<Uint8Array> {
      yield pack.subarray(0, middle);
      yield pack.subarray(middle);
    };
    const firstBarrier = checkpointBarrier<number>(
      "lease renewal first yield",
      (value) => value === 1,
    );
    const secondBarrier = checkpointBarrier<number>(
      "lease renewal second yield",
      (value) => value === 2,
    );
    let yields = 0;
    opened.storage.resetCounters();
    const owner = opened.store.packs.ingest(source(), {
      now,
      async yieldNow() {
        yields++;
        await firstBarrier.checkpoint(yields);
        await secondBarrier.checkpoint(yields);
      },
    });
    await awaitBarrierEntry(firstBarrier, owner);
    const prefixStatements = opened.storage.statementCount;
    clock.value = startedAt + Math.floor(PACK_INGEST_LEASE_MS / 2);
    const middleStart = opened.storage.statementCount;
    firstBarrier.release();
    await awaitBarrierEntry(secondBarrier, owner);
    const middleStatements = opened.storage.statementCount - middleStart;
    clock.value = startedAt + PACK_INGEST_LEASE_MS;

    const competing = reopenStore(opened.storage, now);
    const rejectedStart = opened.storage.statementCount;
    await expect(
      competing.store.packs.ingest(slices(fullObjectPack([data]), 64)),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(opened.storage.statementCount - rejectedStart).toBeLessThan(1_000);
    expect(
      opened.db.scalar<number>(
        "SELECT expires_ms FROM git_pack_ingest_control WHERE repo_id = ?",
        opened.store.sharedRepoId,
      ),
    ).toBe(startedAt + Math.floor(PACK_INGEST_LEASE_MS / 2) + PACK_INGEST_LEASE_MS);

    const tailStart = opened.storage.statementCount;
    secondBarrier.release();
    const completed = await owner;
    const activeStatements =
      prefixStatements + middleStatements + opened.storage.statementCount - tailStart;
    expect(activeStatements).toBeLessThan(1_000);
    const cold = reopenStore(opened.storage, now);
    expect(completePackMatches(cold.store, completed.packId, [blobMembership(data)])).toBe(true);
    expect(cold.store.read(hashObject("blob", data))?.data).toEqual(data);
  });

  it("fences an expired cross-store owner without reusing its pack id", async () => {
    const clock = { value: 10_000 };
    const now = () => clock.value;
    const first = createStore(now);
    const stale = checkpointPack(utf8.encode("expired owner target\n"), "expired-owner");
    first.storage.resetCounters();
    const active = startPausedIngest(first.store, stale, "expired owner index checkpoint");
    await awaitBarrierEntry(active.barrier, active.owner);
    const activePrefixStatements = first.storage.statementCount;
    expect(active.packId()).toBe(1);

    const competing = reopenStore(first.storage, now);
    const winnerData = utf8.encode("post-expiry winner\n");
    clock.value += PACK_INGEST_LEASE_MS - 1;
    const rejectedStart = first.storage.statementCount;
    await expect(
      competing.store.packs.ingest(
        slices(fullObjectPack([stale.targetData, winnerData]), 4 * 1024),
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(first.storage.statementCount - rejectedStart).toBeLessThan(1_000);

    clock.value++;
    const winnerStart = first.storage.statementCount;
    const winner = await competing.store.packs.ingest(
      slices(fullObjectPack([stale.targetData, winnerData]), 4 * 1024),
    );
    expect(first.storage.statementCount - winnerStart).toBeLessThan(1_000);
    expect(winner.packId).toBe(2);
    const staleTailStart = first.storage.statementCount;
    active.barrier.release();
    await expect(active.owner).rejects.toMatchObject({ code: "ESTALE" });
    expect(activePrefixStatements + first.storage.statementCount - staleTailStart).toBeLessThan(
      1_000,
    );

    const cold = reopenStore(first.storage, now);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(await reclaimPending(cold.store)).toBe(0);
    expect(cold.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE pack_id = 1")).toBe(0);
    expect(cold.store.read(stale.targetOid)?.data).toEqual(stale.targetData);
    expect(cold.store.read(hashObject("blob", winnerData))?.data).toEqual(winnerData);
    expect(
      completePackMatches(cold.store, winner.packId, [
        blobMembership(stale.targetData),
        blobMembership(winnerData),
      ]),
    ).toBe(true);
  });
});
