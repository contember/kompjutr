// Shared blobless-clone harness for promisor hydration tests.
import { expect, onTestFinished } from "vitest";
import { createGit } from "../../packages/git/src/client.js";
import type { Git } from "../../packages/git/src/client-types.js";
import { GitError } from "../../packages/git/src/common/errors.js";
import { openRepository } from "../../packages/git/src/ops/core/context.js";
import { clone } from "../../packages/git/src/ops/network/network.js";
import type { Repository } from "../../packages/git/src/ops/repository/repository.js";
import { fetchHttpClient, type GitHttpClient } from "../../packages/git/src/protocol/transport.js";
import { GitFixture } from "./git.js";
import { startGitServer } from "./http-backend.js";
import { makeWorkspace, type TestWorkspace } from "./workspace.js";

export const IDENTITY = { name: "Promisor Tester", email: "promisor@example.com" };
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

export type Fixture = ReturnType<typeof makeFixture>;
export type BlobName = keyof Fixture["blobs"];

export interface Harness extends Fixture {
  workspace: TestWorkspace;
  repo: Repository;
  git: Git;
  offline: Git;
  posts(): number;
  offlineRequests(): number;
}

export async function partialClone(): Promise<Harness> {
  const fixture = makeFixture();
  const server = await startGitServer(fixture.fixture.dir);
  onTestFinished(async () => {
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
  let offlineRequests = 0;
  // Rejection-code assertions only prove propagation; unchanged state is the witness.
  const unreachable: GitHttpClient = async () => {
    offlineRequests++;
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
    offlineRequests: () => offlineRequests,
  };
}

export function promised(repo: Repository): Set<string> {
  return new Set([...repo.store.iteratePromisedBlobs()].map((blob) => blob.oid));
}

/** Promises that must survive: everything except the blobs the operation reads. */
export function expectHydratedExactly(h: Harness, needed: readonly BlobName[]): void {
  const remaining = new Set<string>();
  for (const [name, oid] of Object.entries(h.blobs)) {
    if (!needed.some((wanted) => wanted === name)) remaining.add(oid);
  }
  expect(promised(h.repo)).toEqual(remaining);
}

/** Native Git's tree for one three-way merge, the oracle for every replay. */
export function nativeMergeTree(h: Harness, base: string, ours: string, theirs: string): string {
  const output = h.fixture.git("merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs);
  return output.split("\n")[0] ?? "";
}

export async function expectCleanAt(h: Harness, root: string, tree: string): Promise<void> {
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

export function reflogReasons(h: Harness): { ref_name: string; reason: string }[] {
  return h.repo.store.db.all<{ ref_name: string; reason: string }>(
    `SELECT ref_name, reason, ordinal FROM git_reflog_entries
     UNION ALL SELECT 'HEAD', reason, ordinal FROM git_checkout_reflog_entries
     ORDER BY ordinal`,
  );
}

export async function repositoryState(h: Harness) {
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
    operations: [
      h.repo.store.db.all("SELECT * FROM git_operation_state"),
      h.repo.store.db.all("SELECT * FROM git_operation_steps"),
      h.repo.store.db.all("SELECT * FROM git_operation_touched"),
    ],
    status: await h.git.status({ dir: "/work" }),
    worktrees: await h.git.worktreeList({ dir: "/work" }),
    files,
    promised: promised(h.repo),
  };
}

/** Repository state minus what a published fetch legitimately changes. */
export function localOf(state: Awaited<ReturnType<typeof repositoryState>>) {
  const { branches: _branches, reflog, ...local } = state;
  return {
    ...local,
    reflog: reflog.filter((entry) => !entry.ref_name.startsWith("refs/remotes/")),
  };
}

export async function localState(h: Harness) {
  return localOf(await repositoryState(h));
}

/** Rebase stack onto main: step one conflicts, step two reads the promised base notes. */
export async function stopRebaseWithResolvedConflict(h: Harness): Promise<void> {
  await h.git.branch({ dir: "/work", name: "work", startPoint: "origin/stack" });
  await h.git.checkout({ dir: "/work", ref: "work" });
  const stopped = await h.git.rebase({ dir: "/work", upstream: "main", committer: IDENTITY });
  expect(stopped).toMatchObject({ outcome: "conflicted", replayed: 0 });
  expect(h.repo.store.promisedMissing([h.blobs.baseNotes])).toEqual([h.blobs.baseNotes]);
  h.workspace.worktree.writeFile("/work/shared.txt", new TextEncoder().encode("AS\nb\nc\nd\ne\n"));
  await h.git.add({ dir: "/work", paths: ["shared.txt"] });
}
