import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { concat } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import * as zlib from "../packages/git/src/common/zlib.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackReader } from "../packages/git/src/store/pack/ingest/ingest-reader.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

afterEach(() => vi.restoreAllMocks());

function fullPack(size: number, compressed: Uint8Array): Uint8Array {
  const header = [0x30 | (size & 15)];
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    header[header.length - 1] = header[header.length - 1]! | 128;
    header.push(rest & 127);
    rest = Math.floor(rest / 128);
  }
  const body = concat([
    Buffer.from("5041434b0000000200000001", "hex"),
    new Uint8Array(header),
    compressed,
  ]);
  return concat([body, createHash("sha1").update(body).digest()]);
}

function nativeIndex(repo: GitFixture, pack: Uint8Array): void {
  execFileSync("git", ["index-pack", "--strict", "--stdin"], {
    cwd: repo.dir,
    input: pack,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

function open(db: TestDatabase, cacheEntryLimit = 2 * 1024 * 1024) {
  const database = new SqliteGitDatabase(db, { cacheEntryLimit });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  return {
    store: database.openCheckout(checkout).shared,
    cold: () => new SqliteGitDatabase(db).openCheckout(checkout).shared,
  };
}

describe("pack prefix selection", () => {
  it.each(["compressible", "cross-row", "zero"])(
    "indexes native-valid %s input using the selected decoder",
    async (kind) => {
      const data =
        kind === "zero"
          ? new Uint8Array(0)
          : kind === "cross-row"
            ? randomBytes(1024 * 1024 + 1)
            : new Uint8Array(4096).fill(65);
      const compressed = deflateSync(data);
      const pack = fullPack(data.length, compressed);
      const repo = new GitFixture().init();
      const db = new TestDatabase();
      try {
        nativeIndex(repo, pack);
        if (kind === "compressible")
          expect(zlib.inflatePrefix(compressed, data.length)?.data).toEqual(data);
        if (kind === "cross-row")
          expect(
            zlib.inflatePrefix(compressed.subarray(0, 1024 * 1024 - 16), data.length),
          ).toBeNull();
        const prefix = vi.spyOn(zlib, "inflatePrefix");
        const exact = vi.spyOn(zlib.InflateInto.prototype, "push");
        const { store, cold } = open(db);
        await store.packs.ingest(slices(pack, 65536));
        if (kind === "zero") expect(prefix).toHaveBeenCalledTimes(1);
        else {
          expect(prefix).not.toHaveBeenCalled();
          expect(exact).toHaveBeenCalled();
        }
        const oid = hashObject("blob", data);
        const native = new Uint8Array(
          execFileSync("git", ["cat-file", "blob", oid], {
            cwd: repo.dir,
            maxBuffer: 8 * 1024 * 1024,
          }),
        );
        expect(cold().read(oid)?.data).toEqual(native);
      } finally {
        db.storage.db.close();
        repo.dispose();
      }
    },
  );

  it("redirects compressible delta instructions while preserving native target bytes", async () => {
    const base = new Uint8Array([66]);
    const target = new Uint8Array(4096).fill(65);
    const instructions: Uint8Array[] = [encodeDeltaHeader(base.length, target.length)];
    for (let offset = 0; offset < target.length; offset += 127) {
      const part = target.subarray(offset, offset + 127);
      instructions.push(new Uint8Array([part.length]), part);
    }
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", base);
    writer.refDelta(hashObject("blob", base), concat(instructions));
    writer.finish();
    const pack = concat(chunks);
    const repo = new GitFixture().init();
    const db = new TestDatabase();
    try {
      nativeIndex(repo, pack);
      const prefix = vi.spyOn(zlib, "inflatePrefix");
      const exact = vi.spyOn(zlib.InflateInto.prototype, "push");
      const { store, cold } = open(db);
      await store.packs.ingest(slices(pack, 64));
      expect(prefix).toHaveBeenCalledTimes(1);
      expect(exact).toHaveBeenCalled();
      const oid = hashObject("blob", target);
      expect(cold().read(oid)?.data).toEqual(repo.catFile(oid));
    } finally {
      db.storage.db.close();
      repo.dispose();
    }
  });

  it.each([64, 2 * 1024 * 1024])(
    "classifies malformed Adler as ECORRUPT with cache limit %i",
    async (limit) => {
      const data = limit === 64 ? new Uint8Array(1024).fill(65) : randomBytes(1024 * 1024 + 1);
      const compressed = deflateSync(data);
      compressed[compressed.length - 1] = compressed[compressed.length - 1]! ^ 1;
      const pack = fullPack(data.length, compressed);
      const repo = new GitFixture().init();
      const db = new TestDatabase();
      try {
        expect(() => nativeIndex(repo, pack)).toThrow();
        const { store, cold } = open(db, limit);
        await expect(store.packs.ingest(slices(pack, 65536))).rejects.toMatchObject({
          code: "ECORRUPT",
          cause: expect.any(Error),
        });
        expect(cold().read(hashObject("blob", data))).toBeNull();
        expect(
          db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'"),
        ).toBe(0);
      } finally {
        db.storage.db.close();
        repo.dispose();
      }
    },
  );

  it("preserves reader errors outside decoder error classification", async () => {
    const db = new TestDatabase();
    try {
      const failure = new Error("reader failure");
      vi.spyOn(PackReader.prototype, "window").mockImplementation(() => {
        throw failure;
      });
      const { store } = open(db);
      await expect(
        store.packs.ingest(slices(fullPack(0, deflateSync(new Uint8Array(0))), 64)),
      ).rejects.toBe(failure);
    } finally {
      db.storage.db.close();
    }
  });
});
