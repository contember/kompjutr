import { describe, expect, it, vi } from "vitest";
import { concat, utf8 } from "../../packages/git/src/common/bytes.js";
import { maintainRepository } from "../../packages/git/src/ops/repository/maintenance.js";
import { planTransfer } from "../../packages/git/src/ops/server/transfer.js";
import { streamTransferPack } from "../../packages/git/src/ops/server/transfer-stream.js";
import { SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import { readMaintenanceRootEpoch } from "../../packages/git/src/store/maintenance/control.js";
import { rootsFromTransfers } from "../../packages/git/src/store/maintenance/roots/root-transfer-pages.js";
import { PackWriter } from "../../packages/git/src/store/pack/writer.js";
import { advanceTransfer } from "../../packages/git/src/store/transfer/closure.js";
import {
  assertTransfer,
  cleanupTransfers,
  createTransfer,
  releaseTransfer,
  renewTransfer,
} from "../../packages/git/src/store/transfer/lifetime.js";
import { TestDatabase } from "../helpers/db.js";
import { slices } from "../helpers/git.js";

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const store = database.createBareRepository();
  return { db, database, store };
}
function maintain(database: SqliteGitDatabase, repoId: number, nowMs: number) {
  for (let i = 0; i < 1000; i++) {
    const result = maintainRepository(database, repoId, { nowMs });
    if (result.status === "complete") return result;
  }
  throw new Error("maintenance made no progress");
}

describe("server transfer lifetime", () => {
  it("retains expired roots until explicit cleanup, fencing maintenance on acquire and release", () => {
    const { db, database, store } = open();
    const oid = store.write("blob", utf8.encode("retained"));
    const before = readMaintenanceRootEpoch(db, store.repoId);
    const owner = createTransfer(store, { wanted: [{ oid }], nowMs: 100, ttlMs: 10 });
    expect(readMaintenanceRootEpoch(db, store.repoId)).toBe(before + 1);
    renewTransfer(store, owner, 105, 10);
    expect(readMaintenanceRootEpoch(db, store.repoId)).toBe(before + 1);
    expect(rootsFromTransfers(db, store.repoId, null, 128).candidates).toEqual([
      { oid, expectedType: null, optionalMissing: false },
    ]);
    expect(() => renewTransfer(store, owner, 120)).toThrow(/expired/);
    expect(() => advanceTransfer(store, owner, 120)).toThrow(/expired/);
    cleanupTransfers(store, 120);
    expect(readMaintenanceRootEpoch(db, store.repoId)).toBe(before + 2);
    expect(maintain(database, store.repoId, 121).reachableObjects).toBe(0);
    maintain(database, store.repoId, 121 + 15 * 24 * 60 * 60 * 1000);
    expect(store.read(oid)).toBeNull();
  });

  it("rejects shallow state and unresolved promises, but accepts promisor configuration alone", () => {
    const { store } = open();
    const missing = "1234567890123456789012345678901234567890";
    const options = { wanted: [], nowMs: 100 };
    store.setShallow([missing]);
    expect(() => createTransfer(store, options)).toThrow(/complete repository/);
    store.setShallow([], [missing]);
    store.registerPromisorRemote("origin", "https://example.com/repository.git");
    const owner = createTransfer(store, options);
    releaseTransfer(store, owner);
    store.addPromisedBlobs("origin", [missing]);
    expect(() => createTransfer(store, options)).toThrow(/unresolved promises/);
  });

  it("cold reopens owners, rejects other repositories, and cleans cancellation in bounded pages", () => {
    const { db, database, store } = open();
    const roots = Array.from({ length: 300 }, (_, index) => ({
      oid: store.write("blob", utf8.encode(String(index))),
    }));
    const owner = createTransfer(store, { wanted: roots, nowMs: 100 });
    const reopened = new SqliteGitDatabase(db).openBareRepository(store.repoId);
    expect(() => assertTransfer(reopened, owner, 101)).not.toThrow();
    expect(() => assertTransfer(database.createBareRepository(), owner, 101)).toThrow(/repository/);
    releaseTransfer(reopened, owner);
    expect(db.scalar<number>("SELECT count(*) FROM git_transfer_objects")).toBe(300);
    cleanupTransfers(reopened, 101);
    expect(db.scalar<number>("SELECT count(*) FROM git_transfer_objects")).toBe(172);
    while (!cleanupTransfers(reopened, 101)) {}
    expect(db.scalar<number>("SELECT count(*) FROM git_transfers")).toBe(0);
    const next = createTransfer(reopened, { wanted: [], nowMs: 101 });
    expect(next.transferId).toBeGreaterThan(owner.transferId);
  });

  it("checks an owner after output backpressure before reading the next object", async () => {
    const { store } = open();
    const oid = store.write("blob", utf8.encode("body"));
    const owner = await planTransfer(store, { wanted: [{ oid }] });
    const reader = vi.spyOn(store, "readObjects");
    const stream = streamTransferPack(store, owner);
    expect((await stream.next()).done).toBe(false);
    expect(reader).not.toHaveBeenCalled();
    releaseTransfer(store, owner);
    await expect(stream.next()).rejects.toThrow(/released/);
    expect(reader).not.toHaveBeenCalled();
  });

  it("schedules the next maintenance alarm at an abandoned owner's expiry", () => {
    const { store, database, db } = open();
    const oid = store.write("blob", utf8.encode("body"));
    createTransfer(store, { wanted: [{ oid }], nowMs: 100, ttlMs: 10 });
    expect(maintain(database, store.repoId, 100).nextEligibleAt).toBe(110);
    expect(maintainRepository(database, store.repoId, { nowMs: 110 }).phase).toBe("transfers");
    maintain(database, store.repoId, 110);
    expect(db.scalar<number>("SELECT count(*) FROM git_transfers")).toBe(0);
  });

  it("releases a started stream on return and removes its plan through maintenance", async () => {
    const { store, database, db } = open();
    const oid = store.write("blob", utf8.encode("body"));
    const owner = await planTransfer(store, { wanted: [{ oid }] });
    const stream = streamTransferPack(store, owner);
    await stream.next();
    await stream.return(undefined);
    expect(() => assertTransfer(store, owner, Date.now())).toThrow(/released/);
    expect(maintainRepository(database, store.repoId, { nowMs: Date.now() }).phase).toBe(
      "transfers",
    );
    maintain(database, store.repoId, Date.now());
    expect(db.scalar<number>("SELECT count(*) FROM git_transfers")).toBe(0);
  });

  it("fails before reading after a paused stream expires and cleans expired owners after cold reopen", async () => {
    const { store, database, db } = open();
    const oid = store.write("blob", utf8.encode("body"));
    let now = 100;
    const owner = await planTransfer(store, { wanted: [{ oid }], ttlMs: 10 }, { now: () => now });
    const stream = streamTransferPack(store, owner, { now: () => now });
    const read = vi.spyOn(store, "readObjects");
    await stream.next();
    now = 110;
    await expect(stream.next()).rejects.toThrow(/expired/);
    expect(read).not.toHaveBeenCalled();
    const coldOwner = createTransfer(store, { wanted: [{ oid }], nowMs: now, ttlMs: 1 });
    const reopened = new SqliteGitDatabase(db);
    expect(maintainRepository(reopened, store.repoId, { nowMs: 111 }).phase).toBe("transfers");
    maintain(reopened, store.repoId, 111);
    expect(() =>
      assertTransfer(database.openBareRepository(store.repoId), coldOwner, 111),
    ).toThrow();
    expect(db.scalar<number>("SELECT count(*) FROM git_transfer_objects")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_transfer_roots")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_transfers")).toBe(0);
  });

  it("retains removed refs through real GC until the stream releases its roots", async () => {
    const database = new SqliteGitDatabase(new TestDatabase(), { now: () => 100 });
    const store = database.createBareRepository();
    const oid = store.write("blob", utf8.encode("retained across gc"));
    store.setRef("refs/tags/retained", oid);
    const day = 24 * 60 * 60 * 1000;
    const owner = await planTransfer(
      store,
      { wanted: [{ oid }], ttlMs: 365 * day },
      { now: () => 100 },
    );
    const stream = streamTransferPack(store, owner, { now: () => 100 + 120 * day });
    const output: Uint8Array[] = [];
    const first = await stream.next();
    if (first.done) throw new Error("stream ended before its header");
    output.push(first.value);
    store.deleteRef("refs/tags/retained");
    maintain(database, store.repoId, 100 + day);
    maintain(database, store.repoId, 100 + 120 * day);
    expect(store.read(oid)).not.toBeNull();
    for await (const chunk of stream) output.push(chunk);
    const receiver = open().store;
    await receiver.packs.ingest(slices(concat(output), 8192));
    expect(receiver.read(oid)?.data).toEqual(utf8.encode("retained across gc"));
    maintain(database, store.repoId, 100 + 121 * day);
    maintain(database, store.repoId, 100 + 136 * day);
    expect(store.read(oid)).toBeNull();
  });

  it("cascades transfer rows on destroy and lets cancellation release the revoked owner", async () => {
    const { store, db } = open();
    const oid = store.write("blob", utf8.encode("body"));
    const owner = await planTransfer(store, { wanted: [{ oid }] });
    const stream = streamTransferPack(store, owner);
    await stream.next();
    store.destroy();
    expect(() => releaseTransfer(store, owner)).not.toThrow();
    await expect(stream.return(undefined)).resolves.toEqual({ done: true, value: undefined });
    expect(db.scalar<number>("SELECT count(*) FROM git_transfers")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_transfer_objects")).toBe(0);
    expect(() => releaseTransfer(store, { ...owner, repoId: owner.repoId + 1 })).toThrow(
      /repository/,
    );
  });

  it("keeps streaming when maintenance changes an oversized object's physical source", async () => {
    const { store, db } = open();
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(42);
    const oid = store.write("blob", bytes);
    const replacement: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => replacement.push(chunk));
    writer.header(1);
    writer.object("blob", bytes);
    writer.finish();
    const owner = await planTransfer(store, { wanted: [{ oid }] });
    let changed = false;
    const output: Uint8Array[] = [];
    for await (const chunk of streamTransferPack(store, owner, {
      yieldNow: async () => {
        if (changed) return;
        changed = true;
        await store.packs.ingest(slices(concat(replacement), 8192));
        // Simulate the same source replacement as maintenance after the object was read.
        db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", store.repoId, oid);
        store.clearCaches();
      },
    }))
      output.push(chunk);
    expect(changed).toBe(true);
    const receiver = open().store;
    await receiver.packs.ingest(slices(concat(output), 8192));
    expect(receiver.read(oid)?.data).toEqual(bytes);
  });
});
