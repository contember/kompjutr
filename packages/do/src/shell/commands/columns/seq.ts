// `seq` as uutils 0.2.2 prints it: exact decimal steps, the precision and `-w`
// width read from how the operands are spelled, `-s`, `-t`, and `-f`. Output is
// pulled: each chunk is formatted when the consumer asks for it, so
// `seq 1 1000000000 | head -2` stops after its first chunk.

import { type ByteStream, encode } from "../../exec/bytes.js";
import type { Command, CommandContext, CommandResult } from "../../exec/context.js";
import {
  type ClapCommand,
  ClapError,
  type ClapParsed,
  has,
  last,
  parseClap,
  withBuiltins,
} from "./clap.js";
import { OutputBuffer, quote } from "./records.js";
import { failWith, refuse, refuseBuiltins } from "./refusal.js";
import { type Format, FormatError, FormatRefusal, parseFormat, render } from "./seq-format.js";
import { aligned, isZero, ONE, type PreciseNumber, parseNumber } from "./seq-number.js";

const SEQ: ClapCommand = {
  name: "seq",
  usage:
    "seq [OPTION]... LAST\n       seq [OPTION]... FIRST LAST\n       seq [OPTION]... FIRST INCREMENT LAST",
  trailingOperands: true,
  hyphenOperands: true,
  options: withBuiltins([
    { id: "separator", short: "s", long: "separator", value: "separator" },
    { id: "terminator", short: "t", long: "terminator", value: "terminator" },
    { id: "equal-width", short: "w", long: "equal-width" },
    { id: "format", short: "f", long: "format", value: "format" },
  ]),
};

const TRY_HELP = "Try 'seq --help' for more information.\n";

export const seq: Command = (context) => {
  let parsed: ClapParsed;
  try {
    parsed = parseClap(SEQ, splitAttachedValues(context.argv));
    const extra = parsed.operands[3];
    if (extra !== undefined) {
      throw new ClapError(
        `error: unexpected value '${extra}' for '[numbers]...' found; no more were expected\n\nUsage: ${SEQ.usage}\n\nFor more information, try '--help'.\n`,
      );
    }
  } catch (error) {
    if (error instanceof ClapError) return failWith(context, error.rendered);
    throw error;
  }
  const refused = refuseBuiltins(context, parsed);
  if (refused !== null) return refused;

  const usage = (message: string): CommandResult =>
    failWith(context, `seq: ${message}\n${TRY_HELP}`);
  const numbers = parsed.operands;
  if (numbers.length === 0) return usage("missing operand");
  const formatText = last(parsed, "format");
  const equalWidth = has(parsed, "equal-width");
  if (equalWidth && formatText !== null) {
    return usage("format string may not be specified when printing equal width strings");
  }

  const operand = (text: string): PreciseNumber | CommandResult => {
    const parsedNumber = parseNumber(text, context.fs.retained.available);
    if (parsedNumber === "float") return usage(`invalid floating point argument: ${quote(text)}`);
    if (parsedNumber === "nan") return usage(`invalid 'not-a-number' argument: ${quote(text)}`);
    if (parsedNumber === "unsupported") return refuse(context, `the number ${quote(text)}`);
    return parsedNumber;
  };
  const firstText = numbers.length > 1 ? numbers[0] : undefined;
  const first = firstText === undefined ? ONE : operand(firstText);
  if (!isPrecise(first)) return first;
  const incrementText = numbers.length > 2 ? numbers[1] : undefined;
  const increment = incrementText === undefined ? ONE : operand(incrementText);
  if (!isPrecise(increment)) return increment;
  if (isZero(increment.value))
    return usage(`invalid Zero increment value: ${quote(incrementText ?? "")}`);
  const lastNumber = operand(numbers[numbers.length - 1] ?? "");
  if (!isPrecise(lastNumber)) return lastNumber;

  let format: Format;
  if (formatText !== null) {
    try {
      format = parseFormat(formatText);
    } catch (error) {
      if (error instanceof FormatError) return failWith(context, `seq: ${error.message}\n`);
      if (error instanceof FormatRefusal) return refuse(context, error.message);
      throw error;
    }
  } else {
    const precision =
      first.fractionalDigits === 0 &&
      increment.fractionalDigits === 0 &&
      lastNumber.fractionalDigits === 0
        ? 0
        : Math.max(first.fractionalDigits, increment.fractionalDigits);
    const width = equalWidth
      ? Math.max(first.integralDigits, increment.integralDigits, lastNumber.integralDigits) +
        (precision > 0 ? precision + 1 : 0)
      : 0;
    format = {
      prefix: "",
      suffix: "",
      spec: {
        variant: "decimal",
        uppercase: false,
        forceDecimal: false,
        width,
        precision,
        alignment: "right-zero",
        positiveSign: "",
      },
    };
  }

  const stdout = sequence(context, [first, increment, lastNumber], format, {
    separator: encode(last(parsed, "separator") ?? "\n"),
    terminator: encode(last(parsed, "terminator") ?? "\n"),
  });
  return { stdout, status: () => 0, truncated: () => false };
};

function isPrecise(value: PreciseNumber | CommandResult): value is PreciseNumber {
  return "value" in value;
}

/** uutils splits `-s,` into `-s` `,` (also `-f`, `-t`) before clap sees it. */
function splitAttachedValues(argv: readonly string[]): string[] {
  return argv.flatMap((arg) =>
    arg.length > 2 && /^-[fst]/.test(arg) ? [arg.slice(0, 2), arg.slice(2)] : [arg],
  );
}

async function* sequence(
  context: CommandContext,
  [first, increment, last]: readonly [PreciseNumber, PreciseNumber, PreciseNumber],
  format: Format,
  delimiters: { separator: Uint8Array; terminator: Uint8Array },
): ByteStream {
  const scale = Math.max(first.value.scale, increment.value.scale, last.value.scale);
  // The largest number of digits one rendered value can need; formatting pads to
  // the width and precision, and the common scale widens every step.
  const release = context.fs.retained.retain(
    scale + format.spec.width + (format.spec.precision ?? 0),
    "seq number",
  );
  try {
    const step = aligned(increment.value, scale);
    const end = aligned(last.value, scale);
    let units = aligned(first.value, scale);
    let negativeZero = first.value.negativeZero;
    const out = new OutputBuffer();
    let printed = false;
    while (step >= 0n ? units <= end : units >= end) {
      if (printed) out.push(delimiters.separator);
      out.text(render(format, { units, scale, negativeZero }));
      printed = true;
      units += step;
      negativeZero = false;
      if (out.full) {
        const chunk = out.take();
        if (chunk !== null) yield chunk;
      }
    }
    if (printed) out.push(delimiters.terminator);
    const rest = out.take();
    if (rest !== null) yield rest;
  } finally {
    release();
  }
}
