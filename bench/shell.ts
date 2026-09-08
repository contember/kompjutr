// Shell scenarios: the commands an agent actually issues, measured the way
// everything else here is — statements first, wall time second.
//
// The pair that matters is `shell-grep-literal` against `shell-grep-regex`.
// They search the same tree for the same files; one is a substring, so the
// match is a SQL predicate, and one is an expression, so SQLite has nothing
// to push down to and every candidate file is read. The gap between the two
// rows is the content predicate, and it should widen with the file count.

import { createShell, type Shell } from "../packages/do/src/shell/index.js";
import type { Harness, Scenario, ScenarioContext, Shape } from "./harness.js";
import { shapeOf } from "./harness.js";
import { FILE_BYTES, pathFor } from "./synthetic.js";

/** One file in ten holds the needle, which is a realistic hit rate. */
const HIT_EVERY = 10;
const NEEDLE = "NEEDLE";

// One process runs one scenario, so the shell built in `setup` is the one
// the phases see.
let shell: Shell | null = null;

function current(): Shell {
  if (shell === null) throw new Error("scenario did not run setup");
  return shell;
}

/**
 * Write the tree in bulk rather than a file at a time.
 *
 * Setup is not measured, but it is still wall time, and the point of the
 * fixture is the tree it leaves behind — not the way it got there.
 */
function seed({ harness, count, variant }: ScenarioContext): void {
  const shape: Shape = shapeOf(variant);
  const body = "x".repeat(Math.max(0, FILE_BYTES - 64));
  const files = Array.from({ length: count }, (_, index) => ({
    path: pathFor(shape, index),
    bytes: new TextEncoder().encode(
      `${body}\n${index % HIT_EVERY === 0 ? `${NEEDLE} ${index}` : `plain ${index}`}\n`,
    ),
  }));
  harness.workspace.filesystem.writeFiles(files);
  shell = createShell({ fs: harness.workspace.filesystem, cwd: "/" });
}

/** Run a line and refuse to record a measurement of nothing. */
async function run(source: string, expect: "output" | "silent" = "output"): Promise<void> {
  const outcome = await current().run(source);
  if (expect === "output" && outcome.stdout === "") {
    throw new Error(`${source}: produced no output, so the measurement is empty`);
  }
  if (outcome.exitCode !== 0) {
    throw new Error(`${source}: exit ${outcome.exitCode}: ${outcome.stderr.trim()}`);
  }
}

function scenario(name: string, source: string, expect: "output" | "silent" = "output"): Scenario {
  return {
    name,
    kind: "synthetic",
    async setup(context: ScenarioContext) {
      seed(context);
    },
    phases: [
      {
        name,
        async run() {
          await run(source, expect);
        },
      },
    ],
  };
}

export const SHELL: Scenario[] = [
  // The predicate answers this one: no file's content reaches the isolate.
  scenario("shell-grep-literal", `grep -rl ${NEEDLE} /`),
  // The contrast. `NEED.E` is an expression, so every candidate is read.
  scenario("shell-grep-regex", "grep -rl 'NEED.E' /"),
  // Content mode still needs the matching files' bytes — but only theirs.
  scenario("shell-grep-lines", `grep -rn ${NEEDLE} /`),
  // A bounded pipeline: the consumer stops pulling and the search stops.
  scenario("shell-grep-head", `grep -rl ${NEEDLE} / | head -20`),
  // Path-only, so one indexed statement per page and no content at all.
  scenario("shell-find", "find / -name '*.txt'"),
  // A range delete: the target is the whole tree, and it should not care.
  scenario("shell-rm-rf", "rm -rf /d0 /f0.txt", "silent"),
];

export type { Harness };
