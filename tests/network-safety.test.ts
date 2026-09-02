import { describe, expect, it } from "vitest";

import {
  createGit,
  type GitFetchOptions,
  type GitPushOptions,
  type PushLeaseExpectation,
} from "../src/git/index.js";
import {
  fetchHttpClient,
  type GitHttpClient,
  type GitHttpRequest,
} from "../src/git/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeRepo, makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };

function gitFor(workspace: TestWorkspace, http: GitHttpClient) {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
    http,
  });
}

/** Rewrite one negotiated `want`, so the server answers with a pack that omits the tip. */
function substituteWant(
  request: GitHttpRequest,
  wanted: string,
  replacement: string,
): GitHttpRequest {
  if (request.method !== "POST" || !(request.body instanceof Uint8Array)) return request;
  const text = new TextDecoder().decode(request.body);
  if (!text.includes(wanted)) return request;
  return { ...request, body: new TextEncoder().encode(text.split(wanted).join(replacement)) };
}

describe("native network safety", () => {
  it("deepens safely and requires fresh leases for a multi-ref force push", async () => {
    const fixture = new GitFixture().init();
    const commits: string[] = [];
    for (let index = 0; index < 4; index++) {
      fixture.write(`history-${index}.txt`, `${index}\n`);
      commits.push(fixture.commit(`history ${index}`));
    }
    const clonedTip = commits[3];
    if (clonedTip === undefined) throw new Error("fixture tip is missing");
    fixture.git("branch", "topic", clonedTip);
    fixture.git("config", "receive.denyCurrentBranch", "updateInstead");

    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let deepenAbort: { controller: AbortController; reason: Error } | null = null;
    const http: GitHttpClient = async (request) => {
      const response = await fetchHttpClient(request);
      const pending = deepenAbort;
      if (pending !== null && request.method === "POST") {
        deepenAbort = null;
        pending.controller.abort(pending.reason);
      }
      return response;
    };
    const git = createGit()({
      database: workspace.database,
      worktree: workspace.worktree,
      now: workspace.context.now,
      timezoneOffset: workspace.context.timezoneOffset,
      defaultIdentity: IDENTITY,
      http,
    });
    const dir = "/repo";

    try {
      await git.clone({ url: server.url, dir, depth: 1, singleBranch: false });
      await expect(git.log({ dir })).resolves.toHaveLength(1);
      await git.branch({ dir, name: "topic", startPoint: "refs/remotes/origin/topic" });

      const controller = new AbortController();
      const reason = new Error("cancel deepen");
      deepenAbort = { controller, reason };
      const postsBeforeAbort = server.requests.filter(
        (request) => request.method === "POST",
      ).length;
      const cancelledDeepen: GitFetchOptions = {
        dir,
        remote: "origin",
        deepen: 1,
        singleBranch: true,
        tags: false,
        signal: controller.signal,
      };
      await expect(git.fetch(cancelledDeepen)).rejects.toMatchObject({
        code: "EABORTED",
        cause: reason,
      });
      expect(controller.signal.aborted).toBe(true);
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBeforeAbort + 1,
      );
      await expect(git.log({ dir })).resolves.toHaveLength(1);

      await git.fetch({
        dir,
        remote: "origin",
        deepen: 1,
        singleBranch: true,
        tags: false,
      });
      await expect(git.log({ dir })).resolves.toHaveLength(2);

      await git.fetch({
        dir,
        remote: "origin",
        unshallow: true,
        singleBranch: true,
        tags: false,
      });
      await expect(git.log({ dir })).resolves.toHaveLength(commits.length);

      fixture.git("checkout", "-q", "topic");
      fixture.write("topic.txt", "remote topic\n");
      const remoteTopic = fixture.commit("remote topic");
      fixture.git("checkout", "-q", "main");
      fixture.write("main.txt", "remote main\n");
      const remoteMain = fixture.commit("remote main");

      const mappings: GitPushOptions["refspecs"] = [
        {
          source: "refs/heads/main",
          destination: "refs/heads/main",
          force: true,
        },
        {
          source: "refs/heads/topic",
          destination: "refs/heads/topic",
          force: true,
        },
      ];
      const staleMain: PushLeaseExpectation = { expected: clonedTip };
      const staleTopic: PushLeaseExpectation = { expected: clonedTip };
      const postsBeforeStale = server.requests.filter(
        (request) => request.method === "POST",
      ).length;
      await expect(
        git.push({
          dir,
          remote: "origin",
          refspecs: mappings,
          leases: { main: staleMain, topic: staleTopic },
        }),
      ).rejects.toMatchObject({ code: "ESTALELEASE" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBeforeStale,
      );
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(remoteMain);
      expect(fixture.git("rev-parse", "refs/heads/topic")).toBe(remoteTopic);

      const advertised = await git.lsRemote({
        dir,
        remote: "origin",
        patterns: ["refs/heads/main", "refs/heads/topic"],
      });
      const refreshedMain = advertised.refs.find((ref) => ref.name === "refs/heads/main");
      const refreshedTopic = advertised.refs.find((ref) => ref.name === "refs/heads/topic");
      if (refreshedMain === undefined || refreshedTopic === undefined) {
        throw new Error("refreshed lease targets are missing");
      }

      await expect(
        git.push({
          dir,
          remote: "origin",
          refspecs: mappings,
          leases: {
            main: { expected: refreshedMain.oid },
            topic: { expected: refreshedTopic.oid },
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        refs: [
          { ref: "refs/heads/main", ok: true, error: null },
          { ref: "refs/heads/topic", ok: true, error: null },
        ],
      });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBeforeStale + 1,
      );
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(clonedTip);
      expect(fixture.git("rev-parse", "refs/heads/topic")).toBe(clonedTip);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("publishes no tracking ref when the pack omits an advertised tip", async () => {
    const fixture = new GitFixture().init();
    fixture.write("base.txt", "base\n");
    const base = fixture.commit("base");
    fixture.write("tip.txt", "tip\n");
    const tip = fixture.commit("tip");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    workspace.repo.store.configSet("remote.origin.url", server.url);
    let omitTip = true;
    const git = gitFor(workspace, (request) =>
      fetchHttpClient(omitTip ? substituteWant(request, tip, base) : request),
    );

    try {
      await expect(
        git.fetch({ dir: "/work", remote: "origin", tags: false }),
      ).rejects.toMatchObject({ code: "EFETCHFAIL" });
      expect(workspace.repo.store.missing([tip])).toEqual([tip]);
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(workspace.repo.store.getRef("refs/remotes/origin/HEAD")).toBeNull();
      expect(workspace.repo.readCommit(base).message).toContain("base");

      omitTip = false;
      await git.fetch({ dir: "/work", remote: "origin", tags: false });
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBe(tip);
      expect(workspace.repo.store.getRef("refs/remotes/origin/HEAD")).toBe(
        "ref: refs/remotes/origin/main",
      );
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});
