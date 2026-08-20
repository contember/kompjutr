// One scenario, one process. Never two, so nothing a previous scenario
// allocated can be mistaken for this one's peak.

import { readFileSync, writeFileSync } from "node:fs";

import { type Backend, harness, SCENARIOS, type Shape } from "./scenarios.js";

/**
 * Reset the kernel's resident high-water mark, so the figure taken after the
 * measured region describes that region and not the fixture that preceded it.
 * VmHWM never falls on its own, which otherwise reports 0 for any operation
 * cheaper than its own setup.
 */
function resetPeakRss(): boolean {
  try {
    writeFileSync("/proc/self/clear_refs", "5");
    return true;
  } catch {
    return false;
  }
}

/**
 * The kernel's own high-water mark for resident memory. A sampling timer
 * cannot see the peak of a long synchronous run; this can.
 */
function peakRssBytes(): number {
  const status = readFileSync("/proc/self/status", "utf8");
  const line = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  if (line === null) throw new Error("VmHWM is not available on this kernel");
  return Number(line[1]) * 1024;
}

function asBackend(value: string | undefined): Backend {
  if (value === "dofs" || value === "sqlite") return value;
  throw new Error(`unknown backend: ${String(value)}`);
}

function asShape(value: string | undefined): Shape {
  if (value === "flat" || value === "deep") return value;
  throw new Error(`unknown shape: ${String(value)}`);
}

const [, , name, backendArg, countArg, shapeArg] = process.argv;
const backend = asBackend(backendArg);
const shape = asShape(shapeArg);
const count = Number(countArg);
const scenario = SCENARIOS.find((candidate) => candidate.name === name);
if (scenario === undefined) throw new Error(`unknown scenario: ${name}`);

const context = { harness: harness(backend), count, shape };
await scenario.setup(context);

// Taken after setup and after the peak is reset, so the reported figure is
// what the measured operation itself added, not what the fixture cost.
const peakWasReset = resetPeakRss();
const baselineRss = peakRssBytes();
context.harness.storage.resetCounters();
const started = performance.now();
await scenario.run(context);
const wallMs = performance.now() - started;

process.stdout.write(
  `${JSON.stringify({
    scenario: name,
    backend,
    count,
    shape,
    wallMs: Math.round(wallMs),
    baselineRssBytes: baselineRss,
    peakRssBytes: peakRssBytes(),
    peakWasReset,
    statements: context.harness.storage.statementCount,
    rows: context.harness.storage.rowCount,
  })}\n`,
);
