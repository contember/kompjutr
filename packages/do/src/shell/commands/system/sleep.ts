// `sleep` waits for real. One shell run is one Durable Object request, so the
// summed interval is capped to keep the run inside that request (ADR-0027).

import { empty, encode } from "../../exec/bytes.js";
import { type Command, result } from "../../exec/context.js";
import { type CommandSpec, parseCommandLine, parseFailure } from "./clap.js";

/** The longest total wait one run may request, in seconds. */
export const MAX_SLEEP_SECONDS = 60;

const FAILED = 1;
const TRY = "Try 'sleep --help' for more information.\n";
const INTERVAL = /^\s*\+?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?([smhd]?)$/;
const INFINITE = /^\s*\+?inf(inity)?[smhd]?$/i;
const HEXADECIMAL = /^\s*\+?0[xX]/;
const UNIT_SECONDS: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

const SPEC: CommandSpec = {
  usage: "sleep NUMBER[SUFFIX]...\n       sleep OPTION",
  options: [
    { name: "help", short: ["h"], refused: true },
    { name: "version", short: ["V"], refused: true },
  ],
};

export const sleep: Command = async (context) => {
  let operands: readonly string[];
  try {
    operands = parseCommandLine(context.argv, SPEC).operands;
  } catch (error) {
    const failed = parseFailure(context, error, FAILED);
    if (failed !== null) return failed;
    throw error;
  }
  if (operands.length === 0) {
    context.warn("missing operand");
    context.diagnostic(encode(TRY));
    return result(empty(), FAILED);
  }

  let total = 0;
  const invalid: string[] = [];
  for (const operand of operands) {
    if (HEXADECIMAL.test(operand)) {
      context.warn(`hexadecimal interval '${operand}' is not supported`);
      return result(empty(), FAILED);
    }
    if (INFINITE.test(operand)) {
      total = Number.POSITIVE_INFINITY;
      continue;
    }
    const match = INTERVAL.exec(operand);
    if (match === null) {
      invalid.push(operand);
      continue;
    }
    const [, mantissa = "0", exponent = "", unit = ""] = match;
    total += Number(`${mantissa}${exponent}`) * (UNIT_SECONDS[unit] ?? 1);
  }
  if (invalid.length > 0) {
    for (const operand of invalid) context.warn(`invalid time interval '${operand}'`);
    context.diagnostic(encode(TRY));
    return result(empty(), FAILED);
  }
  if (total > MAX_SLEEP_SECONDS) {
    context.warn(
      `total interval of ${total} seconds exceeds the ${MAX_SLEEP_SECONDS}-second limit: one shell run must finish inside one Durable Object request`,
    );
    return result(empty(), FAILED);
  }

  await new Promise<void>((resolve) => setTimeout(resolve, total * 1000));
  return result(empty());
};
