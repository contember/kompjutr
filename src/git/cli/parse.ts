import { GitError } from "../common/errors.js";
import {
  type GitCliOutputContext,
  gitCliCommitMessageRequired,
  gitCliDiagnosticResult,
  gitCliLogFailure,
  gitCliNetworkRefusal,
  gitCliUnknownCommand,
  gitCliUnknownOptionFailure,
  gitCliUsageFailure,
  gitCliUtf8ByteLength,
  resolveGitCliRunOptions,
} from "./result.js";
import {
  GIT_CLI_MAX_ARGV_ENTRIES,
  GIT_CLI_MAX_ENV_ENTRIES,
  GIT_CLI_MAX_LOG_COUNT,
  type GitCliEnvironment,
  type GitCliInvocation,
  type GitCliLogCommand,
  type GitCliLogFormat,
  type GitCliParseResult,
  type GitCliRevision,
  type ParsedGitCliCommand,
} from "./types.js";

const INPUT_KEYS = new Set(["argv", "cwd", "env", "stdin"]);
const NETWORK_COMMANDS = new Set(["fetch", "push", "pull", "clone", "ls-remote"]);
const DECIMAL_COUNT = /^[0-9]+$/;
const GLOB_PATHSPEC = /[*?[]/;

export interface ValidatedGitCliInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: GitCliEnvironment;
  readonly stdin?: string;
}

export function parseGitCliInput(
  input: unknown,
  logLimitHint?: number,
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  const diagnostics = outputContext ?? {
    options: resolveGitCliRunOptions(undefined),
  };
  const validated = validateGitCliInputInternal(input);
  const parsed = parseGitCliCommandInternal(validated.argv, logLimitHint, diagnostics);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    invocation: {
      command: parsed.invocation.command,
      cwd: validated.cwd,
      env: validated.env,
    },
  };
}

export function validateGitCliInput(input: unknown): ValidatedGitCliInput {
  return validateGitCliInputInternal(input);
}

function validateGitCliInputInternal(input: unknown): ValidatedGitCliInput {
  if (!isPlainRecord(input)) {
    throw new GitError("EINVAL", "git CLI input must be a plain object");
  }
  validateInputKeys(input);
  if (!Object.hasOwn(input, "argv")) {
    throw new GitError("EINVAL", "git CLI argv must be an array");
  }
  const inputArgv: unknown = Reflect.get(input, "argv");
  if (!Array.isArray(inputArgv)) {
    throw new GitError("EINVAL", "git CLI argv must be an array");
  }
  const argvLength = inputArgv.length;
  if (argvLength > GIT_CLI_MAX_ARGV_ENTRIES) {
    throw new GitError("E2BIG", `git CLI argv exceeds ${GIT_CLI_MAX_ARGV_ENTRIES} entries`);
  }
  const argv = new Array<string>(argvLength);
  for (let index = 0; index < argvLength; index++) {
    if (inputArgv.length !== argvLength) throw mutatedArgv();
    const argument: unknown = inputArgv[index];
    if (inputArgv.length !== argvLength) throw mutatedArgv();
    if (typeof argument !== "string") {
      throw new GitError("EINVAL", "git CLI argv entries must be strings");
    }
    gitCliUtf8ByteLength(argument, "git CLI argument", true);
    argv[index] = argument;
  }
  if (inputArgv.length !== argvLength) throw mutatedArgv();
  const cwd = validateCwd(input);
  const env = validateEnvironment(input);
  let stdin: string | undefined;
  if (Object.hasOwn(input, "stdin")) {
    const inputStdin: unknown = Reflect.get(input, "stdin");
    if (inputStdin !== undefined && typeof inputStdin !== "string") {
      throw new GitError("EINVAL", "git CLI stdin must be a string");
    }
    if (inputStdin !== undefined) {
      gitCliUtf8ByteLength(inputStdin, "git CLI stdin", false);
      stdin = inputStdin;
    }
  }
  return { argv, cwd, env, stdin };
}

export function parseGitCliCommand(
  argv: readonly string[],
  logLimitHint?: number,
): GitCliParseResult {
  const diagnostics: GitCliOutputContext = {
    options: resolveGitCliRunOptions(undefined),
  };
  return parseGitCliCommandInternal(argv, logLimitHint, diagnostics);
}

function parseGitCliCommandInternal(
  argv: readonly string[],
  logLimitHint: number | undefined,
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  const name = argv[0];
  if (name === undefined) {
    return { ok: false, result: gitCliUnknownCommand(undefined, outputContext) };
  }
  if (NETWORK_COMMANDS.has(name)) {
    return { ok: false, result: gitCliNetworkRefusal(name, outputContext) };
  }
  let command: ParsedGitCliCommand | undefined;
  if (name === "status") command = parseStatus(argv);
  else if (name === "diff") command = parseDiff(argv);
  else if (name === "log") return parseLog(argv, logLimitHint, outputContext);
  else if (name === "rev-list") command = parseRevList(argv);
  else if (name === "symbolic-ref") command = parseSymbolicRef(argv);
  else if (name === "add") command = parseAdd(argv);
  else if (name === "commit") command = parseCommit(argv);
  else if (name === "rebase") command = parseRebase(argv);
  else return { ok: false, result: gitCliUnknownCommand(name, outputContext) };
  if (command === undefined) return invalidInvocation(name, argv, outputContext);
  return invocation(command);
}

function parseStatus(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 2) return undefined;
  const option = argv[1];
  if (option === "--porcelain" || option === "--porcelain=v1") {
    return { kind: "status", format: "porcelain-v1" };
  }
  if (option === "--short" || option === "-s") {
    return { kind: "status", format: "short" };
  }
  return undefined;
}

function parseDiff(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 1) return undefined;
  return { kind: "diff" };
}

function parseLog(
  argv: readonly string[],
  logLimitHint: number | undefined,
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  let count: number | undefined;
  let format: GitCliLogFormat = { kind: "default" };
  let hasFormat = false;
  let revision: GitCliRevision | undefined;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) throw new Error("git CLI argv changed during parsing");
    if (revision !== undefined) {
      return {
        ok: false,
        result: gitCliLogFailure(
          "options and revisions must precede no extra arguments",
          outputContext,
        ),
      };
    }
    if (argument === "-1") {
      if (count !== undefined) return duplicateLogSelector("count", outputContext);
      count = 1;
      continue;
    }
    if (argument === "-n") {
      if (count !== undefined) return duplicateLogSelector("count", outputContext);
      const value = argv[index + 1];
      if (value === undefined) {
        return {
          ok: false,
          result: gitCliLogFailure("option '-n' requires a value", outputContext),
        };
      }
      const parsed = parseCount(value);
      if (parsed === undefined) {
        return {
          ok: false,
          result: gitCliDiagnosticResult(
            "fatal: '",
            value,
            "': not an integer\n",
            128,
            outputContext,
          ),
        };
      }
      count = parsed;
      index++;
      continue;
    }
    if (argument.startsWith("--max-count=")) {
      if (count !== undefined) return duplicateLogSelector("count", outputContext);
      const value = argument.slice("--max-count=".length);
      const parsed = parseCount(value);
      if (parsed === undefined) {
        return {
          ok: false,
          result: gitCliDiagnosticResult(
            "fatal: '",
            value,
            "': not an integer\n",
            128,
            outputContext,
          ),
        };
      }
      count = parsed;
      continue;
    }
    if (argument === "--oneline") {
      if (hasFormat) return duplicateLogSelector("format", outputContext);
      hasFormat = true;
      format = { kind: "oneline" };
      continue;
    }
    if (argument.startsWith("--format=")) {
      if (hasFormat) return duplicateLogSelector("format", outputContext);
      const template = argument.slice("--format=".length);
      validateLogFormat(template);
      hasFormat = true;
      format = { kind: "template", template };
      continue;
    }
    if (argument.startsWith("-")) {
      return {
        ok: false,
        result: gitCliDiagnosticResult(
          "fatal: unrecognized argument: ",
          argument,
          "\n",
          128,
          outputContext,
        ),
      };
    }
    const parsedRevision = parseRevision(argument);
    if (parsedRevision === undefined) {
      return {
        ok: false,
        result: gitCliDiagnosticResult(
          "fatal: invalid revision expression: ",
          argument,
          "\n",
          128,
          outputContext,
        ),
      };
    }
    revision = parsedRevision;
  }
  if (logLimitHint !== undefined && (count === undefined || logLimitHint < count)) {
    count = logLimitHint;
  }
  const command: GitCliLogCommand = { kind: "log", count, format, revision };
  return invocation(command);
}

function parseRevList(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 3 || argv[1] !== "--count") return undefined;
  const value = argv[2];
  if (value === undefined) return undefined;
  const range = parseRange(value);
  if (range === undefined) return undefined;
  return { kind: "rev-list", left: range.left, right: range.right };
}

function parseSymbolicRef(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 3 || argv[1] !== "--short" || argv[2] === "") return undefined;
  const ref = argv[2];
  if (ref === undefined) return undefined;
  return { kind: "symbolic-ref", ref };
}

function parseAdd(argv: readonly string[]): ParsedGitCliCommand | undefined {
  const paths: string[] = [];
  let endOptions = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (!endOptions && argument === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && argument.startsWith("-")) return undefined;
    if (argument.length === 0 || GLOB_PATHSPEC.test(argument) || argument.startsWith(":")) {
      return undefined;
    }
    paths.push(argument);
  }
  if (paths.length === 0) return undefined;
  return { kind: "add", paths };
}

function parseCommit(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 3 && argv[1] === "-m") {
    const message = argv[2];
    if (message === undefined) return undefined;
    validateCommitMessage(message);
    return { kind: "commit", message };
  }
  if (argv.length === 2 && argv[1]?.startsWith("--message=")) {
    const message = argv[1].slice("--message=".length);
    validateCommitMessage(message);
    return { kind: "commit", message };
  }
  return undefined;
}

function parseRebase(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 2) return undefined;
  if (argv[1] === "--continue") {
    return { kind: "rebase", action: "continue" };
  }
  if (argv[1] === "--abort") {
    return { kind: "rebase", action: "abort" };
  }
  return undefined;
}

function invalidInvocation(
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
  if (
    command === "status" ||
    command === "diff" ||
    command === "rev-list" ||
    command === "symbolic-ref" ||
    command === "add" ||
    command === "commit" ||
    command === "rebase"
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

function duplicateLogSelector(
  selector: string,
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  return {
    ok: false,
    result: gitCliLogFailure(`duplicate log ${selector} selector`, outputContext),
  };
}

function parseCount(value: string): number | undefined {
  if (!DECIMAL_COUNT.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > GIT_CLI_MAX_LOG_COUNT) return undefined;
  return parsed;
}

function validateLogFormat(template: string): void {
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

function validateCommitMessage(message: string): void {
  gitCliUtf8ByteLength(message, "git CLI commit message", true);
}

function parseRevision(value: string): GitCliRevision | undefined {
  const range = parseRange(value);
  if (range !== undefined) {
    return { kind: "range", left: range.left, right: range.right };
  }
  if (value.includes("..")) return undefined;
  if (value.length === 0) return undefined;
  return { kind: "ref", ref: value };
}

function parseRange(value: string): { left: string; right: string } | undefined {
  const separator = value.indexOf("..");
  if (separator <= 0 || separator + 2 >= value.length) return undefined;
  if (value.indexOf("..", separator + 2) !== -1 || value[separator + 2] === ".") return undefined;
  const left = value.slice(0, separator);
  const right = value.slice(separator + 2);
  return { left, right };
}

function invocation(command: ParsedGitCliCommand): GitCliParseResult {
  const value: GitCliInvocation = { command, cwd: "/", env: {} };
  return { ok: true, invocation: value };
}

function validateInputKeys(input: object): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !INPUT_KEYS.has(key)) {
      throw new GitError("EINVAL", `unknown git CLI input field: ${String(key)}`);
    }
  }
}

function validateCwd(input: object): string {
  if (!Object.hasOwn(input, "cwd")) return "/";
  const inputCwd: unknown = Reflect.get(input, "cwd");
  if (inputCwd === undefined) return "/";
  if (typeof inputCwd !== "string" || inputCwd.length === 0 || !inputCwd.startsWith("/")) {
    throw new GitError("EINVAL", "git CLI cwd must be a non-empty absolute path");
  }
  gitCliUtf8ByteLength(inputCwd, "git CLI cwd", true);
  return inputCwd;
}

function validateEnvironment(input: object): GitCliEnvironment {
  if (!Object.hasOwn(input, "env")) return {};
  const inputEnv: unknown = Reflect.get(input, "env");
  if (inputEnv === undefined) return {};
  if (!isPlainRecord(inputEnv)) {
    throw new GitError("EINVAL", "git CLI env must be a plain object");
  }
  const keys = Reflect.ownKeys(inputEnv);
  if (keys.length > GIT_CLI_MAX_ENV_ENTRIES) {
    throw new GitError("E2BIG", `git CLI env exceeds ${GIT_CLI_MAX_ENV_ENTRIES} entries`);
  }
  let authorName: string | undefined;
  let authorEmail: string | undefined;
  let committerName: string | undefined;
  let committerEmail: string | undefined;
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0 || key.includes("=")) {
      throw new GitError("EINVAL", "git CLI env names must be non-empty strings without '='");
    }
    const value: unknown = Reflect.get(inputEnv, key);
    if (typeof value !== "string")
      throw new GitError("EINVAL", "git CLI env values must be strings");
    gitCliUtf8ByteLength(key, "git CLI env name", true);
    gitCliUtf8ByteLength(value, "git CLI env value", true);
    if (key === "GIT_AUTHOR_NAME") authorName = value;
    else if (key === "GIT_AUTHOR_EMAIL") authorEmail = value;
    else if (key === "GIT_COMMITTER_NAME") committerName = value;
    else if (key === "GIT_COMMITTER_EMAIL") committerEmail = value;
  }
  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  };
}

function mutatedArgv(): GitError {
  return new GitError("EINVAL", "git CLI argv changed during validation");
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
