import { errorCode, hasErrorCode } from "../../common/errors.js";
import { type GitContext, nestedRoots } from "../../ops/core/context.js";
import type { Repository } from "../../ops/repository/repository.js";
import type { AddLiteralPathsResult } from "../../ops/staging/staging.js";
import { eagerStatus } from "../../ops/status/status.js";
import { formatCommitRefusalStatus, statusFormatOptions } from "../../ops/status/status-format.js";
import { type GitCliOutputContext, gitCliDiagnosticResult, gitCliResult } from "../result.js";
import type { GitCliEnvironment, GitCliResult, ResolvedGitCliRunOptions } from "../types.js";
import {
  stderrOutput,
  stdoutOutput,
  type TruncatingOutput,
  truncatedResult,
} from "./write-output.js";
import type { ResolvedAddPath } from "./write-runtime.js";
import { branchLabel } from "./write-summary.js";

export function formatAddResult(
  result: AddLiteralPathsResult,
  options: ResolvedGitCliRunOptions,
): GitCliResult {
  if (result.outcome === "staged") return gitCliResult("", "", 0);
  const stderr = stderrOutput(options);
  stderr.append("The following paths are ignored by one of your .gitignore files:\n");
  for (const path of result.paths) stderr.append(`${path}\n`);
  stderr.append("hint: Use -f if you really want to add them.\n");
  stderr.append('hint: Disable this message with "git config set advice.addIgnoredFile false"\n');
  return truncatedResult(undefined, stderr, 1);
}

export function mapAddFailure(
  error: unknown,
  paths: readonly ResolvedAddPath[],
  output: GitCliOutputContext,
): GitCliResult | undefined {
  const message = errorMessage(error);
  if (hasErrorCode(error, "EPATHOUTSIDE") && message !== undefined) {
    return gitCliDiagnosticResult("fatal: ", message, "\n", 128, output);
  }
  if (hasErrorCode(error, "EPATHSPEC") && message !== undefined) {
    if (output.options.discardStderr) {
      return gitCliDiagnosticResult("", "", "", 128, output);
    }
    for (const path of paths) {
      const prefix = "pathspec '";
      const suffix = "' did not match any files";
      if (
        message.length === prefix.length + path.path.length + suffix.length &&
        message.startsWith(prefix) &&
        message.startsWith(path.path, prefix.length) &&
        message.endsWith(suffix)
      ) {
        return gitCliDiagnosticResult(
          "fatal: pathspec '",
          path.input,
          "' did not match any files\n",
          128,
          output,
        );
      }
    }
    return gitCliDiagnosticResult("fatal: ", message, "\n", 128, output);
  }
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}

export function mapCommitFailure(
  context: GitContext,
  repo: Repository,
  error: unknown,
  options: ResolvedGitCliRunOptions,
): GitCliResult | undefined {
  if (hasErrorCode(error, "EMSG")) {
    return gitCliResult("", "Aborting commit due to empty commit message.\n", 1);
  }
  if (hasErrorCode(error, "EEMPTYCOMMIT")) {
    return gitCliResult(cleanCommitRefusal(context, repo), "", 1);
  }
  if (hasErrorCode(error, "EUNMERGED")) {
    const stderr = stderrOutput(options);
    stderr.append(
      "error: Committing is not possible because you have unmerged files.\n" +
        "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
        "hint: as appropriate to mark resolution and make a commit.\n" +
        "fatal: Exiting because of an unresolved conflict.\n",
    );
    return truncatedResult(unmergedPaths(repo, options), stderr, 128);
  }
  if (hasErrorCode(error, "EIDENTITY")) {
    return gitCliResult(
      "",
      "Author identity unknown\n\n" +
        "*** Please tell me who you are.\n\n" +
        "Run\n\n" +
        '  git config --global user.email "you@example.com"\n' +
        '  git config --global user.name "Your Name"\n\n' +
        "to set your account's default identity.\n" +
        "Omit --global to set the identity only in this repository.\n\n" +
        "fatal: unable to auto-detect email address\n",
      128,
    );
  }
  if (hasErrorCode(error, "EOPACTIVE")) {
    return gitCliResult("", "fatal: cannot commit while another operation is in progress\n", 128);
  }
  if (hasErrorCode(error, "ENOCOMMIT")) {
    return gitCliResult("", "fatal: You have nothing to amend.\n", 128);
  }
  return undefined;
}

export function mapRebaseFailure(error: unknown): GitCliResult | undefined {
  if (hasErrorCode(error, "ENOREBASE") || hasErrorCode(error, "EOPMISMATCH")) {
    return gitCliResult("", "fatal: no rebase in progress\n", 128);
  }
  return undefined;
}

/** `merge --abort` is Git's `reset --merge`, which prefixes its refusal with the reset failure. */
export function mapMergeAbortFailure(
  error: unknown,
  output: GitCliOutputContext,
): GitCliResult | undefined {
  const message = errorMessage(error);
  if (hasErrorCode(error, "ECHECKOUTFAIL") && message !== undefined) {
    return gitCliDiagnosticResult(
      "error: ",
      message,
      "\nfatal: Could not reset index file to revision 'HEAD'.\n",
      128,
      output,
    );
  }
  return mapMergeFailure(error, output);
}

export function mapMergeFailure(
  error: unknown,
  output: GitCliOutputContext,
): GitCliResult | undefined {
  if (hasErrorCode(error, "EUNMERGED")) {
    return gitCliDiagnosticResult(
      "fatal: Exiting because of an unresolved conflict.\n",
      "",
      "",
      128,
      output,
    );
  }
  if (hasErrorCode(error, "EOPMISMATCH") || hasErrorCode(error, "ENOMERGE")) {
    return gitCliDiagnosticResult(
      "fatal: There is no merge in progress (MERGE_HEAD missing).\n",
      "",
      "",
      128,
      output,
    );
  }
  return mapLocalMutationFailure(error, output);
}

export function mapPathMutationFailure(
  error: unknown,
  paths: readonly ResolvedAddPath[],
  output: GitCliOutputContext,
): GitCliResult | undefined {
  const message = errorMessage(error);
  if (hasErrorCode(error, "EPATHSPEC") && message !== undefined) {
    for (const path of paths) {
      if (message.includes(`'${path.path}'`)) {
        return gitCliDiagnosticResult(
          "error: pathspec '",
          path.input,
          "' did not match any file(s) known to git\n",
          1,
          output,
        );
      }
    }
  }
  return mapLocalMutationFailure(error, output);
}

export function mapLocalMutationFailure(
  error: unknown,
  output: GitCliOutputContext,
): GitCliResult | undefined {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (code === undefined || message === undefined || !LOCAL_FAILURE_CODES.has(code))
    return undefined;
  return gitCliDiagnosticResult("fatal: ", message, "\n", 128, output);
}

const LOCAL_FAILURE_CODES = new Set([
  "EINVAL",
  "ENOTFOUND",
  "ENOCOMMIT",
  "EBRANCHFAIL",
  "ECHECKOUTFAIL",
  "EPATHSPEC",
  "EPATHOUTSIDE",
  "EOPACTIVE",
  "EOPMISMATCH",
  "ENOREBASE",
  "EUNMERGED",
  "EDETACHED",
  "ESHALLOW",
  "ESTALE",
  "ESTALEHEAD",
  "EWRONGHEAD",
]);

export function mapRebaseContinueFailure(
  repo: Repository,
  error: unknown,
  options: ResolvedGitCliRunOptions,
): GitCliResult | undefined {
  if (hasErrorCode(error, "EUNMERGED")) {
    return truncatedResult(needsMergePaths(repo, options), undefined, 1);
  }
  return mapRebaseFailure(error);
}

export function environmentRecord(environment: GitCliEnvironment): Record<string, string> {
  const record: Record<string, string> = {};
  if (environment.GIT_AUTHOR_NAME !== undefined) {
    record.GIT_AUTHOR_NAME = environment.GIT_AUTHOR_NAME;
  }
  if (environment.GIT_AUTHOR_EMAIL !== undefined) {
    record.GIT_AUTHOR_EMAIL = environment.GIT_AUTHOR_EMAIL;
  }
  if (environment.GIT_COMMITTER_NAME !== undefined) {
    record.GIT_COMMITTER_NAME = environment.GIT_COMMITTER_NAME;
  }
  if (environment.GIT_COMMITTER_EMAIL !== undefined) {
    record.GIT_COMMITTER_EMAIL = environment.GIT_COMMITTER_EMAIL;
  }
  return record;
}

function cleanCommitRefusal(context: GitContext, repo: Repository): string {
  const branch = branchLabel(repo.head().ref);
  const rows = eagerStatus(
    repo,
    context.worktree,
    { excludeRoots: nestedRoots(context, repo.root) },
    context,
  );
  return formatCommitRefusalStatus(rows, branch, statusFormatOptions(repo));
}

function unmergedPaths(repo: Repository, options: ResolvedGitCliRunOptions): TruncatingOutput {
  const out = stdoutOutput(options);
  let previous: string | undefined;
  for (const entry of repo.checkout.indexScan()) {
    if (entry.stage === 0 || entry.path === previous) continue;
    out.append(`U\t${entry.path}\n`);
    previous = entry.path;
  }
  return out;
}

function needsMergePaths(repo: Repository, options: ResolvedGitCliRunOptions): TruncatingOutput {
  const out = stdoutOutput(options);
  let previous: string | undefined;
  for (const entry of repo.checkout.indexScan()) {
    if (entry.stage === 0 || entry.path === previous) continue;
    out.append(`${entry.path}: needs merge\n`);
    previous = entry.path;
  }
  out.append("You must edit all merge conflicts and then\n");
  out.append("mark them as resolved using git add\n");
  return out;
}
