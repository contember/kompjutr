import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { toHex } from "../packages/git/src/common/bytes.js";
import { Sha1, sha1 } from "../packages/git/src/common/sha1.js";

function reference(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

describe("Sha1", () => {
  it("matches node:crypto for known vectors", () => {
    expect(toHex(sha1(new Uint8Array(0)))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(toHex(sha1(new TextEncoder().encode("abc")))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("matches node:crypto across sizes straddling the block boundary", () => {
    for (const size of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 65_536]) {
      const data = new Uint8Array(randomBytes(size));
      expect(toHex(sha1(data))).toBe(reference(data));
    }
  });

  it("is chunk-boundary independent", () => {
    const data = new Uint8Array(randomBytes(100_000));
    for (const chunk of [1, 7, 64, 63, 4096]) {
      const h = new Sha1();
      for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, i + chunk));
      expect(toHex(h.digest())).toBe(reference(data));
    }
  });

  it("hashes inputs longer than 512 MB of bits without wrapping the length", () => {
    // 2^29 bytes = 2^32 bits: the point where a 32-bit bit counter wraps.
    const h = new Sha1();
    const reference512 = createHash("sha1");
    const block = new Uint8Array(1 << 20);
    block.fill(0x61);
    for (let i = 0; i < 513; i++) {
      h.update(block);
      reference512.update(block);
    }
    expect(toHex(h.digest())).toBe(reference512.digest("hex"));
  });
});
