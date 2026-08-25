// The acceptance test for the whole experiment: a real Computer Workspace
// configured with `createSqliteGitClient()`, driven only through
// `workspace.git`, with no Computer fork anywhere.

import { Workspace } from "@cloudflare/computer";
import { afterAll, describe, expect, it } from "vitest";

import { ComputerWorktree, createSqliteGitClient } from "../src/compat/computer.js";
import { createGit, type Git } from "../src/git/client.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import {
  makeWorkspace as makeTestWorkspace,
  type TestWorkspace,
  writeWorkFile,
} from "./helpers/workspace.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };

function makeWorkspace(): { workspace: Workspace; storage: SqliteTestStorage } {
  const storage = new SqliteTestStorage();
  const workspace = new Workspace({
    storage,
    git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
    defaultGitIdentity: IDENTITY,
  });
  return { workspace, storage };
}

function makeNativeGit(): { git: Git; workspace: TestWorkspace } {
  const workspace = makeTestWorkspace();
  return { git: bindNativeGit(workspace), workspace };
}

function bindNativeGit(workspace: TestWorkspace): Git {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
  });
}

async function commitFile(
  git: Git,
  workspace: TestWorkspace,
  dir: string,
  path: string,
  contents: string,
  message: string,
): Promise<string> {
  writeWorkFile(workspace, `${dir === "/" ? "" : dir}/${path}`, contents);
  await git.add({ dir, paths: [path] });
  return (await git.commit({ dir, message })).oid;
}

async function conflictingRebase(): Promise<{
  git: Git;
  workspace: TestWorkspace;
  dir: string;
  original: string;
  upstream: string;
}> {
  const { git, workspace } = makeNativeGit();
  const dir = "/rebase";
  await git.init({ dir });
  await commitFile(git, workspace, dir, "shared.txt", "base\n", "base");
  await git.branch({ dir, name: "upstream" });
  await git.branch({ dir, name: "spare" });
  await git.tag({ dir, name: "before-rebase" });
  await git.checkout({ dir, ref: "upstream" });
  const upstream = await commitFile(git, workspace, dir, "shared.txt", "upstream\n", "upstream");
  await git.checkout({ dir, ref: "main" });
  const original = await commitFile(git, workspace, dir, "shared.txt", "current\n", "current");
  await expect(git.rebase({ dir, upstream: "upstream" })).resolves.toEqual({
    outcome: "conflicted",
    replayed: 0,
    skipped: 0,
  });
  return { git, workspace, dir, original, upstream };
}

async function modifyDeleteRebase(): Promise<{
  git: Git;
  workspace: TestWorkspace;
  dir: string;
  original: string;
}> {
  const { git, workspace } = makeNativeGit();
  const dir = "/modify-delete";
  await git.init({ dir });
  await commitFile(git, workspace, dir, "deleted.txt", "base\n", "base");
  await git.branch({ dir, name: "upstream" });
  await git.checkout({ dir, ref: "upstream" });
  await commitFile(git, workspace, dir, "deleted.txt", "upstream\n", "upstream modifies");
  await git.checkout({ dir, ref: "main" });
  workspace.worktree.removeFiles([`${dir}/deleted.txt`]);
  await git.add({ dir, paths: ["deleted.txt"] });
  const original = (await git.commit({ dir, message: "current deletes" })).oid;
  await expect(git.rebase({ dir, upstream: "upstream" })).resolves.toMatchObject({
    outcome: "conflicted",
  });
  return { git, workspace, dir, original };
}

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

describe("createSqliteGitClient", () => {
  it("exposes native status options and keeps nested repositories excluded", async () => {
    const { git, workspace } = makeNativeGit();
    await git.init({ dir: "/" });
    await commitFile(git, workspace, "/", ".gitignore", "*.log\n", "ignore logs");
    await git.init({ dir: "/nested" });
    writeWorkFile(workspace, "/nested/inside.txt", "nested\n");
    writeWorkFile(workspace, "/debug.log", "ignored\n");
    writeWorkFile(workspace, "/fresh/a.txt", "a\n");
    writeWorkFile(workspace, "/fresh/b.txt", "b\n");

    await expect(git.status()).resolves.toEqual([{ path: "fresh/", index: " ", worktree: "?" }]);
    await expect(git.status({ paths: ["fresh"], untrackedFiles: "all" })).resolves.toEqual([
      { path: "fresh/a.txt", index: " ", worktree: "?" },
      { path: "fresh/b.txt", index: " ", worktree: "?" },
    ]);
    await expect(
      git.status({ paths: ["debug.log"], includeIgnored: true, untrackedFiles: "all" }),
    ).resolves.toEqual([{ path: "debug.log", index: "!", worktree: "!" }]);

    const report = await git.statusReport({ branch: true, paths: ["fresh"] });
    expect(report).toEqual({
      entries: [{ path: "fresh/", index: " ", worktree: "?" }],
      branch: { oid: expect.any(String), head: "main" },
    });
    await expect(git.statusReport({ paths: ["fresh"] })).resolves.toEqual({
      entries: [{ path: "fresh/", index: " ", worktree: "?" }],
    });
  });

  it("drives a full local cycle through workspace.git", async () => {
    const { workspace, storage } = makeWorkspace();
    const git = workspace.git;

    await git.init({ dir: "/" });
    expect(await git.currentBranch()).toBe("main");

    await workspace.fs.writeFile("/README.md", "# demo\n");
    await workspace.fs.mkdir("/src", { recursive: true });
    await workspace.fs.writeFile("/src/a.ts", "export const a = 1;\n");

    // Exactly the interface's shape, with nothing extra riding along.
    expect(await git.status()).toEqual([
      { path: "README.md", index: " ", worktree: "?" },
      { path: "src/", index: " ", worktree: "?" },
    ]);

    await git.add({ paths: ["."], all: true });
    const { oid } = await git.commit({ message: "first" });
    expect(await git.revParse({ ref: "HEAD" })).toBe(oid);
    expect(await git.status()).toEqual([]);

    await workspace.fs.writeFile("/src/a.ts", "export const a = 2;\n");
    expect(await git.status()).toEqual([{ path: "src/a.ts", index: " ", worktree: "M" }]);
    expect(await git.diff()).toContain("-export const a = 1;");
    expect(await git.diffSummary()).toEqual([
      { path: "src/a.ts", status: "M", insertions: 1, deletions: 1 },
    ]);

    await git.add({ paths: ["src/a.ts"] });
    const second = await git.commit({ message: "second" });
    expect((await git.log()).map((entry) => entry.message.trim())).toEqual(["second", "first"]);
    expect((await git.show({ ref: "HEAD" })).oid).toBe(second.oid);
    expect(await git.lsFiles()).toEqual(["README.md", "src/a.ts"]);

    await git.branch({ name: "topic" });
    expect(await git.branchList()).toEqual(["main", "topic"]);
    await git.checkout({ ref: "topic" });
    expect(await git.currentBranch()).toBe("topic");

    // Nothing about this repository lives on disk.
    const paths = await workspace.fs.ls("/");
    expect(paths.some((path) => path.includes(".git"))).toBe(false);
    const tables = storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name);
    expect(tables).toContain("git_repositories");
    expect(tables).toContain("git_index");
  });

  it("uses the workspace's default identity when nothing else supplies one", async () => {
    const { workspace } = makeWorkspace();
    await workspace.git.init({});
    await workspace.fs.writeFile("/a.txt", "a\n");
    await workspace.git.add({ paths: ["a.txt"] });
    const { oid } = await workspace.git.commit({ message: "identity" });
    const view = await workspace.git.show({ ref: oid });
    expect(view.author).toMatchObject(IDENTITY);
  });

  it("keeps native rm inside its repository and nested-root boundaries", async () => {
    const { git, workspace } = makeNativeGit();
    await git.init({ dir: "/" });
    writeWorkFile(workspace, "/top.txt", "top\n");
    writeWorkFile(workspace, "/nested/owned-by-parent.txt", "nested\n");
    await git.add({ dir: "/", paths: ["."], all: true });
    await git.commit({ dir: "/", message: "parent" });
    await git.init({ dir: "/nested" });

    await git.rm({ dir: "/", paths: ["."], recursive: true });

    await expect(git.lsFiles({ dir: "/" })).resolves.toEqual(["nested/owned-by-parent.txt"]);
    expect(workspace.worktree.stat("/top.txt")).toBeNull();
    expect(workspace.worktree.stat("/nested/owned-by-parent.txt")).not.toBeNull();
    await expect(git.repoRoot({ dir: "/nested" })).resolves.toBe("/nested");
  });

  it("clones a remote and reports structured progress", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "# remote\n");
    fixture.write("lib/index.ts", "export const x = 1;\n");
    fixture.commit("remote work");

    const server = await startGitServer(fixture.dir);
    try {
      const { workspace } = makeWorkspace();
      const phases: string[] = [];
      const messages: string[] = [];
      await workspace.git.clone({
        url: server.url,
        dir: "/",
        onProgress: (event) => phases.push(event.phase),
        onMessage: (message) => messages.push(message),
      });

      expect(await workspace.fs.readFile("/README.md", "utf8")).toBe("# remote\n");
      expect(await workspace.git.revParse({ ref: "HEAD" })).toBe(fixture.git("rev-parse", "HEAD"));
      expect(await workspace.git.lsFiles()).toEqual(["README.md", "lib/index.ts"]);
      // The remote said something, and it parsed into a phase rather than
      // arriving only as free text.
      expect(messages.length).toBeGreaterThan(0);
      expect(phases.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("pushes a committed change through Smart HTTP", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "before\n");
    fixture.commit("initial");
    fixture.git("config", "receive.denyCurrentBranch", "updateInstead");

    const server = await startGitServer(fixture.dir);
    try {
      const { workspace } = makeWorkspace();
      await workspace.git.clone({ url: server.url, dir: "/" });
      await workspace.fs.writeFile("/README.md", "after\n");
      await workspace.git.add({ paths: ["README.md"] });
      const local = await workspace.git.commit({ message: "local change" });

      const result = await workspace.git.push({});
      expect(result).toEqual({
        ok: true,
        error: null,
        refs: { "refs/heads/main": { ok: true } },
      });
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(local.oid);
      expect(fixture.git("show", "HEAD:README.md")).toBe("after");
    } finally {
      await server.close();
    }
  });

  it("pulls through the compatibility surface and rolls conflicts back locally", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("conflict.txt", "base\n");
    fixture.commit("base");
    const server = await startGitServer(fixture.dir);
    try {
      const { workspace } = makeWorkspace();
      const git = workspace.git;
      await git.clone({ url: server.url, dir: "/", depth: 0 });

      fixture.write("remote.txt", "remote\n");
      const fastForward = fixture.commit("remote fast-forward");
      await expect(git.pull({})).resolves.toBeUndefined();
      expect(await git.revParse({ ref: "HEAD" })).toBe(fastForward);

      await workspace.fs.writeFile("/conflict.txt", "local\n");
      await git.add({ paths: ["conflict.txt"] });
      const local = await git.commit({ message: "local" });
      fixture.write("conflict.txt", "incoming\n");
      const incoming = fixture.commit("incoming");

      await expect(git.pull({})).rejects.toMatchObject({ code: "EMERGEFAIL" });
      expect(await git.revParse({ ref: "HEAD" })).toBe(local.oid);
      expect(await git.revParse({ ref: "refs/remotes/origin/main" })).toBe(incoming);
      expect(await workspace.fs.readFile("/conflict.txt", "utf8")).toBe("local\n");
      expect(await git.status()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rolls a compatibility merge conflict back without pending state", async () => {
    const { workspace } = makeWorkspace();
    const git = workspace.git;
    await git.init({});
    await workspace.fs.writeFile("/conflict.txt", "base\n");
    await git.add({ paths: ["conflict.txt"] });
    await git.commit({ message: "base" });
    await git.branch({ name: "topic" });
    await git.checkout({ ref: "topic" });
    await workspace.fs.writeFile("/conflict.txt", "incoming\n");
    await git.add({ paths: ["conflict.txt"] });
    await git.commit({ message: "topic" });
    await git.checkout({ ref: "main" });
    await workspace.fs.writeFile("/conflict.txt", "current\n");
    await git.add({ paths: ["conflict.txt"] });
    const current = await git.commit({ message: "main" });

    await expect(git.merge({ theirs: "topic" })).rejects.toMatchObject({ code: "EMERGEFAIL" });
    expect(await git.revParse({ ref: "HEAD" })).toBe(current.oid);
    expect(await workspace.fs.readFile("/conflict.txt", "utf8")).toBe("current\n");
    expect(await git.status()).toEqual([]);
    await expect(git.merge({ theirs: "topic" })).rejects.toMatchObject({ code: "EMERGEFAIL" });
  });

  it("blocks compatibility commit while a native merge is pending", async () => {
    const { workspace, storage } = makeWorkspace();
    const compat = workspace.git;
    await compat.init({});
    await workspace.fs.writeFile("/base.txt", "base\n");
    await compat.add({ paths: ["base.txt"] });
    await compat.commit({ message: "base" });
    await compat.branch({ name: "topic" });
    await compat.checkout({ ref: "topic" });
    await workspace.fs.writeFile("/topic.txt", "topic\n");
    await compat.add({ paths: ["topic.txt"] });
    await compat.commit({ message: "topic" });
    await compat.checkout({ ref: "main" });
    await workspace.fs.writeFile("/main.txt", "main\n");
    await compat.add({ paths: ["main.txt"] });
    const current = await compat.commit({ message: "main" });

    const native = createGit()({
      database: new SqliteGitDatabase(new TestDatabase(storage)),
      worktree: new ComputerWorktree(workspace.provider()),
      now: () => 1_600_000_000_000,
      timezoneOffset: () => 0,
      defaultIdentity: IDENTITY,
    });
    await expect(native.merge({ theirs: "topic", commit: false })).resolves.toEqual({
      pendingCommit: true,
    });

    await expect(
      compat.commit({ message: "must not bypass merge continuation" }),
    ).rejects.toMatchObject({
      code: "EMERGEACTIVE",
    });
    expect(await compat.revParse({ ref: "HEAD" })).toBe(current.oid);
    await expect(native.merge({ theirs: "topic" })).rejects.toMatchObject({
      code: "EMERGEACTIVE",
    });
  });

  it("reports native conflicts after reopen and rejects them on the Computer facade", async () => {
    const { workspace, storage } = makeWorkspace();
    const compat = workspace.git;
    await compat.init({});
    await workspace.fs.writeFile("/conflict.txt", "base\n");
    await compat.add({ paths: ["conflict.txt"] });
    await compat.commit({ message: "base" });
    await compat.branch({ name: "topic" });
    await compat.checkout({ ref: "topic" });
    await workspace.fs.writeFile("/conflict.txt", "incoming\n");
    await compat.add({ paths: ["conflict.txt"] });
    await compat.commit({ message: "topic" });
    await compat.checkout({ ref: "main" });
    await workspace.fs.writeFile("/conflict.txt", "current\n");
    await compat.add({ paths: ["conflict.txt"] });
    await compat.commit({ message: "main" });

    const binding = {
      database: new SqliteGitDatabase(new TestDatabase(storage)),
      worktree: new ComputerWorktree(workspace.provider()),
      now: () => 1_600_000_000_000,
      timezoneOffset: () => 0,
      defaultIdentity: IDENTITY,
    };
    const native = createGit()(binding);
    await expect(native.merge({ theirs: "topic" })).resolves.toEqual({
      conflicted: true,
      pendingCommit: true,
    });
    const reopened = createGit()(binding);

    await expect(reopened.status()).resolves.toEqual([
      { path: "conflict.txt", index: "U", worktree: "U" },
    ]);
    await expect(compat.status()).rejects.toMatchObject({ code: "EUNMERGED" });
  });

  it("blocks ordinary native commit during replay and lets hard reset clear it", async () => {
    const { workspace, storage } = makeWorkspace();
    await workspace.git.init({});
    await workspace.fs.writeFile("/file.txt", "base\n");
    await workspace.git.add({ paths: ["file.txt"] });
    const original = await workspace.git.commit({ message: "base" });
    const database = new SqliteGitDatabase(new TestDatabase(storage));
    const repository = database.find("/");
    if (repository === null) throw new Error("repository is missing");
    const store = database.open(repository);
    store.writeOperationState(
      {
        kind: "cherry-pick",
        originalHeadRef: "refs/heads/main",
        originalHeadOid: original.oid,
        phase: "empty",
        emptyReason: "result",
        sourceOid: original.oid,
        selectedParentOid: null,
        mainline: null,
        currentLabel: "HEAD",
        incomingLabel: original.oid.slice(0, 7),
        message: "base\n",
        author: null,
        committer: null,
      },
      [],
    );
    const native = createGit()({
      database,
      worktree: new ComputerWorktree(workspace.provider()),
      now: () => 1_600_000_000_000,
      timezoneOffset: () => 0,
      defaultIdentity: IDENTITY,
    });

    await expect(native.commit({ message: "must not continue replay" })).rejects.toMatchObject({
      code: "EOPACTIVE",
    });
    await native.reset({ hard: true });
    expect(store.readOperationState()).toBeNull();
    expect(store.getRef("refs/heads/main")).toBe(original.oid);
  });

  it("routes clean cherry-pick and revert through a selected repository", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/nested/repo";
    await git.init({ dir });
    await commitFile(git, workspace, dir, "base.txt", "base\n", "base");
    await git.branch({ dir, name: "topic" });
    await git.checkout({ dir, ref: "topic" });
    const source = await commitFile(git, workspace, dir, "topic.txt", "topic\n", "topic");
    await git.checkout({ dir, ref: "main" });

    const picked = await git.cherryPick({ dir, source });

    expect(picked.outcome).toBe("committed");
    expect(workspace.workspace.fs.readFileSync(`${dir}/topic.txt`, "utf8")).toBe("topic\n");

    const reverted = await git.revert({ dir, source });

    expect(reverted.outcome).toBe("committed");
    expect(workspace.workspace.fs.existsSync(`${dir}/topic.txt`)).toBe(false);
  });

  it("routes conflicted cherry-pick and revert continuations", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/nested/repo";
    await git.init({ dir });
    await commitFile(git, workspace, dir, "conflict.txt", "base\n", "base");
    await git.branch({ dir, name: "topic" });
    await git.checkout({ dir, ref: "topic" });
    const source = await commitFile(git, workspace, dir, "conflict.txt", "incoming\n", "topic");
    await git.checkout({ dir, ref: "main" });
    await commitFile(git, workspace, dir, "conflict.txt", "current\n", "main");

    await expect(git.cherryPick({ dir, source })).resolves.toEqual({ outcome: "conflicted" });
    await expect(git.status({ dir })).resolves.toEqual([
      { path: "conflict.txt", index: "U", worktree: "U" },
    ]);
    writeWorkFile(workspace, `${dir}/conflict.txt`, "resolved\n");
    await git.add({ dir, paths: ["conflict.txt"] });
    await expect(git.cherryPickContinue({ dir })).resolves.toMatchObject({ outcome: "committed" });

    await expect(git.revert({ dir, source })).resolves.toEqual({ outcome: "conflicted" });
    await expect(git.status({ dir })).resolves.toEqual([
      { path: "conflict.txt", index: "U", worktree: "U" },
    ]);
    await expect(git.cherryPickContinue({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    await expect(git.cherryPickSkip({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    await expect(git.cherryPickAbort({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    writeWorkFile(workspace, `${dir}/conflict.txt`, "base\n");
    await git.add({ dir, paths: ["conflict.txt"] });
    await expect(git.revertContinue({ dir })).resolves.toMatchObject({ outcome: "committed" });
  });

  it("routes replay cancellation, wrong-kind, and no-active calls", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/nested/repo";
    await git.init({ dir });
    await commitFile(git, workspace, dir, "same.txt", "base\n", "base");
    await git.branch({ dir, name: "topic" });
    await git.checkout({ dir, ref: "topic" });
    const source = await commitFile(git, workspace, dir, "same.txt", "same\n", "topic");
    await git.checkout({ dir, ref: "main" });
    await commitFile(git, workspace, dir, "same.txt", "same\n", "main");

    await expect(git.cherryPick({ dir, source })).resolves.toEqual({
      outcome: "empty",
      reason: "result",
    });
    await expect(git.revertContinue({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    await expect(git.revertSkip({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    await expect(git.revertAbort({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    await expect(git.cherryPickSkip({ dir })).resolves.toBeUndefined();

    await expect(git.cherryPick({ dir, source })).resolves.toMatchObject({ outcome: "empty" });
    await expect(git.cherryPickAbort({ dir })).resolves.toBeUndefined();
    await expect(git.cherryPickContinue({ dir })).rejects.toMatchObject({
      code: "ENOCHERRYPICK",
    });
    await expect(git.revertSkip({ dir })).rejects.toMatchObject({ code: "ENOREVERT" });
    await expect(git.revertAbort({ dir })).rejects.toMatchObject({ code: "ENOREVERT" });
  });

  it("routes rebase continue, skip, and abort through a reopened native client", async () => {
    const continued = await conflictingRebase();
    const continuedGit = bindNativeGit(continued.workspace);
    await expect(continuedGit.status({ dir: continued.dir })).resolves.toEqual([
      { path: "shared.txt", index: "U", worktree: "U" },
    ]);
    writeWorkFile(continued.workspace, `${continued.dir}/shared.txt`, "resolved\n");
    await continuedGit.add({ dir: continued.dir, paths: ["shared.txt"] });
    await expect(continuedGit.rebaseContinue({ dir: continued.dir })).resolves.toMatchObject({
      outcome: "completed",
      replayed: 1,
      skipped: 0,
      fastForward: false,
    });
    expect(
      continued.workspace.workspace.fs.readFileSync(`${continued.dir}/shared.txt`, "utf8"),
    ).toBe("resolved\n");

    const skipped = await conflictingRebase();
    const skippedGit = bindNativeGit(skipped.workspace);
    await expect(skippedGit.rebaseSkip({ dir: skipped.dir })).resolves.toEqual({
      outcome: "completed",
      oid: skipped.upstream,
      replayed: 0,
      skipped: 1,
      fastForward: false,
    });
    expect(skipped.workspace.workspace.fs.readFileSync(`${skipped.dir}/shared.txt`, "utf8")).toBe(
      "upstream\n",
    );

    const aborted = await conflictingRebase();
    const abortedGit = bindNativeGit(aborted.workspace);
    await expect(abortedGit.rebaseAbort({ dir: aborted.dir })).resolves.toBeUndefined();
    await expect(abortedGit.revParse({ dir: aborted.dir, ref: "HEAD" })).resolves.toBe(
      aborted.original,
    );
    expect(aborted.workspace.workspace.fs.readFileSync(`${aborted.dir}/shared.txt`, "utf8")).toBe(
      "current\n",
    );
    await expect(abortedGit.rebaseContinue({ dir: aborted.dir })).rejects.toMatchObject({
      code: "ENOREBASE",
    });
    await expect(abortedGit.rebaseSkip({ dir: aborted.dir })).rejects.toMatchObject({
      code: "ENOREBASE",
    });
    await expect(abortedGit.rebaseAbort({ dir: aborted.dir })).rejects.toMatchObject({
      code: "ENOREBASE",
    });
  });

  it("enforces rebase operation interlocks and lets hard reset clear recovery state", async () => {
    const { git, workspace, dir, original } = await conflictingRebase();
    const source = await git.revParse({ dir, ref: "upstream" });

    await expect(git.status({ dir })).resolves.toEqual([
      { path: "shared.txt", index: "U", worktree: "U" },
    ]);
    await expect(git.diff({ dir })).resolves.toBeDefined();
    writeWorkFile(workspace, `${dir}/added.txt`, "resolution work\n");
    await expect(git.add({ dir, paths: ["added.txt"] })).resolves.toBeUndefined();
    await expect(git.rm({ dir, paths: ["added.txt"], force: true })).resolves.toBeUndefined();

    const blocked = [
      () => git.fetch({ dir }),
      () => git.clean({ dir }),
      () => git.reset({ dir }),
      () => git.commit({ dir, message: "blocked" }),
      () => git.branch({ dir, name: "blocked" }),
      () => git.branchDelete({ dir, name: "spare" }),
      () => git.tag({ dir, name: "blocked" }),
      () => git.tagDelete({ dir, name: "before-rebase" }),
      () => git.checkout({ dir, ref: "upstream" }),
      () => git.updateRef({ dir, ref: "refs/heads/blocked", value: source }),
      () => git.push({ dir }),
      () => git.pull({ dir }),
      () => git.merge({ dir, theirs: "upstream" }),
      () => git.cherryPick({ dir, source }),
      () => git.revert({ dir, source }),
      () => git.rebase({ dir, upstream: "upstream" }),
    ];
    for (const call of blocked) {
      await expect(call()).rejects.toMatchObject({ code: "EOPACTIVE" });
    }
    await expect(git.mergeContinue({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });
    await expect(git.cherryPickContinue({ dir })).rejects.toMatchObject({
      code: "EOPMISMATCH",
    });
    await expect(git.revertContinue({ dir })).rejects.toMatchObject({ code: "EOPMISMATCH" });

    await git.reset({ dir, hard: true });

    await expect(git.revParse({ dir, ref: "HEAD" })).resolves.toBe(original);
    const repository = workspace.database.find(dir);
    if (repository === null) throw new Error("rebase repository is missing");
    expect(workspace.database.open(repository).readOperationState()).toBeNull();
  });

  it("hard reset removes modify-delete conflict content before clearing rebase recovery", async () => {
    const { git, workspace, dir, original } = await modifyDeleteRebase();
    const repository = workspace.database.find(dir);
    if (repository === null) throw new Error("modify-delete repository is missing");
    const store = workspace.database.open(repository);
    expect(store.hasConflicts()).toBe(true);
    expect(workspace.worktree.stat(`${dir}/deleted.txt`)).not.toBeNull();

    await git.reset({ dir, hard: true });

    await expect(git.revParse({ dir, ref: "HEAD" })).resolves.toBe(original);
    expect(store.indexEntries()).toEqual([]);
    expect(store.hasConflicts()).toBe(false);
    expect(workspace.worktree.stat(`${dir}/deleted.txt`)).toBeNull();
    expect(store.readOperationState()).toBeNull();
  });

  it("fails explicitly for methods that remain unsupported", async () => {
    const { workspace } = makeWorkspace();
    await workspace.git.init({});
    for (const call of [
      () => workspace.git.stashPush({}),
      () => workspace.git.cli({ argv: ["status"] }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "EUNSUPPORTED" });
    }
  });
});
