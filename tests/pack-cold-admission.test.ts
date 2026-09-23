import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject, type ObjectType, serializeTree } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import {
  MAX_DELTA_DEPTH,
  MAX_PACK_DELTA_WORKING_BYTES,
} from "../packages/git/src/store/pack/shared.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { reclaimPending } from "./helpers/pack-store.js";

function literalDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  const chunks = [encodeDeltaHeader(base.length, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const part = target.subarray(offset, offset + 127);
    chunks.push(new Uint8Array([part.length]), part);
  }
  return concat(chunks);
}

function pack(count: number, write: (writer: PackWriter) => void): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(count);
  write(writer);
  writer.finish();
  return concat(chunks);
}

function chainPack(depth: number) {
  let target = new Uint8Array(8);
  const bytes = pack(depth + 1, (writer) => {
    writer.object("blob", target);
    for (let edge = 1; edge <= depth; edge++) {
      const base = target;
      target = new Uint8Array(8);
      new DataView(target.buffer).setUint32(0, edge);
      writer.refDelta(hashObject("blob", base), literalDelta(base, target));
    }
  });
  return { bytes, target, oid: hashObject("blob", target) };
}

function nativeIngest(native: GitFixture, bytes: Uint8Array): void {
  execFileSync("git", ["index-pack", "--stdin", "--fix-thin"], {
    cwd: native.dir,
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function fallbackFixture(loose = false) {
  const db = new TestDatabase();
  const native = new GitFixture().init();
  const database = new SqliteGitDatabase(db);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const a = utf8.encode("fallback A\n");
  const b = utf8.encode("fallback B\n");
  const aOid = hashObject("blob", a);
  const bOid = hashObject("blob", b);
  const bytes = [
    pack(1, (writer) => writer.object("blob", a)),
    pack(2, (writer) => {
      writer.object("blob", a);
      writer.refDelta(aOid, literalDelta(a, b));
    }),
    pack(2, (writer) => {
      writer.object("blob", b);
      writer.refDelta(bOid, literalDelta(b, a));
    }),
  ];
  const ids: number[] = [];
  for (const data of bytes) {
    nativeIngest(native, data);
    ids.push((await store.packs.ingest(slices(data, 4096))).packId);
  }
  expect(new Uint8Array(native.gitBinary("cat-file", "blob", aOid))).toEqual(a);
  expect(new Uint8Array(native.gitBinary("cat-file", "blob", bOid))).toEqual(b);
  if (loose) store.write("blob", a);
  const [first, second, fallback] = ids;
  if (first === undefined || second === undefined || fallback === undefined)
    throw new Error("missing pack");
  return { db, native, store, checkout, first, second, fallback, a, b, aOid, bOid };
}

function copiedZeros(baseSize: number, targetSize: number): Uint8Array {
  const instructions: number[] = [];
  for (let remaining = targetSize; remaining > 0; ) {
    const size = Math.min(65536, remaining);
    if (size === 65536) instructions.push(0x80);
    else instructions.push(0xf0, size & 255, (size >>> 8) & 255, (size >>> 16) & 255);
    remaining -= size;
  }
  return concat([encodeDeltaHeader(baseSize, targetSize), new Uint8Array(instructions)]);
}

function entryHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 128);
    first = rest & 127;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function ofsPack(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const header = new Uint8Array(12);
  header.set(utf8.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, 2);
  const full = concat([entryHeader(3, base.length), deflateSync(base)]);
  let distance = full.length;
  const offset = [distance & 127];
  distance = Math.floor(distance / 128);
  while (distance > 0) {
    distance--;
    offset.unshift(128 | (distance & 127));
    distance = Math.floor(distance / 128);
  }
  const body = concat([
    header,
    full,
    entryHeader(6, delta.length),
    new Uint8Array(offset),
    deflateSync(delta),
  ]);
  return concat([body, createHash("sha1").update(body).digest()]);
}

describe("cold pack admission", () => {
  it("keeps mixed object types independent across forward-page root changes", async () => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const blobOid = hashObject("blob", utf8.encode("base\n"));
      const tree = serializeTree([{ mode: "100644", name: "base", oid: blobOid }]);
      const treeOid = hashObject("tree", tree);
      const commit = (message: string) =>
        utf8.encode(
          `tree ${treeOid}\nauthor Fixture <fixture@example.com> 0 +0000\ncommitter Fixture <fixture@example.com> 0 +0000\n\n${message}\n`,
        );
      const commitOid = hashObject("commit", commit("base"));
      const tag = (name: string) =>
        utf8.encode(
          `object ${commitOid}\ntype commit\ntag ${name}\ntagger Fixture <fixture@example.com> 0 +0000\n\n${name}\n`,
        );
      const inputs: { type: ObjectType; base: Uint8Array; target: Uint8Array }[] = [
        { type: "blob", base: utf8.encode("base\n"), target: utf8.encode("target\n") },
        {
          type: "tree",
          base: tree,
          target: serializeTree([{ mode: "100644", name: "target", oid: blobOid }]),
        },
        { type: "commit", base: commit("base"), target: commit("target") },
        { type: "tag", base: tag("base"), target: tag("target") },
      ];
      const bytes = pack(inputs.length * 2, (writer) => {
        for (const input of inputs) {
          writer.object(input.type, input.base);
          writer.refDelta(
            hashObject(input.type, input.base),
            literalDelta(input.base, input.target),
          );
        }
      });
      nativeIngest(native, bytes);
      const options = { maxDeltaDepth: 1 };
      const database = new SqliteGitDatabase(db, options);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      await database.openCheckout(checkout).packs.ingest(slices(bytes, 4096));
      const cold = new SqliteGitDatabase(db, options).openCheckout(checkout);
      for (const input of inputs) {
        const oid = hashObject(input.type, input.target);
        const expected = new Uint8Array(native.gitBinary("cat-file", input.type, oid));
        expect(cold.read(oid)).toEqual({ type: input.type, data: expected });
      }
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });
  it.each(["missing", "promised"])(
    "does not accept a %s base as a terminal",
    async (availability) => {
      const db = new TestDatabase();
      const native = new GitFixture().init();
      try {
        const database = new SqliteGitDatabase(db);
        const checkout = database.createRepository("/repo", "ref: refs/heads/main");
        const store = database.openCheckout(checkout);
        const base = utf8.encode("unavailable base\n");
        const target = utf8.encode("unavailable target\n");
        const baseOid = hashObject("blob", base);
        const targetOid = hashObject("blob", target);
        const full = pack(1, (writer) => writer.object("blob", base));
        const thin = pack(1, (writer) => writer.refDelta(baseOid, literalDelta(base, target)));
        nativeIngest(native, full);
        nativeIngest(native, thin);
        expect(new Uint8Array(native.gitBinary("cat-file", "blob", targetOid))).toEqual(target);
        if (availability === "promised") {
          store.registerPromisorRemote("origin", "https://example.test/repo.git");
          store.addPromisedBlobs("origin", [baseOid]);
        }
        await expect(store.packs.ingest(slices(thin, 4096))).rejects.toMatchObject({
          code: "ECORRUPT",
          message: expect.stringMatching(/missing base in the pack/),
        });
        const cold = new SqliteGitDatabase(db).openCheckout(checkout);
        expect(cold.read(baseOid)).toBeNull();
        expect(cold.read(targetOid)).toBeNull();
        if (availability === "promised") expect(cold.promisedMissing([baseOid])).toEqual([baseOid]);
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );
  it.each([3, MAX_DELTA_DEPTH])(
    "accepts exactly %i edges and reads them after reopen",
    async (limit) => {
      const db = new TestDatabase();
      const native = new GitFixture().init();
      try {
        const fixture = chainPack(limit);
        nativeIngest(native, fixture.bytes);
        const expected = native.gitBinary("cat-file", "blob", fixture.oid);
        expect(new Uint8Array(expected)).toEqual(fixture.target);
        const options = { maxDeltaDepth: limit };
        const database = new SqliteGitDatabase(db, options);
        const checkout = database.createRepository("/repo", "ref: refs/heads/main");
        await database.openCheckout(checkout).packs.ingest(slices(fixture.bytes, 64 * 1024));
        const cold = new SqliteGitDatabase(db, options).openCheckout(checkout);
        expect(cold.read(fixture.oid)?.data).toEqual(new Uint8Array(expected));
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it.each([3, MAX_DELTA_DEPTH])("rejects %i + 1 edges before publication", async (limit) => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const fixture = chainPack(limit + 1);
      nativeIngest(native, fixture.bytes);
      expect(new Uint8Array(native.gitBinary("cat-file", "blob", fixture.oid))).toEqual(
        fixture.target,
      );
      const options = { maxDeltaDepth: limit };
      const database = new SqliteGitDatabase(db, options);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      let published = false;
      await expect(
        database.openCheckout(checkout).packs.ingest(slices(fixture.bytes, 64 * 1024), {
          lifecycle: {
            reserved() {},
            published() {
              published = true;
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "ECORRUPT",
        message: expect.stringMatching(new RegExp(`deeper than ${limit}`)),
      });
      expect(published).toBe(false);
      const cold = new SqliteGitDatabase(db, options).openCheckout(checkout);
      expect(cold.read(fixture.oid)).toBeNull();
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
        0,
      );
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });

  it.each([false, true])(
    "promotes into crossed self-contained packs, with a loose copy: %s",
    async (loose) => {
      const fixture = await fallbackFixture(loose);
      const { db, native, store, checkout, first, second, aOid, bOid, a, b } = fixture;
      try {
        expect(store.packs.deleteCompletePacks([first])).toBe(1);
        const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout);
        expect(cold.packs.completePackedEntry(aOid)?.packId).toBe(second);
        expect(cold.packs.completePackedEntry(bOid)?.packId).toBe(second);
        expect(cold.packs.readObjects([aOid, bOid])).toEqual(
          new Map([
            [aOid, { type: "blob", data: a }],
            [bOid, { type: "blob", data: b }],
          ]),
        );
        expect(cold.read(aOid)?.data).toEqual(a);
        expect(cold.read(bOid)?.data).toEqual(b);
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it.each([false, true])(
    "validates the repaired final deletion batch in either order: %s",
    async (reverse) => {
      const fixture = await fallbackFixture();
      const { db, native, store, checkout, first, second, fallback, aOid, bOid, a, b } = fixture;
      try {
        expect(store.packs.deleteCompletePacks(reverse ? [second, first] : [first, second])).toBe(
          2,
        );
        const cold = new SqliteGitDatabase(db).openCheckout(checkout);
        expect(cold.packs.completePackedEntry(aOid)?.packId).toBe(fallback);
        expect(cold.packs.completePackedEntry(bOid)?.packId).toBe(fallback);
        expect(cold.read(aOid)?.data).toEqual(a);
        expect(cold.read(bOid)?.data).toEqual(b);
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it.each(["throw", "promise"])(
    "rolls back a deletion nested in the published callback on %s",
    async (failure) => {
      const fixture = await fallbackFixture();
      const { db, native, store, checkout, first, second, aOid, bOid, a, b } = fixture;
      try {
        const data = utf8.encode("callback publication\n");
        const oid = hashObject("blob", data);
        store.registerPromisorRemote("origin", "https://example.test/repo.git");
        store.addPromisedBlobs("origin", [oid]);
        const bytes = pack(1, (writer) => writer.object("blob", data));
        nativeIngest(native, bytes);
        expect(new Uint8Array(native.gitBinary("cat-file", "blob", oid))).toEqual(data);
        await expect(
          store.packs.ingest(slices(bytes, 4096), {
            lifecycle: {
              reserved() {},
              published() {
                expect(store.packs.deleteCompletePacks([second])).toBe(1);
                if (failure === "promise") return Promise.resolve();
                throw new Error("outer callback failed");
              },
            },
          }),
        ).rejects.toThrow(
          failure === "promise" ? /must return undefined/ : /outer callback failed/,
        );
        const cold = new SqliteGitDatabase(db).openCheckout(checkout);
        expect(cold.packs.completePackedEntry(aOid)?.packId).toBe(first);
        expect(cold.packs.completePackedEntry(bOid)?.packId).toBe(second);
        expect(cold.read(aOid)?.data).toEqual(a);
        expect(cold.read(bOid)?.data).toEqual(b);
        expect(cold.read(oid)).toBeNull();
        expect(cold.promisedMissing([oid])).toEqual([oid]);
        expect(await reclaimPending(cold)).toBe(1);
        await cold.packs.ingest(slices(bytes, 4096));
        expect(cold.read(oid)?.data).toEqual(data);
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );

  it("keeps refs, commit projections and promises unpublished on depth rejection", async () => {
    const db = new TestDatabase();
    const native = new GitFixture().init();
    try {
      const options = { maxDeltaDepth: 3 };
      const database = new SqliteGitDatabase(db, options);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout);
      const tree = store.write("tree", new Uint8Array());
      const commitBytes = (message: string) =>
        utf8.encode(
          `tree ${tree}\nauthor Fixture <fixture@example.com> 0 +0000\ncommitter Fixture <fixture@example.com> 0 +0000\n\n${message}\n`,
        );
      const oldCommit = store.write("commit", commitBytes("old"));
      const commit = commitBytes("candidate");
      const commitOid = hashObject("commit", commit);
      store.setRef("refs/heads/main", oldCommit);
      let target = new Uint8Array(8);
      const bytes = pack(6, (writer) => {
        writer.object("commit", commit);
        writer.object("blob", target);
        for (let edge = 1; edge <= 4; edge++) {
          const base = target;
          target = new Uint8Array(8);
          new DataView(target.buffer).setUint32(0, edge);
          writer.refDelta(hashObject("blob", base), literalDelta(base, target));
        }
      });
      const targetOid = hashObject("blob", target);
      nativeIngest(native, bytes);
      expect(new Uint8Array(native.gitBinary("cat-file", "blob", targetOid))).toEqual(target);
      expect(new Uint8Array(native.gitBinary("cat-file", "commit", commitOid))).toEqual(commit);
      store.registerPromisorRemote("origin", "https://example.test/repo.git");
      store.addPromisedBlobs("origin", [targetOid]);
      await expect(
        store.packs.ingest(slices(bytes, 4096), {
          lifecycle: {
            reserved() {},
            published() {
              store.setRef("refs/heads/main", commitOid);
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "ECORRUPT",
        message: expect.stringMatching(/deeper than 3/),
      });
      const cold = new SqliteGitDatabase(db, options).openCheckout(checkout);
      for (const reader of [store, cold]) {
        expect(reader.getRef("refs/heads/main")).toBe(oldCommit);
        expect(reader.getRef("HEAD")).toBe("ref: refs/heads/main");
        expect(reader.read(commitOid)).toBeNull();
        expect(reader.cachedCommit(commitOid)).toBeNull();
        expect(reader.promisedMissing([targetOid])).toEqual([targetOid]);
      }
      expect(await reclaimPending(cold)).toBe(1);
      expect(db.scalar<number>("SELECT count(*) FROM git_pack_commit_staging")).toBe(0);
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });
});

describe("cold delta working-set admission", () => {
  for (const path of ["immediate REF", "deferred REF", "streamed OFS"]) {
    it.each(["logical exact", "logical excess", "chunk exact", "chunk excess"])(
      `${path}: %s`,
      async (boundary) => {
        const db = new TestDatabase();
        const native = new GitFixture().init();
        try {
          const chunkBoundary = boundary.startsWith("chunk");
          const excess = boundary.endsWith("excess");
          const base = new Uint8Array(chunkBoundary ? 65537 : 65536);
          let targetSize = MAX_PACK_DELTA_WORKING_BYTES - (chunkBoundary ? 131072 : base.length);
          if (!chunkBoundary) {
            for (;;) {
              const next =
                MAX_PACK_DELTA_WORKING_BYTES -
                base.length -
                copiedZeros(base.length, targetSize).length;
              if (next === targetSize) break;
              targetSize = next;
            }
          }
          if (excess) targetSize++;
          const delta = copiedZeros(base.length, targetSize);
          const logical = base.length + delta.length + targetSize;
          const rounded =
            Math.ceil(base.length / 65536) * 65536 + Math.ceil(targetSize / 65536) * 65536;
          if (chunkBoundary) {
            expect(logical).toBeLessThan(MAX_PACK_DELTA_WORKING_BYTES);
            expect(rounded).toBe(MAX_PACK_DELTA_WORKING_BYTES + (excess ? 65536 : 0));
          } else {
            expect(logical).toBe(MAX_PACK_DELTA_WORKING_BYTES + Number(excess));
            expect(rounded).toBe(MAX_PACK_DELTA_WORKING_BYTES);
          }
          const baseOid = hashObject("blob", base);
          const bytes =
            path === "streamed OFS"
              ? ofsPack(base, delta)
              : pack(2, (writer) => {
                  if (path === "immediate REF") writer.object("blob", base);
                  writer.refDelta(baseOid, delta);
                  if (path === "deferred REF") writer.object("blob", base);
                });
          nativeIngest(
            native,
            pack(1, (writer) => writer.object("blob", base)),
          );
          nativeIngest(native, bytes);
          const targetOid = hashObject("blob", new Uint8Array(targetSize));
          const expected = native.gitBinary("cat-file", "blob", targetOid);
          expect(expected.length).toBe(targetSize);
          const options = path === "streamed OFS" ? { maxBufferedEntry: 16 } : {};
          const database = new SqliteGitDatabase(db, options);
          const checkout = database.createRepository("/repo", "ref: refs/heads/main");
          const store = database.openCheckout(checkout);
          if (excess) {
            await expect(store.packs.ingest(slices(bytes, 4096))).rejects.toThrow(
              /working set|chunk/,
            );
            expect(
              new SqliteGitDatabase(db, options).openCheckout(checkout).read(targetOid),
            ).toBeNull();
          } else {
            await store.packs.ingest(slices(bytes, 4096));
            const cold = new SqliteGitDatabase(db, options).openCheckout(checkout);
            expect(expected.equals(cold.read(targetOid)?.data ?? new Uint8Array())).toBe(true);
          }
        } finally {
          native.dispose();
          db.storage.db.close();
        }
      },
    );
  }
});
