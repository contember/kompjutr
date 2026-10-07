import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildWorker() {
  const outfile = fileURLToPath(new URL("./dist/worker.mjs", import.meta.url));
  await build({
    entryPoints: [fileURLToPath(new URL("./worker/index.ts", import.meta.url))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: ["node:buffer", "node:zlib"],
    tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
    sourcemap: true,
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWorker();
