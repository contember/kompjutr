import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { Workspace as ComputerWorkspace } from "@cloudflare/computer";
import { afterEach, describe, expect, it } from "vitest";

import { ComputerWorktree } from "../src/compat/computer/worktree.js";
import { type GitContext, openRepository } from "../src/core/context.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { diffSummaryBounded } from "../src/core/ops/diff.js";
import { initRepository } from "../src/core/ops/init.js";
import { rebase } from "../src/core/ops/rebase.js";
import { dirtyPathStream } from "../src/core/ops/worktree-io.js";
import type { Repository } from "../src/core/repository.js";
import { retainedStringBytes } from "../src/core/retained.js";
import { createFilesystem } from "../src/fs/filesystem.js";
import { createGitCliRunner } from "../src/git/cli/index.js";
import { createGitCliWriteHandlers } from "../src/git/cli/write.js";
import { iterateSqlCursor, type SqlDatabase } from "../src/sqlite/db.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { type GitCommandResult, GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import {
  makeRepo,
  type TestRepository,
  type TestWorkspace,
  writeWorkFile,
} from "./helpers/workspace.js";

const FIXED_TIME = 1_577_836_800_000;
const IDENTITY = { name: "Fixture", email: "fixture@example.com" };
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: IDENTITY.name,
  GIT_AUTHOR_EMAIL: IDENTITY.email,
  GIT_COMMITTER_NAME: IDENTITY.name,
  GIT_COMMITTER_EMAIL: IDENTITY.email,
};
const REAL_GIT_ENV = {
  ...process.env,
  ...IDENTITY_ENV,
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00+0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  LC_ALL: "C",
};

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function fixture(): GitFixture {
  const source = new GitFixture().init();
  fixtures.push(source);
  return source;
}

function gitResult(
  source: GitFixture,
  argv: readonly string[],
  cwd = source.dir,
  env: Readonly<Record<string, string>> = {},
): GitCommandResult {
  const result = spawnSync("git", argv, {
    cwd,
    env: { ...REAL_GIT_ENV, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) throw new Error(`git terminated by signal ${result.signal}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function nativeRepository(root = "/repo"): TestRepository {
  const workspace = makeRepo(root, { startTime: FIXED_TIME });
  workspace.context.defaultIdentity = IDENTITY;
  return workspace;
}

function runner(context: GitContext) {
  return createGitCliRunner(createGitCliWriteHandlers(context));
}

function cliResult(result: GitCommandResult) {
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

function divergent(source: GitFixture, withNested = false): void {
  source.write("shared.txt", "base\n");
  if (withNested) source.write("nested/outer.txt", "outer\n");
  const base = source.commit("base");
  source.git("checkout", "-q", "-b", "upstream", base);
  source.write("shared.txt", "upstream\n");
  source.commit("upstream");
  source.git("checkout", "-q", "-b", "current", base);
  source.write("shared.txt", "current\n");
  source.commit("current");
}

async function conflictedNative(
  resolve = true,
  withNested = false,
): Promise<{
  source: GitFixture;
  workspace: TestRepository;
  repo: Repository;
}> {
  const source = fixture();
  divergent(source, withNested);
  const workspace = nativeRepository("/");
  await importFixture(source, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  expect(gitResult(source, ["rebase", "upstream"]).status).toBe(1);
  expect(
    rebase(workspace.context, workspace.repo, workspace.worktree, {
      upstream: "upstream",
      env: IDENTITY_ENV,
    }),
  ).toMatchObject({ outcome: "conflicted" });
  if (withNested) {
    initRepository(workspace.context, { dir: "/nested" });
    writeWorkFile(workspace, "/nested/foreign.txt", "foreign\n");
  }
  if (resolve) {
    source.write("shared.txt", "resolved\n");
    writeWorkFile(workspace, "/shared.txt", "resolved\n");
    expect(gitResult(source, ["add", "shared.txt"]).status).toBe(0);
    expect(
      runner(workspace.context).runCli({ argv: ["add", "shared.txt"], env: IDENTITY_ENV }),
    ).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  }
  return { source, workspace, repo: workspace.repo };
}

function reopenNative(
  workspace: TestWorkspace,
  root = "/",
): {
  context: GitContext;
  repo: Repository;
} {
  const db = new TestDatabase(workspace.storage);
  const worktree = createFilesystem(db, { now: () => FIXED_TIME });
  const context: GitContext = {
    database: new SqliteGitDatabase(db, { now: () => FIXED_TIME }),
    worktree,
    now: () => FIXED_TIME,
    timezoneOffset: () => 0,
    defaultIdentity: IDENTITY,
  };
  return { context, repo: openRepository(context, root) };
}

function computerContext(workspace: ComputerWorkspace): GitContext {
  const provider = workspace.provider();
  const computerDb = provider.db;
  const db: SqlDatabase = {
    run(query, ...bindings) {
      computerDb.run(query, ...bindings);
    },
    all(query, ...bindings) {
      return computerDb.all(query, ...bindings);
    },
    one(query, ...bindings) {
      return computerDb.one(query, ...bindings);
    },
    scalar(query, ...bindings) {
      return computerDb.scalar(query, ...bindings);
    },
    iterate(query, ...bindings) {
      return iterateSqlCursor(computerDb.sql.exec(query, ...bindings));
    },
    transactionSync(closure) {
      return computerDb.transactionSync(closure);
    },
  };
  return {
    database: new SqliteGitDatabase(db, { now: () => FIXED_TIME }),
    worktree: new ComputerWorktree(provider, db),
    now: () => FIXED_TIME,
    timezoneOffset: () => 0,
    defaultIdentity: IDENTITY,
  };
}

type BackendKind = "native" | "computer";

interface ReopenableBackend {
  context: GitContext;
  repo: Repository;
  write(path: string, content: string): Promise<void>;
  reopen(): { context: GitContext; repo: Repository };
}

async function backend(kind: BackendKind): Promise<ReopenableBackend> {
  if (kind === "native") {
    const workspace = nativeRepository("/");
    return {
      context: workspace.context,
      repo: workspace.repo,
      async write(path, content) {
        writeWorkFile(workspace, path, content);
      },
      reopen() {
        return reopenNative(workspace);
      },
    };
  }
  const storage = new SqliteTestStorage();
  const computer = new ComputerWorkspace({ storage });
  const context = computerContext(computer);
  context.defaultIdentity = IDENTITY;
  const repo = initRepository(context);
  return {
    context,
    repo,
    async write(path, content) {
      await computer.fs.writeFile(path, content);
    },
    reopen() {
      const reopenedContext = computerContext(new ComputerWorkspace({ storage }));
      return { context: reopenedContext, repo: openRepository(reopenedContext) };
    },
  };
}

async function stagedCommitBackend(kind: BackendKind): Promise<ReopenableBackend> {
  const target = await backend(kind);
  await target.write("/file.txt", "one\n");
  runner(target.context).runCli({ argv: ["add", "file.txt"], env: IDENTITY_ENV });
  return target;
}

async function conflictedBackend(kind: BackendKind): Promise<ReopenableBackend> {
  const source = fixture();
  divergent(source);
  const target = await backend(kind);
  await importFixture(source, target.repo.checkout);
  checkoutTree(target.repo, target.context.worktree, target.repo.headTree());
  expect(
    rebase(target.context, target.repo, target.context.worktree, {
      upstream: "upstream",
      env: IDENTITY_ENV,
    }),
  ).toMatchObject({ outcome: "conflicted" });
  await target.write("/shared.txt", "resolved\n");
  expect(runner(target.context).runCli({ argv: ["add", "shared.txt"], env: IDENTITY_ENV })).toEqual(
    { stdout: "", stderr: "", exitCode: 0 },
  );
  return target;
}

async function mixedIgnoredAddBackend(kind: BackendKind): Promise<ReopenableBackend> {
  const target = await backend(kind);
  await target.write("/.gitignore", "*.log\n");
  await target.write("/good.txt", "good\n");
  await target.write("/ignored.log", "ignored\n");
  return target;
}

function repositoryState(context: GitContext, repo: Repository) {
  const refs = repo.store.listRefs();
  return {
    head: repo.checkout.head(),
    refs,
    reflogs: [
      { ref: "HEAD", entries: repo.reflog("HEAD") },
      ...refs.map((ref) => ({ ref: ref.name, entries: repo.reflog(ref.name) })),
    ],
    index: [...repo.checkout.indexScan()],
    operation: repo.checkout.readOperationState(),
    worktree: context.worktree.scan(repo.root, { limit: 10_000 }).map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      bytes: entry.type === "file" ? [...context.worktree.readFile(entry.path)] : entry.target,
    })),
    loose: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_objects WHERE repo_id = ? ORDER BY oid",
      repo.store.repoId,
    ),
    objectChunks: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_object_chunks WHERE repo_id = ? ORDER BY oid, seq",
      repo.store.repoId,
    ),
    commits: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_commits WHERE repo_id = ? ORDER BY oid",
      repo.store.repoId,
    ),
    treeSources: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_tree_sources WHERE repo_id = ? ORDER BY tree_oid, storage, source_id",
      repo.store.repoId,
    ),
    treeEntries: repo.store.db.all<Record<string, unknown>>(
      `SELECT entry.* FROM git_tree_entries entry
       JOIN git_tree_sources source ON source.source_key = entry.source_key
       WHERE source.repo_id = ? ORDER BY entry.source_key, entry.ordinal`,
      repo.store.repoId,
    ),
    treeEffective: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_tree_effective WHERE repo_id = ? ORDER BY tree_oid",
      repo.store.repoId,
    ),
    blobIds: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_blob_ids WHERE repo_id = ? ORDER BY content_id",
      repo.store.repoId,
    ),
    blobIdState: repo.store.db.all<Record<string, unknown>>(
      "SELECT * FROM git_blob_id_state WHERE repo_id = ?",
      repo.store.repoId,
    ),
  };
}

function looseOids(repo: Repository): string[] {
  return repo.store.db
    .all<{ oid: string }>(
      "SELECT oid FROM git_objects WHERE repo_id = ? ORDER BY oid",
      repo.store.repoId,
    )
    .map((row) => row.oid);
}

function newLooseOids(before: readonly string[], repo: Repository): string[] {
  const prior = new Set(before);
  return looseOids(repo).filter((oid) => !prior.has(oid));
}

function expectE2Big(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code: "E2BIG" });
    return;
  }
  throw new Error("expected E2BIG");
}

function expectObjectAbsent(repo: Repository, oid: string): void {
  expect(repo.has(oid)).toBe(false);
  expect(repo.store.cachedCommit(oid)).toBeNull();
  try {
    repo.read(oid);
  } catch (error) {
    expect(error).toMatchObject({ code: "ENOTFOUND" });
    return;
  }
  throw new Error(`expected object ${oid} to be unreadable`);
}

function expectObjectsAbsent(repo: Repository, oids: readonly string[]): void {
  for (const oid of oids) expectObjectAbsent(repo, oid);
}

describe("mutating git CLI handlers", () => {
  it("matches Git for cwd-relative add and an ordinary initial commit", () => {
    const source = fixture();
    source.write("nested/a.txt", "one\n");
    source.write("root.txt", "root\n");
    const workspace = nativeRepository();
    writeWorkFile(workspace, "/repo/nested/a.txt", "one\n");
    writeWorkFile(workspace, "/repo/root.txt", "root\n");
    const native = runner(workspace.context);

    const expectedAdd = gitResult(source, ["add", ".", "../root.txt"], join(source.dir, "nested"));
    const actualAdd = native.runCli({
      argv: ["add", ".", "../root.txt"],
      cwd: "/repo/nested",
      env: IDENTITY_ENV,
    });
    expect(actualAdd).toEqual(cliResult(expectedAdd));

    const expectedCommit = gitResult(source, ["commit", "-m", "initial"]);
    const actualCommit = native.runCli({
      argv: ["commit", "-m", "initial"],
      cwd: "/repo",
      env: IDENTITY_ENV,
    });
    expect(actualCommit).toEqual(cliResult(expectedCommit));
    expect(workspace.repo.head().oid).toBe(source.git("rev-parse", "HEAD"));
  });

  it("maps missing and outside path operands without changing the index", () => {
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    const before = [...workspace.repo.checkout.indexScan()];

    expect(native.runCli({ argv: ["add", "missing"], cwd: "/repo" })).toEqual({
      stdout: "",
      stderr: "fatal: pathspec 'missing' did not match any files\n",
      exitCode: 128,
    });
    expect(native.runCli({ argv: ["add", "../../outside"], cwd: "/repo/sub" })).toEqual({
      stdout: "",
      stderr: "fatal: ../../outside: '../../outside' is outside repository at '/repo'\n",
      exitCode: 128,
    });
    expect([...workspace.repo.checkout.indexScan()]).toEqual(before);
  });

  it("preserves literal add operands and matches ignored-path behavior", () => {
    const source = fixture();
    source.write(" spaced ", "literal\n");
    source.write("spaced", "plain\n");
    source.write(".gitignore", "*.log\n");
    source.write("ignored.log", "ignored\n");
    source.write("good.txt", "good\n");
    source.write("é.log", "unicode\n");
    source.write("a b.log", "space\n");
    source.write("sub/nested.log", "nested\n");
    source.write("folder/keep.txt", "keep\n");
    source.write("folder/drop.log", "drop\n");
    const workspace = nativeRepository();
    writeWorkFile(workspace, "/repo/ spaced ", "literal\n");
    writeWorkFile(workspace, "/repo/spaced", "plain\n");
    writeWorkFile(workspace, "/repo/.gitignore", "*.log\n");
    writeWorkFile(workspace, "/repo/ignored.log", "ignored\n");
    writeWorkFile(workspace, "/repo/good.txt", "good\n");
    writeWorkFile(workspace, "/repo/é.log", "unicode\n");
    writeWorkFile(workspace, "/repo/a b.log", "space\n");
    writeWorkFile(workspace, "/repo/sub/nested.log", "nested\n");
    writeWorkFile(workspace, "/repo/folder/keep.txt", "keep\n");
    writeWorkFile(workspace, "/repo/folder/drop.log", "drop\n");
    const native = runner(workspace.context);

    expect(native.runCli({ argv: ["add", " spaced "], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", " spaced "])),
    );
    expect([...workspace.repo.checkout.indexScan()].map((entry) => entry.path)).toEqual([
      " spaced ",
    ]);

    const beforeIgnored = repositoryState(workspace.context, workspace.repo);
    expect(native.runCli({ argv: ["add", "ignored.log"], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", "ignored.log"])),
    );
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(beforeIgnored);
    expect(native.runCli({ argv: ["add", "good.txt", "ignored.log"], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", "good.txt", "ignored.log"])),
    );
    expect([...workspace.repo.checkout.indexScan()].map((entry) => entry.path)).toEqual([
      " spaced ",
      "good.txt",
    ]);
    const afterMixed = repositoryState(workspace.context, workspace.repo);
    expect(native.runCli({ argv: ["add", "é.log", "a b.log", "é.log"], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", "é.log", "a b.log", "é.log"])),
    );
    expect(native.runCli({ argv: ["add", "nested.log"], cwd: "/repo/sub" })).toEqual(
      cliResult(gitResult(source, ["add", "nested.log"], join(source.dir, "sub"))),
    );
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(afterMixed);

    expect(native.runCli({ argv: ["add", "folder"], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", "folder"])),
    );
    expect([...workspace.repo.checkout.indexScan()].map((entry) => entry.path)).toEqual([
      " spaced ",
      "folder/keep.txt",
      "good.txt",
    ]);
  });

  it("stages tracked children while reporting an explicit ignored directory", async () => {
    const source = fixture();
    source.write(".gitignore", "ignored-dir/\n");
    source.write("ignored-dir/tracked.txt", "base\n");
    source.git("add", "-f", "ignored-dir/tracked.txt");
    source.commit("base");
    source.write("ignored-dir/tracked.txt", "changed\n");
    source.write("ignored-dir/untracked.txt", "untracked\n");

    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    writeWorkFile(workspace, "/repo/.gitignore", "ignored-dir/\n");
    writeWorkFile(workspace, "/repo/ignored-dir/tracked.txt", "changed\n");
    writeWorkFile(workspace, "/repo/ignored-dir/untracked.txt", "untracked\n");
    const native = runner(workspace.context);

    expect(
      native.runCli({
        argv: ["add", "ignored-dir", "ignored-dir/tracked.txt", "ignored-dir"],
        cwd: "/repo",
      }),
    ).toEqual(
      cliResult(
        gitResult(source, ["add", "ignored-dir", "ignored-dir/tracked.txt", "ignored-dir"]),
      ),
    );
    expect(workspace.repo.checkout.indexGet("ignored-dir/tracked.txt", 0)?.oid).toBe(
      source.git("rev-parse", ":ignored-dir/tracked.txt"),
    );
    expect(workspace.repo.checkout.indexGet("ignored-dir/untracked.txt", 0)).toBeNull();
  });

  it("uses complete env identities and keeps the partial-env divergence", () => {
    const workspace = nativeRepository();
    workspace.repo.store.configSet("user.name", "Configured");
    workspace.repo.store.configSet("user.email", "configured@example.com");
    writeWorkFile(workspace, "/repo/file.txt", "one\n");
    const native = runner(workspace.context);
    native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    native.runCli({
      argv: ["commit", "-m", "partial"],
      cwd: "/repo",
      env: { GIT_AUTHOR_NAME: "Environment" },
    });
    const oid = workspace.repo.head().oid;
    if (oid === null) throw new Error("commit did not move HEAD");
    const commit = workspace.repo.readCommit(oid);
    expect(commit.author).toMatchObject({ name: "Configured", email: "configured@example.com" });
    expect(commit.committer).toMatchObject({
      name: "Configured",
      email: "configured@example.com",
    });

    writeWorkFile(workspace, "/repo/file.txt", "two\n");
    native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    native.runCli({
      argv: ["commit", "-m", "complete"],
      cwd: "/repo",
      env: {
        GIT_AUTHOR_NAME: "Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Committer",
        GIT_COMMITTER_EMAIL: "committer@example.com",
      },
    });
    const completeOid = workspace.repo.head().oid;
    if (completeOid === null) throw new Error("second commit did not move HEAD");
    const complete = workspace.repo.readCommit(completeOid);
    expect(complete.author).toMatchObject({ name: "Author", email: "author@example.com" });
    expect(complete.committer).toMatchObject({
      name: "Committer",
      email: "committer@example.com",
    });
  });

  it("matches quoted, brace-compressed rename and endpoint mode summaries", () => {
    const source = fixture();
    const original = "dir/old/naïve\tname.txt";
    const renamed = "dir/new/renamed\tname.txt";
    const compactOriginal = "pkg/old/file.ts";
    const compactRenamed = "pkg/new/file.ts";
    source.write(original, "same\n");
    source.write(compactOriginal, "compact\n");
    source.commit("base");
    const workspace = nativeRepository();
    writeWorkFile(workspace, `/repo/${original}`, "same\n");
    writeWorkFile(workspace, `/repo/${compactOriginal}`, "compact\n");
    const native = runner(workspace.context);
    native.runCli({ argv: ["add", "dir", "pkg"], cwd: "/repo" });
    native.runCli({ argv: ["commit", "-m", "base"], cwd: "/repo", env: IDENTITY_ENV });

    source.write("dir/new/.keep", "").remove("dir/new/.keep");
    source.write("pkg/new/.keep", "").remove("pkg/new/.keep");
    workspace.worktree.mkdir("/repo/dir/new", { recursive: true });
    workspace.worktree.mkdir("/repo/pkg/new", { recursive: true });
    source.git("mv", original, renamed);
    source.git("mv", compactOriginal, compactRenamed);
    source.chmod(renamed, 0o755);
    expect(gitResult(source, ["add", "dir", "pkg"]).status).toBe(0);
    workspace.worktree.rename(`/repo/${original}`, `/repo/${renamed}`);
    workspace.worktree.rename(`/repo/${compactOriginal}`, `/repo/${compactRenamed}`);
    workspace.worktree.chmod(`/repo/${renamed}`, 0o755);
    native.runCli({ argv: ["add", "dir", "pkg"], cwd: "/repo" });

    expect(
      native.runCli({ argv: ["commit", "-m", "rename"], cwd: "/repo", env: IDENTITY_ENV }),
    ).toEqual(cliResult(gitResult(source, ["commit", "-m", "rename"])));

    source.git("config", "core.quotePath", "false");
    workspace.repo.store.configSet("core.quotePath", "false");
    source.chmod(renamed, 0o644);
    workspace.worktree.chmod(`/repo/${renamed}`, 0o644);
    expect(gitResult(source, ["add", renamed]).status).toBe(0);
    native.runCli({ argv: ["add", renamed], cwd: "/repo" });
    expect(
      native.runCli({ argv: ["commit", "-m", "mode"], cwd: "/repo", env: IDENTITY_ENV }),
    ).toEqual(cliResult(gitResult(source, ["commit", "-m", "mode"])));
  });

  it("bounds commit-summary rows and retained bytes before materializing them", () => {
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    writeWorkFile(workspace, "/repo/file.txt", "one\n");
    native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    native.runCli({ argv: ["commit", "-m", "base"], cwd: "/repo", env: IDENTITY_ENV });
    const parent = workspace.repo.head().oid;
    if (parent === null) throw new Error("base commit is missing");
    writeWorkFile(workspace, "/repo/file.txt", "two\n");
    native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    native.runCli({ argv: ["commit", "-m", "change"], cwd: "/repo", env: IDENTITY_ENV });
    const current = workspace.repo.head().oid;
    if (current === null) throw new Error("changed commit is missing");
    const options = { ref: parent, to: current, renames: false };
    const exactBytes = 128 + retainedStringBytes("file.txt");

    expect(
      diffSummaryBounded(workspace.repo, workspace.worktree, options, undefined, {
        maxRows: 1,
        maxRetainedBytes: exactBytes,
      }),
    ).toHaveLength(1);
    expect(() =>
      diffSummaryBounded(workspace.repo, workspace.worktree, options, undefined, {
        maxRows: 0,
        maxRetainedBytes: exactBytes,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() =>
      diffSummaryBounded(workspace.repo, workspace.worktree, options, undefined, {
        maxRows: 1,
        maxRetainedBytes: exactBytes - 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("keeps the typed dirty-path file-row ceiling independent of directory rows", () => {
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    writeWorkFile(workspace, "/repo/file.txt", "one\n");
    native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    native.runCli({ argv: ["commit", "-m", "base"], cwd: "/repo", env: IDENTITY_ENV });
    for (let ordinal = 0; ordinal < 100; ordinal++) {
      workspace.worktree.mkdir(`/repo/d${ordinal.toString().padStart(3, "0")}`);
    }
    const limits = {
      maxIndexRows: 1,
      indexRows: 0,
      maxWorktreeRows: 1,
      worktreeRows: 0,
      maxHashCandidates: 1,
      hashCandidates: 0,
      maxHashBytes: 1024,
      hashBytes: 0,
      maxHashRangeReads: 1,
      hashRangeReads: 0,
      maxHashBatches: 1,
      hashBatches: 0,
    };

    expect([...dirtyPathStream(workspace.repo, workspace.worktree, undefined, limits)]).toEqual([]);
    expect(limits).toMatchObject({ indexRows: 1, worktreeRows: 1 });
  });

  it("matches Git's empty, clean-index, and unmerged commit refusals", async () => {
    const emptySource = fixture();
    emptySource.write("file.txt", "one\n");
    const empty = nativeRepository();
    writeWorkFile(empty, "/repo/file.txt", "one\n");
    const emptyRunner = runner(empty.context);
    emptyRunner.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    expect(gitResult(emptySource, ["add", "file.txt"]).status).toBe(0);
    expect(
      emptyRunner.runCli({ argv: ["commit", "-m", "   \n"], cwd: "/repo", env: IDENTITY_ENV }),
    ).toEqual(cliResult(gitResult(emptySource, ["commit", "-m", "   \n"])));

    const cleanSource = fixture();
    cleanSource.write("file.txt", "one\n");
    cleanSource.commit("base");
    const clean = nativeRepository();
    await importFixture(cleanSource, clean.repo.checkout);
    checkoutTree(clean.repo, clean.worktree, clean.repo.headTree());
    expect(
      runner(clean.context).runCli({
        argv: ["commit", "-m", "clean"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(cleanSource, ["commit", "-m", "clean"])));

    cleanSource.write("file.txt", "two\n");
    cleanSource.write("untracked.txt", "new\n");
    writeWorkFile(clean, "/repo/file.txt", "two\n");
    writeWorkFile(clean, "/repo/untracked.txt", "new\n");
    expect(
      runner(clean.context).runCli({
        argv: ["commit", "-m", "dirty"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(cleanSource, ["commit", "-m", "dirty"])));

    const conflict = await conflictedNative(false);
    expect(
      runner(conflict.workspace.context).runCli({
        argv: ["commit", "-m", "not yet"],
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(conflict.source, ["commit", "-m", "not yet"])));
  });

  it("matches Git for add plus rebase continue and aborts after reopen", async () => {
    const unresolved = await conflictedNative(false);
    const unresolvedBefore = repositoryState(unresolved.workspace.context, unresolved.repo);
    expect(
      runner(unresolved.workspace.context).runCli({
        argv: ["rebase", "--continue"],
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(unresolved.source, ["rebase", "--continue"])));
    expect(repositoryState(unresolved.workspace.context, unresolved.repo)).toEqual(
      unresolvedBefore,
    );

    const continued = await conflictedNative();
    const expected = gitResult(continued.source, ["rebase", "--continue"]);
    const actual = runner(continued.workspace.context).runCli({
      argv: ["rebase", "--continue"],
      env: IDENTITY_ENV,
    });
    expect(actual).toEqual(cliResult(expected));
    expect(continued.repo.head().oid).toBe(continued.source.git("rev-parse", "HEAD"));

    const aborted = await conflictedNative();
    const beforeHead = aborted.repo.checkout.requireOperationState("rebase").state.originalHeadOid;
    const reopened = reopenNative(aborted.workspace);
    const expectedAbort = gitResult(aborted.source, ["rebase", "--abort"]);
    const actualAbort = runner(reopened.context).runCli({ argv: ["rebase", "--abort"] });
    expect(actualAbort).toEqual(cliResult(expectedAbort));
    expect(reopened.repo.head().oid).toBe(beforeHead);
    expect(reopened.repo.checkout.readOperationState()).toBeNull();
    expect([...reopened.repo.checkout.indexScan()].some((entry) => entry.stage > 0)).toBe(false);
  });

  it("preserves foreign nested checkouts during rebase continue and abort", async () => {
    const continued = await conflictedNative(true, true);
    const continuedNested = continued.workspace.worktree.scan("/nested", { limit: 100 });
    expect(
      runner(continued.workspace.context).runCli({
        argv: ["rebase", "--continue"],
        env: IDENTITY_ENV,
      }).exitCode,
    ).toBe(0);
    expect(continued.workspace.worktree.scan("/nested", { limit: 100 })).toEqual(continuedNested);
    expect(
      new TextDecoder().decode(continued.workspace.worktree.readFile("/nested/outer.txt")),
    ).toBe("outer\n");
    expect(
      new TextDecoder().decode(continued.workspace.worktree.readFile("/nested/foreign.txt")),
    ).toBe("foreign\n");

    const aborted = await conflictedNative(true, true);
    const abortedNested = aborted.workspace.worktree.scan("/nested", { limit: 100 });
    const reopened = reopenNative(aborted.workspace);
    expect(runner(reopened.context).runCli({ argv: ["rebase", "--abort"] }).exitCode).toBe(0);
    expect(reopened.context.worktree.scan("/nested", { limit: 100 })).toEqual(abortedNested);
    expect(new TextDecoder().decode(reopened.context.worktree.readFile("/nested/outer.txt"))).toBe(
      "outer\n",
    );
    expect(
      new TextDecoder().decode(reopened.context.worktree.readFile("/nested/foreign.txt")),
    ).toBe("foreign\n");
  });

  it("bounds mixed ignored add output and rolls back its staged paths across reopen", async () => {
    const control = await mixedIgnoredAddBackend("native");
    const controlLooseBefore = looseOids(control.repo);
    const controlResult = runner(control.context).runCli({
      argv: ["add", "good.txt", "ignored.log"],
    });
    const orphanOids = newLooseOids(controlLooseBefore, control.repo);
    expect(orphanOids.length).toBeGreaterThan(0);
    const stderrBytes = new TextEncoder().encode(controlResult.stderr).length;
    const ceilings = [
      {
        exact: { maxStderrBytes: stderrBytes },
        firstExcess: { maxStderrBytes: stderrBytes - 1 },
      },
      {
        exact: { maxCombinedOutputBytes: stderrBytes },
        firstExcess: { maxCombinedOutputBytes: stderrBytes - 1 },
      },
    ];

    for (const kind of ["native", "computer"] satisfies BackendKind[]) {
      for (const ceiling of ceilings) {
        const exact = await mixedIgnoredAddBackend(kind);
        expect(
          runner(exact.context).runCli({ argv: ["add", "good.txt", "ignored.log"] }, ceiling.exact),
        ).toEqual(controlResult);
        expect(exact.repo.checkout.indexGet("good.txt", 0)).not.toBeNull();

        const overflow = await mixedIgnoredAddBackend(kind);
        const before = repositoryState(overflow.context, overflow.repo);
        expectE2Big(() =>
          runner(overflow.context).runCli(
            { argv: ["add", "good.txt", "ignored.log"] },
            ceiling.firstExcess,
          ),
        );
        expectObjectsAbsent(overflow.repo, orphanOids);
        const reopened = overflow.reopen();
        expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
        expectObjectsAbsent(reopened.repo, orphanOids);
      }
    }
  });

  it("rolls back commit output overflow across reopen for native and Computer worktrees", async () => {
    const control = await stagedCommitBackend("native");
    const controlLooseBefore = looseOids(control.repo);
    const controlResult = runner(control.context).runCli({
      argv: ["commit", "-m", "commit"],
      env: IDENTITY_ENV,
    });
    const orphanOid = control.repo.head().oid;
    if (orphanOid === null) throw new Error("control commit did not move HEAD");
    const orphanOids = newLooseOids(controlLooseBefore, control.repo);
    expect(orphanOids).toContain(orphanOid);
    const stdoutBytes = new TextEncoder().encode(controlResult.stdout).length;
    const ceilings = [
      {
        exact: { maxStdoutBytes: stdoutBytes },
        firstExcess: { maxStdoutBytes: stdoutBytes - 1 },
      },
      {
        exact: { maxCombinedOutputBytes: stdoutBytes },
        firstExcess: { maxCombinedOutputBytes: stdoutBytes - 1 },
      },
    ];

    for (const kind of ["native", "computer"] satisfies BackendKind[]) {
      for (const ceiling of ceilings) {
        const exact = await stagedCommitBackend(kind);
        expect(
          runner(exact.context).runCli(
            { argv: ["commit", "-m", "commit"], env: IDENTITY_ENV },
            ceiling.exact,
          ),
        ).toEqual(controlResult);

        const overflow = await stagedCommitBackend(kind);
        const before = repositoryState(overflow.context, overflow.repo);
        expectE2Big(() =>
          runner(overflow.context).runCli(
            { argv: ["commit", "-m", "commit"], env: IDENTITY_ENV },
            ceiling.firstExcess,
          ),
        );
        expectObjectsAbsent(overflow.repo, orphanOids);
        const reopened = overflow.reopen();
        expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
        expectObjectsAbsent(reopened.repo, orphanOids);
      }
    }
  });

  it("rolls back every retained rebase output overflow and can discard stderr", async () => {
    const control = await conflictedBackend("native");
    const controlLooseBefore = looseOids(control.repo);
    const controlResult = runner(control.context).runCli({
      argv: ["rebase", "--continue"],
      env: IDENTITY_ENV,
    });
    const orphanOid = control.repo.head().oid;
    if (orphanOid === null) throw new Error("control rebase did not move HEAD");
    const orphanOids = newLooseOids(controlLooseBefore, control.repo);
    expect(orphanOids).toContain(orphanOid);
    const stdoutBytes = new TextEncoder().encode(controlResult.stdout).length;
    const stderrBytes = new TextEncoder().encode(controlResult.stderr).length;
    const combinedBytes = stdoutBytes + stderrBytes;
    const ceilings = [
      {
        exact: { maxStdoutBytes: stdoutBytes },
        firstExcess: { maxStdoutBytes: stdoutBytes - 1 },
      },
      {
        exact: { maxStderrBytes: stderrBytes },
        firstExcess: { maxStderrBytes: stderrBytes - 1 },
      },
      {
        exact: { maxCombinedOutputBytes: combinedBytes },
        firstExcess: { maxCombinedOutputBytes: combinedBytes - 1 },
      },
    ];

    for (const kind of ["native", "computer"] satisfies BackendKind[]) {
      for (const ceiling of ceilings) {
        const exact = await conflictedBackend(kind);
        expect(
          runner(exact.context).runCli(
            { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
            ceiling.exact,
          ),
        ).toEqual(controlResult);

        const overflow = await conflictedBackend(kind);
        const before = repositoryState(overflow.context, overflow.repo);
        expectE2Big(() =>
          runner(overflow.context).runCli(
            { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
            ceiling.firstExcess,
          ),
        );
        expectObjectsAbsent(overflow.repo, orphanOids);
        const reopened = overflow.reopen();
        expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
        expectObjectsAbsent(reopened.repo, orphanOids);
      }

      const discarded = await conflictedBackend(kind);
      const discardedResult = runner(discarded.context).runCli(
        { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
        {
          maxStderrBytes: 0,
          maxCombinedOutputBytes: stdoutBytes,
          discardStderr: true,
        },
      );
      expect(discardedResult).toEqual({
        stdout: controlResult.stdout,
        stderr: "",
        exitCode: 0,
      });

      for (const options of [
        { maxStdoutBytes: stdoutBytes - 1, discardStderr: true },
        { maxCombinedOutputBytes: stdoutBytes - 1, discardStderr: true },
      ]) {
        const overflow = await conflictedBackend(kind);
        const before = repositoryState(overflow.context, overflow.repo);
        expectE2Big(() =>
          runner(overflow.context).runCli(
            { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
            options,
          ),
        );
        expectObjectsAbsent(overflow.repo, orphanOids);
        const reopened = overflow.reopen();
        expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
        expectObjectsAbsent(reopened.repo, orphanOids);
      }
    }
  });

  it("keeps rejected mutating argv non-mutating", async () => {
    const target = await conflictedNative(false);
    const native = runner(target.workspace.context);
    const before = repositoryState(target.workspace.context, target.repo);
    for (const argv of [
      ["add", "--all"],
      ["commit", "-m"],
      ["rebase", "--skip"],
    ]) {
      expect(native.runCli({ argv, env: IDENTITY_ENV }).exitCode).toBe(129);
      expect(repositoryState(target.workspace.context, target.repo)).toEqual(before);
    }
  });

  it("fails closed when rebase worktree transaction affinity is absent", async () => {
    const target = await conflictedNative();
    const context: GitContext = {
      ...target.workspace.context,
      worktree: { ...target.workspace.worktree, db: undefined },
    };
    const before = repositoryState(target.workspace.context, target.repo);
    expect(() => runner(context).runCli({ argv: ["rebase", "--abort"] })).toThrowError(
      /share one database/,
    );
    expect(repositoryState(target.workspace.context, target.repo)).toEqual(before);
  });
});
