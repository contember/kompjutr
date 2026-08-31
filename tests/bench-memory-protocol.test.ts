import { describe, expect, it } from "vitest";

import {
  type MemoryRunIdentity,
  memoryScenarioSpec,
  parseMemoryRun,
  parseMemoryRunOutput,
  parseRuntimeEvidence,
  type RuntimeExpectation,
  reconcileMemoryRuns,
  validateRuntimeEvidence,
} from "../bench/memory-protocol.js";

const IDENTITY: MemoryRunIdentity = {
  scenario: "fs.initial-write",
  operation: "fs.initial-write",
  stage: "capped",
  backend: "sqlite",
  count: 0,
  variant: "flat",
};

function validRuntime(): Record<string, unknown> {
  return {
    allowedCpus: "8",
    cgroupPath:
      "/user.slice/user-1000.slice/user@1000.service/leases.slice/kompjutr-memory-100-1.scope",
    memoryMaxBytes: 536_870_912,
    memorySwapMaxBytes: 0,
  };
}

function snapshot(currentBytes: number, peakBytes: number): Record<string, unknown> {
  return {
    currentBytes,
    peakBytes,
    anonBytes: 80,
    fileBytes: 40,
    kernelBytes: 20,
    shmemBytes: 0,
  };
}

function validRow(): Record<string, unknown> {
  return {
    ...IDENTITY,
    source: "createInitialWorktreeWriter",
    wallMs: 10,
    processBaselineRssBytes: 100,
    processPeakRssBytes: 150,
    processTransientBytes: 50,
    processTransientTarget: "pass",
    statements: 999,
    rows: 20,
    statementTarget: "pass",
    storageFootprintBeforeBytes: 10,
    storageFootprintAfterBytes: 40,
    storageFootprintGrowthBytes: 30,
    workloadBytes: 8_454_145,
    formerLimitBytes: 65_536,
    verifiedContentBytes: 8_388_608,
    verifiedChunkCount: 16,
    verificationDigest: "a".repeat(64),
    semanticStatus: "ok",
    cgroupMemory: {
      before: snapshot(140, 150),
      after: snapshot(200, 250),
      peakGrowthBytes: 100,
    },
    runtime: validRuntime(),
  };
}

function validRedirectRow(): Record<string, unknown> {
  return {
    ...validRow(),
    scenario: "fs.redirect.stream",
    operation: "fs.redirect.stream",
    source: "Filesystem.writeFileStream",
    workloadBytes: 100_663_297,
    formerLimitBytes: 100_663_296,
    verifiedContentBytes: 100_663_297,
    verifiedChunkCount: 193,
  };
}

function parsedCalibration() {
  const row = validRow();
  row.stage = "calibration";
  const runtime = validRuntime();
  runtime.memoryMaxBytes = null;
  row.runtime = runtime;
  return parseMemoryRun(JSON.stringify(row), { ...IDENTITY, stage: "calibration" });
}

describe("memory benchmark protocol", () => {
  it("registers every accepted cgroup row above its former limit", () => {
    const required = [
      "core.integration.guard-hash",
      "core.rebase.baseline-hash",
      "core.staging.add-hash",
      "sqlite.maintenance.reachability",
      "sqlite.pack.fallback-audit",
      "sqlite.pack.authenticate",
      "sqlite.graph.retained",
      "sqlite.object.singleton",
      "sqlite.config.move",
      "sqlite.checkout.list",
    ];
    for (const name of required) {
      const spec = memoryScenarioSpec(name);
      expect(spec.scenario).toBe(name);
      expect(spec.workloadBytes).toBeGreaterThan(spec.formerLimitBytes);
    }
    expect(() => memoryScenarioSpec("missing-row")).toThrow(/unknown memory scenario/);
  });

  it("accepts exact evidence and treats a SQL target miss as data", () => {
    expect(parseMemoryRun(JSON.stringify(validRow()), IDENTITY).statementTarget).toBe("pass");
    const miss = validRow();
    miss.statements = 1_001;
    miss.statementTarget = "miss";
    expect(parseMemoryRun(JSON.stringify(miss), IDENTITY).statementTarget).toBe("miss");
  });

  it("rejects missing, duplicate, and wrong-operation output", () => {
    expect(() => parseMemoryRunOutput("", IDENTITY)).toThrow(/0 output rows/);
    const row = JSON.stringify(validRow());
    expect(() => parseMemoryRunOutput(`${row}\n${row}\n`, IDENTITY)).toThrow(/2 output rows/);
    const wrong = validRow();
    wrong.operation = "fs.redirect.stream";
    expect(() => parseMemoryRun(JSON.stringify(wrong), IDENTITY)).toThrow(
      /does not match scenario/,
    );
  });

  it("binds source, workload, and digest metadata to the scenario", () => {
    const wrongSource = validRow();
    wrongSource.source = "Filesystem.writeFileStream";
    expect(() => parseMemoryRun(JSON.stringify(wrongSource), IDENTITY)).toThrow(/source/);

    const wrongWorkload = validRow();
    wrongWorkload.workloadBytes = 8_454_144;
    expect(() => parseMemoryRun(JSON.stringify(wrongWorkload), IDENTITY)).toThrow(/frozen/);

    const wrongChunks = validRow();
    wrongChunks.verifiedChunkCount = 15;
    expect(() => parseMemoryRun(JSON.stringify(wrongChunks), IDENTITY)).toThrow(/frozen/);

    const redirectIdentity: MemoryRunIdentity = {
      ...IDENTITY,
      scenario: "fs.redirect.stream",
      operation: "fs.redirect.stream",
    };
    expect(parseMemoryRun(JSON.stringify(validRedirectRow()), redirectIdentity).source).toBe(
      "Filesystem.writeFileStream",
    );
  });

  it("rejects contradictory process, storage, and raw cgroup measurements", () => {
    const process = validRow();
    process.processTransientBytes = 49;
    expect(() => parseMemoryRun(JSON.stringify(process), IDENTITY)).toThrow(/inconsistent/);

    const target = validRow();
    target.processPeakRssBytes = 104_857_701;
    target.processTransientBytes = 104_857_601;
    expect(() => parseMemoryRun(JSON.stringify(target), IDENTITY)).toThrow(/target/);

    const footprint = validRow();
    footprint.storageFootprintGrowthBytes = 29;
    expect(() => parseMemoryRun(JSON.stringify(footprint), IDENTITY)).toThrow(/inconsistent/);

    const peak = validRow();
    peak.cgroupMemory = {
      before: snapshot(140, 150),
      after: snapshot(200, 250),
      peakGrowthBytes: 99,
    };
    expect(() => parseMemoryRun(JSON.stringify(peak), IDENTITY)).toThrow(/peakGrowthBytes/);
  });

  it("reconciles exact semantic, cost, storage, and source metadata", () => {
    const calibration = parsedCalibration();
    const capped = parseMemoryRun(JSON.stringify(validRow()), IDENTITY);
    reconcileMemoryRuns(calibration, capped);

    const changed = validRow();
    changed.rows = 21;
    const changedCapped = parseMemoryRun(JSON.stringify(changed), IDENTITY);
    expect(() => reconcileMemoryRuns(calibration, changedCapped)).toThrow(/rows/);
  });

  it("requires exact lease affinity, cgroup, memory.max, and disabled swap", () => {
    const expected: RuntimeExpectation = {
      allowedCpus: "8",
      scope: "benchmark",
      memoryMaxBytes: 536_870_912,
    };
    validateRuntimeEvidence(parseRuntimeEvidence(validRuntime()), expected);

    const cases: { field: string; value: unknown; message: RegExp }[] = [
      { field: "allowedCpus", value: "9", message: /differs from parent/ },
      { field: "cgroupPath", value: "/user.slice/app.slice/test.scope", message: /escaped/ },
      { field: "memoryMaxBytes", value: 536_870_911, message: /memory\.max/ },
      { field: "memorySwapMaxBytes", value: 1, message: /memory\.swap\.max/ },
    ];
    for (const { field, value, message } of cases) {
      const runtime = validRuntime();
      runtime[field] = value;
      expect(() => validateRuntimeEvidence(parseRuntimeEvidence(runtime), expected)).toThrow(
        message,
      );
    }
  });

  it("rejects malformed runtime fields before validation", () => {
    const duplicateCpu = validRuntime();
    duplicateCpu.allowedCpus = "8,8";
    expect(() => parseRuntimeEvidence(duplicateCpu)).toThrow(/duplicate/);

    const unboundedSwap = validRuntime();
    unboundedSwap.memorySwapMaxBytes = null;
    expect(() => parseRuntimeEvidence(unboundedSwap)).toThrow(/safe nonnegative integer/);
  });
});
