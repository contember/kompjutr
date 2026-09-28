import { afterEach, describe, expect, it } from "vitest";
import { utf8Decoder } from "../packages/git/src/common/bytes.js";
import { hasErrorCode } from "../packages/git/src/common/errors.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import type { GitContext } from "../packages/git/src/ops/core/context.js";
import { rebase, rebaseContinue } from "../packages/git/src/ops/rebase/rebase.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { add } from "../packages/git/src/ops/staging/staging.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

// A proven baseline skips the whole-tree check only inside one synchronous call.
// Every entry point still proves it, so an edit made between calls is refused.

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

async function imported(source: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", "Fixture");
  workspace.repo.store.configSet("user.email", "fixture@example.com");
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

/** The first pick touches shared.txt, conflicting when asked; the second touches later.txt. */
function twoPickHistory(conflict: boolean): {
  source: GitFixture;
  original: string;
  upstream: string;
} {
  const source = new GitFixture().init();
  fixtures.push(source);
  source.write("shared.txt", "base\n");
  source.write("later.txt", "base\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "upstream", base);
  source.write(conflict ? "shared.txt" : "upstream.txt", "upstream\n");
  const upstream = source.commit("upstream");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("shared.txt", "current\n");
  source.commit("conflicting first");
  source.write("later.txt", "later\n");
  const original = source.commit("clean second");
  return { source, original, upstream };
}

function textAt(workspace: TestRepository, path: string): string {
  return utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

function expectRefused(action: () => unknown): void {
  let caught: unknown = null;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(hasErrorCode(caught, "ECHECKOUTFAIL")).toBe(true);
}

describe("rebase baseline proof", () => {
  it("refuses a conflicted continue after an edit to a later pick's path", async () => {
    const { source, original, upstream } = twoPickHistory(true);
    const workspace = await imported(source);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, [], { upstream }),
    ).toMatchObject({ outcome: "conflicted", replayed: 0 });
    writeWorkFile(workspace, "/shared.txt", "resolved\n");
    add(workspace.repo, workspace.worktree, { paths: ["shared.txt"] });
    writeWorkFile(workspace, "/later.txt", "edited between calls\n");

    expectRefused(() => rebaseContinue(workspace.context, workspace.repo, workspace.worktree, []));

    const journal = workspace.repo.checkout.requireOperationState("rebase");
    expect(journal.state).toMatchObject({ phase: "conflicted", currentStep: 0 });
    expect(workspace.repo.head().oid).toBe(original);
    expect(textAt(workspace, "later.txt")).toBe("edited between calls\n");
  });

  it("refuses a running continue after an edit to a later pick's path", async () => {
    const { source, original, upstream } = twoPickHistory(false);
    source.git("rebase", "-q", "upstream");
    const expectedTree = source.git("rev-parse", "HEAD^{tree}");
    source.git("reset", "-q", "--hard", original);
    const workspace = await imported(source);
    let journalWritten = false;
    const originalRun = workspace.repo.store.db.run.bind(workspace.repo.store.db);
    workspace.repo.store.db.run = (query: string, ...bindings: unknown[]) => {
      originalRun(query, ...bindings);
      if (query.includes("INSERT INTO git_operation_state")) journalWritten = true;
    };
    const originalOne = workspace.repo.store.db.one.bind(workspace.repo.store.db);
    workspace.repo.store.db.one = <Row extends object>(query: string, ...bindings: unknown[]) => {
      if (journalWritten && query.includes("FROM git_operation_state")) {
        throw new Error("restart after baseline");
      }
      return originalOne<Row>(query, ...bindings);
    };
    expect(() =>
      rebase(workspace.context, workspace.repo, workspace.worktree, [], { upstream }),
    ).toThrow("restart after baseline");

    const durable = reopen(workspace);
    expect(durable.repo.checkout.requireOperationState("rebase").state).toMatchObject({
      phase: "running",
      currentStep: 0,
    });
    writeWorkFile(workspace, "/later.txt", "edited between calls\n");
    expectRefused(() => rebaseContinue(durable.context, durable.repo, workspace.worktree, []));
    expect(durable.repo.head().oid).toBe(original);

    writeWorkFile(workspace, "/later.txt", "base\n");
    expect(rebaseContinue(durable.context, durable.repo, workspace.worktree, [])).toMatchObject({
      outcome: "completed",
      replayed: 2,
    });
    expect(durable.repo.headTree()).toBe(expectedTree);
  });
});
