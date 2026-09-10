import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { concat } from "../packages/git/src/common/bytes.js";
import { ByteLru } from "../packages/git/src/common/lru.js";
import { hashObject, type RawObject } from "../packages/git/src/common/objects.js";
import * as zlib from "../packages/git/src/common/zlib.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackDataReader } from "../packages/git/src/store/pack/read/read-data.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

afterEach(() => vi.restoreAllMocks());

function reader(db: TestDatabase) {
  return new PackDataReader(
    db,
    1,
    new ByteLru<string, RawObject>(8388608, (o) => o.data.length),
    new ByteLru<string, Uint8Array>(4194304, (b) => b.length),
    "test",
    { cacheGeneration: 0, activePending: new Set() },
    2097152,
  );
}

function decode(read: PackDataReader, bytes: Uint8Array, size: number): Uint8Array {
  return read.inflateCompressed(
    {
      oid: "0".repeat(40),
      packId: 1,
      offset: 12,
      dataOff: 14,
      dataLen: bytes.length,
      type: "blob",
      size,
      entrySize: size,
      baseOid: null,
    },
    bytes,
    false,
    false,
  );
}

function pack(size: number, compressed: Uint8Array): Uint8Array {
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

const payload = new Uint8Array(1024).fill(65);
const compressed = deflateSync(payload);
const badAdler = new Uint8Array(compressed);
badAdler[badAdler.length - 1] = badAdler[badAdler.length - 1]! ^ 1;
const cases = [
  { name: "Adler", bytes: badAdler, size: 1024 },
  { name: "gzip", bytes: gzipSync(payload), size: 1024 },
  { name: "raw deflate", bytes: deflateRawSync(payload), size: 1024 },
  { name: "truncation", bytes: compressed.subarray(0, -1), size: 1024 },
  { name: "output exceeds declaration", bytes: compressed, size: 1023 },
  { name: "output below declaration", bytes: compressed, size: 1025 },
  { name: "one byte declared zero", bytes: deflateSync(new Uint8Array([65])), size: 0 },
  { name: "trailing byte", bytes: concat([compressed, new Uint8Array([0])]), size: 1024 },
  { name: "second stream", bytes: concat([compressed, compressed]), size: 1024 },
];

describe("complete-input pack inflation", () => {
  it.each(cases)(
    "rejects native-invalid $name with a valid outer checksum",
    ({ name, bytes, size }) => {
      const repo = new GitFixture().init();
      const db = new TestDatabase();
      try {
        expect(() =>
          execFileSync("git", ["index-pack", "--strict", "--stdin"], {
            cwd: repo.dir,
            input: pack(size, bytes),
            stdio: ["pipe", "pipe", "pipe"],
          }),
        ).toThrow();
        expect(() => decode(reader(db), bytes, size)).toThrow(
          expect.objectContaining({ code: "ECORRUPT" }),
        );
        if (name === "output exceeds declaration") {
          expect(() => decode(reader(db), bytes, size)).toThrow(
            expect.objectContaining({
              code: "ECORRUPT",
              message: "pack entry at 12 exceeds its indexed size",
              cause: expect.objectContaining({ code: "ERR_BUFFER_TOO_LARGE" }),
            }),
          );
        } else if (name === "one byte declared zero") {
          expect(() => decode(reader(db), bytes, size)).toThrow(/exceeds its indexed size/);
        } else if (name === "Adler") {
          expect(() => decode(reader(db), bytes, size)).toThrow(
            expect.objectContaining({
              code: "ECORRUPT",
              message: "pack entry at 12 is not a valid zlib stream",
              cause: expect.objectContaining({ code: "Z_DATA_ERROR" }),
            }),
          );
        }
      } finally {
        db.storage.db.close();
        repo.dispose();
      }
    },
  );

  it.each([0, 1, 1024, 32769])("returns independent native output for %i bytes", (size) => {
    const db = new TestDatabase();
    try {
      const input = new Uint8Array(size).fill(65);
      const encoded = deflateSync(input);
      const read = reader(db);
      const native = vi.spyOn(zlib, "inflatePrefix");
      const exact = vi.spyOn(zlib.InflateInto.prototype, "push");
      const result = decode(read, encoded, size);
      expect(native).toHaveBeenCalledTimes(1);
      expect(exact).not.toHaveBeenCalled();
      expect(result.buffer).not.toBe(encoded.buffer);
      encoded.fill(0xff);
      for (let i = 0; i < 32; i++) {
        const other = new Uint8Array(size).fill(i);
        decode(read, deflateSync(other), size).fill(0xee);
      }
      expect(result).toEqual(input);
    } finally {
      db.storage.db.close();
    }
  });

  it("cold-reads native-valid full and delta objects through the native complete-input path", async () => {
    const repo = new GitFixture().init();
    const db = new TestDatabase();
    try {
      const base = new Uint8Array([66]);
      const target = new Uint8Array(1024).fill(65);
      const delta: Uint8Array[] = [encodeDeltaHeader(base.length, target.length)];
      for (let offset = 0; offset < target.length; offset += 127) {
        const part = target.subarray(offset, offset + 127);
        delta.push(new Uint8Array([part.length]), part);
      }
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(2);
      writer.object("blob", base);
      writer.refDelta(hashObject("blob", base), concat(delta));
      writer.finish();
      const packed = concat(chunks);
      execFileSync("git", ["index-pack", "--strict", "--stdin"], {
        cwd: repo.dir,
        input: packed,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const database = new SqliteGitDatabase(db);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      await database.openCheckout(checkout).shared.packs.ingest(slices(packed, 64));
      const native = vi.spyOn(zlib, "inflatePrefix");
      const exact = vi.spyOn(zlib.InflateInto.prototype, "push");
      const cold = new SqliteGitDatabase(db).openCheckout(checkout).shared;
      for (const data of [target, base]) {
        const oid = hashObject("blob", data);
        expect(cold.read(oid)?.data).toEqual(repo.catFile(oid));
      }
      expect(native).toHaveBeenCalledTimes(2);
      expect(exact).not.toHaveBeenCalled();
    } finally {
      db.storage.db.close();
      repo.dispose();
    }
  });
});
