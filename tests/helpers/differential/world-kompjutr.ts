// Each op on kompjutr's local composition, through the typed API or the
// strict argv runner where the typed API has no matching shape.

import type { LocalWorkspace } from "@kompjutr/local";
import type { Git } from "../../../packages/git/src/client.js";
import { movePath, removePath, writeFile, writeSymlink } from "./disk.js";
import { contentBytes, type Op } from "./ops.js";
import { CLEAN, EMPTY, type Outcome, STOPPED } from "./outcome.js";
import { kompjutrOperation } from "./snapshot.js";

export async function capture(run: () => Promise<Outcome>): Promise<Outcome> {
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

export async function applyKompjutr(workspace: LocalWorkspace, op: Op): Promise<Outcome> {
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
    case "maintenance":
      await git.maintenance({});
      return CLEAN;
    case "peerCommit":
    case "reopen":
      throw new Error(`${op.op} is played by the world`);
  }
}
