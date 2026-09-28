// `sort` holds its whole input, each record reserved against the retained
// budget. `-o` publishes the result in one atomic stream write after every
// input has been read, so the output may name an input. `-c` streams and
// keeps only the previous record.

import { type ByteStream, concat, empty, encode, owned } from "../../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../../exec/context.js";
import { strerror } from "../../exec/errno.js";
import { resolve } from "../../exec/execute.js";
import { isFilesystemError } from "../../exec/redirections.js";
import { streamFile } from "../read.js";
import { ClapError } from "../uutils/arguments.js";
import { compareBytes, comparePlainNumbers, compareSpans, type Span } from "./compare.js";
import { isBlank, KeyError, keyEnd, keyStart, type SortKey } from "./keys.js";
import {
  PlainSortError,
  parseSortArguments,
  type SortSettings,
  SortUsageError,
} from "./options.js";
import { records } from "./records.js";

const OUTPUT_CHUNK = 64 * 1024;

export const sort: Command = async (context) => {
  let settings: SortSettings;
  try {
    settings = parseSortArguments(context.argv);
  } catch (error) {
    if (error instanceof ClapError) {
      context.diagnostic(error.bytes);
      const status = error.kind === "missing-value" || error.kind === "invalid-value" ? 1 : 2;
      return result(empty(), status);
    }
    if (error instanceof KeyError || error instanceof PlainSortError) {
      return fail(context, error.message, 2);
    }
    if (error instanceof SortUsageError) {
      context.diagnostic(
        encode(`sort: ${error.message}\nTry 'sort --help' for more information.\n`),
      );
      return result(empty(), 2);
    }
    throw error;
  }

  const compare = comparator(settings);
  const operands = settings.operands.length === 0 ? ["-"] : settings.operands;
  let failure: string | null = null;
  const input = (async function* (): ByteStream {
    for (const operand of operands) {
      const opened = open(context, operand, settings.check !== "none");
      if (typeof opened === "string") {
        failure = opened;
        return;
      }
      let last: number | undefined;
      for await (const chunk of opened) {
        if (chunk.length === 0) continue;
        last = chunk[chunk.length - 1];
        yield chunk;
      }
      // Every input's last record ends, even one without a delimiter.
      if (last !== undefined && last !== settings.delimiter) {
        yield Uint8Array.of(settings.delimiter);
      }
    }
  })();

  if (settings.check !== "none") {
    const disorder = await findDisorder(context, input, settings, compare);
    if (failure !== null) return fail(context, failure, 2);
    if (disorder === null) return result(empty());
    if (settings.check === "diagnose") {
      const name = operands[0] ?? "-";
      context.diagnostic(
        concat([
          encode(`sort: ${name}:${disorder.line}: disorder: `),
          disorder.record,
          encode("\n"),
        ]),
      );
    }
    return result(empty(), 1);
  }

  const releases: Array<() => void> = [];
  const release = (): void => {
    for (const each of releases.splice(0)) each();
  };
  try {
    const lines: Uint8Array[] = [];
    for await (const record of records(input, settings.delimiter, context.fs.retained)) {
      // Twice the bytes, the reservation sort has always made per held line.
      releases.push(context.fs.retained.retain(record.length * 2, "sort input"));
      lines.push(record.slice());
    }
    if (failure !== null) {
      release();
      return fail(context, failure, 2);
    }
    const span = (line: Uint8Array): Span => ({ bytes: line, start: 0, end: line.length });
    lines.sort((left, right) => compare(span(left), span(right)));
    const kept = settings.unique ? uniqueLines(lines, span, compare) : lines;
    const chunks = serialize(kept, settings.delimiter);
    if (settings.output !== null) {
      const problem = publish(context, settings.output, chunks);
      release();
      return problem === null ? result(empty()) : fail(context, problem, 2);
    }
    return result(owned(chunks, release));
  } catch (error) {
    release();
    throw error;
  }
};

function open(context: CommandContext, operand: string, check: boolean): ByteStream | string {
  if (operand === "-") return context.stdin ?? empty();
  const path = resolve(context.cwd, operand);
  const stat = context.fs.statTarget(path);
  if (stat === null) return `cannot read: ${operand}: No such file or directory`;
  if (stat.type === "dir") {
    // uutils `sort -c` reads a directory as empty input.
    return check ? empty() : "Is a directory (os error 21)";
  }
  return streamFile(context, path, stat.size, "sort input");
}

type Comparator = (left: Span, right: Span) => number;

/** Keys in order, then — unless `-s` or `-u` — the whole line as bytes. */
function comparator(settings: SortSettings): Comparator {
  const { global, keys, separator } = settings;
  const lastResort = !settings.stable && !settings.unique;
  // Without -k the whole line is the one key, so -s and -u still compare it.
  const wholeLine = keys.length === 0;
  const compareKeys = (left: Span, right: Span): number => {
    if (wholeLine) {
      const plain = global.mode === "numeric" ? comparePlainNumbers(left, right) : null;
      const difference =
        plain ??
        compareSpans(
          skipBlanks(left, global.blanksAtStart),
          skipBlanks(right, global.blanksAtStart),
          global,
        );
      return global.reverse ? -difference : difference;
    }
    for (const key of keys) {
      const a = keySpan(left, key, separator);
      const b = keySpan(right, key, separator);
      const difference = compareSpans(a, b, key.options);
      if (difference !== 0) return key.options.reverse ? -difference : difference;
    }
    return 0;
  };
  return (left, right) => {
    const difference = compareKeys(left, right);
    if (difference !== 0 || !lastResort) return difference;
    const bytes = compareBytes(left, right);
    return global.reverse ? -bytes : bytes;
  };
}

function keySpan(line: Span, key: SortKey, separator: number | null): Span {
  const start = keyStart(line.bytes, line.start, line.end, key, separator);
  const end = keyEnd(line.bytes, line.start, line.end, key, separator);
  return { bytes: line.bytes, start, end: Math.max(start, end) };
}

function skipBlanks(line: Span, skip: boolean): Span {
  if (!skip) return line;
  let start = line.start;
  while (start < line.end && isBlank(line.bytes[start])) start++;
  return { bytes: line.bytes, start, end: line.end };
}

/** Under `-u` the comparator has no last resort, so equal means equal keys. */
function uniqueLines(
  lines: readonly Uint8Array[],
  span: (line: Uint8Array) => Span,
  equal: Comparator,
): Uint8Array[] {
  const kept: Uint8Array[] = [];
  for (const line of lines) {
    const previous = kept.at(-1);
    if (previous === undefined || equal(span(previous), span(line)) !== 0) kept.push(line);
  }
  return kept;
}

function* serialize(
  lines: readonly Uint8Array[],
  delimiter: number,
): Generator<Uint8Array, void, undefined> {
  let out = new Uint8Array(OUTPUT_CHUNK);
  let length = 0;
  for (const line of lines) {
    const size = line.length + 1;
    if (length + size > out.length && length > 0) {
      yield out.subarray(0, length);
      out = new Uint8Array(Math.max(OUTPUT_CHUNK, size));
      length = 0;
    }
    if (size > out.length) out = new Uint8Array(size);
    out.set(line, length);
    out[length + size - 1] = delimiter;
    length += size;
  }
  if (length > 0) yield out.subarray(0, length);
}

function publish(
  context: CommandContext,
  operand: string,
  chunks: Iterable<Uint8Array>,
): string | null {
  try {
    context.fs.writeFileStream(resolve(context.cwd, operand), chunks);
    return null;
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    return `open failed: ${operand}: ${strerror(error)}`;
  }
}

async function findDisorder(
  context: CommandContext,
  input: ByteStream,
  settings: SortSettings,
  compare: Comparator,
): Promise<{ line: number; record: Uint8Array } | null> {
  const strict = settings.unique;
  let previous: Uint8Array | null = null;
  let releasePrevious: (() => void) | null = null;
  let line = 0;
  try {
    for await (const record of records(input, settings.delimiter, context.fs.retained)) {
      line++;
      if (previous !== null) {
        const order = compare(
          { bytes: previous, start: 0, end: previous.length },
          { bytes: record, start: 0, end: record.length },
        );
        if (order > 0 || (strict && order === 0)) return { line, record: record.slice() };
      }
      releasePrevious?.();
      releasePrevious = context.fs.retained.retain(record.length, "sort check record");
      previous = record.slice();
    }
    return null;
  } finally {
    releasePrevious?.();
  }
}
