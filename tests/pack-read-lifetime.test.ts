import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { concat } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { ObjectTable } from "../packages/git/src/store/objects/objects.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackDataReader } from "../packages/git/src/store/pack/read/read-data.js";
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
