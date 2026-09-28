// `nl` as uutils 0.2.2 prints it: numbering styles `a`, `t`, `n`, the three
// number formats, width, separator, start, increment, blank-line joining, and
// the `\:\:\:` section delimiters that switch styles and restart numbering.
// Line numbers are i64 and overflow is an error, so they are BigInts here.
// `-b pBRE` needs Rust's regex dialect and is refused.

import { type ByteStream, encode } from "../../exec/bytes.js";
import type { Command, CommandContext } from "../../exec/context.js";
import {
  type ClapCommand,
  ClapError,
  type ClapParsed,
  has,
  last,
  parseClap,
  withBuiltins,
} from "./clap.js";
import { lossy, OutputBuffer, open, records } from "./records.js";
import { failWith, refuse, refuseBuiltins } from "./refusal.js";

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;

const NL: ClapCommand = {
  name: "nl",
  usage: "nl [OPTION]... [FILE]...",
  options: withBuiltins([
    { id: "help", long: "help" },
    { id: "body", short: "b", long: "body-numbering", value: "STYLE" },
    { id: "delimiter", short: "d", long: "section-delimiter", value: "CC" },
    { id: "footer", short: "f", long: "footer-numbering", value: "STYLE" },
    { id: "header", short: "h", long: "header-numbering", value: "STYLE" },
    {
      id: "increment",
      short: "i",
      long: "line-increment",
      value: "NUMBER",
      parse: integer(I64_MIN, I64_MAX),
    },
    {
      id: "join",
      short: "l",
      long: "join-blank-lines",
      value: "NUMBER",
      parse: integer(0n, U64_MAX),
    },
    {
      id: "format",
      short: "n",
      long: "number-format",
      value: "FORMAT",
      choices: ["ln", "rn", "rz"],
    },
    { id: "no-renumber", short: "p", long: "no-renumber" },
    { id: "separator", short: "s", long: "number-separator", value: "STRING" },
    {
      id: "start",
      short: "v",
      long: "starting-line-number",
      value: "NUMBER",
      parse: integer(I64_MIN, I64_MAX),
    },
    { id: "width", short: "w", long: "number-width", value: "NUMBER", parse: integer(0n, U64_MAX) },
  ]),
};

type Style = "all" | "nonempty" | "none";

interface Settings {
  readonly header: Style;
  readonly body: Style;
  readonly footer: Style;
  readonly delimiter: Uint8Array;
  readonly start: bigint;
  readonly increment: bigint;
  readonly join: bigint;
  readonly width: number;
  readonly format: "ln" | "rn" | "rz";
  readonly renumber: boolean;
  readonly separator: Uint8Array;
}

export const nl: Command = (context) => {
  let parsed: ClapParsed;
  try {
    parsed = parseClap(NL, context.argv);
  } catch (error) {
    if (error instanceof ClapError) return failWith(context, error.rendered);
    throw error;
  }
  const refused = refuseBuiltins(context, parsed);
  if (refused !== null) return refused;

  const errors: string[] = [];
  const styles: Style[] = [];
  for (const [id, fallback] of [
    ["header", "none"],
    ["body", "nonempty"],
    ["footer", "none"],
  ] as const) {
    const text = last(parsed, id);
    if (text === null) {
      styles.push(fallback);
      continue;
    }
    if (text.startsWith("p"))
      return refuse(context, `numbering style '${text}' (a regular expression)`);
    const style = STYLES.get(text);
    if (style === undefined) errors.push(`invalid numbering style: '${text}'`);
    styles.push(style ?? fallback);
  }
  const widthText = last(parsed, "width");
  if (widthText !== null && BigInt(widthText) === 0n) {
    errors.push("Invalid line number field width: ‘0’: Numerical result out of range");
  }
  if (errors.length > 0) {
    return failWith(context, `nl: Invalid arguments supplied.\n${errors.join("\n")}\n`);
  }
  const delimiterText = last(parsed, "delimiter");
  const delimiterBytes = delimiterText === null ? encode("\\:") : encode(delimiterText);
  const formatText = last(parsed, "format");
  const settings: Settings = {
    header: styles[0] ?? "none",
    body: styles[1] ?? "nonempty",
    footer: styles[2] ?? "none",
    delimiter: delimiterBytes.length === 1 ? encode(`${delimiterText ?? ""}:`) : delimiterBytes,
    start: BigInt(last(parsed, "start") ?? "1"),
    increment: BigInt(last(parsed, "increment") ?? "1"),
    join: BigInt(last(parsed, "join") ?? "1"),
    width: widthText === null ? 6 : Number(BigInt(widthText)),
    format: formatText === "ln" || formatText === "rz" ? formatText : "rn",
    renumber: !has(parsed, "no-renumber"),
    separator: lossy(encode(last(parsed, "separator") ?? "\t")),
  };

  let status = 0;
  const operands = parsed.operands.length === 0 ? ["-"] : parsed.operands;
  const stdout = (async function* (): ByteStream {
    const state: State = { number: settings.start, emptyRun: 0n };
    for (const operand of operands) {
      const opened = open(context, operand, true);
      if (opened.kind === "directory") {
        context.warn(`${operand}: Is a directory`);
        status = 1;
        continue;
      }
      if (opened.kind === "missing") {
        context.warn(`${operand}: No such file or directory`);
        status = 1;
        return;
      }
      for await (const chunk of number(context, opened.stream, settings, state)) {
        if (chunk === null) {
          context.warn("line number overflow");
          status = 1;
          return;
        }
        yield chunk;
      }
    }
  })();
  return { stdout, status: () => status, truncated: () => false };
};

const STYLES = new Map<string, Style>([
  ["a", "all"],
  ["t", "nonempty"],
  ["n", "none"],
]);

interface State {
  /** Null once the next number would overflow i64. */
  number: bigint | null;
  emptyRun: bigint;
}

/** Numbered output in chunks; a null chunk is the overflow error, after what came before it. */
async function* number(
  context: CommandContext,
  source: ByteStream,
  settings: Settings,
  state: State,
): AsyncGenerator<Uint8Array | null, void, undefined> {
  const out = new OutputBuffer();
  const releaseBlank = context.fs.retained.retain(settings.width + 1, "nl blank field");
  try {
    yield* numberLines(
      context,
      source,
      settings,
      state,
      out,
      encode(" ".repeat(settings.width + 1)),
    );
  } finally {
    releaseBlank();
  }
}

async function* numberLines(
  context: CommandContext,
  source: ByteStream,
  settings: Settings,
  state: State,
  out: OutputBuffer,
  blank: Uint8Array,
): AsyncGenerator<Uint8Array | null, void, undefined> {
  let style = settings.body;
  for await (const record of records(source, 0x0a, context.fs.retained)) {
    const line = record.bytes;
    state.emptyRun = line.length === 0 ? state.emptyRun + 1n : 0n;
    const section = sectionOf(line, settings.delimiter);
    if (section !== null) {
      style = settings[section];
      if (settings.renumber) state.number = settings.start;
      out.byte(0x0a);
    } else if (numbered(style, line, state, settings)) {
      if (state.number === null) {
        const rest = out.take();
        if (rest !== null) yield rest;
        yield null;
        return;
      }
      const release = context.fs.retained.retain(settings.width, "nl number field");
      try {
        out.text(formatNumber(state.number, settings));
      } finally {
        release();
      }
      out.push(settings.separator);
      out.push(lossy(line.slice()));
      out.byte(0x0a);
      const next = state.number + settings.increment;
      state.number = next < I64_MIN || next > I64_MAX ? null : next;
    } else {
      out.push(blank);
      out.push(lossy(line.slice()));
      out.byte(0x0a);
    }
    if (out.full) {
      const chunk = out.take();
      if (chunk !== null) yield chunk;
    }
  }
  const rest = out.take();
  if (rest !== null) yield rest;
}

function numbered(style: Style, line: Uint8Array, state: State, settings: Settings): boolean {
  if (style === "none") return false;
  if (style === "nonempty") return line.length > 0;
  // `-l N`: N consecutive empty lines count as one, numbered on the last.
  return !(line.length === 0 && settings.join > 0n && state.emptyRun % settings.join !== 0n);
}

function sectionOf(line: Uint8Array, pattern: Uint8Array): "header" | "body" | "footer" | null {
  if (line.length === 0 || pattern.length === 0 || line.length % pattern.length !== 0) return null;
  const count = line.length / pattern.length;
  if (count > 3) return null;
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== pattern[index % pattern.length]) return null;
  }
  return count === 1 ? "footer" : count === 2 ? "body" : "header";
}

function formatNumber(value: bigint, settings: Settings): string {
  const text = value.toString();
  if (settings.format === "ln") return text.padEnd(settings.width);
  if (settings.format === "rn") return text.padStart(settings.width);
  if (value < 0n) return `-${(-value).toString().padStart(Math.max(0, settings.width - 1), "0")}`;
  return text.padStart(settings.width, "0");
}

/** clap's integer value parser: Rust's `parse` and its messages. */
function integer(
  min: bigint,
  max: bigint,
): (value: string) => { reason: string; shown: string } | null {
  return (value) => {
    const signed = min < 0n;
    if (!(signed ? /^[+-]?[0-9]+$/ : /^\+?[0-9]+$/).test(value)) {
      return { reason: "invalid digit found in string", shown: value };
    }
    const parsed = BigInt(value);
    if (parsed > max)
      return { reason: "number too large to fit in target type", shown: asFloat(value) };
    if (parsed < min)
      return { reason: "number too small to fit in target type", shown: asFloat(value) };
    return null;
  };
}

/** How clap shows an out-of-range integer: through f64, printed without an exponent. */
function asFloat(value: string): string {
  const [mantissa = "0", exponentText = "0"] = Number(value).toExponential().split("e");
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const exponent = Number(exponentText);
  const integral = digits.padEnd(exponent + 1, "0");
  return `${negative ? "-" : ""}${integral}`;
}
