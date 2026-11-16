import { describe, expect, it } from "vitest";
import { GitError } from "../packages/git/src/common/errors.js";
import { pull as pullCore } from "../packages/git/src/ops/network/pull.js";
import { fetchHttpClient, type GitHttpClient } from "../packages/git/src/protocol/transport.js";
import {
  expectCleanAt,
  expectHydratedExactly,
  type Harness,
  IDENTITY,
  localOf,
  localState,
  nativeMergeTree,
  partialClone,
  reflogReasons,
  repositoryState,
  stopRebaseWithResolvedConflict,
} from "./helpers/promisor.js";

/**
 * A filtered fetch leaves fresh.txt promised on origin/main; origin then moves
 * on, so the pull's own fetch omits that blob and its fast-forward must hydrate it.
 */
async function promisedUpstream(h: Harness): Promise<{ fresh: string; incoming: string }> {
  h.fixture.write("fresh.txt", "fresh\n");
  const filtered = h.fixture.commit("fresh");
  await h.git.fetch({ dir: "/work", filter: "blob:none" });
  const fresh = h.fixture.git("rev-parse", `${filtered}:fresh.txt`);
  expect(h.repo.store.promisedMissing([fresh])).toEqual([fresh]);
  h.fixture.write("later.txt", "later\n");
  return { fresh, incoming: h.fixture.commit("later") };
}

/** Pull with requests after fetch publication, which only hydration makes, sent to `hydration`. */
function pullThrough(h: Harness, hydration: GitHttpClient, signal?: AbortSignal) {
  let published = false;
  let hydrationRequests = 0;
  const http: GitHttpClient = (request) => {
    if (!published) return fetchHttpClient(request);
    hydrationRequests++;
    return hydration(request);
  };
  const pulling = pullCore(
    { ...h.workspace.context, http },
    h.repo,
    h.workspace.worktree,
    { committer: IDENTITY, author: IDENTITY, ...(signal === undefined ? {} : { signal }) },
    {
      afterFetch: () => {
        published = true;
      },
    },
  );
  return { pulling, hydrationRequests: () => hydrationRequests };
}

describe("partial clone mutations hydrate promised blobs", () => {
  it("merges a branch whose merge base and side are promised", async () => {
    const h = await partialClone();
    const result = await h.git.merge({
      dir: "/work",
      theirs: "origin/topic",
      author: IDENTITY,
      committer: IDENTITY,
    });

    expect(result.conflicted).toBeUndefined();
    await expectCleanAt(h, "/work", nativeMergeTree(h, h.base, "main", "topic"));
    expectHydratedExactly(h, ["baseShared", "topicShared", "topicFile"]);
  });

  it("cherry-picks a promised commit", async () => {
    const h = await partialClone();
    const result = await h.git.cherryPick({
      dir: "/work",
      source: "origin/topic",
      committer: IDENTITY,
    });

    expect(result.outcome).toBe("committed");
    await expectCleanAt(h, "/work", nativeMergeTree(h, h.base, "main", "topic"));
    expectHydratedExactly(h, ["baseShared", "topicShared", "topicFile"]);
  });

  it("reverts a commit whose parent content is promised", async () => {
    const h = await partialClone();
    const result = await h.git.revert({
      dir: "/work",
      source: "HEAD",
      author: IDENTITY,
      committer: IDENTITY,
    });

    expect(result.outcome).toBe("committed");
    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", `${h.base}^{tree}`));
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old"]);
  });

  it("rebases onto a promised upstream", async () => {
    const h = await partialClone();
    const result = await h.git.rebase({
      dir: "/work",
      upstream: "origin/topic",
      committer: IDENTITY,
    });

    expect(result).toMatchObject({ outcome: "completed", replayed: 1 });
    await expectCleanAt(h, "/work", nativeMergeTree(h, h.base, "topic", "main"));
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old", "topicShared", "topicFile"]);
  });

  it("continues a rebase whose next step reads a promised base", async () => {
    const h = await partialClone();
    await stopRebaseWithResolvedConflict(h);
    const result = await h.git.rebaseContinue({ dir: "/work", committer: IDENTITY });

    expect(result).toMatchObject({ outcome: "completed", replayed: 2 });
    h.fixture.git("checkout", "-q", "-b", "expected", "stack");
    expect(h.fixture.gitResult("rebase", "main").status).not.toBe(0);
    h.fixture.write("shared.txt", "AS\nb\nc\nd\ne\n");
    h.fixture.git("add", "shared.txt");
    h.fixture.gitWithEnv({ GIT_EDITOR: "true" }, "rebase", "--continue");
    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", "HEAD^{tree}"));
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old", "stackShared", "stackNotes"]);
  });

  it("hard-resets to a promised commit and records one reflog entry", async () => {
    const h = await partialClone();
    const before = reflogReasons(h);

    await h.git.reset({ dir: "/work", hard: true, ref: h.base });

    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", `${h.base}^{tree}`));
    // The first attempt moved the branch before it read a promised blob.
    expect(reflogReasons(h).slice(before.length)).toMatchObject([
      { ref_name: "refs/heads/main", reason: "reset: hard" },
      { ref_name: "HEAD", reason: "reset: hard" },
    ]);
    expectHydratedExactly(h, ["baseShared", "baseNotes", "old"]);
  });

  it("adds a worktree on a promised branch with one hydration request", async () => {
    const h = await partialClone();
    const postsBefore = h.posts();

    await h.git.worktreeAdd({
      dir: "/work",
      root: "/topic",
      target: { kind: "detached", startPoint: "origin/topic" },
    });

    await expectCleanAt(h, "/topic", h.fixture.git("rev-parse", "topic^{tree}"));
    expect(h.posts() - postsBefore).toBe(1);
    expectHydratedExactly(h, ["baseNotes", "old", "topicShared", "topicFile"]);
  });

  it("pulls an upstream whose tree holds a promised blob", async () => {
    const h = await partialClone();
    const { fresh, incoming } = await promisedUpstream(h);
    const { pulling, hydrationRequests } = pullThrough(h, fetchHttpClient);

    expect(await pulling).toMatchObject({ strategy: "merge", result: { fastForward: true } });
    expect(hydrationRequests()).toBeGreaterThan(0);
    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", `${incoming}^{tree}`));
    expect(h.repo.has(fresh)).toBe(true);
    expectHydratedExactly(h, []);
  });
});

describe("a failed hydration leaves the partial clone unchanged", () => {
  it("rolls back a hard reset that moved its ref before reading a promised blob", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(h.offline.reset({ dir: "/work", hard: true, ref: h.base })).rejects.toMatchObject({
      code: "EFETCHFAIL",
    });

    expect(await repositoryState(h)).toEqual(before);
  });

  it("rolls back a merge without leaving operation state", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(
      h.offline.merge({
        dir: "/work",
        theirs: "origin/topic",
        author: IDENTITY,
        committer: IDENTITY,
      }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(await repositoryState(h)).toEqual(before);
    expect(() => h.repo.checkout.requireNoOperationState()).not.toThrow();
  });

  it("rolls back a worktree add whose tree cannot be hydrated", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(
      h.offline.worktreeAdd({
        dir: "/work",
        root: "/topic",
        target: { kind: "new-branch", name: "local-topic", startPoint: "origin/topic" },
      }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(h.offlineRequests()).toBeGreaterThan(0);
    expect(await repositoryState(h)).toEqual(before);
    expect(h.workspace.worktree.stat("/topic")).toBeNull();
    expect(h.workspace.database.findCheckout("/topic")).toBeNull();
  });

  it("rolls back a rebase", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(
      h.offline.rebase({ dir: "/work", upstream: "origin/topic", committer: IDENTITY }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(await repositoryState(h)).toEqual(before);
  });

  it("keeps a resolved rebase stop when its continuation cannot hydrate", async () => {
    const h = await partialClone();
    await stopRebaseWithResolvedConflict(h);
    const before = await repositoryState(h);

    await expect(
      h.offline.rebaseContinue({ dir: "/work", committer: IDENTITY }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(await repositoryState(h)).toEqual(before);
    expect(before.operations[0]).toHaveLength(1);
  });

  it("rolls back a cherry-pick", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(
      h.offline.cherryPick({ dir: "/work", source: "origin/topic", committer: IDENTITY }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(await repositoryState(h)).toEqual(before);
  });

  it("keeps fetched refs and integrates nothing when pull hydration fails", async () => {
    const h = await partialClone();
    const { incoming } = await promisedUpstream(h);
    const before = await repositoryState(h);
    const unreachable: GitHttpClient = async () => {
      throw new GitError("EFETCHFAIL", "promisor remote is unreachable");
    };
    const { pulling, hydrationRequests } = pullThrough(h, unreachable);

    await expect(pulling).rejects.toMatchObject({ code: "EFETCHFAIL" });
    expect(hydrationRequests()).toBeGreaterThan(0);

    expect(h.repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
    expect(await localState(h)).toEqual(localOf(before));
  });

  it("cancels pull hydration after fetch publication without integrating", async () => {
    const h = await partialClone();
    const { incoming } = await promisedUpstream(h);
    const before = await repositoryState(h);
    const controller = new AbortController();
    const abortOnHydration: GitHttpClient = (request) => {
      controller.abort(new Error("cancel during hydration"));
      return fetchHttpClient(request);
    };
    const { pulling, hydrationRequests } = pullThrough(h, abortOnHydration, controller.signal);

    await expect(pulling).rejects.toMatchObject({ code: "EABORTED" });
    expect(hydrationRequests()).toBeGreaterThan(0);

    expect(h.repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
    expect(await localState(h)).toEqual(localOf(before));
  });
});

describe("worktree add checks its target before hydration", () => {
  it("rejects a registered root without contacting the promisor", async () => {
    const h = await partialClone();
    await h.offline.worktreeAdd({ dir: "/work", root: "/taken", target: { kind: "detached" } });

    await expect(
      h.offline.worktreeAdd({
        dir: "/work",
        root: "/taken",
        target: { kind: "detached", startPoint: "origin/topic" },
      }),
    ).rejects.toMatchObject({ code: "EWORKTREEEXISTS" });

    expect(h.offlineRequests()).toBe(0);
  });

  it("rejects a branch attached elsewhere without contacting the promisor", async () => {
    const h = await partialClone();
    // Attach HEAD to a branch whose tree is promised, leaving the worktree alone.
    await h.git.branch({ dir: "/work", name: "work", startPoint: "origin/topic", checkout: true });
    const postsBefore = h.posts();

    await expect(
      h.offline.worktreeAdd({
        dir: "/work",
        root: "/other",
        target: { kind: "existing-branch", name: "work" },
      }),
    ).rejects.toMatchObject({ code: "EBRANCHINUSE" });

    expect(h.offlineRequests()).toBe(0);
    expect(h.posts()).toBe(postsBefore);
    expect(h.workspace.worktree.stat("/other")).toBeNull();
  });
});
