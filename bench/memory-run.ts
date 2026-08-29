import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY } from "./memory.js";
import {
  MEMORY_BENCHMARK_SAFETY_MAX_BYTES,
  type MemoryRun,
  type MemoryRunIdentity,
  memoryScenarioSpec,
  parseCpuList,
  parseMemoryRunOutput,
  parseRuntimeEvidence,
  RUNTIME_CHECK_MEMORY_MAX_BYTES,
  reconcileMemoryRuns,
  validateRuntimeEvidence,
} from "./memory-protocol.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_PATH = join(HERE, "run.ts");
const CHILD_PATH = join(HERE, "child.ts");
const REGISTER_PATH = join(HERE, "register.mjs");
const RESULTS = join(HERE, "results");
const LEASE_MARKER = "KOMPJUTR_MEMORY_BENCH_LEASED";
const LEASE_VCPUS = 2;
const CGROUP_PAGE_BYTES = 4_096;
let scopeOrdinal = 0;

interface MemoryBenchmarkOptions {
  runtimeCheck: boolean;
  originalArgs: readonly string[];
  scenarios: readonly string[] | null;
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

function cgroupPath(): string {
  const rows = readFileSync("/proc/self/cgroup", "utf8")
    .trim()
    .split("\n")
    .filter((row) => row.startsWith("0::"));
  if (rows.length !== 1) throw new Error("benchmark parent has no unique unified cgroup");
  const row = rows[0];
  if (row === undefined) throw new Error("benchmark parent has no unified cgroup");
  return row.slice(3);
}

function leaseCommand(args: readonly string[], runtimeCheck: boolean): string[] {
  return [
    "cpu-lease",
    "run",
    "-n",
    String(LEASE_VCPUS),
    "--no-smt",
    "--timeout",
    runtimeCheck ? "25" : "1800",
    "--label",
    runtimeCheck ? "kompjutr bench:memory runtime-check" : "kompjutr bench:memory",
    "--",
    process.execPath,
    "--experimental-transform-types",
    "--import",
    REGISTER_PATH,
    RUN_PATH,
    ...args,
  ];
}

function enterLease(options: MemoryBenchmarkOptions): boolean {
  if (process.env[LEASE_MARKER] === "1") return false;
  const command = leaseCommand(options.originalArgs, options.runtimeCheck);
  const executable = command[0];
  if (executable === undefined) throw new Error("lease command is empty");
  const result = spawnSync(executable, command.slice(1), {
    env: { ...process.env, [LEASE_MARKER]: "1" },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cpu-lease benchmark child exited with status ${String(result.status)}`);
  }
  return true;
}

export function requireParentLeaseCpus(expectedLogicalCpus: number | null): string {
  const path = cgroupPath();
  if (!/\/leases\.slice\/lease-[^/]+\.scope$/.test(path)) {
    throw new Error(`memory benchmark parent is outside a cpu-lease scope: ${path}`);
  }
  const cpus = allowedCpus();
  if (expectedLogicalCpus !== null && parseCpuList(cpus).length !== expectedLogicalCpus) {
    throw new Error(
      `cpu-lease --no-smt must expose ${expectedLogicalCpus} logical CPUs, got ${cpus}`,
    );
  }
  return cpus;
}

function childNodeArgs(args: readonly string[]): string[] {
  return [
    process.execPath,
    "--experimental-transform-types",
    "--import",
    REGISTER_PATH,
    CHILD_PATH,
    ...args,
  ];
}

export function memoryScopeCommand(
  args: readonly string[],
  parentCpus: string,
  memoryMaxBytes: number | null,
): string[] {
  scopeOrdinal++;
  const unit = `kompjutr-memory-${process.pid}-${scopeOrdinal}`;
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    "--slice=leases.slice",
    `--unit=${unit}`,
    "-p",
    `AllowedCPUs=${parentCpus}`,
    "-p",
    "MemorySwapMax=0",
    ...(memoryMaxBytes === null ? [] : ["-p", `MemoryMax=${memoryMaxBytes}`]),
    "--",
    ...childNodeArgs([
      ...args,
      `--expected-cpus=${parentCpus}`,
      `--expected-memory-max=${memoryMaxBytes ?? "max"}`,
    ]),
  ];
}

export function alignCgroupBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("cgroup byte cap is invalid");
  return Math.ceil(bytes / CGROUP_PAGE_BYTES) * CGROUP_PAGE_BYTES;
}

function runScope(
  args: readonly string[],
  parentCpus: string,
  memoryMaxBytes: number | null,
): string {
  const command = memoryScopeCommand(args, parentCpus, memoryMaxBytes);
  const executable = command[0];
  if (executable === undefined) throw new Error("systemd-run command is empty");
  const result = spawnSync(executable, command.slice(1), {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no child output")
      .trim()
      .split("\n")
      .slice(-20)
      .join(" | ");
    throw new Error(
      `memory benchmark scope failed with status ${String(result.status)}: ${detail}`,
    );
  }
  return result.stdout;
}

function onlyOutputLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error(`memory child emitted ${lines.length} output rows`);
  const line = lines[0];
  if (line === undefined) throw new Error("memory child emitted no output");
  return line;
}

function runCell(
  identity: MemoryRunIdentity,
  parentCpus: string,
  memoryMaxBytes: number | null,
): MemoryRun {
  const output = runScope(
    [
      identity.scenario,
      identity.backend,
      String(identity.count),
      identity.variant,
      `--memory-stage=${identity.stage}`,
    ],
    parentCpus,
    memoryMaxBytes,
  );
  const row = parseMemoryRunOutput(output, identity);
  validateRuntimeEvidence(row.runtime, {
    allowedCpus: parentCpus,
    scope: "benchmark",
    memoryMaxBytes,
  });
  return row;
}

function runtimeCheck(parentCpus: string): void {
  const output = runScope(["--runtime-check"], parentCpus, RUNTIME_CHECK_MEMORY_MAX_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(onlyOutputLine(output));
  } catch (error) {
    throw new Error("runtime check child emitted invalid JSON", { cause: error });
  }
  const evidence = parseRuntimeEvidence(value);
  validateRuntimeEvidence(evidence, {
    allowedCpus: parentCpus,
    scope: "benchmark",
    memoryMaxBytes: RUNTIME_CHECK_MEMORY_MAX_BYTES,
  });
  process.stdout.write(
    `${JSON.stringify({ status: "ok", parentCpus, runtime: evidence }, null, 2)}\n`,
  );
}

function memoryRows(parentCpus: string, selectedNames: readonly string[] | null): MemoryRun[] {
  const rows: MemoryRun[] = [];
  const available = MEMORY;
  if (selectedNames !== null && new Set(selectedNames).size !== selectedNames.length) {
    throw new Error("memory scenario selection contains duplicates");
  }
  const scenarios =
    selectedNames === null
      ? available
      : selectedNames.map((name) => {
          const scenario = available.find((candidate) => candidate.name === name);
          if (scenario === undefined) throw new Error(`unknown memory scenario: ${name}`);
          return scenario;
        });
  if (scenarios.length === 0) throw new Error("memory scenario registry is empty");
  for (const scenario of scenarios) {
    if (!scenario.fileBacked) throw new Error(`${scenario.name} must use file-backed SQLite`);
    if (scenario.phases.length !== 1) {
      throw new Error(`${scenario.name} must contain exactly one measured phase`);
    }
    const phase = scenario.phases[0];
    if (phase === undefined) throw new Error(`${scenario.name} has no measured phase`);
    const spec = memoryScenarioSpec(scenario.name);
    if (phase.name !== spec.operation) throw new Error(`${scenario.name} has the wrong operation`);
    const base: Omit<MemoryRunIdentity, "stage"> = {
      scenario: spec.scenario,
      operation: spec.operation,
      backend: "sqlite",
      count: 0,
      variant: "flat",
    };
    const calibration = runCell({ ...base, stage: "calibration" }, parentCpus, null);
    rows.push(calibration);
    const capBytes = MEMORY_BENCHMARK_SAFETY_MAX_BYTES;
    const capped = runCell({ ...base, stage: "capped" }, parentCpus, capBytes);
    reconcileMemoryRuns(calibration, capped);
    rows.push(capped);
    process.stderr.write(
      `${scenario.name}: process transient ${capped.processTransientBytes} bytes; ` +
        `${capBytes}-byte cgroup safety pass; SQL target ${capped.statementTarget}\n`,
    );
  }
  return rows;
}

function writeReport(rows: readonly MemoryRun[]): void {
  mkdirSync(RESULTS, { recursive: true });
  const stamp = process.env.BENCH_STAMP ?? "memory-latest";
  writeFileSync(join(RESULTS, `${stamp}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  const lines = [
    "# kompjutr bounded-memory benchmark",
    "",
    "The process target is same-run reset VmHWM minus its immediate VmHWM baseline.",
    "The independent 512 MiB cgroup cap is a runaway witness over total memory, including",
    "SQLite page cache. Raw cgroup current/peak/stat values are not process-memory claims.",
    "SQL ≤1,000 is report-only.",
    "",
    "| operation | stage | wall ms | statements | SQL target | process transient | cgroup peak growth | cgroup file after | storage growth | cgroup max | coordinator HWM |",
    "|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.operation} | ${row.stage} | ${row.wallMs} | ${row.statements} | ${row.statementTarget} | ` +
        `${row.processTransientBytes} | ${row.cgroupMemory.peakGrowthBytes} | ` +
        `${row.cgroupMemory.after.fileBytes} | ${row.storageFootprintGrowthBytes} | ` +
        `${row.runtime.memoryMaxBytes ?? "max"} | ${row.coordinatorHighWaterBytes ?? "n/a"} |`,
    );
  }
  writeFileSync(join(RESULTS, `${stamp}.md`), `${lines.join("\n")}\n`);
  process.stderr.write(`wrote ${join(RESULTS, `${stamp}.md`)}\n`);
}

export function runMemoryBenchmark(options: MemoryBenchmarkOptions): void {
  if (enterLease(options)) return;
  const parentCpus = requireParentLeaseCpus(1);
  if (options.runtimeCheck) {
    runtimeCheck(parentCpus);
    return;
  }
  writeReport(memoryRows(parentCpus, options.scenarios));
}
