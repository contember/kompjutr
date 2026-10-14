import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, type StructuredLogsHandler } from "miniflare";
import type { ServerEnvironment } from "../../examples/git-server/worker.js";

export const WORKER_READ_TOKEN = "test-read-token";
export const WORKER_WRITE_TOKEN = "test-write-token";

export function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`git:${token}`).toString("base64")}`;
}

export async function startWorkerdServer(
  directory: string,
  options: {
    entry?: string;
    exportName?: string;
    logs?: StructuredLogsHandler;
    runtimeEnv?: Record<string, string>;
    markerUrl?: string;
  } = {},
) {
  const bundle = join(directory, "server.mjs");
  await build({
    entryPoints: [resolve(options.entry ?? "examples/git-server/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:*"],
    outfile: bundle,
  });
  const exportName = options.exportName ?? "GitRepository";
  const secrets: Pick<ServerEnvironment, "GIT_READ_TOKEN" | "GIT_WRITE_TOKEN"> = {
    GIT_READ_TOKEN: WORKER_READ_TOKEN,
    GIT_WRITE_TOKEN: WORKER_WRITE_TOKEN,
  };
  const runtime = new Miniflare({
    resourcePersistencePath: join(directory, "state"),
    ...(options.logs === undefined ? {} : { handleStructuredLogs: options.logs }),
    ...(options.runtimeEnv === undefined ? {} : { unsafeRuntimeEnv: options.runtimeEnv }),
    workers: [
      {
        config: {
          name: "server",
          type: "worker",
          compatibilityDate: "2026-08-15",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "server.mjs",
            modulesRoot: directory,
            modules: { "server.mjs": { type: "esm", contents: readFileSync(bundle, "utf8") } },
          },
          env: {
            REPOSITORIES: { type: "durable-object", workerName: "server", exportName },
            ...(options.markerUrl === undefined
              ? {}
              : { BENCH_MARKER_URL: { type: "text", value: options.markerUrl } }),
            GIT_READ_TOKEN: { type: "text", value: secrets.GIT_READ_TOKEN },
            GIT_WRITE_TOKEN: { type: "text", value: secrets.GIT_WRITE_TOKEN },
          },
          exports: { [exportName]: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
  try {
    return { runtime, url: (await runtime.ready).origin, close: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
