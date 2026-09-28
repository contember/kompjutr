// `env` in uutils' shape. With no command it prints the environment in
// insertion order: the run snapshot in the order the caller supplied it, then
// new names in the order written, while a reassigned name keeps its place.
// That is what uutils prints for `env -i B=2 A=1 env`. A command runs through the `invoke` seam with the
// edited environment as its whole environment.

import { empty, encode, one } from "../../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../../exec/context.js";
import { type CommandSpec, parseCommandLine, parseFailure } from "./clap.js";

/** uutils' status for its own failures; 127 is a command it could not find. */
const ENV_FAILED = 125;
const NOT_FOUND = 127;
const SHEBANG_HINT = "env: use -[v]S to pass options in shebang lines\n";

// Bash builtins with no binary on PATH: the reference `env` cannot run them.
const SHELL_ONLY = new Set(["cd", "exit", "type", "command", "export", "unset", "set"]);

// JavaScript orders integer-like keys first, so the environment record could
// not keep such a name where it was written. uutils would.
const INTEGER_KEY = /^(0|[1-9][0-9]*)$/;

const SPEC: CommandSpec = {
  usage: "env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]",
  stopAtFirstOperand: true,
  options: [
    { name: "ignore-environment", short: ["i"] },
    { name: "unset", short: ["u"], value: "required", valueName: "NAME", repeatable: true },
    { name: "null", short: ["0"] },
    { name: "chdir", short: ["C"], value: "required", valueName: "DIR", refused: true },
    { name: "file", short: ["f"], value: "required", valueName: "PATH", refused: true },
    { name: "debug", short: ["v"], refused: true },
    { name: "split-string", short: ["S"], value: "required", valueName: "S", refused: true },
    { name: "argv0", short: ["a"], value: "required", valueName: "a", refused: true },
    { name: "ignore-signal", value: "required", valueName: "SIG", refused: true },
    { name: "help", short: ["h"], refused: true },
    { name: "version", short: ["V"], refused: true },
  ],
};

export const env: Command = async (context) => {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(context.argv, SPEC);
  } catch (error) {
    const failed = parseFailure(context, error, ENV_FAILED, SHEBANG_HINT);
    if (failed !== null) return failed;
    throw error;
  }

  let ignore = false;
  let nul = false;
  const unset: string[] = [];
  for (const occurrence of parsed.occurrences) {
    if (occurrence.name === "ignore-environment") ignore = true;
    else if (occurrence.name === "null") nul = true;
    else if (occurrence.name === "unset" && occurrence.value !== null) unset.push(occurrence.value);
  }

  let operands = parsed.operands;
  // A lone `-` before the assignments is the historical spelling of `-i`.
  if (operands[0] === "-") {
    ignore = true;
    operands = operands.slice(1);
  }

  const environment = new Map<string, string>();
  if (!ignore) {
    for (const [name, value] of Object.entries(context.env ?? {})) environment.set(name, value);
  }
  for (const name of unset) {
    if (name === "" || name.includes("=")) {
      return fail(context, `cannot unset '${name}': Invalid argument`, ENV_FAILED);
    }
    environment.delete(name);
  }

  let index = 0;
  for (; index < operands.length; index++) {
    const operand = operands[index];
    if (operand === undefined) continue;
    const equals = operand.indexOf("=");
    if (equals === -1) break;
    const name = operand.slice(0, equals);
    const value = operand.slice(equals + 1);
    if (name === "") {
      context.warn(`warning: no name specified for value '${value}'`);
      continue;
    }
    if (INTEGER_KEY.test(name)) {
      return fail(
        context,
        `variable name '${name}' is not supported: the environment cannot keep integer-like names in order`,
        ENV_FAILED,
      );
    }
    environment.set(name, value);
  }

  const [name, ...args] = operands.slice(index);
  if (name === undefined) {
    const terminator = nul ? "\0" : "\n";
    let text = "";
    for (const [key, value] of environment) text += `${key}=${value}${terminator}`;
    return result(one(encode(text)));
  }
  if (nul) {
    context.warn("cannot specify --null (-0) with command");
    context.diagnostic(encode("Try 'env --help' for more information.\n"));
    return result(empty(), ENV_FAILED);
  }
  return run(context, name, args, Object.fromEntries(environment));
};

async function run(
  context: CommandContext,
  name: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ReturnType<Command>> {
  // The seam hands a sub-invocation no stdin, so a command that would read
  // this stage's input would silently see none.
  if (context.stdin !== null) {
    return fail(
      context,
      `cannot run '${name}' with standard input: the invoked command cannot read it`,
      ENV_FAILED,
    );
  }
  const produced = SHELL_ONLY.has(name)
    ? null
    : await context.invoke(name, args, { env: environment });
  if (produced === null) {
    context.warn(`'${name}': No such file or directory`);
    context.diagnostic(encode(SHEBANG_HINT));
    return result(empty(), NOT_FOUND);
  }
  return {
    stdout: produced.stdout,
    status: () => produced.status(),
    truncated: () => produced.truncated?.() ?? false,
  };
}
