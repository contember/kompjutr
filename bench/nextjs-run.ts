import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GitError } from "../packages/git/src/common/errors.js";
import { harness, type ScenarioContext } from "./harness.js";
import { nextjsNetwork } from "./nextjs-network.js";
import { NEXTJS_WORKFLOW } from "./nextjs-workflow.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const networkMode = process.env.BENCH_NETWORK_MODE;
if (networkMode !== undefined && networkMode !== "legacy" && networkMode !== "mapped") {
  throw new Error("BENCH_NETWORK_MODE must be legacy or mapped");
}
const scenario = networkMode === undefined ? NEXTJS_WORKFLOW : nextjsNetwork(networkMode);

interface Result {
  operation: string;
  status: "ok" | "error";
  wallMs: number;
  statements: number;
  rows: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  peakWasReset: boolean;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  externalBeforeBytes: number;
  externalAfterBytes: number;
  error?: string;
}

function resetPeakRss(): boolean {
  try {
    writeFileSync("/proc/self/clear_refs", "5");
    return true;
  } catch {
    return false;
  }
}

function peakRssBytes(): number {
  const status = readFileSync("/proc/self/status", "utf8");
  const line = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  if (line === null) throw new Error("VmHWM is not available on this kernel");
  return Number(line[1]) * 1024;
}

function message(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    if (typeof current !== "object" || current === null) break;
    const cause = Reflect.get(current, "cause");
    if (cause === undefined) break;
    current = cause;
  }
  return parts.join(" <- ");
}

function mayContinue(operation: string, error: unknown): boolean {
  if (operation.startsWith("git.status") || operation.startsWith("git.diff")) return true;
  return (
    operation.startsWith("git.checkout") && error instanceof GitError && error.code === "E2BIG"
  );
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function markdown(results: readonly Result[]): string {
  const lines = [
    "# Next.js workflow benchmark",
    "",
    "Fixture: `vercel/next.js` at `v15.5.2`, rebuilt as one shallow-cloneable commit with 24,252 tracked files.",
    "The local Smart HTTP origin is prepared outside measurement. Clone includes protocol, pack ingest, index, and checkout.",
    "SQLite uses a temporary file, matching persisted Durable Object storage instead of retaining the database in process memory.",
    "Each operation resets SQLite counters and the process RSS high-water mark.",
    "",
    "| operation | status | wall ms | SQL | rows returned | peak RSS added | heap delta | external delta | error |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.operation} | ${result.status} | ${result.wallMs.toFixed(1)} | ${result.statements} | ${result.rows} | ` +
        `${megabytes(result.peakRssBytes - result.baselineRssBytes)} MiB | ` +
        `${megabytes(result.heapAfterBytes - result.heapBeforeBytes)} MiB | ` +
        `${megabytes(result.externalAfterBytes - result.externalBeforeBytes)} MiB | ` +
        `${result.error?.replaceAll("|", "\\|") ?? ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const databaseDir = mkdtempSync(join(tmpdir(), "kompjutr-nextjs-bench-"));
const databasePath = join(databaseDir, "workspace.sqlite");
const context: ScenarioContext = {
  harness: harness("sqlite", databasePath),
  databasePath,
  count: 0,
  variant: "nextjs",
};
const results: Result[] = [];
try {
  await scenario.setup(context);
  for (const phase of scenario.phases) {
    await phase.before?.(context);
    const peakWasReset = resetPeakRss();
    if (networkMode !== undefined && !peakWasReset) throw new Error("could not reset VmHWM");
    const baselineRssBytes = peakRssBytes();
    const before = process.memoryUsage();
    context.harness.storage.resetCounters();
    const started = performance.now();
    let failure: unknown;
    try {
      await phase.run(context);
    } catch (error) {
      failure = error;
    }
    const after = process.memoryUsage();
    const result: Result = {
      operation: phase.name,
      status: failure === undefined ? "ok" : "error",
      wallMs: performance.now() - started,
      statements: context.harness.storage.statementCount,
      rows: context.harness.storage.rowCount,
      baselineRssBytes,
      peakRssBytes: peakRssBytes(),
      peakWasReset,
      heapBeforeBytes: before.heapUsed,
      heapAfterBytes: after.heapUsed,
      externalBeforeBytes: before.external,
      externalAfterBytes: after.external,
    };
    if (failure !== undefined) result.error = message(failure);
    if (failure === undefined) {
      try {
        await phase.verify?.(context);
      } catch (error) {
        failure = error;
        result.status = "error";
        result.error = message(error);
      }
    }
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (process.env.BENCH_CLONE_ONLY === "1") break;
    if (failure !== undefined && !mayContinue(phase.name, failure)) break;
  }
} finally {
  await scenario.teardown?.(context);
  if (process.env.BENCH_KEEP_DATABASE === "1") {
    process.stderr.write(`[benchmark-database] ${databaseDir}\n`);
  } else {
    rmSync(databaseDir, { recursive: true, force: true });
  }
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, `${scenario.name}.json`), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(join(RESULTS, `${scenario.name}.md`), markdown(results));
if (results.some((result) => result.status === "error")) process.exitCode = 1;
