import { describe, expect, it } from "vitest";

import { openRepository } from "../src/git/ops/context.js";
import type { MergeStateMetadata } from "../src/git/ops/merge-state.js";
import { clone, fetchInto } from "../src/git/ops/network.js";
import type { Repository } from "../src/git/ops/repository.js";
import { worktreeAdd } from "../src/git/ops/worktrees.js";
import { fetchHttpClient } from "../src/git/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import {
  awaitBarrierEntry,
  type BarrierEntry,
  bufferedHttpResponseBarrier,
  type OneShotBarrier,
  oneShotBarrier,
  type PairCompletionOrder,
  runPairInBothCompletionOrders,
} from "./helpers/interleaving.js";
import { assertRepositoryReadable, reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo, makeWorkspace } from "./helpers/workspace.js";

interface StageBarrier {
  readonly barrier: OneShotBarrier;
  checkpoint(stage: string): Promise<void> | undefined;
}

interface ReleasableBarrier extends BarrierEntry {
  release(): void;
}

function pauseAfterDiscovery(name: string): StageBarrier {
  const barrier = oneShotBarrier(name);
  return {
    barrier,
    checkpoint(stage) {
      return stage === "after-discovery" ? barrier.wait() : undefined;
    },
  };
}

async function settleNewestRace(
  order: PairCompletionOrder,
  older: { barrier: ReleasableBarrier; promise: Promise<unknown> },
  newer: { barrier: ReleasableBarrier; promise: Promise<unknown> },
): Promise<void> {
  if (order === "left-first") {
    older.barrier.release();
    await expect(older.promise).rejects.toMatchObject({ code: "ESTALEFETCH" });
    newer.barrier.release();
    await expect(newer.promise).resolves.toBeDefined();
    return;
  }
  newer.barrier.release();
  await expect(newer.promise).resolves.toBeDefined();
  older.barrier.release();
  await expect(older.promise).rejects.toMatchObject({ code: "ESTALEFETCH" });
}

function commitFixture(label: string): { fixture: GitFixture; head: string } {
  const fixture = new GitFixture().init();
  fixture.write(`${label}.txt`, `${label}\n`);
  return { fixture, head: fixture.commit(label) };
}

function installIndependentLocalState(
  repo: Repository,
  original: string,
  incoming: string,
): { index: ReturnType<Repository["checkout"]["indexEntries"]>; journal: object } {
  const blob = repo.store.write("blob", new TextEncoder().encode("staged during fetch\n"));
  repo.store.setRef("refs/heads/during-fetch", original);
  repo.checkout.indexPut({
    path: "staged-during-fetch.txt",
    stage: 0,
    mode: 0o100644,
    oid: blob,
    size: null,
    mtime: null,
    ino: null,
  });
  const state: MergeStateMetadata = {
    originalHeadRef: "refs/heads/main",
    originalHeadOid: original,
    currentParentOid: original,
    incomingParentOid: incoming,
    phase: "ready",
    mode: "no-commit",
    mergeOrigin: "merge",
    currentLabel: "HEAD",
    incomingLabel: "local-topic",
    message: "pending local merge\n",
    author: null,
    committer: null,
  };
  repo.checkout.writeMergeState(state, []);
  const journal = repo.checkout.readOperationState();
  if (journal === null) throw new Error("local operation journal is missing");
  return { index: repo.checkout.indexEntries(), journal };
}

function completeReflogSnapshot(repo: Repository): object {
  return {
    state: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_reflog_state WHERE repo_id = ? ORDER BY repo_id",
      repo.store.repoId,
    ),
    refs: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_reflog_entries WHERE repo_id = ? ORDER BY ordinal",
      repo.store.repoId,
    ),
    heads: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_checkout_reflog_entries WHERE repo_id = ? ORDER BY ordinal",
      repo.store.repoId,
    ),
  };
}

describe("fetch publication concurrency", () => {
  it("preserves the newer same-remote advertisement in both completion orders", async () => {
    await runPairInBothCompletionOrders(async (order) => {
      const fixture = new GitFixture().init();
      fixture.write("README.md", "baseline\n");
      const baseline = fixture.commit("baseline");
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      let olderFetch: Promise<unknown> | null = null;
      let newerFetch: Promise<unknown> | null = null;
      const olderResponse = bufferedHttpResponseBarrier(fetchHttpClient, {
        name: `${order} older fetch pack`,
        select: (request) => request.method === "POST",
      });
      const newerResponse = bufferedHttpResponseBarrier(fetchHttpClient, {
        name: `${order} newer fetch pack`,
        select: (request) => request.method === "POST",
      });
      try {
        await clone(workspace.context, {
          url: server.url,
          dir: "/work",
          depth: 0,
          noTags: true,
        });
        const repo = openRepository(workspace.context, "/work");

        fixture.write("race.txt", "older\n");
        const olderOid = fixture.commit("older advertisement");
        olderFetch = fetchInto({ ...workspace.context, http: olderResponse.http }, repo, {
          singleBranch: false,
          tags: false,
        });
        await awaitBarrierEntry(olderResponse, olderFetch);

        fixture.git("reset", "--hard", baseline);
        fixture.write("race.txt", "newer\n");
        const newerOid = fixture.commit("newer advertisement");
        newerFetch = fetchInto({ ...workspace.context, http: newerResponse.http }, repo, {
          singleBranch: false,
          tags: false,
        });
        await awaitBarrierEntry(newerResponse, newerFetch);

        await settleNewestRace(
          order,
          { barrier: olderResponse, promise: olderFetch },
          { barrier: newerResponse, promise: newerFetch },
        );

        const cold = reopenTestRepository(workspace, "/work");
        expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(newerOid);
        expect(cold.repo.store.getRef("refs/remotes/origin/HEAD")).toBe(
          "ref: refs/remotes/origin/main",
        );
        expect(cold.repo.readCommit(olderOid).message).toContain("older advertisement");
        expect(
          cold.repo.store
            .reflog("refs/remotes/origin/main")
            .some((entry) => entry.newOid === olderOid),
        ).toBe(false);
        assertRepositoryReadable(cold.repo);
      } finally {
        olderResponse.release();
        newerResponse.release();
        await Promise.allSettled([olderFetch, newerFetch].filter((promise) => promise !== null));
        await server.close();
        fixture.dispose();
      }
    });
  });

  it("does not let an older prune delete a branch from a newer advertisement", async () => {
    await runPairInBothCompletionOrders(async (order) => {
      const { fixture, head } = commitFixture(`prune-${order}`);
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      const older = pauseAfterDiscovery(`${order} older prune`);
      const newer = pauseAfterDiscovery(`${order} newer branch fetch`);
      let olderFetch: Promise<unknown> | null = null;
      let newerFetch: Promise<unknown> | null = null;
      try {
        await clone(workspace.context, {
          url: server.url,
          dir: "/work",
          depth: 0,
          noTags: true,
        });
        const repo = openRepository(workspace.context, "/work");
        olderFetch = fetchInto(
          workspace.context,
          repo,
          { singleBranch: false, tags: false, prune: true },
          "fetch",
          { checkpoint: older.checkpoint },
        );
        await awaitBarrierEntry(older.barrier, olderFetch);

        fixture.git("branch", "topic", head);
        newerFetch = fetchInto(
          workspace.context,
          repo,
          { singleBranch: false, tags: false },
          "fetch",
          { checkpoint: newer.checkpoint },
        );
        await awaitBarrierEntry(newer.barrier, newerFetch);

        await settleNewestRace(
          order,
          { barrier: older.barrier, promise: olderFetch },
          { barrier: newer.barrier, promise: newerFetch },
        );
        expect(repo.store.getRef("refs/remotes/origin/topic")).toBe(head);
        expect(repo.resolveRef("refs/remotes/origin/HEAD")).toBe(head);
      } finally {
        older.barrier.release();
        newer.barrier.release();
        await Promise.allSettled([olderFetch, newerFetch].filter((promise) => promise !== null));
        await server.close();
        fixture.dispose();
      }
    });
  });

  it("coexists with local branch, index, and journal mutations across publication", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "first\n");
    const first = fixture.commit("first");
    fixture.write("README.md", "second\n");
    const original = fixture.commit("second");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const paused = pauseAfterDiscovery("local state during fetch");
    let fetching: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("remote.txt", "remote\n");
      const fetched = fixture.commit("fetch around local state");
      fetching = fetchInto(workspace.context, repo, { singleBranch: false, tags: false }, "fetch", {
        checkpoint: paused.checkpoint,
      });
      await awaitBarrierEntry(paused.barrier, fetching);

      const local = installIndependentLocalState(repo, original, first);
      paused.barrier.release();
      await expect(fetching).resolves.toBeDefined();

      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(fetched);
      expect(cold.repo.store.getRef("refs/heads/during-fetch")).toBe(original);
      expect(cold.repo.checkout.indexEntries()).toEqual(local.index);
      expect(cold.repo.checkout.readOperationState()).toEqual(local.journal);
      assertRepositoryReadable(cold.repo);
    } finally {
      paused.barrier.release();
      if (fetching !== null) await Promise.allSettled([fetching]);
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects a tracking-ref ABA but retains the fetched objects", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "first\n");
    const first = fixture.commit("first");
    fixture.write("README.md", "second\n");
    const head = fixture.commit("second");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    const paused = pauseAfterDiscovery("tracking ABA fetch");
    let fetching: Promise<unknown> | null = null;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("remote.txt", "fetched\n");
      const fetched = fixture.commit("fetched before ABA");
      fetching = fetchInto(workspace.context, repo, { singleBranch: false, tags: false }, "fetch", {
        checkpoint: paused.checkpoint,
      });
      await awaitBarrierEntry(paused.barrier, fetching);

      repo.store.setRef("refs/remotes/origin/main", first);
      repo.store.setRef("refs/remotes/origin/main", head);
      const local = installIndependentLocalState(repo, head, first);
      paused.barrier.release();
      await expect(fetching).rejects.toMatchObject({ code: "ESTALEFETCH" });

      const cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(cold.repo.store.getRef("refs/heads/during-fetch")).toBe(head);
      expect(cold.repo.checkout.indexEntries()).toEqual(local.index);
      expect(cold.repo.checkout.readOperationState()).toEqual(local.journal);
      expect(cold.repo.readCommit(fetched).message).toContain("fetched before ABA");
      assertRepositoryReadable(cold.repo);
    } finally {
      paused.barrier.release();
      if (fetching !== null) await Promise.allSettled([fetching]);
      await server.close();
      fixture.dispose();
    }
  });

  it("retries a lost committed result without duplicating its reflog", async () => {
    const { fixture } = commitFixture("response-loss");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        noTags: true,
      });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("next.txt", "next\n");
      const next = fixture.commit("committed before response loss");
      let lost = false;
      await expect(
        fetchInto(workspace.context, repo, { singleBranch: false, tags: false }, "fetch", {
          checkpoint(stage) {
            if (stage !== "after-ref-publication" || lost) return undefined;
            lost = true;
            return Promise.reject(new Error("simulated lost committed fetch result"));
          },
        }),
      ).rejects.toThrow("simulated lost committed fetch result");
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(next);
      const beforeRetry = completeReflogSnapshot(repo);

      await fetchInto(workspace.context, repo, {
        singleBranch: false,
        tags: false,
      });
      const cold = reopenTestRepository(workspace, "/work");
      expect(completeReflogSnapshot(cold.repo)).toEqual(beforeRetry);
      assertRepositoryReadable(cold.repo);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("releases an interrupted ingest and reclaims it on a clean retry", async () => {
    const { fixture, head } = commitFixture("abort-ingest");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const controller = new AbortController();
    const reason = new Error("stop fetch ingest");
    try {
      await expect(
        fetchInto(
          workspace.context,
          workspace.repo,
          {
            remote: "origin",
            url: server.url,
            singleBranch: false,
            tags: false,
            signal: controller.signal,
          },
          "fetch",
          {
            checkpoint(stage) {
              if (stage === "pack-ingest") controller.abort(reason);
              return undefined;
            },
          },
        ),
      ).rejects.toMatchObject({ code: "EABORTED", cause: reason });
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(workspace.repo.shallow()).toEqual(new Set());
      expect(
        workspace.repo.store.db.all<{ state: string }>(
          "SELECT state FROM git_pack_meta ORDER BY pack_id",
        ),
      ).toEqual([{ state: "pending" }]);

      await fetchInto(workspace.context, workspace.repo, {
        remote: "origin",
        url: server.url,
        singleBranch: false,
        tags: false,
      });
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(
        workspace.repo.store.db.all<{ state: string }>(
          "SELECT state FROM git_pack_meta ORDER BY pack_id",
        ),
      ).toEqual([{ state: "complete" }]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("disposes the fetch token when aborted immediately before publication", async () => {
    const { fixture, head } = commitFixture("abort-publication");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const controller = new AbortController();
    const reason = new Error("stop before fetch publication");
    try {
      await expect(
        fetchInto(
          workspace.context,
          workspace.repo,
          {
            remote: "origin",
            url: server.url,
            singleBranch: false,
            tags: false,
            depth: 1,
            signal: controller.signal,
          },
          "fetch",
          {
            checkpoint(stage) {
              if (stage === "before-ref-publication") controller.abort(reason);
              return undefined;
            },
          },
        ),
      ).rejects.toMatchObject({ code: "EABORTED", cause: reason });
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(workspace.repo.shallow()).toEqual(new Set());

      await fetchInto(workspace.context, workspace.repo, {
        remote: "origin",
        url: server.url,
        singleBranch: false,
        tags: false,
        depth: 1,
      });
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(workspace.repo.shallow()).toEqual(new Set([head]));
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("returns fetch success when cancellation follows synchronous publication", async () => {
    const { fixture, head } = commitFixture("abort-after-publication");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const controller = new AbortController();
    try {
      await expect(
        fetchInto(
          workspace.context,
          workspace.repo,
          {
            remote: "origin",
            url: server.url,
            singleBranch: false,
            tags: false,
            signal: controller.signal,
          },
          "fetch",
          {
            checkpoint(stage) {
              if (stage === "after-ref-publication") {
                controller.abort(new Error("fetch already committed"));
              }
              return undefined;
            },
          },
        ),
      ).resolves.toBeDefined();
      expect(controller.signal.aborted).toBe(true);
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("renegotiates a shallow boundary after response loss before publication", async () => {
    const fixture = new GitFixture().init();
    fixture.write("first.txt", "first\n");
    fixture.commit("shallow first");
    fixture.write("second.txt", "second\n");
    fixture.commit("shallow second");
    fixture.write("third.txt", "third\n");
    const head = fixture.commit("shallow response loss tip");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    let lost = false;
    try {
      await expect(
        fetchInto(
          workspace.context,
          workspace.repo,
          { remote: "origin", url: server.url, singleBranch: false, tags: false, depth: 1 },
          "fetch",
          {
            checkpoint(stage) {
              if (stage !== "after-shallow-response" || lost) return undefined;
              lost = true;
              return Promise.reject(new Error("simulated lost shallow response"));
            },
          },
        ),
      ).rejects.toThrow("simulated lost shallow response");
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(workspace.repo.shallow()).toEqual(new Set());
      expect(workspace.repo.readCommit(head).message).toContain("response loss tip");

      let cold = reopenTestRepository(workspace, "/work");
      await fetchInto(cold.context, cold.repo, {
        remote: "origin",
        url: server.url,
        singleBranch: false,
        tags: false,
        depth: 1,
      });
      cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(cold.repo.shallow()).toEqual(new Set([head]));
      expect([...cold.repo.walk(head)].map((entry) => entry.oid)).toEqual([head]);
      assertRepositoryReadable(cold.repo);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects relative deepening when its captured shallow revision becomes stale", async () => {
    const fixture = new GitFixture().init();
    fixture.write("first.txt", "first\n");
    fixture.commit("first");
    fixture.write("second.txt", "second\n");
    const head = fixture.commit("second");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    try {
      await fetchInto(workspace.context, workspace.repo, {
        remote: "origin",
        url: server.url,
        depth: 1,
        singleBranch: true,
        tags: false,
      });
      const paused = pauseAfterDiscovery("stale relative deepen");
      const deepening = fetchInto(
        workspace.context,
        workspace.repo,
        {
          remote: "origin",
          url: server.url,
          deepen: 1,
          singleBranch: true,
          tags: false,
        },
        "fetch",
        { checkpoint: paused.checkpoint },
      );
      await awaitBarrierEntry(paused.barrier, deepening);
      workspace.repo.store.setShallow([head]);
      paused.barrier.release();
      await expect(deepening).rejects.toMatchObject({ code: "ESTALEFETCH" });
      expect(workspace.repo.shallow()).toEqual(new Set([head]));
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("commutes disjoint namespaces that publish the same tag target", async () => {
    await runPairInBothCompletionOrders(async (order) => {
      const { fixture, head } = commitFixture(`shared-tag-${order}`);
      fixture.git("tag", "release", head);
      const server = await startGitServer(fixture.dir);
      const workspace = makeRepo("/work");
      const origin = pauseAfterDiscovery(`${order} origin shared tag`);
      const upstream = pauseAfterDiscovery(`${order} upstream shared tag`);
      const originFetch = fetchInto(
        workspace.context,
        workspace.repo,
        { remote: "origin", url: server.url, singleBranch: false, tags: true },
        "fetch",
        { checkpoint: origin.checkpoint },
      );
      const upstreamFetch = fetchInto(
        workspace.context,
        workspace.repo,
        { remote: "upstream", url: server.url, singleBranch: false, tags: true },
        "fetch",
        { checkpoint: upstream.checkpoint },
      );
      try {
        await Promise.all([
          awaitBarrierEntry(origin.barrier, originFetch),
          awaitBarrierEntry(upstream.barrier, upstreamFetch),
        ]);
        if (order === "left-first") {
          origin.barrier.release();
          await expect(originFetch).resolves.toBeDefined();
          upstream.barrier.release();
          await expect(upstreamFetch).resolves.toBeDefined();
        } else {
          upstream.barrier.release();
          await expect(upstreamFetch).resolves.toBeDefined();
          origin.barrier.release();
          await expect(originFetch).resolves.toBeDefined();
        }
        expect(workspace.repo.store.getRef("refs/tags/release")).toBe(head);
        expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
        expect(workspace.repo.store.getRef("refs/remotes/upstream/main")).toBe(head);
        expect(
          workspace.repo.store.db.all<{
            ref_name: string;
            old_raw: string | null;
            new_raw: string;
          }>("SELECT ref_name, old_raw, new_raw FROM git_reflog_entries ORDER BY ordinal"),
        ).toContainEqual({ ref_name: "refs/tags/release", old_raw: null, new_raw: head });
        assertRepositoryReadable(reopenTestRepository(workspace, "/work").repo);
      } finally {
        origin.barrier.release();
        upstream.barrier.release();
        await Promise.allSettled([originFetch, upstreamFetch]);
        await server.close();
        fixture.dispose();
      }
    });
  });

  it("retries an auto-follow tag conflict without clobbering the local tag", async () => {
    const { fixture, head } = commitFixture("auto-tag-conflict");
    fixture.git("tag", "release", head);
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const paused = pauseAfterDiscovery("auto tag local creation");
    const fetching = fetchInto(
      workspace.context,
      workspace.repo,
      { remote: "origin", url: server.url, singleBranch: false },
      "fetch",
      { checkpoint: paused.checkpoint },
    );
    try {
      await awaitBarrierEntry(paused.barrier, fetching);
      const localTag = workspace.repo.store.write(
        "blob",
        new TextEncoder().encode("local tag target\n"),
      );
      workspace.repo.store.setRef("refs/tags/release", localTag);
      paused.barrier.release();
      await expect(fetching).rejects.toMatchObject({ code: "ESTALEFETCH" });

      let cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/tags/release")).toBe(localTag);
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(cold.repo.readCommit(head).message).toContain("auto-tag-conflict");

      await fetchInto(cold.context, cold.repo, {
        remote: "origin",
        url: server.url,
        singleBranch: false,
      });
      cold = reopenTestRepository(workspace, "/work");
      expect(cold.repo.store.getRef("refs/tags/release")).toBe(localTag);
      expect(cold.repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      assertRepositoryReadable(cold.repo);
    } finally {
      paused.barrier.release();
      await Promise.allSettled([fetching]);
      await server.close();
      fixture.dispose();
    }
  });

  it("serializes shallow deltas from disjoint remotes in both completion orders", async () => {
    await runPairInBothCompletionOrders(async (order) => {
      const left = commitFixture(`left-shallow-base-${order}`);
      left.fixture.write("left-second.txt", "left second\n");
      left.fixture.commit("left shallow middle");
      left.fixture.write("left-third.txt", "left third\n");
      const leftHead = left.fixture.commit("left shallow tip");
      const right = commitFixture(`right-shallow-base-${order}`);
      right.fixture.write("right-second.txt", "right second\n");
      right.fixture.commit("right shallow middle");
      right.fixture.write("right-third.txt", "right third\n");
      const rightHead = right.fixture.commit("right shallow tip");
      const leftServer = await startGitServer(left.fixture.dir);
      const rightServer = await startGitServer(right.fixture.dir);
      const workspace = makeRepo("/work");
      const leftPause = pauseAfterDiscovery(`${order} left shallow fetch`);
      const rightPause = pauseAfterDiscovery(`${order} right shallow fetch`);
      const leftFetch = fetchInto(
        workspace.context,
        workspace.repo,
        {
          remote: "origin",
          url: leftServer.url,
          singleBranch: false,
          tags: false,
          depth: 1,
        },
        "fetch",
        { checkpoint: leftPause.checkpoint },
      );
      const rightFetch = fetchInto(
        workspace.context,
        workspace.repo,
        {
          remote: "upstream",
          url: rightServer.url,
          singleBranch: false,
          tags: false,
          depth: 1,
        },
        "fetch",
        { checkpoint: rightPause.checkpoint },
      );
      try {
        await Promise.all([
          awaitBarrierEntry(leftPause.barrier, leftFetch),
          awaitBarrierEntry(rightPause.barrier, rightFetch),
        ]);
        if (order === "left-first") {
          leftPause.barrier.release();
          await expect(leftFetch).resolves.toBeDefined();
          rightPause.barrier.release();
          await expect(rightFetch).rejects.toMatchObject({ code: "ESTALEFETCH" });
        } else {
          rightPause.barrier.release();
          await expect(rightFetch).resolves.toBeDefined();
          leftPause.barrier.release();
          await expect(leftFetch).rejects.toMatchObject({ code: "ESTALEFETCH" });
        }
        const winnerRemote = order === "left-first" ? "origin" : "upstream";
        const loserRemote = order === "left-first" ? "upstream" : "origin";
        const winner = order === "left-first" ? leftHead : rightHead;
        const loser = order === "left-first" ? rightHead : leftHead;
        const cold = reopenTestRepository(workspace, "/work");
        expect(cold.repo.store.getRef(`refs/remotes/${winnerRemote}/main`)).toBe(winner);
        expect(cold.repo.store.getRef(`refs/remotes/${loserRemote}/main`)).toBeNull();
        expect(cold.repo.shallow()).toEqual(new Set([winner]));
        expect(cold.repo.readCommit(loser).message).toContain("shallow tip");
        assertRepositoryReadable(cold.repo);
      } finally {
        leftPause.barrier.release();
        rightPause.barrier.release();
        await Promise.allSettled([leftFetch, rightFetch]);
        await leftServer.close();
        await rightServer.close();
        left.fixture.dispose();
        right.fixture.dispose();
      }
    });
  });

  it("uses exact CAS for conflicting same-name tags from different remotes", async () => {
    await runPairInBothCompletionOrders(async (order) => {
      const left = commitFixture(`left-tag-${order}`);
      const right = commitFixture(`right-tag-${order}`);
      left.fixture.git("tag", "release", left.head);
      right.fixture.git("tag", "release", right.head);
      const leftServer = await startGitServer(left.fixture.dir);
      const rightServer = await startGitServer(right.fixture.dir);
      const workspace = makeRepo("/work");
      const leftPause = pauseAfterDiscovery(`${order} left conflicting tag`);
      const rightPause = pauseAfterDiscovery(`${order} right conflicting tag`);
      const leftFetch = fetchInto(
        workspace.context,
        workspace.repo,
        { remote: "origin", url: leftServer.url, singleBranch: false, tags: true },
        "fetch",
        { checkpoint: leftPause.checkpoint },
      );
      const rightFetch = fetchInto(
        workspace.context,
        workspace.repo,
        { remote: "upstream", url: rightServer.url, singleBranch: false, tags: true },
        "fetch",
        { checkpoint: rightPause.checkpoint },
      );
      try {
        await Promise.all([
          awaitBarrierEntry(leftPause.barrier, leftFetch),
          awaitBarrierEntry(rightPause.barrier, rightFetch),
        ]);
        if (order === "left-first") {
          leftPause.barrier.release();
          await expect(leftFetch).resolves.toBeDefined();
          rightPause.barrier.release();
          await expect(rightFetch).rejects.toMatchObject({ code: "ESTALEFETCH" });
        } else {
          rightPause.barrier.release();
          await expect(rightFetch).resolves.toBeDefined();
          leftPause.barrier.release();
          await expect(leftFetch).rejects.toMatchObject({ code: "ESTALEFETCH" });
        }
        const winner = order === "left-first" ? left.head : right.head;
        const loser = order === "left-first" ? right.head : left.head;
        const winnerRemote = order === "left-first" ? "origin" : "upstream";
        const loserRemote = order === "left-first" ? "upstream" : "origin";
        const cold = reopenTestRepository(workspace, "/work");
        expect(cold.repo.store.getRef("refs/tags/release")).toBe(winner);
        expect(cold.repo.store.getRef(`refs/remotes/${winnerRemote}/main`)).toBe(winner);
        expect(cold.repo.store.getRef(`refs/remotes/${loserRemote}/main`)).toBeNull();
        expect(cold.repo.readCommit(loser).message).toContain("tag");
        assertRepositoryReadable(cold.repo);
      } finally {
        leftPause.barrier.release();
        rightPause.barrier.release();
        await Promise.allSettled([leftFetch, rightFetch]);
        await leftServer.close();
        await rightServer.close();
        left.fixture.dispose();
        right.fixture.dispose();
      }
    });
  });

  it("fences a linked checkout that attaches after mapped branch preflight", async () => {
    const fixture = new GitFixture().init();
    fixture.write("tracked.txt", "tracked\n");
    const tip = fixture.commit("mapped checkout fence");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    const mapping = {
      source: "refs/heads/main",
      destination: "refs/heads/topic",
    };
    const paused = pauseAfterDiscovery("mapped checkout ABA");
    try {
      await fetchInto(workspace.context, workspace.repo, {
        url: server.url,
        refspecs: [mapping],
      });
      const pending = fetchInto(
        workspace.context,
        workspace.repo,
        { url: server.url, refspecs: [mapping] },
        "fetch",
        { checkpoint: paused.checkpoint },
      );
      await awaitBarrierEntry(paused.barrier, pending);
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/linked",
        target: { kind: "existing-branch", name: "topic" },
      });
      paused.barrier.release();

      await expect(pending).rejects.toMatchObject({ code: "ESTALEFETCH" });
      expect(workspace.repo.store.getRef(mapping.destination)).toBe(tip);
    } finally {
      paused.barrier.release();
      await server.close();
      fixture.dispose();
    }
  });
});
