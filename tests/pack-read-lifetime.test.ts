import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../packages/do/src/db/db.js";
import { concat } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { withGitMutationGuard } from "../packages/git/src/store/core/mutation-guard.js";
import { SqliteGitDatabase, type StoreOptions } from "../packages/git/src/store/index.js";
import { ObjectTable } from "../packages/git/src/store/objects/objects.js";
import { withIntegrationWorkspaceOwned } from "../packages/git/src/store/operations/integration-workspace/workspace.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackDataReader } from "../packages/git/src/store/pack/read/read-data.js";
import { withPackReadScope } from "../packages/git/src/store/pack/read/read-scope.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { scratchTransactionsFor } from "../packages/git/src/store/repository/shared-support.js";
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

function nativeWrite(native: GitFixture, bytes: Uint8Array): void {
  execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: native.dir,
    input: bytes,
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

  it.each([4, 4096])(
    "resolves a cold chain and multiple outputs with page size %i",
    async (graphPageEntries) => {
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
        const options = { objectCacheBytes: 0, graphPageEntries };
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
    },
  );

  it.each([1024 * 1024, 8 * 1024 * 1024])(
    "bounds external materialization batches for distinct roots of %i bytes",
    async (size) => {
      const db = new TestDatabase();
      const native = new GitFixture().init();
      try {
        const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
        const checkout = database.createRepository("/repo", "ref: refs/heads/main");
        const store = database.openCheckout(checkout);
        const bases = Array.from({ length: 6 }, (_, index) => {
          const bytes = new Uint8Array(size).fill(index + 65);
          nativeWrite(native, bytes);
          return store.write("blob", bytes);
        });
        const outputs = bases.map((_, index) => target(index));
        const oids = outputs.map((bytes) => hashObject("blob", bytes));
        const bytes = pack(bases.length, (writer) => {
          for (let index = 0; index < bases.length; index++) {
            writer.refDelta(bases[index]!, literal(size, outputs[index]!));
          }
        });
        nativeIngest(native, bytes);
        await store.packs.ingest(slices(bytes, 4096));
        const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout);
        const external = vi.spyOn(ObjectTable.prototype, "readLooseObjects");
        const result = cold.packs.readObjects(oids);
        for (const oid of oids) expect(result.get(oid)?.data).toEqual(native.catFile(oid));
        expect(external.mock.calls.map(([batch]) => batch.length)).toEqual(
          size === 1024 * 1024 ? [4, 2] : [1, 1, 1, 1, 1, 1],
        );
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it.each([false, true])(
    "reloads a discovery-time cache hit evicted before use (external=%s)",
    async (externalBase) => {
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
        if (externalBase) {
          store.write("blob", base);
          nativeWrite(native, base);
        }
        const bytes = pack(externalBase ? 7 : 8, (writer) => {
          if (!externalBase) writer.object("blob", base);
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
        expect(inflate.mock.calls.filter(([entry]) => entry.oid === intermediateOid)).toHaveLength(
          1,
        );
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it("retries external materialization after a failed read", async () => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout);
      const base = target(0);
      const output = target(1);
      nativeWrite(native, base);
      const baseOid = store.write("blob", base);
      const oid = hashObject("blob", output);
      const bytes = pack(1, (writer) => writer.refDelta(baseOid, literal(base.length, output)));
      nativeIngest(native, bytes);
      await store.packs.ingest(slices(bytes, 4096));
      const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout);
      const external = vi.spyOn(ObjectTable.prototype, "readLooseObjects");
      const failure = new Error("external reader failed");
      external.mockImplementationOnce(() => {
        throw failure;
      });
      expect(() => cold.packs.read(oid)).toThrow(failure);
      expect(cold.packs.read(oid)?.data).toEqual(native.catFile(oid));
      expect(external).toHaveBeenCalledTimes(2);
      expect(() => cold.packs.readObjects([oid], "tree")).toThrow(/not a tree/);
      expect(cold.packs.read("f".repeat(40))).toBeNull();
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });
});

class ObservingDatabase implements SqlDatabase {
  readonly queries: { query: string; bindings: unknown[] }[] = [];
  readonly pageRows: number[] = [];
  transactions = 0;
  openScratchCursors = 0;
  /** Runs before the wrapped statement, so a seam can mutate sources mid-scope. */
  onQuery: ((query: string) => void) | null = null;

  constructor(readonly inner: TestDatabase) {}

  get storage(): TestDatabase["storage"] {
    return this.inner.storage;
  }

  reset(): void {
    this.queries.length = 0;
    this.pageRows.length = 0;
    this.transactions = 0;
  }

  matching(pattern: RegExp): { query: string; bindings: unknown[] }[] {
    return this.queries.filter((entry) => pattern.test(entry.query));
  }

  #record(query: string, bindings: unknown[]): void {
    this.queries.push({ query, bindings });
    const hook = this.onQuery;
    if (hook !== null) hook(query);
  }

  run(query: string, ...bindings: unknown[]): void {
    this.#record(query, bindings);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#record(query, bindings);
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#record(query, bindings);
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#record(query, bindings);
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.#record(query, bindings);
    const rows = this.inner.iterate(query, ...bindings);
    const page = query.includes("/* pack-graph-page */");
    if (!page && !query.includes("git_pack_read_")) return rows;
    const owner = this;
    if (page) owner.pageRows.push(0);
    return {
      [Symbol.iterator](): IterableIterator<Record<string, unknown>> {
        const iterator = rows[Symbol.iterator]();
        let open = true;
        owner.openScratchCursors++;
        const close = (): void => {
          if (!open) return;
          open = false;
          owner.openScratchCursors--;
        };
        const wrapped: IterableIterator<Record<string, unknown>> = {
          [Symbol.iterator]: () => wrapped,
          next(): IteratorResult<Record<string, unknown>> {
            const step = iterator.next();
            if (step.done === true) close();
            else if (page) owner.pageRows[owner.pageRows.length - 1]!++;
            return step;
          },
          return(): IteratorResult<Record<string, unknown>> {
            close();
            iterator.return?.();
            return { done: true, value: undefined };
          },
        };
        return wrapped;
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.transactions++;
    return this.inner.transactionSync(closure);
  }
}

function scratchCounts(db: TestDatabase): { scopes: number; pages: number; frontier: number } {
  const count = (table: string): number => db.scalar<number>(`SELECT count(*) FROM ${table}`) ?? -1;
  return {
    scopes: count("git_pack_read_scopes"),
    pages: count("git_pack_read_pages"),
    frontier: count("git_pack_read_frontier"),
  };
}

function chainPack(length: number): { bytes: Uint8Array; outputs: Uint8Array[]; oids: string[] } {
  const outputs = Array.from({ length }, (_, index) => target(index));
  const oids = outputs.map((bytes) => hashObject("blob", bytes));
  const bytes = pack(length, (writer) => {
    writer.object("blob", outputs[0]!);
    for (let index = 1; index < length; index++) {
      writer.refDelta(oids[index - 1]!, literal(8, outputs[index]!));
    }
  });
  return { bytes, outputs, oids };
}

/** `count` independent delta chains, so every origin walks its own bases. */
function independentChains(count: number, length: number): { bytes: Uint8Array; tips: string[] } {
  const tips: string[] = [];
  const plan: { base: string | null; output: Uint8Array }[] = [];
  let value = 0;
  for (let chain = 0; chain < count; chain++) {
    let previous: string | null = null;
    for (let index = 0; index < length; index++) {
      const output = target(value++);
      plan.push({ base: previous, output });
      previous = hashObject("blob", output);
    }
    if (previous === null) throw new Error("a chain needs at least one object");
    tips.push(previous);
  }
  const bytes = pack(plan.length, (writer) => {
    for (const entry of plan) {
      if (entry.base === null) writer.object("blob", entry.output);
      else writer.refDelta(entry.base, literal(8, entry.output));
    }
  });
  return { bytes, tips };
}

/** Scratch statements and discovery pages one paged read over `origins` costs. */
async function frontierCost(origins: number): Promise<{ statements: number; pages: number }> {
  const inner = new TestDatabase();
  const observed = new ObservingDatabase(inner);
  const database = new SqliteGitDatabase(observed, {
    objectCacheBytes: 0,
    chunkBytes: 0,
    graphPageEntries: 4,
  });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const chains = independentChains(origins, 6);
  await store.packs.ingest(slices(chains.bytes, 4096));
  observed.reset();

  expect([...store.packs.readObjects(chains.tips).keys()]).toEqual(chains.tips);

  expect(scratchCounts(inner)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  return {
    statements: observed.matching(/git_pack_read_/).length,
    pages: observed.pageRows.length,
  };
}

async function pagedChain(db: SqlDatabase, options: StoreOptions = {}, length = 17) {
  const database = new SqliteGitDatabase(db, {
    objectCacheBytes: 0,
    chunkBytes: 0,
    graphPageEntries: 4,
    ...options,
  });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const chain = chainPack(length);
  const packed = await store.packs.ingest(slices(chain.bytes, 4096));
  return { store, checkout, packId: packed.packId, ...chain };
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

function pendingStore(db: SqlDatabase) {
  const database = new SqliteGitDatabase(db, {
    objectCacheBytes: 0,
    chunkBytes: 0,
    graphPageEntries: 4,
  });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  return { checkout, store: database.openCheckout(checkout) };
}

describe("paged packed read scope", () => {
  it("opens no transaction and touches no scratch on a non-paged read", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids, outputs } = await pagedChain(observed, { graphPageEntries: 4096 });
    observed.reset();

    expect(store.packs.read(oids[16]!)?.data).toEqual(outputs[16]);

    expect(observed.transactions).toBe(0);
    expect(observed.matching(/git_pack_read_|git_repositories/)).toEqual([]);
  });

  it("opens exactly one transaction and one owner row on a paged read", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids, outputs } = await pagedChain(observed);
    observed.reset();

    expect(store.packs.read(oids[16]!)?.data).toEqual(outputs[16]);

    expect(observed.transactions).toBe(1);
    expect(observed.matching(/INSERT INTO git_pack_read_scopes/)).toHaveLength(1);
    expect(observed.matching(/SELECT source_generation FROM git_repositories/)).toHaveLength(2);
    expect(scratchCounts(inner)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });

  it("allocates a distinct owner for a nested read scope and leaves no scratch", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids, outputs } = await pagedChain(observed);
    observed.reset();

    const outerId = withPackReadScope(observed, store.sharedRepoId, null, (outer) => {
      expect(store.packs.read(oids[16]!)?.data).toEqual(outputs[16]);
      return outer.readId;
    });

    const owners = observed
      .matching(/INSERT INTO git_pack_read_scopes/)
      .map((entry) => entry.bindings[1]);
    expect(owners).toHaveLength(2);
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).toBe(outerId);
    // Only the outermost scope snapshots the sources; the nested one inherits.
    expect(observed.matching(/SELECT source_generation FROM git_repositories/)).toHaveLength(2);
    expect(scratchCounts(inner)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });

  it("resolves a paged read inside a guarded write transaction", async () => {
    const db = new TestDatabase();
    const { store, oids, outputs } = await pagedChain(db);

    const result = withGitMutationGuard(db, () =>
      db.transactionSync(() => store.packs.read(oids[16]!)),
    );

    expect(result?.data).toEqual(outputs[16]);
    expect(scratchCounts(db)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });

  it("fails ECORRUPT and rolls its scratch back when sources change inside the scope", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids, checkout } = await pagedChain(observed);
    observed.reset();
    observed.onQuery = (query) => {
      if (!query.includes("/* pack-graph-page */")) return;
      observed.onQuery = null;
      inner.run(
        "UPDATE git_repositories SET source_generation = source_generation + 1 WHERE id = ?",
        checkout.repoId,
      );
    };

    expect(() => store.packs.read(oids[16]!)).toThrowError(
      expect.objectContaining({
        code: "ECORRUPT",
        message: "packed read observed a source change",
      }),
    );

    expect(scratchCounts(inner)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
    expect(() => scratchTransactionsFor(observed).requireHealthy()).not.toThrow();
  });

  it("resolves pending-visible bases through a deferred ingest", async () => {
    const db = new TestDatabase();
    const { store } = pendingStore(db);
    const chain = deferredChainPack(17);

    await store.packs.ingest(slices(chain.bytes, 4096));

    for (const oid of chain.oids) expect(store.packs.read(oid)).not.toBeNull();
    expect(scratchCounts(db)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });

  it("re-asserts the pending pack state a scope snapshotted", async () => {
    const db = new TestDatabase();
    const { store, checkout } = pendingStore(db);
    const chain = deferredChainPack(4);
    const packed = await store.packs.ingest(slices(chain.bytes, 4096));

    expect(() =>
      withPackReadScope(db, checkout.repoId, packed.packId, () => {
        db.run(
          "UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = ? AND pack_id = ?",
          checkout.repoId,
          packed.packId,
        );
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ECORRUPT",
        message: "packed read observed a source change",
      }),
    );
    expect(scratchCounts(db)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
    expect(
      db.scalar<string>("SELECT state FROM git_pack_meta WHERE pack_id = ?", packed.packId),
    ).toBe("complete");
  });

  it("leaves an enclosing integration workspace committable after a read failure", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids, checkout } = await pagedChain(observed);
    const tooMany = Array.from({ length: 4097 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );

    const committed = withIntegrationWorkspaceOwned(store.shared, () => {
      expect(() => store.packs.readObjects(tooMany)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      observed.onQuery = (query) => {
        if (!query.includes("/* pack-graph-page */")) return;
        observed.onQuery = null;
        inner.run(
          "UPDATE git_repositories SET source_generation = source_generation + 1 WHERE id = ?",
          checkout.repoId,
        );
      };
      expect(() => store.packs.read(oids[16]!)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      return "committed";
    });

    expect(committed).toBe("committed");
    expect(scratchCounts(inner)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });

  it("returns a paged read in request order, identically to the non-paged read", async () => {
    const pagedDb = new TestDatabase();
    const paged = await pagedChain(pagedDb);
    const wholeDb = new TestDatabase();
    const whole = await pagedChain(wholeDb, { graphPageEntries: 4096 });
    const wanted = [paged.oids[8]!, paged.oids[16]!, paged.oids[4]!];

    const pagedResult = paged.store.packs.readObjects(wanted);
    const wholeResult = whole.store.packs.readObjects(wanted);

    expect([...pagedResult.keys()]).toEqual(wanted);
    expect([...wholeResult.keys()]).toEqual(wanted);
    for (const oid of wanted) expect(pagedResult.get(oid)).toEqual(wholeResult.get(oid));
    // The logical read rebuilds its own result in request order as well.
    expect([...paged.store.readObjects(wanted).objects.keys()]).toEqual(wanted);
  });

  it("drains every scratch cursor before releasing the owner row", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids } = await pagedChain(observed);
    observed.reset();
    let openAtRelease = -1;
    observed.onQuery = (query) => {
      if (query.includes("DELETE FROM git_pack_read_scopes")) {
        openAtRelease = observed.openScratchCursors;
      }
    };

    expect(store.packs.read(oids[16]!)).not.toBeNull();

    expect(openAtRelease).toBe(0);
  });

  it("keeps every page inside its entry limit and its scratch inside the declared bound", async () => {
    const inner = new TestDatabase();
    const observed = new ObservingDatabase(inner);
    const { store, oids } = await pagedChain(observed, { graphPageEntries: 4 }, 64);
    observed.reset();
    let peakFrontier = 0;
    let peakPages = 0;
    observed.onQuery = (query) => {
      if (!query.includes("/* pack-graph-page */")) return;
      peakFrontier = Math.max(peakFrontier, scratchCounts(inner).frontier);
      peakPages = Math.max(peakPages, scratchCounts(inner).pages);
    };

    const wanted = [oids[63]!, oids[47]!, oids[31]!, oids[15]!];
    expect([...store.packs.readObjects(wanted).keys()]).toEqual(wanted);

    expect(observed.pageRows.length).toBeGreaterThan(4);
    for (const rows of observed.pageRows) expect(rows).toBeLessThanOrEqual(4);
    // origins x (depth + 1) is the declared frontier bound; pages are one per step.
    expect(peakFrontier).toBeLessThanOrEqual(wanted.length * observed.pageRows.length);
    expect(peakPages).toBeLessThanOrEqual(observed.pageRows.length);
    expect(scratchCounts(inner)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });

  it("costs scratch statements per page, never per origin", async () => {
    const small = await frontierCost(16);
    const large = await frontierCost(32);

    expect(small.pages).toBeGreaterThan(1);
    expect(large.pages).toBe(small.pages);
    // Independent chains of equal length page identically at both widths, so
    // doubling the origins must not cost a single extra statement.
    expect(large.statements).toBe(small.statements);
    // Discovery spends four per page - frontier read, page row, union graph,
    // move batch - and resolution two; the scope itself seeds, owns, releases.
    expect(large.statements).toBeLessThanOrEqual(6 * large.pages + 4);
  });

  it("pages a union graph that crosses the 4,096-entry discovery limit", async () => {
    const db = new TestDatabase();
    const { store, oids, outputs } = await pagedChain(db, { graphPageEntries: undefined }, 4_200);

    expect(store.packs.read(oids[4_199]!)?.data).toEqual(outputs[4_199]);

    expect(scratchCounts(db)).toEqual({ scopes: 0, pages: 0, frontier: 0 });
  });
});
