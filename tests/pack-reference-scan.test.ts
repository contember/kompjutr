import { describe, expect, it } from "vitest";
import { concat, toHex, utf8 } from "../packages/git/src/common/bytes.js";
import { parseTreeStream, typeForMode } from "../packages/git/src/common/objects.js";
import { PackReferenceCollector } from "../packages/git/src/store/pack/ingest/ingest-references.js";
import { TreeReferenceScanner } from "../packages/git/src/store/pack/ingest/ingest-references-scan.js";

interface Reference {
  oid: string;
  type: "tree" | "blob";
}

function oidBytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 20 }, (_, index) => (seed * 37 + index * 11 + 0xa5) & 0xff);
}

function entry(mode: string, name: Uint8Array | string, seed: number): Uint8Array {
  const nameBytes = typeof name === "string" ? utf8.encode(name) : name;
  return concat([utf8.encode(`${mode} `), nameBytes, new Uint8Array([0]), oidBytes(seed)]);
}

function wordsHex(words: Uint32Array): string {
  let hex = "";
  for (const word of words) hex += word.toString(16).padStart(8, "0");
  return hex;
}

function scan(chunks: Iterable<Uint8Array>): Reference[] {
  const references: Reference[] = [];
  const scanner = new TreeReferenceScanner((oid, type) => {
    references.push({ oid: wordsHex(oid), type });
  });
  for (const chunk of chunks) scanner.push(chunk);
  scanner.finish();
  return references;
}

/** What the collector read through `TreeParser` before the scanner replaced it. */
function parsed(chunks: Iterable<Uint8Array>): Reference[] {
  const references: Reference[] = [];
  for (const { entry } of parseTreeStream(chunks)) {
    const type = typeForMode(entry.mode);
    if (type !== "commit") references.push({ oid: entry.oid, type });
  }
  return references;
}

function failure(run: () => unknown): { code: unknown; message: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected a failure");
}

const TREE = concat([
  entry("100644", "file", 1),
  entry("100755", "run.sh", 2),
  entry("120000", "link", 3),
  entry("160000", "module", 4),
  entry("40000", "dir", 5),
  entry("040000", "padded", 6),
  entry("100644", "x", 7),
]);

describe("tree reference scanner", () => {
  it("reports every non-gitlink entry with its raw OID and the type its mode implies", () => {
    expect(scan([TREE])).toEqual([
      { oid: toHex(oidBytes(1)), type: "blob" },
      { oid: toHex(oidBytes(2)), type: "blob" },
      { oid: toHex(oidBytes(3)), type: "blob" },
      { oid: toHex(oidBytes(5)), type: "tree" },
      { oid: toHex(oidBytes(6)), type: "tree" },
      { oid: toHex(oidBytes(7)), type: "blob" },
    ]);
    expect(scan([TREE])).toEqual(parsed([TREE]));
  });

  it("classifies unusual modes the way TreeParser does", () => {
    const tree = concat([
      entry("4000", "short", 1),
      entry("400000", "wide", 2),
      entry("16000", "short-link", 3),
      entry("", "no-mode", 4),
      concat([new Uint8Array([0]), entry("40000", "nul-mode", 5)]),
      entry("644", "", 6),
    ]);
    expect(scan([tree])).toEqual(parsed([tree]));
    expect(scan([tree]).map((reference) => reference.type)).toEqual(Array(6).fill("blob"));
  });

  it("gives the same references for a split at every byte offset", () => {
    const whole = scan([TREE]);
    for (let split = 0; split <= TREE.length; split++) {
      expect(scan([TREE.subarray(0, split), TREE.subarray(split)])).toEqual(whole);
    }
    const bytes = Array.from(TREE, (byte) => new Uint8Array([byte]));
    expect(scan(bytes)).toEqual(whole);
    expect(scan([new Uint8Array(0), TREE, new Uint8Array(0)])).toEqual(whole);
  });

  it("accepts an empty tree", () => {
    expect(scan([])).toEqual([]);
    expect(scan([new Uint8Array(0)])).toEqual([]);
  });

  it("accepts a non-UTF-8 name, which only a projection refuses", () => {
    const tree = entry("100644", new Uint8Array([0x80, 0xff]), 1);
    expect(scan([tree])).toEqual([{ oid: toHex(oidBytes(1)), type: "blob" }]);
    expect(failure(() => parsed([tree])).code).toBe("EUNSUPPORTED");
  });

  const valid = entry("100644", "file", 1);
  const malformed: [string, Uint8Array][] = [
    ["a mode without a space", utf8.encode("100644")],
    ["an entry ending after the space", utf8.encode("100644 ")],
    ["a name without NUL", utf8.encode("100644 file")],
    ["an entry ending after the NUL", utf8.encode("100644 file\0")],
    ["a truncated OID", valid.subarray(0, valid.length - 1)],
    ["trailing junk", concat([valid, utf8.encode("junk")])],
    ["an oversized mode", entry("1000644", "file", 1)],
    ["an oversized mode after a valid entry", concat([valid, entry("0100644", "f", 2)])],
  ];

  for (const [label, tree] of malformed) {
    it(`fails on ${label} as TreeParser does`, () => {
      const expected = failure(() => parsed([tree]));
      expect(expected.code).toBe("ECORRUPT");
      expect(failure(() => scan([tree]))).toEqual(expected);
      for (let split = 0; split <= tree.length; split++) {
        expect(failure(() => scan([tree.subarray(0, split), tree.subarray(split)]))).toEqual(
          expected,
        );
      }
    });
  }
});

describe("pack reference collector trees", () => {
  it("records streamed tree entries and starts each tree fresh after a failure", () => {
    const collector = new PackReferenceCollector(16, new Set());
    expect(() => collector.addTree([utf8.encode("100644 half")])).toThrow(/malformed tree entry/);
    collector.addTree([TREE.subarray(0, 13), TREE.subarray(13)]);
    collector.addObject(toHex(oidBytes(5)), "tree");
    expect(
      [...collector.unresolved()].sort((left, right) => (left.oid < right.oid ? -1 : 1)),
    ).toEqual(
      [1, 2, 3, 6, 7]
        .map((seed) => ({
          oid: toHex(oidBytes(seed)),
          expected: [seed === 6 ? "tree" : "blob"],
        }))
        .sort((left, right) => (left.oid < right.oid ? -1 : 1)),
    );
    collector.requireTypes();
    collector.addObject(toHex(oidBytes(6)), "blob");
    expect(() => collector.requireTypes()).toThrow(/to be a tree/);
  });
});
