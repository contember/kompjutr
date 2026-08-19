import { afterAll, describe, expect, it } from "vitest";

import { checkoutTree } from "../src/core/ops/checkout.js";
import {
  clean,
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  status,
  statusMatrix,
} from "../src/core/ops/status.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import type { Worktree, WorktreeDirent, WorktreeStat } from "../src/core/worktree.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

/**
 * Every expectation here is checked against the real git binary: the same
 * working-tree states are built twice, once on disk for git and once
 * through DOFS for us, and the porcelain output is compared byte for byte.
 */

type Step =
  | { op: "write"; path: string; content: string; executable?: boolean }
  | { op: "chmod"; path: string; mode: number }
  | { op: "symlink"; path: string; target: string }
  | { op: "remove"; path: string }
  | { op: "stage"; path: string }
  | { op: "gitRemove"; path: string };

interface Scenario {
  name: string;
  /** One commit per entry, in order. */
  commits: Step[][];
  /** Applied after the last commit, to both sides. */
  mutate: Step[];
}

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function applyToFixture(fixture: GitFixture, step: Step): void {
  switch (step.op) {
    case "write":
      if (step.executable === true) fixture.writeExecutable(step.path, step.content);
      else fixture.write(step.path, step.content);
      return;
    case "chmod":
      fixture.chmod(step.path, step.mode);
      return;
    case "symlink":
      fixture.symlink(step.target, step.path);
      return;
    case "remove":
      fixture.remove(step.path);
      return;
    case "stage":
      fixture.git("add", "--", step.path);
      return;
    case "gitRemove":
      fixture.git("rm", "-q", "--", step.path);
      return;
  }
}

function applyToWorkspace(workspace: TestRepository, step: Step): void {
  const { repo, worktree } = workspace;
  const absolute = `/${step.path}`;
  switch (step.op) {
    case "write":
      writeWorkFile(workspace, absolute, step.content, step.executable === true ? 0o755 : 0o644);
      return;
    case "chmod":
      worktree.chmod(absolute, step.mode);
      return;
    case "symlink":
      worktree.unlink(absolute);
      worktree.symlink(step.target, absolute);
      return;
    case "remove":
      worktree.unlink(absolute);
      return;
    case "stage": {
      const hashed = hashWorktreePath(repo, worktree, step.path);
      if (hashed === null) throw new Error(`nothing to stage at ${step.path}`);
      repo.store.indexPut(indexEntryFor(step.path, hashed));
      return;
    }
    case "gitRemove":
      worktree.unlink(absolute);
      repo.store.indexRemove(step.path);
      return;
  }
}

async function build(scenario: Scenario): Promise<{
  fixture: GitFixture;
  workspace: TestRepository;
}> {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  for (const [index, steps] of scenario.commits.entries()) {
    for (const step of steps) applyToFixture(fixture, step);
    fixture.commit(`commit ${index}`);
  }

  const workspace = makeRepo("/");
  await importFixture(fixture, workspace.repo.store);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  // Move the clock on, so a later write of the same length still looks
  // newer than the stat data checkout recorded.
  workspace.tick(60_000);

  for (const step of scenario.mutate) {
    applyToFixture(fixture, step);
    applyToWorkspace(workspace, step);
  }
  return { fixture, workspace };
}

/** git's own output, untrimmed — trailing newlines are part of the check. */
function gitStatus(fixture: GitFixture, ...flags: string[]): string {
  return fixture.gitBinary("status", ...flags).toString("utf8");
}

const BASE: Step[] = [
  { op: "write", path: "base.txt", content: "base\n" },
  { op: "write", path: "keep.txt", content: "keep\n" },
  { op: "write", path: "src/nested.txt", content: "nested\n" },
];

const SCENARIOS: Scenario[] = [
  { name: "clean tree", commits: [BASE], mutate: [] },
  {
    name: "untracked file",
    commits: [BASE],
    mutate: [{ op: "write", path: "fresh.txt", content: "fresh\n" }],
  },
  {
    name: "untracked file inside a tracked directory",
    commits: [BASE],
    mutate: [{ op: "write", path: "src/fresh.txt", content: "fresh\n" }],
  },
  {
    name: "untracked directory",
    commits: [BASE],
    mutate: [
      { op: "write", path: "fresh/a.txt", content: "a\n" },
      { op: "write", path: "fresh/deeper/b.txt", content: "b\n" },
    ],
  },
  {
    name: "modified unstaged",
    commits: [BASE],
    mutate: [{ op: "write", path: "base.txt", content: "different\n" }],
  },
  {
    name: "modified unstaged, same length",
    commits: [BASE],
    mutate: [{ op: "write", path: "base.txt", content: "sase\n" }],
  },
  {
    name: "modified staged",
    commits: [BASE],
    mutate: [
      { op: "write", path: "base.txt", content: "staged\n" },
      { op: "stage", path: "base.txt" },
    ],
  },
  {
    name: "staged then re-modified",
    commits: [BASE],
    mutate: [
      { op: "write", path: "base.txt", content: "staged\n" },
      { op: "stage", path: "base.txt" },
      { op: "write", path: "base.txt", content: "and again\n" },
    ],
  },
  {
    name: "added",
    commits: [BASE],
    mutate: [
      { op: "write", path: "added.txt", content: "added\n" },
      { op: "stage", path: "added.txt" },
    ],
  },
  {
    name: "deleted from disk only",
    commits: [BASE],
    mutate: [{ op: "remove", path: "base.txt" }],
  },
  {
    name: "deleted and staged",
    commits: [BASE],
    mutate: [{ op: "gitRemove", path: "base.txt" }],
  },
  {
    name: "mode change 644 to 755",
    commits: [BASE],
    mutate: [{ op: "chmod", path: "base.txt", mode: 0o755 }],
  },
  {
    name: "symlink added",
    commits: [BASE],
    mutate: [
      { op: "symlink", path: "loose-link", target: "base.txt" },
      { op: "symlink", path: "staged-link", target: "keep.txt" },
      { op: "stage", path: "staged-link" },
    ],
  },
  {
    name: "symlink retargeted",
    commits: [[...BASE, { op: "symlink", path: "link", target: "base.txt" }]],
    mutate: [{ op: "symlink", path: "link", target: "keep.txt" }],
  },
  {
    name: "file replaced by directory",
    commits: [BASE],
    mutate: [
      { op: "remove", path: "base.txt" },
      { op: "write", path: "base.txt/inner.txt", content: "inner\n" },
    ],
  },
  {
    name: "ignored file",
    commits: [[...BASE, { op: "write", path: ".gitignore", content: "*.log\n" }]],
    mutate: [{ op: "write", path: "debug.log", content: "noise\n" }],
  },
  {
    name: "ignored directory",
    commits: [[...BASE, { op: "write", path: ".gitignore", content: "cache/\n" }]],
    mutate: [
      { op: "write", path: "cache/a.txt", content: "a\n" },
      { op: "write", path: "cache/deeper/b.txt", content: "b\n" },
    ],
  },
  {
    name: "untracked directory holding only ignored files",
    commits: [[...BASE, { op: "write", path: ".gitignore", content: "*.log\n" }]],
    mutate: [{ op: "write", path: "logs/a.log", content: "noise\n" }],
  },
  {
    name: "untracked directory holding an ignored file and a real one",
    commits: [[...BASE, { op: "write", path: ".gitignore", content: "*.log\n" }]],
    mutate: [
      { op: "write", path: "mixed/a.log", content: "noise\n" },
      { op: "write", path: "mixed/b.txt", content: "real\n" },
    ],
  },
  {
    name: "tracked file a later ignore rule would match",
    commits: [
      [...BASE, { op: "write", path: "tracked.log", content: "tracked\n" }],
      [{ op: "write", path: ".gitignore", content: "*.log\n" }],
    ],
    mutate: [{ op: "write", path: "tracked.log", content: "still tracked\n" }],
  },
  {
    name: "everything at once",
    commits: [
      [
        ...BASE,
        { op: "write", path: "tracked.log", content: "tracked\n" },
        { op: "symlink", path: "link", target: "base.txt" },
        { op: "write", path: "gone.txt", content: "gone\n" },
        { op: "write", path: "replaced", content: "replaced\n" },
        { op: "write", path: "staged.txt", content: "one\n" },
        { op: "write", path: "mode.txt", content: "mode\n" },
      ],
      [{ op: "write", path: ".gitignore", content: "*.log\ncache/\n" }],
    ],
    mutate: [
      { op: "write", path: "base.txt", content: "modified\n" },
      { op: "write", path: "staged.txt", content: "two\n" },
      { op: "stage", path: "staged.txt" },
      { op: "write", path: "added.txt", content: "added\n" },
      { op: "stage", path: "added.txt" },
      { op: "remove", path: "gone.txt" },
      { op: "gitRemove", path: "keep.txt" },
      { op: "chmod", path: "mode.txt", mode: 0o755 },
      { op: "symlink", path: "link", target: "staged.txt" },
      { op: "remove", path: "replaced" },
      { op: "write", path: "replaced/inner.txt", content: "inner\n" },
      { op: "write", path: "fresh.txt", content: "fresh\n" },
      { op: "write", path: "fresh/a.txt", content: "a\n" },
      { op: "write", path: "cache/ignored.txt", content: "ignored\n" },
      { op: "write", path: "noisy.log", content: "noise\n" },
      { op: "write", path: "tracked.log", content: "changed\n" },
    ],
  },
];

describe("status", () => {
  for (const scenario of SCENARIOS) {
    it(`matches git --porcelain=v2 byte for byte: ${scenario.name}`, async () => {
      const { fixture, workspace } = await build(scenario);
      const entries = status(workspace.repo, workspace.worktree);
      expect(formatPorcelainV2(entries)).toBe(gitStatus(fixture, "--porcelain=v2"));
    });
  }

  for (const scenario of SCENARIOS) {
    it(`matches git --porcelain=v1 and --short: ${scenario.name}`, async () => {
      const { fixture, workspace } = await build(scenario);
      const entries = status(workspace.repo, workspace.worktree);
      expect(formatPorcelainV1(entries)).toBe(gitStatus(fixture, "--porcelain=v1"));
      expect(formatShort(entries)).toBe(gitStatus(fixture, "--short"));
    });
  }

  it("filters by pathspec the way git does", async () => {
    const { fixture, workspace } = await build({
      name: "pathspec",
      commits: [BASE],
      mutate: [
        { op: "write", path: "base.txt", content: "changed\n" },
        { op: "write", path: "src/nested.txt", content: "changed\n" },
        { op: "write", path: "src/fresh.txt", content: "fresh\n" },
      ],
    });
    const entries = status(workspace.repo, workspace.worktree, { paths: ["src"] });
    expect(formatPorcelainV2(entries)).toBe(gitStatus(fixture, "--porcelain=v2", "--", "src"));
  });

  it("lists untracked files one by one for untrackedFiles: all", async () => {
    const { fixture, workspace } = await build({
      name: "untracked all",
      commits: [BASE],
      mutate: [
        { op: "write", path: "fresh/a.txt", content: "a\n" },
        { op: "write", path: "fresh/deeper/b.txt", content: "b\n" },
        { op: "remove", path: "base.txt" },
        { op: "write", path: "base.txt/inner.txt", content: "inner\n" },
      ],
    });
    const entries = status(workspace.repo, workspace.worktree, { untrackedFiles: "all" });
    expect(formatPorcelainV2(entries)).toBe(gitStatus(fixture, "--porcelain=v2", "-uall"));
  });

  it("keeps ignored paths out by default and reports them as untracked on request", async () => {
    const { workspace } = await build({
      name: "ignored",
      commits: [[...BASE, { op: "write", path: ".gitignore", content: "*.log\n" }]],
      mutate: [
        { op: "write", path: "debug.log", content: "noise\n" },
        { op: "write", path: "fresh.txt", content: "fresh\n" },
      ],
    });
    expect(status(workspace.repo, workspace.worktree).map((entry) => entry.path)).toEqual([
      "fresh.txt",
    ]);
    const withIgnored = status(workspace.repo, workspace.worktree, { includeIgnored: true });
    expect(withIgnored.map((entry) => `${entry.index}${entry.worktree} ${entry.path}`)).toEqual([
      " ? debug.log",
      " ? fresh.txt",
    ]);
  });

  it("never ignores a tracked file", async () => {
    const { workspace } = await build({
      name: "tracked but matching",
      commits: [
        [...BASE, { op: "write", path: "tracked.log", content: "tracked\n" }],
        [{ op: "write", path: ".gitignore", content: "*.log\n" }],
      ],
      mutate: [{ op: "remove", path: "tracked.log" }],
    });
    const entries = status(workspace.repo, workspace.worktree);
    expect(entries.map((entry) => `${entry.index}${entry.worktree} ${entry.path}`)).toEqual([
      " D tracked.log",
    ]);
  });

  it("lists every file individually in the isomorphic-git matrix", async () => {
    const { workspace } = await build({
      name: "matrix",
      commits: [BASE],
      mutate: [
        { op: "write", path: "base.txt", content: "changed\n" },
        { op: "write", path: "added.txt", content: "added\n" },
        { op: "stage", path: "added.txt" },
        { op: "write", path: "fresh/a.txt", content: "a\n" },
        { op: "remove", path: "keep.txt" },
      ],
    });
    expect(statusMatrix(workspace.repo, workspace.worktree)).toEqual([
      ["added.txt", 0, 2, 2],
      ["base.txt", 1, 2, 1],
      ["fresh/a.txt", 0, 2, 0],
      ["keep.txt", 1, 0, 1],
      ["src/nested.txt", 1, 1, 1],
    ]);
  });
});

/** Counts the calls that would mean a file was read to be hashed. */
class CountingWorktree implements Worktree {
  reads = 0;

  constructor(private readonly inner: Worktree) {}

  stat(path: string): WorktreeStat | null {
    return this.inner.stat(path);
  }
  readFile(path: string): Uint8Array {
    this.reads++;
    return this.inner.readFile(path);
  }
  writeFile(path: string, data: Uint8Array, mode: number): void {
    this.inner.writeFile(path, data, mode);
  }
  readlink(path: string): string {
    this.reads++;
    return this.inner.readlink(path);
  }
  symlink(target: string, path: string): void {
    this.inner.symlink(target, path);
  }
  readdir(path: string): WorktreeDirent[] {
    return this.inner.readdir(path);
  }
  mkdirp(path: string): void {
    this.inner.mkdirp(path);
  }
  unlink(path: string): void {
    this.inner.unlink(path);
  }
  rmdir(path: string): void {
    this.inner.rmdir(path);
  }
  chmod(path: string, mode: number): void {
    this.inner.chmod(path, mode);
  }
}

describe("status cost", () => {
  it("hashes nothing over an untouched tree", async () => {
    const files: Step[] = [];
    for (let i = 0; i < 40; i++) {
      files.push({ op: "write", path: `dir${i % 4}/file${i}.txt`, content: `contents ${i}\n` });
    }
    // No .gitignore anywhere, so any file read can only be a hash.
    const { workspace } = await build({ name: "cost", commits: [files], mutate: [] });
    const counting = new CountingWorktree(workspace.worktree);

    const first = status(workspace.repo, counting);
    expect(first).toEqual([]);
    expect(counting.reads).toBe(0);

    const before = workspace.repo.store.objectCount();
    workspace.storage.resetCounters();
    expect(status(workspace.repo, counting)).toEqual([]);
    expect(counting.reads).toBe(0);
    expect(workspace.repo.store.objectCount()).toBe(before);
    expect(workspace.storage.statementCount).toBeGreaterThan(0);
  });

  it("costs the same per file whatever the repository holds", async () => {
    const measure = async (count: number): Promise<number> => {
      const files: Step[] = [];
      for (let i = 0; i < count; i++) {
        files.push({ op: "write", path: `dir${i % 4}/file${i}.txt`, content: `contents ${i}\n` });
      }
      // Several commits, so the object database grows independently of the
      // number of files status has to look at.
      const commits: Step[][] = [files];
      for (let round = 0; round < 4; round++) {
        commits.push([{ op: "write", path: "churn.txt", content: `round ${round}\n` }]);
      }
      const { workspace } = await build({ name: `cost ${count}`, commits, mutate: [] });
      workspace.storage.resetCounters();
      status(workspace.repo, workspace.worktree);
      return workspace.storage.statementCount;
    };

    const small = await measure(20);
    const large = await measure(80);
    // Four times the files, so at most four times the work plus the fixed
    // overhead — and nowhere near the object count.
    expect(large).toBeLessThan(small * 4 + 40);
  });

  it("hashes only the files whose stat data no longer matches", async () => {
    const files: Step[] = [];
    for (let i = 0; i < 20; i++) {
      files.push({ op: "write", path: `file${i}.txt`, content: `contents ${i}\n` });
    }
    const { workspace } = await build({
      name: "partial",
      commits: [files],
      // Same length as the original, so only the recorded mtime can tell.
      mutate: [{ op: "write", path: "file3.txt", content: "contents X\n" }],
    });
    const counting = new CountingWorktree(workspace.worktree);
    const entries = status(workspace.repo, counting);
    expect(entries.map((entry) => `${entry.index}${entry.worktree} ${entry.path}`)).toEqual([
      " M file3.txt",
    ]);
    expect(counting.reads).toBe(1);
  });
});

describe("clean", () => {
  /** The paths `git clean` says it would remove, in git's own order. */
  function wouldRemove(fixture: GitFixture, ...flags: string[]): string[] {
    const stdout = fixture.gitBinary("clean", "-n", ...flags).toString("utf8");
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("Would remove "))
      .map((line) => line.slice("Would remove ".length));
  }

  const scenario: Scenario = {
    name: "clean",
    commits: [[...BASE, { op: "write", path: ".gitignore", content: "*.log\n" }]],
    mutate: [
      { op: "write", path: "loose.txt", content: "loose\n" },
      { op: "write", path: "noisy.log", content: "noise\n" },
      { op: "write", path: "src/extra.txt", content: "extra\n" },
      { op: "write", path: "fresh/a.txt", content: "a\n" },
      { op: "write", path: "fresh/deeper/b.txt", content: "b\n" },
      { op: "write", path: "mixed/keep.txt", content: "keep\n" },
      { op: "write", path: "mixed/skip.log", content: "noise\n" },
    ],
  };

  it("reports what git clean -n reports", async () => {
    const { fixture, workspace } = await build(scenario);
    expect(clean(workspace.repo, workspace.worktree, { dryRun: true })).toEqual(
      wouldRemove(fixture),
    );
  });

  it("descends into untracked directories only with directories: true", async () => {
    const { fixture, workspace } = await build(scenario);
    expect(clean(workspace.repo, workspace.worktree, { dryRun: true, directories: true })).toEqual(
      wouldRemove(fixture, "-d"),
    );
  });

  it("leaves the working tree alone on a dry run", async () => {
    const { workspace } = await build(scenario);
    clean(workspace.repo, workspace.worktree, { dryRun: true, directories: true });
    expect(workspace.worktree.stat("/loose.txt")).not.toBeNull();
    expect(workspace.worktree.stat("/fresh/a.txt")).not.toBeNull();
  });

  it("removes untracked paths and leaves ignored and tracked ones", async () => {
    const { workspace } = await build(scenario);
    const removed = clean(workspace.repo, workspace.worktree, { directories: true });
    expect(removed).toContain("fresh/");
    expect(workspace.worktree.stat("/loose.txt")).toBeNull();
    expect(workspace.worktree.stat("/src/extra.txt")).toBeNull();
    expect(workspace.worktree.stat("/fresh")).toBeNull();
    expect(workspace.worktree.stat("/mixed/keep.txt")).toBeNull();
    // Ignored and tracked files survive.
    expect(workspace.worktree.stat("/noisy.log")).not.toBeNull();
    expect(workspace.worktree.stat("/mixed/skip.log")).not.toBeNull();
    expect(workspace.worktree.stat("/base.txt")).not.toBeNull();
    expect(workspace.worktree.stat("/src/nested.txt")).not.toBeNull();
    expect(status(workspace.repo, workspace.worktree)).toEqual([]);
  });
});
