// `awk` record splitting across read boundaries, against mawk. The shell reads
// files in `readBudget`-sized chunks; a tiny budget puts a chunk boundary
// inside records, separators, and runs of blank lines, and the records must
// come out exactly as mawk splits the whole file.

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const MAWK = spawnSync("mawk", ["-W", "version"], { env: { LC_ALL: "C" } }).status === 0;

/** Deterministic text with irregular record lengths and separator runs. */
function corpus(): string {
  let seed = 7;
  const next = (limit: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % limit;
  };
  let text = "\n".repeat(next(3));
  for (let record = 0; record < 3000; record++) {
    const words = 1 + next(6);
    const line = Array.from({ length: words }, () => "w".repeat(1 + next(9)) + next(100)).join(
      next(4) === 0 ? "," : " ",
    );
    text += line;
    text += next(5) === 0 ? "\n".repeat(2 + next(3)) : next(7) === 0 ? ";;" : "\n";
  }
  return text;
}

describe.skipIf(!MAWK)("awk splits records across chunk boundaries as mawk does", () => {
  const text = corpus();

  it.each([
    '{ print NR ":" NF ":" $0 }',
    'BEGIN { RS = "" } { print NR ":" NF ":" $0 "|" }',
    'BEGIN { RS = ";;" } { print NR "[" $0 "]" }',
    'BEGIN { RS = "\\n+" } { print NR "[" $0 "]" }',
    'BEGIN { RS = "[,;]" } { n++ } END { print n, $0 }',
    'BEGIN { FS = "," } { s += NF } END { print s, NR }',
  ])("%j", async (program) => {
    const mawk = spawnSync("mawk", [program], { input: text, env: { LC_ALL: "C" } });
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles([
      { path: "/repo", mode: 0o755 },
      { path: "/repo/in.txt", bytes: new TextEncoder().encode(text), mode: 0o644 },
    ]);
    const shell = createShell({
      fs,
      cwd: "/repo",
      limits: {
        maxOutputBytes: 10_000_000,
        maxOperations: 10_000,
        readBudget: 1024,
        maxRetainedBytes: 16 * 1024 * 1024,
      },
    });
    const quoted = program.replace(/'/g, "'\\''");
    const ours = await shell.exec(`awk '${quoted}' in.txt`);
    expect(new TextDecoder().decode(ours.stdout)).toBe(mawk.stdout.toString("latin1"));
    expect(ours.exitCode).toBe(mawk.status);
  });
});
