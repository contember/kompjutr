import {
  duplicateLogSelector,
  invalidInvocation,
  invocation,
  parseCount,
  parseRange,
  parseRevision,
  parseSafeDecimal,
  validateLogFormat,
  validLiteralPathspec,
  validNameOperand,
  validRevisionOperand,
} from "./parse-utils.js";
import { type GitCliOutputContext, gitCliDiagnosticResult, gitCliLogFailure } from "./result.js";
import type {
  GitCliLogCommand,
  GitCliLogFormat,
  GitCliParseResult,
  GitCliRevision,
  GitCliStatusCommand,
  ParsedGitCliCommand,
} from "./types.js";

const DIFF_CONTEXT = /^-U([0-9]+)$/;

export function parseStatus(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let format: GitCliStatusCommand["format"] = "default";
  let hasFormat = false;
  let branch = false;
  const paths: string[] = [];
  let pathMode = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (!pathMode && argument === "--") {
      pathMode = true;
      continue;
    }
    if (pathMode || !argument.startsWith("-")) {
      pathMode = true;
      if (!validLiteralPathspec(argument)) return undefined;
      paths.push(argument);
      continue;
    }
    if (argument === "-b" || argument === "--branch") {
      if (branch) return undefined;
      branch = true;
      continue;
    }
    let selected: GitCliStatusCommand["format"] | undefined;
    if (argument === "--porcelain" || argument === "--porcelain=v1") {
      selected = "porcelain-v1";
    } else if (argument === "--porcelain=v2") selected = "porcelain-v2";
    else if (argument === "--short" || argument === "-s") selected = "short";
    if (selected === undefined || hasFormat) return undefined;
    format = selected;
    hasFormat = true;
  }
  return {
    kind: "status",
    format,
    ...(branch ? { branch: true } : {}),
    ...(paths.length === 0 ? {} : { paths }),
  };
}

export function parseRevParse(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 2 && argv[1] === "--show-toplevel") {
    return { kind: "rev-parse", showToplevel: true };
  }
  let verify = false;
  let quiet = false;
  let revision: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (argument === "--verify") {
      if (verify || revision !== undefined) return undefined;
      verify = true;
      continue;
    }
    if (argument === "--quiet") {
      if (quiet || revision !== undefined) return undefined;
      quiet = true;
      continue;
    }
    if (argument.startsWith("-") || argument === "" || revision !== undefined) return undefined;
    revision = argument;
  }
  if (revision === undefined || (quiet && !verify)) return undefined;
  return {
    kind: "rev-parse",
    revision,
    ...(verify ? { verify: true } : {}),
    ...(quiet ? { quiet: true } : {}),
  };
}

export function parseBranch(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 1) return { kind: "branch", action: "list" };
  if (argv[1] === "--show-current") return { kind: "branch", action: "show-current" };
  if (argv[1] === "--list" && argv.length === 2) return { kind: "branch", action: "list" };
  if (
    (argv[1] === "-d" || argv[1] === "--delete") &&
    validNameOperand(argv[2]) &&
    argv.length === 3
  ) {
    return { kind: "branch", action: "delete", name: argv[2] };
  }
  if (argv[1] === "-D" && validNameOperand(argv[2]) && argv.length === 3) {
    return { kind: "branch", action: "delete", name: argv[2], force: true };
  }
  if (argv[1] === "-m" || argv[1] === "--move") {
    if (validNameOperand(argv[2]) && argv.length === 3) {
      return { kind: "branch", action: "rename", newName: argv[2] };
    }
    if (validNameOperand(argv[2]) && validNameOperand(argv[3]) && argv.length === 4) {
      return { kind: "branch", action: "rename", oldName: argv[2], newName: argv[3] };
    }
    return undefined;
  }
  const name = argv[1];
  const startPoint = argv[2];
  if (!validNameOperand(name) || argv.length > 3) return undefined;
  if (startPoint !== undefined && !validRevisionOperand(startPoint)) return undefined;
  return {
    kind: "branch",
    action: "create",
    name,
    ...(startPoint === undefined ? {} : { startPoint }),
  };
}

export function parseLsFiles(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let cached = false;
  let others = false;
  let excludeStandard = false;
  const paths: string[] = [];
  let pathMode = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (!pathMode && argument === "--") {
      pathMode = true;
      continue;
    }
    if (pathMode || !argument.startsWith("-")) {
      pathMode = true;
      if (!validLiteralPathspec(argument)) return undefined;
      paths.push(argument);
      continue;
    }
    if (argument === "--cached") {
      if (cached) return undefined;
      cached = true;
    } else if (argument === "--others") {
      if (others) return undefined;
      others = true;
    } else if (argument === "--exclude-standard") {
      if (excludeStandard) return undefined;
      excludeStandard = true;
    } else return undefined;
  }
  if (excludeStandard && !others) return undefined;
  return {
    kind: "ls-files",
    ...(cached ? { cached: true } : {}),
    ...(others ? { others: true } : {}),
    ...(excludeStandard ? { excludeStandard: true } : {}),
    ...(paths.length === 0 ? {} : { paths }),
  };
}

export function parseDiff(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 1) return { kind: "diff" };
  let staged = false;
  let context: number | undefined;
  const revisions: string[] = [];
  const paths: string[] = [];
  let pathMode = false;
  let optionMode = true;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (!pathMode && argument === "--") {
      pathMode = true;
      optionMode = false;
      continue;
    }
    if (pathMode) {
      if (!validLiteralPathspec(argument)) return undefined;
      paths.push(argument);
      continue;
    }
    if (optionMode && (argument === "--cached" || argument === "--staged")) {
      if (staged) return undefined;
      staged = true;
      continue;
    }
    if (optionMode) {
      const match = DIFF_CONTEXT.exec(argument);
      if (match !== null) {
        if (context !== undefined) return undefined;
        const value = match[1];
        if (value === undefined) return undefined;
        context = parseSafeDecimal(value);
        if (context === undefined) return undefined;
        continue;
      }
    }
    if (argument.startsWith("-") || argument.length === 0) return undefined;
    optionMode = false;
    revisions.push(argument);
    if (revisions.length > (staged ? 1 : 2)) return undefined;
  }
  if (pathMode && paths.length === 0) return undefined;
  const ref = revisions[0];
  const to = revisions[1];
  return {
    kind: "diff",
    ...(staged ? { staged: true } : {}),
    ...(ref === undefined ? {} : { ref }),
    ...(to === undefined ? {} : { to }),
    ...(paths.length === 0 ? {} : { paths }),
    ...(context === undefined ? {} : { context }),
  };
}

export function parseLog(
  argv: readonly string[],
  logLimitHint: number | undefined,
  outputContext?: GitCliOutputContext,
): GitCliParseResult {
  let count: number | undefined;
  let format: GitCliLogFormat = { kind: "default" };
  let hasFormat = false;
  let revision: GitCliRevision | undefined;
  let firstParent = false;
  let pathMode = false;
  const paths: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) throw new Error("git CLI argv changed during parsing");
    if (pathMode) {
      if (!validLiteralPathspec(argument)) return invalidInvocation("log", argv, outputContext);
      paths.push(argument);
      continue;
    }
    if (argument === "--") {
      pathMode = true;
      continue;
    }
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
    if (argument === "--first-parent") {
      if (firstParent) return duplicateLogSelector("first-parent", outputContext);
      firstParent = true;
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
  if (pathMode && paths.length === 0) return invalidInvocation("log", argv, outputContext);
  if (logLimitHint !== undefined && (count === undefined || logLimitHint < count)) {
    count = logLimitHint;
  }
  const command: GitCliLogCommand = {
    kind: "log",
    count,
    format,
    revision,
    ...(firstParent ? { firstParent: true } : {}),
    ...(paths.length === 0 ? {} : { paths }),
  };
  return invocation(command);
}

export function parseShow(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let firstParent = false;
  let ref: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--first-parent") {
      if (firstParent || ref !== undefined) return undefined;
      firstParent = true;
      continue;
    }
    if (!validRevisionOperand(argument) || ref !== undefined) return undefined;
    ref = argument;
  }
  return {
    kind: "show",
    ...(ref === undefined ? {} : { ref }),
    ...(firstParent ? { firstParent: true } : {}),
  };
}

export function parseRevList(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 3 || argv[1] !== "--count") return undefined;
  const value = argv[2];
  if (value === undefined) return undefined;
  const range = parseRange(value);
  if (range === undefined) return undefined;
  return { kind: "rev-list", left: range.left, right: range.right };
}

export function parseSymbolicRef(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 3 || argv[1] !== "--short" || argv[2] === "") return undefined;
  const ref = argv[2];
  if (ref === undefined) return undefined;
  return { kind: "symbolic-ref", ref };
}
