import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/git/common/bytes.js";
import { hashObject } from "../src/git/common/objects.js";
import { ChunkedBytes, ChunkPool, PACK_CHUNK_BYTES } from "../src/git/store/pack/chunks.js";
import {
  applyDelta,
  DeltaApplier,
  type DeltaLimits,
  encodeDeltaHeader,
  MAX_DELTA_WORKING_BYTES,
} from "../src/git/store/pack/delta.js";
import { PackWriter } from "../src/git/store/pack/writer.js";

function literalDelta(baseSize: number, target: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [encodeDeltaHeader(baseSize, target.length)];
  for (let offset = 0; offset < target.length; offset += 127) {
    const literal = target.subarray(offset, offset + 127);
    parts.push(new Uint8Array([literal.length]), literal);
  }
  return concat(parts);
}

function applyChunked(
  base: ChunkedBytes,
  pool: ChunkPool,
  delta: Uint8Array,
  parts: readonly Uint8Array[] = [delta],
  limits?: DeltaLimits,
): ChunkedBytes {
  const applier = new DeltaApplier(base, pool, limits);
  try {
    for (const part of parts) applier.push(part);
    return applier.finish();
  } catch (error) {
    applier.abort();
    throw error;
  }
}

function streamedBytes(
  base: Uint8Array,
  delta: Uint8Array,
  parts: readonly Uint8Array[],
): Uint8Array {
  const pool = new ChunkPool();
  const chunkedBase = ChunkedBytes.fromBytes(base, pool);
  let target: ChunkedBytes | null = null;
  try {
    target = applyChunked(chunkedBase, pool, delta, parts);
    return target.toUint8Array();
  } finally {
    target?.release();
    chunkedBase.release();
    expect(pool.checkedOutBytes).toBe(0);
  }
}

function patterned(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  return bytes;
}

describe("streaming git deltas", () => {
  it("preflights pool capacity and drops free chunk references on dispose", () => {
    const pool = new ChunkPool(PACK_CHUNK_BYTES);
    const bytes = ChunkedBytes.fromBytes(patterned(PACK_CHUNK_BYTES), pool);
    expect(() => ChunkedBytes.allocate(PACK_CHUNK_BYTES + 1, pool)).toThrow(/allocation limit/);
    expect(pool.allocatedBytes).toBe(PACK_CHUNK_BYTES);
    expect(pool.checkedOutBytes).toBe(PACK_CHUNK_BYTES);
    expect(() => pool.assertIdle()).toThrow(/owned chunks/);
    bytes.release();
    pool.assertIdle();
    pool.dispose();
    expect(pool.allocatedBytes).toBe(0);
  });

  it("exposes bounded chunks and random bytes without materializing", () => {
    const pool = new ChunkPool();
    const expected = patterned(PACK_CHUNK_BYTES + 7);
    const bytes = ChunkedBytes.fromBytes(expected, pool);
    expect(bytes.byteAt(PACK_CHUNK_BYTES + 3)).toBe(expected[PACK_CHUNK_BYTES + 3]);
    expect(concat([...bytes.chunks()])).toEqual(expected);
    bytes.release();
    pool.assertIdle();
  });

  it("parses headers, copy parameters and literals across every byte split", () => {
    const base = patterned(1000);
    const literal = patterned(127);
    const offset = 257;
    const copySize = 300;
    const target = concat([base.subarray(offset, offset + copySize), literal]);
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([
        0x80 | 0x01 | 0x02 | 0x10 | 0x20 | 0x40,
        offset & 0xff,
        Math.floor(offset / 0x100) & 0xff,
        copySize & 0xff,
        Math.floor(copySize / 0x100) & 0xff,
        Math.floor(copySize / 0x10000) & 0xff,
        literal.length,
      ]),
      literal,
    ]);

    expect(applyDelta(base, delta)).toEqual(target);
    for (let split = 0; split <= delta.length; split++) {
      expect(streamedBytes(base, delta, [delta.subarray(0, split), delta.subarray(split)])).toEqual(
        target,
      );
    }
    expect(
      streamedBytes(
        base,
        delta,
        [...delta].map((byte) => new Uint8Array([byte])),
      ),
    ).toEqual(target);
  });

  it("matches git copy defaults and literal encoding", () => {
    const base = patterned(PACK_CHUNK_BYTES + 4096);
    const copied = base.subarray(0, PACK_CHUNK_BYTES);
    const suffix = utf8.encode("literal-tail");
    const target = concat([copied, suffix]);
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([0x80, suffix.length]),
      suffix,
    ]);
    expect(applyDelta(base, delta)).toEqual(target);
    expect(streamedBytes(base, delta, [delta])).toEqual(target);
  });

  it("produces the same copy and literal result accepted by real git", () => {
    const base = utf8.encode("base-content\n".repeat(200));
    const suffix = utf8.encode("literal-tail\n");
    const target = concat([base, suffix]);
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([
        0x80 | 0x10 | 0x20,
        base.length & 0xff,
        Math.floor(base.length / 0x100) & 0xff,
        suffix.length,
      ]),
      suffix,
    ]);
    expect(streamedBytes(base, delta, [delta])).toEqual(target);

    const packParts: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => packParts.push(chunk));
    writer.header(2);
    writer.object("blob", base);
    writer.refDelta(hashObject("blob", base), delta);
    writer.finish();

    const directory = mkdtempSync(join(tmpdir(), "kompjutr-delta-"));
    try {
      execFileSync("git", ["init", "--bare", "-q"], { cwd: directory });
      execFileSync("git", ["index-pack", "--stdin", "--fix-thin"], {
        cwd: directory,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
        input: Buffer.from(concat(packParts)),
      });
      const fromGit = execFileSync("git", ["cat-file", "blob", hashObject("blob", target)], {
        cwd: directory,
      });
      expect(new Uint8Array(fromGit)).toEqual(target);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("admits exactly 48 MiB and rejects the next byte before allocating", () => {
    const acceptedPool = new ChunkPool();
    const acceptedBase = ChunkedBytes.allocate(0, acceptedPool);
    const accepted = new DeltaApplier(acceptedBase, acceptedPool);
    accepted.push(encodeDeltaHeader(0, MAX_DELTA_WORKING_BYTES));
    expect(accepted.targetSize).toBe(MAX_DELTA_WORKING_BYTES);
    expect(acceptedPool.allocatedBytes).toBe(MAX_DELTA_WORKING_BYTES);
    accepted.abort();
    acceptedBase.release();
    expect(acceptedPool.checkedOutBytes).toBe(0);

    const rejectedPool = new ChunkPool();
    const rejectedBase = ChunkedBytes.allocate(0, rejectedPool);
    const rejected = new DeltaApplier(rejectedBase, rejectedPool);
    expect(() => rejected.push(encodeDeltaHeader(0, MAX_DELTA_WORKING_BYTES + 1))).toThrow(
      /working set/,
    );
    expect(rejectedPool.allocatedBytes).toBe(0);
    expect(rejectedPool.checkedOutBytes).toBe(0);
    rejectedBase.release();
  });

  it("checks an injected rounded working limit before target allocation", () => {
    const pool = new ChunkPool();
    const base = ChunkedBytes.fromBytes(patterned(64), pool);
    const allocated = pool.allocatedBytes;
    const accepted = applyChunked(base, pool, literalDelta(base.length, patterned(64)), undefined, {
      maxWorkingBytes: 2 * PACK_CHUNK_BYTES,
    });
    accepted.release();
    expect(() => {
      const rejected = new DeltaApplier(base, pool, {
        maxWorkingBytes: 2 * PACK_CHUNK_BYTES,
      });
      rejected.push(encodeDeltaHeader(base.length, PACK_CHUNK_BYTES + 1));
    }).toThrow(/working set/);
    expect(pool.allocatedBytes).toBe(allocated + PACK_CHUNK_BYTES);
    expect(pool.checkedOutBytes).toBe(PACK_CHUNK_BYTES);
    base.release();
  });

  it("checks the indexed target size before allocation", () => {
    const pool = new ChunkPool();
    const base = ChunkedBytes.allocate(0, pool);
    const applier = new DeltaApplier(base, pool, { expectedTargetSize: 2 });
    expect(() => applier.push(encodeDeltaHeader(0, 3))).toThrow(/target size mismatch/);
    expect(pool.allocatedBytes).toBe(0);
    base.release();
    pool.assertIdle();
  });

  it("recycles asymmetric near-limit chain chunks without growth by depth", () => {
    const pool = new ChunkPool();
    let current = ChunkedBytes.fromBytes(patterned(100_000), pool);
    const small = patterned(100);
    const large = patterned(100_000);
    let highWater = 0;

    for (let depth = 0; depth < 20; depth++) {
      const targetBytes = depth % 2 === 0 ? small : large;
      const delta =
        depth % 2 === 0
          ? concat([
              encodeDeltaHeader(current.length, small.length),
              new Uint8Array([0x80 | 0x10, small.length]),
            ])
          : literalDelta(current.length, large);
      const next = applyChunked(current, pool, delta, undefined, {
        maxWorkingBytes: 3 * PACK_CHUNK_BYTES,
      });
      current.release();
      current = next;
      expect(current.toUint8Array()).toEqual(targetBytes);
      expect(pool.checkedOutBytes).toBe(
        Math.ceil(current.length / PACK_CHUNK_BYTES) * PACK_CHUNK_BYTES,
      );
      if (depth === 1) highWater = pool.allocatedBytes;
      if (depth > 1) expect(pool.allocatedBytes).toBe(highWater);
    }
    current.release();
    expect(pool.checkedOutBytes).toBe(0);
  });

  it("bounds delta instructions independently and releases the target", () => {
    const pool = new ChunkPool();
    const base = ChunkedBytes.allocate(0, pool);
    const applier = new DeltaApplier(base, pool, { maxInstructionBytes: 2 });
    applier.push(encodeDeltaHeader(0, 0));
    expect(pool.checkedOutBytes).toBe(0);
    expect(() => applier.push(new Uint8Array([0]))).toThrow(/instruction stream too large/);
    expect(pool.checkedOutBytes).toBe(0);
    base.release();
  });

  it("rejects an overflowing streamed size header", () => {
    const pool = new ChunkPool();
    const base = ChunkedBytes.allocate(0, pool);
    const applier = new DeltaApplier(base, pool);
    expect(() =>
      applier.push(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])),
    ).toThrow(/size is invalid/);
    base.release();
    pool.assertIdle();
  });

  it.each([
    {
      name: "source header",
      base: new Uint8Array(),
      delta: new Uint8Array([0x80]),
      error: /truncated/,
    },
    {
      name: "target header",
      base: new Uint8Array(),
      delta: new Uint8Array([0, 0x80]),
      error: /truncated/,
    },
    {
      name: "copy parameters",
      base: patterned(4),
      delta: concat([encodeDeltaHeader(4, 1), new Uint8Array([0x81])]),
      error: /truncated/,
    },
    {
      name: "literal bytes",
      base: new Uint8Array(),
      delta: concat([encodeDeltaHeader(0, 2), new Uint8Array([2, 1])]),
      error: /literal truncated/,
    },
  ])("rejects truncated $name", ({ base, delta, error }) => {
    expect(() => applyDelta(base, delta)).toThrow(error);
    expect(() => streamedBytes(base, delta, [delta])).toThrow(error);
  });

  it.each([
    {
      name: "source mismatch",
      base: patterned(1),
      delta: encodeDeltaHeader(0, 0),
      error: /base size mismatch/,
    },
    {
      name: "copy range",
      base: patterned(1),
      delta: concat([encodeDeltaHeader(1, 2), new Uint8Array([0x80 | 0x10, 2])]),
      error: /copy out of range/,
    },
    {
      name: "copy overflow",
      base: patterned(2),
      delta: concat([encodeDeltaHeader(2, 1), new Uint8Array([0x80 | 0x10, 2])]),
      error: /copy overflows target/,
    },
    {
      name: "literal overflow",
      base: new Uint8Array(),
      delta: concat([encodeDeltaHeader(0, 1), new Uint8Array([2, 1, 2])]),
      error: /literal overflows target/,
    },
    {
      name: "target mismatch",
      base: new Uint8Array(),
      delta: encodeDeltaHeader(0, 1),
      error: /target size mismatch/,
    },
    {
      name: "opcode zero",
      base: new Uint8Array(),
      delta: concat([encodeDeltaHeader(0, 0), new Uint8Array([0])]),
      error: /opcode 0/,
    },
  ])("rejects $name", ({ base, delta, error }) => {
    expect(() => applyDelta(base, delta)).toThrow(error);
    expect(() => streamedBytes(base, delta, [delta])).toThrow(error);
  });
});
