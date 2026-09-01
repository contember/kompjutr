import { GitError } from "../common/errors.js";
import {
  type GitCliOutputContext,
  gitCliCommitMessageRequired,
  gitCliDiagnosticResult,
  gitCliLogFailure,
  gitCliRevisionRequired,
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
  type GitCliAddCommand,
  type GitCliCheckoutCommand,
  type GitCliCommitCommand,
  type GitCliEnvironment,
  type GitCliFetchCommand,
  type GitCliFetchRefspec,
  type GitCliInvocation,
  type GitCliLogCommand,
  type GitCliLogFormat,
  type GitCliParseResult,
  type GitCliPushCommand,
  type GitCliPushLease,
  type GitCliPushRefspec,
  type GitCliRestoreCommand,
  type GitCliRevision,
  type GitCliStatusCommand,
  type ParsedGitCliCommand,
} from "./types.js";

const INPUT_KEYS = new Set(["argv", "cwd", "env", "stdin"]);
const DECIMAL_COUNT = /^[0-9]+$/;
const DIFF_CONTEXT = /^-U([0-9]+)$/;
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

function parseInit(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let bare = false;
  let defaultBranch: string | undefined;
  let directory: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (argument === "--bare") {
      if (bare || directory !== undefined) return undefined;
      bare = true;
      continue;
    }
    if (argument.startsWith("--initial-branch=")) {
      if (defaultBranch !== undefined || directory !== undefined) return undefined;
      const value = argument.slice("--initial-branch=".length);
      if (!validNameOperand(value)) return undefined;
      defaultBranch = value;
      continue;
    }
    if (argument.startsWith("-") || argument === "" || directory !== undefined) return undefined;
    directory = argument;
  }
  return {
    kind: "init",
    ...(directory === undefined ? {} : { directory }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    ...(bare ? { bare: true } : {}),
  };
}

function parseClone(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let depth: number | undefined;
  let singleBranch: boolean | undefined;
  let noTags = false;
  let ref: string | undefined;
  let remote: string | undefined;
  let filter: "blob:none" | undefined;
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (operands.length > 0) {
      if (argument.startsWith("-") || operands.length === 2) return undefined;
      operands.push(argument);
      continue;
    }
    if (argument === "--single-branch" || argument === "--no-single-branch") {
      if (singleBranch !== undefined) return undefined;
      singleBranch = argument === "--single-branch";
      continue;
    }
    if (argument === "--no-tags") {
      if (noTags) return undefined;
      noTags = true;
      continue;
    }
    if (argument === "--filter=blob:none") {
      if (filter !== undefined) return undefined;
      filter = "blob:none";
      continue;
    }
    const valued = cloneValuedOption(argument, argv[index + 1]);
    if (valued !== undefined) {
      if (valued.joined === false) index++;
      if (valued.name === "depth") {
        if (depth !== undefined) return undefined;
        depth = parsePositiveDecimal(valued.value);
        if (depth === undefined) return undefined;
      } else if (valued.name === "branch") {
        if (ref !== undefined || !validRevisionOperand(valued.value)) return undefined;
        ref = valued.value;
      } else {
        if (remote !== undefined || !validNameOperand(valued.value)) return undefined;
        remote = valued.value;
      }
      continue;
    }
    if (argument.startsWith("-") || argument === "") return undefined;
    operands.push(argument);
  }
  const url = operands[0];
  if (url === undefined) return undefined;
  const directory = operands[1];
  return {
    kind: "clone",
    url,
    ...(directory === undefined ? {} : { directory }),
    ...(depth === undefined ? {} : { depth }),
    ...(singleBranch === undefined ? {} : { singleBranch }),
    ...(noTags ? { noTags: true } : {}),
    ...(ref === undefined ? {} : { ref }),
    ...(remote === undefined ? {} : { remote }),
    ...(filter === undefined ? {} : { filter }),
  };
}

function cloneValuedOption(
  argument: string,
  next: string | undefined,
): { name: "depth" | "branch" | "origin"; value: string; joined: boolean } | undefined {
  const options: readonly ("depth" | "branch" | "origin")[] = ["depth", "branch", "origin"];
  for (const option of options) {
    const long = `--${option}`;
    if (argument.startsWith(`${long}=`)) {
      return { name: option, value: argument.slice(long.length + 1), joined: true };
    }
    if (
      argument === long ||
      (option === "branch" && argument === "-b") ||
      (option === "origin" && argument === "-o")
    ) {
      if (next === undefined) return undefined;
      return { name: option, value: next, joined: false };
    }
  }
  return undefined;
}

function parseRemote(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 1) return { kind: "remote", action: "list" };
  if (argv.length === 2 && argv[1] === "-v") {
    return { kind: "remote", action: "list", verbose: true };
  }
  if (argv[1] === "add") {
    if (argv.length !== 4 || !validNameOperand(argv[2])) return undefined;
    const url = argv[3];
    if (url === undefined || url === "") return undefined;
    return {
      kind: "remote",
      action: "add",
      name: argv[2],
      url,
    };
  }
  if (
    (argv[1] === "remove" || argv[1] === "rm") &&
    argv.length === 3 &&
    validNameOperand(argv[2])
  ) {
    return { kind: "remote", action: "remove", name: argv[2] };
  }
  if (argv[1] === "get-url" && argv.length === 3 && validNameOperand(argv[2])) {
    return { kind: "remote", action: "get-url", name: argv[2] };
  }
  if (argv[1] === "set-url" && argv.length === 4 && validNameOperand(argv[2]) && argv[3] !== "") {
    return { kind: "remote", action: "set-url", name: argv[2], url: argv[3] };
  }
  return undefined;
}

function parseLsRemote(argv: readonly string[]): ParsedGitCliCommand | undefined {
  const target = argv[1];
  if (target?.startsWith("-") === true) return undefined;
  const patterns = argv.slice(target === undefined ? 1 : 2);
  if (patterns.some((pattern) => pattern === "" || pattern.startsWith("-"))) return undefined;
  return { kind: "ls-remote", ...(target === undefined ? {} : { target }), patterns };
}

function parseFetch(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let depth: number | undefined;
  let deepen: number | undefined;
  let unshallow = false;
  let singleBranch = false;
  let prune = false;
  let tags: boolean | undefined;
  let filter: "blob:none" | undefined;
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (operands.length > 0) {
      if (argument.startsWith("-")) return undefined;
      operands.push(argument);
      continue;
    }
    if (argument === "--unshallow") {
      if (unshallow) return undefined;
      unshallow = true;
    } else if (argument === "--single-branch") {
      if (singleBranch) return undefined;
      singleBranch = true;
    } else if (argument === "--prune") {
      if (prune) return undefined;
      prune = true;
    } else if (argument === "--tags" || argument === "--no-tags") {
      if (tags !== undefined) return undefined;
      tags = argument === "--tags";
    } else if (argument === "--filter=blob:none") {
      if (filter !== undefined) return undefined;
      filter = "blob:none";
    } else if (argument === "--depth" || argument === "--deepen") {
      const value = argv[index + 1];
      const parsed = value === undefined ? undefined : parsePositiveDecimal(value);
      if (parsed === undefined) return undefined;
      if (argument === "--depth") {
        if (depth !== undefined) return undefined;
        depth = parsed;
      } else {
        if (deepen !== undefined) return undefined;
        deepen = parsed;
      }
      index++;
    } else if (argument.startsWith("--depth=") || argument.startsWith("--deepen=")) {
      const isDepth = argument.startsWith("--depth=");
      const parsed = parsePositiveDecimal(argument.slice(isDepth ? 8 : 9));
      if (parsed === undefined || (isDepth ? depth !== undefined : deepen !== undefined))
        return undefined;
      if (isDepth) depth = parsed;
      else deepen = parsed;
    } else if (argument.startsWith("-")) return undefined;
    else operands.push(argument);
  }
  if ([depth !== undefined, deepen !== undefined, unshallow].filter(Boolean).length > 1)
    return undefined;
  const selection = parseFetchSelection(operands.slice(1));
  if (selection === undefined) return undefined;
  if (
    selection.refspecs !== undefined &&
    (depth !== undefined ||
      deepen !== undefined ||
      unshallow ||
      prune ||
      singleBranch ||
      tags !== undefined)
  )
    return undefined;
  return {
    kind: "fetch",
    ...(operands[0] === undefined ? {} : { target: operands[0] }),
    ...selection,
    ...(depth === undefined ? {} : { depth }),
    ...(deepen === undefined ? {} : { deepen }),
    ...(unshallow ? { unshallow: true } : {}),
    ...(singleBranch ? { singleBranch: true } : {}),
    ...(prune ? { prune: true } : {}),
    ...(tags === undefined ? {} : { tags }),
    ...(filter === undefined ? {} : { filter }),
  };
}

function parseFetchSelection(
  operands: readonly string[],
): Pick<GitCliFetchCommand, "selector" | "refspecs"> | undefined {
  if (operands.length === 0) return {};
  if (operands.length === 1 && !operands[0]?.includes(":")) return { selector: operands[0] };
  const mappings: GitCliFetchRefspec[] = [];
  for (const operand of operands) {
    const force = operand.startsWith("+");
    const value = force ? operand.slice(1) : operand;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon !== value.lastIndexOf(":") || colon === value.length - 1)
      return undefined;
    mappings.push({
      source: value.slice(0, colon),
      destination: value.slice(colon + 1),
      ...(force ? { force: true } : {}),
    });
  }
  const first = mappings[0];
  if (first === undefined) return undefined;
  return { refspecs: [first, ...mappings.slice(1)] };
}

function parsePull(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let fastForward: boolean | undefined;
  let fastForwardOnly = false;
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--ff" || argument === "--no-ff") {
      if (fastForward !== undefined || fastForwardOnly || operands.length > 0) return undefined;
      fastForward = argument === "--ff";
    } else if (argument === "--ff-only") {
      if (fastForward !== undefined || fastForwardOnly || operands.length > 0) return undefined;
      fastForwardOnly = true;
    } else {
      if (argument === undefined || argument.startsWith("-") || operands.length === 2)
        return undefined;
      operands.push(argument);
    }
  }
  return {
    kind: "pull",
    ...(operands[0] === undefined ? {} : { remote: operands[0] }),
    ...(operands[1] === undefined ? {} : { branch: operands[1] }),
    ...(fastForward === undefined ? {} : { fastForward }),
    ...(fastForwardOnly ? { fastForwardOnly: true } : {}),
  };
}

function parsePush(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let force = false;
  let deleteSelection = false;
  let atomic = false;
  const leases: GitCliPushLease[] = [];
  const pushOptions: string[] = [];
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) return undefined;
    if (operands.length > 0) {
      if (argument.startsWith("-")) return undefined;
      operands.push(argument);
    } else if (argument === "--force" || argument === "-f") {
      if (force) return undefined;
      force = true;
    } else if (argument === "--delete") {
      if (deleteSelection) return undefined;
      deleteSelection = true;
    } else if (argument === "--atomic") {
      if (atomic) return undefined;
      atomic = true;
    } else if (argument.startsWith("--push-option=")) {
      pushOptions.push(argument.slice("--push-option=".length));
    } else if (argument.startsWith("--force-with-lease=")) {
      const value = argument.slice("--force-with-lease=".length);
      const colon = value.indexOf(":");
      const destination = colon < 0 ? value : value.slice(0, colon);
      if (
        !validNameOperand(destination) ||
        leases.some((lease) => lease.destination === destination)
      )
        return undefined;
      if (colon < 0) leases.push({ destination, tracking: true });
      else leases.push({ destination, expected: value.slice(colon + 1) || null });
    } else if (argument.startsWith("-")) return undefined;
    else operands.push(argument);
  }
  const selection = parsePushSelection(operands.slice(1), force);
  if (
    selection === undefined ||
    (deleteSelection && (selection.refspecs !== undefined || selection.selector === undefined))
  )
    return undefined;
  return {
    kind: "push",
    ...(operands[0] === undefined ? {} : { target: operands[0] }),
    ...selection,
    ...(force ? { force: true } : {}),
    ...(deleteSelection ? { delete: true } : {}),
    ...(atomic ? { atomic: true } : {}),
    leases,
    pushOptions,
  };
}

function parsePushSelection(
  operands: readonly string[],
  forceAll: boolean,
): Pick<GitCliPushCommand, "selector" | "refspecs"> | undefined {
  if (operands.length === 0) return {};
  if (operands.length === 1 && !operands[0]?.includes(":")) return { selector: operands[0] };
  const mappings: GitCliPushRefspec[] = [];
  for (const operand of operands) {
    const force = forceAll || operand.startsWith("+");
    const value = operand.startsWith("+") ? operand.slice(1) : operand;
    const colon = value.indexOf(":");
    if (colon < 0 || colon !== value.lastIndexOf(":") || colon === value.length - 1)
      return undefined;
    const source = colon === 0 ? null : value.slice(0, colon);
    const destination = value.slice(colon + 1);
    if (source === null) mappings.push({ source: null, destination });
    else mappings.push({ source, destination, ...(force ? { force: true } : {}) });
  }
  const first = mappings[0];
  if (first === undefined) return undefined;
  return { refspecs: [first, ...mappings.slice(1)] };
}

function parseStatus(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseRevParse(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseBranch(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseLsFiles(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseDiff(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseLog(
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

function parseShow(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseAdd(argv: readonly string[], outputContext?: GitCliOutputContext): GitCliParseResult {
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

function parseCommit(
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

function parseReset(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseCheckout(argv: readonly string[]): GitCliCheckoutCommand | undefined {
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

function parseSwitch(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length === 2 && validNameOperand(argv[1])) {
    return { kind: "switch", action: "switch", name: argv[1] };
  }
  if (argv.length === 3 && argv[1] === "-c" && validNameOperand(argv[2])) {
    return { kind: "switch", action: "create", name: argv[2] };
  }
  return undefined;
}

function parseRestore(argv: readonly string[]): GitCliRestoreCommand | undefined {
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

function parseRebase(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

function parseMerge(argv: readonly string[]): ParsedGitCliCommand | undefined {
  if (argv.length !== 2) return undefined;
  if (argv[1] === "--continue") return { kind: "merge", action: "continue" };
  if (argv[1] === "--abort") return { kind: "merge", action: "abort" };
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

function parseSafeDecimal(value: string): number | undefined {
  if (!DECIMAL_COUNT.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePositiveDecimal(value: string): number | undefined {
  const parsed = parseSafeDecimal(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function validLiteralPathspec(value: string): boolean {
  return value.length > 0 && !GLOB_PATHSPEC.test(value) && !value.startsWith(":");
}

function validNameOperand(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith("-");
}

function validRevisionOperand(value: string | undefined): value is string {
  return validNameOperand(value);
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
