import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchHttpClient, type GitHttpClient } from "../src/core/protocol/transport.js";
import { createGit, type Git, type GitLsRemoteOptions, type LsRemoteResult } from "../src/index.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServer, type RequestRecord, startGitServer } from "./helpers/http-backend.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

interface DurableCounts {
  readonly refs: number;
  readonly reflogs: number;
  readonly config: number;
}

let fixture: GitFixture;
let server: GitServer;
let mainOid: string;
let baseOid: string;

beforeAll(async () => {
  fixture = new GitFixture().init();
  fixture.write("base.txt", "base\n");
  baseOid = fixture.commit("base");
  fixture.write("next.txt", "next\n");
  mainOid = fixture.commit("next");
  fixture.git("update-ref", "refs/heads/team/alpha", mainOid);
  fixture.git("update-ref", "refs/checkpoints/team/alpha", baseOid);
  fixture.git("tag", "light", mainOid);
  fixture.git("tag", "-a", "candidate", "-m", "candidate", mainOid);
  server = await startGitServer(fixture.dir);
});

afterAll(async () => {
  await server.close();
  fixture.dispose();
});

function gitFor(workspace: TestRepository, http?: GitHttpClient): Git {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    ...(http === undefined ? {} : { http }),
  });
}

function configuredWorkspace(url = server.url): TestRepository {
  const workspace = makeRepo();
  workspace.repo.store.configSet("remote.origin.url", url);
  return workspace;
}

function gitRows(
  ...patterns: string[]
): readonly { readonly name: string; readonly oid: string }[] {
  const output = fixture.git("ls-remote", fixture.dir, ...patterns);
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error(`git ls-remote returned a malformed row: ${line}`);
    return { oid: line.slice(0, separator), name: line.slice(separator + 1) };
  });
}

function resultRows(result: LsRemoteResult) {
  return result.refs.map((ref) => ({ oid: ref.oid, name: ref.name }));
}

function requestTail(start: number): readonly RequestRecord[] {
  return server.requests.slice(start);
}

function expectDiscoveryOnly(requests: readonly RequestRecord[], count = 1): void {
  expect(requests).toHaveLength(count);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(requests.every((request) => request.query === "service=git-upload-pack")).toBe(true);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  expect(requests.length).toBeLessThanOrEqual(3);
}

function durableCounts(workspace: TestRepository): DurableCounts {
  const row = workspace.storage.sql
    .exec<DurableCounts>(
      `SELECT (SELECT count(*) FROM git_refs) AS refs,
              (SELECT count(*) FROM git_reflog_entries) +
                (SELECT count(*) FROM git_checkout_reflog_entries) AS reflogs,
              (SELECT count(*) FROM git_config) AS config`,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("durable count query returned no row");
  return row;
}

describe("lsRemote", () => {
  it("returns every validated advertisement row in wire order without mutation or caching", async () => {
    const workspace = configuredWorkspace();
    const git = gitFor(workspace);
    const beforeState = durableCounts(workspace);
    const beforeRequests = server.requests.length;
    workspace.storage.resetCounters();

    const first = await git.lsRemote();
    const second = await git.lsRemote({ remote: "origin" });

    expect(resultRows(first)).toEqual(gitRows());
    expect(resultRows(second)).toEqual(gitRows());
    expect(first.headRef).toBe("refs/heads/main");
    expect(first.refs).toEqual(
      expect.arrayContaining([
        { name: "HEAD", oid: mainOid },
        { name: "refs/tags/candidate^{}", oid: mainOid },
        { name: "refs/tags/light", oid: mainOid },
      ]),
    );
    expectDiscoveryOnly(requestTail(beforeRequests), 2);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(durableCounts(workspace)).toEqual(beforeState);
    expect(workspace.repo.store.memory.totalBytes).toBe(0);
    expect(workspace.repo.store.memory.activeCount).toBe(0);
    expect(workspace.repo.store.memory.highWaterBytes).toBeGreaterThan(0);
  });

  it("matches exact names and Git tail wildmatch grammar with one row per ref", async () => {
    const workspace = configuredWorkspace();
    const git = gitFor(workspace);
    const cases = [
      ["refs/heads/team/alpha"],
      ["alpha"],
      ["team/*"],
      ["refs/*/team/*"],
      ["refs/*/alpha"],
      ["t?am/a[lp]pha"],
      ["t[d-f]am/alpha"],
      ["t[!x]am/alpha"],
      ["team/\\alpha"],
      ["heads/*"],
      ["alpha", "team/*", "refs/heads/team/alpha"],
    ];

    for (const patterns of cases) {
      const beforeRequests = server.requests.length;
      const result = await git.lsRemote({ url: server.url, patterns });
      expect(resultRows(result)).toEqual(gitRows(...patterns));
      expectDiscoveryOnly(requestTail(beforeRequests));
    }
  });

  it("includes matching HEAD, lightweight tags, and annotated tag peeled rows", async () => {
    const workspace = configuredWorkspace();
    const git = gitFor(workspace);
    const patterns = ["HEAD", "tags/*"];
    const beforeRequests = server.requests.length;

    const result = await git.lsRemote({ patterns });

    expect(resultRows(result)).toEqual(gitRows(...patterns));
    expect(result.refs).toEqual(
      expect.arrayContaining([
        { name: "HEAD", oid: mainOid },
        { name: "refs/tags/candidate^{}", oid: mainOid },
        { name: "refs/tags/light", oid: mainOid },
      ]),
    );
    expectDiscoveryOnly(requestTail(beforeRequests));
  });

  it("returns an empty result after one discovery when no pattern matches", async () => {
    const workspace = configuredWorkspace();
    const beforeRequests = server.requests.length;

    await expect(gitFor(workspace).lsRemote({ patterns: ["missing/*"] })).resolves.toEqual({
      refs: [],
      headRef: "refs/heads/main",
    });

    expectDiscoveryOnly(requestTail(beforeRequests));
  });

  it("uses at most a transport retry and one later authenticated retry", async () => {
    const authServer = await startGitServer(fixture.dir, { requireAuth: true });
    let attempts = 0;
    let authCalls = 0;
    const http: GitHttpClient = async (request) => {
      attempts++;
      if (attempts === 1) throw new Error("transient transport failure");
      return fetchHttpClient(request);
    };
    const workspace = configuredWorkspace(authServer.url);
    try {
      const result = await gitFor(workspace, http).lsRemote({
        onAuth: () => {
          authCalls++;
          return { username: "fixture", password: "secret" };
        },
      });

      expect(resultRows(result)).toEqual(gitRows());
      expect(attempts).toBe(3);
      expect(authCalls).toBe(1);
      expect(authServer.requests).toHaveLength(2);
      expect(authServer.requests.every((request) => request.method === "GET")).toBe(true);
      expect(authServer.requests.filter((request) => request.method === "POST")).toHaveLength(0);

      const malformed = { username: "fixture" };
      Object.defineProperty(malformed, "password", { value: 7, enumerable: true });
      const beforeMalformed = authServer.requests.length;
      await expect(gitFor(workspace).lsRemote({ onAuth: () => malformed })).rejects.toMatchObject({
        code: "EAUTH",
      });
      expect(authServer.requests.slice(beforeMalformed)).toHaveLength(1);
      expect(authServer.requests.slice(beforeMalformed)[0]?.method).toBe("GET");
      expect(authServer.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
      await authServer.close();
    }
  });

  it("wraps a coded final GET transport failure as EHTTP", async () => {
    const transportCause = new Error("connection reset");
    Object.defineProperty(transportCause, "code", { value: "ECONNRESET", enumerable: true });
    let attempts = 0;
    const http: GitHttpClient = async () => {
      attempts++;
      throw transportCause;
    };
    const workspace = configuredWorkspace();
    const beforeRequests = server.requests.length;

    await expect(gitFor(workspace, http).lsRemote()).rejects.toMatchObject({
      code: "EHTTP",
      cause: transportCause,
    });

    expect(attempts).toBe(2);
    expect(requestTail(beforeRequests)).toHaveLength(0);
    expect(requestTail(beforeRequests).filter((request) => request.method === "POST")).toHaveLength(
      0,
    );
  });

  it("rejects conflicting, missing, and unsupported targets before a request", async () => {
    const workspace = configuredWorkspace();
    const git = gitFor(workspace);
    const conflicting: GitLsRemoteOptions = { remote: "origin" };
    Object.defineProperty(conflicting, "url", { value: server.url, enumerable: true });
    const beforeRequests = server.requests.length;

    await expect(git.lsRemote(conflicting)).rejects.toMatchObject({ code: "EINVAL" });
    await expect(gitFor(makeRepo()).lsRemote()).rejects.toMatchObject({ code: "ENOREMOTE" });
    await expect(git.lsRemote({ url: "ssh://example.test/repo.git" })).rejects.toMatchObject({
      code: "EURLSCHEME",
    });
    for (const field of ["onAuth", "onProgress", "onMessage"]) {
      const invalidCallback: GitLsRemoteOptions = {};
      Object.defineProperty(invalidCallback, field, { value: "invalid", enumerable: true });
      await expect(git.lsRemote(invalidCallback)).rejects.toMatchObject({ code: "EINVAL" });
    }

    expect(requestTail(beforeRequests)).toHaveLength(0);
  });

  it("rejects malformed patterns and each first excess before a request", async () => {
    const workspace = configuredWorkspace();
    const git = gitFor(workspace);
    const beforeMalformed = server.requests.length;

    await expect(git.lsRemote({ patterns: ["tail\\"] })).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(git.lsRemote({ patterns: ["[abc"] })).rejects.toMatchObject({ code: "EINVAL" });
    expect(requestTail(beforeMalformed)).toHaveLength(0);

    const exactCount = Array.from({ length: 1_024 }, (_, index) => `missing/${index}`);
    const beforeExact = server.requests.length;
    await expect(git.lsRemote({ patterns: exactCount })).resolves.toMatchObject({ refs: [] });
    expectDiscoveryOnly(requestTail(beforeExact));

    const beforeCountExcess = server.requests.length;
    await expect(git.lsRemote({ patterns: [...exactCount, "first-excess"] })).rejects.toMatchObject(
      {
        code: "E2BIG",
      },
    );
    expect(requestTail(beforeCountExcess)).toHaveLength(0);

    const beforeByteLimit = server.requests.length;
    await expect(git.lsRemote({ patterns: ["x".repeat(1_024)] })).resolves.toMatchObject({
      refs: [],
    });
    expectDiscoveryOnly(requestTail(beforeByteLimit));

    const beforeByteExcess = server.requests.length;
    await expect(git.lsRemote({ patterns: ["x".repeat(1_025)] })).rejects.toMatchObject({
      code: "E2BIG",
    });
    expect(requestTail(beforeByteExcess)).toHaveLength(0);
  });

  it("shares the aggregate operation memory ceiling and releases a failed reservation", async () => {
    const workspace = configuredWorkspace();
    const blocker = workspace.repo.store.reserveMemory();
    blocker.set("other", MAX_OPERATION_MEMORY_BYTES);
    const beforeRequests = server.requests.length;
    try {
      await expect(gitFor(workspace).lsRemote({ patterns: ["HEAD"] })).rejects.toMatchObject({
        code: "E2BIG",
      });
      expect(requestTail(beforeRequests)).toHaveLength(0);
      expect(workspace.repo.store.memory.activeCount).toBe(1);
      expect(workspace.repo.store.memory.totalBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      blocker.dispose();
    }
    expect(workspace.repo.store.memory.activeCount).toBe(0);
    expect(workspace.repo.store.memory.totalBytes).toBe(0);
  });
});
