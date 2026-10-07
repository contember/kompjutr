import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../packages/do/src/db/db.js";
import { concat } from "../packages/git/src/common/bytes.js";
import { ByteLru } from "../packages/git/src/common/lru.js";
import { hashObject, type RawObject } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackDataReader } from "../packages/git/src/store/pack/read/read-data.js";
import {
  MAX_PACK_ROW_CACHE_BYTES,
  PACK_CHUNK,
  PACK_RANGE_BATCH_BYTES,
  type PackRangeRequest,
} from "../packages/git/src/store/pack/shared.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

const CHUNK_SQL = "WITH requested(pack_id, seq)";

/** Yields batched chunk rows in reverse, so a scatter cannot rely on row order. */
class ReversedChunkDatabase implements SqlDatabase {
  constructor(readonly inner: TestDatabase) {}

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
    if (!query.startsWith(CHUNK_SQL)) return rows;
    return [...rows].reverse();
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

/** Reproducible incompressible bytes, so the pack spans several physical rows. */
function noise(seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0, block = 0; at < length; block++) {
    const digest = createHash("sha256").update(`${seed}:${block}`).digest();
    out.set(digest.subarray(0, Math.min(digest.length, length - at)), at);
    at += digest.length;
  }
  return out;
}

interface StoredPack {
  db: TestDatabase;
  repoId: number;
  packId: number;
  bytes: Uint8Array;
}

/** A pack written by real `git`, ingested whole; its bytes are the oracle. */
async function storeGitPack(native: GitFixture): Promise<StoredPack> {
  const bytes = new Uint8Array(
    execFileSync("git", ["pack-objects", "--stdout", "-q"], {
      cwd: native.dir,
      input: native.git("rev-list", "--objects", "--all"),
      maxBuffer: 1 << 30,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  await database
    .openCheckout(database.createRepository("/repo", "ref: refs/heads/main"))
    .packs.ingest(slices(bytes, 64 * 1024));
  const row = db.one<{ repo_id: number; pack_id: number }>(
    "SELECT DISTINCT repo_id, pack_id FROM git_pack_data",
  );
  if (row === undefined) throw new Error("ingest stored no pack rows");
  return { db, repoId: row.repo_id, packId: row.pack_id, bytes };
}

function coldReader(pack: StoredPack, db: SqlDatabase = pack.db): PackDataReader {
  return new PackDataReader(
    db,
    pack.repoId,
    new ByteLru<string, RawObject>(0, (object) => object.data.length),
    new ByteLru<string, Uint8Array>(MAX_PACK_ROW_CACHE_BYTES, (chunk) => chunk.length),
    "range-test",
    { cacheGeneration: 0, activePending: new Set() },
    0,
  );
}

function request(offset: number, position: number, length: number): PackRangeRequest {
  return { offset, position, length };
}

interface RangeCost {
  statements: number;
  rangeStatements: number;
  rangeRows: number;
}

function measure(pack: StoredPack, read: () => void): RangeCost {
  const storage = pack.db.storage;
  storage.histogram = new Map();
  storage.rowHistogram = new Map();
  storage.resetCounters();
  read();
  const sum = (counts: Map<string, number>): number =>
    [...counts]
      .filter(([query]) => query.startsWith(CHUNK_SQL))
      .reduce((total, [, count]) => total + count, 0);
  const cost = {
    statements: storage.statementCount,
    rangeStatements: sum(storage.histogram),
    rangeRows: sum(storage.rowHistogram),
  };
  storage.histogram = null;
  storage.rowHistogram = null;
  return cost;
}

function expectSourceBytes(
  pack: StoredPack,
  requests: readonly PackRangeRequest[],
  outputs: Map<number, Uint8Array>,
): void {
  expect(outputs.size).toBe(requests.length);
  for (const { offset, position, length } of requests) {
    expect(outputs.get(offset)).toEqual(pack.bytes.subarray(position, position + length));
  }
}

describe("pack range batch reads", () => {
  const native = new GitFixture();
  let pack: StoredPack;

  beforeAll(async () => {
    native.init();
    for (let index = 0; index < 3; index++) {
      native.write(`noise-${index}.bin`, noise(`file-${index}`, 900 * 1024));
    }
    native.git("add", ".");
    native.git("commit", "-q", "-m", "noise");
    pack = await storeGitPack(native);
    expect(pack.bytes.length).toBeGreaterThan(2 * PACK_CHUNK);
  });

  afterAll(() => native.dispose());

  it("reads a range crossing physical rows in one statement", () => {
    const requests = [request(1, PACK_CHUNK - 100, 300)];
    const reader = coldReader(pack);
    let outputs = new Map<number, Uint8Array>();
    const cost = measure(pack, () => {
      outputs = reader.readRangeBatch(pack.packId, requests);
    });
    expectSourceBytes(pack, requests, outputs);
    expect(cost).toEqual({ statements: 1, rangeStatements: 1, rangeRows: 2 });
  });

  it("reads each physical row once for ranges that share it", () => {
    const requests = [
      request(10, 12, 1_000),
      request(20, 50_000, 70_000),
      request(30, PACK_CHUNK - 4_096, 8_192),
      request(40, PACK_CHUNK + 10, 200_000),
      request(50, 2 * PACK_CHUNK + 1, 100),
    ];
    const reader = coldReader(pack, new ReversedChunkDatabase(pack.db));
    let outputs = new Map<number, Uint8Array>();
    const cold = measure(pack, () => {
      outputs = reader.readRangeBatch(pack.packId, requests);
    });
    expectSourceBytes(pack, requests, outputs);
    expect(cold).toEqual({ statements: 1, rangeStatements: 1, rangeRows: 3 });

    const warm = measure(pack, () => {
      outputs = reader.readRangeBatch(pack.packId, requests);
    });
    expectSourceBytes(pack, requests, outputs);
    expect(warm).toEqual({ statements: 0, rangeStatements: 0, rangeRows: 0 });
  });

  it("reads only the first row for a range ending exactly on its boundary", () => {
    const requests = [request(7, PACK_CHUNK - 512, 512)];
    const reader = coldReader(pack);
    let outputs = new Map<number, Uint8Array>();
    const cost = measure(pack, () => {
      outputs = reader.readRangeBatch(pack.packId, requests);
    });
    expectSourceBytes(pack, requests, outputs);
    expect(cost).toEqual({ statements: 1, rangeStatements: 1, rangeRows: 1 });
  });

  it("keeps the one-MiB output ceiling and the request cap", () => {
    const reader = coldReader(pack);
    expect(() =>
      reader.readRangeBatch(pack.packId, [request(0, 0, PACK_RANGE_BATCH_BYTES + 1)]),
    ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
    const tooMany = Array.from({ length: 4_097 }, (_, index) => request(index, index, 1));
    expect(() => reader.readRangeBatch(pack.packId, tooMany)).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() =>
      reader.readRangeBatch(pack.packId, [request(1, 0, 10), request(1, 20, 10)]),
    ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
  });
});

describe("pack range batch corruption", () => {
  const native = new GitFixture();

  beforeAll(() => {
    native.init();
    native.write("noise.bin", noise("single", 1_500 * 1024));
    native.git("add", ".");
    native.git("commit", "-q", "-m", "noise");
  });

  afterAll(() => native.dispose());

  async function freshPack(): Promise<StoredPack> {
    const pack = await storeGitPack(native);
    expect(pack.bytes.length).toBeGreaterThan(PACK_CHUNK + 100);
    return pack;
  }

  it("rejects a missing physical row", async () => {
    const pack = await freshPack();
    pack.db.run(
      "DELETE FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = 1",
      pack.repoId,
      pack.packId,
    );
    expect(() =>
      coldReader(pack).readRangeBatch(pack.packId, [request(1, PACK_CHUNK - 10, 20)]),
    ).toThrow(
      expect.objectContaining({
        code: "ECORRUPT",
        message: expect.stringMatching(/missing chunk 1/),
      }),
    );
  });

  it("rejects a truncated physical row", async () => {
    const pack = await freshPack();
    pack.db.run(
      "UPDATE git_pack_data SET data = substr(data, 1, 100) WHERE repo_id = ? AND pack_id = ? AND seq = 1",
      pack.repoId,
      pack.packId,
    );
    const requests = [request(1, PACK_CHUNK + 50, 100)];
    expect(() => coldReader(pack).readRangeBatch(pack.packId, requests)).toThrow(
      expect.objectContaining({ code: "ECORRUPT", message: expect.stringMatching(/truncated/) }),
    );
    const inside = [request(2, PACK_CHUNK + 10, 90)];
    expectSourceBytes(pack, inside, coldReader(pack).readRangeBatch(pack.packId, inside));
  });
});

function literalDelta(baseSize: number, target: Uint8Array): Uint8Array {
  return concat([
    encodeDeltaHeader(baseSize, target.length),
    new Uint8Array([target.length]),
    target,
  ]);
}

describe("deferred delta range requests", () => {
  it("requests only rows whose base this page admitted", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    // Two 2.5 MiB bases exceed the 4 MiB base group, so each pass admits one.
    const bases = [0x61, 0x62].map((fill) => {
      const data = new Uint8Array(2_560 * 1024).fill(fill);
      return { data, oid: hashObject("blob", data) };
    });
    const deltas = Array.from({ length: 6 }, (_, index) => {
      const base = bases[index % 2]!;
      const data = new Uint8Array([index, 1, 2, 3]);
      return { base, data, oid: hashObject("blob", data) };
    });
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(deltas.length + bases.length);
    for (const delta of deltas) {
      writer.refDelta(delta.base.oid, literalDelta(delta.base.data.length, delta.data));
    }
    for (const base of bases) writer.object("blob", base.data);
    writer.finish();

    const ranges = vi.spyOn(PackDataReader.prototype, "readRangeBatch");
    let requested: number[][];
    try {
      await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      requested = ranges.mock.calls.map(([, requests]) =>
        requests.map((request) => request.position),
      );
    } finally {
      ranges.mockRestore();
    }

    const positions = (base: { oid: string }): number[] =>
      deltas
        .filter((delta) => delta.base === base)
        .map((delta) => store.packs.lookup(delta.oid)?.dataOff ?? -1);
    expect(requested).toEqual([positions(bases[0]!), positions(bases[1]!)]);
    for (const delta of deltas) expect(store.read(delta.oid)?.data).toEqual(delta.data);
  });
});
