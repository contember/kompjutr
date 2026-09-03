import { GitError } from "../common/errors.js";
import {
  type GitCliOutputContext,
  gitCliCommitMessageRequired,
  gitCliLogFailure,
  gitCliRevisionRequired,
  gitCliUnknownCommand,
  gitCliUnknownOptionFailure,
  gitCliUsageFailure,
  gitCliUtf8ByteLength,
} from "./result.js";
import {
  GIT_CLI_MAX_LOG_COUNT,
  type GitCliInvocation,
  type GitCliParseResult,
  type GitCliRevision,
  type ParsedGitCliCommand,
} from "./types.js";

const DECIMAL_COUNT = /^[0-9]+$/;
const GLOB_PATHSPEC = /[*?[]/;

export function invalidInvocation(
  command: string,
  argv: readonly string[],
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  if (command === "log") {
    return {
      ok: false,
      result: gitCliLogFailure("unsupported git log invocation", outputContext),
    };
  }
  if (command === "commit" && argv.length === 2 && argv[1] === "-m") {
    return { ok: false, result: gitCliCommitMessageRequired(outputContext) };
  }
  if (command === "rev-parse" && argv.length === 2 && argv[1] === "--verify") {
    return { ok: false, result: gitCliRevisionRequired(outputContext) };
  }
  if (
    command === "status" ||
    command === "rev-parse" ||
    command === "branch" ||
    command === "ls-files" ||
    command === "diff" ||
    command === "rev-list" ||
    command === "symbolic-ref" ||
    command === "add" ||
    command === "commit" ||
    command === "reset" ||
    command === "checkout" ||
    command === "switch" ||
    command === "restore" ||
    command === "rebase" ||
    command === "merge" ||
    command === "init" ||
    command === "clone" ||
    command === "remote" ||
    command === "ls-remote" ||
    command === "fetch" ||
    command === "pull" ||
    command === "push"
  ) {
    const option = argv.find(
      (argument, index) => index > 0 && argument !== "--" && argument.startsWith("-"),
    );
    if (option !== undefined) {
      return {
        ok: false,
        result: gitCliUnknownOptionFailure(command, option, outputContext),
      };
    }
    return {
      ok: false,
      result: gitCliUsageFailure(command, `unsupported git ${command} invocation`, outputContext),
    };
  }
  return { ok: false, result: gitCliUnknownCommand(command, outputContext) };
}

export function duplicateLogSelector(
  selector: string,
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  return {
    ok: false,
    result: gitCliLogFailure(`duplicate log ${selector} selector`, outputContext),
  };
}

export function parseCount(value: string): number | undefined {
  if (!DECIMAL_COUNT.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > GIT_CLI_MAX_LOG_COUNT) return undefined;
  return parsed;
}

export function parseSafeDecimal(value: string): number | undefined {
  if (!DECIMAL_COUNT.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parsePositiveDecimal(value: string): number | undefined {
  const parsed = parseSafeDecimal(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function validLiteralPathspec(value: string): boolean {
  return value.length > 0 && !GLOB_PATHSPEC.test(value) && !value.startsWith(":");
}

export function validNameOperand(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith("-");
}

export function validRevisionOperand(value: string | undefined): value is string {
  return validNameOperand(value);
}

export function validateLogFormat(template: string): void {
  gitCliUtf8ByteLength(template, "git CLI log format", true);
  for (let index = 0; index < template.length; index++) {
    if (template.charCodeAt(index) !== 0x25) continue;
    const first = template[index + 1];
    if (
      first === "H" ||
      first === "h" ||
      first === "P" ||
      first === "s" ||
      first === "B" ||
      first === "n" ||
      first === "%"
    ) {
      index++;
      continue;
    }
    const second = template[index + 2];
    if ((first === "a" || first === "c") && (second === "n" || second === "e" || second === "t")) {
      index += 2;
      continue;
    }
    throw new GitError("EINVAL", "git CLI log format contains an unsupported placeholder");
  }
}

export function validateCommitMessage(message: string): void {
  gitCliUtf8ByteLength(message, "git CLI commit message", true);
}

export function parseRevision(value: string): GitCliRevision | undefined {
  const range = parseRange(value);
  if (range !== undefined) {
    return { kind: "range", left: range.left, right: range.right };
  }
  if (value.includes("..")) return undefined;
  if (value.length === 0) return undefined;
  return { kind: "ref", ref: value };
}

export function parseRange(value: string): { left: string; right: string } | undefined {
  const separator = value.indexOf("..");
  if (separator <= 0 || separator + 2 >= value.length) return undefined;
  if (value.indexOf("..", separator + 2) !== -1 || value[separator + 2] === ".") return undefined;
  const left = value.slice(0, separator);
  const right = value.slice(separator + 2);
  return { left, right };
}

export function invocation(command: ParsedGitCliCommand): GitCliParseResult {
  const value: GitCliInvocation = { command, cwd: "/", env: {} };
  return { ok: true, invocation: value };
}
