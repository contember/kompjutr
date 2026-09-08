import { afterAll, describe, expect, it } from "vitest";

import { NodeFsCompat } from "../packages/do/src/fs/compat/node.js";
import { createFilesystem } from "../packages/do/src/fs/filesystem.js";
import { createGit, type Git, type PushRefspec } from "../packages/git/src/client.js";
import { fetchHttpClient, type GitHttpClient } from "../packages/git/src/protocol/transport.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServerOptions, startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import { makeWorkspace } from "./helpers/workspace.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };
const NOW = 1_600_000_000_000;
const fixtures: GitFixture[] = [];

afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function remoteFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("README.md", "initial\n");
  fixture.commit("initial");
  fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
  return fixture;
}

/** A client and a node:fs facade over one storage, reopened on every call. */
function openGit(storage: SqliteTestStorage, http?: GitHttpClient): { git: Git; fs: NodeFsCompat } {
  const db = new TestDatabase(storage);
  const worktree = createFilesystem(db, { now: () => NOW });
  return {
    fs: new NodeFsCompat(worktree),
    git: createGit()({
      database: new SqliteGitDatabase(db),
      worktree,
      now: () => NOW,
      timezoneOffset: () => 0,
      defaultIdentity: IDENTITY,
      ...(http === undefined ? {} : { http }),
    }),
  };
}

function workspace(storage = new SqliteTestStorage()): { git: Git; fs: NodeFsCompat } {
  return openGit(storage);
}

function nativeGit(storage: SqliteTestStorage, http?: GitHttpClient): Git {
  return openGit(storage, http).git;
}

interface RefLogRow {
  old_oid: string | null;
  new_oid: string | null;
  actor_name: string | null;
  actor_email: string | null;
  timestamp: number;
  timezone: number;
  reason: string;
}

function reflog(storage: SqliteTestStorage, ref: string): RefLogRow[] {
  return storage.sql
    .exec<RefLogRow>(
      `SELECT old_oid, new_oid, actor_name, actor_email, timestamp, timezone, reason
         FROM git_reflog_entries
        WHERE ref_name = ?
        ORDER BY ordinal DESC`,
      ref,
    )
    .toArray();
}

async function localCommit(
  ws: { git: Git; fs: NodeFsCompat },
  content: string,
  message: string,
): Promise<string> {
  await ws.fs.writeFile("/README.md", content);
  await ws.git.add({ paths: ["README.md"] });
  return (await ws.git.commit({ message })).oid;
}

describe("push", () => {
  it("validates the signal and rejects a pre-aborted push before HTTP", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const git = nativeGit(storage);
      const requests = server.requests.length;
      const malformed = { signal: new AbortController().signal };
      Object.defineProperty(malformed, "signal", { value: {} });
      await expect(git.push(malformed)).rejects.toMatchObject({ code: "EINVAL" });
      expect(server.requests).toHaveLength(requests);

      const controller = new AbortController();
      const reason = new Error("cancel push before discovery");
      controller.abort(reason);
      const beforeAbort = server.requests.length;
      await expect(git.push({ signal: controller.signal })).rejects.toMatchObject({
        code: "EABORTED",
        cause: reason,
      });
      expect(server.requests).toHaveLength(beforeAbort);
    } finally {
      await server.close();
    }
  });

  it("returns confirmed remote success with failed EABORTED tracking", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const tracked = await ws.git.revParse({ ref: "refs/remotes/origin/main" });
      const pushed = await localCommit(ws, "confirmed before tracking abort\n", "confirmed");
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;
      const controller = new AbortController();
      const reason = new Error("cancel tracking reconciliation");
      let discoveries = 0;
      const http: GitHttpClient = async (request) => {
        if (request.method === "GET") {
          discoveries++;
          if (discoveries === 2) {
            controller.abort(reason);
            return {
              status: 500,
              statusText: "Cancelled",
              headers: { "content-type": "text/plain" },
              body: (async function* (): AsyncGenerator<Uint8Array> {})(),
            };
          }
        }
        return fetchHttpClient(request);
      };

      await expect(
        nativeGit(storage, http).push({ signal: controller.signal }),
      ).resolves.toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/main", ok: true, error: null }],
        tracking: {
          outcome: "failed",
          code: "EABORTED",
          message: "network operation aborted",
        },
      });
      expect(discoveries).toBe(2);
      expect(fixture.git("rev-parse", "main")).toBe(pushed);
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(tracked);
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);
    } finally {
      await server.close();
    }
  });

  it("updates a branch, records its tracking ref and makes the retry a no-op", async () => {
    const fixture = remoteFixture();
    const initial = fixture.git("rev-parse", "main");
    const server = await startGitServer(`${fixture.dir}/.git`);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const oid = await localCommit(ws, "updated\n", "update");

      storage.resetCounters();
      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });
      expect(storage.statementCount).toBeLessThan(1_000);
      expect(fixture.git("rev-parse", "main")).toBe(oid);
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(oid);
      expect(reflog(storage, "refs/remotes/origin/main")[0]).toEqual({
        old_oid: initial,
        new_oid: oid,
        actor_name: IDENTITY.name,
        actor_email: IDENTITY.email,
        timestamp: 1_600_000_000,
        timezone: 0,
        reason: "push",
      });

      const posts = server.requests.filter((request) => request.method === "POST").length;
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;
      storage.resetCounters();
      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });
      expect(storage.statementCount).toBeLessThan(1_000);
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);
    } finally {
      await server.close();
    }
  });

  it("rejects stale tracking leases and does not let a matching lease imply force", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const local = await localCommit(ws, "local\n", "local");

      fixture.write("README.md", "remote\n");
      const remote = fixture.commit("remote");
      const postsBefore = server.requests.filter((request) => request.method === "POST").length;
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;
      await expect(ws.git.push({})).rejects.toMatchObject({ code: "ENONFASTFORWARD" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBefore,
      );
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);

      const git = nativeGit(storage);
      await expect(
        git.push({ force: true, leases: { main: { tracking: true } } }),
      ).rejects.toMatchObject({ code: "ESTALELEASE" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBefore,
      );

      await expect(
        git.push({ leases: { "refs/heads/main": { expected: remote } } }),
      ).rejects.toMatchObject({ code: "ENONFASTFORWARD" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBefore,
      );

      await expect(
        git.push({ force: true, leases: { main: { expected: remote } } }),
      ).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "main")).toBe(local);
    } finally {
      await server.close();
    }
  });

  it("leases wildcard creations, deletions, and no-op destinations independently", async () => {
    const fixture = remoteFixture();
    const initial = fixture.git("rev-parse", "main");
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      await ws.git.branch({ name: "topic" });
      const git = nativeGit(storage);
      const posts = server.requests.filter((request) => request.method === "POST").length;

      await expect(
        git.push({
          refspecs: [{ source: "refs/heads/main", destination: "refs/heads/main" }],
          leases: { main: { expected: null } },
        }),
      ).rejects.toMatchObject({ code: "ESTALELEASE" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);

      await expect(
        git.push({
          refspecs: [{ source: "refs/heads/*", destination: "refs/heads/*" }],
          leases: { topic: { expected: null } },
        }),
      ).resolves.toMatchObject({
        ok: true,
        refs: [
          { ref: "refs/heads/main", ok: true, error: null },
          { ref: "refs/heads/topic", ok: true, error: null },
        ],
      });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        posts + 1,
      );
      expect(fixture.git("rev-parse", "refs/heads/topic")).toBe(initial);

      await expect(
        git.push({
          refspecs: [{ source: null, destination: "refs/heads/topic" }],
          leases: { topic: { expected: initial } },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(fixture.gitResult("show-ref", "--verify", "refs/heads/topic").status).not.toBe(0);
    } finally {
      await server.close();
    }
  });

  it("rejects malformed, colliding, excessive, and unused leases before HTTP", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const git = nativeGit(storage);
      const requests = server.requests.length;
      const invalid = [
        { leases: null },
        { leases: { main: { expected: "invalid" } } },
        { leases: { main: { expected: null, tracking: true } } },
        { leases: { main: { tracking: false } } },
        { leases: { missing: { expected: null } } },
        {
          leases: {
            main: { tracking: true },
            "refs/heads/main": { tracking: true },
          },
        },
      ];
      for (const options of invalid) {
        await expect(Reflect.apply(git.push, git, [options])).rejects.toMatchObject({
          code: "EINVAL",
        });
      }

      const excessive: Record<string, { expected: null }> = {};
      for (let index = 0; index < 1_025; index++) {
        excessive[`refs/heads/lease-${index}`] = { expected: null };
      }
      await expect(Reflect.apply(git.push, git, [{ leases: excessive }])).rejects.toMatchObject({
        code: "E2BIG",
      });
      await expect(
        git.push({
          url: server.url,
          leases: { main: { tracking: true } },
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        git.push({
          refspecs: [{ source: "refs/heads/main", destination: "refs/tags/release" }],
          leases: { "refs/tags/release": { tracking: true } },
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });

      await git.updateRef({ ref: "refs/remotes/origin/main", delete: true });
      await expect(git.push({ leases: { main: { tracking: true } } })).rejects.toMatchObject({
        code: "EREFNOTFOUND",
      });
      expect(server.requests).toHaveLength(requests);
    } finally {
      await server.close();
    }
  });

  it("does not publish tracking history after a remote report-status rejection", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const tracked = await ws.git.revParse({ ref: "refs/remotes/origin/main" });
      await localCommit(ws, "rejected\n", "rejected");
      fixture.git("config", "receive.denyCurrentBranch", "refuse");
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;

      await expect(ws.git.push({})).resolves.toEqual({
        ok: false,
        error: "branch is currently checked out",
        unpack: { ok: true },
        refs: [
          {
            ref: "refs/heads/main",
            ok: false,
            error: "branch is currently checked out",
          },
        ],
        tracking: { outcome: "not-applicable" },
      });

      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(tracked);
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);
    } finally {
      await server.close();
    }
  });

  it("creates and deletes a remote branch", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      await ws.fs.mkdir("/src", { recursive: true });
      await ws.fs.writeFile("/src/topic.ts", "export const topic = true;\n");
      await ws.git.add({ paths: ["src/topic.ts"] });
      const oid = (await ws.git.commit({ message: "topic" })).oid;

      await expect(ws.git.push({ remoteRef: "topic" })).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "refs/heads/topic")).toBe(oid);
      expect(fixture.git("show", "refs/heads/topic:src/topic.ts")).toBe(
        "export const topic = true;",
      );
      expect(reflog(storage, "refs/remotes/origin/topic")[0]).toEqual({
        old_oid: null,
        new_oid: oid,
        actor_name: IDENTITY.name,
        actor_email: IDENTITY.email,
        timestamp: 1_600_000_000,
        timezone: 0,
        reason: "push",
      });
      await expect(ws.git.push({ remoteRef: "topic", delete: true })).resolves.toMatchObject({
        ok: true,
      });
      expect(fixture.git("branch", "--list", "topic")).toBe("");
      expect(reflog(storage, "refs/remotes/origin/topic")[0]).toMatchObject({
        old_oid: oid,
        new_oid: null,
        actor_name: IDENTITY.name,
        actor_email: IDENTITY.email,
        timestamp: 1_600_000_000,
        timezone: 0,
        reason: "push",
      });
    } finally {
      await server.close();
    }
  });

  it("keeps tracking state unchanged when the success response is lost", async () => {
    const fixture = remoteFixture();
    const old = fixture.git("rev-parse", "main");
    const serverOptions: GitServerOptions = {};
    const server = await startGitServer(fixture.dir, serverOptions);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const local = await localCommit(ws, "uncertain\n", "uncertain");
      serverOptions.truncatePostAfter = 1;
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;

      await expect(ws.git.push({})).rejects.toMatchObject({ code: "EPUSHUNCERTAIN" });
      expect(fixture.git("rev-parse", "main")).toBe(local);
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(old);
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);

      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(local);
    } finally {
      await server.close();
    }
  });

  it("does not publish tracking history for an explicit push URL", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const tracked = await ws.git.revParse({ ref: "refs/remotes/origin/main" });
      const local = await localCommit(ws, "explicit\n", "explicit URL");
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;

      await expect(ws.git.push({ url: server.url })).resolves.toMatchObject({ ok: true });

      expect(fixture.git("rev-parse", "main")).toBe(local);
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(tracked);
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);
    } finally {
      await server.close();
    }
  });

  it("logs a remote no-op when it reconciles stale local tracking", async () => {
    const fixture = remoteFixture();
    const old = fixture.git("rev-parse", "main");
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const local = await localCommit(ws, "reconciled\n", "reconcile");
      await ws.git.push({});
      const priorEntries = reflog(storage, "refs/remotes/origin/main").length;
      storage.sql.exec(
        `UPDATE git_refs
            SET target = ?
          WHERE name = 'refs/remotes/origin/main'`,
        old,
      );

      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });

      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(priorEntries + 1);
      expect(reflog(storage, "refs/remotes/origin/main")[0]).toMatchObject({
        old_oid: old,
        new_oid: local,
        actor_name: IDENTITY.name,
        actor_email: IDENTITY.email,
        timestamp: 1_600_000_000,
        timezone: 0,
        reason: "push",
      });
    } finally {
      await server.close();
    }
  });

  it("returns the exact empty result for an unmatched wildcard without HTTP", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const git = nativeGit(storage);
      const requests = server.requests.length;

      await expect(
        git.push({
          refspecs: [
            {
              source: "refs/heads/missing/*",
              destination: "refs/heads/missing/*",
            },
          ],
        }),
      ).resolves.toEqual({
        ok: true,
        error: null,
        unpack: { ok: true },
        refs: [],
        tracking: { outcome: "not-applicable" },
      });
      expect(server.requests).toHaveLength(requests);
    } finally {
      await server.close();
    }
  });

  it("validates atomic push options locally and sends valid options", async () => {
    const fixture = remoteFixture();
    fixture.git("config", "receive.advertisePushOptions", "true");
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const git = nativeGit(storage);
      const oid = await localCommit(ws, "options\n", "push options");
      const beforeInvalid = server.requests.length;

      await expect(
        git.push({
          atomic: true,
          pushOptions: ["invalid\noption"],
          refspecs: [{ source: "refs/heads/main", destination: "refs/heads/main" }],
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      expect(server.requests).toHaveLength(beforeInvalid);

      await expect(
        git.push({
          atomic: true,
          pushOptions: ["checkpoint.session=1"],
          refspecs: [{ source: "refs/heads/main", destination: "refs/heads/main" }],
        }),
      ).resolves.toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/main", ok: true, error: null }],
      });
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(oid);
    } finally {
      await server.close();
    }
  });

  it("keeps one 1,024-command public push inside structural limits", async () => {
    const fixture = remoteFixture();
    const remoteOid = fixture.git("rev-parse", "refs/heads/main");
    const destinations = Array.from(
      { length: 1_024 },
      (_, index) => `refs/checkpoints/bulk/${index.toString().padStart(4, "0")}`,
    );
    fixture.gitInput(
      `${destinations.map((destination) => `create ${destination} ${remoteOid}`).join("\n")}\n`,
      "update-ref",
      "--stdin",
    );
    const server = await startGitServer(fixture.dir, { requireAuth: true });
    try {
      const workspace = makeWorkspace();
      const git = createGit()({
        database: workspace.database,
        worktree: workspace.worktree,
        now: workspace.context.now,
        timezoneOffset: workspace.context.timezoneOffset,
        defaultIdentity: IDENTITY,
      });
      await git.init({});
      await git.remoteAdd({ name: "origin", url: server.url });
      const first = destinations[0];
      if (first === undefined) throw new Error("bulk push fixture is empty");
      const refspecs: [PushRefspec, ...PushRefspec[]] = [
        { source: null, destination: first },
        ...destinations.slice(1).map((destination) => ({ source: null, destination })),
      ];
      const leases: Record<string, { expected: string }> = {};
      for (const destination of destinations) leases[destination] = { expected: remoteOid };
      const requestsBefore = server.requests.length;
      workspace.storage.resetCounters();

      const result = await git.push({
        remote: "origin",
        onAuth: () => ({ username: "agent", password: "secret" }),
        refspecs,
        leases,
      });

      expect(result.ok).toBe(true);
      expect(result.refs).toHaveLength(1_024);
      expect(result.refs.map((status) => status.ref)).toEqual(destinations);
      expect(result.refs.every((status) => status.ok && status.error === null)).toBe(true);
      expect(result.tracking).toEqual({ outcome: "not-applicable" });
      expect(workspace.storage.statementCount).toBeLessThan(1_000);
      expect(server.requests.slice(requestsBefore).map((request) => request.method)).toEqual([
        "GET",
        "GET",
        "POST",
      ]);
      expect(fixture.gitResult("show-ref", "--verify", first).status).not.toBe(0);
      expect(fixture.gitResult("show-ref", "--verify", destinations.at(-1) ?? "").status).not.toBe(
        0,
      );
    } finally {
      await server.close();
    }
  });

  it("keeps nonempty mappings when a sibling wildcard is empty", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const git = nativeGit(storage);
      const oid = await localCommit(ws, "mixed\n", "mixed mapping");

      await expect(
        git.push({
          refspecs: [
            {
              source: "refs/heads/missing/*",
              destination: "refs/heads/missing/*",
            },
            { source: "refs/heads/main", destination: "refs/heads/main" },
          ],
        }),
      ).resolves.toMatchObject({
        ok: true,
        refs: [{ ref: "refs/heads/main", ok: true, error: null }],
      });
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(oid);
    } finally {
      await server.close();
    }
  });

  it("fails an exact-missing mixed set before discovery", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const git = nativeGit(storage);
      await localCommit(ws, "local\n", "local only");
      const requests = server.requests.length;

      await expect(
        git.push({
          refspecs: [
            { source: "refs/heads/main", destination: "refs/heads/main" },
            { source: "refs/heads/missing", destination: "refs/heads/missing" },
          ],
        }),
      ).rejects.toMatchObject({ code: "EREFNOTFOUND" });
      expect(server.requests).toHaveLength(requests);
    } finally {
      await server.close();
    }
  });
});
