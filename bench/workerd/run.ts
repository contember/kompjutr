import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

import { startGitServer } from "../../tests/helpers/http-backend.js";
import { FIXTURES, ORIGIN_BRANCH, prepareFixture, trackedEntries } from "../fixtures.js";

const STATEMENT_TARGET = 1_000;

interface CloneResult {
  statements: number;
  rows: number;
  trackedFiles: number;
  worktreeFiles: number;
  invalidFiles: number;
  head: string;
  databaseBytes: number;
}

interface WorkerdMemory {
  baselineRssBytes: number;
  peakRssBytes: number;
}

function statementTarget(statements: number): "pass" | "miss" {
  return statements <= STATEMENT_TARGET ? "pass" : "miss";
}

function cloneResult(value: unknown): CloneResult {
  if (typeof value !== "object" || value === null) throw new Error("invalid benchmark result");
  const statements = Reflect.get(value, "statements");
  const rows = Reflect.get(value, "rows");
  const trackedFiles = Reflect.get(value, "trackedFiles");
  const worktreeFiles = Reflect.get(value, "worktreeFiles");
  const invalidFiles = Reflect.get(value, "invalidFiles");
  const head = Reflect.get(value, "head");
  const databaseBytes = Reflect.get(value, "databaseBytes");
  if (
    typeof statements !== "number" ||
    !Number.isSafeInteger(statements) ||
    statements < 0 ||
    typeof rows !== "number" ||
    !Number.isSafeInteger(rows) ||
    rows < 0 ||
    typeof trackedFiles !== "number" ||
    !Number.isSafeInteger(trackedFiles) ||
    trackedFiles < 0 ||
    typeof worktreeFiles !== "number" ||
    !Number.isSafeInteger(worktreeFiles) ||
    worktreeFiles < 0 ||
    typeof invalidFiles !== "number" ||
    !Number.isSafeInteger(invalidFiles) ||
    invalidFiles < 0 ||
    typeof head !== "string" ||
    typeof databaseBytes !== "number" ||
    !Number.isSafeInteger(databaseBytes)
  ) {
    const error = Reflect.get(value, "error");
    throw new Error(typeof error === "string" ? error : "invalid benchmark result");
  }
  return { statements, rows, trackedFiles, worktreeFiles, invalidFiles, head, databaseBytes };
}

async function runClone(
  namespace: unknown,
  body: string,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
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
  const result: unknown = await Reflect.apply(fetch, stub, [
    "http://bench/clone",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
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
  return { ok, status, payload };
}

function workerdPid(): number {
  const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim();
  for (const field of children.split(/\s+/)) {
    if (field === "") continue;
    const pid = Number(field);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      if (readlinkSync(`/proc/${pid}/exe`).endsWith("/workerd")) return pid;
    } catch {
      // A short-lived child can exit while the process list is inspected.
    }
  }
  throw new Error("Miniflare workerd process was not found");
}

function statusBytes(pid: number, field: "VmRSS" | "VmHWM"): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(status);
  if (match === null) throw new Error(`${field} is unavailable for workerd ${pid}`);
  return Number(match[1]) * 1024;
}

const here = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "kompjutr-workerd-nextjs-"));
let origin: { url: string; close(): Promise<void> } | undefined;

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
    const baselineRssBytes = statusBytes(runtimePid, "VmRSS");
    const namespace = await miniflare.getDurableObjectNamespace("BENCH");
    const started = performance.now();
    const response = await runClone(
      namespace,
      JSON.stringify({ originUrl: origin.url, expectedHead, expectedFiles }),
    );
    const wallMs = performance.now() - started;
    if (!response.ok) {
      const error =
        typeof response.payload === "object" && response.payload !== null
          ? Reflect.get(response.payload, "error")
          : undefined;
      throw new Error(typeof error === "string" ? error : `workerd returned ${response.status}`);
    }
    const result = cloneResult(response.payload);
    const memory: WorkerdMemory = {
      baselineRssBytes,
      peakRssBytes: statusBytes(runtimePid, "VmHWM"),
    };
    const addedPeakRssBytes = Math.max(0, memory.peakRssBytes - memory.baselineRssBytes);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...result,
          wallMs,
          workerdBaselineRssBytes: memory.baselineRssBytes,
          workerdPeakRssBytes: memory.peakRssBytes,
          workerdAddedPeakRssBytes: addedPeakRssBytes,
          statementTarget: {
            atMost: STATEMENT_TARGET,
            status: statementTarget(result.statements),
          },
        },
        null,
        2,
      )}\n`,
    );
    const failures: string[] = [];
    // Local workerd has no isolate limit; this is a process-level regression gate.
    if (addedPeakRssBytes > 100 * 1024 * 1024) {
      failures.push(`${addedPeakRssBytes} added workerd RSS bytes > 100 MiB`);
    }
    if (failures.length > 0) throw new Error(`clone gate failed: ${failures.join(", ")}`);
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
