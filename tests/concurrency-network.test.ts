import { afterAll, describe, expect, it } from "vitest";
import { createGit, type Git } from "../src/git/client.js";
import { GitError } from "../src/git/common/errors.js";
import { openRepository } from "../src/git/ops/context.js";
import { maintenance } from "../src/git/ops/maintenance.js";
import type { MergeStateMetadata } from "../src/git/ops/merge-state.js";
import { clone, fetchInto } from "../src/git/ops/network.js";
import { push } from "../src/git/ops/push.js";
import type { Repository } from "../src/git/ops/repository.js";
import {
  fetchHttpClient,
  type GitHttpClient,
  type GitHttpRequest,
} from "../src/git/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import {
  awaitBarrierEntry,
  bufferedHttpResponseBarrier,
  oneShotBarrier,
  type PairCompletionOrder,
  runPairInBothCompletionOrders,
} from "./helpers/interleaving.js";
import { assertRepositoryReadable, reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };
const COMPLETION_ORDERS: readonly PairCompletionOrder[] = ["left-first", "right-first"];
const fixtures: GitFixture[] = [];

afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function gitFor(workspace: TestWorkspace, http?: GitHttpClient): Git {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
    ...(http === undefined ? {} : { http }),
  });
}

function remoteFixture(): { fixture: GitFixture; initial: string } {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("base.txt", "base\n");
  fixture.write("other.txt", "other\n");
  const initial = fixture.commit("initial");
  fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
  return { fixture, initial };
}

async function localCommit(git: Git, workspace: TestWorkspace, content: string): Promise<string> {
  await workspace.workspace.fs.writeFile("/work/local.txt", content);
  await git.add({ dir: "/work", paths: ["local.txt"] });
  return (await git.commit({ dir: "/work", message: content.trim() })).oid;
}

function corruptLooseObject(repo: Repository, oid: string): void {
  repo.store.db.run(
    "UPDATE git_objects SET stored = 'raw' WHERE repo_id = ? AND oid = ?",
    repo.store.repoId,
    oid,
  );
  repo.store.db.run(
    `UPDATE git_object_chunks SET data = zeroblob((
       SELECT size FROM git_objects WHERE repo_id = ? AND oid = ?
     )) WHERE repo_id = ? AND oid = ? AND seq = 0`,
    repo.store.repoId,
    oid,
    repo.store.repoId,
    oid,
  );
  repo.store.db.run(
    "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ? AND seq > 0",
    repo.store.repoId,
    oid,
  );
}

function pauseBeforeFirstPost(
  name: string,
  upstream: GitHttpClient = fetchHttpClient,
): { barrier: ReturnType<typeof oneShotBarrier>; http: GitHttpClient } {
  const barrier = oneShotBarrier(name);
  let selected = false;
  return {
    barrier,
    async http(request: GitHttpRequest) {
      if (!selected && request.method === "POST") {
        selected = true;
        await barrier.wait();
      }
      return upstream(request);
    },
  };
}

function pauseBeforeFetchPublication(name: string): {
  barrier: ReturnType<typeof oneShotBarrier>;
  checkpoint(stage: string): Promise<void> | undefined;
} {
  const barrier = oneShotBarrier(name);
  return {
    barrier,
    checkpoint(stage) {
      return stage === "before-ref-publication" ? barrier.wait() : undefined;
    },
  };
}

async function settlePushFetch(
  order: PairCompletionOrder,
  pushing: Promise<unknown>,
  pushBarrier: { release(): void },
  fetching: Promise<unknown>,
  fetchBarrier: { release(): void },
): Promise<void> {
  if (order === "left-first") {
    pushBarrier.release();
    await expect(pushing).resolves.toMatchObject({ ok: true });
    fetchBarrier.release();
    await expect(fetching).resolves.toBeDefined();
    return;
  }
  fetchBarrier.release();
  await expect(fetching).resolves.toBeDefined();
  pushBarrier.release();
  await expect(pushing).resolves.toMatchObject({ ok: true });
}

describe("push and pull concurrency", () => {
  it("returns EABORTED when discovery cancellation settles immediately before POST", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const controller = new AbortController();
    const reason = new Error("cancel after push discovery");
    let pushDiscoveries = 0;
    const http: GitHttpClient = async (request) => {
      const response = await fetchHttpClient(request);
      if (request.method !== "GET") return response;
      pushDiscoveries++;
      const body = async function* (): AsyncGenerator<Uint8Array> {
        try {
          yield* response.body;
        } finally {
          controller.abort(reason);
        }
      };
      return { ...response, body: body() };
    };
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      await localCommit(gitFor(workspace), workspace, "cancel before POST\n");
      const posts = server.requests.filter((request) => request.method === "POST").length;

      await expect(
        push({ ...workspace.context, http }, repo, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "EABORTED", cause: reason });

      expect(pushDiscoveries).toBe(1);
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
      expect(fixture.git("rev-parse", "main")).toBe(initial);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      await server.close();
    }
  });

  it("returns EPUSHUNCERTAIN after a consumed POST abort and leaves tracking unchanged", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const response = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "abort after consumed push POST",
      select: (request) => request.method === "POST",
    });
    const controller = new AbortController();
    const reason = new Error("cancel after remote consumed POST");
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "consumed before abort\n");

      pushing = push({ ...workspace.context, http: response.http }, repo, {
        signal: controller.signal,
      });
      await awaitBarrierEntry(response, pushing);
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      controller.abort(reason);
      await expect(pushing).rejects.toMatchObject({
        code: "EPUSHUNCERTAIN",
        cause: { code: "EABORTED", cause: reason },
      });

      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      response.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("snapshots a tracking lease before discovery can interleave a local tracking mutation", async () => {
    const { fixture } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const discovery = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "tracking lease discovery",
      select: (request) => request.method === "GET",
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "tracking snapshot\n");

      pushing = push({ ...workspace.context, http: discovery.http }, repo, {
        leases: { main: { tracking: true } },
      });
      await awaitBarrierEntry(discovery, pushing);
      repo.store.setRef("refs/remotes/origin/main", pushed);
      discovery.release();

      await expect(pushing).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(pushed);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      discovery.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("preserves discovery CAS when the remote changes after a matching lease check", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const post = pauseBeforeFirstPost("leased push after remote race");
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "leased local\n");

      pushing = push({ ...workspace.context, http: post.http }, repo, {
        force: true,
        leases: { main: { expected: initial } },
      });
      await awaitBarrierEntry(post.barrier, pushing);
      fixture.write("remote-race.txt", "remote race\n");
      const raced = fixture.commit("remote race after discovery");
      post.barrier.release();

      await expect(pushing).resolves.toMatchObject({
        ok: false,
        refs: [
          {
            ref: "refs/heads/main",
            ok: false,
            error: "incorrect old value provided",
          },
        ],
      });
      expect(fixture.git("rev-parse", "main")).toBe(raced);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: pushed });
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      post.barrier.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it.each(COMPLETION_ORDERS)(
    "does not let delayed push tracking regress a newer fetch in %s order",
    async (order) => {
      const { fixture } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      const pushResponse = bufferedHttpResponseBarrier(fetchHttpClient, {
        name: `${order} confirmed push response`,
        select: (request) => request.method === "POST",
      });
      const fetchPublication = pauseBeforeFetchPublication(`${order} fetch publication`);
      let pushing: Promise<unknown> | null = null;
      let fetching: Promise<unknown> | null = null;
      try {
        await clone(workspace.context, {
          url: server.url,
          dir: "/work",
          depth: 0,
          noTags: true,
        });
        const repo = openRepository(workspace.context, "/work");
        const git = gitFor(workspace);
        const pushed = await localCommit(git, workspace, "pushed\n");

        pushing = push({ ...workspace.context, http: pushResponse.http }, repo, {});
        await awaitBarrierEntry(pushResponse, pushing);
        expect(fixture.git("rev-parse", "main")).toBe(pushed);

        fixture.write("remote-later.txt", "newer\n");
        const newer = fixture.commit("newer remote tip");
        fetching = fetchInto(workspace.context, repo, {}, "fetch", {
          checkpoint: fetchPublication.checkpoint,
        });
        await awaitBarrierEntry(fetchPublication.barrier, fetching);

        await settlePushFetch(order, pushing, pushResponse, fetching, fetchPublication.barrier);

        const cold = reopenTestRepository(workspace, "/work");
        expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(newer);
        expect(cold.repo.head()).toEqual({ ref: "refs/heads/main", oid: pushed });
        expect(cold.repo.readCommit(newer).message).toContain("newer remote tip");
        assertRepositoryReadable(cold.repo);
      } finally {
        pushResponse.release();
        fetchPublication.barrier.release();
        await Promise.allSettled([pushing, fetching].filter((value) => value !== null));
        await server.close();
      }
    },
  );

  it("does not let a failed refresh fallback overwrite a same-target newer fetch", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let pushDiscoveries = 0;
    const upstream: GitHttpClient = async (request) => {
      if (request.method === "GET") {
        pushDiscoveries++;
        if (pushDiscoveries >= 2) throw new Error("post-success refresh failed");
      }
      return fetchHttpClient(request);
    };
    const response = bufferedHttpResponseBarrier(upstream, {
      name: "push fallback after same-target fetch",
      select: (request) => request.method === "POST",
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "pushed before ABA\n");

      pushing = push({ ...workspace.context, http: response.http }, repo, {});
      await awaitBarrierEntry(response, pushing);
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      fixture.git("reset", "--hard", initial);
      await fetchInto(workspace.context, repo, { tags: false }, "fetch");
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(initial);

      response.release();
      await expect(pushing).resolves.toMatchObject({ ok: true });

      expect(pushDiscoveries).toBeGreaterThanOrEqual(2);
      expect(fixture.git("rev-parse", "main")).toBe(initial);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      response.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("fences an older pending fetch after a later no-op push observation", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const publication = pauseBeforeFetchPublication("fetch before no-op push publication");
    let fetching: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("pending.txt", "pending\n");
      const pending = fixture.commit("pending older fetch");
      fetching = fetchInto(workspace.context, repo, { tags: false }, "fetch", {
        checkpoint: publication.checkpoint,
      });
      await awaitBarrierEntry(publication.barrier, fetching);
      fixture.git("reset", "--hard", initial);
      const posts = server.requests.filter((request) => request.method === "POST").length;

      await expect(push(workspace.context, repo, {})).resolves.toMatchObject({ ok: true });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
      publication.barrier.release();
      await expect(fetching).rejects.toMatchObject({ code: "ESTALEFETCH" });

      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      expect(cold.repo.readCommit(pending).message).toContain("pending older fetch");
      assertRepositoryReadable(cold.repo);
    } finally {
      publication.barrier.release();
      await Promise.allSettled([fetching].filter((value) => value !== null));
      await server.close();
    }
  });

  it("does not let a buffered refresh overwrite a fetch published after its snapshot", async () => {
    const { fixture } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let discoveries = 0;
    const refresh = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "buffered post-success push refresh",
      select: (request) => {
        if (request.method !== "GET") return false;
        discoveries++;
        return discoveries === 2;
      },
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "refreshed push\n");

      pushing = push({ ...workspace.context, http: refresh.http }, repo, {});
      await awaitBarrierEntry(refresh, pushing);
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      fixture.write("newer-remote.txt", "newer\n");
      const fetched = fixture.commit("newer remote tip after buffered refresh");
      await fetchInto(workspace.context, repo, { tags: false }, "fetch");
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(fetched);

      refresh.release();
      await expect(pushing).resolves.toMatchObject({ ok: true });

      expect(discoveries).toBe(2);
      expect(fixture.git("rev-parse", "main")).toBe(fetched);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(fetched);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      refresh.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("does not publish an unreadable tip observed after confirmed push success", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const response = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "push followed by unknown remote tip",
      select: (request) => request.method === "POST",
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "pushed\n");

      pushing = push({ ...workspace.context, http: response.http }, repo, {});
      await awaitBarrierEntry(response, pushing);
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      fixture.write("unknown.txt", "unknown locally\n");
      const unknown = fixture.commit("unknown local object");
      expect(repo.has(unknown)).toBe(false);

      response.release();
      await expect(pushing).resolves.toMatchObject({
        ok: true,
        tracking: { outcome: "deferred" },
      });

      expect(fixture.git("rev-parse", "main")).toBe(unknown);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      response.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("authenticates a locally present refreshed commit before publishing it", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const response = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "push followed by corrupt local refresh target",
      select: (request) => request.method === "POST",
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("candidate.txt", "candidate\n");
      const candidate = fixture.commit("candidate refresh tip");
      expect(repo.store.write("commit", fixture.catFile(candidate))).toBe(candidate);
      fixture.git("reset", "--hard", initial);
      const pushed = await localCommit(gitFor(workspace), workspace, "pushed before corrupt tip\n");
      const cold = reopenTestRepository(workspace, "/work");

      pushing = push({ ...cold.context, http: response.http }, cold.repo, {});
      await awaitBarrierEntry(response, pushing);
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      fixture.git("reset", "--hard", candidate);
      corruptLooseObject(cold.repo, candidate);

      response.release();
      await expect(pushing).resolves.toMatchObject({
        ok: true,
        tracking: { outcome: "deferred" },
      });

      expect(fixture.git("rev-parse", "main")).toBe(candidate);
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      expect(cold.repo.readCommit(pushed).message).toContain("pushed before corrupt tip");
      cold.repo.store.db.run(
        "DELETE FROM git_commits WHERE repo_id = ? AND oid = ?",
        cold.repo.store.repoId,
        candidate,
      );
      cold.repo.store.db.run(
        "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
        cold.repo.store.repoId,
        candidate,
      );
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      response.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("re-authenticates a no-op push target after discovery before tracking publication", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const discovery = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "no-op push discovery before local corruption",
      select: (request) => request.method === "GET",
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const pushed = await localCommit(gitFor(workspace), workspace, "no-op target\n");
      await push(workspace.context, repo, {});
      repo.store.setRef("refs/remotes/origin/main", initial);
      const cold = reopenTestRepository(workspace, "/work");

      pushing = push({ ...cold.context, http: discovery.http }, cold.repo, {});
      await awaitBarrierEntry(discovery, pushing);
      corruptLooseObject(cold.repo, pushed);
      discovery.release();
      await expect(pushing).resolves.toMatchObject({ ok: true });

      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(initial);
      cold.repo.store.db.run(
        "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
        cold.repo.store.repoId,
        pushed,
      );
      expect(cold.repo.store.write("commit", fixture.catFile(pushed))).toBe(pushed);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      discovery.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it.each(["ECORRUPT", "E2BIG", "EFETCHFAIL", "EURLSCHEME"])(
    "keeps confirmed push success certain when tracking refresh fails with %s",
    async (code) => {
      const { fixture } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      let discoveries = 0;
      const http: GitHttpClient = async (request) => {
        if (request.method === "GET") {
          discoveries++;
          if (discoveries >= 2) throw new GitError(code, "tracking refresh failed");
        }
        return fetchHttpClient(request);
      };
      try {
        await clone(workspace.context, {
          url: server.url,
          dir: "/work",
          depth: 0,
          noTags: true,
        });
        const repo = openRepository(workspace.context, "/work");
        const pushed = await localCommit(gitFor(workspace), workspace, "confirmed\n");

        await expect(push({ ...workspace.context, http }, repo, {})).resolves.toMatchObject({
          ok: true,
        });

        expect(discoveries).toBe(3);
        expect(fixture.git("rev-parse", "main")).toBe(pushed);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(pushed);
        assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
      } finally {
        await server.close();
      }
    },
  );

  it("lets only one same-ref push win the advertised remote CAS in both orders", async () => {
    await runPairInBothCompletionOrders(async (order) => {
      const { fixture, initial } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      const leftPost = pauseBeforeFirstPost(`${order} left push POST`);
      const rightPost = pauseBeforeFirstPost(`${order} right push POST`);
      let leftPush: Promise<unknown> | null = null;
      let rightPush: Promise<unknown> | null = null;
      try {
        await clone(workspace.context, {
          url: server.url,
          dir: "/work",
          depth: 0,
          noTags: true,
        });
        const repo = openRepository(workspace.context, "/work");
        const git = gitFor(workspace);
        const left = await localCommit(git, workspace, "left\n");
        repo.store.setRef("refs/heads/left", left);
        await git.reset({ dir: "/work", ref: initial, hard: true });
        const right = await localCommit(git, workspace, "right\n");
        repo.store.setRef("refs/heads/right", right);
        const head = repo.head();
        const index = repo.checkout.indexEntries();
        const journal = repo.checkout.readOperationState();

        leftPush = push({ ...workspace.context, http: leftPost.http }, repo, {
          ref: "left",
          remoteRef: "main",
        });
        rightPush = push({ ...workspace.context, http: rightPost.http }, repo, {
          ref: "right",
          remoteRef: "main",
        });
        await Promise.all([
          awaitBarrierEntry(leftPost.barrier, leftPush),
          awaitBarrierEntry(rightPost.barrier, rightPush),
        ]);

        const winner = order === "left-first" ? left : right;
        const winningPush = order === "left-first" ? leftPush : rightPush;
        const winningBarrier = order === "left-first" ? leftPost.barrier : rightPost.barrier;
        const losingPush = order === "left-first" ? rightPush : leftPush;
        const losingBarrier = order === "left-first" ? rightPost.barrier : leftPost.barrier;
        winningBarrier.release();
        await expect(winningPush).resolves.toMatchObject({
          ok: true,
          tracking: { outcome: order === "left-first" ? "stale" : "updated" },
        });
        losingBarrier.release();
        await expect(losingPush).resolves.toMatchObject({
          ok: false,
          refs: [
            {
              ref: "refs/heads/main",
              ok: false,
              error: "incorrect old value provided",
            },
          ],
          tracking: { outcome: "not-applicable" },
        });

        expect(fixture.git("rev-parse", "main")).toBe(winner);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(
          order === "left-first" ? initial : winner,
        );
        expect(repo.head()).toEqual(head);
        expect(repo.checkout.indexEntries()).toEqual(index);
        expect(repo.checkout.readOperationState()).toEqual(journal);
        assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
      } finally {
        leftPost.barrier.release();
        rightPost.barrier.release();
        await Promise.allSettled([leftPush, rightPush].filter((value) => value !== null));
        await server.close();
      }
    });
  });

  it("preserves newer local commit, staged index, journal, and maintenance across push success", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const response = bufferedHttpResponseBarrier(fetchHttpClient, {
      name: "push state preservation",
      select: (request) => request.method === "POST",
    });
    let pushing: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      const git = gitFor(workspace);
      const pushed = await localCommit(git, workspace, "pushed snapshot\n");

      pushing = push({ ...workspace.context, http: response.http }, repo, {});
      await awaitBarrierEntry(response, pushing);
      const newer = await localCommit(git, workspace, "newer local\n");
      await workspace.workspace.fs.writeFile("/work/staged.txt", "staged\n");
      await git.add({ dir: "/work", paths: ["staged.txt"] });
      const state: MergeStateMetadata = {
        originalHeadRef: "refs/heads/main",
        originalHeadOid: newer,
        currentParentOid: newer,
        incomingParentOid: initial,
        phase: "ready",
        mode: "no-commit",
        mergeOrigin: "merge",
        currentLabel: "HEAD",
        incomingLabel: initial,
        message: "pending local merge\n",
        author: null,
        committer: null,
      };
      repo.checkout.writeMergeState(state, []);
      const index = repo.checkout.indexEntries();
      const journal = repo.checkout.readOperationState();
      await maintenance(workspace.context, repo);

      response.release();
      await expect(pushing).resolves.toMatchObject({ ok: true });

      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(pushed);
      expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: newer });
      expect(repo.checkout.indexEntries()).toEqual(index);
      expect(repo.checkout.readOperationState()).toEqual(journal);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      response.release();
      await Promise.allSettled([pushing].filter((value) => value !== null));
      await server.close();
    }
  });

  it("lets the second pull-rebase owner publish and rejects the first stale owner", async () => {
    const { fixture, initial } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const firstDiscovery = oneShotBarrier("first pull-rebase discovery");
    const secondDiscovery = oneShotBarrier("second pull-rebase discovery");
    let firstBlocked = false;
    let secondBlocked = false;
    const firstHttp: GitHttpClient = async (request) => {
      if (firstBlocked && request.method === "GET") await firstDiscovery.wait();
      return fetchHttpClient(request);
    };
    const secondHttp: GitHttpClient = async (request) => {
      if (secondBlocked && request.method === "GET") await secondDiscovery.wait();
      return fetchHttpClient(request);
    };
    let firstPull: ReturnType<Git["pull"]> | null = null;
    let secondPull: ReturnType<Git["pull"]> | null = null;
    try {
      const firstGit = gitFor(workspace, firstHttp);
      const secondGit = gitFor(workspace, secondHttp);
      await firstGit.clone({ url: server.url, dir: "/work", depth: 0, noTags: true });
      const repo = openRepository(workspace.context, "/work");
      const local = await localCommit(firstGit, workspace, "local replay\n");
      fixture.write("incoming.txt", "incoming\n");
      const incoming = fixture.commit("incoming");
      firstBlocked = true;
      secondBlocked = true;

      firstPull = firstGit.pull({ dir: "/work", rebase: true });
      await awaitBarrierEntry(firstDiscovery, firstPull);
      secondPull = secondGit.pull({ dir: "/work", rebase: true });
      await awaitBarrierEntry(secondDiscovery, secondPull);

      secondDiscovery.release();
      const winner = await secondPull;
      expect(winner).toMatchObject({
        strategy: "rebase",
        result: { outcome: "completed", replayed: 1, skipped: 0, fastForward: false },
      });
      if (winner.strategy !== "rebase" || winner.result.outcome !== "completed") {
        throw new Error("winning pull-rebase did not complete replay");
      }
      const winnerOid = winner.result.oid;
      firstDiscovery.release();
      await expect(firstPull).rejects.toMatchObject({ code: "ESTALEHEAD" });

      expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: winnerOid });
      expect(repo.store.getRef("refs/heads/main")).toBe(winnerOid);
      expect(repo.readCommit(winnerOid).parent).toEqual([incoming]);
      expect(winnerOid).not.toBe(local);
      expect(winnerOid).not.toBe(initial);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
      expect(repo.checkout.readOperationState()).toBeNull();
      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.head()).toEqual({ ref: "refs/heads/main", oid: winnerOid });
      expect(cold.repo.checkout.readOperationState()).toBeNull();
      assertRepositoryReadable(cold.repo);
    } finally {
      firstDiscovery.release();
      secondDiscovery.release();
      await Promise.allSettled([firstPull, secondPull].filter((value) => value !== null));
      await server.close();
    }
  });

  it.each([
    { kind: "staged", stage: true, rebase: false, strategy: "merge" },
    { kind: "dirty", stage: false, rebase: false, strategy: "merge" },
    { kind: "staged", stage: true, rebase: true, strategy: "rebase" },
    { kind: "dirty", stage: false, rebase: true, strategy: "rebase" },
  ])(
    "rejects an interleaved overlapping $kind change during $strategy pull after retaining fetch",
    async ({ stage, rebase }) => {
      const { fixture, initial } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      const discovery = oneShotBarrier(`pull overlapping ${stage ? "staged" : "dirty"}`);
      let blockDiscovery = false;
      const http: GitHttpClient = async (request) => {
        if (blockDiscovery && request.method === "GET") await discovery.wait();
        return fetchHttpClient(request);
      };
      let pulling: Promise<unknown> | null = null;
      try {
        const git = gitFor(workspace, http);
        await git.clone({ url: server.url, dir: "/work", depth: 0, noTags: true });
        const repo = openRepository(workspace.context, "/work");
        fixture.write("base.txt", "incoming\n");
        const incoming = fixture.commit("incoming");
        blockDiscovery = true;

        pulling = git.pull({ dir: "/work", rebase });
        await awaitBarrierEntry(discovery, pulling);
        await workspace.workspace.fs.writeFile("/work/base.txt", "local\n");
        if (stage) await git.add({ dir: "/work", paths: ["base.txt"] });
        discovery.release();

        await expect(pulling).rejects.toMatchObject({ code: "ECHECKOUTFAIL" });
        expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: initial });
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(await workspace.workspace.fs.readFile("/work/base.txt", "utf8")).toBe("local\n");
        expect(repo.checkout.readOperationState()).toBeNull();
        assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
      } finally {
        discovery.release();
        await Promise.allSettled([pulling].filter((value) => value !== null));
        await server.close();
      }
    },
  );

  it("allows unrelated staged and dirty changes introduced during pull fetch", async () => {
    const { fixture } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const discovery = oneShotBarrier("pull unrelated local changes");
    let blockDiscovery = false;
    const http: GitHttpClient = async (request) => {
      if (blockDiscovery && request.method === "GET") await discovery.wait();
      return fetchHttpClient(request);
    };
    let pulling: Promise<unknown> | null = null;
    try {
      const git = gitFor(workspace, http);
      await git.clone({ url: server.url, dir: "/work", depth: 0, noTags: true });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("base.txt", "incoming\n");
      const incoming = fixture.commit("incoming");
      blockDiscovery = true;

      pulling = git.pull({ dir: "/work" });
      await awaitBarrierEntry(discovery, pulling);
      await workspace.workspace.fs.writeFile("/work/staged.txt", "staged\n");
      await git.add({ dir: "/work", paths: ["staged.txt"] });
      await workspace.workspace.fs.writeFile("/work/other.txt", "dirty\n");
      discovery.release();

      await expect(pulling).resolves.toMatchObject({
        strategy: "merge",
        result: { fastForward: true, oid: incoming },
      });
      expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: incoming });
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
      expect(await workspace.workspace.fs.readFile("/work/base.txt", "utf8")).toBe("incoming\n");
      expect(await workspace.workspace.fs.readFile("/work/staged.txt", "utf8")).toBe("staged\n");
      expect(await workspace.workspace.fs.readFile("/work/other.txt", "utf8")).toBe("dirty\n");
      expect(repo.checkout.indexEntries().some((entry) => entry.path === "staged.txt")).toBe(true);
      assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
    } finally {
      discovery.release();
      await Promise.allSettled([pulling].filter((value) => value !== null));
      await server.close();
    }
  });
});
