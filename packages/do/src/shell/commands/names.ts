// `basename` and `dirname`: pure string operations with GNU coreutils output.
// They never touch the filesystem.

import { type ByteStream, encode } from "../exec/bytes.js";
import { type Command, type CommandContext, type CommandResult, result } from "../exec/context.js";
import { type FlagSpec, type ParsedArgs, parseFlags, UsageError } from "./flags.js";

export const basename: Command = (context) => {
  const parsed = parse(context, "basename", {
    boolean: new Set(["-a", "--multiple", "-z", "--zero"]),
    valued: new Set(["-s", "--suffix"]),
  });
  if (parsed === null) return failed();

  let suffix = "";
  let multiple = false;
  for (const flag of parsed.flags) {
    // `-s` implies `-a`, as in GNU basename.
    if (flag.name === "-s" || flag.name === "--suffix") suffix = flag.value ?? "";
    if (flag.name !== "-z" && flag.name !== "--zero") multiple = true;
  }

  const operands = parsed.operands;
  const terminator = zeroTerminated(parsed) ? "\0" : "\n";
  if (operands.length === 0) return usage(context, "basename", "missing operand");
  if (!multiple) {
    if (operands.length > 2) {
      return usage(context, "basename", `extra operand '${operands[2] ?? ""}'`);
    }
    suffix = operands[1] ?? "";
    return result(records([baseOf(operands[0] ?? "", suffix)], terminator));
  }
  return result(
    records(
      operands.map((name) => baseOf(name, suffix)),
      terminator,
    ),
  );
};

export const dirname: Command = (context) => {
  const parsed = parse(context, "dirname", {
    boolean: new Set(["-z", "--zero"]),
    valued: new Set(),
  });
  if (parsed === null) return failed();
  if (parsed.operands.length === 0) return usage(context, "dirname", "missing operand");
  const terminator = zeroTerminated(parsed) ? "\0" : "\n";
  return result(records(parsed.operands.map(dirOf), terminator));
};

function parse(context: CommandContext, name: string, spec: FlagSpec): ParsedArgs | null {
  try {
    return parseFlags(context.argv, spec);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    usage(context, name, error.message);
    return null;
  }
}

function zeroTerminated(parsed: ParsedArgs): boolean {
  return parsed.flags.some((flag) => flag.name === "-z" || flag.name === "--zero");
}

function baseOf(name: string, suffix: string): string {
  const trimmed = name.replace(/\/+$/, "");
  if (trimmed === "") return name === "" ? "" : "/";
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (suffix !== "" && base !== suffix && base.endsWith(suffix)) {
    return base.slice(0, -suffix.length);
  }
  return base;
}

function dirOf(name: string): string {
  const trimmed = name.replace(/\/+$/, "");
  if (trimmed === "") return name.startsWith("/") ? "/" : ".";
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return ".";
  const parent = trimmed.slice(0, slash).replace(/\/+$/, "");
  return parent === "" ? "/" : parent;
}

function usage(context: CommandContext, name: string, message: string): CommandResult {
  context.diagnostic(encode(`${name}: ${message}\nTry '${name} --help' for more information.\n`));
  return failed();
}

function failed(): CommandResult {
  return result(records([], "\n"), 1);
}

function* records(values: readonly string[], terminator: string): ByteStream {
  if (values.length > 0) yield encode(`${values.join(terminator)}${terminator}`);
}
