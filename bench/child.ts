// One scenario, one process. Never two, so nothing a previous scenario
// allocated can be mistaken for this one's peak. A scenario's phases do
// share the process, and reset the peak between them.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asVariant, type Backend, harness } from "./harness.js";
import {
  type CgroupMemorySnapshot,
  deriveCgroupMemoryEvidence,
  type MemoryRunIdentity,
  memoryScenarioSpec,
  PROCESS_TRANSIENT_TARGET_BYTES,
  parseCpuList,
  type RuntimeEvidence,
  SQL_STATEMENT_TARGET,
  validateRuntimeEvidence,
} from "./memory-protocol.js";

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
  if (value === "sqlite") return value;
  throw new Error(`unknown backend: ${String(value)}`);
}

function option(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const values = argv.filter((arg) => arg.startsWith(prefix));
  if (values.length > 1) throw new Error(`duplicate --${name}`);
  return values[0]?.slice(prefix.length) ?? null;
}

function requiredOption(argv: readonly string[], name: string): string {
  const value = option(argv, name);
  if (value === null || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function cgroupPath(): string {
  const rows = readFileSync("/proc/self/cgroup", "utf8")
    .trim()
    .split("\n")
    .filter((row) => row.length > 0);
  const unified = rows.filter((row) => row.startsWith("0::"));
  if (unified.length !== 1) throw new Error("unified cgroup path is unavailable");
  const row = unified[0];
  if (row === undefined) throw new Error("unified cgroup path is unavailable");
  return row.slice(3);
}

function allowedCpus(): string {
  const line = readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith("Cpus_allowed_list:"));
  if (line === undefined) throw new Error("/proc/self/status has no Cpus_allowed_list");
  const value = line.slice("Cpus_allowed_list:".length).trim();
  parseCpuList(value);
  return value;
}

function cgroupLimit(path: string, file: string): number | null {
  const value = readFileSync(join("/sys/fs/cgroup", path, file), "utf8").trim();
  if (value === "max") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${file} is invalid`);
  return parsed;
}

function runtimeEvidence(): RuntimeEvidence {
  const path = cgroupPath();
  const swap = cgroupLimit(path, "memory.swap.max");
  if (swap === null) throw new Error("memory.swap.max is unbounded");
  return {
    allowedCpus: allowedCpus(),
    cgroupPath: path,
    memoryMaxBytes: cgroupLimit(path, "memory.max"),
    memorySwapMaxBytes: swap,
  };
}

function expectedMemoryMax(argv: readonly string[]): number | null {
  const value = requiredOption(argv, "expected-memory-max");
  if (value === "max") return null;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("expected memory max is invalid");
  return bytes;
}

function verifiedRuntime(argv: readonly string[]): RuntimeEvidence {
  const runtime = runtimeEvidence();
  validateRuntimeEvidence(runtime, {
    allowedCpus: requiredOption(argv, "expected-cpus"),
    scope: "benchmark",
    memoryMaxBytes: expectedMemoryMax(argv),
  });
  return runtime;
}

function storageFootprint(databasePath: string): number {
  let bytes = 0;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) bytes += statSync(path).size;
  }
  return bytes;
}

function cgroupFile(path: string, file: string): string {
  return join("/sys/fs/cgroup", path, file);
}

function cgroupNumber(path: string, file: string): number {
  const value = readFileSync(cgroupFile(path, file), "utf8").trim();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${file} is invalid`);
  return parsed;
}

function memoryStat(path: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of readFileSync(cgroupFile(path, "memory.stat"), "utf8").trim().split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) throw new Error("memory.stat contains a malformed row");
    const key = line.slice(0, separator);
    const value = Number(line.slice(separator + 1));
    if (result.has(key) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("memory.stat contains an invalid row");
    }
    result.set(key, value);
  }
  return result;
}

function requiredStat(stats: Map<string, number>, key: string): number {
  const value = stats.get(key);
  if (value === undefined) throw new Error(`memory.stat is missing ${key}`);
  return value;
}

function cgroupMemorySnapshot(runtime: RuntimeEvidence): CgroupMemorySnapshot {
  const stats = memoryStat(runtime.cgroupPath);
  return {
    currentBytes: cgroupNumber(runtime.cgroupPath, "memory.current"),
    peakBytes: cgroupNumber(runtime.cgroupPath, "memory.peak"),
    anonBytes: requiredStat(stats, "anon"),
    fileBytes: requiredStat(stats, "file"),
    kernelBytes: requiredStat(stats, "kernel"),
    shmemBytes: requiredStat(stats, "shmem"),
  };
}

function resetCgroupPeak(runtime: RuntimeEvidence): void {
  writeFileSync(cgroupFile(runtime.cgroupPath, "memory.peak"), "0");
}

const args = process.argv.slice(2);
if (args[0] === "--runtime-check") {
  process.stdout.write(`${JSON.stringify(verifiedRuntime(args.slice(1)))}\n`);
} else {
  const [name, backendArg, countArg, variantArg, ...childOptions] = args;
  if (name === undefined) throw new Error("scenario name is missing");
  const backend = asBackend(backendArg);
  const variant = asVariant(variantArg);
  const count = Number(countArg);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("count is invalid");
  const memoryStage = option(childOptions, "memory-stage");
  const candidates =
    memoryStage === null
      ? (await import("./scenarios.js")).SCENARIOS
      : (await import("./memory.js")).MEMORY;
  const scenario = candidates.find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`unknown scenario: ${name}`);
  const isMemory = scenario.kind === "memory";
  if (isMemory && memoryStage !== "calibration" && memoryStage !== "capped") {
    throw new Error("memory scenario requires a valid --memory-stage");
  }
  if (!isMemory && memoryStage !== null) throw new Error("ordinary scenario has a memory stage");
  const hasRuntimeExpectation = option(childOptions, "expected-cpus") !== null;
  const runtime = isMemory || hasRuntimeExpectation ? verifiedRuntime(childOptions) : null;
  const temporary = scenario.fileBacked
    ? mkdtempSync(join(tmpdir(), "kompjutr-memory-bench-"))
    : null;
  const databasePath = temporary === null ? null : join(temporary, "workspace.sqlite");
  try {
    const context = {
      harness: harness(backend, databasePath ?? ":memory:"),
      databasePath,
      count,
      variant,
    };
    try {
      // Which layer the statements came from, when asked. Written to stderr so the
      // result line stays machine-readable.
      if (process.env.BENCH_QUERIES === "1") context.harness.storage.histogram = new Map();
      await scenario.setup(context);

      for (const phase of scenario.phases) {
        await phase.before?.(context);
        const footprintBefore = databasePath === null ? 0 : storageFootprint(databasePath);
        let cgroupBefore: CgroupMemorySnapshot | null = null;
        if (isMemory) {
          if (runtime === null) throw new Error("memory runtime evidence is missing");
          resetCgroupPeak(runtime);
          cgroupBefore = cgroupMemorySnapshot(runtime);
        }
        // Reset after setup so the peak is from this operation, not fixture construction.
        const peakWasReset = resetPeakRss();
        if (isMemory && !peakWasReset) throw new Error("memory run could not reset VmHWM");
        const baselineRss = peakRssBytes();
        context.harness.storage.resetCounters();
        const started = performance.now();
        await phase.run(context);
        const wallMs = performance.now() - started;
        const peakRss = peakRssBytes();
        const processTransientBytes = peakRss - baselineRss;
        if (isMemory && processTransientBytes > PROCESS_TRANSIENT_TARGET_BYTES) {
          throw new Error(
            `process transient peak ${processTransientBytes} exceeds ${PROCESS_TRANSIENT_TARGET_BYTES}`,
          );
        }
        const cgroupAfter = isMemory && runtime !== null ? cgroupMemorySnapshot(runtime) : null;
        const statements = context.harness.storage.statementCount;
        const rows = context.harness.storage.rowCount;
        const footprintAfter = databasePath === null ? 0 : storageFootprint(databasePath);
        await phase.verify?.(context);
        if (isMemory) {
          if (
            runtime === null ||
            cgroupBefore === null ||
            cgroupAfter === null ||
            (memoryStage !== "calibration" && memoryStage !== "capped")
          ) {
            throw new Error("memory evidence is missing");
          }
          const spec = memoryScenarioSpec(name);
          if (phase.name !== spec.operation)
            throw new Error("memory phase does not match scenario");
          const evidence = phase.memoryEvidence?.();
          if (evidence === undefined) throw new Error("memory phase evidence is missing");
          const identity: MemoryRunIdentity = {
            scenario: spec.scenario,
            operation: spec.operation,
            stage: memoryStage,
            backend,
            count,
            variant,
          };
          process.stdout.write(
            `${JSON.stringify({
              ...identity,
              wallMs: Math.round(wallMs),
              processBaselineRssBytes: baselineRss,
              processPeakRssBytes: peakRss,
              processTransientBytes,
              processTransientTarget: "pass",
              statements,
              rows,
              statementTarget: statements <= SQL_STATEMENT_TARGET ? "pass" : "miss",
              storageFootprintBeforeBytes: footprintBefore,
              storageFootprintAfterBytes: footprintAfter,
              storageFootprintGrowthBytes: footprintAfter - footprintBefore,
              ...evidence,
              semanticStatus: "ok",
              cgroupMemory: deriveCgroupMemoryEvidence(cgroupBefore, cgroupAfter),
              runtime,
            })}\n`,
          );
        } else {
          process.stdout.write(
            `${JSON.stringify({
              scenario: name,
              operation: phase.name,
              backend,
              count,
              variant,
              wallMs: Math.round(wallMs),
              baselineRssBytes: baselineRss,
              peakRssBytes: peakRss,
              peakWasReset,
              statements,
              rows,
            })}\n`,
          );
        }
        const histogram = context.harness.storage.histogram;
        if (histogram !== null) {
          const top = [...histogram.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 12);
          for (const [query, hits] of top) {
            process.stderr.write(`[queries] ${phase.name} ${String(hits).padStart(8)}  ${query}\n`);
          }
        }
      }

      await scenario.teardown?.(context);
    } finally {
      context.harness.storage.db.close();
    }
  } finally {
    if (temporary !== null) rmSync(temporary, { recursive: true, force: true });
  }
}
