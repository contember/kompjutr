// Wave A probe from docs/plans/shell.md: the plan's thesis is that a search
// costs `⌈files/page⌉ + ⌈bytes/budget⌉` statements and that a trailing
// `| head -N` stops early instead of walking the tree. Both are asserted
// here before anything is built on them.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem, RealPath, WriteEntry } from "../../src/fs/types.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

interface Fixture {
  fs: Filesystem;
  storage: SqliteTestStorage;
}

function tree(fileCount: number, needleEvery: number): Fixture {
  const storage = new SqliteTestStorage();
  const fs = createFilesystem(new TestDatabase(storage), { now: () => 1_700_000_000_000 });
  const entries: WriteEntry[] = [];
  for (let i = 0; i < fileCount; i++) {
    const hit = i % needleEvery === 0;
    entries.push({
      path: `/repo/src/mod${String(i).padStart(5, "0")}.ts`,
      bytes: ENCODER.encode(`export const a${i} = ${i};\n${hit ? "// NEEDLE\n" : "// plain\n"}`),
    });
    entries.push({
      path: `/repo/other/file${String(i).padStart(5, "0")}.md`,
      bytes: ENCODER.encode(`# doc ${i}\n`),
    });
  }
  fs.writeFiles(entries);
  return { fs, storage };
}

function measure<T>(storage: SqliteTestStorage, fn: () => T): { value: T; statements: number } {
  const before = storage.statementCount;
  const value = fn();
  return { value, statements: storage.statementCount - before };
}

describe("A2 — early stop", () => {
  it("discovers a bounded page in one statement, independent of tree size", () => {
    const small = tree(100, 5);
    const large = tree(2_000, 5);

    const smallRoot = small.fs.realpath("/repo/src");
    const largeRoot = large.fs.realpath("/repo/src");

    const a = measure(small.storage, () =>
      small.fs.discoverFiles(smallRoot, "*.ts", { limit: 32 }),
    );
    const b = measure(large.storage, () =>
      large.fs.discoverFiles(largeRoot, "*.ts", { limit: 32 }),
    );

    expect(a.value.handles).toHaveLength(32);
    expect(b.value.handles).toHaveLength(32);
    expect(a.statements).toBe(1);
    // The claim under test: a 20x bigger tree costs the same.
    expect(b.statements).toBe(a.statements);
  });

  it("finds 20 matches in a 2,000-file tree without reading the tree", () => {
    const { fs, storage } = tree(2_000, 2);
    const root = fs.realpath("/repo/src");

    const run = measure(storage, () => {
      const found: string[] = [];
      let after: RealPath | undefined;
      let pages = 0;
      // Geometric page growth, seeded at 2x the wanted count: a fixed 32
      // costs a second page as soon as fewer than 2 in 3 candidates match.
      for (let limit = 40; found.length < 20 && pages < 20; limit = Math.min(limit * 2, 1_000)) {
        const page = fs.discoverFiles(
          root,
          "*.ts",
          after === undefined ? { limit } : { after, limit },
        );
        pages++;
        if (page.handles.length === 0) break;
        const batch = fs.readFileHandles(page.handles);
        for (const handle of page.handles) {
          const bytes = batch.files.get(handle.path);
          if (bytes !== undefined && DECODER.decode(bytes).includes("NEEDLE")) {
            found.push(handle.path);
            if (found.length === 20) break;
          }
        }
        if (page.next === null) break;
        after = page.next;
      }
      return { found, pages };
    });

    expect(run.value.found).toHaveLength(20);
    expect(run.value.pages).toBe(1);
    // 1 discover + the reads for one 32-handle page. The tree has 2,000
    // .ts files; touching even a tenth of them would blow this.
    expect(run.statements).toBeLessThanOrEqual(5);
  });
});

describe("A1 — full-scan cost shape", () => {
  it("scales with pages and bytes, not with files", () => {
    const small = tree(500, 3);
    const large = tree(5_000, 3);

    const sweep = ({ fs, storage }: Fixture) => {
      const root = fs.realpath("/repo/src");
      return measure(storage, () => {
        let after: RealPath | undefined;
        let files = 0;
        for (;;) {
          const page = fs.discoverFiles(
            root,
            "*.ts",
            after === undefined ? { limit: 1_000 } : { after, limit: 1_000 },
          );
          if (page.handles.length === 0) break;
          let remaining = page.handles;
          while (remaining.length > 0) {
            const batch = fs.readFileHandles(remaining);
            files += batch.files.size;
            remaining = batch.remaining;
          }
          if (page.next === null) break;
          after = page.next;
        }
        return files;
      });
    };

    const a = sweep(small);
    const b = sweep(large);

    expect(a.value).toBe(500);
    expect(b.value).toBe(5_000);

    // The plan's formula: `⌈files/1000⌉` discovery pages plus one read per
    // byte budget. These fixtures are ~30 bytes a file, so the byte term is
    // one read per page and the whole cost is 2 statements per 1,000 files.
    // Per file that is 1/500th of a statement — which is the claim. It is
    // NOT sublinear in files, and asserting that it were would be wrong.
    expect(a.statements).toBe(2);
    expect(b.statements).toBe(10);
    console.log(`A1: 500 files -> ${a.statements} stmts, 5,000 files -> ${b.statements} stmts`);
  });
});
