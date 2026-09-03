// ADR-0019: source files stay small and cohesive families stay grouped.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CEILING = 500;
const DIRECTORY_FILE_CEILING = 20;
const ROOT = join(import.meta.dirname, "..", "src");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

function* sourceDirectories(dir: string): Generator<string> {
  yield dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* sourceDirectories(join(dir, entry.name));
  }
}

describe("source structure ceilings", () => {
  it("keeps every src/ file under 500 lines", () => {
    const over: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines >= CEILING) over.push(`${file}: ${lines}`);
    }
    expect(over).toEqual([]);
  });

  it("keeps at most 20 direct TypeScript files in every src/ directory", () => {
    const over: string[] = [];
    for (const directory of sourceDirectories(ROOT)) {
      const files = readdirSync(directory, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts"),
      ).length;
      if (files > DIRECTORY_FILE_CEILING) over.push(`${directory}: ${files}`);
    }
    expect(over).toEqual([]);
  });
});
