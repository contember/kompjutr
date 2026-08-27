import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import {
  hashObject,
  MODE_COMMIT,
  MODE_FILE,
  type ObjectType,
  serializeCommit,
  serializeTag,
  serializeTree,
} from "../src/core/objects.js";
import { encodeDeltaHeader } from "../src/core/pack/delta.js";
import { PackWriter } from "../src/core/pack/writer.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { advanceMaintenanceReachability } from "../src/sqlite/maintenance/reachability.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

const PERSON = {
  name: "Reachability Fixture",
  email: "fixture@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

function open(db = new TestDatabase()) {
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { db, database, checkout, store };
}

class GuardedTreeEdgeDatabase implements SqlDatabase {
  sawGuardedProjection = false;

  constructor(
    readonly inner: TestDatabase,
    readonly ordinal: number,
    readonly field: "name" | "raw",
  ) {}

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
    const treeEdges = query.includes("maintenance-tree-edges");
    if (treeEdges) {
      this.sawGuardedProjection =
        query.includes("CASE WHEN typeof(name_bytes) = 'blob'") &&
        query.includes("CASE WHEN typeof(raw_entry) = 'blob'");
      if (!this.sawGuardedProjection) {
        throw new Error("tree edge query did not guard BLOBs before projection");
      }
    }
    for (const row of this.inner.iterate(query, ...bindings)) {
      if (!treeEdges || row.ordinal !== this.ordinal) {
        yield row;
      } else if (this.field === "name") {
        yield { ...row, name_type: "blob", name_length: 101 * 1024 * 1024, name_bytes: null };
      } else {
        yield { ...row, raw_type: "blob", raw_length: 101 * 1024 * 1024, raw_entry: null };
      }
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function openGuardedTree(ordinal: number, field: "name" | "raw") {
  const db = new TestDatabase();
  const guarded = new GuardedTreeEdgeDatabase(db, ordinal, field);
  const database = new SqliteGitDatabase(guarded, { objectCacheBytes: 16 * 1024 * 1024 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { db, guarded, checkout, store };
}

function seedMark(
  db: TestDatabase,
  repoId: number,
  roots: readonly { oid: string; shallow?: boolean }[],
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
     VALUES (?, 1, 0, 'mark', 1, 'done', 0, ?)`,
    repoId,
    roots.length,
  );
  for (const root of roots) {
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
          physical_only, edge_cursor)
       VALUES (?, 1, ?, 1, 0, ?, 0, 0)`,
      repoId,
      root.oid,
      root.shallow === true ? 1 : 0,
    );
    if (root.shallow === true) {
      db.run(
        `INSERT INTO git_maintenance_shallow (repo_id, run_id, oid)
         VALUES (?, 1, ?)`,
        repoId,
        root.oid,
      );
    }
  }
}

function commit(tree: string, parent: string[] = [], message = "fixture\n"): Uint8Array {
  return serializeCommit({
    tree,
    parent,
    author: PERSON,
    committer: PERSON,
    message,
  });
}

function marks(db: TestDatabase, repoId: number) {
  return db.all<{
    oid: string;
    expanded: number;
    physical_only: number;
    edge_cursor: number;
  }>(
    `SELECT oid, expanded, physical_only, edge_cursor
       FROM git_maintenance_objects WHERE repo_id = ? ORDER BY oid`,
    repoId,
  );
}

function drain(
  db: TestDatabase,
  shared: ReturnType<typeof open>["store"]["shared"],
  limit = 10_000,
): void {
  for (let call = 0; call < limit; call++) {
    db.storage.resetCounters();
    const progress = advanceMaintenanceReachability(shared);
    expect(db.storage.statementCount).toBeLessThan(900);
    if (progress.status === "complete") return;
  }
  throw new Error("reachability did not complete within the test bound");
}

function literalDelta(baseSize: number, target: Uint8Array): Uint8Array {
  const chunks = [encodeDeltaHeader(baseSize, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const part = target.subarray(offset, offset + 127);
    chunks.push(new Uint8Array([part.length]), part);
  }
  return concat(chunks);
}

function packedDelta(
  type: ObjectType,
  base: Uint8Array,
  target: Uint8Array,
): { bytes: Uint8Array; baseOid: string; targetOid: string } {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  const baseOid = hashObject(type, base);
  writer.header(2);
  writer.object(type, base);
  writer.refDelta(baseOid, literalDelta(base.length, target));
  writer.finish();
  return { bytes: concat(chunks), baseOid, targetOid: hashObject(type, target) };
}

function fullBlobPack(values: readonly Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(values.length);
  for (const value of values) writer.object("blob", value);
  writer.finish();
  return concat(chunks);
}

describe("maintenance reachability", () => {
  it("marks the direct tag, commit, tree, blob, and gitlink closure", () => {
    const { db, checkout, store } = open();
    const blob = store.write("blob", utf8.encode("file\n"));
    const gitlinkTree = store.write("tree", serializeTree([]));
    const gitlinkCommit = store.write("commit", commit(gitlinkTree, [], "gitlink\n"));
    const missingGitlink = "f".repeat(40);
    const tree = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "file", oid: blob },
        { mode: MODE_COMMIT, name: "missing", oid: missingGitlink },
        { mode: MODE_COMMIT, name: "present", oid: gitlinkCommit },
      ]),
    );
    const commitOid = store.write("commit", commit(tree));
    const tag = store.write(
      "tag",
      serializeTag({ object: commitOid, type: "commit", tag: "v1", message: "release\n" }),
    );
    seedMark(db, checkout.repoId, [{ oid: tag }]);

    drain(db, store.shared);

    const reachable = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reachable).toEqual(new Set([tag, commitOid, tree, blob, gitlinkCommit, gitlinkTree]));
    expect(reachable.has(missingGitlink)).toBe(false);
    expect(
      db.one<{ phase: string; queued_objects: number; reachable_objects: number }>(
        `SELECT phase, queued_objects, reachable_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ phase: "classify-loose", queued_objects: 0, reachable_objects: 6 });
  });

  it("pages more than 256 commit parents and persists the exact cursor", () => {
    const { db, checkout, store } = open();
    const tree = store.write("tree", serializeTree([]));
    const parents: string[] = [];
    for (let index = 0; index < 300; index++) {
      parents.push(store.write("commit", commit(tree, [], `parent ${index}\n`)));
    }
    const root = store.write("commit", commit(tree, parents, "octopus\n"));
    seedMark(db, checkout.repoId, [{ oid: root }]);
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({
      status: "progress",
      processedOid: root,
      discoveredObjects: 256,
      discoveredLogicalObjects: 256,
    });
    expect(db.storage.statementCount).toBeLessThan(900);
    expect([...db.storage.histogram.keys()].join("\n")).toContain("maintenance-loose-headers");
    expect(
      db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        root,
      ),
    ).toEqual({ expanded: 0, edge_cursor: 256 });
    expect(
      db.one<{ queued_objects: number; reachable_objects: number }>(
        "SELECT queued_objects, reachable_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ queued_objects: 257, reachable_objects: 257 });
  });

  it("retains a shallow commit tree and stops all parent edges", () => {
    const { db, checkout, store } = open();
    const parentTree = store.write("tree", serializeTree([]));
    const parent = store.write("commit", commit(parentTree, [], "parent\n"));
    const shallowTree = store.write("tree", serializeTree([]));
    const shallow = store.write("commit", commit(shallowTree, [parent], "shallow\n"));
    seedMark(db, checkout.repoId, [{ oid: shallow, shallow: true }]);

    drain(db, store.shared);

    const reachable = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reachable).toEqual(new Set([shallow, shallowTree]));
    expect(reachable.has(parent)).toBe(false);
  });

  it("pages direct tree entries, validates cost fields, and resumes after a cold reopen", () => {
    const { db, checkout, store } = open();
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (let index = 0; index < 300; index++) {
      const oid = store.write("blob", utf8.encode(`blob ${index}\n`));
      entries.push({ mode: MODE_FILE, name: `file-${String(index).padStart(3, "0")}`, oid });
    }
    const tree = store.write("tree", serializeTree(entries));
    seedMark(db, checkout.repoId, [{ oid: tree }]);
    db.storage.resetCounters();

    const first = advanceMaintenanceReachability(store.shared);
    expect(first).toMatchObject({ processedOid: tree, discoveredObjects: 256 });
    expect(db.storage.statementCount).toBe(12);
    expect(
      db.scalar<number>(
        `SELECT edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        tree,
      ),
    ).toBe(256);
    db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid != ?`,
      checkout.repoId,
      tree,
    );
    db.run("UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?", checkout.repoId);
    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
    const cold = reopened.openCheckout(checkout.id);

    const second = advanceMaintenanceReachability(cold.shared);

    expect(second).toMatchObject({ processedOid: tree, discoveredObjects: 44 });
    expect(
      db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        tree,
      ),
    ).toEqual({ expanded: 1, edge_cursor: 300 });
  });

  it("guards oversized current and lookahead tree BLOBs before materialization", () => {
    for (const fixture of [openGuardedTree(0, "name"), openGuardedTree(256, "raw")]) {
      const blob = fixture.store.write("blob", utf8.encode("shared\n"));
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (let index = 0; index < 257; index++) {
        entries.push({
          mode: MODE_FILE,
          name: `guard-${String(index).padStart(3, "0")}`,
          oid: blob,
        });
      }
      const tree = fixture.store.write("tree", serializeTree(entries));
      seedMark(fixture.db, fixture.checkout.repoId, [{ oid: tree }]);

      expect(() => advanceMaintenanceReachability(fixture.store.shared)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(fixture.guarded.sawGuardedProjection).toBe(true);
      expect(
        fixture.db.scalar<number>(
          "SELECT expanded FROM git_maintenance_objects WHERE repo_id = ? AND oid = ?",
          fixture.checkout.repoId,
          tree,
        ),
      ).toBe(0);
    }
  });

  it("streams large unknown and continuation tag headers without retaining the message", () => {
    const { db, checkout, store } = open();
    const target = store.write("blob", utf8.encode("target\n"));
    const header = `object ${target}\ntype blob\ntag large\nx ${"a".repeat(2 * 1024 * 1024)}\n ${"b".repeat(
      1024 * 1024,
    )}\n\n`;
    const tag = store.write("tag", concat([utf8.encode(header), new Uint8Array(2 * 1024 * 1024)]));
    seedMark(db, checkout.repoId, [{ oid: tag }]);
    const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 16 * 1024 * 1024 });
    const cold = reopened.openCheckout(checkout.id);
    db.storage.resetCounters();

    const progress = advanceMaintenanceReachability(cold.shared);

    expect(progress).toMatchObject({
      processedOid: tag,
      discoveredObjects: 1,
      discoveredLogicalObjects: 1,
    });
    expect(db.storage.statementCount).toBeLessThan(900);
    expect(marks(db, checkout.repoId).map((row) => row.oid)).toContain(target);
  });

  it("promotes an expanded physical mark to logical exactly once and requeues it", () => {
    const { db, checkout, store } = open();
    const target = store.write("blob", utf8.encode("promoted\n"));
    const tag = store.write(
      "tag",
      serializeTag({ object: target, type: "blob", tag: "promote", message: "\n" }),
    );
    seedMark(db, checkout.repoId, [{ oid: tag }]);
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
          physical_only, edge_cursor)
       VALUES (?, 1, ?, 0, 1, 0, 1, 0)`,
      checkout.repoId,
      target,
    );
    db.run(
      "UPDATE git_maintenance_runs SET reachable_objects = 1 WHERE repo_id = ?",
      checkout.repoId,
    );

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({
      processedOid: tag,
      discoveredObjects: 0,
      discoveredLogicalObjects: 1,
    });
    expect(
      db.one<{ expanded: number; physical_only: number; edge_cursor: number }>(
        `SELECT expanded, physical_only, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        target,
      ),
    ).toEqual({ expanded: 0, physical_only: 0, edge_cursor: 0 });
    expect(
      db.one<{ queued_objects: number; reachable_objects: number }>(
        "SELECT queued_objects, reachable_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ queued_objects: 1, reachable_objects: 2 });
  });

  it("marks exact packed delta bases as physical without expanding semantic bytes", async () => {
    const { db, checkout, store } = open();
    const base = utf8.encode("base blob\n");
    const target = utf8.encode("target blob\n");
    const pack = packedDelta("blob", base, target);
    await store.packs.ingest(slices(pack.bytes, 17));
    seedMark(db, checkout.repoId, [{ oid: pack.targetOid }]);

    const logical = advanceMaintenanceReachability(store.shared);
    expect(logical).toMatchObject({ processedOid: pack.targetOid, discoveredObjects: 1 });
    expect(
      db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        pack.baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });

    const physical = advanceMaintenanceReachability(store.shared);
    expect(physical).toMatchObject({
      processedOid: pack.baseOid,
      discoveredLogicalObjects: 0,
    });
    expect(
      db.scalar<number>(
        `SELECT physical_only FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        pack.baseOid,
      ),
    ).toBe(1);
  });

  it("rejects self, two-node, and longer complete-pack delta cycles in one bounded query", async () => {
    for (const links of [[0], [1, 0], [1, 2, 0]]) {
      const { db, checkout, store } = open();
      const values = links.map((_, index) => utf8.encode(`cycle ${links.length} ${index}\n`));
      const oids = values.map((value) => hashObject("blob", value));
      await store.packs.ingest(slices(fullBlobPack(values), 17));
      for (let index = 0; index < links.length; index++) {
        const baseIndex = links[index];
        const oid = oids[index];
        const baseOid = baseIndex === undefined ? undefined : oids[baseIndex];
        if (oid === undefined || baseOid === undefined) throw new Error("cycle fixture is invalid");
        db.run(
          "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND oid = ?",
          baseOid,
          checkout.repoId,
          oid,
        );
      }
      const root = oids[0];
      if (root === undefined) throw new Error("cycle fixture has no root");
      seedMark(db, checkout.repoId, [{ oid: root }]);
      db.storage.histogram = new Map();

      expect(() => advanceMaintenanceReachability(store.shared)).toThrow(/contains a cycle/);
      const chainQueries = [...db.storage.histogram.entries()].filter(([query]) =>
        query.includes("maintenance-pack-chain"),
      );
      expect(chainQueries).toHaveLength(1);
      expect(chainQueries[0]?.[1]).toBe(1);
    }
  });

  it("rejects wrong-type and missing packed delta terminals", async () => {
    const wrong = open();
    const blobBytes = utf8.encode("wrong type source\n");
    const treeBytes = serializeTree([]);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", blobBytes);
    writer.object("tree", treeBytes);
    writer.finish();
    await wrong.store.packs.ingest(slices(concat(chunks), 23));
    const blobOid = hashObject("blob", blobBytes);
    const treeOid = hashObject("tree", treeBytes);
    wrong.db.run(
      "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND oid = ?",
      treeOid,
      wrong.checkout.repoId,
      blobOid,
    );
    seedMark(wrong.db, wrong.checkout.repoId, [{ oid: blobOid }]);
    expect(() => advanceMaintenanceReachability(wrong.store.shared)).toThrow(/wrong type/);

    const missing = open();
    const source = utf8.encode("missing terminal\n");
    const sourceOid = hashObject("blob", source);
    await missing.store.packs.ingest(slices(fullBlobPack([source]), 19));
    missing.db.run(
      "UPDATE git_pack_objects SET base_oid = ? WHERE repo_id = ? AND oid = ?",
      "d".repeat(40),
      missing.checkout.repoId,
      sourceOid,
    );
    seedMark(missing.db, missing.checkout.repoId, [{ oid: sourceOid }]);
    expect(() => advanceMaintenanceReachability(missing.store.shared)).toThrow(/is missing/);
  });

  it("accepts a source-qualified packed delta chain ending at a same-type loose object", async () => {
    const { db, checkout, store } = open();
    const base = utf8.encode("external loose base\n");
    const target = utf8.encode("external loose target\n");
    const baseOid = store.write("blob", base);
    const targetOid = hashObject("blob", target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 13));
    seedMark(db, checkout.repoId, [{ oid: targetOid }]);
    db.storage.histogram = new Map();

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({ processedOid: targetOid, discoveredObjects: 1 });
    expect(
      db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        checkout.repoId,
        baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });
    const chainQueries = [...db.storage.histogram.entries()].filter(([query]) =>
      query.includes("maintenance-pack-chain"),
    );
    expect(chainQueries).toHaveLength(1);
    expect(chainQueries[0]?.[1]).toBe(1);
  });

  it("accepts complete pack id zero in the bounded base-chain validator", () => {
    const { db, checkout, store } = open();
    const bytes = utf8.encode("pack zero\n");
    const oid = hashObject("blob", bytes);
    db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 0, 0, 1, 'complete', 1)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       VALUES (?, ?, 0, 0, 0, 0, 'blob', ?, 0, NULL)`,
      checkout.repoId,
      oid,
      bytes.length,
    );
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(0);
    seedMark(db, checkout.repoId, [{ oid }]);

    expect(advanceMaintenanceReachability(store.shared)).toMatchObject({
      processedOid: oid,
      discoveredObjects: 0,
    });
  });

  it("does not expand semantic commit edges from a physical-only packed base", async () => {
    const { db, checkout, store } = open();
    const baseBlob = store.write("blob", utf8.encode("base-only\n"));
    const baseTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "base-only", oid: baseBlob }]),
    );
    const baseParent = store.write("commit", commit(baseTree, [], "base parent\n"));
    const targetTree = store.write("tree", serializeTree([]));
    const baseBytes = commit(baseTree, [baseParent], "packed base\n");
    const targetBytes = commit(targetTree, [], "packed target\n");
    const pack = packedDelta("commit", baseBytes, targetBytes);
    await store.packs.ingest(slices(pack.bytes, 23));
    seedMark(db, checkout.repoId, [{ oid: pack.targetOid }]);

    advanceMaintenanceReachability(store.shared);
    db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
      checkout.repoId,
      targetTree,
    );
    db.run("UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?", checkout.repoId);

    const physical = advanceMaintenanceReachability(store.shared);

    expect(physical).toMatchObject({
      processedOid: pack.baseOid,
      discoveredObjects: 0,
      discoveredLogicalObjects: 0,
    });
    const reachable = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reachable.has(baseTree)).toBe(false);
    expect(reachable.has(baseParent)).toBe(false);
  });

  it("defers packed commit and tree bases after an exact 256-edge semantic page", async () => {
    const packedCommit = open();
    const commitTree = packedCommit.store.write("tree", serializeTree([]));
    const parents: string[] = [];
    for (let index = 0; index < 255; index++) {
      parents.push(
        packedCommit.store.write("commit", commit(commitTree, [], `packed parent ${index}\n`)),
      );
    }
    const baseCommit = commit(commitTree, [], "delta base\n");
    const targetCommit = commit(commitTree, parents, "delta target\n");
    const commitPack = packedDelta("commit", baseCommit, targetCommit);
    await packedCommit.store.packs.ingest(slices(commitPack.bytes, 37));
    seedMark(packedCommit.db, packedCommit.checkout.repoId, [{ oid: commitPack.targetOid }]);

    advanceMaintenanceReachability(packedCommit.store.shared);

    expect(
      packedCommit.db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedCommit.checkout.repoId,
        commitPack.targetOid,
      ),
    ).toEqual({ expanded: 0, edge_cursor: 256 });
    expect(
      packedCommit.db.scalar<number>(
        `SELECT count(*) FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedCommit.checkout.repoId,
        commitPack.baseOid,
      ),
    ).toBe(0);
    packedCommit.db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid != ?`,
      packedCommit.checkout.repoId,
      commitPack.targetOid,
    );
    packedCommit.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?",
      packedCommit.checkout.repoId,
    );
    advanceMaintenanceReachability(packedCommit.store.shared);
    expect(
      packedCommit.db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedCommit.checkout.repoId,
        commitPack.baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });

    const packedTree = open();
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (let index = 0; index < 256; index++) {
      const oid = packedTree.store.write("blob", utf8.encode(`packed tree blob ${index}\n`));
      entries.push({ mode: MODE_FILE, name: `file-${String(index).padStart(3, "0")}`, oid });
    }
    const baseTree = serializeTree([]);
    const targetTree = serializeTree(entries);
    const treePack = packedDelta("tree", baseTree, targetTree);
    await packedTree.store.packs.ingest(slices(treePack.bytes, 41));
    seedMark(packedTree.db, packedTree.checkout.repoId, [{ oid: treePack.targetOid }]);

    advanceMaintenanceReachability(packedTree.store.shared);

    expect(
      packedTree.db.one<{ expanded: number; edge_cursor: number }>(
        `SELECT expanded, edge_cursor FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedTree.checkout.repoId,
        treePack.targetOid,
      ),
    ).toEqual({ expanded: 0, edge_cursor: 256 });
    expect(
      packedTree.db.scalar<number>(
        `SELECT count(*) FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedTree.checkout.repoId,
        treePack.baseOid,
      ),
    ).toBe(0);
    packedTree.db.run(
      `UPDATE git_maintenance_objects SET expanded = 1
        WHERE repo_id = ? AND run_id = 1 AND oid != ?`,
      packedTree.checkout.repoId,
      treePack.targetOid,
    );
    packedTree.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?",
      packedTree.checkout.repoId,
    );
    advanceMaintenanceReachability(packedTree.store.shared);
    expect(
      packedTree.db.one<{ physical_only: number; expanded: number }>(
        `SELECT physical_only, expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND run_id = 1 AND oid = ?`,
        packedTree.checkout.repoId,
        treePack.baseOid,
      ),
    ).toEqual({ physical_only: 1, expanded: 0 });
  });

  it("fails closed on missing mandatory edges and corrupt direct-tree rows", () => {
    const missing = open();
    const absent = "e".repeat(40);
    const missingTree = missing.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "missing", oid: absent }]),
    );
    seedMark(missing.db, missing.checkout.repoId, [{ oid: missingTree }]);
    expect(() => advanceMaintenanceReachability(missing.store.shared)).toThrow(
      /references a missing object/,
    );
    expect(
      missing.db.scalar<number>(
        `SELECT expanded FROM git_maintenance_objects
          WHERE repo_id = ? AND oid = ?`,
        missing.checkout.repoId,
        missingTree,
      ),
    ).toBe(0);

    const corrupt = open();
    const blob = corrupt.store.write("blob", utf8.encode("blob\n"));
    const tree = corrupt.store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }]),
    );
    corrupt.db.run(
      `UPDATE git_tree_entries SET raw_entry = x'00'
        WHERE source_key = (
          SELECT source_key FROM git_tree_effective WHERE repo_id = ? AND tree_oid = ?
        )`,
      corrupt.checkout.repoId,
      tree,
    );
    seedMark(corrupt.db, corrupt.checkout.repoId, [{ oid: tree }]);
    expect(() => advanceMaintenanceReachability(corrupt.store.shared)).toThrow(
      /raw edge disagrees/,
    );
  });

  it("fails closed on a stale packed tree source marker", async () => {
    const { db, checkout, store } = open();
    const treeBytes = serializeTree([]);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", treeBytes);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 13));
    const tree = hashObject("tree", treeBytes);
    db.run(
      `UPDATE git_tree_sources SET source_id = source_id + 1
        WHERE repo_id = ? AND tree_oid = ? AND storage = 'pack'`,
      checkout.repoId,
      tree,
    );
    seedMark(db, checkout.repoId, [{ oid: tree }]);

    expect(() => advanceMaintenanceReachability(store.shared)).toThrow(
      /not complete and source-qualified/,
    );
  });

  it("returns root-changed without publishing or changing counters", () => {
    const { db, checkout, store } = open();
    const blob = store.write("blob", utf8.encode("root\n"));
    seedMark(db, checkout.repoId, [{ oid: blob }]);
    const before = marks(db, checkout.repoId);
    db.run("UPDATE git_maintenance_control SET root_epoch = 1 WHERE repo_id = ?", checkout.repoId);

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toEqual({
      runId: 1,
      status: "root-changed",
      processedOid: null,
      discoveredObjects: 0,
      discoveredLogicalObjects: 0,
    });
    expect(marks(db, checkout.repoId)).toEqual(before);
    expect(
      db.one<{ reachable_objects: number; queued_objects: number }>(
        "SELECT reachable_objects, queued_objects FROM git_maintenance_runs WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toEqual({ reachable_objects: 0, queued_objects: 1 });
  });

  it("rejects drifted queue and logical counters at their exact audit boundaries", () => {
    const initialized = open();
    const first = initialized.store.write("blob", utf8.encode("first\n"));
    seedMark(initialized.db, initialized.checkout.repoId, [{ oid: first }]);
    initialized.db.run(
      "UPDATE git_maintenance_runs SET queued_objects = 2 WHERE repo_id = ?",
      initialized.checkout.repoId,
    );
    expect(() => advanceMaintenanceReachability(initialized.store.shared)).toThrow(
      /initial maintenance counters disagree/,
    );

    const completed = open();
    const second = completed.store.write("blob", utf8.encode("second\n"));
    seedMark(completed.db, completed.checkout.repoId, [{ oid: second }]);
    advanceMaintenanceReachability(completed.store.shared);
    completed.db.run(
      "UPDATE git_maintenance_runs SET reachable_objects = 2 WHERE repo_id = ?",
      completed.checkout.repoId,
    );
    expect(() => advanceMaintenanceReachability(completed.store.shared)).toThrow(
      /completed maintenance counters disagree/,
    );
  });

  it("audits completed marks exactly after a cold classify-loose reopen", () => {
    const stable = open();
    const stableBlob = stable.store.write("blob", utf8.encode("stable complete\n"));
    seedMark(stable.db, stable.checkout.repoId, [{ oid: stableBlob }]);
    drain(stable.db, stable.store.shared);
    const stableReopen = new SqliteGitDatabase(stable.db, { objectCacheBytes: 1024 * 1024 });
    expect(
      advanceMaintenanceReachability(stableReopen.openCheckout(stable.checkout.id).shared),
    ).toMatchObject({ status: "complete", processedOid: null });

    for (const corruption of ["queued", "reachable", "logical", "physical"]) {
      const fixture = open();
      const blob = fixture.store.write("blob", utf8.encode(`complete ${corruption}\n`));
      seedMark(fixture.db, fixture.checkout.repoId, [{ oid: blob }]);
      drain(fixture.db, fixture.store.shared);
      if (corruption === "queued") {
        fixture.db.run(
          "UPDATE git_maintenance_runs SET queued_objects = 1 WHERE repo_id = ?",
          fixture.checkout.repoId,
        );
      } else if (corruption === "reachable") {
        fixture.db.run(
          "UPDATE git_maintenance_runs SET reachable_objects = reachable_objects + 1 WHERE repo_id = ?",
          fixture.checkout.repoId,
        );
      } else if (corruption === "logical") {
        fixture.db.run(
          "UPDATE git_maintenance_objects SET expanded = 0 WHERE repo_id = ? AND oid = ?",
          fixture.checkout.repoId,
          blob,
        );
      } else {
        fixture.db.run(
          `INSERT INTO git_maintenance_objects
             (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
              physical_only, edge_cursor)
           VALUES (?, 1, ?, 0, 0, 0, 1, 0)`,
          fixture.checkout.repoId,
          "c".repeat(40),
        );
      }
      const reopened = new SqliteGitDatabase(fixture.db, { objectCacheBytes: 1024 * 1024 });
      expect(() =>
        advanceMaintenanceReachability(reopened.openCheckout(fixture.checkout.id).shared),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    }
  });

  it("ignores valid-looking corrupt and oversized commit cache rows in favor of raw headers", () => {
    const { db, checkout, store } = open();
    const tree = store.write("tree", serializeTree([]));
    const parentTreeBlob = store.write("blob", utf8.encode("parent tree\n"));
    const parentTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "parent", oid: parentTreeBlob }]),
    );
    const parent = store.write("commit", commit(parentTree, [], "actual parent\n"));
    const root = store.write("commit", commit(tree, [parent], "actual root\n"));
    const decoyBlob = store.write("blob", utf8.encode("decoy tree\n"));
    const decoyTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "decoy", oid: decoyBlob }]),
    );
    const decoyParent = store.write("commit", commit(decoyTree, [], "decoy parent\n"));
    db.run(
      `UPDATE git_commits
          SET tree = ?, parents = json_array(?), cache_bytes = ?
        WHERE repo_id = ? AND oid = ?`,
      decoyTree,
      decoyParent,
      101 * 1024 * 1024,
      checkout.repoId,
      root,
    );
    seedMark(db, checkout.repoId, [{ oid: root }]);
    db.storage.histogram = new Map();

    const progress = advanceMaintenanceReachability(store.shared);

    expect(progress).toMatchObject({ processedOid: root, discoveredLogicalObjects: 2 });
    const queryText = [...db.storage.histogram.keys()].join("\n");
    expect(queryText).toContain("maintenance-loose-headers");
    expect(queryText).not.toContain("git_commits");
    const reached = new Set(marks(db, checkout.repoId).map((row) => row.oid));
    expect(reached.has(tree)).toBe(true);
    expect(reached.has(parent)).toBe(true);
    expect(reached.has(decoyTree)).toBe(false);
    expect(reached.has(decoyParent)).toBe(false);
  });

  it("uses raw loose and packed commit headers regardless of derived cache qualification", async () => {
    const loose = open();
    const looseTree = loose.store.write("tree", serializeTree([]));
    const looseCommit = loose.store.write("commit", commit(looseTree));
    loose.db.run(
      "UPDATE git_commits SET object_size = object_size + 1 WHERE repo_id = ? AND oid = ?",
      loose.checkout.repoId,
      looseCommit,
    );
    seedMark(loose.db, loose.checkout.repoId, [{ oid: looseCommit }]);
    loose.db.storage.histogram = new Map();

    advanceMaintenanceReachability(loose.store.shared);

    expect([...loose.db.storage.histogram.keys()].join("\n")).toContain(
      "maintenance-loose-headers",
    );
    expect(marks(loose.db, loose.checkout.repoId).map((row) => row.oid)).toContain(looseTree);

    const packed = open();
    const packedTree = packed.store.write("tree", serializeTree([]));
    const packedBytes = commit(packedTree);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("commit", packedBytes);
    writer.finish();
    await packed.store.packs.ingest(slices(concat(chunks), 19));
    const packedCommit = hashObject("commit", packedBytes);
    packed.db.run(
      "UPDATE git_commits SET object_size = object_size + 1 WHERE repo_id = ? AND oid = ?",
      packed.checkout.repoId,
      packedCommit,
    );
    seedMark(packed.db, packed.checkout.repoId, [{ oid: packedCommit }]);

    const progress = advanceMaintenanceReachability(packed.store.shared);

    expect(progress).toMatchObject({ processedOid: packedCommit, discoveredLogicalObjects: 1 });
    expect(marks(packed.db, packed.checkout.repoId).map((row) => row.oid)).toContain(packedTree);
  });

  it("resumes a 50,001-commit history cold beyond the bounded graph-reader limit", () => {
    const { db, checkout, store } = open();
    const tree = store.write("tree", serializeTree([]));
    const chain: string[] = [];
    store.writeObjects(
      (batch) => {
        let parent: string[] = [];
        for (let index = 0; index < 50_001; index++) {
          const oid = batch.write("commit", commit(tree, parent, `history ${index}\n`));
          chain.push(oid);
          parent = [oid];
        }
      },
      { flushEvery: 2_048 },
    );
    const root = chain[chain.length - 1];
    if (root === undefined) throw new Error("history fixture is empty");
    seedMark(db, checkout.repoId, [{ oid: root }]);
    const queuePlan = db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT oid FROM git_maintenance_objects
        WHERE repo_id = ? AND run_id = 1 AND expanded = 0
        ORDER BY physical_only ASC, oid COLLATE BINARY LIMIT 2`,
      checkout.repoId,
    );
    expect(queuePlan.some((row) => row.detail.includes("git_maintenance_objects_queue"))).toBe(
      true,
    );
    expect(queuePlan.some((row) => row.detail.includes("USE TEMP B-TREE"))).toBe(false);

    let shared = store.shared;
    db.storage.resetCounters();
    let progress = advanceMaintenanceReachability(shared);
    let maximumStatements = db.storage.statementCount;
    if (db.storage.statementCount >= 900) {
      throw new Error(`reachability slice used ${db.storage.statementCount} statements`);
    }
    for (let call = 1; progress.status !== "complete"; call++) {
      if (call === 25_000) {
        const reopened = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024 });
        shared = reopened.openCheckout(checkout.id).shared;
      }
      db.storage.resetCounters();
      progress = advanceMaintenanceReachability(shared);
      maximumStatements = Math.max(maximumStatements, db.storage.statementCount);
      if (db.storage.statementCount >= 900) {
        throw new Error(`reachability slice used ${db.storage.statementCount} statements`);
      }
      if (call > 50_005) throw new Error("large history did not terminate");
    }

    expect(maximumStatements).toBe(12);
    expect(
      db.one<{ phase: string; queued_objects: number; reachable_objects: number }>(
        `SELECT phase, queued_objects, reachable_objects
           FROM git_maintenance_runs WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({
      phase: "classify-loose",
      queued_objects: 0,
      reachable_objects: 50_002,
    });
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ? AND physical_only = 0",
        checkout.repoId,
      ),
    ).toBe(50_002);
  }, 300_000);
});
