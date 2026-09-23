import type { GitContext } from "../../ops/core/context.js";
import type { RebaseResult } from "../../ops/core/kinds.js";
import { requireRebaseCursor } from "../../ops/rebase/rebase-lifecycle-baseline.js";
import type { Repository } from "../../ops/repository/repository.js";
import { readOperationStepOwned } from "../../store/operations/operation-journal.js";
import type { RebaseJournalCursor } from "../../store/operations/operation-journal-types.js";
import { gitCliResult } from "../result.js";
import type { GitCliResult, ResolvedGitCliRunOptions } from "../types.js";
import {
  stderrOutput,
  stdoutOutput,
  type TruncatingOutput,
  truncatedResult,
} from "./write-output.js";
import { formatCommit, subject } from "./write-summary.js";

interface RebaseMutation {
  before: RebaseJournalCursor;
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
  const stderr = stderrOutput(options);
  appendRebaseProgress(stderr, before.state.currentStep, before.stepCount, mutation.result);
  if (mutation.result.outcome === "completed") {
    stderr.append(`Successfully rebased and updated ${before.state.originalHeadRef}.\n`);
  } else {
    const step = requireRebaseCursor(repo).step;
    if (step === null) throw new Error("conflicted rebase has no current step");
    const source = repo.readCommit(step.sourceOid);
    stderr.append(
      `error: could not apply ${step.sourceOid.slice(0, 7)}... ${subject(source.message)}\n`,
    );
  }
  const stdout = stdoutOutput(options);
  const commitOid = continuedCommitOid(repo, mutation);
  if (commitOid !== undefined) formatCommit(repo, worktree, commitOid, "detached HEAD", stdout);
  return truncatedResult(stdout, stderr, mutation.result.outcome === "completed" ? 0 : 1);
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
  const step = requireRebaseCursor(repo).step;
  if (step === null) throw new Error("conflicted rebase has no current step");
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
    return readOperationStepOwned(repo.checkout, before.state.currentStep)?.resultOid ?? undefined;
  }
  if (mutation.result.outcome !== "completed") return undefined;
  let current = mutation.result.oid;
  for (let count = 0; count <= before.stepCount; count++) {
    const commit = repo.readCommit(current);
    const parent = commit.parent[0];
    if (parent === before.state.currentParentOid) return current;
    if (parent === undefined) return undefined;
    current = parent;
  }
  throw new Error("completed rebase did not reach its prior replay parent");
}

function appendRebaseProgress(
  out: TruncatingOutput,
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
