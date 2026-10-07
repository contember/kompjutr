// The full-history Next.js origin for `--history=full`. The shared fixture is a
// single-commit rebuild, so it cannot measure a history-wide clone.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES, ORIGIN_BRANCH } from "../fixtures.js";

/** Next.js v15.5.2, the commit the shared fixture snapshots. */
const HISTORY_REVISION = "497ec6aa08a33f9e2d65a5c8461f550c2549d3e6";

const ORIGIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".fixtures",
  "nextjs-history.git",
);

function git(...args: string[]): string {
  return execFileSync("git", ["--git-dir", ORIGIN, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }).trim();
}

/** Tracked paths at the pinned revision, without submodules, as `trackedEntries` counts them. */
function trackedFiles(): number {
  return git("ls-tree", "-r", "-z", "--full-tree", HISTORY_REVISION)
    .split("\0")
    .filter((record) => record.length > 0 && !record.startsWith("160000 ")).length;
}

/**
 * Clone the upstream history once into `bench/.fixtures`, then pin `main` to the
 * revision and allow filtered fetches. The clone runs before the origin server
 * starts, so a synchronous child cannot deadlock against it.
 */
export function prepareHistoryOrigin(): { gitDir: string; head: string; files: number } {
  const fixture = FIXTURES.nextjs;
  if (!existsSync(ORIGIN)) {
    mkdirSync(dirname(ORIGIN), { recursive: true });
    execFileSync(
      "git",
      [
        "-c",
        "pack.threads=2",
        "clone",
        "--bare",
        "--single-branch",
        "--branch",
        fixture.ref,
        "--no-tags",
        fixture.url,
        ORIGIN,
      ],
      { stdio: "inherit" },
    );
  }
  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error(`${ORIGIN} is shallow; the full-history mode needs complete history`);
  }
  if (git("rev-parse", "HEAD^{commit}") !== HISTORY_REVISION) {
    throw new Error(`${ORIGIN} is not ${fixture.name} ${fixture.ref} (${HISTORY_REVISION})`);
  }
  git("update-ref", `refs/heads/${ORIGIN_BRANCH}`, HISTORY_REVISION);
  git("symbolic-ref", "HEAD", `refs/heads/${ORIGIN_BRANCH}`);
  git("config", "uploadpack.allowFilter", "true");
  const files = trackedFiles();
  if (files !== fixture.files) {
    throw new Error(`history origin has ${files} tracked files, expected ${fixture.files}`);
  }
  return { gitDir: ORIGIN, head: HISTORY_REVISION, files };
}
