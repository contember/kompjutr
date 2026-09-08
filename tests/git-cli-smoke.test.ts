import { describe, expect, it } from "vitest";
import { createGitCommand } from "../packages/do/src/git-shell.js";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createShell } from "../packages/do/src/shell/index.js";
import { createGit } from "../packages/git/src/client.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const ENCODER = new TextEncoder();
describe("Git CLI smoke", () => {
  it("connects file selection, the async runner, and the injected shell command", async () => {
    const workspace = new Workspace({
      storage: new SqliteTestStorage(),
      git: createGit(),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
      now: () => 1577836800000,
    });
    workspace.filesystem.mkdir("/repo");
    await workspace.git.init({ dir: "/repo" });
    workspace.filesystem.writeFile("/repo/.gitignore", ENCODER.encode("*.tmp\n"));
    workspace.filesystem.writeFile("/repo/tracked.txt", ENCODER.encode("tracked\n"));
    await workspace.git.add({ dir: "/repo", paths: [".gitignore", "tracked.txt"] });
    await workspace.git.commit({ dir: "/repo", message: "base" });
    workspace.filesystem.writeFile("/repo/fresh.txt", ENCODER.encode("fresh\n"));
    workspace.filesystem.writeFile("/repo/ignored.tmp", ENCODER.encode("ignored\n"));
    expect(
      await workspace.git.lsFiles({
        dir: "/repo",
        cached: true,
        others: true,
        excludeStandard: true,
      }),
    ).toEqual([".gitignore", "fresh.txt", "tracked.txt"]);
    expect(await workspace.git.runCli({ argv: ["status", "--porcelain"], cwd: "/repo" })).toEqual({
      stdout: "?? fresh.txt\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const shell = createShell({
      fs: workspace.filesystem,
      cwd: "/repo",
      commands: new Map([["git", createGitCommand(workspace.git)]]),
    });
    expect(await shell.run("git status --porcelain | wc -l")).toMatchObject({
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
      operations: 0,
    });
  });
});
