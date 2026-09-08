import type { GitContext } from "../../ops/core/context.js";
import type { RebaseResult } from "../../ops/core/kinds.js";
import type { RebaseJournal } from "../../ops/core/operation-state.js";
import type { Repository } from "../../ops/repository/repository.js";
import { gitCliResult, gitCliUtf8ByteLength } from "../result.js";
import type { GitCliResult, ResolvedGitCliRunOptions } from "../types.js";
import {
  BoundedSummaryOutput,
  retainedStderrCeiling,
  retainedStdoutCeiling,
} from "./write-output.js";
import { formatCommit, subject } from "./write-summary.js";

interface RebaseMutation {
  before: RebaseJournal;
  result: RebaseResult;
}

export function formatRebaseContinue(
  repo: Repository,
  worktree: GitContext["worktree"],
  mutation: RebaseMutation,
  options: ResolvedGitCliRunOptions,
): GitCliResult {
  const before = mutation.before;
  if (mutation.result.outcome !== "completed" && mutation.result.outcome !== "conflicted") {
    throw new Error(`rebase continuation returned ${mutation.result.outcome}`);
  }
  let formattedStderr = "";
  if (!options.discardStderr) {
    const stderr = new BoundedSummaryOutput(
      retainedStderrCeiling(options),
      "git CLI rebase stderr",
    );
    appendRebaseProgress(stderr, before.state.currentStep, before.steps.length, mutation.result);
    if (mutation.result.outcome === "completed") {
      stderr.append(`Successfully rebased and updated ${before.state.originalHeadRef}.\n`);
    } else if (mutation.result.outcome === "conflicted") {
      const current = repo.checkout.requireOperationState("rebase");
      const step = current.steps[current.state.currentStep];
      if (step === undefined) throw new Error("conflicted rebase has no current step");
      const source = repo.readCommit(step.sourceOid);
      stderr.append(
        `error: could not apply ${step.sourceOid.slice(0, 7)}... ${subject(source.message)}\n`,
      );
    }
    formattedStderr = stderr.finish();
  }
  const commitOid = continuedCommitOid(repo, mutation);
  const stdout =
    commitOid === undefined
      ? ""
      : formatCommit(
          repo,
          worktree,
          commitOid,
          "detached HEAD",
          retainedStdoutCeiling(options, gitCliUtf8ByteLength(formattedStderr, "stderr", false)),
        );
  return gitCliResult(stdout, formattedStderr, mutation.result.outcome === "completed" ? 0 : 1);
}

export function formatRebaseResult(repo: Repository, result: RebaseResult): GitCliResult {
  if (result.outcome === "up-to-date") {
    return gitCliResult("", "Current branch is up to date.\n", 0);
  }
  if (result.outcome === "completed") {
    const ref = repo.head().ref;
    const destination = ref === null ? "detached HEAD" : ref;
    return gitCliResult("", `Successfully rebased and updated ${destination}.\n`, 0);
  }
  const journal = repo.checkout.requireOperationState("rebase");
  const step = journal.steps[journal.state.currentStep];
  if (step === undefined) throw new Error("conflicted rebase has no current step");
  const source = repo.readCommit(step.sourceOid);
  return gitCliResult(
    "",
    `error: could not apply ${step.sourceOid.slice(0, 7)}... ${subject(source.message)}\n`,
    1,
  );
}

function continuedCommitOid(repo: Repository, mutation: RebaseMutation): string | undefined {
  const before = mutation.before;
  if (mutation.result.outcome === "conflicted") {
    return (
      repo.checkout.requireOperationState("rebase").steps[before.state.currentStep]?.resultOid ??
      undefined
    );
  }
  if (mutation.result.outcome !== "completed") return undefined;
  let current = mutation.result.oid;
  for (let count = 0; count <= before.steps.length; count++) {
    const commit = repo.readCommit(current);
    const parent = commit.parent[0];
    if (parent === before.state.currentParentOid) return current;
    if (parent === undefined) return undefined;
    current = parent;
  }
  throw new Error("completed rebase did not reach its prior replay parent");
}

function appendRebaseProgress(
  out: BoundedSummaryOutput,
  priorStep: number,
  totalSteps: number,
  result: RebaseResult,
): void {
  let finalStep = totalSteps;
  if (result.outcome === "conflicted") finalStep = priorStep + result.replayed + result.skipped + 1;
  for (let step = priorStep + 2; step <= finalStep; step++) {
    out.append(`Rebasing (${step}/${totalSteps})\r`);
  }
}
