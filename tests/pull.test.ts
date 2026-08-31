import { join } from "node:path";
import type { GitPullOptions as ComputerPullOptions } from "@cloudflare/computer/git";
import { describe, expect, it } from "vitest";
import { openRepository } from "../src/core/context.js";
import { commit } from "../src/core/ops/commit.js";
import type { MergeStateMetadata } from "../src/core/ops/merge-state.js";
import { pull as pullCore, resolvePull, validatePullAfterFetch } from "../src/core/ops/pull.js";
import { fetchHttpClient, type GitHttpClient } from "../src/core/protocol/transport.js";
import type { Repository } from "../src/core/repository.js";
import { createGit, type Git, type GitPullOptions } from "../src/git/client.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import {
  makeRepo,
  makeWorkspace,
  type TestRepository,
  type TestWorkspace,
} from "./helpers/workspace.js";

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };
const REFLOG_TIME = 1_577_836_800_000;
const compatibilityPullOptions: ComputerPullOptions = {};
const nativePullOptions: GitPullOptions = compatibilityPullOptions;
void nativePullOptions;

function committedRepo(): TestRepository {
  const workspace = makeRepo();
  commit(workspace.context, workspace.repo, {
    message: "base",
    author: IDENTITY,
    committer: IDENTITY,
    allowEmpty: true,
  });
  return workspace;
}

function configureUpstream(workspace: TestRepository): void {
  workspace.repo.store.configSet("branch.main.remote", "origin");
  workspace.repo.store.configSet("branch.main.merge", "refs/heads/main");
  workspace.repo.store.configSet("remote.origin.url", "https://example.com/repo.git");
}

function pullPublicationCount(repo: Repository): number {
  return (
    repo.store.db.scalar<number>(
      "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ? AND reason LIKE 'pull:%'",
      repo.store.repoId,
    ) ?? 0
  );
}

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

function reopenedGit(workspace: TestWorkspace): Git {
  return createGit()({
    database: new SqliteGitDatabase(new TestDatabase(workspace.storage), {
      now: workspace.context.now,
    }),
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
  });
}

function remoteFixture(): { fixture: GitFixture; base: string } {
  const fixture = new GitFixture().init();
  fixture.write("base.txt", "base\n");
  return { fixture, base: fixture.commit("base") };
}

function discoveryBarrier(): {
  http: GitHttpClient;
  block: () => void;
  entered: Promise<void>;
  release: () => void;
} {
  let blocked = false;
  let enterDiscovery = (): void => {};
  let releaseDiscovery = (): void => {};
  const entered = new Promise<void>((resolve) => {
    enterDiscovery = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  return {
    async http(request) {
      if (blocked && request.method === "GET") {
        enterDiscovery();
        await released;
      }
      return fetchHttpClient(request);
    },
    block() {
      blocked = true;
    },
    entered,
    release() {
      releaseDiscovery();
    },
  };
}

describe("pull", () => {
  it("resolves the checked-out branch and its configured upstream", () => {
    const workspace = committedRepo();
    configureUpstream(workspace);

    expect(resolvePull(workspace.repo)).toEqual({
      headRef: "refs/heads/main",
      headOid: workspace.repo.head().oid,
      branch: "main",
      remote: "origin",
      url: "https://example.com/repo.git",
      displayUrl: "https://example.com/repo.git",
      remoteRef: "refs/heads/main",
      remoteBranch: "main",
      fetchRefspec: "+refs/heads/*:refs/remotes/origin/*",
      fetchSingleBranch: false,
      fetchAutoTags: true,
    });
  });

  it("applies explicit target and fast-forward options over configuration", () => {
    const workspace = committedRepo();
    configureUpstream(workspace);
    workspace.repo.store.configSet("branch.main.remote", "bad..remote");
    workspace.repo.store.configSet("branch.main.merge", "refs/tags/nope");
    workspace.repo.store.configSet("remote.upstream.url", "https://example.com/repo.git");
    workspace.repo.store.configSet("pull.ff", "only");

    expect(
      resolvePull(workspace.repo, {
        remote: "upstream",
        ref: "main",
        remoteRef: "topic",
        fastForward: false,
        fastForwardOnly: false,
      }),
    ).toMatchObject({
      remote: "upstream",
      url: "https://example.com/repo.git",
      remoteRef: "refs/heads/topic",
      remoteBranch: "topic",
      fetchRefspec: "refs/heads/topic",
      fetchSingleBranch: true,
      fetchAutoTags: false,
      fastForward: false,
      fastForwardOnly: false,
    });
  });

  it("lets singleBranch explicitly choose exact or canonical pull coverage", () => {
    const workspace = committedRepo();
    configureUpstream(workspace);

    expect(resolvePull(workspace.repo, { singleBranch: true })).toMatchObject({
      fetchRefspec: "refs/heads/main",
      fetchSingleBranch: true,
      fetchAutoTags: true,
    });
    expect(
      resolvePull(workspace.repo, {
        remoteRef: "topic",
        singleBranch: false,
      }),
    ).toMatchObject({
      remoteRef: "refs/heads/topic",
      fetchRefspec: "+refs/heads/*:refs/remotes/origin/*",
      fetchSingleBranch: false,
      fetchAutoTags: true,
    });
  });

  it("rejects a configured fetch refspec outside the canonical pull coverage", () => {
    const workspace = committedRepo();
    configureUpstream(workspace);
    workspace.repo.store.configSet(
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main",
    );

    expect(() => resolvePull(workspace.repo)).toThrowError(
      expect.objectContaining({ code: "EUNSUPPORTED" }),
    );
    expect(() => resolvePull(workspace.repo, { singleBranch: true })).not.toThrow();
  });

  it("uses the configured tracking namespace when an explicit URL overrides transport", () => {
    const workspace = committedRepo();
    workspace.repo.store.configSet("branch.main.remote", "upstream");
    workspace.repo.store.configSet("branch.main.merge", "refs/heads/main");

    expect(
      resolvePull(workspace.repo, {
        url: "https://user:secret@example.com/repo.git?token=secret#fragment",
      }),
    ).toMatchObject({
      remote: "upstream",
      url: "https://user:secret@example.com/repo.git?token=secret#fragment",
      displayUrl: "https://example.com/repo.git",
    });
  });

  it.each([
    ["true", { fastForward: true }],
    ["false", { fastForward: false }],
    ["only", { fastForwardOnly: true }],
  ])("reads pull.ff=%s", (value, expected) => {
    const workspace = committedRepo();
    configureUpstream(workspace);
    workspace.repo.store.configSet("pull.ff", value);

    expect(resolvePull(workspace.repo)).toMatchObject(expected);
  });

  it("rejects detached, unborn, and inactive local branches", () => {
    const unborn = makeRepo();
    expect(() => resolvePull(unborn.repo)).toThrowError(
      expect.objectContaining({ code: "ENOCOMMIT" }),
    );

    const detached = committedRepo();
    const oid = detached.repo.head().oid;
    if (oid === null) throw new Error("fixture did not create HEAD");
    detached.repo.checkout.setHead(oid);
    expect(() => resolvePull(detached.repo)).toThrowError(
      expect.objectContaining({ code: "EDETACHED" }),
    );

    const wrong = committedRepo();
    configureUpstream(wrong);
    expect(() => resolvePull(wrong.repo, { ref: "topic" })).toThrowError(
      expect.objectContaining({ code: "EWRONGHEAD" }),
    );
  });

  it("accepts a long raw HEAD through preflight and unchanged post-fetch validation", () => {
    const ref = `refs/heads/${"h".repeat(1_000_001)}`;
    const rawHead = `ref: ${ref}`;
    const prepare = (): { repo: Repository; durableHead: string; durableRefs: unknown[] } => {
      const workspace = committedRepo();
      const oid = workspace.repo.store.getRef("refs/heads/main");
      if (oid === null) throw new Error("long pull HEAD fixture is missing main");
      workspace.repo.store.db.run(
        "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?)",
        workspace.repo.store.repoId,
        ref,
        oid,
      );
      workspace.repo.store.db.run(
        "UPDATE git_checkouts SET head = ? WHERE id = ?",
        rawHead,
        workspace.repo.checkout.checkoutId,
      );
      const database = new SqliteGitDatabase(new TestDatabase(workspace.storage));
      const context = { ...workspace.context, database };
      const repo = openRepository(context, "/");
      return {
        repo,
        durableHead: repo.checkout.head(),
        durableRefs: repo.store.db.all<Record<string, unknown>>(
          "SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
          repo.store.repoId,
        ),
      };
    };
    const prepared = prepare();
    const options = {
      remote: "origin",
      remoteRef: "main",
      url: "https://example.com/repo.git",
    };
    const plan = resolvePull(prepared.repo, options);
    expect(plan.headRef).toBe(ref);
    expect(() => validatePullAfterFetch(prepared.repo, options, plan)).not.toThrow();
    expect(prepared.repo.checkout.head()).toBe(prepared.durableHead);
    expect(
      prepared.repo.store.db.all<Record<string, unknown>>(
        "SELECT name, target FROM git_refs WHERE repo_id = ? ORDER BY name",
        prepared.repo.store.repoId,
      ),
    ).toEqual(prepared.durableRefs);
  });

  describe("pull orchestration", () => {
    it("rechecks a long canonical HEAD with the pull owner after fetch", async () => {
      const { fixture } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        await gitFor(workspace).clone({ url: server.url, dir: "/work", depth: 0 });
        const database = new SqliteGitDatabase(new TestDatabase(workspace.storage));
        const context = { ...workspace.context, database };
        const baseRepo = openRepository(context, "/work");
        const base = baseRepo.store.getRef("refs/heads/main");
        if (base === null) throw new Error("long post-fetch HEAD fixture is missing main");
        const ref = `refs/heads/${"h".repeat(1_013)}`;
        baseRepo.store.db.run(
          "INSERT INTO git_refs (repo_id, name, target) VALUES (?, ?, ?)",
          baseRepo.store.repoId,
          ref,
          base,
        );
        baseRepo.store.db.run(
          "UPDATE git_checkouts SET head = ? WHERE id = ?",
          `ref: ${ref}`,
          baseRepo.checkout.checkoutId,
        );
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");
        await expect(
          pullCore(context, baseRepo, workspace.worktree, {
            remote: "origin",
            remoteRef: "main",
            url: server.url,
          }),
        ).resolves.toEqual({ oid: incoming, fastForward: true });
        expect(baseRepo.head()).toEqual({ ref, oid: incoming });
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("rejects public preflight failures before making an HTTP request", async () => {
      const workspace = committedRepo();
      configureUpstream(workspace);
      const originalHead = workspace.repo.head();
      let requests = 0;
      const http: GitHttpClient = async () => {
        requests++;
        throw new Error("preflight unexpectedly reached HTTP");
      };

      await expect(gitFor(workspace, http).pull({ ref: "topic" })).rejects.toMatchObject({
        code: "EWRONGHEAD",
      });
      expect(requests).toBe(0);
      expect(workspace.repo.head()).toEqual(originalHead);
      expect(workspace.repo.checkout.readMergeState()).toBeNull();
    });

    it("rejects a malformed URL before making an HTTP request", async () => {
      const workspace = committedRepo();
      configureUpstream(workspace);
      workspace.repo.store.configSet("remote.origin.url", "https://?token=secret");
      let requests = 0;
      const http: GitHttpClient = async () => {
        requests++;
        throw new Error("invalid URL unexpectedly reached HTTP");
      };

      await expect(gitFor(workspace, http).pull()).rejects.toMatchObject({
        code: "EINVAL",
        message: "pull URL is invalid",
      });
      expect(requests).toBe(0);
    });

    it("fetches and fast-forwards the checked-out branch", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        const repo = openRepository(workspace.context, "/work");
        const branchEntries = repo.store.reflog("refs/heads/main").length;
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");
        workspace.storage.resetCounters();

        await expect(git.pull({ dir: "/work" })).resolves.toEqual({
          oid: incoming,
          fastForward: true,
        });

        expect(base).not.toBe(incoming);
        expect(repo.head().oid).toBe(incoming);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          oldOid: base,
          newOid: incoming,
          actor: IDENTITY,
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
          reason: "fetch",
        });
        expect(repo.store.reflog("refs/heads/main")).toHaveLength(branchEntries + 1);
        expect(repo.store.reflog("refs/heads/main")[0]).toMatchObject({
          oldOid: base,
          newOid: incoming,
          actor: IDENTITY,
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
          reason: "pull: fast-forward",
        });
        expect(repo.checkout.reflog("HEAD")[0]).toMatchObject({
          oldOid: base,
          newOid: incoming,
          reason: "pull: fast-forward",
        });
        expect(await workspace.workspace.fs.readFile("/work/remote.txt", "utf8")).toBe("remote\n");
        expect(workspace.storage.statementCount).toBeLessThan(1_000);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("updates canonical side refs and tags while integrating only its upstream", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        const repo = openRepository(workspace.context, "/work");

        fixture.git("checkout", "-q", "-b", "topic", base);
        fixture.write("topic.txt", "topic\n");
        const topic = fixture.commit("topic");
        fixture.git("tag", "topic-light");
        fixture.git("tag", "-a", "topic-annotated", "-m", "topic");
        fixture.git("checkout", "-q", "main");
        fixture.write("main.txt", "main\n");
        const remoteMain = fixture.commit("main");
        fixture.git("branch", "side");
        repo.store.configSet("branch.main.merge", "refs/heads/topic");

        await expect(git.pull({ dir: "/work" })).resolves.toEqual({
          oid: topic,
          fastForward: true,
        });

        expect(repo.head().oid).toBe(topic);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(remoteMain);
        expect(repo.store.getRef("refs/remotes/origin/side")).toBe(remoteMain);
        expect(repo.store.getRef("refs/remotes/origin/topic")).toBe(topic);
        expect(repo.store.getRef("refs/tags/topic-light")).toBe(topic);
        const annotated = repo.store.getRef("refs/tags/topic-annotated");
        if (annotated === null) throw new Error("pull omitted the annotated tag");
        expect(repo.peel(annotated)).toBe(topic);
        expect(await workspace.workspace.fs.readFile("/work/topic.txt", "utf8")).toBe("topic\n");
        expect(workspace.worktree.stat("/work/main.txt")).toBeNull();
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("keeps configured single-branch pull coverage bounded to its upstream", async () => {
      const { fixture } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        const repo = openRepository(workspace.context, "/work");
        fixture.git("branch", "side");
        fixture.write("main.txt", "main\n");
        const incoming = fixture.commit("main");
        fixture.git("tag", "main-tag");

        await git.pull({ dir: "/work", singleBranch: true });

        expect(repo.head().oid).toBe(incoming);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.store.getRef("refs/remotes/origin/side")).toBeNull();
        expect(repo.store.getRef("refs/tags/main-tag")).toBe(incoming);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("keeps remote names independent from an explicit transport URL", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        const repo = openRepository(workspace.context, "/work");
        repo.store.configSet("branch.main.remote", "upstream");
        fixture.write("first.txt", "first\n");
        const first = fixture.commit("first");

        await git.pull({ dir: "/work", url: server.url });
        expect(repo.store.getRef("refs/remotes/upstream/main")).toBe(first);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(base);

        fixture.write("second.txt", "second\n");
        const second = fixture.commit("second");
        await git.pull({ dir: "/work", remote: "mirror", url: server.url });
        expect(repo.store.getRef("refs/remotes/mirror/main")).toBe(second);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("forwards authentication and remote progress through pull", async () => {
      const { fixture } = remoteFixture();
      const server = await startGitServer(fixture.dir, { requireAuth: true });
      const workspace = makeWorkspace();
      let authCalls = 0;
      const onAuth = () => {
        authCalls++;
        return { username: "fixture", password: "secret" };
      };
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0, onAuth });
        fixture.write("remote.txt", "remote\n");
        fixture.commit("remote");
        const phases: string[] = [];
        const messages: string[] = [];

        await git.pull({
          dir: "/work",
          onAuth,
          onProgress: (event) => phases.push(event.phase),
          onMessage: (message) => messages.push(message),
        });

        expect(authCalls).toBeGreaterThanOrEqual(2);
        expect(phases.length).toBeGreaterThan(0);
        expect(messages.length).toBeGreaterThan(0);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("creates a two-parent merge for clean divergence", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
        await git.add({ dir: "/work", paths: ["local.txt"] });
        const local = await git.commit({ dir: "/work", message: "local" });
        const repo = openRepository(workspace.context, "/work");
        const branchEntries = repo.store.reflog("refs/heads/main").length;
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");

        const result = await git.pull({ dir: "/work" });
        if (result.oid === undefined) throw new Error("pull did not create a merge commit");

        const merged = repo.readCommit(result.oid);
        expect(merged.parent).toEqual([local.oid, incoming]);
        expect(merged.message).toBe(`Merge branch 'main' of ${server.url}\n`);
        expect(repo.head().oid).toBe(result.oid);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          oldOid: base,
          newOid: incoming,
          actor: IDENTITY,
          reason: "fetch",
        });
        expect(repo.store.reflog("refs/heads/main")).toHaveLength(branchEntries + 1);
        expect(repo.store.reflog("refs/heads/main")[0]).toMatchObject({
          oldOid: local.oid,
          newOid: result.oid,
          actor: IDENTITY,
          timestamp: 1_577_836_800,
          timezoneOffset: 0,
          reason: "pull: merge",
        });
        expect(repo.checkout.reflog("HEAD")[0]).toMatchObject({
          oldOid: local.oid,
          newOid: result.oid,
          reason: "pull: merge",
        });
        expect(await workspace.workspace.fs.readFile("/work/local.txt", "utf8")).toBe("local\n");
        expect(await workspace.workspace.fs.readFile("/work/remote.txt", "utf8")).toBe("remote\n");
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("matches real Git for a clean divergent pull with a pinned message", async () => {
      const { fixture } = remoteFixture();
      const expectedRoot = new GitFixture();
      expectedRoot.git("clone", "-q", fixture.dir, "expected");
      const expected = new GitFixture(join(expectedRoot.dir, "expected"));
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });

        await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
        await git.add({ dir: "/work", paths: ["local.txt"] });
        const local = await git.commit({ dir: "/work", message: "local" });
        expected.write("local.txt", "local\n");
        expect(expected.commit("local")).toBe(local.oid);

        fixture.write("remote.txt", "remote\n");
        fixture.commit("remote");
        expected.git("pull", "-q", "--no-rebase", "--no-commit");
        const expectedOid = expected.commit("pull merge");

        await expect(git.pull({ dir: "/work", message: "pull merge" })).resolves.toEqual({
          oid: expectedOid,
        });
        expect(await workspace.workspace.fs.readFile("/work/local.txt", "utf8")).toBe(
          `${expected.git("show", "HEAD:local.txt")}\n`,
        );
        expect(await workspace.workspace.fs.readFile("/work/remote.txt", "utf8")).toBe(
          `${expected.git("show", "HEAD:remote.txt")}\n`,
        );
      } finally {
        await server.close();
        expectedRoot.dispose();
        fixture.dispose();
      }
    });

    it("reports up-to-date and local-ahead pulls without moving HEAD", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        await expect(git.pull({ dir: "/work" })).resolves.toEqual({
          oid: base,
          alreadyMerged: true,
        });

        await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
        await git.add({ dir: "/work", paths: ["local.txt"] });
        const local = await git.commit({ dir: "/work", message: "local" });
        await expect(git.pull({ dir: "/work" })).resolves.toEqual({
          oid: local.oid,
          alreadyMerged: true,
        });
        expect(openRepository(workspace.context, "/work").head().oid).toBe(local.oid);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("honors pull.ff=false by forcing a merge commit over a fast-forward", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace();
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        const repo = openRepository(workspace.context, "/work");
        repo.store.configSet("pull.ff", "false");
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");

        const result = await git.pull({ dir: "/work" });
        if (result.oid === undefined) throw new Error("forced pull returned no merge commit");
        expect(result.fastForward).toBeUndefined();
        expect(repo.readCommit(result.oid).parent).toEqual([base, incoming]);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("retains fetched state when a touched worktree file is dirty", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        const repo = openRepository(workspace.context, "/work");
        const branchEntries = repo.store.reflog("refs/heads/main").length;
        const headEntries = repo.checkout.reflog("HEAD").length;
        await workspace.workspace.fs.writeFile("/work/base.txt", "dirty\n");
        fixture.write("base.txt", "incoming\n");
        const incoming = fixture.commit("remote");

        await expect(git.pull({ dir: "/work" })).rejects.toMatchObject({
          code: "ECHECKOUTFAIL",
        });
        expect(repo.head().oid).toBe(base);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(await workspace.workspace.fs.readFile("/work/base.txt", "utf8")).toBe("dirty\n");
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          oldOid: base,
          newOid: incoming,
          reason: "fetch",
        });
        expect(repo.store.reflog("refs/heads/main")).toHaveLength(branchEntries);
        expect(repo.checkout.reflog("HEAD")).toHaveLength(headEntries);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("retains fetched state when fast-forward-only rejects divergence", async () => {
      const { fixture } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      try {
        const git = gitFor(workspace);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
        await git.add({ dir: "/work", paths: ["local.txt"] });
        const local = await git.commit({ dir: "/work", message: "local" });
        const repo = openRepository(workspace.context, "/work");
        const branchEntries = repo.store.reflog("refs/heads/main").length;
        const headEntries = repo.checkout.reflog("HEAD").length;
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");

        await expect(git.pull({ dir: "/work", fastForwardOnly: true })).rejects.toMatchObject({
          code: "ENONFF",
        });

        expect(repo.head().oid).toBe(local.oid);
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.checkout.readMergeState()).toBeNull();
        expect(await workspace.workspace.fs.readFile("/work/local.txt", "utf8")).toBe("local\n");
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          newOid: incoming,
          reason: "fetch",
        });
        expect(repo.store.reflog("refs/heads/main")).toHaveLength(branchEntries);
        expect(repo.checkout.reflog("HEAD")).toHaveLength(headEntries);
      } finally {
        await server.close();
        fixture.dispose();
      }
    });

    it("rejects a HEAD change before a merge state created across fetch", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      const barrier = discoveryBarrier();
      try {
        const git = gitFor(workspace, barrier.http);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");
        const repo = openRepository(workspace.context, "/work");
        const pullEntries = pullPublicationCount(repo);
        barrier.block();

        const pulling = git.pull({ dir: "/work" });
        await barrier.entered;
        repo.store.setRef("refs/heads/topic", base);
        repo.checkout.setHead("ref: refs/heads/topic");
        const state: MergeStateMetadata = {
          originalHeadRef: "refs/heads/topic",
          originalHeadOid: base,
          currentParentOid: base,
          incomingParentOid: base,
          phase: "ready",
          mode: "no-commit",
          mergeOrigin: "merge",
          currentLabel: "HEAD",
          incomingLabel: base,
          message: "pending local merge\n",
          author: null,
          committer: null,
        };
        repo.checkout.writeMergeState(state, []);
        barrier.release();

        await expect(pulling).rejects.toMatchObject({ code: "ESTALEHEAD" });
        expect(repo.head()).toEqual({ ref: "refs/heads/topic", oid: base });
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.checkout.requireMergeState().state).toEqual(state);
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          newOid: incoming,
          reason: "fetch",
        });
        expect(pullPublicationCount(repo)).toBe(pullEntries);
      } finally {
        barrier.release();
        await server.close();
        fixture.dispose();
      }
    });

    it("rejects a same-branch OID change across fetch", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      const barrier = discoveryBarrier();
      try {
        const git = gitFor(workspace, barrier.http);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
        await git.add({ dir: "/work", paths: ["local.txt"] });
        await git.commit({ dir: "/work", message: "local" });
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");
        const repo = openRepository(workspace.context, "/work");
        const pullEntries = pullPublicationCount(repo);
        barrier.block();

        const pulling = git.pull({ dir: "/work" });
        await barrier.entered;
        repo.store.setRef("refs/heads/main", base);
        barrier.release();

        await expect(pulling).rejects.toMatchObject({ code: "ESTALEHEAD" });
        expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: base });
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.checkout.readMergeState()).toBeNull();
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          newOid: incoming,
          reason: "fetch",
        });
        expect(pullPublicationCount(repo)).toBe(pullEntries);
      } finally {
        barrier.release();
        await server.close();
        fixture.dispose();
      }
    });

    const upstreamMutations: Array<{
      name: string;
      mutate: (repo: Repository, serverUrl: string) => void;
    }> = [
      {
        name: "branch remote",
        mutate(repo, serverUrl) {
          repo.store.configSet("branch.main.remote", "mirror");
          repo.store.configSet("remote.mirror.url", serverUrl);
        },
      },
      {
        name: "branch merge ref",
        mutate(repo) {
          repo.store.configSet("branch.main.merge", "refs/heads/topic");
        },
      },
      {
        name: "remote URL",
        mutate(repo, serverUrl) {
          repo.store.configSet("remote.origin.url", `${serverUrl}/changed`);
        },
      },
      {
        name: "remote fetch refspec",
        mutate(repo) {
          repo.store.configSet("remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
        },
      },
      {
        name: "pull.ff",
        mutate(repo) {
          repo.store.configSet("pull.ff", "false");
        },
      },
    ];

    it.each(upstreamMutations)(
      "rejects a $name change across fetch while retaining fetched state",
      async ({ mutate }) => {
        const { fixture, base } = remoteFixture();
        const server = await startGitServer(fixture.dir);
        const workspace = makeWorkspace({ now: () => REFLOG_TIME });
        const barrier = discoveryBarrier();
        try {
          const git = gitFor(workspace, barrier.http);
          await git.clone({ url: server.url, dir: "/work", depth: 0 });
          fixture.write("remote.txt", "remote\n");
          const incoming = fixture.commit("remote");
          const repo = openRepository(workspace.context, "/work");
          const pullEntries = pullPublicationCount(repo);
          barrier.block();

          const pulling = git.pull({ dir: "/work" });
          await barrier.entered;
          mutate(repo, server.url);
          barrier.release();

          await expect(pulling).rejects.toMatchObject({ code: "ESTALEUPSTREAM" });
          expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: base });
          expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
          expect(repo.checkout.readMergeState()).toBeNull();
          expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
            newOid: incoming,
            reason: "fetch",
          });
          expect(pullPublicationCount(repo)).toBe(pullEntries);
        } finally {
          barrier.release();
          await server.close();
          fixture.dispose();
        }
      },
    );

    it("preserves an active merge created across fetch and rejects it on preflight", async () => {
      const { fixture, base } = remoteFixture();
      const server = await startGitServer(fixture.dir);
      const workspace = makeWorkspace({ now: () => REFLOG_TIME });
      const barrier = discoveryBarrier();
      try {
        const git = gitFor(workspace, barrier.http);
        await git.clone({ url: server.url, dir: "/work", depth: 0 });
        await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
        await git.add({ dir: "/work", paths: ["local.txt"] });
        const local = await git.commit({ dir: "/work", message: "local" });
        fixture.write("remote.txt", "remote\n");
        const incoming = fixture.commit("remote");
        const repo = openRepository(workspace.context, "/work");
        const pullEntries = pullPublicationCount(repo);
        barrier.block();

        const pulling = git.pull({ dir: "/work" });
        await barrier.entered;
        const state: MergeStateMetadata = {
          originalHeadRef: "refs/heads/main",
          originalHeadOid: local.oid,
          currentParentOid: local.oid,
          incomingParentOid: base,
          phase: "ready",
          mode: "no-commit",
          mergeOrigin: "merge",
          currentLabel: "HEAD",
          incomingLabel: base,
          message: "pending local merge\n",
          author: null,
          committer: null,
        };
        repo.checkout.writeMergeState(state, []);
        barrier.release();

        await expect(pulling).rejects.toMatchObject({ code: "EMERGEACTIVE" });
        expect(repo.head()).toEqual({ ref: "refs/heads/main", oid: local.oid });
        expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
        expect(repo.checkout.requireMergeState().state).toEqual(state);
        expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
          newOid: incoming,
          reason: "fetch",
        });
        expect(pullPublicationCount(repo)).toBe(pullEntries);

        let requests = 0;
        const noHttp: GitHttpClient = async () => {
          requests++;
          throw new Error("active merge unexpectedly reached HTTP");
        };
        await expect(gitFor(workspace, noHttp).pull({ dir: "/work" })).rejects.toMatchObject({
          code: "EMERGEACTIVE",
        });
        expect(requests).toBe(0);
      } finally {
        barrier.release();
        await server.close();
        fixture.dispose();
      }
    });
  });

  it("persists a conflicted pull across reopen and continues it", async () => {
    const fixture = new GitFixture().init();
    fixture.write("conflict.txt", "base\n");
    fixture.commit("base");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ now: () => REFLOG_TIME });
    try {
      const git = gitFor(workspace);
      await git.clone({ url: server.url, dir: "/work", depth: 0 });
      await workspace.workspace.fs.writeFile("/work/conflict.txt", "local\n");
      await git.add({ dir: "/work", paths: ["conflict.txt"] });
      const local = await git.commit({ dir: "/work", message: "local" });
      fixture.write("conflict.txt", "remote\n");
      const incoming = fixture.commit("remote");

      await expect(git.pull({ dir: "/work" })).resolves.toEqual({
        conflicted: true,
        pendingCommit: true,
      });

      const repo = openRepository(workspace.context, "/work");
      const branchEntries = repo.store.reflog("refs/heads/main").length;
      expect(repo.head().oid).toBe(local.oid);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
      expect(repo.checkout.requireMergeState().state.phase).toBe("conflicted");
      expect(await workspace.workspace.fs.readFile("/work/conflict.txt", "utf8")).toContain(
        `>>>>>>> ${incoming}`,
      );
      expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
        newOid: incoming,
        reason: "fetch",
      });
      expect(
        repo.store.reflog("refs/heads/main").filter((entry) => entry.reason.startsWith("pull:")),
      ).toEqual([]);
      const priorOrdinal = repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        repo.store.repoId,
      );
      if (priorOrdinal === undefined) throw new Error("reflog state missing before continuation");

      const cold = reopenedGit(workspace);
      await workspace.workspace.fs.writeFile("/work/conflict.txt", "resolved\n");
      await cold.add({ dir: "/work", paths: ["conflict.txt"] });
      const continued = await cold.commit({ dir: "/work", message: "resolved pull" });
      expect(repo.readCommit(continued.oid).parent).toEqual([local.oid, incoming]);
      expect(repo.checkout.readMergeState()).toBeNull();
      expect(repo.store.reflog("refs/heads/main")).toHaveLength(branchEntries + 1);
      expect(repo.store.reflog("refs/heads/main")[0]).toEqual({
        refName: "refs/heads/main",
        ordinal: priorOrdinal + 1,
        oldRaw: local.oid,
        newRaw: continued.oid,
        oldOid: local.oid,
        newOid: continued.oid,
        actor: IDENTITY,
        timestamp: 1_577_836_800,
        timezoneOffset: 0,
        reason: "pull: merge",
      });
      expect(repo.checkout.reflog("HEAD")[0]).toEqual({
        refName: "HEAD",
        ordinal: priorOrdinal + 2,
        oldRaw: "ref: refs/heads/main",
        newRaw: "ref: refs/heads/main",
        oldOid: local.oid,
        newOid: continued.oid,
        actor: IDENTITY,
        timestamp: 1_577_836_800,
        timezoneOffset: 0,
        reason: "pull: merge",
      });
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("persists a no-commit pull across reopen and aborts only local integration", async () => {
    const { fixture } = remoteFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      const git = gitFor(workspace);
      await git.clone({ url: server.url, dir: "/work", depth: 0 });
      await workspace.workspace.fs.writeFile("/work/local.txt", "local\n");
      await git.add({ dir: "/work", paths: ["local.txt"] });
      const local = await git.commit({ dir: "/work", message: "local" });
      fixture.write("remote.txt", "remote\n");
      const incoming = fixture.commit("remote");

      await expect(git.pull({ dir: "/work", commit: false })).resolves.toEqual({
        pendingCommit: true,
      });

      const repo = openRepository(workspace.context, "/work");
      expect(repo.head().oid).toBe(local.oid);
      expect(repo.checkout.requireMergeState().state.phase).toBe("ready");
      expect(await workspace.workspace.fs.readFile("/work/remote.txt", "utf8")).toBe("remote\n");

      await reopenedGit(workspace).mergeAbort({ dir: "/work" });
      expect(repo.head().oid).toBe(local.oid);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(incoming);
      expect(repo.checkout.readMergeState()).toBeNull();
      expect(() => workspace.workspace.fs.readFile("/work/remote.txt")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(await workspace.workspace.fs.readFile("/work/local.txt", "utf8")).toBe("local\n");
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("returns stable errors for incomplete or invalid upstream configuration", () => {
    const missingRemote = committedRepo();
    expect(() => resolvePull(missingRemote.repo)).toThrowError(
      expect.objectContaining({ code: "ENOUPSTREAM" }),
    );

    const missingBranch = committedRepo();
    missingBranch.repo.store.configSet("branch.main.remote", "origin");
    missingBranch.repo.store.configSet("remote.origin.url", "https://example.com/repo.git");
    expect(() => resolvePull(missingBranch.repo)).toThrowError(
      expect.objectContaining({ code: "ENOUPSTREAM" }),
    );

    const invalidRef = committedRepo();
    configureUpstream(invalidRef);
    invalidRef.repo.store.configSet("branch.main.merge", "refs/tags/v1");
    expect(() => resolvePull(invalidRef.repo)).toThrowError(
      expect.objectContaining({ code: "EINVALIDREF" }),
    );
  });

  it("rejects rebase requests and malformed pull configuration", () => {
    const rebase = committedRepo();
    configureUpstream(rebase);
    rebase.repo.store.configSet("pull.rebase", "true");
    expect(() => resolvePull(rebase.repo)).toThrowError(
      expect.objectContaining({ code: "EUNSUPPORTED" }),
    );

    const malformed = committedRepo();
    configureUpstream(malformed);
    const invalidFastForward = "sometimes".repeat(3);
    expect(invalidFastForward.length).toBeGreaterThan(16);
    malformed.repo.store.configSet("pull.ff", invalidFastForward);
    expect(() => resolvePull(malformed.repo)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );

    const invalidRebase = committedRepo();
    configureUpstream(invalidRebase);
    const invalidRebaseValue = "invalid-rebase-value";
    expect(invalidRebaseValue.length).toBeGreaterThan(16);
    invalidRebase.repo.store.configSet("pull.rebase", invalidRebaseValue);
    expect(() => resolvePull(invalidRebase.repo)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );

    const conflicting = committedRepo();
    configureUpstream(conflicting);
    expect(() =>
      resolvePull(conflicting.repo, { fastForward: false, fastForwardOnly: true }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("durably resolves a canonical configured fetch refspec beyond 2048 bytes", () => {
    const workspace = committedRepo();
    const remote = "r".repeat(2_049);
    const remoteRef = `refs/heads/${"u".repeat(1_014)}`;
    const prefix = "https://example.com/";
    const url = `${prefix}${"x".repeat(8_193 - prefix.length)}`;
    const fetchRefspec = `+refs/heads/*:refs/remotes/${remote}/*`;
    workspace.repo.store.configSet("branch.main.remote", remote);
    workspace.repo.store.configSet("branch.main.merge", remoteRef);
    workspace.repo.store.configSet(`remote.${remote}.url`, url);
    workspace.repo.store.configSet(`remote.${remote}.fetch`, fetchRefspec);
    expect(remote).toHaveLength(2_049);
    expect(remoteRef).toHaveLength(1_025);
    expect(url).toHaveLength(8_193);
    expect(fetchRefspec.length).toBeGreaterThan(2_048);
    expect(workspace.repo.store.configGet(`remote.${remote}.fetch`)).toBe(fetchRefspec);

    const expected = {
      remote,
      url,
      displayUrl: url,
      remoteRef,
      remoteBranch: remoteRef.slice("refs/heads/".length),
      fetchRefspec,
    };
    expect(resolvePull(workspace.repo)).toMatchObject(expected);

    const coldDatabase = new SqliteGitDatabase(new TestDatabase(workspace.storage));
    const coldRepo = openRepository({ ...workspace.context, database: coldDatabase });
    expect(resolvePull(coldRepo)).toMatchObject(expected);
  });

  it("treats config rows as untrusted", () => {
    const workspace = committedRepo();
    configureUpstream(workspace);
    workspace.storage.sql.exec(
      "UPDATE git_config SET value = ? WHERE repo_id = ? AND path = ?",
      new Uint8Array([1, 2, 3]),
      workspace.repo.store.repoId,
      "branch.main.remote",
    );

    expect(() => resolvePull(workspace.repo)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("rejects a corrupt checked-out branch target before network work", () => {
    const workspace = committedRepo();
    configureUpstream(workspace);
    workspace.storage.sql.exec(
      "UPDATE git_refs SET target = ? WHERE repo_id = ? AND name = ?",
      new Uint8Array([1, 2, 3]),
      workspace.repo.store.repoId,
      "refs/heads/main",
    );

    expect(() => resolvePull(workspace.repo)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it.each(["m", "i", "merges", "interactive"])("rejects pull.rebase=%s as unsupported", (value) => {
    const workspace = committedRepo();
    configureUpstream(workspace);
    workspace.repo.store.configSet("pull.rebase", value);

    expect(() => resolvePull(workspace.repo)).toThrowError(
      expect.objectContaining({ code: "EUNSUPPORTED" }),
    );
  });
});
