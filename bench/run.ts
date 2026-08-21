// The parent: spawns one child per scenario, optionally inside a cgroup
// with a hard memory limit, and writes the results out.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURE_NAMES, FIXTURES } from "./fixtures.js";
import { asVariant, type Backend, isShape, SCENARIOS, type Variant } from "./scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

interface Run {
  scenario: string;
  /** The measured operation. Equal to the scenario name for the synthetic ones. */
  operation: string;
  backend: Backend;
  count: number;
  variant: Variant;
  wallMs: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  /** False when the kernel would not reset VmHWM, making the delta a lower bound. */
  peakWasReset: boolean;
  /** Smallest old-space the cell completed in, when --min-heap ran. */
  minHeapMb?: number;
  statements: number;
  rows: number;
}

type Outcome =
  | (Run & { status: "ok" })
  | ({ status: "oom" | "error"; detail: string } & Partial<Run>);

interface Cell {
  outcomes: Outcome[];
  /** Every phase reported. A partial cell is a failure, whatever it printed. */
  complete: boolean;
}

interface Options {
  smoke: boolean;
  /** Working memory allowed above the runner's own footprint, in MB. 0 disables the cap. */
  budgetMb: number;
  counts: number[] | null;
  scenarios: string[] | null;
  backends: Backend[] | null;
  variants: Variant[] | null;
  /** Repeats per cell. A resident high-water mark is noisy; the median is reported. */
  repeat: number;
  /** Bisect the smallest V8 old-space each cell completes in. */
  minHeap: boolean;
}

function listOption(argv: string[], name: string): string[] | null {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (found === undefined) return null;
  return found.slice(name.length + 3).split(",");
}

function asBackend(value: string): Backend {
  if (value === "sqlite") return value;
  throw new Error(`unknown backend: ${value}`);
}

function parseOptions(argv: string[]): Options {
  const budgetArg = argv.find((arg) => arg.startsWith("--budget="));
  const counts = listOption(argv, "counts");
  const variants = listOption(argv, "variants") ?? listOption(argv, "fixtures");
  return {
    smoke: argv.includes("--smoke"),
    budgetMb: budgetArg === undefined ? 0 : Number(budgetArg.split("=")[1]),
    counts: counts === null ? null : counts.map(Number),
    scenarios: listOption(argv, "scenarios"),
    backends: (listOption(argv, "backends") ?? null)?.map(asBackend) ?? null,
    variants: variants === null ? null : variants.map(asVariant),
    repeat: Number(argv.find((arg) => arg.startsWith("--repeat="))?.split("=")[1] ?? "1"),
    minHeap: argv.includes("--min-heap"),
  };
}

/**
 * A Durable Object's 128 MB covers the whole isolate, so `--max-old-space-size`
 * is the wrong instrument — it bounds only V8's old space and lets external and
 * ArrayBuffer memory run away unmeasured. A cgroup bounds all of it.
 *
 * The cap is the runner's own footprint plus the budget, because bare node with
 * this module graph already costs well over 100 MB before any git work. Without
 * that offset an empty run would be killed and the number would be nonsense.
 */
function command(
  args: string[],
  capBytes: number | null,
  heapMb: number | null = null,
): { file: string; argv: string[] } {
  const node = [
    "--experimental-transform-types",
    ...(heapMb === null
      ? []
      : // A tight young generation too, so the figure is what the workload
        // needs rather than what the collector felt like keeping.
        [`--max-old-space-size=${heapMb}`, "--max-semi-space-size=1"]),
    "--import",
    join(HERE, "register.mjs"),
    join(HERE, "child.ts"),
    ...args,
  ];
  if (capBytes === null) return { file: process.execPath, argv: node };
  return {
    file: "systemd-run",
    argv: [
      "--user",
      "--scope",
      "-p",
      `MemoryMax=${Math.round(capBytes / 1024 / 1024)}M`,
      "--quiet",
      "--",
      process.execPath,
      ...node,
    ],
  };
}

function phaseCount(scenario: string): number {
  return SCENARIOS.find((candidate) => candidate.name === scenario)?.phases.length ?? 1;
}

function once(
  scenario: string,
  backend: Backend,
  count: number,
  variant: Variant,
  capBytes: number | null,
  heapMb: number | null = null,
): Cell {
  const { file, argv } = command([scenario, backend, String(count), variant], capBytes, heapMb);
  const result = spawnSync(file, argv, { encoding: "utf8", maxBuffer: 1 << 26 });
  const identity = { scenario, backend, count, variant };
  if (result.status === 137 || result.signal === "SIGKILL") {
    return {
      outcomes: [{ status: "oom", detail: "killed at MemoryMax", ...identity }],
      complete: false,
    };
  }
  const rows = result.stdout
    .split("\n")
    .filter((text) => text.startsWith("{"))
    .map(parseRun)
    .filter((run): run is Run => run !== null);
  const complete = rows.length === phaseCount(scenario) && result.status === 0;
  if (complete) return { outcomes: rows.map((run) => ({ ...run, status: "ok" })), complete };

  const detail = (result.stderr || result.stdout || "no output")
    .trim()
    .split("\n")
    .slice(-3)
    .join(" | ");
  return {
    outcomes: [
      ...rows.map((run): Outcome => ({ ...run, status: "ok" })),
      { status: "error", detail, ...identity },
    ],
    complete: false,
  };
}

/** The child's own JSON, validated rather than asserted. */
function parseRun(line: string): Run | null {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null) return null;
  const record: Record<string, unknown> = { ...value };
  const numbers = ["count", "wallMs", "baselineRssBytes", "peakRssBytes", "statements", "rows"];
  for (const key of numbers) {
    if (typeof record[key] !== "number") return null;
  }
  const { scenario, operation, backend, variant } = record;
  if (typeof scenario !== "string" || typeof operation !== "string") return null;
  if (typeof variant !== "string") return null;
  if (typeof record.peakWasReset !== "boolean") return null;
  if (backend !== "sqlite") return null;
  return {
    scenario,
    operation,
    backend,
    variant: asVariant(variant),
    count: Number(record.count),
    wallMs: Number(record.wallMs),
    baselineRssBytes: Number(record.baselineRssBytes),
    peakRssBytes: Number(record.peakRssBytes),
    peakWasReset: record.peakWasReset === true,
    statements: Number(record.statements),
    rows: Number(record.rows),
  };
}

function peakDelta(cell: Cell): number {
  let total = 0;
  for (const outcome of cell.outcomes) {
    if (outcome.status !== "ok") continue;
    total += outcome.peakRssBytes - outcome.baselineRssBytes;
  }
  return total;
}

/**
 * The median of `repeat` runs. VmHWM is a high-water mark, so it moves with
 * when the collector happened to run, not only with what the code allocated —
 * a single reading of it is not a measurement.
 */
function repeated(
  scenario: string,
  backend: Backend,
  count: number,
  variant: Variant,
  repeat: number,
): Cell {
  const runs: Cell[] = [];
  for (let i = 0; i < repeat; i++) runs.push(once(scenario, backend, count, variant, null));
  const complete = runs.filter((run) => run.complete);
  if (complete.length === 0) return runs[0] ?? { outcomes: [], complete: false };
  complete.sort((left, right) => peakDelta(left) - peakDelta(right));
  const median = complete[Math.floor(complete.length / 2)];
  return median ?? { outcomes: [], complete: false };
}

/**
 * The smallest V8 old-space the workload completes in, by bisection.
 *
 * Peak RSS cannot resolve this: it is a high-water mark that moves with when
 * the collector ran, and repeated medians of the same cell landed 40 MB apart.
 * Under a heap cap V8 collects harder instead of growing, so what survives is
 * what the object graph actually needs. This bounds the JS side only —
 * ArrayBuffers and node:sqlite pages live outside old space, which is why the
 * cgroup pass exists as well.
 */
function minimumHeapMb(
  scenario: string,
  backend: Backend,
  count: number,
  variant: Variant,
): number | null {
  let low = 4;
  // A real repository puts the baseline well past a gigabyte, and a ceiling
  // it cannot reach reports "no number" instead of the number.
  let high = 4096;
  if (!once(scenario, backend, count, variant, null, high).complete) return null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (once(scenario, backend, count, variant, null, middle).complete) high = middle;
    else low = middle + 1;
  }
  return low;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

function table(outcomes: Outcome[]): string {
  const lines = [
    "| operation | variant | N | backend | wall ms | statements | rows | peak RSS added | min heap | outcome |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const outcome of outcomes) {
    const added =
      outcome.status === "ok" && outcome.peakRssBytes !== undefined
        ? `${mb(outcome.peakRssBytes - (outcome.baselineRssBytes ?? 0))} MB`
        : "—";
    lines.push(
      `| ${outcome.operation ?? outcome.scenario ?? "?"} | ${outcome.variant ?? "?"} | ${outcome.count ?? "?"} | ${outcome.backend ?? "?"} | ` +
        `${outcome.status === "ok" ? outcome.wallMs : "—"} | ` +
        `${outcome.status === "ok" ? outcome.statements : "—"} | ` +
        `${outcome.status === "ok" ? outcome.rows : "—"} | ${added} | ` +
        `${outcome.minHeapMb === undefined ? "—" : `${outcome.minHeapMb} MB`} | ` +
        `${outcome.status === "ok" ? "ok" : `**${outcome.status}** ${"detail" in outcome ? outcome.detail : ""}`} |`,
    );
  }
  return lines.join("\n");
}

const options = parseOptions(process.argv.slice(2));
const backends: Backend[] = options.backends ?? ["sqlite"];
const scenarios =
  options.scenarios ??
  (options.smoke
    ? ["add-commit", "status-clean"]
    : ["add-commit", "status-clean", "status-dirty", "checkout", "log"]);

/** Synthetic cells vary the tree shape; macro cells vary the repository. */
function variantsFor(kind: "synthetic" | "macro"): Variant[] {
  const chosen = options.variants?.filter((variant) =>
    kind === "synthetic" ? isShape(variant) : !isShape(variant),
  );
  if (chosen !== undefined && chosen.length > 0) return chosen;
  if (kind === "synthetic") return ["flat", "deep"];
  return options.smoke ? ["express"] : ["prettier"];
}

/** For a macro cell `count` caps the tracked files; 0 means the whole tree. */
function countsFor(kind: "synthetic" | "macro"): number[] {
  if (options.counts !== null) return options.counts;
  if (kind === "macro") return [0];
  return options.smoke ? [50, 200] : [100, 250, 500, 1000, 2500, 5000, 10000];
}

const outcomes: Outcome[] = [];
for (const scenario of scenarios) {
  const kind = SCENARIOS.find((candidate) => candidate.name === scenario)?.kind ?? "synthetic";
  for (const variant of variantsFor(kind)) {
    for (const count of countsFor(kind)) {
      for (const backend of backends) {
        // The cap needs the runner's own footprint, which only a real run knows.
        // The uncapped pass supplies it; the capped pass then means something.
        const probe = repeated(scenario, backend, count, variant, options.repeat);
        if (options.minHeap && probe.complete) {
          const found = minimumHeapMb(scenario, backend, count, variant);
          for (const outcome of probe.outcomes) {
            if (found !== null && outcome.status === "ok") outcome.minHeapMb = found;
          }
        }
        outcomes.push(...probe.outcomes);
        if (options.budgetMb > 0 && probe.complete) {
          const first = probe.outcomes[0];
          const floor = first !== undefined && first.status === "ok" ? first.baselineRssBytes : 0;
          const capped = once(
            scenario,
            backend,
            count,
            variant,
            floor + options.budgetMb * 1024 * 1024,
          );
          if (!capped.complete)
            outcomes.push(...capped.outcomes.filter((row) => row.status !== "ok"));
        }
        process.stderr.write(
          `${scenario} ${variant} ${count} ${backend}: ${probe.complete ? "ok" : "failed"}\n`,
        );
      }
    }
  }
}

mkdirSync(RESULTS, { recursive: true });
const stamp = process.env.BENCH_STAMP ?? "latest";
writeFileSync(join(RESULTS, `${stamp}.json`), `${JSON.stringify(outcomes, null, 2)}\n`);
const macroVariants = variantsFor("macro").filter((variant) => !isShape(variant));
const header = [
  `# kompjutr benchmark — ${options.smoke ? "smoke" : "full"} sweep`,
  "",
  'Synthetic files are 4096 bytes each. "peak RSS added" is the kernel\'s VmHWM',
  "after the measured operation minus VmHWM after setup, so the fixture's cost is",
  "excluded.",
  "",
  ...macroVariants.map((variant) => {
    if (isShape(variant)) return "";
    const fixture = FIXTURES[variant];
    return `Fixture \`${variant}\`: ${fixture.url} at \`${fixture.ref}\`, ${fixture.files} tracked files upstream.`;
  }),
  "",
  options.budgetMb > 0
    ? `Ceiling runs used a cgroup MemoryMax of the runner's own footprint plus ${options.budgetMb} MB of`
    : "No memory cap was applied; pass --budget=<MB> for ceiling runs.",
  options.budgetMb > 0 ? "working memory. Only failures are listed for the capped pass." : "",
  "",
  "**This is node:sqlite, not Durable Object SQL.** The curve and the statement",
  "counts transfer; an absolute Durable Object ceiling does not. Nothing here",
  "claims one.",
  "",
];
writeFileSync(join(RESULTS, `${stamp}.md`), `${header.join("\n")}\n${table(outcomes)}\n`);
process.stderr.write(`\nwrote ${join(RESULTS, `${stamp}.md`)}\n`);
process.stderr.write(`fixtures available: ${FIXTURE_NAMES.join(", ")}\n`);
