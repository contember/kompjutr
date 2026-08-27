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
import {
  type FullObjectPackInput,
  streamFullObjectPack,
} from "../src/core/pack/full-object-stream.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { MAX_INDEXED_COMMIT_BYTES, prepareCommitCache } from "../src/sqlite/commits.js";
import { blob, readBlob, type SqlDatabase } from "../src/sqlite/db.js";
import { MAX_OPERATION_MEMORY_BYTES, MemoryCoordinator } from "../src/sqlite/memory.js";
import {
  type CompletePackObject,
  MAX_DELTA_DEPTH,
  MAX_PACK_DELETE_BATCH,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_CHUNK,
} from "../src/sqlite/packs.js";
import { CheckoutStore, SharedRepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
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

class RecordingDatabase implements SqlDatabase {
  readonly queries: { query: string; bindings: unknown[] }[] = [];

  constructor(readonly inner: TestDatabase) {}

  get storage() {
    return this.inner.storage;
  }

  run(query: string, ...bindings: unknown[]): void {
    this.queries.push({ query, bindings });
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.queries.push({ query, bindings });
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.queries.push({ query, bindings });
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.queries.push({ query, bindings });
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.queries.push({ query, bindings });
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

class MutatingQueryDatabase implements SqlDatabase {
  constructor(
    readonly inner: TestDatabase,
    readonly marker: string,
    readonly replacement: Readonly<Record<string, unknown>>,
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
    for (const row of this.inner.iterate(query, ...bindings)) {
      yield query.includes(this.marker) ? { ...row, ...this.replacement } : row;
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function open() {
  const database = new SqliteGitDatabase(new TestDatabase(), { objectCacheBytes: 1024 * 1024 });
  return database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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

function singleObjectPack(type: ObjectType, data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object(type, data);
  writer.finish();
  return concat(chunks);
}

function singleBlobPack(data: Uint8Array): Uint8Array {
  return singleObjectPack("blob", data);
}

async function collectPack(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return concat(chunks);
}

function seedRepackBatch(store: ReturnType<typeof open>): void {
  store.db.run(
    `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
     VALUES (?, 0, 2)`,
    store.sharedRepoId,
  );
  store.db.run(
    `INSERT INTO git_maintenance_runs
       (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
     VALUES (?, 1, 0, 'repack', 1, 'done')`,
    store.sharedRepoId,
  );
  store.db.run(
    `INSERT INTO git_maintenance_repack_batches
       (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
     VALUES (?, 1, 1, 'selected', NULL, 1, 1, 0)`,
    store.sharedRepoId,
  );
}

describe("full-object pack stream", () => {
  it("preserves the push writer bytes across chunked and buffered objects", async () => {
    const chunked = new Uint8Array(40_000);
    for (let index = 0; index < chunked.length; index++) chunked[index] = index & 0xff;
    const buffered = utf8.encode("buffered object\n");
    const objects: FullObjectPackInput[] = [
      { oid: hashObject("blob", chunked), type: "blob", size: chunked.length },
      { oid: hashObject("blob", buffered), type: "blob", size: buffered.length },
    ];
    const chunkedInput = [chunked.subarray(0, 12_345), chunked.subarray(12_345)];

    const expectedChunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => expectedChunks.push(chunk));
    writer.header(objects.length);
    const first = writer.startObject("blob", chunked.length, objects[0]!.oid);
    for (const chunk of chunkedInput) {
      for (let offset = 0; offset < chunk.length; offset += 16 * 1024) {
        first.push(chunk.subarray(offset, offset + 16 * 1024));
      }
    }
    first.finish();
    const second = writer.startObject("blob", buffered.length, objects[1]!.oid);
    second.push(buffered);
    second.finish();
    writer.finish();

    const actual = await collectPack(
      streamFullObjectPack(
        objects,
        {
          readBatch: () => new Map([[objects[1]!.oid, { type: "blob", data: buffered }]]),
          readChunks: (object) => (object.oid === objects[0]!.oid ? chunkedInput : null),
        },
        {
          maxObjects: 2,
          maxInflatedBytes: chunked.length + buffered.length,
          maxStoredBytes: Number.MAX_SAFE_INTEGER,
          readBatchBytes: buffered.length,
          allowOversizedObject: true,
        },
      ),
    );
    expect(actual).toEqual(concat(expectedChunks));

    const store = open();
    const result = await store.packs.ingest(slices(actual, 127));
    expect(result.count).toBe(2);
    expect(store.read(objects[0]!.oid)?.data).toEqual(chunked);
    expect(store.read(objects[1]!.oid)?.data).toEqual(buffered);
  });

  it("enforces exact planning, read, inflated, and stored byte boundaries", async () => {
    const data = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])];
    const objects: FullObjectPackInput[] = data.map((bytes) => ({
      oid: hashObject("blob", bytes),
      type: "blob",
      size: bytes.length,
    }));
    const source = new Map(objects.map((object, index) => [object.oid, data[index]!]));
    const reads: string[][] = [];
    const reader = {
      readBatch: (requested: readonly FullObjectPackInput[]) => {
        reads.push(requested.map((object) => object.oid));
        const batch = new Map<string, RawObject>();
        for (const object of requested) {
          batch.set(object.oid, { type: "blob", data: source.get(object.oid)! });
        }
        return batch;
      },
      readChunks: () => null,
    };
    const limits = {
      maxObjects: 3,
      maxInflatedBytes: 5,
      maxStoredBytes: Number.MAX_SAFE_INTEGER,
      readBatchBytes: 4,
    };
    const pack = await collectPack(streamFullObjectPack(objects, reader, limits));
    expect(reads.map((page) => page.length)).toEqual([2, 1]);
    expect(await collectPack(streamFullObjectPack(objects, reader, limits))).toEqual(pack);

    await expect(
      collectPack(streamFullObjectPack(objects, reader, { ...limits, maxObjects: 2 })),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      collectPack(streamFullObjectPack(objects, reader, { ...limits, maxInflatedBytes: 4 })),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(
      await collectPack(
        streamFullObjectPack(objects, reader, { ...limits, maxStoredBytes: pack.length }),
      ),
    ).toEqual(pack);
    await expect(
      collectPack(
        streamFullObjectPack(objects, reader, { ...limits, maxStoredBytes: pack.length - 1 }),
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      collectPack(streamFullObjectPack([objects[0]!, objects[0]!], reader, limits)),
    ).rejects.toThrow(/plan is invalid/);
  });

  it("requires explicit chunking for an object above the read boundary", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const object: FullObjectPackInput = {
      oid: hashObject("blob", data),
      type: "blob",
      size: data.length,
    };
    let chunkReads = 0;
    const reader = {
      readBatch: () => new Map<string, RawObject>(),
      readChunks: () => {
        chunkReads++;
        return [data];
      },
    };
    const limits = {
      maxObjects: 1,
      maxInflatedBytes: data.length,
      maxStoredBytes: Number.MAX_SAFE_INTEGER,
      readBatchBytes: data.length - 1,
    };

    await expect(collectPack(streamFullObjectPack([object], reader, limits))).rejects.toMatchObject(
      {
        code: "E2BIG",
      },
    );
    expect(chunkReads).toBe(0);
    const pack = await collectPack(
      streamFullObjectPack([object], reader, {
        ...limits,
        maxInflatedBytes: data.length - 1,
        allowOversizedObject: true,
      }),
    );
    expect(chunkReads).toBe(1);
    const fixture = new GitFixture().init();
    try {
      fixture.write("generated.pack", pack);
      expect(fixture.git("index-pack", "--strict", "generated.pack")).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      fixture.dispose();
    }
  });
});

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
    const first = database.openCheckout(database.createRepository("/one", "ref: refs/heads/main"));
    const second = database.openCheckout(database.createRepository("/two", "ref: refs/heads/main"));
    for (const { store, prefix } of [
      { store: first, prefix: 0x10 },
      { store: second, prefix: 0x20 },
    ]) {
      db.run(
        `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
         VALUES (?, 1, ?, 0, 'complete', 0)`,
        store.repoId,
        3 * PACK_CHUNK,
      );
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

  it("does not reclaim an active interleaved ingest", async () => {
    const store = open();
    const firstData = utf8.encode("first active ingest\n");
    const secondData = utf8.encode("second active ingest\n");
    const firstPack = singleBlobPack(firstData);
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const paused = async function* (): AsyncIterable<Uint8Array> {
      await gate;
      yield firstPack;
    };

    const firstIngest = store.packs.ingest(paused());
    expect(
      store.db.one<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ pack_id: 1, state: "pending" });

    const second = await store.packs.ingest(slices(singleBlobPack(secondData), 17));
    expect(
      store.db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = 1",
        store.sharedRepoId,
      ),
    ).toBe("pending");
    releaseFirst?.();
    const first = await firstIngest;

    expect(first.packId).toBe(1);
    expect(second.packId).toBe(2);
    expect(store.read(hashObject("blob", firstData))?.data).toEqual(firstData);
    expect(store.read(hashObject("blob", secondData))?.data).toEqual(secondData);
  });

  it("reclaims an abandoned unowned pack after a cold reopen", async () => {
    const store = open();
    const bad = singleBlobPack(utf8.encode("cold abandoned ingest\n"));
    bad[bad.length - 1]! ^= 0xff;
    await expect(store.packs.ingest(slices(bad, 31))).rejects.toThrow(/checksum/);
    const db = store.db;
    if (!(db instanceof TestDatabase)) throw new Error("expected test database");
    const coldDatabase = new SqliteGitDatabase(db);
    const checkout = coldDatabase.findCheckout("/repo");
    if (checkout === null) throw new Error("repository missing after reopen");
    const cold = coldDatabase.openCheckout(checkout);

    expect(cold.packs.reclaimPending()).toBe(1);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta")).toBe(0);
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
    const repository = coldDatabase.findCheckout("/repo");
    if (repository === null) throw new Error("repository missing after pack ingest");
    const cold = coldDatabase.openCheckout(repository);
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
    const repository = coldDatabase.findCheckout("/repo");
    if (repository === null) throw new Error("repository missing after pack ingest");
    expect(
      coldDatabase.openCheckout(repository).readBlobs([targetOid]).blobs.get(targetOid),
    ).toEqual(target);
  });

  it("drives the packed base lookup from the requested oids", async () => {
    const inner = new TestDatabase();
    const recorder = new RecordingDatabase(inner);
    const database = new SqliteGitDatabase(recorder);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    // The delta precedes its base, so the entry is deferred and draining it
    // looks the base up through the statement under test.
    const base = utf8.encode("base content\n".repeat(20));
    const baseOid = hashObject("blob", base);
    const target = utf8.encode(`${utf8Decoder.decode(base)}extra\n`);
    const targetOid = hashObject("blob", target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.object("blob", base);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));
    expect(store.readBlobs([targetOid]).blobs.get(targetOid)).toEqual(target);

    const issued = recorder.queries.find((entry) => entry.query.includes("json_each(?) wanted"));
    if (issued === undefined) throw new Error("the packed base lookup was never issued");
    const plan = inner
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${issued.query}`, ...issued.bindings)
      .map((row) => row.detail);
    // Without the CROSS JOIN, SQLite drives from git_pack_objects and rescans
    // the bound oids once per packed object: 450 ms rather than 0.4 ms on a
    // 30,613-object pack.
    expect(plan[0]).toMatch(/VIRTUAL TABLE/);
    expect(plan.slice(1).join("\n")).toMatch(
      /SEARCH object USING INDEX sqlite_autoindex_git_pack_objects_1/,
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
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    blocker.set("other", 1);
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new CheckoutStore(
      new SharedRepoStore(db, repository.repoId, 1, objects, rows, coordinator),
      repository,
    );
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
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    blocker.set("other", 1);
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new CheckoutStore(
      new SharedRepoStore(db, repository.repoId, 1, objects, rows, coordinator),
      repository,
    );
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
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new CheckoutStore(
      new SharedRepoStore(db, repository.repoId, 1, objects, rows, coordinator),
      repository,
    );
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
    store.db.run("PRAGMA foreign_keys = OFF");
    store.db.run("DELETE FROM git_pack_meta WHERE state = 'pending'");
    store.db.run("PRAGMA foreign_keys = ON");
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
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
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
    expect(small).toBe(12);
    expect(large).toBe(12);
    expect(boundary).toBeLessThanOrEqual(20);
    expect(overBoundary).toBeLessThanOrEqual(20);
    expect(wide).toBeLessThanOrEqual(25);
  });

  it("batches 999 deferred deltas that share a later base", async () => {
    const db = new ReorderedRangeDatabase(new TestDatabase());
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new CheckoutStore(
      new SharedRepoStore(db, repository.repoId, 1, objects, rows, coordinator),
      repository,
    );
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
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
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const coordinator = new MemoryCoordinator();
    const blocker = coordinator.reserve();
    blocker.set("other", 1);
    const objects = new ByteLru<string, RawObject>(8 * 1024 * 1024, (object) => object.data.length);
    const rows = new ByteLru<string, Uint8Array>(4 * PACK_CHUNK, (row) => row.length);
    const store = new CheckoutStore(
      new SharedRepoStore(db, repository.repoId, 1, objects, rows, coordinator),
      repository,
    );
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
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
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
      const fixture = deltaPack(depth);
      await store.packs.ingest(slices(fixture.bytes, 64));
      const coldDatabase = new SqliteGitDatabase(db, { maxDeltaDepth: limit });
      const row = coldDatabase.findCheckout("/repo");
      if (row === null) throw new Error("repository missing after pack ingest");
      return { actual: coldDatabase.openCheckout(row).read(fixture.targetOid), fixture };
    };

    const accepted = await readAt(3, 3);
    expect(accepted.actual?.data).toEqual(accepted.fixture.target);
    await expect(readAt(4, 3)).rejects.toThrow(/deeper than 3/);

    const openWithLimit = (maxDeltaDepth: number) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { maxDeltaDepth });
      return database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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
        `SELECT s.storage
           FROM git_tree_effective e
           JOIN git_tree_sources s ON s.source_key = e.source_key
          WHERE e.repo_id = 1 AND e.tree_oid = ?`,
        oid,
      ),
    ).toBeUndefined();
    store.db.run("UPDATE git_pack_meta SET state = 'complete' WHERE repo_id = 1 AND pack_id = 7");
    expect(
      store.db.one(
        `SELECT s.storage, s.source_id
           FROM git_tree_effective e
           JOIN git_tree_sources s ON s.source_key = e.source_key
          WHERE e.repo_id = 1 AND e.tree_oid = ?`,
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
        `SELECT s.storage
           FROM git_tree_effective e
           JOIN git_tree_sources s ON s.source_key = e.source_key
          WHERE e.repo_id = 1 AND e.tree_oid = ?`,
        oid,
      ),
    ).toEqual({ storage: "pack" });

    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = 1 AND pack_id = ?",
      packId,
    );
    expect(
      store.db.one(
        `SELECT s.storage
           FROM git_tree_effective e
           JOIN git_tree_sources s ON s.source_key = e.source_key
          WHERE e.repo_id = 1 AND e.tree_oid = ?`,
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

  it("leaves a pack with an invalid UTF-8 tree name incomplete and unreadable", async () => {
    const store = open();
    const data = concat([
      utf8.encode("100644 "),
      new Uint8Array([0x80, 0]),
      new Uint8Array(20).fill(0x11),
    ]);
    const oid = hashObject("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();

    await expect(store.packs.ingest(slices(concat(chunks), 64))).rejects.toMatchObject({
      code: "EUNSUPPORTED",
    });
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'pending'"),
    ).toBe(1);
    expect(store.typeAndSize(oid)).toBeNull();
    expect(store.read(oid)).toBeNull();
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
  });

  it("streams an entry larger than the buffered limit", async () => {
    const database = new SqliteGitDatabase(new TestDatabase(), {
      maxBufferedEntry: 64 * 1024,
      objectCacheBytes: 512 * 1024,
    });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
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

  it("records an owned reservation and publication in the pack transactions", async () => {
    const store = open();
    seedRepackBatch(store);
    const data = new Uint8Array([1]);
    const oid = hashObject("blob", data);
    let reservedVisible = false;
    let publishedVisible = false;

    const result = await store.packs.ingest(slices(singleBlobPack(data), 7), {
      lifecycle: {
        reserved: (packId) => {
          reservedVisible =
            store.db.scalar<string>(
              "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
              store.sharedRepoId,
              packId,
            ) === "pending";
          store.db.run(
            `UPDATE git_maintenance_repack_batches
                SET state = 'pending', pack_id = ?
              WHERE repo_id = ? AND run_id = 1 AND batch_id = 1`,
            packId,
            store.sharedRepoId,
          );
        },
        published: (published) => {
          publishedVisible =
            store.db.scalar<string>(
              "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
              store.sharedRepoId,
              published.packId,
            ) === "complete";
          store.db.run(
            `UPDATE git_maintenance_repack_batches
                SET state = 'published', stored_bytes = ?
              WHERE repo_id = ? AND run_id = 1 AND batch_id = 1`,
            published.bytes,
            store.sharedRepoId,
          );
        },
      },
    });

    expect({ reservedVisible, publishedVisible }).toEqual({
      reservedVisible: true,
      publishedVisible: true,
    });
    expect(
      store.db.one<{ state: string; pack_id: number; stored_bytes: number }>(
        `SELECT state, pack_id, stored_bytes FROM git_maintenance_repack_batches
          WHERE repo_id = ?`,
        store.sharedRepoId,
      ),
    ).toEqual({ state: "published", pack_id: result.packId, stored_bytes: result.bytes });
    expect(
      store.packs.completePackMatches(result.packId, [{ oid, type: "blob", size: data.length }]),
    ).toBe(true);
  });

  it("rolls back the pack reservation when its owner cannot record it", async () => {
    const store = open();
    seedRepackBatch(store);
    const data = new Uint8Array([1]);

    await expect(
      store.packs.ingest(slices(singleBlobPack(data), 7), {
        lifecycle: {
          reserved: async (packId) => {
            store.db.run(
              `UPDATE git_maintenance_repack_batches
                  SET state = 'pending', pack_id = ?
                WHERE repo_id = ? AND run_id = 1 AND batch_id = 1`,
              packId,
              store.sharedRepoId,
            );
          },
          published: () => {},
        },
      }),
    ).rejects.toThrow(/reserved hook must return undefined/);

    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta")).toBe(0);
    expect(
      store.db.one<{ state: string; pack_id: number | null }>(
        "SELECT state, pack_id FROM git_maintenance_repack_batches WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ state: "selected", pack_id: null });
  });

  it("rolls pack and owner publication back when the published hook throws", async () => {
    const store = open();
    seedRepackBatch(store);
    const data = serializeTree([]);
    const oid = hashObject("tree", data);

    await expect(
      store.packs.ingest(slices(singleObjectPack("tree", data), 7), {
        lifecycle: {
          reserved: (packId) => {
            store.db.run(
              `UPDATE git_maintenance_repack_batches
                  SET state = 'pending', pack_id = ?
                WHERE repo_id = ? AND run_id = 1 AND batch_id = 1`,
              packId,
              store.sharedRepoId,
            );
          },
          published: (published) => {
            store.db.run(
              `UPDATE git_maintenance_repack_batches
                  SET state = 'published', stored_bytes = ?
                WHERE repo_id = ? AND run_id = 1 AND batch_id = 1`,
              published.bytes,
              store.sharedRepoId,
            );
            throw new Error("injected publication failure");
          },
        },
      }),
    ).rejects.toThrow(/injected publication failure/);

    expect(
      store.db.one<{ state: string; count: number }>(
        "SELECT state, count FROM git_pack_meta WHERE repo_id = ? AND pack_id = 1",
        store.sharedRepoId,
      ),
    ).toEqual({ state: "pending", count: 0 });
    expect(
      store.db.one<{ state: string; pack_id: number; stored_bytes: number }>(
        "SELECT state, pack_id, stored_bytes FROM git_maintenance_repack_batches WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ state: "pending", pack_id: 1, stored_bytes: 0 });
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_effective")).toBe(0);
    expect(store.packs.completePackedEntry(oid)).toBeNull();
    expect(store.read(oid)).toBeNull();
    expect(
      store.packs.discardPending(1, (packId) => {
        store.db.run(
          `UPDATE git_maintenance_repack_batches
              SET state = 'selected', pack_id = NULL
            WHERE repo_id = ? AND pack_id = ?`,
          store.sharedRepoId,
          packId,
        );
      }),
    ).toBe(true);
  });

  it("preserves owned pending packs during broad cleanup and discards one exactly", async () => {
    const store = open();
    seedRepackBatch(store);
    const bad = singleBlobPack(new Uint8Array([1]));
    bad[bad.length - 1]! ^= 0xff;
    let ownedPackId = -1;

    await expect(
      store.packs.ingest(slices(bad, 7), {
        lifecycle: {
          reserved: (packId) => {
            ownedPackId = packId;
            store.db.run(
              `UPDATE git_maintenance_repack_batches
                  SET state = 'pending', pack_id = ?
                WHERE repo_id = ? AND run_id = 1 AND batch_id = 1`,
              packId,
              store.sharedRepoId,
            );
          },
          published: () => {},
        },
      }),
    ).rejects.toThrow(/checksum/);

    expect(store.packs.reclaimPending()).toBe(0);
    expect(
      store.packs.discardPending(ownedPackId, (packId) => {
        store.db.run(
          `UPDATE git_maintenance_repack_batches
              SET state = 'selected', pack_id = NULL
            WHERE repo_id = ? AND run_id = 1 AND batch_id = 1 AND pack_id = ?`,
          store.sharedRepoId,
          packId,
        );
      }),
    ).toBe(true);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta")).toBe(0);
    expect(
      store.db.one<{ state: string; pack_id: number | null }>(
        "SELECT state, pack_id FROM git_maintenance_repack_batches WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ state: "selected", pack_id: null });
  });

  it("matches exact complete membership and deletes complete packs in bounded batches", async () => {
    const store = open();
    const firstData = utf8.encode("first complete pack\n");
    const secondData = utf8.encode("second complete pack\n");
    const firstOid = hashObject("blob", firstData);
    const secondOid = hashObject("blob", secondData);
    const first = await store.packs.ingest(slices(singleBlobPack(firstData), 17));
    const second = await store.packs.ingest(slices(singleBlobPack(secondData), 17));

    expect(
      store.packs.completePackMatches(first.packId, [
        { oid: firstOid, type: "blob", size: firstData.length },
      ]),
    ).toBe(true);
    expect(store.packs.completePackMatches(first.packId, [])).toBe(false);
    expect(
      store.packs.completePackMatches(first.packId, [
        { oid: secondOid, type: "blob", size: secondData.length },
      ]),
    ).toBe(false);
    expect(
      store.packs.completePackMatches(first.packId, [
        { oid: firstOid, type: "tree", size: firstData.length },
      ]),
    ).toBe(false);
    expect(
      store.packs.completePackMatches(first.packId, [
        { oid: firstOid, type: "blob", size: firstData.length + 1 },
      ]),
    ).toBe(false);
    expect(store.read(firstOid)?.data).toEqual(firstData);
    expect(store.read(secondOid)?.data).toEqual(secondData);
    expect(() =>
      store.packs.deleteCompletePacks(
        Array.from({ length: MAX_PACK_DELETE_BATCH + 1 }, (_, packId) => packId),
      ),
    ).toThrow(/exceeds 128 inputs/);

    const pendingId = second.packId + 1;
    store.db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, ?, 0, 0, 'pending', 0)`,
      store.sharedRepoId,
      pendingId,
    );
    expect(() => store.packs.deleteCompletePacks([first.packId, pendingId])).toThrow(/pending/);
    expect(
      store.packs.completePackMatches(first.packId, [
        { oid: firstOid, type: "blob", size: firstData.length },
      ]),
    ).toBe(true);
    expect(store.packs.discardPending(pendingId)).toBe(true);

    expect(store.packs.deleteCompletePacks([first.packId, second.packId])).toBe(2);
    expect(store.read(firstOid)).toBeNull();
    expect(store.read(secondOid)).toBeNull();
    expect(store.packs.deleteCompletePacks([first.packId, second.packId])).toBe(0);
  });

  it("validates exact pack membership rows and rejects duplicate expectations", async () => {
    const inner = new TestDatabase();
    const db = new MutatingQueryDatabase(inner, "complete-pack-membership", { offset: -1 });
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const data = utf8.encode("membership corruption\n");
    const oid = hashObject("blob", data);
    const result = await store.packs.ingest(slices(singleBlobPack(data), 19));
    const object: CompletePackObject = { oid, type: "blob", size: data.length };

    expect(() => store.packs.completePackMatches(result.packId, [object])).toThrow(
      /invalid object membership/,
    );
    expect(() => store.packs.completePackMatches(result.packId, [object, object])).toThrow(
      /duplicate pack object/,
    );
    expect(() =>
      store.packs.completePackMatches(result.packId, [
        { oid: "invalid", type: "blob", size: data.length },
      ]),
    ).toThrow(/invalid object metadata/);
  });

  it("reads complete packed metadata through a loose shadow", async () => {
    const store = open();
    const data = utf8.encode("packed metadata shadow\n");
    const oid = hashObject("blob", data);
    const result = await store.packs.ingest(slices(singleBlobPack(data), 23));
    store.db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, 'blob', ?, 'raw')",
      store.sharedRepoId,
      oid,
      data.length,
    );
    store.db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
      store.sharedRepoId,
      oid,
      data,
    );
    store.db.run(
      `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
       VALUES (?, ?, 1)`,
      store.sharedRepoId,
      oid,
    );

    expect(store.packs.completePackedEntry(oid)).toEqual({
      packId: result.packId,
      type: "blob",
      size: data.length,
      baseOid: null,
    });
    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = ? AND pack_id = ?",
      store.sharedRepoId,
      result.packId,
    );
    expect(store.packs.completePackedEntry(oid)).toBeNull();
    expect(() => store.packs.completePackedEntry("invalid")).toThrow(/valid object id/);
  });

  it("rejects corrupt complete packed metadata and delta bases", async () => {
    for (const replacement of [{ type: "invalid" }, { size: -1 }, { base_oid: "invalid" }]) {
      const inner = new TestDatabase();
      const db = new MutatingQueryDatabase(inner, "complete-packed-entry", replacement);
      const database = new SqliteGitDatabase(db);
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
      const data = utf8.encode(`corrupt packed metadata ${JSON.stringify(replacement)}\n`);
      const oid = hashObject("blob", data);
      await store.packs.ingest(slices(singleBlobPack(data), 29));

      expect(() => store.packs.completePackedEntry(oid)).toThrow(/invalid metadata/);
    }
  });

  it("deletes packed commit and tree projections with warmed pack caches", async () => {
    const store = open();
    const tree = serializeTree([{ mode: MODE_FILE, name: "missing", oid: "1".repeat(40) }]);
    const treeOid = hashObject("tree", tree);
    const person = {
      name: "Pack Author",
      email: "author@example.com",
      timestamp: 1_700_000_000,
      timezoneOffset: 0,
    };
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: person,
      committer: person,
      message: "packed commit\n",
    });
    const commitOid = hashObject("commit", commitData);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("tree", tree);
    writer.object("commit", commitData);
    writer.finish();
    const result = await store.packs.ingest(slices(concat(chunks), 31));

    expect(store.read(treeOid)?.data).toEqual(tree);
    expect(store.read(commitOid)?.data).toEqual(commitData);
    expect(store.cachedCommit(commitOid)?.commit.message).toBe("packed commit\n");
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_effective")).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(1);

    expect(store.packs.deleteCompletePacks([result.packId])).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta")).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_effective")).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    expect(store.read(treeOid)).toBeNull();
    expect(store.read(commitOid)).toBeNull();
    expect(store.cachedCommit(commitOid)).toBeNull();
    expect(store.packs.deleteCompletePacks([result.packId])).toBe(0);
  });

  it("keeps commit and effective tree projections for loose shadows", async () => {
    const store = open();
    const tree = serializeTree([{ mode: MODE_FILE, name: "missing", oid: "1".repeat(40) }]);
    const treeOid = hashObject("tree", tree);
    const person = {
      name: "Shadow Author",
      email: "shadow@example.com",
      timestamp: 1_700_000_001,
      timezoneOffset: 0,
    };
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: person,
      committer: person,
      message: "shadowed commit\n",
    });
    const commitOid = hashObject("commit", commitData);
    expect(store.write("tree", tree)).toBe(treeOid);
    expect(store.write("commit", commitData)).toBe(commitOid);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("tree", tree);
    writer.object("commit", commitData);
    writer.finish();
    const result = await store.packs.ingest(slices(concat(chunks), 31));

    expect(
      store.db.one<{ storage: string }>(
        `SELECT source.storage FROM git_tree_effective effective
         JOIN git_tree_sources source ON source.source_key = effective.source_key
         WHERE effective.repo_id = ? AND effective.tree_oid = ?`,
        store.sharedRepoId,
        treeOid,
      ),
    ).toEqual({ storage: "loose" });
    expect(store.packs.deleteCompletePacks([result.packId])).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(1);
    expect(store.cachedCommit(commitOid)?.commit.message).toBe("shadowed commit\n");
    expect(store.read(treeOid)?.data).toEqual(tree);
    expect(store.read(commitOid)?.data).toEqual(commitData);
    expect(
      store.db.one<{ storage: string }>(
        `SELECT source.storage FROM git_tree_effective effective
         JOIN git_tree_sources source ON source.source_key = effective.source_key
         WHERE effective.repo_id = ? AND effective.tree_oid = ?`,
        store.sharedRepoId,
        treeOid,
      ),
    ).toEqual({ storage: "loose" });
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
