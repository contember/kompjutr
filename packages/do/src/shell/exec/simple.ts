// A simple command's words and assignments, in Bash's order: the command
// name and arguments expand first, then redirections (in `stage.ts`), then
// assignment values. With no command name left after expansion the
// assignments change the shell and the status is the last substitution's;
// otherwise they are exported to that one command only.

import { DECLARATIONS } from "../plan/plan.js";
import type { PlannedAssignment, PlannedCommand } from "../plan/types.js";
import { expandArguments, expandText, type Parameters } from "./arguments.js";
import { empty, encode } from "./bytes.js";
import { type BuiltinOutcome, SHELL_BUILTINS } from "./compound/builtins.js";
import { EXIT, type Frame, type Runtime } from "./compound/frame.js";
import { type CommandContext, result } from "./context.js";
import type { ShellExpansion } from "./expansion/shell-expansion.js";
import { utf8Bytes } from "./utf8.js";

export type Runner = (
  context: CommandContext,
  frame: Frame,
) => BuiltinOutcome | Promise<BuiltinOutcome>;

export interface CommandWords {
  /** Null when the words expanded to nothing. */
  readonly name: string | null;
  readonly argv: readonly string[];
  release(): void;
}

export interface CommandTarget {
  readonly runner: Runner;
  /** The environment the command sees, when prefix assignments change it. */
  readonly env: Readonly<Record<string, string>> | undefined;
  release(): void;
}

export async function expandCommandWords(
  planned: PlannedCommand,
  expansion: ShellExpansion,
): Promise<CommandWords> {
  if (planned.nameWord === null) {
    const expanded = await expandArguments(planned.args, expansion);
    return { name: planned.name, argv: expanded.argv, release: expanded.release };
  }
  const expanded = await expandArguments([planned.nameWord, ...planned.args], expansion);
  const [name, ...argv] = expanded.argv;
  return { name: name ?? null, argv, release: expanded.release };
}

/** Expands the assignments and picks what runs. */
export async function commandTarget(
  planned: PlannedCommand,
  name: string | null,
  expansion: ShellExpansion,
  frame: Frame,
  runtime: Runtime,
): Promise<CommandTarget> {
  if (name === null) {
    const variables = frame.shell.variables;
    for (const assignment of planned.assignments) {
      const value = await assignmentValue(assignment, expansion);
      variables.set(
        assignment.name,
        (assignment.append ? (variables.get(assignment.name) ?? "") : "") + value,
      );
    }
    const status = expansion.status.last ?? 0;
    return { runner: () => finished(status), env: undefined, release: () => {} };
  }

  // Reached only through an expanded name; the planner refuses a literal one.
  if (DECLARATIONS.has(name)) return refused("this command is not supported");
  const builtin = SHELL_BUILTINS.get(name);
  if (
    builtin !== undefined &&
    planned.assignments.length > 0 &&
    (name === "export" || name === "unset")
  ) {
    return refused("assignments before this command are not supported");
  }

  const temporary = await temporaryAssignments(planned.assignments, expansion, runtime);
  try {
    const exported = frame.shell.variables.exported();
    const env =
      temporary.values.size === 0
        ? exported
        : Object.freeze({ ...exported, ...Object.fromEntries(temporary.values) });
    // An executor builtin runs in this shell; the assignments are dropped after it, as in Bash.
    return { runner: builtin ?? registryRunner(name, runtime), env, release: temporary.release };
  } catch (error) {
    temporary.release();
    throw error;
  }
}

/** `NAME=value cmd`: each value sees the ones before it, and none reaches the shell. */
async function temporaryAssignments(
  assignments: readonly PlannedAssignment[],
  expansion: ShellExpansion,
  runtime: Runtime,
): Promise<{ readonly values: ReadonlyMap<string, string>; release(): void }> {
  const values = new Map<string, string>();
  const releases: Array<() => void> = [];
  const release = (): void => {
    for (const each of releases) each();
  };
  if (assignments.length === 0) return { values, release };
  const shell = expansion.parameters;
  const parameters: Parameters = {
    value: (name) => values.get(name) ?? shell.value(name),
    assign: (name, value) => shell.assign(name, value),
    get nounset() {
      return shell.nounset;
    },
  };
  const layered = expansion.reading(parameters);
  try {
    for (const assignment of assignments) {
      const expanded = await assignmentValue(assignment, layered);
      const value = (assignment.append ? (parameters.value(assignment.name) ?? "") : "") + expanded;
      releases.push(
        runtime.fs.retained.retain(
          utf8Bytes(assignment.name) + utf8Bytes(value),
          "command environment",
        ),
      );
      values.set(assignment.name, value);
    }
  } catch (error) {
    release();
    throw error;
  }
  return { values, release };
}

/** The value after `NAME=` or `NAME+=`; the prefix is unquoted literal text and survives expansion unchanged. */
async function assignmentValue(
  assignment: PlannedAssignment,
  expansion: ShellExpansion,
): Promise<string> {
  const text = await expandText(assignment.word, expansion);
  return text.slice(assignment.name.length + (assignment.append ? 2 : 1));
}

/** Registry commands report `exit` through `control`; executor builtins through a flow. */
function registryRunner(name: string, runtime: Runtime): Runner {
  const command = runtime.commands.get(name);
  if (command === undefined) return notFound(name);
  return async (context) => {
    const produced = await command(context);
    const exits = produced.control?.kind === "exit" && produced.control.terminateRun;
    return { result: produced, flow: exits ? EXIT : null };
  };
}

/** Bash reports a missing command after binding the stage's redirections. */
function notFound(name: string): Runner {
  return (context) => {
    context.diagnostic(encode(`bash: line ${context.line}: ${name}: command not found\n`));
    return { result: result(empty(), 127), flow: null };
  };
}

function refused(message: string): CommandTarget {
  return {
    runner: (context) => {
      context.warn(message);
      return finished(2);
    },
    env: undefined,
    release: () => {},
  };
}

function finished(status: number): BuiltinOutcome {
  return { result: result(empty(), status), flow: null };
}
