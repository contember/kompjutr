// Real repositories, pinned to the tags the earlier DOFS experiment sized,
// so a row here lines up with a row in `docs/benchmark-reference.md`.
//
// A fixture is fetched once into `bench/.fixtures` and then rebuilt as a
// single-commit repository. That rebuild is what makes it usable as a local
// Smart HTTP origin: git will not serve a shallow clone, and a full clone of
// these repositories is history nobody here measures.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Harness } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".fixtures");

/** The branch the rebuilt origin publishes. Never an upstream name. */
export const ORIGIN_BRANCH = "main";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "Bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00+0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  LC_ALL: "C",
};

export const FIXTURE_NAMES = [
  "express",
  "tailwind",
  "vue",
  "eslint",
  "prettier",
  "nextjs",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface Fixture {
  name: FixtureName;
  url: string;
  /** Upstream tag the checkout is pinned to. */
  ref: string;
  /** Tracked files upstream, from the earlier experiment's sizing pass. */
  files: number;
}

export const FIXTURES: Record<FixtureName, Fixture> = {
  express: {
    name: "express",
    url: "https://github.com/expressjs/express.git",
    ref: "v5.2.1",
    files: 218,
  },
  tailwind: {
    name: "tailwind",
    url: "https://github.com/tailwindlabs/tailwindcss.git",
    ref: "v4.3.3",
    files: 541,
  },
  vue: { name: "vue", url: "https://github.com/vuejs/core.git", ref: "v3.6.0-rc.4", files: 1075 },
  eslint: {
    name: "eslint",
    url: "https://github.com/eslint/eslint.git",
    ref: "v10.8.1",
    files: 2358,
  },
  prettier: {
    name: "prettier",
    url: "https://github.com/prettier/prettier.git",
    ref: "3.9.6",
    files: 9329,
  },
  nextjs: {
    name: "nextjs",
    url: "https://github.com/vercel/next.js.git",
    ref: "v15.5.2",
    files: 24252,
  },
};

export function isFixtureName(value: string): value is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(value);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
}

/**
 * Fetch and rebuild a fixture, or return the cached one. The marker records
 * the tag, so changing a pin invalidates the cache instead of silently
 * measuring the old checkout.
 */
export function prepareFixture(fixture: Fixture): string {
  const dir = join(CACHE, fixture.name);
  const marker = join(CACHE, `${fixture.name}.json`);
  if (existsSync(marker)) {
    const cached: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (typeof cached === "object" && cached !== null && "ref" in cached) {
      if (cached.ref === fixture.ref) return dir;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(marker, { force: true });
  mkdirSync(CACHE, { recursive: true });

  git(CACHE, [
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--depth",
    "1",
    "--branch",
    fixture.ref,
    "--single-branch",
    "--no-tags",
    fixture.url,
    dir,
  ]);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  git(dir, ["init", "-q", "-b", ORIGIN_BRANCH]);
  git(dir, ["config", "core.autocrlf", "false"]);
  // `-f` because the upstream checkout is exactly the tracked set: anything
  // the repository's own .gitignore matches is still one of its files.
  git(dir, ["add", "-A", "-f"]);
  git(dir, ["commit", "-q", "-m", `${fixture.name} ${fixture.ref}`]);
  // Working tree rewritten from the blobs, so a `.gitattributes` filter can
  // not leave the checkout differing from what a clone would write.
  git(dir, ["reset", "-q", "--hard"]);
  git(dir, ["repack", "-adq"]);

  const commit = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(marker, `${JSON.stringify({ ...fixture, commit }, null, 2)}\n`);
  return dir;
}

export interface FixtureEntry {
  path: string;
  /** The mode git recorded: 100644, 100755 or 120000. */
  mode: number;
}

/** Every tracked path, in git's own order. */
export function trackedEntries(dir: string): FixtureEntry[] {
  const listing = execFileSync("git", ["ls-files", "-s", "-z"], {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const entries: FixtureEntry[] = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const mode = Number.parseInt(record.slice(0, record.indexOf(" ")), 8);
    // Submodules have no content to write.
    if (mode === 0o160000) continue;
    entries.push({ path: record.slice(tab + 1), mode });
  }
  return entries;
}

/**
 * Write the fixture into the workspace, the way a clone's checkout would.
 * Not measured: this stands in for the checkout the reference experiment ran
 * outside its measured region too.
 */
export async function materialize(
  harness: Harness,
  root: string,
  dir: string,
  entries: readonly FixtureEntry[],
): Promise<void> {
  const made = new Set<string>();
  await harness.workspace.fs.mkdir(root, { recursive: true });
  made.add(root);
  for (const entry of entries) {
    const target = `${root}/${entry.path}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    if (!made.has(parent)) {
      await harness.workspace.fs.mkdir(parent, { recursive: true });
      made.add(parent);
    }
    const source = join(dir, entry.path);
    if (entry.mode === 0o120000) {
      await harness.workspace.fs.symlink(readlinkSync(source), target);
      continue;
    }
    await harness.workspace.fs.writeFile(target, new Uint8Array(readFileSync(source)), {
      mode: entry.mode & 0o777,
    });
  }
}
