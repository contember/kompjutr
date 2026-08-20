// The parent: spawns one child per scenario, optionally inside a cgroup
// with a hard memory limit, and writes the results out.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Backend, Shape } from "./scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

interface Run {
  scenario: string;
  backend: Backend;
  count: number;
  shape: Shape;
  wallMs: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  /** False when the kernel would not reset VmHWM, making the delta a lower bound. */
  peakWasReset: boolean;
  statements: number;
  rows: number;
}

type Outcome =
  | (Run & { status: "ok" })
  | ({ status: "oom" | "error"; detail: string } & Partial<Run>);

interface Options {
  smoke: boolean;
  /** Working memory allowed above the runner's own footprint, in MB. 0 disables the cap. */
  budgetMb: number;
}

function parseOptions(argv: string[]): Options {
  const smoke = argv.includes("--smoke");
  const budgetArg = argv.find((arg) => arg.startsWith("--budget="));
  return { smoke, budgetMb: budgetArg === undefined ? 0 : Number(budgetArg.split("=")[1]) };
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
function command(args: string[], capBytes: number | null): { file: string; argv: string[] } {
  const node = [
    "--experimental-transform-types",
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

function once(
  scenario: string,
  backend: Backend,
  count: number,
  shape: Shape,
  capBytes: number | null,
): Outcome {
  const { file, argv } = command([scenario, backend, String(count), shape], capBytes);
  const result = spawnSync(file, argv, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (result.status === 137 || result.signal === "SIGKILL") {
    return { status: "oom", detail: `killed at MemoryMax`, scenario, backend, count, shape };
  }
  const line = result.stdout.split("\n").find((text) => text.startsWith("{"));
  if (line === undefined) {
    const detail = (result.stderr || result.stdout || "no output")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ");
    return { status: "error", detail, scenario, backend, count, shape };
  }
  const parsed = parseRun(line);
  if (parsed === null) {
    return { status: "error", detail: "unreadable result line", scenario, backend, count, shape };
  }
  return { ...parsed, status: "ok" };
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
  const { scenario, backend, shape } = record;
  if (typeof scenario !== "string") return null;
  if (typeof record.peakWasReset !== "boolean") return null;
  if (backend !== "dofs" && backend !== "sqlite") return null;
  if (shape !== "flat" && shape !== "deep") return null;
  return {
    scenario,
    backend,
    shape,
    count: Number(record.count),
    wallMs: Number(record.wallMs),
    baselineRssBytes: Number(record.baselineRssBytes),
    peakRssBytes: Number(record.peakRssBytes),
    peakWasReset: record.peakWasReset === true,
    statements: Number(record.statements),
    rows: Number(record.rows),
  };
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

function table(outcomes: Outcome[]): string {
  const lines = [
    "| scenario | shape | N | backend | wall ms | peak RSS added | statements | outcome |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const outcome of outcomes) {
    const added =
      outcome.status === "ok" && outcome.peakRssBytes !== undefined
        ? `${mb(outcome.peakRssBytes - (outcome.baselineRssBytes ?? 0))} MB`
        : "—";
    lines.push(
      `| ${outcome.scenario ?? "?"} | ${outcome.shape ?? "?"} | ${outcome.count ?? "?"} | ${outcome.backend ?? "?"} | ` +
        `${outcome.status === "ok" ? outcome.wallMs : "—"} | ${added} | ` +
        `${outcome.status === "ok" ? outcome.statements : "—"} | ` +
        `${outcome.status === "ok" ? "ok" : `**${outcome.status}** ${"detail" in outcome ? outcome.detail : ""}`} |`,
    );
  }
  return lines.join("\n");
}

const options = parseOptions(process.argv.slice(2));
const backends: Backend[] = ["dofs", "sqlite"];
const shapes: Shape[] = ["flat", "deep"];
const counts = options.smoke ? [50, 200] : [100, 250, 500, 1000, 2500, 5000, 10000];
const scenarios = options.smoke
  ? ["add-commit", "status-clean"]
  : ["add-commit", "status-clean", "status-dirty", "checkout", "log"];

const outcomes: Outcome[] = [];
for (const scenario of scenarios) {
  for (const shape of shapes) {
    for (const count of counts) {
      for (const backend of backends) {
        // The cap needs the runner's own footprint, which only a real run knows.
        // The uncapped pass supplies it; the capped pass then means something.
        const probe = once(scenario, backend, count, shape, null);
        outcomes.push(probe);
        if (options.budgetMb > 0 && probe.status === "ok") {
          const cap = (probe.baselineRssBytes ?? 0) + options.budgetMb * 1024 * 1024;
          const capped = once(scenario, backend, count, shape, cap);
          if (capped.status !== "ok") outcomes.push(capped);
        }
        process.stderr.write(`${scenario} ${shape} ${count} ${backend}: ${probe.status}\n`);
      }
    }
  }
}

mkdirSync(RESULTS, { recursive: true });
const stamp = process.env.BENCH_STAMP ?? "latest";
writeFileSync(join(RESULTS, `${stamp}.json`), `${JSON.stringify(outcomes, null, 2)}\n`);
const header = [
  `# kompjutr benchmark — ${options.smoke ? "smoke" : "full"} sweep`,
  "",
  `Files are ${4096} bytes each. "peak RSS added" is the kernel's VmHWM after the`,
  "measured operation minus VmHWM after setup, so the fixture's cost is excluded.",
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
