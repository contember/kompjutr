// AST to plan. This is the stage the shell exists for: the corpus shows
// agents are not scripting, they are making single calls with two ergonomic
// decorations — truncate the output and swallow the errors — and both of
// those are query parameters, not language features. See §4 of
// docs/archive/plans/shell.md.
//
// Two rewrites are active here:
//
//   R1  a trailing `head -N` becomes a demand hint instead of a stage that
//       throws away work already done (76 of 114 multi-stage corpus lines)
//   R2  `find … | xargs grep …` collapses into one search, because find's
//       output is already the search's discovery cursor (~10 lines)
//
// R3 (a stage reading stdin never queries the filesystem), R4 (`2>/dev/null`
// is a flag) and R5 (pure-text stages) need no rewrite: they fall out of the
// plan shape and the executor's laziness. They are listed in the plan
// document as rules because they are guarantees, not because they are code.

import {
  type Pipeline,
  type Redirection,
  type Script,
  ShellSyntaxError,
  type SimpleCommand,
  type Word,
} from "../parse/ast.js";
import {
  type Argument,
  type Plan,
  type PlannedCommand,
  type PlannedPipeline,
  type PlannedRedirection,
  type PlannedStep,
  traitsFor,
} from "./types.js";

export function planScript(script: Script): Plan {
  const steps: PlannedStep[] = [];
  for (const statement of script.statements) {
    steps.push({ pipeline: planPipeline(statement.pipeline), connector: statement.connector });
  }
  return { steps };
}

function planPipeline(pipeline: Pipeline): PlannedPipeline {
  let commands = pipeline.commands.map(planCommand);
  const fusions: string[] = [];

  const fused = fuseFindIntoSearch(commands);
  if (fused !== null) {
    commands = fused.commands;
    fusions.push(fused.note);
  }

  const limited = liftTrailingLimit(commands);
  if (limited !== null) {
    commands = limited.commands;
    fusions.push(limited.note);
    return { commands, limitHint: limited.limit, fusions };
  }

  return { commands, limitHint: null, fusions };
}

function planCommand(command: SimpleCommand): PlannedCommand {
  const [nameWord, ...argWords] = command.words;
  if (nameWord === undefined) {
    throw new ShellSyntaxError("command", "missing command name", 0);
  }
  if (isAssignment(nameWord)) {
    throw new ShellSyntaxError("assignment", "variable assignment is not supported", 0);
  }
  if (hasParameter(nameWord)) {
    throw new ShellSyntaxError(
      "parameter expansion",
      "parameters in command names are not supported",
      0,
    );
  }
  const name = literalText(nameWord);

  return {
    name,
    args: argWords.map(toArgument),
    redirections: command.redirections.map(planRedirection),
  };
}

function planRedirection(redirection: Redirection): PlannedRedirection {
  if (redirection.op === ">&") {
    if (
      (redirection.fd === 1 || redirection.fd === 2) &&
      (redirection.targetFd === 1 || redirection.targetFd === 2) &&
      redirection.fd !== redirection.targetFd
    ) {
      return {
        kind: "duplicate",
        fd: redirection.fd,
        targetFd: redirection.targetFd,
      };
    }
    throw new ShellSyntaxError(
      "redirection",
      `\`${redirection.fd}>&${redirection.targetFd}\` is not supported`,
      0,
    );
  }

  if (hasParameter(redirection.target)) {
    throw new ShellSyntaxError(
      "parameter expansion",
      "parameters in redirection targets are not supported",
      0,
    );
  }
  const target = toArgument(redirection.target);

  if (redirection.op === "<") {
    if (redirection.fd !== 0) {
      throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
    }
    return { kind: "read", fd: 0, path: target };
  }

  const append = redirection.op === ">>";
  if (redirection.fd === 2) {
    // `2>/dev/null` is 145 of 614 corpus lines' worth of noise suppression.
    // Recognising the sink means never allocating the buffer at all.
    if (argumentLiteral(target) === "/dev/null") {
      return { kind: "write", fd: 2, path: target, append };
    }
    throw new ShellSyntaxError(
      "redirection",
      "redirecting stderr to a file is not supported; use 2>/dev/null or 2>&1",
      0,
    );
  }
  if (redirection.fd !== 1) {
    throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
  }
  return { kind: "write", fd: 1, path: target, append };
}

/**
 * R1 — a trailing `head -N` publishes its demand to the source.
 *
 * The stage stays. It is the mechanism: because the executor is pull-based,
 * a `head` that stops pulling after N lines stops the search behind it,
 * which stops the discovery pages behind that. Removing the stage and
 * trusting the hint would leave nothing to enforce the count at all — the
 * first draft did exactly that and returned whole files.
 *
 * What the hint buys is the *first* page size. The Wave A probe showed a
 * fixed page costs a second round trip as soon as match density drops
 * below 2/3, so a source seeds at `2 * limitHint`.
 *
 * No hint is published when a blocking stage sits between the source and the
 * limiter: `find | sort | head -20` genuinely needs all of find's output, so
 * sizing the first page to 40 would only cost extra round trips.
 */
function liftTrailingLimit(
  commands: readonly PlannedCommand[],
): { commands: PlannedCommand[]; limit: number; note: string } | null {
  if (commands.length < 2) return null;
  const last = commands[commands.length - 1];
  if (last === undefined || !traitsFor(last.name).limiter) return null;
  // A `head` that writes to a file or reads from one is not a pipeline stage.
  if (hasOutputRedirection(last) || hasInputRedirection(last)) return null;

  const limit = headCount(last.args);
  if (limit === null) return null;

  const upstream = commands.slice(0, -1);
  if (upstream.some((command) => traitsFor(command.name).blocking)) {
    return null;
  }

  return {
    commands: [...commands],
    limit,
    note: `head -${limit} published as a demand hint`,
  };
}

/** `head -20`, `head -n 20`, or the default 10. Null when it takes bytes. */
function headCount(args: readonly Argument[]): number | null {
  let count = 10;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return null;
    const value = argumentLiteral(arg);
    if (value === null) return null;
    // `-c` bounds bytes, not lines; that is not a line demand.
    if (value === "-c" || value.startsWith("-c")) return null;
    if (value === "-n") {
      const next = args[index + 1];
      if (next === undefined) return null;
      const nextValue = argumentLiteral(next);
      if (nextValue === null) return null;
      const parsed = Number(nextValue);
      if (!Number.isInteger(parsed) || parsed < 0) return null;
      count = parsed;
      index++;
      continue;
    }
    if (/^-[0-9]+$/.test(value)) {
      count = Number(value.slice(1));
      continue;
    }
    if (/^-n[0-9]+$/.test(value)) {
      count = Number(value.slice(2));
      continue;
    }
    // A file operand means `head` is a source, not a limiter.
    return null;
  }
  return count;
}

/**
 * R2 — `find <root> -name <pat> | xargs grep <args>` is one search.
 *
 * Two pipeline stages, not three: the search is `xargs`'s argument, not its
 * own stage. find's output is already the search's discovery cursor and
 * xargs exists only to carry it, so the fused form skips a full round trip
 * of paths through JS and a second path resolution per file.
 *
 * Only the exact shape collapses. An `xargs` flag or a find predicate this
 * does not model changes *which* files are searched, so the pipeline is left
 * alone rather than fused with the predicate quietly dropped.
 */
function fuseFindIntoSearch(
  commands: readonly PlannedCommand[],
): { commands: PlannedCommand[]; note: string } | null {
  if (commands.length < 2) return null;
  const find = commands[0];
  const xargs = commands[1];
  if (find === undefined || xargs === undefined) return null;
  if (find.name !== "find" || xargs.name !== "xargs") return null;
  if (hasOutputRedirection(find) || hasOutputRedirection(xargs) || hasInputRedirection(xargs))
    return null;

  const inner = xargsCommand(xargs.args);
  if (inner === null) return null;
  if (inner.name !== "grep" && inner.name !== "rg") return null;

  const parsed = simpleFind(find.args);
  if (parsed === null) return null;

  // The fused search takes find's root as its path and find's -name as the
  // include filter. `-r` is implied for grep: find was already recursive.
  const args: Argument[] = [
    ...(inner.name === "grep" ? [literal("-r")] : []),
    ...inner.args,
    ...(parsed.pattern === null
      ? []
      : inner.name === "grep"
        ? [literal(`--include=${parsed.pattern}`)]
        : [literal("-g"), literal(parsed.pattern)]),
    literal(parsed.root),
  ];

  const search: PlannedCommand = {
    name: inner.name,
    args,
    redirections: xargs.redirections,
  };

  return {
    commands: [search, ...commands.slice(2)],
    note: `find | xargs ${inner.name} fused into one search`,
  };
}

/**
 * The command `xargs` would run. Null when `xargs` carries a flag: `-n1`
 * and `-I{}` change how arguments are grouped, and a fused search cannot
 * reproduce that.
 */
function xargsCommand(
  args: readonly Argument[],
): { name: string; args: readonly Argument[] } | null {
  const first = args[0];
  if (first === undefined) return null;
  const name = argumentLiteral(first);
  if (name === null || name.startsWith("-")) return null;
  return { name, args: args.slice(1) };
}

/** `find <root> -name <pattern>` and nothing else. */
function simpleFind(args: readonly Argument[]): { root: string; pattern: string | null } | null {
  let root: string | null = null;
  let pattern: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return null;
    if (argumentGlobPattern(arg) !== null) return null;
    const value = argumentLiteral(arg);
    if (value === null) return null;
    if (value === "-name") {
      const next = args[index + 1];
      if (next === undefined) return null;
      pattern = argumentGlobPattern(next) ?? argumentLiteral(next);
      if (pattern === null) return null;
      index++;
      continue;
    }
    if (value === "-type") {
      const next = args[index + 1];
      // Only `-type f` matches what a search reads anyway.
      if (next === undefined || argumentLiteral(next) !== "f") return null;
      index++;
      continue;
    }
    if (value.startsWith("-")) return null;
    if (root !== null) return null;
    root = value;
  }

  return root === null ? null : { root, pattern };
}

function literal(value: string): Argument {
  return { kind: "word", parts: [{ kind: "literal", value, quoted: false }] };
}

function hasInputRedirection(command: PlannedCommand): boolean {
  return command.redirections.some((redirection) => redirection.kind === "read");
}

function hasOutputRedirection(command: PlannedCommand): boolean {
  return command.redirections.some(
    (redirection) => redirection.kind !== "read" && redirection.fd === 1,
  );
}

function toArgument(word: Word): Argument {
  return {
    kind: "word",
    parts: word.parts.map((part) => {
      if (part.kind === "Parameter") {
        return { kind: "parameter", name: part.name, quoted: part.quoted };
      }
      if (part.kind === "Glob") return { kind: "glob", value: part.value };
      return {
        kind: "literal",
        value: part.value,
        quoted: part.kind !== "Literal",
      };
    }),
  };
}

/** `[` is the only metacharacter a bracket-free escape has to hide. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (match) => `[${match}]`);
}

function literalText(word: Word): string {
  let text = "";
  for (const part of word.parts) {
    if (part.kind === "Parameter") {
      throw new ShellSyntaxError("parameter expansion", "parameter is not literal text", 0);
    }
    text += part.value;
  }
  return text;
}

function hasParameter(word: Word): boolean {
  return word.parts.some((part) => part.kind === "Parameter");
}

function isAssignment(word: Word): boolean {
  const first = word.parts[0];
  return first?.kind === "Literal" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.value);
}

function argumentLiteral(argument: Argument): string | null {
  let value = "";
  for (const part of argument.parts) {
    if (part.kind !== "literal") return null;
    value += part.value;
  }
  return value;
}

function argumentGlobPattern(argument: Argument): string | null {
  let pattern = "";
  let hasGlobPart = false;
  for (const part of argument.parts) {
    if (part.kind === "parameter") return null;
    if (part.kind === "glob") {
      hasGlobPart = true;
      pattern += part.value;
    } else {
      pattern += escapeGlob(part.value);
    }
  }
  return hasGlobPart ? pattern : null;
}
