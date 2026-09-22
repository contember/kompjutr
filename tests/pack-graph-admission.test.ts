import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { comparePaths } from "../packages/git/src/common/paths.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { PackGraphAdmission } from "../packages/git/src/store/pack/graph/graph-admission.js";
import { GRAPH_PAGE } from "../packages/git/src/store/pack/graph/graph-sql.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { lifecycleDelta, lifecyclePack } from "./helpers/pack-maintenance.js";

/**
 * The page the root-boundary fixtures below are sized against. Production pages
 * at `GRAPH_PAGE`; pinning these two cases keeps their crossings affordable.
 */
const BOUNDARY_PAGE = 256;

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

function open(maxDeltaDepth = 600) {
  const db = new TestDatabase();
  const native = new GitFixture().init();
  const options = { maxDeltaDepth };
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
        const graph = new PackGraphAdmission(
          db,
          store.sharedRepoId,
          600,
          "deletion",
          BOUNDARY_PAGE,
        );
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
        const graph = new PackGraphAdmission(
          db,
          store.sharedRepoId,
          600,
          "deletion",
          BOUNDARY_PAGE,
        );
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

  it("visits the same graph rows at the production page as at a 256-record page", async () => {
    const fixture = open();
    const { db, ingest, native, store } = fixture;
    try {
      // One delta child per base: the affected set crosses the production page
      // with objects the seed keeps, because each one takes part in a delta.
      const bases = Array.from({ length: GRAPH_PAGE / 2 + 32 }, (_, index) =>
        numberedObject(index),
      );
      const children = bases.map((_entry, index) => numberedObject(1_000_000 + index));
      const chain = Array.from({ length: 320 }, (_, index) => numberedObject(2_000_000 + index));
      const head = chain[0];
      if (head === undefined) throw new Error("chain fixture is empty");
      const objectCount = bases.length + children.length + chain.length;
      const packId = await ingest(
        lifecyclePack((writer) => {
          for (const [index, entry] of bases.entries()) {
            const child = children[index];
            if (child === undefined) throw new Error("delta child fixture is missing");
            writer.object("blob", entry.data);
            writer.refDelta(entry.oid, lifecycleDelta(entry.data.length, child.data));
          }
          writer.object("blob", head.data);
          let previous = head;
          for (const entry of chain.slice(1)) {
            writer.refDelta(previous.oid, lifecycleDelta(previous.data.length, entry.data));
            previous = entry;
          }
        }, objectCount),
      );
      verifyNative(native, [...bases, ...children, ...chain]);

      const walk = (page: number) =>
        db.transactionSync(() => {
          db.storage.resetCounters();
          const graph = new PackGraphAdmission(db, store.sharedRepoId, 600, "publication", page);
          graph.seedPacks([packId]);
          graph.validate();
          const statements = db.storage.statementCount;
          const memo = db.all<{ oid: string; depth: number; type: string }>(
            "SELECT oid, depth, type FROM git_pack_graph_memo ORDER BY oid",
          );
          // `cursor` is spent reverse-walk progress, dead once `pending` is 0.
          const affected = db.all<{ oid: string; pending: number }>(
            "SELECT oid, pending FROM git_pack_graph_affected ORDER BY oid",
          );
          graph.cleanup();
          return { statements, memo, affected };
        });

      const paged = walk(BOUNDARY_PAGE);
      const production = walk(GRAPH_PAGE);

      // The page changes how many round trips the same closure costs, nothing else.
      const pages = Math.ceil(objectCount / GRAPH_PAGE);
      expect(production.statements).toBeLessThan(10 * (pages + 1));
      expect(production.statements).toBeLessThan(paged.statements);
      expect(production.memo).toEqual(paged.memo);
      expect(production.affected).toEqual(paged.affected);
      expect(paged.memo).toHaveLength(objectCount);
      expect(paged.affected.length).toBeGreaterThan(GRAPH_PAGE);
      expect(paged.affected.every((row) => row.pending === 0)).toBe(true);
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });
});

describe("pack graph seeding", () => {
  it("seeds the delta participants of a changed pack and nothing else", async () => {
    const fixture = open();
    const { db, ingest, native, store } = fixture;
    try {
      const solo = Array.from({ length: 16 }, (_, index) => numberedObject(index));
      const chain = Array.from({ length: 3 }, (_, index) => numberedObject(1_000_000 + index));
      const head = chain[0];
      if (head === undefined) throw new Error("chain fixture is empty");
      const packId = await ingest(
        lifecyclePack((writer) => {
          for (const entry of solo) writer.object("blob", entry.data);
          writer.object("blob", head.data);
          let previous = head;
          for (const entry of chain.slice(1)) {
            writer.refDelta(previous.oid, lifecycleDelta(previous.data.length, entry.data));
            previous = entry;
          }
        }, solo.length + chain.length),
      );
      verifyNative(native, [...solo, ...chain]);

      const seeded = db.transactionSync(() => {
        const graph = new PackGraphAdmission(db, store.sharedRepoId, 600, "publication");
        graph.seedPacks([packId]);
        const rows = db.all<{ oid: string }>(
          "SELECT oid FROM git_pack_graph_affected ORDER BY oid",
        );
        graph.cleanup();
        return rows.map((row) => row.oid);
      });

      expect(seeded).toEqual(chain.map((entry) => entry.oid).sort(comparePaths));
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });

  it("seeds a changed-pack base whose only delta child is an older published pack", async () => {
    const fixture = open();
    const { db, ingest, native, store } = fixture;
    try {
      const base = object(utf8.encode("base published twice\n"));
      const child = object(utf8.encode("dependent published first\n"));
      const solo = Array.from({ length: 8 }, (_, index) => numberedObject(index));
      native.writeObject("blob", base.data);
      store.write("blob", base.data);
      await ingest(
        lifecyclePack((writer) => {
          writer.refDelta(base.oid, lifecycleDelta(base.data.length, child.data));
        }, 1),
      );
      const packId = await ingest(fullPack([base, ...solo]));
      verifyNative(native, [base, child, ...solo]);

      const walk = db.transactionSync(() => {
        const graph = new PackGraphAdmission(db, store.sharedRepoId, 600, "publication");
        graph.seedPacks([packId]);
        const seeded = db.all<{ oid: string }>(
          "SELECT oid FROM git_pack_graph_affected ORDER BY oid",
        );
        graph.validate();
        const closure = db.all<{ oid: string }>(
          "SELECT oid FROM git_pack_graph_affected ORDER BY oid",
        );
        const memo = db.all<{ oid: string; depth: number }>(
          "SELECT oid, depth FROM git_pack_graph_memo ORDER BY oid",
        );
        graph.cleanup();
        return { seeded, closure, memo };
      });

      expect(walk.seeded.map((row) => row.oid)).toEqual([base.oid]);
      expect(walk.closure.map((row) => row.oid)).toEqual([base.oid, child.oid].sort(comparePaths));
      expect(walk.memo).toEqual(
        [
          { oid: base.oid, depth: 0 },
          { oid: child.oid, depth: 1 },
        ].sort((left, right) => comparePaths(left.oid, right.oid)),
      );
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a cycle that fallback promotion closes between changed-pack objects", async () => {
    const fixture = open();
    const { db, ingest, native, store, cold } = fixture;
    try {
      const a = object(utf8.encode("reciprocal A\n"));
      const b = object(utf8.encode("reciprocal B\n"));
      const packId = await ingest(fullPack([a, b]));
      // Neither canonical row is a delta, and neither is a canonical base: the
      // edges exist only as the surviving entries a deletion would promote.
      await ingest(
        lifecyclePack((writer) => {
          writer.refDelta(b.oid, lifecycleDelta(b.data.length, a.data));
        }, 1),
      );
      await ingest(
        lifecyclePack((writer) => {
          writer.refDelta(a.oid, lifecycleDelta(a.data.length, b.data));
        }, 1),
      );
      store.write("blob", a.data);
      store.write("blob", b.data);
      verifyNative(native, [a, b]);

      expect(() => store.packs.deleteCompletePacks([packId])).toThrow(/cyclic delta chain/);

      const reopened = cold();
      expect(reopened.packs.completePackedEntry(a.oid)?.packId).toBe(packId);
      expect(reopened.packs.completePackedEntry(b.oid)?.packId).toBe(packId);
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a chain that fallback promotion deepens past the limit", async () => {
    const depth = 3;
    const fixture = open(depth);
    const { db, ingest, native, store, cold } = fixture;
    try {
      const chain = Array.from({ length: depth + 1 }, (_, index) => numberedObject(index));
      const solo = object(utf8.encode("promoted past the limit\n"));
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (head === undefined || tail === undefined) throw new Error("chain fixture is empty");
      await ingest(
        lifecyclePack((writer) => {
          writer.object("blob", head.data);
          let previous = head;
          for (const entry of chain.slice(1)) {
            writer.refDelta(previous.oid, lifecycleDelta(previous.data.length, entry.data));
            previous = entry;
          }
        }, chain.length),
      );
      const soloPack = await ingest(fullPack([solo]));
      // The deeper copy is never canonical, so publication never walks it; the
      // promotion a deletion performs is what makes it the object's only source.
      await ingest(
        lifecyclePack((writer) => {
          writer.refDelta(tail.oid, lifecycleDelta(tail.data.length, solo.data));
        }, 1),
      );
      verifyNative(native, [...chain, solo]);

      expect(() => store.packs.deleteCompletePacks([soloPack])).toThrow(
        `delta chain deeper than ${depth}`,
      );

      const reopened = cold();
      expect(reopened.read(solo.oid)?.data).toEqual(solo.data);
      expect(reopened.packs.completePackedEntry(solo.oid)?.packId).toBe(soloPack);
      expectClean(db);
    } finally {
      fixture.dispose();
    }
  });
});
