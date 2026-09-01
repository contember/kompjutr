import { GitError, hasErrorCode } from "../common/errors.js";
import { type GitContext, nestedRoots, openRepository } from "../ops/context.js";
import { diff } from "../ops/diff.js";
import type { StatusEntry } from "../ops/kinds.js";
import { divergence } from "../ops/merge-base.js";
import { readRef } from "../ops/plumbing.js";
import { type CommitView, linearLogRange, log } from "../ops/reads.js";
import { eagerStatus } from "../ops/status.js";
import { formatPorcelainV1, formatShort, statusFormatOptions } from "../ops/status-format.js";
import {
  type GitCliOutputContext,
  gitCliDiagnosticResult,
  gitCliDiagnosticResultParts,
  gitCliDiagnosticSliceResult,
  gitCliResult,
  gitCliUtf8ByteLength,
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
const MAX_FORMAT_OPERATIONS = 1_000_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ReadHandlers = Pick<GitCliHandlers, "status" | "diff" | "log" | "revList" | "symbolicRef">;

export function createGitCliReadHandlers(context: GitContext): ReadHandlers {
  return {
    async status(invocation, runOptions) {
      return withRepository(context, invocation.cwd, outputContext(runOptions), (repo) => {
        const rows = eagerStatus(
          repo,
          context.worktree,
          { excludeRoots: nestedRoots(context, repo.root) },
          context,
        );
        const options = statusFormatOptions(repo);
        preflightStatusOutput(
          rows,
          options.quotePath ?? true,
          Math.min(runOptions.maxStdoutBytes, runOptions.maxCombinedOutputBytes),
        );
        const stdout =
          invocation.command.format === "short"
            ? formatShort(rows, options)
            : formatPorcelainV1(rows, options);
        return gitCliResult(stdout, "", 0);
      });
    },
    async diff(invocation, runOptions) {
      return withRepository(context, invocation.cwd, outputContext(runOptions), (repo) => {
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
    async log(invocation, runOptions) {
      const output = outputContext(runOptions);
      return withRepository(context, invocation.cwd, output, (repo) => {
        const command = invocation.command;
        const revision = command.revision;
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

function withRepository(
  context: GitContext,
  cwd: string,
  output: GitCliOutputContext,
  body: (repo: ReturnType<typeof openRepository>) => GitCliResult,
): GitCliResult {
  try {
    return body(openRepository(context, cwd));
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

function preflightStatusOutput(
  rows: readonly StatusEntry[],
  quotePath: boolean,
  maximum: number,
): void {
  for (const row of rows) {
    validateStatusPath(row.path);
    if (row.originalPath !== undefined) validateStatusPath(row.originalPath);
  }
  let bytes = 0;
  const addRow = (row: StatusEntry, prefixBytes: number): void => {
    bytes = statusOutputAdd(bytes, prefixBytes, maximum);
    if (row.originalPath === undefined) {
      bytes = statusOutputAdd(bytes, statusPathBytes(row.path, quotePath, true, false), maximum);
    } else {
      bytes = statusOutputAdd(
        bytes,
        statusPathBytes(row.originalPath, quotePath, true, true),
        maximum,
      );
      bytes = statusOutputAdd(bytes, 4, maximum);
      bytes = statusOutputAdd(bytes, statusPathBytes(row.path, quotePath, true, true), maximum);
    }
    bytes = statusOutputAdd(bytes, 1, maximum);
  };
  for (const row of rows) {
    if (row.worktree === "?" || row.worktree === "!") continue;
    addRow(row, 3);
  }
  for (const row of rows) {
    if (row.worktree === "?") addRow(row, 3);
  }
  for (const row of rows) {
    if (row.worktree === "!") addRow(row, 3);
  }
}

function validateStatusPath(path: string): void {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code === 0) throw invalidStatusPath();
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = path.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw invalidStatusPath();
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidStatusPath();
    }
  }
}

function invalidStatusPath(): GitError {
  return new GitError("EINVAL", "status paths must be NUL-free well-formed UTF-16");
}

function statusPathBytes(
  path: string,
  quotePath: boolean,
  quoteEdgeSpaces: boolean,
  quoteRenameSeparator: boolean,
): number {
  let quoted =
    (quoteEdgeSpaces && (path.startsWith(" ") || path.endsWith(" "))) ||
    (quoteRenameSeparator && path.includes(" -> "));
  let bytes = 0;
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code < 0x80) {
      const escapedBytes = statusAsciiBytes(code);
      if (escapedBytes !== 1) quoted = true;
      bytes += escapedBytes;
      continue;
    }
    let sourceBytes = code <= 0x7ff ? 2 : 3;
    if (code >= 0xd800 && code <= 0xdbff) {
      sourceBytes = 4;
      index++;
    }
    if (quotePath) {
      quoted = true;
      bytes += sourceBytes * 4;
    } else {
      bytes += sourceBytes;
    }
  }
  return bytes + (quoted ? 2 : 0);
}

function statusAsciiBytes(code: number): number {
  if ((code >= 0x07 && code <= 0x0d) || code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20 || code === 0x7f) return 4;
  return 1;
}

function statusOutputAdd(current: number, additional: number, maximum: number): number {
  if (additional > maximum - current) {
    throw new GitError("E2BIG", `git CLI status output exceeds ${maximum} bytes`);
  }
  return current + additional;
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
  maximum: number,
): string {
  const out = new BoundedLogOutput(maximum);
  if (format.kind === "template" && format.template === "") return "";
  let operations = 0;
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]!;
    if (format.kind === "default") {
      if (index > 0) out.append("\n");
      appendDefaultCommit(out, commit);
    } else if (format.kind === "oneline") {
      out.appendSlice(commit.oid, 0, Math.min(7, commit.oid.length));
      out.append(" ");
      appendSubject(out, commit.message);
      out.append("\n");
    } else {
      operations = appendTemplate(out, commit, format.template, operations);
      out.append("\n");
    }
  }
  return out.finish();
}

class BoundedLogOutput {
  #bytes = 0;
  readonly #chunks: string[] = [];

  constructor(private readonly maximum: number) {}

  append(value: string): void {
    if (value === "") return;
    const bytes = gitCliUtf8ByteLength(value, "git CLI log output", false);
    this.#append(value, bytes);
  }

  appendSlice(value: string, start: number, end = value.length): void {
    if (start === end) return;
    const bytes = utf8RangeBytes(value, start, end);
    this.#admit(bytes);
    const chunk = value.slice(start, end);
    this.#chunks.push(chunk);
  }

  #append(value: string, bytes: number): void {
    this.#admit(bytes);
    this.#chunks.push(value);
  }

  #admit(bytes: number): void {
    if (bytes > this.maximum - this.#bytes) {
      throw new GitError("E2BIG", `git CLI log output exceeds ${this.maximum} bytes`);
    }
    this.#bytes += bytes;
  }

  finish(): string {
    return this.#chunks.join("");
  }
}

function appendDefaultCommit(out: BoundedLogOutput, commit: CommitView): void {
  out.append("commit ");
  out.append(commit.oid);
  out.append("\n");
  if (commit.parent.length > 1) {
    out.append("Merge: ");
    for (let index = 0; index < commit.parent.length; index++) {
      if (index > 0) out.append(" ");
      const oid = commit.parent[index]!;
      out.appendSlice(oid, 0, Math.min(7, oid.length));
    }
    out.append("\n");
  }
  out.append("Author: ");
  out.append(commit.author.name);
  out.append(" <");
  out.append(commit.author.email);
  out.append(">\nDate:   ");
  out.append(mediumDate(commit.author));
  out.append("\n");
  let messageEnd = commit.message.length;
  while (messageEnd > 0 && commit.message.charCodeAt(messageEnd - 1) === 0x0a) messageEnd--;
  if (messageEnd === 0) return;
  out.append("\n");
  let lineStart = 0;
  while (lineStart < messageEnd) {
    const newline = commit.message.indexOf("\n", lineStart);
    const lineEnd = newline < 0 || newline > messageEnd ? messageEnd : newline;
    out.append("    ");
    out.appendSlice(commit.message, lineStart, lineEnd);
    out.append("\n");
    lineStart = lineEnd + 1;
  }
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

function appendSubject(out: BoundedLogOutput, message: string): void {
  let appended = false;
  let lineStart = 0;
  while (lineStart <= message.length) {
    const newline = message.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? message.length : newline;
    let trimmedEnd = lineEnd;
    while (trimmedEnd > lineStart && isTrimWhitespace(message.charCodeAt(trimmedEnd - 1))) {
      trimmedEnd--;
    }
    if (trimmedEnd === lineStart) {
      if (appended) return;
    } else {
      if (appended) out.append(" ");
      out.appendSlice(message, lineStart, trimmedEnd);
      appended = true;
    }
    if (newline < 0) return;
    lineStart = newline + 1;
  }
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
    out.appendSlice(template, literalStart, index);
    const first = template[index + 1]!;
    let token = `%${first}`;
    if (first === "a" || first === "c") token += template[index + 2]!;
    appendTemplateValue(out, commit, token);
    index += token.length - 1;
    literalStart = index + 1;
  }
  operations = nextFormatOperation(operations);
  out.appendSlice(template, literalStart);
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

function appendTemplateValue(out: BoundedLogOutput, commit: CommitView, token: string): void {
  if (token === "%H") out.append(commit.oid);
  else if (token === "%h") out.appendSlice(commit.oid, 0, Math.min(7, commit.oid.length));
  else if (token === "%P") {
    for (let index = 0; index < commit.parent.length; index++) {
      if (index > 0) out.append(" ");
      out.append(commit.parent[index]!);
    }
  } else if (token === "%s") appendSubject(out, commit.message);
  else if (token === "%B") out.append(commit.message);
  else if (token === "%an") out.append(commit.author.name);
  else if (token === "%ae") out.append(commit.author.email);
  else if (token === "%at") out.append(String(commit.author.timestamp));
  else if (token === "%cn") out.append(commit.committer.name);
  else if (token === "%ce") out.append(commit.committer.email);
  else if (token === "%ct") out.append(String(commit.committer.timestamp));
  else if (token === "%n") out.append("\n");
  else if (token === "%%") out.append("%");
  else throw new GitError("EINVAL", `unsupported git CLI log placeholder ${token}`);
}

function isTrimWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function utf8RangeBytes(value: string, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff) || index + 1 >= end) {
        throw new GitError("EINVAL", "git CLI log output must be well-formed UTF-16");
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", "git CLI log output must be well-formed UTF-16");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}
