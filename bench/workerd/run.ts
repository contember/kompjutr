import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare, type StructuredLogsHandler } from "miniflare";

import { startGitServer } from "../../tests/helpers/http-backend.js";
import { FIXTURES, ORIGIN_BRANCH, prepareFixture, trackedEntries } from "../fixtures.js";
import { GC_TRACE_V8_FLAGS, GcTrace, lineBufferedRuntimeEnv } from "./gc-trace.js";
import {
  MemorySampler,
  resetPeakRss,
  rollupSample,
  statusBytes,
  workerdCgroup,
  workerdPid,
} from "./proc-memory.js";

const STATEMENT_TARGET = 1_000;
// A regression limit at today's level, not the production isolate limit (ADR-0026).
const V8_USED_PLUS_EXTERNAL_LIMIT_BYTES = 300 * 1024 * 1024;
const SAMPLE_INTERVAL_MS = 5;
const TRACE_TIMEOUT_MS = 10_000;

interface CloneCounts {
  statements: number;
  rows: number;
}

interface CheckoutResult {
  trackedFiles: number;
  worktreeFiles: number;
  invalidFiles: number;
  head: string;
  databaseBytes: number;
}

type DurableObjectPost = (path: string, body: object) => Promise<unknown>;

function statementTarget(statements: number): "pass" | "miss" {
  return statements <= STATEMENT_TARGET ? "pass" : "miss";
}

function count(value: object, key: string): number {
  const field = Reflect.get(value, key);
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`invalid benchmark result field ${key}`);
  }
  return field;
}

function cloneCounts(value: unknown): CloneCounts {
  if (typeof value !== "object" || value === null) throw new Error("invalid clone result");
  return { statements: count(value, "statements"), rows: count(value, "rows") };
}

function checkoutResult(value: unknown): CheckoutResult {
  if (typeof value !== "object" || value === null) throw new Error("invalid checkout result");
  const head = Reflect.get(value, "head");
  if (typeof head !== "string") throw new Error("invalid benchmark result field head");
  return {
    trackedFiles: count(value, "trackedFiles"),
    worktreeFiles: count(value, "worktreeFiles"),
    invalidFiles: count(value, "invalidFiles"),
    head,
    databaseBytes: count(value, "databaseBytes"),
  };
}

function durableObjectPost(namespace: unknown): DurableObjectPost {
  if (typeof namespace !== "object" || namespace === null) {
    throw new Error("Miniflare returned no Durable Object namespace");
  }
  const getByName = Reflect.get(namespace, "getByName");
  if (typeof getByName !== "function") {
    throw new Error("Durable Object namespace has no getByName method");
  }
  const stub = Reflect.apply(getByName, namespace, ["nextjs"]);
  if (typeof stub !== "object" || stub === null) {
    throw new Error("Durable Object namespace returned no stub");
  }
  const fetch = Reflect.get(stub, "fetch");
  if (typeof fetch !== "function") throw new Error("Durable Object stub has no fetch method");
  return async (path, body) => {
    const result: unknown = await Reflect.apply(fetch, stub, [
      `http://bench${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ]);
    if (typeof result !== "object" || result === null) {
      throw new Error("Durable Object fetch returned no Response");
    }
    const ok = Reflect.get(result, "ok");
    const status = Reflect.get(result, "status");
    const json = Reflect.get(result, "json");
    if (typeof ok !== "boolean" || typeof status !== "number" || typeof json !== "function") {
      throw new Error("Durable Object fetch returned an invalid Response");
    }
    const payload: unknown = await Reflect.apply(json, result, []);
    if (!ok) {
      const error =
        typeof payload === "object" && payload !== null ? Reflect.get(payload, "error") : undefined;
      throw new Error(typeof error === "string" ? error : `workerd ${path} returned ${status}`);
    }
    return payload;
  };
}

function measuredRevision(root: string): { commit: string; changes: string[] } {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0);
  return { commit, changes };
}

function packageVersion(name: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(createRequire(import.meta.url).resolve(`${name}/package.json`), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string") throw new Error(`${name} has no package version`);
  return version;
}

const here = dirname(fileURLToPath(import.meta.url));
const revision = measuredRevision(join(here, "..", ".."));
const runtimeVersions = {
  workerd: packageVersion("workerd"),
  miniflare: packageVersion("miniflare"),
};
const runtimeEnv = lineBufferedRuntimeEnv();
const temporary = mkdtempSync(join(tmpdir(), "kompjutr-workerd-nextjs-"));
let origin: { url: string; close(): Promise<void> } | undefined;

// Appended, so a caller's own workerd V8 flags still apply.
const inheritedV8Flags = process.env.MINIFLARE_WORKERD_V8_FLAGS?.trim() ?? "";
process.env.MINIFLARE_WORKERD_V8_FLAGS = [inheritedV8Flags, ...GC_TRACE_V8_FLAGS]
  .filter((flag) => flag.length > 0)
  .join(" ");
const trace = new GcTrace();
const routeWorkerdLog: StructuredLogsHandler = ({ level, message }) => {
  if (!trace.accept(message)) process.stderr.write(`[workerd ${level}] ${message}\n`);
};

try {
  const fixture = FIXTURES.nextjs;
  const fixtureDir = prepareFixture(fixture);
  const expectedFiles = trackedEntries(fixtureDir).length;
  if (expectedFiles !== fixture.files) {
    throw new Error(`fixture has ${expectedFiles} tracked files, expected ${fixture.files}`);
  }
  const expectedHead = execFileSync("git", ["rev-parse", ORIGIN_BRANCH], {
    cwd: fixtureDir,
    encoding: "utf8",
  }).trim();
  origin = await startGitServer(join(fixtureDir, ".git"));
  const bundle = join(temporary, "worker.mjs");
  await build({
    entryPoints: [join(here, "worker.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:*"],
    outfile: bundle,
  });
  const miniflare = new Miniflare({
    resourcePersistencePath: join(temporary, "state"),
    handleStructuredLogs: routeWorkerdLog,
    unsafeRuntimeEnv: runtimeEnv,
    workers: [
      {
        config: {
          name: "bench",
          type: "worker",
          compatibilityDate: "2026-08-15",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: temporary,
            modules: {
              "worker.mjs": { type: "esm", contents: readFileSync(bundle, "utf8") },
            },
          },
          env: {
            BENCH: { type: "durable-object", workerName: "bench", exportName: "CloneBench" },
          },
          exports: {
            CloneBench: { type: "durable-object", storage: "sqlite" },
          },
        },
      },
    ],
  });
  try {
    await miniflare.ready;
    const runtimePid = workerdPid();
    const cgroup = workerdCgroup(runtimePid);
    const post = durableObjectPost(await miniflare.getDurableObjectNamespace("BENCH"));

    // The baseline follows Durable Object startup and a full GC, so the measured
    // region holds the clone alone.
    await post("/warm", {});
    await post("/gc", {});
    await trace.waitForMarker(1, TRACE_TIMEOUT_MS);
    const baselineRollup = rollupSample(runtimePid);
    const baselineRssBytes = statusBytes(runtimePid, "VmRSS");
    resetPeakRss(runtimePid);
    const sampler = new MemorySampler(runtimePid, SAMPLE_INTERVAL_MS);
    const started = performance.now();
    let counts: CloneCounts;
    try {
      counts = cloneCounts(await post("/clone", { originUrl: origin.url }));
    } catch (error) {
      sampler.stop();
      throw error;
    }
    const wallMs = performance.now() - started;
    const sampled = sampler.stop();
    const peakRssBytes = statusBytes(runtimePid, "VmHWM");

    // The closing forced GC samples the heap the clone left and proves that the
    // trace reached the end of the clone.
    await post("/gc", {});
    await trace.waitForMarker(2, TRACE_TIMEOUT_MS);
    const afterGcRollup = rollupSample(runtimePid);
    const v8 = trace.attributeBetweenMarkers(1, 2);

    const checkout = checkoutResult(await post("/verify", { expectedHead, expectedFiles }));

    const addedPeakRssBytes = Math.max(0, peakRssBytes - baselineRssBytes);
    // Each residue pairs one smaps_rollup with the forced GC just before it, so
    // both sides describe the same idle moment.
    const baselineNonV8Bytes =
      baselineRollup.rssBytes - v8.baseline.committedBytes - v8.baseline.externalBytes;
    const afterCloneNonV8Bytes =
      afterGcRollup.rssBytes - v8.final.committedBytes - v8.final.externalBytes;
    process.stdout.write(
      `${JSON.stringify(
        {
          ...counts,
          ...checkout,
          wallMs,
          measuredCommit: revision.commit,
          measuredTreeDirty: revision.changes.length > 0,
          measuredTreeChanges: revision.changes,
          runtimeVersions,
          cgroup,
          workerdBaselineRssBytes: baselineRssBytes,
          workerdPeakRssBytes: peakRssBytes,
          workerdAddedPeakRssBytes: addedPeakRssBytes,
          clone: {
            v8: {
              lowerBound: true,
              gcEvents: v8.gcEvents,
              forcedGcEvents: v8.forcedEvents,
              samples: v8.samples,
              otherIsolateGcEvents: v8.otherIsolateEvents,
              unrecognizedTraceLines: v8.unrecognizedTraceLines,
              unrecognizedTraceSample: v8.unrecognizedTraceSample,
              baseline: v8.baseline,
              afterClone: v8.final,
              peakUsedBytes: v8.peakUsedBytes,
              peakCommittedBytes: v8.peakCommittedBytes,
              peakExternalBytes: v8.peakExternalBytes,
              peakArrayBufferBytes: v8.peakArrayBufferBytes,
              peakUsedPlusExternalBytes: v8.peakUsedPlusExternalBytes,
              peakCommittedPlusExternalBytes: v8.peakCommittedPlusExternalBytes,
            },
            process: {
              baselineRssBytes,
              peakRssBytes,
              addedPeakRssBytes,
              baselineRollup,
              afterClosingGcRollup: afterGcRollup,
              sampled: {
                resolution: `±${sampled.intervalMs} ms samples of /proc/<pid>/status`,
                peakAnonymousBytes: sampled.peakAnonymousBytes,
                peakFileBytes: sampled.peakFileBytes,
                atPeakRss: sampled.peakRss,
                samples: sampled.samples,
                samplingMs: sampled.samplingMs,
              },
            },
            nonV8Residue: {
              bound: "point value at an idle moment after a forced GC; not a bound on the peak",
              baselineBytes: baselineNonV8Bytes,
              afterCloneBytes: afterCloneNonV8Bytes,
              addedBytes: afterCloneNonV8Bytes - baselineNonV8Bytes,
            },
          },
          statementTarget: {
            atMost: STATEMENT_TARGET,
            status: statementTarget(counts.statements),
          },
          v8RegressionLimit: {
            measure: "clone.v8.peakUsedPlusExternalBytes",
            limitBytes: V8_USED_PLUS_EXTERNAL_LIMIT_BYTES,
            status:
              v8.peakUsedPlusExternalBytes <= V8_USED_PLUS_EXTERNAL_LIMIT_BYTES ? "pass" : "fail",
          },
        },
        null,
        2,
      )}\n`,
    );
    // Process RSS is report-only: local workerd RSS does not measure the isolate limit.
    if (v8.peakUsedPlusExternalBytes > V8_USED_PLUS_EXTERNAL_LIMIT_BYTES) {
      throw new Error(
        `clone gate failed: ${v8.peakUsedPlusExternalBytes} V8 used + external bytes > ${V8_USED_PLUS_EXTERNAL_LIMIT_BYTES}`,
      );
    }
  } finally {
    await miniflare.dispose();
  }
} finally {
  try {
    await origin?.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
