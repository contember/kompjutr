import { describe, expect, it } from "vitest";
import { createGit, type GitMaintenanceResult } from "../src/git/client.js";
import { concat, utf8 } from "../src/git/common/bytes.js";
import {
  hashObject,
  MODE_FILE,
  type ObjectType,
  serializeCommit,
  serializeTree,
  type TreeEntry,
} from "../src/git/common/objects.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
import { GC_GRACE_MS } from "../src/git/store/maintenance/sweep.js";
import { PackWriter } from "../src/git/store/pack/writer.js";
import { Workspace } from "../src/runtime/workspace.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const START_MS = 1_900_000_000_000;
const LIVE_LOOSE_OBJECTS = 2_049;
const DEAD_LOOSE_OBJECTS = 257;
const LIVE_LOGICAL_OBJECTS = LIVE_LOOSE_OBJECTS + 1;
const IDENTITY = {
  name: "Maintenance Cost Fixture",
  email: "maintenance-cost@example.com",
  timestamp: 1_900_000_000,
  timezoneOffset: 0,
};

interface Clock {
  value: number;
}

interface Fixture {
  repoId: number;
  liveLooseOids: string[];
  liveOids: string[];
  liveFirstData: Uint8Array;
  liveLastData: Uint8Array;
  liveTreeOid: string;
  liveTreeData: Uint8Array;
  liveCommitOid: string;
  liveCommitData: Uint8Array;
  deadLooseOids: string[];
  deadLooseBlobOid: string;
  deadLooseTreeOid: string;
  deadLooseTreeSourceKey: number;
  deadLooseCommitOid: string;
  mixedPackId: number;
  mixedLiveOid: string;
  mixedLiveData: Uint8Array;
  mixedDeadOid: string;
  mixedDeadData: Uint8Array;
  deadPackId: number;
  deadPackBytes: number;
  deadPackBlobOid: string;
  deadPackTreeOid: string;
  deadPackTreeSourceKey: number;
  deadPackCommitOid: string;
}

interface MaintenanceCallObservation {
  result: GitMaintenanceResult;
}

function requiredItem<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`${label} is missing`);
  return item;
}

function storedByteAggregate(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function treeSourceKey(
  db: TestDatabase,
  repoId: number,
  treeOid: string,
  storage: "loose" | "pack",
  sourceId: number,
): number {
  const key = db.scalar<number>(
    `SELECT source_key FROM git_tree_sources
      WHERE repo_id = ? AND tree_oid = ? AND storage = ? AND source_id = ?`,
    repoId,
    treeOid,
    storage,
    sourceId,
  );
  if (key === undefined || !Number.isSafeInteger(key) || key < 1) {
    throw new Error("maintenance cost tree source key is invalid");
  }
  return key;
}

function liveBlobData(index: number): Uint8Array {
  return utf8.encode(`reachable loose object ${String(index).padStart(4, "0")}\n`);
}

function denseDeadData(index: number): Uint8Array {
  const data = new Uint8Array(4 * 1024);
  for (let offset = 0; offset < data.length; offset++) {
    data[offset] = (offset * 131 + index * 17) & 0xff;
  }
  data[0] = index & 0xff;
  data[1] = index >>> 8;
  return data;
}

function fullPack(objects: readonly { type: ObjectType; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(objects.length);
  for (const object of objects) writer.object(object.type, object.data);
  writer.finish();
  return concat(chunks);
}

async function createFixture(storage: SqliteTestStorage, clock: Clock): Promise<Fixture> {
  const workspace = new Workspace({
    storage,
    git: createGit(),
    now: () => clock.value,
    defaultGitIdentity: IDENTITY,
  });
  await workspace.git.init({ dir: "/repo" });

  const db = new TestDatabase(storage);
  const database = new SqliteGitDatabase(db, { now: () => clock.value });
  const checkout = database.findCheckout("/repo");
  if (checkout === null) throw new Error("maintenance cost checkout is missing");
  const store = database.openCheckout(checkout);

  const live = store.writeObjects((batch) => {
    const blobOids: string[] = [];
    const entries: TreeEntry[] = [];
    for (let index = 0; index < LIVE_LOOSE_OBJECTS - 2; index++) {
      const oid = batch.write("blob", liveBlobData(index));
      blobOids.push(oid);
      entries.push({ mode: MODE_FILE, name: `live-${String(index).padStart(4, "0")}`, oid });
    }
    const treeData = serializeTree(entries);
    const treeOid = batch.write("tree", treeData);
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: "retain the wide tree\n",
    });
    const commitOid = batch.write("commit", commitData);
    return {
      blobOids,
      treeData,
      treeOid,
      commitData,
      commitOid,
      oids: [...blobOids, treeOid, commitOid],
    };
  });
  expect(live.oids).toHaveLength(LIVE_LOOSE_OBJECTS);

  const deadLoose = store.writeObjects((batch) => {
    const blobOids: string[] = [];
    for (let index = 0; index < DEAD_LOOSE_OBJECTS - 2; index++) {
      blobOids.push(batch.write("blob", denseDeadData(index)));
    }
    const treeData = serializeTree([
      { mode: MODE_FILE, name: "dead", oid: requiredItem(blobOids, 0, "dead loose blob") },
    ]);
    const treeOid = batch.write("tree", treeData);
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: IDENTITY,
      committer: IDENTITY,
      message: "collect this loose history\n",
    });
    const commitOid = batch.write("commit", commitData);
    return { blobOids, treeOid, commitOid, oids: [...blobOids, treeOid, commitOid] };
  });
  expect(deadLoose.oids).toHaveLength(DEAD_LOOSE_OBJECTS);

  const mixedLiveData = utf8.encode("reachable member of a mixed pack\n");
  const mixedDeadData = utf8.encode("unreachable member retained with its mixed pack\n");
  const mixedLiveOid = hashObject("blob", mixedLiveData);
  const mixedDeadOid = hashObject("blob", mixedDeadData);
  const mixed = await store.packs.ingest(
    slices(
      fullPack([
        { type: "blob", data: mixedLiveData },
        { type: "blob", data: mixedDeadData },
      ]),
      64 * 1024,
    ),
    { reclaimPending: false, now: () => clock.value },
  );

  const deadPackBlobData = utf8.encode("dead packed blob\n");
  const deadPackBlobOid = hashObject("blob", deadPackBlobData);
  const deadPackTreeData = serializeTree([
    { mode: MODE_FILE, name: "packed-dead", oid: deadPackBlobOid },
  ]);
  const deadPackTreeOid = hashObject("tree", deadPackTreeData);
  const deadPackCommitData = serializeCommit({
    tree: deadPackTreeOid,
    parent: [],
    author: IDENTITY,
    committer: IDENTITY,
    message: "collect this packed history\n",
  });
  const deadPackCommitOid = hashObject("commit", deadPackCommitData);
  const deadPack = await store.packs.ingest(
    slices(
      fullPack([
        { type: "blob", data: deadPackBlobData },
        { type: "tree", data: deadPackTreeData },
        { type: "commit", data: deadPackCommitData },
      ]),
      64 * 1024,
    ),
    { reclaimPending: false, now: () => clock.value },
  );

  const deadLooseTreeSourceKey = treeSourceKey(db, checkout.repoId, deadLoose.treeOid, "loose", 0);
  const deadPackTreeSourceKey = treeSourceKey(
    db,
    checkout.repoId,
    deadPackTreeOid,
    "pack",
    deadPack.packId,
  );
  const deadLooseBlobOid = requiredItem(deadLoose.blobOids, 0, "dead loose blob");

  store.setRef("refs/heads/main", live.commitOid);
  store.setRef("refs/tags/mixed-live", mixedLiveOid);
  store.shared.upsertBlobIds([
    { contentId: new Uint8Array([1, 2, 3]), oid: deadLooseBlobOid },
    { contentId: new Uint8Array([4, 5, 6]), oid: deadPackBlobOid },
  ]);
  expect(store.cachedCommit(deadLoose.commitOid)).not.toBeNull();
  expect(store.cachedCommit(deadPackCommitOid)).not.toBeNull();

  return {
    repoId: checkout.repoId,
    liveLooseOids: live.oids,
    liveOids: [...live.oids, mixedLiveOid],
    liveFirstData: liveBlobData(0),
    liveLastData: liveBlobData(LIVE_LOOSE_OBJECTS - 3),
    liveTreeOid: live.treeOid,
    liveTreeData: live.treeData,
    liveCommitOid: live.commitOid,
    liveCommitData: live.commitData,
    deadLooseOids: deadLoose.oids,
    deadLooseBlobOid,
    deadLooseTreeOid: deadLoose.treeOid,
    deadLooseTreeSourceKey,
    deadLooseCommitOid: deadLoose.commitOid,
    mixedPackId: mixed.packId,
    mixedLiveOid,
    mixedLiveData,
    mixedDeadOid,
    mixedDeadData,
    deadPackId: deadPack.packId,
    deadPackBytes: deadPack.bytes,
    deadPackBlobOid,
    deadPackTreeOid,
    deadPackTreeSourceKey,
    deadPackCommitOid,
  };
}

async function publicMaintenanceCall(
  storage: SqliteTestStorage,
  clock: Clock,
): Promise<MaintenanceCallObservation> {
  const workspace = new Workspace({
    storage,
    git: createGit(),
    now: () => clock.value,
    defaultGitIdentity: IDENTITY,
  });
  storage.resetCounters();
  const result = await workspace.git.maintenance({ dir: "/repo" });
  expect(storage.statementCount).toBeLessThan(1_000);

  return { result };
}

function publishCompletedMark(
  db: TestDatabase,
  repoId: number,
  runId: number,
  liveOids: readonly string[],
  directRootOids: readonly string[],
): void {
  expect(liveOids).toHaveLength(LIVE_LOGICAL_OBJECTS);
  expect(directRootOids).toHaveLength(2);
  if (
    directRootOids[0] === undefined ||
    directRootOids[1] === undefined ||
    directRootOids[0] === directRootOids[1] ||
    !liveOids.includes(directRootOids[0]) ||
    !liveOids.includes(directRootOids[1])
  ) {
    throw new Error("maintenance direct roots are invalid");
  }
  const payload = JSON.stringify(liveOids);
  const rootPayload = JSON.stringify(directRootOids);
  db.transactionSync(() => {
    db.run("DELETE FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?", repoId, runId);
    db.run("DELETE FROM git_maintenance_shallow WHERE repo_id = ? AND run_id = ?", repoId, runId);
    db.run(
      `INSERT INTO git_maintenance_objects
       (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
       SELECT ?, ?, value, 0, 1, 0, 0, 0 FROM json_each(?)`,
      repoId,
      runId,
      payload,
    );
    db.run(
      `UPDATE git_maintenance_objects SET source_mask = 1
        WHERE repo_id = ? AND run_id = ?
          AND oid IN (SELECT value FROM json_each(?))`,
      repoId,
      runId,
      rootPayload,
    );
    db.run(
      `UPDATE git_maintenance_runs
          SET phase = 'classify-loose', root_source = 'done',
              cursor_checkout_id = NULL, cursor_text = NULL, cursor_ordinal = NULL,
              reachable_objects = ?, queued_objects = 0, next_eligible_ms = NULL
        WHERE repo_id = ? AND run_id = ? AND phase = 'roots'`,
      liveOids.length,
      repoId,
      runId,
    );
    expect(
      db.one<{
        phase: string;
        root_source: string;
        reachable_objects: number;
        queued_objects: number;
        marks: number;
      }>(
        `SELECT run.phase, run.root_source, run.reachable_objects, run.queued_objects,
                count(mark.oid) AS marks
           FROM git_maintenance_runs run
           LEFT JOIN git_maintenance_objects mark
             ON mark.repo_id = run.repo_id AND mark.run_id = run.run_id
          WHERE run.repo_id = ? AND run.run_id = ?
          GROUP BY run.repo_id, run.run_id`,
        repoId,
        runId,
      ),
    ).toEqual({
      phase: "classify-loose",
      root_source: "done",
      reachable_objects: liveOids.length,
      queued_objects: 0,
      marks: liveOids.length,
    });
    const rootRows = db.all<{ oid: string; source_mask: number; expanded: number }>(
      `SELECT oid, source_mask, expanded FROM git_maintenance_objects
        WHERE repo_id = ? AND run_id = ? AND source_mask != 0
        ORDER BY oid COLLATE BINARY`,
      repoId,
      runId,
    );
    expect(rootRows).toHaveLength(directRootOids.length);
    expect(new Set(rootRows.map((row) => row.oid))).toEqual(new Set(directRootOids));
    for (const row of rootRows) {
      expect(row.source_mask).toBe(1);
      expect(row.expanded).toBe(1);
    }
    expect(
      db.one<{ descendants: number; expanded: number }>(
        `SELECT
           sum(CASE WHEN source_mask = 0 THEN 1 ELSE 0 END) AS descendants,
           sum(CASE WHEN expanded = 1 THEN 1 ELSE 0 END) AS expanded
          FROM git_maintenance_objects WHERE repo_id = ? AND run_id = ?`,
        repoId,
        runId,
      ),
    ).toEqual({
      descendants: liveOids.length - directRootOids.length,
      expanded: liveOids.length,
    });
  });
}

async function finishRun(
  storage: SqliteTestStorage,
  clock: Clock,
  runId: number,
): Promise<{ complete: GitMaintenanceResult; calls: MaintenanceCallObservation[] }> {
  const calls: MaintenanceCallObservation[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const observation = await publicMaintenanceCall(storage, clock);
    const result = observation.result;
    expect(result.runId).toBe(runId);
    calls.push(observation);
    if (result.status === "complete") return { complete: result, calls };
  }
  throw new Error("maintenance cost run did not complete");
}

function looseRowBytes(db: TestDatabase, repoId: number, oids: readonly string[]): number {
  return storedByteAggregate(
    db.scalar<number>(
      `SELECT coalesce(sum(length(chunk.data)), 0)
         FROM git_object_chunks chunk
        WHERE chunk.repo_id = ? AND chunk.oid IN (SELECT value FROM json_each(?))`,
      repoId,
      JSON.stringify(oids),
    ),
    "loose stored byte aggregate",
  );
}

function packRowBytes(db: TestDatabase, repoId: number, packIds: readonly number[]): number {
  return storedByteAggregate(
    db.scalar<number>(
      `SELECT coalesce(sum(length(data)), 0) FROM git_pack_data
        WHERE repo_id = ? AND pack_id IN (SELECT value FROM json_each(?))`,
      repoId,
      JSON.stringify(packIds),
    ),
    "pack stored byte aggregate",
  );
}

function storageRowBytes(db: TestDatabase, repoId: number): number {
  const row = db.one<{ loose_bytes: number; pack_bytes: number }>(
    `SELECT
       coalesce((SELECT sum(length(data)) FROM git_object_chunks WHERE repo_id = ?), 0)
         AS loose_bytes,
       coalesce((SELECT sum(length(data)) FROM git_pack_data WHERE repo_id = ?), 0)
         AS pack_bytes`,
    repoId,
    repoId,
  );
  if (
    row === undefined ||
    !Number.isSafeInteger(row.loose_bytes) ||
    row.loose_bytes < 0 ||
    !Number.isSafeInteger(row.pack_bytes) ||
    row.pack_bytes < 0 ||
    row.loose_bytes > Number.MAX_SAFE_INTEGER - row.pack_bytes
  ) {
    throw new Error("authoritative storage byte aggregate is invalid");
  }
  return row.loose_bytes + row.pack_bytes;
}

describe("public maintenance storage pressure", () => {
  it("keeps every cold call bounded while repacking 2,049 live and sweeping 257 dead loose objects", async () => {
    const storage = new SqliteTestStorage();
    const clock: Clock = { value: START_MS };
    const fixture = await createFixture(storage, clock);
    const db = new TestDatabase(storage);
    const beforeBytes = storageRowBytes(db, fixture.repoId);
    const liveLooseStoredBytes = looseRowBytes(db, fixture.repoId, fixture.liveLooseOids);
    expect(liveLooseStoredBytes).toBeGreaterThan(0);

    const startedCall = await publicMaintenanceCall(storage, clock);
    const started = startedCall.result;
    expect(started).toMatchObject({ status: "progress", phase: "roots", runId: 1 });
    publishCompletedMark(db, fixture.repoId, started.runId, fixture.liveOids, [
      fixture.liveCommitOid,
      fixture.mixedLiveOid,
    ]);

    const first = await finishRun(storage, clock, started.runId);
    expect(first.complete).toMatchObject({
      status: "complete",
      phase: "finish",
      reachableObjects: LIVE_LOGICAL_OBJECTS,
      queuedObjects: 0,
      repackedObjects: LIVE_LOOSE_OBJECTS,
      reclaimedObjects: 0,
      reclaimedPacks: 0,
      reclaimedBytes: 0,
      nextEligibleAt: START_MS + GC_GRACE_MS,
    });
    expect(
      [...new Set(first.calls.map((call) => call.result.repackedObjects))].filter(
        (count) => count > 0,
      ),
    ).toEqual([2_048, LIVE_LOOSE_OBJECTS]);
    const maintenancePacks = db.all<{ pack_id: number; count: number }>(
      `SELECT pack_id, count FROM git_pack_meta
        WHERE repo_id = ? AND pack_id NOT IN (?, ?) ORDER BY pack_id`,
      fixture.repoId,
      fixture.mixedPackId,
      fixture.deadPackId,
    );
    expect(maintenancePacks.map((pack) => pack.count)).toEqual([2_048, 1]);
    const maintenancePackIds = maintenancePacks.map((pack) => pack.pack_id);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_loose_gc_candidates WHERE repo_id = ?",
        fixture.repoId,
      ),
    ).toBe(DEAD_LOOSE_OBJECTS);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_gc_candidates WHERE repo_id = ?",
        fixture.repoId,
      ),
    ).toBe(1);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_gc_candidates WHERE repo_id = ? AND pack_id = ?",
        fixture.repoId,
        fixture.mixedPackId,
      ),
    ).toBe(0);
    const deadLooseStoredBytes = storedByteAggregate(
      db.scalar<number>(
        `SELECT coalesce(sum(length(chunk.data)), 0)
           FROM git_loose_gc_candidates candidate
           JOIN git_object_chunks chunk
             ON chunk.repo_id = candidate.repo_id AND chunk.oid = candidate.oid
          WHERE candidate.repo_id = ?`,
        fixture.repoId,
      ),
      "dead loose stored byte aggregate",
    );

    clock.value = START_MS + GC_GRACE_MS;
    const rolloverCall = await publicMaintenanceCall(storage, clock);
    const rollover = rolloverCall.result;
    expect(rollover).toMatchObject({
      status: "progress",
      phase: "roots",
      runId: started.runId + 1,
      reachableObjects: 0,
      queuedObjects: 0,
      repackedObjects: 0,
      reclaimedObjects: 0,
      reclaimedPacks: 0,
      reclaimedBytes: 0,
    });
    publishCompletedMark(db, fixture.repoId, rollover.runId, fixture.liveOids, [
      fixture.liveCommitOid,
      fixture.mixedLiveOid,
    ]);

    const second = await finishRun(storage, clock, rollover.runId);
    expect(second.complete).toMatchObject({
      status: "complete",
      phase: "finish",
      reachableObjects: LIVE_LOGICAL_OBJECTS,
      queuedObjects: 0,
      repackedObjects: 0,
      reclaimedObjects: DEAD_LOOSE_OBJECTS + 3,
      reclaimedPacks: 1,
      reclaimedBytes: deadLooseStoredBytes + fixture.deadPackBytes,
      nextEligibleAt: null,
    });

    const finalDatabase = new SqliteGitDatabase(db, { now: () => clock.value });
    const checkout = finalDatabase.findCheckout("/repo");
    if (checkout === null) throw new Error("maintenance cost checkout disappeared");
    const finalStore = finalDatabase.openCheckout(checkout);
    const liveFirstOid = requiredItem(fixture.liveLooseOids, 0, "first live loose object");
    const liveLastOid = requiredItem(
      fixture.liveLooseOids,
      LIVE_LOOSE_OBJECTS - 3,
      "last live loose blob",
    );
    expect(finalStore.hasAll(fixture.liveOids).size).toBe(fixture.liveOids.length);
    expect(finalStore.read(liveFirstOid)?.data).toEqual(fixture.liveFirstData);
    expect(finalStore.read(liveLastOid)?.data).toEqual(fixture.liveLastData);
    expect(finalStore.read(fixture.liveTreeOid)?.data).toEqual(fixture.liveTreeData);
    expect(finalStore.read(fixture.liveCommitOid)?.data).toEqual(fixture.liveCommitData);
    expect(finalStore.read(fixture.mixedLiveOid)?.data).toEqual(fixture.mixedLiveData);
    expect(finalStore.read(fixture.mixedDeadOid)?.data).toEqual(fixture.mixedDeadData);

    expect(
      db.one<{ state: string; count: number }>(
        "SELECT state, count FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        fixture.repoId,
        fixture.mixedPackId,
      ),
    ).toEqual({ state: "complete", count: 2 });
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?",
        fixture.repoId,
        fixture.mixedPackId,
      ),
    ).toBe(2);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_pack_gc_candidates WHERE repo_id = ? AND pack_id = ?",
        fixture.repoId,
        fixture.mixedPackId,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        `SELECT EXISTS(
           SELECT 1 FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_data WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_gc_candidates WHERE repo_id = ? AND pack_id = ?
         )`,
        fixture.repoId,
        fixture.deadPackId,
        fixture.repoId,
        fixture.deadPackId,
        fixture.repoId,
        fixture.deadPackId,
        fixture.repoId,
        fixture.deadPackId,
      ),
    ).toBe(0);

    const deadLoosePayload = JSON.stringify(fixture.deadLooseOids);
    expect(
      db.scalar<number>(
        `SELECT EXISTS(
           SELECT 1 FROM git_objects WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
           UNION ALL SELECT 1 FROM git_object_chunks
             WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
           UNION ALL SELECT 1 FROM git_loose_object_lifecycle
             WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
           UNION ALL SELECT 1 FROM git_loose_gc_candidates
             WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))
         )`,
        fixture.repoId,
        deadLoosePayload,
        fixture.repoId,
        deadLoosePayload,
        fixture.repoId,
        deadLoosePayload,
        fixture.repoId,
        deadLoosePayload,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        `SELECT count(*) FROM git_blob_ids
          WHERE repo_id = ? AND oid IN (?, ?)`,
        fixture.repoId,
        fixture.deadLooseBlobOid,
        fixture.deadPackBlobOid,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        `SELECT count(*) FROM git_commits
          WHERE repo_id = ? AND oid IN (?, ?)`,
        fixture.repoId,
        fixture.deadLooseCommitOid,
        fixture.deadPackCommitOid,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        `SELECT count(*) FROM git_tree_sources
          WHERE repo_id = ? AND tree_oid IN (?, ?)`,
        fixture.repoId,
        fixture.deadLooseTreeOid,
        fixture.deadPackTreeOid,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        `SELECT count(*) FROM git_tree_effective
          WHERE repo_id = ? AND tree_oid IN (?, ?)`,
        fixture.repoId,
        fixture.deadLooseTreeOid,
        fixture.deadPackTreeOid,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>(
        `SELECT count(*) FROM git_tree_entries WHERE source_key IN (?, ?)`,
        fixture.deadLooseTreeSourceKey,
        fixture.deadPackTreeSourceKey,
      ),
    ).toBe(0);

    const afterBytes = storageRowBytes(db, fixture.repoId);
    const maintenancePackBytes = packRowBytes(db, fixture.repoId, maintenancePackIds);
    expect(maintenancePackBytes).toBeGreaterThan(0);
    expect(afterBytes).toBe(
      beforeBytes -
        deadLooseStoredBytes -
        fixture.deadPackBytes -
        liveLooseStoredBytes +
        maintenancePackBytes,
    );
    expect(afterBytes).toBeLessThan(beforeBytes);
  });
});
