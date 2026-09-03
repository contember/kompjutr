import { parsePositiveDecimal, validNameOperand, validRevisionOperand } from "./parse-utils.js";
import type {
  GitCliFetchCommand,
  GitCliFetchRefspec,
  GitCliPushCommand,
  GitCliPushLease,
  GitCliPushRefspec,
  ParsedGitCliCommand,
} from "./types.js";

export function parseInit(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

export function parseClone(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

export function parseRemote(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

export function parseLsRemote(argv: readonly string[]): ParsedGitCliCommand | undefined {
  const target = argv[1];
  if (target?.startsWith("-") === true) return undefined;
  const patterns = argv.slice(target === undefined ? 1 : 2);
  if (patterns.some((pattern) => pattern === "" || pattern.startsWith("-"))) return undefined;
  return { kind: "ls-remote", ...(target === undefined ? {} : { target }), patterns };
}

export function parseFetch(argv: readonly string[]): ParsedGitCliCommand | undefined {
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

export function parsePull(argv: readonly string[]): ParsedGitCliCommand | undefined {
  let rebase = false;
  let fastForward: boolean | undefined;
  let fastForwardOnly = false;
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--rebase") {
      if (rebase || fastForward !== undefined || fastForwardOnly || operands.length > 0)
        return undefined;
      rebase = true;
    } else if (argument === "--ff" || argument === "--no-ff") {
      if (rebase || fastForward !== undefined || fastForwardOnly || operands.length > 0)
        return undefined;
      fastForward = argument === "--ff";
    } else if (argument === "--ff-only") {
      if (rebase || fastForward !== undefined || fastForwardOnly || operands.length > 0)
        return undefined;
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
    ...(rebase ? { rebase: true } : {}),
    ...(fastForward === undefined ? {} : { fastForward }),
    ...(fastForwardOnly ? { fastForwardOnly: true } : {}),
  };
}

export function parsePush(argv: readonly string[]): ParsedGitCliCommand | undefined {
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
