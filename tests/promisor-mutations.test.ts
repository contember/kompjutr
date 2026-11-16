import { afterEach, describe, expect, it } from "vitest";
import { createGit } from "../packages/git/src/client.js";
import type { Git } from "../packages/git/src/client-types.js";
import { GitError } from "../packages/git/src/common/errors.js";
import { openRepository } from "../packages/git/src/ops/core/context.js";
import { clone } from "../packages/git/src/ops/network/network.js";
import type { Repository } from "../packages/git/src/ops/repository/repository.js";
import { fetchHttpClient, type GitHttpClient } from "../packages/git/src/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

const IDENTITY = { name: "Promisor Tester", email: "promisor@example.com" };
const TRACKED = ["shared.txt", "old.txt", "topic.txt", "notes.txt", "side.txt"];
const decoder = new TextDecoder();

/**
 * main and topic diverge from base on opposite ends of shared.txt, so a
 * three-way merge needs base, ours, and theirs. After a blobless clone of
 * main every blob outside main's tip is promised; side.txt is never needed.
 */
function makeFixture() {
  const fixture = new GitFixture().init();
  fixture.write("shared.txt", "a\nb\nc\nd\ne\n");
  fixture.write("old.txt", "old\n");
  fixture.write("notes.txt", "1\n2\n3\n4\n5\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic");
  fixture.write("shared.txt", "a\nb\nc\nd\nE\n");
  fixture.write("topic.txt", "topic\n");
  fixture.commit("topic");
  fixture.git("checkout", "-q", "-b", "stack", base);
  fixture.write("shared.txt", "S\nb\nc\nd\ne\n");
  fixture.commit("stack one");
  fixture.write("notes.txt", "1\n2\n3\n4\nN\n");
  fixture.commit("stack two");
  fixture.git("checkout", "-q", "-b", "side", base);
  fixture.write("side.txt", "side\n");
  fixture.commit("side");
  fixture.git("checkout", "-q", "main");
  fixture.write("shared.txt", "A\nb\nc\nd\ne\n");
  fixture.write("notes.txt", "M\n2\n3\n4\n5\n");
  fixture.remove("old.txt");
  fixture.commit("main");
  fixture.git("config", "uploadpack.allowFilter", "true");
  const blob = (spec: string): string => fixture.git("rev-parse", spec);
  return {
    fixture,
    base,
    blobs: {
      baseShared: blob(`${base}:shared.txt`),
      baseNotes: blob(`${base}:notes.txt`),
      old: blob(`${base}:old.txt`),
      topicShared: blob("topic:shared.txt"),
      topicFile: blob("topic:topic.txt"),
      stackShared: blob("stack:shared.txt"),
      stackNotes: blob("stack:notes.txt"),
      side: blob("side:side.txt"),
    },
  };
}

type Fixture = ReturnType<typeof makeFixture>;
type BlobName = keyof Fixture["blobs"];

interface Harness extends Fixture {
  workspace: TestWorkspace;
  repo: Repository;
  git: Git;
  offline: Git;
  posts(): number;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function partialClone(): Promise<Harness> {
  const fixture = makeFixture();
  const server = await startGitServer(fixture.fixture.dir);
  cleanups.push(async () => {
    await server.close();
    fixture.fixture.dispose();
  });
  const workspace = makeWorkspace();
  await clone(workspace.context, { url: server.url, dir: "/work", filter: "blob:none" });
  const binding = {
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
  };
  const unreachable: GitHttpClient = async () => {
    throw new GitError("EFETCHFAIL", "promisor remote is unreachable");
  };
  const repo = openRepository(workspace.context, "/work");
  expect(promised(repo)).toEqual(
    new Set([
      fixture.blobs.baseShared,
      fixture.blobs.baseNotes,
      fixture.blobs.old,
      fixture.blobs.topicShared,
      fixture.blobs.topicFile,
      fixture.blobs.stackShared,
      fixture.blobs.stackNotes,
      fixture.blobs.side,
    ]),
  );
  return {
    ...fixture,
    workspace,
    repo,
    git: createGit()({ ...binding, http: fetchHttpClient }),
    offline: createGit()({ ...binding, http: unreachable }),
    posts: () => server.requests.filter((request) => request.method === "POST").length,
  };
}

function promised(repo: Repository): Set<string> {
  return new Set([...repo.store.iteratePromisedBlobs()].map((blob) => blob.oid));
}

/** Promises that must survive: everything except the blobs the operation reads. */
function expectHydratedExactly(h: Harness, needed: readonly BlobName[]): void {
  const remaining = new Set<string>();
  for (const [name, oid] of Object.entries(h.blobs)) {
    if (!needed.some((wanted) => wanted === name)) remaining.add(oid);
  }
  expect(promised(h.repo)).toEqual(remaining);
}

/** Native Git's tree for one three-way merge, the oracle for every replay. */
function nativeMergeTree(h: Harness, base: string, ours: string, theirs: string): string {
  const output = h.fixture.git("merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs);
  return output.split("\n")[0] ?? "";
}

async function expectCleanAt(h: Harness, root: string, tree: string): Promise<void> {
  const head = await h.git.revParse({ dir: root, ref: "HEAD" });
  expect(openRepository(h.workspace.context, root).readCommit(head).tree).toBe(tree);
  expect(await h.git.status({ dir: root })).toEqual([]);
  for (const path of TRACKED) {
    const native = h.fixture.gitResult("rev-parse", "--verify", "-q", `${tree}:${path}`);
    const local = h.workspace.worktree.stat(`${root}/${path}`);
    if (native.status !== 0) {
      expect(local).toBeNull();
      continue;
    }
    expect(h.workspace.worktree.readFile(`${root}/${path}`)).toEqual(
      h.fixture.catFile(native.stdout),
    );
  }
}

function reflogReasons(h: Harness): { ref_name: string; reason: string }[] {
  return h.repo.store.db.all<{ ref_name: string; reason: string }>(
    `SELECT ref_name, reason, ordinal FROM git_reflog_entries
     UNION ALL SELECT 'HEAD', reason, ordinal FROM git_checkout_reflog_entries
     ORDER BY ordinal`,
  );
}

async function repositoryState(h: Harness) {
  const files: Record<string, string | null> = {};
  for (const path of TRACKED) {
    const target = `/work/${path}`;
    files[path] =
      h.workspace.worktree.stat(target) === null
        ? null
        : decoder.decode(h.workspace.worktree.readFile(target));
  }
  return {
    head: await h.git.revParse({ dir: "/work", ref: "HEAD" }),
    branches: await h.git.branchList({ dir: "/work" }),
    reflog: reflogReasons(h),
    operations: h.repo.store.db.all("SELECT * FROM git_operation_state"),
    status: await h.git.status({ dir: "/work" }),
    worktrees: await h.git.worktreeList({ dir: "/work" }),
    files,
    promised: promised(h.repo),
  };
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
    await h.git.branch({ dir: "/work", name: "work", startPoint: "origin/stack" });
    await h.git.checkout({ dir: "/work", ref: "work" });
    const stopped = await h.git.rebase({ dir: "/work", upstream: "main", committer: IDENTITY });
    expect(stopped).toMatchObject({ outcome: "conflicted", replayed: 0 });
    expect(h.repo.store.promisedMissing([h.blobs.baseNotes])).toEqual([h.blobs.baseNotes]);

    h.workspace.worktree.writeFile(
      "/work/shared.txt",
      new TextEncoder().encode("AS\nb\nc\nd\ne\n"),
    );
    await h.git.add({ dir: "/work", paths: ["shared.txt"] });
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

  it("pulls an upstream commit that restores a promised blob", async () => {
    const h = await partialClone();
    h.fixture.write("old.txt", "old\n");
    h.fixture.commit("restore old");

    const result = await h.git.pull({ dir: "/work", committer: IDENTITY, author: IDENTITY });

    expect(result).toMatchObject({ strategy: "merge", result: { fastForward: true } });
    await expectCleanAt(h, "/work", h.fixture.git("rev-parse", "main^{tree}"));
    expectHydratedExactly(h, ["old"]);
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

  it("registers no worktree when its tree cannot be hydrated", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);

    await expect(
      h.offline.worktreeAdd({
        dir: "/work",
        root: "/topic",
        target: { kind: "new-branch", name: "local-topic", startPoint: "origin/topic" },
      }),
    ).rejects.toMatchObject({ code: "EFETCHFAIL" });

    expect(await repositoryState(h)).toEqual(before);
    expect(h.workspace.worktree.stat("/topic")).toBeNull();
  });
});
