import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../src/git/common/bytes.js";
import { hashObject } from "../src/git/common/objects.js";
import { type CheckoutStore, SqliteGitDatabase } from "../src/git/store/index.js";
import { PackWriter } from "../src/git/store/pack/writer.js";
import {
  type CompletePackObject,
  PACK_INGEST_LEASE_MS,
  type PackIngestResult,
} from "../src/git/store/packs.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";
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
  readonly members: readonly CompletePackObject[];
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
  const members: CompletePackObject[] = [blobMembership(targetData)];
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

function blobMembership(data: Uint8Array): CompletePackObject {
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
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.packs.completePackMatches(retry.packId, [blobMembership(targetData)])).toBe(
      true,
    );
    expect(cold.store.packs.completePackMatches(first.packId, pending.members)).toBe(true);
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
    const reclaimed = cold.store.packs.reclaimPending();
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
    expect(cold.store.packs.completePackMatches(completed.packId, pending.members)).toBe(true);
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
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(
      cold.store.packs.completePackMatches(winner.packId, [
        blobMembership(targetData),
        blobMembership(winnerOnlyData),
      ]),
    ).toBe(true);
    expect(cold.store.packs.completePackMatches(retry.packId, pending.members)).toBe(true);
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

  it("rejects publication that depends on another owner's pending membership", async () => {
    const first = createStore();
    const pending = checkpointPack(utf8.encode("pending canonical owner\n"), "pending-canonical");
    first.storage.resetCounters();
    const active = startPausedIngest(first.store, pending, "pending canonical checkpoint");
    await awaitBarrierEntry(active.barrier, active.owner);
    const activePrefixStatements = first.storage.statementCount;

    const competing = reopenStore(first.storage);
    const rejectedStart = first.storage.statementCount;
    await expect(
      competing.store.packs.ingest(slices(fullObjectPack([pending.targetData]), 4 * 1024), {
        reclaimPending: false,
      }),
    ).rejects.toMatchObject({ code: "ESTALE" });
    expect(first.storage.statementCount - rejectedStart).toBeLessThan(1_000);
    expect(
      first.db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = 2",
        first.store.sharedRepoId,
      ),
    ).toBe("pending");

    const activeTailStart = first.storage.statementCount;
    active.barrier.release();
    const winner = await active.owner;
    expect(activePrefixStatements + first.storage.statementCount - activeTailStart).toBeLessThan(
      1_000,
    );
    const cold = reopenStore(first.storage);
    expect(cold.store.packs.reclaimPending()).toBe(1);
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.read(pending.targetOid)?.data).toEqual(pending.targetData);
    expect(cold.store.packs.completePackMatches(winner.packId, pending.members)).toBe(true);
    expectCheckpointReadable(cold.store, pending);
    expect(
      cold.db.all<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        cold.store.sharedRepoId,
      ),
    ).toEqual([{ pack_id: winner.packId, state: "complete" }]);
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
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.read(hashObject("blob", retained))).toBeNull();
    expect(cold.store.read(hashObject("blob", published))?.data).toEqual(published);
    expect(cold.store.packs.completePackMatches(second.packId, [blobMembership(published)])).toBe(
      true,
    );
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
    let reclaimed = -1;
    first.storage.resetCounters();

    await expect(
      first.store.packs.ingest(singleChunk(pack), {
        now,
        onProgress(message) {
          if (!message.startsWith("Resolving deltas:")) return;
          progressCalls++;
          clock.value += PACK_INGEST_LEASE_MS;
          reclaimed = competing.store.packs.reclaimPending();
        },
      }),
    ).rejects.toMatchObject({ code: "ESTALE" });

    expect(progressCalls).toBe(1);
    expect(reclaimed).toBe(1);
    expect(first.storage.statementCount).toBeLessThan(1_000);
    const cold = reopenStore(first.storage, now);
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.packs.reclaimPending()).toBe(0);
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
    expect(cold.store.packs.completePackMatches(completed.packId, [blobMembership(data)])).toBe(
      true,
    );
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
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.store.packs.reclaimPending()).toBe(0);
    expect(cold.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE pack_id = 1")).toBe(0);
    expect(cold.store.read(stale.targetOid)?.data).toEqual(stale.targetData);
    expect(cold.store.read(hashObject("blob", winnerData))?.data).toEqual(winnerData);
    expect(
      cold.store.packs.completePackMatches(winner.packId, [
        blobMembership(stale.targetData),
        blobMembership(winnerData),
      ]),
    ).toBe(true);
  });
});
