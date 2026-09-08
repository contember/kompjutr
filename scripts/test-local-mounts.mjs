import { spawnSync } from "node:child_process";

const probe = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "true"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  const reason = (probe.stderr || probe.stdout || "unshare is unavailable").trim();
  console.log(`Local mount witness skipped: ${reason}`);
  process.exit(0);
}

const result = spawnSync(
  "unshare",
  [
    "--user",
    "--map-root-user",
    "--mount",
    "--fork",
    process.execPath,
    "--experimental-transform-types",
    "--import",
    "./bench/register.mjs",
    "scripts/local-mount-witness.ts",
  ],
  { cwd: process.cwd(), stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Local bind-mount recovery witness passed");
