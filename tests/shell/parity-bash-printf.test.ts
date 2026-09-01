// Bash parity covers admitted printf forms. Unsupported forms are pinned locally.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  agreeWithBashInvalidPrintfFormat,
  compareWithBash,
  REAL_BASH,
} from "../helpers/shell-parity.js";

describe.skipIf(!REAL_BASH)("printf matches Bash", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source));
  }

  it("formats strings, literal percent signs, and signed decimals", async () => {
    await compare(String.raw`printf '[%s] %% %d %d %d\n' hello 0 +12 -3`);
  });

  it("recycles the format while operands remain", async () => {
    await compare(String.raw`printf '%s\n' alpha beta gamma`);
  });

  it("uses empty strings and zero for missing operands", async () => {
    await compare(String.raw`printf '<%s><%s><%d><%d>\n' one 2`);
  });

  it("writes the admitted escapes as exact bytes, including NUL", async () => {
    const parity = await compareWithBash(String.raw`printf 'A\0B\nC\tD\rE\\F'`);
    agreeWithBash(parity);
    expect(parity.ours.stdout).toEqual(new Uint8Array([65, 0, 66, 10, 67, 9, 68, 13, 69, 92, 70]));
  });

  it("matches Bash output and status for an invalid conversion", async () => {
    agreeWithBashInvalidPrintfFormat(await compareWithBash("printf 'before:%s:%Z:after' value"));
  });
});

describe("printf intentional local refusals", () => {
  let shell: Shell;

  beforeEach(() => {
    const fs = createFilesystem(new TestDatabase());
    fs.mkdir("/repo");
    shell = createShell({ fs, cwd: "/repo" });
  });

  it.each([
    ["width", "printf '%2s' value", "format width and precision are not supported"],
    ["dynamic width", "printf '%*s' 2 value", "format width and precision are not supported"],
    ["precision", "printf '%.2s' value", "format width and precision are not supported"],
    ["%b", "printf '%b' value", "%b is not supported"],
    ["%q", "printf '%q' value", "%q is not supported"],
    ["%c", "printf '%c' value", "%c is not supported"],
  ])("refuses %s", async (_name, source, diagnostic) => {
    const run = await shell.exec(source);
    expect(run.stdout).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(run.stderr)).toBe(`printf: ${diagnostic}\n`);
    expect(run.exitCode).toBe(2);
  });

  it("refuses escapes outside the admitted set", async () => {
    const run = await shell.exec(String.raw`printf '\x'`);
    expect(run.stdout).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(run.stderr)).toBe("printf: escape \\x is not supported\n");
    expect(run.exitCode).toBe(2);
  });

  it.each([
    ["0x10", "printf '%d' 0x10"],
    ["010", "printf '%d' 010"],
    ["'x", `printf '%d' "'x"`],
  ])("refuses non-decimal numeric spelling %s", async (value, source) => {
    const run = await shell.exec(source);
    expect(run.stdout).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(run.stderr)).toBe(
      `printf: numeric operand '${value}' is not a signed decimal\n`,
    );
    expect(run.exitCode).toBe(2);
  });

  it("remains bounded by the shell stdout sink", async () => {
    const fs = createFilesystem(new TestDatabase());
    fs.mkdir("/repo");
    const bounded = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 4, maxOperations: 10, readBudget: 100 },
    });
    const run = await bounded.exec("printf '%s' abcdef");
    expect(run.stdout).toEqual(new TextEncoder().encode("abcd"));
    expect(run.truncated).toBe(true);
    expect(run.operations).toBe(0);
  });
});
