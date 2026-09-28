// `tree` lists one directory per keyset page and `du` scans one subtree per
// page, so neither pays per file. Asserted at two tree sizes an order of
// magnitude apart: an operation count that stays flat while files grow tenfold
// is the property, and retained bytes stay at the page bound.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { WriteEntry } from "../../packages/do/src/fs/types.js";
import { createShell, type RunResult, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const DIRECTORIES = 10;
const RETAINED_CEILING = 256 * 1024;

function project(filesPerDirectory: number): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  const entries: WriteEntry[] = [];
  for (let directory = 0; directory < DIRECTORIES; directory++) {
    for (let index = 0; index < filesPerDirectory; index++) {
      entries.push({
        path: `/repo/src/d${directory}/file${String(index).padStart(4, "0")}.ts`,
        bytes: ENCODER.encode(`export const v = ${index};\n`),
      });
    }
  }
  fs.writeFiles(entries);
  return createShell({ fs, cwd: "/repo" });
}

async function run(shell: Shell, source: string): Promise<RunResult> {
  const result = await shell.run(source);
  expect(result.exitCode, source).toBe(0);
  return result;
}

describe("tree and du cost pages, not files", () => {
  it("walks 500 files in a few operations with bounded retained bytes", async () => {
    const shell = project(50);

    const tree = await run(shell, "tree");
    expect(tree.stdout.endsWith("\n12 directories, 500 files\n")).toBe(true);
    // One stat, then one listing page per directory: ., src, and ten below.
    expect(tree.operations).toBe(13);
    expect(tree.peakRetainedBytes).toBeLessThan(RETAINED_CEILING);

    const du = await run(shell, "du -s");
    const bytes =
      DIRECTORIES *
      Array.from({ length: 50 }, (_, index) => `${index}`.length + 19).reduce(
        (sum, size) => sum + size,
        0,
      );
    expect(du.stdout).toBe(`${Math.ceil(bytes / 1024)}\t.\n`);
    // One lstat and one scan page.
    expect(du.operations).toBe(2);
    expect(du.peakRetainedBytes).toBeLessThan(RETAINED_CEILING);
  });

  it("stays flat when the tree grows tenfold", async () => {
    const small = project(50);
    const large = project(500);
    for (const source of ["tree", "du -s", "du -a"]) {
      const smallRun = await run(small, source);
      const largeRun = await run(large, source);
      expect(largeRun.operations, source).toBeLessThanOrEqual(smallRun.operations + 10);
      expect(largeRun.peakRetainedBytes, source).toBeLessThan(RETAINED_CEILING);
    }
  });

  it("stops listing when head stops reading", async () => {
    const shell = project(50);
    const full = await run(shell, "tree");
    const head = await run(shell, "tree | head -3");
    expect(head.stdout).toBe(".\n`-- src\n    |-- d0\n");
    expect(head.operations).toBeLessThan(full.operations);
    expect(head.operations).toBeLessThanOrEqual(4);
  });
});
