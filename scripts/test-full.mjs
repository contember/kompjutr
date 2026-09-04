import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const rootExcludes = [
  "--exclude=tests/fs/**",
  "--exclude=tests/shell/**",
  "--exclude=tests/e2e/**",
  "--exclude=tests/pack.test.ts",
  "--exclude=tests/protocol.test.ts",
];
const rootShardCount = 8;
const packSlices = [
  "full-object pack stream|delta|real git packs",
  "synthetic pack ingest",
  "pack fallback preservation",
  "pack deferred resolution",
  "pack publication and deletion",
];

// `weight` is a start-order hint in rough measured seconds, nothing else.
// Longest-first keeps the tail from landing after every lane has drained.
const slices = [
  ...Array.from({ length: rootShardCount }, (_, index) => ({
    name: `root ${index + 1}/${rootShardCount}`,
    // threads pool: the forks pool trips vitest's fixed 60 s onTaskUpdate RPC
    // timeout after long store batches even when every test passes.
    args: [...rootExcludes, "--pool=threads", `--shard=${index + 1}/${rootShardCount}`],
    weight: 110,
  })),
  {
    name: "protocol",
    args: ["tests/protocol.test.ts"],
    workers: 1,
    weight: 4,
  },
  ...packSlices.map((pattern, index) => ({
    name: `pack ${index + 1}/${packSlices.length}`,
    args: ["tests/pack.test.ts", `--testNamePattern=^(${pattern})`],
    weight: 12,
  })),
  { name: "filesystem", args: ["tests/fs"], weight: 18 },
  { name: "shell", args: ["tests/shell"], weight: 10 },
  { name: "end-to-end", args: ["tests/e2e"], weight: 100 },
];

const workersFor = (slice) => slice.workers ?? 2;

// Each lane spends `workersFor` cores, so the cap is core-budgeted rather than
// slice-counted. TEST_FULL_LANES overrides it on a busy or a bigger machine.
const laneCap = Math.max(
  1,
  Number(process.env.TEST_FULL_LANES) || Math.floor(availableParallelism() / 2),
);

function run(slice) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitest, "run", `--maxWorkers=${workersFor(slice)}`, ...slice.args],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    // Buffered, not inherited: concurrent lanes would interleave line by line.
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const seconds = (Date.now() - started) / 1000;
      process.stdout.write(`\n=== ${slice.name} (${seconds.toFixed(1)}s) ===\n`);
      process.stdout.write(Buffer.concat(chunks).toString());
      resolve({
        name: slice.name,
        seconds,
        failure:
          status === 0
            ? null
            : `${slice.name} failed with ${signal === null ? `exit code ${status}` : `signal ${signal}`}`,
      });
    });
  });
}

const queue = [...slices].sort((left, right) => right.weight - left.weight);
const results = [];
const started = Date.now();

async function lane() {
  for (let slice = queue.shift(); slice !== undefined; slice = queue.shift()) {
    results.push(await run(slice));
  }
}

await Promise.all(Array.from({ length: Math.min(laneCap, slices.length) }, lane));

const wall = (Date.now() - started) / 1000;
const serial = results.reduce((total, result) => total + result.seconds, 0);
process.stdout.write(
  `\n=== full suite: ${wall.toFixed(1)}s wall, ${serial.toFixed(1)}s serial, ${laneCap} lanes ===\n`,
);
for (const result of [...results].sort((left, right) => right.seconds - left.seconds).slice(0, 5)) {
  process.stdout.write(`  ${result.seconds.toFixed(1).padStart(7)}s  ${result.name}\n`);
}

const failures = results.filter((result) => result.failure !== null);
if (failures.length > 0) {
  // Every lane runs to completion first: one report beats bisecting a fail-fast.
  throw new Error(failures.map((result) => result.failure).join("\n"));
}
