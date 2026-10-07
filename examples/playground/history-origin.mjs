import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const REVISION = "497ec6aa08a33f9e2d65a5c8461f550c2549d3e6";

export function prepareHistoryOrigin(directory) {
  const origin = join(directory, ".state", "origins", "nextjs-v15.5.2.git");
  if (!existsSync(origin)) {
    mkdirSync(dirname(origin), { recursive: true });
    execFileSync(
      "cpu-lease",
      [
        "run",
        "-n",
        "2",
        "--",
        "git",
        "-c",
        "pack.threads=2",
        "clone",
        "--bare",
        "--single-branch",
        "--branch",
        "v15.5.2",
        "--no-tags",
        "https://github.com/vercel/next.js.git",
        origin,
      ],
      { stdio: "inherit" },
    );
  }
  const git = (...args) =>
    execFileSync("git", ["--git-dir", origin, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("The history origin is shallow; a complete upstream history is required.");
  }
  if (git("rev-parse", "HEAD^{commit}") !== REVISION) {
    throw new Error(`The history origin does not match Next.js v15.5.2 (${REVISION}).`);
  }
  git("update-ref", "refs/heads/main", REVISION);
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("config", "uploadpack.allowFilter", "true");
  return origin;
}
