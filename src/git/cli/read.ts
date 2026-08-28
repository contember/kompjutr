import { type GitContext, nestedRoots, openRepository } from "../../core/context.js";
import { GitError, hasErrorCode } from "../../core/errors.js";
import { diff } from "../../core/ops/diff.js";
import { divergence } from "../../core/ops/merge-base.js";
import { readRef } from "../../core/ops/plumbing.js";
import { type CommitView, linearLogRange, log } from "../../core/ops/reads.js";
import { eagerStatus } from "../../core/ops/status.js";
import {
  formatPorcelainV1,
  formatShort,
  statusFormatOptions,
} from "../../core/ops/status-format.js";
import { gitCliResult, gitCliUtf8ByteLength } from "./result.js";
import {
  GIT_CLI_MAX_LOG_COUNT,
  GIT_CLI_MAX_STDOUT_BYTES,
  type GitCliHandlers,
  type GitCliResult,
  type GitCliRevision,
} from "./types.js";

const HEADS = "refs/heads/";
const REFS = "refs/";
const MAX_FORMAT_OPERATIONS = 1_000_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ReadHandlers = Pick<GitCliHandlers, "status" | "diff" | "log" | "revList" | "symbolicRef">;

export function createGitCliReadHandlers(context: GitContext): ReadHandlers {
  return {
    status(invocation) {
      return withRepository(context, invocation.cwd, (repo) => {
        const rows = eagerStatus(
          repo,
          context.worktree,
          { excludeRoots: nestedRoots(context, repo.root) },
          context,
        );
        const options = statusFormatOptions(repo);
        const stdout =
          invocation.command.format === "short"
            ? formatShort(rows, options)
            : formatPorcelainV1(rows, options);
        return gitCliResult(stdout, "", 0);
      });
    },
    diff(invocation, runOptions) {
      return withRepository(context, invocation.cwd, (repo) => {
        const quotePath = statusFormatOptions(repo).quotePath ?? true;
        return gitCliResult(
          diff(repo, context.worktree, {}, context.sparseWorkspace, {
            quotePaths: true,
            quoteNonAscii: quotePath,
            indexBase: true,
            maxOutputBytes: Math.min(runOptions.maxStdoutBytes, runOptions.maxCombinedOutputBytes),
          }),
          "",
          0,
        );
      });
    },
    log(invocation) {
      return withRepository(context, invocation.cwd, (repo) => {
        const command = invocation.command;
        const revision = command.revision;
        if (revision === undefined && repo.head().oid === null) {
          return unbornLogFailure(repo.head().ref);
        }
        if (revision !== undefined) {
          const missing = missingRevision(repo, revision);
          if (missing !== undefined) return ambiguousRevision(missing);
        }
        let commits: CommitView[];
        if (revision?.kind === "range") {
          try {
            commits = linearLogRange(
              repo,
              revision.left,
              revision.right,
              command.count ?? GIT_CLI_MAX_LOG_COUNT,
            );
          } catch (error) {
            if (hasErrorCode(error, "EUNSUPPORTED")) {
              return gitCliResult(
                "",
                "fatal: log range is not a complete single-parent chain\n",
                128,
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
          });
        }
        return gitCliResult(formatLog(commits, command.format), "", 0);
      });
    },
    revList(invocation) {
      return withRepository(context, invocation.cwd, (repo) => {
        const expression = `${invocation.command.left}..${invocation.command.right}`;
        if (
          repo.tryRevParse(invocation.command.left) === undefined ||
          repo.tryRevParse(invocation.command.right) === undefined
        ) {
          return ambiguousRevision(expression);
        }
        const result = divergence(repo, {
          current: invocation.command.left,
          upstream: invocation.command.right,
        });
        return gitCliResult(`${result.behind}\n`, "", 0);
      });
    },
    symbolicRef(invocation) {
      return withRepository(context, invocation.cwd, (repo) => {
        const ref = invocation.command.ref;
        if (ref !== "HEAD" && !ref.startsWith(REFS)) return notSymbolicRef(ref);
        const seen = new Set<string>();
        let current = ref;
        let followed = false;
        for (let hops = 0; hops < 8; hops++) {
          if (seen.has(current)) return missingSymbolicRef(ref);
          seen.add(current);
          const target = readRef(repo, { ref: current });
          if (target.kind !== "symbolic") {
            return followed ? gitCliResult(`${shortRef(current)}\n`, "", 0) : notSymbolicRef(ref);
          }
          followed = true;
          current = target.target;
        }
        return missingSymbolicRef(ref);
      });
    },
  };
}

function withRepository(
  context: GitContext,
  cwd: string,
  body: (repo: ReturnType<typeof openRepository>) => GitCliResult,
): GitCliResult {
  try {
    return body(openRepository(context, cwd));
  } catch (error) {
    if (hasErrorCode(error, "ENOTAREPO")) {
      return gitCliResult(
        "",
        "fatal: not a git repository (or any of the parent directories): .git\n",
        128,
      );
    }
    throw error;
  }
}

function missingRevision(
  repo: ReturnType<typeof openRepository>,
  revision: GitCliRevision,
): string | undefined {
  if (revision.kind === "ref") {
    return repo.tryRevParse(revision.ref) === undefined ? revision.ref : undefined;
  }
  if (
    repo.tryRevParse(revision.left) === undefined ||
    repo.tryRevParse(revision.right) === undefined
  ) {
    return `${revision.left}..${revision.right}`;
  }
  return undefined;
}

function ambiguousRevision(expression: string): GitCliResult {
  return gitCliResult(
    "",
    `fatal: ambiguous argument '${expression}': unknown revision or path not in the working tree.\n` +
      "Use '--' to separate paths from revisions, like this:\n" +
      "'git <command> [<revision>...] -- [<file>...]'\n",
    128,
  );
}

function unbornLogFailure(ref: string | null): GitCliResult {
  const branch = ref?.startsWith(HEADS) === true ? ref.slice(HEADS.length) : "HEAD";
  return gitCliResult(
    "",
    `fatal: your current branch '${branch}' does not have any commits yet\n`,
    128,
  );
}

function notSymbolicRef(ref: string): GitCliResult {
  return gitCliResult("", `fatal: ref ${ref} is not a symbolic ref\n`, 128);
}

function missingSymbolicRef(ref: string): GitCliResult {
  return gitCliResult("", `fatal: No such ref: ${ref}\n`, 128);
}

function shortRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  return ref.startsWith(REFS) ? ref.slice(REFS.length) : ref;
}

function formatLog(
  commits: readonly CommitView[],
  format:
    | { readonly kind: "default" }
    | { readonly kind: "oneline" }
    | {
        readonly kind: "template";
        readonly template: string;
      },
): string {
  const out = new BoundedLogOutput();
  if (format.kind === "template" && format.template === "") return "";
  let operations = 0;
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]!;
    if (format.kind === "default") {
      if (index > 0) out.append("\n");
      appendDefaultCommit(out, commit);
    } else if (format.kind === "oneline") {
      out.append(`${commit.oid.slice(0, 7)} ${subject(commit.message)}\n`);
    } else {
      operations = appendTemplate(out, commit, format.template, operations);
      out.append("\n");
    }
  }
  return out.finish();
}

class BoundedLogOutput {
  #bytes = 0;
  #chunks: string[] = [];

  append(value: string): void {
    if (value === "") return;
    const bytes = gitCliUtf8ByteLength(value, "git CLI log output", false);
    if (bytes > GIT_CLI_MAX_STDOUT_BYTES - this.#bytes) {
      throw new GitError("E2BIG", `git CLI log output exceeds ${GIT_CLI_MAX_STDOUT_BYTES} bytes`);
    }
    this.#bytes += bytes;
    this.#chunks.push(value);
  }

  finish(): string {
    return this.#chunks.join("");
  }
}

function appendDefaultCommit(out: BoundedLogOutput, commit: CommitView): void {
  out.append(`commit ${commit.oid}\n`);
  if (commit.parent.length > 1) {
    out.append(`Merge: ${commit.parent.map((oid) => oid.slice(0, 7)).join(" ")}\n`);
  }
  out.append(`Author: ${commit.author.name} <${commit.author.email}>\n`);
  out.append(`Date:   ${mediumDate(commit.author)}\n`);
  const message = commit.message.replace(/\n+$/, "");
  if (message === "") return;
  out.append("\n");
  for (const line of message.split("\n")) out.append(`    ${line}\n`);
}

function mediumDate(person: CommitView["author"]): string {
  if (!Number.isSafeInteger(person.timestamp) || !Number.isSafeInteger(person.timezoneOffset)) {
    throw new GitError("EINVAL", "git CLI log identity has an invalid date");
  }
  const localSeconds = person.timestamp - person.timezoneOffset * 60;
  const milliseconds = localSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new GitError("EINVAL", "git CLI log identity date is outside the supported range");
  }
  const date = new Date(milliseconds);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  if (weekday === undefined || month === undefined || Number.isNaN(date.getTime())) {
    throw new GitError("EINVAL", "git CLI log identity date is outside the supported range");
  }
  return (
    `${weekday} ${month} ${date.getUTCDate()} ` +
    `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:` +
    `${twoDigits(date.getUTCSeconds())} ${date.getUTCFullYear()} ${timezone(person.timezoneOffset)}`
  );
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function timezone(offsetMinutes: number): string {
  const east = -offsetMinutes;
  const sign = east < 0 ? "-" : "+";
  const absolute = Math.abs(east);
  return `${sign}${twoDigits(Math.floor(absolute / 60))}${twoDigits(absolute % 60)}`;
}

function subject(message: string): string {
  const lines = message.split("\n");
  const parts: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (parts.length > 0) break;
      continue;
    }
    parts.push(line.trimEnd());
  }
  return parts.join(" ").trimEnd();
}

function appendTemplate(
  out: BoundedLogOutput,
  commit: CommitView,
  template: string,
  initialOperations: number,
): number {
  let operations = initialOperations;
  let literalStart = 0;
  for (let index = 0; index < template.length; index++) {
    if (template.charCodeAt(index) !== 0x25) continue;
    operations = nextFormatOperation(operations);
    out.append(template.slice(literalStart, index));
    const first = template[index + 1]!;
    let token = `%${first}`;
    if (first === "a" || first === "c") token += template[index + 2]!;
    out.append(templateValue(commit, token));
    index += token.length - 1;
    literalStart = index + 1;
  }
  operations = nextFormatOperation(operations);
  out.append(template.slice(literalStart));
  return operations;
}

function nextFormatOperation(current: number): number {
  if (current >= MAX_FORMAT_OPERATIONS) {
    throw new GitError(
      "E2BIG",
      `git CLI log formatting exceeds ${MAX_FORMAT_OPERATIONS} operations`,
    );
  }
  return current + 1;
}

function templateValue(commit: CommitView, token: string): string {
  if (token === "%H") return commit.oid;
  if (token === "%h") return commit.oid.slice(0, 7);
  if (token === "%P") return commit.parent.join(" ");
  if (token === "%s") return subject(commit.message);
  if (token === "%B") return commit.message;
  if (token === "%an") return commit.author.name;
  if (token === "%ae") return commit.author.email;
  if (token === "%at") return String(commit.author.timestamp);
  if (token === "%cn") return commit.committer.name;
  if (token === "%ce") return commit.committer.email;
  if (token === "%ct") return String(commit.committer.timestamp);
  if (token === "%n") return "\n";
  if (token === "%%") return "%";
  throw new GitError("EINVAL", `unsupported git CLI log placeholder ${token}`);
}
