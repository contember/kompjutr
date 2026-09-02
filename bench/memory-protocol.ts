import { CHUNK_SIZE } from "../src/fs/schema.js";
import { MAX_OBJECT_BYTES } from "../src/git/common/objects.js";
import { INFLATE_FEED, maximumDeflatedBytes, OBJECT_CHUNK } from "../src/git/store/objects.js";
import { commitGraphBytes } from "./commit-graph-bytes.js";

export const SQL_STATEMENT_TARGET = 1_000;
export const PROCESS_TRANSIENT_TARGET_BYTES = 100 * 1024 * 1024;
export const MEMORY_BENCHMARK_SAFETY_MAX_BYTES = 512 * 1024 * 1024;
export const RUNTIME_CHECK_MEMORY_MAX_BYTES = 256 * 1024 * 1024;

const INITIAL_STREAM_BYTES = 8 * 1024 * 1024;
const INITIAL_SYMLINK_BYTES = 64 * 1024 + 1;
const REDIRECT_STREAM_BYTES = 96 * 1024 * 1024 + 1;
export const HASH_WORKLOAD_BYTES = 32 * 1024 * 1024 + 1;
export const GRAPH_MESSAGE_BYTES = 500_000;
export const GRAPH_COMMIT_COUNT = 34;
export const LARGE_OBJECT_BYTES = 4 * 1024 * 1024 + 1;
export const LARGE_CONFIG_BYTES = 1024 * 1024 + 1;
export const LARGE_HEADER_BYTES = 48 * 1024 * 1024 + 64 * 1024;
export const CHECKOUT_COUNT = 1_024;
export const LOOSE_STREAM_OBJECT_BYTES = MAX_OBJECT_BYTES - 2 * 1024 * 1024;
export const LOOSE_STREAM_OBJECT_COUNT = 2;
export const LOOSE_STREAM_OUTPUT_BYTES = LOOSE_STREAM_OBJECT_BYTES * LOOSE_STREAM_OBJECT_COUNT;
const LOOSE_STREAM_PAYLOAD_BYTES =
  maximumDeflatedBytes(LOOSE_STREAM_OBJECT_BYTES) * LOOSE_STREAM_OBJECT_COUNT;
const LOOSE_STREAM_RETAINED_BYTES = LOOSE_STREAM_OUTPUT_BYTES + LOOSE_STREAM_PAYLOAD_BYTES;
export const CHECKOUT_ROOT_BYTES = 4_096;
export const CHECKOUT_HEAD_BYTES = 1_024;

const RANGE_HASH_CHUNKS = Math.ceil(HASH_WORKLOAD_BYTES / (64 * 1024));
const PACK_FIXTURE_OBJECT_BYTES = 1;
const PACK_STREAM_CHUNK_BYTES = 1024 * 1024;
const SQLITE_OBJECT_CHUNK_BYTES = 1024 * 1024;
const FALLBACK_COMPRESSED_BYTES = storedZlibBytes(PACK_FIXTURE_OBJECT_BYTES, 48 * 1024 * 1024);
const AUTH_COMPRESSED_BYTES = storedZlibBytes(PACK_FIXTURE_OBJECT_BYTES, 64 * 1024 * 1024);
const GRAPH_MESSAGE = `${"g".repeat(GRAPH_MESSAGE_BYTES - 1)}\n`;
const GRAPH_PERSON = {
  name: "Memory Benchmark",
  email: "memory@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};
const GRAPH_ROOT_BYTES = commitGraphBytes({
  tree: "1".repeat(40),
  parent: [],
  author: GRAPH_PERSON,
  committer: GRAPH_PERSON,
  message: GRAPH_MESSAGE,
});
const GRAPH_CHILD_BYTES = commitGraphBytes({
  tree: "1".repeat(40),
  parent: ["2".repeat(40)],
  author: GRAPH_PERSON,
  committer: GRAPH_PERSON,
  message: GRAPH_MESSAGE,
});
const GRAPH_RETAINED_BYTES = GRAPH_ROOT_BYTES + (GRAPH_COMMIT_COUNT - 1) * GRAPH_CHILD_BYTES;
const CHECKOUT_TEXT_BYTES = CHECKOUT_COUNT * (CHECKOUT_ROOT_BYTES + CHECKOUT_HEAD_BYTES);
const CHECKOUT_RETAINED_BYTES =
  128 +
  CHECKOUT_COUNT * (8 + 128 + (48 + CHECKOUT_ROOT_BYTES * 2) + (48 + CHECKOUT_HEAD_BYTES * 2));

function storedZlibBytes(dataBytes: number, minimumBytes: number): number {
  const fixedBytes = 2 + 5 + dataBytes + 4;
  return fixedBytes + Math.max(0, Math.ceil((minimumBytes + 1 - fixedBytes) / 5)) * 5;
}

if (GRAPH_RETAINED_BYTES <= 32 * 1024 * 1024) {
  throw new Error("graph memory fixture does not cross its former retained limit");
}
if (CHECKOUT_RETAINED_BYTES <= 6 * 1024 * 1024) {
  throw new Error("checkout memory fixture does not cross its former retained limit");
}
if (LOOSE_STREAM_OUTPUT_BYTES + INFLATE_FEED >= PROCESS_TRANSIENT_TARGET_BYTES) {
  throw new Error("loose stream final outputs and one inflater feed do not fit the process target");
}
if (LOOSE_STREAM_RETAINED_BYTES <= PROCESS_TRANSIENT_TARGET_BYTES) {
  throw new Error("loose stream fixture does not cross the retired retained-payload shape");
}

export type MemoryScenarioName =
  | "fs.initial-write"
  | "fs.redirect.stream"
  | "core.integration.guard-hash"
  | "core.rebase.baseline-hash"
  | "core.staging.add-hash"
  | "core.loose-object-stream"
  | "sqlite.maintenance.reachability"
  | "sqlite.pack.fallback-audit"
  | "sqlite.pack.authenticate"
  | "sqlite.graph.retained"
  | "sqlite.object.singleton"
  | "sqlite.config.move"
  | "sqlite.checkout.list";
export type MemorySource =
  | "createInitialWorktreeWriter"
  | "Filesystem.writeFileStream"
  | "requireCleanIntegrationWorktree"
  | "rebase"
  | "add"
  | "SharedRepoStore.readBlobs"
  | "advanceMaintenanceReachability"
  | "PackStore.deleteCompletePacks"
  | "PackStore.authenticateCompleteSources"
  | "Repository.walkIndexed"
  | "CheckoutStore.configMoveSection"
  | "SqliteGitDatabase.listCheckouts";

export interface MemoryScenarioSpec {
  scenario: MemoryScenarioName;
  operation: MemoryScenarioName;
  source: MemorySource;
  workloadBytes: number;
  formerLimitBytes: number;
  verifiedContentBytes: number;
  verifiedChunkCount: number;
}

const INITIAL_WRITE_SPEC: MemoryScenarioSpec = {
  scenario: "fs.initial-write",
  operation: "fs.initial-write",
  source: "createInitialWorktreeWriter",
  workloadBytes: INITIAL_STREAM_BYTES + INITIAL_SYMLINK_BYTES,
  formerLimitBytes: 64 * 1024,
  verifiedContentBytes: INITIAL_STREAM_BYTES,
  verifiedChunkCount: Math.ceil(INITIAL_STREAM_BYTES / CHUNK_SIZE),
};

const REDIRECT_STREAM_SPEC: MemoryScenarioSpec = {
  scenario: "fs.redirect.stream",
  operation: "fs.redirect.stream",
  source: "Filesystem.writeFileStream",
  workloadBytes: REDIRECT_STREAM_BYTES,
  formerLimitBytes: 96 * 1024 * 1024,
  verifiedContentBytes: REDIRECT_STREAM_BYTES,
  verifiedChunkCount: Math.ceil(REDIRECT_STREAM_BYTES / CHUNK_SIZE),
};

const MEMORY_SCENARIO_SPECS: readonly MemoryScenarioSpec[] = [
  INITIAL_WRITE_SPEC,
  REDIRECT_STREAM_SPEC,
  {
    scenario: "core.integration.guard-hash",
    operation: "core.integration.guard-hash",
    source: "requireCleanIntegrationWorktree",
    workloadBytes: HASH_WORKLOAD_BYTES,
    formerLimitBytes: 32 * 1024 * 1024,
    verifiedContentBytes: HASH_WORKLOAD_BYTES,
    verifiedChunkCount: RANGE_HASH_CHUNKS,
  },
  {
    scenario: "core.rebase.baseline-hash",
    operation: "core.rebase.baseline-hash",
    source: "rebase",
    workloadBytes: HASH_WORKLOAD_BYTES,
    formerLimitBytes: 32 * 1024 * 1024,
    verifiedContentBytes: HASH_WORKLOAD_BYTES,
    verifiedChunkCount: RANGE_HASH_CHUNKS,
  },
  {
    scenario: "core.staging.add-hash",
    operation: "core.staging.add-hash",
    source: "add",
    workloadBytes: HASH_WORKLOAD_BYTES,
    formerLimitBytes: 32 * 1024 * 1024,
    verifiedContentBytes: HASH_WORKLOAD_BYTES,
    verifiedChunkCount: RANGE_HASH_CHUNKS * 2,
  },
  {
    scenario: "core.loose-object-stream",
    operation: "core.loose-object-stream",
    source: "SharedRepoStore.readBlobs",
    workloadBytes: LOOSE_STREAM_RETAINED_BYTES,
    formerLimitBytes: PROCESS_TRANSIENT_TARGET_BYTES,
    verifiedContentBytes: LOOSE_STREAM_OUTPUT_BYTES,
    verifiedChunkCount:
      Math.ceil(maximumDeflatedBytes(LOOSE_STREAM_OBJECT_BYTES) / OBJECT_CHUNK) *
      LOOSE_STREAM_OBJECT_COUNT,
  },
  {
    scenario: "sqlite.maintenance.reachability",
    operation: "sqlite.maintenance.reachability",
    source: "advanceMaintenanceReachability",
    workloadBytes: LARGE_HEADER_BYTES,
    formerLimitBytes: 48 * 1024 * 1024,
    verifiedContentBytes: LARGE_HEADER_BYTES,
    verifiedChunkCount: Math.ceil(LARGE_HEADER_BYTES / SQLITE_OBJECT_CHUNK_BYTES),
  },
  {
    scenario: "sqlite.pack.fallback-audit",
    operation: "sqlite.pack.fallback-audit",
    source: "PackStore.deleteCompletePacks",
    workloadBytes: FALLBACK_COMPRESSED_BYTES,
    formerLimitBytes: 48 * 1024 * 1024,
    verifiedContentBytes: PACK_FIXTURE_OBJECT_BYTES,
    verifiedChunkCount: Math.ceil(FALLBACK_COMPRESSED_BYTES / PACK_STREAM_CHUNK_BYTES),
  },
  {
    scenario: "sqlite.pack.authenticate",
    operation: "sqlite.pack.authenticate",
    source: "PackStore.authenticateCompleteSources",
    workloadBytes: AUTH_COMPRESSED_BYTES,
    formerLimitBytes: 64 * 1024 * 1024,
    verifiedContentBytes: PACK_FIXTURE_OBJECT_BYTES,
    verifiedChunkCount: Math.ceil(AUTH_COMPRESSED_BYTES / PACK_STREAM_CHUNK_BYTES),
  },
  {
    scenario: "sqlite.graph.retained",
    operation: "sqlite.graph.retained",
    source: "Repository.walkIndexed",
    workloadBytes: GRAPH_RETAINED_BYTES,
    formerLimitBytes: 32 * 1024 * 1024,
    verifiedContentBytes: GRAPH_COMMIT_COUNT * GRAPH_MESSAGE_BYTES,
    verifiedChunkCount: GRAPH_COMMIT_COUNT,
  },
  {
    scenario: "sqlite.object.singleton",
    operation: "sqlite.object.singleton",
    source: "SharedRepoStore.readBlobs",
    workloadBytes: LARGE_OBJECT_BYTES,
    formerLimitBytes: 4 * 1024 * 1024,
    verifiedContentBytes: LARGE_OBJECT_BYTES,
    verifiedChunkCount: Math.ceil(LARGE_OBJECT_BYTES / SQLITE_OBJECT_CHUNK_BYTES),
  },
  {
    scenario: "sqlite.config.move",
    operation: "sqlite.config.move",
    source: "CheckoutStore.configMoveSection",
    workloadBytes: LARGE_CONFIG_BYTES,
    formerLimitBytes: 1024 * 1024,
    verifiedContentBytes: LARGE_CONFIG_BYTES,
    verifiedChunkCount: Math.ceil(LARGE_CONFIG_BYTES / (1024 * 1024)),
  },
  {
    scenario: "sqlite.checkout.list",
    operation: "sqlite.checkout.list",
    source: "SqliteGitDatabase.listCheckouts",
    workloadBytes: CHECKOUT_RETAINED_BYTES,
    formerLimitBytes: 6 * 1024 * 1024,
    verifiedContentBytes: CHECKOUT_TEXT_BYTES,
    verifiedChunkCount: CHECKOUT_COUNT,
  },
];

export function memoryScenarioSpec(name: string): MemoryScenarioSpec {
  const spec = MEMORY_SCENARIO_SPECS.find((candidate) => candidate.scenario === name);
  if (spec !== undefined) return spec;
  throw new Error(`unknown memory scenario: ${name}`);
}

export interface RuntimeEvidence {
  allowedCpus: string;
  cgroupPath: string;
  memoryMaxBytes: number | null;
  memorySwapMaxBytes: number;
}

export interface RuntimeExpectation {
  allowedCpus: string;
  scope: "lease" | "benchmark";
  memoryMaxBytes: number | null;
}

export interface CgroupMemorySnapshot {
  currentBytes: number;
  peakBytes: number;
  anonBytes: number;
  fileBytes: number;
  kernelBytes: number;
  shmemBytes: number;
}

export interface CgroupMemoryEvidence {
  before: CgroupMemorySnapshot;
  after: CgroupMemorySnapshot;
  peakGrowthBytes: number;
}

export interface MemoryPhaseEvidence {
  source: MemorySource;
  workloadBytes: number;
  formerLimitBytes: number;
  verifiedContentBytes: number;
  verifiedChunkCount: number;
  verificationDigest: string;
}

export interface MemoryRun {
  scenario: MemoryScenarioName;
  operation: MemoryScenarioName;
  source: MemorySource;
  stage: "calibration" | "capped";
  backend: "sqlite";
  count: number;
  variant: string;
  wallMs: number;
  processBaselineRssBytes: number;
  processPeakRssBytes: number;
  processTransientBytes: number;
  processTransientTarget: "pass";
  statements: number;
  rows: number;
  statementTarget: "pass" | "miss";
  storageFootprintBeforeBytes: number;
  storageFootprintAfterBytes: number;
  storageFootprintGrowthBytes: number;
  workloadBytes: number;
  formerLimitBytes: number;
  verifiedContentBytes: number;
  verifiedChunkCount: number;
  verificationDigest: string;
  semanticStatus: "ok";
  cgroupMemory: CgroupMemoryEvidence;
  runtime: RuntimeEvidence;
}

export interface MemoryRunIdentity {
  scenario: MemoryScenarioName;
  operation: MemoryScenarioName;
  stage: "calibration" | "capped";
  backend: "sqlite";
  count: number;
  variant: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields: ${actual.join(",")}`);
  }
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function safeIntegerField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a safe nonnegative integer`);
  }
  return value;
}

function nullableSafeIntegerField(record: Record<string, unknown>, key: string): number | null {
  if (record[key] === null) return null;
  return safeIntegerField(record, key);
}

function finiteNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a finite nonnegative number`);
  }
  return value;
}

function parseCpuComponent(component: string): { first: number; last: number } {
  if (!/^\d+(?:-\d+)?$/.test(component)) throw new Error("CPU list is malformed");
  const separator = component.indexOf("-");
  const firstText = separator < 0 ? component : component.slice(0, separator);
  const lastText = separator < 0 ? component : component.slice(separator + 1);
  const first = Number(firstText);
  const last = Number(lastText);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) {
    throw new Error("CPU list is malformed");
  }
  return { first, last };
}

/** Parse the kernel/systemd CPU-list grammar and reject duplicate or unordered CPUs. */
export function parseCpuList(value: string): number[] {
  if (value.length === 0 || /\s/.test(value)) throw new Error("CPU list is malformed");
  const cpus: number[] = [];
  let previous = -1;
  for (const component of value.split(",")) {
    const { first, last } = parseCpuComponent(component);
    if (first <= previous || last - first > 65_535) {
      throw new Error("CPU list is duplicate, unordered, or too large");
    }
    for (let cpu = first; cpu <= last; cpu++) cpus.push(cpu);
    previous = last;
  }
  return cpus;
}

function normalizedCpuList(value: string): string {
  return parseCpuList(value).join(",");
}

export function parseRuntimeEvidence(value: unknown): RuntimeEvidence {
  if (!isRecord(value)) throw new Error("runtime evidence must be an object");
  exactKeys(
    value,
    ["allowedCpus", "cgroupPath", "memoryMaxBytes", "memorySwapMaxBytes"],
    "runtime evidence",
  );
  const allowedCpus = textField(value, "allowedCpus");
  parseCpuList(allowedCpus);
  const cgroupPath = textField(value, "cgroupPath");
  if (!cgroupPath.startsWith("/") || cgroupPath.includes("..") || /\s/.test(cgroupPath)) {
    throw new Error("cgroupPath must be an absolute cgroup path");
  }
  return {
    allowedCpus,
    cgroupPath,
    memoryMaxBytes: nullableSafeIntegerField(value, "memoryMaxBytes"),
    memorySwapMaxBytes: safeIntegerField(value, "memorySwapMaxBytes"),
  };
}

export function validateRuntimeEvidence(
  evidence: RuntimeEvidence,
  expected: RuntimeExpectation,
): void {
  if (normalizedCpuList(evidence.allowedCpus) !== normalizedCpuList(expected.allowedCpus)) {
    throw new Error(
      `child CPU affinity ${evidence.allowedCpus} differs from parent ${expected.allowedCpus}`,
    );
  }
  const inLease = /\/leases\.slice\/lease-[^/]+\.scope$/.test(evidence.cgroupPath);
  const inBenchmark = /\/leases\.slice\/kompjutr-memory-[^/]+\.scope$/.test(evidence.cgroupPath);
  if (expected.scope === "lease" ? !inLease : !inBenchmark) {
    throw new Error(`child escaped the expected ${expected.scope} cgroup scope`);
  }
  if (evidence.memoryMaxBytes !== expected.memoryMaxBytes) {
    throw new Error(
      `child memory.max ${String(evidence.memoryMaxBytes)} differs from ${String(expected.memoryMaxBytes)}`,
    );
  }
  if (evidence.memorySwapMaxBytes !== 0) {
    throw new Error(`child memory.swap.max must be 0, got ${evidence.memorySwapMaxBytes}`);
  }
}

const SNAPSHOT_KEYS = [
  "currentBytes",
  "peakBytes",
  "anonBytes",
  "fileBytes",
  "kernelBytes",
  "shmemBytes",
];

function parseCgroupSnapshot(value: unknown, label: string): CgroupMemorySnapshot {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, SNAPSHOT_KEYS, label);
  const snapshot = {
    currentBytes: safeIntegerField(value, "currentBytes"),
    peakBytes: safeIntegerField(value, "peakBytes"),
    anonBytes: safeIntegerField(value, "anonBytes"),
    fileBytes: safeIntegerField(value, "fileBytes"),
    kernelBytes: safeIntegerField(value, "kernelBytes"),
    shmemBytes: safeIntegerField(value, "shmemBytes"),
  };
  if (snapshot.currentBytes > snapshot.peakBytes) {
    throw new Error(`${label} current exceeds peak`);
  }
  return snapshot;
}

export function deriveCgroupMemoryEvidence(
  before: CgroupMemorySnapshot,
  after: CgroupMemorySnapshot,
): CgroupMemoryEvidence {
  if (after.peakBytes < before.peakBytes) throw new Error("cgroup memory peak moved backwards");
  return { before, after, peakGrowthBytes: after.peakBytes - before.peakBytes };
}

function parseCgroupMemory(value: unknown): CgroupMemoryEvidence {
  if (!isRecord(value)) throw new Error("cgroupMemory must be an object");
  exactKeys(value, ["before", "after", "peakGrowthBytes"], "cgroupMemory");
  const before = parseCgroupSnapshot(value.before, "cgroupMemory.before");
  const after = parseCgroupSnapshot(value.after, "cgroupMemory.after");
  const derived = deriveCgroupMemoryEvidence(before, after);
  if (safeIntegerField(value, "peakGrowthBytes") !== derived.peakGrowthBytes) {
    throw new Error("cgroupMemory.peakGrowthBytes is inconsistent");
  }
  return derived;
}

const MEMORY_RUN_KEYS = [
  "scenario",
  "operation",
  "source",
  "stage",
  "backend",
  "count",
  "variant",
  "wallMs",
  "processBaselineRssBytes",
  "processPeakRssBytes",
  "processTransientBytes",
  "processTransientTarget",
  "statements",
  "rows",
  "statementTarget",
  "storageFootprintBeforeBytes",
  "storageFootprintAfterBytes",
  "storageFootprintGrowthBytes",
  "workloadBytes",
  "formerLimitBytes",
  "verifiedContentBytes",
  "verifiedChunkCount",
  "verificationDigest",
  "semanticStatus",
  "cgroupMemory",
  "runtime",
];

/** Strictly parse one child row. Missing, extra, unsafe, or contradictory data fails. */
export function parseMemoryRun(line: string, expected?: MemoryRunIdentity): MemoryRun {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("memory child emitted invalid JSON", { cause: error });
  }
  if (!isRecord(value)) throw new Error("memory child row must be an object");
  exactKeys(value, MEMORY_RUN_KEYS, "memory child row");

  const spec = memoryScenarioSpec(textField(value, "scenario"));
  if (textField(value, "operation") !== spec.operation) {
    throw new Error("operation does not match scenario");
  }
  if (textField(value, "source") !== spec.source) throw new Error("source does not match scenario");
  const stage = value.stage;
  if (stage !== "calibration" && stage !== "capped") throw new Error("stage is invalid");
  if (value.backend !== "sqlite") throw new Error("backend is invalid");
  const count = safeIntegerField(value, "count");
  const variant = textField(value, "variant");
  const wallMs = finiteNumberField(value, "wallMs");
  const processBaselineRssBytes = safeIntegerField(value, "processBaselineRssBytes");
  const processPeakRssBytes = safeIntegerField(value, "processPeakRssBytes");
  if (processPeakRssBytes < processBaselineRssBytes) {
    throw new Error("process peak RSS is below its same-run baseline");
  }
  const processTransientBytes = safeIntegerField(value, "processTransientBytes");
  if (processTransientBytes !== processPeakRssBytes - processBaselineRssBytes) {
    throw new Error("process transient bytes are inconsistent");
  }
  if (
    value.processTransientTarget !== "pass" ||
    processTransientBytes > PROCESS_TRANSIENT_TARGET_BYTES
  ) {
    throw new Error("process transient target did not pass");
  }
  const statements = safeIntegerField(value, "statements");
  const rows = safeIntegerField(value, "rows");
  const statementTarget = value.statementTarget;
  if (statementTarget !== "pass" && statementTarget !== "miss") {
    throw new Error("statementTarget is invalid");
  }
  const expectedTarget = statements <= SQL_STATEMENT_TARGET ? "pass" : "miss";
  if (statementTarget !== expectedTarget) throw new Error("statementTarget contradicts statements");
  const storageFootprintBeforeBytes = safeIntegerField(value, "storageFootprintBeforeBytes");
  const storageFootprintAfterBytes = safeIntegerField(value, "storageFootprintAfterBytes");
  const storageFootprintGrowthBytes = safeIntegerField(value, "storageFootprintGrowthBytes");
  if (storageFootprintGrowthBytes !== storageFootprintAfterBytes - storageFootprintBeforeBytes) {
    throw new Error("storage footprint growth is inconsistent");
  }
  const workloadBytes = safeIntegerField(value, "workloadBytes");
  const formerLimitBytes = safeIntegerField(value, "formerLimitBytes");
  const verifiedContentBytes = safeIntegerField(value, "verifiedContentBytes");
  const verifiedChunkCount = safeIntegerField(value, "verifiedChunkCount");
  if (
    workloadBytes !== spec.workloadBytes ||
    formerLimitBytes !== spec.formerLimitBytes ||
    verifiedContentBytes !== spec.verifiedContentBytes ||
    verifiedChunkCount !== spec.verifiedChunkCount
  ) {
    throw new Error("scenario metadata does not match its frozen specification");
  }
  if (workloadBytes <= formerLimitBytes) {
    throw new Error("scenario workload does not cross its former limit");
  }
  const verificationDigest = textField(value, "verificationDigest");
  if (!/^[0-9a-f]{64}$/.test(verificationDigest)) {
    throw new Error("verificationDigest must be a SHA-256 hex digest");
  }
  if (value.semanticStatus !== "ok") throw new Error("semantic verification did not pass");
  const cgroupMemory = parseCgroupMemory(value.cgroupMemory);
  const runtime = parseRuntimeEvidence(value.runtime);

  const run: MemoryRun = {
    scenario: spec.scenario,
    operation: spec.operation,
    source: spec.source,
    stage,
    backend: "sqlite",
    count,
    variant,
    wallMs,
    processBaselineRssBytes,
    processPeakRssBytes,
    processTransientBytes,
    processTransientTarget: "pass",
    statements,
    rows,
    statementTarget,
    storageFootprintBeforeBytes,
    storageFootprintAfterBytes,
    storageFootprintGrowthBytes,
    workloadBytes,
    formerLimitBytes,
    verifiedContentBytes,
    verifiedChunkCount,
    verificationDigest,
    semanticStatus: "ok",
    cgroupMemory,
    runtime,
  };
  if (expected !== undefined) {
    const identityKeys: (keyof MemoryRunIdentity)[] = [
      "scenario",
      "operation",
      "stage",
      "backend",
      "count",
      "variant",
    ];
    for (const key of identityKeys) {
      if (run[key] !== expected[key]) throw new Error(`${key} does not match the requested cell`);
    }
  }
  return run;
}

/** One child invocation must publish exactly one row for its requested operation. */
export function parseMemoryRunOutput(output: string, expected: MemoryRunIdentity): MemoryRun {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error(`memory child emitted ${lines.length} output rows`);
  const line = lines[0];
  if (line === undefined) throw new Error("memory child emitted no output");
  return parseMemoryRun(line, expected);
}

const RECONCILED_KEYS: (keyof MemoryRun)[] = [
  "scenario",
  "operation",
  "source",
  "backend",
  "count",
  "variant",
  "statements",
  "rows",
  "statementTarget",
  "storageFootprintBeforeBytes",
  "storageFootprintAfterBytes",
  "storageFootprintGrowthBytes",
  "workloadBytes",
  "formerLimitBytes",
  "verifiedContentBytes",
  "verifiedChunkCount",
  "verificationDigest",
  "semanticStatus",
];

/** Calibration and capped runs may differ only in timing and memory observations. */
export function reconcileMemoryRuns(calibration: MemoryRun, capped: MemoryRun): void {
  if (calibration.stage !== "calibration" || capped.stage !== "capped") {
    throw new Error("memory reconciliation requires calibration then capped stages");
  }
  for (const key of RECONCILED_KEYS) {
    if (calibration[key] !== capped[key]) throw new Error(`memory stages disagree on ${key}`);
  }
}
