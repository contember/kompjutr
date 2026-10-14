import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createGitServer, Database, maintainRepository, SqliteGitDatabase } from "@kompjutr/do";
import example from "../../examples/git-server/worker.js";
import { startHandlerServer } from "../../tests/helpers/server-oracle-http.js";
import {
  startWorkerdServer,
  WORKER_READ_TOKEN,
  WORKER_WRITE_TOKEN,
} from "../../tests/helpers/server-workerd.js";
import { SqliteTestStorage } from "../../tests/helpers/storage.js";
import {
  GC_TRACE_V8_FLAGS,
  type GcEvent,
  GcTrace,
  lineBufferedRuntimeEnv,
} from "../workerd/gc-trace.js";
import { workerdPid } from "../workerd/proc-memory.js";
import { benchmarkControl, phaseCounts } from "./control.js";
import { forwardBenchmarkRequest } from "./forward.js";
import { serverGcMetrics } from "./gc-metrics.js";
import { CountedStorage } from "./storage.js";
import { transferState } from "./transfer-state.js";

export async function startBenchmarkRuntime(
  kind: "node" | "workerd",
  directory: string,
  checkpoint: () => void | Promise<void>,
  diagnosticLogPath?: string,
) {
  let receivedBytes = 0;
  let sentBytes = 0;
  const count = (body: ReadableStream<Uint8Array> | null, received: boolean) =>
    body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (received) receivedBytes += chunk.byteLength;
          else sentBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    ) ?? null;
  let handler: (request: Request) => Promise<Response> = async () =>
    new Response("initializing", { status: 503 });
  const proxy = await startHandlerServer(async (request) => {
    if (new URL(request.url).pathname === "/__yield") {
      await checkpoint();
      return new Response("ok");
    }
    const body = count(request.body, true);
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      duplex: "half",
      ...(body === null ? {} : { body }),
    };
    const response = await handler(new Request(request.url, init));
    return new Response(count(response.body, false), {
      status: response.status,
      headers: response.headers,
    });
  });
  let disposeRuntime: () => Promise<void> = async () => {};
  let restoreEnvironment = () => {};
  const close = async () => {
    try {
      await proxy.close();
    } finally {
      try {
        await disposeRuntime();
      } finally {
        restoreEnvironment();
      }
    }
  };
  try {
    if (kind === "node") {
      const storage = new SqliteTestStorage(`${directory}/server.sqlite`);
      disposeRuntime = async () => {
        storage.db.close();
      };
      const counted = new CountedStorage(storage);
      const database = new SqliteGitDatabase(new Database(counted));
      const store = database.createBareRepository();
      const server = createGitServer(store, {
        maxPackBytes: 256 * 1024 * 1024,
        yieldNow: async () => {
          await checkpoint();
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      });
      handler = (request) =>
        example.fetch(request, {
          REPOSITORIES: { getByName: () => server },
          GIT_READ_TOKEN: WORKER_READ_TOKEN,
          GIT_WRITE_TOKEN: WORKER_WRITE_TOKEN,
        });
      return {
        url: new URL(proxy.url).origin,
        pid: process.pid,
        reset: async () => {
          counted.reset();
          receivedBytes = sentBytes = 0;
        },
        counts: async () => ({ ...counted.counts(), receivedBytes, sentBytes }),
        gc: async () => {
          globalThis.gc?.();
        },
        v8: () => ({
          lowerBound: true,
          note: "Node process.memoryUsage samples reported per phase; no workerd isolate equivalence",
        }),
        diagnostics: () => ({
          memory: process.memoryUsage(),
          proxyErrors: proxy.errors.map(String),
        }),
        transferState: async () => transferState(store.db),
        cleanup: async () => {
          let steps = 0;
          while (steps++ < 100_000) {
            maintainRepository(database, store.repoId, { nowMs: Date.now() + 600_000 });
            const owners = store.db.scalar<number>("SELECT COUNT(*) FROM git_transfers");
            if (owners === 0)
              return {
                steps,
                owners,
                scratch: store.db.scalar<number>("SELECT COUNT(*) FROM git_transfer_objects"),
              };
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          throw new Error("transfer cleanup did not finish");
        },
        close,
      };
    }
    const trace = new GcTrace();
    const flags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
    restoreEnvironment = () => {
      if (flags === undefined) delete process.env.MINIFLARE_WORKERD_V8_FLAGS;
      else process.env.MINIFLARE_WORKERD_V8_FLAGS = flags;
    };
    process.env.MINIFLARE_WORKERD_V8_FLAGS = [flags?.trim() ?? "", ...GC_TRACE_V8_FLAGS]
      .filter((flag) => flag.length > 0)
      .join(" ");
    const worker = await startWorkerdServer(directory, {
      entry: "bench/server/worker.ts",
      exportName: "ServerBench",
      markerUrl: `${new URL(proxy.url).origin}/__yield`,
      runtimeEnv: lineBufferedRuntimeEnv(),
      logs: ({ level, message }) => {
        if (diagnosticLogPath !== undefined)
          appendFileSync(diagnosticLogPath, `${JSON.stringify({ level, message })}\n`);
        if (!trace.accept(message)) process.stderr.write(`[workerd ${level}] ${message}\n`);
      },
    });
    disposeRuntime = () => worker.close();
    handler = (request) => {
      const url = new URL(request.url);
      const forwarded = forwardBenchmarkRequest(request, worker.url);
      return fetch(forwarded).catch((error: unknown) => {
        process.stderr.write(
          `benchmark proxy ${request.method} ${url.pathname}: ${String(error)}\n`,
        );
        if (error instanceof Error && error.cause !== undefined)
          process.stderr.write(`${String(error.cause)}\n`);
        throw error;
      });
    };
    const control = (path: string) => benchmarkControl(worker.url, path);
    let marker = 0;
    let phase = "uninitialized";
    const boundaries: GcEvent[] = [];
    return {
      url: new URL(proxy.url).origin,
      directUrl: worker.url,
      pid: workerdPid(),
      reset: async () => {
        phase = randomUUID();
        await control(`reset?phase=${phase}`);
        receivedBytes = sentBytes = 0;
      },
      counts: async () => ({
        sql: phaseCounts(await control("counts"), phase),
        receivedBytes,
        sentBytes,
      }),
      gc: async () => {
        await control("gc");
        await trace.waitForMarker(++marker, 10_000);
        const boundary = trace.events.findLast((event) => event.forced);
        if (boundary === undefined) throw new Error("missing forced GC boundary");
        boundaries.push(boundary);
      },
      v8: () => serverGcMetrics(trace, marker, boundaries),
      diagnostics: () => ({
        gcEvents: trace.events,
        markerCount: marker,
        proxyErrors: proxy.errors.map(String),
      }),
      transferState: () => control("state"),
      cleanup: () => control("cleanup"),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Benchmark setup and cleanup failed");
    }
    throw error;
  }
}
