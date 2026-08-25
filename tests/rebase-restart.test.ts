import { afterEach, describe, expect, it } from "vitest";

import type { GitContext } from "../src/core/context.js";
import { serializeCommit, serializeTree } from "../src/core/objects.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { integrationIndexMatchesTree } from "../src/core/ops/integration-worktree.js";
import { MAX_OPERATION_STEPS } from "../src/core/ops/operation-state.js";
import {
  type RebaseLifecycleResult,
  rebase,
  rebaseAbort,
  rebaseContinue,
  rebaseSkip,
} from "../src/core/ops/rebase.js";
import {
  calculateRebaseBaselineSqlStatements,
  calculateRebaseJournalSqlStatements,
  calculateRebaseTransitionSqlStatements,
} from "../src/core/ops/rebase-lifecycle.js";
import { add } from "../src/core/ops/staging.js";
import { Repository } from "../src/core/repository.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

const PERSON = {
  name: "Rebase Fixture",
  email: "rebase@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function fixture(): GitFixture {
  const created = new GitFixture().init();
  fixtures.push(created);
  return created;
}

async function imported(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/");
  await importFixture(source, workspace.repo.store);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
  return workspace;
}

function reopen(workspace: TestRepository): { context: GitContext; repo: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage));
  const row = database.find("/");
  if (row === null) throw new Error("reopened repository is missing");
  return {
    context: { ...workspace.context, database },
    repo: new Repository(database.open(row), "/"),
  };
}

function history(
  source: GitFixture,
  conflictLast = false,
): {
  upstream: string;
  original: string;
} {
  source.write("shared.txt", "base\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "upstream", base);
  source.write("upstream.txt", "upstream\n");
  if (conflictLast) source.write("shared.txt", "upstream\n");
  const upstream = source.commit("upstream");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("one.txt", "one\n");
  source.commit("one");
  source.write("two.txt", "two\n");
  if (conflictLast) source.write("shared.txt", "current\n");
  const original = source.commit("two");
  return { upstream, original };
}

function objectProjectionCounts(workspace: TestRepository): {
  objects: number;
  commits: number;
  treeSources: number;
  treeEntries: number;
  treeEffective: number;
} {
  const row = workspace.storage.sql
    .exec<{
      objects: number;
      commits: number;
      treeSources: number;
      treeEntries: number;
      treeEffective: number;
    }>(
      `SELECT (SELECT COUNT(*) FROM git_objects) AS objects,
              (SELECT COUNT(*) FROM git_commits) AS commits,
              (SELECT COUNT(*) FROM git_tree_sources) AS treeSources,
              (SELECT COUNT(*) FROM git_tree_entries) AS treeEntries,
              (SELECT COUNT(*) FROM git_tree_effective) AS treeEffective`,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("object projection counts are missing");
  return row;
}

describe("rebase restart recovery", () => {
  it("accepts transition statement 999 and saturates statement 1000", () => {
    expect(calculateRebaseTransitionSqlStatements(800, 100, 99)).toBe(999);
    expect(calculateRebaseTransitionSqlStatements(800, 100, 100)).toBe(1_000);
    expect(
      calculateRebaseJournalSqlStatements(4_096, 1_000, 4 * 1024 * 1024, "replace"),
    ).toBeLessThan(1_000);
    expect(calculateRebaseJournalSqlStatements(4_097, 0, 0, "create")).toBe(1_000);
    expect(calculateRebaseBaselineSqlStatements(4_096, 32 * 1024 * 1024)).toBeLessThan(1_000);
    expect(calculateRebaseBaselineSqlStatements(4_097, 0)).toBe(1_000);
  });

  it("keeps an actual maximum-entry replay transition below 1000 SQL statements", async () => {
    const source = fixture();
    source.write("base.txt", "base\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "upstream", base);
    source.write("upstream.txt", "upstream\n");
    const upstream = source.commit("upstream");
    source.git("checkout", "-q", "-b", "current", base);
    for (let ordinal = 0; ordinal < 999; ordinal++) {
      source.write(`many/${ordinal.toString().padStart(4, "0")}.txt`, `${ordinal}\n`);
    }
    source.commit("maximum integration entries");
    const workspace = await imported(source);
    const originalTransaction = workspace.storage.transactionSync.bind(workspace.storage);
    const transitionStatements: number[] = [];
    workspace.storage.transactionSync = function transactionSync<T>(closure: () => T): T {
      const before = workspace.storage.statementCount;
      return originalTransaction(() => {
        try {
          return closure();
        } finally {
          transitionStatements.push(workspace.storage.statementCount - before);
        }
      });
    };

    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toMatchObject({ outcome: "completed", replayed: 1 });
    expect(transitionStatements.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...transitionStatements)).toBeLessThan(1_000);
  });

  it("preflights the exact maximum replay queue before creating its journal", () => {
    const workspace = makeRepo("/");
    const tree = workspace.repo.store.write("tree", serializeTree([]));
    const base = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: PERSON,
        committer: PERSON,
        message: "base\n",
      }),
    );
    const upstream = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [base],
        author: PERSON,
        committer: PERSON,
        message: "upstream\n",
      }),
    );
    let current = base;
    for (let ordinal = 1; ordinal <= MAX_OPERATION_STEPS; ordinal++) {
      current = workspace.repo.store.write(
        "commit",
        serializeCommit({
          tree,
          parent: [current],
          author: PERSON,
          committer: PERSON,
          message: `current ${ordinal}\n`,
        }),
      );
    }
    workspace.repo.store.setRef("refs/heads/main", current);
    const originalTransaction = workspace.storage.transactionSync.bind(workspace.storage);
    const transitionStatements: number[] = [];
    workspace.storage.transactionSync = function transactionSync<T>(closure: () => T): T {
      const before = workspace.storage.statementCount;
      return originalTransaction(() => {
        try {
          return closure();
        } finally {
          transitionStatements.push(workspace.storage.statementCount - before);
        }
      });
    };
    const originalWrite = workspace.repo.store.writeOperationJournal.bind(workspace.repo.store);
    let reachedJournal = false;
    workspace.repo.store.writeOperationJournal = (state, steps, touched) => {
      expect(steps).toHaveLength(MAX_OPERATION_STEPS);
      reachedJournal = true;
      originalWrite(state, steps, touched);
      throw new Error("maximum replay journal seam");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("maximum replay journal seam");
    expect(reachedJournal).toBe(true);
    expect(Math.max(...transitionStatements)).toBeLessThan(1_000);
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.store.readOperationState()).toBeNull();
  });

  it("rolls the upstream baseline back when initial journal creation fails", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalWrite = workspace.repo.store.writeOperationJournal.bind(workspace.repo.store);
    workspace.repo.store.writeOperationJournal = (state, steps, touched) => {
      originalWrite(state, steps, touched);
      throw new Error("initial journal fault");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("initial journal fault");
    expect(workspace.repo.head().oid).toBe(original);
    expect(workspace.repo.store.readOperationState()).toBeNull();
    expect(
      integrationIndexMatchesTree(workspace.repo, workspace.repo.readCommit(original).tree),
    ).toBe(true);
  });

  it("rolls a fast-forward checkout back when its expected-old ref update is stale", async () => {
    const source = fixture();
    source.write("file.txt", "one\n");
    const first = source.commit("one");
    source.write("file.txt", "two\n");
    const second = source.commit("two");
    source.git("checkout", "-q", "-b", "behind", first);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.store.updateRefExpected.bind(workspace.repo.store);
    workspace.repo.store.updateRefExpected = (name, expectedOid, targetOid) => {
      workspace.repo.store.setRef(name, second);
      originalUpdate(name, expectedOid, targetOid);
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream: second }),
    ).toThrow(/changed|stale/i);
    const durable = reopen(workspace);
    expect(durable.repo.head()).toEqual({ ref: "refs/heads/behind", oid: first });
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(first).tree)).toBe(
      true,
    );
    expect(durable.repo.store.readOperationState()).toBeNull();
  });

  it("rolls conflict files and stages back when journal suspension fails", async () => {
    const source = fixture();
    const { original, upstream } = history(source, true);
    const workspace = await imported(source);
    const originalReplace = workspace.repo.store.replaceOperationJournal.bind(workspace.repo.store);
    workspace.repo.store.replaceOperationJournal = (integrity, state, steps, touched) => {
      originalReplace(integrity, state, steps, touched);
      if (state.phase === "conflicted") throw new Error("conflict journal fault");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("conflict journal fault");
    const durable = reopen(workspace);
    const journal = durable.repo.store.requireOperationState("rebase");
    expect(journal.state).toMatchObject({ phase: "running", currentStep: 1 });
    expect(journal.touched).toEqual([]);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.store.hasConflicts()).toBe(false);
  });

  it("rolls a hard skip checkout back when its cursor transition fails", async () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    writeWorkFile(workspace, "/one.txt", "conflict-time staged edit\n");
    add(workspace.repo, workspace.worktree, { paths: ["one.txt"] });
    const before = workspace.repo.store.requireOperationState("rebase");
    const originalReplace = workspace.repo.store.replaceOperationJournal.bind(workspace.repo.store);
    workspace.repo.store.replaceOperationJournal = (integrity, state, steps, touched) => {
      originalReplace(integrity, state, steps, touched);
      if (state.phase === "running") throw new Error("skip cursor fault");
    };

    expect(() => rebaseSkip(workspace.context, workspace.repo, workspace.worktree)).toThrow(
      "skip cursor fault",
    );
    const durable = reopen(workspace);
    const after = durable.repo.store.requireOperationState("rebase");
    expect(after.integrityOid).toBe(before.integrityOid);
    expect(after.state).toMatchObject({
      phase: "conflicted",
      currentStep: before.state.currentStep,
    });
    expect(workspace.worktree.readFile("/one.txt")).toEqual(
      new TextEncoder().encode("conflict-time staged edit\n"),
    );
  });

  it("rolls a hard abort checkout back when journal clearing fails", async () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    writeWorkFile(workspace, "/one.txt", "abort-time edit\n");
    const before = workspace.repo.store.requireOperationState("rebase");
    const originalClear = workspace.repo.store.clearOperationState.bind(workspace.repo.store);
    workspace.repo.store.clearOperationState = () => {
      originalClear();
      throw new Error("abort clear fault");
    };

    expect(() => rebaseAbort(workspace.repo, workspace.worktree)).toThrow("abort clear fault");
    const durable = reopen(workspace);
    expect(durable.repo.store.requireOperationState("rebase").integrityOid).toBe(
      before.integrityOid,
    );
    expect(workspace.worktree.readFile("/one.txt")).toEqual(
      new TextEncoder().encode("abort-time edit\n"),
    );
  });

  it("rolls a clean unpublished commit back when its cursor transition fails", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const projectionsBefore = objectProjectionCounts(workspace);
    const originalReplace = workspace.repo.store.replaceOperationJournal.bind(workspace.repo.store);
    workspace.repo.store.replaceOperationJournal = (integrity, state, steps, touched) => {
      originalReplace(integrity, state, steps, touched);
      if (state.phase === "running" && state.currentStep === 1) {
        throw new Error("clean cursor fault");
      }
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("clean cursor fault");
    const durable = reopen(workspace);
    const journal = durable.repo.store.requireOperationState("rebase");
    expect(journal.state).toMatchObject({
      phase: "running",
      currentStep: 0,
      currentParentOid: upstream,
    });
    expect(journal.steps.every((step) => step.outcome === "pending")).toBe(true);
    expect(durable.repo.head().oid).toBe(original);
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(upstream).tree)).toBe(
      true,
    );
    expect(objectProjectionCounts(workspace)).toEqual(projectionsBefore);
  });

  it("resumes after the initial upstream baseline and journal commit", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalRead = workspace.repo.store.readOperationState.bind(workspace.repo.store);
    let journalWritten = false;
    const originalWrite = workspace.repo.store.writeOperationJournal.bind(workspace.repo.store);
    workspace.repo.store.writeOperationJournal = (state, steps, touched) => {
      originalWrite(state, steps, touched);
      journalWritten = true;
    };
    workspace.repo.store.readOperationState = () => {
      if (journalWritten) throw new Error("restart after baseline");
      return originalRead();
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart after baseline");
    const durable = reopen(workspace);
    const journal = durable.repo.store.requireOperationState("rebase");
    expect(journal.state).toMatchObject({
      phase: "running",
      currentStep: 0,
      currentParentOid: upstream,
      originalHeadOid: original,
    });
    expect(durable.repo.head().oid).toBe(original);
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(upstream).tree)).toBe(
      true,
    );

    const result = rebaseContinue(durable.context, durable.repo, workspace.worktree);
    expect(result.outcome).toBe("completed");
    expect(durable.repo.store.readOperationState()).toBeNull();
  });

  it("aborts a cold running baseline back to original HEAD", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalRead = workspace.repo.store.readOperationState.bind(workspace.repo.store);
    let journalWritten = false;
    const originalWrite = workspace.repo.store.writeOperationJournal.bind(workspace.repo.store);
    workspace.repo.store.writeOperationJournal = (state, steps, touched) => {
      originalWrite(state, steps, touched);
      journalWritten = true;
    };
    workspace.repo.store.readOperationState = () => {
      if (journalWritten) throw new Error("restart at running baseline");
      return originalRead();
    };
    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart at running baseline");

    const durable = reopen(workspace);
    rebaseAbort(durable.repo, workspace.worktree);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.store.readOperationState()).toBeNull();
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(original).tree)).toBe(
      true,
    );
  });

  it("resumes a cold conflict after a clean applied step and ignores a moved upstream ref", async () => {
    const source = fixture();
    const { original } = history(source, true);
    const workspace = await imported(source);

    const suspended = rebase(workspace.context, workspace.repo, workspace.worktree, {
      upstream: "upstream",
    });
    expect(suspended).toMatchObject({ outcome: "conflicted", replayed: 1 });
    const journal = workspace.repo.store.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(1);
    workspace.repo.store.setRef("refs/heads/upstream", original);

    const durable = reopen(workspace);
    writeWorkFile(workspace, "/shared.txt", "cold resolution\n");
    add(durable.repo, workspace.worktree, { paths: ["shared.txt"] });
    const result = rebaseContinue(durable.context, durable.repo, workspace.worktree);

    expect(result).toMatchObject({ outcome: "completed", replayed: 2 });
    expect(durable.repo.store.readOperationState()).toBeNull();
  });

  it("retains the completed journal when final publication fails, then publishes after reopen", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.store.updateRefExpected.bind(workspace.repo.store);
    workspace.repo.store.updateRefExpected = (name, expectedOid, targetOid) => {
      originalUpdate(name, expectedOid, targetOid);
      throw new Error("restart before publication");
    };

    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart before publication");
    const durable = reopen(workspace);
    const journal = durable.repo.store.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(journal.steps.length);
    expect(durable.repo.head().oid).toBe(original);

    const result: RebaseLifecycleResult = rebaseContinue(
      durable.context,
      durable.repo,
      workspace.worktree,
    );
    expect(result).toMatchObject({ outcome: "completed", replayed: 2 });
    if (result.outcome !== "completed") throw new Error("rebase did not complete");
    expect(durable.repo.head().oid).toBe(result.oid);
    expect(durable.repo.store.readOperationState()).toBeNull();
  });

  it("aborts a cold completed pre-publication journal back to original HEAD", async () => {
    const source = fixture();
    const { original, upstream } = history(source);
    const workspace = await imported(source);
    const originalUpdate = workspace.repo.store.updateRefExpected.bind(workspace.repo.store);
    workspace.repo.store.updateRefExpected = (name, expectedOid, targetOid) => {
      originalUpdate(name, expectedOid, targetOid);
      throw new Error("restart before completed abort");
    };
    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }),
    ).toThrow("restart before completed abort");

    const durable = reopen(workspace);
    const journal = durable.repo.store.requireOperationState("rebase");
    expect(journal.state.currentStep).toBe(journal.steps.length);
    rebaseAbort(durable.repo, workspace.worktree);
    expect(durable.repo.head().oid).toBe(original);
    expect(durable.repo.store.readOperationState()).toBeNull();
    expect(integrationIndexMatchesTree(durable.repo, durable.repo.readCommit(original).tree)).toBe(
      true,
    );
  });

  it("rejects a stale checked-out branch without clearing recovery state", async () => {
    const source = fixture();
    const { upstream } = history(source, true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, { upstream }).outcome,
    ).toBe("conflicted");
    const journal = workspace.repo.store.requireOperationState("rebase");
    workspace.repo.store.setRef(journal.state.originalHeadRef, upstream);

    expect(() =>
      rebaseContinue(workspace.context, workspace.repo, workspace.worktree),
    ).toThrowError("HEAD changed during the rebase operation");
    expect(workspace.repo.store.requireOperationState("rebase").integrityOid).toBe(
      journal.integrityOid,
    );
  });
});
