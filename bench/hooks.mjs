import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = `
export class RpcTarget {}
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
`;

export function resolve(specifier, context, next) {
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
