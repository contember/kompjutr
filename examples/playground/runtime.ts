import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Miniflare } from "miniflare";

export function createRuntime(options: {
  scriptPath: string;
  originUrl: string;
  persistPath: string;
  port?: number;
  filter?: "blob:none";
}) {
  return new Miniflare({
    host: "127.0.0.1",
    port: options.port,
    resourcePersistencePath: options.persistPath,
    workers: [
      {
        config: {
          name: "playground",
          type: "worker",
          compatibilityDate: "2026-08-15",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: dirname(options.scriptPath),
            modules: {
              "worker.mjs": { type: "esm", contents: readFileSync(options.scriptPath, "utf8") },
            },
          },
          env: {
            ORIGIN_URL: { type: "text", value: options.originUrl },
            CLONE_FILTER: { type: "text", value: options.filter ?? "none" },
            PLAYGROUND: {
              type: "durable-object",
              workerName: "playground",
              exportName: "Playground",
            },
          },
          exports: { Playground: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
}
