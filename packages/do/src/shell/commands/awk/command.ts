// `awk [-F fs] [-v var=value]… [-f progfile | 'program'] [operand…]`, as mawk
// parses it: options end at the first non-option, `--`, or the program text.
// mawk's `-W` options and long options are refused rather than ignored.

import type { ByteStream } from "../../exec/bytes.js";
import { empty } from "../../exec/bytes.js";
import { type Command, type CommandContext, result } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { streamFile } from "../read.js";
import { bytesToText, fromUnicode, toUnicode } from "./bytes.js";
import { AwkFatalError, AwkRuntimeError, AwkSyntaxError } from "./errors.js";
import { assignFromCommandLine, isAssignment } from "./input.js";
import { parseProgram } from "./parse/parser.js";
import { processEscapes } from "./parse/tokens.js";
import { runProgram } from "./run.js";
import { Runtime } from "./runtime.js";
import { maybeNumber, type Value } from "./values.js";

class CommandLineError extends Error {}

interface Invocation {
  readonly program: string;
  /** The `-f` file name, which prefixes compile errors. */
  readonly programFile: string | null;
  /** `-F` and `-v` in the order given; `-F` is an FS assignment. */
  readonly assignments: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly operands: readonly string[];
}

function parseCommandLine(context: CommandContext): Invocation {
  const argv = context.argv;
  const assignments: Array<{ name: string; value: string }> = [];
  let programFile: string | null = null;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg === "--") {
      index++;
      break;
    }
    if (arg.startsWith("--")) throw new CommandLineError(`not an option: ${arg}`);
    const letter = arg.charAt(1);
    if (!"Fvf".includes(letter)) {
      if (letter === "W") throw new CommandLineError(`-W options are not supported: ${arg}`);
      throw new CommandLineError(`not an option: ${arg}`);
    }
    let value: string;
    if (arg.length > 2) {
      value = arg.slice(2);
      index++;
    } else {
      const next = argv[index + 1];
      if (next === undefined) throw new CommandLineError(`option ${arg} lacks argument`);
      value = next;
      index += 2;
    }
    if (letter === "F") assignments.push({ name: "FS", value: fromUnicode(value) });
    else if (letter === "v") {
      const text = fromUnicode(value);
      const equals = text.indexOf("=");
      if (!isAssignment(text)) throw new CommandLineError(`improper assignment: -v ${value}`);
      assignments.push({ name: text.slice(0, equals), value: text.slice(equals + 1) });
    } else {
      if (programFile !== null)
        throw new CommandLineError("more than one -f program file is not supported");
      if (value === "-")
        throw new CommandLineError("-f - is not supported: standard input is the data");
      programFile = value;
    }
  }
  let program: string;
  if (programFile === null) {
    const text = argv[index];
    if (text === undefined)
      throw new CommandLineError(
        "no program given: usage: awk [-F fs] [-v var=value] 'program' [file ...]",
      );
    program = fromUnicode(text);
    index++;
  } else {
    program = readProgramFile(context, programFile);
  }
  return {
    program,
    programFile,
    assignments,
    operands: argv.slice(index).map(fromUnicode),
  };
}

function readProgramFile(context: CommandContext, name: string): string {
  const path = resolve(context.cwd, name);
  const stat = context.fs.stat(path);
  if (stat === null || stat.type !== "file") {
    const reason = stat === null ? "No such file or directory" : "Is a directory";
    throw new AwkFatalError(`cannot open "${name}" (${reason})`);
  }
  const release = context.fs.retained.retain(stat.size, "awk program file");
  try {
    return bytesToText(context.fs.readFile(path));
  } finally {
    release();
  }
}

function openOperand(context: CommandContext, name: string): ByteStream {
  const path = resolve(context.cwd, toUnicode(name));
  const stat = context.fs.stat(path);
  if (stat === null) throw new AwkFatalError(`cannot open "${name}" (No such file or directory)`);
  if (stat.type !== "file") throw new AwkFatalError(`cannot open "${name}" (Is a directory)`);
  return streamFile(context, path, stat.size, "awk input");
}

export function awkCommand(name: string): Command {
  return (context) => {
    let invocation: Invocation;
    try {
      invocation = parseCommandLine(context);
    } catch (error) {
      if (error instanceof CommandLineError || error instanceof AwkFatalError) {
        context.warn(error.message);
        return result(empty(), 2);
      }
      throw error;
    }

    const prefix = invocation.programFile === null ? "" : `${invocation.programFile}: `;
    let runtime: Runtime;
    try {
      const program = parseProgram(
        invocation.program,
        invocation.assignments.map((assignment) => assignment.name),
      );
      const argv: Value[] = [fromUnicode(name), ...invocation.operands.map(maybeNumber)];
      const environ = Object.entries(context.env ?? {}).map(([key, value]): [string, Value] => [
        fromUnicode(key),
        maybeNumber(fromUnicode(value)),
      ]);
      runtime = new Runtime({ program, budget: context.fs.retained, argv, environ });
    } catch (error) {
      if (error instanceof AwkSyntaxError) {
        context.warn(
          error.line === null ? error.message : `${prefix}line ${error.line}: ${error.message}`,
        );
        return result(empty(), 2);
      }
      throw error;
    }

    try {
      for (const assignment of invocation.assignments) {
        if (assignment.name === "FS") runtime.setSpecial("FS", processEscapes(assignment.value));
        else assignFromCommandLine(runtime, `${assignment.name}=${assignment.value}`);
      }
    } catch (error) {
      runtime.release();
      if (error instanceof AwkRuntimeError) {
        context.warn(`run time error: ${error.message}\n\tFILENAME="" FNR=0 NR=0`);
        return result(empty(), 2);
      }
      throw error;
    }

    const handle = runProgram(
      runtime,
      {
        open: (operand) => openOperand(context, operand),
        stdin: context.stdin,
      },
      (message) => context.warn(message),
    );
    return { stdout: handle.stdout, status: handle.status, truncated: () => false };
  };
}
