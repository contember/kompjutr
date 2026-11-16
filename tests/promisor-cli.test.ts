import { describe, expect, it } from "vitest";
import {
  expectCleanAt,
  expectHydratedExactly,
  type Harness,
  IDENTITY,
  nativeMergeTree,
  partialClone,
  repositoryState,
  stopRebaseWithResolvedConflict,
} from "./helpers/promisor.js";

const ENV = {
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
};

function cli(h: Harness, ...argv: string[]) {
  return h.git.runCli({ argv, cwd: "/work", env: ENV });
}

/** Native Git's tree after rebasing stack onto main with the same resolution. */
function nativeResolvedRebase(h: Harness, then: "continue" | "skip"): string {
  h.fixture.git("checkout", "-q", "-b", "expected", "stack");
  expect(h.fixture.gitResult("rebase", "main").status).not.toBe(0);
  if (then === "continue") {
    h.fixture.write("shared.txt", "AS\nb\nc\nd\ne\n");
    h.fixture.git("add", "shared.txt");
  }
  h.fixture.gitWithEnv({ GIT_EDITOR: "true" }, "rebase", `--${then}`);
  return h.fixture.git("rev-parse", "HEAD^{tree}");
}

describe("git CLI writes in a blobless clone hydrate promised blobs", () => {
  it("rebase --continue reads a promised base in its next step", async () => {
    const h = await partialClone();
    await stopRebaseWithResolvedConflict(h);
    const postsBefore = h.posts();

    expect(await cli(h, "rebase", "--continue")).toMatchObject({ exitCode: 0 });

    await expectCleanAt(h, "/work", nativeResolvedRebase(h, "continue"));
    expect(h.posts() - postsBefore).toBe(1);
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old", "stackShared", "stackNotes"]);
  });

  it("rebase --skip reads a promised base in its next step", async () => {
    const h = await partialClone();
    await stopRebaseWithResolvedConflict(h);

    expect(await cli(h, "rebase", "--skip")).toMatchObject({ exitCode: 0 });

    await expectCleanAt(h, "/work", nativeResolvedRebase(h, "skip"));
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old", "stackShared", "stackNotes"]);
  });

  it("rebase --abort restores the original branch", async () => {
    const h = await partialClone();
    await stopRebaseWithResolvedConflict(h);

    expect(await cli(h, "rebase", "--abort")).toMatchObject({ exitCode: 0 });

    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", "stack^{tree}"));
    expect(() => h.repo.checkout.requireNoOperationState()).not.toThrow();
  });

  it("rebase starts onto a promised upstream", async () => {
    const h = await partialClone();

    expect(await cli(h, "rebase", "origin/topic")).toMatchObject({ exitCode: 0 });

    await expectCleanAt(h, "/work", nativeMergeTree(h, h.base, "topic", "main"));
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old", "topicShared", "topicFile"]);
  });

  it("reset --hard moves to a promised commit in one hydration request", async () => {
    const h = await partialClone();
    const postsBefore = h.posts();

    expect(await cli(h, "reset", "--hard", h.base)).toMatchObject({ exitCode: 0 });

    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", `${h.base}^{tree}`));
    expect(h.posts() - postsBefore).toBe(1);
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old"]);
  });

  it("merge --abort and --continue finish a merge stopped on a conflict", async () => {
    const h = await partialClone();
    const merged = await h.git.merge({
      dir: "/work",
      theirs: "origin/stack",
      author: IDENTITY,
      committer: IDENTITY,
    });
    expect(merged.conflicted).toBeDefined();

    expect(await cli(h, "merge", "--abort")).toMatchObject({ exitCode: 0 });
    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", "main^{tree}"));

    await h.git.merge({
      dir: "/work",
      theirs: "origin/stack",
      author: IDENTITY,
      committer: IDENTITY,
    });
    h.workspace.worktree.writeFile(
      "/work/shared.txt",
      new TextEncoder().encode("AS\nb\nc\nd\ne\n"),
    );
    expect(await cli(h, "add", "shared.txt")).toMatchObject({ exitCode: 0 });
    expect(await cli(h, "merge", "--continue")).toMatchObject({ exitCode: 0 });
    expect(await h.git.status({ dir: "/work" })).toEqual([]);
  });

  it("checks out and restores a promised path", async () => {
    const h = await partialClone();

    expect(await cli(h, "checkout", "origin/topic", "--", "topic.txt")).toMatchObject({
      exitCode: 0,
    });
    expect(await cli(h, "restore", "--source=origin/topic", "shared.txt")).toMatchObject({
      exitCode: 0,
    });

    expect(h.workspace.worktree.readFile("/work/topic.txt")).toEqual(
      h.fixture.catFile(h.blobs.topicFile),
    );
    expect(h.workspace.worktree.readFile("/work/shared.txt")).toEqual(
      h.fixture.catFile(h.blobs.topicShared),
    );
    expectHydratedExactly(h, ["topicShared", "topicFile"]);
  });

  it("switches to a branch whose tree is promised", async () => {
    const h = await partialClone();

    expect(await cli(h, "checkout", "-b", "local-topic", "origin/topic")).toMatchObject({
      exitCode: 0,
    });
    expect(await cli(h, "switch", "main")).toMatchObject({ exitCode: 0 });
    expect(await cli(h, "checkout", "local-topic")).toMatchObject({ exitCode: 0 });

    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", "topic^{tree}"));
    expectHydratedExactly(h, ["baseNotes", "old", "topicShared", "topicFile"]);
  });
});

describe("a failed CLI hydration leaves the blobless clone unchanged", () => {
  it("rolls back a hard reset", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(
      h.offline.runCli({ argv: ["reset", "--hard", h.base], cwd: "/work", env: ENV }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(h.offlineRequests()).toBeGreaterThan(0);
    expect(await repositoryState(h)).toEqual(before);
  });

  it("keeps a resolved rebase stop when its continuation cannot hydrate", async () => {
    const h = await partialClone();
    await stopRebaseWithResolvedConflict(h);
    const before = await repositoryState(h);

    await expect(
      h.offline.runCli({ argv: ["rebase", "--continue"], cwd: "/work", env: ENV }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(await repositoryState(h)).toEqual(before);
    expect(before.operations[0]).toHaveLength(1);
  });
});
