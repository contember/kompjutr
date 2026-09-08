// Behavioural scenarios run through both public surfaces. Git's test code is
// not copied here; each caller records the upstream scenario it adapted.

import { Buffer } from "node:buffer";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { comparePaths } from "../../packages/do/src/fs/path.js";
import { Workspace } from "../../packages/do/src/runtime/workspace.js";
import { createGit, type Git } from "../../packages/git/src/client.js";
import { GitFixture } from "./git.js";
import { SqliteTestStorage } from "./storage.js";

const FIXED_TIME = 1_577_836_800_000;
const IDENTITY = { name: "Fixture", email: "fixture@example.com" };

export const UPSTREAM_GIT_REVISION = "1a3e64c6c4a623626ff0687008732a8e007e2a1c";

export interface GitParitySource {
  file: string;
  test: string;
}

export interface GitParityScenario {
  source: GitParitySource;
  steps: GitParityStep[];
}

interface StepExpectation {
  outcome?: "success" | "failure";
  kompjutrCode?: string;
}

type GitParityAction =
  | { op: "write"; path: string; content: string; mode?: number }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string }
  | { op: "chmod"; path: string; mode: number }
  | { op: "symlink"; path: string; target: string }
  | { op: "add"; paths: string[]; all?: boolean; trackedOnly?: boolean; force?: boolean }
  | { op: "commit"; message: string; amend?: boolean }
  | { op: "branch"; name: string; startPoint?: string; force?: boolean }
  | { op: "checkout"; ref: string; paths?: string[]; force?: boolean }
  | { op: "reset"; paths?: string[]; hard?: boolean; ref?: string }
  | { op: "clean"; paths?: string[]; directories?: boolean; dryRun?: boolean };

export type GitParityStep = GitParityAction & { expected?: StepExpectation };

interface StepOutcome {
  outcome: "success" | "failure";
  code?: string;
}

interface RefState {
  name: string;
  oid: string;
}

interface StatusState {
  path: string;
  index: string;
  worktree: string;
}

interface WorktreeState {
  path: string;
  type: "file" | "dir" | "symlink";
  executable?: boolean;
  content?: string;
  target?: string;
}

export interface GitParitySnapshot {
  head: string | null;
  currentBranch: string | null;
  refs: RefState[];
  index: string[];
  status: StatusState[];
  worktree: WorktreeState[];
}

export interface GitParityResult {
  git: GitParitySnapshot;
  kompjutr: GitParitySnapshot;
}

interface KompjutrDriver {
  workspace: Workspace;
  git: Git;
}

export async function runGitParityScenario(scenario: GitParityScenario): Promise<GitParityResult> {
  const fixture = new GitFixture().init();
  const kompjutr = createKompjutrDriver();
  await kompjutr.git.init({ dir: "/" });

  try {
    for (const [index, step] of scenario.steps.entries()) {
      const [gitOutcome, kompjutrOutcome] = await Promise.all([
        captureOutcome(() => applyToGit(fixture, step)),
        captureOutcome(() => applyToKompjutr(kompjutr, step)),
      ]);
      verifyOutcome(scenario, index, step, gitOutcome, kompjutrOutcome);
    }

    const [git, ours] = await Promise.all([snapshotGit(fixture), snapshotKompjutr(kompjutr)]);
    return { git, kompjutr: ours };
  } finally {
    fixture.dispose();
  }
}

function createKompjutrDriver(): KompjutrDriver {
  const workspace = new Workspace({
    storage: new SqliteTestStorage(),
    git: createGit(),
    now: () => FIXED_TIME,
    timezoneOffset: () => 0,
    defaultGitIdentity: IDENTITY,
  });
  return { workspace, git: workspace.git };
}

async function captureOutcome(run: () => void | Promise<void>): Promise<StepOutcome> {
  try {
    await run();
    return { outcome: "success" };
  } catch (error) {
    const code = errorCode(error);
    return code === undefined ? { outcome: "failure" } : { outcome: "failure", code };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function verifyOutcome(
  scenario: GitParityScenario,
  index: number,
  step: GitParityStep,
  git: StepOutcome,
  kompjutr: StepOutcome,
): void {
  const expected = step.expected?.outcome ?? "success";
  const label = `${scenario.source.file}: ${scenario.source.test}, step ${index + 1} (${step.op})`;
  if (git.outcome !== expected) {
    throw new Error(`${label}: Git returned ${git.outcome}, expected ${expected}`);
  }
  if (kompjutr.outcome !== expected) {
    throw new Error(
      `${label}: kompjutr returned ${kompjutr.outcome} (${kompjutr.code ?? "no code"}), expected ${expected}`,
    );
  }
  const expectedCode = step.expected?.kompjutrCode;
  if (expectedCode !== undefined && kompjutr.code !== expectedCode) {
    throw new Error(
      `${label}: kompjutr returned ${kompjutr.code ?? "no code"}, expected ${expectedCode}`,
    );
  }
}

function applyToGit(fixture: GitFixture, step: GitParityStep): void {
  switch (step.op) {
    case "write":
      fixture.write(step.path, step.content);
      if (step.mode !== undefined) fixture.chmod(step.path, step.mode);
      return;
    case "mkdir":
      mkdirSync(join(fixture.dir, step.path), { recursive: true });
      return;
    case "remove":
      fixture.remove(step.path);
      return;
    case "chmod":
      fixture.chmod(step.path, step.mode);
      return;
    case "symlink":
      fixture.symlink(step.target, step.path);
      return;
    case "add": {
      const args = ["add"];
      if (step.force === true) args.push("--force");
      if (step.all === true) args.push(step.trackedOnly === true ? "--update" : "--all");
      else args.push("--", ...step.paths);
      fixture.git(...args);
      return;
    }
    case "commit": {
      const args = ["commit", "-q", "-m", step.message];
      if (step.amend === true) args.push("--amend");
      fixture.git(...args);
      return;
    }
    case "branch": {
      const args = ["branch"];
      if (step.force === true) args.push("--force");
      args.push(step.name);
      if (step.startPoint !== undefined) args.push(step.startPoint);
      fixture.git(...args);
      return;
    }
    case "checkout": {
      const args = ["checkout", "-q"];
      if (step.force === true) args.push("--force");
      args.push(step.ref);
      if (step.paths !== undefined && step.paths.length > 0) args.push("--", ...step.paths);
      fixture.git(...args);
      return;
    }
    case "reset": {
      const args = ["reset", "-q"];
      if (step.hard === true) args.push("--hard");
      if (step.ref !== undefined) args.push(step.ref);
      if (step.paths !== undefined && step.paths.length > 0) args.push("--", ...step.paths);
      fixture.git(...args);
      return;
    }
    case "clean": {
      const args = ["clean", step.dryRun === true ? "-n" : "-f"];
      if (step.directories === true) args.push("-d");
      if (step.paths !== undefined && step.paths.length > 0) args.push("--", ...step.paths);
      fixture.git(...args);
      return;
    }
  }
}

async function applyToKompjutr(driver: KompjutrDriver, step: GitParityStep): Promise<void> {
  const { git, workspace } = driver;
  switch (step.op) {
    case "write":
      await workspace.fs.writeFiles(
        [{ path: `/${step.path}`, content: step.content, mode: step.mode }],
        { createParents: true },
      );
      return;
    case "mkdir":
      await workspace.fs.mkdir(`/${step.path}`, { recursive: true });
      return;
    case "remove":
      await workspace.fs.rm(`/${step.path}`, { recursive: true, force: true });
      return;
    case "chmod":
      await workspace.fs.chmod(`/${step.path}`, step.mode);
      return;
    case "symlink":
      await workspace.fs.symlink(step.target, `/${step.path}`);
      return;
    case "add":
      await git.add({
        paths: step.paths,
        all: step.all,
        trackedOnly: step.trackedOnly,
        force: step.force,
      });
      return;
    case "commit":
      await git.commit({ message: step.message, amend: step.amend });
      return;
    case "branch":
      await git.branch({ name: step.name, startPoint: step.startPoint, force: step.force });
      return;
    case "checkout":
      await git.checkout({ ref: step.ref, paths: step.paths, force: step.force });
      return;
    case "reset":
      await git.reset({ paths: step.paths, hard: step.hard, ref: step.ref });
      return;
    case "clean":
      await git.clean({
        paths: step.paths,
        directories: step.directories,
        dryRun: step.dryRun,
      });
      return;
  }
}

async function snapshotGit(fixture: GitFixture): Promise<GitParitySnapshot> {
  return {
    head: tryGit(fixture, "rev-parse", "--verify", "--quiet", "HEAD"),
    currentBranch: tryGit(fixture, "symbolic-ref", "--quiet", "--short", "HEAD"),
    refs: gitRefs(fixture),
    index: nulRecords(fixture.gitBinary("ls-files", "-z")),
    status: gitStatus(fixture),
    worktree: gitWorktree(fixture),
  };
}

async function snapshotKompjutr(driver: KompjutrDriver): Promise<GitParitySnapshot> {
  const { git, workspace } = driver;
  return {
    head: await tryKompjutrRef(git, "HEAD"),
    currentBranch: (await git.currentBranch()) ?? null,
    refs: await kompjutrRefs(git),
    index: await git.lsFiles(),
    status: await git.status(),
    worktree: await kompjutrWorktree(workspace),
  };
}

function tryGit(fixture: GitFixture, ...args: string[]): string | null {
  try {
    return fixture.git(...args);
  } catch {
    return null;
  }
}

async function tryKompjutrRef(git: Git, ref: string): Promise<string | null> {
  try {
    return await git.revParse({ ref });
  } catch {
    return null;
  }
}

function gitRefs(fixture: GitFixture): RefState[] {
  const output = fixture.git(
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    "refs/heads",
    "refs/tags",
  );
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    if (tab === -1) throw new Error(`invalid for-each-ref output: ${line}`);
    return { name: line.slice(0, tab), oid: line.slice(tab + 1) };
  });
}

async function kompjutrRefs(git: Git): Promise<RefState[]> {
  const refs: RefState[] = [];
  for (const branch of await git.branchList()) {
    const name = `refs/heads/${branch}`;
    refs.push({ name, oid: await git.revParse({ ref: name }) });
  }
  for (const tag of await git.tagList()) {
    const name = `refs/tags/${tag}`;
    refs.push({ name, oid: await git.revParse({ ref: name }) });
  }
  refs.sort((left, right) => comparePaths(left.name, right.name));
  return refs;
}

function nulRecords(bytes: Uint8Array): string[] {
  const output = Buffer.from(bytes).toString("utf8");
  if (output === "") return [];
  const records = output.split("\0");
  if (records[records.length - 1] === "") records.pop();
  return records;
}

function gitStatus(fixture: GitFixture): StatusState[] {
  return nulRecords(
    fixture.gitBinary("status", "--porcelain=v1", "-z", "--untracked-files=normal"),
  ).map((record) => {
    if (record.length < 3 || record[2] !== " ") {
      throw new Error(`invalid porcelain v1 record: ${JSON.stringify(record)}`);
    }
    return { index: record[0] ?? "", worktree: record[1] ?? "", path: record.slice(3) };
  });
}

function gitWorktree(fixture: GitFixture): WorktreeState[] {
  const out: WorktreeState[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".git") continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        out.push({ path, type: "symlink", target: readlinkSync(full) });
      } else if (stat.isDirectory()) {
        out.push({ path, type: "dir" });
        visit(full, path);
      } else if (stat.isFile()) {
        out.push({
          path,
          type: "file",
          executable: (stat.mode & 0o111) !== 0,
          content: readFileSync(full).toString("hex"),
        });
      } else {
        throw new Error(`unsupported worktree entry: ${path}`);
      }
    }
  };
  visit(fixture.dir, "");
  out.sort((left, right) => comparePaths(left.path, right.path));
  return out;
}

async function kompjutrWorktree(workspace: Workspace): Promise<WorktreeState[]> {
  const out: WorktreeState[] = [];
  for (const entry of await workspace.fs.walk("/")) {
    const path = entry.path.slice(1);
    if (entry.type === "symlink") {
      out.push({ path, type: "symlink", target: workspace.filesystem.readlink(entry.path) });
    } else if (entry.type === "dir") {
      out.push({ path, type: "dir" });
    } else {
      out.push({
        path,
        type: "file",
        executable: (entry.mode & 0o111) !== 0,
        content: Buffer.from(workspace.filesystem.readFile(entry.path)).toString("hex"),
      });
    }
  }
  out.sort((left, right) => comparePaths(left.path, right.path));
  return out;
}
