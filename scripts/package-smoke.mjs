import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const compatPeer = "@cloudflare/computer@0.2.1";
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

async function writeConsumer(directory, source, skipLibCheck = false) {
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
          skipLibCheck,
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

async function assertComputerIsAbsent(directory) {
  const manifest = join(directory, "node_modules", "@cloudflare", "computer", "package.json");
  try {
    await access(manifest, constants.F_OK);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("The standalone consumer unexpectedly installed @cloudflare/computer");
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
        'import * as rootEntry from "kompjutr";',
        'import * as fsEntry from "kompjutr/fs";',
        'import * as gitEntry from "kompjutr/git";',
        'import * as shellEntry from "kompjutr/shell";',
        'import * as testingEntry from "kompjutr/testing";',
        "",
        "void [rootEntry, fsEntry, gitEntry, shellEntry, testingEntry];",
        "",
      ].join("\n"),
    );
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], standalone);
    await assertComputerIsAbsent(standalone);
    typecheckConsumer(standalone);
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'for (const entry of ["kompjutr", "kompjutr/fs", "kompjutr/git", "kompjutr/shell", "kompjutr/testing"]) await import(entry);',
      ],
      standalone,
    );

    const compatibility = join(temporaryRoot, "compat-consumer");
    await writeConsumer(
      compatibility,
      [
        'import { ComputerWorktree, createSqliteGitClient } from "kompjutr/compat/computer";',
        "",
        "void ComputerWorktree;",
        "void createSqliteGitClient;",
        "",
      ].join("\n"),
      true,
    );
    run(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, compatPeer],
      compatibility,
    );
    typecheckConsumer(compatibility);
    run(
      process.execPath,
      ["--input-type=module", "--eval", 'await import("kompjutr/compat/computer");'],
      compatibility,
    );

    console.log(`Package smoke passed for ${tarballs[0]}`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await main();
