import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";
import { blob, readBlob, type SqlDatabase } from "../packages/do/src/db/db.js";
import { concat, utf8, utf8Decoder } from "../packages/git/src/common/bytes.js";
import { GitError } from "../packages/git/src/common/errors.js";
import {
  hashObject,
  MAX_OBJECT_BYTES,
  MODE_FILE,
  type ObjectType,
  parseCommit,
  parseTree,
  type RawObject,
  serializeCommit,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { log, show } from "../packages/git/src/ops/repository/reads.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { SqliteGitDatabase, type StoreOptions } from "../packages/git/src/store/index.js";
import { applyDelta, encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import {
  type FullObjectPackInput,
  streamFullObjectPack,
} from "../packages/git/src/store/pack/full-object-stream.js";
import {
  MAX_DELTA_DEPTH,
  MAX_PACK_DELETE_BATCH,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_CHUNK,
} from "../packages/git/src/store/pack/packs.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { COMMIT_ROW_MAX_BYTES } from "../packages/git/src/store/trees/commits.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { completePackMatches, type PackMember, reclaimPending } from "./helpers/pack-store.js";
import { TIMING_GATE } from "./helpers/timing.js";

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

class FailingRunDatabase implements SqlDatabase {
  fail = false;

  constructor(
    readonly inner: TestDatabase,
    readonly marker: string,
  ) {}

  get storage() {
    return this.inner.storage;
  }

  run(query: string, ...bindings: unknown[]): void {
    if (this.fail && query.includes(this.marker)) throw new Error("injected pack deletion failure");
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
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

class ClosingIteratorDatabase implements SqlDatabase {
  prematurePackClosures = 0;
  packIteratorReturns = 0;
  graphIteratorReturns = 0;
  corruptNextPackTraversal = false;
  corruptNextGraphTraversal = false;

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
    if (query.includes("/* pack-graph */")) {
      const iterator = rows[Symbol.iterator]();
      let rowIndex = 0;
      const wrapped: IterableIterator<Record<string, unknown>> = {
        [Symbol.iterator]: () => wrapped,
        next: (): IteratorResult<Record<string, unknown>> => {
          const next = iterator.next();
          if (next.done) return next;
          let value = next.value;
          if (this.corruptNextGraphTraversal && rowIndex === 0) {
            value = { ...value, oid: "invalid" };
            this.corruptNextGraphTraversal = false;
          }
          rowIndex++;
          return { done: false, value };
        },
        return: (): IteratorResult<Record<string, unknown>> => {
          this.graphIteratorReturns++;
          iterator.return?.();
          return { done: true, value: undefined };
        },
      };
      return wrapped;
    }
    if (!query.includes("FROM git_pack_data") || !query.includes("ORDER BY seq")) return rows;
    const iterator = rows[Symbol.iterator]();
    let completed = false;
    let rowIndex = 0;
    const wrapped: IterableIterator<Record<string, unknown>> = {
      [Symbol.iterator]: () => wrapped,
      next: (): IteratorResult<Record<string, unknown>> => {
        const next = iterator.next();
        if (next.done) {
          completed = true;
          return next;
        }
        let value = next.value;
        if (this.corruptNextPackTraversal && rowIndex === 0) {
          const data = readBlob(value.data).slice();
          data[0]! ^= 0xff;
          value = { ...value, data };
          this.corruptNextPackTraversal = false;
        }
        rowIndex++;
        return { done: false, value };
      },
      return: (): IteratorResult<Record<string, unknown>> => {
        this.packIteratorReturns++;
        if (!completed) this.prematurePackClosures++;
        completed = true;
        iterator.return?.();
        return { done: true, value: undefined };
      },
    };
    return wrapped;
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

const DENSE_HEADER_SOURCE_BYTES = 1024 * 1024;

function denseIgnoredHeaderCommit(): Uint8Array {
  const malformedTree = utf8.encode("tree malformed\n");
  const ignored = utf8.encode("x y\n");
  const sourceBytes = DENSE_HEADER_SOURCE_BYTES;
  const count = Math.floor((sourceBytes - malformedTree.length - 1) / ignored.length);
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

function repeatedCopyDelta(baseSize: number, targetSize: number, lastByte?: number): Uint8Array {
  const chunks: Uint8Array[] = [encodeDeltaHeader(baseSize, targetSize)];
  let remaining = targetSize - (lastByte === undefined ? 0 : 1);
  while (remaining > 0) {
    const size = Math.min(baseSize, remaining);
    if (size === 0x10000) {
      chunks.push(new Uint8Array([0x80]));
    } else {
      let command = 0x80;
      const bytes: number[] = [];
      if ((size & 0xff) !== 0) {
        command |= 0x10;
        bytes.push(size & 0xff);
      }
      if (((size >>> 8) & 0xff) !== 0) {
        command |= 0x20;
        bytes.push((size >>> 8) & 0xff);
      }
      if (((size >>> 16) & 0xff) !== 0) {
        command |= 0x40;
        bytes.push((size >>> 16) & 0xff);
      }
      chunks.push(new Uint8Array([command, ...bytes]));
    }
    remaining -= size;
  }
  if (lastByte !== undefined) chunks.push(new Uint8Array([1, lastByte]));
  return concat(chunks);
}

function repeatedTarget(base: Uint8Array, size: number, lastByte?: number): Uint8Array {
  const target = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += base.length) {
    target.set(base.subarray(0, Math.min(base.length, size - offset)), offset);
  }
  if (lastByte !== undefined) target[target.length - 1] = lastByte;
  return target;
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

async function unionFixture(db: SqlDatabase = new TestDatabase(), options: StoreOptions = {}) {
  const database = new SqliteGitDatabase(db, {
    chunkBytes: 0,
    objectCacheBytes: 0,
    ...options,
  });
  const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
  const chain = Array.from({ length: 25 }, (_, index) => {
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, index);
    view.setUint32(4, index ^ 0x5a5a5a5a);
    return { data, oid: hashObject("blob", data) };
  });
  const targets = Array.from({ length: 5 }, (_, index) => {
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0x80000000 + index);
    view.setUint32(4, index ^ 0xa5a5a5a5);
    return { data, oid: hashObject("blob", data) };
  });
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(chain.length + targets.length);
  writer.object("blob", chain[0]!.data);
  for (let index = 1; index < chain.length; index++) {
    const target = chain[index]!;
    const base = chain[index - 1]!;
    writer.refDelta(base.oid, literalDelta(base.data.length, target.data));
  }
  const sharedBase = chain[chain.length - 1]!;
  for (const target of targets) {
    writer.refDelta(sharedBase.oid, literalDelta(sharedBase.data.length, target.data));
  }
  writer.finish();
  const packed = await store.packs.ingest(slices(concat(chunks), 64 * 1024));
  return { chain, db, targets, packId: packed.packId, store };
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

function blobMembership(data: Uint8Array): PackMember {
  return { oid: hashObject("blob", data), type: "blob", size: data.length };
}

function deterministicBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < out.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 0xff;
  }
  return out;
}

async function collectPack(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return concat(chunks);
}

/** A stand-in pack owner: the pack store's ownership hooks are generic. */
function seedPackOwner(store: ReturnType<typeof open>): void {
  store.db.run(
    `CREATE TABLE test_pack_owner (
       repo_id INTEGER NOT NULL,
       state TEXT NOT NULL,
       pack_id INTEGER,
       stored_bytes INTEGER NOT NULL DEFAULT 0,
       FOREIGN KEY (repo_id, pack_id) REFERENCES git_pack_meta (repo_id, pack_id)
     )`,
  );
  store.db.run(
    "INSERT INTO test_pack_owner (repo_id, state, pack_id) VALUES (?, 'selected', NULL)",
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

    // The next ordinary ingest reclaims pack 1 before it reserves pack 2.
    const current = utf8.encode("replacement pack row\n");
    const oid = hashObject("blob", current);
    const result = await store.packs.ingest(slices(singleBlobPack(current), 64));
    expect(result.packId).toBe(2);
    expect(store.db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE pack_id = 1")).toBe(0);
    expect(store.read(oid)?.data).toEqual(current);
  });

  it("keeps loose objects readable after a live cache clear", () => {
    const store = open();
    const data = utf8.encode("loose after cache clear\n");
    const oid = store.write("blob", data);
    expect(store.read(oid)?.data).toEqual(data);
    const db = store.db;
    if (!(db instanceof TestDatabase)) throw new Error("expected test database");

    db.storage.resetCounters();
    store.shared.clearCaches();
    expect(store.shared.hasLoose).toBe(true);
    expect(db.storage.statementCount).toBe(0);
    expect(store.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBeGreaterThan(0);
  });

  it("revalidates loose availability and invalidates both storage cache generations", async () => {
    const store = open();
    const removedData = utf8.encode("removed loose\n");
    const remainingData = utf8.encode("remaining loose\n");
    const packedData = utf8.encode("removed packed\n");
    const removedOid = store.write("blob", removedData);
    const remainingOid = store.write("blob", remainingData);
    const packedOid = hashObject("blob", packedData);
    const packed = await store.packs.ingest(slices(singleBlobPack(packedData), 19));
    expect(store.read(removedOid)?.data).toEqual(removedData);
    expect(store.read(remainingOid)?.data).toEqual(remainingData);
    expect(store.read(packedOid)?.data).toEqual(packedData);
    expect(store.packs.readRaw(packed.packId, 0, 4)).toEqual(utf8.encode("PACK"));

    store.db.transactionSync(() => {
      store.db.run(
        "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
        store.sharedRepoId,
        removedOid,
      );
      store.db.run(
        "DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        store.sharedRepoId,
        packed.packId,
      );
    });
    expect(store.read(removedOid)?.data).toEqual(removedData);

    store.shared.revalidateStorageCaches();
    expect(store.shared.hasLoose).toBe(true);
    expect(store.read(removedOid)).toBeNull();
    expect(store.read(packedOid)).toBeNull();
    expect(store.read(remainingOid)?.data).toEqual(remainingData);
    const replacementData = utf8.encode("replacement packed\n");
    const replacementOid = hashObject("blob", replacementData);
    const replacement = await store.packs.ingest(slices(singleBlobPack(replacementData), 19));
    expect(replacement.packId).toBe(packed.packId + 1);
    expect(store.read(replacementOid)?.data).toEqual(replacementData);
  });

  it("invalidates stale caches and keeps loose reads enabled when availability validation fails", () => {
    const inner = new TestDatabase();
    const db = new MutatingQueryDatabase(inner, "loose-storage-availability", {
      has_loose: 2,
    });
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const cachedData = utf8.encode("cached loose\n");
    const authoritativeData = utf8.encode("authoritative loose\n");
    const cachedOid = store.write("blob", cachedData);
    const authoritativeOid = store.writeStream("blob", authoritativeData.length, () => [
      authoritativeData,
    ]);
    store.db.run(
      "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
      store.sharedRepoId,
      cachedOid,
    );

    expect(() => store.shared.revalidateStorageCaches()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );

    expect(store.shared.hasLoose).toBe(true);
    expect(store.read(cachedOid)).toBeNull();
    expect(store.typeAndSize(authoritativeOid)).toEqual({
      type: "blob",
      size: authoritativeData.length,
    });
    expect(store.read(authoritativeOid)?.data).toEqual(authoritativeData);
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
    expect(
      store.db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = 1",
        store.sharedRepoId,
      ),
    ).toBe("pending");

    await expect(store.packs.ingest(slices(singleBlobPack(secondData), 17))).rejects.toMatchObject({
      code: "EBUSY",
    });
    expect(
      store.db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = 1",
        store.sharedRepoId,
      ),
    ).toBe("pending");
    releaseFirst?.();
    const first = await firstIngest;
    const second = await store.packs.ingest(slices(singleBlobPack(secondData), 17));

    expect(first.packId).toBe(1);
    expect(second.packId).toBe(2);
    expect(store.read(hashObject("blob", firstData))?.data).toEqual(firstData);
    expect(store.read(hashObject("blob", secondData))?.data).toEqual(secondData);
  });

  it("reclaims an abandoned pending pack during ordinary ingest", async () => {
    const ordinary = open();
    ordinary.db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 1, 0, 0, 'pending', 0)`,
      ordinary.sharedRepoId,
    );
    const ordinaryResult = await ordinary.packs.ingest(
      slices(singleBlobPack(utf8.encode("ordinary cleanup\n")), 13),
    );
    expect(ordinaryResult.packId).toBe(1);
    expect(ordinary.db.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(1);
  });

  it("fails closed when broad cleanup observes an invalid pack state", async () => {
    const inner = new TestDatabase();
    const db = new MutatingQueryDatabase(inner, "pack.pack_id AS pack_id, pack.state AS state", {
      state: "invalid",
    });
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    inner.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 1, 0, 0, 'pending', 0)`,
      store.sharedRepoId,
    );

    await expect(
      store.packs.ingest(slices(singleBlobPack(utf8.encode("cleanup probe\n")), 13)),
    ).rejects.toThrow(/invalid pending cleanup state/);
    expect(
      inner.one<{ pack_id: number; state: string }>(
        "SELECT pack_id, state FROM git_pack_meta WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ pack_id: 1, state: "pending" });
  });

  it("uses a NULL-inclusive predicate for invalid pending cleanup", async () => {
    const inner = new TestDatabase();
    const recording = new RecordingDatabase(inner);
    const database = new SqliteGitDatabase(recording);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    inner.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 1, 0, 0, 'pending', 0)`,
      store.sharedRepoId,
    );

    expect(await reclaimPending(store)).toBe(1);
    const cleanup = recording.queries.find((entry) =>
      entry.query.includes("pack.pack_id AS pack_id, pack.state AS state"),
    );
    if (cleanup === undefined) throw new Error("pending cleanup query was not issued");
    expect(cleanup.query).toContain("pack.state IS NOT 'complete'");
    expect(cleanup.query).not.toContain("pack.state != 'complete'");
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

    expect(await reclaimPending(cold)).toBe(1);
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
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    const started = performance.now();
    const first = cold.readBlobs([wanted[0]!, ...wanted, wanted[0]!], {
      budgetBytes: 1024 * 1024,
    });
    const elapsed = performance.now() - started;
    expect(first.remaining).toEqual([]);
    expect(first.blobs.size).toBe(1_000);
    for (const object of objects) expect(first.blobs.get(object.oid)).toEqual(object.data);
    expect(
      [...db.storage.histogram].filter(
        ([query]) =>
          query.startsWith("WITH RECURSIVE") && query.includes("roots(oid) AS MATERIALIZED"),
      ),
    ).toEqual([[expect.any(String), 1]]);
    expect(
      [...db.storage.histogram.keys()].filter((query) =>
        query.includes("WHERE object.repo_id = ? AND object.oid = ?"),
      ),
    ).toEqual([]);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    if (TIMING_GATE) expect(elapsed).toBeLessThan(100);

    db.storage.resetCounters();
    const second = cold.readBlobs(wanted, { budgetBytes: 1024 * 1024 });
    expect(second.blobs).toEqual(first.blobs);
    expect(db.storage.statementCount).toBeLessThan(1_000);
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
      "INSERT INTO git_objects (repo_id, oid, type, size) VALUES (1, ?, 'blob', ?)",
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

  it("drives the packed base lookup from the pack's own base offsets", async () => {
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
    expect(plan[0]).toMatch(/VIRTUAL TABLE/);
    expect(plan.slice(1).join("\n")).toMatch(
      /SEARCH entry USING PRIMARY KEY \(repo_id=\? AND pack_id=\? AND offset=\?\)/,
    );
  });

  it("rejects invalid packed read inputs before SQL", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/one", "ref: refs/heads/main"));
    const oid = "a".repeat(40);
    const rejectsWithoutSql = (invoke: () => unknown, code: "EINVAL" | "E2BIG"): void => {
      db.storage.resetCounters();
      expect(invoke).toThrowError(expect.objectContaining({ code }));
      expect(db.storage.statementCount).toBe(0);
    };

    rejectsWithoutSql(() => store.packs.readObjects(["not-an-oid"]), "EINVAL");
    rejectsWithoutSql(() => store.packs.readObjects(new Array(4_097).fill(oid)), "E2BIG");
    rejectsWithoutSql(
      () => Reflect.apply(store.packs.readObjects, store.packs, [[oid], "invalid"]),
      "EINVAL",
    );
  });

  it("indexes all 500 commit objects during ingest", async () => {
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
    expect(blobs.statements).toBeLessThan(1_000);
    expect(commits.statements).toBeLessThan(1_000);
    expect(commits.cached).toBe(500);
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

  it("publishes a commit whose message exceeds the row ceiling with a message-less row", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { maxBufferedEntry: 64 * 1024 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const message = "a".repeat(COMMIT_ROW_MAX_BYTES + 64 * 1024);
    const data = syntheticCommit(0, message);
    expect(data.length).toBeGreaterThan(COMMIT_ROW_MAX_BYTES);
    const oid = hashObject("commit", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("commit", data);
    writer.finish();

    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(1);
    const reopened = new SqliteGitDatabase(db, {
      maxBufferedEntry: 64 * 1024,
      objectCacheBytes: 0,
    });
    const checkout = reopened.findCheckout("/repo");
    if (checkout === null) throw new Error("large packed commit repository disappeared");
    const cold = reopened.openCheckout(checkout);
    expect(cold.typeAndSize(oid)).toEqual({ type: "commit", size: data.length });
    expect(cold.read(oid)?.data).toEqual(data);
    expect(
      cold.db.one(
        "SELECT message IS NULL AS message, object_size FROM git_commits WHERE oid = ?",
        oid,
      ),
    ).toEqual({ message: 1, object_size: data.length });
    expect(cold.cachedCommit(oid)).toMatchObject({ oid, messageStored: false });
    const repo = new Repository(cold);
    expect(log(repo, { ref: oid }).map((view) => view.message)).toEqual([message]);
    expect(show(repo, { ref: oid }).commit.message).toBe(message);
    expect([...repo.walkIndexed(oid)].map((entry) => entry.commit)).toEqual([parseCommit(data)]);
  }, 30_000);

  it("rejects a malformed commit above the row ceiling without publishing it", async () => {
    const store = open();
    const data = utf8.encode(`tree malformed\n\n${"m".repeat(COMMIT_ROW_MAX_BYTES)}`);
    expect(data.length).toBeGreaterThan(COMMIT_ROW_MAX_BYTES);

    await expect(
      store.packs.ingest(slices(singleObjectPack("commit", data), 64 * 1024)),
    ).rejects.toMatchObject({ code: "ECORRUPT" });
    expect(
      store.db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);
    expect(await reclaimPending(store)).toBe(1);
  });

  it("rejects commit headers above the row ceiling and leaves a reclaimable pack", async () => {
    const store = open();
    const data = serializeCommit({
      tree: "1".repeat(40),
      parent: [],
      author: {
        name: "a".repeat(COMMIT_ROW_MAX_BYTES),
        email: "author@example.com",
        timestamp: 1,
        timezoneOffset: 0,
      },
      committer: { name: "C", email: "c@example.com", timestamp: 1, timezoneOffset: 0 },
      message: "headers\n",
    });

    await expect(
      store.packs.ingest(slices(singleObjectPack("commit", data), 64 * 1024)),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(
      store.db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);
    expect(store.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(0);
    expect(await reclaimPending(store)).toBe(1);
  });

  it("matches loose caching for a commit above the SQL page byte limit", async () => {
    const data = syntheticCommit(9, "p".repeat(1_100_096));
    const oid = hashObject("commit", data);

    const loose = open();
    expect(loose.write("commit", data)).toBe(oid);
    const looseCache = loose.cachedCommit(oid);
    expect(looseCache).not.toBeNull();
    expect(looseCache?.objectSize).toBeGreaterThan(1024 * 1024);
    expect(looseCache?.messageStored).toBe(true);

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

  it("reports dense malformed commit headers as corruption", async () => {
    const store = open();
    const data = denseIgnoredHeaderCommit();
    expect(data.length).toBeLessThanOrEqual(DENSE_HEADER_SOURCE_BYTES);
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
    }
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("ECORRUPT");
  });

  it("keeps promises through staged batches and removes them on final completion", async () => {
    const store = open();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    const promisedData = utf8.encode("promised through staging\n");
    const promisedOid = hashObject("blob", promisedData);
    writer.header(501);
    writer.object("blob", promisedData);
    let firstOid = "";
    for (let index = 0; index < 500; index++) {
      const data = syntheticCommit(index, `${"s".repeat(10_000)} ${index}\n`);
      if (index === 0) firstOid = hashObject("commit", data);
      writer.object("commit", data);
    }
    writer.finish();
    const pack = concat(chunks);
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    store.addPromisedBlobs("origin", [promisedOid]);

    await expect(
      store.packs.ingest(slices(pack, 64 * 1024), {
        lifecycle: {
          reserved: () => undefined,
          published: () => {
            throw new Error("reject final publication");
          },
        },
      }),
    ).rejects.toThrow("reject final publication");
    expect(store.promisedMissing([promisedOid])).toEqual([promisedOid]);
    expect(
      store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);

    await store.packs.ingest(slices(pack, 64 * 1024));
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(500);
    expect(store.cachedCommit(firstOid)).not.toBeNull();
    expect(store.promisedMissing([promisedOid])).toEqual([]);
  });
});

describe("pack fallback preservation", () => {
  it.each([false, true])(
    "promotes a whole deletion batch into a self-contained pack (reverse: %s)",
    async (reverse) => {
      const store = open();
      const a = utf8.encode("batch promotion A\n");
      const b = utf8.encode("batch promotion B\n");
      const aOid = hashObject("blob", a);
      const bOid = hashObject("blob", b);
      const p1 = await store.packs.ingest(slices(singleBlobPack(a), 64));
      const p2 = await store.packs.ingest(slices(singleBlobPack(b), 64));
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(2);
      writer.refDelta(bOid, literalDelta(b.length, a));
      writer.object("blob", b);
      writer.finish();
      const p3 = await store.packs.ingest(slices(concat(chunks), 64));
      const ids = [p1.packId, p2.packId];
      expect(store.packs.deleteCompletePacks(reverse ? ids.reverse() : ids)).toBe(2);
      const database = new SqliteGitDatabase(store.db, { objectCacheBytes: 0 });
      const checkout = database.findCheckout("/repo");
      if (checkout === null) throw new Error("batch promotion fixture disappeared");
      const cold = database.openCheckout(checkout);
      expect(cold.read(aOid)?.data).toEqual(a);
      expect(cold.read(bOid)?.data).toEqual(b);
      expect(cold.packs.completePackedEntry(aOid)?.packId).toBe(p3.packId);
      expect(cold.packs.completePackedEntry(bOid)?.packId).toBe(p3.packId);
      expect(cold.packs.lookup(aOid)?.baseOffset).toBe(cold.packs.lookup(bOid)?.offset);
    },
  );

  it.each(["first", "second"])(
    "reads crossed packs A (X→Y) and B (Y→X) before and after deleting the %s",
    async (deleted) => {
      const store = open();
      const x = utf8.encode("crossed pack X\n");
      const y = utf8.encode("crossed pack Y\n");
      const xOid = hashObject("blob", x);
      const yOid = hashObject("blob", y);
      const crossed = (base: Uint8Array, target: Uint8Array, baseFirst: boolean) => {
        const chunks: Uint8Array[] = [];
        const writer = new PackWriter((chunk) => chunks.push(chunk));
        writer.header(2);
        if (baseFirst) writer.object("blob", base);
        writer.refDelta(hashObject("blob", base), literalDelta(base.length, target));
        if (!baseFirst) writer.object("blob", base);
        writer.finish();
        return concat(chunks);
      };
      // A resolves its ref-delta immediately; B only once the later base drains.
      const a = await store.packs.ingest(slices(crossed(y, x, true), 64));
      const b = await store.packs.ingest(slices(crossed(x, y, false), 64));
      for (const [pack, delta, base] of [
        [a.packId, xOid, yOid],
        [b.packId, yOid, xOid],
      ] as const) {
        expect(
          store.db.scalar<number>(
            `SELECT count(*) FROM git_pack_entries delta
               JOIN git_pack_entries base
                 ON base.repo_id = delta.repo_id AND base.pack_id = delta.pack_id
                AND base.offset = delta.base_offset
              WHERE delta.pack_id = ? AND delta.oid = ? AND base.oid = ?`,
            pack,
            delta,
            base,
          ),
        ).toBe(1);
      }
      const expected = new Map([
        [xOid, { type: "blob", data: x }],
        [yOid, { type: "blob", data: y }],
      ]);
      expect(store.packs.readObjects([xOid, yOid])).toEqual(expected);

      const survivor = deleted === "first" ? b.packId : a.packId;
      expect(store.packs.deleteCompletePacks([deleted === "first" ? a.packId : b.packId])).toBe(1);
      const database = new SqliteGitDatabase(store.db, { objectCacheBytes: 0 });
      const checkout = database.findCheckout("/repo");
      if (checkout === null) throw new Error("crossed pack repository disappeared");
      const cold = database.openCheckout(checkout);
      expect(cold.packs.completePackedEntry(xOid)?.packId).toBe(survivor);
      expect(cold.packs.completePackedEntry(yOid)?.packId).toBe(survivor);
      expect(cold.packs.readObjects([yOid, xOid])).toEqual(expected);
      expect(cold.read(xOid)?.data).toEqual(x);
      expect(cold.read(yOid)?.data).toEqual(y);
    },
  );

  it("promotes a complete duplicate when its canonical pack is reclaimed", async () => {
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
    const second = await store.packs.ingest(slices(pack(), 64));
    expect(store.cachedCommit(oid)?.commit).toEqual(parseCommit(data));
    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = 1 AND pack_id = ?",
      first.packId,
    );
    expect(await reclaimPending(store)).toBe(1);
    expect(store.cachedCommit(oid)?.commit).toEqual(parseCommit(data));
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(second.packId);
  });

  it("promotes a complete delta fallback closure before deleting its owner", async () => {
    const store = open();
    const base = utf8.encode("complete fallback base\n");
    const baseOid = hashObject("blob", base);
    const target = utf8.encode("complete fallback target\n");
    const targetOid = hashObject("blob", target);
    const primaryChunks: Uint8Array[] = [];
    const primaryWriter = new PackWriter((chunk) => primaryChunks.push(chunk));
    primaryWriter.header(2);
    primaryWriter.object("blob", base);
    primaryWriter.object("blob", target);
    primaryWriter.finish();
    const primary = await store.packs.ingest(slices(concat(primaryChunks), 64));

    const fallbackChunks: Uint8Array[] = [];
    const fallbackWriter = new PackWriter((chunk) => fallbackChunks.push(chunk));
    fallbackWriter.header(2);
    fallbackWriter.object("blob", base);
    fallbackWriter.refDelta(baseOid, literalDelta(base.length, target));
    fallbackWriter.finish();
    const fallback = await store.packs.ingest(slices(concat(fallbackChunks), 64));

    expect(store.packs.deleteCompletePacks([primary.packId])).toBe(1);
    expect(store.packs.completePackedEntry(baseOid)?.packId).toBe(fallback.packId);
    expect(store.packs.completePackedEntry(targetOid)?.packId).toBe(fallback.packId);
    expect(store.read(baseOid)?.data).toEqual(base);
    expect(store.read(targetOid)?.data).toEqual(target);
  });

  it("preserves one complete delta closure when deleting two owners in either order", async () => {
    for (const reverse of [false, true]) {
      const store = open();
      const base = utf8.encode(`batch fallback base ${reverse}\n`);
      const baseOid = hashObject("blob", base);
      const target = utf8.encode(`batch fallback target ${reverse}\n`);
      const targetOid = hashObject("blob", target);
      const pack = (): Uint8Array => {
        const chunks: Uint8Array[] = [];
        const writer = new PackWriter((chunk) => chunks.push(chunk));
        writer.header(2);
        writer.object("blob", base);
        writer.refDelta(baseOid, literalDelta(base.length, target));
        writer.finish();
        return concat(chunks);
      };
      const first = await store.packs.ingest(slices(pack(), 64));
      const second = await store.packs.ingest(slices(pack(), 64));
      const survivor = await store.packs.ingest(slices(pack(), 64));
      const deleting = reverse ? [second.packId, first.packId] : [first.packId, second.packId];

      expect(store.packs.deleteCompletePacks(deleting)).toBe(2);
      expect(
        completePackMatches(store, survivor.packId, [
          { oid: baseOid, type: "blob", size: base.length },
          { oid: targetOid, type: "blob", size: target.length },
        ]),
      ).toBe(true);
      expect(store.packs.completePackedEntry(baseOid)?.packId).toBe(survivor.packId);
      expect(store.packs.completePackedEntry(targetOid)?.packId).toBe(survivor.packId);
      expect(store.read(baseOid)?.data).toEqual(base);
      expect(store.read(targetOid)?.data).toEqual(target);
    }
  });

  it("rolls fallback promotion and pack deletion back on a late SQL failure", async () => {
    const inner = new TestDatabase();
    const db = new FailingRunDatabase(inner, "DELETE FROM git_pack_entries");
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const data = utf8.encode("atomic fallback deletion\n");
    const oid = hashObject("blob", data);
    const pack = singleBlobPack(data);
    const primary = await store.packs.ingest(slices(pack, 64));
    const fallback = await store.packs.ingest(slices(pack, 64));
    db.fail = true;

    expect(() => store.packs.deleteCompletePacks([primary.packId])).toThrow(
      /injected pack deletion failure/,
    );
    expect(inner.scalar<number>("SELECT count(*) FROM git_pack_meta")).toBe(2);
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(primary.packId);
    expect(completePackMatches(store, fallback.packId, [blobMembership(data)])).toBe(true);

    db.fail = false;
    expect(store.packs.deleteCompletePacks([primary.packId])).toBe(1);
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(fallback.packId);
  });

  it("reads multiple objects beyond the batching target", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const objects = [deterministicBytes(2_200_000), deterministicBytes(2_200_001)];
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(objects.length);
    for (const data of objects) writer.object("blob", data);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    const oids = objects.map((data) => hashObject("blob", data));

    const measure = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const measureCheckout = measure.findCheckout("/repo");
    if (measureCheckout === null) throw new Error("packed read repository disappeared");
    const measured = measure.openCheckout(measureCheckout);
    const read = measured.packs.readObjects(oids, "blob");
    expect(read.get(oids[0]!)?.data).toEqual(objects[0]);
    expect(read.get(oids[1]!)?.data).toEqual(objects[1]);
  });

  it("reports oversized delta metadata that extends beyond stored chunks as corruption", async () => {
    const store = open();
    const base = utf8.encode("bounded streamed delta base\n");
    const baseOid = hashObject("blob", base);
    const target = utf8.encode("bounded streamed delta target\n");
    const targetOid = hashObject("blob", target);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", base);
    writer.refDelta(baseOid, literalDelta(base.length, target));
    writer.finish();
    const packed = await store.packs.ingest(slices(concat(chunks), 64));
    store.db.run(
      "UPDATE git_pack_entries SET data_len = ? WHERE repo_id = ? AND pack_id = ? AND oid = ?",
      80 * 1024 * 1024,
      store.sharedRepoId,
      packed.packId,
      targetOid,
    );
    const db = store.db;
    if (!(db instanceof TestDatabase)) throw new Error("expected test database");
    const reopened = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const checkout = reopened.findCheckout("/repo");
    if (checkout === null) throw new Error("streamed delta repository disappeared");
    const cold = reopened.openCheckout(checkout);
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    expect(() => cold.packs.readObjects([targetOid])).toThrow(/missing chunk/);
    expect(db.storage.statementCount).toBeLessThan(1_000);

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    expect(() => cold.packs.read(targetOid)).toThrow(/missing chunk/);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("promotes a fallback pack without rewriting tree projections across a cold reopen", async () => {
    const store = open();
    const tree = serializeTree([{ mode: MODE_FILE, name: "file", oid: "1".repeat(40) }]);
    const treeOid = hashObject("tree", tree);
    const person = {
      name: "Fallback Author",
      email: "fallback@example.com",
      timestamp: 1_700_000_002,
      timezoneOffset: 0,
    };
    const commitData = serializeCommit({
      tree: treeOid,
      parent: [],
      author: person,
      committer: person,
      message: "fallback projection\n",
    });
    const commitOid = hashObject("commit", commitData);
    const pack = (): Uint8Array => {
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(2);
      writer.object("tree", tree);
      writer.object("commit", commitData);
      writer.finish();
      return concat(chunks);
    };
    const primary = await store.packs.ingest(slices(pack(), 64));
    const fallback = await store.packs.ingest(slices(pack(), 64));

    const unrelatedTree = serializeTree([{ mode: MODE_FILE, name: "other", oid: "2".repeat(40) }]);
    const unrelatedOid = hashObject("tree", unrelatedTree);
    await store.packs.ingest(slices(singleObjectPack("tree", unrelatedTree), 64));
    store.db.run("CREATE TABLE test_tree_projection_writes (tree_oid TEXT NOT NULL)");
    store.db.run(
      `CREATE TRIGGER test_tree_projection_insert AFTER INSERT ON git_tree_sources
       BEGIN INSERT INTO test_tree_projection_writes (tree_oid) VALUES (NEW.tree_oid); END`,
    );
    store.db.run(
      `CREATE TRIGGER test_tree_projection_delete AFTER DELETE ON git_tree_sources
       BEGIN INSERT INTO test_tree_projection_writes (tree_oid) VALUES (OLD.tree_oid); END`,
    );
    const projection = () =>
      store.db.one<{ source_key: number; complete: number }>(
        "SELECT source_key, complete FROM git_tree_sources WHERE repo_id = ? AND tree_oid = ?",
        store.sharedRepoId,
        treeOid,
      );
    const before = projection();

    expect(store.read(treeOid)?.data).toEqual(tree);
    expect(store.cachedCommit(commitOid)?.commit).toEqual(parseCommit(commitData));
    expect(store.packs.deleteCompletePacks([primary.packId])).toBe(1);
    expect(
      store.db.scalar<number>(
        "SELECT count(*) FROM test_tree_projection_writes WHERE tree_oid IN (?, ?)",
        treeOid,
        unrelatedOid,
      ),
    ).toBe(0);
    expect(projection()).toEqual(before);

    const reopened = new SqliteGitDatabase(store.db, { objectCacheBytes: 0 });
    const checkout = reopened.findCheckout("/repo");
    if (checkout === null) throw new Error("fallback checkout disappeared");
    const cold = reopened.openCheckout(checkout);
    const coldTree = cold.read(treeOid);
    if (coldTree === null) throw new Error("promoted tree disappeared");
    expect(coldTree.data).toEqual(tree);
    expect(parseTree(coldTree.data)).toEqual(parseTree(tree));
    expect(cold.cachedCommit(commitOid)?.commit).toEqual(parseCommit(commitData));
    expect(cold.packs.completePackedEntry(treeOid)?.packId).toBe(fallback.packId);
    expect([...cold.walkTree(treeOid)]).toEqual([
      { path: "file", mode: MODE_FILE, oid: "1".repeat(40) },
    ]);
  });
});

describe("pack deferred resolution", () => {
  it("batches parsed trees within the statement target", async () => {
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
    expect(small).toBeLessThan(1_000);
    expect(large).toBeLessThan(1_000);
    expect(boundary).toBeLessThan(1_000);
    expect(overBoundary).toBeLessThan(1_000);
    expect(wide).toBeLessThan(1_000);
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

    expect(db.storage.statementCount).toBeLessThan(1_000);
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
    expect(db.storage.statementCount).toBeLessThan(1_000);
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
    expect(db.storage.statementCount).toBeLessThan(1_000);
    for (const target of targets) expect(store.read(target.oid)?.data).toEqual(target.data);
  });

  it("indexes 80 deferred chunked trees", async () => {
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

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1")).toBe(81);
    expect(db.storage.statementCount).toBeLessThan(1_000);
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

    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("admits aggregate branch targets beyond the per-delta working bound", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const base = deterministicBytes(64 * 1024);
    const baseOid = hashObject("blob", base);
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const large = repeatedTarget(base, MAX_PACK_DELTA_WORKING_BYTES - base.length - 16 * 1024);
    const firstOid = hashObject("blob", first);
    const secondOid = hashObject("blob", second);
    const largeOid = hashObject("blob", large);
    const firstLeaf = new Uint8Array([3]);
    const secondLeaf = new Uint8Array([4]);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(6);
    writer.refDelta(baseOid, literalDelta(base.length, first));
    writer.refDelta(firstOid, literalDelta(first.length, firstLeaf));
    writer.refDelta(baseOid, literalDelta(base.length, second));
    writer.refDelta(secondOid, literalDelta(second.length, secondLeaf));
    writer.refDelta(baseOid, repeatedCopyDelta(base.length, large.length));
    writer.object("blob", base);
    writer.finish();

    db.storage.resetCounters();
    const result = await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    expect(result.count).toBe(6);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(store.packs.completePackedEntry(largeOid)).toMatchObject({
      type: "blob",
      size: large.length,
    });
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

    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(store.read(objects[999]!.oid)?.data).toEqual(objects[999]!.data);
  });

  it("drives the delta graph with canonical oid seeks", async () => {
    const inner = new TestDatabase();
    try {
      const recorder = new RecordingDatabase(inner);
      const { store, targets } = await unionFixture(recorder);
      recorder.queries.length = 0;
      expect(store.packs.read(targets[0]!.oid)?.data).toEqual(targets[0]!.data);
      const issued = recorder.queries.find((entry) => entry.query.includes("/* pack-graph */"));
      if (issued === undefined) throw new Error("the delta graph was never issued");
      const plan = inner
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${issued.query}`, ...issued.bindings)
        .map((row) => row.detail);
      const seeks = {
        object: /SEARCH .* USING .*INDEX .* \(repo_id=\? AND oid=\?\)/,
        child: /SEARCH .* USING PRIMARY KEY \(repo_id=\? AND pack_id=\? AND offset=\?\)/,
        base: /SEARCH .* USING PRIMARY KEY \(repo_id=\? AND pack_id=\? AND offset=\?\)/,
        entry: /SEARCH .* USING PRIMARY KEY \(repo_id=\? AND pack_id=\? AND offset=\?\)/,
        own: /SEARCH .* USING .*INDEX git_pack_entries_by_oid \(repo_id=\? AND oid=\? AND pack_id=\?\)/,
      };
      for (const [alias, seek] of Object.entries(seeks)) {
        const lookups = plan.filter((detail) =>
          new RegExp(`^(SEARCH|SCAN) ${alias} `).test(detail),
        );
        expect(lookups.length).toBeGreaterThan(0);
        for (const lookup of lookups) expect(lookup).toMatch(seek);
      }
      const recursiveStep = plan.indexOf("RECURSIVE STEP");
      const reachableScan = plan.indexOf("SCAN reachable", recursiveStep);
      const childSeek = plan.findIndex((detail) => detail.startsWith("SEARCH child "));
      expect(recursiveStep).toBeGreaterThanOrEqual(0);
      expect(reachableScan).toBeGreaterThan(recursiveStep);
      expect(childSeek).toBeGreaterThan(reachableScan);
    } finally {
      inner.storage.db.close();
    }
  });

  it("resolves one union graph across every public packed read path", async () => {
    const { db, targets, store } = await unionFixture();
    if (!(db instanceof TestDatabase)) throw new Error("expected graph test database");
    const targetOids = targets.map((target) => target.oid);
    const statements: number[] = [];
    db.storage.histogram = new Map();
    db.storage.resetCounters();
    const objects = store.packs.readObjects(targetOids, "blob");
    for (const target of targets) expect(objects.get(target.oid)?.data).toEqual(target.data);
    statements.push(db.storage.statementCount);
    expect(
      [...db.storage.histogram]
        .filter(([query]) => query.includes("/* pack-graph */"))
        .reduce((calls, [, count]) => calls + count, 0),
    ).toBe(1);

    const first = targets[0]!;
    db.storage.resetCounters();
    expect(store.packs.read(first.oid)?.data).toEqual(first.data);
    statements.push(db.storage.statementCount);

    db.storage.resetCounters();
    const blobs = store.packs.readBlobs(targetOids);
    for (const target of targets) expect(blobs.get(target.oid)).toEqual(target.data);
    statements.push(db.storage.statementCount);

    db.storage.resetCounters();
    expect(store.packs.readAuthenticatedObject(first.oid, "blob")?.data).toEqual(first.data);
    statements.push(db.storage.statementCount);

    expect(statements.every((count) => count < 1_000)).toBe(true);
  });

  it("reports missing bases, cycles, and depth excess in the delta graph", async () => {
    const typed = await unionFixture();
    expect(() =>
      typed.store.packs.readObjects(
        typed.targets.map((target) => target.oid),
        "tree",
      ),
    ).toThrow(/is a blob, not a tree/);

    const entryOffset = (fixture: Awaited<ReturnType<typeof unionFixture>>, oid: string) => {
      const offset = fixture.db.scalar<number>(
        "SELECT offset FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND oid = ?",
        fixture.store.sharedRepoId,
        fixture.packId,
        oid,
      );
      if (offset === undefined) throw new Error(`pack entry ${oid} disappeared`);
      return offset;
    };
    const missing = await unionFixture();
    const missingOffset = entryOffset(missing, missing.chain[3]!.oid);
    const missingChild = missing.chain[4]!;
    missing.db.run(
      "DELETE FROM git_pack_entries WHERE repo_id = ? AND pack_id = ? AND offset = ?",
      missing.store.sharedRepoId,
      missing.packId,
      missingOffset,
    );
    expect(() => missing.store.packs.read(missing.targets[0]!.oid)).toThrow(
      `missing delta base at pack ${missing.packId} offset ${missingOffset} for ${missingChild.oid}`,
    );

    const cyclic = await unionFixture();
    cyclic.db.run(
      "UPDATE git_pack_entries SET base_offset = ? WHERE repo_id = ? AND pack_id = ? AND oid = ?",
      entryOffset(cyclic, cyclic.chain[cyclic.chain.length - 1]!.oid),
      cyclic.store.sharedRepoId,
      cyclic.packId,
      cyclic.chain[0]!.oid,
    );
    expect(() => cyclic.store.packs.read(cyclic.targets[0]!.oid)).toThrow(/cyclic delta chain/);
    let pairVerdict = "";
    try {
      cyclic.store.packs.readObjects([cyclic.targets[1]!.oid, cyclic.targets[0]!.oid]);
    } catch (error) {
      pairVerdict = error instanceof Error ? error.message : String(error);
    }
    // Both origins share the cycle; the verdict names an object on it.
    expect(cyclic.chain.map((entry) => `cyclic delta chain at ${entry.oid}`)).toContain(
      pairVerdict,
    );

    await expect(unionFixture(new TestDatabase(), { maxDeltaDepth: 12 })).rejects.toThrow(
      /delta chain deeper than 12/,
    );
  });

  it("closes the graph cursor when row validation fails", async () => {
    const inner = new TestDatabase();
    const db = new ClosingIteratorDatabase(inner);
    const { store, targets } = await unionFixture(db);
    db.corruptNextGraphTraversal = true;

    expect(() => store.packs.read(targets[0]!.oid)).toThrow(
      /packed blob index contains invalid metadata/,
    );
    expect(db.graphIteratorReturns).toBe(1);
  });

  it("rejects an in-pack REF delta cycle with no full object", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const a = utf8.encode("cycle member A\n");
    const b = utf8.encode("cycle member B\n");
    const aOid = hashObject("blob", a);
    const bOid = hashObject("blob", b);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.refDelta(bOid, literalDelta(b.length, a));
    writer.refDelta(aOid, literalDelta(a.length, b));
    writer.finish();

    await expect(store.packs.ingest(slices(concat(chunks), 64))).rejects.toMatchObject({
      code: "ECORRUPT",
      message: expect.stringMatching(
        /cannot resolve 2 delta object\(s\): missing base in the pack/,
      ),
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
      0,
    );
    expect(store.read(aOid)).toBeNull();
    expect(store.read(bOid)).toBeNull();
    expect(await reclaimPending(store)).toBe(1);
  });

  it("rejects a thin pack whose bases exist only loose, for every object type", async () => {
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

    await expect(store.packs.ingest(slices(concat(chunks), 64 * 1024))).rejects.toMatchObject({
      code: "ECORRUPT",
      message: expect.stringMatching(
        /cannot resolve 4 delta object\(s\): missing base in the pack/,
      ),
    });
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
      0,
    );
    for (const object of expected) expect(store.read(object.oid)).toBeNull();
    expect(await reclaimPending(store)).toBe(1);
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

  it("resolves deferred base groups beyond the blob batching target", async () => {
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

    const result = await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    expect(result.count).toBe(4);
    expect(store.read(hashObject("blob", new Uint8Array([1])))?.data).toEqual(new Uint8Array([1]));
    expect(store.read(hashObject("blob", new Uint8Array([2])))?.data).toEqual(new Uint8Array([2]));
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
    for (const table of ["git_pack_objects", "git_pack_entries"]) {
      store.db.run(
        `UPDATE ${table} SET size = 1, entry_size = 1 WHERE repo_id = 1 AND oid = ?`,
        oid,
      );
    }

    expect(() => store.readBlobs([oid])).toThrow(/exceeds its indexed size/);
  });

  it("keeps the production delta limit and enforces its exact boundary", async () => {
    expect(MAX_DELTA_DEPTH).toBe(4_095);
    const ingestAt = async (depth: number, limit: number) => {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { maxDeltaDepth: limit });
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
      const fixture = deltaPack(depth);
      await store.packs.ingest(slices(fixture.bytes, 64));
      return { db, fixture };
    };

    const accepted = await ingestAt(3, 3);
    const coldDatabase = new SqliteGitDatabase(accepted.db, { maxDeltaDepth: 3 });
    const row = coldDatabase.findCheckout("/repo");
    if (row === null) throw new Error("repository missing after pack ingest");
    expect(coldDatabase.openCheckout(row).read(accepted.fixture.targetOid)?.data).toEqual(
      accepted.fixture.target,
    );
    await expect(ingestAt(4, 3)).rejects.toThrow(/deeper than 3/);

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
});

describe("pack publication and deletion", () => {
  it("removes the projection when its only pack is reclaimed", async () => {
    const store = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = hashObject("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const { packId } = await store.packs.ingest(slices(concat(chunks), 64));
    const projections = () =>
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      );
    expect(projections()).toBe(1);

    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = 1 AND pack_id = ?",
      packId,
    );
    expect(await reclaimPending(store)).toBe(1);
    expect(projections()).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
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

  it.each([7, 20, 64])("owns reused Buffer chunks of %i bytes during ingest", async (size) => {
    const store = open();
    const data = utf8.encode("retained transport bytes\n".repeat(20));
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", data);
    writer.finish();
    const pack = concat(chunks);
    async function* reusedChunks(): AsyncGenerator<Uint8Array> {
      const buffer = Buffer.alloc(size);
      for (let offset = 0; offset < pack.length; offset += size) {
        const source = pack.subarray(offset, offset + size);
        buffer.set(source);
        yield buffer.subarray(0, source.length);
        buffer.fill(0xff);
      }
    }
    const result = await store.packs.ingest(reusedChunks());
    expect(result.count).toBe(1);
    expect(store.read(hashObject("blob", data))?.data).toEqual(data);
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
    expect(await reclaimPending(store)).toBe(1);
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
    seedPackOwner(store);
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
            `UPDATE test_pack_owner
                SET state = 'pending', pack_id = ?
              WHERE repo_id = ?`,
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
            `UPDATE test_pack_owner
                SET state = 'published', stored_bytes = ?
              WHERE repo_id = ?`,
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
        `SELECT state, pack_id, stored_bytes FROM test_pack_owner
          WHERE repo_id = ?`,
        store.sharedRepoId,
      ),
    ).toEqual({ state: "published", pack_id: result.packId, stored_bytes: result.bytes });
    expect(
      completePackMatches(store, result.packId, [{ oid, type: "blob", size: data.length }]),
    ).toBe(true);
  });

  it("rolls back the pack reservation when its owner cannot record it", async () => {
    const store = open();
    seedPackOwner(store);
    const data = new Uint8Array([1]);

    await expect(
      store.packs.ingest(slices(singleBlobPack(data), 7), {
        lifecycle: {
          reserved: async (packId) => {
            store.db.run(
              `UPDATE test_pack_owner
                  SET state = 'pending', pack_id = ?
                WHERE repo_id = ?`,
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
        "SELECT state, pack_id FROM test_pack_owner WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ state: "selected", pack_id: null });
  });

  it("rolls pack and owner publication back when the published hook throws", async () => {
    const store = open();
    seedPackOwner(store);
    const data = serializeTree([]);
    const oid = hashObject("tree", data);

    await expect(
      store.packs.ingest(slices(singleObjectPack("tree", data), 7), {
        lifecycle: {
          reserved: (packId) => {
            store.db.run(
              `UPDATE test_pack_owner
                  SET state = 'pending', pack_id = ?
                WHERE repo_id = ?`,
              packId,
              store.sharedRepoId,
            );
          },
          published: (published) => {
            store.db.run(
              `UPDATE test_pack_owner
                  SET state = 'published', stored_bytes = ?
                WHERE repo_id = ?`,
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
        "SELECT state, pack_id, stored_bytes FROM test_pack_owner WHERE repo_id = ?",
        store.sharedRepoId,
      ),
    ).toEqual({ state: "pending", pack_id: 1, stored_bytes: 0 });
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(1);
    expect(store.packs.completePackedEntry(oid)).toBeNull();
    expect(store.read(oid)).toBeNull();
    store.db.run(
      "UPDATE test_pack_owner SET state = 'selected', pack_id = NULL WHERE repo_id = ?",
      store.sharedRepoId,
    );
    expect(await reclaimPending(store)).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
  });

  it("deletes complete packs in bounded batches and refuses pending ones", async () => {
    const store = open();
    const firstData = utf8.encode("first complete pack\n");
    const secondData = utf8.encode("second complete pack\n");
    const firstOid = hashObject("blob", firstData);
    const secondOid = hashObject("blob", secondData);
    const first = await store.packs.ingest(slices(singleBlobPack(firstData), 17));
    const second = await store.packs.ingest(slices(singleBlobPack(secondData), 17));

    expect(
      completePackMatches(store, first.packId, [
        { oid: firstOid, type: "blob", size: firstData.length },
      ]),
    ).toBe(true);
    expect(completePackMatches(store, first.packId, [])).toBe(false);
    expect(
      completePackMatches(store, first.packId, [
        { oid: secondOid, type: "blob", size: secondData.length },
      ]),
    ).toBe(false);
    expect(
      completePackMatches(store, first.packId, [
        { oid: firstOid, type: "tree", size: firstData.length },
      ]),
    ).toBe(false);
    expect(
      completePackMatches(store, first.packId, [
        { oid: firstOid, type: "blob", size: firstData.length + 1 },
      ]),
    ).toBe(false);
    expect(store.read(firstOid)?.data).toEqual(firstData);
    expect(store.read(secondOid)?.data).toEqual(secondData);
    expect(() =>
      store.packs.deleteCompletePacks(
        Array.from({ length: MAX_PACK_DELETE_BATCH + 1 }, (_, packId) => packId),
      ),
    ).toThrow(`pack batch exceeds ${MAX_PACK_DELETE_BATCH} inputs`);

    const pendingId = second.packId + 1;
    store.db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, ?, 0, 0, 'pending', 0)`,
      store.sharedRepoId,
      pendingId,
    );
    expect(() => store.packs.deleteCompletePacks([first.packId, pendingId])).toThrow(/pending/);
    expect(
      completePackMatches(store, first.packId, [
        { oid: firstOid, type: "blob", size: firstData.length },
      ]),
    ).toBe(true);
    expect(await reclaimPending(store)).toBe(1);

    expect(store.packs.deleteCompletePacks([first.packId, second.packId])).toBe(2);
    expect(store.read(firstOid)).toBeNull();
    expect(store.read(secondOid)).toBeNull();
    expect(store.packs.deleteCompletePacks([first.packId, second.packId])).toBe(0);
  });

  it("deletes the maximum complete-pack batch within the statement target", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const packIds: number[] = [];
    for (let index = 0; index < MAX_PACK_DELETE_BATCH; index++) {
      const result = await store.packs.ingest(
        slices(singleBlobPack(utf8.encode(`delete-batch-${index}\n`)), 64),
      );
      packIds.push(result.packId);
    }
    const coldDatabase = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const checkout = coldDatabase.findCheckout("/repo");
    if (checkout === null) throw new Error("delete batch repository disappeared");
    const cold = coldDatabase.openCheckout(checkout);

    db.storage.resetCounters();
    expect(cold.packs.deleteCompletePacks(packIds)).toBe(MAX_PACK_DELETE_BATCH);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("reads complete packed metadata through a loose shadow", async () => {
    const store = open();
    const data = utf8.encode("packed metadata shadow\n");
    const oid = hashObject("blob", data);
    const result = await store.packs.ingest(slices(singleBlobPack(data), 23));
    store.db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size) VALUES (?, ?, 'blob', ?)",
      store.sharedRepoId,
      oid,
      data.length,
    );
    store.db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
      store.sharedRepoId,
      oid,
      deflateSync(data),
    );

    expect(store.packs.completePackedEntry(oid)).toEqual({
      packId: result.packId,
      type: "blob",
      size: data.length,
    });
    store.db.run(
      "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = ? AND pack_id = ?",
      store.sharedRepoId,
      result.packId,
    );
    expect(store.packs.completePackedEntry(oid)).toBeNull();
    expect(() => store.packs.completePackedEntry("invalid")).toThrow(/valid object id/);
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
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(1);

    expect(store.packs.deleteCompletePacks([result.packId])).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta")).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    expect(store.read(treeOid)).toBeNull();
    expect(store.read(commitOid)).toBeNull();
    expect(store.cachedCommit(commitOid)).toBeNull();
    expect(store.packs.deleteCompletePacks([result.packId])).toBe(0);
  });

  it("keeps commit and tree projections for loose shadows", async () => {
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

    const projection = () =>
      store.db.one<{ source_key: number; complete: number }>(
        "SELECT source_key, complete FROM git_tree_sources WHERE repo_id = ? AND tree_oid = ?",
        store.sharedRepoId,
        treeOid,
      );
    const before = projection();
    expect(before).toMatchObject({ complete: 1 });
    expect(store.packs.deleteCompletePacks([result.packId])).toBe(1);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(1);
    expect(store.cachedCommit(commitOid)?.commit.message).toBe("shadowed commit\n");
    expect(store.read(treeOid)?.data).toEqual(tree);
    expect(store.read(commitOid)?.data).toEqual(commitData);
    expect(projection()).toEqual(before);
    expect([...store.walkTree(treeOid)]).toEqual([
      { path: "missing", mode: MODE_FILE, oid: "1".repeat(40) },
    ]);
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
      "SELECT COUNT(*) FROM git_pack_entries WHERE base_offset IS NOT NULL",
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

  it("rejects a real pack holding an object above the object ceiling", async () => {
    const repo = fixture().init();
    repo.write("small.txt", "small\n");
    repo.write("huge.bin", new Uint8Array(MAX_OBJECT_BYTES + 1));
    repo.commit("huge");
    const pack = repo.packAll();

    const store = open();
    await expect(store.packs.ingest(slices(pack, 64 * 1024))).rejects.toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );

    expect(
      store.db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'"),
    ).toBe(0);
    expect(store.db.scalar<number>("SELECT count(*) FROM git_pack_objects")).toBe(0);
    expect(store.listRefs()).toEqual([]);
  });
});
