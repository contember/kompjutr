import { describe, expect, it } from "vitest";
import { createInitialWorktreeWriter } from "../src/fs/store/initial-write.js";
import { createGit, type GitWorkspaceBinding } from "../src/git/client.js";
import { utf8Decoder } from "../src/git/common/bytes.js";
import { nestedRoots, openRepository } from "../src/git/ops/core/context.js";
import { initRepository } from "../src/git/ops/repository/init.js";
import { walkWorktree } from "../src/git/ops/worktree/worktree-io.js";
import { SqliteGitDatabase } from "../src/git/store/index.js";
import {
  INDEX_DIRTY,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
} from "../src/git/store/indexes/index-tracker.js";
import { Workspace as RuntimeWorkspace } from "../src/runtime/workspace.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import { makeRepo, makeWorkspace, writeWorkFile } from "./helpers/workspace.js";

const TREE = "1".repeat(40);
const OTHER_TREE = "2".repeat(40);
const CALLER_TREE = "3".repeat(40);

describe("workspace fixture", () => {
  it("puts the git state in SQL and the working tree in DOFS", async () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/README.md", "hello\n");

    expect(await workspace.workspace.fs.readFile("/README.md", "utf8")).toBe("hello\n");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/README.md"))).toBe("hello\n");
    expect(workspace.repo.checkout.head()).toBe("ref: refs/heads/main");
    expect(
      workspace.storage.sql.exec<{ root: string }>("SELECT root FROM git_checkouts").toArray(),
    ).toEqual([{ root: "/" }]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
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

  it("authenticates only the composed native database for initial writes", () => {
    const workspace = makeWorkspace();
    const native = workspace.database;
    const writer = createInitialWorktreeWriter(
      workspace.database.db,
      Date.now,
      (database) => database === native,
    );
    const sameRawDatabase = new SqliteGitDatabase(workspace.database.db);

    expect(writer.supportsDatabase(native)).toBe(true);
    expect(writer.supportsDatabase(sameRawDatabase)).toBe(false);
  });

  it("publishes the exact runtime database identity through the native binding", () => {
    const storage = new SqliteTestStorage();
    let captured: GitWorkspaceBinding | undefined;
    const workspace = new RuntimeWorkspace({
      storage,
      git: (binding) => {
        captured = binding;
        return createGit()(binding);
      },
    });

    void workspace.git;
    if (captured === undefined) throw new Error("runtime did not bind Git");
    const otherWrapper = new SqliteGitDatabase(captured.database.db);
    expect(captured.initialWorktree?.supportsDatabase?.(captured.database)).toBe(true);
    expect(captured.initialWorktree?.supportsDatabase?.(otherWrapper)).toBe(false);
    expect(captured.selectedPaths).toBeDefined();
    expect(captured.commitTrees).toBeDefined();
  });

  it("opens one checkout-bound view from one routing lookup", () => {
    const workspace = makeRepo("/");
    const repoId = workspace.repo.store.repoId;
    const checkoutId = workspace.repo.checkout.checkoutId + 100;
    workspace.worktree.mkdir("/linked");
    workspace.database.db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (?, ?, '/linked', ?, 0)`,
      checkoutId,
      repoId,
      TREE,
    );
    workspace.database.db.run(
      `INSERT OR IGNORE INTO git_index_state
         (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
      checkoutId,
    );

    workspace.storage.resetCounters();
    const linked = openRepository(workspace.context, "/linked/src/file.ts");

    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(linked.store).toBe(workspace.repo.store);
    expect(linked.checkout.checkoutId).toBe(checkoutId);
    expect(linked.checkout.checkoutId).not.toBe(linked.store.repoId);
    expect(linked.root).toBe("/linked");

    linked.checkout.setHead("ref: refs/heads/linked");
    expect(linked.checkout.head()).toBe("ref: refs/heads/linked");
    expect(workspace.repo.checkout.head()).toBe("ref: refs/heads/main");

    workspace.repo.store.setShallow([TREE]);
    expect(workspace.repo.shallow()).toEqual(new Set([TREE]));
    linked.checkout.setShallow([OTHER_TREE], [TREE]);
    expect(workspace.repo.shallow()).toEqual(new Set([OTHER_TREE]));
    const callerCopy = linked.store.shallow();
    callerCopy.clear();
    callerCopy.add(CALLER_TREE);
    expect(linked.store.shallow()).toEqual(new Set([OTHER_TREE]));
    workspace.repo.store.clearCaches();
    expect(workspace.repo.shallow()).toEqual(new Set([OTHER_TREE]));

    workspace.storage.resetCounters();
    expect(nestedRoots(workspace.context, "/")).toEqual(["/linked"]);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("removes tracker state before destroying a sealed repository", () => {
    const workspace = makeRepo("/");
    const checkoutId = workspace.repo.checkout.checkoutId;
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
      resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, TREE, []),
    ).toBe(true);
    expect(resealIndexTracker(workspace.database.db, nested.checkout.checkoutId, TREE, [])).toBe(
      true,
    );

    nested.store.destroy();

    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({
      available: false,
    });
  });

  it("starts monotonic replacement identities with clean incomplete tracker state", () => {
    const workspace = makeRepo("/");
    const repoId = workspace.repo.store.repoId;
    const checkoutId = workspace.repo.checkout.checkoutId;
    expect(
      resealIndexTracker(workspace.database.db, checkoutId, TREE, [
        { path: "old.txt", flags: INDEX_DIRTY },
      ]),
    ).toBe(true);
    workspace.repo.store.destroy();

    const replacement = initRepository(workspace.context, { dir: "/replacement" });
    expect(replacement.store.repoId).toBeGreaterThan(repoId);
    expect(replacement.checkout.checkoutId).toBeGreaterThan(checkoutId);
    expect(readIndexTrackerState(workspace.database.db, replacement.checkout.checkoutId)).toEqual({
      available: false,
    });
    expect([
      ...iterateIndexTrackerDirty(workspace.database.db, replacement.checkout.checkoutId),
    ]).toEqual([]);
  });
});
