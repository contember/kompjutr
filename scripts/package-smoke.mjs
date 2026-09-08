import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const typescriptCompiler = join(root, "node_modules", "typescript", "bin", "tsc");
const packages = ["sqlite", "drive", "git", "do", "local"];
const repositoryUrl = "git+https://github.com/contember/kompjutr.git";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const outcome =
      result.signal === null ? `exit code ${result.status}` : `signal ${result.signal}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${outcome}`);
  }
}

function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

async function packageManifests() {
  const manifests = new Map();
  for (const name of packages) {
    manifests.set(
      name,
      JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8")),
    );
  }
  const versions = new Set([...manifests.values()].map((manifest) => manifest.version));
  if (versions.size !== 1) throw new Error("@kompjutr package versions are not in lockstep");
  const version = versions.values().next().value;
  if (typeof version !== "string" || version === "") throw new Error("package version is invalid");
  for (const [name, manifest] of manifests) {
    if (
      manifest.repository?.type !== "git" ||
      manifest.repository.url !== repositoryUrl ||
      manifest.repository.directory !== `packages/${name}`
    ) {
      throw new Error(`${name} package repository metadata is inconsistent`);
    }
    for (const [dependency, dependencyVersion] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@kompjutr/") && dependencyVersion !== version) {
        throw new Error(
          `${name} depends on ${dependency}@${dependencyVersion}, expected ${version}`,
        );
      }
    }
  }
  return { manifests, version };
}

async function verifyGitLicenseNotice(directory) {
  const packageRoot = join(directory, "node_modules", "@kompjutr", "git");
  const notice = await readFile(join(packageRoot, "src", "diff", "LICENSE"), "utf8");
  const pointer = "The full licence text is at ../../LICENSES/LGPL-2.1.txt.";
  if (!notice.includes(pointer)) throw new Error("git package LGPL notice target is inconsistent");
  await readFile(join(packageRoot, "LICENSES", "LGPL-2.1.txt"));
}

function validatePack(name, manifest, packed, expectedFilename) {
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0]?.filename !== expectedFilename) {
    throw new Error(`${name} produced an unexpected npm pack result`);
  }
  const files = packed[0].files?.map((file) => file.path);
  if (
    !Array.isArray(files) ||
    !files.includes("package.json") ||
    !files.includes("dist/index.js")
  ) {
    throw new Error(`${name} tarball is missing its package metadata or main entry`);
  }
  if (
    files.some(
      (path) => path.endsWith(".tsbuildinfo") || (path.startsWith("src/") && path.endsWith(".ts")),
    )
  ) {
    throw new Error(`${name} tarball contains build state or TypeScript source`);
  }
  if (packed[0].name !== manifest.name || packed[0].version !== manifest.version) {
    throw new Error(`${name} npm pack metadata differs from package.json`);
  }
  const expectedLicense = name === "git" ? "MIT AND LGPL-2.1-or-later" : "MIT";
  if (manifest.license !== expectedLicense || !files.includes("LICENSE")) {
    throw new Error(`${name} package license metadata is inconsistent`);
  }
  const expectedNoticeFiles =
    name === "git"
      ? ["LICENSES/LGPL-2.1.txt", "src/diff/LICENSE"]
      : name === "do"
        ? ["LICENSES/cloudflare-computer.txt"]
        : [];
  const actualNoticeFiles = files.filter(
    (path) => path.startsWith("LICENSES/") || path === "src/diff/LICENSE",
  );
  if (
    actualNoticeFiles.length !== expectedNoticeFiles.length ||
    expectedNoticeFiles.some((path) => !actualNoticeFiles.includes(path))
  ) {
    throw new Error(`${name} tarball contains inconsistent license notices`);
  }
}

function requestedPackDestination(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--pack-destination" || args[1] === undefined) {
    throw new Error("Usage: npm run package:smoke -- [--pack-destination <directory>]");
  }
  return resolve(args[1]);
}

function consumerSource(includeLocal) {
  const imports = [
    'import { GitError, type SqlDatabase } from "@kompjutr/sqlite";',
    'import type { GitDrive, ScanEntry } from "@kompjutr/drive";',
    'import { createGit, GitError as PublicGitError, type Git } from "@kompjutr/git";',
    'import * as doFsIntegration from "@kompjutr/git/do-fs";',
    'import { Database, Workspace } from "@kompjutr/do";',
    'import * as fsEntry from "@kompjutr/do/fs";',
    'import { createGitCommand } from "@kompjutr/do/git-shell";',
    'import * as shellEntry from "@kompjutr/do/shell";',
    'import * as testingEntry from "@kompjutr/do/testing";',
  ];
  if (includeLocal) imports.push('import * as localEntry from "@kompjutr/local";');
  return [
    ...imports,
    "",
    "const database: SqlDatabase | undefined = undefined;",
    "const drive: GitDrive | undefined = undefined;",
    "const row: ScanEntry | undefined = undefined;",
    "const git: Git | undefined = undefined;",
    "void [",
    "  GitError, PublicGitError, createGit, Database, Workspace, createGitCommand,",
    `  database, drive, row, git, doFsIntegration, fsEntry, shellEntry, testingEntry${includeLocal ? ", localEntry" : ""},`,
    "];",
    "",
  ].join("\n");
}

async function writeConsumer(directory, includeLocal) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(join(directory, "consumer.ts"), consumerSource(includeLocal));
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: includeLocal ? "NodeNext" : "ESNext",
          moduleResolution: includeLocal ? "NodeNext" : "Bundler",
          noEmit: true,
          strict: true,
          target: "ES2023",
          lib: includeLocal
            ? ["ES2023", "ES2024.String", "ESNext.Disposable"]
            : ["ES2023", "ES2024.String", "ESNext.Disposable", "WebWorker"],
          typeRoots: includeLocal ? [join(root, "node_modules", "@types")] : undefined,
          types: includeLocal ? ["node"] : [],
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

async function verifyConsumer(directory, expectedPackages, version) {
  const consumerLock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
  for (const name of expectedPackages) {
    const installed = consumerLock.packages?.[`node_modules/@kompjutr/${name}`];
    if (
      installed?.version !== version ||
      !installed.resolved?.endsWith(`kompjutr-${name}-${version}.tgz`)
    ) {
      throw new Error(`consumer did not resolve @kompjutr/${name} from the verified tarball`);
    }
  }
  run(
    process.execPath,
    [typescriptCompiler, "--project", join(directory, "tsconfig.json")],
    directory,
  );
}

async function main() {
  const { manifests, version } = await packageManifests();
  const expectedTarballs = packages.map((name) => `kompjutr-${name}-${version}.tgz`).sort();
  const externalDestination = requestedPackDestination(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "kompjutr-package-smoke-"));
  try {
    const packDestination = externalDestination ?? join(temporaryRoot, "packages");
    await mkdir(packDestination, { recursive: true });
    const existing = (await readdir(packDestination)).filter((name) => name.endsWith(".tgz"));
    if (existing.length !== 0)
      throw new Error(`Pack destination contains tarballs: ${packDestination}`);

    run(npm, ["run", "build"], root);
    for (const name of packages) {
      const expectedFilename = `kompjutr-${name}-${version}.tgz`;
      const packed = JSON.parse(
        output(
          npm,
          ["pack", "--json", "--pack-destination", packDestination],
          join(root, "packages", name),
        ),
      );
      validatePack(name, manifests.get(name), packed, expectedFilename);
    }
    const tarballNames = (await readdir(packDestination))
      .filter((name) => name.endsWith(".tgz"))
      .sort();
    if (JSON.stringify(tarballNames) !== JSON.stringify(expectedTarballs)) {
      throw new Error(`Expected ${expectedTarballs.join(", ")}; found ${tarballNames.join(", ")}`);
    }

    const nodeConsumer = join(temporaryRoot, "node-consumer");
    const workerConsumer = join(temporaryRoot, "worker-consumer");
    await Promise.all([writeConsumer(nodeConsumer, true), writeConsumer(workerConsumer, false)]);
    const tarballFor = (name) => join(packDestination, `kompjutr-${name}-${version}.tgz`);
    run(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packages.map(tarballFor)],
      nodeConsumer,
    );
    const workerPackages = packages.filter((name) => name !== "local");
    run(
      npm,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...workerPackages.map(tarballFor)],
      workerConsumer,
    );
    await verifyConsumer(nodeConsumer, packages, version);
    await verifyConsumer(workerConsumer, workerPackages, version);
    await verifyGitLicenseNotice(nodeConsumer);
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'const sqlite = await import("@kompjutr/sqlite");',
          'const git = await import("@kompjutr/git");',
          'for (const entry of ["@kompjutr/drive", "@kompjutr/git/do-fs", "@kompjutr/do", "@kompjutr/do/fs", "@kompjutr/do/git-shell", "@kompjutr/do/shell", "@kompjutr/do/testing", "@kompjutr/local"]) await import(entry);',
          'if (sqlite.GitError !== git.GitError) throw new Error("GitError has duplicate runtime identities");',
          'try { await import("kompjutr"); throw new Error("Retired package is importable"); } catch (error) { if (error?.message === "Retired package is importable") throw error; }',
          'try { await import("@kompjutr/git/store/index"); throw new Error("Internal Git path is exported"); } catch (error) { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; }',
        ].join("\n"),
      ],
      nodeConsumer,
    );
    console.log(`Package smoke passed for ${tarballNames.join(", ")}`);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await main();
