import { readFileSync } from "node:fs";
import { join } from "node:path";

import { startGitServer } from "../tests/helpers/http-backend.js";
import {
  FIXTURES,
  type FixtureEntry,
  ORIGIN_BRANCH,
  prepareFixture,
  trackedEntries,
} from "./fixtures.js";
import type { Scenario } from "./harness.js";

const REPO = "/repo";
const CHANGE_COUNT = 100;
const MAX_SAMPLE_BYTES = 64 * 1024;
const TEXT_FILE = /\.(?:c|css|go|h|html|js|jsx|md|mjs|rs|sh|toml|ts|tsx|txt|yaml|yml)$/i;
const MARKER_PREFIX = "/* nextjs workflow benchmark change ";

interface Sample {
  path: string;
  workspacePath: string;
  content: Uint8Array;
  changed: Uint8Array;
  mode: number;
}

let origin: { url: string; close(): Promise<void> } | null = null;
let sample: Sample[] = [];

function changed(content: Uint8Array, index: number): Uint8Array {
  const marker = new TextEncoder().encode(`\n${MARKER_PREFIX}${index} */\n`);
  const result = new Uint8Array(content.byteLength + marker.byteLength);
  result.set(content);
  result.set(marker, content.byteLength);
  return result;
}

function collectSample(dir: string, entries: readonly FixtureEntry[]): Sample[] {
  const result: Sample[] = [];
  for (const entry of entries) {
    if (result.length === CHANGE_COUNT) break;
    if (entry.mode === 0o120000 || !TEXT_FILE.test(entry.path)) continue;
    const content = new Uint8Array(readFileSync(join(dir, entry.path)));
    if (content.byteLength > MAX_SAMPLE_BYTES) continue;
    result.push({
      path: entry.path,
      workspacePath: `${REPO}/${entry.path}`,
      content,
      changed: changed(content, result.length),
      mode: entry.mode & 0o777,
    });
  }
  if (result.length !== CHANGE_COUNT) {
    throw new Error(`Next.js fixture has ${result.length} sampleable files, needs ${CHANGE_COUNT}`);
  }
  return result;
}

function expectStatus(
  rows: readonly { path: string; index: string; worktree: string }[],
  index: string,
  worktree: string,
  label: string,
): void {
  if (
    rows.length === CHANGE_COUNT &&
    rows.every((row) => row.index === index && row.worktree === worktree)
  ) {
    return;
  }
  throw new Error(`${label} returned ${rows.length} entries with unexpected state`);
}

function expectClean(rows: readonly { path: string }[], label: string): void {
  if (rows.length === 0) return;
  throw new Error(`${label} returned ${rows.length} entries, expected none`);
}

function traceCloneMemory(message: string): void {
  if (process.env.BENCH_MEMORY_TRACE !== "1") return;
  if (!message.startsWith("Receiving objects:") && !message.startsWith("Resolved ")) return;
  const memory = process.memoryUsage();
  process.stderr.write(
    `[clone-memory] ${message.trim()} rss=${memory.rss} heap=${memory.heapUsed} external=${memory.external}\n`,
  );
}

export const NEXTJS_WORKFLOW: Scenario = {
  name: "nextjs-workflow",
  kind: "macro",
  async setup() {
    const fixture = FIXTURES.nextjs;
    const dir = prepareFixture(fixture);
    sample = collectSample(dir, trackedEntries(dir));
    origin = await startGitServer(join(dir, ".git"));
  },
  phases: [
    {
      name: "git.clone",
      async run({ harness }) {
        if (origin === null) throw new Error("Next.js origin was not started");
        await harness.git.clone({
          url: origin.url,
          dir: REPO,
          ref: ORIGIN_BRANCH,
          depth: 1,
          singleBranch: true,
          onMessage: traceCloneMemory,
        });
      },
    },
    {
      name: "git.status (clean clone)",
      async run({ harness }) {
        expectClean(await harness.git.status({ dir: REPO }), "clean clone status");
      },
    },
    {
      name: "git.branch",
      async run({ harness }) {
        await harness.git.branch({ dir: REPO, name: "bench-work", checkout: true });
      },
    },
    {
      name: "fs.writeFiles (100)",
      async run({ harness }) {
        await harness.workspace.fs.writeFiles(
          sample.map((entry) => ({
            path: entry.workspacePath,
            content: entry.changed,
            mode: entry.mode,
          })),
        );
      },
    },
    {
      name: "git.status (100 modified)",
      async run({ harness }) {
        expectStatus(await harness.git.status({ dir: REPO }), " ", "M", "dirty status");
      },
    },
    {
      name: "git.diffSummary (100)",
      async run({ harness }) {
        const rows = await harness.git.diffSummary({ dir: REPO });
        if (rows.length !== CHANGE_COUNT) {
          throw new Error(`diffSummary returned ${rows.length}, expected ${CHANGE_COUNT}`);
        }
      },
    },
    {
      name: "git.diff (100)",
      async run({ harness }) {
        const patch = await harness.git.diff({ dir: REPO });
        const markers = patch.split(MARKER_PREFIX).length - 1;
        if (markers !== CHANGE_COUNT) {
          throw new Error(`diff returned ${markers} change markers, expected ${CHANGE_COUNT}`);
        }
      },
    },
    {
      name: "git.add (100)",
      async run({ harness }) {
        await harness.git.add({ dir: REPO, paths: sample.map((entry) => entry.path) });
      },
    },
    {
      name: "git.status (100 staged)",
      async run({ harness }) {
        expectStatus(await harness.git.status({ dir: REPO }), "M", " ", "staged status");
      },
    },
    {
      name: "git.commit (100)",
      async run({ harness }) {
        await harness.git.commit({ dir: REPO, message: "Benchmark 100-file change" });
      },
    },
    {
      name: "git.status (clean commit)",
      async run({ harness }) {
        expectClean(await harness.git.status({ dir: REPO }), "post-commit status");
      },
    },
    {
      name: "git.checkout main",
      async run({ harness }) {
        await harness.git.checkout({ dir: REPO, ref: ORIGIN_BRANCH });
      },
    },
    {
      name: "git.checkout main (force)",
      async run({ harness }) {
        await harness.git.checkout({ dir: REPO, ref: ORIGIN_BRANCH, force: true });
      },
    },
    {
      name: "git.status (clean main)",
      async run({ harness }) {
        expectClean(await harness.git.status({ dir: REPO }), "main status");
      },
    },
    {
      name: "git.checkout bench-work",
      async run({ harness }) {
        await harness.git.checkout({ dir: REPO, ref: "bench-work" });
      },
    },
    {
      name: "git.checkout bench-work (force)",
      async run({ harness }) {
        await harness.git.checkout({ dir: REPO, ref: "bench-work", force: true });
      },
    },
    {
      name: "git.status (clean work)",
      async run({ harness }) {
        expectClean(await harness.git.status({ dir: REPO }), "work branch status");
      },
    },
  ],
  async teardown() {
    await origin?.close();
    origin = null;
    sample = [];
  },
};
