import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { concat, toHex } from "../src/git/common/bytes.js";
import { sha1 } from "../src/git/common/sha1.js";
import {
  deflate,
  InflateInto,
  InflateStream,
  inflate,
  inflatePrefix,
} from "../src/git/common/zlib.js";

describe("zlib", () => {
  it("round-trips", () => {
    const data = new Uint8Array(randomBytes(10_000));
    expect(inflate(deflate(data))).toEqual(data);
  });

  it("reports the consumed length of a prefix stream", () => {
    const data = new TextEncoder().encode("hello world ".repeat(50));
    const compressed = deflateSync(data);
    const padded = concat([compressed, new Uint8Array(64)]);
    const result = inflatePrefix(padded, data.length);
    expect(result).not.toBeNull();
    expect(result?.consumed).toBe(compressed.length);
    expect(result?.data).toEqual(data);
  });

  it("signals a truncated window instead of throwing", () => {
    const data = new Uint8Array(randomBytes(50_000));
    const compressed = deflateSync(data);
    expect(inflatePrefix(compressed.subarray(0, 100), data.length)).toBeNull();
  });

  it("rejects output above the caller's bound", () => {
    const data = new Uint8Array(randomBytes(50_000));
    const compressed = deflateSync(data);
    expect(() => inflatePrefix(compressed, data.length - 1)).toThrow();
  });

  it("inflates a large prefix into one bounded output allocation", () => {
    const data = new Uint8Array(8 * 1024 * 1024);
    data.fill(97);
    const compressed = deflateSync(data);
    const result = inflatePrefix(compressed, data.length);
    expect(result?.data.length).toBe(data.length);
    expect(toHex(sha1(result?.data ?? new Uint8Array()))).toBe(toHex(sha1(data)));
    expect(result?.data.buffer.byteLength).toBeLessThanOrEqual(data.length + 1);
  });

  it.each([0, 1, 63, 64, 16_384, 16_385, 8 * 1024 * 1024])(
    "inflates %i bytes directly into the final target",
    (size) => {
      const data = new Uint8Array(size);
      data.fill(97);
      const compressed = deflateSync(data);
      const stream = new InflateInto(size);
      let consumed = 0;
      while (!stream.ended && consumed < compressed.length) {
        consumed += stream.push(compressed.subarray(consumed, consumed + 1));
      }
      const result = stream.finish();
      expect(consumed).toBe(compressed.length);
      expect(result.buffer.byteLength).toBe(Math.max(size, 0));
      expect(toHex(sha1(result))).toBe(toHex(sha1(data)));
    },
  );

  it("rejects direct inflate output size mismatches", () => {
    const data = new Uint8Array(100);
    data.fill(97);
    const compressed = deflateSync(data);
    const short = new InflateInto(data.length - 1);
    expect(() => short.push(compressed)).toThrow(/expected size/);
    const long = new InflateInto(data.length + 1);
    long.push(compressed);
    expect(() => long.finish()).toThrow(/expected size/);
  });

  it("streams large input in bounded slices and reports consumption", () => {
    const data = new Uint8Array(randomBytes(3_000_000));
    const compressed = deflateSync(data);
    const padded = concat([compressed, new Uint8Array(1024)]);

    const chunks: Uint8Array[] = [];
    const stream = new InflateStream((chunk) => chunks.push(chunk));
    let offset = 0;
    let consumed = 0;
    while (!stream.ended && offset < padded.length) {
      const slice = padded.subarray(offset, offset + 65_536);
      consumed += stream.push(slice);
      offset += slice.length;
    }
    expect(stream.ended).toBe(true);
    expect(consumed).toBe(compressed.length);
    expect(stream.inflated).toBe(data.length);
    expect(toHex(sha1(concat(chunks)))).toBe(toHex(sha1(data)));
  });
});
