import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import {
  PROBE_FIXTURE_FETCH_HEAD,
  PROBE_FIXTURE_HEAD,
  PROBE_FIXTURE_URL,
  PROBE_RESPONSE_LIMIT,
  PROBE_STATEMENT_LIMIT,
  PROBE_WORKER_NAME,
  type ProbeSuccess,
  probeSuccess,
} from "./protocol.js";

const REQUEST_TIMEOUT_MS = 120_000;
const RESET_TIMEOUT_MS = 30_000;

interface ResponseMetadata {
  version: string;
  colo: string;
  country: string;
}

interface OperationEvidence {
  action: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  status: number;
  metadata: ResponseMetadata;
  response: ProbeSuccess;
}

interface FailureEvidence {
  action: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  status: number;
  metadata: ResponseMetadata;
  body: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value?.slice(prefix.length);
}

function requiredEnvironment(name: string, argumentName: string): string {
  const value = argument(argumentName) ?? process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} or --${argumentName}=... is required`);
  }
  return value;
}

function metadata(response: Response): ResponseMetadata {
  return {
    version: response.headers.get("x-probe-version") ?? "unknown",
    colo: response.headers.get("x-probe-colo") ?? "unknown",
    country: response.headers.get("x-probe-country") ?? "unknown",
  };
}

async function boundedBody(response: Response): Promise<string> {
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > PROBE_RESPONSE_LIMIT) {
    throw new Error(`probe response has ${body.length} bytes; limit is ${PROBE_RESPONSE_LIMIT}`);
  }
  return new TextDecoder().decode(body);
}

function probeUrl(baseUrl: string, runId: string, action: string): string {
  return `${baseUrl.replace(/\/$/, "")}/runs/${runId}/${action}`;
}

function verifyResponse(action: string, value: ProbeSuccess): void {
  if (value.action !== action) {
    throw new Error(`probe returned action ${value.action} for ${action}`);
  }
  if (value.foreignKeysAfter !== 1) {
    throw new Error(`${action} left PRAGMA foreign_keys=${value.foreignKeysAfter}`);
  }
  if (value.metrics.statements > PROBE_STATEMENT_LIMIT) {
    throw new Error(`${action} used ${value.metrics.statements} SQL statements`);
  }
}

async function operation(
  baseUrl: string,
  token: string,
  runId: string,
  action: string,
): Promise<OperationEvidence> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await fetch(probeUrl(baseUrl, runId, action), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const wallMs = performance.now() - started;
  const finishedAt = new Date().toISOString();
  const body = await boundedBody(response);
  if (!response.ok) {
    throw new Error(`${action} failed with HTTP ${response.status}: ${body}`);
  }
  const parsed: unknown = JSON.parse(body);
  const value = probeSuccess(parsed);
  verifyResponse(action, value);
  return {
    action,
    runId,
    startedAt,
    finishedAt,
    wallMs,
    status: response.status,
    metadata: metadata(response),
    response: value,
  };
}

async function expectedFailure(
  baseUrl: string,
  token: string,
  runId: string,
  action: string,
): Promise<FailureEvidence> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await fetch(probeUrl(baseUrl, runId, action), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const wallMs = performance.now() - started;
  const finishedAt = new Date().toISOString();
  const body = await boundedBody(response);
  if (response.status < 500) {
    throw new Error(`${action} returned HTTP ${response.status}; expected an application error`);
  }
  return {
    action,
    runId,
    startedAt,
    finishedAt,
    wallMs,
    status: response.status,
    metadata: metadata(response),
    body,
  };
}

async function reopened(
  baseUrl: string,
  token: string,
  runId: string,
  previousInstanceId: string,
  records: OperationEvidence[],
): Promise<OperationEvidence> {
  const deadline = performance.now() + RESET_TIMEOUT_MS;
  let lastInstanceId = previousInstanceId;
  while (performance.now() < deadline) {
    try {
      const current = await operation(baseUrl, token, runId, "meta");
      lastInstanceId = current.response.instanceId;
      if (lastInstanceId !== previousInstanceId) {
        records.push(current);
        return current;
      }
    } catch (error) {
      if (performance.now() >= deadline) throw error;
    }
    await setTimeout(250);
  }
  throw new Error(`Durable Object ${runId} did not reopen: instance remained ${lastInstanceId}`);
}

function fact(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error("probe facts are not an object");
  }
  return Reflect.get(value, key);
}

function makeRunId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .toLowerCase();
  return `probe-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function probeSourceSha256(): string {
  const hash = createHash("sha256");
  for (const path of [
    "bench/production/protocol.ts",
    "bench/production/run.ts",
    "bench/production/worker.ts",
    "bench/production/wrangler.jsonc",
  ]) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(process.cwd(), path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const baseUrl = requiredEnvironment("KOMPJUTR_PROBE_URL", "url");
const token = requiredEnvironment("KOMPJUTR_PROBE_TOKEN", "token");
if (token.length < 32) throw new Error("KOMPJUTR_PROBE_TOKEN must contain at least 32 characters");

const runId = makeRunId();
const storageRunId = `${runId}-storage`;
const startedAt = new Date().toISOString();
const operations: OperationEvidence[] = [];
const failures: FailureEvidence[] = [];

const unauthorized = await fetch(probeUrl(baseUrl, runId, "meta"), {
  method: "POST",
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
await boundedBody(unauthorized);
if (unauthorized.status !== 401) {
  throw new Error(`unauthenticated request returned HTTP ${unauthorized.status}, expected 401`);
}

async function record(targetRunId: string, action: string): Promise<OperationEvidence> {
  const evidence = await operation(baseUrl, token, targetRunId, action);
  operations.push(evidence);
  console.log(
    `${targetRunId} ${action}: ${evidence.wallMs.toFixed(1)} ms, ` +
      `${evidence.response.metrics.statements} statements, ${evidence.response.databaseBytes} bytes`,
  );
  return evidence;
}

await record(runId, "meta");
for (const action of ["clone", "fetch", "mutate", "add", "commit", "push", "rebase-clean"]) {
  await record(runId, action);
}

const continueSetup = await record(runId, "rebase-continue-setup");
failures.push(await expectedFailure(baseUrl, token, runId, "isolate-reset"));
await reopened(baseUrl, token, runId, continueSetup.response.instanceId, operations);
await record(runId, "rebase-continue-status");
await record(runId, "rebase-continue-resolve");
await record(runId, "rebase-continue-finish");

const abortSetup = await record(runId, "rebase-abort-setup");
failures.push(await expectedFailure(baseUrl, token, runId, "isolate-reset"));
await reopened(baseUrl, token, runId, abortSetup.response.instanceId, operations);
await record(runId, "rebase-abort-status");
await record(runId, "rebase-abort-finish");

const beforeApplicationFailure = await record(runId, "meta");
failures.push(await expectedFailure(baseUrl, token, runId, "application-failure"));
const afterApplicationFailure = await record(runId, "meta");
if (afterApplicationFailure.response.instanceId !== beforeApplicationFailure.response.instanceId) {
  throw new Error("application failure unexpectedly reset the Durable Object instance");
}
await record(runId, "audit");

await record(storageRunId, "meta");
const marker = await record(storageRunId, "marker-set");
if (fact(marker.response.facts, "marker") !== "present") {
  throw new Error("storage reset marker was not persisted");
}
const storageReset = await record(storageRunId, "storage-reset");
if (fact(storageReset.response.facts, "deleted") !== true) {
  throw new Error("storage reset did not confirm deletion");
}
failures.push(await expectedFailure(baseUrl, token, storageRunId, "isolate-reset"));
await reopened(baseUrl, token, storageRunId, storageReset.response.instanceId, operations);
const markerAfterReset = await record(storageRunId, "marker-state");
if (fact(markerAfterReset.response.facts, "marker") !== null) {
  throw new Error("storage reset retained the disposable marker");
}

const finishedAt = new Date().toISOString();
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceStatus = execFileSync(
  "git",
  [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "bench/production",
    "package.json",
    "package-lock.json",
  ],
  { encoding: "utf8" },
).trim();
const wranglerVersion = execFileSync(
  join(process.cwd(), "node_modules/.bin/wrangler"),
  ["--version"],
  { encoding: "utf8" },
).trim();
const versions = new Set(operations.map((entry) => entry.metadata.version));
if (versions.size !== 1 || versions.has("unknown")) {
  throw new Error(`probe responses did not identify one deployment version: ${[...versions]}`);
}
const evidence = {
  schemaVersion: 1,
  worker: PROBE_WORKER_NAME,
  workerUrl: baseUrl,
  runId,
  storageRunId,
  startedAt,
  finishedAt,
  sourceCommit,
  sourceDirty: sourceStatus !== "",
  probeSourceSha256: probeSourceSha256(),
  wranglerVersion,
  deploymentVersion: [...versions][0],
  fixture: {
    url: PROBE_FIXTURE_URL,
    head: PROBE_FIXTURE_HEAD,
    fetchHead: PROBE_FIXTURE_FETCH_HEAD,
  },
  authentication: { unauthenticatedStatus: unauthorized.status },
  operations,
  expectedFailures: failures,
};
const outputDirectory = join(process.cwd(), "bench/results");
mkdirSync(outputDirectory, { recursive: true });
const output = join(outputDirectory, `production-do-${runId}.json`);
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`Production probe passed. Raw evidence: ${output}`);
