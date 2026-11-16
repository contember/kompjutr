// Each op on the real git binary.

import type { GitFixture } from "../git.js";
import { movePath, removePath, writeFile, writeSymlink } from "./disk.js";
import { contentBytes, type Op } from "./ops.js";
import { CLEAN, EMPTY, type Outcome, STOPPED } from "./outcome.js";
import { gitOperation } from "./snapshot.js";

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
  // Known divergences match git's English messages.
  const result = fixture.gitInputResultWithEnv("", { LC_ALL: "C" }, ...args);
  if (result.status === 0) return CLEAN;
  // 128 is a refusal; 1 stopped on a conflict, or found nothing to do.
  if (INTEGRATION.has(op.op) && result.status === 1) {
    if (gitOperation(fixture) !== null) return STOPPED;
    if (op.op === "revert" || op.op === "revertContinue") return EMPTY;
  }
  return { kind: "failed", detail: `exit ${result.status}: ${result.stderr.trim()}` };
}

export function applyGit(fixture: GitFixture, op: Op): Outcome {
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
      // `commit` stands in for `merge --continue`, which cannot take a message.
      if (gitOperation(fixture) !== "merge") {
        return { kind: "failed", detail: "There is no merge in progress (MERGE_HEAD missing)." };
      }
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
      // kompjutr resolves the upstream before fetching (git-support.md,
      // `git pull`); git fetches first, so ask for the upstream up front.
      const branch = fixture.gitResult("symbolic-ref", "--quiet", "--short", "HEAD");
      const merge = fixture.gitResult("config", `branch.${branch.stdout.trim()}.merge`);
      if (branch.status !== 0 || merge.status !== 0) {
        return { kind: "failed", detail: "no upstream" };
      }
      const fetched = run(fixture, op, ["fetch", "-q", "origin"]);
      if (fetched.kind !== "clean") return fetched;
      const upstream = fixture.gitResult("rev-parse", "--verify", "--quiet", "@{upstream}");
      if (upstream.status !== 0) return { kind: "failed", detail: "no upstream" };
      const args = ["merge", "-q", "-m", op.message];
      if (op.mode === "no-ff") args.push("--no-ff");
      if (op.mode === "ff-only") args.push("--ff-only");
      return run(fixture, op, [...args, upstream.stdout.trim()]);
    }
    case "maintenance":
      return run(fixture, op, ["gc", "-q"]);
    case "reopen":
      // kompjutr-only: git holds nothing in memory between commands.
      return CLEAN;
    case "peerCommit":
      throw new Error("peerCommit is played by the world");
  }
}
