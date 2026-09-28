// `set`, `break`, `continue`, `export`, and `unset` change the shell that
// runs them, so they are executor builtins rather than registry commands.
// Diagnostics follow Bash's wording and exit statuses; options this shell does
// not implement are refused by name.

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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Leading option words; `--` ends them, and `-` alone is an operand. */
function options(
  context: CommandContext,
  command: string,
  usage: string,
  accept: (letter: string) => "ok" | "refuse" | "invalid",
):
  | { readonly letters: ReadonlySet<string>; readonly operands: readonly string[] }
  | BuiltinOutcome {
  const letters = new Set<string>();
  const argv = context.argv;
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      index++;
      break;
    }
    if (arg.length < 2 || !arg.startsWith("-")) break;
    for (const letter of arg.slice(1)) {
      const verdict = accept(letter);
      if (verdict === "refuse") return refuse(context, `-${letter} is not supported`);
      if (verdict === "invalid") {
        located(context, `${command}: -${letter}: invalid option`);
        context.diagnostic(encode(`${command}: usage: ${usage}\n`));
        return done(2);
      }
      letters.add(letter);
    }
  }
  return { letters, operands: argv.slice(index) };
}

/** Splitting uses a fixed default IFS, so a script may not change it. */
function changesIfs(operands: readonly string[]): boolean {
  return operands.some((operand) => /^IFS(\+?=|$)/.test(operand));
}

const exportBuiltin: ShellBuiltin = (context, frame) => {
  const parsed = options(
    context,
    "export",
    "export [-fn] [name[=value] ...] or export -p",
    (letter) => (letter === "n" ? "ok" : letter === "p" || letter === "f" ? "refuse" : "invalid"),
  );
  if ("result" in parsed) return parsed;
  if (parsed.operands.length === 0) {
    return refuse(context, "listing exported variables is not supported");
  }
  if (changesIfs(parsed.operands)) return refuse(context, "changing IFS is not supported");
  const unexport = parsed.letters.has("n");
  const variables = frame.shell.variables;
  let status = 0;
  for (const operand of parsed.operands) {
    const equals = operand.indexOf("=");
    const target = equals === -1 ? operand : operand.slice(0, equals);
    const append = equals !== -1 && target.endsWith("+");
    const name = append ? target.slice(0, -1) : target;
    if (!IDENTIFIER.test(name)) {
      located(context, `export: \`${operand}': not a valid identifier`);
      status = 1;
      continue;
    }
    if (equals === -1) {
      if (unexport) variables.unexport(name);
      else variables.export(name);
      continue;
    }
    const value = (append ? (variables.get(name) ?? "") : "") + operand.slice(equals + 1);
    if (!unexport) {
      variables.export(name, value);
      continue;
    }
    variables.set(name, value);
    variables.unexport(name);
  }
  return done(status);
};

const unsetBuiltin: ShellBuiltin = (context, frame) => {
  const parsed = options(context, "unset", "unset [-f] [-v] [-n] [name ...]", (letter) =>
    letter === "v" ? "ok" : letter === "f" || letter === "n" ? "refuse" : "invalid",
  );
  if ("result" in parsed) return parsed;
  if (parsed.operands.length === 0) return refuse(context, "unset without names is not supported");
  if (changesIfs(parsed.operands)) return refuse(context, "changing IFS is not supported");
  let status = 0;
  for (const name of parsed.operands) {
    if (IDENTIFIER.test(name)) {
      frame.shell.variables.unset(name);
    } else if (parsed.letters.has("v")) {
      located(context, `unset: \`${name}': not a valid identifier`);
      status = 1;
    }
    // Without `-v`, Bash looks for a function of that name; there are none.
  }
  return done(status);
};

export const SHELL_BUILTINS: ReadonlyMap<string, ShellBuiltin> = new Map([
  ["set", set],
  ["break", loopControl("break")],
  ["continue", loopControl("continue")],
  ["export", exportBuiltin],
  ["unset", unsetBuiltin],
]);
