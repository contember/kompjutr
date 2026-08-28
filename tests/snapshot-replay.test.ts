import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Repository } from "../src/core/repository.js";
import { createGit, type Git } from "../src/git/client.js";
import { readIndexTrackerState } from "../src/sqlite/index-tracker.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/sqlite/memory.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

function fixture(): GitFixture {
  const created = new GitFixture().init();
  fixtures.push(created);
  return created;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function bindGit(workspace: TestRepository, database: SqliteGitDatabase = workspace.database): Git {
  return createGit()({
    database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
  });
}

async function importWorkspace(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/");
  await importFixture(source, workspace.repo.checkout);
  return workspace;
}

function controlState(workspace: TestRepository) {
  const row = workspace.database.checkoutAt("/");
  if (row === null) throw new Error("repository is missing");
  const repo = new Repository(workspace.database.openCheckout(row));
  return {
    head: repo.checkout.head(),
    refs: repo.store.listRefs(),
    reflogs: repo.store.listRefs().map((ref) => ({ name: ref.name, rows: repo.reflog(ref.name) })),
    index: [...repo.checkout.indexScan()],
    tracker: readIndexTrackerState(workspace.database.db, repo.checkout.checkoutId),
    operation: repo.checkout.readOperationState(),
    worktree: workspace.worktree.scan("/", { limit: 10_000 }),
  };
}

function scratchRows(workspace: TestRepository): Record<string, unknown>[] {
  return workspace.database.db.all<Record<string, unknown>>(
    `SELECT * FROM git_scratch_index_entries ORDER BY repo_id, name, path, stage`,
  );
}

function objectCount(workspace: TestRepository): number {
  return workspace.database.db.scalar<number>("SELECT count(*) FROM git_objects") ?? -1;
}

function gitReplayTree(source: GitFixture, snapshot: string, onto: string, name: string): string {
  const environment = { GIT_INDEX_FILE: join(source.dir, ".git", `${name}.index`) };
  source.gitWithEnv(environment, "read-tree", onto);
  const patch = source.gitBinary("diff", "--binary", "--full-index", `${snapshot}^`, snapshot);
  const applied = source.gitInputResultWithEnv(
    patch.toString("utf8"),
    environment,
    "apply",
    "--3way",
    "--cached",
  );
  if (applied.status !== 0) throw new Error(`Git snapshot replay failed: ${applied.stderr}`);
  return source.gitWithEnv(environment, "write-tree");
}

function gitReplayConflictRows(
  source: GitFixture,
  snapshot: string,
  onto: string,
  name: string,
): string[] {
  const branch = `control-${name}`;
  source.git("checkout", "-q", "-b", branch, onto);
  const applied = source.gitResult("cherry-pick", "--no-commit", snapshot);
  if (applied.status === 0) throw new Error("Git snapshot replay unexpectedly succeeded");
  const rows = source
    .git("ls-files", "--stage")
    .split("\n")
    .filter((row) => /^[0-7]+ [0-9a-f]{40} [123]\t/.test(row));
  source.git("reset", "--hard", "-q", onto);
  source.git("checkout", "-q", "onto");
  source.git("branch", "-D", branch);
  return rows;
}

function cleanHistory(): {
  source: GitFixture;
  base: string;
  snapshot: string;
  onto: string;
  expectedTree: string;
} {
  const source = fixture();
  source
    .write("merge.txt", "first\nsecond\nthird\n")
    .write("binary.dat", new Uint8Array([0, 1, 2, 3]))
    .write("mode.sh", "#!/bin/sh\n")
    .write("rename-old.txt", "rename\n")
    .write("delete.txt", "delete\n")
    .write("stable.txt", "stable\n");
  const base = source.commit("base");

  source.git("checkout", "-q", "-b", "snapshot", base);
  source
    .write("merge.txt", "snapshot first\nsecond\nthird\n")
    .write("binary.dat", new Uint8Array([0, 9, 2, 3]))
    .chmod("mode.sh", 0o755)
    .remove("rename-old.txt")
    .write("rename-new.txt", "rename\n")
    .remove("delete.txt")
    .write("added.txt", "added\n");
  const snapshot = source.commit("snapshot");

  source.git("checkout", "-q", "-b", "onto", base);
  source.write("merge.txt", "first\nsecond\nonto third\n").write("onto.txt", "onto\n");
  const onto = source.commit("onto");
  const expectedTree = gitReplayTree(source, snapshot, onto, "clean-replay");
  return { source, base, snapshot, onto, expectedTree };
}

describe("scratch snapshot replay", () => {
  it("matches Git for clean content, binary, mode, add, delete, and rename-shaped changes", async () => {
    const { source, snapshot, onto, expectedTree } = cleanHistory();
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const before = controlState(workspace);
    const beforeStatements = workspace.storage.statementCount;

    const result = await git.withScratchIndex({ name: "clean" }, (scratch) => {
      const replayed = scratch.replaySnapshot({ snapshot, onto });
      expect(replayed).toEqual({ outcome: "clean", tree: expectedTree });
      expect(scratch.writeTree()).toBe(expectedTree);
      return replayed;
    });

    expect(result).toEqual({ outcome: "clean", tree: expectedTree });
    expect(workspace.storage.statementCount - beforeStatements).toBeLessThan(1_000);
    expect(controlState(workspace)).toEqual(before);
    expect(scratchRows(workspace)).toEqual([]);

    const coldDatabase = new SqliteGitDatabase(workspace.database.db);
    const cold = bindGit(workspace, coldDatabase);
    await expect(
      cold.withScratchIndex({ name: "cold" }, (scratch) =>
        scratch.replaySnapshot({ snapshot: "snapshot", onto: "onto" }),
      ),
    ).resolves.toEqual({ outcome: "clean", tree: expectedTree });
    expect(controlState(workspace)).toEqual(before);
    expect(scratchRows(workspace)).toEqual([]);
  });

  it("returns Git stage data for conflicts without changing the selected index or objects", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n").write("stable.txt", "stable\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "snapshot", base);
    source.write("conflict.txt", "snapshot\n");
    const snapshot = source.commit("snapshot");
    source.git("checkout", "-q", "-b", "onto", base);
    source.write("conflict.txt", "onto\n");
    const onto = source.commit("onto");
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const before = controlState(workspace);
    const beforeObjects = objectCount(workspace);
    const expectedStages = [
      { stage: 1, mode: "100644", oid: source.git("rev-parse", `${base}:conflict.txt`) },
      { stage: 2, mode: "100644", oid: source.git("rev-parse", `${onto}:conflict.txt`) },
      { stage: 3, mode: "100644", oid: source.git("rev-parse", `${snapshot}:conflict.txt`) },
    ];

    await git.withScratchIndex({ name: "conflict" }, (scratch) => {
      scratch.readTree({ tree: base });
      const beforeTree = scratch.writeTree();
      expect(scratch.replaySnapshot({ snapshot, onto })).toEqual({
        outcome: "conflicted",
        conflicts: [{ path: "conflict.txt", kind: "content", stages: expectedStages }],
      });
      expect(scratch.writeTree()).toBe(beforeTree);
    });

    expect(objectCount(workspace)).toBe(beforeObjects);
    expect(controlState(workspace)).toEqual(before);
    expect(scratchRows(workspace)).toEqual([]);
  });

  it("returns Git's physical stage projection for structural conflicts", async () => {
    const source = fixture();
    source.write("collision", "base\n");
    const base = source.commit("base");

    source.git("checkout", "-q", "-b", "snapshot", base);
    source.write("collision", "snapshot\n").write("typed", "regular\n");
    const snapshot = source.commit("snapshot");

    source.git("checkout", "-q", "-b", "onto", base);
    source.remove("collision").write("collision/child.txt", "child\n").symlink("target", "typed");
    const onto = source.commit("onto");
    const expectedRows = gitReplayConflictRows(source, snapshot, onto, "structural-replay");
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);

    await git.withScratchIndex({ name: "structural" }, (scratch) => {
      const result = scratch.replaySnapshot({ snapshot, onto });
      expect(result.outcome).toBe("conflicted");
      if (result.outcome !== "conflicted")
        throw new Error("snapshot replay unexpectedly succeeded");
      const actualRows = result.conflicts.flatMap((conflict) =>
        conflict.stages.map(
          (stage) => `${stage.mode} ${stage.oid} ${stage.stage}\t${conflict.path}`,
        ),
      );
      expect(actualRows).toEqual(expectedRows);
    });
  });

  it("rejects root, merge, and gitlink snapshots before changing scratch state", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const root = source.commit("root");
    source.write("tip.txt", "tip\n");
    const onto = source.commit("onto");
    source.git("checkout", "-q", "-b", "side", root);
    source.write("side.txt", "side\n");
    const side = source.commit("side");
    const merge = source.gitInput(
      "merge snapshot\n",
      "commit-tree",
      source.git("rev-parse", `${onto}^{tree}`),
      "-p",
      onto,
      "-p",
      side,
    );
    source.git("update-ref", "refs/heads/merge-snapshot", merge);
    source.git("checkout", "-q", "-b", "gitlink-snapshot", onto);
    source.git("update-index", "--add", "--cacheinfo", `160000,${root},vendor/module`);
    source.git("commit", "-q", "-m", "gitlink snapshot");
    const gitlink = source.git("rev-parse", "HEAD");

    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const before = controlState(workspace);
    const beforeObjects = objectCount(workspace);

    await git.withScratchIndex({ name: "invalid" }, (scratch) => {
      scratch.readTree({ tree: onto });
      const tree = scratch.writeTree();
      for (const snapshot of [root, merge]) {
        expect(() => scratch.replaySnapshot({ snapshot, onto })).toThrowError(
          expect.objectContaining({ code: "EINVAL" }),
        );
        expect(scratch.writeTree()).toBe(tree);
      }
      expect(() => scratch.replaySnapshot({ snapshot: gitlink, onto })).toThrowError(
        expect.objectContaining({ code: "EUNSUPPORTED" }),
      );
      expect(scratch.writeTree()).toBe(tree);
    });

    expect(objectCount(workspace)).toBe(beforeObjects);
    expect(controlState(workspace)).toEqual(before);
  });

  it("rejects a root snapshot before reading its corrupt tree projection", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const root = source.commit("root");
    source.write("onto.txt", "onto\n");
    const onto = source.commit("onto");
    const workspace = await importWorkspace(source);
    const rootTree = source.git("rev-parse", `${root}^{tree}`);
    workspace.database.db.run(
      `UPDATE git_tree_entries SET oid = ?
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? LIMIT 1
        ) AND ordinal = 0`,
      "f".repeat(40),
      workspace.repo.store.repoId,
      rootTree,
    );

    await expect(
      bindGit(workspace).withScratchIndex({ name: "invalid-root" }, (scratch) =>
        scratch.replaySnapshot({ snapshot: root, onto }),
      ),
    ).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("rolls back replay objects when the scratch callback fails", async () => {
    const { source, snapshot, onto } = cleanHistory();
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const before = controlState(workspace);
    const beforeObjects = objectCount(workspace);

    await expect(
      git.withScratchIndex({ name: "rollback" }, (scratch) => {
        const result = scratch.replaySnapshot({ snapshot, onto });
        expect(result.outcome).toBe("clean");
        throw new Error("abort replay");
      }),
    ).rejects.toThrow("abort replay");

    expect(objectCount(workspace)).toBe(beforeObjects);
    expect(controlState(workspace)).toEqual(before);
    expect(scratchRows(workspace)).toEqual([]);
  });

  it("fails closed on stale derived tree rows", async () => {
    const { source, snapshot, onto } = cleanHistory();
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const snapshotTree = source.git("rev-parse", `${snapshot}^{tree}`);
    const before = controlState(workspace);
    const beforeObjects = objectCount(workspace);
    workspace.database.db.run(
      `UPDATE git_tree_entries SET oid = ?
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = ? AND tree_oid = ? LIMIT 1
        ) AND ordinal = 0`,
      "f".repeat(40),
      workspace.repo.store.repoId,
      snapshotTree,
    );

    await expect(
      git.withScratchIndex({ name: "stale" }, (scratch) =>
        scratch.replaySnapshot({ snapshot, onto }),
      ),
    ).rejects.toMatchObject({ code: "ECORRUPT" });
    expect(objectCount(workspace)).toBe(beforeObjects);
    expect(controlState(workspace)).toEqual(before);
    expect(scratchRows(workspace)).toEqual([]);
  });

  it("rejects a replay plan beyond the 1,000-entry boundary without writes", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "snapshot", base);
    for (let index = 0; index < 1_001; index++) {
      source.write(`added/${index.toString().padStart(4, "0")}.txt`, `${index}\n`);
    }
    const snapshot = source.commit("oversized snapshot");
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const before = controlState(workspace);
    const beforeObjects = objectCount(workspace);

    await expect(
      git.withScratchIndex({ name: "oversized" }, (scratch) =>
        scratch.replaySnapshot({ snapshot, onto: base }),
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(objectCount(workspace)).toBe(beforeObjects);
    expect(controlState(workspace)).toEqual(before);
    expect(scratchRows(workspace)).toEqual([]);
  });

  it("replays a clean retained plan above 16 MiB within the shared memory limit", async () => {
    const source = fixture();
    const body = "x".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 9; index++) {
      source.write(`large/${index}.txt`, `base first\n${body}\nbase last\n`);
    }
    const base = source.commit("large base");
    source.git("checkout", "-q", "-b", "snapshot", base);
    for (let index = 0; index < 9; index++) {
      source.write(`large/${index}.txt`, `snapshot first\n${body}\nbase last\n`);
    }
    const snapshot = source.commit("large snapshot");
    source.git("checkout", "-q", "-b", "onto", base);
    for (let index = 0; index < 9; index++) {
      source.write(`large/${index}.txt`, `base first\n${body}\nonto last\n`);
    }
    const onto = source.commit("large onto");
    const expectedTree = gitReplayTree(source, snapshot, onto, "large-replay");
    const workspace = await importWorkspace(source);

    await expect(
      bindGit(workspace).withScratchIndex({ name: "large" }, (scratch) =>
        scratch.replaySnapshot({ snapshot, onto }),
      ),
    ).resolves.toEqual({ outcome: "clean", tree: expectedTree });
    expect(workspace.repo.store.memory.highWaterBytes).toBeLessThanOrEqual(
      MAX_OPERATION_MEMORY_BYTES,
    );
    expect(workspace.repo.store.memory.activeCount).toBe(0);
  }, 30_000);
});
