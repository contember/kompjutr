import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGitCli } from "../src/git/cli/index.js";
import { createGitCliReadHandlers } from "../src/git/cli/read.js";
import type { GitCliResult } from "../src/git/cli/types.js";
import { createGit } from "../src/git/client.js";
import { checkoutTree } from "../src/git/ops/checkout.js";
import { commit } from "../src/git/ops/commit.js";
import { openRepository } from "../src/git/ops/context.js";
import {
  diff as coreDiff,
  DIFF_COMBINED_MAX_LINES,
  DIFF_COMBINED_MAX_MEMORY_BYTES,
  DIFF_MAX_OUTPUT_BYTES,
  diffHeaderPath,
} from "../src/git/ops/diff.js";
import { rebase } from "../src/git/ops/rebase.js";
import { add } from "../src/git/ops/staging.js";
import { hashWorktreePath, indexEntryFor } from "../src/git/ops/worktree-io.js";
import { fetchHttpClient } from "../src/git/protocol/transport.js";
import type { IndexEntry } from "../src/git/store/index.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { importFixture } from "./helpers/import.js";
import {
  makeRepo,
  makeWorkspace,
  type TestRepository,
  writeWorkFile,
} from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];
const ENCODER = new TextEncoder();
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});
function nativeRun(
  workspace: TestRepository,
  argv: string[],
  cwd = "/repo",
): Promise<GitCliResult> {
  return runGitCli({ argv, cwd }, createGitCliReadHandlers(workspace.context));
}
function gitBytesAt(fixture: GitFixture, cwd: string, argv: string[]): string {
  return execFileSync("git", argv, {
    cwd: join(fixture.dir, cwd),
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      LC_ALL: "C",
    },
    encoding: "utf8",
  });
}
function gitResultAt(fixture: GitFixture, argv: string[], cwd = ""): GitCliResult {
  const result = spawnSync("git", argv, {
    cwd: join(fixture.dir, cwd),
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      LC_ALL: "C",
    },
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === null) throw new Error(`git terminated by signal ${result.signal}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    truncated: false,
  };
}
async function importAt(fixture: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/repo");
  await importFixture(fixture, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  return workspace;
}
function conflictIndexEntry(stage: 2 | 3, oid: string, path = "conflict.txt"): IndexEntry {
  return {
    path,
    stage,
    mode: 0o100644,
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}
function setSyntheticConflict(
  workspace: TestRepository,
  first: string,
  second: string,
  result: string,
): void {
  setSyntheticConflictBytes(
    workspace,
    ENCODER.encode(first),
    ENCODER.encode(second),
    ENCODER.encode(result),
  );
}
function setSyntheticConflictBytes(
  workspace: TestRepository,
  first: Uint8Array,
  second: Uint8Array,
  result: Uint8Array,
): void {
  const firstOid = workspace.repo.store.write("blob", first);
  const secondOid = workspace.repo.store.write("blob", second);
  workspace.repo.checkout.indexReplace([
    conflictIndexEntry(2, firstOid),
    conflictIndexEntry(3, secondOid),
  ]);
  workspace.worktree.writeFiles([{ path: "/repo/conflict.txt", bytes: result, mode: 0o644 }]);
}
function syntheticCombinedDiff(workspace: TestRepository, maxOutputBytes?: number): string {
  const formatOptions =
    maxOutputBytes === undefined ? { indexBase: true } : { indexBase: true, maxOutputBytes };
  return coreDiff(workspace.repo, workspace.worktree, {}, undefined, formatOptions);
}
async function createRebaseConflict(
  upstreamText: string,
  currentText: string,
): Promise<{
  fixture: GitFixture;
  workspace: TestRepository;
}> {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("conflict.txt", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "upstream", base);
  fixture.write("conflict.txt", upstreamText);
  const upstream = fixture.commit("upstream");
  fixture.git("checkout", "-q", "-b", "current", base);
  fixture.write("conflict.txt", currentText);
  fixture.commit("current");
  const workspace = await importAt(fixture);
  expect(gitResultAt(fixture, ["rebase", "upstream"]).exitCode).toBe(1);
  expect(
    rebase(workspace.context, workspace.repo, workspace.worktree, {
      upstream,
      committer: { name: "Fixture", email: "fixture@example.com" },
    }).outcome,
  ).toBe("conflicted");
  return { fixture, workspace };
}
describe("read-only git argv handlers", () => {
  let fixture: GitFixture;
  let workspace: TestRepository;
  let base: string;
  beforeAll(async () => {
    fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("src/žluťoučký.txt", "first\n");
    fixture.git("add", "-A");
    fixture.gitWithEnv(
      {
        GIT_AUTHOR_NAME: "Žofie",
        GIT_AUTHOR_EMAIL: "zofie@example.com",
        GIT_COMMITTER_NAME: "Žofie",
        GIT_COMMITTER_EMAIL: "zofie@example.com",
      },
      "commit",
      "-q",
      "-m",
      "první\n\nbody",
    );
    base = fixture.git("rev-parse", "HEAD");
    fixture.git("tag", "base");
    fixture.write("second.txt", "second\n").commit("second");
    fixture.write("third.txt", "third\n").commit("third");
    workspace = await importAt(fixture);
  });
  it("matches clean and dirty status plus diff from root and nested cwd", async () => {
    expect((await nativeRun(workspace, ["status", "--porcelain"])).stdout).toBe(
      fixture.gitBinary("status", "--porcelain").toString("utf8"),
    );
    fixture.write("src/žluťoučký.txt", "changed\n");
    fixture.write("src/untracked.txt", "new\n");
    writeWorkFile(workspace, "/repo/src/žluťoučký.txt", "changed\n");
    writeWorkFile(workspace, "/repo/src/untracked.txt", "new\n");
    expect(await nativeRun(workspace, ["diff"], "/repo/src")).toEqual({
      stdout: fixture.gitBinary("diff").toString("utf8"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    fixture.git("config", "core.quotePath", "false");
    workspace.repo.store.configSet("core.quotePath", "false");
    expect((await nativeRun(workspace, ["diff"])).stdout).toBe(
      fixture.gitBinary("diff").toString("utf8"),
    );
  });
  it("matches default, oneline, template and admitted linear-range logs", async () => {
    for (const argv of [
      ["log"],
      ["log", "-n", "2", "--oneline"],
      ["log", "--format=%H|%h|%P|%s|%B|%an|%ae|%at|%cn|%ce|%ct|%n|%%"],
      ["log", "--oneline", "base..HEAD"],
    ]) {
      expect(await nativeRun(workspace, argv)).toEqual({
        stdout: fixture.gitBinary(...argv).toString("utf8"),
        stderr: "",
        exitCode: 0,
        truncated: false,
      });
    }
  });
  it("matches show patches and first-parent/path-selected history", async () => {
    for (const argv of [
      ["show"],
      ["show", "base"],
      ["show", "--first-parent", "base"],
      ["log", "--first-parent", "--format=%H"],
      ["log", "-n", "1", "--format=%H", "--", "second.txt"],
    ]) {
      expect(await nativeRun(workspace, argv), argv.join(" ")).toEqual(gitResultAt(fixture, argv));
    }
    const nestedArgv = ["log", "--format=%H", "--", "žluťoučký.txt"];
    expect(await nativeRun(workspace, nestedArgv, "/repo/src")).toEqual({
      stdout: gitBytesAt(fixture, "src", nestedArgv),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
  });
  it("requires an explicit first parent for a merge show", async () => {
    const merged = new GitFixture().init();
    fixtures.push(merged);
    merged.write("base.txt", "base\n").commit("base");
    merged.git("checkout", "-q", "-b", "side");
    merged.write("side.txt", "side\n").commit("side");
    merged.git("checkout", "-q", "main");
    merged.write("main.txt", "main\n").commit("main");
    merged.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const target = await importAt(merged);

    expect(await nativeRun(target, ["show", "--first-parent"])).toEqual(
      gitResultAt(merged, ["show", "--first-parent"]),
    );
    expect(await nativeRun(target, ["show"])).toEqual({
      stdout: "",
      stderr: "fatal: merge show requires --first-parent\n",
      exitCode: 128,
      truncated: false,
    });
  });
  it("matches rev-list count and symbolic-ref from a nested cwd", async () => {
    expect(await nativeRun(workspace, ["rev-list", "--count", "base..HEAD"], "/repo/src")).toEqual({
      stdout: gitBytesAt(fixture, "src", ["rev-list", "--count", "base..HEAD"]),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    expect(await nativeRun(workspace, ["symbolic-ref", "--short", "HEAD"], "/repo/src")).toEqual({
      stdout: gitBytesAt(fixture, "src", ["symbolic-ref", "--short", "HEAD"]),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
  });
  it("returns exact unborn, missing-revision and detached-ref failures", async () => {
    const unborn = makeRepo("/repo");
    expect(await nativeRun(unborn, ["log"])).toEqual({
      stdout: "",
      stderr: "fatal: your current branch 'main' does not have any commits yet\n",
      exitCode: 128,
      truncated: false,
    });
    expect(await nativeRun(workspace, ["log", "missing"])).toEqual({
      stdout: "",
      stderr:
        "fatal: ambiguous argument 'missing': unknown revision or path not in the working tree.\n" +
        "Use '--' to separate paths from revisions, like this:\n" +
        "'git <command> [<revision>...] -- [<file>...]'\n",
      exitCode: 128,
      truncated: false,
    });
    workspace.repo.checkout.setHead(workspace.repo.revParse("HEAD"));
    fixture.git("checkout", "--detach", "-q");
    expect((await nativeRun(workspace, ["log", "-1"])).stdout).toBe(
      fixture.gitBinary("log", "-1").toString("utf8"),
    );
    expect(await nativeRun(workspace, ["symbolic-ref", "--short", "HEAD"])).toEqual({
      stdout: "",
      stderr: "fatal: ref HEAD is not a symbolic ref\n",
      exitCode: 128,
      truncated: false,
    });
  });
  it("does not return a discarded huge read diagnostic", async () => {
    const target = makeRepo("/repo");
    const ref = `not-a-ref-${"x".repeat(2 * 1024 * 1024)}`;
    const handlers = createGitCliReadHandlers(target.context);
    const input = { argv: ["symbolic-ref", "--short", ref], cwd: "/repo" };
    expect(
      await runGitCli(input, handlers, {
        discardStderr: true,
        maxStdoutBytes: 0,
        maxStderrBytes: 0,
        maxCombinedOutputBytes: 0,
      }),
    ).toEqual({ stdout: "", stderr: "", exitCode: 128, truncated: false });
    await expect(
      runGitCli(input, handlers, { maxStderrBytes: 1, maxCombinedOutputBytes: 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
  it("preflights stdout bounds without a partial result", async () => {
    const handlers = createGitCliReadHandlers(workspace.context);
    for (const argv of [
      ["log", "-1", "--oneline"],
      ["show", "base"],
    ]) {
      const expected = fixture.gitBinary(...argv).toString("utf8");
      const bytes = ENCODER.encode(expected).byteLength;
      expect(await runGitCli({ argv, cwd: "/repo" }, handlers, { maxStdoutBytes: bytes })).toEqual({
        stdout: expected,
        stderr: "",
        exitCode: 0,
        truncated: false,
      });
      await expect(
        runGitCli({ argv, cwd: "/repo" }, handlers, { maxStdoutBytes: bytes - 1 }),
      ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    }
  });
  it("preflights a lower status ceiling before constructing its complete output", async () => {
    const target = makeRepo("/repo");
    writeWorkFile(target, "/repo/untracked.txt", "content\n");
    const handlers = createGitCliReadHandlers(target.context);
    const expected = "?? untracked.txt\n";
    const bytes = ENCODER.encode(expected).byteLength;
    expect(
      await runGitCli({ argv: ["status", "--porcelain"], cwd: "/repo" }, handlers, {
        maxStdoutBytes: bytes,
        maxCombinedOutputBytes: bytes,
      }),
    ).toEqual({ stdout: expected, stderr: "", exitCode: 0, truncated: false });
    await expect(
      runGitCli({ argv: ["status", "--porcelain"], cwd: "/repo" }, handlers, {
        maxStdoutBytes: bytes - 1,
        maxCombinedOutputBytes: bytes - 1,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "E2BIG",
        message: `git CLI status output exceeds ${bytes - 1} bytes`,
      }),
    );
  });
  it("rejects large subject and message output at the configured byte ceiling", async () => {
    const target = makeRepo("/repo");
    const message = `${"large subject ".repeat(16 * 1024)}\n\n${"large body ".repeat(16 * 1024)}`;
    const identity = { name: "Large Message", email: "large@example.test" };
    commit(target.context, target.repo, {
      message,
      author: identity,
      committer: identity,
      allowEmpty: true,
    });
    const handlers = createGitCliReadHandlers(target.context);
    for (const format of ["%s", "%B"]) {
      await expect(
        runGitCli({ argv: ["log", "-1", `--format=${format}`], cwd: "/repo" }, handlers, {
          maxStdoutBytes: 1,
          maxCombinedOutputBytes: 1,
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    }
  });
  it("proves a linear range with one bounded indexed graph read", async () => {
    workspace.repo.checkout.setHead(fixture.git("rev-parse", "HEAD"));
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    expect((await nativeRun(workspace, ["log", "--oneline", `${base}..HEAD`])).exitCode).toBe(0);
    expect(
      [...workspace.storage.histogram].filter(([query]) =>
        query.startsWith("WITH RECURSIVE params(repo_id, root_oid"),
      ),
    ).toEqual([[expect.any(String), 1]]);
    expect(workspace.storage.statementCount).toBeLessThan(1000);
  });
});
describe("everyday read argv parity", () => {
  async function everydayFixture(): Promise<{
    fixture: GitFixture;
    workspace: TestRepository;
  }> {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write(".gitignore", "ignored.txt\n");
    fixture.write("root.txt", "root\n");
    fixture.write("nested/tracked.txt", "tracked\n");
    fixture.commit("base");
    fixture.git("branch", "side");
    const workspace = await importAt(fixture);
    fixture.write("root.txt", "changed\n");
    fixture.write("nested/untracked.txt", "untracked\n");
    fixture.write("ignored.txt", "ignored\n");
    writeWorkFile(workspace, "/repo/root.txt", "changed\n");
    writeWorkFile(workspace, "/repo/nested/untracked.txt", "untracked\n");
    writeWorkFile(workspace, "/repo/ignored.txt", "ignored\n");
    return { fixture, workspace };
  }

  it("matches every admitted status form, branch read, revision read, and ls-files selection", async () => {
    const { fixture, workspace } = await everydayFixture();
    const rootCommands = [
      ["status"],
      ["status", "--short"],
      ["status", "--porcelain=v1", "--branch"],
      ["status", "--porcelain=v2", "--branch"],
      ["status", "--short", "--", "root.txt"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--verify", "HEAD^0"],
      ["rev-parse", "--quiet", "--verify", "HEAD"],
      ["rev-parse", "--show-toplevel"],
      ["branch", "--show-current"],
      ["branch", "--list"],
      ["ls-files"],
      ["ls-files", "--cached"],
      ["ls-files", "--others"],
      ["ls-files", "--others", "--exclude-standard"],
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      ["ls-files", "--cached", "--", "nested"],
    ];
    for (const argv of rootCommands) {
      const gitExpected = gitResultAt(fixture, argv);
      const expected =
        argv[1] === "--show-toplevel" ? { ...gitExpected, stdout: "/repo\n" } : gitExpected;
      expect(await nativeRun(workspace, argv), argv.join(" ")).toEqual(expected);
    }

    const nestedCommands = [
      ["status"],
      ["status", "--short"],
      ["status", "--porcelain=v2", "--branch", "--", "../root.txt", "."],
      ["ls-files"],
      ["ls-files", "--others", "--exclude-standard"],
      ["ls-files", "--cached", "--", "../root.txt", "."],
    ];
    for (const argv of nestedCommands) {
      expect(await nativeRun(workspace, argv, "/repo/nested"), argv.join(" ")).toEqual(
        gitResultAt(fixture, argv, "nested"),
      );
    }
  });

  it("matches unborn and detached HEAD results, missing revisions, and no matches", async () => {
    const unbornFixture = new GitFixture().init();
    fixtures.push(unbornFixture);
    const unborn = makeRepo("/repo");
    for (const argv of [
      ["status"],
      ["status", "--short", "--branch"],
      ["status", "--porcelain=v2", "--branch"],
      ["branch", "--show-current"],
      ["branch", "--list"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--verify", "HEAD"],
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      ["ls-files", "--cached", "--", "missing"],
    ]) {
      expect(await nativeRun(unborn, argv), `unborn: ${argv.join(" ")}`).toEqual(
        gitResultAt(unbornFixture, argv),
      );
    }

    const { fixture, workspace } = await everydayFixture();
    const oid = fixture.git("rev-parse", "HEAD");
    fixture.git("checkout", "--detach", "-q");
    workspace.repo.checkout.setHead(oid);
    for (const argv of [
      ["status"],
      ["status", "--short", "--branch"],
      ["status", "--porcelain=v2", "--branch"],
      ["branch", "--show-current"],
      ["branch", "--list"],
    ]) {
      expect(await nativeRun(workspace, argv), `detached: ${argv.join(" ")}`).toEqual(
        gitResultAt(fixture, argv),
      );
    }
  });

  it("matches optionless status for staged additions, edits, deletions, and renames", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("deleted.txt", "delete\n");
    fixture.write("modified.txt", "before\n");
    fixture.write("renamed.txt", "rename\n");
    fixture.commit("base");
    const workspace = await importAt(fixture);

    fixture.remove("deleted.txt");
    fixture.write("modified.txt", "after\n");
    fixture.write("added.txt", "add\n");
    fixture.git("mv", "renamed.txt", "moved.txt");
    fixture.git("add", "-A");
    workspace.worktree.removeFiles(["/repo/deleted.txt"]);
    workspace.worktree.rename("/repo/renamed.txt", "/repo/moved.txt");
    writeWorkFile(workspace, "/repo/modified.txt", "after\n");
    writeWorkFile(workspace, "/repo/added.txt", "add\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true }, workspace.context);

    expect(await nativeRun(workspace, ["status"])).toEqual(gitResultAt(fixture, ["status"]));
  });

  it("matches exact and first-excess output ceilings for each read family", async () => {
    const { fixture, workspace } = await everydayFixture();
    const handlers = createGitCliReadHandlers(workspace.context);
    for (const argv of [
      ["status"],
      ["status", "--porcelain=v2", "--branch"],
      ["rev-parse", "HEAD"],
      ["branch", "--list"],
      ["ls-files", "--cached", "--others", "--exclude-standard"],
    ]) {
      const expected = gitResultAt(fixture, argv);
      const bytes = ENCODER.encode(expected.stdout).byteLength;
      expect(
        await runGitCli({ argv, cwd: "/repo" }, handlers, {
          maxStdoutBytes: bytes,
          maxCombinedOutputBytes: bytes,
        }),
        argv.join(" "),
      ).toEqual(expected);
      await expect(
        runGitCli({ argv, cwd: "/repo" }, handlers, {
          maxStdoutBytes: bytes - 1,
          maxCombinedOutputBytes: bytes - 1,
        }),
      ).rejects.toMatchObject({ code: "E2BIG" });
    }
  });

  it("matches Git's exact malformed verification and status-option results", async () => {
    const { fixture, workspace } = await everydayFixture();
    for (const argv of [
      ["rev-parse", "--verify"],
      ["status", "--definitely-unknown"],
      ["branch", "--definitely-unknown"],
      ["ls-files", "--definitely-unknown"],
    ]) {
      expect(await nativeRun(workspace, argv)).toEqual(gitResultAt(fixture, argv));
    }
  });
});
describe("git diff header path quoting", () => {
  it("matches Git C quoting for UTF-8 and control bytes", () => {
    const path = 'é\t"\\.txt';
    expect(diffHeaderPath(path, "a/", { quotePaths: true })).toBe('"a/\\303\\251\\t\\"\\\\.txt"');
    expect(diffHeaderPath(path, "b/", { quotePaths: true, quoteNonAscii: false })).toBe(
      '"b/é\\t\\"\\\\.txt"',
    );
    expect(diffHeaderPath("plain name.txt", "a/", { quotePaths: true })).toBe("a/plain name.txt");
  });
  it("quotes paths beyond the former 2,200-byte boundary and rejects malformed paths", () => {
    const exact = "é".repeat(1100);
    expect(diffHeaderPath(exact, "a/", { quotePaths: true })).toHaveLength(8804);
    expect(diffHeaderPath(`${exact}x`, "a/", { quotePaths: true })).toHaveLength(8805);
    for (const path of ["nul\0path", "high\ud800path", "low\udc00path"]) {
      expect(() => diffHeaderPath(path, "a/", { quotePaths: true })).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });
  it("quotes every special-character rename header position like Git", async () => {
    const source = 'old-ž\t"\\.txt';
    const destination = 'new-ě\t"\\.txt';
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write(source, "rename\n").commit("base");
    const workspace = await importAt(fixture);
    fixture.git("mv", "--", source, destination);
    workspace.worktree.rename(`/repo/${source}`, `/repo/${destination}`);
    workspace.repo.checkout.indexRemove(source);
    const renamed = hashWorktreePath(workspace.repo, workspace.worktree, destination);
    if (renamed === null) throw new Error("renamed path disappeared");
    workspace.repo.checkout.indexPut(indexEntryFor(destination, renamed));
    expect(
      coreDiff(workspace.repo, workspace.worktree, { renames: true }, undefined, {
        quotePaths: true,
      }),
    ).toBe(fixture.gitBinary("diff", "--find-renames", "HEAD").toString("utf8"));
  });
});
describe("plain git diff semantics and cumulative bounds", () => {
  it("compares the index to the worktree for staged-only and mixed changes", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("file.txt", "base\n").commit("base");
    const workspace = await importAt(fixture);
    workspace.tick(1000);
    fixture.write("file.txt", "staged\n");
    fixture.git("add", "file.txt");
    writeWorkFile(workspace, "/repo/file.txt", "staged\n");
    add(workspace.repo, workspace.worktree, { paths: ["file.txt"] }, workspace.context);
    expect(await nativeRun(workspace, ["diff"])).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    workspace.tick(1000);
    fixture.write("file.txt", "unstaged\n");
    writeWorkFile(workspace, "/repo/file.txt", "unstaged\n");
    expect(await nativeRun(workspace, ["diff"])).toEqual({
      stdout: fixture.gitBinary("diff").toString("utf8"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
  });
  it("accepts the exact cumulative multi-file byte limit and rejects first excess", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    for (let index = 0; index < 16; index++) fixture.write(`f-${index}.txt`, "before\n");
    fixture.commit("base");
    const workspace = await importAt(fixture);
    workspace.tick(1000);
    for (let index = 0; index < 16; index++) {
      fixture.write(`f-${index}.txt`, `after ${index}\n`);
      writeWorkFile(workspace, `/repo/f-${index}.txt`, `after ${index}\n`);
    }
    const expected = fixture.gitBinary("diff").toString("utf8");
    const bytes = ENCODER.encode(expected).byteLength;
    const handlers = createGitCliReadHandlers(workspace.context);
    expect(
      await runGitCli({ argv: ["diff"], cwd: "/repo" }, handlers, { maxStdoutBytes: bytes }),
    ).toEqual({ stdout: expected, stderr: "", exitCode: 0, truncated: false });
    await expect(
      runGitCli({ argv: ["diff"], cwd: "/repo" }, handlers, { maxStdoutBytes: bytes - 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
  it("matches staged aliases, refs, paths, two refs, and joined context", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("root.txt", "root base\n");
    fixture.write("src/file.txt", "line 1\nline 2\nline 3\n");
    fixture.commit("base");
    fixture.git("tag", "base");
    fixture.write("root.txt", "root committed\n");
    fixture.write("src/file.txt", "line 1\ncommitted\nline 3\n");
    fixture.commit("second");
    const workspace = await importAt(fixture);

    for (const argv of [
      ["diff", "base"],
      ["diff", "base", "HEAD"],
      ["diff", "-U0", "base", "HEAD", "--", "src"],
    ]) {
      expect(await nativeRun(workspace, argv)).toEqual(gitResultAt(fixture, argv));
    }

    workspace.tick(1000);
    fixture.write("src/file.txt", "line 1\nstaged\nline 3\n");
    fixture.git("add", "src/file.txt");
    writeWorkFile(workspace, "/repo/src/file.txt", "line 1\nstaged\nline 3\n");
    add(workspace.repo, workspace.worktree, { paths: ["src/file.txt"] }, workspace.context);
    workspace.tick(1000);
    fixture.write("src/file.txt", "line 1\nunstaged\nline 3\n");
    writeWorkFile(workspace, "/repo/src/file.txt", "line 1\nunstaged\nline 3\n");
    for (const argv of [
      ["diff", "--cached"],
      ["diff", "--staged", "base"],
      ["diff", "-U0", "--cached", "--", "src/file.txt"],
    ]) {
      expect(await nativeRun(workspace, argv)).toEqual(gitResultAt(fixture, argv));
    }
    expect(await nativeRun(workspace, ["diff", "--cached", "--", "file.txt"], "/repo/src")).toEqual(
      gitResultAt(fixture, ["diff", "--cached", "--", "src/file.txt"]),
    );
  });
  it("preflights staged output at the exact configured byte ceiling", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("file.txt", "base\n").commit("base");
    const workspace = await importAt(fixture);
    fixture.write("file.txt", "staged\n");
    fixture.git("add", "file.txt");
    writeWorkFile(workspace, "/repo/file.txt", "staged\n");
    add(workspace.repo, workspace.worktree, { paths: ["file.txt"] }, workspace.context);
    const argv = ["diff", "--cached"];
    const expected = fixture.gitBinary(...argv).toString("utf8");
    const bytes = ENCODER.encode(expected).byteLength;
    const handlers = createGitCliReadHandlers(workspace.context);

    expect(await runGitCli({ argv, cwd: "/repo" }, handlers, { maxStdoutBytes: bytes })).toEqual({
      stdout: expected,
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await expect(
      runGitCli({ argv, cwd: "/repo" }, handlers, { maxStdoutBytes: bytes - 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
  it("hydrates only selected historical blobs for staged CLI diff", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("selected.txt", "selected old\n");
    fixture.write("unselected.txt", "unselected old\n");
    const first = fixture.commit("first");
    const selectedBlob = fixture.git("rev-parse", `${first}:selected.txt`);
    const unselectedBlob = fixture.git("rev-parse", `${first}:unselected.txt`);
    fixture.write("selected.txt", "selected current\n");
    fixture.remove("unselected.txt");
    fixture.write("current.txt", "current\n");
    fixture.commit("second");
    fixture.git("config", "uploadpack.allowFilter", "true");
    const server = await startGitServer(fixture.dir);
    const target = makeWorkspace();
    const git = createGit()({ ...target.context, http: fetchHttpClient });
    try {
      await git.clone({ url: server.url, dir: "/repo", filter: "blob:none" });
      const repo = openRepository(target.context, "/repo");
      expect(repo.has(selectedBlob)).toBe(false);
      expect(repo.has(unselectedBlob)).toBe(false);
      const requestsBeforeDiff = server.requests.length;

      const argv = ["diff", "--cached", first, "--", "selected.txt"];
      expect(await git.runCli({ argv, cwd: "/repo" })).toEqual(gitResultAt(fixture, argv));
      expect(repo.has(selectedBlob)).toBe(true);
      expect(repo.has(unselectedBlob)).toBe(false);
      expect(server.requests.slice(requestsBeforeDiff).map((request) => request.method)).toEqual([
        "GET",
        "POST",
      ]);
    } finally {
      await server.close();
    }
  });
  it("hydrates show patch blobs while path log leaves unrelated promises intact", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("selected.txt", "selected old\n");
    fixture.write("unrelated.txt", "unrelated\n");
    fixture.commit("first");
    fixture.write("selected.txt", "selected current\n");
    const second = fixture.commit("second");
    const selectedOld = fixture.git("rev-parse", `${second}^:selected.txt`);
    const unrelated = fixture.git("rev-parse", `${second}:unrelated.txt`);
    fixture.remove("unrelated.txt");
    fixture.commit("third");
    fixture.git("config", "uploadpack.allowFilter", "true");
    const server = await startGitServer(fixture.dir);
    const target = makeWorkspace();
    const git = createGit()({ ...target.context, http: fetchHttpClient });
    try {
      await git.clone({ url: server.url, dir: "/repo", filter: "blob:none" });
      const repo = openRepository(target.context, "/repo");
      expect(repo.has(selectedOld)).toBe(false);
      expect(repo.has(unrelated)).toBe(false);

      const requestsBeforeShow = server.requests.length;
      const shown = await git.show({ dir: "/repo", ref: second, patch: true });
      expect(shown.patch?.trimEnd()).toBe(fixture.git("show", "--format=", second));
      expect(repo.has(selectedOld)).toBe(true);
      expect(repo.has(unrelated)).toBe(false);
      expect(server.requests.slice(requestsBeforeShow).map((request) => request.method)).toEqual([
        "GET",
        "POST",
      ]);

      expect(await git.runCli({ argv: ["show", second], cwd: "/repo" })).toEqual(
        gitResultAt(fixture, ["show", second]),
      );
      const requestsBeforeLog = server.requests.length;
      expect(
        await git.runCli({ argv: ["log", "--format=%H", "--", "selected.txt"], cwd: "/repo" }),
      ).toEqual(gitResultAt(fixture, ["log", "--format=%H", "--", "selected.txt"]));
      expect(server.requests).toHaveLength(requestsBeforeLog);
      expect(repo.has(unrelated)).toBe(false);
    } finally {
      await server.close();
    }
  });
  it("matches Git combined diff while a rebase conflict is unresolved", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("conflict.txt", "base\n");
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "upstream", base);
    fixture.write("conflict.txt", "upstream\n");
    const upstream = fixture.commit("upstream");
    fixture.git("checkout", "-q", "-b", "current", base);
    fixture.write("conflict.txt", "current\n");
    fixture.commit("current");
    const workspace = await importAt(fixture);
    expect(gitResultAt(fixture, ["rebase", "upstream"]).exitCode).toBe(1);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, {
        upstream,
        committer: { name: "Fixture", email: "fixture@example.com" },
      }).outcome,
    ).toBe("conflicted");
    expect(await nativeRun(workspace, ["diff"])).toEqual(gitResultAt(fixture, ["diff"]));
    for (const { stage, parent } of [
      { stage: 2, parent: "upstream\n" },
      { stage: 3, parent: "current\n" },
    ]) {
      expect(fixture.gitBinary("show", `:${stage}:conflict.txt`).toString("utf8")).toBe(parent);
      fixture.write("conflict.txt", parent);
      writeWorkFile(workspace, "/repo/conflict.txt", parent);
      const expected = gitResultAt(fixture, ["diff"]);
      expect(expected.stdout).not.toContain("@@@");
      expect(await nativeRun(workspace, ["diff"])).toEqual(expected);
    }
    fixture.write("conflict.txt", "upstream\n").chmod("conflict.txt", 0o755);
    writeWorkFile(workspace, "/repo/conflict.txt", "upstream\n", 0o755);
    const modeOnly = gitResultAt(fixture, ["diff"]);
    expect(modeOnly.stdout).toContain("mode 100644,100644..100755\n");
    expect(modeOnly.stdout).not.toContain("@@@");
    expect(await nativeRun(workspace, ["diff"])).toEqual(modeOnly);
    fixture.write("conflict.txt", "resolved\n").chmod("conflict.txt", 0o644);
    writeWorkFile(workspace, "/repo/conflict.txt", "resolved\n");
    expect(await nativeRun(workspace, ["diff"])).toEqual(gitResultAt(fixture, ["diff"]));
    fixture.remove("conflict.txt");
    workspace.worktree.removeFiles(["/repo/conflict.txt"]);
    expect(await nativeRun(workspace, ["diff"])).toEqual(gitResultAt(fixture, ["diff"]));
  });
  it("matches Git's unmerged fallback when either conflict side is absent", async () => {
    for (const upstreamDeletes of [false, true]) {
      const fixture = new GitFixture().init();
      fixtures.push(fixture);
      fixture.write("conflict.txt", "base\n");
      const base = fixture.commit("base");
      fixture.git("checkout", "-q", "-b", "upstream", base);
      if (upstreamDeletes) fixture.git("rm", "-q", "conflict.txt");
      else fixture.write("conflict.txt", "upstream\n");
      const upstream = fixture.commit("upstream");
      fixture.git("checkout", "-q", "-b", "current", base);
      if (upstreamDeletes) fixture.write("conflict.txt", "current\n");
      else fixture.git("rm", "-q", "conflict.txt");
      fixture.commit("current");
      const workspace = await importAt(fixture);
      expect(gitResultAt(fixture, ["rebase", "upstream"]).exitCode).toBe(1);
      expect(
        rebase(workspace.context, workspace.repo, workspace.worktree, {
          upstream,
          committer: { name: "Fixture", email: "fixture@example.com" },
        }).outcome,
      ).toBe("conflicted");
      expect(await nativeRun(workspace, ["diff"])).toEqual(gitResultAt(fixture, ["diff"]));
    }
  });
  it("matches Git combined rows when either parent or the result has no final LF", async () => {
    const cases = [
      { stageWithoutLf: 2, upstream: "upstream", current: "current\n", result: "resolved\n" },
      { stageWithoutLf: 3, upstream: "upstream\n", current: "current", result: "resolved\n" },
      { stageWithoutLf: null, upstream: "upstream\n", current: "current\n", result: "resolved" },
    ];
    for (const texts of cases) {
      const { fixture, workspace } = await createRebaseConflict(texts.upstream, texts.current);
      if (texts.stageWithoutLf !== null) {
        expect(
          fixture.gitBinary("show", `:${texts.stageWithoutLf}:conflict.txt`).toString("utf8"),
        ).not.toMatch(/\n$/);
      }
      fixture.write("conflict.txt", texts.result);
      writeWorkFile(workspace, "/repo/conflict.txt", texts.result);
      const expected = gitResultAt(fixture, ["diff"]);
      expect(expected.stdout).toContain("@@@");
      expect(expected.stdout).not.toContain("\\ No newline at end of file");
      expect(await nativeRun(workspace, ["diff"])).toEqual(expected);
    }
  });
  it("matches Git combined binary conflict output", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("conflict.bin", new Uint8Array([0, 1]));
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "upstream", base);
    fixture.write("conflict.bin", new Uint8Array([0, 2]));
    const upstream = fixture.commit("upstream");
    fixture.git("checkout", "-q", "-b", "current", base);
    fixture.write("conflict.bin", new Uint8Array([0, 3]));
    fixture.commit("current");
    const workspace = await importAt(fixture);
    expect(gitResultAt(fixture, ["rebase", "upstream"]).exitCode).toBe(1);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, {
        upstream,
        committer: { name: "Fixture", email: "fixture@example.com" },
      }).outcome,
    ).toBe("conflicted");
    for (const stage of [2, 3]) {
      const parent = fixture.gitBinary("show", `:${stage}:conflict.bin`);
      fixture.write("conflict.bin", parent);
      workspace.worktree.writeFiles([
        { path: "/repo/conflict.bin", bytes: new Uint8Array(parent), mode: 0o644 },
      ]);
      expect(fixture.git("hash-object", "conflict.bin")).toBe(
        fixture.git("rev-parse", `:${stage}:conflict.bin`),
      );
      const expected = gitResultAt(fixture, ["diff"]);
      expect(expected.stdout).toContain("Binary files differ\n");
      expect(await nativeRun(workspace, ["diff"])).toEqual(expected);
    }
  });
  it("matches Git combined hunk context for distant conflicts", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    fixture.write("conflict.txt", `${lines.join("\n")}\n`);
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "upstream", base);
    const upstreamLines = [...lines];
    upstreamLines[1] = "upstream one";
    upstreamLines[15] = "upstream fifteen";
    fixture.write("conflict.txt", `${upstreamLines.join("\n")}\n`);
    const upstream = fixture.commit("upstream");
    fixture.git("checkout", "-q", "-b", "current", base);
    const currentLines = [...lines];
    currentLines[1] = "current one";
    currentLines[15] = "current fifteen";
    fixture.write("conflict.txt", `${currentLines.join("\n")}\n`);
    fixture.commit("current");
    const workspace = await importAt(fixture);
    expect(gitResultAt(fixture, ["rebase", "upstream"]).exitCode).toBe(1);
    expect(
      rebase(workspace.context, workspace.repo, workspace.worktree, {
        upstream,
        committer: { name: "Fixture", email: "fixture@example.com" },
      }).outcome,
    ).toBe("conflicted");
    expect(await nativeRun(workspace, ["diff"])).toEqual(gitResultAt(fixture, ["diff"]));
  });
  it("routes text, header-only and binary combined output through one sink", () => {
    const workspace = makeRepo("/repo");
    const cases = [
      () => setSyntheticConflict(workspace, "first\n", "second\n", "resolved\n"),
      () => setSyntheticConflict(workspace, "first\n", "second\n", "first\n"),
      () =>
        setSyntheticConflictBytes(
          workspace,
          new Uint8Array([0, 1]),
          new Uint8Array([0, 2]),
          new Uint8Array([0, 3]),
        ),
    ];
    for (const prepare of cases) {
      prepare();
      const expected = syntheticCombinedDiff(workspace);
      const bytes = ENCODER.encode(expected).byteLength;
      expect(syntheticCombinedDiff(workspace, bytes)).toBe(expected);
      expect(() => syntheticCombinedDiff(workspace, bytes - 1)).toThrowError(
        expect.objectContaining({
          code: "E2BIG",
          message: `diff output exceeds ${bytes - 1} UTF-8 bytes`,
        }),
      );
    }
  });
  it("enforces the intrinsic combined output limit for the typed diff", () => {
    const workspace = makeRepo("/repo");
    const firstOid = workspace.repo.store.write("blob", ENCODER.encode("first\n"));
    const secondOid = workspace.repo.store.write("blob", ENCODER.encode("second\n"));
    const pathCount = 2522;
    const pathAt = (index: number): string => {
      const prefix = `p-${index.toString().padStart(4, "0")}-`;
      const length = index === pathCount - 1 ? 1649 : 2199;
      return `${prefix}${"x".repeat(length - prefix.length)}`;
    };
    workspace.repo.checkout.indexReplace(
      (function* (): Generator<IndexEntry> {
        for (let index = 0; index < pathCount; index++) {
          const path = pathAt(index);
          yield conflictIndexEntry(2, firstOid, path);
          yield conflictIndexEntry(3, secondOid, path);
        }
      })(),
    );
    const bytes = ENCODER.encode("first\n");
    for (let start = 0; start < pathCount; start += 100) {
      const end = Math.min(pathCount, start + 100);
      const entries = [];
      for (let index = start; index < end; index++) {
        entries.push({ path: `/repo/${pathAt(index)}`, bytes, mode: 0o644 });
      }
      workspace.worktree.writeFiles(entries);
    }
    expect(syntheticCombinedDiff(workspace)).toHaveLength(DIFF_MAX_OUTPUT_BYTES);
    const excessPath = "z.txt";
    workspace.repo.checkout.indexApply((sink) => {
      sink.put(conflictIndexEntry(2, firstOid, excessPath));
      sink.put(conflictIndexEntry(3, secondOid, excessPath));
    });
    workspace.worktree.writeFiles([
      { path: `/repo/${excessPath}`, bytes: ENCODER.encode("first\n"), mode: 0o644 },
    ]);
    expect(() => syntheticCombinedDiff(workspace)).toThrowError(
      expect.objectContaining({
        code: "E2BIG",
        message: `diff output exceeds ${DIFF_MAX_OUTPUT_BYTES} UTF-8 bytes`,
      }),
    );
  });
  it("preflights the exact combined line limit before allocating line arrays", () => {
    const workspace = makeRepo("/repo");
    const first = "\n".repeat(33333);
    const second = "\n".repeat(33333);
    setSyntheticConflict(workspace, first, second, "\n".repeat(33334));
    expect(() => syntheticCombinedDiff(workspace, 0)).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: "diff output exceeds 0 UTF-8 bytes" }),
    );
    expect(syntheticCombinedDiff(workspace, 1024 * 1024)).toContain("@@@");
    setSyntheticConflict(workspace, first, second, "\n".repeat(33335));
    expect(() => syntheticCombinedDiff(workspace)).toThrowError(
      expect.objectContaining({
        code: "E2BIG",
        message: `combined diff exceeds ${DIFF_COMBINED_MAX_LINES} lines`,
      }),
    );
  });
  it("takes the parent-equality fast path before combined renderer limits", () => {
    const workspace = makeRepo("/repo");
    const parent = "\n".repeat(DIFF_COMBINED_MAX_LINES + 1);
    setSyntheticConflict(workspace, parent, "different\n", parent);
    const output = syntheticCombinedDiff(workspace);
    expect(output).toContain("diff --cc conflict.txt\n");
    expect(output).not.toContain("@@@");
  });
  it("accepts the exact combined retained-memory estimate and rejects first excess", () => {
    const workspace = makeRepo("/repo");
    const firstLine = `${"a".repeat(127)}\n`;
    const secondLine = `${"b".repeat(127)}\n`;
    const resultLine = `${"c".repeat(127)}\n`;
    const exactLines = 8399;
    // 8,399 differing three-way lines cost 2,850 bytes each plus 43,170,816 fixed bytes.
    const exactEstimate = 67107966;
    expect(DIFF_COMBINED_MAX_MEMORY_BYTES - exactEstimate).toBe(898);
    setSyntheticConflict(
      workspace,
      firstLine.repeat(exactLines),
      secondLine.repeat(exactLines),
      resultLine.repeat(exactLines),
    );
    const exact = syntheticCombinedDiff(workspace);
    expect(exact).toContain("@@@");
    expect(exact.length).toBeGreaterThan(3 * 1024 * 1024);
    setSyntheticConflict(
      workspace,
      firstLine.repeat(exactLines + 1),
      secondLine.repeat(exactLines + 1),
      resultLine.repeat(exactLines + 1),
    );
    expect(() => syntheticCombinedDiff(workspace)).toThrowError(
      expect.objectContaining({
        code: "E2BIG",
        message: `combined diff retained memory exceeds ${DIFF_COMBINED_MAX_MEMORY_BYTES} bytes`,
      }),
    );
  });
  it("continues index-worktree diff after the former 100,000-row scan ceiling", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("z-tracked.txt", "tracked\n").commit("base");
    const workspace = await importAt(fixture);
    const untracked = 99999;
    workspace.storage.db.exec(`
      WITH RECURSIVE sequence(i) AS (
        VALUES (0) UNION ALL SELECT i + 1 FROM sequence WHERE i + 1 < ${untracked}
      )
      INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
      SELECT 2000000 + i, 'file', 420, 1577836800000, 0, 1, 1 FROM sequence;
      WITH RECURSIVE sequence(i) AS (
        VALUES (0) UNION ALL SELECT i + 1 FROM sequence WHERE i + 1 < ${untracked}
      )
      INSERT INTO fs_paths (path, parent, inode)
      SELECT printf('/repo/u-%06d.txt', i), '/repo', 2000000 + i FROM sequence;
    `);
    expect(await nativeRun(workspace, ["diff"])).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    workspace.storage.db.exec(`
      INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
      VALUES (2100000, 'file', 420, 1577836800000, 0, 1, 1);
      INSERT INTO fs_paths (path, parent, inode)
      VALUES ('/repo/u-999999.txt', '/repo', 2100000);
    `);
    expect(await nativeRun(workspace, ["diff"])).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
  });
});
describe("recursive symbolic-ref reads", () => {
  it("matches recursive, dangling and cyclic Git symrefs", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("file.txt", "base\n");
    fixture.commit("base");
    const workspace = await importAt(fixture);
    fixture.git("symbolic-ref", "refs/alias", "refs/heads/main");
    fixture.git("symbolic-ref", "HEAD", "refs/alias");
    workspace.repo.store.setRef("refs/alias", "ref: refs/heads/main");
    workspace.repo.checkout.setHead("ref: refs/alias");
    expect(await nativeRun(workspace, ["symbolic-ref", "--short", "HEAD"])).toEqual(
      gitResultAt(fixture, ["symbolic-ref", "--short", "HEAD"]),
    );
    fixture.git("symbolic-ref", "refs/alias", "refs/heads/missing");
    workspace.repo.store.setRef("refs/alias", "ref: refs/heads/missing");
    expect(await nativeRun(workspace, ["symbolic-ref", "--short", "HEAD"])).toEqual(
      gitResultAt(fixture, ["symbolic-ref", "--short", "HEAD"]),
    );
    fixture.git("symbolic-ref", "refs/a", "refs/b");
    fixture.git("symbolic-ref", "refs/b", "refs/a");
    fixture.git("symbolic-ref", "HEAD", "refs/a");
    workspace.repo.store.setRef("refs/a", "ref: refs/b");
    workspace.repo.store.setRef("refs/b", "ref: refs/a");
    workspace.repo.checkout.setHead("ref: refs/a");
    expect(await nativeRun(workspace, ["symbolic-ref", "--short", "HEAD"])).toEqual(
      gitResultAt(fixture, ["symbolic-ref", "--short", "HEAD"]),
    );
  });
});
describe("restricted log ranges", () => {
  it("rejects merge, divergent, unrelated and shallow-boundary graphs before output", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("base.txt", "base\n").commit("base");
    fixture.git("tag", "base");
    fixture.git("checkout", "-q", "-b", "side");
    fixture.write("side.txt", "side\n").commit("side");
    fixture.git("checkout", "-q", "main");
    fixture.write("main.txt", "main\n").commit("main");
    fixture.git("tag", "main-tip");
    fixture.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const workspace = await importAt(fixture);
    const failure = {
      stdout: "",
      stderr: "fatal: log range is not a complete single-parent chain\n",
      exitCode: 128,
      truncated: false,
    };
    expect(await nativeRun(workspace, ["log", "base..HEAD"])).toEqual(failure);
    expect(await nativeRun(workspace, ["log", "side..main-tip"])).toEqual(failure);
    expect(await nativeRun(workspace, ["log", "-n", "0", "base..HEAD"])).toEqual(failure);
    for (const range of ["side..HEAD", "main-tip..side"]) {
      expect(await nativeRun(workspace, ["rev-list", "--count", range])).toEqual({
        stdout: fixture.gitBinary("rev-list", "--count", range).toString("utf8"),
        stderr: "",
        exitCode: 0,
        truncated: false,
      });
    }
    const unrelated = new GitFixture().init();
    fixtures.push(unrelated);
    unrelated.write("other.txt", "other\n").commit("other");
    const otherOid = unrelated.git("rev-parse", "HEAD");
    workspace.repo.store.write("commit", unrelated.catFile(otherOid));
    workspace.repo.store.cacheCommit(otherOid, unrelated.catFile(otherOid));
    expect(await nativeRun(workspace, ["log", `${otherOid}..main-tip`])).toEqual(failure);
    const shallowBoundary = fixture.git("rev-parse", "main-tip");
    workspace.repo.store.setShallow([shallowBoundary]);
    expect(await nativeRun(workspace, ["log", `base..main-tip`])).toEqual(failure);
  });
});
