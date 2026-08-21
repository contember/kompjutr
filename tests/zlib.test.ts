import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { concat, toHex } from "../src/core/bytes.js";
import { sha1 } from "../src/core/sha1.js";
import { deflate, InflateStream, inflate, inflatePrefix } from "../src/core/zlib.js";

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
