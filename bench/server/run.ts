import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../tests/helpers/server-oracle-http.js";
import { basicAuth, WORKER_WRITE_TOKEN } from "../../tests/helpers/server-workerd.js";
import { MemorySampler, statusBytes } from "../workerd/proc-memory.js";
import { openResettableUpload } from "./cancellation.js";
import { prepareServerFixture } from "./fixtures.js";
import { assertLease, CpuCheckpoints, memoryContext } from "./metrics.js";
import { startBenchmarkRuntime } from "./runtime.js";
import { activeOwners } from "./transfer-state.js";

const args = process.argv.slice(2);
const runtime = args.includes("--runtime=node")
  ? "node"
  : args.includes("--runtime=workerd")
    ? "workerd"
    : null;
const fixtureName = args.includes("--fixture=medium")
  ? "medium"
  : args.includes("--fixture=large")
    ? "large"
    : null;
if (runtime === null || fixtureName === null || args.length !== 2)
  throw new Error("usage: bench:server -- --runtime=node|workerd --fixture=medium|large");
assertLease();
const fixture = await prepareServerFixture(fixtureName);
const directory = await mkdtemp(join(tmpdir(), "kompjutr-server-bench-"));
let cpu: CpuCheckpoints | undefined;
await mkdir("bench/results", { recursive: true });
const diagnosticLogPath = `bench/results/server-${runtime}-${fixtureName}.runtime.log`;
await writeFile(diagnosticLogPath, "");
const server = await startBenchmarkRuntime(
  runtime,
  directory,
  () => cpu?.checkpoint(),
  diagnosticLogPath,
);
cpu = new CpuCheckpoints(server.pid);
const auth = ["-c", `http.extraHeader=Authorization: ${basicAuth(WORKER_WRITE_TOKEN)}`];
const url = `${server.url}/demo.git`;
const phases: object[] = [];
let failedPhase: string | undefined;
const cancellationState: { beforeCancel?: unknown; afterCancel?: unknown } = {};
function diagnostic<T>(read: () => T): T | { diagnosticError: string } {
  try {
    return read();
  } catch (error) {
    return { diagnosticError: String(error) };
  }
}
async function phase(name: string, operation: () => Promise<unknown>): Promise<void> {
  await server.gc();
  await server.reset();
  const memory = memoryContext(server.pid);
  const sampler = new MemorySampler(server.pid, 5);
  let nodePeakHeapExternalBytes = 0;
  const sampleNode = () => {
    const sample = process.memoryUsage();
    nodePeakHeapExternalBytes = Math.max(
      nodePeakHeapExternalBytes,
      sample.heapUsed + sample.external,
    );
  };
  const nodeTimer = runtime === "node" ? setInterval(sampleNode, 5) : undefined;
  const start = performance.now();
  cpu?.start();
  let operationCompleted = false;
  let cpuResult: ReturnType<CpuCheckpoints["finish"]> | undefined;
  let sampled: ReturnType<MemorySampler["stop"]> | undefined;
  let processPeakRssBytes: number | undefined;
  try {
    await operation();
    operationCompleted = true;
    cpuResult = cpu?.finish();
    const wallMs = performance.now() - start;
    sampled = sampler.stop();
    processPeakRssBytes = statusBytes(server.pid, "VmHWM");
    const counts = await server.counts();
    if (nodeTimer !== undefined) {
      clearInterval(nodeTimer);
      sampleNode();
    }
    await server.gc();
    const result = {
      name,
      counts,
      wallMs,
      ...cpuResult,
      ...memory,
      processPeakRssBytes,
      processAddedPeakRssBytes: Math.max(0, processPeakRssBytes - memory.processBaselineRssBytes),
      sampled,
      v8: server.v8(),
      ...(runtime === "node" ? { nodePeakHeapExternalBytes, nodeMemoryLowerBound: true } : {}),
    };
    phases.push(result);
    process.stderr.write(`${name}: ${JSON.stringify(result)}\n`);
  } catch (error) {
    failedPhase = name;
    const failure = {
      runtime,
      fixture,
      phase: name,
      operationCompleted,
      wallMs: performance.now() - start,
      error: String(error),
      cause: error instanceof Error ? String(error.cause) : undefined,
      cpu: cpuResult ?? diagnostic(() => cpu?.finish()),
      sampled: sampled ?? diagnostic(() => sampler.stop()),
      processPeakRssBytes:
        processPeakRssBytes ?? diagnostic(() => statusBytes(server.pid, "VmHWM")),
      ...memory,
      diagnostics: server.diagnostics(),
      diagnosticLogPath,
      completedPhases: phases,
    };
    const failurePath = `bench/results/server-${runtime}-${fixtureName}.failure.json`;
    await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
    process.stderr.write(
      `Benchmark failed in ${name}; diagnostics: ${failurePath} and ${diagnosticLogPath}\n`,
    );
    throw error;
  } finally {
    diagnostic(() => sampler.stop());
    if (nodeTimer !== undefined) clearInterval(nodeTimer);
  }
}
try {
  await phase("initial-push", () =>
    runGit(fixture.directory, [...auth, "push", url, "refs/heads/main:refs/heads/main"]),
  );
  const clone = join(directory, "clone");
  await phase("full-clone", () =>
    runGit(directory, [...auth, "clone", "--no-checkout", url, clone]),
  );
  await runGit(clone, ["fsck", "--full", "--strict"]);
  const actualHead = (await runGit(clone, ["rev-parse", "HEAD"])).stdout.toString().trim();
  if (actualHead !== fixture.head) throw new Error("clone head differs from fixture");
  const actualObjects = (await runGit(clone, ["rev-list", "--objects", "--all"])).stdout
    .toString()
    .trim()
    .split("\n").length;
  if (actualObjects !== fixture.objects) throw new Error("clone closure differs from fixture");
  const source = join(directory, "source");
  await runGit(directory, ["clone", fixture.directory, source]);
  await writeFile(join(source, "incremental.txt"), "server benchmark incremental v1\n");
  await runGit(source, ["add", "incremental.txt"]);
  await runGit(source, ["commit", "-m", "server benchmark incremental v1"]);
  await phase("incremental-push", () => runGit(source, [...auth, "push", url, "main"]));
  await phase("incremental-fetch", () => runGit(clone, [...auth, "fetch", "origin"]));
  if (
    !(await runGit(clone, ["rev-parse", "origin/main"])).stdout.equals(
      (await runGit(source, ["rev-parse", "HEAD"])).stdout,
    )
  )
    throw new Error("incremental head differs");
  await runGit(clone, ["fsck", "--full", "--strict"]);
  const currentHead = (await runGit(source, ["rev-parse", "HEAD"])).stdout.toString().trim();
  const authorization = basicAuth(WORKER_WRITE_TOKEN);
  const cancellationTransport =
    runtime === "workerd"
      ? "TCP reset to direct application HTTP entry"
      : "Fetch cancellation through measured Node HTTP proxy";
  let cancel: () => Promise<void>;
  if ("directUrl" in server && typeof server.directUrl === "string") {
    const upload = await openResettableUpload(
      `${server.directUrl}/demo.git/git-upload-pack`,
      authorization,
      currentHead,
    );
    cancel = async () => upload.reset();
  } else {
    const abort = new AbortController();
    const response = await fetch(`${url}/git-upload-pack`, {
      method: "POST",
      signal: abort.signal,
      headers: { authorization, "content-type": "application/x-git-upload-pack-request" },
      body: `0032want ${currentHead}\n00000009done\n`,
    });
    if (!response.ok)
      throw new Error(`cancellation upload returned ${response.status}: ${await response.text()}`);
    const reader = response.body?.getReader();
    await reader?.read();
    cancel = async () => {
      await reader?.cancel();
      abort.abort();
    };
  }
  const beforeCancel = await server.transferState();
  cancellationState.beforeCancel = beforeCancel;
  if (activeOwners(beforeCancel) === 0)
    throw new Error("cancellation witness has no active transfer");
  await cancel();
  let afterCancel = await server.transferState();
  cancellationState.afterCancel = afterCancel;
  for (let poll = 0; activeOwners(afterCancel) > 0 && poll < 100; poll++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    afterCancel = await server.transferState();
    cancellationState.afterCancel = afterCancel;
  }
  if (activeOwners(afterCancel) !== 0)
    throw new Error("cancellation failed to release its owner before expiry");
  const cleanup = await server.cleanup();
  if (
    typeof cleanup !== "object" ||
    cleanup === null ||
    Reflect.get(cleanup, "owners") !== 0 ||
    Reflect.get(cleanup, "scratch") !== 0
  )
    throw new Error("cancellation left transfer state");
  const result = {
    runtime,
    fixture,
    phases,
    cancellation: {
      transport: cancellationTransport,
      beforeCancel,
      afterCancel,
      immediateRelease: true,
      cleanupClockAdvanceMs: 600_000,
    },
    cleanup,
    measuredCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    measuredTreeChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
    memoryInterpretation:
      "RSS measures the whole local process, not the production isolate. V8 peak samples are lower bounds; local success does not prove the 128MB production limit.",
    sqlInterpretation:
      "Statements executed and cursor rows returned; returnedRows does not measure SQLite rows scanned or billed reads.",
    cpuInterpretation:
      "Host process CPU at acknowledged yield checkpoints, with begin/end phase markers. Includes runtime/background CPU, never DO Date.now duration.",
  };
  await mkdir("bench/results", { recursive: true });
  await writeFile(
    `bench/results/server-${runtime}-${fixtureName}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (failedPhase === undefined) {
    await writeFile(
      `bench/results/server-${runtime}-${fixtureName}.failure.json`,
      `${JSON.stringify(
        {
          runtime,
          fixture,
          stage: "verification-or-cancellation",
          error: String(error),
          completedPhases: phases,
          cancellationState,
          diagnostics: server.diagnostics(),
          diagnosticLogPath,
        },
        null,
        2,
      )}\n`,
    );
  }
  throw error;
} finally {
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
