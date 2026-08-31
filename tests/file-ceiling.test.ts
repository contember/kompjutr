// ADR-0019: source files stay at or under 2,000 lines; split along a seam first.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CEILING = 2_000;
const ROOT = join(import.meta.dirname, "..", "src");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

describe("source file ceiling", () => {
  it("keeps every src/ file at or under 2,000 lines", () => {
    const over: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines > CEILING) over.push(`${file}: ${lines}`);
    }
    expect(over).toEqual([]);
  });
});
