import { afterAll, describe, expect, it } from "vitest";

import { openRepository } from "../src/core/context.js";
import { fetchHttpClient, type GitHttpClient } from "../src/core/protocol/transport.js";
import { createGit, type Git } from "../src/index.js";
import { MAX_OPERATION_MEMORY_BYTES, type MemoryReservation } from "../src/memory.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };
const fixtures: GitFixture[] = [];

afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function originFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("README.md", "base\n");
  fixture.commit("base");
  fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
  return fixture;
}

function bindGit(
  workspace: TestWorkspace,
  http?: GitHttpClient,
  database = workspace.database,
): Git {
  return createGit()({
    database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
    ...(http === undefined ? {} : { http }),
  });
}

function reflogRows(workspace: TestWorkspace, ref: string) {
  return workspace.storage.sql
    .exec<{ old_oid: string | null; new_oid: string | null; reason: string }>(
      `SELECT old_oid, new_oid, reason
         FROM git_reflog_entries
        WHERE ref_name = ?
        ORDER BY ordinal DESC`,
      ref,
    )
    .toArray();
}

async function commit(
  workspace: TestWorkspace,
  git: Git,
  content: string,
  message: string,
): Promise<string> {
  await workspace.workspace.fs.writeFile("/README.md", content);
  await git.add({ paths: ["README.md"] });
  return (await git.commit({ message })).oid;
}

describe("checkpoint transport workflow", () => {
  it("publishes, lists, recovers, cold-opens, and deletes a branch with checkpoints", async () => {
    const fixture = originFixture();
    const server = await startGitServer(fixture.dir, { requireAuth: true });
    const onAuth = () => ({ username: "agent", password: "secret" });
    try {
      const authoring = makeWorkspace({ startTime: 1_700_000_000_000 });
      const git = bindGit(authoring);
      await git.clone({ url: server.url, dir: "/", onAuth, singleBranch: true });
      const intermediate = await commit(authoring, git, "checkpoint\n", "checkpoint");
      await git.updateRef({
        ref: "refs/checkpoints/session/step-1",
        value: intermediate,
        expected: null,
      });
      const tip = await commit(authoring, git, "tip\n", "tip");

      let posted = false;
      const failPostStatusDiscovery: GitHttpClient = async (request) => {
        if (posted && request.method === "GET") {
          throw new Error("post-status discovery unavailable");
        }
        const response = await fetchHttpClient(request);
        if (request.method === "POST") posted = true;
        return response;
      };
      const pushGit = bindGit(authoring, failPostStatusDiscovery);
      const pushed = await pushGit.push({
        remote: "origin",
        atomic: true,
        onAuth,
        refspecs: [
          { source: "refs/heads/main", destination: "refs/heads/session" },
          {
            source: "refs/checkpoints/session/*",
            destination: "refs/checkpoints/session/*",
          },
        ],
      });

      expect(pushed).toEqual({
        ok: true,
        error: null,
        unpack: { ok: true },
        refs: [
          { ref: "refs/checkpoints/session/step-1", ok: true, error: null },
          { ref: "refs/heads/session", ok: true, error: null },
        ],
        tracking: { outcome: "updated" },
      });
      expect(fixture.git("rev-parse", "refs/heads/session")).toBe(tip);
      expect(fixture.git("rev-parse", "refs/checkpoints/session/step-1")).toBe(intermediate);
      expect(await git.revParse({ ref: "refs/remotes/origin/session" })).toBe(tip);
      expect(reflogRows(authoring, "refs/remotes/origin/session")).toMatchObject([
        { old_oid: null, new_oid: tip, reason: "push" },
      ]);
      await expect(
        git.revParse({ ref: "refs/remotes/origin/checkpoints/session/step-1" }),
      ).rejects.toMatchObject({ code: "ENOTFOUND" });

      const listed = await git.lsRemote({
        remote: "origin",
        onAuth,
        patterns: ["refs/heads/session", "refs/checkpoints/session/*"],
      });
      expect(listed.refs).toEqual([
        { name: "refs/checkpoints/session/step-1", oid: intermediate },
        { name: "refs/heads/session", oid: tip },
      ]);

      const recovery = makeWorkspace({ startTime: 1_700_000_100_000 });
      const recoveryGit = bindGit(recovery);
      await recoveryGit.init({});
      await recoveryGit.remoteAdd({ name: "origin", url: server.url });
      await expect(
        recoveryGit.fetch({
          remote: "origin",
          onAuth,
          refspecs: [
            { source: "refs/heads/session", destination: "refs/heads/recovered" },
            {
              source: "refs/checkpoints/session/*",
              destination: "refs/checkpoints/session/*",
            },
          ],
        }),
      ).resolves.toEqual({
        mode: "mapped",
        defaultBranch: "refs/heads/main",
        fetchHead: null,
        updates: [
          {
            source: "refs/checkpoints/session/step-1",
            destination: "refs/checkpoints/session/step-1",
            oid: intermediate,
          },
          { source: "refs/heads/session", destination: "refs/heads/recovered", oid: tip },
        ],
      });

      const cold = bindGit(recovery, undefined, new SqliteGitDatabase(recovery.database.db));
      expect(await cold.revParse({ ref: "refs/heads/recovered" })).toBe(tip);
      expect(await cold.revParse({ ref: "refs/checkpoints/session/step-1" })).toBe(intermediate);

      const deleted = await git.push({
        remote: "origin",
        atomic: true,
        onAuth,
        refspecs: [
          { source: null, destination: "refs/heads/session" },
          { source: null, destination: "refs/checkpoints/session/step-1" },
        ],
      });
      expect(deleted).toMatchObject({
        ok: true,
        tracking: { outcome: "updated" },
        refs: [
          { ref: "refs/checkpoints/session/step-1", ok: true },
          { ref: "refs/heads/session", ok: true },
        ],
      });
      await expect(git.revParse({ ref: "refs/remotes/origin/session" })).rejects.toMatchObject({
        code: "ENOTFOUND",
      });
      expect(reflogRows(authoring, "refs/remotes/origin/session")).toMatchObject([
        { old_oid: tip, new_oid: null, reason: "push" },
        { old_oid: null, new_oid: tip, reason: "push" },
      ]);
      await expect(
        git.lsRemote({
          remote: "origin",
          onAuth,
          patterns: ["refs/heads/session", "refs/checkpoints/session/*"],
        }),
      ).resolves.toMatchObject({ refs: [] });
    } finally {
      await server.close();
    }
  });

  it("reports a non-atomic partial result and tracks only the successful branch", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    fixture.git("update-ref", "refs/heads/session", base);
    fixture.writeExecutable(
      ".git/hooks/update",
      '#!/bin/sh\ncase "$1" in\n  refs/checkpoints/*) exit 1 ;;\nesac\nexit 0\n',
    );
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      const git = bindGit(workspace);
      await git.clone({ url: server.url, dir: "/", singleBranch: true });
      const tip = await commit(workspace, git, "partial\n", "partial");
      await git.updateRef({
        ref: "refs/checkpoints/session/rejected",
        value: tip,
        expected: null,
      });

      const result = await git.push({
        remote: "origin",
        refspecs: [
          { source: "refs/heads/main", destination: "refs/heads/session" },
          {
            source: "refs/checkpoints/session/rejected",
            destination: "refs/checkpoints/session/rejected",
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.refs).toMatchObject([
        { ref: "refs/checkpoints/session/rejected", ok: false },
        { ref: "refs/heads/session", ok: true, error: null },
      ]);
      expect(result.tracking).toEqual({ outcome: "updated" });
      expect(fixture.git("rev-parse", "refs/heads/session")).toBe(tip);
      expect(
        fixture.gitResult("show-ref", "--verify", "refs/checkpoints/session/rejected").status,
      ).not.toBe(0);
      expect(await git.revParse({ ref: "refs/remotes/origin/session" })).toBe(tip);
    } finally {
      await server.close();
    }
  });

  it("does not authenticate an object closure for an advertised no-op", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      const git = bindGit(workspace);
      await git.init({});
      await git.remoteAdd({ name: "origin", url: server.url });
      openRepository(workspace.context, "/").store.setRef("refs/heads/remote-only", base);
      const posts = server.requests.filter((request) => request.method === "POST").length;

      await expect(
        git.push({
          remote: "origin",
          refspecs: [{ source: "refs/heads/remote-only", destination: "refs/heads/main" }],
        }),
      ).resolves.toEqual({
        ok: true,
        error: null,
        unpack: { ok: true },
        refs: [{ ref: "refs/heads/main", ok: true, error: null }],
        tracking: {
          outcome: "failed",
          code: "EPUSHLOCAL",
          message: "local push source or closure is incomplete",
        },
      });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
      expect(await git.readRef({ ref: "refs/remotes/origin/main" })).toEqual({ kind: "absent" });
    } finally {
      await server.close();
    }
  });

  it("defers tracking when a post-receive hook replaces the accepted target", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    fixture.git("update-ref", "refs/heads/session", base);
    fixture.writeExecutable(
      ".git/hooks/post-receive",
      [
        "#!/bin/sh",
        "while read old new ref",
        "do",
        '  if [ "$ref" = "refs/heads/session" ]',
        "  then",
        '    tree=$(git rev-parse "$new^{tree}")',
        '    changed=$(printf "hook replacement\\n" | GIT_AUTHOR_NAME=Hook GIT_AUTHOR_EMAIL=hook@example.test GIT_COMMITTER_NAME=Hook GIT_COMMITTER_EMAIL=hook@example.test git commit-tree "$tree" -p "$new")',
        '    git update-ref "$ref" "$changed"',
        "  fi",
        "done",
        "",
      ].join("\n"),
    );
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      const git = bindGit(workspace);
      await git.clone({ url: server.url, dir: "/", singleBranch: true });
      const tip = await commit(workspace, git, "hooked\n", "hooked");

      const result = await git.push({
        remote: "origin",
        refspecs: [{ source: "refs/heads/main", destination: "refs/heads/session" }],
      });

      expect(result).toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/session", ok: true }],
        tracking: { outcome: "deferred" },
      });
      expect(fixture.git("rev-parse", "refs/heads/session")).not.toBe(tip);
      await expect(git.revParse({ ref: "refs/remotes/origin/session" })).rejects.toMatchObject({
        code: "ENOTFOUND",
      });
    } finally {
      await server.close();
    }
  });

  it("reports stale tracking without hiding a confirmed remote success", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    fixture.git("update-ref", "refs/heads/session", base);
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      const normalGit = bindGit(workspace);
      await normalGit.clone({ url: server.url, dir: "/", singleBranch: true });
      const intermediate = await commit(workspace, normalGit, "intermediate\n", "intermediate");
      const tip = await commit(workspace, normalGit, "tip\n", "tip");
      let posted = false;
      let raced = false;
      const racingHttp: GitHttpClient = async (request) => {
        const response = await fetchHttpClient(request);
        if (request.method === "POST") posted = true;
        else if (posted && !raced) {
          raced = true;
          openRepository(workspace.context, "/").store.setRef(
            "refs/remotes/origin/session",
            intermediate,
          );
        }
        return response;
      };

      const result = await bindGit(workspace, racingHttp).push({
        remote: "origin",
        refspecs: [{ source: "refs/heads/main", destination: "refs/heads/session" }],
      });

      expect(result).toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/session", ok: true }],
        tracking: { outcome: "stale" },
      });
      expect(fixture.git("rev-parse", "refs/heads/session")).toBe(tip);
      expect(await normalGit.revParse({ ref: "refs/remotes/origin/session" })).toBe(intermediate);
    } finally {
      await server.close();
    }
  });

  it("returns a tracking failure without hiding a confirmed remote success", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    fixture.git("update-ref", "refs/heads/session", base);
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      const normalGit = bindGit(workspace);
      await normalGit.clone({ url: server.url, dir: "/", singleBranch: true });
      await normalGit.updateRef({
        ref: "refs/remotes/origin/session",
        value: base,
        expected: null,
      });
      const tip = await commit(workspace, normalGit, "confirmed\n", "confirmed");
      let posted = false;
      let corrupted = false;
      const corruptingHttp: GitHttpClient = async (request) => {
        const response = await fetchHttpClient(request);
        if (request.method === "POST") posted = true;
        else if (posted && !corrupted) {
          corrupted = true;
          workspace.storage.sql.exec(
            "UPDATE git_refs SET target = 'invalid' WHERE name = 'refs/remotes/origin/session'",
          );
        }
        return response;
      };

      const result = await bindGit(workspace, corruptingHttp).push({
        remote: "origin",
        refspecs: [{ source: "refs/heads/main", destination: "refs/heads/session" }],
      });

      expect(result).toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/session", ok: true }],
        tracking: { outcome: "failed", code: "ECORRUPT" },
      });
      expect(fixture.git("rev-parse", "refs/heads/session")).toBe(tip);
    } finally {
      await server.close();
    }
  });

  it("maps post-status tracking memory exhaustion to a failed outcome", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    fixture.git("update-ref", "refs/heads/session", base);
    const server = await startGitServer(fixture.dir);
    const exhaustion: { blocker?: MemoryReservation } = {};
    try {
      const workspace = makeWorkspace();
      const normalGit = bindGit(workspace);
      await normalGit.clone({ url: server.url, dir: "/", singleBranch: true });
      const tip = await commit(workspace, normalGit, "bounded\n", "bounded");
      let posted = false;
      const exhaustingHttp: GitHttpClient = async (request) => {
        const response = await fetchHttpClient(request);
        if (request.method === "POST") posted = true;
        else if (posted && exhaustion.blocker === undefined) {
          const store = openRepository(workspace.context, "/").store;
          const blocker = store.reserveMemory();
          exhaustion.blocker = blocker;
          blocker.set("other", MAX_OPERATION_MEMORY_BYTES - store.memory.totalBytes);
        }
        return response;
      };

      const result = await bindGit(workspace, exhaustingHttp).push({
        remote: "origin",
        refspecs: [{ source: "refs/heads/main", destination: "refs/heads/session" }],
      });

      expect(result).toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/session", ok: true }],
        tracking: { outcome: "failed", code: "E2BIG" },
      });
      expect(fixture.git("rev-parse", "refs/heads/session")).toBe(tip);
    } finally {
      exhaustion.blocker?.dispose();
      await server.close();
    }
  });

  it("publishes no mapped fetch destination when one checkpoint set member is invalid", async () => {
    const fixture = originFixture();
    const base = fixture.git("rev-parse", "refs/heads/main");
    fixture.git("update-ref", "refs/heads/session", base);
    fixture.git("update-ref", "refs/checkpoints/session/step-1", base);
    const server = await startGitServer(fixture.dir);
    try {
      const workspace = makeWorkspace();
      const git = bindGit(workspace);
      await git.init({});

      await expect(
        git.fetch({
          url: server.url,
          refspecs: [
            {
              source: "refs/checkpoints/session/step-1",
              destination: "refs/checkpoints/recovered/step-1",
            },
            { source: "refs/heads/session", destination: "refs/heads/main" },
          ],
        }),
      ).rejects.toMatchObject({ code: "EBRANCHFAIL" });
      await expect(
        git.revParse({ ref: "refs/checkpoints/recovered/step-1" }),
      ).rejects.toMatchObject({ code: "ENOTFOUND" });
      await expect(git.revParse({ ref: "refs/heads/main" })).rejects.toMatchObject({
        code: "ENOTFOUND",
      });
    } finally {
      await server.close();
    }
  });
});
