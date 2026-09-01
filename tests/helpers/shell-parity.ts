// Differential harness for the Bash-shaped shell surface.
//
// Controlled dimensions: `LC_ALL=C`; POSIX-default `IFS`; an environment
// allowlist of `PATH`, `LC_ALL`, `IFS`, and case-explicit variables; and cwd at
// the seeded tree root (`<temp>` for Bash, `/repo` for kompjutr).
//
// The seed supports regular files and their parent directories only. Both sides
// receive mode 0644/0755 and the same fixed mtime. Symlinks, empty directories,
// inode/owner identity, absolute paths, and the physical cwd are not comparable.
// Named expansion is limited to controlled or case-explicit variables. Bash
// intrinsic variables (`PWD`, `SHLVL`, `RANDOM`, `BASH_*`, etc.) and special
// parameters (`$?`, `$$`, `$1`, etc.) are rejected rather than normalized.
// Stdout, stderr, and exit status are compared exactly, with output kept as bytes.
// The printf-invalid helper only removes Bash's fixed `bash: line 1: ` location
// prefix from the exact `%Z` diagnostic; the remaining diagnostic stays byte-exact.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { expect } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { WriteEntry } from "../../src/fs/types.js";
import { createShell } from "../../src/shell/index.js";
import { TestDatabase } from "./db.js";

const ROOT = "/repo";
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const MTIME = 1_700_000_000_000;
const MTIME_DATE = new Date(MTIME);
const ENCODER = new TextEncoder();
const BASE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LC_ALL: "C",
  IFS: " \t\n",
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASH_INTRINSICS = new Set([
  "BASHPID",
  "BASHOPTS",
  "BASH_ALIASES",
  "BASH_ARGC",
  "BASH_ARGV",
  "BASH_CMDS",
  "BASH_LINENO",
  "BASH_SOURCE",
  "BASH_SUBSHELL",
  "BASH_VERSINFO",
  "BASH_VERSION",
  "DIRSTACK",
  "EPOCHREALTIME",
  "EPOCHSECONDS",
  "EUID",
  "FUNCNAME",
  "GROUPS",
  "HISTCMD",
  "HOSTNAME",
  "HOSTTYPE",
  "LINENO",
  "MACHTYPE",
  "OLDPWD",
  "OPTARG",
  "OPTIND",
  "OSTYPE",
  "PIPESTATUS",
  "PPID",
  "PWD",
  "RANDOM",
  "SECONDS",
  "SHELLOPTS",
  "SHLVL",
  "SRANDOM",
  "UID",
  "_",
]);

export type ShellTree = Readonly<Record<string, string | Uint8Array>>;

export interface ShellParityOptions {
  readonly tree?: ShellTree;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ShellParityRun {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
}

export interface ShellParity {
  readonly bash: ShellParityRun;
  readonly ours: ShellParityRun;
}

function probeBash(): string {
  const run = spawnSync("bash", ["--version"], { env: BASE_ENV });
  if (run.error !== undefined || run.status !== 0) return "";
  return new TextDecoder().decode(run.stdout);
}

export const REAL_BASH = /^GNU bash, version /.test(probeBash());

export async function compareWithBash(
  source: string,
  options: ShellParityOptions = {},
): Promise<ShellParity> {
  const tree = options.tree ?? {};
  validateTree(tree);
  const env = controlledEnvironment(options.env ?? {});
  validateParameterExpansions(source, env);
  if (!REAL_BASH) throw new Error("GNU Bash is required for shell parity");

  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "kompjutr-shell-parity-"));
    const virtualEntries = seedHostTree(directory, tree);
    const fs = createFilesystem(new TestDatabase(), { now: () => MTIME });
    fs.writeFiles(virtualEntries);
    const shell = createShell({ fs, cwd: ROOT });

    const bash = spawnSync("bash", ["--noprofile", "--norc", "-c", source], {
      cwd: directory,
      env,
      maxBuffer: 1 << 26,
    });
    if (bash.error !== undefined) throw bash.error;
    if (bash.status === null) {
      throw new Error(`bash terminated by ${bash.signal ?? "an unknown signal"}`);
    }

    const ours = await shell.exec(source, { env });
    return {
      bash: {
        stdout: Uint8Array.from(bash.stdout),
        stderr: Uint8Array.from(bash.stderr),
        exitCode: bash.status,
      },
      ours: { stdout: ours.stdout, stderr: ours.stderr, exitCode: ours.exitCode },
    };
  } finally {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

function validateTree(tree: ShellTree): void {
  for (const relative of Object.keys(tree)) {
    const segments = relative.split("/");
    if (
      relative.length === 0 ||
      relative.includes("\0") ||
      posix.isAbsolute(relative) ||
      relative.endsWith("/") ||
      posix.normalize(relative) !== relative ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(
        `shell parity tree path must be a normalized non-empty relative file: ${relative}`,
      );
    }
  }
}

function controlledEnvironment(
  caseEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  for (const name of Object.keys(caseEnvironment)) {
    if (!ENV_NAME.test(name)) throw new Error(`invalid shell parity environment name: ${name}`);
    if (Object.hasOwn(BASE_ENV, name)) {
      throw new Error(`shell parity environment cannot override controlled variable ${name}`);
    }
    if (name.startsWith("BASH") || BASH_INTRINSICS.has(name)) {
      throw new Error(`Bash intrinsic variable ${name} is outside shell parity`);
    }
  }
  return { ...BASE_ENV, ...caseEnvironment };
}

function validateParameterExpansions(source: string, env: Readonly<Record<string, string>>): void {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (char === "\\" && !singleQuoted) {
      index++;
      continue;
    }
    if (char !== "$" || singleQuoted) continue;

    const rest = source.slice(index + 1);
    const named = /^\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)?.[1];
    if (named !== undefined) {
      if (!Object.hasOwn(env, named)) {
        throw new Error(`parameter ${named} must be explicit in the shell parity environment`);
      }
      continue;
    }
    if (/^\{?[0-9@*#?$!_-]/.test(rest)) {
      throw new Error("Bash special parameters are outside shell parity");
    }
  }
}

function seedHostTree(directory: string, tree: ShellTree): WriteEntry[] {
  const relativeDirectories = new Set<string>();
  const files: WriteEntry[] = [];

  for (const [relative, content] of Object.entries(tree)) {
    const segments = relative.split("/");
    let parent = "";
    for (const segment of segments.slice(0, -1)) {
      parent = parent === "" ? segment : `${parent}/${segment}`;
      relativeDirectories.add(parent);
    }

    const bytes = typeof content === "string" ? ENCODER.encode(content) : content;
    const onDisk = join(directory, relative);
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, bytes, { mode: FILE_MODE });
    chmodSync(onDisk, FILE_MODE);
    utimesSync(onDisk, MTIME_DATE, MTIME_DATE);
    files.push({ path: `${ROOT}/${relative}`, bytes, mode: FILE_MODE, mtime: MTIME });
  }

  const directories: WriteEntry[] = [{ path: ROOT, mode: DIRECTORY_MODE, mtime: MTIME }];
  for (const relative of relativeDirectories) {
    const onDisk = join(directory, relative);
    mkdirSync(onDisk, { recursive: true });
    directories.push({ path: `${ROOT}/${relative}`, mode: DIRECTORY_MODE, mtime: MTIME });
  }
  for (const onDisk of [
    directory,
    ...Array.from(relativeDirectories, (path) => join(directory, path)),
  ]) {
    chmodSync(onDisk, DIRECTORY_MODE);
    utimesSync(onDisk, MTIME_DATE, MTIME_DATE);
  }

  return [...directories, ...files];
}

export function agreeWithBash(parity: ShellParity): void {
  expect(parity.ours.stdout).toEqual(parity.bash.stdout);
  expect(parity.ours.stderr).toEqual(parity.bash.stderr);
  expect(parity.ours.exitCode).toBe(parity.bash.exitCode);
}

export function agreeWithBashInvalidPrintfFormat(parity: ShellParity): void {
  const bashDiagnostic = new TextDecoder().decode(parity.bash.stderr);
  const normalized = bashDiagnostic.replace(
    /^bash: line 1: (?=printf: `Z': invalid format character\n$)/,
    "",
  );
  expect(parity.ours.stdout).toEqual(parity.bash.stdout);
  expect(parity.ours.stderr).toEqual(ENCODER.encode(normalized));
  expect(parity.ours.exitCode).toBe(parity.bash.exitCode);
}
