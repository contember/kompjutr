import type { GitCliOutputContext } from "../result.js";
import { gitCliUnknownCommand, resolveGitCliRunOptions } from "../result.js";
import type { GitCliParseResult, ParsedGitCliCommand } from "../types.js";
import { validateGitCliInputInternal } from "./parse-input.js";
import {
  parseClone,
  parseFetch,
  parseInit,
  parseLsRemote,
  parsePull,
  parsePush,
  parseRemote,
} from "./parse-network.js";
import {
  parseBranch,
  parseDiff,
  parseLog,
  parseLsFiles,
  parseRevList,
  parseRevParse,
  parseShow,
  parseStatus,
  parseSymbolicRef,
} from "./parse-read.js";
import { invalidInvocation, invocation } from "./parse-utils.js";
import {
  parseAdd,
  parseCheckout,
  parseCommit,
  parseMerge,
  parseRebase,
  parseReset,
  parseRestore,
  parseSwitch,
} from "./parse-write.js";

export type { ValidatedGitCliInput } from "./parse-input.js";

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

export function validateGitCliInput(
  input: unknown,
): import("./parse-input.js").ValidatedGitCliInput {
  return validateGitCliInputInternal(input);
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
  let command: ParsedGitCliCommand | undefined;
  if (name === "init") command = parseInit(argv);
  else if (name === "clone") command = parseClone(argv);
  else if (name === "remote") command = parseRemote(argv);
  else if (name === "ls-remote") command = parseLsRemote(argv);
  else if (name === "fetch") command = parseFetch(argv);
  else if (name === "pull") command = parsePull(argv);
  else if (name === "push") command = parsePush(argv);
  else if (name === "status") command = parseStatus(argv);
  else if (name === "rev-parse") command = parseRevParse(argv);
  else if (name === "branch") command = parseBranch(argv);
  else if (name === "ls-files") command = parseLsFiles(argv);
  else if (name === "diff") command = parseDiff(argv);
  else if (name === "log") return parseLog(argv, logLimitHint, outputContext);
  else if (name === "show") command = parseShow(argv);
  else if (name === "rev-list") command = parseRevList(argv);
  else if (name === "symbolic-ref") command = parseSymbolicRef(argv);
  else if (name === "add") return parseAdd(argv, outputContext);
  else if (name === "commit") return parseCommit(argv, outputContext);
  else if (name === "reset") command = parseReset(argv);
  else if (name === "checkout") command = parseCheckout(argv);
  else if (name === "switch") command = parseSwitch(argv);
  else if (name === "restore") command = parseRestore(argv);
  else if (name === "rebase") command = parseRebase(argv);
  else if (name === "merge") command = parseMerge(argv);
  else return { ok: false, result: gitCliUnknownCommand(name, outputContext) };
  if (command === undefined) return invalidInvocation(name, argv, outputContext);
  return invocation(command);
}
