import { afterEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../src/git/client.js";
import { checkoutTree } from "../src/git/ops/checkout/checkout.js";
import type { GitContext } from "../src/git/ops/core/context.js";
import { recoverRef } from "../src/git/ops/core/ref-log.js";
import { updateRef } from "../src/git/ops/repository/plumbing.js";
import type { Repository } from "../src/git/ops/repository/repository.js";
import type { Worktree } from "../src/git/ops/worktree/worktree.js";
import {
  SqliteGitDatabase,
  withGitMutationGuardOwned,
} from "../src/git/store/database/database.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { assertRepositoryReadable, reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

interface OperationFixture {
  workspace: TestRepository;
  topic: string;
  git: Git;
}

type ActiveKind = "merge" | "cherry-pick" | "revert";
type AttemptKind = "merge" | "cherry-pick" | "revert" | "rebase";

interface PublicGitState {
  database: SqliteGitDatabase;
  worktree: Worktree;
  context: Pick<GitContext, "now" | "timezoneOffset">;
}

function fixture(): GitFixture {
  const source = new GitFixture().init();
  fixtures.push(source);
  return source;
}

async function operationFixture(): Promise<OperationFixture> {
  const source = fixture();
  source.write("conflict.txt", "base\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "topic", base);
  source.write("conflict.txt", "topic\n");
  source.write("topic.txt", "topic\n");
  const topic = source.commit("topic");
  source.git("checkout", "-q", "main");
  source.write("conflict.txt", "main\n");
  source.write("main.txt", "main\n");
  source.commit("main");

  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Concurrency Fixture");
  workspace.repo.store.configSet("user.email", "concurrency@example.com");
  return { workspace, topic, git: publicGit(workspace) };
}

function publicGit(workspace: PublicGitState): Git {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
  });
}

async function startActive(active: ActiveKind, test: OperationFixture): Promise<void> {
  const { git, topic } = test;
  if (active === "merge") {
    await expect(git.merge({ theirs: topic })).resolves.toEqual({
      conflicted: true,
      pendingCommit: true,
    });
    return;
  }
  if (active === "cherry-pick") {
    await expect(git.cherryPick({ source: topic })).resolves.toEqual({ outcome: "conflicted" });
    return;
  }
  await expect(git.revert({ source: topic })).resolves.toEqual({ outcome: "conflicted" });
}

function attemptOperation(attempt: AttemptKind, test: OperationFixture): Promise<unknown> {
  const { git, topic } = test;
  if (attempt === "merge") return git.merge({ theirs: topic });
  if (attempt === "cherry-pick") return git.cherryPick({ source: topic });
  if (attempt === "revert") return git.revert({ source: topic });
  return git.rebase({ upstream: topic });
}

function durableSnapshot(repo: Repository, worktree: Worktree): object {
  return {
    head: repo.head(),
    refs: repo.store.listRefs(),
    index: repo.checkout.indexEntries(),
    journal: repo.checkout.readOperationState(),
    namedReflog: repo.store.reflog("refs/heads/main"),
    headReflog: repo.checkout.reflog("HEAD"),
    worktree: worktree.scan("/", { limit: 32 }).map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      target: entry.target,
      bytes: entry.type === "file" ? worktree.readFile(entry.path) : null,
    })),
  };
}

function moveRefWithoutReflog(repo: Repository, name: string, target: string): void {
  repo.store.db.run(
    "UPDATE git_refs SET target = ? WHERE repo_id = ? AND name = ?",
    target,
    repo.store.repoId,
    name,
  );
}

const compatibilityRows: readonly { active: ActiveKind; attempt: AttemptKind }[] = [
  { active: "merge", attempt: "cherry-pick" },
  { active: "merge", attempt: "revert" },
  { active: "merge", attempt: "rebase" },
  { active: "cherry-pick", attempt: "merge" },
  { active: "cherry-pick", attempt: "cherry-pick" },
  { active: "cherry-pick", attempt: "revert" },
  { active: "cherry-pick", attempt: "rebase" },
  { active: "revert", attempt: "merge" },
  { active: "revert", attempt: "cherry-pick" },
  { active: "revert", attempt: "revert" },
  { active: "revert", attempt: "rebase" },
];
const staleKinds: readonly ActiveKind[] = ["merge", "cherry-pick", "revert"];

describe("local operation concurrency", () => {
  for (const row of compatibilityRows) {
    it(`keeps an active ${row.active} when ${row.attempt} is rejected`, async () => {
      const test = await operationFixture();
      await startActive(row.active, test);
      const before = durableSnapshot(test.workspace.repo, test.workspace.worktree);
      const expectedCode = row.active === "merge" ? "EMERGEACTIVE" : "EOPACTIVE";

      test.workspace.storage.resetCounters();
      await expect(attemptOperation(row.attempt, test)).rejects.toMatchObject({
        code: expectedCode,
      });
      expect(test.workspace.storage.statementCount).toBeLessThan(1_000);
      expect(durableSnapshot(test.workspace.repo, test.workspace.worktree)).toEqual(before);

      const cold = reopenTestRepository(test.workspace);
      expect(cold.worktree).not.toBe(test.workspace.worktree);
      expect(durableSnapshot(cold.repo, cold.worktree)).toEqual(before);
      assertRepositoryReadable(cold.repo);
    });
  }

  for (const active of staleKinds) {
    it(`retains an active ${active} journal when its branch CAS is stale`, async () => {
      const test = await operationFixture();
      const clean = durableSnapshot(test.workspace.repo, test.workspace.worktree);
      await startActive(active, test);
      const journal = test.workspace.repo.checkout.readOperationState();
      if (journal === null) throw new Error("active operation journal is missing");
      const replacement = test.workspace.repo.peel(test.topic);
      moveRefWithoutReflog(test.workspace.repo, journal.state.originalHeadRef, replacement);
      const beforeRejected = durableSnapshot(test.workspace.repo, test.workspace.worktree);

      const invoke = (): Promise<unknown> => {
        if (active === "merge") return test.git.mergeContinue();
        if (active === "cherry-pick") return test.git.cherryPickContinue();
        return test.git.revertContinue();
      };
      test.workspace.storage.resetCounters();
      await expect(invoke()).rejects.toMatchObject({ code: "ESTALEHEAD" });
      expect(test.workspace.storage.statementCount).toBeLessThan(1_000);
      const cold = reopenTestRepository(test.workspace);
      expect(cold.worktree).not.toBe(test.workspace.worktree);
      expect(durableSnapshot(cold.repo, cold.worktree)).toEqual(beforeRejected);
      assertRepositoryReadable(cold.repo);

      moveRefWithoutReflog(cold.repo, journal.state.originalHeadRef, journal.state.originalHeadOid);
      const coldGit = publicGit(cold);
      if (active === "merge") await coldGit.mergeAbort();
      else if (active === "cherry-pick") await coldGit.cherryPickAbort();
      else await coldGit.revertAbort();
      expect(durableSnapshot(cold.repo, cold.worktree)).toEqual(clean);
      await expect(coldGit.status()).resolves.toEqual([]);
      assertRepositoryReadable(cold.repo);
    });
  }

  it("hard reset clears a conflicted revert after a cold reopen", async () => {
    const test = await operationFixture();
    const clean = durableSnapshot(test.workspace.repo, test.workspace.worktree);
    await startActive("revert", test);
    const cold = reopenTestRepository(test.workspace);
    expect(cold.worktree).not.toBe(test.workspace.worktree);

    test.workspace.storage.resetCounters();
    const coldGit = publicGit(cold);
    await coldGit.reset({ hard: true });
    expect(test.workspace.storage.statementCount).toBeLessThan(1_000);
    expect(durableSnapshot(cold.repo, cold.worktree)).toEqual(clean);
    await expect(coldGit.status()).resolves.toEqual([]);
    assertRepositoryReadable(cold.repo);
  });

  it("keeps the outer guard after caught reentry and cleans it on success", async () => {
    const test = await operationFixture();
    const first = test.workspace.database;
    const second = new SqliteGitDatabase(test.workspace.repo.store.db);

    withGitMutationGuardOwned(first, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => withGitMutationGuardOwned(second, () => undefined)).toThrowError(
          expect.objectContaining({ code: "EREENTRANT" }),
        );
        expect(
          test.workspace.repo.store.db.scalar<number>(
            "SELECT count(*) FROM git_meta WHERE key = 'mutation_guard'",
          ),
        ).toBe(1);
      }
    });

    expect(
      test.workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_meta WHERE key = 'mutation_guard'",
      ),
    ).toBe(0);
  });

  it("rejects exported low-level mutations before changing refs", async () => {
    const test = await operationFixture();
    withGitMutationGuardOwned(test.workspace.database, () => {
      expect(() =>
        updateRef(test.workspace.context, test.workspace.repo, {
          ref: "refs/heads/reentrant",
          value: test.topic,
        }),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      expect(() =>
        recoverRef(test.workspace.context, test.workspace.repo, {
          ref: "refs/heads/recovered-reentrant",
          source: { ref: "refs/heads/main", ordinal: 1, endpoint: "new" },
          expectedCurrent: null,
        }),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
    });
    expect(test.workspace.repo.store.getRef("refs/heads/reentrant")).toBeNull();
    expect(test.workspace.repo.store.getRef("refs/heads/recovered-reentrant")).toBeNull();
  });

  it("rejects same-client, second-client, and CLI reentry before mutation", async () => {
    const test = await operationFixture();
    const same = test.git;
    const second = publicGit(test.workspace);
    let sameAttempt: Promise<void> | undefined;
    let secondAttempt: Promise<void> | undefined;
    let cliAttempt: Promise<unknown> | undefined;

    withGitMutationGuardOwned(test.workspace.database, () => {
      sameAttempt = same.branch({ name: "same-reentry", startPoint: test.topic });
      secondAttempt = second.branch({ name: "second-reentry", startPoint: test.topic });
      cliAttempt = same.cli({ argv: ["branch", "cli-reentry"], cwd: "/" });
    });
    if (sameAttempt === undefined || secondAttempt === undefined || cliAttempt === undefined) {
      throw new Error("reentry attempts were not invoked");
    }
    await expect(sameAttempt).rejects.toMatchObject({ code: "EREENTRANT" });
    await expect(secondAttempt).rejects.toMatchObject({ code: "EREENTRANT" });
    await expect(cliAttempt).rejects.toMatchObject({ code: "EREENTRANT" });
    expect(test.workspace.repo.store.getRef("refs/heads/same-reentry")).toBeNull();
    expect(test.workspace.repo.store.getRef("refs/heads/second-reentry")).toBeNull();
    expect(test.workspace.repo.store.getRef("refs/heads/cli-reentry")).toBeNull();
  });

  it("guards exported database, repository, shared-store, and checkout-store facades", async () => {
    const test = await operationFixture();
    const beforeIndex = test.workspace.repo.checkout.indexEntries();
    const beforeObjects = test.workspace.repo.store.objectCount();
    const metadata = {
      actor: null,
      reason: "guard witness",
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
    };
    let initialCallbackCalled = false;
    let applyCallbackCalled = false;

    withGitMutationGuardOwned(test.workspace.database, () => {
      expect(() =>
        test.workspace.database.createRepository("/guarded-nested", "ref: refs/heads/main"),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      expect(() =>
        test.workspace.repo.mutateRefs(
          { puts: [{ name: "refs/heads/facade-reentry", target: test.topic }] },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      expect(() =>
        test.workspace.repo.store.writeObjects((batch) => {
          batch.write("blob", new TextEncoder().encode("shared nested write\n"));
        }),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      const checkoutBatch = test.workspace.repo.checkout.writeBatch({ flushEvery: 1 });
      expect(() =>
        checkoutBatch.write("blob", new TextEncoder().encode("checkout nested write\n")),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      expect(() => test.workspace.repo.store.configSet("guard.reentry", "changed")).toThrowError(
        expect.objectContaining({ code: "EREENTRANT" }),
      );
      expect(() =>
        test.workspace.repo.store.withScratchIndex("facade-reentry", () => undefined),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      expect(() => test.workspace.repo.checkout.indexClear()).toThrowError(
        expect.objectContaining({ code: "EREENTRANT" }),
      );
      expect(() =>
        test.workspace.repo.checkout.tryCreateInitialState(() => {
          initialCallbackCalled = true;
        }),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      expect(() =>
        test.workspace.repo.checkout.indexApply(() => {
          applyCallbackCalled = true;
        }),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
    });

    expect(test.workspace.database.checkoutAt("/guarded-nested")).toBeNull();
    expect(test.workspace.repo.store.getRef("refs/heads/facade-reentry")).toBeNull();
    expect(test.workspace.repo.store.configGet("guard.reentry")).toBeUndefined();
    expect(initialCallbackCalled).toBe(false);
    expect(applyCallbackCalled).toBe(false);
    expect(test.workspace.repo.checkout.indexEntries()).toEqual(beforeIndex);
    expect(test.workspace.repo.store.objectCount()).toBe(beforeObjects);
  });

  it("keeps owned scratch methods usable while public callback reentry rejects", async () => {
    const test = await operationFixture();
    const tree = await test.git.withScratchIndex({ name: "guard-witness" }, (scratch) => {
      expect(() =>
        updateRef(test.workspace.context, test.workspace.repo, {
          ref: "refs/heads/scratch-reentry",
          value: test.topic,
        }),
      ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
      scratch.readTree({ empty: true });
      return scratch.writeTree();
    });

    expect(test.workspace.repo.typeOf(tree)).toBe("tree");
    expect(test.workspace.repo.store.getRef("refs/heads/scratch-reentry")).toBeNull();
  });

  it("rolls back an IndexTrackerWriter callback after two caught reentry attempts", async () => {
    const test = await operationFixture();
    test.workspace.worktree.writeFile("/callback.txt", new TextEncoder().encode("callback\n"));
    await test.git.add({ paths: ["callback.txt"] });
    const before = durableSnapshot(test.workspace.repo, test.workspace.worktree);
    let attempts = 0;
    const callbackFailure = new Error("index tracker callback failure");
    const callbackGit = createGit()({
      database: test.workspace.database,
      worktree: test.workspace.worktree,
      now: test.workspace.context.now,
      timezoneOffset: test.workspace.context.timezoneOffset,
      indexTracker: {
        reseal: () => true,
        advanceBaseline: () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            expect(() =>
              updateRef(test.workspace.context, test.workspace.repo, {
                ref: `refs/heads/callback-reentry-${attempt}`,
                value: test.topic,
              }),
            ).toThrowError(expect.objectContaining({ code: "EREENTRANT" }));
            attempts++;
          }
          throw callbackFailure;
        },
      },
    });

    await expect(callbackGit.commit({ message: "callback rollback" })).rejects.toBe(
      callbackFailure,
    );
    expect(attempts).toBe(2);
    expect(durableSnapshot(test.workspace.repo, test.workspace.worktree)).toEqual(before);
    const cold = reopenTestRepository(test.workspace);
    expect(durableSnapshot(cold.repo, cold.worktree)).toEqual(before);
    expect(test.workspace.repo.store.getRef("refs/heads/callback-reentry-0")).toBeNull();
    expect(test.workspace.repo.store.getRef("refs/heads/callback-reentry-1")).toBeNull();
  });
  it("rolls the guard row back when the outer mutation fails", async () => {
    const test = await operationFixture();
    expect(() =>
      withGitMutationGuardOwned(test.workspace.database, () => {
        throw new Error("outer mutation fault");
      }),
    ).toThrow("outer mutation fault");
    expect(
      test.workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_meta WHERE key = 'mutation_guard'",
      ),
    ).toBe(0);
  });
});
