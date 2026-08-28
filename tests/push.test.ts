import { Workspace } from "@cloudflare/computer";
import { afterAll, describe, expect, it } from "vitest";

import { ComputerWorktree, createSqliteGitClient } from "../src/compat/computer.js";
import { openRepository } from "../src/core/context.js";
import { createGit, type Git, type PushRefspec } from "../src/git/client.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/sqlite/memory.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServerOptions, startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import { makeWorkspace } from "./helpers/workspace.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };
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

function workspace(storage = new SqliteTestStorage()): Workspace {
  return new Workspace({
    storage,
    git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
    defaultGitIdentity: IDENTITY,
  });
}

function nativeGit(ws: Workspace, storage: SqliteTestStorage): Git {
  return createGit()({
    database: new SqliteGitDatabase(new TestDatabase(storage)),
    worktree: new ComputerWorktree(ws.provider()),
    now: () => 1_600_000_000_000,
    timezoneOffset: () => 0,
    defaultIdentity: IDENTITY,
  });
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

async function localCommit(ws: Workspace, content: string, message: string): Promise<string> {
  await ws.fs.writeFile("/README.md", content);
  await ws.git.add({ paths: ["README.md"] });
  return (await ws.git.commit({ message })).oid;
}

describe("push", () => {
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

  it("rejects a non-fast-forward before POST and force updates with a fresh lease", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const storage = new SqliteTestStorage();
      const ws = workspace(storage);
      await ws.git.clone({ url: server.url, dir: "/" });
      const local = await localCommit(ws, "local\n", "local");

      fixture.write("README.md", "remote\n");
      fixture.commit("remote");
      const postsBefore = server.requests.filter((request) => request.method === "POST").length;
      const trackingEntries = reflog(storage, "refs/remotes/origin/main").length;
      await expect(ws.git.push({})).rejects.toMatchObject({ code: "ENONFASTFORWARD" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBefore,
      );
      expect(reflog(storage, "refs/remotes/origin/main")).toHaveLength(trackingEntries);

      await expect(ws.git.push({ force: true })).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "main")).toBe(local);
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
        refs: {
          "refs/heads/main": { ok: false, error: "branch is currently checked out" },
        },
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
      const git = nativeGit(ws, storage);
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
      const git = nativeGit(ws, storage);
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

  it("keeps one 1,024-command public push inside aggregate budgets", async () => {
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
      const memory = openRepository(workspace.context, "/").store.memory;
      memory.assertIdle();
      const highWaterBefore = memory.highWaterBytes;
      const first = destinations[0];
      if (first === undefined) throw new Error("bulk push fixture is empty");
      const refspecs: [PushRefspec, ...PushRefspec[]] = [
        { source: null, destination: first },
        ...destinations.slice(1).map((destination) => ({ source: null, destination })),
      ];
      const requestsBefore = server.requests.length;
      workspace.storage.resetCounters();

      const result = await git.push({
        remote: "origin",
        onAuth: () => ({ username: "agent", password: "secret" }),
        refspecs,
      });

      expect(result.ok).toBe(true);
      expect(result.refs).toHaveLength(1_024);
      expect(result.refs.map((status) => status.ref)).toEqual(destinations);
      expect(result.refs.every((status) => status.ok && status.error === null)).toBe(true);
      expect(result.tracking).toEqual({ outcome: "not-applicable" });
      expect(workspace.storage.statementCount).toBeLessThan(1_000);
      expect(memory.highWaterBytes).toBeGreaterThan(highWaterBefore);
      expect(memory.highWaterBytes).toBeLessThanOrEqual(MAX_OPERATION_MEMORY_BYTES);
      memory.assertIdle();
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
      const git = nativeGit(ws, storage);
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
      const git = nativeGit(ws, storage);
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
