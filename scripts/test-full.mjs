import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const rootExcludes = [
  "--exclude=tests/fs/**",
  "--exclude=tests/shell/**",
  "--exclude=tests/e2e/**",
];
const rootShardCount = 8;
const slices = [
  ...Array.from({ length: rootShardCount }, (_, index) => ({
    name: `root ${index + 1}/${rootShardCount}`,
    args: [...rootExcludes, `--shard=${index + 1}/${rootShardCount}`],
  })),
  { name: "filesystem", args: ["tests/fs"] },
  { name: "shell", args: ["tests/shell"] },
  { name: "end-to-end", args: ["tests/e2e"] },
];

for (const slice of slices) {
  process.stdout.write(`\n=== ${slice.name} ===\n`);
  const result = spawnSync(process.execPath, [vitest, "run", "--maxWorkers=4", ...slice.args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const outcome =
      result.signal === null ? `exit code ${result.status}` : `signal ${result.signal}`;
    throw new Error(`Full-suite slice ${slice.name} failed with ${outcome}`);
  }
}
