import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { GitError } from "../src/git/common/errors.js";
import { openRepository } from "../src/git/ops/context.js";
import { divergence, mergeBase } from "../src/git/ops/merge-base.js";
import { clone, fetchInto, remoteUrlFor } from "../src/git/ops/network.js";
import { log, lsTree } from "../src/git/ops/reads.js";
import type { Repository } from "../src/git/ops/repository.js";
import { gitModeFor, type Worktree } from "../src/git/ops/worktree.js";
import {
  fetchHttpClient,
  type GitHttpClient,
  type GitHttpRequest,
} from "../src/git/protocol/transport.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServerOptions, startGitServer, startStubServer } from "./helpers/http-backend.js";
import { makeRepo, makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";

interface Entry {
  mode: string;
  content: string;
}

const REFLOG_ACTOR = { name: "Network Actor", email: "network@example.com" };
const REFLOG_TIME = 1_700_000_000_000;
const packetDecoder = new TextDecoder();
const packetEncoder = new TextEncoder();

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

function makeCloneSelectionFixture(): {
  fixture: GitFixture;
  base: string;
  detached: string;
  mainTip: string;
  topicTip: string;
} {
  const fixture = new GitFixture().init();
  fixture.write("shared.txt", "base\n");
  const base = fixture.commit("base");
  fixture.git("branch", "topic");
  fixture.write("main.txt", "main one\n");
  fixture.commit("main one");
  fixture.write("main.txt", "main two\n");
  const mainTip = fixture.commit("main two");
  fixture.git("tag", "-a", "main-v1", "-m", "main release", mainTip);
  fixture.git("checkout", "-q", "topic");
  fixture.write("topic.txt", "topic\n");
  const topicTip = fixture.commit("topic");
  fixture.git("tag", "topic-v1", topicTip);
  const detached = fixture.git(
    "commit-tree",
    fixture.git("rev-parse", "HEAD^{tree}"),
    "-m",
    "detached",
  );
  fixture.git("tag", "detached", detached);
  fixture.git("checkout", "-q", "main");
  return { fixture, base, detached, mainTip, topicTip };
}

function outputLines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}

function resolvedRefLines(repo: Repository, prefix: string): string[] {
  return repo.store.listRefs(prefix).map((ref) => {
    const oid = repo.resolveRef(ref.name);
    if (oid === null) throw new Error(`could not resolve ${ref.name}`);
    return `${ref.name} ${oid}`;
  });
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

function rewriteFirstUploadLine(
  request: GitHttpRequest,
  rewrite: (line: string) => string,
): GitHttpRequest {
  if (request.method !== "POST" || !(request.body instanceof Uint8Array)) return request;
  const frameLength = Number.parseInt(packetDecoder.decode(request.body.subarray(0, 4)), 16);
  if (!Number.isSafeInteger(frameLength) || frameLength < 4 || frameLength > request.body.length) {
    throw new Error("invalid upload-pack request frame");
  }
  const line = packetDecoder.decode(request.body.subarray(4, frameLength));
  const rewritten = rewrite(line);
  if (rewritten === line) return request;
  const payload = packetEncoder.encode(rewritten);
  const header = packetEncoder.encode((payload.length + 4).toString(16).padStart(4, "0"));
  const body = new Uint8Array(header.length + payload.length + request.body.length - frameLength);
  body.set(header);
  body.set(payload, header.length);
  body.set(request.body.subarray(frameLength), header.length + payload.length);
  return { ...request, body };
}

function withoutIncludeTag(request: GitHttpRequest): GitHttpRequest {
  return rewriteFirstUploadLine(request, (line) => line.replace(" include-tag", ""));
}

async function* replaceResponseText(
  body: AsyncIterable<Uint8Array>,
  search: string,
  replacement: string,
): AsyncGenerator<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const text = packetDecoder.decode(joined);
  if (!text.includes(search)) throw new Error("advertised tag target was not found");
  yield packetEncoder.encode(text.replace(search, replacement));
}

async function* removeResponsePacket(
  body: AsyncIterable<Uint8Array>,
  marker: string,
): AsyncGenerator<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const text = packetDecoder.decode(joined);
  const markerOffset = text.indexOf(marker);
  if (markerOffset < 4) throw new Error("advertised tag packet was not found");
  const frameOffset = markerOffset - 4;
  const frameLength = Number.parseInt(text.slice(frameOffset, markerOffset), 16);
  if (!Number.isSafeInteger(frameLength) || frameLength < 4) {
    throw new Error("advertised tag packet was malformed");
  }
  yield packetEncoder.encode(text.slice(0, frameOffset) + text.slice(frameOffset + frameLength));
}

function createRemoteAnnotatedTags(fixture: GitFixture, count: number, oid: string): void {
  let input = "";
  for (let index = 0; index < count; index++) {
    const name = `bulk-${String(index).padStart(5, "0")}`;
    input += `tag ${name}\nfrom ${oid}\ntagger Fixture <fixture@example.com> 1 +0000\ndata ${name.length}\n${name}\n`;
  }
  const result = spawnSync("git", ["fast-import", "--quiet"], {
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
  if (result.status !== 0) throw new Error(result.stderr || "git fast-import failed");
}

function createAnnotatedTagChain(
  fixture: GitFixture,
  name: string,
  target: string,
  hops: number,
  messageBytes: number,
): string {
  const message = "x".repeat(messageBytes);
  let current = target;
  let type = "commit";
  for (let index = 0; index < hops; index++) {
    const data = packetEncoder.encode(
      `object ${current}\ntype ${type}\ntag ${name}-${index}\n` +
        "tagger Fixture <fixture@example.com> 1 +0000\n\n" +
        message,
    );
    current = fixture.writeObject("tag", data);
    type = "tag";
  }
  fixture.git("update-ref", `refs/tags/${name}`, current);
  return current;
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
      await nativeGit(reference.dir, "clone", "--quiet", server.url, ".");
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
    const { fixture, first, head } = makeFixture();
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
      expect(entries.map((entry) => entry.oid)).toEqual([head, first]);
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

  it("makes an explicit depth 1 clone shallow and single-branch like Git", async () => {
    const { fixture, base, mainTip } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(reference.dir, "clone", "--quiet", "--depth", "1", server.url, ".");
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 1 });
      const repo = openRepository(workspace.context, "/work");

      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/",
          ),
        ),
      );
      expect(resolvedRefLines(repo, "refs/tags/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags/",
          ),
        ),
      );
      expect(log(repo, { ref: "HEAD" }).map((entry) => entry.oid)).toEqual(
        outputLines(await nativeGit(reference.dir, "rev-list", "HEAD")),
      );
      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([{ oid: mainTip }]);
      expect(repo.has(base)).toBe(false);
    } finally {
      await server.close();
      reference.dispose();
      fixture.dispose();
    }
  });

  it("keeps depth 1 on all branches when singleBranch is explicitly false", async () => {
    const { fixture, base, detached, mainTip, topicTip } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(
        reference.dir,
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--no-single-branch",
        server.url,
        ".",
      );
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        depth: 1,
        singleBranch: false,
      });
      const repo = openRepository(workspace.context, "/work");

      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/",
          ),
        ),
      );
      expect(resolvedRefLines(repo, "refs/tags/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags/",
          ),
        ),
      );
      for (const ref of ["HEAD", "refs/remotes/origin/topic", "refs/tags/detached"]) {
        expect(log(repo, { ref }).map((entry) => entry.oid)).toEqual(
          outputLines(await nativeGit(reference.dir, "rev-list", ref)),
        );
      }
      const shallow = tableRows(workspace, "SELECT oid FROM git_shallow");
      expect(shallow).toHaveLength(3);
      expect(shallow).toEqual(
        expect.arrayContaining([{ oid: detached }, { oid: mainTip }, { oid: topicTip }]),
      );
      expect(repo.has(base)).toBe(false);
    } finally {
      await server.close();
      reference.dispose();
      fixture.dispose();
    }
  });

  it("keeps noTags independent on a depth 1 clone", async () => {
    const { fixture, mainTip } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(
        reference.dir,
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        server.url,
        ".",
      );
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 1, noTags: true });
      const repo = openRepository(workspace.context, "/work");

      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/",
          ),
        ),
      );
      expect(resolvedRefLines(repo, "refs/tags/")).toEqual([]);
      expect(log(repo, { ref: "HEAD" }).map((entry) => entry.oid)).toEqual(
        outputLines(await nativeGit(reference.dir, "rev-list", "HEAD")),
      );
      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([{ oid: mainTip }]);
    } finally {
      await server.close();
      reference.dispose();
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

  it("defaults to complete history, all branches and normal tag following", async () => {
    const { fixture, base } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(reference.dir, "clone", "--quiet", server.url, ".");
      await clone(workspace.context, { url: server.url, dir: "/work" });
      const repo = openRepository(workspace.context, "/work");

      const nativeRemoteRefs = outputLines(
        await nativeGit(
          reference.dir,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/remotes/",
        ),
      );
      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(nativeRemoteRefs);
      const nativeTags = outputLines(
        await nativeGit(
          reference.dir,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/tags/",
        ),
      );
      expect(resolvedRefLines(repo, "refs/tags/")).toEqual(nativeTags);

      expect(log(repo, { ref: "HEAD" }).map((entry) => entry.oid)).toEqual(
        outputLines(await nativeGit(reference.dir, "rev-list", "HEAD")),
      );
      expect(log(repo, { ref: "refs/remotes/origin/topic" }).map((entry) => entry.oid)).toEqual(
        outputLines(await nativeGit(reference.dir, "rev-list", "refs/remotes/origin/topic")),
      );
      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([]);

      const nativeBases = outputLines(
        await nativeGit(reference.dir, "merge-base", "--all", "HEAD", "refs/remotes/origin/topic"),
      );
      expect(nativeBases).toEqual([base]);
      expect(mergeBase(repo, { current: "HEAD", incoming: "refs/remotes/origin/topic" })).toEqual({
        kind: "divergent",
        bases: nativeBases,
      });
      const nativeCounts = (
        await nativeGit(
          reference.dir,
          "rev-list",
          "--left-right",
          "--count",
          "HEAD...refs/remotes/origin/topic",
        )
      )
        .split(/\s+/)
        .map(Number);
      const ahead = nativeCounts[0];
      const behind = nativeCounts[1];
      if (ahead === undefined || behind === undefined) {
        throw new Error("git did not report divergence counts");
      }
      expect(divergence(repo, { current: "HEAD", upstream: "refs/remotes/origin/topic" })).toEqual({
        relationship: "diverged",
        ahead,
        behind,
      });
      expect(remoteUrlFor(repo, "origin")).toBe(server.url);
      expect(repo.store.configGet("branch.main.merge")).toBe("refs/heads/main");
    } finally {
      await server.close();
      reference.dispose();
      fixture.dispose();
    }
  });

  it("keeps explicit singleBranch true limited to the remote HEAD branch", async () => {
    const { fixture } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(reference.dir, "clone", "--quiet", "--single-branch", server.url, ".");
      await clone(workspace.context, { url: server.url, dir: "/work", singleBranch: true });
      const repo = openRepository(workspace.context, "/work");

      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/",
          ),
        ),
      );
      expect(resolvedRefLines(repo, "refs/tags/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags/",
          ),
        ),
      );
      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([]);
    } finally {
      await server.close();
      reference.dispose();
      fixture.dispose();
    }
  });

  it("keeps explicit noTags false within a single branch's reachable tags", async () => {
    const { fixture } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(
        reference.dir,
        "clone",
        "--quiet",
        "--single-branch",
        "--tags",
        server.url,
        ".",
      );
      await clone(workspace.context, {
        url: server.url,
        dir: "/work",
        singleBranch: true,
        noTags: false,
      });
      const repo = openRepository(workspace.context, "/work");

      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/",
          ),
        ),
      );
      expect(resolvedRefLines(repo, "refs/tags/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/tags/",
          ),
        ),
      );
      expect(repo.tags()).toEqual(["main-v1"]);
    } finally {
      await server.close();
      reference.dispose();
      fixture.dispose();
    }
  });

  it("keeps explicit noTags true tagless while fetching all branches", async () => {
    const { fixture } = makeCloneSelectionFixture();
    const server = await startGitServer(fixture.dir);
    const reference = new GitFixture();
    const workspace = makeWorkspace();
    try {
      await nativeGit(reference.dir, "clone", "--quiet", "--no-tags", server.url, ".");
      await clone(workspace.context, { url: server.url, dir: "/work", noTags: true });
      const repo = openRepository(workspace.context, "/work");

      expect(resolvedRefLines(repo, "refs/remotes/")).toEqual(
        outputLines(
          await nativeGit(
            reference.dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/",
          ),
        ),
      );
      expect(repo.tags()).toEqual([]);
      expect(tableRows(workspace, "SELECT oid FROM git_shallow")).toEqual([]);
    } finally {
      await server.close();
      reference.dispose();
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

  it("auto-follows reachable tags and reserves tags: true for complete coverage", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("release.txt", "release\n");
      const release = fixture.commit("release");
      fixture.git("tag", "v1-light");
      fixture.git("tag", "-a", "v1-annotated", "-m", "release");
      const detached = fixture.git(
        "commit-tree",
        fixture.git("rev-parse", "HEAD^{tree}"),
        "-m",
        "detached",
      );
      fixture.git("tag", "detached", detached);

      const fetched = await fetchInto(workspace.context, repo, {});

      expect(fetched.fetchHead).toBe(release);
      expect(repo.store.getRef("refs/tags/v1-light")).toBe(release);
      const annotated = repo.store.getRef("refs/tags/v1-annotated");
      if (annotated === null) throw new Error("annotated tag was not fetched");
      expect(repo.peel(annotated)).toBe(release);
      expect(repo.store.getRef("refs/tags/detached")).toBeNull();

      await fetchInto(workspace.context, repo, { tags: true });
      expect(repo.store.getRef("refs/tags/detached")).toBe(detached);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("completes an annotated auto-tag when the server omits include-tag", async () => {
    const { fixture } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let posts = 0;
    const http: GitHttpClient = (request) => {
      if (request.method === "POST") posts++;
      return fetchHttpClient(withoutIncludeTag(request));
    };
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("release.txt", "release\n");
      const release = fixture.commit("release");
      fixture.git("tag", "-a", "v2", "-m", "release");
      posts = 0;

      await fetchInto({ ...workspace.context, http }, repo, {});

      const tag = repo.store.getRef("refs/tags/v2");
      if (tag === null) throw new Error("annotated tag was not fetched");
      expect(repo.peel(tag)).toBe(release);
      expect(posts).toBe(2);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("does not publish refs when the annotated-tag fallback stays incomplete", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let posts = 0;
    let tagOid = "";
    let release = "";
    const http: GitHttpClient = (request) => {
      if (request.method !== "POST") return fetchHttpClient(request);
      posts++;
      const withoutTag = withoutIncludeTag(request);
      const forwarded =
        posts === 2
          ? rewriteFirstUploadLine(withoutTag, (line) =>
              line.replace(`want ${tagOid}`, `want ${release}`),
            )
          : withoutTag;
      return fetchHttpClient(forwarded);
    };
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("release.txt", "release\n");
      release = fixture.commit("release");
      fixture.git("tag", "-a", "v2", "-m", "release");
      tagOid = fixture.git("rev-parse", "refs/tags/v2");
      posts = 0;

      await expect(fetchInto({ ...workspace.context, http }, repo, {})).rejects.toMatchObject({
        code: "EFETCHFAIL",
      });

      expect(posts).toBe(2);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(repo.store.getRef("refs/tags/v2")).toBeNull();
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects an annotated tag whose chain disagrees with its advertised peeled target", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let release = "";
    const http: GitHttpClient = async (request) => {
      const response = await fetchHttpClient(request);
      if (request.method !== "GET") return response;
      return {
        ...response,
        body: replaceResponseText(
          response.body,
          `${release} refs/tags/v2^{}`,
          `${head} refs/tags/v2^{}`,
        ),
      };
    };
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("release.txt", "release\n");
      release = fixture.commit("release");
      fixture.git("tag", "-a", "v2", "-m", "release");

      await expect(fetchInto({ ...workspace.context, http }, repo, {})).rejects.toMatchObject({
        code: "ECORRUPT",
      });

      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(repo.store.getRef("refs/tags/v2")).toBeNull();
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects an annotated tag without an advertised peeled target", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let release = "";
    const http: GitHttpClient = async (request) => {
      const response = await fetchHttpClient(request);
      if (request.method !== "GET") return response;
      return {
        ...response,
        body: removeResponsePacket(response.body, `${release} refs/tags/broken^{}\n`),
      };
    };
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("release.txt", "release\n");
      release = fixture.commit("release");
      fixture.git("tag", "-a", "broken", "-m", "release");

      await expect(
        fetchInto({ ...workspace.context, http }, repo, { tags: true }),
      ).rejects.toMatchObject({ code: "ECORRUPT" });

      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(repo.store.getRef("refs/tags/broken")).toBeNull();
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects required tag drift after the network round trip", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    let enterPost = (): void => {};
    let releasePost = (): void => {};
    const entered = new Promise<void>((resolve) => {
      enterPost = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const http: GitHttpClient = async (request) => {
      const response = await fetchHttpClient(request);
      if (request.method === "POST") {
        enterPost();
        await released;
      }
      return response;
    };
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.write("release.txt", "release\n");
      fixture.commit("release");
      fixture.git("tag", "release");
      const fetching = fetchInto({ ...workspace.context, http }, repo, { tags: true });
      await entered;
      repo.store.setRef("refs/tags/release", head);
      releasePost();

      await expect(fetching).rejects.toMatchObject({ code: "ESTALEFETCH" });
      expect(repo.store.getRef("refs/tags/release")).toBe(head);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
    } finally {
      releasePost();
      await server.close();
      fixture.dispose();
    }
  });

  it("keeps explicit selectors tagless and honors tags: false", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      fixture.git("checkout", "-q", "-b", "topic");
      fixture.write("topic.txt", "topic\n");
      const topic = fixture.commit("topic");
      fixture.git("tag", "topic-tag");
      fixture.git("checkout", "-q", "main");
      fixture.write("main.txt", "main\n");
      const main = fixture.commit("main");
      fixture.git("tag", "main-tag");

      const explicit = await fetchInto(workspace.context, repo, { remoteRef: "topic" });
      expect(explicit.fetchHead).toBe(topic);
      expect(repo.store.getRef("refs/remotes/origin/topic")).toBe(topic);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(head);
      expect(repo.tags()).toEqual([]);

      const withoutTags = await fetchInto(workspace.context, repo, {
        singleBranch: true,
        tags: false,
      });
      expect(withoutTags.fetchHead).toBe(main);
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(main);
      expect(repo.tags()).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("does not create a dangling remote HEAD when prune fetches another branch", async () => {
    const { fixture } = makeFixture();
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("topic.txt", "topic\n");
    const topic = fixture.commit("topic");
    fixture.git("checkout", "-q", "main");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    try {
      await fetchInto(workspace.context, workspace.repo, {
        url: server.url,
        remoteRef: "topic",
        singleBranch: true,
        tags: false,
        prune: true,
      });

      expect(workspace.repo.store.getRef("refs/remotes/origin/topic")).toBe(topic);
      expect(workspace.repo.store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(workspace.repo.store.getRef("refs/remotes/origin/HEAD")).toBeNull();
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("preserves auto-followed local tags and rejects tags: true clobbers", async () => {
    const { fixture, head } = makeFixture();
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace();
    try {
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0 });
      const repo = openRepository(workspace.context, "/work");
      repo.store.setRef("refs/tags/release", head);
      fixture.write("release.txt", "release\n");
      const release = fixture.commit("release");
      fixture.git("tag", "release");

      await fetchInto(workspace.context, repo, {});
      expect(repo.store.getRef("refs/remotes/origin/main")).toBe(release);
      expect(repo.store.getRef("refs/tags/release")).toBe(head);

      await expect(
        fetchInto(workspace.context, repo, { remoteRef: "refs/tags/release" }),
      ).rejects.toMatchObject({ code: "ETAGFAIL" });
      await expect(fetchInto(workspace.context, repo, { tags: true })).rejects.toMatchObject({
        code: "ETAGFAIL",
      });
      expect(repo.store.getRef("refs/tags/release")).toBe(head);
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
      await clone(workspace.context, { url: server.url, dir: "/work", depth: 0, noTags: true });
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

  it("keeps bulk fetch and prune within the statement target at scale", async () => {
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

      expect(statements.map(({ refs }) => refs)).toEqual([1, 1_000, 9_329]);
      expect(statements.every(({ fetch, prune }) => fetch < 1_000 && prune < 1_000)).toBe(true);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("authenticates many annotated tags in bounded pages", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "bulk tags\n");
    const oid = fixture.commit("bulk tags");
    createRemoteAnnotatedTags(fixture, 4_100, oid);
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    workspace.repo.store.configSet("remote.origin.url", server.url);
    try {
      workspace.storage.resetCounters();
      await fetchInto(workspace.context, workspace.repo, { tags: true });

      expect(workspace.repo.tags()).toHaveLength(4_100);
      expect(workspace.repo.store.getRef("refs/tags/bulk-00000")).not.toBeNull();
      expect(workspace.repo.store.getRef("refs/tags/bulk-04099")).not.toBeNull();
      expect(workspace.storage.statementCount).toBeLessThan(1_000);
    } finally {
      await server.close();
      fixture.dispose();
    }
  }, 180_000);

  it("authenticates more than 64 MiB across tag hops", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "tag chains\n");
    const commit = fixture.commit("tag chains");
    const hops = 15;
    const messageBytes = 2_300_000;
    const first = createAnnotatedTagChain(fixture, "large-a", commit, hops, messageBytes);
    const second = createAnnotatedTagChain(fixture, "large-b", commit, hops, messageBytes);
    fixture.git("config", "pack.window", "0");
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    workspace.repo.store.configSet("remote.origin.url", server.url);
    try {
      await fetchInto(workspace.context, workspace.repo, { tags: true });

      expect(messageBytes * hops * 2).toBeGreaterThan(64 * 1024 * 1024);
      expect(workspace.repo.store.getRef("refs/tags/large-a")).toBe(first);
      expect(workspace.repo.store.getRef("refs/tags/large-b")).toBe(second);
      expect(workspace.repo.peel(first)).toBe(commit);
      expect(workspace.repo.peel(second)).toBe(commit);
    } finally {
      await server.close();
      fixture.dispose();
    }
  }, 30_000);

  it("keeps the tag peel depth bound after removing cumulative byte admission", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "deep tag\n");
    const commit = fixture.commit("deep tag");
    createAnnotatedTagChain(fixture, "too-deep", commit, 16, 0);
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    workspace.repo.store.configSet("remote.origin.url", server.url);
    try {
      await expect(
        fetchInto(workspace.context, workspace.repo, { tags: true }),
      ).rejects.toMatchObject({ code: "ECORRUPT" });
      expect(workspace.repo.store.getRef("refs/tags/too-deep")).toBeNull();
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects an over-limit advertisement before publishing any ref", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "bounded\n");
    const oid = fixture.commit("bounded advertisement");
    createRemoteBranches(fixture, 1, 16_385, oid);
    const server = await startGitServer(fixture.dir);
    const workspace = makeRepo("/work");
    workspace.repo.store.configSet("remote.origin.url", server.url);
    workspace.repo.store.setRef("refs/remotes/origin/retained", oid);
    const before = workspace.repo.store.listRefs();
    try {
      await expect(fetchInto(workspace.context, workspace.repo, {})).rejects.toMatchObject({
        code: "E2BIG",
      });
      expect(workspace.repo.store.listRefs()).toEqual(before);
      expect(tableRows(workspace, "SELECT pack_id FROM git_pack_meta")).toEqual([]);
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
