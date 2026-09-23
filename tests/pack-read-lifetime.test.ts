import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../packages/do/src/db/db.js";
import { concat } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { withGitMutationGuard } from "../packages/git/src/store/core/mutation-guard.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { withIntegrationWorkspaceOwned } from "../packages/git/src/store/operations/integration-workspace/workspace.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackDataReader } from "../packages/git/src/store/pack/read/read-data.js";
import { MAX_DELTA_DEPTH } from "../packages/git/src/store/pack/shared.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

afterEach(() => vi.restoreAllMocks());

function pack(count: number, write: (writer: PackWriter) => void): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(count);
  write(writer);
  writer.finish();
  return concat(chunks);
}

function literal(baseSize: number, target: Uint8Array): Uint8Array {
  return concat([
    encodeDeltaHeader(baseSize, target.length),
    new Uint8Array([target.length]),
    target,
  ]);
}

function target(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function nativeIngest(native: GitFixture, bytes: Uint8Array): void {
  execFileSync("git", ["index-pack", "--stdin", "--fix-thin"], {
    cwd: native.dir,
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("packed read payload lifetime", () => {
  it.each([0, 16 * 1024 * 1024])(
    "reuses shared bases only through the bounded cache (%i bytes)",
    async (objectCacheBytes) => {
      const db = new TestDatabase();
      const native = new GitFixture().init();
      try {
        const base = new Uint8Array(1024).fill(65);
        const baseOid = hashObject("blob", base);
        const targets = [target(1), target(2), target(3)];
        const oids = targets.map((bytes) => hashObject("blob", bytes));
        const bytes = pack(4, (writer) => {
          writer.object("blob", base);
          for (const output of targets) writer.refDelta(baseOid, literal(base.length, output));
        });
        nativeIngest(native, bytes);
        const database = new SqliteGitDatabase(db, { objectCacheBytes });
        const checkout = database.createRepository("/repo", "ref: refs/heads/main");
        await database.openCheckout(checkout).packs.ingest(slices(bytes, 4096));
        const cold = new SqliteGitDatabase(db, { objectCacheBytes }).openCheckout(checkout);
        const inflate = vi.spyOn(PackDataReader.prototype, "inflateCompressed");
        const result = cold.packs.readObjects(oids);
        expect([...result.keys()]).toEqual(oids);
        for (const oid of oids) expect(result.get(oid)?.data).toEqual(native.catFile(oid));
        expect(inflate.mock.calls.filter(([entry]) => entry.oid === baseOid)).toHaveLength(
          objectCacheBytes === 0 ? 3 : 1,
        );
        inflate.mockClear();
        expect(cold.packs.readObjects(oids)).toEqual(result);
        expect(inflate).toHaveBeenCalledTimes(objectCacheBytes === 0 ? 6 : 0);
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it("releases cache-ineligible fanout bases while retaining requested outputs", async () => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const base = new Uint8Array(4096).fill(66);
      const baseOid = hashObject("blob", base);
      const outputs = [target(1), target(2)];
      const oids = outputs.map((bytes) => hashObject("blob", bytes));
      const bytes = pack(3, (writer) => {
        writer.object("blob", base);
        for (const output of outputs) writer.refDelta(baseOid, literal(base.length, output));
      });
      nativeIngest(native, bytes);
      const options = { objectCacheBytes: 4096 };
      const database = new SqliteGitDatabase(db, options);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      await database.openCheckout(checkout).packs.ingest(slices(bytes, 4096));
      const cold = () => new SqliteGitDatabase(db, options).openCheckout(checkout);
      const inflate = vi.spyOn(PackDataReader.prototype, "inflateCompressed");
      expect([...cold().packs.readObjects(oids).values()].map((value) => value.data)).toEqual(
        oids.map((oid) => native.catFile(oid)),
      );
      expect(inflate.mock.calls.filter(([entry]) => entry.oid === baseOid)).toHaveLength(2);
      inflate.mockClear();
      const wanted = [baseOid, ...oids];
      const all = cold().packs.readObjects(wanted);
      expect([...all.keys()]).toEqual(wanted);
      expect(all.get(baseOid)?.data).toEqual(base);
      expect(inflate.mock.calls.filter(([entry]) => entry.oid === baseOid)).toHaveLength(1);
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });

  it("resolves a cold chain and multiple outputs", async () => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const outputs = Array.from({ length: 17 }, (_, index) => target(index));
      const oids = outputs.map((bytes) => hashObject("blob", bytes));
      const bytes = pack(outputs.length, (writer) => {
        writer.object("blob", outputs[0]!);
        for (let index = 1; index < outputs.length; index++) {
          writer.refDelta(oids[index - 1]!, literal(8, outputs[index]!));
        }
      });
      nativeIngest(native, bytes);
      const options = { objectCacheBytes: 0 };
      const database = new SqliteGitDatabase(db, options);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      await database.openCheckout(checkout).packs.ingest(slices(bytes, 4096));
      const cold = new SqliteGitDatabase(db, options).openCheckout(checkout);
      const inflate = vi.spyOn(PackDataReader.prototype, "inflateCompressed");
      expect(cold.packs.read(oids[16]!)?.data).toEqual(native.catFile(oids[16]!));
      expect(inflate).toHaveBeenCalledTimes(17);
      const wanted = [oids[8]!, oids[16]!, oids[4]!];
      const result = cold.packs.readObjects(wanted);
      expect([...result.keys()]).toEqual(wanted);
      for (const oid of wanted) expect(result.get(oid)?.data).toEqual(native.catFile(oid));
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });

  it("reloads a discovery-time cache hit evicted before use", async () => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout);
      const base = target(0);
      const intermediate = target(99);
      const output = target(100);
      const fillers = [1, 2, 3, 4, 5].map(target);
      const baseOid = hashObject("blob", base);
      const intermediateOid = hashObject("blob", intermediate);
      const oid = hashObject("blob", output);
      const bytes = pack(8, (writer) => {
        writer.object("blob", base);
        writer.refDelta(baseOid, literal(8, intermediate));
        writer.refDelta(intermediateOid, literal(8, output));
        for (const filler of fillers) writer.object("blob", filler);
      });
      nativeIngest(native, bytes);
      await store.packs.ingest(slices(bytes, 4096));
      const cold = new SqliteGitDatabase(db, { objectCacheBytes: 1024 }).openCheckout(checkout);
      expect(cold.packs.read(intermediateOid)?.data).toEqual(native.catFile(intermediateOid));
      const inflate = vi.spyOn(PackDataReader.prototype, "inflateCompressed");
      const wanted = [...fillers.map((bytes) => hashObject("blob", bytes)), oid];
      const result = cold.packs.readObjects(wanted);
      for (const oid of wanted) expect(result.get(oid)?.data).toEqual(native.catFile(oid));
      expect(inflate.mock.calls.filter(([entry]) => entry.oid === intermediateOid)).toHaveLength(1);
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });
});

class ObservingDatabase implements SqlDatabase {
  readonly queries: string[] = [];
  transactions = 0;

  constructor(readonly inner: TestDatabase) {}

  get storage(): TestDatabase["storage"] {
    return this.inner.storage;
  }

  reset(): void {
    this.queries.length = 0;
    this.transactions = 0;
  }

  matching(pattern: RegExp): string[] {
    return this.queries.filter((query) => pattern.test(query));
  }

  run(query: string, ...bindings: unknown[]): void {
    this.queries.push(query);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.queries.push(query);
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.queries.push(query);
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.queries.push(query);
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.queries.push(query);
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    this.transactions++;
    return this.inner.transactionSync(closure);
  }
}

const GRAPH_QUERY = /\/\* pack-graph \*\//;

/** `count` independent delta chains of `length` entries, so every tip walks its own bases. */
function independentChains(
  count: number,
  length: number,
): { bytes: Uint8Array; tips: string[]; outputs: Uint8Array[] } {
  const tips: string[] = [];
  const outputs: Uint8Array[] = [];
  const plan: { base: string | null; output: Uint8Array }[] = [];
  let value = 0;
  for (let chain = 0; chain < count; chain++) {
    let previous: string | null = null;
    let output: Uint8Array | null = null;
    for (let index = 0; index < length; index++) {
      output = target(value++);
      plan.push({ base: previous, output });
      previous = hashObject("blob", output);
    }
    if (previous === null || output === null) throw new Error("a chain needs at least one object");
    tips.push(previous);
    outputs.push(output);
  }
  const bytes = pack(plan.length, (writer) => {
    for (const entry of plan) {
      if (entry.base === null) writer.object("blob", entry.output);
      else writer.refDelta(entry.base, literal(8, entry.output));
    }
  });
  return { bytes, tips, outputs };
}

async function chainStore(db: SqlDatabase, length: number) {
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 0, chunkBytes: 0 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const chain = independentChains(1, length);
  await store.packs.ingest(slices(chain.bytes, 64 * 1024));
  const tip = chain.tips[0]!;
  const output = chain.outputs[0]!;
  return { store, tip, output };
}

/**
 * Forward ref-deltas defer every entry, so resolution reads the bases back out
 * of the still-pending pack — the only caller that passes a pending pack id.
 */
function deferredChainPack(length: number): { bytes: Uint8Array; oids: string[] } {
  const outputs = Array.from({ length }, (_, index) => target(index));
  const oids = outputs.map((bytes) => hashObject("blob", bytes));
  const bytes = pack(length, (writer) => {
    for (let index = length - 1; index > 0; index--) {
      writer.refDelta(oids[index - 1]!, literal(8, outputs[index]!));
    }
    writer.object("blob", outputs[0]!);
  });
  return { bytes, oids };
}

describe("non-paged packed reads", () => {
  it("opens no transaction and writes nothing", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, tip, output } = await chainStore(observed, 17);
    observed.reset();

    expect(store.packs.read(tip)?.data).toEqual(output);

    expect(observed.transactions).toBe(0);
    expect(observed.matching(GRAPH_QUERY)).toHaveLength(1);
    expect(observed.matching(/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/)).toEqual([]);
  });

  it("reads one object at the maximum depth from a single graph query", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, tip, output } = await chainStore(observed, MAX_DELTA_DEPTH + 1);
    observed.reset();

    expect(store.packs.read(tip)?.data).toEqual(output);

    expect(observed.matching(GRAPH_QUERY)).toHaveLength(1);
  });

  it("splits 4,096 wanted depth-3 chains whose union graph exceeds one graph", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const database = new SqliteGitDatabase(observed, { objectCacheBytes: 0, chunkBytes: 0 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const chains = independentChains(4096, 4);
    await store.packs.ingest(slices(chains.bytes, 64 * 1024));
    observed.reset();

    const result = store.packs.readObjects(chains.tips, "blob");

    expect([...result.keys()]).toEqual(chains.tips);
    chains.tips.forEach((oid, index) => {
      expect(result.get(oid)?.data).toEqual(chains.outputs[index]);
    });
    expect(observed.matching(GRAPH_QUERY).length).toBeGreaterThan(1);
    expect(observed.transactions).toBe(0);
  });

  it("resolves pending-visible bases through a deferred ingest", async () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0, chunkBytes: 0 });
    const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
    const chain = deferredChainPack(17);

    await store.packs.ingest(slices(chain.bytes, 4096));

    for (const oid of chain.oids) expect(store.packs.read(oid)).not.toBeNull();
  });

  it("resolves a read inside a guarded write transaction", async () => {
    const db = new TestDatabase();
    const { store, tip, output } = await chainStore(db, 17);

    const result = withGitMutationGuard(db, () => db.transactionSync(() => store.packs.read(tip)));

    expect(result?.data).toEqual(output);
  });

  it("leaves an enclosing integration workspace committable after a read failure", async () => {
    const db = new TestDatabase();
    const { store, tip, output } = await chainStore(db, 17);
    const tooMany = Array.from({ length: 4097 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );

    const committed = withIntegrationWorkspaceOwned(store.shared, () => {
      expect(() => store.packs.readObjects(tooMany)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(store.packs.read(tip)?.data).toEqual(output);
      return "committed";
    });

    expect(committed).toBe("committed");
  });
});
