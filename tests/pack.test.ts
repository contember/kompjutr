import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import { concat, utf8, utf8Decoder } from "../src/core/bytes.js";
import { GitError } from "../src/core/errors.js";
import {
  hashObject,
  MODE_FILE,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
} from "../src/core/objects.js";
import { applyDelta, encodeDeltaHeader } from "../src/core/pack/delta.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { MAX_INDEXED_COMMIT_BYTES } from "../src/sqlite/commits.js";
import { MAX_DELTA_DEPTH } from "../src/sqlite/packs.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

function open() {
  const database = new SqliteGitDatabase(new TestDatabase(), { objectCacheBytes: 1024 * 1024 });
  return database.open(database.create("/repo", "ref: refs/heads/main"));
}

function syntheticTree(count: number): Uint8Array {
  const entryBytes = 36;
  const out = new Uint8Array(count * entryBytes);
  const mode = utf8.encode("100644 ");
  for (let index = 0; index < count; index++) {
    const at = index * entryBytes;
    out.set(mode, at);
    out[at + 7] = 0x66;
    const digits = String(index).padStart(7, "0");
    for (let digit = 0; digit < digits.length; digit++) {
      out[at + 8 + digit] = digits.charCodeAt(digit);
    }
    out[at + 15] = 0;
    out[at + 32] = (index >>> 24) & 0xff;
    out[at + 33] = (index >>> 16) & 0xff;
    out[at + 34] = (index >>> 8) & 0xff;
    out[at + 35] = index & 0xff;
  }
  return out;
}

function syntheticCommit(index: number, message = `commit ${index}\n`): Uint8Array {
  return serializeCommit({
    tree: index.toString(16).padStart(40, "0"),
    parent: index === 0 ? [] : [(index - 1).toString(16).padStart(40, "0")],
    author: {
      name: "Pack Author",
      email: "author@example.com",
      timestamp: 1_700_000_000 + index,
      timezoneOffset: 60,
    },
    committer: {
      name: "Pack Committer",
      email: "committer@example.com",
      timestamp: 1_700_000_000 + index,
      timezoneOffset: 60,
    },
    message,
  });
}

function literalDelta(baseSize: number, target: Uint8Array): Uint8Array {
  const chunks = [encodeDeltaHeader(baseSize, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const part = target.subarray(offset, offset + 127);
    chunks.push(new Uint8Array([part.length]), part);
  }
  return concat(chunks);
}

function deltaPack(depth: number): { bytes: Uint8Array; target: Uint8Array; targetOid: string } {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(depth + 1);
  let target = utf8.encode("a");
  let targetOid = hashObject("blob", target);
  writer.object("blob", target);
  for (let at = 0; at < depth; at++) {
    const base = target;
    const baseOid = targetOid;
    target = utf8.encode(`${utf8Decoder.decode(base)}a`);
    targetOid = hashObject("blob", target);
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([target.length]),
      target,
    ]);
    writer.refDelta(baseOid, delta);
  }
  writer.finish();
  return { bytes: concat(chunks), target, targetOid };
}

describe("delta", () => {
  it("round-trips a literal-only delta", () => {
    const base = utf8.encode("the quick brown fox");
    const target = utf8.encode("jumps over the lazy dog");
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([target.length]),
      target,
    ]);
    expect(applyDelta(base, delta)).toEqual(target);
  });

  it("round-trips a copy command", () => {
    const base = utf8.encode("0123456789");
    // copy 4 bytes from offset 2, then insert "XY"
    const delta = concat([
      encodeDeltaHeader(base.length, 6),
      new Uint8Array([0x80 | 0x01 | 0x10, 2, 4]),
      new Uint8Array([2]),
      utf8.encode("XY"),
    ]);
    expect(applyDelta(base, delta)).toEqual(utf8.encode("2345XY"));
  });

  it("rejects a copy that runs past the base", () => {
    const base = utf8.encode("short");
    const delta = concat([
      encodeDeltaHeader(base.length, 100),
      new Uint8Array([0x80 | 0x01 | 0x10, 0, 100]),
    ]);
    expect(() => applyDelta(base, delta)).toThrow(/out of range/);
  });
});

describe("synthetic pack ingest", () => {
  it("bulk-reads 1,000 shuffled packed and delta blobs without scalar fallback", async () => {
    const store = open();
    const objects = Array.from({ length: 1_000 }, (_, index) => {
      const data = new Uint8Array(513).fill(index & 0xff);
      data[0] = index & 0xff;
      data[1] = index >>> 8;
      return { data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(objects.length * 2);
    const base = objects[0]!;
    for (const object of objects) {
      if (object === base) writer.object("blob", object.data);
      else writer.refDelta(base.oid, literalDelta(base.data.length, object.data));
      writer.object("blob", new Uint8Array(randomBytes(8 * 1024)));
    }
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    const wanted = objects.map((object) => object.oid).reverse();
    const db = store.db;
    if (!(db instanceof TestDatabase)) throw new Error("expected test database");
    const coldDatabase = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024 });
    const repository = coldDatabase.find("/repo");
    if (repository === null) throw new Error("repository missing after pack ingest");
    const cold = coldDatabase.open(repository);
    db.storage.resetCounters();

    const started = performance.now();
    const first = cold.readBlobs([wanted[0]!, ...wanted, wanted[0]!], {
      budgetBytes: 1024 * 1024,
    });
    const elapsed = performance.now() - started;
    expect(first.remaining).toEqual([]);
    expect(first.blobs.size).toBe(1_000);
    for (const object of objects) expect(first.blobs.get(object.oid)).toEqual(object.data);
    expect(db.storage.statementCount).toBeLessThanOrEqual(5);
    expect(elapsed).toBeLessThan(100);

    db.storage.resetCounters();
    const second = cold.readBlobs(wanted, { budgetBytes: 1024 * 1024 });
    expect(second.blobs).toEqual(first.blobs);
    expect(db.storage.statementCount).toBeLessThanOrEqual(2);
  });

  it("does not write a loose shadow for an existing packed object", async () => {
    const store = open();
    const data = utf8.encode("packed only\n");
    const oid = hashObject("blob", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", data);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));
    store.writeObjects((batch) => {
      expect(batch.write("blob", data)).toBe(oid);
      expect(batch.write("blob", data)).toBe(oid);
    });
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_objects WHERE oid = ?", oid)).toBe(0);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("bulk-resolves packed deltas before a corrupt loose base duplicate", async () => {
    const store = open();
    const base = utf8.encode("base content\n".repeat(20));
    const baseOid = hashObject("blob", base);
    const target = utf8.encode(`${utf8Decoder.decode(base)}extra\n`);
    const targetOid = hashObject("blob", target);
    const delta = literalDelta(base.length, target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", base);
    writer.refDelta(baseOid, delta);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));
    store.db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (1, ?, 'blob', ?, 'raw')",
      baseOid,
      base.length,
    );
    store.db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (1, ?, 0, ?)",
      baseOid,
      new Uint8Array([0]),
    );
    const db = store.db;
    if (!(db instanceof TestDatabase)) throw new Error("expected test database");
    const coldDatabase = new SqliteGitDatabase(db);
    const repository = coldDatabase.find("/repo");
    if (repository === null) throw new Error("repository missing after pack ingest");
    expect(coldDatabase.open(repository).readBlobs([targetOid]).blobs.get(targetOid)).toEqual(
      target,
    );
  });

  it("fails a corrupt loose shadow instead of falling through to the pack", async () => {
    const store = open();
    const data = utf8.encode("shadowed\n");
    const oid = hashObject("blob", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", data);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));
    store.db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (1, ?, 'blob', ?, 'raw')",
      oid,
      data.length,
    );
    store.db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (1, ?, 0, ?)",
      oid,
      new Uint8Array([0]),
    );
    expect(() => store.readBlobs([oid])).toThrow(/size/);
  });

  it("adds at most two statements when indexing 500 commits", async () => {
    const measure = async (type: "blob" | "commit") => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      const store = database.open(database.create("/repo", "ref: refs/heads/main"));
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(500);
      for (let index = 0; index < 500; index++) writer.object(type, syntheticCommit(index));
      writer.finish();
      db.storage.resetCounters();
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      const statements = db.storage.statementCount;
      const cached = db.scalar<number>("SELECT COUNT(*) FROM git_commits") ?? 0;
      return { statements, cached };
    };

    const blobs = await measure("blob");
    const commits = await measure("commit");
    expect(blobs.statements).toBe(9);
    expect(commits.statements).toBe(10);
    expect(commits.cached).toBe(500);
    expect(commits.statements - blobs.statements).toBe(1);
  });

  it("indexes full, immediate-delta and deferred-delta commits", async () => {
    const store = open();
    const baseFirst = syntheticCommit(10, "base first\n");
    const targetFirst = syntheticCommit(11, "resolved immediately\n");
    const baseLater = syntheticCommit(20, "base later\n");
    const targetLater = syntheticCommit(21, "resolved after its base\n");
    const baseFirstOid = hashObject("commit", baseFirst);
    const targetFirstOid = hashObject("commit", targetFirst);
    const baseLaterOid = hashObject("commit", baseLater);
    const targetLaterOid = hashObject("commit", targetLater);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(4);
    writer.object("commit", baseFirst);
    writer.refDelta(baseFirstOid, literalDelta(baseFirst.length, targetFirst));
    writer.refDelta(baseLaterOid, literalDelta(baseLater.length, targetLater));
    writer.object("commit", baseLater);
    writer.finish();

    await store.packs.ingest(slices(concat(chunks), 64));

    for (const item of [
      { oid: baseFirstOid, data: baseFirst },
      { oid: targetFirstOid, data: targetFirst },
      { oid: baseLaterOid, data: baseLater },
      { oid: targetLaterOid, data: targetLater },
    ]) {
      expect(store.cachedCommit(item.oid)?.commit).toEqual(parseCommit(item.data));
    }
  });

  it("re-inflates a buffered-limit commit and rejects an over-limit commit", async () => {
    const database = new SqliteGitDatabase(new TestDatabase(), { maxBufferedEntry: 64 * 1024 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const bounded = syntheticCommit(1, `${"a".repeat(70 * 1024)}\n`);
    const boundedOid = hashObject("commit", bounded);
    const boundedChunks: Uint8Array[] = [];
    const boundedWriter = new PackWriter((chunk) => boundedChunks.push(chunk));
    boundedWriter.header(1);
    boundedWriter.object("commit", bounded);
    boundedWriter.finish();
    await store.packs.ingest(slices(concat(boundedChunks), 4096));
    expect(store.cachedCommit(boundedOid)?.commit).toEqual(parseCommit(bounded));

    const oversized = syntheticCommit(2, "x".repeat(MAX_INDEXED_COMMIT_BYTES));
    expect(oversized.length).toBeGreaterThan(MAX_INDEXED_COMMIT_BYTES);
    const oversizedChunks: Uint8Array[] = [];
    const oversizedWriter = new PackWriter((chunk) => oversizedChunks.push(chunk));
    oversizedWriter.header(1);
    oversizedWriter.object("commit", oversized);
    oversizedWriter.finish();
    let error: unknown;
    try {
      await store.packs.ingest(slices(concat(oversizedChunks), 64 * 1024));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("E2BIG");
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(1);
    expect(store.packs.reclaimPending()).toBe(1);
  });

  it("matches loose caching for a commit above the SQL page byte limit", async () => {
    const data = syntheticCommit(9, "p".repeat(600_096));
    const oid = hashObject("commit", data);

    const loose = open();
    expect(loose.write("commit", data)).toBe(oid);
    const looseCache = loose.cachedCommit(oid);
    expect(looseCache).not.toBeNull();
    expect(looseCache?.cacheBytes).toBeGreaterThan(1024 * 1024);

    const packed = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("commit", data);
    writer.finish();
    await packed.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(
      packed.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(1);
    expect(packed.cachedCommit(oid)).toEqual(looseCache);
  });

  it("rolls pack completion back when final source validation writes short", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1_024);
    for (let index = 0; index < 1_024; index++) writer.object("commit", syntheticCommit(index));
    writer.finish();

    let error: unknown;
    let removedOid = "";
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024), {
        yieldNow: async () => {
          if (removedOid !== "") return;
          const count =
            store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_objects WHERE pack_id = 1") ?? 0;
          if (count !== 1_024) return;
          removedOid =
            store.db.scalar<string>(
              "SELECT oid FROM git_pack_objects WHERE pack_id = 1 ORDER BY offset DESC LIMIT 1",
            ) ?? "";
          store.db.run("DELETE FROM git_pack_objects WHERE pack_id = 1 AND oid = ?", removedOid);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("ECORRUPT");
    expect(removedOid).not.toBe("");
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);
    expect(store.cachedCommit(removedOid)).toBeNull();
    expect(store.packs.reclaimPending()).toBe(1);
  });

  it("makes staged commit batches visible on final completion", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(500);
    let firstOid = "";
    for (let index = 0; index < 500; index++) {
      const data = syntheticCommit(index, `${"s".repeat(10_000)} ${index}\n`);
      if (index === 0) firstOid = hashObject("commit", data);
      writer.object("commit", data);
    }
    writer.finish();

    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(500);
    expect(store.cachedCommit(firstOid)).not.toBeNull();
  });

  it("keeps staged cache rows hidden through failed ingest and orphan reclaim", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(501);
    const first = syntheticCommit(0, `${"m".repeat(10_000)} 0\n`);
    const firstOid = hashObject("commit", first);
    writer.object("commit", first);
    for (let index = 1; index < 500; index++) {
      writer.object("commit", syntheticCommit(index, `${"m".repeat(10_000)} ${index}\n`));
    }
    const missingBase = "f".repeat(40);
    writer.refDelta(missingBase, literalDelta(1, syntheticCommit(501)));
    writer.finish();

    await expect(store.packs.ingest(slices(concat(chunks), 64 * 1024))).rejects.toThrow(
      /missing base/,
    );
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBeGreaterThan(0);
    expect(store.cachedCommit(firstOid)).toBeNull();
    store.db.run("DELETE FROM git_pack_meta WHERE state = 'pending'");
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_data")).toBeGreaterThan(0);
    expect(store.packs.reclaimPending()).toBe(1);
    expect(store.cachedCommit(firstOid)).toBeNull();
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_data")).toBe(0);
  });

  it("does not validate a duplicate against a pack whose object row lost OR IGNORE", async () => {
    const store = open();
    const data = syntheticCommit(1);
    const oid = hashObject("commit", data);
    const pack = (): Uint8Array => {
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(1);
      writer.object("commit", data);
      writer.finish();
      return concat(chunks);
    };

    const first = await store.packs.ingest(slices(pack(), 64));
    await store.packs.ingest(slices(pack(), 64));
    expect(store.cachedCommit(oid)?.commit).toEqual(parseCommit(data));
    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = 1 AND pack_id = ?",
      first.packId,
    );
    expect(store.packs.reclaimPending()).toBe(1);
    expect(store.cachedCommit(oid)).toBeNull();
  });

  it("batches 500 parsed trees below the operation statement ceiling", async () => {
    const measure = async (count: number) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      const store = database.open(database.create("/repo", "ref: refs/heads/main"));
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(count);
      for (let at = 0; at < count; at++) {
        writer.object(
          "tree",
          serializeTree([
            { mode: MODE_FILE, name: `f-${at}`, oid: at.toString(16).padStart(40, "0") },
          ]),
        );
      }
      writer.finish();
      db.storage.resetCounters();
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      return db.storage.statementCount;
    };

    const small = await measure(50);
    const large = await measure(500);
    const boundary = await measure(990);
    const overBoundary = await measure(991);
    const wide = await measure(3_293);
    expect(small).toBe(11);
    expect(large).toBe(11);
    expect(boundary).toBeLessThanOrEqual(20);
    expect(overBoundary).toBeLessThanOrEqual(20);
    expect(wide).toBeLessThanOrEqual(25);
  });

  it("batches 999 deferred deltas that share a later base", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = new Uint8Array(513).fill(0x61);
    const baseOid = hashObject("blob", base);
    const targets = Array.from({ length: 999 }, (_, index) => {
      const data = base.slice();
      data[0] = index & 0xff;
      data[1] = index >>> 8;
      return { data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1_000);
    for (const target of targets) writer.refDelta(baseOid, literalDelta(base.length, target.data));
    writer.object("blob", base);
    writer.finish();

    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(db.storage.statementCount).toBeLessThanOrEqual(40);
    expect(store.read(targets[0]!.oid)?.data).toEqual(targets[0]!.data);
    expect(store.read(targets[998]!.oid)?.data).toEqual(targets[998]!.data);
  });

  it("streams oversized full trees into the parsed index", async () => {
    const ingest = async (data: Uint8Array, maxBufferedEntry?: number) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { maxBufferedEntry });
      const store = database.open(database.create("/repo", "ref: refs/heads/main"));
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(1);
      writer.object("tree", data);
      writer.finish();
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      return { db, store, oid: hashObject("tree", data) };
    };

    const small = syntheticTree(2_000);
    const indexedSmall = await ingest(small, 64 * 1024);
    expect(
      indexedSmall.db.scalar<number>(
        "SELECT entry_count FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
        indexedSmall.oid,
      ),
    ).toBe(2_000);

    const count = Math.ceil((8 * 1024 * 1024 + 1) / 36);
    const large = syntheticTree(count);
    const indexedLarge = await ingest(large);
    expect(indexedLarge.store.typeAndSize(indexedLarge.oid)).toEqual({
      type: "tree",
      size: large.length,
    });
    expect(
      indexedLarge.db.scalar<number>(
        "SELECT entry_count FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
        indexedLarge.oid,
      ),
    ).toBe(count);
  }, 30_000);

  it("rejects a corrupt pack region before allocating it", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    db.storage.resetCounters();
    expect(() => store.packs.readRaw(1, 0, 100 * 1024 * 1024)).toThrow(/bounded region/);
    expect(db.storage.statementCount).toBe(0);
  });

  it("stops bulk inflate when output exceeds the indexed size", async () => {
    const store = open();
    const data = new Uint8Array(2 * 1024 * 1024);
    const oid = hashObject("blob", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", data);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    store.db.run(
      "UPDATE git_pack_objects SET size = 1, entry_size = 1 WHERE repo_id = 1 AND oid = ?",
      oid,
    );

    expect(() => store.readBlobs([oid])).toThrow(/exceeds its indexed size/);
  });

  it("keeps the production delta limit and enforces its exact boundary", async () => {
    expect(MAX_DELTA_DEPTH).toBe(50_000);
    const readAt = async (depth: number, limit: number) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { maxDeltaDepth: limit });
      const store = database.open(database.create("/repo", "ref: refs/heads/main"));
      const fixture = deltaPack(depth);
      await store.packs.ingest(slices(fixture.bytes, 64));
      const coldDatabase = new SqliteGitDatabase(db, { maxDeltaDepth: limit });
      const row = coldDatabase.find("/repo");
      if (row === null) throw new Error("repository missing after pack ingest");
      return { actual: coldDatabase.open(row).read(fixture.targetOid), fixture };
    };

    const accepted = await readAt(3, 3);
    expect(accepted.actual?.data).toEqual(accepted.fixture.target);
    await expect(readAt(4, 3)).rejects.toThrow(/deeper than 3/);

    const openWithLimit = (maxDeltaDepth: number) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { maxDeltaDepth });
      return database.open(database.create("/repo", "ref: refs/heads/main"));
    };
    expect(() => openWithLimit(MAX_DELTA_DEPTH + 1)).not.toThrow();
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => openWithLimit(invalid)).toThrow(/finite non-negative integer/);
    }
  });

  it("keeps pending trees invisible and selects them only on completion", () => {
    const store = open();
    const oid = "1".repeat(40);
    store.db.run(
      "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (1, 7, 0, 1, 'pending', 0)",
    );
    store.db.run(
      `INSERT INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       VALUES (1, ?, 7, 0, 0, 0, 'tree', 0, 0, NULL)`,
      oid,
    );

    expect(
      store.db.one(
        "SELECT storage FROM git_tree_effective WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toBeUndefined();
    store.db.run("UPDATE git_pack_meta SET state = 'complete' WHERE repo_id = 1 AND pack_id = 7");
    expect(
      store.db.one(
        "SELECT storage, source_id FROM git_tree_effective WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toEqual({ storage: "pack", source_id: 7 });
  });

  it("removes the selected source when a pack is reclaimed", async () => {
    const store = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = hashObject("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const { packId } = await store.packs.ingest(slices(concat(chunks), 64));
    expect(
      store.db.one(
        "SELECT storage FROM git_tree_effective WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toEqual({ storage: "pack" });

    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = 1 AND pack_id = ?",
      packId,
    );
    expect(
      store.db.one(
        "SELECT storage FROM git_tree_effective WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toBeUndefined();
    expect(store.packs.reclaimPending()).toBe(1);
    expect(
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1 AND storage = 'pack' AND source_id = ?",
        packId,
      ),
    ).toBe(0);
  });

  it("indexes full entries and ref-deltas", async () => {
    const store = open();
    const base = utf8.encode("base content\n".repeat(20));
    const baseOid = hashObject("blob", base);
    const target = utf8.encode(`${"base content\n".repeat(20)}extra\n`);
    const targetOid = hashObject("blob", target);
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([
        0x80 | 0x01 | 0x02 | 0x10 | 0x20,
        0,
        0,
        base.length & 0xff,
        base.length >> 8,
      ]),
      new Uint8Array([6]),
      utf8.encode("extra\n"),
    ]);

    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", base);
    writer.refDelta(baseOid, delta);
    writer.finish();

    const result = await store.packs.ingest(slices(concat(chunks), 7));
    expect(result.count).toBe(2);
    expect(store.read(baseOid)?.data).toEqual(base);
    expect(store.read(targetOid)?.data).toEqual(target);
  });

  it("rejects a pack whose trailer does not match", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", utf8.encode("hi"));
    writer.finish();
    const pack = concat(chunks);
    pack[pack.length - 1]! ^= 0xff;
    await expect(store.packs.ingest(slices(pack, 64))).rejects.toThrow(/checksum/);
  });

  it("leaves an interrupted pack invisible and reclaimable", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", utf8.encode("hi"));
    writer.finish();
    const pack = concat(chunks);
    pack[pack.length - 1]! ^= 0xff;
    await expect(store.packs.ingest(slices(pack, 64))).rejects.toThrow();

    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_data")).toBeGreaterThan(0);
    expect(store.packs.reclaimPending()).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_data")).toBe(0);
  });

  it("streams an entry larger than the buffered limit", async () => {
    const database = new SqliteGitDatabase(new TestDatabase(), {
      maxBufferedEntry: 64 * 1024,
      objectCacheBytes: 512 * 1024,
    });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const big = new Uint8Array(randomBytes(600_000));
    const small = utf8.encode("after the big one\n");
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", big);
    writer.object("blob", small);
    writer.finish();

    const result = await store.packs.ingest(slices(concat(chunks), 8192));
    expect(result.count).toBe(2);
    // The oversized entry was never buffered, yet its id is correct and the
    // scan found the next entry.
    expect(store.has(hashObject("blob", big))).toBe(true);
    expect(store.read(hashObject("blob", small))?.data).toEqual(small);
    expect(store.read(hashObject("blob", big))?.data).toEqual(big);
  });
});

describe("real git packs", () => {
  const fixtures: GitFixture[] = [];
  afterAll(() => {
    for (const fixture of fixtures) fixture.dispose();
  });

  function fixture(): GitFixture {
    const created = new GitFixture();
    fixtures.push(created);
    return created;
  }

  it("ingests a pack git wrote and reproduces every object", async () => {
    const repo = fixture().init();
    for (let i = 0; i < 12; i++) {
      repo.write("README.md", `# project\n${"line\n".repeat(i * 40)}`);
      repo.write(`src/file${i % 3}.ts`, `export const v${i} = ${i};\n`.repeat(i + 1));
      repo.commit(`commit ${i}`);
    }
    const head = repo.git("rev-parse", "HEAD");
    const pack = repo.packAll();

    const store = open();
    const result = await store.packs.ingest(slices(pack, 64 * 1024));
    expect(result.count).toBeGreaterThan(20);

    const expected = repo
      .git("rev-list", "--all", "--objects")
      .split("\n")
      .map((line) => line.split(" ")[0]!)
      .filter((oid) => oid.length === 40);
    for (const oid of expected) {
      const object = store.read(oid);
      expect(object, `missing ${oid}`).not.toBeNull();
      expect(hashObject(object!.type, object!.data)).toBe(oid);
    }

    const commit = parseCommit(store.read(head)!.data);
    expect(commit.message.trim()).toBe("commit 11");
    const tree = parseTree(store.read(commit.tree)!.data);
    expect(tree.map((entry) => entry.name).sort()).toEqual(["README.md", "src"]);
  });

  it("resolves ofs-deltas whose base appears earlier in the pack", async () => {
    const repo = fixture().init();
    let body = "";
    for (let i = 0; i < 40; i++) {
      body += `line ${i} ${"x".repeat(200)}\n`;
      repo.write("big.txt", body);
      repo.commit(`grow ${i}`);
    }
    const pack = repo.packAll();
    const store = open();
    await store.packs.ingest(slices(pack, 4096));

    const deltas = store.db.scalar<number>(
      "SELECT COUNT(*) FROM git_pack_objects WHERE base_oid IS NOT NULL",
    );
    expect(deltas).toBeGreaterThan(0);

    for (const oid of repo
      .git("rev-list", "--all", "--objects")
      .split("\n")
      .map((line) => line.split(" ")[0]!)
      .filter((oid) => oid.length === 40)) {
      const object = store.read(oid)!;
      expect(hashObject(object.type, object.data)).toBe(oid);
    }
  });
});
