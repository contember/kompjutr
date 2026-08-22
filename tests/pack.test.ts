import { createHash, randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import { concat, utf8, utf8Decoder } from "../src/core/bytes.js";
import { GitError } from "../src/core/errors.js";
import { ByteLru } from "../src/core/lru.js";
import {
  hashObject,
  MODE_FILE,
  type ObjectType,
  parseCommit,
  parseTree,
  type RawObject,
  serializeCommit,
  serializeTree,
} from "../src/core/objects.js";
import { applyDelta, encodeDeltaHeader } from "../src/core/pack/delta.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { MAX_INDEXED_COMMIT_BYTES, prepareCommitCache } from "../src/sqlite/commits.js";
import { blob, readBlob, type SqlDatabase } from "../src/sqlite/db.js";
import { MAX_OPERATION_MEMORY_BYTES, MemoryCoordinator } from "../src/sqlite/memory.js";
import { MAX_DELTA_DEPTH, MAX_PACK_DELTA_WORKING_BYTES, PACK_CHUNK } from "../src/sqlite/packs.js";
import { RepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

class ReorderedRangeDatabase implements SqlDatabase {
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

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    const rows = this.inner.iterate(query, ...bindings);
    if (!query.startsWith("WITH RECURSIVE /* pack-range")) return rows;
    return [...rows].reverse();
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

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

function parentHeavyCommit(parentCount: number): Uint8Array {
  const tree = utf8.encode(`tree ${"f".repeat(40)}\n`);
  const parent = utf8.encode(`parent ${"e".repeat(40)}\n`);
  const data = new Uint8Array(tree.length + parent.length * parentCount + 1);
  data.set(tree);
  for (let index = 0; index < parentCount; index++) {
    data.set(parent, tree.length + index * parent.length);
  }
  data[data.length - 1] = 0x0a;
  return data;
}

function denseIgnoredHeaderCommit(): Uint8Array {
  const malformedTree = utf8.encode("tree malformed\n");
  const ignored = utf8.encode("x y\n");
  const count = Math.floor((MAX_INDEXED_COMMIT_BYTES - malformedTree.length - 1) / ignored.length);
  const data = new Uint8Array(malformedTree.length + ignored.length * count + 1);
  data.set(malformedTree);
  for (let index = 0; index < count; index++) {
    data.set(ignored, malformedTree.length + index * ignored.length);
  }
  data[data.length - 1] = 0x0a;
  return data;
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

function singleBlobPack(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object("blob", data);
  writer.finish();
  return concat(chunks);
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
  it("shares and isolates one 4 MiB pack-row cache across repositories", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { chunkBytes: 16 * 1024 * 1024 });
    const first = database.open(database.create("/one", "ref: refs/heads/main"));
    const second = database.open(database.create("/two", "ref: refs/heads/main"));
    for (const { store, prefix } of [
      { store: first, prefix: 0x10 },
      { store: second, prefix: 0x20 },
    ]) {
      for (let seq = 0; seq < 3; seq++) {
        db.run(
          "INSERT INTO git_pack_data (repo_id, pack_id, seq, data) VALUES (?, 1, ?, ?)",
          store.repoId,
          seq,
          blob(new Uint8Array(PACK_CHUNK).fill(prefix + seq)),
        );
        expect(store.packs.readRaw(1, seq * PACK_CHUNK, 1)[0]).toBe(prefix + seq);
      }
    }
    expect(first.cacheBytes().chunks).toBe(4 * 1024 * 1024);
    expect(second.cacheBytes()).toEqual(first.cacheBytes());

    expect(first.packs.readRaw(1, 0, 1)[0]).toBe(0x10);
    expect(second.packs.readRaw(1, 0, 1)[0]).toBe(0x20);
    const row = db.one<{ data: unknown }>(
      "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = 1 AND seq = 0",
      first.repoId,
    );
    if (row === undefined) throw new Error("missing first repository pack row");
    const replacement = readBlob(row.data).slice();
    replacement[0]! ^= 0xff;
    db.run(
      "UPDATE git_pack_data SET data = ? WHERE repo_id = ? AND pack_id = 1 AND seq = 0",
      blob(replacement),
      first.repoId,
    );
    first.packs.clearCaches();

    db.storage.resetCounters();
    expect(second.packs.readRaw(1, 0, 1)[0]).toBe(0x20);
    expect(db.storage.statementCount).toBe(0);
    db.storage.resetCounters();
    expect(first.packs.readRaw(1, 0, 1)[0]).toBe(0xef);
    expect(db.storage.statementCount).toBe(1);
  });

  it("does not reuse a reclaimed pack row cache generation", async () => {
    const store = open();
    const bad = singleBlobPack(utf8.encode("pending stale row\n"));
    bad[bad.length - 1]! ^= 0xff;
    await expect(store.packs.ingest(slices(bad, 64))).rejects.toThrow(/checksum/);
    expect(store.packs.readRaw(1, 0, bad.length)).toEqual(bad);
    expect(store.packs.reclaimPending()).toBe(1);

    const current = utf8.encode("replacement pack row\n");
    const oid = hashObject("blob", current);
    const result = await store.packs.ingest(slices(singleBlobPack(current), 64));
    expect(result.packId).toBe(1);
    expect(store.read(oid)?.data).toEqual(current);
  });

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
    let acceptedMessageBytes = 0;
    let rejectedMessageBytes = MAX_INDEXED_COMMIT_BYTES;
    while (acceptedMessageBytes + 1 < rejectedMessageBytes) {
      const candidate = Math.floor((acceptedMessageBytes + rejectedMessageBytes) / 2);
      const data = syntheticCommit(1, "a".repeat(candidate));
      try {
        prepareCommitCache({ repoId: 1, oid: hashObject("commit", data), data });
        acceptedMessageBytes = candidate;
      } catch (error) {
        if (!(error instanceof GitError) || error.code !== "E2BIG") throw error;
        rejectedMessageBytes = candidate;
      }
    }
    const bounded = syntheticCommit(1, "a".repeat(acceptedMessageBytes));
    const boundedOid = hashObject("commit", bounded);
    const boundedChunks: Uint8Array[] = [];
    const boundedWriter = new PackWriter((chunk) => boundedChunks.push(chunk));
    boundedWriter.header(1);
    boundedWriter.object("commit", bounded);
    boundedWriter.finish();
    await store.packs.ingest(slices(concat(boundedChunks), 4096));
    expect(store.cachedCommit(boundedOid)?.commit).toEqual(parseCommit(bounded));

    const oversized = syntheticCommit(1, "a".repeat(acceptedMessageBytes + 1));
    expect(oversized.length).toBe(bounded.length + 1);
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

  it("accepts a near-limit commit with 21,843 parents under shared coordinator pressure", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.create("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    blocker.set("other", 1);
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new RepoStore(db, repository, 1, objects, rows, coordinator);
    const data = parentHeavyCommit(21_843);
    expect(data.length).toBe(1_048_511);
    const oid = hashObject("commit", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("commit", data);
    writer.finish();

    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      expect(store.cachedCommit(oid)?.commit.parent).toHaveLength(21_843);
      expect(coordinator.totalBytes).toBe(1);
    } finally {
      blocker.clear("other");
      blocker.dispose();
    }
    expect(coordinator.activeCount).toBe(0);
  });

  it("rejects dense ignored headers before allocating the commit parser", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.create("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    blocker.set("other", 1);
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new RepoStore(db, repository, 1, objects, rows, coordinator);
    const data = denseIgnoredHeaderCommit();
    expect(data.length).toBeLessThanOrEqual(MAX_INDEXED_COMMIT_BYTES);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("commit", data);
    writer.finish();

    let error: unknown;
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    } catch (caught) {
      error = caught;
    } finally {
      blocker.clear("other");
      blocker.dispose();
    }
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("E2BIG");
    expect(coordinator.activeCount).toBe(0);
  });

  it("preflights commit serialization again when shared pressure arrives before flush", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.create("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new RepoStore(db, repository, 1, objects, rows, coordinator);
    const data = parentHeavyCommit(21_843);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1_024);
    for (let index = 0; index < 1_023; index++) {
      writer.object("blob", new Uint8Array([index & 0xff, index >>> 8]));
    }
    writer.object("commit", data);
    writer.finish();

    db.storage.histogram = new Map();
    let pressured = false;
    let error: unknown;
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024), {
        yieldNow: async () => {
          if (pressured) return;
          const indexed =
            db.scalar<number>("SELECT COUNT(*) FROM git_pack_objects WHERE repo_id = 1") ?? 0;
          if (indexed !== 1_024) return;
          blocker.set("other", 3 * 1024 * 1024);
          pressured = true;
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      blocker.clear("other");
      blocker.dispose();
    }
    expect(pressured).toBe(true);
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("E2BIG");
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("INSERT INTO git_commits"))
        .reduce((total, [, calls]) => total + calls, 0),
    ).toBe(0);
    expect(coordinator.activeCount).toBe(0);
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
    const db = new ReorderedRangeDatabase(new TestDatabase());
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
    const packBytes = concat(chunks);

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    await store.packs.ingest(slices(packBytes, 64 * 1024));

    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("SELECT data FROM git_pack_data"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBe(Math.ceil(packBytes.length / PACK_CHUNK));
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("WITH RECURSIVE /* pack-range substr <= 262144 */"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBe(1);
    expect(
      [...db.storage.histogram].filter(([query]) =>
        query.startsWith("SELECT pack_id, offset, data_off, data_len, type, size"),
      ),
    ).toEqual([]);
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("INSERT OR IGNORE INTO git_pack_objects"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBeLessThanOrEqual(5);
    expect(store.read(targets[0]!.oid)?.data).toEqual(targets[0]!.data);
    expect(store.read(targets[998]!.oid)?.data).toEqual(targets[998]!.data);
  });

  it("reads a deferred range crossing physical rows without full-row rereads", async () => {
    const db = new ReorderedRangeDatabase(new TestDatabase());
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const padding = new Uint8Array(randomBytes(880 * 1024));
    const base = new Uint8Array(randomBytes(300 * 1024));
    const target = new Uint8Array(randomBytes(300 * 1024));
    const baseOid = hashObject("blob", base);
    const targetOid = hashObject("blob", target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(3);
    writer.object("blob", padding);
    writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.object("blob", base);
    writer.finish();
    const packBytes = concat(chunks);

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    await store.packs.ingest(slices(packBytes, 64 * 1024));

    const packed = store.packs.lookup(targetOid);
    expect(packed).not.toBeNull();
    if (packed === null) throw new Error("missing deferred target");
    expect(Math.floor(packed.dataOff / PACK_CHUNK)).not.toBe(
      Math.floor((packed.dataOff + packed.dataLen - 1) / PACK_CHUNK),
    );
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("SELECT data FROM git_pack_data"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBe(Math.ceil(packBytes.length / PACK_CHUNK));
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("WITH RECURSIVE /* pack-range substr <= 262144 */"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBe(1);
    expect(store.read(targetOid)?.data).toEqual(target);
    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
  });

  it("falls back to bounded full-row streaming above the one-MiB page range cap", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = new Uint8Array(randomBytes(300 * 1024));
    const baseOid = hashObject("blob", base);
    const targets = Array.from({ length: 4 }, () => {
      const data = new Uint8Array(randomBytes(400 * 1024));
      return { data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(targets.length + 1);
    for (const target of targets) {
      writer.refDelta(baseOid, literalDelta(base.length, target.data));
    }
    writer.object("blob", base);
    writer.finish();
    const packBytes = concat(chunks);

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    await store.packs.ingest(slices(packBytes, 64 * 1024));

    const compressedBytes = targets.reduce(
      (bytes, target) => bytes + (store.packs.lookup(target.oid)?.dataLen ?? 0),
      0,
    );
    expect(compressedBytes).toBeGreaterThan(1024 * 1024);
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("WITH RECURSIVE /* pack-range substr <= 262144 */"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBe(0);
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("SELECT data FROM git_pack_data"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBeGreaterThan(Math.ceil(packBytes.length / PACK_CHUNK));
    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
    for (const target of targets) expect(store.read(target.oid)?.data).toEqual(target.data);
  });

  it("fails one byte before allocating a deferred range batch", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.create("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new RepoStore(db, repository, 1, objects, rows, coordinator);
    const base = new Uint8Array(513).fill(0x61);
    const baseOid = hashObject("blob", base);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1_024);
    for (let index = 0; index < 1_023; index++) {
      const target = base.slice();
      target[0] = index & 0xff;
      target[1] = index >>> 8;
      writer.refDelta(baseOid, literalDelta(base.length, target));
    }
    writer.object("blob", base);
    writer.finish();

    db.storage.histogram = new Map();
    let pressured = false;
    let error: unknown;
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024), {
        yieldNow: async () => {
          if (pressured) return;
          const pending = db.all<{ data_len: number }>(
            "SELECT data_len FROM git_pack_pending WHERE repo_id = 1 AND pack_id = 1",
          );
          if (pending.length !== 1_023) return;
          const compressedBytes = pending.reduce((bytes, row) => bytes + row.data_len, 0);
          expect(compressedBytes).toBeLessThanOrEqual(1024 * 1024);
          const rangeBytes = compressedBytes + 256 * 1024 + pending.length * 832;
          const pressure = MAX_OPERATION_MEMORY_BYTES - coordinator.totalBytes - rangeBytes + 1;
          expect(pressure).toBeGreaterThan(0);
          blocker.set("other", pressure);
          pressured = true;
        },
      });
    } catch (caught) {
      error = caught;
    } finally {
      blocker.clear("other");
      blocker.dispose();
    }
    expect(pressured).toBe(true);
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("E2BIG");
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("WITH RECURSIVE /* pack-range"))
        .reduce((count, [, calls]) => count + calls, 0),
    ).toBe(0);
    expect(coordinator.activeCount).toBe(0);
  });

  it("streams a deferred tree delta through one bounded operation owner", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, {
      objectCacheBytes: 0,
      maxBufferedEntry: 64 * 1024,
    });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = syntheticTree(2_000);
    const target = syntheticTree(3_000);
    const baseOid = hashObject("tree", base);
    const targetOid = hashObject("tree", target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("tree", base);
    writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.finish();

    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 113));

    expect(store.packs.lastIngestMemoryHighWater).toBeLessThanOrEqual(MAX_OPERATION_MEMORY_BYTES);
    expect(
      db.scalar<number>(
        "SELECT entry_count FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ? AND storage = 'pack'",
        targetOid,
      ),
    ).toBe(3_000);
    expect(store.read(targetOid)?.data).toEqual(target);
    expect(db.storage.statementCount).toBeLessThanOrEqual(40);
  });

  it("batches deferred chunked trees instead of flushing one sink per tree", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const base = serializeTree([{ mode: MODE_FILE, name: "base", oid: "1".repeat(40) }]);
    const baseOid = hashObject("tree", base);
    const targets = Array.from({ length: 80 }, (_, index) =>
      serializeTree([
        {
          mode: MODE_FILE,
          name: `file-${index.toString().padStart(3, "0")}`,
          oid: index.toString(16).padStart(40, "0"),
        },
      ]),
    );
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(targets.length + 1);
    for (const target of targets) writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.object("tree", base);
    writer.finish();

    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 97));

    expect(
      db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1 AND storage = 'pack'",
      ),
    ).toBe(81);
    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
  });

  it("preflights chunked tree retention at the exact one-MiB boundary", async () => {
    const ingest = async (extraNameByte: boolean) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      const store = database.open(database.create("/repo", "ref: refs/heads/main"));
      const base = new Uint8Array(0);
      const suffix = serializeTree([
        {
          mode: MODE_FILE,
          name: "z".repeat(extraNameByte ? 37 : 36),
          oid: "f".repeat(40),
        },
      ]);
      const target = concat([syntheticTree(29_088), suffix]);
      expect(target.length).toBe(1_047_232 + (extraNameByte ? 1 : 0));
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(2);
      writer.object("tree", base);
      writer.refDelta(hashObject("tree", base), literalDelta(0, target));
      writer.finish();

      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      expect(store.packs.lastIngestMemoryHighWater).toBeLessThanOrEqual(MAX_OPERATION_MEMORY_BYTES);
      expect(
        db.scalar<number>(
          "SELECT entry_count FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
          hashObject("tree", target),
        ),
      ).toBe(29_089);
    };

    await ingest(false);
    await ingest(true);
  });

  it("does not stage an empty commit batch under repeated reservation pressure", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.create("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    blocker.set("other", 1);
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new RepoStore(db, repository, 1, objects, rows, coordinator);
    const exactTree = concat([
      syntheticTree(29_088),
      serializeTree([{ mode: MODE_FILE, name: "z".repeat(36), oid: "f".repeat(40) }]),
    ]);
    const secondTree = exactTree.slice();
    const lastTreeByte = secondTree.length - 1;
    secondTree[lastTreeByte] = secondTree[lastTreeByte]! ^ 1;
    const largeBlob = new Uint8Array(randomBytes(8 * 1024 * 1024));
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(4);
    writer.object("tree", secondTree);
    writer.object("blob", largeBlob);
    writer.object("tree", exactTree);
    writer.object("blob", largeBlob);
    writer.finish();

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    } finally {
      blocker.clear("other");
      blocker.dispose();
    }

    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.startsWith("UPDATE git_pack_meta SET state = ?"))
        .reduce((total, [, calls]) => total + calls, 0),
    ).toBe(0);
    expect(coordinator.activeCount).toBe(0);
  });

  it("resolves a same-page deferred chain without one pass per delta", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(301);
    let data = utf8.encode("a");
    let oid = hashObject("blob", data);
    writer.object("blob", data);
    for (let index = 0; index < 300; index++) {
      const base = data;
      const baseOid = oid;
      data = utf8.encode(`${utf8Decoder.decode(data)}a`);
      oid = hashObject("blob", data);
      writer.refDelta(baseOid, literalDelta(base.length, data));
    }
    writer.finish();

    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("resolves 999 child-before-base deltas in bounded statements", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const objects = Array.from({ length: 1_000 }, (_, index) => {
      const data = new Uint8Array(64).fill(index & 0xff);
      data[0] = index & 0xff;
      data[1] = index >>> 8;
      return { data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(objects.length);
    for (let index = objects.length - 1; index > 0; index--) {
      const target = objects[index]!;
      const base = objects[index - 1]!;
      writer.refDelta(base.oid, literalDelta(base.data.length, target.data));
    }
    writer.object("blob", objects[0]!.data);
    writer.finish();

    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
    expect(store.read(objects[999]!.oid)?.data).toEqual(objects[999]!.data);
  });

  it("checkpoints a reverse delta chain across three pending pages", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const objects = Array.from({ length: 8_194 }, (_, index) => {
      const data = new Uint8Array(8);
      const view = new DataView(data.buffer);
      view.setUint32(0, index);
      view.setUint32(4, index ^ 0x5a5a5a5a);
      return { data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(objects.length);
    for (let index = objects.length - 1; index > 0; index--) {
      const target = objects[index]!;
      const base = objects[index - 1]!;
      writer.refDelta(base.oid, literalDelta(base.data.length, target.data));
    }
    writer.object("blob", objects[0]!.data);
    writer.finish();

    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(db.storage.statementCount).toBeLessThanOrEqual(100);
    expect(store.read(objects[8_193]!.oid)?.data).toEqual(objects[8_193]!.data);
  });

  it("resolves thin deltas from every loose object type in one bounded batch", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const treeBase = serializeTree(
      Array.from({ length: 150 }, (_, index) => ({
        mode: MODE_FILE,
        name: `a${index.toString().padStart(3, "0")}`,
        oid: "1".repeat(40),
      })),
    );
    const treeTarget = serializeTree(
      Array.from({ length: 150 }, (_, index) => ({
        mode: MODE_FILE,
        name: `b${index.toString().padStart(3, "0")}`,
        oid: "2".repeat(40),
      })),
    );
    const inputs: { type: ObjectType; base: Uint8Array; target: Uint8Array }[] = [
      { type: "blob", base: utf8.encode("base blob\n"), target: utf8.encode("target blob\n") },
      { type: "tree", base: treeBase, target: treeTarget },
      {
        type: "commit",
        base: syntheticCommit(0, `${"b".repeat(5_000)}\n`),
        target: syntheticCommit(1, `${"t".repeat(5_000)}\n`),
      },
      {
        type: "tag",
        base: utf8.encode(`${"1".repeat(40)}\n${"b".repeat(5_000)}\n`),
        target: utf8.encode(`${"2".repeat(40)}\n${"t".repeat(5_000)}\n`),
      },
    ];
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(inputs.length);
    const expected: { type: ObjectType; oid: string; data: Uint8Array }[] = [];
    for (const input of inputs) {
      const baseOid = store.write(input.type, input.base);
      writer.refDelta(baseOid, literalDelta(input.base.length, input.target));
      expected.push({
        type: input.type,
        oid: hashObject(input.type, input.target),
        data: input.target,
      });
    }
    writer.finish();

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(db.storage.statementCount).toBeLessThanOrEqual(30);
    expect(
      [...db.storage.histogram].filter(([query]) =>
        query.includes("SELECT data FROM git_object_chunks WHERE repo_id = ? AND oid = ?"),
      ),
    ).toEqual([]);
    for (const object of expected) {
      expect(store.read(object.oid)).toEqual({ type: object.type, data: object.data });
    }
  });

  it("keeps every scalar pack API blind to the pack being indexed", async () => {
    const store = open();
    const objects = Array.from({ length: 1_024 }, (_, index) => {
      const data = new Uint8Array([index & 0xff, index >>> 8, 0x61]);
      return { data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(objects.length);
    for (const object of objects) writer.object("blob", object.data);
    writer.finish();

    const first = objects[0]!;
    let observed:
      | {
          lookup: unknown;
          typeAndSize: unknown;
          count: number;
          prefix: string[];
          oids: string[];
          read: unknown;
        }
      | undefined;
    await store.packs.ingest(slices(concat(chunks), 64 * 1024), {
      yieldNow: async () => {
        if (observed !== undefined) return;
        const indexed =
          store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_objects WHERE repo_id = 1") ?? 0;
        if (indexed !== objects.length) return;
        observed = {
          lookup: store.packs.lookup(first.oid),
          typeAndSize: store.typeAndSize(first.oid),
          count: store.packs.count(),
          prefix: store.packs.findPrefix(first.oid.slice(0, 8), 2),
          oids: store.packs.oids(),
          read: store.read(first.oid),
        };
      },
    });

    expect(observed).toEqual({
      lookup: null,
      typeAndSize: null,
      count: 0,
      prefix: [],
      oids: [],
      read: null,
    });
    expect(store.read(first.oid)?.data).toEqual(first.data);
    expect(store.packs.count()).toBe(objects.length);
  });

  it("rejects multiple oversized ingest bases before bulk inflation", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const size = 2 * 1024 * 1024 + 1;
    const bases = [new Uint8Array(size), new Uint8Array(size).fill(1)];
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(4);
    writer.refDelta(hashObject("blob", bases[0]!), literalDelta(size, new Uint8Array([1])));
    writer.refDelta(hashObject("blob", bases[1]!), literalDelta(size, new Uint8Array([2])));
    for (const base of bases) writer.object("blob", base);
    writer.finish();

    db.storage.histogram = new Map();
    await expect(store.packs.ingest(slices(concat(chunks), 64 * 1024))).rejects.toThrow(
      /bases exceed the 4 MiB batch limit/,
    );
    expect(
      [...db.storage.histogram].filter(([query]) => query.includes("roots(oid) AS MATERIALIZED")),
    ).toEqual([]);
  });

  it("rejects mixed packed and loose bases before either source is materialized", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.open(database.create("/repo", "ref: refs/heads/main"));
    const packedBase = utf8.encode("packed base\n");
    const packedChunks: Uint8Array[] = [];
    const packedWriter = new PackWriter((chunk) => packedChunks.push(chunk));
    packedWriter.header(1);
    packedWriter.object("blob", packedBase);
    packedWriter.finish();
    await store.packs.ingest(slices(concat(packedChunks), 64 * 1024));

    const looseChunk = new Uint8Array(64 * 1024).fill(0x61);
    const looseChunks = function* (): Generator<Uint8Array> {
      for (let offset = 0; offset < MAX_PACK_DELTA_WORKING_BYTES; offset += looseChunk.length) {
        yield looseChunk.subarray(
          0,
          Math.min(looseChunk.length, MAX_PACK_DELTA_WORKING_BYTES - offset),
        );
      }
    };
    const looseOid = store.writeStream("blob", MAX_PACK_DELTA_WORKING_BYTES, looseChunks);

    const thinChunks: Uint8Array[] = [];
    const thinWriter = new PackWriter((chunk) => thinChunks.push(chunk));
    thinWriter.header(2);
    thinWriter.refDelta(
      hashObject("blob", packedBase),
      literalDelta(packedBase.length, new Uint8Array([1])),
    );
    thinWriter.refDelta(looseOid, literalDelta(MAX_PACK_DELTA_WORKING_BYTES, new Uint8Array([2])));
    thinWriter.finish();

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    await expect(store.packs.ingest(slices(concat(thinChunks), 64 * 1024))).rejects.toThrow(
      /bases exceed the 4 MiB batch limit/,
    );
    expect(db.storage.statementCount).toBe(11);
    expect(
      [...db.storage.histogram].filter(([query]) => query.includes("git_object_chunks")),
    ).toEqual([]);
    expect(
      [...db.storage.histogram].filter(([query]) => query.includes("roots(oid) AS MATERIALIZED")),
    ).toEqual([]);
  });

  it("does not resolve a base from an unrelated pending pack", async () => {
    const store = open();
    const base = utf8.encode("pending base\n");
    const baseOid = hashObject("blob", base);
    const firstChunks: Uint8Array[] = [];
    const firstWriter = new PackWriter((chunk) => firstChunks.push(chunk));
    firstWriter.header(1);
    firstWriter.object("blob", base);
    firstWriter.finish();
    const first = await store.packs.ingest(slices(concat(firstChunks), 64));

    const target = utf8.encode("pending base plus delta\n");
    const secondChunks: Uint8Array[] = [];
    const secondWriter = new PackWriter((chunk) => secondChunks.push(chunk));
    secondWriter.header(1);
    secondWriter.refDelta(baseOid, literalDelta(base.length, target));
    secondWriter.finish();

    let hidden = false;
    await expect(
      store.packs.ingest(slices(concat(secondChunks), 64), {
        yieldNow: async () => {
          if (hidden) return;
          hidden = true;
          store.db.run(
            "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = 1 AND pack_id = ?",
            first.packId,
          );
        },
      }),
    ).rejects.toThrow(/missing base/);
  });

  it("reports a corrupt deferred zlib stream as ECORRUPT", async () => {
    const store = open();
    const base = utf8.encode("deferred base");
    const baseOid = hashObject("blob", base);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1_024);
    writer.refDelta(baseOid, literalDelta(base.length, utf8.encode("deferred target")));
    for (let index = 0; index < 1_022; index++) {
      writer.object("blob", new Uint8Array([index & 0xff, index >>> 8]));
    }
    writer.object("blob", base);
    writer.finish();

    let corrupted = false;
    let error: unknown;
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024), {
        yieldNow: async () => {
          if (corrupted) return;
          const pending = store.db.one<{ data_off: number }>(
            "SELECT data_off FROM git_pack_pending WHERE repo_id = 1 AND pack_id = 1 LIMIT 1",
          );
          if (pending === undefined) return;
          const seq = Math.floor(pending.data_off / PACK_CHUNK);
          const row = store.db.one<{ data: unknown }>(
            "SELECT data FROM git_pack_data WHERE repo_id = 1 AND pack_id = 1 AND seq = ?",
            seq,
          );
          if (row === undefined) throw new Error("missing deferred pack row");
          const data = readBlob(row.data).slice();
          data[pending.data_off - seq * PACK_CHUNK]! ^= 0xff;
          store.db.run(
            "UPDATE git_pack_data SET data = ? WHERE repo_id = 1 AND pack_id = 1 AND seq = ?",
            blob(data),
            seq,
          );
          store.packs.clearCaches();
          corrupted = true;
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(corrupted).toBe(true);
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("ECORRUPT");
    expect(error.message).toMatch(/valid zlib stream/);
  });

  it("preserves exact entry boundaries on buffered and streaming inflate paths", async () => {
    const store = open();
    const first = utf8.encode("first buffered entry\n");
    const crossing = new Uint8Array(randomBytes(PACK_CHUNK + 64 * 1024));
    const last = utf8.encode("last buffered entry\n");
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(3);
    writer.object("blob", first);
    writer.object("blob", crossing);
    writer.object("blob", last);
    writer.finish();

    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(store.read(hashObject("blob", first))?.data).toEqual(first);
    expect(store.read(hashObject("blob", crossing))?.data).toEqual(crossing);
    expect(store.read(hashObject("blob", last))?.data).toEqual(last);
  });

  it("bounds native inflate by the declared entry size", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", new Uint8Array(randomBytes(1_024)));
    writer.finish();
    const pack = concat(chunks);
    expect(pack[12]! & 0x80).not.toBe(0);
    expect(pack[13]).toBe(64);
    pack[13] = 1;
    pack.set(createHash("sha1").update(pack.subarray(0, -20)).digest(), pack.length - 20);

    await expect(store.packs.ingest(slices(pack, 64 * 1024))).rejects.toThrow(/invalid pack entry/);
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
