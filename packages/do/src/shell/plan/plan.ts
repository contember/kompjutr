// AST to plan. Planning is pure: globs, parameters, and loop words stay
// marked here and are resolved by the executor. The query rewrites live in
// `fusions.ts`.

import type {
  Command,
  CompoundCommand,
  Pipeline,
  Redirection,
  Script,
  SimpleCommand,
  Statement,
  Word,
} from "../parse/ast.js";
import { ShellSyntaxError } from "../parse/ast.js";
import { argumentPart, markBraces } from "./braces.js";
import { fuseFindIntoSearch, liftTrailingLimit } from "./fusions.js";
import { refuseNamedTildes } from "./tilde.js";
import type {
  Argument,
  FlatPart,
  Plan,
  PlannedCommand,
  PlannedCompound,
  PlannedPipeline,
  PlannedRedirection,
  PlannedStage,
} from "./types.js";

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
  const redirections = command.redirections.map(planRedirection);
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
      return {
        kind: "for",
        name: command.name,
        words: command.words.map(toArgument),
        body: planList(command.body),
        redirections,
        line,
      };
  }
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
  if (markBraces(nameWord.parts) !== null) {
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

  return {
    kind: "command",
    name,
    args: argWords.map(toArgument),
    redirections: command.redirections.map(planRedirection),
    line: command.line,
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

  if (redirection.op === "<<" || redirection.op === "<<<") {
    if (redirection.fd !== 0) {
      throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
    }
    return {
      kind: "text",
      fd: 0,
      text: hereText(redirection),
      newline: redirection.op === "<<<",
    };
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
  if (redirection.fd === 2) return { kind: "write", fd: 2, path: target, append };
  if (redirection.fd !== 1) {
    throw new ShellSyntaxError("redirection", `descriptor ${redirection.fd} is not supported`, 0);
  }
  return { kind: "write", fd: 1, path: target, append };
}

/** A here-string admits tilde expansion but no brace or pathname expansion. */
function hereText(redirection: Extract<Redirection, { readonly op: "<<" | "<<<" }>): Argument {
  const word = redirection.op === "<<" ? redirection.body : redirection.target;
  const parts = word.parts.map((part): FlatPart => {
    if (part.kind === "Parameter") return { kind: "parameter", name: part.name, quoted: true };
    const quoted = redirection.op === "<<" || (part.kind !== "Literal" && part.kind !== "Glob");
    return { kind: "literal", value: part.value, quoted };
  });
  if (redirection.op === "<<") return { kind: "word", parts };
  refuseNamedTildes(parts, "here-string");
  return { kind: "here-string", parts };
}

function toArgument(word: Word): Argument {
  const braces = markBraces(word.parts);
  if (braces !== null) return { kind: "word", parts: braces };
  const kind = isAssignment(word) ? "assignment" : "word";
  const parts = word.parts.map(argumentPart);
  refuseNamedTildes(parts, kind);
  return { kind, parts };
}

function startsWithTilde(word: Word): boolean {
  const first = word.parts[0];
  return first?.kind === "Literal" && first.value.startsWith("~");
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
