import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilesystem } from "../src/fs/filesystem.js";
import { createContextGitCliRunner } from "../src/git/cli/index.js";
import { utf8 } from "../src/git/common/bytes.js";
import { hashObject } from "../src/git/common/objects.js";
import { joinPath as gitJoinPath } from "../src/git/common/paths.js";
import { checkoutTree } from "../src/git/ops/checkout/checkout.js";
import { type GitContext, openRepository } from "../src/git/ops/core/context.js";
import { diffSummaryBounded, diffSummaryEntryRetainedBytes } from "../src/git/ops/diff/diff.js";
import { rebase } from "../src/git/ops/rebase/rebase.js";
import { commit } from "../src/git/ops/repository/commit.js";
import { initRepository } from "../src/git/ops/repository/init.js";
import type { Repository } from "../src/git/ops/repository/repository.js";
import { dirtyPathStream } from "../src/git/ops/worktree/worktree-io.js";
import { PACK_BLOB_BATCH_TARGET_BYTES, SqliteGitDatabase } from "../src/git/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { type GitCommandResult, GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import {
  makeRepo,
  type TestRepository,
  type TestWorkspace,
  writeWorkFile,
} from "./helpers/workspace.js";

const FIXED_TIME = 1577836800000;
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
  return createContextGitCliRunner(context);
}
function cliResult(result: GitCommandResult) {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    truncated: false,
  };
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
      await runner(workspace.context).runCli({ argv: ["add", "shared.txt"], env: IDENTITY_ENV }),
    ).toEqual({ stdout: "", stderr: "", exitCode: 0, truncated: false });
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
interface ReopenableBackend {
  context: GitContext;
  repo: Repository;
  write(path: string, content: string): Promise<void>;
  reopen(): {
    context: GitContext;
    repo: Repository;
  };
}
async function backend(): Promise<ReopenableBackend> {
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
async function dirtyCommitAllBackend(): Promise<ReopenableBackend> {
  const target = await backend();
  await target.write("/file.txt", "one\n");
  await runner(target.context).runCli({ argv: ["add", "file.txt"], env: IDENTITY_ENV });
  await runner(target.context).runCli({
    argv: ["commit", "-m", "base"],
    env: IDENTITY_ENV,
  });
  await target.write("/file.txt", "two\n");
  return target;
}
async function conflictedBackend(): Promise<ReopenableBackend> {
  const source = fixture();
  divergent(source);
  const target = await backend();
  await importFixture(source, target.repo.checkout);
  checkoutTree(target.repo, target.context.worktree, target.repo.headTree());
  expect(
    rebase(target.context, target.repo, target.context.worktree, {
      upstream: "upstream",
      env: IDENTITY_ENV,
    }),
  ).toMatchObject({ outcome: "conflicted" });
  await target.write("/shared.txt", "resolved\n");
  expect(
    await runner(target.context).runCli({ argv: ["add", "shared.txt"], env: IDENTITY_ENV }),
  ).toEqual({ stdout: "", stderr: "", exitCode: 0, truncated: false });
  return target;
}
async function mixedIgnoredAddBackend(): Promise<ReopenableBackend> {
  const target = await backend();
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
    worktree: context.worktree.scan(repo.root, { limit: 10000 }).map((entry) => ({
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
    .all<{
      oid: string;
    }>("SELECT oid FROM git_objects WHERE repo_id = ? ORDER BY oid", repo.store.repoId)
    .map((row) => row.oid);
}
function newLooseOids(before: readonly string[], repo: Repository): string[] {
  const prior = new Set(before);
  return looseOids(repo).filter((oid) => !prior.has(oid));
}
function indexLines(repo: Repository): string[] {
  return [...repo.checkout.indexScan()].map(
    (entry) =>
      `${entry.mode.toString(8).padStart(6, "0")} ${entry.oid} ${entry.stage}\t${entry.path}`,
  );
}
function lines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}
async function expectPublicGitState(source: GitFixture, workspace: TestRepository): Promise<void> {
  const symbolic = gitResult(source, ["symbolic-ref", "--no-recurse", "-q", "HEAD"]);
  const expectedHead =
    symbolic.status === 0 ? `ref: ${symbolic.stdout.trim()}` : source.git("rev-parse", "HEAD");
  expect(workspace.repo.checkout.head()).toBe(expectedHead);
  expect(workspace.repo.store.listRefs().map((ref) => `${ref.name} ${ref.target}`)).toEqual(
    lines(source.git("for-each-ref", "--format=%(refname) %(objectname)")).filter(
      (line) => line !== "",
    ),
  );
  expect(indexLines(workspace.repo)).toEqual(lines(source.git("ls-files", "--stage")));
  const expectedStatus = gitResult(source, ["status", "--porcelain=v2"]);
  expect(
    await runner(workspace.context).runCli({
      argv: ["status", "--porcelain=v2"],
      cwd: workspace.repo.root,
    }),
  ).toEqual(cliResult(expectedStatus));

  const paths = new Set([
    ...lines(source.git("ls-files")),
    ...[...workspace.repo.checkout.indexScan()].map((entry) => entry.path),
  ]);
  for (const path of paths) {
    if (path === "") continue;
    const diskPath = join(source.dir, path);
    const nativePath = gitJoinPath(workspace.repo.root, path);
    const expected = existsSync(diskPath) ? readFileSync(diskPath) : null;
    const actual =
      workspace.worktree.stat(nativePath) === null ? null : workspace.worktree.readFile(nativePath);
    expect(actual === null ? null : [...actual], path).toEqual(
      expected === null ? null : [...expected],
    );
  }
}
async function expectE2Big(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
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
  it("matches Git for cwd-relative add and an ordinary initial commit", async () => {
    const source = fixture();
    source.write("nested/a.txt", "one\n");
    source.write("root.txt", "root\n");
    const workspace = nativeRepository();
    writeWorkFile(workspace, "/repo/nested/a.txt", "one\n");
    writeWorkFile(workspace, "/repo/root.txt", "root\n");
    const native = runner(workspace.context);
    const expectedAdd = gitResult(source, ["add", ".", "../root.txt"], join(source.dir, "nested"));
    const actualAdd = await native.runCli({
      argv: ["add", ".", "../root.txt"],
      cwd: "/repo/nested",
      env: IDENTITY_ENV,
    });
    expect(actualAdd).toEqual(cliResult(expectedAdd));
    const expectedCommit = gitResult(source, ["commit", "-m", "initial"]);
    const actualCommit = await native.runCli({
      argv: ["commit", "-m", "initial"],
      cwd: "/repo",
      env: IDENTITY_ENV,
    });
    expect(actualCommit).toEqual(cliResult(expectedCommit));
    expect(workspace.repo.head().oid).toBe(source.git("rev-parse", "HEAD"));
  });
  it("matches repository-wide update, force, and all staging from a nested cwd", async () => {
    const source = fixture();
    source.write(".gitignore", "*.log\n");
    source.write("nested/tracked.txt", "one\n");
    source.write("gone.txt", "gone\n");
    source.commit("base");
    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());

    source.write("nested/tracked.txt", "two\n");
    source.remove("gone.txt");
    source.write("new.txt", "new\n");
    source.write("ignored.log", "ignored\n");
    writeWorkFile(workspace, "/repo/nested/tracked.txt", "two\n");
    workspace.worktree.removeFiles(["/repo/gone.txt"]);
    writeWorkFile(workspace, "/repo/new.txt", "new\n");
    writeWorkFile(workspace, "/repo/ignored.log", "ignored\n");
    const native = runner(workspace.context);

    expect(await native.runCli({ argv: ["add", "--update"], cwd: "/repo/nested" })).toEqual(
      cliResult(gitResult(source, ["add", "--update"], join(source.dir, "nested"))),
    );
    expect(indexLines(workspace.repo)).toEqual(source.git("ls-files", "--stage").split("\n"));
    expect(workspace.repo.checkout.indexGet("new.txt", 0)).toBeNull();

    expect(
      await native.runCli({ argv: ["add", "--force", "../ignored.log"], cwd: "/repo/nested" }),
    ).toEqual(
      cliResult(
        gitResult(source, ["add", "--force", "../ignored.log"], join(source.dir, "nested")),
      ),
    );
    expect(indexLines(workspace.repo)).toEqual(source.git("ls-files", "--stage").split("\n"));

    expect(await native.runCli({ argv: ["add", "--all"], cwd: "/repo/nested" })).toEqual(
      cliResult(gitResult(source, ["add", "--all"], join(source.dir, "nested"))),
    );
    expect(indexLines(workspace.repo)).toEqual(source.git("ls-files", "--stage").split("\n"));
  });
  it("matches commit all, amend, and empty commits including identity and nested cwd", async () => {
    const source = fixture();
    source.write("nested/tracked.txt", "one\n");
    source.write("gone.txt", "gone\n");
    source.commit("base");
    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    const native = runner(workspace.context);

    source.write("nested/tracked.txt", "two\n");
    source.remove("gone.txt");
    source.write("untracked.txt", "new\n");
    writeWorkFile(workspace, "/repo/nested/tracked.txt", "two\n");
    workspace.worktree.removeFiles(["/repo/gone.txt"]);
    writeWorkFile(workspace, "/repo/untracked.txt", "new\n");
    const expectedAll = gitResult(
      source,
      ["commit", "--all", "--message", "tracked"],
      join(source.dir, "nested"),
    );
    expect(
      await native.runCli({
        argv: ["commit", "--all", "--message", "tracked"],
        cwd: "/repo/nested",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(expectedAll));
    expect(workspace.repo.head().oid).toBe(source.git("rev-parse", "HEAD"));
    expect(workspace.repo.checkout.indexGet("untracked.txt", 0)).toBeNull();

    source.write("nested/tracked.txt", "corrected\n");
    writeWorkFile(workspace, "/repo/nested/tracked.txt", "corrected\n");
    const expectedAmend = gitResult(source, ["commit", "-a", "--amend", "-m", "corrected"]);
    expect(
      await native.runCli({
        argv: ["commit", "-a", "--amend", "-m", "corrected"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(expectedAmend));
    expect(workspace.repo.head().oid).toBe(source.git("rev-parse", "HEAD"));

    const expectedEmpty = gitResult(source, ["commit", "--allow-empty", "-m", "marker"]);
    expect(
      await native.runCli({
        argv: ["commit", "--allow-empty", "-m", "marker"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(expectedEmpty));
    expect(workspace.repo.head().oid).toBe(source.git("rev-parse", "HEAD"));
  });
  it("streams commit all past the former whole-index threshold", async () => {
    const workspace = nativeRepository();
    const original = utf8.encode("original\n");
    const modified = utf8.encode("modified\n");
    const fresh = utf8.encode("fresh\n");
    const originalOid = workspace.repo.store.write("blob", original);
    const paths = Array.from({ length: 30_000 }, (_, index) => {
      const directory = Math.floor(index / 100);
      const file = index % 100;
      return `tracked/d${directory.toString().padStart(3, "0")}/f${file
        .toString()
        .padStart(3, "0")}-${"x".repeat(24)}.txt`;
    });
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/repo/${path}`, bytes: original })),
    );
    const stats = new Map(
      workspace.worktree
        .scan("/repo", { filesOnly: true, limit: paths.length + 1 })
        .map((entry) => [entry.path.slice("/repo/".length), entry]),
    );
    workspace.repo.checkout.indexReplace(
      paths.map((path) => {
        const stat = stats.get(path);
        if (stat === undefined) throw new Error(`missing commit-all scale path: ${path}`);
        return {
          path,
          stage: 0,
          mode: 0o100644,
          oid: originalOid,
          size: stat.size,
          mtime: stat.mtime,
          ino: stat.ino,
          rev: stat.rev,
        };
      }),
    );
    commit(workspace.context, workspace.repo, { message: "base" });
    const formerlyModeledBytes = paths.reduce(
      (bytes, path) => bytes + 256 + (48 + path.length * 2) + (48 + originalOid.length * 2) + 96,
      0,
    );
    expect(formerlyModeledBytes).toBeGreaterThan(16 * 1024 * 1024);

    workspace.tick(60_000);
    const modifiedPath = paths[0];
    const deletedPath = paths[1];
    const unchangedPath = paths[paths.length - 1];
    const newPath = "new.txt";
    if (modifiedPath === undefined || deletedPath === undefined || unchangedPath === undefined) {
      throw new Error("commit-all scale paths are missing");
    }
    workspace.worktree.writeFiles([
      { path: `/repo/${modifiedPath}`, bytes: modified },
      { path: `/repo/${newPath}`, bytes: fresh },
    ]);
    workspace.worktree.removeFiles([`/repo/${deletedPath}`]);

    const result = await runner(workspace.context).runCli({
      argv: ["commit", "-a", "-m", "scale"],
      cwd: "/repo",
      env: IDENTITY_ENV,
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: "", truncated: false });
    const modifiedOid = hashObject("blob", modified);
    expect(
      [...workspace.repo.checkout.indexScan()].map((entry) => ({
        path: entry.path,
        oid: entry.oid,
      })),
    ).toEqual(
      paths
        .filter((path) => path !== deletedPath)
        .map((path) => ({ path, oid: path === modifiedPath ? modifiedOid : originalOid })),
    );
    const tree = workspace.repo.headTree();
    if (tree === null) throw new Error("commit-all scale commit has no tree");
    expect(workspace.repo.resolveTreePath(tree, modifiedPath)?.oid).toBe(modifiedOid);
    expect(workspace.repo.resolveTreePath(tree, deletedPath)).toBeNull();
    expect(workspace.repo.resolveTreePath(tree, newPath)).toBeNull();
    expect(workspace.repo.resolveTreePath(tree, unchangedPath)?.oid).toBe(originalOid);
    expect(workspace.worktree.stat(`/repo/${newPath}`)).not.toBeNull();
  });
  it("matches an empty root commit and an unborn amend refusal", async () => {
    const source = fixture();
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    const beforeAmend = repositoryState(workspace.context, workspace.repo);
    expect(
      await native.runCli({
        argv: ["commit", "--amend", "-m", "missing"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(source, ["commit", "--amend", "-m", "missing"])));
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(beforeAmend);
    const expected = gitResult(source, ["commit", "--allow-empty", "-m", "empty root"]);
    expect(
      await native.runCli({
        argv: ["commit", "--allow-empty", "-m", "empty root"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(expected));
    expect(workspace.repo.head().oid).toBe(source.git("rev-parse", "HEAD"));
  });
  it("rolls back commit-all staging when identity resolution fails", async () => {
    const source = fixture();
    source.write("tracked.txt", "one\n");
    source.commit("base");
    const workspace = nativeRepository();
    workspace.context.defaultIdentity = undefined;
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    writeWorkFile(workspace, "/repo/tracked.txt", "two\n");
    const before = repositoryState(workspace.context, workspace.repo);

    const result = await runner(workspace.context).runCli({
      argv: ["commit", "-a", "-m", "missing identity"],
      cwd: "/repo",
    });
    expect(result).toMatchObject({ stdout: "", exitCode: 128, truncated: false });
    expect(result.stderr).toContain("Author identity unknown");
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(before);
  });
  it("summarizes a root blob above the repository batching target", async () => {
    const workspace = nativeRepository();
    const content = new Uint8Array(PACK_BLOB_BATCH_TARGET_BYTES + 1).fill(0x61);
    content[0] = 0;
    workspace.worktree.writeFiles([{ path: "/repo/large.bin", bytes: content }]);
    const git = runner(workspace.context);
    expect(
      await git.runCli({ argv: ["add", "large.bin"], cwd: "/repo", env: IDENTITY_ENV }),
    ).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const result = await git.runCli({
      argv: ["commit", "-m", "large root"],
      cwd: "/repo",
      env: IDENTITY_ENV,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 file changed, 0 insertions(+), 0 deletions(-)");
    expect(result.stdout).toContain("create mode 100644 large.bin");
  });
  it("maps missing and outside path operands without changing the index", async () => {
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    const before = [...workspace.repo.checkout.indexScan()];
    expect(await native.runCli({ argv: ["add", "missing"], cwd: "/repo" })).toEqual({
      stdout: "",
      stderr: "fatal: pathspec 'missing' did not match any files\n",
      exitCode: 128,
      truncated: false,
    });
    expect(await native.runCli({ argv: ["add", "../../outside"], cwd: "/repo/sub" })).toEqual({
      stdout: "",
      stderr: "fatal: ../../outside: '../../outside' is outside repository at '/repo'\n",
      exitCode: 128,
      truncated: false,
    });
    expect([...workspace.repo.checkout.indexScan()]).toEqual(before);
  });
  it("preserves literal add operands and matches ignored-path behavior", async () => {
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
    expect(await native.runCli({ argv: ["add", " spaced "], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", " spaced "])),
    );
    expect([...workspace.repo.checkout.indexScan()].map((entry) => entry.path)).toEqual([
      " spaced ",
    ]);
    const beforeIgnored = repositoryState(workspace.context, workspace.repo);
    expect(await native.runCli({ argv: ["add", "ignored.log"], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", "ignored.log"])),
    );
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(beforeIgnored);
    expect(await native.runCli({ argv: ["add", "good.txt", "ignored.log"], cwd: "/repo" })).toEqual(
      cliResult(gitResult(source, ["add", "good.txt", "ignored.log"])),
    );
    expect([...workspace.repo.checkout.indexScan()].map((entry) => entry.path)).toEqual([
      " spaced ",
      "good.txt",
    ]);
    const afterMixed = repositoryState(workspace.context, workspace.repo);
    expect(
      await native.runCli({ argv: ["add", "é.log", "a b.log", "é.log"], cwd: "/repo" }),
    ).toEqual(cliResult(gitResult(source, ["add", "é.log", "a b.log", "é.log"])));
    expect(await native.runCli({ argv: ["add", "nested.log"], cwd: "/repo/sub" })).toEqual(
      cliResult(gitResult(source, ["add", "nested.log"], join(source.dir, "sub"))),
    );
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(afterMixed);
    expect(await native.runCli({ argv: ["add", "folder"], cwd: "/repo" })).toEqual(
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
      await native.runCli({
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
  it("uses complete env identities and keeps the partial-env divergence", async () => {
    const workspace = nativeRepository();
    workspace.repo.store.configSet("user.name", "Configured");
    workspace.repo.store.configSet("user.email", "configured@example.com");
    writeWorkFile(workspace, "/repo/file.txt", "one\n");
    const native = runner(workspace.context);
    await native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    await native.runCli({
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
    await native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    await native.runCli({
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
  it("matches quoted, brace-compressed rename and endpoint mode summaries", async () => {
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
    await native.runCli({ argv: ["add", "dir", "pkg"], cwd: "/repo" });
    await native.runCli({ argv: ["commit", "-m", "base"], cwd: "/repo", env: IDENTITY_ENV });
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
    await native.runCli({ argv: ["add", "dir", "pkg"], cwd: "/repo" });
    expect(
      await native.runCli({ argv: ["commit", "-m", "rename"], cwd: "/repo", env: IDENTITY_ENV }),
    ).toEqual(cliResult(gitResult(source, ["commit", "-m", "rename"])));
    source.git("config", "core.quotePath", "false");
    workspace.repo.store.configSet("core.quotePath", "false");
    source.chmod(renamed, 0o644);
    workspace.worktree.chmod(`/repo/${renamed}`, 0o644);
    expect(gitResult(source, ["add", renamed]).status).toBe(0);
    await native.runCli({ argv: ["add", renamed], cwd: "/repo" });
    expect(
      await native.runCli({ argv: ["commit", "-m", "mode"], cwd: "/repo", env: IDENTITY_ENV }),
    ).toEqual(cliResult(gitResult(source, ["commit", "-m", "mode"])));
  });
  it("bounds commit-summary rows and retained bytes before materializing them", async () => {
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    writeWorkFile(workspace, "/repo/file.txt", "one\n");
    await native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    await native.runCli({ argv: ["commit", "-m", "base"], cwd: "/repo", env: IDENTITY_ENV });
    const parent = workspace.repo.head().oid;
    if (parent === null) throw new Error("base commit is missing");
    writeWorkFile(workspace, "/repo/file.txt", "two\n");
    await native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    await native.runCli({ argv: ["commit", "-m", "change"], cwd: "/repo", env: IDENTITY_ENV });
    const current = workspace.repo.head().oid;
    if (current === null) throw new Error("changed commit is missing");
    const options = { ref: parent, to: current, renames: false };
    const [summaryRow] = diffSummaryBounded(
      workspace.repo,
      workspace.worktree,
      options,
      undefined,
      {
        maxRows: 1,
        maxRetainedBytes: 8 * 1024 * 1024,
      },
    );
    if (summaryRow === undefined) throw new Error("diff summary row is missing");
    const exactBytes = diffSummaryEntryRetainedBytes(summaryRow);
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
  it("keeps the typed dirty-path file-row ceiling independent of directory rows", async () => {
    const workspace = nativeRepository();
    const native = runner(workspace.context);
    writeWorkFile(workspace, "/repo/file.txt", "one\n");
    await native.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    await native.runCli({ argv: ["commit", "-m", "base"], cwd: "/repo", env: IDENTITY_ENV });
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
    await emptyRunner.runCli({ argv: ["add", "file.txt"], cwd: "/repo" });
    expect(gitResult(emptySource, ["add", "file.txt"]).status).toBe(0);
    expect(
      await emptyRunner.runCli({
        argv: ["commit", "-m", "   \n"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(emptySource, ["commit", "-m", "   \n"])));
    const cleanSource = fixture();
    cleanSource.write("file.txt", "one\n");
    cleanSource.commit("base");
    const clean = nativeRepository();
    await importFixture(cleanSource, clean.repo.checkout);
    checkoutTree(clean.repo, clean.worktree, clean.repo.headTree());
    const cleanBefore = repositoryState(clean.context, clean.repo);
    expect(
      await runner(clean.context).runCli({
        argv: ["commit", "-m", "clean"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(cleanSource, ["commit", "-m", "clean"])));
    expect(repositoryState(clean.context, clean.repo)).toEqual(cleanBefore);
    cleanSource.write("file.txt", "two\n");
    cleanSource.write("untracked.txt", "new\n");
    writeWorkFile(clean, "/repo/file.txt", "two\n");
    writeWorkFile(clean, "/repo/untracked.txt", "new\n");
    expect(
      await runner(clean.context).runCli({
        argv: ["commit", "-m", "dirty"],
        cwd: "/repo",
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(cleanSource, ["commit", "-m", "dirty"])));
    const conflict = await conflictedNative(false);
    const conflictBefore = repositoryState(conflict.workspace.context, conflict.repo);
    expect(
      await runner(conflict.workspace.context).runCli({
        argv: ["commit", "-m", "not yet"],
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(conflict.source, ["commit", "-m", "not yet"])));
    expect(repositoryState(conflict.workspace.context, conflict.repo)).toEqual(conflictBefore);
  });
  it("matches Git state across branch create, rename, and deletion", async () => {
    const source = fixture();
    source.write("file.txt", "base\n");
    source.commit("base");
    source.write("file.txt", "tip\n");
    source.commit("tip");
    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    const native = runner(workspace.context);

    for (const argv of [
      ["branch", "topic", "HEAD~1"],
      ["branch", "-m", "topic", "renamed"],
      ["branch", "-d", "renamed"],
      ["branch", "old", "HEAD~1"],
      ["branch", "-D", "old"],
    ]) {
      expect(gitResult(source, argv).status, argv.join(" ")).toBe(0);
      expect((await native.runCli({ argv, cwd: "/repo" })).exitCode, argv.join(" ")).toBe(0);
      await expectPublicGitState(source, workspace);
    }
  });
  it("matches Git state across checkout, switch, path checkout, restore, and refusal", async () => {
    const source = fixture();
    source.write("nested/file.txt", "base\n");
    source.write("removed.txt", "present\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "side", base);
    source.write("nested/file.txt", "side\n");
    source.remove("removed.txt");
    source.commit("side");
    source.git("checkout", "-q", "main");
    source.write("main.txt", "main\n");
    const main = source.commit("main");
    source.git("tag", "v1", main);
    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    const native = runner(workspace.context);

    expect(gitResult(source, ["checkout", "-b", "topic", "side"]).status).toBe(0);
    expect(
      (await native.runCli({ argv: ["checkout", "-b", "topic", "side"], cwd: "/repo" })).exitCode,
    ).toBe(0);
    await expectPublicGitState(source, workspace);

    expect(gitResult(source, ["switch", "main"]).status).toBe(0);
    expect((await native.runCli({ argv: ["switch", "main"], cwd: "/repo" })).exitCode).toBe(0);
    await expectPublicGitState(source, workspace);

    for (const target of ["v1", main]) {
      const before = repositoryState(workspace.context, workspace.repo);
      expect(gitResult(source, ["switch", target]).status, target).not.toBe(0);
      expect(
        (await native.runCli({ argv: ["switch", target], cwd: "/repo" })).exitCode,
        target,
      ).not.toBe(0);
      expect(repositoryState(workspace.context, workspace.repo)).toEqual(before);
      await expectPublicGitState(source, workspace);
    }

    expect(
      gitResult(source, ["checkout", "side", "--", "file.txt"], join(source.dir, "nested")).status,
    ).toBe(0);
    expect(
      (await native.runCli({ argv: ["checkout", "side", "--", "file.txt"], cwd: "/repo/nested" }))
        .exitCode,
    ).toBe(0);
    await expectPublicGitState(source, workspace);

    const sourceRemovalIndex = indexLines(workspace.repo);
    expect(gitResult(source, ["restore", "--source=side", "removed.txt"]).status).toBe(0);
    expect(
      (await native.runCli({ argv: ["restore", "--source=side", "removed.txt"], cwd: "/repo" }))
        .exitCode,
    ).toBe(0);
    expect(indexLines(workspace.repo)).toEqual(sourceRemovalIndex);
    await expectPublicGitState(source, workspace);

    source.write("main.txt", "staged\n");
    writeWorkFile(workspace, "/repo/main.txt", "staged\n");
    expect(gitResult(source, ["add", "main.txt"]).status).toBe(0);
    expect((await native.runCli({ argv: ["add", "main.txt"], cwd: "/repo" })).exitCode).toBe(0);
    const stagedIndex = indexLines(workspace.repo);
    source.write("main.txt", "dirty\n");
    writeWorkFile(workspace, "/repo/main.txt", "dirty\n");
    expect(gitResult(source, ["restore", "main.txt"]).status).toBe(0);
    expect((await native.runCli({ argv: ["restore", "main.txt"], cwd: "/repo" })).exitCode).toBe(0);
    expect(indexLines(workspace.repo)).toEqual(stagedIndex);
    await expectPublicGitState(source, workspace);

    source.write("nested/file.txt", "dirty\n");
    writeWorkFile(workspace, "/repo/nested/file.txt", "dirty\n");
    expect(
      gitResult(source, ["restore", "--source=main", "file.txt"], join(source.dir, "nested"))
        .status,
    ).toBe(0);
    expect(
      (await native.runCli({ argv: ["restore", "--source=main", "file.txt"], cwd: "/repo/nested" }))
        .exitCode,
    ).toBe(0);
    await expectPublicGitState(source, workspace);

    const before = repositoryState(workspace.context, workspace.repo);
    expect(gitResult(source, ["restore", "missing.txt"]).status).not.toBe(0);
    expect(
      (await native.runCli({ argv: ["restore", "missing.txt"], cwd: "/repo" })).exitCode,
    ).not.toBe(0);
    expect(repositoryState(workspace.context, workspace.repo)).toEqual(before);
    await expectPublicGitState(source, workspace);
  });
  it("prunes an explicit-source restore without changing an excluded nested checkout", async () => {
    const source = fixture();
    source.write(".gitignore", "/foreign/\n");
    source.write("removed.txt", "present\n");
    const base = source.commit("base");
    source.git("checkout", "-q", "-b", "without", base);
    source.remove("removed.txt");
    source.commit("without file");
    source.git("checkout", "-q", "main");
    expect(gitResult(source, ["init", "-q", "foreign"]).status).toBe(0);
    source.write("foreign/marker.txt", "foreign\n");

    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    initRepository(workspace.context, { dir: "/repo/foreign" });
    writeWorkFile(workspace, "/repo/foreign/marker.txt", "foreign\n");
    const nested = workspace.worktree.scan("/repo/foreign", { limit: 100 });

    expect(gitResult(source, ["restore", "--source=without", "removed.txt"]).status).toBe(0);
    expect(
      (
        await runner(workspace.context).runCli({
          argv: ["restore", "--source=without", "removed.txt"],
          cwd: "/repo",
        })
      ).exitCode,
    ).toBe(0);
    expect(workspace.worktree.scan("/repo/foreign", { limit: 100 })).toEqual(nested);
    expect(new TextDecoder().decode(workspace.worktree.readFile("/repo/foreign/marker.txt"))).toBe(
      "foreign\n",
    );
    await expectPublicGitState(source, workspace);
  });
  it("matches Git state for path, mixed, hard, and detached resets", async () => {
    const source = fixture();
    source.write("nested/file.txt", "base\n");
    source.write("root.txt", "base\n");
    const base = source.commit("base");
    source.write("nested/file.txt", "tip\n");
    source.write("root.txt", "tip\n");
    const tip = source.commit("tip");
    source.git("branch", "latest", tip);
    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    const native = runner(workspace.context);

    source.write("nested/file.txt", "staged\n");
    writeWorkFile(workspace, "/repo/nested/file.txt", "staged\n");
    expect(gitResult(source, ["add", "file.txt"], join(source.dir, "nested")).status).toBe(0);
    expect((await native.runCli({ argv: ["add", "file.txt"], cwd: "/repo/nested" })).exitCode).toBe(
      0,
    );
    expect(
      gitResult(source, ["reset", "HEAD", "--", "file.txt"], join(source.dir, "nested")).status,
    ).toBe(0);
    expect(
      (await native.runCli({ argv: ["reset", "HEAD", "--", "file.txt"], cwd: "/repo/nested" }))
        .exitCode,
    ).toBe(0);
    await expectPublicGitState(source, workspace);

    expect(gitResult(source, ["reset", "--mixed", base]).status).toBe(0);
    expect((await native.runCli({ argv: ["reset", "--mixed", base], cwd: "/repo" })).exitCode).toBe(
      0,
    );
    await expectPublicGitState(source, workspace);

    expect(gitResult(source, ["reset", "--hard", "latest"]).status).toBe(0);
    expect(
      (await native.runCli({ argv: ["reset", "--hard", "latest"], cwd: "/repo" })).exitCode,
    ).toBe(0);
    await expectPublicGitState(source, workspace);

    expect(gitResult(source, ["checkout", "--detach", tip]).status).toBe(0);
    workspace.repo.checkout.setHead(tip);
    expect(gitResult(source, ["reset", "--hard", base]).status).toBe(0);
    expect((await native.runCli({ argv: ["reset", "--hard", base], cwd: "/repo" })).exitCode).toBe(
      0,
    );
    await expectPublicGitState(source, workspace);
  });
  it("matches Git path reset for distinct spaced and unspaced literal names", async () => {
    const source = fixture();
    source.write(" file ", "spaced base\n");
    source.write("file", "plain base\n");
    source.commit("base");
    source.write(" file ", "spaced staged\n");
    source.write("file", "plain staged\n");
    source.git("add", " file ", "file");
    const workspace = nativeRepository();
    await importFixture(source, workspace.repo.checkout);
    workspace.repo.checkout.indexReplace([
      {
        path: " file ",
        stage: 0,
        mode: 0o100644,
        oid: workspace.repo.store.write("blob", new TextEncoder().encode("spaced staged\n")),
        size: null,
        mtime: null,
        ino: null,
      },
      {
        path: "file",
        stage: 0,
        mode: 0o100644,
        oid: workspace.repo.store.write("blob", new TextEncoder().encode("plain staged\n")),
        size: null,
        mtime: null,
        ino: null,
      },
    ]);
    writeWorkFile(workspace, "/repo/ file ", "spaced staged\n");
    writeWorkFile(workspace, "/repo/file", "plain staged\n");

    expect(gitResult(source, ["reset", "HEAD", "--", " file "]).status).toBe(0);
    expect(
      (
        await runner(workspace.context).runCli({
          argv: ["reset", "HEAD", "--", " file "],
          cwd: "/repo",
        })
      ).exitCode,
    ).toBe(0);
    await expectPublicGitState(source, workspace);
  });
  it("matches Git state for clean rebase start and conflicted rebase skip", async () => {
    const cleanSource = fixture();
    cleanSource.write("base.txt", "base\n");
    const base = cleanSource.commit("base");
    cleanSource.git("checkout", "-q", "-b", "upstream", base);
    cleanSource.write("upstream.txt", "upstream\n");
    cleanSource.commit("upstream");
    cleanSource.git("checkout", "-q", "-b", "current", base);
    cleanSource.write("current.txt", "current\n");
    cleanSource.commit("current");
    const clean = nativeRepository();
    await importFixture(cleanSource, clean.repo.checkout);
    checkoutTree(clean.repo, clean.worktree, clean.repo.headTree());
    expect(gitResult(cleanSource, ["rebase", "upstream"]).status).toBe(0);
    const cleanResult = await runner(clean.context).runCli({
      argv: ["rebase", "upstream"],
      cwd: "/repo",
      env: IDENTITY_ENV,
    });
    expect(cleanResult.exitCode, cleanResult.stderr).toBe(0);
    await expectPublicGitState(cleanSource, clean);

    const conflicted = await conflictedNative(false);
    expect(gitResult(conflicted.source, ["rebase", "--skip"]).status).toBe(0);
    expect(
      (
        await runner(conflicted.workspace.context).runCli({
          argv: ["rebase", "--skip"],
          env: IDENTITY_ENV,
        })
      ).exitCode,
    ).toBe(0);
    await expectPublicGitState(conflicted.source, conflicted.workspace);
  });
  it("matches Git for add plus rebase continue and aborts after reopen", async () => {
    const unresolved = await conflictedNative(false);
    const unresolvedBefore = repositoryState(unresolved.workspace.context, unresolved.repo);
    expect(
      await runner(unresolved.workspace.context).runCli({
        argv: ["rebase", "--continue"],
        env: IDENTITY_ENV,
      }),
    ).toEqual(cliResult(gitResult(unresolved.source, ["rebase", "--continue"])));
    expect(repositoryState(unresolved.workspace.context, unresolved.repo)).toEqual(
      unresolvedBefore,
    );
    const continued = await conflictedNative();
    const expected = gitResult(continued.source, ["rebase", "--continue"]);
    const actual = await runner(continued.workspace.context).runCli({
      argv: ["rebase", "--continue"],
      env: IDENTITY_ENV,
    });
    expect(actual).toEqual(cliResult(expected));
    expect(continued.repo.head().oid).toBe(continued.source.git("rev-parse", "HEAD"));
    const aborted = await conflictedNative();
    const beforeHead = aborted.repo.checkout.requireOperationState("rebase").state.originalHeadOid;
    const reopened = reopenNative(aborted.workspace);
    const expectedAbort = gitResult(aborted.source, ["rebase", "--abort"]);
    const actualAbort = await runner(reopened.context).runCli({ argv: ["rebase", "--abort"] });
    expect(actualAbort).toEqual(cliResult(expectedAbort));
    expect(reopened.repo.head().oid).toBe(beforeHead);
    expect(reopened.repo.checkout.readOperationState()).toBeNull();
    expect([...reopened.repo.checkout.indexScan()].some((entry) => entry.stage > 0)).toBe(false);
  });
  it("preserves foreign nested checkouts during rebase continue and abort", async () => {
    const continued = await conflictedNative(true, true);
    const continuedNested = continued.workspace.worktree.scan("/nested", { limit: 100 });
    expect(
      (
        await runner(continued.workspace.context).runCli({
          argv: ["rebase", "--continue"],
          env: IDENTITY_ENV,
        })
      ).exitCode,
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
    expect((await runner(reopened.context).runCli({ argv: ["rebase", "--abort"] })).exitCode).toBe(
      0,
    );
    expect(reopened.context.worktree.scan("/nested", { limit: 100 })).toEqual(abortedNested);
    expect(new TextDecoder().decode(reopened.context.worktree.readFile("/nested/outer.txt"))).toBe(
      "outer\n",
    );
    expect(
      new TextDecoder().decode(reopened.context.worktree.readFile("/nested/foreign.txt")),
    ).toBe("foreign\n");
  });
  it("preserves foreign nested checkouts during rebase start and skip after reopen", async () => {
    const source = fixture();
    divergent(source, true);
    const started = nativeRepository("/");
    await importFixture(source, started.repo.checkout);
    checkoutTree(started.repo, started.worktree, started.repo.headTree());
    initRepository(started.context, { dir: "/nested" });
    writeWorkFile(started, "/nested/foreign.txt", "foreign\n");
    const startedNested = started.worktree.scan("/nested", { limit: 100 });

    expect(
      (
        await runner(started.context).runCli({
          argv: ["rebase", "upstream"],
          env: IDENTITY_ENV,
        })
      ).exitCode,
    ).toBe(1);
    expect(started.worktree.scan("/nested", { limit: 100 })).toEqual(startedNested);
    expect(new TextDecoder().decode(started.worktree.readFile("/nested/outer.txt"))).toBe(
      "outer\n",
    );
    expect(new TextDecoder().decode(started.worktree.readFile("/nested/foreign.txt"))).toBe(
      "foreign\n",
    );

    const skipped = await conflictedNative(false, true);
    const skippedNested = skipped.workspace.worktree.scan("/nested", { limit: 100 });
    const cold = reopenNative(skipped.workspace);
    expect(
      (
        await runner(cold.context).runCli({
          argv: ["rebase", "--skip"],
          env: IDENTITY_ENV,
        })
      ).exitCode,
    ).toBe(0);
    expect(cold.context.worktree.scan("/nested", { limit: 100 })).toEqual(skippedNested);
    expect(new TextDecoder().decode(cold.context.worktree.readFile("/nested/outer.txt"))).toBe(
      "outer\n",
    );
    expect(new TextDecoder().decode(cold.context.worktree.readFile("/nested/foreign.txt"))).toBe(
      "foreign\n",
    );
  });
  it("bounds mixed ignored add output and rolls back its staged paths across reopen", async () => {
    const control = await mixedIgnoredAddBackend();
    const controlLooseBefore = looseOids(control.repo);
    const controlResult = await runner(control.context).runCli({
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
    for (const ceiling of ceilings) {
      const exact = await mixedIgnoredAddBackend();
      expect(
        await runner(exact.context).runCli(
          { argv: ["add", "good.txt", "ignored.log"] },
          ceiling.exact,
        ),
      ).toEqual(controlResult);
      expect(exact.repo.checkout.indexGet("good.txt", 0)).not.toBeNull();
      const overflow = await mixedIgnoredAddBackend();
      const before = repositoryState(overflow.context, overflow.repo);
      await expectE2Big(
        async () =>
          await runner(overflow.context).runCli(
            { argv: ["add", "good.txt", "ignored.log"] },
            ceiling.firstExcess,
          ),
      );
      expectObjectsAbsent(overflow.repo, orphanOids);
      const reopened = overflow.reopen();
      expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
      expectObjectsAbsent(reopened.repo, orphanOids);
    }
  });
  it("rolls back commit-all staging and publication on output overflow across reopen", async () => {
    const control = await dirtyCommitAllBackend();
    const controlLooseBefore = looseOids(control.repo);
    const controlResult = await runner(control.context).runCli({
      argv: ["commit", "-a", "-m", "commit"],
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
    for (const ceiling of ceilings) {
      const exact = await dirtyCommitAllBackend();
      expect(
        await runner(exact.context).runCli(
          { argv: ["commit", "-a", "-m", "commit"], env: IDENTITY_ENV },
          ceiling.exact,
        ),
      ).toEqual(controlResult);
      const prepared = await dirtyCommitAllBackend();
      const overflow = prepared.reopen();
      const before = repositoryState(overflow.context, overflow.repo);
      await expectE2Big(
        async () =>
          await runner(overflow.context).runCli(
            { argv: ["commit", "-a", "-m", "commit"], env: IDENTITY_ENV },
            ceiling.firstExcess,
          ),
      );
      expectObjectsAbsent(overflow.repo, orphanOids);
      const reopened = prepared.reopen();
      expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
      expectObjectsAbsent(reopened.repo, orphanOids);
    }
  });
  it("rolls back every retained rebase output overflow and can discard stderr", async () => {
    const control = await conflictedBackend();
    const controlLooseBefore = looseOids(control.repo);
    const controlResult = await runner(control.context).runCli({
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
    for (const ceiling of ceilings) {
      const exact = await conflictedBackend();
      expect(
        await runner(exact.context).runCli(
          { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
          ceiling.exact,
        ),
      ).toEqual(controlResult);
      const overflow = await conflictedBackend();
      const before = repositoryState(overflow.context, overflow.repo);
      await expectE2Big(
        async () =>
          await runner(overflow.context).runCli(
            { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
            ceiling.firstExcess,
          ),
      );
      expectObjectsAbsent(overflow.repo, orphanOids);
      const reopened = overflow.reopen();
      expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
      expectObjectsAbsent(reopened.repo, orphanOids);
    }
    const discarded = await conflictedBackend();
    const discardedResult = await runner(discarded.context).runCli(
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
      truncated: false,
    });
    for (const options of [
      { maxStdoutBytes: stdoutBytes - 1, discardStderr: true },
      { maxCombinedOutputBytes: stdoutBytes - 1, discardStderr: true },
    ]) {
      const overflow = await conflictedBackend();
      const before = repositoryState(overflow.context, overflow.repo);
      await expectE2Big(
        async () =>
          await runner(overflow.context).runCli(
            { argv: ["rebase", "--continue"], env: IDENTITY_ENV },
            options,
          ),
      );
      expectObjectsAbsent(overflow.repo, orphanOids);
      const reopened = overflow.reopen();
      expect(repositoryState(reopened.context, reopened.repo)).toEqual(before);
      expectObjectsAbsent(reopened.repo, orphanOids);
    }
  });
  it("keeps rejected mutating argv non-mutating", async () => {
    const target = await conflictedNative(false);
    const native = runner(target.workspace.context);
    const before = repositoryState(target.workspace.context, target.repo);
    for (const argv of [
      ["add", "--all", "file"],
      ["commit", "-m"],
      ["rebase", "--onto", "main"],
    ]) {
      expect((await native.runCli({ argv, env: IDENTITY_ENV })).exitCode).toBe(129);
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
    await expect(runner(context).runCli({ argv: ["rebase", "--abort"] })).rejects.toThrowError(
      /share one database/,
    );
    expect(repositoryState(target.workspace.context, target.repo)).toEqual(before);
  });
});
