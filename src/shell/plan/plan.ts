// AST to plan. This is the stage the shell exists for: the corpus shows
// agents are not scripting, they are making single calls with two ergonomic
// decorations — truncate the output and swallow the errors — and both of
// those are query parameters, not language features. See §4 of
// docs/plans/shell.md.
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
  type FileTarget,
  type Plan,
  type PlannedCommand,
  type PlannedPipeline,
  type PlannedStep,
  type StderrMode,
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

  let stderr: StderrMode = "inherit";
  let stdout: FileTarget | null = null;
  let stdin: Argument | null = null;

  for (const redirection of command.redirections) {
    applyRedirection(redirection, {
      setStderr: (mode) => {
        stderr = mode;
      },
      setStdout: (target) => {
        stdout = target;
      },
      setStdin: (target) => {
        stdin = target;
      },
    });
  }

  return {
    name: literalText(nameWord),
    args: argWords.map(toArgument),
    stderr,
    stdout,
    stdin,
  };
}

interface RedirectionSink {
  setStderr(mode: StderrMode): void;
  setStdout(target: FileTarget): void;
  setStdin(target: Argument): void;
}

function applyRedirection(redirection: Redirection, sink: RedirectionSink): void {
  if (redirection.op === ">&") {
    // `2>&1` merges; `1>&2` is the mirror. Anything else names a descriptor
    // this shell does not have.
    if (redirection.fd === 2 && redirection.targetFd === 1) {
      sink.setStderr("merge");
      return;
    }
    throw new ShellSyntaxError(
      "redirection",
      `\`${redirection.fd}>&${redirection.targetFd}\` is not supported`,
      0,
    );
  }

  const target = toArgument(redirection.target);

  if (redirection.op === "<") {
    sink.setStdin(target);
    return;
  }

  const append = redirection.op === ">>";
  if (redirection.fd === 2) {
    // `2>/dev/null` is 145 of 614 corpus lines' worth of noise suppression.
    // Recognising the sink means never allocating the buffer at all.
    if (target.kind === "literal" && target.value === "/dev/null") {
      sink.setStderr("drop");
      return;
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
  sink.setStdout({ path: target, append });
}

/**
 * R1 — a trailing `head -N` becomes demand rather than a stage.
 *
 * The limit is dropped when a blocking stage sits between the source and the
 * limiter: `find | sort | head -20` genuinely needs all of find's output, and
 * pretending otherwise would return the wrong 20 lines.
 */
function liftTrailingLimit(
  commands: readonly PlannedCommand[],
): { commands: PlannedCommand[]; limit: number; note: string } | null {
  if (commands.length < 2) return null;
  const last = commands[commands.length - 1];
  if (last === undefined || !traitsFor(last.name).limiter) return null;
  // A `head` that writes to a file or reads from one is not a pipeline stage.
  if (last.stdout !== null || last.stdin !== null) return null;

  const limit = headCount(last.args);
  if (limit === null) return null;

  const upstream = commands.slice(0, -1);
  if (upstream.some((command) => traitsFor(command.name).blocking)) {
    return null;
  }

  return {
    commands: upstream,
    limit,
    note: `head -${limit} lifted into a demand hint`,
  };
}

/** `head -20`, `head -n 20`, or the default 10. Null when it takes bytes. */
function headCount(args: readonly Argument[]): number | null {
  let count = 10;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined || arg.kind !== "literal") return null;
    const value = arg.value;
    // `-c` bounds bytes, not lines; that is not a line demand.
    if (value === "-c" || value.startsWith("-c")) return null;
    if (value === "-n") {
      const next = args[index + 1];
      if (next === undefined || next.kind !== "literal") return null;
      const parsed = Number(next.value);
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
  if (find.stdout !== null || xargs.stdout !== null || xargs.stdin !== null) return null;

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
    stderr: xargs.stderr,
    stdout: null,
    stdin: null,
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
  if (first === undefined || first.kind !== "literal") return null;
  if (first.value.startsWith("-")) return null;
  return { name: first.value, args: args.slice(1) };
}

/** `find <root> -name <pattern>` and nothing else. */
function simpleFind(args: readonly Argument[]): { root: string; pattern: string | null } | null {
  let root: string | null = null;
  let pattern: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return null;
    if (arg.kind === "glob") return null;
    if (arg.value === "-name") {
      const next = args[index + 1];
      if (next === undefined) return null;
      pattern = next.kind === "glob" ? next.pattern : next.value;
      index++;
      continue;
    }
    if (arg.value === "-type") {
      const next = args[index + 1];
      // Only `-type f` matches what a search reads anyway.
      if (next === undefined || next.kind !== "literal" || next.value !== "f") return null;
      index++;
      continue;
    }
    if (arg.value.startsWith("-")) return null;
    if (root !== null) return null;
    root = arg.value;
  }

  return root === null ? null : { root, pattern };
}

function literal(value: string): Argument {
  return { kind: "literal", value };
}

/**
 * A word becomes one argument. A word carrying any unquoted glob part
 * becomes a glob pattern for the executor to expand; the quoted parts are
 * escaped so `"*.ts"*` matches a literal `*.ts` followed by anything.
 */
function toArgument(word: Word): Argument {
  const hasGlobPart = word.parts.some((part) => part.kind === "Glob");
  if (!hasGlobPart) return literal(word.parts.map((part) => part.value).join(""));

  let pattern = "";
  for (const part of word.parts) {
    pattern += part.kind === "Glob" ? part.value : escapeGlob(part.value);
  }
  return { kind: "glob", pattern };
}

/** `[` is the only metacharacter a bracket-free escape has to hide. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (match) => `[${match}]`);
}

function literalText(word: Word): string {
  return word.parts.map((part) => part.value).join("");
}
