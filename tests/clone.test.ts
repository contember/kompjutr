import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { openRepository } from "../src/core/context.js";
import { GitError } from "../src/core/errors.js";
import { clone, fetchInto, remoteUrlFor } from "../src/core/ops/network.js";
import { log, lsTree } from "../src/core/ops/reads.js";
import { fetchHttpClient, type GitHttpClient } from "../src/core/protocol/transport.js";
import type { Repository } from "../src/core/repository.js";
import { gitModeFor, type Worktree } from "../src/core/worktree.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServerOptions, startGitServer, startStubServer } from "./helpers/http-backend.js";
import { makeRepo, makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

interface Entry {
  mode: string;
  content: string;
}

const REFLOG_ACTOR = { name: "Network Actor", email: "network@example.com" };
const REFLOG_TIME = 1_700_000_000_000;

/** Every file under a real directory, keyed by relative path, `.git` aside. */
function nativeTree(root: string, prefix = ""): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const name of readdirSync(root)) {
    if (name === ".git") continue;
    const absolute = join(root, name);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const [key, value] of nativeTree(absolute, path)) out.set(key, value);
    } else if (stat.isSymbolicLink()) {
      out.set(path, { mode: "120000", content: readlinkSync(absolute) });
    } else {
      out.set(path, {
        mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
        content: readFileSync(absolute).toString("base64"),
      });
    }
  }
  return out;
}

/**
 * The same shape, read back out of DOFS. The type comes from `stat`, not
 * from the directory entry: DOFS reports a symlink as a plain file there.
 */
function worktreeTree(worktree: Worktree, root: string, prefix = ""): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const entry of worktree.readdir(root)) {
    const absolute = root === "/" ? `/${entry.name}` : `${root}/${entry.name}`;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const stat = worktree.stat(absolute);
    if (stat === null) throw new Error(`missing stat for ${absolute}`);
    if (stat.type === "dir") {
      for (const [key, value] of worktreeTree(worktree, absolute, path)) out.set(key, value);
      continue;
    }
    if (stat.type === "symlink") {
      out.set(path, { mode: "120000", content: worktree.readlink(absolute) });
      continue;
    }
    out.set(path, {
      mode: gitModeFor(stat),
      content: Buffer.from(worktree.readFile(absolute)).toString("base64"),
    });
  }
  return out;
}

/** A fixture exercising the modes a checkout has to get right. */
function makeFixture(): { fixture: GitFixture; first: string; head: string } {
  const fixture = new GitFixture();
  fixture.init();
  fixture.write("README.md", "hello\n");
  fixture.writeExecutable("bin/run.sh", "#!/bin/sh\necho hi\n");
  fixture.symlink("README.md", "readme-link");
  fixture.write("deep/nested/note.txt", "nested\n");
  fixture.write("data.bin", new Uint8Array([0, 1, 2, 255, 254, 0, 10, 13]));
  const first = fixture.commit("first");
  fixture.write("second.txt", "second\n");
  fixture.remove("deep/nested/note.txt");
  const head = fixture.commit("second");
  return { fixture, first, head };
}

const execFileAsync = promisify(execFile);

/**
 * The reference clone, run by the real git binary. It has to be
 * asynchronous: the test server shares this process's event loop, and a
 * synchronous child would deadlock against it.
 */
async function nativeGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  return stdout.trimEnd();
}

function createRemoteBranches(fixture: GitFixture, from: number, to: number, oid: string): void {
  let input = "";
  for (let index = from; index < to; index++) {
    input += `create refs/heads/bulk-${String(index).padStart(5, "0")} ${oid}\n`;
  }
  if (input === "") return;
  const result = spawnSync("git", ["update-ref", "--stdin"], {
    cwd: fixture.dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      LC_ALL: "C",
    },
    input,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "git update-ref failed");
}

function tableRows<Row extends object>(workspace: TestWorkspace, query: string): Row[] {
  return workspace.storage.sql.exec<Row>(query).toArray();
}

/** Every path segment DOFS holds under `root`, for the `.git` assertion. */
function allSegments(worktree: Worktree, root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of worktree.readdir(directory)) {
      out.push(entry.name);
      const absolute = directory === "/" ? `/${entry.name}` : `${directory}/${entry.name}`;
      if (worktree.stat(absolute)?.type === "dir") visit(absolute);
    }
  };
  visit(root);
  return out;
}

describe("clone", () => {
  it("materialises the same working tree as a native git clone", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(reference.dir, "clone", "--quiet", "--depth", "1", server.url, ".");
      await clone(workspace.context, { url: server.url, dir: "/work" });

      const expected = nativeTree(reference.dir);
      const actual = worktreeTree(workspace.worktree, "/work");
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [path, entry] of expected) expect([path, actual.get(path)]).toEqual([path, entry]);
      expect(await nativeGit(reference.dir, "rev-parse", "HEAD")).toBe(head);
    } finally {
      await server.close();
      reference.dispose();
      fixture.dispose();
    }
  });

  it("keeps the whole repository in SQL and leaves no .git behind", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });

      expect(tableRows(workspace, "SELECT root, head FROM git_checkouts")).toEqual([
        { root: "/work", head: "ref: refs/heads/main" },
      ]);
      expect(tableRows(workspace, "SELECT name, target FROM git_refs ORDER BY name")).toEqual([
        { name: "refs/heads/main", target: head },
        { name: "refs/remotes/origin/HEAD", target: "ref: refs/remotes/origin/main" },
        { name: "refs/remotes/origin/main", target: head },
      ]);
      expect(
        tableRows(workspace, "SELECT pack_id, state FROM git_pack_meta ORDER BY pack_id"),
      ).toEqual([{ pack_id: 1, state: "complete" }]);

      const files = worktreeTree(workspace.worktree, "/work");
      expect(
        tableRows<{ path: string }>(workspace, "SELECT path FROM git_index ORDER BY path").map(
          (row) => row.path,
        ),
      ).toEqual([...files.keys()].sort());
      expect(allSegments(workspace.worktree, "/work")).not.toContain(".git");
      expect(tableRows(workspace, "SELECT * FROM git_objects")).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("records clone fetch and checkout as exact ordered publications", async () => {
    const { fixture, head } = makeFixture();
    fixture.git("branch", "topic");
    fixture.git("tag", "v1");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({
      startTime: REFLOG_TIME,
      timezoneOffset: -90,
      now: () => REFLOG_TIME,
    });
    workspace.context.defaultIdentity = REFLOG_ACTOR;
    try {
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 0,
        singleBranch: false,
        noTags: false,
      });
      const repo = openRepository(workspace.context, "/work");

      const ordered = tableRows<{
        ref_name: string;
        ordinal: number;
        old_raw: string | null;
        new_raw: string | null;
        old_oid: string | null;
        new_oid: string | null;
        actor_name: string | null;
        actor_email: string | null;
        timestamp: number;
        timezone: number;
        reason: string;
      }>(
        workspace,
        `SELECT ref_name, ordinal, old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason FROM git_reflog_entries
          UNION ALL
         SELECT 'HEAD', ordinal, old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason FROM git_checkout_reflog_entries
          ORDER BY ordinal`,
      );
      expect(ordered).toEqual([
        {
          ref_name: "refs/remotes/origin/HEAD",
          ordinal: 1,
          old_raw: null,
          new_raw: "ref: refs/remotes/origin/main",
          old_oid: null,
          new_oid: head,
          actor_name: REFLOG_ACTOR.name,
          actor_email: REFLOG_ACTOR.email,
          timestamp: REFLOG_TIME / 1_000,
          timezone: -90,
          reason: "clone: fetch",
        },
        {
          ref_name: "refs/remotes/origin/main",
          ordinal: 2,
          old_raw: null,
          new_raw: head,
          old_oid: null,
          new_oid: head,
          actor_name: REFLOG_ACTOR.name,
          actor_email: REFLOG_ACTOR.email,
          timestamp: REFLOG_TIME / 1_000,
          timezone: -90,
          reason: "clone: fetch",
        },
        {
          ref_name: "refs/remotes/origin/topic",
          ordinal: 3,
          old_raw: null,
          new_raw: head,
          old_oid: null,
          new_oid: head,
          actor_name: REFLOG_ACTOR.name,
          actor_email: REFLOG_ACTOR.email,
          timestamp: REFLOG_TIME / 1_000,
          timezone: -90,
          reason: "clone: fetch",
        },
        {
          ref_name: "refs/tags/v1",
          ordinal: 4,
          old_raw: null,
          new_raw: head,
          old_oid: null,
          new_oid: head,
          actor_name: REFLOG_ACTOR.name,
          actor_email: REFLOG_ACTOR.email,
          timestamp: REFLOG_TIME / 1_000,
          timezone: -90,
          reason: "clone: fetch",
        },
        {
          ref_name: "refs/heads/main",
          ordinal: 5,
          old_raw: null,
          new_raw: head,
          old_oid: null,
          new_oid: head,
          actor_name: REFLOG_ACTOR.name,
          actor_email: REFLOG_ACTOR.email,
          timestamp: REFLOG_TIME / 1_000,
          timezone: -90,
          reason: "clone: checkout",
        },
        {
          ref_name: "HEAD",
          ordinal: 6,
          old_raw: "ref: refs/heads/main",
          new_raw: "ref: refs/heads/main",
          old_oid: null,
          new_oid: head,
          actor_name: REFLOG_ACTOR.name,
          actor_email: REFLOG_ACTOR.email,
          timestamp: REFLOG_TIME / 1_000,
          timezone: -90,
          reason: "clone: checkout",
        },
      ]);
      expect(repo.checkout.reflog("HEAD")[0]).toMatchObject({ oldOid: null, newOid: head });
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("reads back what the fixture's git reports", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });
      const repo = openRepository(workspace.context, "/work");

      expect(repo.revParse("HEAD")).toBe(head);
      expect(repo.head().ref).toBe(
        `refs/heads/${fixture.git("rev-parse", "--abbrev-ref", "HEAD")}`,
      );
      const entries = log(repo, { ref: "HEAD" });
      expect(entries.map((entry) => entry.oid)).toEqual([head]);
      expect(entries[0]?.message.trim()).toBe(fixture.git("log", "-1", "--format=%B").trim());

      const listed = lsTree(repo, "HEAD").map(
        (entry) => `${entry.mode} ${entry.type} ${entry.path}`,
      );
      const native = fixture
        .git("ls-tree", "HEAD")
        .split("\n")
        .map((line) => {
          const [meta, path] = line.split("\t");
          const [mode, type] = (meta ?? "").split(" ");
          return `${mode} ${type} ${path}`;
        });
      expect(listed.sort()).toEqual(native.sort());
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("records the shallow boundary and stops the walk there", async () => {
    const { fixture, first, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 1 });
      const repo = openRepository(workspace.context, "/work");

      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([{ oid: head }]);
      expect([...repo.walk(repo.revParse("HEAD"))].map((entry) => entry.oid)).toEqual([head]);
      expect(repo.has(first)).toBe(false);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("fetches full history when depth is disabled", async () => {
    const { fixture, first, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");

      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([]);
      expect([...repo.walk(repo.revParse("HEAD"))].map((entry) => entry.oid)).toEqual([
        head,
        first,
      ]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("holds memory to the configured budgets whatever the pack weighs", async () => {
    const chunkBytes = 5 * 1024 * 1024;
    const objectCacheBytes = 1024 * 1024;
    const fixture = new GitFixture();
    fixture.init();
    for (let i = 0; i < 24; i++) fixture.write(`blob-${i}.bin`, randomBytes(1024 * 1024));
    fixture.commit("bulk");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ chunkBytes, objectCacheBytes, cacheEntryLimit: 65536 });
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });
      const repo = openRepository(workspace.context, "/work");

      const packSize = tableRows<{ size: number }>(workspace, "SELECT size FROM git_pack_meta")[0];
      expect(packSize?.size ?? 0).toBeGreaterThan(4 * chunkBytes);
      const cached = repo.store.cacheBytes();
      // Non-zero as well as bounded: an empty cache would pass the bound
      // without proving anything about it.
      expect(cached.chunks).toBeGreaterThan(0);
      expect(cached.chunks).toBeLessThanOrEqual(chunkBytes);
      expect(cached.objects).toBeLessThanOrEqual(objectCacheBytes);
    } finally {
      await server.close();
      fixture.dispose();
    }
  }, 180_000);

  it("defaults to depth 1, a single branch and no tags", async () => {
    const { fixture, head } = makeFixture();
    fixture.git("branch", "topic");
    fixture.git("tag", "v1");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });
      const repo = openRepository(workspace.context, "/work");

      expect(repo.store.listRefs("refs/remotes/").map((ref) => ref.name)).toEqual([
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);
      expect(repo.tags()).toEqual([]);
      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([{ oid: head }]);
      expect(remoteUrlFor(repo, "origin")).toBe(server.url);
      expect(repo.store.configGet("branch.main.merge")).toBe("refs/heads/main");
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("goes through the transport the context supplies", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const seen: string[] = [];
    const workspace = makeWorkspace();
    const http: GitHttpClient = (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return fetchHttpClient(request);
    };
    try {
      await clone({ ...workspace.context, http }, { url: server.url, dir: "/work" });
      expect(openRepository(workspace.context, "/work").revParse("HEAD")).toBe(head);
      expect(seen.some((line) => line.startsWith("GET "))).toBe(true);
      expect(seen.some((line) => line.endsWith("/git-upload-pack"))).toBe(true);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("refuses to clone over an existing repository", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });
      await expect(
        clone(workspace.context, { url: server.url, dir: "/work" }),
      ).rejects.toMatchObject({ code: "EALREADYINIT" });
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("leaves nothing behind when the ref does not exist", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await expect(
        clone(workspace.context, { url: server.url, dir: "/work", ref: "no-such-branch" }),
      ).rejects.toMatchObject({ code: "EREFNOTFOUND" });
      expect(tableRows(workspace, "SELECT root FROM git_checkouts")).toEqual([]);
      expect(tableRows(workspace, "SELECT pack_id FROM git_pack_meta")).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("leaves nothing behind when the response is cut off mid-pack", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir, { truncatePostAfter: 200 });
    const workspace = makeWorkspace();
    try {
      const failure = await clone(workspace.context, { url: server.url, dir: "/work" }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(tableRows(workspace, "SELECT root FROM git_checkouts")).toEqual([]);
      expect(tableRows(workspace, "SELECT pack_id, state FROM git_pack_meta")).toEqual([]);
      expect(tableRows(workspace, "SELECT oid FROM git_pack_objects")).toEqual([]);
      expect(tableRows(workspace, "SELECT offset FROM git_pack_pending")).toEqual([]);
      expect(tableRows(workspace, "SELECT seq FROM git_pack_data")).toEqual([]);
      expect(tableRows(workspace, "SELECT ref_name FROM git_reflog_entries")).toEqual([]);
      expect(tableRows(workspace, "SELECT repo_id FROM git_reflog_state")).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("removes provisional clone history when checkout fails after ref publication", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ startTime: REFLOG_TIME, now: () => REFLOG_TIME });
    const injected = new GitError("EIO", "injected checkout failure");
    let provisionalEntries = 0;
    let provisionalReasons: string[] = [];
    let provisionalNextOrdinal: number | null = null;
    const worktree: Worktree = {
      ...workspace.worktree,
      writeFiles() {
        provisionalEntries =
          tableRows<{ count: number }>(
            workspace,
            `SELECT count(*) AS count FROM (
               SELECT ordinal FROM git_reflog_entries
               UNION ALL SELECT ordinal FROM git_checkout_reflog_entries
             )`,
          )[0]?.count ?? 0;
        provisionalReasons = tableRows<{ reason: string }>(
          workspace,
          `SELECT reason, ordinal FROM git_reflog_entries
           UNION ALL SELECT reason, ordinal FROM git_checkout_reflog_entries
           ORDER BY ordinal`,
        ).map((row) => row.reason);
        provisionalNextOrdinal =
          tableRows<{ next_ordinal: number }>(
            workspace,
            "SELECT next_ordinal FROM git_reflog_state",
          )[0]?.next_ordinal ?? null;
        throw injected;
      },
    };
    try {
      await expect(
        clone({ ...workspace.context, worktree }, { url: server.url, dir: "/work", depth: 0 }),
      ).rejects.toBe(injected);

      expect(provisionalEntries).toBe(4);
      expect(provisionalReasons).toEqual([
        "clone: fetch",
        "clone: fetch",
        "clone: checkout",
        "clone: checkout",
      ]);
      expect(provisionalNextOrdinal).toBe(4);
      expect(tableRows(workspace, "SELECT ref_name FROM git_reflog_entries")).toEqual([]);
      expect(tableRows(workspace, "SELECT repo_id FROM git_reflog_state")).toEqual([]);
      expect(tableRows(workspace, "SELECT root FROM git_checkouts")).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("reports a missing repository as an HTTP error", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await expect(
        clone(workspace.context, { url: `${server.url}-absent`, dir: "/work" }),
      ).rejects.toMatchObject({ code: "EHTTP", status: 404 });
      expect(tableRows(workspace, "SELECT root FROM git_checkouts")).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("retries an authenticated remote through onAuth", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir, { requireAuth: true });
    const workspace = makeWorkspace();
    try {
      await expect(
        clone(workspace.context, { url: server.url, dir: "/nope" }),
      ).rejects.toMatchObject({ code: "EHTTP", status: 401 });
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        onAuth: () => ({ username: "user", password: "secret" }),
      });
      expect(openRepository(workspace.context, "/work").revParse("HEAD")).toBe(head);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects a remote that is not smart HTTP", async () => {
    const server = await startStubServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("d1b2a3c4e5f60718293a4b5c6d7e8f9012345678\trefs/heads/main\n");
    });
    const workspace = makeWorkspace();
    try {
      await expect(
        clone(workspace.context, { url: server.url, dir: "/work" }),
      ).rejects.toMatchObject({ code: "ECORRUPT" });
      expect(tableRows(workspace, "SELECT root FROM git_checkouts")).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects a URL scheme it cannot speak", async () => {
    const workspace = makeWorkspace();
    await expect(
      clone(workspace.context, { url: "ssh://git@example.com/x.git", dir: "/work" }),
    ).rejects.toMatchObject({ code: "EURLSCHEME" });
    expect(tableRows(workspace, "SELECT root FROM git_checkouts")).toEqual([]);
  });
});

describe("fetch", () => {
  it("transfers only the new objects, then nothing at all", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({
      startTime: REFLOG_TIME,
      timezoneOffset: -90,
      now: () => REFLOG_TIME,
    });
    workspace.context.defaultIdentity = REFLOG_ACTOR;
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });
      const repo: Repository = openRepository(workspace.context, "/work");
      const firstPack = tableRows<{ count: number }>(
        workspace,
        "SELECT count FROM git_pack_meta ORDER BY pack_id",
      );

      fixture.write("third.txt", "third\n");
      const next = fixture.commit("third");
      workspace.tick(2_000);
      const result = await fetchInto(workspace.context, repo, { depth: 1, singleBranch: true });

      expect(result.fetchHead).toBe(next);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(next);
      expect(repo.readCommit(next).parent).toEqual([head]);
      expect(repo.store.getRef("refs/heads/main")).toBe(head);

      const packs = tableRows<{ pack_id: number; count: number; state: string }>(
        workspace,
        "SELECT pack_id, count, state FROM git_pack_meta ORDER BY pack_id",
      );
      expect(packs.length).toBe(2);
      expect(packs[1]?.state).toBe("complete");
      // The new commit, the new root tree and the one new blob — nothing else.
      expect(packs[1]?.count).toBe(3);
      expect(packs[1]?.count ?? 0).toBeLessThan(firstPack[0]?.count ?? 0);
      expect(repo.store.reflog("refs/remotes/origin/main")[0]).toMatchObject({
        oldRaw: head,
        newRaw: next,
        oldOid: head,
        newOid: next,
        actor: REFLOG_ACTOR,
        timestamp: REFLOG_TIME / 1_000 + 2,
        timezoneOffset: -90,
        reason: "fetch",
      });
      const historyAfterUpdate = repo.store.reflog("refs/remotes/origin/main").length;

      const posts = server.requests.filter((request) => request.method === "POST").length;
      const unchanged = await fetchInto(workspace.context, repo, { depth: 1, singleBranch: true });
      expect(unchanged.fetchHead).toBe(next);
      expect(server.requests.filter((request) => request.method === "POST").length).toBe(posts);
      expect(
        tableRows<{ pack_id: number }>(workspace, "SELECT pack_id FROM git_pack_meta").length,
      ).toBe(2);
      expect(repo.store.reflog("refs/remotes/origin/main")).toHaveLength(historyAfterUpdate);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("prunes tracking refs the remote has dropped", async () => {
    const { fixture } = makeFixture();
    fixture.git("branch", "topic");
    fixture.git("tag", "v1");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ startTime: REFLOG_TIME, now: () => REFLOG_TIME });
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      await fetchInto(workspace.context, repo, {
        depth: 0,
        singleBranch: false,
        tags: true,
      });
      expect(repo.store.getRef("refs/remotes/origin/topic")).not.toBeNull();
      expect(repo.store.reflog("refs/tags/v1")[0]).toMatchObject({
        oldRaw: null,
        newOid: repo.head().oid,
        reason: "fetch",
      });

      fixture.git("branch", "-D", "topic");
      await fetchInto(workspace.context, repo, { depth: 0, singleBranch: false, prune: true });
      expect(repo.store.getRef("refs/remotes/origin/topic")).toBeNull();
      expect(repo.store.getRef("refs/remotes/origin/main")).not.toBeNull();
      expect(repo.store.reflog("refs/remotes/origin/topic")[0]).toMatchObject({
        newRaw: null,
        newOid: null,
        reason: "fetch",
      });
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("does not publish tracking history when fetch pack ingest fails", async () => {
    const { fixture, head } = makeFixture();
    const serverOptions: GitServerOptions = {};
    const server = await startGitServer(fixture.dir, serverOptions);
    const workspace = makeWorkspace({ startTime: REFLOG_TIME, now: () => REFLOG_TIME });
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      const entries = repo.store.reflog("refs/remotes/origin/main").length;
      fixture.write("failed.txt", "failed\n");
      fixture.commit("failed fetch");
      serverOptions.truncatePostAfter = 200;

      const failure = await fetchInto(workspace.context, repo, {
        depth: 0,
        singleBranch: true,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(repo.store.reflog("refs/remotes/origin/main")).toHaveLength(entries);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("keeps bulk fetch and prune statement growth flat by page", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "bulk\n");
    const oid = fixture.commit("bulk refs");
    const server = await startGitServer(fixture.dir);
    const counts = [1, 1_000, 9_329];
    const statements: Array<{ refs: number; fetch: number; prune: number }> = [];
    let remoteBranches = 1;
    try {
      for (const count of counts) {
        createRemoteBranches(fixture, remoteBranches, count, oid);
        remoteBranches = count;
        const workspace = makeRepo("/work", {
          startTime: REFLOG_TIME,
          now: () => REFLOG_TIME,
        });
        workspace.repo.store.configSet("remote.origin.url", server.url);

        workspace.storage.resetCounters();
        await fetchInto(workspace.context, workspace.repo, {
          singleBranch: false,
        });
        const fetchStatements = workspace.storage.statementCount;
        expect(workspace.repo.store.listRefs("refs/remotes/origin/")).toHaveLength(count + 1);

        const stale = Array.from({ length: count }, (_, index) => ({
          name: `refs/remotes/origin/stale-${String(index).padStart(5, "0")}`,
          target: oid,
        }));
        workspace.repo.store.updateRefs(stale);
        workspace.storage.resetCounters();
        await fetchInto(workspace.context, workspace.repo, {
          singleBranch: false,
          prune: true,
        });
        const pruneStatements = workspace.storage.statementCount;
        expect(workspace.repo.store.getRef(stale[0]!.name)).toBeNull();
        expect(workspace.repo.store.getRef(stale[stale.length - 1]!.name)).toBeNull();
        statements.push({ refs: count, fetch: fetchStatements, prune: pruneStatements });
      }

      expect(statements).toEqual([
        { refs: 1, fetch: 31, prune: 15 },
        { refs: 1_000, fetch: 31, prune: 15 },
        { refs: 9_329, fetch: 43, prune: 27 },
      ]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("fails with a clear error when the remote is unknown", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ now: () => REFLOG_TIME });
    try {
      await clone(workspace.context, { url: server.url, dir: "/work" });
      const repo = openRepository(workspace.context, "/work");
      const entries = repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        repo.store.repoId,
      );
      await expect(
        fetchInto(workspace.context, repo, { remote: "upstream" }),
      ).rejects.toBeInstanceOf(GitError);
      expect(
        repo.store.db.scalar<number>(
          "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
          repo.store.repoId,
        ),
      ).toBe(entries);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});
