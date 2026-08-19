import { describe, expect, it } from "vitest";

import { utf8Decoder } from "../src/core/bytes.js";
import { nestedRoots } from "../src/core/context.js";
import { initRepository } from "../src/core/ops/init.js";
import { walkWorktree } from "../src/core/ops/worktree-io.js";
import { makeRepo, makeWorkspace, writeWorkFile } from "./helpers/workspace.js";

describe("workspace fixture", () => {
  it("puts the git state in SQL and the working tree in DOFS", async () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/README.md", "hello\n");

    expect(await workspace.workspace.fs.readFile("/README.md", "utf8")).toBe("hello\n");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/README.md"))).toBe("hello\n");
    expect(workspace.repo.store.head()).toBe("ref: refs/heads/main");
    expect(
      workspace.storage.sql
        .exec<{ root: string }>("SELECT root FROM git_repositories")
        .toArray(),
    ).toEqual([{ root: "/" }]);
  });

  it("refuses to initialise the same root twice", () => {
    const workspace = makeRepo("/");
    expect(() => initRepository(workspace.context, { dir: "/" })).toThrow(/already exists/);
  });

  it("walks the working tree and stops at a nested repository", () => {
    const workspace = makeWorkspace();
    const repo = initRepository(workspace.context, { dir: "/" });
    initRepository(workspace.context, { dir: "/vendor/inner" });
    writeWorkFile(workspace, "/a.txt", "a");
    writeWorkFile(workspace, "/src/b.txt", "b");
    writeWorkFile(workspace, "/vendor/inner/c.txt", "c");

    const excludeRoots = nestedRoots(workspace.context, repo.root);
    expect(excludeRoots).toEqual(["/vendor/inner"]);
    expect(walkWorktree(workspace.worktree, repo.root, { excludeRoots })).toEqual([
      "a.txt",
      "src/b.txt",
    ]);
  });

  it("counts SQL statements so tests can assert on cost", () => {
    const workspace = makeRepo("/");
    workspace.storage.resetCounters();
    workspace.repo.store.getRef("refs/heads/main");
    expect(workspace.storage.statementCount).toBe(1);
  });
});
