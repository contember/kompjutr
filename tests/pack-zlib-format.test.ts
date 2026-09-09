import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { concat } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import {
  DeflateStream,
  deflate,
  InflateInto,
  InflateStream,
  inflatePrefix,
} from "../packages/git/src/common/zlib.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

const payload = new Uint8Array(1024).fill(65);
const zlib = deflateSync(payload);
const gzip = gzipSync(payload);
const formats = [
  { name: "zlib", data: zlib, valid: true },
  { name: "zlib-small-window", data: deflateSync(payload, { windowBits: 9 }), valid: true },
  { name: "gzip", data: gzip, valid: false },
  { name: "raw", data: deflateRawSync(payload), valid: false },
  { name: "truncated-zlib", data: zlib.subarray(0, -1), valid: false },
  { name: "truncated-gzip", data: gzip.subarray(0, -1), valid: false },
];

function pack(data: Uint8Array): Uint8Array {
  const body = concat([Buffer.from("5041434b0000000200000001b040", "hex"), data]);
  return concat([body, createHash("sha1").update(body).digest()]);
}

function gzipWithZeroLeadingPackChecksum(): Uint8Array {
  // MTIME 107 makes the outer checksum start with zero, stopping pako's gzip-member retry.
  return Buffer.from("1f8b08006b000000000373741c05a360148c5400001afb37b700040000", "hex");
}

describe("pack zlib wrapper format", () => {
  it.each(formats)("native Git and both current ingest paths: $name", async ({ data, valid }) => {
    const repo = new GitFixture().init();
    const packed = pack(data);
    try {
      const native = () =>
        execFileSync("git", ["index-pack", "--strict", "--stdin"], {
          cwd: repo.dir,
          input: packed,
          stdio: ["pipe", "pipe", "pipe"],
        });
      if (valid) expect(native).not.toThrow();
      else expect(native).toThrow();
      for (const cacheEntryLimit of [64, 2048]) {
        const db = new TestDatabase();
        try {
          const database = new SqliteGitDatabase(db, { cacheEntryLimit });
          const store = database.openCheckout(
            database.createRepository("/repo", "ref: refs/heads/main"),
          ).shared;
          const ingest = store.packs.ingest(slices(packed, 64));
          if (valid) await expect(ingest).resolves.toMatchObject({ count: 1 });
          else {
            await expect(ingest).rejects.toThrow();
            expect(store.read(hashObject("blob", payload))).toBeNull();
          }
        } finally {
          db.storage.db.close();
        }
      }
    } finally {
      repo.dispose();
    }
  });

  it("rejects a native-invalid gzip entry when the valid outer checksum starts with zero", async () => {
    const repo = new GitFixture().init();
    const packed = pack(gzipWithZeroLeadingPackChecksum());
    expect(packed[packed.length - 20]).toBe(0);
    try {
      expect(() =>
        execFileSync("git", ["index-pack", "--strict", "--stdin"], {
          cwd: repo.dir,
          input: packed,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ).toThrow();
      for (const cacheEntryLimit of [64, 2048]) {
        const db = new TestDatabase();
        try {
          const database = new SqliteGitDatabase(db, { cacheEntryLimit });
          const store = database.openCheckout(
            database.createRepository("/repo", "ref: refs/heads/main"),
          ).shared;
          const ingest = store.packs.ingest(slices(packed, 64));
          await expect(ingest).rejects.toThrow();
          expect(store.read(hashObject("blob", payload))).toBeNull();
        } finally {
          db.storage.db.close();
        }
      }
    } finally {
      repo.dispose();
    }
  });

  it("rejects gzip in both production wrappers and native prefix", () => {
    expect(gzip.length).toBe(29);
    expect(() => inflatePrefix(gzip, payload.length)).toThrow();
    const exact = new InflateInto(payload.length);
    expect(() => exact.push(gzip)).toThrow();
    const chunks: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => chunks.push(chunk));
    expect(() => stream.push(gzip)).toThrow();
    expect(chunks).toEqual([]);
  });

  it.each(formats)(
    "both production wrappers match the native format oracle: $name",
    ({ name, data, valid }) => {
      const exact = new InflateInto(payload.length);
      const chunks: Uint8Array[] = [];
      const stream = new InflateStream((chunk) => chunks.push(chunk));
      if (valid) {
        expect(exact.push(data)).toBe(data.length);
        expect(exact.finish()).toEqual(payload);
        expect(stream.push(data)).toBe(data.length);
        expect(stream.ended).toBe(true);
        expect(concat(chunks)).toEqual(payload);
      } else if (name === "truncated-zlib") {
        exact.push(data);
        expect(() => exact.finish()).toThrow();
        stream.push(data);
        expect(stream.ended).toBe(false);
      } else {
        expect(() => exact.push(data)).toThrow();
        expect(() => stream.push(data)).toThrow();
      }
    },
  );

  it.each([0, 1024, 32769])("explicit zlib mode reads both current writers at %i bytes", (size) => {
    const input = new Uint8Array(size).fill(65);
    const chunks: Uint8Array[] = [];
    const writer = new DeflateStream((chunk) => chunks.push(chunk));
    writer.push(input);
    writer.finish();
    for (const encoded of [deflate(input), concat(chunks)]) {
      const exact = new InflateInto(size);
      const output: Uint8Array[] = [];
      const stream = new InflateStream((chunk) => output.push(chunk));
      for (let offset = 0; offset < encoded.length; offset++) {
        const byte = encoded.subarray(offset, offset + 1);
        expect(exact.push(byte)).toBe(1);
        expect(stream.push(byte)).toBe(1);
      }
      expect(exact.finish()).toEqual(input);
      expect(stream.ended).toBe(true);
      expect(concat(output)).toEqual(input);
    }
  });
});
