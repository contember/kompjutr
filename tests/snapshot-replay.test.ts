import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../packages/git/src/client.js";
import {
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
} from "../packages/git/src/do-fs/indexes/index-tracker.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];
const FIXTURE_IDENTITY = { name: "Fixture", email: "fixture@example.com" };
const FIXTURE_NOW = 1_577_836_800_000;

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
  const workspace = makeRepo("/", { now: () => FIXTURE_NOW });
  await importFixture(source, workspace.repo.checkout);
  return workspace;
}

function reopenDatabase(workspace: TestRepository): SqliteGitDatabase {
  return new SqliteGitDatabase(workspace.database.db, { now: () => FIXTURE_NOW });
}

function controlState(workspace: TestRepository, database: SqliteGitDatabase = workspace.database) {
  const row = database.checkoutAt("/");
  if (row === null) throw new Error("repository is missing");
  const repo = new Repository(database.openCheckout(row));
  return {
    head: repo.checkout.head(),
    refs: repo.store.listRefs(),
    reflogs: repo.store.listRefs().map((ref) => ({ name: ref.name, rows: repo.reflog(ref.name) })),
    index: [...repo.checkout.indexScan()],
    tracker: readIndexTrackerState(database.db, repo.checkout.checkoutId),
    trackerDirty: [...iterateIndexTrackerDirty(database.db, repo.checkout.checkoutId)],
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

async function initialiseCheckedOutTip(
  workspace: TestRepository,
  git: Git,
  tip: string,
  tree: string,
): Promise<void> {
  await git.readTree({ tree: tip, updateWorktree: true });
  if (!resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, tree, [])) {
    throw new Error("index tracker could not be initialised");
  }
}

async function composeSnapshotCommit(
  git: Git,
  snapshot: string,
  onto: string,
  name: string,
): Promise<{ tree: string; commit: string }> {
  return git.withScratchIndex({ name }, (scratch) => {
    const replayed = scratch.replaySnapshot({ snapshot, onto });
    if (replayed.outcome !== "clean") throw new Error("snapshot replay is conflicted");
    const commit = scratch.commitTree({
      tree: replayed.tree,
      message: "restore checkpoint\n",
      parent: [onto],
      author: FIXTURE_IDENTITY,
      committer: FIXTURE_IDENTITY,
    });
    return { tree: replayed.tree, commit };
  });
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

    const coldDatabase = reopenDatabase(workspace);
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
    const publishRef = "refs/checkpoints/conflicted";
    await git.updateRef({ ref: publishRef, value: onto, expected: null });
    const before = controlState(workspace);
    const beforeObjects = objectCount(workspace);
    const expectedStages = [
      { stage: 1, mode: "100644", oid: source.git("rev-parse", `${base}:conflict.txt`) },
      { stage: 2, mode: "100644", oid: source.git("rev-parse", `${onto}:conflict.txt`) },
      { stage: 3, mode: "100644", oid: source.git("rev-parse", `${snapshot}:conflict.txt`) },
    ];

    await expect(git.tryRevParse({ ref: "missing-checkpoint" })).resolves.toBeUndefined();
    await expect(git.mergeBase({ current: onto, incoming: snapshot })).resolves.toEqual({
      kind: "divergent",
      bases: [base],
    });
    expect(
      (await git.lsTree({ ref: snapshot, recursive: true })).some((row) => row.mode === "160000"),
    ).toBe(false);

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
    await expect(git.readRef({ ref: publishRef })).resolves.toEqual({
      kind: "direct",
      oid: onto,
    });
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

  it("rejects a root snapshot", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const root = source.commit("root");
    source.write("onto.txt", "onto\n");
    const onto = source.commit("onto");
    const workspace = await importWorkspace(source);

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

  it("replays a clean plan above 16 MiB", async () => {
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
  }, 30_000);
});

describe("checkpoint restore composition", () => {
  it("inspects, replays, applies, and guardedly publishes through the public client", async () => {
    const { source, base, snapshot, onto, expectedTree } = cleanHistory();
    const expectedCommit = source.gitInput(
      "restore checkpoint\n",
      "commit-tree",
      expectedTree,
      "-p",
      onto,
    );
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const ontoTree = source.git("rev-parse", `${onto}^{tree}`);
    const publishRef = "refs/checkpoints/current";
    await initialiseCheckedOutTip(workspace, git, onto, ontoTree);
    await git.updateRef({ ref: publishRef, value: onto, expected: null });
    const beforeReplay = controlState(workspace);
    const beforeObjects = objectCount(workspace);

    await expect(git.revParse({ ref: `${snapshot}^{commit}` })).resolves.toBe(snapshot);
    await expect(git.tryRevParse({ ref: "missing-checkpoint" })).resolves.toBeUndefined();
    const snapshotRows = await git.lsTree({ ref: snapshot, recursive: true });
    expect(snapshotRows.some((row) => row.mode === "160000")).toBe(false);
    await expect(git.mergeBase({ current: onto, incoming: snapshot })).resolves.toEqual({
      kind: "divergent",
      bases: [base],
    });

    const restored = await composeSnapshotCommit(git, snapshot, onto, "restore");
    expect(restored).toEqual({ tree: expectedTree, commit: expectedCommit });
    expect(controlState(workspace)).toEqual(beforeReplay);
    expect(scratchRows(workspace)).toEqual([]);

    await git.readTree({ tree: restored.tree, updateWorktree: true });
    await git.updateRef({ ref: publishRef, value: restored.commit, expected: onto });

    await expect(git.writeTree()).resolves.toBe(expectedTree);
    await expect(git.diff({ ref: restored.commit })).resolves.toBe("");
    await expect(git.readRef({ ref: publishRef })).resolves.toEqual({
      kind: "direct",
      oid: expectedCommit,
    });
    const afterPublish = controlState(workspace);
    expect(afterPublish.head).toBe("ref: refs/heads/onto");
    expect(afterPublish.operation).toBeNull();
    expect(afterPublish.tracker).toEqual({ available: true, baselineTreeOid: ontoTree });
    expect(afterPublish.trackerDirty.length).toBeGreaterThan(0);
    expect(afterPublish.reflogs.find((entry) => entry.name === publishRef)?.rows[0]?.newOid).toBe(
      expectedCommit,
    );
    expect(objectCount(workspace)).toBeGreaterThan(beforeObjects);
    expect(scratchRows(workspace)).toEqual([]);

    const coldDatabase = reopenDatabase(workspace);
    const cold = bindGit(workspace, coldDatabase);
    await expect(cold.readRef({ ref: publishRef })).resolves.toEqual({
      kind: "direct",
      oid: expectedCommit,
    });
    await expect(cold.writeTree()).resolves.toBe(expectedTree);
    expect(controlState(workspace, coldDatabase)).toEqual(afterPublish);
  });

  it("leaves the applied tree intact when a guarded publisher loses a ref race", async () => {
    const { source, snapshot, onto, expectedTree } = cleanHistory();
    const workspace = await importWorkspace(source);
    const git = bindGit(workspace);
    const ontoTree = source.git("rev-parse", `${onto}^{tree}`);
    const publishRef = "refs/checkpoints/raced";
    await initialiseCheckedOutTip(workspace, git, onto, ontoTree);
    await git.updateRef({ ref: publishRef, value: onto, expected: null });
    const beforeObjects = objectCount(workspace);

    const restored = await composeSnapshotCommit(git, snapshot, onto, "raced-restore");
    await git.readTree({ tree: restored.tree, updateWorktree: true });
    await git.updateRef({ ref: publishRef, value: snapshot, expected: onto });
    const beforeFailedPublish = controlState(workspace);
    const objectsBeforeFailedPublish = objectCount(workspace);
    const reflogRowsBefore = beforeFailedPublish.reflogs.find((entry) => entry.name === publishRef)
      ?.rows.length;

    await expect(
      git.updateRef({ ref: publishRef, value: restored.commit, expected: onto }),
    ).rejects.toMatchObject({ code: "ESTALEHEAD" });

    expect(controlState(workspace)).toEqual(beforeFailedPublish);
    expect(
      controlState(workspace).reflogs.find((entry) => entry.name === publishRef)?.rows.length,
    ).toBe(reflogRowsBefore);
    expect(objectCount(workspace)).toBe(objectsBeforeFailedPublish);
    expect(objectCount(workspace)).toBeGreaterThan(beforeObjects);
    expect(workspace.repo.has(restored.tree)).toBe(true);
    expect(workspace.repo.has(restored.commit)).toBe(true);
    expect(scratchRows(workspace)).toEqual([]);
    await expect(git.readRef({ ref: "HEAD" })).resolves.toEqual({
      kind: "symbolic",
      target: "refs/heads/onto",
    });
    await expect(git.readRef({ ref: publishRef })).resolves.toEqual({
      kind: "direct",
      oid: snapshot,
    });
    await expect(git.writeTree()).resolves.toBe(expectedTree);
    await expect(git.diff({ ref: restored.commit })).resolves.toBe("");
    expect(beforeFailedPublish.operation).toBeNull();
    expect(beforeFailedPublish.tracker).toEqual({ available: true, baselineTreeOid: ontoTree });
    expect(beforeFailedPublish.trackerDirty.length).toBeGreaterThan(0);

    const coldDatabase = reopenDatabase(workspace);
    const cold = bindGit(workspace, coldDatabase);
    await expect(cold.readRef({ ref: publishRef })).resolves.toEqual({
      kind: "direct",
      oid: snapshot,
    });
    await expect(cold.writeTree()).resolves.toBe(expectedTree);
    expect(controlState(workspace, coldDatabase)).toEqual(beforeFailedPublish);
  });
});
