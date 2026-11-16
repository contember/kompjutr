import type { LocalWorkspace } from "@kompjutr/local";
import type { Git } from "../../../packages/git/src/client.js";
import { type LocalFixture, localFixture } from "../../local/helpers.js";
import { GitFixture } from "../git.js";
import type { GitServer } from "../http-backend.js";
import { startGitServer } from "../http-backend.js";
import { movePath, removePath, writeFile, writeSymlink } from "./disk.js";
import { contentBytes, type Op, type WorldStart } from "./ops.js";
import { FIXED_TIME, gitOperation, kompjutrOperation } from "./snapshot.js";

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };

/**
 * `stopped` is an integration that paused for the user — a conflict, or an
 * empty cherry-pick waiting for skip — and `empty` a revert that had nothing
 * to undo and left no state behind. git reports both with exit status 1;
 * kompjutr returns a result object.
 */
export type OutcomeKind = "clean" | "stopped" | "empty" | "failed";

export interface Outcome {
  kind: OutcomeKind;
  /** kompjutr's stable `error.code`, or git's exit status. */
  detail?: string;
  /** kompjutr threw something without a stable `code`. */
  crash?: boolean;
}

export interface DifferentialWorld {
  readonly start: WorldStart;
  readonly workspace: LocalWorkspace;
  readonly root: string;
  readonly mirror: GitFixture;
  readonly origins: { kompjutr: GitFixture; git: GitFixture } | null;
  applyKompjutr(op: Op): Promise<Outcome>;
  applyGit(op: Op): Outcome;
  dispose(): Promise<void>;
}

/** What a cloned world's origin holds before either side clones it. */
function seedOrigin(seed: GitFixture): void {
  seed.write("README.md", "seed\n").write("dir/x.txt", "alpha\nbeta\ngamma\n");
  seed.commit("seed");
  seed.git("checkout", "-q", "-b", "feature");
  seed.write("dir/y.txt", "feature\n").commit("feature work");
  seed.git("checkout", "-q", "main");
  seed.write("README.md", "seed\nmain\n").commit("main work");
}

export async function createWorld(start: WorldStart): Promise<DifferentialWorld> {
  const fixtures: GitFixture[] = [];
  const track = (fixture: GitFixture): GitFixture => {
    fixtures.push(fixture);
    return fixture;
  };
  const local: LocalFixture = localFixture();
  const open = (): LocalWorkspace =>
    local.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
  let workspace = open();
  const mirror = track(new GitFixture());
  let server: GitServer | null = null;
  let origins: DifferentialWorld["origins"] = null;
  let peers: { kompjutr: GitFixture; git: GitFixture } | null = null;

  try {
    if (start === "clone") {
      const seed = track(new GitFixture().init());
      seedOrigin(seed);
      origins = { kompjutr: track(bareClone(seed)), git: track(bareClone(seed)) };
      peers = { kompjutr: track(new GitFixture()), git: track(new GitFixture()) };
      peers.kompjutr.git("clone", "-q", origins.kompjutr.dir, ".");
      peers.git.git("clone", "-q", origins.git.dir, ".");
      server = await startGitServer(origins.kompjutr.dir);
      // kompjutr's clone defaults are shallow, single-branch and tagless;
      // ask for the shape `git clone` produces.
      await workspace.git.clone({
        url: server.url,
        dir: "/",
        depth: 0,
        singleBranch: false,
        noTags: false,
      });
      mirror.git("clone", "-q", origins.git.dir, ".");
      mirror.git("config", "core.autocrlf", "false");
    } else {
      await workspace.git.init();
      mirror.init("main");
    }
  } catch (error) {
    workspace.close();
    await server?.close();
    for (const fixture of fixtures) fixture.dispose();
    local.dispose();
    throw error;
  }

  const world: DifferentialWorld = {
    start,
    get workspace() {
      return workspace;
    },
    root: local.root,
    mirror,
    origins,
    async applyKompjutr(op) {
      if (op.op === "reopen") {
        workspace.close();
        workspace = open();
        return CLEAN;
      }
      if (op.op === "peerCommit") return peerCommit(peers?.kompjutr, op);
      return capture(() => applyKompjutr(workspace, op));
    },
    applyGit(op) {
      if (op.op === "peerCommit") return peerCommit(peers?.git, op);
      return applyGit(mirror, op);
    },
    async dispose() {
      workspace.close();
      await server?.close();
      for (const fixture of fixtures) fixture.dispose();
      local.dispose();
    },
  };
  return world;
}

function bareClone(source: GitFixture): GitFixture {
  const bare = new GitFixture();
  bare.git("clone", "--bare", "-q", source.dir, ".");
  return bare;
}

const CLEAN: Outcome = { kind: "clean" };
const STOPPED: Outcome = { kind: "stopped" };
const EMPTY: Outcome = { kind: "empty" };

async function capture(run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await run();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof code === "string") return { kind: "failed", detail: `${code}: ${message}` };
    return { kind: "failed", detail: message, crash: true };
  }
}

/** Real git plays the colleague on one side; both sides get the same commit. */
function peerCommit(peer: GitFixture | undefined, op: Extract<Op, { op: "peerCommit" }>): Outcome {
  if (peer === undefined) throw new Error("peerCommit needs a cloned world");
  peer.git("fetch", "-q", "origin");
  const remote = `origin/${op.branch}`;
  const exists = peer.gitResult("rev-parse", "--verify", "--quiet", remote).status === 0;
  peer.git("checkout", "-q", "-B", op.branch, exists ? remote : "origin/main");
  writeFile(peer.dir, op.path, contentBytes(op.content), false);
  peer.git("add", "-A");
  peer.git("commit", "-q", "--allow-empty", "-m", op.message);
  peer.git("push", "-q", "origin", op.branch);
  return CLEAN;
}

// -- kompjutr ----------------------------------------------------------

async function cli(git: Git, argv: string[]): Promise<Outcome> {
  const result = await git.runCli({ argv, cwd: "/" });
  if (result.exitCode === 0) return CLEAN;
  return { kind: "failed", detail: `exit ${result.exitCode}: ${result.stderr.trim()}` };
}

function merged(result: { conflicted?: boolean }): Outcome {
  return result.conflicted === true ? STOPPED : CLEAN;
}

function replayed(result: { outcome: string }, pending: boolean): Outcome {
  if (result.outcome === "conflicted") return STOPPED;
  // A suspended empty cherry-pick waits for skip, as git's does.
  if (result.outcome === "empty") return pending ? STOPPED : EMPTY;
  return CLEAN;
}

async function applyKompjutr(workspace: LocalWorkspace, op: Op): Promise<Outcome> {
  const { git, root } = workspace;
  const pending = (): boolean => kompjutrOperation(workspace) !== null;
  switch (op.op) {
    case "write":
      writeFile(root, op.path, contentBytes(op.content), op.executable === true);
      return CLEAN;
    case "remove":
      removePath(root, op.path);
      return CLEAN;
    case "symlink":
      writeSymlink(root, op.path, op.target);
      return CLEAN;
    case "add":
      await git.add({ paths: op.paths });
      return CLEAN;
    case "addAll":
      await git.add({ paths: [], all: true, trackedOnly: op.update === true });
      return CLEAN;
    case "rm":
      await git.rm({
        paths: op.paths,
        cached: op.cached,
        recursive: op.recursive,
        force: op.force,
      });
      return CLEAN;
    case "mv":
      // kompjutr has no `mv`; a rename on disk staged by path is what a
      // caller does instead, and both sides do exactly that.
      movePath(root, op.from, op.to);
      await git.add({ paths: [op.from, op.to] });
      return CLEAN;
    case "commit":
      if (op.all === true) {
        const argv = ["commit", "-a", "-m", op.message];
        if (op.amend === true) argv.push("--amend");
        if (op.allowEmpty === true) argv.push("--allow-empty");
        return cli(git, argv);
      }
      await git.commit({ message: op.message, amend: op.amend, allowEmpty: op.allowEmpty });
      return CLEAN;
    case "reset": {
      // The typed reset leaves HEAD alone; the argv runner moves it as git does.
      const argv = ["reset"];
      if (op.hard === true) argv.push("--hard");
      if (op.ref !== undefined) argv.push(op.ref);
      if (op.paths !== undefined) argv.push("--", ...op.paths);
      return cli(git, argv);
    }
    case "clean":
      await git.clean({ directories: op.directories });
      return CLEAN;
    case "branch":
      await git.branch({ name: op.name, startPoint: op.startPoint, force: op.force });
      return CLEAN;
    case "branchDelete":
      await git.branchDelete({ name: op.name, force: op.force });
      return CLEAN;
    case "branchRename":
      await git.branchRename({ oldName: op.from, newName: op.to });
      return CLEAN;
    case "checkout":
      await git.checkout({ ref: op.ref, force: op.force });
      return CLEAN;
    case "checkoutNew": {
      const argv = ["checkout", "-b", op.name];
      if (op.startPoint !== undefined) argv.push(op.startPoint);
      return cli(git, argv);
    }
    case "checkoutPaths":
      await git.checkout({ ref: op.ref, paths: op.paths });
      return CLEAN;
    case "tag":
      await git.tag({ name: op.name, object: op.object, force: op.force });
      return CLEAN;
    case "tagDelete":
      await git.tagDelete({ name: op.name });
      return CLEAN;
    case "merge":
      return merged(
        await git.merge({
          theirs: op.theirs,
          message: op.message,
          fastForward: op.mode === "no-ff" ? false : undefined,
          fastForwardOnly: op.mode === "ff-only" ? true : undefined,
          commit: op.noCommit === true ? false : undefined,
        }),
      );
    case "mergeContinue":
      return merged(await git.mergeContinue({ message: op.message }));
    case "mergeAbort":
      await git.mergeAbort({});
      return CLEAN;
    case "cherryPick":
      return replayed(await git.cherryPick({ source: op.source }), pending());
    case "cherryPickContinue":
      return replayed(await git.cherryPickContinue({}), pending());
    case "cherryPickSkip":
      await git.cherryPickSkip({});
      return CLEAN;
    case "cherryPickAbort":
      await git.cherryPickAbort({});
      return CLEAN;
    case "revert":
      return replayed(await git.revert({ source: op.source }), pending());
    case "revertContinue":
      return replayed(await git.revertContinue({}), pending());
    case "revertSkip":
      await git.revertSkip({});
      return CLEAN;
    case "revertAbort":
      await git.revertAbort({});
      return CLEAN;
    case "rebase":
      return replayed(await git.rebase({ upstream: op.upstream }), false);
    case "rebaseContinue":
      return replayed(await git.rebaseContinue({}), false);
    case "rebaseSkip":
      return replayed(await git.rebaseSkip({}), false);
    case "rebaseAbort":
      await git.rebaseAbort({});
      return CLEAN;
    case "fetch":
      await git.fetch({ remote: "origin", prune: op.prune });
      return CLEAN;
    case "push": {
      const result = await git.push({ ref: op.ref, force: op.force, delete: op.delete });
      // A rejected push resolves; normalise it to git's non-zero exit.
      return result.ok ? CLEAN : { kind: "failed", detail: result.error ?? "rejected" };
    }
    case "pull": {
      const pulled = await git.pull({
        message: op.message,
        fastForward: op.mode === "no-ff" ? false : undefined,
        fastForwardOnly: op.mode === "ff-only" ? true : undefined,
      });
      if (pulled.strategy !== "merge") throw new Error("merge pull selected rebase");
      return merged(pulled.result);
    }
    case "peerCommit":
    case "reopen":
      throw new Error(`${op.op} is played by the world`);
  }
}

// -- real git ----------------------------------------------------------

/** Ops after which a non-zero exit may leave an integration paused. */
const INTEGRATION = new Set<Op["op"]>([
  "merge",
  "mergeContinue",
  "cherryPick",
  "cherryPickContinue",
  "cherryPickSkip",
  "revert",
  "revertContinue",
  "revertSkip",
  "rebase",
  "rebaseContinue",
  "rebaseSkip",
  "pull",
]);

function run(fixture: GitFixture, op: Op, args: string[]): Outcome {
  const result = fixture.gitResult(...args);
  if (result.status === 0) return CLEAN;
  // 128 is a refusal; 1 stopped on a conflict, or found nothing to do.
  if (INTEGRATION.has(op.op) && result.status === 1) {
    if (gitOperation(fixture) !== null) return STOPPED;
    if (op.op === "revert" || op.op === "revertContinue") return EMPTY;
  }
  return { kind: "failed", detail: `exit ${result.status}: ${result.stderr.trim()}` };
}

function applyGit(fixture: GitFixture, op: Op): Outcome {
  const root = fixture.dir;
  switch (op.op) {
    case "write":
      writeFile(root, op.path, contentBytes(op.content), op.executable === true);
      return CLEAN;
    case "remove":
      removePath(root, op.path);
      return CLEAN;
    case "symlink":
      writeSymlink(root, op.path, op.target);
      return CLEAN;
    case "add":
      return run(fixture, op, ["add", "--", ...op.paths]);
    case "addAll":
      return run(fixture, op, ["add", op.update === true ? "--update" : "--all"]);
    case "rm": {
      const args = ["rm", "-q"];
      if (op.cached === true) args.push("--cached");
      if (op.recursive === true) args.push("-r");
      if (op.force === true) args.push("-f");
      return run(fixture, op, [...args, "--", ...op.paths]);
    }
    case "mv":
      movePath(root, op.from, op.to);
      return run(fixture, op, ["add", "--", op.from, op.to]);
    case "commit": {
      const args = ["commit", "-q", "-m", op.message];
      if (op.all === true) args.push("-a");
      if (op.amend === true) args.push("--amend");
      if (op.allowEmpty === true) args.push("--allow-empty");
      return run(fixture, op, args);
    }
    case "reset": {
      const args = ["reset", "-q"];
      if (op.hard === true) args.push("--hard");
      if (op.ref !== undefined) args.push(op.ref);
      if (op.paths !== undefined) args.push("--", ...op.paths);
      return run(fixture, op, args);
    }
    case "clean":
      return run(
        fixture,
        op,
        op.directories === true ? ["clean", "-q", "-f", "-d"] : ["clean", "-q", "-f"],
      );
    case "branch": {
      const args = ["branch"];
      if (op.force === true) args.push("--force");
      args.push(op.name);
      if (op.startPoint !== undefined) args.push(op.startPoint);
      return run(fixture, op, args);
    }
    case "branchDelete":
      return run(fixture, op, ["branch", op.force === true ? "-D" : "-d", op.name]);
    case "branchRename":
      return run(fixture, op, ["branch", "-m", op.from, op.to]);
    case "checkout": {
      // --no-guess: kompjutr never invents a local branch from a remote one.
      const args = ["checkout", "-q", "--no-guess"];
      if (op.force === true) args.push("--force");
      return run(fixture, op, [...args, op.ref, "--"]);
    }
    case "checkoutNew": {
      const args = ["checkout", "-q", "-b", op.name];
      if (op.startPoint !== undefined) args.push(op.startPoint);
      return run(fixture, op, args);
    }
    case "checkoutPaths":
      return run(fixture, op, ["checkout", "-q", op.ref, "--", ...op.paths]);
    case "tag": {
      const args = ["tag"];
      if (op.force === true) args.push("--force");
      args.push(op.name);
      if (op.object !== undefined) args.push(op.object);
      return run(fixture, op, args);
    }
    case "tagDelete":
      return run(fixture, op, ["tag", "-d", op.name]);
    case "merge": {
      const args = ["merge", "-q", "-m", op.message];
      if (op.mode === "no-ff") args.push("--no-ff");
      if (op.mode === "ff-only") args.push("--ff-only");
      if (op.noCommit === true) args.push("--no-commit");
      return run(fixture, op, [...args, op.theirs]);
    }
    case "mergeContinue":
      return run(fixture, op, ["commit", "-q", "-m", op.message]);
    case "mergeAbort":
      return run(fixture, op, ["merge", "--abort"]);
    case "cherryPick":
      return run(fixture, op, ["cherry-pick", op.source]);
    case "cherryPickContinue":
      return run(fixture, op, ["cherry-pick", "--continue", "--no-edit"]);
    case "cherryPickSkip":
      return run(fixture, op, ["cherry-pick", "--skip"]);
    case "cherryPickAbort":
      return run(fixture, op, ["cherry-pick", "--abort"]);
    case "revert":
      return run(fixture, op, ["revert", "--no-edit", op.source]);
    case "revertContinue":
      return run(fixture, op, ["revert", "--continue", "--no-edit"]);
    case "revertSkip":
      return run(fixture, op, ["revert", "--skip"]);
    case "revertAbort":
      return run(fixture, op, ["revert", "--abort"]);
    case "rebase":
      return run(fixture, op, ["rebase", "-q", op.upstream]);
    case "rebaseContinue":
      return run(fixture, op, ["-c", "core.editor=true", "rebase", "--continue"]);
    case "rebaseSkip":
      return run(fixture, op, ["rebase", "--skip"]);
    case "rebaseAbort":
      return run(fixture, op, ["rebase", "--abort"]);
    case "fetch":
      return run(
        fixture,
        op,
        op.prune === true ? ["fetch", "-q", "--prune", "origin"] : ["fetch", "-q", "origin"],
      );
    case "push": {
      const args = ["push", "-q"];
      if (op.force === true) args.push("--force");
      args.push("origin");
      return run(
        fixture,
        op,
        op.delete === true ? [...args, "--delete", op.ref] : [...args, op.ref],
      );
    }
    case "pull": {
      // `git pull` takes no `-m`: spell it as the fetch and merge it is, and
      // merge by OID so a conflict hunk is labelled as kompjutr labels it.
      const fetched = run(fixture, op, ["fetch", "-q", "origin"]);
      if (fetched.kind !== "clean") return fetched;
      const upstream = fixture.gitResult("rev-parse", "--verify", "--quiet", "@{upstream}");
      if (upstream.status !== 0) return { kind: "failed", detail: "no upstream" };
      const args = ["merge", "-q", "-m", op.message];
      if (op.mode === "no-ff") args.push("--no-ff");
      if (op.mode === "ff-only") args.push("--ff-only");
      return run(fixture, op, [...args, upstream.stdout.trim()]);
    }
    case "reopen":
      // kompjutr-only: git holds nothing in memory between commands.
      return CLEAN;
    case "peerCommit":
      throw new Error("peerCommit is played by the world");
  }
}
