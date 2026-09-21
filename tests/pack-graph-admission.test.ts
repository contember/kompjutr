import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { comparePaths } from "../packages/git/src/common/paths.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { PackGraphAdmission } from "../packages/git/src/store/pack/graph/graph-admission.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { lifecycleDelta, lifecyclePack } from "./helpers/pack-maintenance.js";

interface BlobFixture {
  oid: string;
  data: Uint8Array;
}

function object(data: Uint8Array): BlobFixture {
  return { oid: hashObject("blob", data), data };
}

function numberedObject(index: number): BlobFixture {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setUint32(0, index);
  return object(data);
}

function open() {
  const db = new TestDatabase();
  const native = new GitFixture().init();
  const options = { maxDeltaDepth: 600 };
  const database = new SqliteGitDatabase(db, options);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const ingest = async (bytes: Uint8Array) => {
    execFileSync("git", ["index-pack", "--stdin", "--fix-thin"], {
      cwd: native.dir,
      input: bytes,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return (await store.packs.ingest(slices(bytes, 4096))).packId;
  };
  const cold = () => new SqliteGitDatabase(db, options).openCheckout(checkout);
  const dispose = () => {
    native.dispose();
    db.storage.db.close();
  };
  return { db, native, store, ingest, cold, dispose };
}

function verifyNative(native: GitFixture, objects: readonly BlobFixture[]): void {
  const actual = execFileSync("git", ["cat-file", "--batch"], {
    cwd: native.dir,
    input: `${objects.map((entry) => entry.oid).join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const expected = concat(
    objects.flatMap((entry) => [
      utf8.encode(`${entry.oid} blob ${entry.data.length}\n`),
      entry.data,
      utf8.encode("\n"),
    ]),
  );
  expect(actual.equals(expected)).toBe(true);
}

function fullPack(objects: readonly BlobFixture[]): Uint8Array {
  return lifecyclePack((writer) => {
    for (const entry of objects) writer.object("blob", entry.data);
  }, objects.length);
}

function expectClean(db: TestDatabase): void {
  for (const suffix of ["operations", "affected", "memo", "path"]) {
    expect(db.scalar<number>(`SELECT count(*) FROM git_pack_graph_${suffix}`)).toBe(0);
  }
}

describe("pack graph starting roots", () => {
  it("rejects a missing changed root reached through a surviving dependent", async () => {
    const fixture = open();
    const { db, ingest, native, store, cold } = fixture;
    try {
      const base = object(utf8.encode("deleted root\n"));
      const child = object(utf8.encode("surviving dependent\n"));
      const basePack = await ingest(fullPack([base]));
      await ingest(
        lifecyclePack((writer) => {
          writer.refDelta(base.oid, lifecycleDelta(base.data.length, child.data));
        }, 1),
      );
      verifyNative(native, [base, child]);

      // Isolate final-graph admission from the earlier physical-base pin guard.
      expect(() =>
        db.transactionSync(() => {
          const graph = new PackGraphAdmission(db, store.sharedRepoId, 600, "deletion");
          graph.seedPacks([basePack]);
          db.run(
            "DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
            store.sharedRepoId,
            basePack,
          );
          graph.validate();
          graph.cleanup();
        }),
      ).toThrow(`missing delta base ${base.oid}`);

      const reopened = cold();
      expect(reopened.read(base.oid)?.data).toEqual(base.data);
      expect(reopened.read(child.oid)?.data).toEqual(child.data);
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });

  it("validates interleaved visible and deleted roots across the 256-record boundary", async () => {
    const fixture = open();
    const { db, ingest, native, store, cold } = fixture;
    try {
      const objects = Array.from({ length: 1024 }, (_, index) => numberedObject(index));
      objects.sort((left, right) => comparePaths(left.oid, right.oid));
      const removed = objects.filter((_entry, index) => index % 2 === 0);
      const retained = objects.filter((_entry, index) => index % 2 === 1);
      const removedPack = await ingest(fullPack(removed));
      const retainedPack = await ingest(fullPack(retained));
      verifyNative(native, objects);

      db.transactionSync(() => {
        const graph = new PackGraphAdmission(db, store.sharedRepoId, 600, "deletion");
        graph.seedPacks([removedPack, retainedPack]);
        db.run(
          "DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          store.sharedRepoId,
          removedPack,
        );
        graph.validate();
        graph.cleanup();
      });

      const reopened = cold();
      for (const entry of removed) expect(reopened.read(entry.oid)).toBeNull();
      for (const entry of retained) expect(reopened.read(entry.oid)?.data).toEqual(entry.data);
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });

  it("finishes a multi-page chain before skipping a missing-root gap", async () => {
    const fixture = open();
    const { db, ingest, native, store, cold } = fixture;
    try {
      const chain = Array.from({ length: 513 }, (_, index) => numberedObject(index));
      let tip = numberedObject(1000000);
      for (let index = 1000001; !tip.oid.startsWith("1"); index++) tip = numberedObject(index);
      let last = numberedObject(2000000);
      for (let index = 2000001; !last.oid.startsWith("f"); index++) last = numberedObject(index);
      const gap: BlobFixture[] = [];
      for (let index = 3000000; gap.length < 768; index++) {
        const entry = numberedObject(index);
        if (comparePaths(entry.oid, tip.oid) > 0 && comparePaths(entry.oid, last.oid) < 0)
          gap.push(entry);
      }
      const first = chain[0];
      const base = chain[chain.length - 1];
      if (first === undefined || base === undefined) throw new Error("chain fixture is empty");
      await ingest(
        lifecyclePack((writer) => {
          writer.object("blob", first.data);
          let previous = first;
          for (const entry of chain.slice(1)) {
            writer.refDelta(previous.oid, lifecycleDelta(previous.data.length, entry.data));
            previous = entry;
          }
        }, chain.length),
      );
      const tipPack = await ingest(
        lifecyclePack((writer) => {
          writer.refDelta(base.oid, lifecycleDelta(base.data.length, tip.data));
        }, 1),
      );
      const gapPack = await ingest(fullPack(gap));
      const lastPack = await ingest(fullPack([last]));
      verifyNative(native, [...chain, tip, ...gap, last]);

      db.transactionSync(() => {
        const graph = new PackGraphAdmission(db, store.sharedRepoId, 600, "deletion");
        graph.seedPacks([tipPack, gapPack, lastPack]);
        db.run(
          "DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
          store.sharedRepoId,
          gapPack,
        );
        graph.validate();
        graph.cleanup();
      });

      const reopened = cold();
      expect(reopened.read(tip.oid)?.data).toEqual(tip.data);
      expect(reopened.read(last.oid)?.data).toEqual(last.data);
      for (const entry of gap) expect(reopened.read(entry.oid)).toBeNull();
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });
});
