import { describe, expect, it } from "vitest";

import type { GitContext, IndexTrackerSeedEntry } from "../src/core/context.js";
import { CorruptError, GitError } from "../src/core/errors.js";
import { commit } from "../src/core/ops/commit.js";
import { eagerStatus, status } from "../src/core/ops/status.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import type { SparseWorkspaceSource } from "../src/core/sparse-workspace.js";
import {
  INDEX_DIRTY,
  readIndexTrackerState,
  resealIndexTracker,
  WORKTREE_DIRTY,
} from "../src/sqlite/index-tracker.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

class NoScanWorktree extends CountingWorktree {
  override scan(): never {
    throw new Error("sparse status must not scan the worktree");
  }
}

function commitFiles(workspace: TestRepository, paths: readonly string[]): void {
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  for (const path of paths) {
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path);
    if (hashed === null) throw new Error(`missing fixture path: ${path}`);
    workspace.repo.store.indexPut(indexEntryFor(path, hashed));
  }
  commit(workspace.context, workspace.repo, { message: "fixture" });
}

function trackerContext(
  workspace: TestRepository,
  source: SparseWorkspaceSource | undefined = workspace.context.sparseWorkspace,
): Pick<GitContext, "sparseWorkspace" | "indexTracker"> {
  return {
    sparseWorkspace: source,
    indexTracker: {
      reseal(
        repoId: number,
        baselineTreeOid: string | null,
        entries: Iterable<IndexTrackerSeedEntry>,
      ) {
        return resealIndexTracker(workspace.database.db, repoId, baselineTreeOid, entries);
      },
    },
  };
}

function seal(
  workspace: TestRepository,
  entries: Iterable<IndexTrackerSeedEntry> = [],
  baselineTreeOid: string | null = workspace.repo.headTree(),
): void {
  expect(
    resealIndexTracker(
      workspace.database.db,
      workspace.repo.store.repoId,
      baselineTreeOid,
      entries,
    ),
  ).toBe(true);
}

describe("sparse eager status", () => {
  it("returns a clean sealed status without scanning the tree or worktree", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    commitFiles(workspace, ["a.txt"]);
    seal(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    expect(eagerStatus(workspace.repo, worktree, {}, trackerContext(workspace))).toEqual([]);
    expect(workspace.storage.statementCount).toBeLessThan(10);
    expect(workspace.storage.rowCount).toBeLessThan(10);
  });

  it("hashes one hundred modified tracked paths without a refresh scan", () => {
    const workspace = makeRepo("/");
    const paths = Array.from(
      { length: 100 },
      (_, index) => `src/f${index.toString().padStart(3, "0")}.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "before\n");
    commitFiles(workspace, paths);
    seal(workspace);
    workspace.tick(60_000);
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "after\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    const rows = eagerStatus(
      workspace.repo,
      worktree,
      { untrackedFiles: "all" },
      trackerContext(workspace),
    );

    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.index === " " && row.worktree === "M")).toBe(true);
    expect(worktree.bulkReadPaths).toHaveLength(100);
    expect(workspace.storage.statementCount).toBeLessThan(50);
    expect(workspace.storage.rowCount).toBeLessThan(10_000);
    expect([...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId)]).toEqual(
      paths.map((path) => ({ path, flags: WORKTREE_DIRTY })),
    );
  });

  it("matches full status for staged, unstaged, mode, symlink, and conflict rows", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/staged.txt", "before\n");
    writeWorkFile(workspace, "/unstaged.txt", "before\n");
    writeWorkFile(workspace, "/mode.txt", "mode\n");
    workspace.worktree.symlink("before", "/link");
    writeWorkFile(workspace, "/conflict.txt", "base\n");
    const paths = ["conflict.txt", "link", "mode.txt", "staged.txt", "unstaged.txt"];
    commitFiles(workspace, paths);
    seal(workspace);
    workspace.tick(60_000);

    writeWorkFile(workspace, "/staged.txt", "staged\n");
    const staged = hashWorktreePath(workspace.repo, workspace.worktree, "staged.txt");
    if (staged === null) throw new Error("missing staged fixture");
    workspace.repo.store.indexPut(indexEntryFor("staged.txt", staged));
    writeWorkFile(workspace, "/unstaged.txt", "unstaged\n");
    workspace.worktree.chmod("/mode.txt", 0o755);
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    workspace.repo.store.indexRemove("conflict.txt");
    const oid = workspace.repo.store.write("blob", new TextEncoder().encode("conflict\n"));
    for (const stage of [1, 2, 3]) {
      const entry: IndexEntry = {
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      };
      workspace.repo.store.indexPut(entry);
    }

    const expected = status(workspace.repo, workspace.worktree, { untrackedFiles: "all" });
    const actual = eagerStatus(
      workspace.repo,
      new NoScanWorktree(workspace.worktree),
      { untrackedFiles: "all" },
      trackerContext(workspace),
    );
    expect(actual).toEqual(expected);
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId),
    ]).toContainEqual({ path: "conflict.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY });
  });

  it("falls back for normal untracked collapsing and stays sparse for all", () => {
    const normal = makeRepo("/");
    seal(normal);
    writeWorkFile(normal, "/fresh/a.txt", "fresh\n");
    expect(
      eagerStatus(normal.repo, normal.worktree, {}, trackerContext(normal)).map((row) => row.path),
    ).toEqual(["fresh/"]);

    const all = makeRepo("/");
    seal(all);
    writeWorkFile(all, "/fresh/a.txt", "fresh\n");
    expect(
      eagerStatus(
        all.repo,
        new NoScanWorktree(all.worktree),
        { untrackedFiles: "all" },
        trackerContext(all),
      ).map((row) => row.path),
    ).toEqual(["fresh/a.txt"]);

    const ignored = makeRepo("/");
    writeWorkFile(ignored, "/.gitignore", "*.log\n");
    commitFiles(ignored, [".gitignore"]);
    seal(ignored);
    writeWorkFile(ignored, "/ignored/noisy.log", "noise\n");
    expect(
      eagerStatus(
        ignored.repo,
        ignored.worktree,
        { includeIgnored: true },
        trackerContext(ignored),
      ).map((row) => row.path),
    ).toEqual(["ignored/"]);
  });

  it("chooses normal-untracked fallback before hashing a tracked candidate", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "before\n");
    commitFiles(workspace, ["a.txt"]);
    seal(workspace);
    workspace.tick(60_000);
    writeWorkFile(workspace, "/a.txt", "after\n");
    writeWorkFile(workspace, "/z-untracked.txt", "untracked\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    expect(() => eagerStatus(workspace.repo, worktree, {}, trackerContext(workspace))).toThrowError(
      /must not scan/,
    );
    expect(worktree.bulkReadPaths).toEqual([]);
  });

  it("retains worktree dirtiness when a staged deletion leaves the old file", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    commitFiles(workspace, ["kept.txt"]);
    seal(workspace);
    workspace.repo.store.indexRemove("kept.txt");

    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        { untrackedFiles: "all" },
        trackerContext(workspace),
      ),
    ).toEqual([expect.objectContaining({ path: "kept.txt", index: "D", worktree: " " })]);
    expect([...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId)]).toEqual(
      [{ path: "kept.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY }],
    );
  });

  it("falls back when capabilities or tracker state are unavailable", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/untracked.txt", "untracked\n");
    const expected = status(workspace.repo, workspace.worktree);

    expect(eagerStatus(workspace.repo, workspace.worktree, {}, {})).toEqual(expected);
    expect(eagerStatus(workspace.repo, workspace.worktree, {}, trackerContext(workspace))).toEqual(
      expected,
    );
  });

  it("uses the tree diff when HEAD changes after the tracker baseline", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "one\n");
    commitFiles(workspace, ["a.txt"]);
    const oldTree = workspace.repo.headTree();
    writeWorkFile(workspace, "/a.txt", "two\n");
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, "a.txt");
    if (hashed === null) throw new Error("missing updated fixture");
    workspace.repo.store.indexPut(indexEntryFor("a.txt", hashed));
    commit(workspace.context, workspace.repo, { message: "second" });
    seal(workspace, [], oldTree);

    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        {},
        trackerContext(workspace),
      ),
    ).toEqual([]);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: true,
      baselineTreeOid: workspace.repo.headTree(),
    });
  });

  it("propagates sparse hydration corruption without resealing", () => {
    const workspace = makeRepo("/");
    seal(workspace, [{ path: "broken.txt", flags: INDEX_DIRTY }]);
    const source = workspace.context.sparseWorkspace;
    if (source === undefined) throw new Error("missing sparse source");
    const broken: SparseWorkspaceSource = {
      readState: (repoId) => source.readState(repoId),
      dirtyPaths: (repoId) => source.dirtyPaths(repoId),
      hydrate: () => {
        throw new CorruptError("injected sparse corruption");
      },
    };
    let reseals = 0;
    const context: Pick<GitContext, "sparseWorkspace" | "indexTracker"> = {
      sparseWorkspace: broken,
      indexTracker: {
        reseal: () => {
          reseals++;
          return true;
        },
      },
    };

    expect(() => eagerStatus(workspace.repo, workspace.worktree, {}, context)).toThrowError(
      /injected sparse corruption/,
    );
    expect(reseals).toBe(0);
  });

  it("falls back when bounded dirty traversal reports E2BIG", () => {
    const workspace = makeRepo("/");
    let hydrates = 0;
    let reseals = 0;
    const source: SparseWorkspaceSource = {
      readState: () => ({ available: true, baselineTreeOid: null }),
      dirtyPaths: function* () {
        yield* [];
        throw new GitError("E2BIG", "injected sparse bound");
      },
      hydrate: () => {
        hydrates++;
        return { available: false };
      },
    };
    const context: Pick<GitContext, "sparseWorkspace" | "indexTracker"> = {
      sparseWorkspace: source,
      indexTracker: {
        reseal: () => {
          reseals++;
          return true;
        },
      },
    };

    expect(eagerStatus(workspace.repo, workspace.worktree, {}, context)).toEqual([]);
    expect(hydrates).toBe(0);
    expect(reseals).toBe(0);
  });
});
