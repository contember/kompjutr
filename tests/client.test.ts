// The acceptance test for the whole experiment: a real Computer Workspace
// configured with `createSqliteGitClient()`, driven only through
// `workspace.git`, with no Computer fork anywhere.

import { join } from "node:path";

import { Workspace } from "@cloudflare/computer";
import { afterAll, describe, expect, it } from "vitest";

import { ComputerWorktree, createSqliteGitClient } from "../src/compat/computer.js";
import { Repository } from "../src/core/repository.js";
import type { Worktree } from "../src/core/worktree.js";
import type { ScanEntry } from "../src/fs/types.js";
import { createGit, type Git, type GitScratchIndex } from "../src/git/client.js";
import { iterateIndexTrackerDirty, readIndexTrackerState } from "../src/sqlite/index-tracker.js";
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
const FIXTURE_IDENTITY = { name: "Fixture", email: "fixture@example.com" };

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
  return bindNativeGitDatabase(workspace, workspace.database);
}

function bindNativeGitDatabase(workspace: TestWorkspace, database: SqliteGitDatabase): Git {
  return createGit()({
    database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
  });
}

function maintenanceState(database: SqliteGitDatabase, repoId: number) {
  const db = database.db;
  return {
    control: db.all<Record<string, unknown>>(
      "SELECT * FROM git_maintenance_control WHERE repo_id = ? ORDER BY repo_id",
      repoId,
    ),
    runs: db.all<Record<string, unknown>>(
      "SELECT * FROM git_maintenance_runs WHERE repo_id = ? ORDER BY run_id",
      repoId,
    ),
    objects: db.all<Record<string, unknown>>(
      "SELECT * FROM git_maintenance_objects WHERE repo_id = ? ORDER BY run_id, oid",
      repoId,
    ),
    shallow: db.all<Record<string, unknown>>(
      "SELECT * FROM git_maintenance_shallow WHERE repo_id = ? ORDER BY run_id, oid",
      repoId,
    ),
    repackBatches: db.all<Record<string, unknown>>(
      "SELECT * FROM git_maintenance_repack_batches WHERE repo_id = ? ORDER BY run_id, batch_id",
      repoId,
    ),
    repackObjects: db.all<Record<string, unknown>>(
      `SELECT * FROM git_maintenance_repack_objects
        WHERE repo_id = ? ORDER BY run_id, batch_id, ordinal`,
      repoId,
    ),
    looseCandidates: db.all<Record<string, unknown>>(
      "SELECT * FROM git_loose_gc_candidates WHERE repo_id = ? ORDER BY oid",
      repoId,
    ),
    packCandidates: db.all<Record<string, unknown>>(
      "SELECT * FROM git_pack_gc_candidates WHERE repo_id = ? ORDER BY pack_id",
      repoId,
    ),
  };
}

function clientControlState(
  workspace: TestWorkspace,
  dir: string,
  database: SqliteGitDatabase = workspace.database,
) {
  const checkout = database.findCheckout(dir);
  if (checkout === null) throw new Error(`repository is missing at ${dir}`);
  const repo = new Repository(database.openCheckout(checkout));
  const refs = repo.store.listRefs();
  return {
    head: repo.checkout.head(),
    refs,
    reflogs: [
      { ref: "HEAD", entries: repo.reflog("HEAD") },
      ...refs.map((ref) => ({ ref: ref.name, entries: repo.reflog(ref.name) })),
    ],
    index: [...repo.checkout.indexScan()],
    tracker: readIndexTrackerState(database.db, checkout.id),
    trackerDirty: [...iterateIndexTrackerDirty(database.db, checkout.id)],
    operation: repo.checkout.readOperationState(),
    maintenance: maintenanceState(database, checkout.repoId),
    scratchIndexes: database.db.all<Record<string, unknown>>(
      "SELECT * FROM git_scratch_indexes WHERE repo_id = ? ORDER BY name",
      checkout.repoId,
    ),
    scratchEntries: database.db.all<Record<string, unknown>>(
      `SELECT * FROM git_scratch_index_entries
        WHERE repo_id = ? ORDER BY name, path, stage`,
      checkout.repoId,
    ),
  };
}

function clientWorktreeState(workspace: TestWorkspace, root: string) {
  return workspace.worktree.scan(root, { limit: 1_000 }).map((entry) => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    target: entry.type === "symlink" ? workspace.worktree.readlink(entry.path) : null,
    bytes: entry.type === "file" ? [...workspace.worktree.readFile(entry.path)] : [],
  }));
}

function syntheticCachedWorktree(inner: Worktree, count: number, contentId: Uint8Array): Worktree {
  return {
    ...inner,
    scan(_root, options): ScanEntry[] {
      const after = options.after;
      const start =
        after === undefined
          ? 0
          : Number.parseInt(after.slice(after.lastIndexOf("f") + 1, -4), 10) + 1;
      const rows: ScanEntry[] = [];
      for (let index = start; index < count && rows.length < options.limit; index++) {
        rows.push({
          path: `/f${index.toString().padStart(5, "0")}.txt`,
          type: "file",
          mode: 0o100644,
          size: 0,
          mtime: 1,
          ino: index + 2,
          nlink: 1,
          rev: 1,
          target: null,
          contentId,
        });
      }
      return rows;
    },
  };
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

    await commitFile(git, workspace, "/", "cached.txt", "cached\n", "cached fixture");
    await git.rm({ paths: ["cached.txt"], cached: true });
    await expect(git.status({ paths: ["cached.txt"], untrackedFiles: "all" })).resolves.toEqual([
      { path: "cached.txt", index: "D", worktree: " " },
      { path: "cached.txt", index: " ", worktree: "?" },
    ]);
    await expect(
      git.status({ paths: ["cached.txt"], untrackedFiles: "no", includeIgnored: true }),
    ).resolves.toEqual([{ path: "cached.txt", index: "D", worktree: " " }]);
  });

  it("exposes divergence and raw ref reads for symbolic and detached HEAD", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/reads";
    await git.init({ dir });
    const base = await commitFile(git, workspace, dir, "file.txt", "base\n", "base");
    await git.branch({ dir, name: "base" });
    const tip = await commitFile(git, workspace, dir, "file.txt", "tip\n", "tip");

    await expect(git.divergence({ dir, current: "HEAD", upstream: "base" })).resolves.toEqual({
      relationship: "ahead",
      ahead: 1,
      behind: 0,
    });
    await expect(git.readRef({ dir, ref: "HEAD" })).resolves.toEqual({
      kind: "symbolic",
      target: "refs/heads/main",
    });

    await git.updateRef({
      dir,
      ref: "refs/remotes/origin/main",
      value: tip,
      force: true,
    });
    await git.updateRef({
      dir,
      ref: "refs/remotes/origin/alias",
      value: "refs/remotes/origin/main",
      symbolic: true,
      force: true,
    });
    await git.updateRef({
      dir,
      ref: "refs/remotes/origin/HEAD",
      value: "refs/remotes/origin/alias",
      symbolic: true,
      force: true,
    });
    await expect(git.readRef({ dir, ref: "refs/remotes/origin/HEAD" })).resolves.toEqual({
      kind: "symbolic",
      target: "refs/remotes/origin/alias",
    });
    await expect(git.readRef({ dir, ref: "refs/remotes/missing/HEAD" })).resolves.toEqual({
      kind: "absent",
    });

    await git.checkout({ dir, ref: base });
    await expect(git.readRef({ dir, ref: "HEAD" })).resolves.toEqual({
      kind: "direct",
      oid: base,
    });
    await expect(git.divergence({ dir, current: "HEAD", upstream: "main" })).resolves.toEqual({
      relationship: "behind",
      ahead: 0,
      behind: 1,
    });
  });

  it("selects checkout-local HEAD while sharing refs across an unequal-id cold reopen", async () => {
    const { git, workspace } = makeNativeGit();
    await git.init({ dir: "/primary" });
    const oid = await commitFile(git, workspace, "/primary", "file.txt", "main\n", "main");
    const primary = workspace.database.checkoutAt("/primary");
    if (primary === null) throw new Error("primary checkout is missing");
    const secondaryId = primary.id + 100;
    workspace.database.db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (?, ?, '/secondary', ?, 0)`,
      secondaryId,
      primary.repoId,
      oid,
    );
    workspace.database.db.run(
      "UPDATE git_identity_control SET last_checkout_id = ? WHERE singleton = 1",
      secondaryId,
    );
    expect(secondaryId).not.toBe(primary.id);
    expect(secondaryId).not.toBe(primary.repoId);
    await expect(git.readRef({ dir: "/primary", ref: "HEAD" })).resolves.toEqual({
      kind: "symbolic",
      target: "refs/heads/main",
    });
    await expect(git.readRef({ dir: "/secondary", ref: "HEAD" })).resolves.toEqual({
      kind: "direct",
      oid,
    });
    await expect(git.readRef({ dir: "/secondary", ref: "refs/heads/main" })).resolves.toEqual({
      kind: "direct",
      oid,
    });

    const cold = bindNativeGitDatabase(workspace, new SqliteGitDatabase(workspace.database.db));
    await expect(cold.readRef({ dir: "/primary", ref: "HEAD" })).resolves.toEqual({
      kind: "symbolic",
      target: "refs/heads/main",
    });
    await expect(cold.readRef({ dir: "/secondary", ref: "HEAD" })).resolves.toEqual({
      kind: "direct",
      oid,
    });
    await expect(cold.readRef({ dir: "/secondary", ref: "refs/heads/main" })).resolves.toEqual({
      kind: "direct",
      oid,
    });
  });

  it("reports exact renames natively without widening the Computer facade", async () => {
    const { workspace, storage } = makeWorkspace();
    const compat = workspace.git;
    await compat.init({});
    await workspace.fs.writeFile("/old.txt", "same\n");
    await compat.add({ paths: ["old.txt"] });
    await compat.commit({ message: "base" });

    await workspace.fs.rm("/old.txt");
    await workspace.fs.writeFile("/new.txt", "same\n");
    await compat.add({ paths: ["."], all: true });

    const native = createGit()({
      database: new SqliteGitDatabase(new TestDatabase(storage)),
      worktree: new ComputerWorktree(workspace.provider()),
      now: () => 1_600_000_000_000,
      timezoneOffset: () => 0,
      defaultIdentity: IDENTITY,
    });
    await expect(native.status()).resolves.toEqual([
      {
        path: "new.txt",
        originalPath: "old.txt",
        similarity: 100,
        index: "R",
        worktree: " ",
      },
    ]);
    await expect(native.diffSummary()).resolves.toEqual([
      {
        path: "new.txt",
        originalPath: "old.txt",
        similarity: 100,
        status: "R",
        insertions: 0,
        deletions: 0,
      },
    ]);
    await expect(native.diff()).resolves.toContain(
      "similarity index 100%\nrename from old.txt\nrename to new.txt\n",
    );

    await expect(compat.status()).resolves.toEqual([
      { path: "new.txt", index: "A", worktree: " " },
      { path: "old.txt", index: "D", worktree: " " },
    ]);
    await expect(compat.diffSummary()).resolves.toEqual([
      { path: "new.txt", status: "A", insertions: 1, deletions: 0 },
      { path: "old.txt", status: "D", insertions: 0, deletions: 1 },
    ]);
    await expect(compat.diff()).resolves.not.toContain("similarity index");
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
    const repository = database.findCheckout("/");
    if (repository === null) throw new Error("repository is missing");
    const store = database.openCheckout(repository);
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
    const repository = workspace.database.findCheckout(dir);
    if (repository === null) throw new Error("rebase repository is missing");
    expect(workspace.database.openCheckout(repository).readOperationState()).toBeNull();
  });

  it("hard reset removes modify-delete conflict content before clearing rebase recovery", async () => {
    const { git, workspace, dir, original } = await modifyDeleteRebase();
    const repository = workspace.database.findCheckout(dir);
    if (repository === null) throw new Error("modify-delete repository is missing");
    const store = workspace.database.openCheckout(repository);
    expect(store.hasConflicts()).toBe(true);
    expect(workspace.worktree.stat(`${dir}/deleted.txt`)).not.toBeNull();

    await git.reset({ dir, hard: true });

    await expect(git.revParse({ dir, ref: "HEAD" })).resolves.toBe(original);
    expect(store.indexEntries()).toEqual([]);
    expect(store.hasConflicts()).toBe(false);
    expect(workspace.worktree.stat(`${dir}/deleted.txt`)).toBeNull();
    expect(store.readOperationState()).toBeNull();
  });

  it("matches a Git alternate-index snapshot and preserves every checkout control", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture
      .write("changed.txt", "base\n")
      .write("removed.txt", "removed\n")
      .writeExecutable("bin/run", "#!/bin/sh\n")
      .symlink("changed.txt", "link");
    const expectedBase = fixture.commit("base");
    const expectedBaseTree = fixture.git("rev-parse", `${expectedBase}^{tree}`);

    const { git, workspace } = makeNativeGit();
    const dir = "/snapshot";
    await git.init({ dir });
    writeWorkFile(workspace, `${dir}/changed.txt`, "base\n");
    writeWorkFile(workspace, `${dir}/removed.txt`, "removed\n");
    writeWorkFile(workspace, `${dir}/bin/run`, "#!/bin/sh\n", 0o755);
    workspace.worktree.symlink("changed.txt", `${dir}/link`);
    await git.add({ dir, paths: [], all: true });
    const base = (
      await git.commit({
        dir,
        message: "base",
        author: FIXTURE_IDENTITY,
        committer: FIXTURE_IDENTITY,
      })
    ).oid;
    expect(base).toBe(expectedBase);

    await git.readTree({ dir, tree: "HEAD" });
    await expect(git.writeTree({ dir })).resolves.toBe(expectedBaseTree);
    const beforeDetached = clientControlState(workspace, dir);
    const beforeDetachedWorktree = clientWorktreeState(workspace, dir);
    const expectedDetached = fixture.gitInput(
      "detached\n",
      "commit-tree",
      expectedBaseTree,
      "-p",
      base,
    );
    await expect(
      git.commitTree({
        dir,
        tree: expectedBaseTree,
        message: "detached\n",
        parent: [base],
        author: FIXTURE_IDENTITY,
        committer: FIXTURE_IDENTITY,
      }),
    ).resolves.toBe(expectedDetached);
    expect(clientControlState(workspace, dir)).toEqual(beforeDetached);
    expect(clientWorktreeState(workspace, dir)).toEqual(beforeDetachedWorktree);

    writeWorkFile(workspace, `${dir}/changed.txt`, "staged\n");
    await git.add({ dir, paths: ["changed.txt"] });
    writeWorkFile(workspace, `${dir}/changed.txt`, "worktree\n");
    workspace.worktree.unlink(`${dir}/removed.txt`);
    writeWorkFile(workspace, `${dir}/new/deep.txt`, "new\n");
    writeWorkFile(workspace, `${dir}/bin/run`, "not executable\n");
    workspace.worktree.unlink(`${dir}/link`);
    workspace.worktree.symlink("new/deep.txt", `${dir}/link`);

    fixture
      .write("changed.txt", "worktree\n")
      .remove("removed.txt")
      .write("new/deep.txt", "new\n")
      .write("bin/run", "not executable\n")
      .chmod("bin/run", 0o644)
      .remove("link")
      .symlink("new/deep.txt", "link");
    const environment = { GIT_INDEX_FILE: join(fixture.dir, ".git", "snapshot.index") };
    fixture.gitWithEnv(environment, "read-tree", "HEAD");
    fixture.gitWithEnv(environment, "add", "-A");
    const expectedTree = fixture.gitWithEnv(environment, "write-tree");
    const expectedSnapshot = fixture.gitInputWithEnv(
      "snapshot\n",
      environment,
      "commit-tree",
      expectedTree,
      "-p",
      base,
    );

    const checkout = workspace.database.findCheckout(dir);
    if (checkout === null) throw new Error("snapshot repository is missing");
    const store = workspace.database.openCheckout(checkout);
    store.writeOperationState(
      {
        kind: "cherry-pick",
        originalHeadRef: "refs/heads/main",
        originalHeadOid: base,
        phase: "empty",
        emptyReason: "result",
        sourceOid: base,
        selectedParentOid: null,
        mainline: null,
        currentLabel: "HEAD",
        incomingLabel: base.slice(0, 7),
        message: "base\n",
        author: null,
        committer: null,
      },
      [],
    );

    const beforeControl = clientControlState(workspace, dir);
    const beforeWorktree = clientWorktreeState(workspace, dir);
    const beforeObjects = workspace.database.db.scalar<number>(
      "SELECT count(*) FROM git_objects WHERE repo_id = ?",
      checkout.repoId,
    );

    await expect(
      git.withScratchIndex({ dir, name: "failed-snapshot" }, (scratch) => {
        scratch.readTree({ tree: "HEAD" });
        scratch.add({ paths: [], all: true });
        const tree = scratch.writeTree();
        scratch.commitTree({
          tree,
          message: "rolled back\n",
          parent: [base],
          author: FIXTURE_IDENTITY,
          committer: FIXTURE_IDENTITY,
        });
        throw new Error("abort scratch snapshot");
      }),
    ).rejects.toThrow("abort scratch snapshot");
    expect(
      workspace.database.db.scalar<number>(
        "SELECT count(*) FROM git_objects WHERE repo_id = ?",
        checkout.repoId,
      ),
    ).toBe(beforeObjects);
    expect(clientControlState(workspace, dir)).toEqual(beforeControl);
    expect(clientWorktreeState(workspace, dir)).toEqual(beforeWorktree);

    const afterFailureDatabase = new SqliteGitDatabase(workspace.database.db);
    expect(clientControlState(workspace, dir, afterFailureDatabase)).toEqual(beforeControl);
    await expect(
      git.withScratchIndex({ dir, name: "async-snapshot" }, async (scratch) => {
        scratch.readTree({ tree: "HEAD" });
        scratch.add({ paths: [], all: true });
        return scratch.writeTree();
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(clientControlState(workspace, dir)).toEqual(beforeControl);

    let leaked: GitScratchIndex | undefined;
    const beforeStatements = workspace.storage.statementCount;
    const snapshot = await git.withScratchIndex({ dir, name: "snapshot" }, (scratch) => {
      leaked = scratch;
      scratch.readTree({ tree: "HEAD" });
      scratch.add({ paths: [], all: true });
      const tree = scratch.writeTree();
      expect(tree).toBe(expectedTree);
      return scratch.commitTree({
        tree,
        message: "snapshot\n",
        parent: [base],
        author: FIXTURE_IDENTITY,
        committer: FIXTURE_IDENTITY,
      });
    });
    const statements = workspace.storage.statementCount - beforeStatements;
    expect(statements).toBeLessThan(1_000);
    expect(snapshot).toBe(expectedSnapshot);
    const captured = leaked;
    if (captured === undefined) throw new Error("scratch handle was not captured");
    expect(() => captured.writeTree()).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      captured.commitTree({ tree: expectedTree, message: "leaked\n", parent: [base] }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));

    expect((await git.catFile({ dir, oid: snapshot })).bytes).toEqual(
      new Uint8Array(fixture.gitBinary("cat-file", "commit", expectedSnapshot)),
    );
    expect((await git.catFile({ dir, oid: expectedTree })).bytes).toEqual(
      new Uint8Array(fixture.gitBinary("cat-file", "tree", expectedTree)),
    );
    expect(clientControlState(workspace, dir)).toEqual(beforeControl);
    expect(clientWorktreeState(workspace, dir)).toEqual(beforeWorktree);

    const coldDatabase = new SqliteGitDatabase(workspace.database.db);
    const coldGit = bindNativeGitDatabase(workspace, coldDatabase);
    expect(clientControlState(workspace, dir, coldDatabase)).toEqual(beforeControl);
    expect((await coldGit.catFile({ dir, oid: snapshot })).bytes).toEqual(
      new Uint8Array(fixture.gitBinary("cat-file", "commit", expectedSnapshot)),
    );
  });

  it("keeps the maximal public scratch snapshot below SQL and memory budgets", async () => {
    const workspace = makeTestWorkspace();
    const setupGit = bindNativeGit(workspace);
    await setupGit.init({ dir: "/" });
    const blob = await setupGit.hashObject({ content: new Uint8Array(), write: true });
    const checkout = workspace.database.findCheckout("/");
    if (checkout === null) throw new Error("scale repository is missing");
    const repo = new Repository(workspace.database.openCheckout(checkout));
    const contentId = new Uint8Array([7, 8, 9]);
    repo.store.upsertBlobIds([{ contentId, oid: blob }]);
    const git = createGit()({
      database: workspace.database,
      worktree: syntheticCachedWorktree(workspace.worktree, 10_000, contentId),
      now: workspace.context.now,
      timezoneOffset: workspace.context.timezoneOffset,
      defaultIdentity: IDENTITY,
    });
    const beforeControl = clientControlState(workspace, "/");
    const beforeStatements = workspace.storage.statementCount;

    const oid = await git.withScratchIndex({ name: "maximal" }, (scratch) => {
      scratch.readTree({ empty: true });
      scratch.add({ paths: [], all: true });
      const tree = scratch.writeTree();
      return scratch.commitTree({ tree, message: "maximal snapshot\n" });
    });

    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(workspace.storage.statementCount - beforeStatements).toBeLessThan(1_000);
    expect(repo.store.memory.highWaterBytes).toBeLessThan(64 * 1024 * 1024);
    expect(repo.store.memory.activeCount).toBe(0);
    expect(clientControlState(workspace, "/")).toEqual(beforeControl);
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
