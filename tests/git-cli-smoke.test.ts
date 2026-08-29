import { describe, expect, it } from "vitest";

import { createGit } from "../src/git/client.js";
import { createGitCommand } from "../src/git/shell.js";
import { Workspace } from "../src/runtime/workspace.js";
import { createShell } from "../src/shell/index.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const ENCODER = new TextEncoder();

describe("Git CLI smoke", () => {
  it("connects file selection, the synchronous runner, and the injected shell command", async () => {
    const workspace = new Workspace({
      storage: new SqliteTestStorage(),
      git: createGit(),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
      now: () => 1_577_836_800_000,
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
    expect(workspace.git.runCli({ argv: ["status", "--porcelain"], cwd: "/repo" })).toEqual({
      stdout: "?? fresh.txt\n",
      stderr: "",
      exitCode: 0,
    });

    const shell = createShell({
      fs: workspace.filesystem,
      cwd: "/repo",
      commands: new Map([["git", createGitCommand(workspace.git)]]),
    });
    expect(shell.run("git status --porcelain | wc -l")).toMatchObject({
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
      operations: 0,
    });
  });
});
