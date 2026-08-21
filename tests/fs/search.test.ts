// `discoverFilesContaining` — the content predicate. The property under test
// is not speed: it is that the answer is the same one a read-and-match pass
// would give, including for the case SQL cannot decide.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import { CHUNK_SIZE } from "../../src/fs/schema.js";
import type { Filesystem, RealPath } from "../../src/fs/types.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const ENCODER = new TextEncoder();

function open(): { fs: Filesystem; storage: SqliteTestStorage } {
  const storage = new SqliteTestStorage();
  const fs = createFilesystem(new TestDatabase(storage), { now: () => 1_700_000_000_000 });
  return { fs, storage };
}

function paths(handles: ReadonlyArray<{ path: RealPath }>): string[] {
  return handles.map((handle) => handle.path);
}

describe("the content predicate", () => {
  it("returns only the files that contain the needle", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/repo/a.ts", bytes: ENCODER.encode("const x = 1;\n// NEEDLE\n") },
      { path: "/repo/b.ts", bytes: ENCODER.encode("const y = 2;\n") },
      { path: "/repo/c.ts", bytes: ENCODER.encode("NEEDLE at the front\n") },
    ]);
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.ts", ENCODER.encode("NEEDLE"));
    expect(paths(page.matched)).toEqual(["/repo/a.ts", "/repo/c.ts"]);
    expect(page.undecided).toEqual([]);
    expect(page.next).toBeNull();
  });

  it("costs one statement whatever the tree holds", () => {
    const { fs, storage } = open();
    fs.writeFiles(
      Array.from({ length: 2_000 }, (_, index) => ({
        path: `/repo/f${String(index).padStart(5, "0")}.ts`,
        bytes: ENCODER.encode(`const v${index} = ${index};\n${index % 10 === 0 ? "NEEDLE\n" : ""}`),
      })),
    );
    const root = fs.realpath("/repo");
    const before = storage.statementCount;
    const page = fs.discoverFilesContaining(root, "*.ts", ENCODER.encode("NEEDLE"));
    expect(storage.statementCount - before).toBe(1);
    expect(page.matched).toHaveLength(200);
  });

  it("matches bytes, not text", () => {
    const { fs } = open();
    // A needle that is not valid UTF-8 on its own still has to be findable.
    const needle = new Uint8Array([0xff, 0x00, 0xfe]);
    const body = new Uint8Array([1, 2, 0xff, 0x00, 0xfe, 3]);
    fs.writeFiles([
      { path: "/repo/bin.dat", bytes: body },
      { path: "/repo/other.dat", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.dat", needle);
    expect(paths(page.matched)).toEqual(["/repo/bin.dat"]);
  });

  it("does not confuse a path match with a content match", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/repo/NEEDLE.ts", bytes: ENCODER.encode("nothing here\n") }]);
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.ts", ENCODER.encode("NEEDLE"));
    expect(page.matched).toEqual([]);
    expect(page.undecided).toEqual([]);
  });
});

describe("excluding binary files", () => {
  it("drops a file holding a NUL byte", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/repo/text.ts", bytes: ENCODER.encode("NEEDLE\n") },
      { path: "/repo/bin.ts", bytes: new Uint8Array([78, 69, 69, 68, 76, 69, 0, 9]) },
    ]);
    const root = fs.realpath("/repo");
    const needle = ENCODER.encode("NEEDLE");

    const all = fs.discoverFilesContaining(root, "*.ts", needle);
    expect(paths(all.matched)).toEqual(["/repo/bin.ts", "/repo/text.ts"]);

    const text = fs.discoverFilesContaining(root, "*.ts", needle, { excludeBinary: true });
    expect(paths(text.matched)).toEqual(["/repo/text.ts"]);
  });

  it("still costs one statement", () => {
    const { fs, storage } = open();
    fs.writeFiles(
      Array.from({ length: 500 }, (_, index) => ({
        path: `/repo/f${String(index).padStart(4, "0")}.ts`,
        bytes: ENCODER.encode(`NEEDLE ${index}\n`),
      })),
    );
    const root = fs.realpath("/repo");
    const before = storage.statementCount;
    fs.discoverFilesContaining(root, "*.ts", ENCODER.encode("NEEDLE"), { excludeBinary: true });
    expect(storage.statementCount - before).toBe(1);
  });

  it("leaves a multi-chunk file undecided rather than guessing", () => {
    // The NUL could be in any chunk, and so could the needle. Reading is
    // the caller's job either way.
    const { fs } = open();
    const body = new Uint8Array(CHUNK_SIZE + 16);
    body.set(ENCODER.encode("NEEDLE"), 0);
    fs.writeFiles([{ path: "/repo/big.ts", bytes: body }]);
    const page = fs.discoverFilesContaining(
      fs.realpath("/repo"),
      "*.ts",
      ENCODER.encode("NEEDLE"),
      { excludeBinary: true },
    );
    expect(paths(page.undecided)).toEqual(["/repo/big.ts"]);
  });
});

describe("the case SQL cannot decide", () => {
  it("reports a multi-chunk file as undecided rather than dropping it", () => {
    const { fs } = open();
    // The needle straddles the boundary: neither chunk contains it whole, so
    // `instr` per chunk would answer "no" and be wrong.
    const head = "a".repeat(CHUNK_SIZE - 3);
    fs.writeFiles([
      { path: "/repo/big.ts", bytes: ENCODER.encode(`${head}NEEDLE${"b".repeat(100)}`) },
    ]);
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.ts", ENCODER.encode("NEEDLE"));
    expect(page.matched).toEqual([]);
    expect(paths(page.undecided)).toEqual(["/repo/big.ts"]);

    // And the caller reading it finds the needle, which is the point: the
    // file was handed over instead of silently lost.
    const bytes = fs.readFile("/repo/big.ts");
    expect(new TextDecoder().decode(bytes).includes("NEEDLE")).toBe(true);
  });

  it("reports a multi-chunk file with no match as undecided too", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/repo/big.ts", bytes: ENCODER.encode("z".repeat(CHUNK_SIZE + 10)) }]);
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.ts", ENCODER.encode("NEEDLE"));
    // Conservative on purpose: SQL cannot prove the absence either.
    expect(paths(page.undecided)).toEqual(["/repo/big.ts"]);
  });
});

describe("paging and guards", () => {
  it("pages without repeating or skipping a file", () => {
    const { fs } = open();
    fs.writeFiles(
      Array.from({ length: 25 }, (_, index) => ({
        path: `/repo/f${String(index).padStart(3, "0")}.ts`,
        bytes: ENCODER.encode("NEEDLE\n"),
      })),
    );
    const root = fs.realpath("/repo");
    const seen: string[] = [];
    let after: RealPath | undefined;
    for (;;) {
      const page = fs.discoverFilesContaining(
        root,
        "*.ts",
        ENCODER.encode("NEEDLE"),
        after === undefined ? { limit: 10 } : { after, limit: 10 },
      );
      seen.push(...paths(page.matched), ...paths(page.undecided));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("stays inside the subtree", () => {
    const { fs } = open();
    fs.writeFiles([
      { path: "/repo/in.ts", bytes: ENCODER.encode("NEEDLE\n") },
      { path: "/repo-other/out.ts", bytes: ENCODER.encode("NEEDLE\n") },
      // The sibling trap: '.' and '-' sort below '/'.
      { path: "/repo.bak/out.ts", bytes: ENCODER.encode("NEEDLE\n") },
    ]);
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.ts", ENCODER.encode("NEEDLE"));
    expect(paths(page.matched)).toEqual(["/repo/in.ts"]);
  });

  it("refuses a needle it cannot bound", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/repo/a.ts", bytes: ENCODER.encode("x") }]);
    const root = fs.realpath("/repo");
    expect(() => fs.discoverFilesContaining(root, "*.ts", new Uint8Array(0))).toThrow(
      /must not be empty/,
    );
    expect(() => fs.discoverFilesContaining(root, "*.ts", new Uint8Array(2_000))).toThrow(
      /ceiling/,
    );
  });

  it("ignores directories and symlinks", () => {
    const { fs } = open();
    fs.writeFiles([{ path: "/repo/real.ts", bytes: ENCODER.encode("NEEDLE\n") }]);
    fs.mkdir("/repo/dir.ts");
    fs.symlink("/repo/real.ts", "/repo/link.ts");
    const page = fs.discoverFilesContaining(fs.realpath("/repo"), "*.ts", ENCODER.encode("NEEDLE"));
    expect(paths(page.matched)).toEqual(["/repo/real.ts"]);
  });
});
