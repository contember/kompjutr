import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import { hashObject, MODE_FILE, serializeCommit, serializeTree } from "../src/core/objects.js";
import { encodeDeltaHeader } from "../src/core/pack/delta.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { blob, readBlob, type SqlDatabase } from "../src/sqlite/db.js";
import {
  advanceMaintenanceRepack,
  type MaintenanceRepackOptions,
  settleMaintenanceRepackForRestart,
} from "../src/sqlite/maintenance/repack.js";
import { type CompletePackObject, MAX_PACK_BLOB_BATCH_BYTES } from "../src/sqlite/packs.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";
import { awaitBarrierEntry, checkpointBarrier } from "./helpers/interleaving.js";

const PERSON = {
  name: "Repack Fixture",
  email: "repack@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};
const REPACK_OPTIONS: MaintenanceRepackOptions = { nowMs: 1 };

class AvailabilityFailureDatabase implements SqlDatabase {
  corruptAvailability = false;

  constructor(readonly inner: TestDatabase) {}

  get storage() {
    return this.inner.storage;
  }

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

interface MarkInput {
  oid: string;
  physicalOnly?: boolean;
}

function open(db = new TestDatabase()) {
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 8 * 1024 * 1024 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { db, database, checkout, store };
}

function seedRepack(db: TestDatabase, repoId: number, marks: readonly MarkInput[]): void {
  const logical = marks.filter((mark) => mark.physicalOnly !== true).length;
  db.run(
    `INSERT OR IGNORE INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 2)`,
    repoId,
  );
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
        reachable_objects, queued_objects)
     VALUES (?, 1, 0, 'repack', 1, 'done', ?, 0)`,
    repoId,
    logical,
  );
  db.run(
    `INSERT INTO git_maintenance_objects
       (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
        physical_only, edge_cursor)
     SELECT ?, 1, json_extract(value, '$.oid'), 1, 1, 0,
            json_extract(value, '$.physicalOnly'), 0
       FROM json_each(?)`,
    repoId,
    JSON.stringify(
      marks.map((mark) => ({ oid: mark.oid, physicalOnly: mark.physicalOnly === true ? 1 : 0 })),
    ),
  );
}

function fullObjectPack(type: "blob" | "tree" | "commit" | "tag", data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object(type, data);
  writer.finish();
  return concat(chunks);
}

function deterministicBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < out.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 0xff;
  }
  return out;
}

function copyDelta(baseSize: number, offset: number, size: number): Uint8Array {
  return concat([
    encodeDeltaHeader(baseSize, size),
    new Uint8Array([
      0xff,
      offset & 0xff,
      (offset >>> 8) & 0xff,
      (offset >>> 16) & 0xff,
      (offset >>> 24) & 0xff,
      size & 0xff,
      (size >>> 8) & 0xff,
      (size >>> 16) & 0xff,
    ]),
  ]);
}

interface SharedOversizedDeltaFixture {
  basePackId: number;
  deltaPackId: number;
  targets: CompletePackObject[];
}

async function sharedOversizedDeltaFixture(
  store: ReturnType<typeof open>["store"],
): Promise<SharedOversizedDeltaFixture> {
  const base = deterministicBytes(MAX_PACK_BLOB_BATCH_BYTES + 64 * 1024);
  const baseOid = hashObject("blob", base);
  const basePack = await store.packs.ingest(slices(fullObjectPack("blob", base), 64 * 1024));
  const targetSize = 2 * 1024 * 1024 + 64 * 1024;
  const count = 22;
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(count);
  const targets: CompletePackObject[] = [];
  for (let index = 0; index < count; index++) {
    const offset = index * 4096;
    const data = base.subarray(offset, offset + targetSize);
    writer.refDelta(baseOid, copyDelta(base.length, offset, targetSize));
    targets.push({ oid: hashObject("blob", data), type: "blob", size: data.length });
  }
  writer.finish();
  const deltaPack = await store.packs.ingest(slices(concat(chunks), 64 * 1024));
  const compressedBase = store.db.scalar<number>(
    "SELECT data_len FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND oid = ?",
    store.repoId,
    basePack.packId,
    baseOid,
  );
  if (compressedBase === undefined || compressedBase <= MAX_PACK_BLOB_BATCH_BYTES) {
    throw new Error("maintenance shared delta base is not oversized");
  }
  return { basePackId: basePack.packId, deltaPackId: deltaPack.packId, targets };
}

function commit(tree: string, message = "repacked\n"): Uint8Array {
  return serializeCommit({
    tree,
    parent: [],
    author: PERSON,
    committer: PERSON,
    message,
  });
}

function corruptPackEntryBytes(
  db: TestDatabase,
  repoId: number,
  packId: number,
  oid: string,
): void {
  const entry = db.one<{ data_off: number }>(
    "SELECT data_off FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND oid = ?",
    repoId,
    packId,
    oid,
  );
  const row = db.one<{ data: unknown }>(
    "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = 0",
    repoId,
    packId,
  );
  if (entry === undefined || row === undefined)
    throw new Error("pack corruption fixture is missing");
  const data = readBlob(row.data).slice();
  data[entry.data_off]! ^= 0xff;
  db.run(
    "UPDATE git_pack_data SET data = ? WHERE repo_id = ? AND pack_id = ? AND seq = 0",
    blob(data),
    repoId,
    packId,
  );
}

async function advanceBelowStatementLimit(
  db: TestDatabase,
  shared: ReturnType<typeof open>["store"]["shared"],
  options: MaintenanceRepackOptions = REPACK_OPTIONS,
) {
  db.storage.resetCounters();
  const result = await advanceMaintenanceRepack(shared, options);
  expect(db.storage.statementCount).toBeLessThan(900);
  return result;
}

describe("maintenance repack", () => {
  it("publishes and finalizes a mixed logical and physical loose batch across cold reopens", async () => {
    const { db, checkout, store } = open();
    const blobData = utf8.encode("reachable blob\n");
    const blob = store.write("blob", blobData);
    const treeData = serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]);
    const tree = store.write("tree", treeData);
    const commitData = commit(tree);
    const commitOid = store.write("commit", commitData);
    seedRepack(db, checkout.repoId, [
      { oid: commitOid },
      { oid: tree },
      { oid: blob, physicalOnly: true },
    ]);
    const binaryOrder = db.all<{ oid: string }>(
      "SELECT oid FROM git_objects WHERE repo_id = ? ORDER BY oid COLLATE BINARY",
      checkout.repoId,
    );

    expect(await advanceBelowStatementLimit(db, store.shared)).toMatchObject({
      status: "progress",
      boundary: "selected",
      objectCount: 3,
    });
    expect(
      db.all<{ oid: string }>(
        `SELECT oid FROM git_maintenance_repack_objects
          WHERE repo_id = ? ORDER BY ordinal`,
        checkout.repoId,
      ),
    ).toEqual(binaryOrder);
    expect(await advanceBelowStatementLimit(db, store.shared)).toMatchObject({
      status: "progress",
      boundary: "published",
      objectCount: 3,
    });
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", checkout.repoId),
    ).toBe(3);

    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 8 * 1024 * 1024 });
    const cold = reopened.openCheckout(checkout.id);
    const finalized = await advanceBelowStatementLimit(db, cold.shared);
    expect(finalized).toMatchObject({
      status: "progress",
      boundary: "finalized",
      objectCount: 3,
    });
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_object_chunks WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_loose_object_lifecycle WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(0);
    expect(cold.read(blob)?.data).toEqual(blobData);
    expect(cold.read(tree)?.data).toEqual(treeData);
    expect(cold.read(commitOid)?.data).toEqual(commitData);
    expect(cold.cachedCommit(commitOid)?.commit.tree).toBe(tree);
    expect(
      db.one<{ storage: string; source_id: number }>(
        `SELECT source.storage, source.source_id
           FROM git_tree_effective effective
           JOIN git_tree_sources source ON source.source_key = effective.source_key
          WHERE effective.repo_id = ? AND effective.tree_oid = ?`,
        checkout.repoId,
        tree,
      ),
    ).toEqual({ storage: "pack", source_id: finalized.packId });
    expect(
      db.one<{ repacked_objects: number; reachable_objects: number; queued_objects: number }>(
        `SELECT repacked_objects, reachable_objects, queued_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ repacked_objects: 3, reachable_objects: 2, queued_objects: 0 });
    expect(await advanceBelowStatementLimit(db, cold.shared)).toMatchObject({
      status: "complete",
      boundary: null,
    });
    expect(
      db.scalar<string>(
        "SELECT phase FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe("classify-packs");
  });

  it("recovers an owned pending ingest exactly and republishes the durable selection", async () => {
    const { db, checkout, store } = open();
    const data = utf8.encode("pending recovery\n");
    const oid = store.write("blob", data);
    seedRepack(db, checkout.repoId, [{ oid }]);
    await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);

    await expect(
      advanceMaintenanceRepack(store.shared, {
        nowMs: 1,
        yieldNow: () => Promise.reject(new Error("crash after reservation")),
      }),
    ).rejects.toThrow(/crash after reservation/);
    expect(
      db.one<{ state: string; pack_id: number }>(
        "SELECT state, pack_id FROM git_maintenance_repack_batches WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ state: "pending", pack_id: 1 });
    expect(store.packs.completePackedEntry(oid)).toBeNull();
    expect(store.read(oid)?.data).toEqual(data);

    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const cold = reopened.openCheckout(checkout.id);
    expect(await advanceBelowStatementLimit(db, cold.shared)).toMatchObject({
      boundary: "selected",
      packId: null,
    });
    expect(
      db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(await advanceBelowStatementLimit(db, cold.shared)).toMatchObject({
      boundary: "published",
      packId: 2,
    });
    expect(await advanceBelowStatementLimit(db, cold.shared)).toMatchObject({
      boundary: "finalized",
      packId: 2,
    });
    expect(cold.read(oid)?.data).toEqual(data);
  });

  it("finalizes an existing complete-pack shadow without creating a duplicate pack", async () => {
    const { db, checkout, store } = open();
    const data = utf8.encode("already packed\n");
    const oid = store.write("blob", data);
    const packed = await store.packs.ingest(slices(fullObjectPack("blob", data), 11));
    seedRepack(db, checkout.repoId, [{ oid }]);

    const finalized = await advanceBelowStatementLimit(db, store.shared);

    expect(finalized).toMatchObject({
      boundary: "finalized",
      batchId: null,
      packId: null,
      objectCount: 1,
    });
    expect(
      db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE repo_id = ?", checkout.repoId),
    ).toBe(1);
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(packed.packId);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(store.read(oid)?.data).toEqual(data);

    const interleaved = open();
    const interleavedData = utf8.encode("packed after selection\n");
    const interleavedOid = interleaved.store.write("blob", interleavedData);
    seedRepack(interleaved.db, interleaved.checkout.repoId, [{ oid: interleavedOid }]);
    expect(
      await advanceBelowStatementLimit(interleaved.db, interleaved.store.shared),
    ).toMatchObject({
      boundary: "selected",
    });
    await interleaved.store.packs.ingest(slices(fullObjectPack("blob", interleavedData), 11));

    expect(
      await advanceBelowStatementLimit(interleaved.db, interleaved.store.shared),
    ).toMatchObject({
      boundary: "finalized",
      objectCount: 1,
    });
    expect(interleaved.db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(1);
    expect(
      interleaved.db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches"),
    ).toBe(0);
    expect(interleaved.store.read(interleavedOid)?.data).toEqual(interleavedData);
  });

  it("finalizes against an ordinary owner that publishes during maintenance ingest", async () => {
    const { db, checkout, store } = open();
    const data = utf8.encode("ordinary owner during maintenance publication\n");
    const oid = store.write("blob", data);
    seedRepack(db, checkout.repoId, [{ oid }]);
    expect(await advanceBelowStatementLimit(db, store.shared)).toMatchObject({
      boundary: "selected",
      objectCount: 1,
    });

    let yields = 0;
    const barrier = checkpointBarrier<number>("maintenance pack reserved", (value) => value === 1);
    const publishing = advanceMaintenanceRepack(store.shared, {
      nowMs: 1,
      yieldNow: () => barrier.checkpoint(++yields),
    });
    await awaitBarrierEntry(barrier, publishing);
    const pendingPackId = db.scalar<number>(
      "SELECT pack_id FROM git_maintenance_repack_batches WHERE repo_id = ?",
      checkout.repoId,
    );
    expect(pendingPackId).toBe(1);

    const competingDatabase = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const competingCheckout = competingDatabase.findCheckout("/repo");
    if (competingCheckout === null) throw new Error("maintenance checkout disappeared");
    const competing = competingDatabase.openCheckout(competingCheckout);
    const ordinary = await competing.packs.ingest(slices(fullObjectPack("blob", data), 11));
    expect(ordinary.packId).toBe(2);
    barrier.release();
    expect(await publishing).toMatchObject({
      boundary: "published",
      packId: pendingPackId,
      objectCount: 1,
    });

    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const reopenedCheckout = reopened.findCheckout("/repo");
    if (reopenedCheckout === null) throw new Error("maintenance checkout disappeared on restart");
    const cold = reopened.openCheckout(reopenedCheckout);
    expect(await advanceBelowStatementLimit(db, cold.shared)).toMatchObject({
      boundary: "finalized",
      packId: pendingPackId,
      objectCount: 1,
    });
    expect(
      db.all<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        checkout.repoId,
      ),
    ).toEqual([{ pack_id: ordinary.packId, state: "complete" }]);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(cold.packs.completePackedEntry(oid)?.packId).toBe(ordinary.packId);
    expect(cold.read(oid)?.data).toEqual(data);
  });

  it("fails closed on corrupt complete-shadow metadata", async () => {
    const { db, checkout, store } = open();
    const data = utf8.encode("corrupt shadow\n");
    const oid = store.write("blob", data);
    const packed = await store.packs.ingest(slices(fullObjectPack("blob", data), 11));
    seedRepack(db, checkout.repoId, [{ oid }]);
    db.run(
      "UPDATE git_pack_objects SET size = size + 1 WHERE repo_id = ? AND pack_id = ?",
      checkout.repoId,
      packed.packId,
    );

    await expect(advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).rejects.toThrow(
      /shadow has the wrong size/,
    );
    expect(store.read(oid)?.data).toEqual(data);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(
      db.scalar<number>(
        "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(0);
  });

  it("requires every exact loose and lifecycle row before any finalization deletion", async () => {
    for (const corruption of ["published-loose", "published-lifecycle", "shadow-lifecycle"]) {
      const { db, checkout, store } = open();
      const firstData = utf8.encode(`${corruption} first\n`);
      const secondData = utf8.encode(`${corruption} second\n`);
      const first = store.write("blob", firstData);
      const second = store.write("blob", secondData);
      seedRepack(
        db,
        checkout.repoId,
        corruption === "shadow-lifecycle" ? [{ oid: first }] : [{ oid: first }, { oid: second }],
      );

      if (corruption === "shadow-lifecycle") {
        await store.packs.ingest(slices(fullObjectPack("blob", firstData), 11));
        db.run(
          "DELETE FROM git_loose_object_lifecycle WHERE repo_id = ? AND oid = ?",
          checkout.repoId,
          first,
        );
      } else {
        await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
        await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
        if (corruption === "published-loose") {
          db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", checkout.repoId, first);
        } else {
          db.run(
            "DELETE FROM git_loose_object_lifecycle WHERE repo_id = ? AND oid = ?",
            checkout.repoId,
            first,
          );
        }
      }

      await expect(advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).rejects.toThrow(
        /loose deletion set is incomplete/,
      );
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
          checkout.repoId,
          second,
        ),
      ).toBe(1);
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM git_loose_object_lifecycle WHERE repo_id = ? AND oid = ?",
          checkout.repoId,
          second,
        ),
      ).toBe(1);
      expect(
        db.scalar<number>(
          "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
          checkout.repoId,
        ),
      ).toBe(0);
      if (corruption !== "shadow-lifecycle") {
        expect(
          db.scalar<string>(
            "SELECT state FROM git_maintenance_repack_batches WHERE repo_id = ?",
            checkout.repoId,
          ),
        ).toBe("published");
      }
    }
  });

  it("finalizes a valid published maintenance pack with pack id zero", async () => {
    const { db, checkout, store } = open();
    const data = utf8.encode("zero pack\n");
    const oid = store.write("blob", data);
    const original = await store.packs.ingest(slices(fullObjectPack("blob", data), 13));
    expect(original.packId).toBe(1);
    db.transactionSync(() => {
      db.run(
        `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
         SELECT repo_id, 0, size, count, state, created
           FROM git_pack_meta WHERE repo_id = ? AND pack_id = 1`,
        checkout.repoId,
      );
      db.run(
        `INSERT INTO git_pack_data (repo_id, pack_id, seq, data)
         SELECT repo_id, 0, seq, data FROM git_pack_data WHERE repo_id = ? AND pack_id = 1`,
        checkout.repoId,
      );
      db.run(
        `INSERT INTO git_pack_entries
           (repo_id, pack_id, oid, offset, data_off, data_len, type, size, entry_size, base_oid)
         SELECT repo_id, 0, oid, offset, data_off, data_len, type, size, entry_size, base_oid
           FROM git_pack_entries WHERE repo_id = ? AND pack_id = 1`,
        checkout.repoId,
      );
      db.run(
        "UPDATE git_pack_objects SET pack_id = 0 WHERE repo_id = ? AND pack_id = 1",
        checkout.repoId,
      );
      db.run("DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = 1", checkout.repoId);
    });
    seedRepack(db, checkout.repoId, [{ oid }]);
    db.run(
      `INSERT INTO git_maintenance_repack_batches
         (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
       SELECT ?, 1, 1, 'published', 0, 1, ?, size
         FROM git_pack_meta WHERE repo_id = ? AND pack_id = 0`,
      checkout.repoId,
      data.length,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_repack_objects
         (repo_id, run_id, batch_id, oid, ordinal, type, size)
       VALUES (?, 1, 1, ?, 0, 'blob', ?)`,
      checkout.repoId,
      oid,
      data.length,
    );

    db.transactionSync(() => {
      settleMaintenanceRepackForRestart(store.shared, 1);
    });
    settleMaintenanceRepackForRestart(store.shared, 1);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(
      db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = 0",
        checkout.repoId,
      ),
    ).toBe("complete");
    expect(store.read(oid)?.data).toEqual(data);

    db.run(
      `INSERT INTO git_maintenance_repack_batches
         (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
       SELECT ?, 1, 1, 'published', 0, 1, ?, size
         FROM git_pack_meta WHERE repo_id = ? AND pack_id = 0`,
      checkout.repoId,
      data.length,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_repack_objects
         (repo_id, run_id, batch_id, oid, ordinal, type, size)
       VALUES (?, 1, 1, ?, 0, 'blob', ?)`,
      checkout.repoId,
      oid,
      data.length,
    );

    expect(await advanceBelowStatementLimit(db, store.shared)).toMatchObject({
      boundary: "finalized",
      packId: 0,
    });
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("enforces count, inflated, stored-output, and statement bounds", async () => {
    const { db, checkout, store } = open();
    const oids: string[] = [];
    store.writeObjects(
      (batch) => {
        for (let index = 0; index < 2_049; index++) {
          oids.push(batch.write("blob", utf8.encode(`bounded-${index}\n`)));
        }
      },
      { flushEvery: 2_048 },
    );
    seedRepack(
      db,
      checkout.repoId,
      oids.map((oid) => ({ oid })),
    );
    const selected = await advanceBelowStatementLimit(db, store.shared);
    expect(selected).toMatchObject({ boundary: "selected", objectCount: 2_048 });
    const published = await advanceBelowStatementLimit(db, store.shared);
    expect(published).toMatchObject({ boundary: "published", objectCount: 2_048 });
    expect(
      db.scalar<number>(
        "SELECT inflated_bytes FROM git_maintenance_repack_batches WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(
      db.scalar<number>(
        "SELECT size FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        published.packId,
      ),
    ).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(await advanceBelowStatementLimit(db, store.shared)).toMatchObject({
      boundary: "finalized",
      objectCount: 2_048,
    });

    const bounded = open();
    const large = new Uint8Array(32 * 1024).fill(0x61);
    const largeOid = bounded.store.write("blob", large);
    seedRepack(bounded.db, bounded.checkout.repoId, [{ oid: largeOid }]);
    expect(
      await advanceMaintenanceRepack(bounded.store.shared, {
        nowMs: 1,
        maxInflatedBytes: 16,
        readBatchBytes: 16,
      }),
    ).toMatchObject({ boundary: "selected", objectCount: 1 });
    expect(
      await advanceMaintenanceRepack(bounded.store.shared, {
        nowMs: 1,
        maxInflatedBytes: 16,
        readBatchBytes: 16,
      }),
    ).toMatchObject({ boundary: "published", objectCount: 1 });

    const output = open();
    const outputOid = output.store.write("blob", utf8.encode("output cap\n"));
    seedRepack(output.db, output.checkout.repoId, [{ oid: outputOid }]);
    await advanceMaintenanceRepack(output.store.shared, REPACK_OPTIONS);
    await expect(
      advanceMaintenanceRepack(output.store.shared, { nowMs: 1, maxStoredBytes: 16 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(output.store.read(outputOid)?.data).toEqual(utf8.encode("output cap\n"));
    expect(
      output.db.scalar<string>(
        "SELECT state FROM git_maintenance_repack_batches WHERE repo_id = ?",
        output.checkout.repoId,
      ),
    ).toBe("pending");
  });

  it("preflights repacked counter capacity before durable selection or publication", async () => {
    const fresh = open();
    const freshOid = fresh.store.write("blob", utf8.encode("counter full before selection\n"));
    seedRepack(fresh.db, fresh.checkout.repoId, [{ oid: freshOid }]);
    fresh.db.run(
      "UPDATE git_maintenance_runs SET repacked_objects = ? WHERE repo_id = ?",
      Number.MAX_SAFE_INTEGER,
      fresh.checkout.repoId,
    );

    await expect(advanceMaintenanceRepack(fresh.store.shared, REPACK_OPTIONS)).rejects.toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(fresh.db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(fresh.db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
    expect(fresh.store.read(freshOid)).not.toBeNull();

    const selected = open();
    const selectedOid = selected.store.write("blob", utf8.encode("counter full before pack\n"));
    seedRepack(selected.db, selected.checkout.repoId, [{ oid: selectedOid }]);
    expect(await advanceMaintenanceRepack(selected.store.shared, REPACK_OPTIONS)).toMatchObject({
      boundary: "selected",
    });
    selected.db.run(
      "UPDATE git_maintenance_runs SET repacked_objects = ? WHERE repo_id = ?",
      Number.MAX_SAFE_INTEGER,
      selected.checkout.repoId,
    );

    await expect(
      advanceMaintenanceRepack(selected.store.shared, REPACK_OPTIONS),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(selected.db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
    expect(
      selected.db.scalar<string>(
        "SELECT state FROM git_maintenance_repack_batches WHERE repo_id = ?",
        selected.checkout.repoId,
      ),
    ).toBe("selected");
    expect(selected.store.read(selectedOid)).not.toBeNull();

    const published = open();
    const publishedOid = published.store.write("blob", utf8.encode("counter full finalize\n"));
    seedRepack(published.db, published.checkout.repoId, [{ oid: publishedOid }]);
    await advanceMaintenanceRepack(published.store.shared, REPACK_OPTIONS);
    await advanceMaintenanceRepack(published.store.shared, REPACK_OPTIONS);
    published.db.run(
      "UPDATE git_maintenance_runs SET repacked_objects = ? WHERE repo_id = ?",
      Number.MAX_SAFE_INTEGER,
      published.checkout.repoId,
    );
    await expect(
      advanceMaintenanceRepack(published.store.shared, REPACK_OPTIONS),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(
      published.db.scalar<string>(
        "SELECT state FROM git_maintenance_repack_batches WHERE repo_id = ?",
        published.checkout.repoId,
      ),
    ).toBe("published");
    expect(
      published.db.scalar<number>(
        "SELECT count(*) FROM git_objects WHERE repo_id = ?",
        published.checkout.repoId,
      ),
    ).toBe(1);

    const shadow = open();
    const shadowData = utf8.encode("counter full shadow\n");
    const shadowOid = shadow.store.write("blob", shadowData);
    await shadow.store.packs.ingest(slices(fullObjectPack("blob", shadowData), 11));
    seedRepack(shadow.db, shadow.checkout.repoId, [{ oid: shadowOid }]);
    shadow.db.run(
      "UPDATE git_maintenance_runs SET repacked_objects = ? WHERE repo_id = ?",
      Number.MAX_SAFE_INTEGER,
      shadow.checkout.repoId,
    );
    await expect(
      advanceMaintenanceRepack(shadow.store.shared, REPACK_OPTIONS),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(
      shadow.db.scalar<number>(
        "SELECT count(*) FROM git_objects WHERE repo_id = ?",
        shadow.checkout.repoId,
      ),
    ).toBe(1);
  });

  it("keeps committed finalization once-only when cache revalidation loses its response", async () => {
    const inner = new TestDatabase();
    const failing = new AvailabilityFailureDatabase(inner);
    const database = new SqliteGitDatabase(failing, { objectCacheBytes: 8 * 1024 * 1024 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout);
    const data = utf8.encode("packed authority\n");
    const stale = new Uint8Array(data.length).fill(0x78);
    const oid = store.write("blob", data);
    seedRepack(inner, checkout.repoId, [{ oid }]);
    await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
    await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
    inner.run(
      "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ? AND seq = 0",
      stale,
      checkout.repoId,
      oid,
    );
    store.shared.clearCaches();
    store.shared.markLoose();
    expect(store.read(oid)?.data).toEqual(stale);
    failing.corruptAvailability = true;

    await expect(advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).rejects.toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(inner.scalar<number>("SELECT count(*) FROM git_objects")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_loose_object_lifecycle")).toBe(0);
    expect(inner.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(
      inner.scalar<number>(
        "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1);
    expect(store.shared.hasLoose).toBe(true);
    expect(store.read(oid)?.data).toEqual(data);

    failing.corruptAvailability = false;
    expect(await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).toMatchObject({
      status: "complete",
      boundary: null,
    });
    expect(
      inner.scalar<number>(
        "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("rolls finalization back on complete-pack graph corruption", async () => {
    const { db, checkout, store } = open();
    const data = utf8.encode("corrupt finalization\n");
    const oid = store.write("blob", data);
    seedRepack(db, checkout.repoId, [{ oid }]);
    await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
    const published = await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
    if (published.packId === null) throw new Error("published fixture has no pack id");
    db.run(
      "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND pack_id = ?",
      "f".repeat(40),
      checkout.repoId,
      published.packId,
    );

    await expect(advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).rejects.toThrow(
      /membership/,
    );

    expect(store.read(oid)?.data).toEqual(data);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", checkout.repoId),
    ).toBe(1);
    expect(
      db.one<{ state: string; repacked_objects: number }>(
        `SELECT batch.state, run.repacked_objects
           FROM git_maintenance_repack_batches batch
           JOIN git_maintenance_runs run ON run.repo_id = batch.repo_id AND run.run_id = batch.run_id
          WHERE batch.repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ state: "published", repacked_objects: 0 });
  });

  it("cold-authenticates packed bytes before and after every loose finalization path", async () => {
    for (const timing of ["before-delete", "after-delete"]) {
      for (const path of ["published", "immediate-shadow", "selected-shadow"]) {
        const { db, checkout, store } = open();
        const data = utf8.encode(`corrupt ${timing} ${path} packed source\n`);
        const oid = store.write("blob", data);
        let packId: number;
        if (path === "published") {
          seedRepack(db, checkout.repoId, [{ oid }]);
          await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
          const published = await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
          if (published.packId === null)
            throw new Error("published corruption fixture has no pack");
          packId = published.packId;
        } else if (path === "immediate-shadow") {
          const packed = await store.packs.ingest(slices(fullObjectPack("blob", data), 11));
          packId = packed.packId;
          seedRepack(db, checkout.repoId, [{ oid }]);
        } else {
          seedRepack(db, checkout.repoId, [{ oid }]);
          await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
          const packed = await store.packs.ingest(slices(fullObjectPack("blob", data), 11));
          packId = packed.packId;
        }
        expect(store.packs.read(oid)?.data).toEqual(data);
        if (timing === "before-delete") {
          corruptPackEntryBytes(db, checkout.repoId, packId, oid);
        } else {
          db.run(
            `CREATE TRIGGER test_post_delete_pack_corruption
           AFTER DELETE ON git_objects
           WHEN OLD.repo_id = ${checkout.repoId} AND OLD.oid = '${oid}'
           BEGIN
             DELETE FROM git_pack_data
              WHERE repo_id = ${checkout.repoId} AND pack_id = ${packId} AND seq = 0;
           END`,
          );
        }

        await expect(advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).rejects.toMatchObject({
          code: "ECORRUPT",
        });
        expect(
          db.scalar<number>(
            "SELECT count(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
            checkout.repoId,
            oid,
          ),
        ).toBe(1);
        expect(
          db.scalar<number>(
            "SELECT count(*) FROM git_loose_object_lifecycle WHERE repo_id = ? AND oid = ?",
            checkout.repoId,
            oid,
          ),
        ).toBe(1);
        expect(
          db.scalar<number>(
            "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
            checkout.repoId,
          ),
        ).toBe(0);
        if (path === "immediate-shadow") {
          expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
        } else {
          expect(
            db.scalar<string>(
              "SELECT state FROM git_maintenance_repack_batches WHERE repo_id = ?",
              checkout.repoId,
            ),
          ).toBe(path === "published" ? "published" : "selected");
        }
        expect(
          db.scalar<string>(
            "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
            checkout.repoId,
            packId,
          ),
        ).toBe("complete");
        expect(
          db.scalar<number>(
            "SELECT count(*) FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = 0",
            checkout.repoId,
            packId,
          ),
        ).toBe(1);
      }
    }
  });

  it("finalizes an incompressible packed source beyond the bulk read boundary", async () => {
    const { db, checkout, store } = open();
    const data = deterministicBytes(MAX_PACK_BLOB_BATCH_BYTES + 64 * 1024);
    const oid = store.write("blob", data);
    seedRepack(db, checkout.repoId, [{ oid }]);
    await advanceBelowStatementLimit(db, store.shared);
    const published = await advanceBelowStatementLimit(db, store.shared);
    if (published.packId === null) throw new Error("oversized maintenance pack was not published");
    expect(
      db.scalar<number>(
        "SELECT data_len FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND oid = ?",
        checkout.repoId,
        published.packId,
        oid,
      ),
    ).toBeGreaterThan(MAX_PACK_BLOB_BATCH_BYTES);

    const reopened = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const cold = reopened.openCheckout(checkout.id);
    const finalized = await advanceBelowStatementLimit(db, cold.shared);
    expect(finalized).toMatchObject({ boundary: "finalized", packId: published.packId });
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
        checkout.repoId,
        oid,
      ),
    ).toBe(0);
    expect(cold.packs.read(oid)?.data).toEqual(data);
  });

  it("shares the cold dependency-read budget across maintenance shadow pages", async () => {
    const { db, checkout, store } = open();
    const fixture = await sharedOversizedDeltaFixture(store);
    for (const target of fixture.targets) {
      db.run(
        `INSERT INTO git_objects (repo_id, oid, type, size, stored)
         VALUES (?, ?, 'blob', ?, 'raw')`,
        checkout.repoId,
        target.oid,
        target.size,
      );
      db.run(
        `WITH RECURSIVE chunks(seq, remaining) AS (
           VALUES (0, ?)
           UNION ALL
           SELECT seq + 1, remaining - 1048576 FROM chunks WHERE remaining > 1048576
         )
         INSERT INTO git_object_chunks (repo_id, oid, seq, data)
         SELECT ?, ?, seq, zeroblob(min(remaining, 1048576)) FROM chunks`,
        target.size,
        checkout.repoId,
        target.oid,
      );
      db.run(
        `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         VALUES (?, ?, 1)`,
        checkout.repoId,
        target.oid,
      );
    }
    seedRepack(
      db,
      checkout.repoId,
      fixture.targets.map((target) => ({ oid: target.oid })),
    );
    db.storage.resetCounters();

    await expect(advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).rejects.toMatchObject({
      code: "E2BIG",
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", checkout.repoId),
    ).toBe(fixture.targets.length);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_loose_object_lifecycle WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(fixture.targets.length);
    expect(
      db.scalar<number>(
        "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
    expect(
      db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        fixture.basePackId,
      ),
    ).toBe("complete");
    expect(
      db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        fixture.deltaPackId,
      ),
    ).toBe("complete");
  });

  it("returns root-changed without touching selected, pending, or published state", async () => {
    for (const boundary of ["selected", "pending", "published"]) {
      const { db, checkout, store } = open();
      const oid = store.write("blob", utf8.encode(`drift ${boundary}\n`));
      seedRepack(db, checkout.repoId, [{ oid }]);
      await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
      if (boundary === "pending") {
        await expect(
          advanceMaintenanceRepack(store.shared, {
            nowMs: 1,
            yieldNow: () => Promise.reject(new Error("leave pending")),
          }),
        ).rejects.toThrow(/leave pending/);
      } else if (boundary === "published") {
        await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
      }
      const beforeBatch = db.one<Record<string, unknown>>(
        "SELECT * FROM git_maintenance_repack_batches WHERE repo_id = ?",
        checkout.repoId,
      );
      const beforePacks = db.all<Record<string, unknown>>(
        "SELECT * FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id",
        checkout.repoId,
      );
      db.run(
        "UPDATE git_maintenance_control SET root_epoch = 1 WHERE repo_id = ?",
        checkout.repoId,
      );

      expect(await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS)).toMatchObject({
        status: "root-changed",
        boundary: null,
      });
      expect(
        db.one("SELECT * FROM git_maintenance_repack_batches WHERE repo_id = ?", checkout.repoId),
      ).toEqual(beforeBatch);
      expect(
        db.all("SELECT * FROM git_pack_meta WHERE repo_id = ? ORDER BY pack_id", checkout.repoId),
      ).toEqual(beforePacks);
      expect(store.read(oid)).not.toBeNull();
    }

    const interleaved = open();
    const oid = interleaved.store.write("blob", utf8.encode("drift during ingest\n"));
    seedRepack(interleaved.db, interleaved.checkout.repoId, [{ oid }]);
    await advanceMaintenanceRepack(interleaved.store.shared, REPACK_OPTIONS);
    let drifted = false;
    const result = await advanceMaintenanceRepack(interleaved.store.shared, {
      nowMs: 1,
      yieldNow: () => {
        if (!drifted) {
          interleaved.db.run(
            "UPDATE git_maintenance_control SET root_epoch = 1 WHERE repo_id = ?",
            interleaved.checkout.repoId,
          );
          drifted = true;
        }
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ status: "root-changed", boundary: null });
    expect(
      interleaved.db.scalar<string>(
        "SELECT state FROM git_maintenance_repack_batches WHERE repo_id = ?",
        interleaved.checkout.repoId,
      ),
    ).toBe("pending");
    expect(interleaved.store.packs.completePackedEntry(oid)).toBeNull();
    expect(interleaved.store.read(oid)).not.toBeNull();
  });

  it("settles selected, pending, and published batches exactly for a root restart", async () => {
    const selected = open();
    const selectedOid = selected.store.write("blob", utf8.encode("settle selected\n"));
    seedRepack(selected.db, selected.checkout.repoId, [{ oid: selectedOid }]);
    await advanceMaintenanceRepack(selected.store.shared, REPACK_OPTIONS);
    selected.db.transactionSync(() => {
      settleMaintenanceRepackForRestart(selected.store.shared, 1);
    });
    settleMaintenanceRepackForRestart(selected.store.shared, 1);
    expect(
      selected.db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_repack_batches WHERE repo_id = ?",
        selected.checkout.repoId,
      ),
    ).toBe(0);
    expect(selected.store.read(selectedOid)).not.toBeNull();

    const pending = open();
    const pendingOid = pending.store.write("blob", utf8.encode("settle pending\n"));
    seedRepack(pending.db, pending.checkout.repoId, [{ oid: pendingOid }]);
    await advanceMaintenanceRepack(pending.store.shared, REPACK_OPTIONS);
    await expect(
      advanceMaintenanceRepack(pending.store.shared, {
        nowMs: 1,
        yieldNow: () => Promise.reject(new Error("pending restart")),
      }),
    ).rejects.toThrow(/pending restart/);
    const pendingReopen = new SqliteGitDatabase(pending.db, { objectCacheBytes: 0 });
    const pendingCold = pendingReopen.openCheckout(pending.checkout.id);
    pending.db.transactionSync(() => {
      settleMaintenanceRepackForRestart(pendingCold.shared, 1);
    });
    expect(pending.db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(0);
    expect(pending.db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(
      0,
    );
    expect(pendingCold.read(pendingOid)).not.toBeNull();

    const published = open();
    const publishedData = utf8.encode("settle published\n");
    const publishedOid = published.store.write("blob", publishedData);
    seedRepack(published.db, published.checkout.repoId, [{ oid: publishedOid }]);
    await advanceMaintenanceRepack(published.store.shared, REPACK_OPTIONS);
    const publication = await advanceMaintenanceRepack(published.store.shared, REPACK_OPTIONS);
    if (publication.packId === null) throw new Error("published settlement has no pack id");
    const publishedReopen = new SqliteGitDatabase(published.db, { objectCacheBytes: 0 });
    const publishedCold = publishedReopen.openCheckout(published.checkout.id);
    published.db.transactionSync(() => {
      settleMaintenanceRepackForRestart(publishedCold.shared, 1);
    });
    settleMaintenanceRepackForRestart(publishedCold.shared, 1);
    expect(
      published.db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        published.checkout.repoId,
        publication.packId,
      ),
    ).toBe("complete");
    expect(published.db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(
      0,
    );
    expect(publishedCold.read(publishedOid)?.data).toEqual(publishedData);
    expect(publishedCold.packs.read(publishedOid)?.data).toEqual(publishedData);
    expect(
      published.db.scalar<number>(
        "SELECT repacked_objects FROM git_maintenance_runs WHERE repo_id = ?",
        published.checkout.repoId,
      ),
    ).toBe(0);
  });

  it("rolls restart settlement back on corrupt published membership", async () => {
    const { db, checkout, store } = open();
    const oid = store.write("blob", utf8.encode("settlement corruption\n"));
    seedRepack(db, checkout.repoId, [{ oid }]);
    await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
    const published = await advanceMaintenanceRepack(store.shared, REPACK_OPTIONS);
    if (published.packId === null) throw new Error("settlement corruption has no pack id");
    db.run(
      "UPDATE git_pack_entries SET size = size + 1 WHERE repo_id = ? AND pack_id = ?",
      checkout.repoId,
      published.packId,
    );

    expect(() => settleMaintenanceRepackForRestart(store.shared, 1)).toThrow(/membership/);

    expect(db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(1);
    expect(
      db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        published.packId,
      ),
    ).toBe("complete");
  });

  it("fails closed on incomplete mark audits and malformed durable batch rows", async () => {
    const queued = open();
    const queuedOid = queued.store.write("blob", utf8.encode("queued\n"));
    seedRepack(queued.db, queued.checkout.repoId, [{ oid: queuedOid }]);
    queued.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?",
      queued.checkout.repoId,
    );
    await expect(advanceMaintenanceRepack(queued.store.shared, REPACK_OPTIONS)).rejects.toThrow(
      /nonempty mark queue/,
    );

    const logical = open();
    const physical = logical.store.write("blob", utf8.encode("physical\n"));
    seedRepack(logical.db, logical.checkout.repoId, [{ oid: physical, physicalOnly: true }]);
    logical.db.run(
      "UPDATE git_maintenance_runs SET reachable_objects = 1 WHERE repo_id = ?",
      logical.checkout.repoId,
    );
    await expect(advanceMaintenanceRepack(logical.store.shared, REPACK_OPTIONS)).rejects.toThrow(
      /counters disagree/,
    );

    const malformed = open();
    const malformedOid = malformed.store.write("blob", utf8.encode("malformed\n"));
    seedRepack(malformed.db, malformed.checkout.repoId, [{ oid: malformedOid }]);
    await advanceMaintenanceRepack(malformed.store.shared, REPACK_OPTIONS);
    malformed.db.run(
      "UPDATE git_maintenance_repack_objects SET size = size + 1 WHERE repo_id = ?",
      malformed.checkout.repoId,
    );
    await expect(advanceMaintenanceRepack(malformed.store.shared, REPACK_OPTIONS)).rejects.toThrow(
      /membership is incomplete/,
    );

    const clock = open();
    const clockOid = clock.store.write("blob", utf8.encode("clock\n"));
    seedRepack(clock.db, clock.checkout.repoId, [{ oid: clockOid }]);
    await expect(advanceMaintenanceRepack(clock.store.shared, { nowMs: -1 })).rejects.toThrow(
      /clock/,
    );
    expect(clock.db.scalar<number>("SELECT count(*) FROM git_maintenance_repack_batches")).toBe(0);
  });
});
