// `cut` as uutils 0.2.2 prints it. `-c` is `-b`: the reference counts bytes in
// the C locale. The field walkers are ported step for step rather than
// rewritten as a join, because the reference's own quirks are observable: an
// unterminated last line under `--output-delimiter` can repeat its last field.

import type { ByteStream } from "../../exec/bytes.js";
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
import { complement, ListError, parseList, type Range } from "./ranges.js";
import { OutputBuffer, open, type Record, records } from "./records.js";
import { failWith, refuseBuiltins } from "./refusal.js";

const CUT: ClapCommand = {
  name: "cut",
  usage: "cut OPTION... [FILE]...",
  options: withBuiltins([
    { id: "bytes", short: "b", long: "bytes", value: "LIST", hyphenValues: true, repeatable: true },
    {
      id: "characters",
      short: "c",
      long: "characters",
      value: "LIST",
      hyphenValues: true,
      repeatable: true,
    },
    { id: "delimiter", short: "d", long: "delimiter", value: "DELIM", repeatable: true },
    { id: "whitespace", short: "w", repeatable: true },
    {
      id: "fields",
      short: "f",
      long: "fields",
      value: "LIST",
      hyphenValues: true,
      repeatable: true,
    },
    { id: "complement", long: "complement", repeatable: true },
    { id: "only-delimited", short: "s", long: "only-delimited", repeatable: true },
    { id: "zero-terminated", short: "z", long: "zero-terminated", repeatable: true },
    { id: "output-delimiter", long: "output-delimiter", value: "NEW_DELIM", repeatable: true },
  ]),
};

type Delimiter =
  | { readonly kind: "whitespace" }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array };

interface Mode {
  readonly kind: "bytes" | "fields";
  readonly ranges: readonly Range[];
  readonly terminator: number;
  readonly outputDelimiter: Uint8Array | null;
  readonly delimiter: Delimiter;
  readonly onlyDelimited: boolean;
}

const ENCODER = new TextEncoder();
const NUL = new Uint8Array([0]);

export const cut: Command = (context) => {
  let parsed: ClapParsed;
  let mode: Mode;
  try {
    // uutils rewrites `-d=` so that `=` is the delimiter.
    const argv = context.argv.map((arg) => (arg === "-d=" ? "--delimiter==" : arg));
    parsed = parseClap(CUT, argv);
    const refused = refuseBuiltins(context, parsed);
    if (refused !== null) return refused;
    mode = selectMode(parsed);
  } catch (error) {
    if (error instanceof ClapError) return failWith(context, error.rendered);
    if (error instanceof CutError) return failWith(context, `cut: ${error.message}\n`);
    throw error;
  }

  let status = 0;
  const operands = parsed.operands.length === 0 ? ["-"] : parsed.operands;
  const stdout = (async function* (): ByteStream {
    let stdinRead = false;
    for (const operand of operands) {
      if (operand === "-") {
        if (stdinRead) continue;
        stdinRead = true;
      }
      const opened = open(context, operand, true);
      if (opened.kind !== "stream") {
        context.warn(
          `${operand}: ${opened.kind === "directory" ? "Is a directory" : "No such file or directory"}`,
        );
        status = 1;
        continue;
      }
      yield* cutStream(context, opened.stream, mode);
    }
  })();
  return { stdout, status: () => status, truncated: () => false };
};

class CutError extends Error {}

function selectMode(parsed: ClapParsed): Mode {
  const whitespace = has(parsed, "whitespace");
  const delimiterText = last(parsed, "delimiter");
  let delimiter: Delimiter = { kind: "bytes", bytes: Uint8Array.of(0x09) };
  if (delimiterText !== null) {
    if (whitespace) {
      throw new CutError(
        "invalid input: Only one of --delimiter (-d) or -w option can be specified",
      );
    }
    if (delimiterText === "" || delimiterText === "''") {
      delimiter = { kind: "bytes", bytes: NUL };
    } else {
      if ([...delimiterText].length > 1)
        throw new CutError("the delimiter must be a single character");
      delimiter = { kind: "bytes", bytes: ENCODER.encode(delimiterText) };
    }
  } else if (whitespace) {
    delimiter = { kind: "whitespace" };
  }
  const outputText = last(parsed, "output-delimiter");
  const outputDelimiter =
    outputText === null
      ? null
      : outputText === "" || outputText === "''"
        ? NUL
        : ENCODER.encode(outputText);
  const terminator = has(parsed, "zero-terminated") ? 0 : 0x0a;

  const lists = parsed.matches.filter(
    (match) => match.id === "bytes" || match.id === "characters" || match.id === "fields",
  );
  const only = lists[0];
  if (lists.length > 1) {
    throw new CutError(
      "invalid usage: expects no more than one of --fields (-f), --chars (-c) or --bytes (-b)",
    );
  }
  if (only === undefined || only.value === null) {
    throw new CutError("invalid usage: expects one of --fields (-f), --chars (-c) or --bytes (-b)");
  }
  let ranges: Range[];
  try {
    ranges = parseList(only.value);
  } catch (error) {
    if (error instanceof ListError) throw new CutError(error.message);
    throw error;
  }
  if (has(parsed, "complement")) ranges = complement(ranges);
  const onlyDelimited = has(parsed, "only-delimited");
  if (only.id !== "fields") {
    if (delimiterText !== null) {
      throw new CutError(
        "invalid input: The '--delimiter' ('-d') option only usable if printing a sequence of fields",
      );
    }
    if (whitespace) {
      throw new CutError(
        "invalid input: The '-w' option only usable if printing a sequence of fields",
      );
    }
    if (onlyDelimited) {
      throw new CutError(
        "invalid input: The '--only-delimited' ('-s') option only usable if printing a sequence of fields",
      );
    }
  }
  return {
    kind: only.id === "fields" ? "fields" : "bytes",
    ranges,
    terminator,
    outputDelimiter,
    delimiter,
    onlyDelimited,
  };
}

async function* cutStream(context: CommandContext, source: ByteStream, mode: Mode): ByteStream {
  const out = new OutputBuffer();
  const input = records(source, mode.terminator, context.fs.retained);
  const delimiter = mode.delimiter;
  if (
    mode.kind === "fields" &&
    delimiter.kind === "bytes" &&
    delimiter.bytes.length === 1 &&
    delimiter.bytes[0] === mode.terminator
  ) {
    yield* terminatorFields(input, mode, mode.outputDelimiter ?? delimiter.bytes);
    return;
  }
  for await (const record of input) {
    if (mode.kind === "bytes") cutBytes(record.bytes, mode, out);
    else cutFields(withTerminator(record, mode.terminator), mode, out);
    if (out.full) {
      const chunk = out.take();
      if (chunk !== null) yield chunk;
    }
  }
  const rest = out.take();
  if (rest !== null) yield rest;
}

function withTerminator(record: Record, terminator: number): Uint8Array {
  if (!record.terminated) return record.bytes;
  const line = new Uint8Array(record.bytes.length + 1);
  line.set(record.bytes);
  line[record.bytes.length] = terminator;
  return line;
}

function cutBytes(line: Uint8Array, mode: Mode, out: OutputBuffer): void {
  let printDelimiter = false;
  for (const { low, high } of mode.ranges) {
    if (low > line.length) break;
    if (printDelimiter && mode.outputDelimiter !== null) out.push(mode.outputDelimiter);
    else if (mode.outputDelimiter !== null) printDelimiter = true;
    out.push(line.subarray(low - 1, Math.min(high, line.length)));
  }
  out.byte(mode.terminator);
}

interface Match {
  readonly first: number;
  readonly last: number;
}

function cutFields(line: Uint8Array, mode: Mode, out: OutputBuffer): void {
  const matches = delimiterMatches(line, mode.delimiter);
  if (matches.length === 0) {
    if (mode.onlyDelimited) return;
    out.push(line);
    if (line.length === 0 || line[line.length - 1] !== mode.terminator) out.byte(mode.terminator);
    return;
  }
  // `-w` always joins with an explicit delimiter, tab unless given.
  const explicit =
    mode.outputDelimiter ?? (mode.delimiter.kind === "whitespace" ? Uint8Array.of(0x09) : null);
  if (explicit === null) implicitFields(line, matches, mode, out);
  else explicitFields(line, matches, mode, explicit, out);
}

function implicitFields(
  line: Uint8Array,
  matches: readonly Match[],
  mode: Mode,
  out: OutputBuffer,
): void {
  let fieldsPos = 1;
  let lowIndex = 0;
  let cursor = 0;
  let printDelimiter = false;
  for (const { low, high } of mode.ranges) {
    if (low - fieldsPos > 0) {
      cursor += low - fieldsPos - 1;
      const skipped = matches[cursor];
      if (skipped === undefined) break;
      cursor++;
      lowIndex = printDelimiter ? skipped.first : skipped.last;
    }
    const target = cursor + (high - low);
    const end = matches[target];
    if (end !== undefined) {
      cursor = target + 1;
      out.push(line.subarray(lowIndex, end.first));
      printDelimiter = true;
      lowIndex = end.first;
      fieldsPos = high + 1;
      continue;
    }
    cursor = matches.length;
    out.push(line.subarray(lowIndex));
    if (line[line.length - 1] === mode.terminator) return;
    break;
  }
  out.byte(mode.terminator);
}

function explicitFields(
  line: Uint8Array,
  matches: readonly Match[],
  mode: Mode,
  delimiter: Uint8Array,
  out: OutputBuffer,
): void {
  let fieldsPos = 1;
  let lowIndex = 0;
  let cursor = 0;
  let printDelimiter = false;
  ranges: for (const { low, high } of mode.ranges) {
    if (low - fieldsPos > 0) {
      cursor += low - fieldsPos - 1;
      const skipped = matches[cursor];
      if (skipped === undefined) break;
      cursor++;
      lowIndex = skipped.last;
    }
    for (let field = low; field <= high; field++) {
      if (printDelimiter) out.push(delimiter);
      else printDelimiter = true;
      const next = matches[cursor];
      if (next !== undefined) {
        cursor++;
        out.push(line.subarray(lowIndex, next.first));
        lowIndex = next.last;
        fieldsPos = high + 1;
        continue;
      }
      out.push(line.subarray(lowIndex));
      if (line[line.length - 1] === mode.terminator) return;
      continue ranges;
    }
  }
  out.byte(mode.terminator);
}

function delimiterMatches(line: Uint8Array, delimiter: Delimiter): Match[] {
  const found: Match[] = [];
  if (delimiter.kind === "whitespace") {
    for (let index = 0; index < line.length; index++) {
      if (!isBlank(line[index])) continue;
      const first = index;
      while (index + 1 < line.length && isBlank(line[index + 1])) index++;
      found.push({ first, last: index + 1 });
    }
    return found;
  }
  const needle = delimiter.bytes;
  const head = needle[0] ?? 0;
  for (let index = line.indexOf(head); index !== -1; index = line.indexOf(head, index)) {
    if (startsWith(line, needle, index)) {
      found.push({ first: index, last: index + needle.length });
      index += needle.length;
    } else {
      index++;
    }
  }
  return found;
}

function isBlank(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09;
}

function startsWith(line: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at + needle.length > line.length) return false;
  for (let offset = 0; offset < needle.length; offset++) {
    if (line[at + offset] !== needle[offset]) return false;
  }
  return true;
}

/** The delimiter is the terminator: each record is a field of one output line. */
async function* terminatorFields(
  input: AsyncIterable<Record>,
  mode: Mode,
  outputDelimiter: Uint8Array,
): ByteStream {
  const out = new OutputBuffer();
  let index = 0;
  let printed = false;
  for await (const record of input) {
    index++;
    if (!mode.ranges.some((range) => range.low <= index && index <= range.high)) continue;
    if (printed) out.push(outputDelimiter);
    printed = true;
    out.push(record.bytes.slice());
    if (out.full) {
      const chunk = out.take();
      if (chunk !== null) yield chunk;
    }
  }
  out.byte(mode.terminator);
  const rest = out.take();
  if (rest !== null) yield rest;
}
