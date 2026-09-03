import {
  type GitCliOutputContext,
  gitCliCommitMessageRequired,
  gitCliDiagnosticResult,
  gitCliUnknownOptionFailure,
} from "../result.js";
import type {
  GitCliAddCommand,
  GitCliCheckoutCommand,
  GitCliCommitCommand,
  GitCliParseResult,
  GitCliRestoreCommand,
  ParsedGitCliCommand,
} from "../types.js";
import {
  invalidInvocation,
  invocation,
  validateCommitMessage,
  validLiteralPathspec,
  validNameOperand,
  validRevisionOperand,
} from "./parse-utils.js";

export function parseAdd(
  argv: readonly string[],
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  const paths: string[] = [];
  let all = false;
  let update = false;
  let force = false;
  let endOptions = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return invalidInvocation("add", argv, outputContext);
    if (!endOptions && argument === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && (argument === "-A" || argument === "--all")) {
      if (all) return invalidInvocation("add", argv, outputContext);
      all = true;
      continue;
    }
    if (!endOptions && (argument === "-u" || argument === "--update")) {
      if (update) return invalidInvocation("add", argv, outputContext);
      update = true;
      continue;
    }
    if (!endOptions && (argument === "-f" || argument === "--force")) {
      if (force) return invalidInvocation("add", argv, outputContext);
      force = true;
      continue;
    }
    if (!endOptions && argument.startsWith("-")) {
      return {
        ok: false,
        result: gitCliUnknownOptionFailure("add", argument, outputContext),
      };
    }
    if (!validLiteralPathspec(argument)) {
      return invalidInvocation("add", argv, outputContext);
    }
    paths.push(argument);
  }
  if (all && update) {
    return {
      ok: false,
      result: gitCliDiagnosticResult(
        "fatal: options '-A' and '-u' cannot be used together\n",
        "",
        "",
        128,
        outputContext,
      ),
    };
  }
  if ((all || update) && paths.length > 0) {
    return invalidInvocation("add", argv, outputContext);
  }
  if (!all && !update && paths.length === 0) {
    return invalidInvocation("add", argv, outputContext);
  }
  const command: GitCliAddCommand = {
    kind: "add",
    paths,
    ...(all ? { all: true } : {}),
    ...(update ? { update: true } : {}),
    ...(force ? { force: true } : {}),
  };
  return invocation(command);
}

export function parseCommit(
  argv: readonly string[],
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  let message: string | undefined;
  let all = false;
  let amend = false;
  let allowEmpty = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return invalidInvocation("commit", argv, outputContext);
    if (argument === "-m" || argument === "--message") {
      if (message !== undefined) return invalidInvocation("commit", argv, outputContext);
      const value = argv[index + 1];
      if (value === undefined) {
        return {
          ok: false,
          result:
            argument === "-m"
              ? gitCliCommitMessageRequired(outputContext)
              : gitCliDiagnosticResult(
                  "error: option `message' requires a value\n",
                  "",
                  "",
                  129,
                  outputContext,
                ),
        };
      }
      validateCommitMessage(value);
      message = value;
      index++;
      continue;
    }
    if (argument.startsWith("--message=")) {
      if (message !== undefined) return invalidInvocation("commit", argv, outputContext);
      const value = argument.slice("--message=".length);
      validateCommitMessage(value);
      message = value;
      continue;
    }
    if (argument === "-a" || argument === "--all") {
      if (all) return invalidInvocation("commit", argv, outputContext);
      all = true;
      continue;
    }
    if (argument === "--amend") {
      if (amend) return invalidInvocation("commit", argv, outputContext);
      amend = true;
      continue;
    }
    if (argument === "--allow-empty") {
      if (allowEmpty) return invalidInvocation("commit", argv, outputContext);
      allowEmpty = true;
      continue;
    }
    if (argument.startsWith("-")) {
      return {
        ok: false,
        result: gitCliUnknownOptionFailure("commit", argument, outputContext),
      };
    }
    return invalidInvocation("commit", argv, outputContext);
  }
  if (message === undefined) return invalidInvocation("commit", argv, outputContext);
  const command: GitCliCommitCommand = {
    kind: "commit",
    message,
    ...(all ? { all: true } : {}),
    ...(amend ? { amend: true } : {}),
    ...(allowEmpty ? { allowEmpty: true } : {}),
  };
  return invocation(command);
}

export function parseReset(argv: readonly string[]): ParsedGitCliCommand | undefined {
  const separator = argv.indexOf("--", 1);
  if (separator !== -1) {
    const before = argv.slice(1, separator);
    const paths = argv.slice(separator + 1);
    if (
      before.length > 1 ||
      paths.length === 0 ||
      paths.some((path) => !validLiteralPathspec(path))
    ) {
      return undefined;
    }
    const ref = before[0];
    if (ref !== undefined && !validRevisionOperand(ref)) return undefined;
    return {
      kind: "reset",
      mode: "mixed",
      ...(ref === undefined ? {} : { ref }),
      paths,
    };
  }
  let mode: "mixed" | "hard" = "mixed";
  let offset = 1;
  if (argv[1] === "--mixed" || argv[1] === "--hard") {
    mode = argv[1] === "--hard" ? "hard" : "mixed";
    offset++;
  }
  const ref = argv[offset];
  if (argv.length > offset + 1 || (ref !== undefined && !validRevisionOperand(ref)))
    return undefined;
  return { kind: "reset", mode, ...(ref === undefined ? {} : { ref }) };
}

export function parseCheckout(argv: readonly string[]): GitCliCheckoutCommand | undefined {
  if (argv[1] === "-b") {
    const name = argv[2];
    const startPoint = argv[3];
    if (!validNameOperand(name) || argv.length > 4) return undefined;
    if (startPoint !== undefined && !validRevisionOperand(startPoint)) return undefined;
    return {
      kind: "checkout",
      action: "create",
      name,
      ...(startPoint === undefined ? {} : { startPoint }),
    };
  }
  let force = false;
  let offset = 1;
  if (argv[1] === "-f" || argv[1] === "--force") {
    force = true;
    offset++;
  }
  const ref = argv[offset];
  if (!validRevisionOperand(ref)) return undefined;
  if (argv.length === offset + 1) {
    return { kind: "checkout", action: "checkout", ref, ...(force ? { force: true } : {}) };
  }
  if (force || argv[offset + 1] !== "--") return undefined;
  const paths = argv.slice(offset + 2);
  if (paths.length === 0 || paths.some((path) => !validLiteralPathspec(path))) return undefined;
  return { kind: "checkout", action: "checkout", ref, paths };
}

export function parseSwitch(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 2 && validNameOperand(argv[1])) {
    return { kind: "switch", action: "switch", name: argv[1] };
  }
  if (argv.length === 3 && argv[1] === "-c" && validNameOperand(argv[2])) {
    return { kind: "switch", action: "create", name: argv[2] };
  }
  return undefined;
}

export function parseRestore(argv: readonly string[]): GitCliRestoreCommand | undefined {
  let source: string | undefined;
  let offset = 1;
  const first = argv[offset];
  if (first?.startsWith("--source=") === true) {
    source = first.slice("--source=".length);
    if (!validRevisionOperand(source)) return undefined;
    offset++;
  }
  const separated = argv[offset] === "--";
  if (separated) offset++;
  const paths = argv.slice(offset);
  if (
    paths.length === 0 ||
    paths.some((path) => !validLiteralPathspec(path) || (!separated && path.startsWith("-")))
  ) {
    return undefined;
  }
  return { kind: "restore", ...(source === undefined ? {} : { source }), paths };
}

export function parseRebase(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 2) return undefined;
  if (argv[1] === "--continue") {
    return { kind: "rebase", action: "continue" };
  }
  if (argv[1] === "--abort") {
    return { kind: "rebase", action: "abort" };
  }
  if (argv[1] === "--skip") return { kind: "rebase", action: "skip" };
  if (!validRevisionOperand(argv[1])) return undefined;
  return { kind: "rebase", action: "start", upstream: argv[1] };
}

export function parseMerge(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 2) return undefined;
  if (argv[1] === "--continue") return { kind: "merge", action: "continue" };
  if (argv[1] === "--abort") return { kind: "merge", action: "abort" };
  return undefined;
}
