import { describe, expect, it } from "vitest";

import { utf8Decoder } from "../src/core/bytes.js";
import { nestedRoots } from "../src/core/context.js";
import { initRepository } from "../src/core/ops/init.js";
import { walkWorktree } from "../src/core/ops/worktree-io.js";
import {
  INDEX_DIRTY,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
} from "../src/sqlite/index-tracker.js";
import { makeRepo, makeWorkspace, writeWorkFile } from "./helpers/workspace.js";

const TREE = "1".repeat(40);

describe("workspace fixture", () => {
  it("puts the git state in SQL and the working tree in DOFS", async () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/README.md", "hello\n");

    expect(await workspace.workspace.fs.readFile("/README.md", "utf8")).toBe("hello\n");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/README.md"))).toBe("hello\n");
    expect(workspace.repo.store.head()).toBe("ref: refs/heads/main");
    expect(
      workspace.storage.sql.exec<{ root: string }>("SELECT root FROM git_checkouts").toArray(),
    ).toEqual([{ root: "/" }]);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.checkoutId)).toEqual({
      available: false,
    });
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

  it("removes tracker state before destroying a sealed repository", () => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.store.checkoutId;
    expect(
      resealIndexTracker(workspace.database.db, checkoutId, TREE, [
        { path: "old.txt", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);

    workspace.repo.store.destroy();

    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_index_dirty WHERE checkout_id = ?",
        checkoutId,
      ),
    ).toBe(0);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_index_state WHERE checkout_id = ?",
        checkoutId,
      ),
    ).toBe(0);
  });

  it("invalidates the parent tracker when a nested repository is destroyed", () => {
    const workspace = makeRepo("/");
    workspace.worktree.mkdir("/nested");
    const nested = initRepository(workspace.context, { dir: "/nested" });
    expect(
      resealIndexTracker(workspace.database.db, workspace.repo.store.checkoutId, TREE, []),
    ).toBe(true);
    expect(resealIndexTracker(workspace.database.db, nested.store.checkoutId, TREE, [])).toBe(true);

    nested.store.destroy();

    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.checkoutId)).toEqual({
      available: false,
    });
  });

  it("starts a reused repository id with clean incomplete tracker state", () => {
    const workspace = makeRepo("/");
    const repoId = workspace.repo.store.repoId;
    const checkoutId = workspace.repo.store.checkoutId;
    expect(
      resealIndexTracker(workspace.database.db, checkoutId, TREE, [
        { path: "old.txt", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    workspace.repo.store.destroy();

    const replacement = initRepository(workspace.context, { dir: "/replacement" });
    expect(replacement.store.repoId).toBe(repoId);
    expect(replacement.store.checkoutId).toBe(checkoutId);
    expect(readIndexTrackerState(workspace.database.db, checkoutId)).toEqual({ available: false });
    expect([...iterateIndexTrackerDirty(workspace.database.db, checkoutId)]).toEqual([]);
  });
});
