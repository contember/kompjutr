import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import { hashObject, MODE_FILE, serializeTree } from "../src/core/objects.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { deflate } from "../src/core/zlib.js";
import { blob, readBlob } from "../src/sqlite/db.js";
import {
  ancestors,
  blobIdMismatchRetainedBytes,
  contentIdKey,
  MAX_BLOB_ID_MISMATCH_RETAINED_BYTES,
  SqliteGitDatabase,
} from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const repository = database.create("/repo", "ref: refs/heads/main");
  return { db, database, store: database.open(repository) };
}

function insertRawBlob(db: TestDatabase, repoId: number, data: Uint8Array): string {
  const oid = hashObject("blob", data);
  db.run(
    "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, 'blob', ?, 'raw')",
    repoId,
    oid,
    data.length,
  );
  db.run(
    "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
    repoId,
    oid,
    blob(data),
  );
  return oid;
}

describe("path helpers", () => {
  it("walks ancestors nearest first", () => {
    expect(ancestors("/a/b/c")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    expect(ancestors("/")).toEqual(["/"]);
  });
});

describe("repository registry", () => {
  it("resolves the nearest registered ancestor", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    database.create("/", "ref: refs/heads/main");
    database.create("/projects/app", "ref: refs/heads/main");
    expect(database.find("/projects/app/src/index.ts")?.root).toBe("/projects/app");
    expect(database.find("/projects/other")?.root).toBe("/");
    expect(database.find("/projects/appliance")?.root).toBe("/");
  });

  it("creates no .git rows of any kind", () => {
    const { database } = open();
    const tables = database.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "git_blob_ids",
      "git_commits",
      "git_config",
      "git_index",
      "git_index_dirty",
      "git_index_state",
      "git_meta",
      "git_object_chunks",
      "git_objects",
      "git_operation_state",
      "git_operation_touched",
      "git_pack_data",
      "git_pack_meta",
      "git_pack_objects",
      "git_pack_pending",
      "git_refs",
      "git_repositories",
      "git_shallow",
      "git_tree_effective",
      "git_tree_entries",
      "git_tree_sources",
    ]);
  });

  it("does not install cross-schema triggers in a Git-only database", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    expect(
      database.db.scalar<number>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'index_tracker_%'",
      ),
    ).toBe(0);
  });

  it("shares one 8 MiB object cache across repositories", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const first = database.open(database.create("/one", "ref: refs/heads/main"));
    const second = database.open(database.create("/two", "ref: refs/heads/main"));
    for (let index = 0; index < 10; index++) {
      const data = new Uint8Array(1024 * 1024).fill(index);
      (index < 5 ? first : second).write("blob", data);
    }
    expect(first.cacheBytes().objects).toBe(8 * 1024 * 1024);
    expect(second.cacheBytes()).toEqual(first.cacheBytes());
  });

  it("isolates equal oids by repository and store generation", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const firstRow = database.create("/one", "ref: refs/heads/main");
    const secondRow = database.create("/two", "ref: refs/heads/main");
    const first = database.open(firstRow);
    const data = utf8.encode("same object, isolated cache\n");
    const oid = first.write("blob", data);
    expect(insertRawBlob(db, secondRow.id, data)).toBe(oid);
    const second = database.open(secondRow);

    db.storage.resetCounters();
    expect(second.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBeGreaterThan(0);
    db.storage.resetCounters();
    expect(second.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBe(0);

    first.destroy();
    second.destroy();
    const recreated = database.create("/recreated", "ref: refs/heads/main");
    expect(recreated.id).toBe(firstRow.id);
    expect(insertRawBlob(db, recreated.id, data)).toBe(oid);
    const replacement = database.open(recreated);
    db.storage.resetCounters();
    expect(replacement.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBeGreaterThan(0);
  });
});

describe("blob id batches", () => {
  it("round-trips 9,329 opaque binary ids in bounded statements", () => {
    const { db, store } = open();
    const mappings = Array.from({ length: 9_329 }, (_, index) => {
      const contentId = new Uint8Array(20);
      contentId[0] = index & 0xff;
      contentId[1] = (index >>> 8) & 0xff;
      contentId[2] = 0;
      return { contentId, oid: index.toString(16).padStart(40, "0") };
    });
    mappings.push({ contentId: new Uint8Array(0), oid: "f".repeat(40) });
    db.storage.resetCounters();
    store.upsertBlobIds(mappings);
    const writtenStatements = db.storage.statementCount;
    const found = store.lookupBlobIds(mappings.map((mapping) => mapping.contentId));
    const totalStatements = db.storage.statementCount;

    expect(writtenStatements).toBeLessThanOrEqual(10);
    expect(totalStatements).toBeLessThanOrEqual(20);
    expect(found.size).toBe(mappings.length);
    for (const mapping of mappings) {
      expect(found.get(contentIdKey(mapping.contentId))).toBe(mapping.oid);
    }

    db.storage.resetCounters();
    expect(store.blobIdMismatches(mappings)).toEqual(new Map());
    expect(db.storage.statementCount).toBeLessThanOrEqual(3);
    expect(db.storage.rowCount).toBe(0);
  });

  it("returns only mismatched and missing expected identities", () => {
    const { db, store } = open();
    const matching = new Uint8Array([0, 1, 0]);
    const mismatched = new Uint8Array([0, 2, 0]);
    const missing = new Uint8Array([0, 3, 0]);
    const matchingOid = "1".repeat(40);
    const actualOid = "2".repeat(40);
    store.upsertBlobIds([
      { contentId: matching, oid: matchingOid },
      { contentId: mismatched, oid: actualOid },
    ]);

    db.storage.resetCounters();
    const result = store.blobIdMismatches([
      { contentId: matching, oid: matchingOid },
      { contentId: mismatched, oid: "3".repeat(40) },
      { contentId: missing, oid: "4".repeat(40) },
      // Conflicting expectations for one identity must still expose its actual oid.
      { contentId: matching, oid: "5".repeat(40) },
    ]);

    expect(result).toEqual(
      new Map([
        [1, actualOid],
        [2, null],
        [3, matchingOid],
      ]),
    );
    expect(db.storage.statementCount).toBe(1);
    expect(db.storage.rowCount).toBe(3);
  });

  it("bounds all expected and returned identity state before SQL", () => {
    const { db, store } = open();
    const oid = "1".repeat(40);
    const full = new Uint8Array(1024 * 1024);
    const emptyCost = blobIdMismatchRetainedBytes({ contentId: new Uint8Array(0), oid });
    const fullCost = blobIdMismatchRetainedBytes({ contentId: full, oid });
    const prefix = Array.from({ length: 15 }, (_, index) => {
      const contentId = full.slice();
      contentId[0] = index;
      return { contentId, oid };
    });
    const lastLength = MAX_BLOB_ID_MISMATCH_RETAINED_BYTES - prefix.length * fullCost - emptyCost;
    expect(lastLength).toBeGreaterThan(0);
    expect(lastLength).toBeLessThanOrEqual(1024 * 1024);
    const exact = [...prefix, { contentId: new Uint8Array(lastLength), oid }];
    expect(exact.reduce((bytes, mapping) => bytes + blobIdMismatchRetainedBytes(mapping), 0)).toBe(
      MAX_BLOB_ID_MISMATCH_RETAINED_BYTES,
    );

    db.storage.resetCounters();
    expect(store.blobIdMismatches(exact).size).toBe(exact.length);
    expect(db.storage.statementCount).toBeLessThanOrEqual(20);

    db.storage.resetCounters();
    expect(() =>
      store.blobIdMismatches([...prefix, { contentId: new Uint8Array(lastLength + 1), oid }]),
    ).toThrow(/comparison state exceeds/);
    expect(db.storage.statementCount).toBe(0);
  });

  it("rejects invalid expected identities and fails closed on corrupt mappings", () => {
    const { store } = open();
    const contentId = new Uint8Array([9]);
    expect(() => store.blobIdMismatches([{ contentId, oid: "not-an-oid" }])).toThrow(
      /invalid blob oid/,
    );
    expect(() =>
      store.blobIdMismatches([{ contentId: new Uint8Array(1024 * 1024 + 1), oid: "1".repeat(40) }]),
    ).toThrow(/exceeds the 1 MiB/);

    store.upsertBlobIds([{ contentId, oid: "1".repeat(40) }]);
    store.db.run("UPDATE git_blob_ids SET oid = 'broken' WHERE repo_id = ?", 1);
    expect(() => store.blobIdMismatches([{ contentId, oid: "2".repeat(40) }])).toThrow(
      /invalid mapping/,
    );
  });

  it("isolates mappings and removes them with their repository", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const first = database.open(database.create("/one", "ref: refs/heads/main"));
    const second = database.open(database.create("/two", "ref: refs/heads/main"));
    const contentId = new Uint8Array([0, 255, 0]);
    first.upsertBlobIds([{ contentId, oid: "1".repeat(40) }]);
    second.upsertBlobIds([{ contentId, oid: "2".repeat(40) }]);
    expect(first.lookupBlobIds([contentId]).get(contentIdKey(contentId))).toBe("1".repeat(40));
    expect(second.lookupBlobIds([contentId]).get(contentIdKey(contentId))).toBe("2".repeat(40));
    first.destroy();
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids")).toBe(1);
  });
});

describe("loose objects", () => {
  it("rejects an oversized tree name while the parser field is growing", () => {
    const { store } = open();
    const data = concat([
      utf8.encode("100644 "),
      new Uint8Array(2_201).fill(0x61),
      new Uint8Array([0]),
      new Uint8Array(20),
    ]);
    expect(() => store.write("tree", data)).toThrow(/entry name is too long/);
    expect(store.objectCount()).toBe(0);
  });

  it("round-trips through chunked storage", () => {
    const { store } = open();
    const data = new TextEncoder().encode("hello world\n");
    const oid = store.write("blob", data);
    expect(oid).toBe(hashObject("blob", data));
    expect(store.has(oid)).toBe(true);
    expect(store.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("stores objects through the exact 4 KiB raw boundary", () => {
    const { store } = open();
    for (const size of [0, 1, 4_095, 4_096, 4_097]) {
      const data = new Uint8Array(randomBytes(size));
      const oid = store.write("blob", data);
      const row = store.db.one<{ stored: string; data: unknown }>(
        `SELECT o.stored, c.data FROM git_objects o
          JOIN git_object_chunks c ON c.repo_id = o.repo_id AND c.oid = o.oid
         WHERE o.repo_id = ? AND o.oid = ? AND c.seq = 0`,
        1,
        oid,
      );
      if (row === undefined) throw new Error(`missing loose row for ${oid}`);
      expect(row.stored).toBe(size <= 4_096 ? "raw" : "zlib");
      if (size <= 4_096) expect(readBlob(row.data)).toEqual(data);
      expect(oid).toBe(hashObject("blob", data));
      expect(store.read(oid)?.data).toEqual(data);
    }
  });

  it("chunks objects larger than one row", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(3_500_000));
    const oid = store.write("blob", data);
    const chunks = store.db.scalar<number>(
      "SELECT COUNT(*) FROM git_object_chunks WHERE oid = ?",
      oid,
    );
    expect(chunks).toBeGreaterThan(1);
    expect(store.read(oid)?.data.length).toBe(data.length);
  });

  it("resolves unambiguous prefixes only", () => {
    const { store } = open();
    const oid = store.write("blob", new TextEncoder().encode("a"));
    expect(store.resolvePrefix(oid.slice(0, 7))).toBe(oid);
    expect(store.resolvePrefix("0".repeat(8))).toBeNull();
  });

  it("reads 1,000 loose blobs in one bounded batch", () => {
    const { db, store } = open();
    const expected = new Map<string, Uint8Array>();
    store.writeObjects((batch) => {
      for (let index = 0; index < 1_000; index++) {
        const data = new Uint8Array(257).fill(index & 0xff);
        data[0] = index & 0xff;
        data[1] = index >>> 8;
        expected.set(batch.write("blob", data), data);
      }
    });
    const wanted = [...expected.keys()];
    db.storage.resetCounters();
    const read = store.readBlobs([wanted[0]!, ...wanted, wanted[0]!], {
      budgetBytes: 1024 * 1024,
    });
    expect(read.remaining).toEqual([]);
    expect(read.blobs.size).toBe(expected.size);
    for (const [oid, data] of expected) expect(read.blobs.get(oid)).toEqual(data);
    expect(db.storage.statementCount).toBe(3);
  });

  it("returns remaining at object boundaries and rejects no-progress reads", () => {
    const { store } = open();
    const first = store.write("blob", new Uint8Array(10));
    const second = store.write("blob", new Uint8Array(20));
    expect(store.readBlobs([first, second], { budgetBytes: 10 })).toEqual({
      blobs: new Map([[first, new Uint8Array(10)]]),
      remaining: [second],
      bytes: 10,
    });
    expect(() => store.readBlobs([second], { budgetBytes: 10 })).toThrow(/EFBIG|exceeds/);
  });
});

describe("effective tree sources", () => {
  const effective = (db: TestDatabase, repoId: number, oid: string) =>
    db.one<{ storage: string; source_id: number }>(
      "SELECT storage, source_id FROM git_tree_effective WHERE repo_id = ? AND tree_oid = ?",
      repoId,
      oid,
    );

  it("tracks single and batch loose tree writes", () => {
    const { db, store } = open();
    const first = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const second = serializeTree([{ mode: MODE_FILE, name: "b", oid: "2".repeat(40) }]);
    const firstOid = store.write("tree", first);
    const secondOid = store.writeObjects((batch) => batch.write("tree", second));

    expect(effective(db, 1, firstOid)).toEqual({ storage: "loose", source_id: 0 });
    expect(effective(db, 1, secondOid)).toEqual({ storage: "loose", source_id: 0 });
  });

  it("indexes a raw tree written through the streaming path", () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "streamed", oid: "3".repeat(40) }]);
    const oid = store.writeStream("tree", data.length, function* () {
      yield data.subarray(0, 7);
      yield data.subarray(7);
    });

    expect(
      db.scalar<string>("SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?", 1, oid),
    ).toBe("raw");
    expect([...store.walkTree(oid)]).toEqual([
      { path: "streamed", mode: MODE_FILE, oid: "3".repeat(40) },
    ]);
  });

  it("removes stale parsed rows before rewriting a deleted loose tree", () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = store.write("tree", data);
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(
      db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toBe(0);

    expect(store.write("tree", data)).toBe(oid);
    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: "1".repeat(40) }]);
  });

  it("falls back to a complete packed copy when the loose tree is deleted", async () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = store.write("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const { packId } = await store.packs.ingest(slices(concat(chunks), 64));

    expect(effective(db, 1, oid)).toEqual({ storage: "loose", source_id: 0 });
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(effective(db, 1, oid)).toEqual({ storage: "pack", source_id: packId });
    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: "1".repeat(40) }]);
  });

  it("isolates identical tree ids between repositories", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const first = database.open(database.create("/one", "ref: refs/heads/main"));
    const second = database.open(database.create("/two", "ref: refs/heads/main"));
    const data = serializeTree([{ mode: MODE_FILE, name: "same", oid: "1".repeat(40) }]);
    const oid = first.write("tree", data);
    expect(second.write("tree", data)).toBe(oid);

    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(effective(db, 1, oid)).toBeUndefined();
    expect(effective(db, 2, oid)).toEqual({ storage: "loose", source_id: 0 });
    expect([...second.walkTree(oid)]).toHaveLength(1);
  });
});

describe("object batches", () => {
  const chunkCount = (store: ReturnType<typeof open>["store"], oid: string) =>
    store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE oid = ?", oid);

  it("round-trips every payload shape through the ordinary read path", () => {
    const { store } = open();
    const shapes: Uint8Array[] = [
      new Uint8Array(0),
      utf8.encode("a tree entry or two\n"),
      new Uint8Array(randomBytes(4_096)),
      new Uint8Array(randomBytes(4_097)),
      // Random, so it neither compresses nor fits in one 1 MiB chunk row.
      new Uint8Array(randomBytes(3_500_000)),
      new Uint8Array(randomBytes(200_000)),
    ];
    const oids = store.writeObjects((batch) => shapes.map((data) => batch.write("blob", data)));
    // Identity by length plus hash: a megabyte-scale deep compare costs
    // more than the whole rest of this file.
    const same = (actual: Uint8Array, expected: Uint8Array) => {
      expect(actual.length).toBe(expected.length);
      expect(hashObject("blob", actual)).toBe(hashObject("blob", expected));
    };
    shapes.forEach((data, at) => {
      const oid = oids[at]!;
      expect(oid).toBe(hashObject("blob", data));
      expect(store.has(oid)).toBe(true);
      expect(store.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
      expect(
        store.db.scalar<string>(
          "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
          1,
          oid,
        ),
      ).toBe(data.length <= 4_096 ? "raw" : "zlib");
      same(store.read(oid)?.data ?? new Uint8Array(1), data);
      same(concat([...(store.readChunks(oid) ?? [])]), data);
    });
    expect(chunkCount(store, oids[4]!)).toBeGreaterThan(1);
  });

  it("stores empty blobs and trees as one non-null raw BLOB chunk", () => {
    const { store } = open();
    const empty = new Uint8Array(0);
    const [blobOid, treeOid] = store.writeObjects((batch) => [
      batch.write("blob", empty),
      batch.write("tree", empty),
    ]);

    const objects: { type: "blob" | "tree"; oid: string | undefined }[] = [
      { type: "blob", oid: blobOid },
      { type: "tree", oid: treeOid },
    ];
    for (const { type, oid } of objects) {
      if (oid === undefined) throw new Error(`missing empty ${type} oid`);
      expect(oid).toBe(hashObject(type, empty));
      expect(
        store.db.scalar<string>(
          "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
          1,
          oid,
        ),
      ).toBe("raw");
      expect(
        store.db.one<{ seq: number; dataType: string; bytes: number }>(
          `SELECT seq, typeof(data) AS dataType, length(data) AS bytes
             FROM git_object_chunks WHERE repo_id = ? AND oid = ?`,
          1,
          oid,
        ),
      ).toEqual({ seq: 0, dataType: "blob", bytes: 0 });
      expect(store.read(oid)).toEqual({ type, data: empty });
    }

    if (treeOid === undefined) throw new Error("missing empty tree oid");
    expect(
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = ? AND tree_oid = ?",
        1,
        treeOid,
      ),
    ).toBe(1);
    expect([...store.walkTree(treeOid)]).toEqual([]);
  });

  it("stages an object without writing a row until it is flushed", () => {
    const { store } = open();
    const data = utf8.encode("deferred\n");
    const batch = store.writeBatch();
    const oid = batch.write("blob", data);
    expect(oid).toBe(hashObject("blob", data));
    expect(store.has(oid)).toBe(false);
    expect(chunkCount(store, oid)).toBe(0);
    batch.flush();
    expect(store.has(oid)).toBe(true);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("owns raw and zlib blob bytes before the caller can mutate them", () => {
    const { store } = open();
    const inputs = [new Uint8Array(randomBytes(4_096)), new Uint8Array(randomBytes(4_097))];
    const expected = inputs.map((data) => data.slice());
    const batch = store.writeBatch();
    const oids = inputs.map((data) => batch.write("blob", data));
    for (const data of inputs) data.fill(0);
    batch.flush();

    expected.forEach((data, index) => {
      const oid = oids[index];
      if (oid === undefined) throw new Error(`missing oid ${index}`);
      expect(oid).toBe(hashObject("blob", data));
      expect(store.read(oid)?.data).toEqual(data);
    });
  });

  it("owns raw and zlib tree bytes used by the parsed index", () => {
    const { store } = open();
    const rawEntries = [{ mode: MODE_FILE, name: "raw", oid: "1".repeat(40) }];
    const zlibEntries = Array.from({ length: 160 }, (_, index) => ({
      mode: MODE_FILE,
      name: `file-${String(index).padStart(3, "0")}.txt`,
      oid: String(index).padStart(40, "0"),
    }));
    const raw = serializeTree(rawEntries);
    const zlib = serializeTree(zlibEntries);
    const rawExpected = raw.slice();
    const zlibExpected = zlib.slice();
    expect(raw.length).toBeLessThanOrEqual(4_096);
    expect(zlib.length).toBeGreaterThan(4_096);
    const batch = store.writeBatch();
    const rawOid = batch.write("tree", raw);
    const zlibOid = batch.write("tree", zlib);
    raw.fill(0);
    zlib.fill(0);
    batch.flush();

    expect(store.read(rawOid)?.data).toEqual(rawExpected);
    expect(store.read(zlibOid)?.data).toEqual(zlibExpected);
    expect([...store.walkTree(rawOid)].map((row) => row.path)).toEqual(["raw"]);
    expect([...store.walkTree(zlibOid)].map((row) => row.path)).toEqual(
      zlibEntries.map((row) => row.name),
    );
  });

  it("removes the chunks a shorter write of the same oid does not reach", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(700_000));
    // writeStream rows at 64 KiB, the batch at 1 MiB, so the same oid goes
    // from many chunks to one. Content addressing makes that the only way
    // two writes of one oid can disagree on chunk count.
    const oid = store.writeStream("blob", data.length, function* () {
      yield data;
    });
    const before = chunkCount(store, oid) ?? 0;
    expect(before).toBeGreaterThan(1);

    // Drop the metadata row only: an interrupted write leaves exactly this,
    // chunks with nothing pointing at them, and `has` says no.
    store.db.run("DELETE FROM git_objects WHERE oid = ?", oid);
    expect(store.has(oid)).toBe(false);

    store.writeObjects((batch) => batch.write("blob", data));
    expect(chunkCount(store, oid)).toBe(1);
    expect(hashObject("blob", store.read(oid)?.data ?? new Uint8Array(1))).toBe(oid);
  });

  it("writes nothing for an object that is already stored", () => {
    const { store } = open();
    const data = utf8.encode("already here\n");
    const oid = store.write("blob", data);
    const written = () =>
      store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE repo_id = ?", 1);
    const before = written();
    store.writeObjects((batch) => batch.write("blob", data));
    expect(written()).toBe(before);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("does not rewrite an existing small legacy-zlib object as raw", () => {
    const { store } = open();
    const data = utf8.encode("legacy compressed bytes\n");
    const oid = store.writeObjects((batch) => batch.write("blob", data));
    store.db.run("UPDATE git_objects SET stored = 'zlib' WHERE repo_id = ? AND oid = ?", 1, oid);
    store.db.run(
      "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ? AND seq = 0",
      deflate(data),
      1,
      oid,
    );

    store.writeObjects((batch) => batch.write("blob", data));

    expect(
      store.db.scalar<string>(
        "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
        1,
        oid,
      ),
    ).toBe("zlib");
    expect(store.read(oid)?.data).toEqual(data);
  });
});

describe("bulk existence", () => {
  it("answers for loose, packed, both and absent exactly as has() does", async () => {
    const { db, store } = open();
    const looseOnly = utf8.encode("loose only\n");
    const packedOnly = utf8.encode("packed only\n");
    const both = utf8.encode("loose and packed\n");
    const looseOid = store.write("blob", looseOnly);
    const bothOid = store.write("blob", both);
    const packedOid = hashObject("blob", packedOnly);
    const absentOid = "0".repeat(40);

    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", packedOnly);
    writer.object("blob", both);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));

    const oids = [looseOid, packedOid, bothOid, absentOid];
    const present = store.hasAll(oids);
    for (const oid of oids) expect(present.has(oid)).toBe(store.has(oid));
    expect([...present].sort()).toEqual([looseOid, packedOid, bothOid].sort());
    expect(store.missing(oids)).toEqual([absentOid]);

    // One statement for the whole list, spanning both tables.
    db.storage.resetCounters();
    store.hasAll(oids);
    expect(db.storage.statementCount).toBe(1);
  });

  it("holds its own against an empty list and against duplicates", () => {
    const { store } = open();
    const oid = store.write("blob", utf8.encode("dup\n"));
    expect(store.hasAll([]).size).toBe(0);
    expect(store.missing([])).toEqual([]);
    expect(store.missing([oid, oid])).toEqual([]);
    expect(store.missing(["1".repeat(40), "1".repeat(40)])).toEqual(["1".repeat(40)]);
  });
});

describe("refs, config and index", () => {
  it("stores refs relationally with HEAD on the repository row", () => {
    const { store } = open();
    store.setRef("refs/heads/main", "a".repeat(40));
    store.setRef("refs/remotes/origin/main", "b".repeat(40));
    expect(store.getRef("refs/heads/main")).toBe("a".repeat(40));
    expect(store.listRefs("refs/heads/")).toEqual([
      { name: "refs/heads/main", target: "a".repeat(40) },
    ]);
    expect(store.head()).toBe("ref: refs/heads/main");
    store.setHead("c".repeat(40));
    expect(store.getRef("HEAD")).toBe("c".repeat(40));
  });

  it("updates 9,329 refs and shallow boundaries in bounded statements", () => {
    const { db, store } = open();
    const refs = Array.from({ length: 9_329 }, (_, index) => ({
      name: `refs/remotes/origin/branch-${index.toString().padStart(4, "0")}`,
      target: index.toString(16).padStart(40, "0"),
    }));
    const oids = refs.map((ref) => ref.target);

    db.storage.resetCounters();
    store.updateRefs(refs);
    expect(db.storage.statementCount).toBeLessThanOrEqual(5);
    expect(store.listRefs("refs/remotes/origin/")).toHaveLength(refs.length);

    db.storage.resetCounters();
    store.updateRefs(
      refs.slice(0, 1_000),
      refs.slice(-1_000).map((ref) => ref.name),
    );
    expect(db.storage.statementCount).toBeLessThanOrEqual(2);
    expect(store.listRefs("refs/remotes/origin/")).toHaveLength(refs.length - 1_000);

    db.storage.resetCounters();
    store.setShallow(oids);
    expect(db.storage.statementCount).toBeLessThanOrEqual(5);
    expect(store.shallow().size).toBe(oids.length);

    db.storage.resetCounters();
    store.setShallow([], oids.slice(0, 1_000));
    expect(db.storage.statementCount).toBeLessThanOrEqual(1);
    expect(store.shallow().size).toBe(oids.length - 1_000);
  });

  it("keeps multi-valued config in order", () => {
    const { store } = open();
    store.configSet("user.email", "a@example.com");
    store.configAdd("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    store.configAdd("remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    expect(store.configGet("user.email")).toBe("a@example.com");
    expect(store.configGetAll("remote.origin.fetch")).toHaveLength(2);
    expect(store.configPaths("remote.")).toEqual(["remote.origin.fetch"]);
    store.configUnset("user.email");
    expect(store.configGet("user.email")).toBeUndefined();
  });

  it("keys the index by path and stage", () => {
    const { store } = open();
    store.indexPut({
      path: "src/a.ts",
      stage: 0,
      mode: 0o100644,
      oid: "a".repeat(40),
      size: 12,
      mtime: 5,
      ino: 7,
    });
    expect(store.indexGet("src/a.ts")?.oid).toBe("a".repeat(40));
    expect(store.hasConflicts()).toBe(false);
    store.indexPut({
      path: "src/a.ts",
      stage: 2,
      mode: 0o100644,
      oid: "b".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    expect(store.hasConflicts()).toBe(true);
    expect(store.indexEntries()).toHaveLength(2);
    store.indexRemove("src/a.ts");
    expect(store.indexEntries()).toHaveLength(0);
  });
});
