import { utf8Decoder } from "../common/bytes.js";
import { GitError, hasErrorCode } from "../common/errors.js";
import { joinPath, normalizePath, relativeTo } from "../common/paths.js";
import { diffText } from "../diff/index.js";
import { isBinary } from "../diff/lines.js";
import { commit as commitOp } from "../ops/commit.js";
import { type GitContext, nestedRoots, openRepository } from "../ops/context.js";
import { diffHeaderPath, diffSummaryBounded } from "../ops/diff.js";
import type { DiffSummaryEntry, RebaseResult } from "../ops/kinds.js";
import type { RebaseJournal } from "../ops/operation-state.js";
import { rebaseAbortExcluding, rebaseContinueExcluding } from "../ops/rebase.js";
import type { Repository, ResolvedHead } from "../ops/repository.js";
import { type AddLiteralPathsResult, addLiteralPaths, add as addOp } from "../ops/staging.js";
import { eagerStatus } from "../ops/status.js";
import { formatCommitRefusalStatus, statusFormatOptions } from "../ops/status-format.js";
import { PACK_BLOB_BATCH_TARGET_BYTES, type WalkTreeDiffEntry } from "../store/index.js";
import {
  boundedGitCliResult,
  type GitCliOutputContext,
  gitCliDiagnosticResult,
  gitCliResult,
  gitCliUtf8ByteLength,
} from "./result.js";
import type {
  GitCliEnvironment,
  GitCliHandlers,
  GitCliResult,
  ResolvedGitCliRunOptions,
} from "./types.js";

const HEADS = "refs/heads/";
const SUMMARY_REPOSITORY_BYTES = 8 * 1024 * 1024;
const SUMMARY_WINDOW_ROWS = 1_000;
const SUMMARY_MAX_ROWS = 50_000;
const SUMMARY_MIN_RETAINED_BYTES = 64 * 1024;

type WriteHandlers = Pick<GitCliHandlers, "add" | "commit" | "rebase">;
type MutationPhase = "native-operation" | "format-success" | "preflight";

interface CommitMutation {
  oid: string;
  previousHead: ResolvedHead;
  amended: boolean;
}

interface RebaseMutation {
  before: RebaseJournal;
  result: RebaseResult;
}

interface ResolvedAddPath {
  input: string;
  path: string;
}

interface CommitSummary {
  files: number;
  insertions: number;
  deletions: number;
  details: readonly string[];
}

interface RootSummaryRow {
  path: string;
  mode: string;
  oid: string;
}

export function createGitCliWriteHandlers(context: GitContext): WriteHandlers {
  return {
    async add(invocation, options) {
      const output = outputContext(options);
      return withRepository(context, invocation.cwd, options, (repo) => {
        let paths: ResolvedAddPath[] = [];
        return runMutation(
          repo,
          options,
          () => {
            if (invocation.command.all || invocation.command.update) {
              addOp(
                repo,
                context.worktree,
                {
                  paths: [],
                  all: true,
                  ...(invocation.command.update ? { trackedOnly: true } : {}),
                  ...(invocation.command.force ? { force: true } : {}),
                  excludeRoots: nestedRoots(context, repo.root),
                },
                context,
              );
              const result: AddLiteralPathsResult = { outcome: "staged" };
              return result;
            }
            paths = resolveAddPaths(repo, invocation.cwd, invocation.command.paths);
            return addLiteralPaths(
              repo,
              context.worktree,
              {
                paths: paths.map((path) => path.path),
                ...(invocation.command.force ? { force: true } : {}),
                excludeRoots: nestedRoots(context, repo.root),
              },
              context,
            );
          },
          (outcome) => formatAddResult(outcome, options),
          (error) => mapAddFailure(error, paths, output),
        );
      });
    },
    async commit(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) =>
        runMutation(
          repo,
          options,
          () => {
            const hasConflicts = repo.checkout.hasConflicts();
            if (!hasConflicts) repo.checkout.requireNoOperationState();
            if (invocation.command.all && !hasConflicts) {
              addOp(
                repo,
                context.worktree,
                {
                  paths: [],
                  all: true,
                  trackedOnly: true,
                  excludeRoots: nestedRoots(context, repo.root),
                },
                context,
              );
            }
            const previousHead = repo.head();
            const result = commitOp(context, repo, {
              message: invocation.command.message,
              env: environmentRecord(invocation.env),
              ...(invocation.command.amend ? { amend: true } : {}),
              ...(invocation.command.allowEmpty ? { allowEmpty: true } : {}),
            });
            return { oid: result.oid, previousHead, amended: invocation.command.amend === true };
          },
          (mutation) =>
            gitCliResult(
              formatCommitSummary(
                repo,
                context.worktree,
                mutation,
                retainedStdoutCeiling(options, 0),
              ),
              "",
              0,
            ),
          (error) => mapCommitFailure(context, repo, error, options),
        ),
      );
    },
    async rebase(invocation, options) {
      return withRepository(context, invocation.cwd, options, (repo) => {
        requireTransactionalWorktree(context, repo);
        if (invocation.command.action === "abort") {
          return runMutation(
            repo,
            options,
            () => rebaseAbortExcluding(repo, context.worktree, nestedRoots(context, repo.root)),
            () => gitCliResult("", "", 0),
            mapRebaseFailure,
          );
        }
        return runMutation(
          repo,
          options,
          () => {
            const before = repo.checkout.requireOperationState("rebase");
            const result = rebaseContinueExcluding(
              context,
              repo,
              context.worktree,
              nestedRoots(context, repo.root),
              { env: environmentRecord(invocation.env) },
            );
            return { before, result };
          },
          (mutation) => formatRebaseContinue(repo, context.worktree, mutation, options),
          (error) => mapRebaseContinueFailure(repo, error, options),
        );
      });
    },
  };
}

function runMutation<Outcome>(
  repo: Repository,
  options: ResolvedGitCliRunOptions,
  operation: () => Outcome,
  formatSuccess: (outcome: Outcome) => GitCliResult,
  mapOperationFailure: (error: unknown) => GitCliResult | undefined,
): GitCliResult {
  let phase: MutationPhase = "native-operation";
  try {
    return repo.store.db.transactionSync(() => {
      phase = "native-operation";
      const outcome = operation();
      phase = "format-success";
      const result = formatSuccess(outcome);
      phase = "preflight";
      return boundedGitCliResult(result, options);
    });
  } catch (error) {
    repo.store.revalidateStorageCaches();
    if (phase !== "native-operation") throw error;
    const mapped = mapOperationFailure(error);
    if (mapped === undefined) throw error;
    return boundedGitCliResult(mapped, options);
  }
}

function withRepository(
  context: GitContext,
  cwd: string,
  options: ResolvedGitCliRunOptions,
  body: (repo: Repository) => GitCliResult,
): GitCliResult {
  let repo: Repository;
  try {
    repo = openRepository(context, cwd);
  } catch (error) {
    if (!hasErrorCode(error, "ENOTAREPO")) throw error;
    return boundedGitCliResult(
      gitCliResult(
        "",
        "fatal: not a git repository (or any of the parent directories): .git\n",
        128,
      ),
      options,
    );
  }
  return body(repo);
}

function requireTransactionalWorktree(context: GitContext, repo: Repository): void {
  if (context.worktree.db !== repo.store.db) {
    throw new GitError(
      "EUNSUPPORTED",
      "git CLI rebase requires the worktree and repository to share one database",
    );
  }
}

function resolveAddPaths(
  repo: Repository,
  cwd: string,
  inputs: readonly string[],
): ResolvedAddPath[] {
  const paths: ResolvedAddPath[] = [];
  for (const input of inputs) {
    const absolute = input.startsWith("/") ? normalizePath(input) : joinPath(cwd, input);
    const path = relativeTo(repo.root, absolute);
    if (path === null) {
      throw new GitError(
        "EPATHOUTSIDE",
        `${input}: '${input}' is outside repository at '${repo.root}'`,
      );
    }
    paths.push({ input, path });
  }
  return paths;
}

function formatAddResult(
  result: AddLiteralPathsResult,
  options: ResolvedGitCliRunOptions,
): GitCliResult {
  if (result.outcome === "staged") return gitCliResult("", "", 0);
  if (options.discardStderr) return gitCliResult("", "", 1);
  const stderr = new BoundedSummaryOutput(retainedStderrCeiling(options), "git CLI add stderr");
  stderr.append("The following paths are ignored by one of your .gitignore files:\n");
  for (const path of result.paths) stderr.append(`${path}\n`);
  stderr.append("hint: Use -f if you really want to add them.\n");
  stderr.append('hint: Disable this message with "git config set advice.addIgnoredFile false"\n');
  return gitCliResult("", stderr.finish(), 1);
}

function mapAddFailure(
  error: unknown,
  paths: readonly ResolvedAddPath[],
  output: GitCliOutputContext,
): GitCliResult | undefined {
  const message = untrustedErrorMessage(error);
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

function untrustedErrorMessage(error: unknown): string | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }
  try {
    return "message" in error && typeof error.message === "string" ? error.message : undefined;
  } catch {
    return undefined;
  }
}

function mapCommitFailure(
  context: GitContext,
  repo: Repository,
  error: unknown,
  options: ResolvedGitCliRunOptions,
): GitCliResult | undefined {
  if (hasErrorCode(error, "EMSG")) {
    return gitCliResult("", "Aborting commit due to empty commit message.\n", 1);
  }
  if (hasErrorCode(error, "EEMPTYCOMMIT")) {
    return gitCliResult(cleanCommitRefusal(context, repo, options), "", 1);
  }
  if (hasErrorCode(error, "EUNMERGED")) {
    const stderr = boundedFailureStderr(
      "error: Committing is not possible because you have unmerged files.\n" +
        "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
        "hint: as appropriate to mark resolution and make a commit.\n" +
        "fatal: Exiting because of an unresolved conflict.\n",
      options,
    );
    return gitCliResult(
      unmergedPaths(
        repo,
        retainedStdoutCeiling(
          options,
          gitCliUtf8ByteLength(stderr, "git CLI commit stderr", false),
        ),
      ),
      stderr,
      128,
    );
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

function mapRebaseFailure(error: unknown): GitCliResult | undefined {
  if (hasErrorCode(error, "ENOREBASE") || hasErrorCode(error, "EOPMISMATCH")) {
    return gitCliResult("", "fatal: no rebase in progress\n", 128);
  }
  return undefined;
}

function mapRebaseContinueFailure(
  repo: Repository,
  error: unknown,
  options: ResolvedGitCliRunOptions,
): GitCliResult | undefined {
  if (hasErrorCode(error, "EUNMERGED")) {
    return gitCliResult(needsMergePaths(repo, retainedStdoutCeiling(options, 0)), "", 1);
  }
  return mapRebaseFailure(error);
}

function environmentRecord(environment: GitCliEnvironment): Record<string, string> {
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

function cleanCommitRefusal(
  context: GitContext,
  repo: Repository,
  options: ResolvedGitCliRunOptions,
): string {
  const branch = branchLabel(repo.head().ref);
  const rows = eagerStatus(
    repo,
    context.worktree,
    { excludeRoots: nestedRoots(context, repo.root) },
    context,
  );
  return formatCommitRefusalStatus(
    rows,
    branch,
    statusFormatOptions(repo),
    retainedStdoutCeiling(options, 0),
  );
}

function unmergedPaths(repo: Repository, maximum: number): string {
  const out = new BoundedSummaryOutput(maximum, "git CLI unmerged paths");
  let previous: string | undefined;
  for (const entry of repo.checkout.indexScan()) {
    if (entry.stage === 0 || entry.path === previous) continue;
    out.append(`U\t${entry.path}\n`);
    previous = entry.path;
  }
  return out.finish();
}

function needsMergePaths(repo: Repository, maximum: number): string {
  const out = new BoundedSummaryOutput(maximum, "git CLI rebase unresolved paths");
  let previous: string | undefined;
  for (const entry of repo.checkout.indexScan()) {
    if (entry.stage === 0 || entry.path === previous) continue;
    out.append(`${entry.path}: needs merge\n`);
    previous = entry.path;
  }
  out.append("You must edit all merge conflicts and then\n");
  out.append("mark them as resolved using git add\n");
  return out.finish();
}

function formatCommitSummary(
  repo: Repository,
  worktree: GitContext["worktree"],
  mutation: CommitMutation,
  maximum: number,
): string {
  return formatCommit(
    repo,
    worktree,
    mutation.oid,
    branchLabel(mutation.previousHead.ref),
    maximum,
    mutation.amended,
  );
}

function formatCommit(
  repo: Repository,
  worktree: GitContext["worktree"],
  oid: string,
  label: string,
  maximum: number,
  amended = false,
): string {
  const commit = repo.readCommit(oid);
  const quoteNonAscii = statusFormatOptions(repo).quotePath ?? true;
  const summary = summarizeCommit(
    repo,
    worktree,
    commit.tree,
    commit.parent[0],
    quoteNonAscii,
    maximum,
  );
  const root = commit.parent.length === 0 ? " (root-commit)" : "";
  const out = new BoundedSummaryOutput(maximum, "git CLI commit summary");
  out.append(`[${label}${root} ${abbreviate(repo, oid)}] ${subject(commit.message)}\n`);
  if (amended) out.append(` Date: ${mediumDate(commit.author)}\n`);
  if (summary.files > 0) out.append(` ${shortStat(summary)}\n`);
  for (const detail of summary.details) out.append(` ${detail}\n`);
  return out.finish();
}

function summarizeCommit(
  repo: Repository,
  worktree: GitContext["worktree"],
  tree: string,
  parentOid: string | undefined,
  quoteNonAscii: boolean,
  maximum: number,
): CommitSummary {
  if (parentOid === undefined) return summarizeRoot(repo, tree, quoteNonAscii, maximum);
  const parentTree = repo.readCommit(parentOid).tree;
  const retainedCeiling = summaryRetainedCeiling(maximum);
  const rows = diffSummaryBounded(
    repo,
    worktree,
    { ref: parentTree, to: tree, renames: true },
    undefined,
    {
      maxRows: Math.min(SUMMARY_MAX_ROWS, Math.floor(retainedCeiling / 128)),
      maxRetainedBytes: retainedCeiling,
    },
  );
  return summaryFromDiffRows(repo, parentTree, tree, rows, quoteNonAscii, maximum);
}

function summaryFromDiffRows(
  repo: Repository,
  beforeTree: string,
  afterTree: string,
  rows: readonly DiffSummaryEntry[],
  quoteNonAscii: boolean,
  maximum: number,
): CommitSummary {
  const retained = new SummaryRetainedBudget(maximum);
  const modes = new Map<string, WalkTreeDiffEntry>();
  for (const row of repo.walkTreeDiff(beforeTree, afterTree)) {
    retained.addPath(row.path);
    modes.set(row.path, row);
  }
  const renamed = new Set<string>();
  for (const row of rows) {
    if (row.originalPath !== undefined) {
      retained.addPath(row.originalPath);
      retained.addPath(row.path);
      renamed.add(row.originalPath);
      renamed.add(row.path);
    }
  }
  const details: string[] = [];
  for (const row of rows) {
    if (row.originalPath !== undefined && row.similarity !== undefined) {
      const source = modes.get(row.originalPath);
      const destination = modes.get(row.path);
      pushSummaryDetail(
        details,
        `rename ${summaryRenamePath(row.originalPath, row.path, quoteNonAscii)} (${row.similarity}%)`,
        retained,
      );
      if (
        source !== undefined &&
        destination !== undefined &&
        source.beforeMode !== null &&
        destination.afterMode !== null &&
        source.beforeMode !== destination.afterMode
      ) {
        pushSummaryDetail(
          details,
          `mode change ${source.beforeMode} => ${destination.afterMode}`,
          retained,
        );
      }
    }
  }
  for (const [path, row] of modes) {
    if (renamed.has(path)) continue;
    const detail = modeDetail(row, quoteNonAscii);
    if (detail !== undefined) pushSummaryDetail(details, detail, retained);
  }
  return {
    files: rows.length,
    insertions: rows.reduce((total, row) => total + row.insertions, 0),
    deletions: rows.reduce((total, row) => total + row.deletions, 0),
    details,
  };
}

function summarizeRoot(
  repo: Repository,
  tree: string,
  quoteNonAscii: boolean,
  maximum: number,
): CommitSummary {
  const retained = new SummaryRetainedBudget(maximum);
  const details: string[] = [];
  let files = 0;
  let insertions = 0;
  let pending: RootSummaryRow[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    let rows = pending;
    pending = [];
    while (rows.length > 0) {
      const batch = repo.readBlobs(
        rows.map((row) => row.oid),
        { budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES },
      );
      if (batch.blobs.size === 0) {
        throw new Error("commit summary blob batch made no progress");
      }
      let processed = 0;
      while (processed < rows.length) {
        const row = rows[processed];
        if (row === undefined) throw new Error("commit summary blob row is missing");
        const bytes = batch.blobs.get(row.oid);
        if (bytes === undefined) break;
        if (!isBinary(bytes)) insertions += diffText("", utf8Decoder.decode(bytes)).insertions;
        pushSummaryDetail(
          details,
          `create mode ${row.mode} ${summaryPath(row.path, quoteNonAscii)}`,
          retained,
        );
        processed++;
      }
      if (processed === 0) throw new Error("commit summary blob batch made no progress");
      rows = rows.slice(processed);
    }
  };
  for (const row of repo.walkTreeDiff(null, tree)) {
    if (row.afterMode === null || row.afterOid === null) {
      throw new Error("root commit summary yielded a deletion");
    }
    files++;
    retained.addPath(row.path);
    pending.push({ path: row.path, mode: row.afterMode, oid: row.afterOid });
    if (pending.length >= SUMMARY_WINDOW_ROWS) flush();
  }
  flush();
  return { files, insertions, deletions: 0, details };
}

function modeDetail(row: WalkTreeDiffEntry, quoteNonAscii: boolean): string | undefined {
  const path = summaryPath(row.path, quoteNonAscii);
  if (row.beforeMode === null && row.afterMode !== null) {
    return `create mode ${row.afterMode} ${path}`;
  }
  if (row.afterMode === null && row.beforeMode !== null) {
    return `delete mode ${row.beforeMode} ${path}`;
  }
  if (row.beforeMode !== null && row.afterMode !== null && row.beforeMode !== row.afterMode) {
    return `mode change ${row.beforeMode} => ${row.afterMode} ${path}`;
  }
  return undefined;
}

function summaryPath(path: string, quoteNonAscii: boolean): string {
  return diffHeaderPath(path, "", { quotePaths: true, quoteNonAscii });
}

function summaryRenamePath(source: string, destination: string, quoteNonAscii: boolean): string {
  const sourcePath = summaryPath(source, quoteNonAscii);
  const destinationPath = summaryPath(destination, quoteNonAscii);
  if (sourcePath.startsWith('"') || destinationPath.startsWith('"')) {
    return `${sourcePath} => ${destinationPath}`;
  }
  const compressed = compressRenamePath(source, destination);
  if (compressed === undefined) {
    return `${sourcePath} => ${destinationPath}`;
  }
  return summaryPath(compressed, quoteNonAscii);
}

function compressRenamePath(source: string, destination: string): string | undefined {
  let common = 0;
  const maximum = Math.min(source.length, destination.length);
  while (common < maximum && source.charCodeAt(common) === destination.charCodeAt(common)) common++;
  const prefixEnd = source.lastIndexOf("/", common - 1) + 1;
  let sourceEnd = source.length;
  let destinationEnd = destination.length;
  while (
    sourceEnd > prefixEnd &&
    destinationEnd > prefixEnd &&
    source.charCodeAt(sourceEnd - 1) === destination.charCodeAt(destinationEnd - 1)
  ) {
    sourceEnd--;
    destinationEnd--;
  }
  const sourceSuffix = source.indexOf("/", sourceEnd);
  const destinationSuffix = destination.indexOf("/", destinationEnd);
  const suffixStart =
    sourceSuffix >= 0 &&
    destinationSuffix >= 0 &&
    source.slice(sourceSuffix) === destination.slice(destinationSuffix)
      ? sourceSuffix
      : source.length;
  if (prefixEnd === 0 && suffixStart === source.length) return undefined;
  const destinationSuffixStart =
    suffixStart === source.length
      ? destination.length
      : destination.length - (source.length - suffixStart);
  return (
    source.slice(0, prefixEnd) +
    `{${source.slice(prefixEnd, suffixStart)} => ${destination.slice(prefixEnd, destinationSuffixStart)}}` +
    source.slice(suffixStart)
  );
}

function pushSummaryDetail(
  details: string[],
  detail: string,
  retained: SummaryRetainedBudget,
): void {
  retained.addString(detail);
  details.push(detail);
}

function shortStat(summary: CommitSummary): string {
  const parts = [`${summary.files} ${summary.files === 1 ? "file" : "files"} changed`];
  if (summary.insertions === 0 && summary.deletions === 0) {
    parts.push("0 insertions(+)", "0 deletions(-)");
  } else {
    if (summary.insertions > 0) {
      parts.push(
        `${summary.insertions} ${summary.insertions === 1 ? "insertion" : "insertions"}(+)`,
      );
    }
    if (summary.deletions > 0) {
      parts.push(`${summary.deletions} ${summary.deletions === 1 ? "deletion" : "deletions"}(-)`);
    }
  }
  return parts.join(", ");
}

function mediumDate(person: { timestamp: number; timezoneOffset: number }): string {
  const localSeconds = person.timestamp - person.timezoneOffset * 60;
  const milliseconds = localSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new GitError("EINVAL", "git CLI commit identity date is outside the supported range");
  }
  const date = new Date(milliseconds);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()];
  if (weekday === undefined || month === undefined || Number.isNaN(date.getTime())) {
    throw new GitError("EINVAL", "git CLI commit identity date is outside the supported range");
  }
  const east = -person.timezoneOffset;
  const sign = east < 0 ? "-" : "+";
  const absolute = Math.abs(east);
  const twoDigits = (value: number): string => String(value).padStart(2, "0");
  return (
    `${weekday} ${month} ${date.getUTCDate()} ` +
    `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:` +
    `${twoDigits(date.getUTCSeconds())} ${date.getUTCFullYear()} ${sign}` +
    `${twoDigits(Math.floor(absolute / 60))}${twoDigits(absolute % 60)}`
  );
}

function formatRebaseContinue(
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

function branchLabel(ref: string | null): string {
  if (ref === null) return "detached HEAD";
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

function abbreviate(repo: Repository, oid: string): string {
  for (let length = 7; length < oid.length; length++) {
    if (repo.store.resolvePrefix(oid.slice(0, length)) === oid) return oid.slice(0, length);
  }
  return oid;
}

function subject(message: string): string {
  const parts: string[] = [];
  for (const line of message.split("\n")) {
    if (line.trim() === "") {
      if (parts.length > 0) break;
      continue;
    }
    parts.push(line.trimEnd());
  }
  return parts.join(" ").trimEnd();
}

class SummaryRetainedBudget {
  #bytes = 0;
  readonly #maximum: number;

  constructor(maximum: number) {
    this.#maximum = summaryRetainedCeiling(maximum);
  }

  addPath(path: string): void {
    this.add(96 + gitCliUtf8ByteLength(path, "git CLI commit summary path", true) * 2);
  }

  addString(value: string): void {
    this.add(48 + gitCliUtf8ByteLength(value, "git CLI commit summary detail", false) * 2);
  }

  private add(bytes: number): void {
    if (bytes > this.#maximum - this.#bytes) {
      throw new GitError("E2BIG", `git CLI commit summary exceeds ${this.#maximum} retained bytes`);
    }
    this.#bytes += bytes;
  }
}

function summaryRetainedCeiling(maximum: number): number {
  return Math.min(SUMMARY_REPOSITORY_BYTES, Math.max(SUMMARY_MIN_RETAINED_BYTES, maximum * 4));
}

function retainedStdoutCeiling(options: ResolvedGitCliRunOptions, stderrBytes: number): number {
  const retainedStderr = options.discardStderr ? 0 : stderrBytes;
  return Math.min(
    options.maxStdoutBytes,
    Math.max(0, options.maxCombinedOutputBytes - retainedStderr),
  );
}

function retainedStderrCeiling(options: ResolvedGitCliRunOptions): number {
  if (options.discardStderr) return Number.MAX_SAFE_INTEGER;
  return Math.min(options.maxStderrBytes, options.maxCombinedOutputBytes);
}

function boundedFailureStderr(value: string, options: ResolvedGitCliRunOptions): string {
  if (options.discardStderr) return "";
  const out = new BoundedSummaryOutput(retainedStderrCeiling(options), "git CLI failure stderr");
  out.append(value);
  return out.finish();
}

function outputContext(options: ResolvedGitCliRunOptions): GitCliOutputContext {
  return { options };
}

class BoundedSummaryOutput {
  #bytes = 0;
  #output = "";

  constructor(
    private readonly maximum: number,
    private readonly label: string,
  ) {}

  append(value: string): void {
    const bytes = gitCliUtf8ByteLength(value, this.label, false);
    if (bytes > this.maximum - this.#bytes) {
      throw new GitError("E2BIG", `${this.label} exceeds ${this.maximum} bytes`);
    }
    this.#bytes += bytes;
    this.#output += value;
  }

  finish(): string {
    return this.#output;
  }
}
