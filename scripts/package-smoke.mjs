import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const typescriptCompiler = join(root, "node_modules", "typescript", "bin", "tsc");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const outcome =
      result.signal === null ? `exit code ${result.status}` : `signal ${result.signal}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${outcome}`);
  }
}

function requestedPackDestination(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--pack-destination" || args[1] === undefined) {
    throw new Error("Usage: npm run package:smoke -- [--pack-destination <directory>]");
  }
  return resolve(args[1]);
}

async function writeConsumer(directory, source) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(join(directory, "consumer.ts"), source);
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
          typeRoots: [join(root, "node_modules", "@types")],
          types: ["node"],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

function typecheckConsumer(directory) {
  run(
    process.execPath,
    [typescriptCompiler, "--project", join(directory, "tsconfig.json")],
    directory,
  );
}

async function main() {
  const externalDestination = requestedPackDestination(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "kompjutr-package-smoke-"));

  try {
    const packDestination = externalDestination ?? join(temporaryRoot, "package");
    await mkdir(packDestination, { recursive: true });
    const existingTarballs = (await readdir(packDestination)).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (existingTarballs.length !== 0) {
      throw new Error(`Pack destination already contains a tarball: ${packDestination}`);
    }

    run(npm, ["run", "build"], root);
    run(npm, ["pack", "--pack-destination", packDestination], root);

    const tarballs = (await readdir(packDestination)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1 || tarballs[0] === undefined) {
      throw new Error(`Expected one packed tarball, found ${tarballs.length}`);
    }
    const tarball = join(packDestination, tarballs[0]);

    const standalone = join(temporaryRoot, "standalone-consumer");
    await writeConsumer(
      standalone,
      [
        "import type {",
        "  DivergenceOptions as RootDivergenceOptions,",
        "  DivergenceRelationship as RootDivergenceRelationship,",
        "  DivergenceResult as RootDivergenceResult,",
        "  Git as RootGit,",
        "  GitCliInput as RootGitCliInput,",
        "  GitCliResult as RootGitCliResult,",
        "  GitCliRunner as RootGitCliRunner,",
        "  GitCliRunOptions as RootGitCliRunOptions,",
        "  GitDivergenceOptions as RootGitDivergenceOptions,",
        "  GitReadRefOptions as RootGitReadRefOptions,",
        "  GitWorktreeAddOptions as RootGitWorktreeAddOptions,",
        "  GitWorktreeRemoveOptions as RootGitWorktreeRemoveOptions,",
        "  RawRefTarget as RootRawRefTarget,",
        "  ReadRefOptions as RootReadRefOptions,",
        "  WorktreeAddOptions as RootWorktreeAddOptions,",
        "  WorktreeAddTarget as RootWorktreeAddTarget,",
        "  WorktreeInfo as RootWorktreeInfo,",
        "  WorktreeRemoveOptions as RootWorktreeRemoveOptions,",
        '} from "kompjutr";',
        "import {",
        "  divergence as rootDivergence,",
        "  readRef as rootReadRef,",
        "  worktreeAdd as rootWorktreeAdd,",
        "  worktreeList as rootWorktreeList,",
        "  worktreePrune as rootWorktreePrune,",
        "  worktreeRemove as rootWorktreeRemove,",
        '} from "kompjutr";',
        'import * as rootEntry from "kompjutr";',
        'import * as fsEntry from "kompjutr/fs";',
        "import type {",
        "  DivergenceOptions as GitDivergenceOptions,",
        "  DivergenceRelationship as GitDivergenceRelationship,",
        "  DivergenceResult as GitDivergenceResult,",
        "  Git as GitEntrypointGit,",
        "  GitCliInput,",
        "  GitCliResult,",
        "  GitCliRunner,",
        "  GitCliRunOptions,",
        "  GitDivergenceOptions as GitClientDivergenceOptions,",
        "  GitReadRefOptions as GitClientReadRefOptions,",
        "  GitWorktreeAddOptions as GitClientWorktreeAddOptions,",
        "  GitWorktreeRemoveOptions as GitClientWorktreeRemoveOptions,",
        "  RawRefTarget as GitRawRefTarget,",
        "  ReadRefOptions as GitReadRefOptions,",
        "  WorktreeAddOptions as GitWorktreeAddOptions,",
        "  WorktreeAddTarget as GitWorktreeAddTarget,",
        "  WorktreeInfo as GitWorktreeInfo,",
        "  WorktreeRemoveOptions as GitWorktreeRemoveOptions,",
        '} from "kompjutr/git";',
        'import { createGitCommand } from "kompjutr/git/shell";',
        "import {",
        "  divergence as gitDivergence,",
        "  readRef as gitReadRef,",
        "  worktreeAdd as gitWorktreeAdd,",
        "  worktreeList as gitWorktreeList,",
        "  worktreePrune as gitWorktreePrune,",
        "  worktreeRemove as gitWorktreeRemove,",
        '} from "kompjutr/git";',
        'import * as gitEntry from "kompjutr/git";',
        'import * as shellEntry from "kompjutr/shell";',
        'import * as testingEntry from "kompjutr/testing";',
        "",
        'const coreDivergence: RootDivergenceOptions = { current: "HEAD", upstream: "main" };',
        "const gitCoreDivergence: GitDivergenceOptions = coreDivergence;",
        'const divergenceOptions: RootGitDivergenceOptions = { ...coreDivergence, dir: "/repo" };',
        "const gitDivergenceOptions: GitClientDivergenceOptions = divergenceOptions;",
        'const relationship: RootDivergenceRelationship = "diverged";',
        "const gitRelationship: GitDivergenceRelationship = relationship;",
        "const divergenceResult: RootDivergenceResult = { relationship, ahead: 2, behind: 1 };",
        "const gitDivergenceResult: GitDivergenceResult = divergenceResult;",
        "",
        'const rootCliInput: RootGitCliInput = { argv: ["status", "--porcelain"], cwd: "/repo" };',
        "const gitCliInput: GitCliInput = rootCliInput;",
        "const rootCliOptions: RootGitCliRunOptions = { logLimitHint: 3 };",
        "const gitCliOptions: GitCliRunOptions = rootCliOptions;",
        'const rootCliResult: RootGitCliResult = { stdout: "", stderr: "", exitCode: 0, truncated: false };',
        "const gitCliResult: GitCliResult = rootCliResult;",
        "const rootCliRunner: RootGitCliRunner = { runCli: async () => rootCliResult };",
        "const gitCliRunner: GitCliRunner = rootCliRunner;",
        "const gitCommand = createGitCommand(gitCliRunner);",
        "",
        'const readOptions: RootReadRefOptions = { ref: "refs/remotes/origin/HEAD" };',
        "const gitReadOptions: GitReadRefOptions = readOptions;",
        'const clientReadOptions: RootGitReadRefOptions = { ...readOptions, dir: "/repo" };',
        "const gitClientReadOptions: GitClientReadRefOptions = clientReadOptions;",
        'const rawTarget: RootRawRefTarget = { kind: "symbolic", target: "refs/remotes/origin/main" };',
        "const gitRawTarget: GitRawRefTarget = rawTarget;",
        "",
        'const target: RootWorktreeAddTarget = { kind: "detached" };',
        "const gitTarget: GitWorktreeAddTarget = target;",
        'const addOptions: RootWorktreeAddOptions = { root: "/session", target };',
        "const gitAddOptions: GitWorktreeAddOptions = addOptions;",
        'const clientAddOptions: RootGitWorktreeAddOptions = { ...addOptions, dir: "/repo" };',
        "const gitClientAddOptions: GitClientWorktreeAddOptions = clientAddOptions;",
        'const removeOptions: RootWorktreeRemoveOptions = { root: "/session", force: true };',
        "const gitCoreRemoveOptions: GitWorktreeRemoveOptions = removeOptions;",
        'const clientRemoveOptions: RootGitWorktreeRemoveOptions = { ...removeOptions, dir: "/repo" };',
        "const gitClientRemoveOptions: GitClientWorktreeRemoveOptions = clientRemoveOptions;",
        'const worktree: RootWorktreeInfo = { checkoutId: 2, root: "/session", head: "0123456789012345678901234567890123456789", isPrimary: false, state: "present" };',
        "const gitWorktree: GitWorktreeInfo = worktree;",
        'const rootMethods: readonly (keyof RootGit)[] = ["runCli", "divergence", "readRef", "worktreeAdd", "worktreeList", "worktreeRemove", "worktreePrune"];',
        "const gitMethods: readonly (keyof GitEntrypointGit)[] = rootMethods;",
        "",
        "void [",
        "  rootEntry, fsEntry, gitEntry, shellEntry, testingEntry,",
        "  gitCoreDivergence, gitDivergenceOptions, gitRelationship, gitDivergenceResult,",
        "  gitCliInput, gitCliOptions, gitCliResult, gitCliRunner, gitCommand,",
        "  gitReadOptions, gitClientReadOptions, gitRawTarget,",
        "  gitTarget, gitAddOptions, gitClientAddOptions, gitCoreRemoveOptions, gitClientRemoveOptions, gitWorktree, gitMethods,",
        "  rootDivergence, rootReadRef, rootWorktreeAdd, rootWorktreeList, rootWorktreeRemove, rootWorktreePrune,",
        "  gitDivergence, gitReadRef, gitWorktreeAdd, gitWorktreeList, gitWorktreeRemove, gitWorktreePrune,",
        "];",
        "",
      ].join("\n"),
    );
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], standalone);
    typecheckConsumer(standalone);
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'for (const entry of ["kompjutr", "kompjutr/fs", "kompjutr/git", "kompjutr/git/shell", "kompjutr/shell", "kompjutr/testing"]) await import(entry);',
          'const root = await import("kompjutr");',
          'const fs = await import("kompjutr/fs");',
          'const git = await import("kompjutr/git");',
          'const gitShell = await import("kompjutr/git/shell");',
          'if (typeof gitShell.createGitCommand !== "function") throw new Error("Missing public Git shell adapter");',
          'for (const [name, entry] of [["kompjutr", root], ["kompjutr/fs", fs], ["kompjutr/git", git]]) {',
          '  if ("createExactPathStateSource" in entry) throw new Error("Internal exact-path source leaked from " + name);',
          "}",
          'for (const name of ["divergence", "readRef", "worktreeAdd", "worktreeList", "worktreeRemove", "worktreePrune"]) {',
          '  if (typeof root[name] !== "function" || typeof git[name] !== "function") throw new Error("Missing public operation: " + name);',
          "}",
          "try {",
          '  await import("kompjutr/fs/exact-path-states");',
          '  throw new Error("Internal exact-path implementation is publicly importable");',
          "} catch (error) {",
          '  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;',
          "}",
        ].join("\n"),
      ],
      standalone,
    );

    console.log(`Package smoke passed for ${tarballs[0]}`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await main();
