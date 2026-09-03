import { GitError, hasErrorCode } from "../common/errors.js";
import { joinPath, normalizePath, relativePath, relativeTo } from "../common/paths.js";
import { type GitContext, nestedRoots, openRepository } from "../ops/context.js";
import { diff } from "../ops/diff.js";
import { divergence } from "../ops/merge-base.js";
import { withPromisorHydration } from "../ops/network.js";
import { readRef } from "../ops/plumbing.js";
import { type CommitView, linearLogRange, log, show } from "../ops/reads.js";
import { branchList, currentBranch } from "../ops/refs.js";
import { lsFilesWithWorktree } from "../ops/staging.js";
import { eagerStatus, statusBranch } from "../ops/status.js";
import { formatCliPathLines, formatCliStatus, statusFormatOptions } from "../ops/status-format.js";
import type { StatusDetail } from "../ops/status-rows.js";
import { formatLog } from "./read-log.js";
import {
  type GitCliOutputContext,
  gitCliDiagnosticResult,
  gitCliDiagnosticResultParts,
  gitCliDiagnosticSliceResult,
  gitCliResult,
  gitCliRevisionRequired,
  gitCliStdoutPartsResult,
} from "./result.js";
import {
  GIT_CLI_MAX_LOG_COUNT,
  type GitCliHandlers,
  type GitCliResult,
  type GitCliRevision,
  type ResolvedGitCliRunOptions,
} from "./types.js";

const HEADS = "refs/heads/";
const REFS = "refs/";

type ReadHandlers = Pick<
  GitCliHandlers,
  "status" | "revParse" | "branch" | "lsFiles" | "diff" | "log" | "show" | "revList" | "symbolicRef"
>;

export function createGitCliReadHandlers(context: GitContext): ReadHandlers {
  return {
    async status(invocation, runOptions) {
      return withRepository(context, invocation.cwd, outputContext(runOptions), (repo) => {
        const command = invocation.command;
        const paths = resolveLiteralPaths(repo.root, invocation.cwd, command.paths, "status");
        const rows = eagerStatus(
          repo,
          context.worktree,
          { paths, excludeRoots: nestedRoots(context, repo.root) },
          context,
        );
        relativizeStatusRows(repo.root, invocation.cwd, rows);
        const branch =
          command.format === "default" || command.branch === true
            ? statusBranch(repo)
            : { oid: null, head: null };
        const stdout = formatCliStatus(
          rows,
          branch,
          command.format,
          command.branch === true,
          statusFormatOptions(repo),
          stdoutCeiling(runOptions),
        );
        return gitCliResult(stdout, "", 0);
      });
    },
    async revParse(invocation, runOptions) {
      const output = outputContext(runOptions);
      return withRepository(context, invocation.cwd, output, async (repo) => {
        const command = invocation.command;
        if (command.showToplevel === true) {
          return gitCliStdoutPartsResult([`${repo.root}\n`], stdoutCeiling(runOptions));
        }
        const revision = command.revision;
        if (revision === undefined) return gitCliRevisionRequired(output);
        let oid: string | undefined;
        try {
          oid = await withPromisorHydration(context, repo, () => repo.tryRevParse(revision));
        } catch (error) {
          if (!hasErrorCode(error, "ENOTFOUND")) throw error;
        }
        if (oid !== undefined) {
          return gitCliStdoutPartsResult([`${oid}\n`], stdoutCeiling(runOptions));
        }
        if (command.quiet === true) return gitCliResult("", "", 1);
        if (command.verify === true) return gitCliRevisionRequired(output);
        const failure = ambiguousRevision({ kind: "ref", ref: revision }, output);
        return gitCliStdoutPartsResult(
          [`${revision}\n`],
          stdoutCeiling(runOptions),
          failure.exitCode,
          failure.stderr,
        );
      });
    },
    async branch(invocation, runOptions) {
      return withRepository(context, invocation.cwd, outputContext(runOptions), (repo) => {
        const current = currentBranch(repo);
        if (invocation.command.action === "show-current") {
          return gitCliStdoutPartsResult(
            current === undefined ? [] : [`${current}\n`],
            stdoutCeiling(runOptions),
          );
        }
        const parts: string[] = [];
        const head = repo.head();
        if (head.ref === null && head.oid !== null) {
          parts.push(`* (HEAD detached at ${head.oid.slice(0, 7)})\n`);
        }
        for (const name of branchList(repo)) {
          parts.push(`${name === current ? "*" : " "} ${name}\n`);
        }
        return gitCliStdoutPartsResult(parts, stdoutCeiling(runOptions));
      });
    },
    async lsFiles(invocation, runOptions) {
      return withRepository(context, invocation.cwd, outputContext(runOptions), (repo) => {
        const command = invocation.command;
        let paths = resolveLiteralPaths(repo.root, invocation.cwd, command.paths, "ls-files");
        if (paths === undefined) {
          const cwdPath = relativeTo(repo.root, invocation.cwd);
          if (cwdPath === null) throw new GitError("EINVAL", "ls-files cwd is outside repository");
          if (cwdPath !== "") paths = [cwdPath];
        }
        const selection = {
          paths,
          excludeRoots: nestedRoots(context, repo.root),
        };
        const selected =
          command.cached === true && command.others === true
            ? [
                ...lsFilesWithWorktree(repo, context.worktree, {
                  ...selection,
                  others: true,
                  excludeStandard: command.excludeStandard,
                }),
                ...lsFilesWithWorktree(repo, context.worktree, {
                  ...selection,
                  cached: true,
                }),
              ]
            : lsFilesWithWorktree(repo, context.worktree, {
                ...selection,
                cached: command.cached,
                others: command.others,
                excludeStandard: command.excludeStandard,
              });
        const displayed = selected.map((path) => pathFromCwd(repo.root, invocation.cwd, path));
        return gitCliResult(
          formatCliPathLines(displayed, statusFormatOptions(repo), stdoutCeiling(runOptions)),
          "",
          0,
        );
      });
    },
    async diff(invocation, runOptions) {
      return withRepository(context, invocation.cwd, outputContext(runOptions), async (repo) => {
        const command = invocation.command;
        const quotePath = statusFormatOptions(repo).quotePath ?? true;
        const paths = resolveDiffPaths(repo.root, invocation.cwd, command.paths);
        return withPromisorHydration(context, repo, () =>
          gitCliResult(
            diff(
              repo,
              context.worktree,
              {
                staged: command.staged,
                ref: command.ref,
                to: command.to,
                paths,
                context: command.context,
              },
              context.sparseWorkspace,
              {
                quotePaths: true,
                quoteNonAscii: quotePath,
                indexBase:
                  command.staged !== true && command.ref === undefined && command.to === undefined,
                maxOutputBytes: Math.min(
                  runOptions.maxStdoutBytes,
                  runOptions.maxCombinedOutputBytes,
                ),
              },
            ),
            "",
            0,
          ),
        );
      });
    },
    async log(invocation, runOptions) {
      const output = outputContext(runOptions);
      return withRepository(context, invocation.cwd, output, (repo) => {
        const command = invocation.command;
        const revision = command.revision;
        const paths = resolveLiteralPaths(repo.root, invocation.cwd, command.paths, "log");
        if (revision === undefined && repo.head().oid === null) {
          return unbornLogFailure(repo.head().ref, output);
        }
        if (revision !== undefined) {
          if (missingRevision(repo, revision)) return ambiguousRevision(revision, output);
        }
        let commits: CommitView[];
        if (revision?.kind === "range") {
          try {
            commits = linearLogRange(
              repo,
              revision.left,
              revision.right,
              command.count ?? GIT_CLI_MAX_LOG_COUNT,
              { paths },
            );
          } catch (error) {
            if (hasErrorCode(error, "EUNSUPPORTED")) {
              return gitCliDiagnosticResult(
                "fatal: log range is not a complete single-parent chain\n",
                "",
                "",
                128,
                output,
              );
            }
            throw error;
          }
        } else if (command.count === 0) {
          commits = [];
        } else {
          commits = log(repo, {
            ref: revision?.kind === "ref" ? revision.ref : undefined,
            depth: command.count,
            paths,
            firstParent: command.firstParent,
          });
        }
        return gitCliResult(
          formatLog(
            commits,
            command.format,
            Math.min(runOptions.maxStdoutBytes, runOptions.maxCombinedOutputBytes),
          ),
          "",
          0,
        );
      });
    },
    async show(invocation, runOptions) {
      const output = outputContext(runOptions);
      return withRepository(context, invocation.cwd, output, async (repo) => {
        const ref = invocation.command.ref ?? "HEAD";
        if (repo.head().oid === null && invocation.command.ref === undefined) {
          return unbornLogFailure(repo.head().ref, output);
        }
        const revision: GitCliRevision = { kind: "ref", ref };
        if (missingRevision(repo, revision)) return ambiguousRevision(revision, output);
        const oid = repo.peel(repo.revParse(ref));
        if (
          repo.readCommit(oid).parent.length > 1 &&
          !repo.shallow().has(oid) &&
          invocation.command.firstParent !== true
        ) {
          return gitCliDiagnosticResult(
            "fatal: merge show requires --first-parent\n",
            "",
            "",
            128,
            output,
          );
        }
        const result = await withPromisorHydration(context, repo, () =>
          show(repo, {
            ref,
            patch: true,
            ...(invocation.command.firstParent === true ? { mainline: 1 } : {}),
          }),
        );
        const maximum = stdoutCeiling(runOptions);
        const metadata = formatLog([result.commit], { kind: "default" }, maximum);
        const patch = result.patch ?? "";
        return gitCliStdoutPartsResult(
          patch === "" ? [metadata] : [metadata, "\n", patch],
          maximum,
        );
      });
    },
    async revList(invocation, runOptions) {
      const output = outputContext(runOptions);
      return withRepository(context, invocation.cwd, output, (repo) => {
        if (
          repo.tryRevParse(invocation.command.left) === undefined ||
          repo.tryRevParse(invocation.command.right) === undefined
        ) {
          return ambiguousRevision(
            { kind: "range", left: invocation.command.left, right: invocation.command.right },
            output,
          );
        }
        const result = divergence(repo, {
          current: invocation.command.left,
          upstream: invocation.command.right,
        });
        return gitCliResult(`${result.behind}\n`, "", 0);
      });
    },
    async symbolicRef(invocation, runOptions) {
      const output = outputContext(runOptions);
      return withRepository(context, invocation.cwd, output, (repo) => {
        const ref = invocation.command.ref;
        if (ref !== "HEAD" && !ref.startsWith(REFS)) return notSymbolicRef(ref, output);
        const seen = new Set<string>();
        let current = ref;
        let followed = false;
        for (let hops = 0; hops < 8; hops++) {
          if (seen.has(current)) return missingSymbolicRef(ref, output);
          seen.add(current);
          const target = readRef(repo, { ref: current });
          if (target.kind !== "symbolic") {
            return followed
              ? gitCliResult(`${shortRef(current)}\n`, "", 0)
              : notSymbolicRef(ref, output);
          }
          followed = true;
          current = target.target;
        }
        return missingSymbolicRef(ref, output);
      });
    },
  };
}

async function withRepository(
  context: GitContext,
  cwd: string,
  output: GitCliOutputContext,
  body: (repo: ReturnType<typeof openRepository>) => GitCliResult | Promise<GitCliResult>,
): Promise<GitCliResult> {
  try {
    return await body(openRepository(context, cwd));
  } catch (error) {
    if (hasErrorCode(error, "ENOTAREPO")) {
      return gitCliDiagnosticResult(
        "fatal: not a git repository (or any of the parent directories): .git\n",
        "",
        "",
        128,
        output,
      );
    }
    throw error;
  }
}

function resolveDiffPaths(
  root: string,
  cwd: string,
  inputs: readonly string[] | undefined,
): string[] | undefined {
  if (inputs === undefined) return undefined;
  return inputs.map((input) => {
    const absolute = input.startsWith("/") ? normalizePath(input) : joinPath(cwd, input);
    const path = relativeTo(root, absolute);
    if (path === null) {
      throw new GitError("EINVAL", `diff path '${input}' is outside repository at '${root}'`);
    }
    return path;
  });
}

function resolveLiteralPaths(
  root: string,
  cwd: string,
  inputs: readonly string[] | undefined,
  command: string,
): string[] | undefined {
  if (inputs === undefined) return undefined;
  return inputs.map((input) => {
    const absolute = input.startsWith("/") ? normalizePath(input) : joinPath(cwd, input);
    const path = relativeTo(root, absolute);
    if (path === null) {
      throw new GitError("EINVAL", `${command} path '${input}' is outside repository at '${root}'`);
    }
    return path;
  });
}

function relativizeStatusRows(root: string, cwd: string, rows: StatusDetail[]): void {
  for (const row of rows) {
    row.path = pathFromCwd(root, cwd, row.path);
    if ("originalPath" in row && row.originalPath !== undefined) {
      row.originalPath = pathFromCwd(root, cwd, row.originalPath);
    }
  }
}

function pathFromCwd(root: string, cwd: string, path: string): string {
  const directory = path.endsWith("/");
  const relative = relativePath(cwd, joinPath(root, path));
  if (!directory) return relative;
  return relative === "." ? "./" : `${relative}/`;
}

function stdoutCeiling(options: ResolvedGitCliRunOptions): number {
  return Math.min(options.maxStdoutBytes, options.maxCombinedOutputBytes);
}

function missingRevision(
  repo: ReturnType<typeof openRepository>,
  revision: GitCliRevision,
): boolean {
  if (revision.kind === "ref") {
    return repo.tryRevParse(revision.ref) === undefined;
  }
  if (
    repo.tryRevParse(revision.left) === undefined ||
    repo.tryRevParse(revision.right) === undefined
  ) {
    return true;
  }
  return false;
}

function ambiguousRevision(revision: GitCliRevision, output: GitCliOutputContext): GitCliResult {
  const suffix =
    "': unknown revision or path not in the working tree.\n" +
    "Use '--' to separate paths from revisions, like this:\n" +
    "'git <command> [<revision>...] -- [<file>...]'\n";
  return gitCliDiagnosticResultParts(
    "fatal: ambiguous argument '",
    revision.kind === "ref" ? revision.ref : revision.left,
    revision.kind === "ref" ? "" : "..",
    revision.kind === "ref" ? "" : revision.right,
    suffix,
    128,
    output,
  );
}

function unbornLogFailure(ref: string | null, output: GitCliOutputContext): GitCliResult {
  if (ref?.startsWith(HEADS) === true) {
    return gitCliDiagnosticSliceResult(
      "fatal: your current branch '",
      ref,
      HEADS.length,
      "' does not have any commits yet\n",
      128,
      output,
    );
  }
  return gitCliDiagnosticResult(
    "fatal: your current branch '",
    "HEAD",
    "' does not have any commits yet\n",
    128,
    output,
  );
}

function outputContext(options: ResolvedGitCliRunOptions): GitCliOutputContext {
  return { options };
}

function notSymbolicRef(ref: string, output: GitCliOutputContext): GitCliResult {
  return gitCliDiagnosticResult("fatal: ref ", ref, " is not a symbolic ref\n", 128, output);
}

function missingSymbolicRef(ref: string, output: GitCliOutputContext): GitCliResult {
  return gitCliDiagnosticResult("fatal: No such ref: ", ref, "\n", 128, output);
}

function shortRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  return ref.startsWith(REFS) ? ref.slice(REFS.length) : ref;
}
