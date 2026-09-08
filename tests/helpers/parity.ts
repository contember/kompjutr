// Differential fixtures for the two search surfaces.
//
// `grep` and `rg` here are not "grep-like": agents send them the real flags
// and read the real output, so what that output should be is not a thing to
// have an opinion about. These run one corpus through the real binaries and
// through the shell and demand the same bytes back — the discipline
// `tests/helpers/git.ts` already applies to pack layout.
//
// Two dimensions are controlled rather than compared, because neither
// implementation specifies them:
//
//   * `LC_ALL=C`, so the real binaries match bytes the way the shell does.
//   * `--no-ignore` and an empty `RIPGREP_CONFIG_PATH` for rg. Ignore-file
//     handling is the deliberate divergence in docs/archive/plans/shell.md §5.1;
//     switching it off on rg's side makes everything else comparable.
//
// Walk order is the third. `rg --sort path` fixes it, so rg compares
// exactly. GNU grep has no equivalent and walks in readdir order, so its
// recursive cases compare as sets — `agree(parity, { ordered: false })`.
// That the shell's own order is sorted is asserted separately; it is a
// property of the shell, not something inherited from either binary.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "./db.js";
/** Where the corpus lives inside kompjutr. The on-disk root maps onto it. */
export const ROOT = "/repo";
const ENCODER = new TextEncoder();
function probe(binary: string): string {
  const run = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) return "";
  return run.stdout;
}
// Resolved once. `spawnSync` does not go through a shell, so a `grep` alias
// in the developer's profile — ugrep is a common one — cannot substitute
// itself here the way it does at an interactive prompt.
export const REAL_GREP = /^grep \(GNU grep\)/.test(probe("grep"));
export const REAL_RG = /^ripgrep /.test(probe("rg"));
export interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
export interface Parity {
  readonly real: Run;
  readonly ours: Run;
}
export type Corpus = Readonly<Record<string, string | Uint8Array>>;
/** Wrap for the shell's lexer. Everything is a single-quoted word. */
function quote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}
export class ParityFixture {
  /** The on-disk corpus root. Appears in the real binaries' output. */
  readonly dir: string;
  readonly fs: Filesystem;
  readonly shell: Shell;
  constructor(corpus: Corpus) {
    this.dir = mkdtempSync(join(tmpdir(), "kompjutr-parity-"));
    this.fs = createFilesystem(new TestDatabase(), { now: () => 1700000000000 });
    const entries: Array<{
      path: string;
      bytes: Uint8Array;
    }> = [];
    for (const [relative, content] of Object.entries(corpus)) {
      const bytes = typeof content === "string" ? ENCODER.encode(content) : content;
      const onDisk = join(this.dir, relative);
      mkdirSync(dirname(onDisk), { recursive: true });
      writeFileSync(onDisk, bytes);
      entries.push({ path: `${ROOT}/${relative}`, bytes });
    }
    this.fs.writeFiles(entries);
    this.shell = createShell({ fs: this.fs, cwd: ROOT });
  }
  /**
   * The same argv through both implementations. `{root}` stands for the
   * corpus root and is substituted per side, so the two see the same
   * command with the only difference that cannot be avoided.
   */
  async compare(binary: "grep" | "rg", ...argv: readonly string[]): Promise<Parity> {
    return { real: this.#real(binary, argv), ours: await this.#ours(binary, argv) };
  }
  #real(binary: "grep" | "rg", argv: readonly string[]): Run {
    const args = argv.map((argument) => argument.replaceAll("{root}", this.dir));
    const controlled = binary === "rg" ? ["--no-ignore", "--sort", "path"] : [];
    const run = spawnSync(binary, [...controlled, ...args], {
      cwd: this.dir,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", RIPGREP_CONFIG_PATH: "" },
      maxBuffer: 1 << 26,
    });
    return {
      stdout: this.#normalize(run.stdout),
      stderr: this.#normalize(run.stderr),
      exitCode: run.status ?? -1,
    };
  }
  async #ours(binary: "grep" | "rg", argv: readonly string[]): Promise<Run> {
    const source = [binary, ...argv.map((a) => quote(a.replaceAll("{root}", ROOT)))].join(" ");
    const run = await this.shell.run(source);
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
  }
  /** Rewrite the on-disk root to the kompjutr one so paths are comparable. */
  #normalize(text: string): string {
    return text.replaceAll(this.dir, ROOT);
  }
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
export function lines(text: string): string[] {
  return text.split("\n").filter((entry) => entry !== "");
}
/**
 * Both sides produced the same stdout and the same exit status.
 *
 * `ordered: false` compares stdout as a set of lines, for the GNU grep
 * recursive cases whose walk order is readdir's rather than anything either
 * implementation promises.
 */
export function agree(
  parity: Parity,
  options: {
    ordered?: boolean;
  } = {},
): void {
  const ordered = options.ordered ?? true;
  const ours = ordered ? parity.ours.stdout : lines(parity.ours.stdout).sort().join("\n");
  const real = ordered ? parity.real.stdout : lines(parity.real.stdout).sort().join("\n");
  expect(ours).toBe(real);
  expect(parity.ours.exitCode).toBe(parity.real.exitCode);
}
