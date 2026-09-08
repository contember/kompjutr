import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { LocalWorkspace, type NodeSqliteMetrics } from "@kompjutr/local";

const DIRECTORY_COUNT = 50;
const FILES_PER_DIRECTORY = 50;
const FILE_COUNT = DIRECTORY_COUNT * FILES_PER_DIRECTORY;
const FIXED_TIME = 1_577_836_800_000;

interface Measurement extends NodeSqliteMetrics {
  readonly operation: string;
  readonly milliseconds: number;
  readonly files: number;
}

async function measure(
  workspace: LocalWorkspace,
  operation: string,
  run: () => number | Promise<number>,
): Promise<Measurement> {
  workspace.database.resetMetrics();
  const started = performance.now();
  const files = await run();
  const milliseconds = performance.now() - started;
  return { operation, milliseconds, files, ...workspace.database.metrics() };
}

const base = mkdtempSync(join(tmpdir(), "kompjutr-local-bench-"));
const root = join(base, "root");
const stateDirectory = join(base, "state");
mkdirSync(root);

for (let directory = 0; directory < DIRECTORY_COUNT; directory++) {
  const parent = join(root, `directory-${String(directory).padStart(2, "0")}`);
  mkdirSync(parent);
  for (let file = 0; file < FILES_PER_DIRECTORY; file++) {
    const name = `file-${String(file).padStart(2, "0")}.txt`;
    writeFileSync(join(parent, name), `${directory}:${file}\n`);
  }
}

const workspace = new LocalWorkspace({
  root,
  stateDirectory,
  now: () => FIXED_TIME,
  timezoneOffset: () => 0,
  defaultGitIdentity: { name: "Local Benchmark", email: "benchmark@example.test" },
});

try {
  await workspace.git.init();
  await workspace.git.add({ paths: ["."] });
  await workspace.git.commit({ message: "benchmark fixture" });

  const traversal = await measure(workspace, "ordered traversal", () => {
    let files = 0;
    for (const entry of workspace.drive.scanStream("/", { filesOnly: true })) {
      if (entry.type === "file") files++;
    }
    return files;
  });
  if (traversal.files !== FILE_COUNT) {
    throw new Error(`ordered traversal returned ${traversal.files} files, expected ${FILE_COUNT}`);
  }

  const status = await measure(workspace, "clean status with conservative hashes", async () => {
    const entries = await workspace.git.status();
    if (entries.length !== 0) throw new Error(`clean status returned ${entries.length} changes`);
    return FILE_COUNT;
  });

  const result = {
    fixture: { directories: DIRECTORY_COUNT, files: FILE_COUNT },
    measurements: [traversal, status],
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  workspace.close();
  rmSync(base, { force: true, recursive: true });
}
