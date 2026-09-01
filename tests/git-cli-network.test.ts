import { afterEach, describe, expect, it } from "vitest";
import { createGit } from "../src/git/client.js";
import { createGitCommand } from "../src/git/shell.js";
import { Workspace } from "../src/runtime/workspace.js";
import { createShell } from "../src/shell/index.js";
import { GitFixture } from "./helpers/git.js";
import type { GitServer } from "./helpers/http-backend.js";
import { type GitServerOptions, startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "CLI Agent", email: "cli@example.com" };
const ENCODER = new TextEncoder();
const fixtures: GitFixture[] = [];
const servers: GitServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function remoteFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("README.md", "initial\n");
  fixture.commit("initial");
  fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
  return fixture;
}

async function serverFor(fixture: GitFixture, options: GitServerOptions = {}): Promise<GitServer> {
  const server = await startGitServer(fixture.dir, options);
  servers.push(server);
  return server;
}

function runtime(
  storage = new SqliteTestStorage(),
  options: { auth?: boolean; signal?: AbortSignal } = {},
) {
  return new Workspace({
    storage,
    git: createGit(),
    defaultGitIdentity: IDENTITY,
    now: () => 1_700_000_000_000,
    cliNetwork: {
      ...(options.auth
        ? {
            onAuth: () => ({ username: "agent", password: "token" }),
            headers: { "X-Git-Client": "kompjutr" },
          }
        : {}),
      ...(options.signal === undefined ? {} : { signal: () => options.signal }),
    },
  });
}

describe("Git network argv", () => {
  it("runs clone, remote, ls-remote, pull, push, and a cold-reopen fetch over Smart HTTP", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const storage = new SqliteTestStorage();
    let workspace = runtime(storage);

    const direct = await workspace.git.runCli({
      argv: ["ls-remote", server.url, "main"],
      cwd: "/",
    });
    expect(direct).toMatchObject({
      stdout: `${fixture.git("rev-parse", "main")}\trefs/heads/main\n`,
      exitCode: 0,
    });

    const cloned = await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    expect(cloned.exitCode, cloned.stderr).toBe(0);
    expect(await workspace.git.revParse({ dir: "/repo", ref: "HEAD" })).toBe(
      fixture.git("rev-parse", "HEAD"),
    );
    expect(await workspace.git.runCli({ argv: ["remote"], cwd: "/repo" })).toMatchObject({
      stdout: "origin\n",
      exitCode: 0,
    });
    expect(
      await workspace.git.runCli({ argv: ["remote", "get-url", "origin"], cwd: "/repo" }),
    ).toMatchObject({
      stdout: `${server.url}\n`,
      exitCode: 0,
    });
    const advertised = await workspace.git.runCli({
      argv: ["ls-remote", "origin", "main"],
      cwd: "/repo",
    });
    expect(advertised.exitCode, advertised.stderr).toBe(0);
    expect(advertised.stdout).toContain("\trefs/heads/main\n");
    const shell = createShell({
      fs: workspace.filesystem,
      cwd: "/repo",
      commands: new Map([["git", createGitCommand(workspace.git)]]),
    });
    expect(await shell.run("git ls-remote origin main | wc -l")).toMatchObject({
      stdout: "1\n",
      exitCode: 0,
    });
    expect(await shell.run("git ls-remote origin main > remote-refs.txt")).toMatchObject({
      stdout: "",
      exitCode: 0,
    });
    expect(new TextDecoder().decode(workspace.filesystem.readFile("/repo/remote-refs.txt"))).toBe(
      `${fixture.git("rev-parse", "main")}\trefs/heads/main\n`,
    );

    fixture.write("remote.txt", "remote\n");
    const remoteTip = fixture.commit("remote");
    const pulled = await workspace.git.runCli({ argv: ["pull", "--ff-only"], cwd: "/repo" });
    expect(pulled.exitCode, pulled.stderr).toBe(0);
    expect(await workspace.git.revParse({ dir: "/repo", ref: "HEAD" })).toBe(remoteTip);

    workspace.filesystem.writeFile("/repo/local.txt", ENCODER.encode("local\n"));
    await workspace.git.add({ dir: "/repo", paths: ["local.txt"] });
    const localTip = (await workspace.git.commit({ dir: "/repo", message: "local" })).oid;
    const pushed = await workspace.git.runCli({
      argv: ["push", "origin", "refs/heads/main:refs/heads/main"],
      cwd: "/repo",
    });
    expect(pushed.exitCode, pushed.stderr).toBe(0);
    expect(fixture.git("rev-parse", "main")).toBe(localTip);

    workspace = runtime(storage);
    const fetched = await workspace.git.runCli({ argv: ["fetch", "origin", "main"], cwd: "/repo" });
    expect(fetched.exitCode, fetched.stderr).toBe(0);
    expect(await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" })).toBe(
      localTip,
    );
  });

  it("uses binding auth and preserves binding cancellation without environment credentials", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture, { requireAuth: true });
    const authenticated = runtime(new SqliteTestStorage(), { auth: true });
    const result = await authenticated.git.runCli({
      argv: ["clone", server.url, "repo"],
      cwd: "/",
      env: { GIT_ASKPASS: "ignored", GIT_TOKEN: "ignored" },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(server.requests.filter((request) => request.method === "GET")).toHaveLength(2);

    const controller = new AbortController();
    controller.abort(new Error("cancel CLI clone"));
    const cancelled = runtime(new SqliteTestStorage(), { signal: controller.signal });
    const before = server.requests.length;
    await expect(
      cancelled.git.runCli({ argv: ["clone", server.url, "cancelled"], cwd: "/" }),
    ).rejects.toMatchObject({ code: "EABORTED" });
    expect(server.requests).toHaveLength(before);
  });

  it("runs pull --rebase over Smart HTTP and leaves conflicts recoverable", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const workspace = runtime();
    await workspace.git.runCli({ argv: ["clone", server.url, "clean"], cwd: "/" });
    await workspace.git.runCli({ argv: ["clone", server.url, "compact"], cwd: "/" });
    workspace.filesystem.writeFile("/clean/local.txt", ENCODER.encode("local\n"));
    await workspace.git.add({ dir: "/clean", paths: ["local.txt"] });
    await workspace.git.commit({ dir: "/clean", message: "local" });
    fixture.write("remote.txt", "remote\n");
    const incoming = fixture.commit("remote");

    const fastForward = await workspace.git.runCli({
      argv: ["pull", "--rebase"],
      cwd: "/compact",
    });
    expect(fastForward.exitCode, fastForward.stderr).toBe(0);
    expect(fastForward.stderr).toContain("Fast-forward\n");
    expect(await workspace.git.revParse({ dir: "/compact", ref: "HEAD" })).toBe(incoming);
    const upToDate = await workspace.git.runCli({ argv: ["pull", "--rebase"], cwd: "/compact" });
    expect(upToDate.exitCode, upToDate.stderr).toBe(0);
    expect(upToDate.stderr).toContain("Already up to date.\n");

    await workspace.git.configSet({ dir: "/clean", path: "pull.rebase", value: "true" });
    const rebased = await workspace.git.runCli({ argv: ["pull"], cwd: "/clean" });
    expect(rebased.exitCode, rebased.stderr).toBe(0);
    expect(rebased.stderr).toContain("Successfully rebased");
    const cleanHead = await workspace.git.revParse({ dir: "/clean", ref: "HEAD" });
    expect(
      (await workspace.git.log({ dir: "/clean", ref: cleanHead, depth: 1 }))[0]?.parent,
    ).toEqual([incoming]);

    await workspace.git.runCli({ argv: ["clone", server.url, "conflict"], cwd: "/" });
    workspace.filesystem.writeFile("/conflict/README.md", ENCODER.encode("local\n"));
    await workspace.git.add({ dir: "/conflict", paths: ["README.md"] });
    const local = await workspace.git.commit({ dir: "/conflict", message: "local conflict" });
    fixture.write("README.md", "remote\n");
    const remoteConflict = fixture.commit("remote conflict");

    const conflicted = await workspace.git.runCli({
      argv: ["pull", "--rebase", "origin", "main"],
      cwd: "/conflict",
    });
    expect(conflicted.exitCode).not.toBe(0);
    expect(conflicted.stderr).toContain("could not apply");
    expect(await workspace.git.revParse({ dir: "/conflict", ref: "HEAD" })).toBe(local.oid);
    expect(
      await workspace.git.revParse({ dir: "/conflict", ref: "refs/remotes/origin/main" }),
    ).toBe(remoteConflict);
    expect(
      await workspace.git.runCli({ argv: ["rebase", "--abort"], cwd: "/conflict" }),
    ).toMatchObject({ exitCode: 0 });
    expect(await workspace.git.status({ dir: "/conflict" })).toEqual([]);
  });

  it("truncates pull-rebase output only after fetch and replay publication", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const workspace = runtime();
    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    workspace.filesystem.writeFile("/repo/local.txt", ENCODER.encode("local\n"));
    await workspace.git.add({ dir: "/repo", paths: ["local.txt"] });
    const local = await workspace.git.commit({ dir: "/repo", message: "local" });
    fixture.write("remote.txt", "remote\n");
    const incoming = fixture.commit("remote");
    await workspace.git.fetch({ dir: "/repo" });

    const result = await workspace.git.runCli(
      { argv: ["pull", "--rebase"], cwd: "/repo" },
      { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
    );

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0, truncated: true });
    const head = await workspace.git.revParse({ dir: "/repo", ref: "HEAD" });
    expect(head).not.toBe(local.oid);
    expect((await workspace.git.log({ dir: "/repo", ref: head, depth: 1 }))[0]?.parent).toEqual([
      incoming,
    ]);
  });

  it("keeps a conflicted rebase journal when post-publication output is full", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const workspace = runtime();
    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    workspace.filesystem.writeFile("/repo/README.md", ENCODER.encode("local\n"));
    await workspace.git.add({ dir: "/repo", paths: ["README.md"] });
    const local = await workspace.git.commit({ dir: "/repo", message: "local" });
    fixture.write("README.md", "remote\n");
    const incoming = fixture.commit("remote");
    await workspace.git.fetch({ dir: "/repo" });

    const result = await workspace.git.runCli(
      { argv: ["pull", "--rebase"], cwd: "/repo" },
      { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
    );

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 1, truncated: true });
    expect(await workspace.git.revParse({ dir: "/repo", ref: "HEAD" })).toBe(local.oid);
    expect(await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" })).toBe(
      incoming,
    );
    await expect(workspace.git.rebaseContinue({ dir: "/repo" })).rejects.toMatchObject({
      code: "EUNMERGED",
    });
    await expect(workspace.git.rebaseAbort({ dir: "/repo" })).resolves.toBeUndefined();
  });

  it("preserves a nested checkout when pull --rebase targets its parent path", async () => {
    const fixture = remoteFixture();
    fixture.write("nested/outer.txt", "outer\n");
    const base = fixture.commit("nested base");
    const server = await serverFor(fixture);
    const workspace = runtime();
    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    await workspace.git.init({ dir: "/repo/nested" });
    workspace.filesystem.writeFile("/repo/nested/foreign.txt", ENCODER.encode("foreign\n"));
    const outer = workspace.filesystem.readFile("/repo/nested/outer.txt");
    const foreign = workspace.filesystem.readFile("/repo/nested/foreign.txt");
    fixture.write("nested/outer.txt", "incoming\n");
    const incoming = fixture.commit("change nested path");
    await workspace.git.fetch({ dir: "/repo" });

    const result = await workspace.git.runCli(
      { argv: ["pull", "--rebase"], cwd: "/repo" },
      { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
    );

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 128, truncated: true });
    expect(await workspace.git.revParse({ dir: "/repo", ref: "HEAD" })).toBe(base);
    expect(await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" })).toBe(
      incoming,
    );
    expect(workspace.filesystem.readFile("/repo/nested/outer.txt")).toEqual(outer);
    expect(workspace.filesystem.readFile("/repo/nested/foreign.txt")).toEqual(foreign);
  });

  it("rejects argv credentials and propagates cancellation through every network command", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const credentials = server.url.replace("http://", "http://agent:token@");
    const workspace = runtime();

    expect(
      await workspace.git.runCli({ argv: ["clone", credentials, "secret"], cwd: "/" }),
    ).toMatchObject({
      exitCode: 128,
      stderr: expect.stringContaining("network binding"),
    });
    await expect(workspace.git.repoRoot({ dir: "/secret" })).rejects.toMatchObject({
      code: "ENOTAREPO",
    });
    expect(await workspace.git.runCli({ argv: ["clone", "not-a-url"], cwd: "/" })).toMatchObject({
      exitCode: 128,
      stderr: expect.stringContaining("remote URL is invalid"),
    });

    await workspace.git.runCli({ argv: ["clone", server.url, "configured"], cwd: "/" });
    await workspace.git.remoteSetUrl({ dir: "/configured", name: "origin", url: credentials });
    const configuredBefore = server.requests.length;
    for (const argv of [
      ["ls-remote", "origin"],
      ["fetch", "origin"],
      ["pull", "--ff-only"],
      ["pull", "--rebase"],
      ["push", "origin", "main:main"],
    ]) {
      expect(await workspace.git.runCli({ argv, cwd: "/configured" })).toMatchObject({
        exitCode: 128,
        stderr: expect.stringContaining("network binding"),
      });
    }
    expect(server.requests).toHaveLength(configuredBefore);
    const directPush = await workspace.git.runCli({
      argv: ["push", credentials.replace("http://", "HTTP://"), "main:main"],
      cwd: "/configured",
    });
    expect(directPush).toMatchObject({
      exitCode: 128,
      stderr: expect.stringContaining("network binding"),
    });
    expect(directPush.stderr).not.toContain("token");
    const slashlessPush = await workspace.git.runCli({
      argv: ["push", "http:agent:token@example.test/repo", "main:main"],
      cwd: "/configured",
    });
    expect(slashlessPush).toMatchObject({
      exitCode: 128,
      stderr: expect.stringContaining("network binding"),
    });
    expect(slashlessPush.stderr).not.toContain("token");
    expect(server.requests).toHaveLength(configuredBefore);

    const controller = new AbortController();
    const cancellable = runtime(new SqliteTestStorage(), { signal: controller.signal });
    await cancellable.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    controller.abort(new Error("cancel network argv"));
    const before = server.requests.length;
    for (const argv of [
      ["ls-remote", "origin"],
      ["fetch", "origin"],
      ["pull", "--ff-only"],
      ["pull", "--rebase"],
      ["push", "origin", "main:main"],
    ]) {
      await expect(cancellable.git.runCli({ argv, cwd: "/repo" })).rejects.toMatchObject({
        code: "EABORTED",
      });
    }
    expect(server.requests).toHaveLength(before);
  });

  it("rolls back known local output overflow and truncates confirmed network outcomes", async () => {
    const fixture = remoteFixture();
    for (let index = 0; index < 24; index++) fixture.git("branch", `topic-${index}`);
    const server = await serverFor(fixture);
    const workspace = runtime();

    await expect(
      workspace.git.runCli(
        { argv: ["init", "too-small"], cwd: "/" },
        { maxStdoutBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(workspace.git.repoRoot({ dir: "/clone-overflow" })).rejects.toMatchObject({
      code: "ENOTAREPO",
    });
    await expect(workspace.git.repoRoot({ dir: "/too-small" })).rejects.toMatchObject({
      code: "ENOTAREPO",
    });

    await expect(
      workspace.git.runCli(
        { argv: ["clone", server.url, "clone-overflow"], cwd: "/" },
        { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });

    await workspace.git.runCli({ argv: ["clone", server.url, "bounded"], cwd: "/" });
    await expect(
      workspace.git.runCli(
        { argv: ["remote", "get-url", "origin"], cwd: "/bounded" },
        { maxStdoutBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      workspace.git.runCli(
        { argv: ["ls-remote", "origin"], cwd: "/bounded" },
        { maxStdoutBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });

    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    const trackingBeforeProgress = await workspace.git.revParse({
      dir: "/repo",
      ref: "refs/remotes/origin/main",
    });
    fixture.write("progress.txt", "progress\n".repeat(4_096));
    fixture.commit("progress");
    await expect(
      workspace.git.runCli(
        { argv: ["fetch", "origin", "main"], cwd: "/repo" },
        { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" })).toBe(
      trackingBeforeProgress,
    );
    expect(await workspace.git.runCli({ argv: ["pull", "--ff-only"], cwd: "/repo" })).toMatchObject(
      { exitCode: 0 },
    );
    const fetched = await workspace.git.runCli(
      {
        argv: ["fetch", "origin", "+refs/heads/*:refs/remotes/many/*"],
        cwd: "/repo",
      },
      { maxStderrBytes: 1_024, maxCombinedOutputBytes: 1_024 },
    );
    expect(fetched.exitCode).toBe(0);
    expect(fetched.truncated).toBe(true);
    expect(await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/many/topic-23" })).toBe(
      fixture.git("rev-parse", "topic-23"),
    );

    workspace.filesystem.writeFile("/repo/push.txt", ENCODER.encode("push\n"));
    await workspace.git.add({ dir: "/repo", paths: ["push.txt"] });
    const oid = (await workspace.git.commit({ dir: "/repo", message: "push" })).oid;
    const pushed = await workspace.git.runCli(
      {
        argv: ["push", "origin", "refs/heads/main:refs/heads/main"],
        cwd: "/repo",
      },
      { maxStderrBytes: 12, maxCombinedOutputBytes: 12 },
    );
    expect(pushed).toMatchObject({ exitCode: 0, truncated: true });
    expect(fixture.git("rev-parse", "main")).toBe(oid);
  });

  it("keeps pull publication and push invocation authoritative when output is full", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const workspace = runtime();
    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    const originalHead = await workspace.git.revParse({ dir: "/repo", ref: "HEAD" });
    const requestsBeforeFailedPull = server.requests.length;
    await expect(
      workspace.git.runCli(
        { argv: ["pull", "missing", "main"], cwd: "/repo" },
        { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(await workspace.git.revParse({ dir: "/repo", ref: "HEAD" })).toBe(originalHead);
    expect(server.requests).toHaveLength(requestsBeforeFailedPull);

    fixture.write("remote.txt", "remote\n");
    const remoteTip = fixture.commit("remote");
    await workspace.git.runCli({ argv: ["fetch", "origin", "main"], cwd: "/repo" });
    const pulled = await workspace.git.runCli(
      { argv: ["pull", "--ff-only"], cwd: "/repo" },
      { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
    );
    expect(pulled).toMatchObject({ exitCode: 0, stderr: "", truncated: true });
    expect(await workspace.git.revParse({ dir: "/repo", ref: "HEAD" })).toBe(remoteTip);

    workspace.filesystem.writeFile("/repo/local.txt", ENCODER.encode("local\n"));
    await workspace.git.add({ dir: "/repo", paths: ["local.txt"] });
    await workspace.git.commit({ dir: "/repo", message: "local" });
    const posts = server.requests.filter((request) => request.method === "POST").length;
    await expect(
      workspace.git.runCli(
        { argv: ["push", "origin", "main:main"], cwd: "/repo" },
        { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
  });

  it("reports bare init paths and keeps unmatched mapped fetch output pre-publication", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const workspace = runtime();

    expect(
      await workspace.git.runCli({ argv: ["init", "--bare", "bare"], cwd: "/" }),
    ).toMatchObject({
      stdout: "Initialized empty Git repository in /bare/\n",
      exitCode: 0,
    });
    expect(
      await workspace.git.runCli({ argv: ["init", "--bare", "bare"], cwd: "/" }),
    ).toMatchObject({
      exitCode: 128,
      stderr: expect.stringContaining("already exists"),
    });
    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    await expect(
      workspace.git.runCli(
        {
          argv: ["fetch", "origin", "refs/heads/missing*:refs/remotes/missing/*"],
          cwd: "/repo",
        },
        { maxStderrBytes: 0, maxCombinedOutputBytes: 0 },
      ),
    ).rejects.toMatchObject({ code: "E2BIG" });
    await expect(
      workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/missing/topic" }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("keeps stale leases pre-invocation and response loss post-invocation distinguishable", async () => {
    const fixture = remoteFixture();
    const server = await serverFor(fixture);
    const workspace = runtime();
    await workspace.git.runCli({ argv: ["clone", server.url, "repo"], cwd: "/" });
    workspace.filesystem.writeFile("/repo/change.txt", ENCODER.encode("change\n"));
    await workspace.git.add({ dir: "/repo", paths: ["change.txt"] });
    await workspace.git.commit({ dir: "/repo", message: "change" });

    const posts = server.requests.filter((request) => request.method === "POST").length;
    const stale = await workspace.git.runCli({
      argv: [
        "push",
        "--force-with-lease=main:0000000000000000000000000000000000000000",
        "origin",
        "refs/heads/main:refs/heads/main",
      ],
      cwd: "/repo",
    });
    expect(stale.exitCode).toBe(128);
    expect(stale.stderr).toContain("push lease is stale");
    expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);

    const lossy = await serverFor(fixture, { truncatePostAfter: 8 });
    expect(
      await workspace.git.runCli({
        argv: ["remote", "set-url", "origin", lossy.url],
        cwd: "/repo",
      }),
    ).toMatchObject({ exitCode: 0 });
    const uncertainPosts = lossy.requests.filter((request) => request.method === "POST").length;
    const trackingBefore = await workspace.git.revParse({
      dir: "/repo",
      ref: "refs/remotes/origin/main",
    });
    await expect(
      workspace.git.runCli(
        {
          argv: ["push", "origin", "refs/heads/main:refs/heads/main"],
          cwd: "/repo",
        },
        { maxStderrBytes: 10, maxCombinedOutputBytes: 10 },
      ),
    ).rejects.toMatchObject({
      code: "EPUSHUNCERTAIN",
      result: { exitCode: 128, stderr: "To origin\n", truncated: true },
    });
    expect(lossy.requests.filter((request) => request.method === "POST")).toHaveLength(
      uncertainPosts + 1,
    );
    expect(await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" })).toBe(
      trackingBefore,
    );
  });
});
