import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGES = new Map([
  ["@kompjutr/git/do-fs", new URL("../packages/git/src/do-fs/index.ts", import.meta.url)],
  ["@kompjutr/do/git-shell", new URL("../packages/do/src/git-shell.ts", import.meta.url)],
  ["@kompjutr/do/testing", new URL("../packages/do/src/testing.ts", import.meta.url)],
  ["@kompjutr/do/shell", new URL("../packages/do/src/shell/index.ts", import.meta.url)],
  ["@kompjutr/do/fs", new URL("../packages/do/src/fs/index.ts", import.meta.url)],
  ["@kompjutr/sqlite", new URL("../packages/sqlite/src/index.ts", import.meta.url)],
  ["@kompjutr/drive", new URL("../packages/drive/src/index.ts", import.meta.url)],
  ["@kompjutr/git", new URL("../packages/git/src/index.ts", import.meta.url)],
  ["@kompjutr/do", new URL("../packages/do/src/index.ts", import.meta.url)],
  ["@kompjutr/local", new URL("../packages/local/src/index.ts", import.meta.url)],
]);

const SOURCE = `
export class RpcTarget {}
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
`;

export function resolve(specifier, context, next) {
  const source = PACKAGES.get(specifier);
  if (source !== undefined) return { url: source.href, shortCircuit: true };
  if (specifier === "cloudflare:workers") {
    return { url: "cloudflare-workers-stub:///", shortCircuit: true };
  }
  // TS sources import "./x.js"; the file on disk is "./x.ts".
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(target))) {
      const ts = fileURLToPath(target).replace(/\.js$/, ".ts");
      if (existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  if (url === "cloudflare-workers-stub:///") {
    return { format: "module", source: SOURCE, shortCircuit: true };
  }
  return next(url, context);
}
