import { describe, expect, it } from "vitest";

import type { GitContext, IndexTrackerSeedEntry } from "../src/core/context.js";
import { CorruptError, GitError } from "../src/core/errors.js";
import { commit } from "../src/core/ops/commit.js";
import { eagerStatus, status, statusStream } from "../src/core/ops/status.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import type { SparseWorkspaceSource } from "../src/core/sparse-workspace.js";
import { INDEX_DIRTY, readIndexTrackerState, WORKTREE_DIRTY } from "../src/sqlite/index-tracker.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import {
  configureFixtureIdentity,
  requireSparseWorkspace,
  sealIndexTracker,
  sparseTrackerContext,
  stageWorktreePaths,
} from "./helpers/sparse.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

class NoScanWorktree extends CountingWorktree {
  override scan(): never {
    throw new Error("sparse status must not scan the worktree");
  }
}

class FailingHashWorktree extends CountingWorktree {
  override readFiles(): never {
    throw new Error("injected hash failure");
  }
}

function commitFiles(workspace: TestRepository, paths: readonly string[]): void {
  configureFixtureIdentity(workspace);
  stageWorktreePaths(workspace, paths);
  commit(workspace.context, workspace.repo, { message: "fixture" });
}

function recordingContext(workspace: TestRepository) {
  const reseals: Array<{
    repoId: number;
    baselineTreeOid: string | null;
    entries: IndexTrackerSeedEntry[];
  }> = [];
  const context: Pick<GitContext, "sparseWorkspace" | "indexTracker"> = {
    sparseWorkspace: workspace.context.sparseWorkspace,
    indexTracker: {
      reseal(repoId, baselineTreeOid, entries) {
        reseals.push({ repoId, baselineTreeOid, entries: [...entries] });
        return true;
      },
    },
  };
  return { context, reseals };
}

function bareIndexEntry(path: string, mode = 0o100644): IndexEntry {
  return {
    path,
    stage: 0,
    mode,
    oid: "ab".repeat(20),
    size: null,
    mtime: null,
    ino: null,
  };
}

describe("sparse eager status", () => {
  it("reseals one authoritative full status for an incomplete repository", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    commitFiles(workspace, ["a.txt"]);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: false,
    });

    const expected = status(workspace.repo, workspace.worktree);
    expect(
      eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace)),
    ).toEqual(expected);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: true,
      baselineTreeOid: workspace.repo.headTree(),
    });
    expect([...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId)]).toEqual(
      [],
    );
    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        {},
        sparseTrackerContext(workspace),
      ),
    ).toEqual([]);
  });

  it("reseals exact conservative dirty leaves hidden by status presentation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", "cache/\n");
    writeWorkFile(workspace, "/conflict.txt", "base\n");
    workspace.worktree.symlink("before", "/link");
    for (const path of [
      "removed.txt",
      "retained.txt",
      "stable.txt",
      "staged.txt",
      "unstaged.txt",
    ]) {
      writeWorkFile(workspace, `/${path}`, `${path}\n`);
    }
    commitFiles(workspace, [
      ".gitignore",
      "conflict.txt",
      "link",
      "removed.txt",
      "retained.txt",
      "stable.txt",
      "staged.txt",
      "unstaged.txt",
    ]);
    workspace.repo.store.indexPut(bareIndexEntry("module", 0o160000));
    commit(workspace.context, workspace.repo, { message: "gitlink fixture" });
    workspace.tick(60_000);

    writeWorkFile(workspace, "/staged.txt", "staged after\n");
    const staged = hashWorktreePath(workspace.repo, workspace.worktree, "staged.txt");
    if (staged === null) throw new Error("missing staged fixture");
    workspace.repo.store.indexPut(indexEntryFor("staged.txt", staged));
    writeWorkFile(workspace, "/unstaged.txt", "unstaged after\n");
    writeWorkFile(workspace, "/stable.txt", "stable.txt\n");
    workspace.repo.store.indexRemove("retained.txt");
    workspace.repo.store.indexRemove("removed.txt");
    workspace.worktree.unlink("/removed.txt");
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    workspace.repo.store.indexRemove("conflict.txt");
    const conflictOid = workspace.repo.store.write("blob", new TextEncoder().encode("conflict\n"));
    for (const stage of [1, 2, 3]) {
      workspace.repo.store.indexPut({
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid: conflictOid,
        size: null,
        mtime: null,
        ino: null,
      });
    }
    writeWorkFile(workspace, "/cache/noisy.log", "ignored\n");
    writeWorkFile(workspace, "/fresh/a.txt", "a\n");
    writeWorkFile(workspace, "/fresh/deeper/b.txt", "b\n");

    const expected = status(workspace.repo, workspace.worktree);
    expect(
      eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace)),
    ).toEqual(expected);
    expect([...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId)]).toEqual(
      [
        { path: "cache/noisy.log", flags: WORKTREE_DIRTY },
        { path: "conflict.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY },
        { path: "fresh/a.txt", flags: WORKTREE_DIRTY },
        { path: "fresh/deeper/b.txt", flags: WORKTREE_DIRTY },
        { path: "link", flags: WORKTREE_DIRTY },
        { path: "module", flags: INDEX_DIRTY },
        { path: "removed.txt", flags: INDEX_DIRTY },
        { path: "retained.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY },
        { path: "staged.txt", flags: INDEX_DIRTY },
        { path: "unstaged.txt", flags: WORKTREE_DIRTY },
      ],
    );
  });

  it("returns a clean sealed status without scanning the tree or worktree", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    commitFiles(workspace, ["a.txt"]);
    sealIndexTracker(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    expect(eagerStatus(workspace.repo, worktree, {}, sparseTrackerContext(workspace))).toEqual([]);
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
    sealIndexTracker(workspace);
    workspace.tick(60_000);
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "after\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    const rows = eagerStatus(
      workspace.repo,
      worktree,
      { untrackedFiles: "all" },
      sparseTrackerContext(workspace),
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
    sealIndexTracker(workspace);
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
      sparseTrackerContext(workspace),
    );
    expect(actual).toEqual(expected);
    expect([
      ...workspace.context.sparseWorkspace!.dirtyPaths(workspace.repo.store.repoId),
    ]).toContainEqual({ path: "conflict.txt", flags: INDEX_DIRTY | WORKTREE_DIRTY });
  });

  it("falls back for normal untracked collapsing and stays sparse for all", () => {
    const normal = makeRepo("/");
    sealIndexTracker(normal);
    writeWorkFile(normal, "/fresh/a.txt", "fresh\n");
    expect(
      eagerStatus(normal.repo, normal.worktree, {}, sparseTrackerContext(normal)).map(
        (row) => row.path,
      ),
    ).toEqual(["fresh/"]);

    const all = makeRepo("/");
    sealIndexTracker(all);
    writeWorkFile(all, "/fresh/a.txt", "fresh\n");
    expect(
      eagerStatus(
        all.repo,
        new NoScanWorktree(all.worktree),
        { untrackedFiles: "all" },
        sparseTrackerContext(all),
      ).map((row) => row.path),
    ).toEqual(["fresh/a.txt"]);

    const ignored = makeRepo("/");
    writeWorkFile(ignored, "/.gitignore", "*.log\n");
    commitFiles(ignored, [".gitignore"]);
    sealIndexTracker(ignored);
    writeWorkFile(ignored, "/ignored/noisy.log", "noise\n");
    expect(
      eagerStatus(
        ignored.repo,
        ignored.worktree,
        { includeIgnored: true },
        sparseTrackerContext(ignored),
      ).map((row) => row.path),
    ).toEqual(["ignored/"]);
  });

  it("chooses normal-untracked fallback before hashing a tracked candidate", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "before\n");
    commitFiles(workspace, ["a.txt"]);
    sealIndexTracker(workspace);
    workspace.tick(60_000);
    writeWorkFile(workspace, "/a.txt", "after\n");
    writeWorkFile(workspace, "/z-untracked.txt", "untracked\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    expect(() =>
      eagerStatus(workspace.repo, worktree, {}, sparseTrackerContext(workspace)),
    ).toThrowError(/must not scan/);
    expect(worktree.bulkReadPaths).toEqual([]);
  });

  it("retains worktree dirtiness when a staged deletion leaves the old file", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    commitFiles(workspace, ["kept.txt"]);
    sealIndexTracker(workspace);
    workspace.repo.store.indexRemove("kept.txt");

    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        { untrackedFiles: "all" },
        sparseTrackerContext(workspace),
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
    expect(
      eagerStatus(workspace.repo, workspace.worktree, {}, sparseTrackerContext(workspace)),
    ).toEqual(expected);
  });

  it("does not reseal a filtered or only partly capable full status", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { paths: ["a.txt"] }, recorded.context),
    ).toHaveLength(1);
    expect(
      eagerStatus(
        workspace.repo,
        workspace.worktree,
        { excludeRoots: ["/nested"] },
        recorded.context,
      ),
    ).toHaveLength(1);
    expect(
      eagerStatus(
        workspace.repo,
        workspace.worktree,
        {},
        {
          sparseWorkspace: workspace.context.sparseWorkspace,
        },
      ),
    ).toHaveLength(1);
    expect(
      eagerStatus(
        workspace.repo,
        workspace.worktree,
        {},
        {
          indexTracker: recorded.context.indexTracker,
        },
      ),
    ).toHaveLength(1);
    expect(recorded.reseals).toEqual([]);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: false,
    });
  });

  it("does not reseal a partial full status when hashing fails", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "before\n");
    commitFiles(workspace, ["a.txt"]);
    workspace.tick(60_000);
    writeWorkFile(workspace, "/a.txt", "after\n");
    const recorded = recordingContext(workspace);

    expect(() =>
      eagerStatus(
        workspace.repo,
        new FailingHashWorktree(workspace.worktree),
        {},
        recorded.context,
      ),
    ).toThrowError(/injected hash failure/);
    expect(recorded.reseals).toEqual([]);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: false,
    });
  });

  it("keeps the exported lazy status stream side-effect free when abandoned", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    const stream = statusStream(workspace.repo, workspace.worktree, { untrackedFiles: "all" });

    expect(stream.next().value).toEqual(expect.objectContaining({ path: "a.txt" }));
    stream.return(undefined);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: false,
    });
  });

  it("returns normal status and skips reseal above the dirty-row cap", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.indexReplace(
      Array.from({ length: 32_001 }, (_, index) =>
        bareIndexEntry(`f${index.toString().padStart(5, "0")}.txt`),
      ),
    );
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { untrackedFiles: "all" }, recorded.context),
    ).toHaveLength(32_001);
    expect(recorded.reseals).toEqual([]);
  });

  it("returns normal status and skips reseal above the retained-memory cap", () => {
    const workspace = makeRepo("/");
    const suffix = "x".repeat(2_000);
    workspace.repo.store.indexReplace(
      Array.from({ length: 4_000 }, (_, index) =>
        bareIndexEntry(`${index.toString().padStart(4, "0")}/${suffix}`),
      ),
    );
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { untrackedFiles: "all" }, recorded.context),
    ).toHaveLength(4_000);
    expect(recorded.reseals).toEqual([]);
  });

  it("skips reseal for a worktree leaf the tracker cannot represent", () => {
    const workspace = makeRepo("/");
    const path = "x".repeat(2_201);
    writeWorkFile(workspace, `/${path}`, "large path\n");
    const recorded = recordingContext(workspace);

    expect(
      eagerStatus(workspace.repo, workspace.worktree, { untrackedFiles: "all" }, recorded.context),
    ).toEqual([expect.objectContaining({ path })]);
    expect(recorded.reseals).toEqual([]);
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
    sealIndexTracker(workspace, { baselineTreeOid: oldTree });

    expect(
      eagerStatus(
        workspace.repo,
        new NoScanWorktree(workspace.worktree),
        {},
        sparseTrackerContext(workspace),
      ),
    ).toEqual([]);
    expect(readIndexTrackerState(workspace.database.db, workspace.repo.store.repoId)).toEqual({
      available: true,
      baselineTreeOid: workspace.repo.headTree(),
    });
  });

  it("propagates sparse hydration corruption without resealing", () => {
    const workspace = makeRepo("/");
    sealIndexTracker(workspace, { entries: [{ path: "broken.txt", flags: INDEX_DIRTY }] });
    const source = requireSparseWorkspace(workspace);
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
