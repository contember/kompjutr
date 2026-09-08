import { afterEach, describe, expect, it } from "vitest";

import { utf8Decoder } from "../packages/git/src/common/bytes.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import type { GitContext } from "../packages/git/src/ops/core/context.js";
import { cherryPick } from "../packages/git/src/ops/replay/cherry-pick.js";
import {
  revert,
  revertAbort,
  revertContinue,
  revertSkip,
} from "../packages/git/src/ops/replay/revert.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { add, rm } from "../packages/git/src/ops/staging/staging.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const REVERTER = { name: "Reverter", email: "reverter@example.com" };
const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function fixture(): GitFixture {
  const created = new GitFixture().init();
  fixtures.push(created);
  return created;
}

async function imported(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", REVERTER.name);
  workspace.repo.store.configSet("user.email", REVERTER.email);
  return workspace;
}

function reopen(workspace: TestRepository): { context: GitContext; repo: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
    now: workspace.context.now,
  });
  const row = database.findCheckout("/");
  if (row === null) throw new Error("reopened repository is missing");
  return {
    context: { ...workspace.context, database },
    repo: new Repository(database.openCheckout(row)),
  };
}

function textAt(workspace: TestRepository, path: string): string | null {
  if (workspace.worktree.stat(`/${path}`) === null) return null;
  return utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

function recordingBaselineContext(workspace: TestRepository): {
  context: GitContext;
  advances: Array<{ checkoutId: number; tree: string | null }>;
} {
  const advances: Array<{ checkoutId: number; tree: string | null }> = [];
  return {
    context: {
      ...workspace.context,
      indexTracker: {
        reseal: () => true,
        advanceBaseline: (checkoutId, tree) => {
          advances.push({ checkoutId, tree });
          return true;
        },
      },
    },
    advances,
  };
}

function fixtureCommitMessage(source: GitFixture, oid: string): string {
  const commit = utf8Decoder.decode(source.catFile(oid));
  const separator = commit.indexOf("\n\n");
  if (separator < 0) throw new Error("fixture commit has no message separator");
  return commit.slice(separator + 2);
}

describe("revert lifecycle", () => {
  it("creates a one-parent commit with Git's exact default message and two new identities", async () => {
    const source = fixture();
    source.write("tracked.txt", "base\n");
    source.commit("base");
    source.write("tracked.txt", "changed\n");
    source.write(".git/message", "\n  subject   with\ttab  \n\nbody\n");
    source.git("add", "tracked.txt");
    source.git("commit", "-q", "--cleanup=verbatim", "-F", ".git/message");
    const reverted = source.git("rev-parse", "HEAD");
    source.write("later.txt", "later\n");
    const current = source.commit("later");
    const workspace = await imported(source);
    workspace.tick(120_000);
    const recorded = recordingBaselineContext(workspace);

    const result = revert(recorded.context, workspace.repo, workspace.worktree, {
      source: reverted,
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("revert did not commit");
    const commit = workspace.repo.readCommit(result.oid);
    expect(recorded.advances).toEqual([
      { checkoutId: workspace.repo.checkout.checkoutId, tree: commit.tree },
    ]);
    expect(commit.parent).toEqual([current]);
    expect(commit.message).toBe(
      `Revert "  subject   with\ttab  "\n\nThis reverts commit ${reverted}.\n`,
    );
    source.git("revert", "--no-edit", reverted);
    expect(commit.message).toBe(fixtureCommitMessage(source, source.git("rev-parse", "HEAD")));
    expect(commit.author).toEqual({
      ...REVERTER,
      timestamp: 1_577_836_920,
      timezoneOffset: 0,
    });
    expect(commit.committer).toEqual(commit.author);
    expect(textAt(workspace, "tracked.txt")).toBe("base\n");
    expect(textAt(workspace, "later.txt")).toBe("later\n");
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: current,
        newOid: result.oid,
        actor: REVERTER,
        timestamp: commit.committer.timestamp,
        timezoneOffset: commit.committer.timezoneOffset,
        reason: "revert",
      }),
    ]);
    const named = workspace.repo.store.reflog("refs/heads/main")[0];
    const head = workspace.repo.checkout.reflog("HEAD")[0];
    expect(head).toMatchObject({ oldOid: current, newOid: result.oid, reason: "revert" });
    if (named === undefined || head === undefined) throw new Error("revert reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("rolls back a clean revert when publication fails after the ref mutation", async () => {
    const source = fixture();
    source.write("tracked.txt", "base\n");
    source.commit("base");
    source.write("tracked.txt", "changed\n");
    const reverted = source.commit("change");
    source.write("later.txt", "later\n");
    const current = source.commit("later");
    const workspace = await imported(source);
    const beforeObjects = workspace.repo.store.objectCount();
    const originalRun = workspace.repo.store.db.run.bind(workspace.repo.store.db);
    let faultInjected = false;
    workspace.repo.store.db.run = (query, ...bindings) => {
      originalRun(query, ...bindings);
      if (!faultInjected && query.includes("INSERT INTO git_refs")) {
        faultInjected = true;
        expect(
          workspace.repo.store.db.scalar<string>(
            "SELECT target FROM git_refs WHERE repo_id = ? AND name = 'refs/heads/main'",
            workspace.repo.store.repoId,
          ),
        ).not.toBe(current);
        throw new Error("late revert publication fault");
      }
    };

    expect(() =>
      revert(workspace.context, workspace.repo, workspace.worktree, { source: reverted }),
    ).toThrow("late revert publication fault");
    expect(faultInjected).toBe(true);

    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.store.objectCount()).toBe(beforeObjects);
    expect(textAt(workspace, "tracked.txt")).toBe("changed\n");
    expect(textAt(workspace, "later.txt")).toBe("later\n");
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);
  });

  it("reverts a root commit relative to the empty tree", async () => {
    const source = fixture();
    source.write("root.txt", "root\n");
    const root = source.commit("root");
    source.write("later.txt", "later\n");
    const current = source.commit("later");
    const workspace = await imported(source);

    const result = revert(workspace.context, workspace.repo, workspace.worktree, { source: root });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("root revert did not commit");
    expect(workspace.repo.readCommit(result.oid).parent).toEqual([current]);
    expect(textAt(workspace, "root.txt")).toBeNull();
    expect(textAt(workspace, "later.txt")).toBe("later\n");
  });

  it("requires a valid mainline and emits Git's merge-revert message", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("topic.txt", "topic\n");
    source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("main.txt", "main\n");
    source.commit("main");
    source.git("merge", "-q", "--no-ff", "topic", "-m", "merge subject");
    const merge = source.git("rev-parse", "HEAD");
    const selectedParent = source.git("rev-parse", `${merge}^1`);

    const rejectedMainlines: readonly (number | undefined)[] = [undefined, 3];
    for (const mainline of rejectedMainlines) {
      const rejected = await imported(source);
      const before = rejected.repo.head();
      expect(() =>
        revert(rejected.context, rejected.repo, rejected.worktree, {
          source: merge,
          mainline,
        }),
      ).toThrow(expect.objectContaining({ code: "EINVAL" }));
      expect(rejected.repo.head()).toEqual(before);
      expect(rejected.repo.checkout.readOperationState()).toBeNull();
      expect(rejected.repo.store.reflog("refs/heads/main")).toEqual([]);
      expect(rejected.repo.checkout.reflog("HEAD")).toEqual([]);
    }

    const workspace = await imported(source);
    const result = revert(workspace.context, workspace.repo, workspace.worktree, {
      source: merge,
      mainline: 1,
    });
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("merge revert did not commit");
    expect(workspace.repo.readCommit(result.oid).message).toBe(
      `Revert "merge subject"\n\nThis reverts commit ${merge}, reversing\nchanges made to ${selectedParent}.\n`,
    );
    source.git("revert", "--no-edit", "-m", "1", merge);
    expect(workspace.repo.readCommit(result.oid).message).toBe(
      fixtureCommitMessage(source, source.git("rev-parse", "HEAD")),
    );
    expect(textAt(workspace, "topic.txt")).toBeNull();
    expect(textAt(workspace, "main.txt")).toBe("main\n");
  });

  it("treats source-empty and result-empty reverts as terminal", async () => {
    const kinds: readonly ("source" | "result")[] = ["source", "result"];
    for (const kind of kinds) {
      const source = fixture();
      source.write("tracked.txt", "base\n");
      source.commit("base");
      let reverted: string;
      if (kind === "source") {
        source.git("commit", "--allow-empty", "-q", "-m", "empty");
        reverted = source.git("rev-parse", "HEAD");
      } else {
        source.write("tracked.txt", "changed\n");
        reverted = source.commit("change");
        source.write("tracked.txt", "base\n");
        source.commit("already reversed");
      }
      const workspace = await imported(source);
      const before = workspace.repo.head();

      expect(
        revert(workspace.context, workspace.repo, workspace.worktree, { source: reverted }),
      ).toEqual({ outcome: "empty", reason: kind });
      expect(workspace.repo.head()).toEqual(before);
      expect(workspace.repo.checkout.readOperationState()).toBeNull();
      expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
      expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);
      expect(() => revertContinue(workspace.context, workspace.repo)).toThrow(
        expect.objectContaining({ code: "ENOREVERT" }),
      );
    }
  });

  it("writes inverse conflict stages and continues after a cold reopen", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "source\n");
    const reverted = source.commit("source subject");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "current\n");
    const current = source.commit("current");
    const expectedStage1 = source.git("rev-parse", `${reverted}:conflict.txt`);
    const expectedStage2 = source.git("rev-parse", `${current}:conflict.txt`);
    const expectedStage3 = source.git("rev-parse", `${reverted}^:conflict.txt`);
    const workspace = await imported(source);

    expect(
      revert(workspace.context, workspace.repo, workspace.worktree, { source: reverted }),
    ).toEqual({ outcome: "conflicted" });
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.checkout.indexGet("conflict.txt", 1)?.oid).toBe(expectedStage1);
    expect(workspace.repo.checkout.indexGet("conflict.txt", 2)?.oid).toBe(expectedStage2);
    expect(workspace.repo.checkout.indexGet("conflict.txt", 3)?.oid).toBe(expectedStage3);
    expect(textAt(workspace, "conflict.txt")).toContain(
      `>>>>>>> parent of ${reverted.slice(0, 7)} (source subject)`,
    );
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);

    workspace.tick(60_000);
    const cold = reopen(workspace);
    writeWorkFile(workspace, "/conflict.txt", "resolved\n");
    add(cold.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });
    const result = revertContinue(cold.context, cold.repo);
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("revert continuation did not commit");
    const commit = cold.repo.readCommit(result.oid);
    expect(commit.parent).toEqual([current]);
    expect(commit.author).toMatchObject({ ...REVERTER, timestamp: 1_577_836_860 });
    expect(commit.committer).toEqual(commit.author);
    expect(cold.repo.checkout.readOperationState()).toBeNull();
    expect(cold.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: current,
        newOid: result.oid,
        actor: REVERTER,
        timestamp: commit.committer.timestamp,
        timezoneOffset: commit.committer.timezoneOffset,
        reason: "revert",
      }),
    ]);
    const named = cold.repo.store.reflog("refs/heads/main")[0];
    const head = cold.repo.checkout.reflog("HEAD")[0];
    expect(head).toMatchObject({ oldOid: current, newOid: result.oid, reason: "revert" });
    if (named === undefined || head === undefined) throw new Error("revert reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("continues a revert modify/delete conflict after native rm resolution", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("added.txt", "source\n");
    const reverted = source.commit("add file");
    source.git("checkout", "-q", "main");
    source.write("added.txt", "current\n");
    const current = source.commit("independent add");
    const workspace = await imported(source);

    expect(
      revert(workspace.context, workspace.repo, workspace.worktree, { source: reverted }),
    ).toEqual({ outcome: "conflicted" });
    expect(workspace.repo.checkout.indexGet("added.txt", 1)?.oid).toBeDefined();
    expect(workspace.repo.checkout.indexGet("added.txt", 2)?.oid).toBeDefined();
    expect(workspace.repo.checkout.indexGet("added.txt", 3)).toBeNull();
    rm(workspace.repo, workspace.worktree, { paths: ["added.txt"] });
    const result = revertContinue(workspace.context, workspace.repo);
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("delete resolution did not commit");
    const commit = workspace.repo.readCommit(result.oid);
    expect(commit.parent).toEqual([current]);
    expect(workspace.repo.readTree(commit.tree).map((entry) => entry.name)).not.toContain(
      "added.txt",
    );
  });

  it("ends a conflict resolved back to HEAD as a terminal empty revert", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "source\n");
    const reverted = source.commit("source");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "current\n");
    const current = source.commit("current");
    const workspace = await imported(source);
    revert(workspace.context, workspace.repo, workspace.worktree, { source: reverted });

    writeWorkFile(workspace, "/conflict.txt", "current\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });

    expect(revertContinue(workspace.context, workspace.repo)).toEqual({
      outcome: "empty",
      reason: "result",
    });
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.checkout.readOperationState()).toBeNull();
    expect(() => revertContinue(workspace.context, workspace.repo)).toThrow(
      expect.objectContaining({ code: "ENOREVERT" }),
    );
  });

  it("restores owned paths on skip and abort after partial resolution", async () => {
    const actions: readonly ("skip" | "abort")[] = ["skip", "abort"];
    for (const action of actions) {
      const source = fixture();
      source.write("conflict.txt", "base\n");
      source.write("sentinel.txt", "sentinel\n");
      source.commit("base");
      source.git("checkout", "-q", "-b", "topic");
      source.write("conflict.txt", "source\n");
      const reverted = source.commit("source");
      source.git("checkout", "-q", "main");
      source.write("conflict.txt", "current\n");
      const current = source.commit("current");
      const workspace = await imported(source);
      revert(workspace.context, workspace.repo, workspace.worktree, { source: reverted });
      writeWorkFile(workspace, "/conflict.txt", "partial\n");
      add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });
      writeWorkFile(workspace, "/sentinel.txt", "local sentinel\n");
      writeWorkFile(workspace, "/untracked.txt", "untracked\n");

      if (action === "skip") {
        const cold = reopen(workspace);
        revertSkip(cold.repo, workspace.worktree);
        expect(cold.repo.checkout.readOperationState()).toBeNull();
      } else {
        revertAbort(workspace.repo, workspace.worktree);
        expect(workspace.repo.checkout.readOperationState()).toBeNull();
      }
      expect(workspace.repo.head().oid).toBe(current);
      expect(textAt(workspace, "conflict.txt")).toBe("current\n");
      expect(textAt(workspace, "sentinel.txt")).toBe("local sentinel\n");
      expect(textAt(workspace, "untracked.txt")).toBe("untracked\n");
    }
  });

  it("keeps wrong-kind state and reports stable no-active errors", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "topic\n");
    const picked = source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "main\n");
    source.commit("main");
    const workspace = await imported(source);

    for (const invoke of [
      () => revertContinue(workspace.context, workspace.repo),
      () => revertSkip(workspace.repo, workspace.worktree),
      () => revertAbort(workspace.repo, workspace.worktree),
    ]) {
      expect(invoke).toThrow(expect.objectContaining({ code: "ENOREVERT" }));
    }

    cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked });
    for (const invoke of [
      () => revertContinue(workspace.context, workspace.repo),
      () => revertSkip(workspace.repo, workspace.worktree),
      () => revertAbort(workspace.repo, workspace.worktree),
    ]) {
      expect(invoke).toThrow(expect.objectContaining({ code: "EOPMISMATCH" }));
      expect(workspace.repo.checkout.readOperationState()?.kind).toBe("cherry-pick");
    }
  });

  it("rejects staged and touched work while preserving unrelated local changes", async () => {
    const source = fixture();
    source.write("tracked.txt", "base\n");
    source.write("sentinel.txt", "sentinel\n");
    source.commit("base");
    source.write("tracked.txt", "source\n");
    const reverted = source.commit("change");

    const staged = await imported(source);
    writeWorkFile(staged, "/staged.txt", "staged\n");
    add(staged.repo, staged.worktree, { paths: ["staged.txt"], excludeRoots: [] });
    expect(() =>
      revert(staged.context, staged.repo, staged.worktree, { source: reverted }),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));

    const dirty = await imported(source);
    writeWorkFile(dirty, "/tracked.txt", "dirty\n");
    expect(() => revert(dirty.context, dirty.repo, dirty.worktree, { source: reverted })).toThrow(
      expect.objectContaining({ code: "ECHECKOUTFAIL" }),
    );

    const unrelated = await imported(source);
    writeWorkFile(unrelated, "/sentinel.txt", "local sentinel\n");
    writeWorkFile(unrelated, "/untracked.txt", "untracked\n");
    expect(
      revert(unrelated.context, unrelated.repo, unrelated.worktree, { source: reverted }).outcome,
    ).toBe("committed");
    expect(textAt(unrelated, "sentinel.txt")).toBe("local sentinel\n");
    expect(textAt(unrelated, "untracked.txt")).toBe("untracked\n");
  });

  it("restores the original tree after a forward cherry-pick and revert", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const original = source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("picked.txt", "picked\n");
    const picked = source.commit("pick");
    source.git("checkout", "-q", "main");
    const workspace = await imported(source);
    const originalTree = workspace.repo.readCommit(original).tree;

    expect(
      cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }).outcome,
    ).toBe("committed");
    const result = revert(workspace.context, workspace.repo, workspace.worktree, {
      source: picked,
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("round-trip revert did not commit");
    expect(workspace.repo.readCommit(result.oid).tree).toBe(originalTree);
    expect(textAt(workspace, "picked.txt")).toBeNull();
  });
});
