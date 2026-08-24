// The macro suite: the same repositories, the same operations and the same
// order as the DOFS experiment recorded in `docs/archive/benchmarks/benchmark-reference.md`,
// so a row here can be read against a row there.
//
// It is split in two scenarios rather than one. The reference deleted
// `.git` mid-run to move from packed objects to loose ones; kompjutr has no
// `.git` to delete, so the loose half starts from a fresh workspace with
// the same files in it. Each half is one process, which also keeps the two
// halves' memory apart.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { startGitServer } from "../tests/helpers/http-backend.js";
import {
  FIXTURES,
  type FixtureEntry,
  materialize,
  ORIGIN_BRANCH,
  prepareFixture,
  trackedEntries,
} from "./fixtures.js";
import { fixtureNameOf, type Scenario, type ScenarioContext } from "./harness.js";

const REPO = "/repo";
/** The reference sampled 50 files for its diff and bulk-read operations. */
const SAMPLE_FILES = 50;
const MAX_SAMPLE_BYTES = 64 * 1024;
const TEXT_FILE = /\.(?:c|css|go|h|html|js|json|jsx|md|mjs|rs|sh|toml|ts|tsx|txt|yaml|yml)$/i;

interface Sample {
  /** Workspace path, not the path on disk. */
  path: string;
  content: Uint8Array;
  /**
   * Carried explicitly: `writeFile` without a mode resets an existing file to
   * 0644, and losing the executable bit would leave the tree modified after
   * the restore.
   */
  mode: number;
}

// One process runs one scenario, so the fixture a scenario resolved in
// `setup` is still the one its phases see.
let origin: { url: string; close(): Promise<void> } | null = null;
let sample: Sample[] = [];

function entriesFor(context: ScenarioContext): { dir: string; entries: FixtureEntry[] } {
  const fixture = FIXTURES[fixtureNameOf(context.variant)];
  const dir = prepareFixture(fixture);
  const all = trackedEntries(dir);
  return { dir, entries: context.count > 0 ? all.slice(0, context.count) : all };
}

/** The reference's sample: the first readable text files under 64 KB. */
function collectSample(dir: string, entries: readonly FixtureEntry[]): Sample[] {
  const collected: Sample[] = [];
  for (const entry of entries) {
    if (collected.length === SAMPLE_FILES) break;
    if (entry.mode === 0o120000) continue;
    if (!TEXT_FILE.test(entry.path)) continue;
    const content = new Uint8Array(readFileSync(join(dir, entry.path)));
    if (content.byteLength > MAX_SAMPLE_BYTES) continue;
    collected.push({ path: `${REPO}/${entry.path}`, content, mode: entry.mode & 0o777 });
  }
  if (collected.length < SAMPLE_FILES) {
    throw new Error(`fixture has ${collected.length} sampleable files, needs ${SAMPLE_FILES}`);
  }
  return collected;
}

function changed(content: Uint8Array, index: number): Uint8Array {
  const marker = new TextEncoder().encode(`\n/* macro benchmark change ${index} */\n`);
  const out = new Uint8Array(content.byteLength + marker.byteLength);
  out.set(content);
  out.set(marker, content.byteLength);
  return out;
}

function expectClean(rows: readonly { path: string }[], label: string): void {
  if (rows.length === 0) return;
  const shown = rows
    .slice(0, 5)
    .map((row) => row.path)
    .join(", ");
  throw new Error(`${label} reported ${rows.length} entries, expected 0: ${shown}`);
}

export const MACRO: Scenario[] = [
  {
    // Objects arrive in a packfile, the way a clone delivers them.
    name: "macro-packed",
    kind: "macro",
    async setup(context) {
      const fixture = FIXTURES[fixtureNameOf(context.variant)];
      const dir = prepareFixture(fixture);
      origin = await startGitServer(join(dir, ".git"));
    },
    phases: [
      {
        // Not in the reference: it cloned outside its measured region.
        name: "git.clone",
        async run({ harness }) {
          if (origin === null) throw new Error("origin was not started");
          await harness.git.clone({
            url: origin.url,
            dir: REPO,
            ref: ORIGIN_BRANCH,
            depth: 1,
            singleBranch: true,
          });
        },
      },
      {
        name: "git.status (packed)",
        async run({ harness }) {
          expectClean(await harness.git.status({ dir: REPO }), "packed status");
        },
      },
    ],
    async teardown() {
      await origin?.close();
      origin = null;
    },
  },
  {
    // Objects are written locally, the way staging and committing create
    // them. The reference reached this state by deleting `.git` and
    // re-initialising over the same checkout.
    name: "macro-loose",
    kind: "macro",
    async setup(context) {
      const { dir, entries } = entriesFor(context);
      sample = collectSample(dir, entries);
      await materialize(context.harness, REPO, dir, entries);
      await context.harness.git.init({ dir: REPO });
    },
    phases: [
      {
        name: "git.add (all)",
        async run({ harness }) {
          await harness.git.add({ dir: REPO, paths: [], all: true });
        },
      },
      {
        name: "git.commit",
        async run({ harness }) {
          await harness.git.commit({ dir: REPO, message: "Create loose fixture" });
        },
      },
      {
        name: "git.diffSummary",
        async before({ harness }) {
          for (const [index, entry] of sample.entries()) {
            await harness.workspace.fs.writeFile(entry.path, changed(entry.content, index), {
              mode: entry.mode,
            });
          }
        },
        async run({ harness }) {
          const rows = await harness.git.diffSummary({ dir: REPO });
          if (rows.length !== SAMPLE_FILES) {
            throw new Error(`diffSummary reported ${rows.length}, expected ${SAMPLE_FILES}`);
          }
        },
      },
      {
        name: "git.status (loose)",
        async before({ harness }) {
          for (const entry of sample) {
            await harness.workspace.fs.writeFile(entry.path, entry.content, { mode: entry.mode });
          }
        },
        async run({ harness }) {
          expectClean(await harness.git.status({ dir: REPO }), "loose status");
        },
      },
    ],
  },
];
