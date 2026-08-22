import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { CorruptError } from "../src/core/errors.js";
import { MODE_COMMIT, serializeTree } from "../src/core/objects.js";
import { commit } from "../src/core/ops/commit.js";
import { diff, diffSummary } from "../src/core/ops/diff.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import type { SparseWorkspaceSource } from "../src/core/sparse-workspace.js";
import { resealIndexTracker } from "../src/sqlite/index-tracker.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

class NoScanWorktree extends CountingWorktree {
  override scan(): never {
    throw new Error("sparse diff must not scan the worktree");
  }
}

function stagePaths(workspace: TestRepository, paths: readonly string[]): void {
  for (const path of paths) {
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path);
    if (hashed === null) throw new Error(`missing fixture path: ${path}`);
    workspace.repo.store.indexPut(indexEntryFor(path, hashed));
  }
}

function commitPaths(workspace: TestRepository, paths: readonly string[], message: string): string {
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  stagePaths(workspace, paths);
  return commit(workspace.context, workspace.repo, { message }).oid;
}

function seal(workspace: TestRepository, baselineTreeOid = workspace.repo.headTree()): void {
  expect(
    resealIndexTracker(workspace.database.db, workspace.repo.store.repoId, baselineTreeOid, []),
  ).toBe(true);
}

function source(workspace: TestRepository): SparseWorkspaceSource {
  const value = workspace.context.sparseWorkspace;
  if (value === undefined) throw new Error("missing sparse workspace source");
  return value;
}

describe("sparse diff", () => {
  it("returns a clean sealed diff without scanning the tree or worktree", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    commitPaths(workspace, ["a.txt"], "initial");
    seal(workspace);
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    expect(diffSummary(workspace.repo, worktree, {}, source(workspace))).toEqual([]);
    expect(workspace.storage.statementCount).toBeLessThan(10);
    expect(workspace.storage.rowCount).toBeLessThan(10);
  });

  it("hashes one hundred modified paths without a refresh scan", () => {
    const workspace = makeRepo("/");
    const paths = Array.from(
      { length: 100 },
      (_, index) => `src/f${index.toString().padStart(3, "0")}.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "before\n");
    commitPaths(workspace, paths, "initial");
    seal(workspace);
    workspace.tick(60_000);
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "after\n");
    const worktree = new NoScanWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    const summary = diffSummary(workspace.repo, worktree, {}, source(workspace));

    expect(summary.map((entry) => entry.path)).toEqual(paths);
    expect(summary.every((entry) => entry.status === "M")).toBe(true);
    expect(worktree.bulkReadPaths).toHaveLength(200);
    expect(workspace.storage.statementCount).toBeLessThan(50);
    expect(workspace.storage.rowCount).toBeLessThan(10_000);
  });

  it("matches the full path for staged, deleted, mode, symlink, and conflict changes", () => {
    const workspace = makeRepo("/");
    const paths = ["conflict.txt", "deleted.txt", "link", "mode.txt", "staged.txt"];
    writeWorkFile(workspace, "/conflict.txt", "base\n");
    writeWorkFile(workspace, "/deleted.txt", "deleted\n");
    workspace.worktree.symlink("before", "/link");
    writeWorkFile(workspace, "/mode.txt", "mode\n");
    writeWorkFile(workspace, "/staged.txt", "before\n");
    commitPaths(workspace, paths, "initial");
    seal(workspace);
    workspace.tick(60_000);

    workspace.worktree.unlink("/deleted.txt");
    workspace.worktree.chmod("/mode.txt", 0o755);
    workspace.worktree.unlink("/link");
    workspace.worktree.symlink("after", "/link");
    writeWorkFile(workspace, "/staged.txt", "after\n");
    stagePaths(workspace, ["staged.txt"]);
    workspace.repo.store.indexRemove("conflict.txt");
    const conflictOid = workspace.repo.store.write("blob", utf8.encode("conflict\n"));
    for (const stage of [1, 2, 3]) {
      const entry: IndexEntry = {
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid: conflictOid,
        size: null,
        mtime: null,
        ino: null,
      };
      workspace.repo.store.indexPut(entry);
    }

    const expectedPatch = diff(workspace.repo, workspace.worktree);
    const expectedSummary = diffSummary(workspace.repo, workspace.worktree);
    const worktree = new NoScanWorktree(workspace.worktree);
    expect(diff(workspace.repo, worktree, {}, source(workspace))).toBe(expectedPatch);
    expect(diffSummary(workspace.repo, worktree, {}, source(workspace))).toEqual(expectedSummary);
  });

  it("uses the tracker baseline for a custom ref and respects pathspecs", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "one\n");
    writeWorkFile(workspace, "/nested/b.txt", "one\n");
    const first = commitPaths(workspace, ["a.txt", "nested/b.txt"], "first");
    writeWorkFile(workspace, "/a.txt", "two\n");
    writeWorkFile(workspace, "/nested/b.txt", "two\n");
    commitPaths(workspace, ["a.txt", "nested/b.txt"], "second");
    seal(workspace);
    const options = { ref: first, paths: ["nested"] };

    const expected = diff(workspace.repo, workspace.worktree, options);
    expect(
      diff(workspace.repo, new NoScanWorktree(workspace.worktree), options, source(workspace)),
    ).toBe(expected);
    expect(expected).toContain("nested/b.txt");
    expect(expected).not.toContain("a.txt");
  });

  it("falls back before hashing when state or hydration is unavailable", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "before\n");
    commitPaths(workspace, ["a.txt"], "initial");
    seal(workspace);
    workspace.tick(60_000);
    writeWorkFile(workspace, "/a.txt", "after\n");
    const available = source(workspace);
    const unavailableState: SparseWorkspaceSource = {
      readState: () => ({ available: false }),
      dirtyPaths: (repoId) => available.dirtyPaths(repoId),
      hydrate: (request) => available.hydrate(request),
    };
    const unavailableHydration: SparseWorkspaceSource = {
      readState: (repoId) => available.readState(repoId),
      dirtyPaths: (repoId) => available.dirtyPaths(repoId),
      hydrate: () => ({ available: false }),
    };
    const expected = diff(workspace.repo, workspace.worktree);

    expect(diff(workspace.repo, workspace.worktree, {}, unavailableState)).toBe(expected);
    expect(diff(workspace.repo, workspace.worktree, {}, unavailableHydration)).toBe(expected);
    const noScan = new NoScanWorktree(workspace.worktree);
    expect(() => diff(workspace.repo, noScan, {}, unavailableHydration)).toThrow(/must not scan/);
    expect(noScan.bulkReadPaths).toEqual([]);
  });

  it("falls back before hydration when more than one thousand paths are dirty", () => {
    const workspace = makeRepo("/");
    let hydrates = 0;
    const tooMany: SparseWorkspaceSource = {
      readState: () => ({ available: true, baselineTreeOid: null }),
      dirtyPaths: function* () {
        for (let index = 0; index < 1_001; index++) {
          yield { path: `f${index.toString().padStart(4, "0")}.txt`, flags: 2 };
        }
      },
      hydrate: () => {
        hydrates++;
        return { available: false };
      },
    };

    expect(() => diff(workspace.repo, new NoScanWorktree(workspace.worktree), {}, tooMany)).toThrow(
      /must not scan/,
    );
    expect(hydrates).toBe(0);
  });

  it("propagates sparse hydration corruption", () => {
    const workspace = makeRepo("/");
    seal(workspace);
    writeWorkFile(workspace, "/broken.txt", "broken\n");
    const available = source(workspace);
    const broken: SparseWorkspaceSource = {
      readState: (repoId) => available.readState(repoId),
      dirtyPaths: (repoId) => available.dirtyPaths(repoId),
      hydrate: () => {
        throw new CorruptError("injected sparse corruption");
      },
    };

    expect(() => diff(workspace.repo, workspace.worktree, {}, broken)).toThrow(
      /injected sparse corruption/,
    );
  });

  it("handles an unborn tree with a staged addition", () => {
    const workspace = makeRepo("/");
    seal(workspace, null);
    writeWorkFile(workspace, "/added.txt", "added\n");
    stagePaths(workspace, ["added.txt"]);

    const expected = diff(workspace.repo, workspace.worktree);
    expect(
      diff(workspace.repo, new NoScanWorktree(workspace.worktree), {}, source(workspace)),
    ).toBe(expected);
    expect(expected).toContain("new file mode 100644");
  });

  it("prunes equal subtrees for a bounded commit-pair diff", () => {
    const workspace = makeRepo("/");
    const paths = Array.from(
      { length: 200 },
      (_, index) => `d${index.toString().padStart(3, "0")}/file.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "before\n");
    commitPaths(workspace, paths, "first");
    writeWorkFile(workspace, `/${paths[137]}`, "after\n");
    stagePaths(workspace, [paths[137]!]);
    commit(workspace.context, workspace.repo, { message: "second" });

    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    const summary = diffSummary(workspace.repo, workspace.worktree, { ref: "HEAD~1", to: "HEAD" });

    expect(summary).toEqual([{ path: paths[137], status: "M", insertions: 1, deletions: 1 }]);
    expect(
      workspace.storage.statementCount,
      JSON.stringify([...workspace.storage.histogram.entries()]),
    ).toBeLessThanOrEqual(20);
    expect(workspace.storage.rowCount).toBeLessThan(100);
  });

  it("falls back to the full merge for a 1,001-path commit pair", () => {
    const workspace = makeRepo("/");
    const paths = Array.from(
      { length: 1_001 },
      (_, index) => `f${index.toString().padStart(4, "0")}.txt`,
    );
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "before\n");
    commitPaths(workspace, paths, "first");
    workspace.tick(60_000);
    for (const path of paths) writeWorkFile(workspace, `/${path}`, "after\n");
    stagePaths(workspace, paths);
    commit(workspace.context, workspace.repo, { message: "second" });
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();

    const summary = diffSummary(workspace.repo, workspace.worktree, {
      ref: "HEAD~1",
      to: "HEAD",
    });

    expect(summary).toHaveLength(1_001);
    const queries = [...workspace.storage.histogram.keys()].join("\n");
    expect(queries).toContain("before_root, after_root");
    expect(queries).toContain("root_oid, path_cap");
  });

  it("counts changed gitlinks toward the commit-pair fallback limit", () => {
    const workspace = makeRepo("/");
    const entries = Array.from({ length: 1_001 }, (_, index) => ({
      mode: MODE_COMMIT,
      name: `dependency-${index.toString().padStart(4, "0")}`,
      oid: "1".repeat(40),
    }));
    const before = workspace.repo.store.write("tree", serializeTree(entries));
    const after = workspace.repo.store.write(
      "tree",
      serializeTree(entries.map((entry) => ({ ...entry, oid: "2".repeat(40) }))),
    );
    const blobIdsBefore =
      workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids") ?? 0;
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    const worktree = new NoScanWorktree(workspace.worktree);

    expect(diffSummary(workspace.repo, worktree, { ref: before, to: after })).toEqual([]);

    const statements = [...workspace.storage.histogram.entries()];
    expect(statements.find(([query]) => query.includes("before_root, after_root"))?.[1]).toBe(1);
    expect(statements.find(([query]) => query.includes("root_oid, path_cap"))?.[1]).toBe(2);
    expect(statements.some(([query]) => query.includes("wanted(ordinal, oid)"))).toBe(false);
    expect(worktree.bulkReadPaths).toEqual([]);
    expect(workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids") ?? 0).toBe(
      blobIdsBefore,
    );
  });
});
