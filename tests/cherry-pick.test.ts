import { afterEach, describe, expect, it } from "vitest";

import { utf8Decoder } from "../src/core/bytes.js";
import type { GitContext } from "../src/core/context.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import {
  cherryPick,
  cherryPickAbort,
  cherryPickContinue,
  cherryPickSkip,
} from "../src/core/ops/cherry-pick.js";
import { restoreProjectedOperation } from "../src/core/ops/merge-apply.js";
import { calculateReplayRecoverySqlStatements } from "../src/core/ops/replay-lifecycle.js";
import { add, rm } from "../src/core/ops/staging.js";
import { Repository } from "../src/core/repository.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };
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
  await importFixture(source, workspace.repo.store);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  return workspace;
}

function reopen(workspace: TestRepository): { context: GitContext; repo: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
    now: workspace.context.now,
  });
  const row = database.find("/");
  if (row === null) throw new Error("reopened repository is missing");
  return {
    context: { ...workspace.context, database },
    repo: new Repository(database.open(row), "/"),
  };
}

function textAt(workspace: TestRepository, path: string): string | null {
  if (workspace.worktree.stat(`/${path}`) === null) return null;
  return utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

function durableSnapshot(workspace: TestRepository): {
  head: ReturnType<Repository["head"]>;
  objects: number;
  state: ReturnType<Repository["store"]["readOperationState"]>;
  index: ReturnType<Repository["store"]["indexGet"]>[];
  conflict: string | null;
  reflogEntries: number;
  reflogOrdinal: number;
} {
  const row = workspace.storage.sql
    .exec<{ count: number }>("SELECT COUNT(*) AS count FROM git_objects")
    .toArray()[0];
  if (row === undefined) throw new Error("object count is missing");
  return {
    head: workspace.repo.head(),
    objects: row.count,
    state: workspace.repo.store.readOperationState(),
    index: [
      workspace.repo.store.indexGet("conflict.txt", 0),
      workspace.repo.store.indexGet("conflict.txt", 1),
      workspace.repo.store.indexGet("conflict.txt", 2),
      workspace.repo.store.indexGet("conflict.txt", 3),
    ],
    conflict: textAt(workspace, "conflict.txt"),
    reflogEntries:
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ) ?? -1,
    reflogOrdinal:
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ) ?? -1,
  };
}

describe("cherry-pick lifecycle", () => {
  it("accepts recovery statement 999 and saturates statement 1000", () => {
    expect(calculateReplayRecoverySqlStatements(900, 99)).toBe(999);
    expect(calculateReplayRecoverySqlStatements(900, 100)).toBe(1_000);
  });

  it("rolls back every conflicted replay write class", async () => {
    const faultClasses: readonly ("snapshot" | "content" | "worktree" | "index" | "journal")[] = [
      "snapshot",
      "content",
      "worktree",
      "index",
      "journal",
    ];
    for (const fault of faultClasses) {
      const source = fixture();
      source.write("conflict.txt", "base\n");
      source.commit("base");
      source.git("checkout", "-q", "-b", "topic");
      source.write("conflict.txt", "incoming\n");
      const picked = source.commit("topic");
      source.git("checkout", "-q", "main");
      source.write("conflict.txt", "current\n");
      source.commit("main");
      const workspace = await imported(source);
      const before = durableSnapshot(workspace);
      let objectWrites = 0;
      if (fault === "snapshot" || fault === "content") {
        const original = workspace.repo.store.writeObjects.bind(workspace.repo.store);
        workspace.repo.store.writeObjects = (body, options) => {
          const result = original(body, options);
          objectWrites++;
          if (objectWrites === (fault === "snapshot" ? 1 : 2)) throw new Error(`fault ${fault}`);
          return result;
        };
      }
      if (fault === "worktree") {
        const original = workspace.worktree.writeFiles.bind(workspace.worktree);
        workspace.worktree.writeFiles = (entries, options) => {
          original(entries, options);
          throw new Error("fault worktree");
        };
      }
      if (fault === "index") {
        const original = workspace.repo.store.indexApply.bind(workspace.repo.store);
        workspace.repo.store.indexApply = (body, options) => {
          original(body, options);
          throw new Error("fault index");
        };
      }
      if (fault === "journal") {
        const original = workspace.repo.store.writeOperationState.bind(workspace.repo.store);
        workspace.repo.store.writeOperationState = (state, touched) => {
          original(state, touched);
          throw new Error("fault journal");
        };
      }

      expect(() =>
        cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }),
      ).toThrow(`fault ${fault}`);
      expect(durableSnapshot(workspace)).toEqual(before);
    }
  });

  it("rolls back commit-object and ref write failures", async () => {
    const faultClasses: readonly ("commit" | "ref")[] = ["commit", "ref"];
    for (const fault of faultClasses) {
      const source = fixture();
      source.write("base.txt", "base\n");
      source.commit("base");
      source.git("checkout", "-q", "-b", "topic");
      source.write("picked.txt", "picked\n");
      const picked = source.commit("topic");
      source.git("checkout", "-q", "main");
      const workspace = await imported(source);
      const before = durableSnapshot(workspace);
      if (fault === "commit") {
        const original = workspace.repo.store.writeObjects.bind(workspace.repo.store);
        let calls = 0;
        workspace.repo.store.writeObjects = (body, options) => {
          const result = original(body, options);
          calls++;
          if (calls === 2) throw new Error("fault commit");
          return result;
        };
      } else {
        const original = workspace.repo.store.mutateRefs.bind(workspace.repo.store);
        workspace.repo.store.mutateRefs = (mutation, metadata) => {
          original(mutation, metadata);
          throw new Error("fault ref");
        };
      }

      expect(() =>
        cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }),
      ).toThrow(`fault ${fault}`);
      expect(durableSnapshot(workspace)).toEqual(before);
    }
  });

  it("creates a one-parent commit with the exact source author and a new committer", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("picked.txt", "picked\n");
    const picked = source.commit("pick this");
    source.git("checkout", "-q", "main");
    const workspace = await imported(source);
    workspace.tick(60_000);

    const result = cherryPick(workspace.context, workspace.repo, workspace.worktree, {
      source: picked,
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("cherry-pick did not commit");
    const commit = workspace.repo.readCommit(result.oid);
    const original = workspace.repo.readCommit(picked);
    expect(commit.parent).toEqual([base]);
    expect(commit.author).toEqual(original.author);
    expect(commit.committer.timestamp).toBe(original.committer.timestamp + 60);
    expect(commit.message).toBe(original.message);
    expect(textAt(workspace, "picked.txt")).toBe("picked\n");
    expect(workspace.repo.store.readOperationState()).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: base,
        newOid: result.oid,
        actor: IDENTITY,
        timestamp: commit.committer.timestamp,
        timezoneOffset: commit.committer.timezoneOffset,
        reason: "cherry-pick",
      }),
    ]);
    const named = workspace.repo.store.reflog("refs/heads/main")[0];
    const head = workspace.repo.store.reflog("HEAD")[0];
    expect(head).toMatchObject({ oldOid: base, newOid: result.oid, reason: "cherry-pick" });
    if (named === undefined || head === undefined) throw new Error("cherry-pick reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("applies a root commit relative to the empty tree", async () => {
    const source = fixture();
    source.write("root.txt", "root\n");
    const root = source.commit("root source");
    source.git("checkout", "-q", "--orphan", "destination");
    source.git("rm", "-q", "-rf", ".");
    source.write("destination.txt", "destination\n");
    const destination = source.commit("destination");
    const workspace = await imported(source);

    const result = cherryPick(workspace.context, workspace.repo, workspace.worktree, {
      source: root,
    });

    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("root cherry-pick did not commit");
    expect(workspace.repo.readCommit(result.oid).parent).toEqual([destination]);
    expect(textAt(workspace, "root.txt")).toBe("root\n");
    expect(textAt(workspace, "destination.txt")).toBe("destination\n");
  });

  it("suspends source-empty and result-empty picks across reopen", async () => {
    const kinds: readonly ("source" | "result")[] = ["source", "result"];
    for (const kind of kinds) {
      const source = fixture();
      source.write("base.txt", "base\n");
      const base = source.commit("base");
      source.git("checkout", "-q", "-b", "topic");
      let picked: string;
      if (kind === "source") {
        source.git("commit", "--allow-empty", "-m", "empty");
        picked = source.git("rev-parse", "HEAD");
      } else {
        source.write("present.txt", "present\n");
        picked = source.commit("add present");
      }
      source.git("checkout", "-q", "main");
      if (kind === "result") {
        source.write("present.txt", "present\n");
        source.commit("already present");
      }
      const workspace = await imported(source);

      expect(
        cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }),
      ).toEqual({
        outcome: "empty",
        reason: kind,
      });
      expect(workspace.repo.head().oid).not.toBeNull();
      const cold = reopen(workspace);
      expect(cold.repo.store.requireOperationState("cherry-pick").state).toMatchObject({
        phase: "empty",
        emptyReason: kind,
        sourceOid: picked,
      });
      expect(cherryPickContinue(cold.context, cold.repo)).toEqual({
        outcome: "empty",
        reason: kind,
      });
      cherryPickSkip(cold.repo, workspace.worktree);
      expect(cold.repo.store.readOperationState()).toBeNull();
      expect(cold.repo.has(base)).toBe(true);
      expect(cold.repo.store.reflog("refs/heads/main")).toEqual([]);
      expect(cold.repo.store.reflog("HEAD")).toEqual([]);
    }
  });

  it("persists exact conflict stages and continues after a cold reopen", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "incoming\n");
    const picked = source.commit("topic subject");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "current\n");
    const current = source.commit("main");
    const workspace = await imported(source);

    expect(
      cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }),
    ).toEqual({
      outcome: "conflicted",
    });
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.store.indexGet("conflict.txt", 1)?.oid).toBeDefined();
    expect(workspace.repo.store.indexGet("conflict.txt", 2)?.oid).toBeDefined();
    expect(workspace.repo.store.indexGet("conflict.txt", 3)?.oid).toBeDefined();
    expect(textAt(workspace, "conflict.txt")).toContain(
      `>>>>>>> ${picked.slice(0, 7)} (topic subject)`,
    );
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.store.reflog("HEAD")).toEqual([]);

    workspace.tick(60_000);
    const cold = reopen(workspace);
    writeWorkFile(workspace, "/conflict.txt", "resolved\n");
    add(cold.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });
    const result = cherryPickContinue(cold.context, cold.repo);
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("continuation did not commit");
    const commit = cold.repo.readCommit(result.oid);
    const original = cold.repo.readCommit(picked);
    expect(commit.parent).toEqual([current]);
    expect(commit.author).toEqual(original.author);
    expect(commit.message).toBe(original.message);
    expect(commit.committer).toMatchObject({
      name: IDENTITY.name,
      email: IDENTITY.email,
      timestamp: original.committer.timestamp + 60,
      timezoneOffset: workspace.context.timezoneOffset(),
    });
    expect(cold.repo.store.readOperationState()).toBeNull();
    expect(cold.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: current,
        newOid: result.oid,
        actor: IDENTITY,
        timestamp: commit.committer.timestamp,
        timezoneOffset: commit.committer.timezoneOffset,
        reason: "cherry-pick",
      }),
    ]);
    const named = cold.repo.store.reflog("refs/heads/main")[0];
    const head = cold.repo.store.reflog("HEAD")[0];
    expect(head).toMatchObject({ oldOid: current, newOid: result.oid, reason: "cherry-pick" });
    if (named === undefined || head === undefined) throw new Error("cherry-pick reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("continues a modify/delete conflict after native rm resolution", async () => {
    const source = fixture();
    source.write("deleted.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.remove("deleted.txt");
    const picked = source.commit("delete file");
    source.git("checkout", "-q", "main");
    source.write("deleted.txt", "current\n");
    const current = source.commit("keep modified");
    const workspace = await imported(source);

    expect(
      cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }),
    ).toEqual({ outcome: "conflicted" });
    rm(workspace.repo, workspace.worktree, { paths: ["deleted.txt"] });
    const result = cherryPickContinue(workspace.context, workspace.repo);
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error("delete resolution did not commit");
    const commit = workspace.repo.readCommit(result.oid);
    expect(commit.parent).toEqual([current]);
    expect(workspace.repo.readTree(commit.tree).map((entry) => entry.name)).not.toContain(
      "deleted.txt",
    );
  });

  it("turns a resolved-to-HEAD conflict into durable empty state", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "incoming\n");
    const picked = source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "current\n");
    const current = source.commit("main");
    const workspace = await imported(source);
    cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked });

    writeWorkFile(workspace, "/conflict.txt", "current\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });
    expect(cherryPickContinue(workspace.context, workspace.repo)).toEqual({
      outcome: "empty",
      reason: "result",
    });
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.store.requireOperationState("cherry-pick").state.phase).toBe("empty");
    cherryPickAbort(workspace.repo, workspace.worktree);
    expect(workspace.repo.store.readOperationState()).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.store.reflog("HEAD")).toEqual([]);
  });

  it("restores owned paths on abort after partial resolution and preserves unrelated paths", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.write("sentinel.txt", "sentinel\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "incoming\n");
    const picked = source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "current\n");
    const current = source.commit("main");
    const workspace = await imported(source);
    cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked });
    writeWorkFile(workspace, "/conflict.txt", "partial resolution\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });
    writeWorkFile(workspace, "/sentinel.txt", "local sentinel\n");
    writeWorkFile(workspace, "/untracked.txt", "untracked\n");

    const beforeRejectedRestore = durableSnapshot(workspace);
    const journal = workspace.repo.store.requireOperationState("cherry-pick");
    expect(() =>
      workspace.repo.store.db.transactionSync(() =>
        restoreProjectedOperation(workspace.repo, workspace.worktree, journal, {
          priorSqlStatements: 999,
          clearState: true,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(durableSnapshot(workspace)).toEqual(beforeRejectedRestore);

    cherryPickAbort(workspace.repo, workspace.worktree);

    expect(workspace.repo.head().oid).toBe(current);
    expect(textAt(workspace, "conflict.txt")).toBe("current\n");
    expect(textAt(workspace, "sentinel.txt")).toBe("local sentinel\n");
    expect(textAt(workspace, "untracked.txt")).toBe("untracked\n");
    expect(workspace.repo.store.readOperationState()).toBeNull();
  });

  it("restores owned paths on skip after partial resolution and a cold reopen", async () => {
    const source = fixture();
    source.write("conflict.txt", "base\n");
    source.write("sentinel.txt", "sentinel\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("conflict.txt", "incoming\n");
    const picked = source.commit("topic");
    source.git("checkout", "-q", "main");
    source.write("conflict.txt", "current\n");
    const current = source.commit("main");
    const workspace = await imported(source);
    cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked });
    writeWorkFile(workspace, "/conflict.txt", "partial resolution\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"], excludeRoots: [] });
    writeWorkFile(workspace, "/sentinel.txt", "local sentinel\n");
    writeWorkFile(workspace, "/untracked.txt", "untracked\n");

    const cold = reopen(workspace);
    cherryPickSkip(cold.repo, workspace.worktree);

    expect(cold.repo.head().oid).toBe(current);
    expect(textAt(workspace, "conflict.txt")).toBe("current\n");
    expect(textAt(workspace, "sentinel.txt")).toBe("local sentinel\n");
    expect(textAt(workspace, "untracked.txt")).toBe("untracked\n");
    expect(cold.repo.store.indexGet("conflict.txt", 0)?.oid).toBeDefined();
    expect(cold.repo.store.hasConflicts()).toBe(false);
    expect(cold.repo.store.readOperationState()).toBeNull();
  });

  it("rejects staged and touched dirty state while preserving unrelated work", async () => {
    const source = fixture();
    source.write("tracked.txt", "base\n");
    source.write("sentinel.txt", "sentinel\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("tracked.txt", "picked\n");
    source.write("new.txt", "new\n");
    const picked = source.commit("topic");
    source.git("checkout", "-q", "main");

    const staged = await imported(source);
    writeWorkFile(staged, "/staged.txt", "staged\n");
    add(staged.repo, staged.worktree, { paths: ["staged.txt"], excludeRoots: [] });
    expect(() =>
      cherryPick(staged.context, staged.repo, staged.worktree, { source: picked }),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));

    const dirty = await imported(source);
    writeWorkFile(dirty, "/tracked.txt", "dirty\n");
    expect(() => cherryPick(dirty.context, dirty.repo, dirty.worktree, { source: picked })).toThrow(
      expect.objectContaining({ code: "ECHECKOUTFAIL" }),
    );

    const untracked = await imported(source);
    writeWorkFile(untracked, "/new.txt", "local untracked\n");
    expect(() =>
      cherryPick(untracked.context, untracked.repo, untracked.worktree, { source: picked }),
    ).toThrow(expect.objectContaining({ code: "ECHECKOUTFAIL" }));

    const unrelated = await imported(source);
    writeWorkFile(unrelated, "/sentinel.txt", "local sentinel\n");
    writeWorkFile(unrelated, "/untracked.txt", "untracked\n");
    expect(
      cherryPick(unrelated.context, unrelated.repo, unrelated.worktree, { source: picked }).outcome,
    ).toBe("committed");
    expect(textAt(unrelated, "sentinel.txt")).toBe("local sentinel\n");
    expect(textAt(unrelated, "untracked.txt")).toBe("untracked\n");
  });

  it("rejects detached, unborn, and non-branch symbolic HEAD without mutation", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    source.commit("base");
    source.git("checkout", "-q", "-b", "topic");
    source.write("picked.txt", "picked\n");
    const picked = source.commit("pick");
    source.git("checkout", "-q", "main");

    const kinds: readonly ("detached" | "unborn" | "tag")[] = ["detached", "unborn", "tag"];
    for (const kind of kinds) {
      const workspace = await imported(source);
      const oid = workspace.repo.head().oid;
      if (oid === null) throw new Error("fixture HEAD is missing");
      if (kind === "detached") workspace.repo.store.setHead(oid);
      if (kind === "unborn") workspace.repo.store.setHead("ref: refs/heads/unborn");
      if (kind === "tag") {
        workspace.repo.store.setRef("refs/tags/current", oid);
        workspace.repo.store.setHead("ref: refs/tags/current");
      }
      const before = {
        head: workspace.repo.head(),
        index: [...workspace.repo.store.indexScan()],
        state: workspace.repo.store.readOperationState(),
        base: textAt(workspace, "base.txt"),
        picked: textAt(workspace, "picked.txt"),
      };

      expect(() =>
        cherryPick(workspace.context, workspace.repo, workspace.worktree, { source: picked }),
      ).toThrow(
        expect.objectContaining({
          code: kind === "detached" ? "EDETACHED" : kind === "unborn" ? "ENOCOMMIT" : "EWRONGHEAD",
        }),
      );
      expect({
        head: workspace.repo.head(),
        index: [...workspace.repo.store.indexScan()],
        state: workspace.repo.store.readOperationState(),
        base: textAt(workspace, "base.txt"),
        picked: textAt(workspace, "picked.txt"),
      }).toEqual(before);
    }
  });
});
