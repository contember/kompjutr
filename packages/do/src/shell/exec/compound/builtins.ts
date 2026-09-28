// `set`, `break`, and `continue` change the shell that runs them, so they
// are executor builtins rather than registry commands. Diagnostics follow
// Bash's wording and exit statuses; options this shell does not implement
// are refused by name.

import { type ByteStream, encode } from "../bytes.js";
import { type CommandContext, type CommandResult, result } from "../context.js";
import { EXIT, type Flow, type Frame } from "./frame.js";
import type { ShellOptions } from "./state.js";

export interface BuiltinOutcome {
  readonly result: CommandResult;
  readonly flow: Flow | null;
}

export type ShellBuiltin = (context: CommandContext, frame: Frame) => BuiltinOutcome;

const LETTERS: ReadonlyMap<string, keyof ShellOptions> = new Map([
  ["e", "errexit"],
  ["u", "nounset"],
]);

const OPTION_NAMES: ReadonlyMap<string, keyof ShellOptions> = new Map([
  ["errexit", "errexit"],
  ["nounset", "nounset"],
  ["pipefail", "pipefail"],
]);

// Bash 5.2's `set -o` names; the unimplemented ones are refused, not rejected as unknown.
const BASH_OPTION_NAMES = new Set([
  "allexport",
  "braceexpand",
  "emacs",
  "errtrace",
  "functrace",
  "hashall",
  "histexpand",
  "history",
  "ignoreeof",
  "interactive-comments",
  "keyword",
  "monitor",
  "noclobber",
  "noexec",
  "noglob",
  "nolog",
  "notify",
  "onecmd",
  "physical",
  "posix",
  "privileged",
  "verbose",
  "vi",
  "xtrace",
]);

function* nothing(): ByteStream {
  // Builtins report through diagnostics only.
}

function done(status: number, flow: Flow | null = null): BuiltinOutcome {
  return { result: result(nothing(), status), flow };
}

function located(context: CommandContext, message: string): void {
  context.diagnostic(encode(`bash: line ${context.line}: ${message}\n`));
}

function refuse(context: CommandContext, message: string): BuiltinOutcome {
  context.warn(message);
  return done(2);
}

const set: ShellBuiltin = (context, frame) => {
  const argv = context.argv;
  if (argv.length === 0) return refuse(context, "listing variables is not supported");
  const changes: Array<readonly [keyof ShellOptions, boolean]> = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const sign = arg.charAt(0);
    if ((sign !== "-" && sign !== "+") || arg.length < 2 || arg === "--") {
      return refuse(context, "positional parameters are not supported");
    }
    for (const letter of arg.slice(1)) {
      if (letter !== "o") {
        const option = LETTERS.get(letter);
        if (option === undefined) return refuse(context, `${sign}${letter} is not supported`);
        changes.push([option, sign === "-"]);
        continue;
      }
      index++;
      const name = argv[index];
      if (name === undefined) {
        return refuse(context, `${sign}o without an option name is not supported`);
      }
      const option = OPTION_NAMES.get(name);
      if (option !== undefined) {
        changes.push([option, sign === "-"]);
        continue;
      }
      if (BASH_OPTION_NAMES.has(name)) return refuse(context, `${sign}o ${name} is not supported`);
      apply(frame, changes);
      located(context, `set: ${name}: invalid option name`);
      return done(2);
    }
  }
  apply(frame, changes);
  return done(0);
};

function apply(frame: Frame, changes: ReadonlyArray<readonly [keyof ShellOptions, boolean]>): void {
  for (const [option, enabled] of changes) frame.shell.options[option] = enabled;
}

const NUMBER = /^\s*[+-]?[0-9]+\s*$/;

function loopControl(kind: "break" | "continue"): ShellBuiltin {
  return (context, frame) => {
    if (frame.loops === 0) {
      located(context, `${kind}: only meaningful in a \`for', \`while', or \`until' loop`);
      return done(0);
    }
    if (context.argv.length > 1) {
      located(context, `${kind}: too many arguments`);
      return done(1, EXIT);
    }
    const operand = context.argv[0];
    if (operand === undefined) return done(0, { kind, levels: 1 });
    if (!NUMBER.test(operand)) {
      located(context, `${kind}: ${operand}: numeric argument required`);
      return done(128, EXIT);
    }
    const count = BigInt(operand.trim());
    if (count <= 0n) {
      // Bash reports the range error and then leaves every enclosing loop.
      located(context, `${kind}: ${operand}: loop count out of range`);
      return done(1, { kind: "break", levels: frame.loops });
    }
    const levels = count > BigInt(frame.loops) ? frame.loops : Number(count);
    return done(0, { kind, levels });
  };
}

export const SHELL_BUILTINS: ReadonlyMap<string, ShellBuiltin> = new Map([
  ["set", set],
  ["break", loopControl("break")],
  ["continue", loopControl("continue")],
]);
