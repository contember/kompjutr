// `jq FILTER [FILES…]`: compile once, then run the filter over each input as
// it is parsed and stream every result. Exit status follows jq 1.8's main():
// the last input's outcome decides, and `-e` maps "no output", "last output
// false or null", and errors to 4, 1, and 5.

import type { ByteStream } from "../../exec/bytes.js";
import { type Command, type CommandContext, fail } from "../../exec/context.js";
import { EMPTY_ENV, withVariable } from "./bindings.js";
import { globals, REFUSED } from "./builtins/index.js";
import { dumpInto, dumpString, quote, Writer } from "./dump.js";
import { CompileError, JqError, JqHalt, JqRefusal } from "./errors.js";
import { evaluate } from "./evaluate.js";
import { InputReader } from "./input.js";
import { OptionError, type Options, parseOptions, USAGE_HINT } from "./options.js";
import { type Env, type Host, Runtime, root } from "./runtime.js";
import type { Node } from "./syntax/ast.js";
import { parseProgram } from "./syntax/parser.js";
import { resolve } from "./syntax/resolve.js";
import { type JqValue, utf8 } from "./value.js";

const OK = 0;
const NULL_KIND = -1;
const NO_OUTPUT = -4;
const ERROR = 5;
const SYSTEM = 2;

export const jq: Command = (context) => {
  let options: Options;
  try {
    options = parseOptions(context.argv);
  } catch (error) {
    if (!(error instanceof OptionError)) throw error;
    context.diagnostic(utf8(`${error.message}\n${error.usage ? USAGE_HINT : ""}`));
    return exited(2);
  }

  const table = globals();
  const variables = globalVariables(context, options);
  let program: Node;
  let called: ReadonlySet<string>;
  try {
    program = parseProgram(options.program);
    called = resolve(program, options.program, {
      functions: new Set(table.keys()),
      refused: REFUSED,
      variables: new Set(variables.keys()),
    });
  } catch (error) {
    return failure(context, error);
  }

  let status = 0;
  const stdout = run(context, options, program, variables, called, (code) => {
    status = code;
  });
  return { stdout, status: () => status, truncated: () => false };
};

function failure(context: CommandContext, error: unknown): ReturnType<Command> {
  if (error instanceof CompileError) {
    context.diagnostic(utf8(`${error.diagnostics.join("\n")}\n`));
    return exited(3);
  }
  if (error instanceof JqRefusal) return fail(context, error.message, 2);
  if (error instanceof RangeError) return fail(context, engineLimit(error), 2);
  throw error;
}

function engineLimit(error: RangeError): string {
  return `the program or value exceeds a JavaScript engine limit (${error.message})`;
}

function exited(status: number): ReturnType<Command> {
  return { stdout: (function* (): ByteStream {})(), status: () => status, truncated: () => false };
}

function globalVariables(context: CommandContext, options: Options): Map<string, JqValue> {
  const variables = new Map<string, JqValue>();
  const environment = new Map<string, JqValue>(Object.entries(context.env ?? {}));
  variables.set("ENV", environment);
  variables.set(
    "ARGS",
    new Map<string, JqValue>([
      ["positional", [...options.positional]],
      ["named", new Map(options.named)],
    ]),
  );
  for (const [name, value] of options.named) variables.set(name, value);
  return variables;
}

async function* run(
  context: CommandContext,
  options: Options,
  program: Node,
  variables: ReadonlyMap<string, JqValue>,
  called: ReadonlySet<string>,
  setStatus: (code: number) => void,
): ByteStream {
  const reader = new InputReader(context, options.files, options.rawInput, options.slurp);
  const environment = variables.get("ENV") ?? null;
  const host: Host = {
    input: () => {
      const step = reader.poll();
      if (step === undefined || step.kind === "end") return undefined;
      if (step.kind === "error") throw new JqError(step.message);
      step.release();
      return { value: step.value };
    },
    inputFilename: () => reader.filename,
    environment: environment instanceof Map ? environment : new Map(),
    now: () => context.now(),
    debug: (value) => {
      const text = dumpString(["DEBUG:", value], { ...options.dump, pretty: false });
      context.diagnostic(utf8(`${text}\n`));
    },
    stderr: (value) => {
      context.diagnostic(utf8(typeof value === "string" ? value : dumpString(value)));
    },
  };
  const runtime = new Runtime(host, context.fs.retained, globals(), evaluate);
  let env: Env = EMPTY_ENV;
  for (const [name, value] of variables) env = withVariable(env, name, value);

  if (called.has("input/0") || called.has("inputs/0")) await reader.preload();

  let result = NO_OUTPUT;
  let last = -1;
  try {
    if (options.nullInput) {
      result = yield* process(context, options, runtime, program, env, null, reader);
    } else {
      while (reader.failures === 0) {
        const step = await reader.next();
        if (step.kind === "end") break;
        if (step.kind === "error") {
          result = ERROR;
          context.diagnostic(utf8(`jq: parse error: ${step.message}\n`));
          break;
        }
        try {
          result = yield* process(context, options, runtime, program, env, step.value, reader);
        } finally {
          step.release();
          runtime.ledger.settle();
        }
        if (result <= 0 && result !== NO_OUTPUT) last = result === NULL_KIND ? 0 : 1;
      }
    }
  } catch (error) {
    if (error instanceof JqHalt) {
      halt(context, error);
      setStatus(options.exitStatus ? Math.abs(error.status) : Math.max(error.status, 0));
      return;
    }
    // V8's own limits (call stack, string or array length) are a real failure
    // of this runtime rather than of the program; they must not escape the shell.
    if (error instanceof RangeError) {
      context.warn(engineLimit(error));
      setStatus(2);
      return;
    }
    if (!(error instanceof JqRefusal)) throw error;
    context.warn(error.message);
    setStatus(2);
    return;
  }
  if (reader.failures > 0) result = SYSTEM;
  setStatus(exitStatus(options.exitStatus, result, last));
}

/** halt_error's report goes to stderr as is: a string raw, anything else as JSON. */
function halt(context: CommandContext, error: JqHalt): void {
  const report = error.report;
  if (report === undefined || report === null) return;
  context.diagnostic(utf8(typeof report === "string" ? report : `${dumpString(report)}\n`));
}

function exitStatus(exitStatusOption: boolean, result: number, last: number): number {
  if (!exitStatusOption) return result > 0 ? result : 0;
  if (result !== NO_OUTPUT) return Math.abs(result);
  return last === -1 ? 4 : last === 0 ? 1 : 0;
}

/** jq's process(): every result of the filter over one input. */
async function* process(
  context: CommandContext,
  options: Options,
  runtime: Runtime,
  program: Node,
  env: Env,
  input: JqValue,
  reader: InputReader,
): AsyncGenerator<Uint8Array, number, undefined> {
  let result = NO_OUTPUT;
  const results = evaluate(runtime, program, root(input), env);
  try {
    for (;;) {
      let step: IteratorResult<{ value: JqValue }, void>;
      try {
        step = results.next();
      } catch (error) {
        if (!(error instanceof JqError)) throw error;
        const message = error.value;
        const text =
          typeof message === "string"
            ? `jq: error (at ${reader.position}): ${message}\n`
            : `jq: error (at ${reader.position}) (not a string): ${dumpString(message)}\n`;
        context.diagnostic(utf8(text));
        return ERROR;
      }
      if (step.done === true) return result;
      const value = step.value.value;
      if (options.rawOutput && typeof value === "string") {
        if (!options.dump.ascii && options.nul && value.includes("\0")) {
          context.diagnostic(
            utf8(
              `jq: error (at ${reader.position}): Cannot dump a string containing NUL with --raw-output0 option\n`,
            ),
          );
          return ERROR;
        }
        yield utf8(options.dump.ascii ? quote(value, true) : value);
        result = OK;
      } else {
        result = value === null || value === false ? NULL_KIND : OK;
        yield* serialize(value, options);
      }
      if (!options.join) yield utf8("\n");
      if (options.nul) yield utf8("\0");
    }
  } finally {
    results.return();
  }
}

function* serialize(value: JqValue, options: Options): Generator<Uint8Array, void, undefined> {
  const writer = new Writer();
  const steps = dumpInto(writer, value, options.dump);
  while (steps.next().done !== true) yield utf8(writer.take());
  yield utf8(writer.take());
}
