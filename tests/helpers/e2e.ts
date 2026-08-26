// End-to-end journeys. A bounded action DSL is played against kompjutr and
// against the real git binary at the same time, and the whole public
// repository state is compared after every step — a journey asserts nothing
// of its own about Git behaviour, it asks Git.
//
// Each side owns a private bare origin seeded from the same commits, so
// pushes, pulls and injected colleague work stay symmetric without the two
// implementations racing on one remote. kompjutr reaches its origin over
// Smart HTTP (the only transport it has); the mirror reaches its own over a
// local path, because the mirror is the reference, not the subject.

import { Buffer } from "node:buffer";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { GitContext } from "../../src/core/context.js";
import { openRepository } from "../../src/core/context.js";
import type { StatusBranch } from "../../src/core/ops/status.js";
import { formatPorcelainV2, statusReport } from "../../src/core/ops/status.js";
import { comparePaths } from "../../src/core/streams.js";
import type { Git } from "../../src/git/client.js";
import { createGit } from "../../src/git/client.js";
import { Workspace } from "../../src/runtime/workspace.js";
import { Database } from "../../src/sqlite/db.js";
import { createSqliteSparseWorkspaceSource } from "../../src/sqlite/sparse-workspace.js";
import { SqliteGitDatabase } from "../../src/sqlite/store.js";
import { GitFixture } from "./git.js";
import type { GitServer } from "./http-backend.js";
import { startGitServer } from "./http-backend.js";
import { SqliteTestStorage } from "./storage.js";

/** Where the repository under test lives inside the kompjutr workspace. */
export const WORK = "/work";

/**
 * Both sides commit at the same instant. `GitFixture` pins the same value in
 * `GIT_*_DATE`, so a commit with the same tree, parents and message gets the
 * same OID on both sides and journeys can compare OIDs directly.
 */
const FIXED_TIME = 1_577_836_800_000; // 2020-01-01T00:00:00Z

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };

/**
 * Written by `git clone`, and deliberately absent here: kompjutr never
 * records a remote's default branch as a ref. Compared refs drop it.
 */
const REMOTE_HEAD = /^refs\/remotes\/[^/]+\/HEAD$/;

// -- the action DSL ----------------------------------------------------

type WorktreeAction =
  | { op: "write"; path: string; content: string; mode?: number }
  | { op: "writeBytes"; path: string; bytes: Uint8Array }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string }
  | { op: "chmod"; path: string; mode: number }
  | { op: "symlink"; path: string; target: string };

type IndexAction =
  | { op: "add"; paths?: string[]; all?: boolean; trackedOnly?: boolean; force?: boolean }
  | { op: "rm"; paths: string[]; cached?: boolean; recursive?: boolean; force?: boolean }
  | { op: "reset"; ref?: string; hard?: boolean; paths?: string[] }
  | { op: "clean"; paths?: string[]; directories?: boolean; dryRun?: boolean }
  | { op: "commit"; message: string; amend?: boolean; allowEmpty?: boolean };

type RefAction =
  | { op: "branch"; name: string; startPoint?: string; force?: boolean; checkout?: boolean }
  | { op: "branchDelete"; name: string }
  | { op: "checkout"; ref: string; paths?: string[]; force?: boolean }
  | { op: "tag"; name: string; object?: string; force?: boolean }
  | { op: "tagDelete"; name: string };

type IntegrationAction =
  | {
      op: "merge";
      theirs: string;
      message?: string;
      fastForward?: boolean;
      fastForwardOnly?: boolean;
      commit?: boolean;
    }
  | { op: "mergeContinue"; message?: string }
  | { op: "mergeAbort" }
  | { op: "cherryPick"; source: string; mainline?: number }
  | { op: "cherryPickContinue" }
  | { op: "cherryPickSkip" }
  | { op: "cherryPickAbort" }
  | { op: "revert"; source: string; mainline?: number }
  | { op: "revertContinue" }
  | { op: "revertSkip" }
  | { op: "revertAbort" }
  | { op: "rebase"; upstream: string }
  | { op: "rebaseContinue" }
  | { op: "rebaseSkip" }
  | { op: "rebaseAbort" };

type NetworkAction =
  | { op: "fetch"; remote?: string; prune?: boolean; tags?: boolean }
  | { op: "pull"; message?: string; fastForward?: boolean; fastForwardOnly?: boolean }
  | { op: "push"; ref?: string; remoteRef?: string; force?: boolean; delete?: boolean };

/**
 * Work by somebody else, run as real git against both sides' peer clones so
 * the two origins stay in lockstep. `reopen` drops kompjutr's cached handles
 * the way a Durable Object eviction does; git has no equivalent and skips it.
 */
type WorldAction =
  | { op: "peer"; act: (peer: GitFixture) => void }
  | { op: "reopen" }
  /**
   * An escape hatch for anything the DSL does not spell out — config, remotes,
   * plumbing. Both halves must do the same thing, or the comparison that
   * follows will say so.
   */
  | {
      op: "custom";
      local: (git: Git, world: E2EWorld) => void | Promise<void>;
      mirror: (fixture: GitFixture) => void;
    };

export type E2EAction =
  | WorktreeAction
  | IndexAction
  | RefAction
  | IntegrationAction
  | NetworkAction
  | WorldAction;

/** What a step is expected to do. Defaults to a clean success. */
export interface StepExpectation {
  outcome?: OutcomeKind;
  /** kompjutr's stable `error.code`, checked only on a failed step. */
  code?: string;
}

export type E2EStep = E2EAction & { expect?: StepExpectation };

/**
 * Three outcomes, because a conflict is neither. Git reports one by exiting
 * non-zero with unmerged index entries behind it; kompjutr returns a result
 * object instead, so the two are normalised before they are compared.
 */
export type OutcomeKind = "clean" | "conflicted" | "failed";

interface Outcome {
  kind: OutcomeKind;
  code?: string;
}

// -- the compared state ------------------------------------------------

interface RefState {
  name: string;
  oid: string;
}

interface WorktreeState {
  path: string;
  type: "file" | "dir" | "symlink";
  executable?: boolean;
  content?: string;
  target?: string;
}

interface LogEntry {
  oid: string;
  message: string;
  parents: string[];
}

export interface E2ESnapshot {
  head: string | null;
  currentBranch: string | null;
  refs: RefState[];
  originRefs: RefState[];
  index: string[];
  /** `git status --porcelain=v2`, the widest framed status both sides emit. */
  status: string;
  worktree: WorktreeState[];
  log: LogEntry[];
  /** Which integration is pending, as the two sides each record it. */
  operation: "merge" | "cherry-pick" | "revert" | "rebase" | null;
}

// -- the world ---------------------------------------------------------

export interface E2EWorldOptions {
  /** Root-commit contents. Defaults to a single `README.md`. */
  seed?: Record<string, string>;
  /** Extra commits on the seed, applied before either side clones. */
  seedHistory?: (fixture: GitFixture) => void;
  /** Start both sides from `init` instead of a clone. */
  start?: "clone" | "init";
}

export interface E2EWorld {
  /** kompjutr's runtime, rebuilt by a `reopen` step. */
  readonly git: Git;
  readonly workspace: Workspace;
  /** The real-git twin every step is replayed against. */
  readonly mirror: GitFixture;
  /** Bare origins, one per side. */
  readonly originK: GitFixture;
  readonly originG: GitFixture;
  /** Colleague working copies, one per side. */
  readonly peerK: GitFixture;
  readonly peerG: GitFixture;
  /** The Smart HTTP URL kompjutr clones and pushes through. */
  readonly url: string;
  /** Requests the served origin has seen, in order. */
  readonly requests: GitServer["requests"];

  /** Play steps on both sides, comparing the whole state after each one. */
  run(...steps: E2EStep[]): Promise<void>;
  /** Play steps on kompjutr only, for journeys real git cannot mirror. */
  runLocal(...steps: E2EStep[]): Promise<void>;
  /** Compare both sides now. `run` does this for you after every step. */
  compare(label?: string): Promise<void>;
  snapshot(): Promise<{ kompjutr: E2ESnapshot; git: E2ESnapshot }>;
  /** Drop kompjutr's cached handles, as a Durable Object eviction would. */
  reopen(): void;
  /** Read a working-tree file from the kompjutr side. */
  read(path: string): Promise<string>;
  dispose(): Promise<void>;
}

export async function createWorld(options: E2EWorldOptions = {}): Promise<E2EWorld> {
  const seed = options.seed ?? { "README.md": "seed\n" };
  const start = options.start ?? "clone";
  const disposables: GitFixture[] = [];
  const track = (fixture: GitFixture): GitFixture => {
    disposables.push(fixture);
    return fixture;
  };

  // One seed working copy, cloned twice, so both origins hold identical OIDs.
  const seedWc = track(new GitFixture().init());
  for (const [path, content] of Object.entries(seed)) seedWc.write(path, content);
  seedWc.commit("seed");
  options.seedHistory?.(seedWc);

  const originK = track(bareCloneOf(seedWc));
  const originG = track(bareCloneOf(seedWc));
  const peerK = track(workingCloneOf(originK));
  const peerG = track(workingCloneOf(originG));

  const server = await startGitServer(originK.dir);

  const storage = new SqliteTestStorage();
  let workspace = newWorkspace(storage);
  const mirror = track(new GitFixture());

  if (start === "clone") {
    // kompjutr's clone defaults are shallow, single-branch and tagless; the
    // mirror's are not, so ask for the shape `git clone` actually produces.
    await workspace.git.clone({
      url: server.url,
      dir: WORK,
      depth: 0,
      singleBranch: false,
      noTags: false,
    });
    mirror.git("clone", "-q", originG.dir, ".");
    mirror.git("config", "core.autocrlf", "false");
  } else {
    await workspace.git.init({ dir: WORK });
    mirror.init();
  }

  const world: E2EWorld = {
    get git() {
      return workspace.git;
    },
    get workspace() {
      return workspace;
    },
    mirror,
    originK,
    originG,
    peerK,
    peerG,
    url: server.url,
    requests: server.requests,

    async run(...steps) {
      for (const [index, step] of steps.entries()) {
        await playStep(world, step, index, true);
      }
    },
    async runLocal(...steps) {
      for (const [index, step] of steps.entries()) {
        await playStep(world, step, index, false);
      }
    },
    async compare(label) {
      const { kompjutr, git } = await world.snapshot();
      const reason = label ?? "kompjutr state differs from git";
      expect(kompjutr.operation, `${reason}: pending operation`).toEqual(git.operation);
      expect(comparable(kompjutr), reason).toEqual(comparable(git));
    },
    async snapshot() {
      const [kompjutr, git] = await Promise.all([
        snapshotKompjutr(workspace, storage, originK),
        snapshotGit(mirror, originG),
      ]);
      return { kompjutr, git };
    },
    reopen() {
      workspace = newWorkspace(storage);
    },
    async read(path) {
      const bytes: unknown = await workspace.fs.readFile(join(WORK, path), "utf8");
      if (typeof bytes !== "string") throw new Error(`${path} did not read back as text`);
      return bytes;
    },
    async dispose() {
      await server.close();
      for (const fixture of disposables) fixture.dispose();
    },
  };
  return world;
}

/**
 * Mid-rebase the two designs place HEAD deliberately differently: Git detaches
 * onto the new base and replays there, while kompjutr leaves the branch at its
 * original OID and lets the authenticated journal own the unpublished results
 * (`docs/reference/git-support.md`, `git rebase`). Everything else — refs,
 * index stages, conflict bytes, the pending operation — is still compared, and
 * the full comparison resumes the moment the rebase finishes or aborts.
 */
function comparable(
  snapshot: E2ESnapshot,
): Omit<E2ESnapshot, "head" | "currentBranch" | "log"> &
  Partial<Pick<E2ESnapshot, "head" | "currentBranch" | "log">> {
  if (snapshot.operation !== "rebase") return snapshot;
  const { head: _head, currentBranch: _branch, log: _log, ...rest } = snapshot;
  return { ...rest, status: maskHeadDerived(rest.status) };
}

/**
 * Porcelain v2 reports each ordinary row's mode and OID *in HEAD*, so those
 * two fields inherit the mid-rebase HEAD difference above. Masking them keeps
 * the rest of the row — the codes, the index and worktree modes and OIDs, and
 * every unmerged `u` row — under comparison.
 */
function maskHeadDerived(status: string): string {
  return status
    .split("\n")
    .map((line) => {
      if (!line.startsWith("1 ") && !line.startsWith("2 ")) return line;
      // <kind> <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>...
      const fields = line.split(" ");
      if (fields.length < 9) return line;
      fields[3] = "<head-mode>";
      fields[6] = "<head-oid>";
      return fields.join(" ");
    })
    .join("\n");
}

function newWorkspace(storage: SqliteTestStorage): Workspace {
  return new Workspace({
    storage,
    git: createGit(),
    now: () => FIXED_TIME,
    timezoneOffset: () => 0,
    defaultGitIdentity: IDENTITY,
  });
}

/** `git clone --bare` into the fixture's own empty directory. */
function bareCloneOf(source: GitFixture): GitFixture {
  const bare = new GitFixture();
  bare.git("clone", "--bare", "-q", source.dir, ".");
  return bare;
}

function workingCloneOf(origin: GitFixture): GitFixture {
  const clone = new GitFixture();
  clone.git("clone", "-q", origin.dir, ".");
  clone.git("config", "core.autocrlf", "false");
  return clone;
}

// -- playing one step --------------------------------------------------

async function playStep(
  world: E2EWorld,
  step: E2EStep,
  index: number,
  mirrored: boolean,
): Promise<void> {
  const label = `step ${index + 1} (${step.op})`;
  const expected = step.expect?.outcome ?? "clean";

  const kompjutr = await captureOutcome(() => applyToKompjutr(world, step));
  if (kompjutr.kind !== expected) {
    throw new Error(
      `${label}: kompjutr was ${kompjutr.kind}${codeSuffix(kompjutr)}, expected ${expected}`,
    );
  }
  if (step.expect?.code !== undefined && kompjutr.code !== step.expect.code) {
    throw new Error(
      `${label}: kompjutr code was ${kompjutr.code ?? "none"}, expected ${step.expect.code}`,
    );
  }

  if (!mirrored) return;

  const git = await captureOutcome(() => applyToGit(world, step));
  if (git.kind !== kompjutr.kind) {
    throw new Error(
      `${label}: git was ${git.kind}, kompjutr was ${kompjutr.kind}${codeSuffix(kompjutr)}`,
    );
  }
  await world.compare(`${label}: state diverged`);
}

function codeSuffix(outcome: Outcome): string {
  return outcome.code === undefined ? "" : ` (${outcome.code})`;
}

async function captureOutcome(run: () => Outcome | Promise<Outcome>): Promise<Outcome> {
  try {
    return await run();
  } catch (error) {
    const code = errorCode(error);
    return code === undefined ? { kind: "failed" } : { kind: "failed", code };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

const CLEAN: Outcome = { kind: "clean" };
const CONFLICTED: Outcome = { kind: "conflicted" };

// -- the kompjutr side -------------------------------------------------

async function applyToKompjutr(world: E2EWorld, step: E2EStep): Promise<Outcome> {
  const { workspace } = world;
  const git = world.git;
  const dir = WORK;
  const at = (path: string): string => join(WORK, path);

  switch (step.op) {
    case "write":
      await workspace.fs.writeFiles(
        [{ path: at(step.path), content: step.content, mode: step.mode }],
        {
          createParents: true,
        },
      );
      return CLEAN;
    case "writeBytes":
      await workspace.fs.writeFiles([{ path: at(step.path), content: step.bytes }], {
        createParents: true,
      });
      return CLEAN;
    case "mkdir":
      await workspace.fs.mkdir(at(step.path), { recursive: true });
      return CLEAN;
    case "remove":
      await workspace.fs.rm(at(step.path), { recursive: true, force: true });
      return CLEAN;
    case "chmod":
      await workspace.fs.chmod(at(step.path), step.mode);
      return CLEAN;
    case "symlink":
      await workspace.fs.symlink(step.target, at(step.path));
      return CLEAN;

    case "add":
      await git.add({
        dir,
        paths: step.paths ?? [],
        all: step.all,
        trackedOnly: step.trackedOnly,
        force: step.force,
      });
      return CLEAN;
    case "rm":
      await git.rm({
        dir,
        paths: step.paths,
        cached: step.cached,
        recursive: step.recursive,
        force: step.force,
      });
      return CLEAN;
    case "reset":
      await git.reset({ dir, ref: step.ref, hard: step.hard, paths: step.paths });
      return CLEAN;
    case "clean":
      await git.clean({
        dir,
        paths: step.paths,
        directories: step.directories,
        dryRun: step.dryRun,
      });
      return CLEAN;
    case "commit":
      await git.commit({
        dir,
        message: step.message,
        amend: step.amend,
        allowEmpty: step.allowEmpty,
      });
      return CLEAN;

    case "branch":
      await git.branch({
        dir,
        name: step.name,
        startPoint: step.startPoint,
        force: step.force,
        checkout: step.checkout,
      });
      return CLEAN;
    case "branchDelete":
      await git.branchDelete({ dir, name: step.name });
      return CLEAN;
    case "checkout":
      await git.checkout({ dir, ref: step.ref, paths: step.paths, force: step.force });
      return CLEAN;
    case "tag":
      await git.tag({ dir, name: step.name, object: step.object, force: step.force });
      return CLEAN;
    case "tagDelete":
      await git.tagDelete({ dir, name: step.name });
      return CLEAN;

    case "merge":
      return mergeOutcome(
        await git.merge({
          dir,
          theirs: step.theirs,
          message: mergeMessage(step.message, step.theirs),
          fastForward: step.fastForward,
          fastForwardOnly: step.fastForwardOnly,
          commit: step.commit,
        }),
      );
    case "mergeContinue":
      return mergeOutcome(await git.mergeContinue({ dir, message: step.message }));
    case "mergeAbort":
      await git.mergeAbort({ dir });
      return CLEAN;

    case "cherryPick":
      return replayOutcome(
        await git.cherryPick({ dir, source: step.source, mainline: step.mainline }),
      );
    case "cherryPickContinue":
      return replayOutcome(await git.cherryPickContinue({ dir }));
    case "cherryPickSkip":
      await git.cherryPickSkip({ dir });
      return CLEAN;
    case "cherryPickAbort":
      await git.cherryPickAbort({ dir });
      return CLEAN;

    case "revert":
      return replayOutcome(await git.revert({ dir, source: step.source, mainline: step.mainline }));
    case "revertContinue":
      return replayOutcome(await git.revertContinue({ dir }));
    case "revertSkip":
      await git.revertSkip({ dir });
      return CLEAN;
    case "revertAbort":
      await git.revertAbort({ dir });
      return CLEAN;

    case "rebase":
      return rebaseOutcome(await git.rebase({ dir, upstream: step.upstream }));
    case "rebaseContinue":
      return rebaseOutcome(await git.rebaseContinue({ dir }));
    case "rebaseSkip":
      return rebaseOutcome(await git.rebaseSkip({ dir }));
    case "rebaseAbort":
      await git.rebaseAbort({ dir });
      return CLEAN;

    case "fetch":
      await git.fetch({ dir, remote: step.remote, prune: step.prune, tags: step.tags });
      return CLEAN;
    case "pull":
      return mergeOutcome(
        await git.pull({
          dir,
          message: step.message,
          fastForward: step.fastForward,
          fastForwardOnly: step.fastForwardOnly,
        }),
      );
    case "push": {
      const result = await git.push({
        dir,
        ref: step.ref,
        remoteRef: step.remoteRef,
        force: step.force,
        delete: step.delete,
      });
      // A rejected push resolves; only a transport fault throws. Normalise
      // the rejection to a failure so it lines up with git's exit code.
      if (!result.ok) return { kind: "failed", code: result.error ?? undefined };
      return CLEAN;
    }

    case "peer":
      step.act(world.peerK);
      return CLEAN;
    case "reopen":
      world.reopen();
      return CLEAN;
    case "custom":
      await step.local(git, world);
      return CLEAN;
  }
}

function mergeMessage(message: string | undefined, theirs: string): string {
  // Git's own default differs from kompjutr's, so both sides are always
  // handed the same explicit message and the comparison stays about state.
  return message ?? `Merge ${theirs}`;
}

function mergeOutcome(result: { conflicted?: boolean }): Outcome {
  return result.conflicted === true ? CONFLICTED : CLEAN;
}

function replayOutcome(result: { outcome: string }): Outcome {
  return result.outcome === "conflicted" ? CONFLICTED : CLEAN;
}

function rebaseOutcome(result: { outcome: string }): Outcome {
  return result.outcome === "conflicted" ? CONFLICTED : CLEAN;
}

// -- the real-git side -------------------------------------------------

function applyToGit(world: E2EWorld, step: E2EStep): Outcome {
  const fixture = world.mirror;

  switch (step.op) {
    case "write":
      fixture.write(step.path, step.content);
      if (step.mode !== undefined) fixture.chmod(step.path, step.mode);
      return CLEAN;
    case "writeBytes":
      fixture.write(step.path, step.bytes);
      return CLEAN;
    case "mkdir":
      fixture.write(join(step.path, ".keep"), "");
      fixture.remove(join(step.path, ".keep"));
      return CLEAN;
    case "remove":
      fixture.remove(step.path);
      return CLEAN;
    case "chmod":
      fixture.chmod(step.path, step.mode);
      return CLEAN;
    case "symlink":
      fixture.symlink(step.target, step.path);
      return CLEAN;

    case "add": {
      const args = ["add"];
      if (step.force === true) args.push("--force");
      if (step.all === true) args.push(step.trackedOnly === true ? "--update" : "--all");
      else args.push("--", ...(step.paths ?? []));
      fixture.git(...args);
      return CLEAN;
    }
    case "rm": {
      const args = ["rm", "-q"];
      if (step.cached === true) args.push("--cached");
      if (step.recursive === true) args.push("-r");
      if (step.force === true) args.push("-f");
      fixture.git(...args, "--", ...step.paths);
      return CLEAN;
    }
    case "reset": {
      const args = ["reset", "-q"];
      if (step.hard === true) args.push("--hard");
      if (step.ref !== undefined) args.push(step.ref);
      if (step.paths !== undefined && step.paths.length > 0) args.push("--", ...step.paths);
      fixture.git(...args);
      return CLEAN;
    }
    case "clean": {
      const args = ["clean", step.dryRun === true ? "-n" : "-f"];
      if (step.directories === true) args.push("-d");
      if (step.paths !== undefined && step.paths.length > 0) args.push("--", ...step.paths);
      fixture.git(...args);
      return CLEAN;
    }
    case "commit": {
      const args = ["commit", "-q", "-m", step.message];
      if (step.amend === true) args.push("--amend");
      if (step.allowEmpty === true) args.push("--allow-empty");
      fixture.git(...args);
      return CLEAN;
    }

    case "branch": {
      if (step.checkout === true) {
        const args = ["checkout", "-q", step.force === true ? "-B" : "-b", step.name];
        if (step.startPoint !== undefined) args.push(step.startPoint);
        fixture.git(...args);
        return CLEAN;
      }
      const args = ["branch"];
      if (step.force === true) args.push("--force");
      args.push(step.name);
      if (step.startPoint !== undefined) args.push(step.startPoint);
      fixture.git(...args);
      return CLEAN;
    }
    case "branchDelete":
      fixture.git("branch", "-D", step.name);
      return CLEAN;
    case "checkout": {
      const args = ["checkout", "-q"];
      if (step.force === true) args.push("--force");
      args.push(step.ref);
      if (step.paths !== undefined && step.paths.length > 0) args.push("--", ...step.paths);
      fixture.git(...args);
      return CLEAN;
    }
    case "tag": {
      const args = ["tag"];
      if (step.force === true) args.push("--force");
      args.push(step.name);
      if (step.object !== undefined) args.push(step.object);
      fixture.git(...args);
      return CLEAN;
    }
    case "tagDelete":
      fixture.git("tag", "-d", step.name);
      return CLEAN;

    case "merge": {
      const args = ["merge", "-q", "-m", mergeMessage(step.message, step.theirs)];
      if (step.fastForwardOnly === true) args.push("--ff-only");
      else if (step.fastForward === false) args.push("--no-ff");
      if (step.commit === false) args.push("--no-commit");
      args.push(step.theirs);
      return integrationOutcome(fixture, args);
    }
    case "mergeContinue": {
      // `merge --continue` refuses a merge that never conflicted, and a
      // plain commit is what finalises both shapes.
      const args =
        step.message === undefined
          ? ["commit", "-q", "--no-edit"]
          : ["commit", "-q", "-m", step.message];
      return integrationOutcome(fixture, args);
    }
    case "mergeAbort":
      fixture.git("merge", "--abort");
      return CLEAN;

    case "cherryPick": {
      const args = ["cherry-pick"];
      if (step.mainline !== undefined) args.push("-m", String(step.mainline));
      args.push(step.source);
      return integrationOutcome(fixture, args);
    }
    case "cherryPickContinue":
      return integrationOutcome(fixture, ["cherry-pick", "--continue", "--no-edit"]);
    case "cherryPickSkip":
      return integrationOutcome(fixture, ["cherry-pick", "--skip"]);
    case "cherryPickAbort":
      fixture.git("cherry-pick", "--abort");
      return CLEAN;

    case "revert": {
      const args = ["revert", "--no-edit"];
      if (step.mainline !== undefined) args.push("-m", String(step.mainline));
      args.push(step.source);
      return integrationOutcome(fixture, args);
    }
    case "revertContinue":
      return integrationOutcome(fixture, ["revert", "--continue", "--no-edit"]);
    case "revertSkip":
      return integrationOutcome(fixture, ["revert", "--skip"]);
    case "revertAbort":
      fixture.git("revert", "--abort");
      return CLEAN;

    case "rebase":
      return integrationOutcome(fixture, ["rebase", "-q", step.upstream]);
    case "rebaseContinue":
      return integrationOutcome(fixture, ["rebase", "--continue"]);
    case "rebaseSkip":
      return integrationOutcome(fixture, ["rebase", "--skip"]);
    case "rebaseAbort":
      fixture.git("rebase", "--abort");
      return CLEAN;

    case "fetch": {
      const args = ["fetch", "-q"];
      if (step.prune === true) args.push("--prune");
      if (step.tags === true) args.push("--tags");
      args.push(step.remote ?? "origin");
      fixture.git(...args);
      return CLEAN;
    }
    case "pull": {
      // `git pull` takes no `-m`, so pull is spelled out as what it is: a
      // fetch followed by a merge of the upstream, which also lets the
      // message reach the merge commit the same way it does on a merge step.
      fixture.git("fetch", "-q", "origin");
      const args = ["merge", "-q", "-m", step.message ?? "Merge origin"];
      if (step.fastForwardOnly === true) args.push("--ff-only");
      else if (step.fastForward === false) args.push("--no-ff");
      args.push(fixture.git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"));
      return integrationOutcome(fixture, args);
    }
    case "push": {
      const args = ["push", "-q"];
      if (step.force === true) args.push("--force");
      if (step.delete === true) args.push("--delete");
      args.push("origin");
      args.push(step.remoteRef === undefined ? currentBranchOf(fixture) : refspecFor(step));
      return integrationOutcome(fixture, args);
    }

    case "peer":
      step.act(world.peerG);
      return CLEAN;
    case "reopen":
      // kompjutr-only: git holds nothing in memory between commands.
      return CLEAN;
    case "custom":
      step.mirror(fixture);
      return CLEAN;
  }
}

function refspecFor(step: { ref?: string; remoteRef?: string }): string {
  const source = step.ref ?? "HEAD";
  return step.remoteRef === undefined ? source : `${source}:${step.remoteRef}`;
}

function currentBranchOf(fixture: GitFixture): string {
  return fixture.git("rev-parse", "--abbrev-ref", "HEAD");
}

/**
 * Run a git command that may legitimately conflict. A non-zero exit with
 * unmerged index entries behind it is a conflict; anything else is a
 * failure, and is rethrown so the codes stay comparable.
 */
function integrationOutcome(fixture: GitFixture, args: string[]): Outcome {
  try {
    fixture.git(...args);
    return CLEAN;
  } catch (error) {
    if (fixture.git("ls-files", "-u") !== "") return CONFLICTED;
    throw error;
  }
}

// -- snapshots ---------------------------------------------------------

async function snapshotKompjutr(
  workspace: Workspace,
  storage: SqliteTestStorage,
  origin: GitFixture,
): Promise<E2ESnapshot> {
  const git = workspace.git;
  const context = probeContext(workspace, storage);
  const repo = openRepository(context, WORK);
  const head = repo.store.getRef("HEAD") === null ? null : safeOid(repo);

  const report = statusReport(repo, context.worktree, { untrackedFiles: "normal" });
  const branch: StatusBranch | undefined = undefined;

  return {
    head,
    currentBranch: (await git.currentBranch({ dir: WORK, fullname: true })) ?? null,
    refs: comparableRefs(
      repo.store
        .listRefs("refs/")
        .map((row) => ({ name: row.name, oid: row.target }))
        .filter((ref) => !ref.oid.startsWith("ref: ")),
    ),
    originRefs: gitRefsOf(origin),
    index: await git.lsFiles({ dir: WORK }),
    // `GitFixture.git` trims its output; trim ours to match.
    status: formatPorcelainV2(report.entries, branch).trimEnd(),
    worktree: await kompjutrWorktree(workspace),
    log: await kompjutrLog(git, head),
    operation: repo.store.readOperationState()?.kind ?? null,
  };
}

function safeOid(repo: ReturnType<typeof openRepository>): string | null {
  try {
    return repo.head().oid;
  } catch {
    return null;
  }
}

/**
 * A fresh database handle for every snapshot, so a reader never answers from
 * a cache the operation under test populated.
 */
function probeContext(workspace: Workspace, storage: SqliteTestStorage): GitContext {
  return {
    database: new SqliteGitDatabase(new Database(storage)),
    worktree: workspace.filesystem,
    sparseWorkspace: createSqliteSparseWorkspaceSource(workspace.db),
    now: () => FIXED_TIME,
    timezoneOffset: () => 0,
  };
}

async function kompjutrWorktree(workspace: Workspace): Promise<WorktreeState[]> {
  const out: WorktreeState[] = [];
  for (const entry of await workspace.fs.walk(WORK)) {
    const path = entry.path.slice(WORK.length + 1);
    if (path === "") continue;
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

const LOG_DEPTH = 64;

async function kompjutrLog(git: Git, head: string | null): Promise<LogEntry[]> {
  if (head === null) return [];
  const commits = await git.log({ dir: WORK, depth: LOG_DEPTH });
  return commits.map((commit) => ({
    oid: commit.oid,
    message: commit.message.trimEnd(),
    parents: commit.parent,
  }));
}

async function snapshotGit(fixture: GitFixture, origin: GitFixture): Promise<E2ESnapshot> {
  const head = tryGit(fixture, "rev-parse", "--verify", "--quiet", "HEAD");
  return {
    head,
    currentBranch: tryGit(fixture, "symbolic-ref", "--quiet", "HEAD"),
    refs: comparableRefs(gitRefsOf(fixture)),
    originRefs: gitRefsOf(origin),
    // `ls-files` repeats an unmerged path once per stage; kompjutr's
    // `lsFiles` reports distinct paths. The stages themselves are compared
    // through the porcelain v2 `u` rows, which carry all three OIDs.
    index: distinct(nulRecords(fixture.gitBinary("ls-files", "-z"))),
    status: fixture.git("status", "--porcelain=v2", "--untracked-files=normal"),
    worktree: gitWorktree(fixture),
    log: gitLog(fixture, head),
    operation: gitOperation(fixture),
  };
}

function tryGit(fixture: GitFixture, ...args: string[]): string | null {
  try {
    const out = fixture.git(...args);
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function gitRefsOf(fixture: GitFixture): RefState[] {
  const output = fixture.git("for-each-ref", "--format=%(refname)%09%(objectname)");
  if (output === "") return [];
  const refs = output.split("\n").map((line) => {
    const tab = line.indexOf("\t");
    if (tab === -1) throw new Error(`invalid for-each-ref output: ${line}`);
    return { name: line.slice(0, tab), oid: line.slice(tab + 1) };
  });
  return comparableRefs(refs);
}

function comparableRefs(refs: RefState[]): RefState[] {
  return refs
    .filter((ref) => !REMOTE_HEAD.test(ref.name))
    .sort((left, right) => comparePaths(left.name, right.name));
}

function gitLog(fixture: GitFixture, head: string | null): LogEntry[] {
  if (head === null) return [];
  const output = fixture.git(
    "log",
    `--max-count=${LOG_DEPTH}`,
    "--format=%H%x09%P%x09%B%x00",
    head,
  );
  return output
    .split("\0")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const parts = record.split("\t");
      const oid = parts[0] ?? "";
      const parents = parts[1] ?? "";
      return {
        oid,
        message: (parts[2] ?? "").trimEnd(),
        parents: parents === "" ? [] : parents.split(" "),
      };
    });
}

function gitOperation(fixture: GitFixture): E2ESnapshot["operation"] {
  const gitDir = join(fixture.dir, ".git");
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  return null;
}

function distinct(paths: string[]): string[] {
  return [...new Set(paths)];
}

function nulRecords(bytes: Uint8Array): string[] {
  const output = Buffer.from(bytes).toString("utf8");
  if (output === "") return [];
  const records = output.split("\0");
  if (records[records.length - 1] === "") records.pop();
  return records;
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
