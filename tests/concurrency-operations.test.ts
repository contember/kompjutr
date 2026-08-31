import { afterEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../src/git/client.js";
import { checkoutTree } from "../src/git/ops/checkout.js";
import type { GitContext } from "../src/git/ops/context.js";
import type { Repository } from "../src/git/ops/repository.js";
import type { Worktree } from "../src/git/ops/worktree.js";
import type { SqliteGitDatabase } from "../src/git/store/index.js";
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
});
