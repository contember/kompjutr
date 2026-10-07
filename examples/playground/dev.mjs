import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { FIXTURES, prepareFixture } from "../../bench/fixtures.js";
import { startGitServer } from "../../tests/helpers/http-backend.js";
import { buildWorker } from "./build-worker.mjs";
import { prepareHistoryOrigin } from "./history-origin.mjs";
import { createRuntime } from "./runtime.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const fullHistory = process.argv.includes("--full-history");
const originPath = fullHistory
  ? prepareHistoryOrigin(directory)
  : join(prepareFixture(FIXTURES.nextjs), ".git");
const persistPath = join(directory, ".state", ...(fullHistory ? ["full-history"] : []));
const origin = await startGitServer(originPath, { port: 8788 });
let runtime;
let frontend;

async function close() {
  await frontend?.close();
  await runtime?.dispose();
  await origin.close();
}

try {
  runtime = createRuntime({
    scriptPath: await buildWorker(),
    persistPath,
    originUrl: origin.url,
    ...(fullHistory ? { filter: "blob:none" } : {}),
    port: 8787,
  });
  await runtime.ready;
  frontend = await createServer({ root: directory });
  await frontend.listen();
  console.log("kompjutr playground → http://127.0.0.1:4173");
  console.log(
    `Next.js v15.5.2 · full 24,252-file tree · ${fullHistory ? "complete upstream history, lazy historical blobs" : "single-commit fixture"}`,
  );
  console.log(`SQLite persists in ${persistPath}`);
} catch (error) {
  await close();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });
}
