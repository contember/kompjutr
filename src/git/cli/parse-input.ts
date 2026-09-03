import { GitError } from "../common/errors.js";
import { gitCliUtf8ByteLength } from "./result.js";
import {
  GIT_CLI_MAX_ARGV_ENTRIES,
  GIT_CLI_MAX_ENV_ENTRIES,
  type GitCliEnvironment,
} from "./types.js";

const INPUT_KEYS = new Set(["argv", "cwd", "env", "stdin"]);

export interface ValidatedGitCliInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: GitCliEnvironment;
  readonly stdin?: string;
}

export function validateGitCliInputInternal(input: unknown): ValidatedGitCliInput {
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
