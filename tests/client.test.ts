// The acceptance test for the whole client surface, driven only through
// `createGit()` over Durable Object SQLite.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
} from "../packages/do/src/db/db.js";
import type { NodeFsCompat } from "../packages/do/src/fs/compat/node.js";
import { createFilesystem } from "../packages/do/src/fs/filesystem.js";
import type { ScanEntry } from "../packages/do/src/fs/types.js";
import {
  createGit,
  type Git,
  type GitAbortableNetworkOptions,
  type GitCloneOptions,
  type GitFetchOptions,
  type GitPushOptions,
  type GitScratchIndex,
  type PushLeaseExpectation,
} from "../packages/git/src/client.js";
import { utf8, utf8Decoder } from "../packages/git/src/common/bytes.js";
import {
  iterateIndexTrackerDirty,
  readIndexTrackerState,
} from "../packages/git/src/do-fs/indexes/index-tracker.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import type { Worktree } from "../packages/git/src/ops/worktree/worktree.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import type { SqliteTestStorage } from "./helpers/storage.js";
import {
  makeWorkspace as makeTestWorkspace,
  type TestWorkspace,
  writeWorkFile,
} from "./helpers/workspace.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };
const FIXTURE_IDENTITY = { name: "Fixture", email: "fixture@example.com" };
class CodedTooBigStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;
  #queryFragment: string | null = null;
  #binding: unknown;
  writesBeforeFailure = 0;
  constructor(private readonly inner: SqliteTestStorage) {
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        if (
          this.#queryFragment !== null &&
          query.includes(this.#queryFragment) &&
          bindings.includes(this.#binding)
        ) {
          this.#queryFragment = null;
          throw Object.assign(new Error("injected coded SQLite value failure"), {
            code: "SQLITE_TOOBIG",
          });
        }
        if (this.#queryFragment !== null && /^\s*(?:DELETE|INSERT|UPDATE)\b/.test(query)) {
          this.writesBeforeFailure++;
        }
        return this.inner.sql.exec<Row>(query, ...bindings);
      },
    };
  }
  arm(queryFragment: string, binding: unknown): void {
    this.#queryFragment = queryFragment;
    this.#binding = binding;
    this.writesBeforeFailure = 0;
  }
  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}
interface ClientWorkspace extends TestWorkspace {
  git: Git;
  fs: NodeFsCompat;
}
function makeWorkspace(now = 1600000000000): {
  workspace: ClientWorkspace;
  storage: SqliteTestStorage;
} {
  const base = makeTestWorkspace({ startTime: now });
  return {
    workspace: { ...base, git: bindNativeGit(base), fs: base.workspace.fs },
    storage: base.storage,
  };
}
/** A second client over the same storage, with its own database and worktree. */
function reopenGit(storage: SqliteTestStorage, now = 1600000000000): Git {
  const db = new TestDatabase(storage);
  return createGit()({
    database: new SqliteGitDatabase(db),
    worktree: createFilesystem(db, { now: () => now }),
    now: () => now,
    timezoneOffset: () => 0,
    defaultIdentity: IDENTITY,
  });
}
function makeNativeGit(): {
  git: Git;
  workspace: TestWorkspace;
} {
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
  return workspace.worktree.scan(root, { limit: 1000 }).map((entry) => ({
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
describe("git client", () => {
  it("exposes native cancellation, deepening, unshallow, and lease options", () => {
    const signal = new AbortController().signal;
    const abortable: GitAbortableNetworkOptions = { signal };
    const clone: GitCloneOptions = { url: "https://example.test/repo.git", ...abortable };
    const deepen: GitFetchOptions = { remote: "origin", deepen: 2, ...abortable };
    const unshallow: GitFetchOptions = { remote: "origin", unshallow: true };
    const lease: PushLeaseExpectation = { tracking: true };
    const push: GitPushOptions = { remote: "origin", leases: { main: lease }, ...abortable };
    expect([clone.signal, deepen.deepen, unshallow.unshallow, push.leases?.main]).toEqual([
      signal,
      2,
      true,
      lease,
    ]);
  });
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
    await expect(git.mergeBase({ dir, current: "HEAD", incoming: "base" })).resolves.toEqual({
      kind: "already-merged",
      bases: [base],
    });
    await expect(git.lsTree({ dir, ref: "HEAD", recursive: true })).resolves.toEqual([
      expect.objectContaining({ mode: "100644", path: "file.txt", type: "blob" }),
    ]);
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
  it("exposes typed, path, and quiet revision resolution", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/revision";
    await git.init({ dir });
    const head = await commitFile(git, workspace, dir, "nested/file.txt", "value\n", "base");
    const phantom = "f".repeat(40);
    await expect(git.revParse({ dir, ref: "HEAD^{commit}" })).resolves.toBe(head);
    await expect(git.revParse({ dir, ref: "HEAD:nested/file.txt" })).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    );
    await expect(git.tryRevParse({ dir, ref: "HEAD" })).resolves.toBe(head);
    await expect(git.tryRevParse({ dir, ref: "missing" })).resolves.toBeUndefined();
    await expect(git.tryRevParse({ dir, ref: phantom })).resolves.toBe(phantom);
    await expect(git.tryRevParse({ dir, ref: `${phantom}^{}` })).resolves.toBeUndefined();
    await expect(git.tryRevParse({ dir, ref: "HEAD^{blob}" })).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });
  it("exposes guarded direct-ref update and deletion", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/guarded-ref";
    await git.init({ dir });
    const first = await commitFile(git, workspace, dir, "file.txt", "first\n", "first");
    const second = await commitFile(git, workspace, dir, "file.txt", "second\n", "second");
    const ref = "refs/heads/checkpoint";
    await git.updateRef({ dir, ref, value: first, expected: null });
    await expect(git.readRef({ dir, ref })).resolves.toEqual({ kind: "direct", oid: first });
    await expect(git.updateRef({ dir, ref, value: second, expected: null })).rejects.toMatchObject({
      code: "ESTALEHEAD",
    });
    await git.updateRef({ dir, ref, value: second, expected: first });
    await expect(git.readRef({ dir, ref })).resolves.toEqual({ kind: "direct", oid: second });
    await git.updateRef({ dir, ref, delete: true, expected: second });
    await expect(git.readRef({ dir, ref })).resolves.toEqual({ kind: "absent" });
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
  it("reports exact renames across a reopened client", async () => {
    const { workspace, storage } = makeWorkspace();
    const git = workspace.git;
    await git.init({});
    await workspace.fs.writeFile("/old.txt", "same\n");
    await git.add({ paths: ["old.txt"] });
    await git.commit({ message: "base" });
    await workspace.fs.rm("/old.txt");
    await workspace.fs.writeFile("/new.txt", "same\n");
    await git.add({ paths: ["."], all: true });
    const native = reopenGit(storage);
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
  });
  it("drives a full local cycle through the client", async () => {
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
    expect((await git.show({ ref: "HEAD" })).commit.oid).toBe(second.oid);
    expect(await git.lsFiles()).toEqual(["README.md", "src/a.ts"]);
    await git.branch({ name: "topic" });
    expect(await git.branchList()).toEqual(["main", "topic"]);
    await git.checkout({ ref: "topic" });
    expect(await git.currentBranch()).toBe("topic");
    // Nothing about this repository lives on disk.
    const paths = await workspace.fs.readdir("/");
    expect(paths.some((path) => path.includes(".git"))).toBe(false);
    const tables = storage.sql
      .exec<{
        name: string;
      }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name);
    expect(tables).toContain("git_repositories");
    expect(tables).toContain("git_index");
  });
  it("supports branch rename for current and inactive branches through the native facade", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/branch-rename";
    await git.init({ dir });
    await commitFile(git, workspace, dir, "README.md", "base\n", "base");
    await git.configSet({ dir, path: "branch.main.remote", value: "origin" });
    await git.branch({ dir, name: "topic" });
    await git.configSet({ dir, path: "branch.topic.merge", value: "refs/heads/topic" });
    await git.branchRename({ dir, newName: "primary" });
    await expect(git.currentBranch({ dir })).resolves.toBe("primary");
    await expect(git.branchList({ dir })).resolves.toEqual(["primary", "topic"]);
    await expect(git.configGet({ dir, path: "branch.primary.remote" })).resolves.toBe("origin");
    await expect(git.configGet({ dir, path: "branch.main.remote" })).resolves.toBeUndefined();
    await git.branchRename({ dir, oldName: "topic", newName: "feature" });
    await expect(git.currentBranch({ dir })).resolves.toBe("primary");
    await expect(git.branchList({ dir })).resolves.toEqual(["feature", "primary"]);
    await expect(git.configGet({ dir, path: "branch.feature.merge" })).resolves.toBe(
      "refs/heads/topic",
    );
    await expect(git.configGet({ dir, path: "branch.topic.merge" })).resolves.toBeUndefined();
  });
  it("selects index and ref paths through lsFiles pathspecs", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/ls-files-pathspec";
    await git.init({ dir });
    writeWorkFile(workspace, `${dir}/root.ts`, "root\n");
    writeWorkFile(workspace, `${dir}/dir/one.ts`, "one\n");
    writeWorkFile(workspace, `${dir}/dir/nested/two.ts`, "two\n");
    writeWorkFile(workspace, `${dir}/dir/readme.md`, "readme\n");
    await git.add({ dir, paths: ["."], all: true });
    await git.commit({ dir, message: "tracked paths" });
    writeWorkFile(workspace, `${dir}/dir/staged.ts`, "staged\n");
    await git.add({ dir, paths: ["dir/staged.ts"] });
    await expect(git.lsFiles({ dir, paths: ["dir/*.ts"] })).resolves.toEqual([
      "dir/nested/two.ts",
      "dir/one.ts",
      "dir/staged.ts",
    ]);
    await expect(git.lsFiles({ dir, ref: "HEAD", paths: ["dir/*.ts"] })).resolves.toEqual([
      "dir/nested/two.ts",
      "dir/one.ts",
    ]);
  });
  it("selects cached and non-ignored untracked builder files", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/ls-files-builder";
    await git.init({ dir });
    writeWorkFile(workspace, `${dir}/.gitignore`, "*.tmp\n");
    writeWorkFile(workspace, `${dir}/tracked.ts`, "tracked\n");
    await git.add({ dir, paths: [".gitignore", "tracked.ts"] });
    await git.commit({ dir, message: "tracked" });
    writeWorkFile(workspace, `${dir}/src/new.ts`, "new\n");
    writeWorkFile(workspace, `${dir}/src/ignored.tmp`, "ignored\n");
    writeWorkFile(workspace, `${dir}/nested/foreign.ts`, "nested\n");
    await git.init({ dir: `${dir}/nested` });
    await expect(git.lsFiles({ dir })).resolves.toEqual([".gitignore", "tracked.ts"]);
    await expect(
      git.lsFiles({
        dir,
        cached: true,
        others: true,
        excludeStandard: true,
        paths: ["*.ts"],
      }),
    ).resolves.toEqual(["src/new.ts", "tracked.ts"]);
    await expect(git.lsFiles({ dir, others: true })).resolves.toEqual([
      "src/ignored.tmp",
      "src/new.ts",
    ]);
    await expect(git.lsFiles({ dir, cached: false, others: false })).resolves.toEqual([]);
  });
  it("rejects worktree lsFiles selection at a ref", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/ls-files-ref-selection";
    await git.init({ dir });
    writeWorkFile(workspace, `${dir}/tracked.ts`, "tracked\n");
    await git.add({ dir, paths: ["tracked.ts"] });
    await git.commit({ dir, message: "tracked" });
    await expect(git.lsFiles({ dir, ref: "HEAD", others: true })).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(git.lsFiles({ dir, ref: "HEAD", excludeStandard: false })).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(git.lsFiles({ dir, ref: "HEAD", paths: ["*.ts"] })).resolves.toEqual([
      "tracked.ts",
    ]);
  });
  it("uses the workspace's default identity when nothing else supplies one", async () => {
    const { workspace } = makeWorkspace();
    await workspace.git.init({});
    await workspace.fs.writeFile("/a.txt", "a\n");
    await workspace.git.add({ paths: ["a.txt"] });
    const { oid } = await workspace.git.commit({ message: "identity" });
    const view = await workspace.git.show({ ref: oid });
    expect(view.commit.author).toMatchObject(IDENTITY);
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
  it("gets and sets the remote URL used by fetch and push", async () => {
    const original = new GitFixture().init();
    fixtures.push(original);
    original.write("README.md", "original\n");
    const originalHead = original.commit("original");
    const replacement = new GitFixture();
    fixtures.push(replacement);
    replacement.git("clone", "-q", original.dir, ".");
    replacement.write("replacement.txt", "replacement\n");
    const replacementHead = replacement.commit("replacement");
    const originalServer = await startGitServer(original.dir);
    const replacementServer = await startGitServer(replacement.dir);
    try {
      const { git } = makeNativeGit();
      const dir = "/typed-remote";
      await git.clone({ dir, url: originalServer.url });
      await expect(git.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(originalServer.url);
      await git.remoteSetUrl({ dir, name: "origin", url: replacementServer.url });
      await expect(git.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(replacementServer.url);
      await git.fetch({ dir, remote: "origin" });
      await expect(git.revParse({ dir, ref: "refs/remotes/origin/main" })).resolves.toBe(
        replacementHead,
      );
      await expect(git.configGet({ dir, path: "remote.origin.pushurl" })).resolves.toBeUndefined();
      await expect(
        git.push({ dir, remote: "origin", ref: "main", remoteRef: "typed-fallback" }),
      ).resolves.toMatchObject({ ok: true });
      expect(replacement.git("rev-parse", "refs/heads/typed-fallback")).toBe(originalHead);
      expect(original.gitResult("rev-parse", "refs/heads/typed-fallback").status).not.toBe(0);
    } finally {
      await Promise.all([originalServer.close(), replacementServer.close()]);
    }
  });
  it("rejects a missing remote URL without creating a partial section", async () => {
    const { git } = makeNativeGit();
    const dir = "/missing-remote";
    await git.init({ dir });
    await expect(git.remoteGetUrl({ dir, name: "missing" })).rejects.toMatchObject({
      code: "EREMOTEFAIL",
    });
    await expect(
      git.remoteSetUrl({ dir, name: "missing", url: "https://example.invalid/new.git" }),
    ).rejects.toMatchObject({ code: "EREMOTEFAIL" });
    await expect(git.configGet({ dir, path: "remote.missing.url" })).resolves.toBeUndefined();
    await expect(git.configGet({ dir, path: "remote.missing.fetch" })).resolves.toBeUndefined();
    await expect(git.remoteList({ dir })).resolves.toEqual([]);
  });
  it("rejects a multi-valued remote URL without replacing its values", async () => {
    const { git } = makeNativeGit();
    const dir = "/multi-url-remote";
    await git.init({ dir });
    await git.remoteAdd({ dir, name: "origin", url: "https://example.invalid/one.git" });
    await git.configSet({
      dir,
      path: "remote.origin.url",
      value: "https://example.invalid/two.git",
      append: true,
    });
    await expect(git.remoteGetUrl({ dir, name: "origin" })).rejects.toMatchObject({
      code: "EUNSUPPORTED",
    });
    await expect(
      git.remoteSetUrl({ dir, name: "origin", url: "https://example.invalid/new.git" }),
    ).rejects.toMatchObject({ code: "EUNSUPPORTED" });
    await expect(git.configGet({ dir, path: "remote.origin.url", all: true })).resolves.toEqual([
      "https://example.invalid/one.git",
      "https://example.invalid/two.git",
    ]);
  });
  it("rolls remote config back after coded SQLite value failures", async () => {
    const workspace = makeTestWorkspace();
    const faultStorage = new CodedTooBigStorage(workspace.storage);
    const database = new SqliteGitDatabase(new Database(faultStorage));
    const git = bindNativeGitDatabase(workspace, database);
    const dir = "/remote-sqlite-too-big";
    await git.init({ dir });
    const configState = (): Record<string, unknown>[] =>
      database.db.all<Record<string, unknown>>(
        "SELECT path, seq, value FROM git_config WHERE repo_id = 1 ORDER BY path, seq",
      );
    const beforeAdd = configState();
    faultStorage.arm("INSERT INTO git_config", "remote.origin.fetch");
    await expect(
      git.remoteAdd({ dir, name: "origin", url: "https://example.invalid/original.git" }),
    ).rejects.toMatchObject({ name: "GitError", code: "E2BIG" });
    expect(faultStorage.writesBeforeFailure).toBeGreaterThan(0);
    expect(configState()).toEqual(beforeAdd);
    const original = "https://example.invalid/original.git";
    await git.remoteAdd({ dir, name: "origin", url: original });
    const beforeSet = configState();
    faultStorage.arm("INSERT INTO git_config", "remote.origin.url");
    await expect(
      git.remoteSetUrl({ dir, name: "origin", url: "https://example.invalid/replacement.git" }),
    ).rejects.toMatchObject({ name: "GitError", code: "E2BIG" });
    expect(faultStorage.writesBeforeFailure).toBeGreaterThan(0);
    expect(configState()).toEqual(beforeSet);
    await expect(git.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(original);
    const coldDatabase = new SqliteGitDatabase(new TestDatabase(workspace.storage));
    const coldGit = bindNativeGitDatabase(workspace, coldDatabase);
    await expect(coldGit.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(original);
    await expect(coldGit.configGet({ dir, path: "remote.origin.fetch" })).resolves.toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
  });
  it("round-trips the former remote URL first excess through a cold reopen", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/bounded-url-remote";
    const original = "https://example.invalid/original.git";
    await git.init({ dir });
    await git.remoteAdd({ dir, name: "origin", url: original });
    const formerFirstExcess = "x".repeat(8193);
    await expect(
      git.remoteSetUrl({ dir, name: "origin", url: formerFirstExcess }),
    ).resolves.toBeUndefined();
    await expect(git.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(formerFirstExcess);
    const coldGit = bindNativeGitDatabase(workspace, new SqliteGitDatabase(workspace.database.db));
    await expect(coldGit.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(formerFirstExcess);
    await git.configSet({
      dir,
      path: "remote.origin.url",
      value: formerFirstExcess,
    });
    await expect(git.remoteGetUrl({ dir, name: "origin" })).resolves.toBe(formerFirstExcess);
    await expect(git.remoteSetUrl({ dir, name: "origin", url: original })).resolves.toBeUndefined();
    await expect(git.configGet({ dir, path: "remote.origin.url" })).resolves.toBe(original);
  });
  it("preserves long remote names and empty URL values accepted by real Git", async () => {
    const { git, workspace } = makeNativeGit();
    const dir = "/long-name-remote";
    const name = "r".repeat(2190);
    await git.init({ dir });
    await git.remoteAdd({ dir, name, url: "https://example.invalid/original.git" });
    await expect(git.remoteList({ dir })).resolves.toEqual([
      { name, url: "https://example.invalid/original.git" },
    ]);
    await expect(git.remoteGetUrl({ dir, name })).resolves.toBe(
      "https://example.invalid/original.git",
    );
    await expect(git.remoteSetUrl({ dir, name, url: "" })).resolves.toBeUndefined();
    await expect(git.remoteGetUrl({ dir, name })).resolves.toBe("");
    const coldGit = bindNativeGitDatabase(workspace, new SqliteGitDatabase(workspace.database.db));
    await expect(coldGit.remoteList({ dir })).resolves.toEqual([{ name, url: "" }]);
    await expect(coldGit.remoteGetUrl({ dir, name })).resolves.toBe("");
  });
  it("validates remote URL options before constructing config paths", async () => {
    const { git } = makeNativeGit();
    const dir = "/invalid-url-options";
    await git.init({ dir });
    await expect(
      Reflect.apply(git.remoteGetUrl, git, [{ dir, name: "invalid\ud800" }]),
    ).rejects.toMatchObject({ code: "EINVAL" });
    await expect(
      Reflect.apply(git.remoteSetUrl, git, [{ dir, name: "origin", url: "\ud800" }]),
    ).rejects.toMatchObject({ code: "EINVAL" });
    await expect(Reflect.apply(git.remoteGetUrl, git, [null])).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(git.remoteList({ dir })).resolves.toEqual([]);
  });
  it("returns structured push status confirmed by the remote", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "before\n");
    fixture.commit("initial");
    fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
    const server = await startGitServer(fixture.dir);
    try {
      const { storage, workspace } = makeWorkspace();
      await workspace.git.clone({ url: server.url, dir: "/" });
      await workspace.fs.writeFile("/README.md", "after\n");
      await workspace.git.add({ paths: ["README.md"] });
      const local = await workspace.git.commit({ message: "local change" });
      expect(await workspace.git.push({})).toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(local.oid);
      expect(fixture.git("show", "HEAD:README.md")).toBe("after");
      const native = reopenGit(storage);
      await expect(native.push({})).resolves.toEqual({
        ok: true,
        error: null,
        unpack: { ok: true },
        refs: [{ ref: "refs/heads/main", ok: true, error: null }],
        tracking: { outcome: "unchanged" },
      });
      const trackingLease: PushLeaseExpectation = { tracking: true };
      const leasedPush: GitPushOptions = { leases: { main: trackingLease } };
      await expect(native.push(leasedPush)).resolves.toMatchObject({ ok: true });
    } finally {
      await server.close();
    }
  });
  it("keeps a pending merge open and refuses to restart it", async () => {
    const { workspace, storage } = makeWorkspace();
    const git = workspace.git;
    await git.init({});
    await workspace.fs.writeFile("/base.txt", "base\n");
    await git.add({ paths: ["base.txt"] });
    await git.commit({ message: "base" });
    await git.branch({ name: "topic" });
    await git.checkout({ ref: "topic" });
    await workspace.fs.writeFile("/topic.txt", "topic\n");
    await git.add({ paths: ["topic.txt"] });
    await git.commit({ message: "topic" });
    await git.checkout({ ref: "main" });
    await workspace.fs.writeFile("/main.txt", "main\n");
    await git.add({ paths: ["main.txt"] });
    const current = await git.commit({ message: "main" });
    const native = reopenGit(storage);
    await expect(native.merge({ theirs: "topic", commit: false })).resolves.toEqual({
      pendingCommit: true,
    });
    expect(await git.revParse({ ref: "HEAD" })).toBe(current.oid);
    await expect(native.merge({ theirs: "topic" })).rejects.toMatchObject({
      code: "EMERGEACTIVE",
    });
  });
  it("reports conflicts after reopen", async () => {
    const { workspace, storage } = makeWorkspace();
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
    await git.commit({ message: "main" });
    const db = new TestDatabase(storage);
    const binding = {
      database: new SqliteGitDatabase(db),
      worktree: createFilesystem(db, { now: () => 1600000000000 }),
      now: () => 1600000000000,
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
  });
  it("blocks ordinary native commit during replay and lets hard reset clear it", async () => {
    const { workspace, storage } = makeWorkspace();
    await workspace.git.init({});
    await workspace.fs.writeFile("/file.txt", "base\n");
    await workspace.git.add({ paths: ["file.txt"] });
    const original = await workspace.git.commit({ message: "base" });
    const replayDb = new TestDatabase(storage);
    const database = new SqliteGitDatabase(replayDb);
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
      worktree: createFilesystem(replayDb, { now: () => 1600000000000 }),
      now: () => 1600000000000,
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
      () => git.branchRename({ dir, newName: "blocked" }),
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
    expect(statements).toBeLessThan(1000);
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
  it("owns object bytes across the public write and read boundaries", async () => {
    const { git, workspace } = makeNativeGit();
    await git.init({ dir: "/" });
    const content = utf8.encode("abc");
    const oid = await git.hashObject({ content, write: true });
    content[1] = 0x78;
    const warm = await git.catFile({ oid });
    expect(utf8Decoder.decode(warm.bytes)).toBe("abc");
    warm.bytes[1] = 0x79;
    expect(utf8Decoder.decode((await git.catFile({ oid })).bytes)).toBe("abc");
    const cold = reopenGit(workspace.storage);
    const reread = await cold.catFile({ oid });
    expect(utf8Decoder.decode(reread.bytes)).toBe("abc");
    reread.bytes[1] = 0x7a;
    expect(utf8Decoder.decode((await cold.catFile({ oid })).bytes)).toBe("abc");
  });

  it("owns object bytes read out of a pack", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "# remote\n");
    fixture.commit("remote work");
    const server = await startGitServer(fixture.dir);
    try {
      const { workspace, storage } = makeWorkspace();
      await workspace.git.clone({ url: server.url, dir: "/" });
      expect(storage.db.prepare("SELECT COUNT(*) AS n FROM git_pack_objects").get()).toEqual({
        n: 3,
      });
      const oid = fixture.git("rev-parse", "HEAD:README.md");
      const packed = await workspace.git.catFile({ oid });
      expect(utf8Decoder.decode(packed.bytes)).toBe("# remote\n");
      packed.bytes[2] = 0x78;
      expect(utf8Decoder.decode((await workspace.git.catFile({ oid })).bytes)).toBe("# remote\n");
      const cold = reopenGit(storage);
      const again = await cold.catFile({ oid });
      expect(utf8Decoder.decode(again.bytes)).toBe("# remote\n");
      again.bytes[2] = 0x79;
      expect(utf8Decoder.decode((await cold.catFile({ oid })).bytes)).toBe("# remote\n");
    } finally {
      await server.close();
    }
  });

  it("keeps the maximal public scratch snapshot below the SQL budget", async () => {
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
      worktree: syntheticCachedWorktree(workspace.worktree, 10000, contentId),
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
    expect(workspace.storage.statementCount - beforeStatements).toBeLessThan(1000);
    expect(clientControlState(workspace, "/")).toEqual(beforeControl);
  });
  it("routes argv CLI through the same dispatcher in two independent workspaces", async () => {
    const clock = 1577836800000;
    const native = makeNativeGit();
    const { workspace: mirror } = makeWorkspace(clock);
    const nativeGit = native.git;
    const mirrorGit = mirror.git;
    const dir = "/argv-repo";
    await nativeGit.init({ dir });
    await mirrorGit.init({ dir });
    writeWorkFile(native.workspace, `${dir}/sub/file.txt`, "one\n");
    await mirror.fs.mkdir(`${dir}/sub`, { recursive: true });
    await mirror.fs.writeFile(`${dir}/sub/file.txt`, "one\n");
    const statusInput = { argv: ["status", "--porcelain"], cwd: `${dir}/sub` };
    const nativeStatus = await nativeGit.runCli(statusInput);
    expect(await nativeGit.cli(statusInput)).toEqual(nativeStatus);
    expect(await mirrorGit.cli(statusInput)).toEqual(nativeStatus);
    expect(nativeStatus).toEqual({
      stdout: "?? ./\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const addInput = { argv: ["add", "file.txt"], cwd: `${dir}/sub` };
    expect(await mirrorGit.cli(addInput)).toEqual(await nativeGit.cli(addInput));
    const env = {
      GIT_AUTHOR_NAME: "CLI Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "CLI Committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    };
    const commitInput = { argv: ["commit", "-m", "from argv"], cwd: dir, env };
    expect(await mirrorGit.cli(commitInput)).toEqual(await nativeGit.cli(commitInput));
    for (const input of [
      { argv: ["symbolic-ref", "--short", "HEAD"], cwd: `${dir}/sub` },
      { argv: ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"], cwd: dir },
      { argv: ["status"], cwd: dir },
      { argv: ["push"], cwd: dir },
      { argv: ["unknown"], cwd: dir },
      { argv: ["status", "--porcelain"], cwd: "/outside" },
    ]) {
      expect(await mirrorGit.cli(input)).toEqual(await nativeGit.runCli(input));
    }
    const legacyInput = { argv: ["status", "--porcelain"], cwd: dir, dir };
    await expect(nativeGit.runCli(legacyInput)).rejects.toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    await expect(mirrorGit.cli(legacyInput)).rejects.toMatchObject({ code: "EINVAL" });
    const unexpected = new Error("unexpected argv getter failure");
    const throwingInput = {
      get argv(): string[] {
        throw unexpected;
      },
    };
    await expect(nativeGit.runCli(throwingInput)).rejects.toThrow(unexpected);
    await expect(nativeGit.cli(throwingInput)).rejects.toBe(unexpected);
    await expect(mirrorGit.cli(throwingInput)).rejects.toBe(unexpected);
  });
  it("fails explicitly for methods that remain unsupported", async () => {
    const { workspace } = makeWorkspace();
    await workspace.git.init({});
    await expect(workspace.git.stashPush({})).rejects.toMatchObject({ code: "EUNSUPPORTED" });
  });
});
