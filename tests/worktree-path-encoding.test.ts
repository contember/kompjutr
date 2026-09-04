// A worktree name that is not well-formed UTF-8 used to reach `fs_paths` as
// WTF-8 and come back as U+FFFD, so `git add .` never saw the file it had
// just written: the commit silently dropped it and `status` reported clean.
// The filesystem now refuses the write, so the drop cannot happen.

import { describe, expect, it } from "vitest";

import { createGit } from "../src/git/client.js";
import { Workspace } from "../src/runtime/workspace.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const ENCODER = new TextEncoder();

function openRepository(): Workspace {
  const workspace = new Workspace({
    storage: new SqliteTestStorage(),
    git: createGit(),
    defaultGitIdentity: { name: "Test", email: "test@example.com" },
    now: () => 1_577_836_800_000,
  });
  workspace.filesystem.mkdir("/repo");
  return workspace;
}

describe("worktree path encoding", () => {
  it("commits an astral filename and reports a clean tree afterwards", async () => {
    const workspace = openRepository();
    await workspace.git.init({ dir: "/repo" });
    workspace.filesystem.writeFile("/repo/\u{1F600}.txt", ENCODER.encode("x"));
    workspace.filesystem.writeFile("/repo/z.txt", ENCODER.encode("z"));

    await workspace.git.add({ dir: "/repo", paths: ["."] });
    await workspace.git.commit({ dir: "/repo", message: "add both" });

    expect(await workspace.git.lsFiles({ dir: "/repo", cached: true })).toEqual([
      "z.txt",
      "\u{1F600}.txt",
    ]);
    const status = await workspace.git.runCli({ argv: ["status", "--porcelain"], cwd: "/repo" });
    expect(status.stdout).toBe("");
  });

  for (const [label, name] of [
    ["high", "a\uD800b.txt"],
    ["low", "a\uDC00b.txt"],
  ] as const) {
    it(`refuses a lone ${label} surrogate rather than dropping it from the commit`, async () => {
      const workspace = openRepository();
      await workspace.git.init({ dir: "/repo" });

      expect(() => workspace.filesystem.writeFile(`/repo/${name}`, ENCODER.encode("x"))).toThrow(
        /not well-formed UTF-8/,
      );
      workspace.filesystem.writeFile("/repo/z.txt", ENCODER.encode("z"));

      // Nothing was written, so nothing can be silently missing from the tree.
      expect(workspace.filesystem.readdir("/repo").map((entry) => entry.name)).toEqual(["z.txt"]);
      await workspace.git.add({ dir: "/repo", paths: ["."] });
      await workspace.git.commit({ dir: "/repo", message: "only z" });
      expect(await workspace.git.lsFiles({ dir: "/repo", cached: true })).toEqual(["z.txt"]);
      const status = await workspace.git.runCli({ argv: ["status", "--porcelain"], cwd: "/repo" });
      expect(status.stdout).toBe("");
    });
  }
});
