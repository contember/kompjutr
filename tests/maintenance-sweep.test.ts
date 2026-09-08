import { describe, expect, it } from "vitest";
import { blob, type SqlDatabase } from "../packages/do/src/db/db.js";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import {
  hashObject,
  MODE_FILE,
  type ObjectType,
  serializeCommit,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import {
  advanceMaintenanceSweep,
  GC_GRACE_MS,
  type MaintenanceSweepProgress,
} from "../packages/git/src/store/maintenance/sweep.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";
import { promiseMaintenance } from "./helpers/promise-maintenance.js";

const PERSON = {
  name: "Sweep Fixture",
  email: "sweep@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

type SweepPhase = "classify-loose" | "classify-packs" | "sweep-loose" | "sweep-packs";

interface MarkInput {
  oid: string;
  physicalOnly?: boolean;
}

function open(db: SqlDatabase = new TestDatabase()) {
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 8 * 1024 * 1024 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { database, checkout, store };
}

function seedRun(
  db: SqlDatabase,
  repoId: number,
  phase: SweepPhase,
  marks: readonly MarkInput[] = [],
): void {
  db.run(
    `INSERT OR IGNORE INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 2)`,
    repoId,
  );
  db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
        reachable_objects, queued_objects)
     VALUES (?, 1, 0, ?, 1, 'done', ?, 0)`,
    repoId,
    phase,
    marks.filter((mark) => mark.physicalOnly !== true).length,
  );
  for (const mark of marks) {
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
          physical_only, edge_cursor)
       VALUES (?, 1, ?, 1, 1, 0, ?, 0)`,
      repoId,
      mark.oid,
      mark.physicalOnly === true ? 1 : 0,
    );
  }
}

function candidateAge(db: SqlDatabase, table: string, repoId: number, key: string | number) {
  const column = typeof key === "string" ? "oid" : "pack_id";
  return db.scalar<number>(
    `SELECT unreachable_since_ms FROM ${table} WHERE repo_id = ? AND ${column} = ?`,
    repoId,
    key,
  );
}

function seedBlobId(db: SqlDatabase, repoId: number, contentId: Uint8Array, oid: string): void {
  db.run("INSERT OR IGNORE INTO git_blob_id_state (repo_id, generation) VALUES (?, 1)", repoId);
  db.run(
    `INSERT INTO git_blob_ids (repo_id, content_id, oid, generation)
     VALUES (?, ?, ?, 1)`,
    repoId,
    blob(contentId),
    oid,
  );
}

function advance(
  db: TestDatabase,
  shared: ReturnType<typeof open>["store"]["shared"],
  nowMs: number,
  pageRows = 8,
): MaintenanceSweepProgress {
  db.storage.resetCounters();
  const result = advanceMaintenanceSweep(shared, { nowMs, pageRows });
  expect(db.storage.statementCount).toBeLessThan(1_000);
  expect(db.storage.rowCount).toBeLessThan(300);
  return result;
}

function advanceToPhase(
  db: TestDatabase,
  shared: ReturnType<typeof open>["store"]["shared"],
  nowMs: number,
  phase: MaintenanceSweepProgress["phase"],
  pageRows = 8,
): MaintenanceSweepProgress {
  for (let call = 0; call < 1_000; call++) {
    const result = advance(db, shared, nowMs, pageRows);
    if (result.phase === phase) return result;
  }
  throw new Error(`maintenance sweep did not reach ${phase}`);
}

function literalDelta(baseSize: number, target: Uint8Array): Uint8Array {
  const chunks = [encodeDeltaHeader(baseSize, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const part = target.subarray(offset, offset + 127);
    chunks.push(new Uint8Array([part.length]), part);
  }
  return concat(chunks);
}

function fullPack(objects: readonly { type: ObjectType; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(objects.length);
  for (const object of objects) writer.object(object.type, object.data);
  writer.finish();
  return concat(chunks);
}

class FailingCounterDatabase implements SqlDatabase {
  failCounterUpdate = false;

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
    if (this.failCounterUpdate && query.includes("SET reclaimed_objects")) {
      throw new Error("simulated counter publication crash");
    }
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

class CorruptAvailabilityDatabase implements SqlDatabase {
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

describe("maintenance sweep", () => {
  it.each(["loose", "packed"])(
    "keeps a fulfilled %s promise across stale marking and cold sweep",
    async (variant) => {
      const fixture = promiseMaintenance();
      await fixture.runtime().git.init({ dir: "/repo" });
      const store = fixture.store();
      const data = utf8.encode("reachable promised leaf\n");
      const oid = hashObject("blob", data);
      store.registerPromisorRemote("origin", "https://example.test/repo.git");
      store.addPromisedBlobs("origin", [oid]);
      const tree = store.write("tree", serializeTree([{ mode: MODE_FILE, name: "file", oid }]));
      const head = store.write(
        "commit",
        serializeCommit({
          tree,
          parent: [],
          author: PERSON,
          committer: PERSON,
          message: "promise\n",
        }),
      );
      store.setRef("refs/heads/main", head);
      const deadData = utf8.encode("genuinely unreachable\n");
      const dead = hashObject("blob", deadData);
      store.addPromisedBlobs("origin", [dead]);
      await fixture.until("classify-loose");
      expect(fixture.marked(oid)).toBe(0);
      if (variant === "loose") {
        store.write("blob", data);
        store.write("blob", deadData);
      } else {
        await store.packs.ingest(slices(fullPack([{ type: "blob", data }]), 17));
        await store.packs.ingest(slices(fullPack([{ type: "blob", data: deadData }]), 17));
      }
      expect(store.promisedBlobCount()).toBe(0);
      expect(await fixture.call()).toMatchObject({ phase: "roots", restarted: true });
      await fixture.until("sweep-loose");
      expect(fixture.marked(oid)).toBe(1);
      const deadPack = fixture.store().packs.lookup(dead)?.packId;
      expect(
        candidateAge(
          fixture.db,
          variant === "loose" ? "git_loose_gc_candidates" : "git_pack_gc_candidates",
          store.repoId,
          deadPack ?? dead,
        ),
      ).toBe(fixture.clock.value);
      fixture.clock.value += GC_GRACE_MS + 1;
      await fixture.until("finish");
      expect(fixture.store().read(dead)).toBeNull();
      await fixture.expectReadable(head, oid, data);
    },
  );

  it("converges loose candidates without cursors, preserves first age, and resumes cold", () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const retained = store.write("blob", utf8.encode("retained\n"));
    const aged = store.write("blob", utf8.encode("aged unreachable\n"));
    const fresh = store.write("blob", utf8.encode("fresh unreachable\n"));
    seedRun(db, checkout.repoId, "classify-loose", [{ oid: retained }]);
    db.run(
      `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
       VALUES (?, ?, 3), (?, ?, 7)`,
      checkout.repoId,
      retained,
      checkout.repoId,
      aged,
    );

    expect(advance(db, store.shared, 100, 1)).toMatchObject({
      phase: "classify-loose",
      status: "progress",
    });
    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 8 * 1024 * 1024 });
    const cold = reopened.openCheckout(checkout.id);
    advanceToPhase(db, cold.shared, 100, "repack", 1);

    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, retained)).toBeUndefined();
    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, aged)).toBe(7);
    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, fresh)).toBe(100);
    expect(
      db.one<{ cursor_checkout_id: null; cursor_text: null; cursor_ordinal: null }>(
        `SELECT cursor_checkout_id, cursor_text, cursor_ordinal
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ cursor_checkout_id: null, cursor_text: null, cursor_ordinal: null });
  });

  it("returns root-changed without changing candidates or downstream state", () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const oid = store.write("blob", utf8.encode("root drift\n"));
    seedRun(db, checkout.repoId, "classify-loose");
    db.run(
      "INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms) VALUES (?, ?, 4)",
      checkout.repoId,
      oid,
    );
    db.run("UPDATE git_maintenance_control SET root_epoch = 1 WHERE repo_id = ?", checkout.repoId);

    expect(advance(db, store.shared, 100)).toMatchObject({
      phase: "classify-loose",
      status: "root-changed",
    });
    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, oid)).toBe(4);
    expect(
      db.one<{ phase: string; reclaimed_objects: number }>(
        "SELECT phase, reclaimed_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ phase: "classify-loose", reclaimed_objects: 0 });
  });

  it("deletes loose storage at the exact boundary and clears derived rows and warmed caches", () => {
    const beforeDb = new TestDatabase();
    const before = open(beforeDb);
    const beforeData = utf8.encode("not eligible yet\n");
    const beforeOid = before.store.write("blob", beforeData);
    seedRun(beforeDb, before.checkout.repoId, "sweep-loose");
    beforeDb.run(
      `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
       VALUES (?, ?, 100)`,
      before.checkout.repoId,
      beforeOid,
    );
    expect(advance(beforeDb, before.store.shared, 100 + GC_GRACE_MS - 1)).toMatchObject({
      phase: "sweep-packs",
      status: "phase-complete",
      nextEligibleMs: 100 + GC_GRACE_MS,
    });
    expect(before.store.read(beforeOid)?.data).toEqual(beforeData);

    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const blobData = utf8.encode("doomed blob\n");
    const blobOid = store.write("blob", blobData);
    const treeData = serializeTree([{ mode: MODE_FILE, name: "file", oid: blobOid }]);
    const treeOid = store.write("tree", treeData);
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: PERSON,
      committer: PERSON,
      message: "doomed commit\n",
    });
    const commitOid = store.write("commit", commitData);
    const survivorData = utf8.encode("retained loose object\n");
    const survivorOid = store.write("blob", survivorData);
    seedRun(db, checkout.repoId, "sweep-loose", [{ oid: survivorOid }]);
    for (const oid of [blobOid, treeOid, commitOid]) {
      db.run(
        `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
         VALUES (?, ?, 100)`,
        checkout.repoId,
        oid,
      );
    }
    seedBlobId(db, checkout.repoId, new Uint8Array([1, 2, 3]), blobOid);
    expect(store.read(blobOid)?.data).toEqual(blobData);
    expect(store.read(treeOid)?.data).toEqual(treeData);
    expect(store.cachedCommit(commitOid)?.commit.message).toBe("doomed commit\n");

    advanceToPhase(db, store.shared, 100 + GC_GRACE_MS, "sweep-packs");

    expect(store.read(blobOid)).toBeNull();
    expect(store.read(treeOid)).toBeNull();
    expect(store.read(commitOid)).toBeNull();
    expect(store.read(survivorOid)?.data).toEqual(survivorData);
    expect(store.shared.hasLoose).toBe(true);
    expect(store.cachedCommit(commitOid)).toBeNull();
    expect(
      db.scalar<number>("SELECT count(*) FROM git_blob_ids WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_commits WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_tree_sources WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_loose_object_lifecycle WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1);
    expect(
      db.one<{ reclaimed_objects: number; reclaimed_bytes: number }>(
        "SELECT reclaimed_objects, reclaimed_bytes FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({
      reclaimed_objects: 3,
      reclaimed_bytes: blobData.length + treeData.length + commitData.length,
    });
  });

  it("retains mixed packs and sweeps a wholly unreachable pack at the exact boundary", async () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const liveData = utf8.encode("packed live\n");
    const incidentalData = utf8.encode("packed incidental\n");
    const deadData = utf8.encode("packed dead\n");
    const liveOid = store.write("blob", liveData);
    const incidentalOid = store.write("blob", incidentalData);
    const deadOid = store.write("blob", deadData);
    const mixed = await store.packs.ingest(
      slices(
        fullPack([
          { type: "blob", data: liveData },
          { type: "blob", data: incidentalData },
        ]),
        17,
      ),
      { reclaimPending: false },
    );
    const dead = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: deadData }]), 13),
      {
        reclaimPending: false,
      },
    );
    for (const oid of [liveOid, incidentalOid, deadOid]) {
      db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", checkout.repoId, oid);
    }
    seedBlobId(db, checkout.repoId, new Uint8Array([9, 9, 9]), deadOid);
    seedRun(db, checkout.repoId, "classify-packs", [{ oid: liveOid, physicalOnly: true }]);
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, 3)`,
      checkout.repoId,
      mixed.packId,
    );

    advanceToPhase(db, store.shared, 100, "sweep-loose");
    expect(
      candidateAge(db, "git_pack_gc_candidates", checkout.repoId, mixed.packId),
    ).toBeUndefined();
    expect(candidateAge(db, "git_pack_gc_candidates", checkout.repoId, dead.packId)).toBe(100);
    advanceToPhase(db, store.shared, 100, "sweep-packs");
    expect(advance(db, store.shared, 100 + GC_GRACE_MS)).toMatchObject({
      reclaimedObjects: 1,
      reclaimedPacks: 1,
      reclaimedBytes: dead.bytes,
    });
    expect(store.read(liveOid)?.data).toEqual(liveData);
    expect(store.read(incidentalOid)?.data).toEqual(incidentalData);
    expect(store.read(deadOid)).toBeNull();
    expect(
      db.scalar<number>("SELECT count(*) FROM git_blob_ids WHERE repo_id = ?", checkout.repoId),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE repo_id = ?", checkout.repoId),
    ).toBe(1);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_data WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        dead.packId,
      ),
    ).toBe(0);
    expect(advance(db, store.shared, 100 + GC_GRACE_MS)).toMatchObject({
      phase: "finish",
      status: "complete",
    });
  });

  it("preserves an existing pack age and retains it one millisecond before eligibility", async () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const result = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: utf8.encode("aged pack\n") }]), 11),
      { reclaimPending: false },
    );
    seedRun(db, checkout.repoId, "classify-packs");
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, 7)`,
      checkout.repoId,
      result.packId,
    );

    expect(advance(db, store.shared, 100)).toMatchObject({
      phase: "sweep-loose",
      status: "phase-complete",
    });
    expect(candidateAge(db, "git_pack_gc_candidates", checkout.repoId, result.packId)).toBe(7);
    expect(advance(db, store.shared, 100)).toMatchObject({ phase: "sweep-packs" });
    expect(advance(db, store.shared, 7 + GC_GRACE_MS - 1)).toMatchObject({
      phase: "finish",
      status: "complete",
      nextEligibleMs: 7 + GC_GRACE_MS,
      reclaimedPacks: 0,
    });
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        result.packId,
      ),
    ).toBe(1);
  });

  it.each([
    { label: "logical", physicalOnly: false },
    { label: "physical", physicalOnly: true },
  ])(
    "removes a candidate that becomes $label marked during pack sweep",
    async ({ physicalOnly }) => {
      const db = new TestDatabase();
      const { checkout, store } = open(db);
      const data = utf8.encode(`marked ${physicalOnly}\n`);
      const result = await store.packs.ingest(slices(fullPack([{ type: "blob", data }]), 11), {
        reclaimPending: false,
      });
      const oid = db.scalar<string>(
        "SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        result.packId,
      );
      if (oid === undefined) throw new Error("pack fixture did not publish its object");
      seedRun(db, checkout.repoId, "sweep-packs", [{ oid, physicalOnly }]);
      db.run(
        `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, 0)`,
        checkout.repoId,
        result.packId,
      );

      expect(advance(db, store.shared, GC_GRACE_MS)).toMatchObject({
        phase: "sweep-packs",
        reclaimedObjects: 0,
        reclaimedPacks: 0,
        reclaimedBytes: 0,
      });
      expect(
        candidateAge(db, "git_pack_gc_candidates", checkout.repoId, result.packId),
      ).toBeUndefined();
      expect(store.read(oid)?.data).toEqual(data);
    },
  );

  it("publishes the minimum next eligibility across loose and packed candidates", async () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const looseOid = store.write("blob", utf8.encode("future loose\n"));
    const packed = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: utf8.encode("future packed\n") }]), 13),
      { reclaimPending: false },
    );
    seedRun(db, checkout.repoId, "sweep-loose");
    db.run(
      `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
       VALUES (?, ?, 200)`,
      checkout.repoId,
      looseOid,
    );
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, 100)`,
      checkout.repoId,
      packed.packId,
    );

    expect(advance(db, store.shared, 1)).toMatchObject({
      phase: "sweep-packs",
      nextEligibleMs: 200 + GC_GRACE_MS,
    });
    expect(advance(db, store.shared, 1)).toMatchObject({
      phase: "finish",
      status: "complete",
      nextEligibleMs: 100 + GC_GRACE_MS,
    });
  });

  it("removes stale pending and maintenance-owned candidates directly during pack sweep", async () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const owned = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: utf8.encode("owned\n") }]), 11),
      { reclaimPending: false },
    );
    seedRun(db, checkout.repoId, "sweep-packs");
    db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 99, 0, 0, 'pending', 1)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_repack_batches
         (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
       VALUES (?, 1, 1, 'published', ?, 0, 0, 0)`,
      checkout.repoId,
      owned.packId,
    );
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, 99, 1), (?, ?, 1)`,
      checkout.repoId,
      checkout.repoId,
      owned.packId,
    );

    expect(advance(db, store.shared, 100)).toMatchObject({
      phase: "sweep-packs",
      reclaimedObjects: 0,
      reclaimedPacks: 0,
    });
    expect(advance(db, store.shared, 100)).toMatchObject({
      phase: "sweep-packs",
      reclaimedObjects: 0,
      reclaimedPacks: 0,
    });
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_gc_candidates WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE repo_id = ?", checkout.repoId),
    ).toBe(2);
    expect(advance(db, store.shared, 100)).toMatchObject({ phase: "finish", status: "complete" });
  });

  it("rolls back loose deletion and counters when publication fails", () => {
    const inner = new TestDatabase();
    const db = new FailingCounterDatabase(inner);
    const { checkout, store } = open(db);
    const data = utf8.encode("rollback object\n");
    const oid = store.write("blob", data);
    seedRun(db, checkout.repoId, "sweep-loose");
    db.run(
      `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
       VALUES (?, ?, 0)`,
      checkout.repoId,
      oid,
    );
    db.failCounterUpdate = true;

    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: GC_GRACE_MS })).toThrow(
      "simulated counter publication crash",
    );
    expect(store.read(oid)?.data).toEqual(data);
    expect(candidateAge(inner, "git_loose_gc_candidates", checkout.repoId, oid)).toBe(0);
    expect(
      inner.scalar<number>(
        "SELECT reclaimed_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(0);
  });

  it("rolls back every packed row and projection when counter publication fails", async () => {
    const inner = new TestDatabase();
    const db = new FailingCounterDatabase(inner);
    const { checkout, store } = open(db);
    const blobData = utf8.encode("packed rollback blob\n");
    const blobOid = hashObject("blob", blobData);
    const treeData = serializeTree([{ mode: MODE_FILE, name: "file", oid: blobOid }]);
    const treeOid = hashObject("tree", treeData);
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: PERSON,
      committer: PERSON,
      message: "packed rollback commit\n",
    });
    const commitOid = hashObject("commit", commitData);
    const packed = await store.packs.ingest(
      slices(
        fullPack([
          { type: "blob", data: blobData },
          { type: "tree", data: treeData },
          { type: "commit", data: commitData },
        ]),
        17,
      ),
      { reclaimPending: false },
    );
    seedRun(db, checkout.repoId, "sweep-packs");
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, 0)`,
      checkout.repoId,
      packed.packId,
    );
    seedBlobId(db, checkout.repoId, new Uint8Array([4, 5, 6]), blobOid);
    expect(store.read(blobOid)?.data).toEqual(blobData);
    expect(store.read(treeOid)?.data).toEqual(treeData);
    expect(store.cachedCommit(commitOid)?.commit.message).toBe("packed rollback commit\n");
    const dataRows = inner.scalar<number>(
      "SELECT count(*) FROM git_pack_data WHERE repo_id = ? AND pack_id = ?",
      checkout.repoId,
      packed.packId,
    );
    if (dataRows === undefined || dataRows < 1) throw new Error("pack fixture has no data rows");
    db.failCounterUpdate = true;

    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: GC_GRACE_MS })).toThrow(
      "simulated counter publication crash",
    );
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        packed.packId,
      ),
    ).toBe(1);
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_pack_data WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        packed.packId,
      ),
    ).toBe(dataRows);
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        packed.packId,
      ),
    ).toBe(3);
    expect(candidateAge(inner, "git_pack_gc_candidates", checkout.repoId, packed.packId)).toBe(0);
    expect(
      inner.scalar<number>("SELECT count(*) FROM git_blob_ids WHERE repo_id = ?", checkout.repoId),
    ).toBe(1);
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_tree_sources WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1);
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_tree_effective WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(1);
    expect(
      inner.scalar<number>("SELECT count(*) FROM git_commits WHERE repo_id = ?", checkout.repoId),
    ).toBe(1);
    expect(
      inner.one<{ reclaimed_objects: number; reclaimed_packs: number; reclaimed_bytes: number }>(
        `SELECT reclaimed_objects, reclaimed_packs, reclaimed_bytes
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ reclaimed_objects: 0, reclaimed_packs: 0, reclaimed_bytes: 0 });
    expect(store.read(blobOid)?.data).toEqual(blobData);
    expect(store.read(treeOid)?.data).toEqual(treeData);
    expect(store.read(commitOid)?.data).toEqual(commitData);
    expect(store.cachedCommit(commitOid)?.commit.message).toBe("packed rollback commit\n");
  });

  it("recovers exactly after cache revalidation fails following committed pack deletion", async () => {
    const inner = new TestDatabase();
    const db = new CorruptAvailabilityDatabase(inner);
    const { checkout, store } = open(db);
    const survivorData = utf8.encode("authoritative survivor\n");
    const survivorOid = store.write("blob", survivorData);
    const deadData = utf8.encode("deleted despite probe failure\n");
    const deadOid = hashObject("blob", deadData);
    const packed = await store.packs.ingest(
      slices(fullPack([{ type: "blob", data: deadData }]), 13),
      { reclaimPending: false },
    );
    seedRun(db, checkout.repoId, "sweep-packs", [{ oid: survivorOid }]);
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, ?, 0)`,
      checkout.repoId,
      packed.packId,
    );
    expect(store.read(deadOid)?.data).toEqual(deadData);
    expect(store.read(survivorOid)?.data).toEqual(survivorData);
    db.corruptAvailability = true;

    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: GC_GRACE_MS })).toThrow(
      /availability probe/,
    );
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        checkout.repoId,
        packed.packId,
      ),
    ).toBe(0);
    expect(
      candidateAge(inner, "git_pack_gc_candidates", checkout.repoId, packed.packId),
    ).toBeUndefined();
    expect(
      inner.one<{ reclaimed_objects: number; reclaimed_packs: number; reclaimed_bytes: number }>(
        `SELECT reclaimed_objects, reclaimed_packs, reclaimed_bytes
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ reclaimed_objects: 1, reclaimed_packs: 1, reclaimed_bytes: packed.bytes });
    expect(store.read(deadOid)).toBeNull();
    expect(store.read(survivorOid)?.data).toEqual(survivorData);

    db.corruptAvailability = false;
    const coldDatabase = new SqliteGitDatabase(inner, { objectCacheBytes: 8 * 1024 * 1024 });
    const cold = coldDatabase.openCheckout(checkout.id);
    expect(advanceMaintenanceSweep(cold.shared, { nowMs: GC_GRACE_MS })).toMatchObject({
      phase: "finish",
      status: "complete",
      reclaimedObjects: 1,
      reclaimedPacks: 1,
      reclaimedBytes: packed.bytes,
    });
    expect(cold.read(deadOid)).toBeNull();
    expect(cold.read(survivorOid)?.data).toEqual(survivorData);
  });

  it("fails counter exhaustion closed and preserves eligible storage", () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const data = utf8.encode("counter overflow\n");
    const oid = store.write("blob", data);
    seedRun(db, checkout.repoId, "sweep-loose");
    db.run(
      `UPDATE git_maintenance_runs SET reclaimed_objects = ? WHERE repo_id = ?`,
      Number.MAX_SAFE_INTEGER,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms)
       VALUES (?, ?, 0)`,
      checkout.repoId,
      oid,
    );

    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: GC_GRACE_MS })).toThrow(
      /counters are exhausted/,
    );
    expect(store.read(oid)?.data).toEqual(data);
    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, oid)).toBe(0);
  });

  it("rejects bounded caller inputs", () => {
    const db = new TestDatabase();
    const { store } = open(db);

    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: -1 })).toThrow(/clock/);
    expect(() => advanceMaintenanceSweep(store.shared, { nowMs: 1, pageRows: 129 })).toThrow(
      /page size/,
    );
  });
  it("keeps a loose delta base that a surviving pack still needs", async () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    const baseData = utf8.encode("loose delta base\n");
    const baseOid = store.write("blob", baseData);
    const keeperData = utf8.encode("packed keeper\n");
    const keeperOid = hashObject("blob", keeperData);
    const targetData = utf8.encode("loose delta target\n");
    const targetOid = hashObject("blob", targetData);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", keeperData);
    writer.refDelta(baseOid, literalDelta(baseData.length, targetData));
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    expect(
      db.scalar<string>(
        "SELECT base_oid FROM git_pack_entries WHERE repo_id = ? AND base_oid = ?",
        checkout.repoId,
        baseOid,
      ),
    ).toBe(baseOid);

    seedRun(db, checkout.repoId, "classify-loose", [{ oid: keeperOid, physicalOnly: true }]);
    advanceToPhase(db, store.shared, 100, "repack");
    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, baseOid)).toBeUndefined();

    // A pack ingested after classification leaves an aged nomination behind.
    db.run(
      "UPDATE git_maintenance_runs SET phase = 'sweep-loose' WHERE repo_id = ? AND run_id = 1",
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms) VALUES (?, ?, 100)`,
      checkout.repoId,
      baseOid,
    );
    advanceToPhase(db, store.shared, 100 + GC_GRACE_MS, "sweep-packs");

    expect(candidateAge(db, "git_loose_gc_candidates", checkout.repoId, baseOid)).toBeUndefined();
    expect(store.read(baseOid)?.data).toEqual(baseData);
    expect(store.read(targetOid)?.data).toEqual(targetData);
  });

  it("keeps every stateless loose page within the statement target and memory envelope", () => {
    const db = new TestDatabase();
    const { checkout, store } = open(db);
    for (let index = 0; index < 257; index++) {
      store.write("blob", utf8.encode(`bounded ${index}\n`));
    }
    seedRun(db, checkout.repoId, "classify-loose");

    for (let call = 0; call < 20; call++) {
      const result = advance(db, store.shared, 10, 32);
      if (result.phase === "repack") break;
    }
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_loose_gc_candidates WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(257);
    expect(
      db.scalar<string>(
        "SELECT phase FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe("repack");
  });
});
