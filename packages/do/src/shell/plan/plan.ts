// AST to plan. Planning is pure: globs, parameters, substitutions, and loop
// words stay marked here and are resolved by the executor; a substitution's
// list is planned with the rest, so a refusal anywhere fails before anything
// runs. The query rewrites live in `fusions.ts`.

import type {
  Command,
  CompoundCommand,
  Pipeline,
  Redirection,
  Script,
  SimpleCommand,
  Statement,
  Word,
  WordPart,
} from "../parse/ast.js";
import { hasExpansion, ShellSyntaxError } from "../parse/ast.js";
import { markBraces } from "./braces.js";
import { fuseFindIntoSearch, liftTrailingLimit } from "./fusions.js";
import type {
  Argument,
  Plan,
  PlannedAssignment,
  PlannedCommand,
  PlannedCompound,
  PlannedPipeline,
  PlannedRedirection,
  PlannedStage,
} from "./types.js";
import {
  argumentPart,
  assignmentArgument,
  hereText,
  isAssignmentShaped,
  toArgument,
} from "./words.js";

export function planScript(script: Script): Plan {
  return planList(script.statements);
}

function planList(statements: readonly Statement[]): Plan {
  return {
    steps: statements.map((statement) => ({
      pipeline: planPipeline(statement.pipeline),
      negated: statement.pipeline.negated,
      connector: statement.connector,
    })),
  };
}

function planPipeline(pipeline: Pipeline): PlannedPipeline {
  const stages = pipeline.commands.map(planStage);
  const simple = simpleStages(stages);
  if (simple === null) return { commands: stages, limitHint: null, fusions: [] };

  let commands = simple;
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

/** The stages when every one is a simple command, the only shape the rewrites read. */
function simpleStages(stages: readonly PlannedStage[]): PlannedCommand[] | null {
  const commands: PlannedCommand[] = [];
  for (const stage of stages) {
    if (stage.kind !== "command") return null;
    commands.push(stage);
  }
  return commands;
}

function planStage(command: Command): PlannedStage {
  return command.kind === "SimpleCommand" ? planCommand(command) : planCompound(command);
}

function planCompound(command: CompoundCommand): PlannedCompound {
  const redirections = planRedirections(command.redirections);
  const line = command.line;
  switch (command.kind) {
    case "Subshell":
      return { kind: "subshell", body: planList(command.body), redirections, line };
    case "Group":
      return { kind: "group", body: planList(command.body), redirections, line };
    case "If":
      return {
        kind: "if",
        clauses: command.clauses.map((clause) => ({
          condition: planList(clause.condition),
          body: planList(clause.body),
        })),
        otherwise: command.otherwise === null ? null : planList(command.otherwise),
        redirections,
        line,
      };
    case "For":
      refuseIfs(command.name);
      return {
        kind: "for",
        name: command.name,
        words: command.words.map((word) => toArgument(word, planScript)),
        body: planList(command.body),
        redirections,
        line,
      };
  }
}

function planCommand(command: SimpleCommand): PlannedCommand {
  const assignments: PlannedAssignment[] = [];
  let index = 0;
  for (; index < command.words.length; index++) {
    const word = command.words[index];
    if (word === undefined || !isAssignmentShaped(word)) {
      if (word !== undefined && index === assignments.length) refuseArrayAssignment(word);
      break;
    }
    assignments.push(planAssignment(word));
  }
  const [nameWord, ...argWords] = command.words.slice(index);
  const redirections = planRedirections(command.redirections);
  const line = command.line;
  if (nameWord === undefined) {
    return {
      kind: "command",
      name: null,
      nameWord: null,
      args: [],
      assignments,
      redirections,
      line,
    };
  }

  if (markBraces(nameWord.parts, (part) => argumentPart(part, planScript)) !== null) {
    throw new ShellSyntaxError(
      "brace expansion",
      "brace expansion in command names is not supported",
      0,
    );
  }
  if (startsWithTilde(nameWord)) {
    throw new ShellSyntaxError(
      "tilde expansion",
      "tilde expansion in command names is not supported",
      0,
    );
  }
  if (hasExpansion(nameWord)) {
    return {
      kind: "command",
      name: null,
      nameWord: toArgument(nameWord, planScript),
      args: argWords.map((word) => toArgument(word, planScript)),
      assignments,
      redirections,
      line,
    };
  }

  const name = literalText(nameWord);
  if (DECLARATIONS.has(name)) {
    throw new ShellSyntaxError(`\`${name}\``, `\`${name}\` is not supported`, 0);
  }
  if (assignments.length > 0 && (name === "export" || name === "unset")) {
    // Bash keeps some of these assignments and drops others, depending on the names.
    throw new ShellSyntaxError("assignment", `assignments before \`${name}\` are not supported`, 0);
  }
  return {
    kind: "command",
    name,
    nameWord: null,
    args: argWords.map((word) => toArgument(word, planScript, name === "export")),
    assignments,
    redirections,
    line,
  };
}

/** Declaration builtins with attributes or scopes this shell does not model. */
export const DECLARATIONS: ReadonlySet<string> = new Set([
  "readonly",
  "local",
  "declare",
  "typeset",
]);

function planAssignment(word: Word): PlannedAssignment {
  const first = word.parts[0];
  const match =
    first?.kind === "Literal" ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.value) : null;
  const name = match?.[1];
  if (match === null || name === undefined) {
    throw new ShellSyntaxError("assignment", "malformed assignment", 0);
  }
  refuseIfs(name);
  return { name, append: match[2] === "+", word: assignmentArgument(word, planScript) };
}

/** `NAME[…]=value` assigns an array element in Bash; there are no arrays here. */
function refuseArrayAssignment(word: Word): void {
  const [first, second] = word.parts;
  if (
    first?.kind === "Literal" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(first.value) &&
    second?.kind === "Glob" &&
    second.value.startsWith("[")
  ) {
    const third = word.parts[2];
    if (third?.kind === "Literal" && /^\+?=/.test(third.value)) {
      throw new ShellSyntaxError("assignment", "array assignment is not supported", 0);
    }
  }
}

/** Splitting uses a fixed default IFS, so a script may not change it. */
export function refuseIfs(name: string): void {
  if (name === "IFS") {
    throw new ShellSyntaxError("assignment", "changing IFS is not supported", 0);
  }
}

/**
 * Descriptor bindings in source order. A command substitution in a target
 * runs while the redirections before it are bound, and Bash reports an
 * ambiguous target there too, so both follow the stderr bound so far; only
 * an unredirected stderr or `2>/dev/null` is modelled at that point.
 */
function planRedirections(redirections: readonly Redirection[]): PlannedRedirection[] {
  const planned: PlannedRedirection[] = [];
  let stderrRedirected = false;
  for (const redirection of redirections) {
    const target =
      redirection.op === "<<"
        ? redirection.body
        : redirection.op === ">&"
          ? null
          : redirection.target;
    const reports =
      target !== null &&
      (target.parts.some(isSubstitution) ||
        (redirection.op !== "<<" && redirection.op !== "<<<" && target.parts.some(mayBeAmbiguous)));
    if (stderrRedirected && reports) {
      throw new ShellSyntaxError(
        "redirection",
        "a command substitution or unquoted expansion in a redirection target after a stderr redirection other than 2>/dev/null is not supported",
        0,
      );
    }
    const next = planRedirection(redirection);
    planned.push(next);
    if (next.kind === "duplicate" && next.fd === 2) stderrRedirected = true;
    if (next.kind === "write" && next.fd === 2 && !isDevNull(next.path)) stderrRedirected = true;
  }
  return planned;
}

/** An unquoted expansion may yield no field or several. */
function mayBeAmbiguous(part: WordPart): boolean {
  return (
    (part.kind === "Parameter" ||
      part.kind === "ParameterLength" ||
      part.kind === "ParameterOperation" ||
      part.kind === "CommandSubstitution") &&
    !part.quoted
  );
}

function isSubstitution(part: WordPart): boolean {
  if (part.kind === "CommandSubstitution") return true;
  return part.kind === "ParameterOperation" && part.word.some(isSubstitution);
}

function isDevNull(path: Argument): boolean {
  const [only, ...rest] = path.parts;
  return rest.length === 0 && only?.kind === "literal" && only.value === "/dev/null";
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

  if (redirection.op === "<<" || redirection.op === "<<<") {
    if (redirection.fd !== 0) {
      throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
    }
    const word = redirection.op === "<<" ? redirection.body : redirection.target;
    return {
      kind: "text",
      fd: 0,
      text: hereText(word, redirection.op === "<<<", planScript),
      newline: redirection.op === "<<<",
    };
  }

  const path = toArgument(redirection.target, planScript);
  const spelling = redirection.spelling;

  if (redirection.op === "<") {
    if (redirection.fd !== 0) {
      throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
    }
    return { kind: "read", fd: 0, path, spelling };
  }

  const append = redirection.op === ">>";
  if (redirection.fd === 2) return { kind: "write", fd: 2, path, append, spelling };
  if (redirection.fd !== 1) {
    throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
  }
  return { kind: "write", fd: 1, path, append, spelling };
}

function startsWithTilde(word: Word): boolean {
  const first = word.parts[0];
  return first?.kind === "Literal" && first.value.startsWith("~");
}

function literalText(word: Word): string {
  let text = "";
  for (const part of word.parts) {
    if (
      part.kind === "Parameter" ||
      part.kind === "ParameterLength" ||
      part.kind === "ParameterOperation" ||
      part.kind === "CommandSubstitution"
    ) {
      throw new ShellSyntaxError("parameter expansion", "parameter is not literal text", 0);
    }
    text += part.value;
  }
  return text;
}
