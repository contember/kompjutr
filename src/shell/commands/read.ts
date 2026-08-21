// `cat`, `head`, `tail`, `wc` — 161 corpus invocations between them, and
// almost all of `head`/`tail` were pipeline truncation rather than a file
// read. The ones that do name a file lower to `readRange`, so `head -20` of
// a 40 MB file is one statement over a few kilobytes.

import { type ByteStream, concat, encode, lines, NEWLINE, terminated } from "../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { count, parseFlags, UsageError } from "./flags.js";

/** Enough of a file to hold `count` lines, without reading all of it. */
const LINE_PROBE = 8 * 1024;

export const cat: Command = (context) => {
  if (context.argv.length === 0) {
    return result(context.stdin ?? empty());
  }
  const paths = context.argv.map((operand) => resolve(context.cwd, operand));

  // `cat big.log | head -20` is the one place the planner's demand hint pays
  // for itself: without it `cat` reads the whole file and `head` throws the
  // rest away. With it the read is a bounded range, same as `head big.log`.
  if (paths.length === 1 && context.limitHint !== null) {
    const only = paths[0] ?? "";
    const stat = context.fs.stat(only);
    if (stat === null) return fail(context, `${only}: No such file or directory`);
    return result(headOfFile(context, only, stat.size, context.limitHint));
  }

  let status = 0;
  const stream = (function* (): ByteStream {
    // One round trip for the whole list rather than one per file.
    let pending: readonly string[] = paths;
    const seen = new Map<string, Uint8Array>();
    while (pending.length > 0) {
      const batch = context.fs.readFiles(pending, { budget: context.fs.readBudget });
      for (const [path, bytes] of batch.files) seen.set(path, bytes);
      pending = batch.remaining;
    }
    for (const path of paths) {
      const bytes = seen.get(path);
      if (bytes === undefined) {
        context.warn(`${path}: No such file or directory`);
        status = 1;
        continue;
      }
      yield bytes;
    }
  })();
  return { stdout: stream, status: () => status };
};

export const head: Command = (context) => {
  try {
    // `head -20` is the spelling agents actually use, and a general flag
    // parser sees `-2` `-0` as two unknown flags. Strip the obsolete form
    // before parsing rather than teaching the parser about digits.
    const { argv, shorthand } = takeCountShorthand(context.argv);
    const parsed = parseFlags(argv, {
      boolean: new Set(["-q", "-v"]),
      valued: new Set(["-n", "-c", "--lines", "--bytes"]),
    });
    let wanted = shorthand ?? 10;
    let unit: "lines" | "bytes" = "lines";
    for (const flag of parsed.flags) {
      if (flag.name === "-n" || flag.name === "--lines") {
        wanted = count(flag.value ?? "", "-n");
        unit = "lines";
      } else if (flag.name === "-c" || flag.name === "--bytes") {
        wanted = count(flag.value ?? "", "-c");
        unit = "bytes";
      }
    }
    const operands = parsed.operands;

    // One file, bounded by lines: read a probe from the front and extend
    // only if it held too few newlines. Reading a 40 MB file to keep its
    // first twenty lines is the thing this shell exists not to do.
    if (operands.length === 1 && unit === "lines") {
      const path = resolve(context.cwd, operands[0] ?? "");
      const stat = context.fs.stat(path);
      if (stat === null) return fail(context, `${path}: No such file or directory`);
      return result(headOfFile(context, path, stat.size, wanted));
    }

    const source = operands.length === 0 ? context.stdin : fileStream(context, operands);
    if (source === null) return result(empty());
    return result(unit === "bytes" ? takeBytes(source, wanted) : takeLines(source, wanted));
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

export const tail: Command = (context) => {
  try {
    let wanted = 10;
    const operands: string[] = [];
    for (let index = 0; index < context.argv.length; index++) {
      const arg = context.argv[index];
      if (arg === undefined) continue;
      if (/^-[0-9]+$/.test(arg)) {
        wanted = Number(arg.slice(1));
        continue;
      }
      if (arg === "-n" || arg === "--lines") {
        wanted = count(context.argv[index + 1] ?? "", "-n");
        index++;
        continue;
      }
      if (/^-n[0-9]+$/.test(arg)) {
        wanted = Number(arg.slice(2));
        continue;
      }
      if (arg.startsWith("-")) throw new UsageError(`invalid option -- '${arg}'`);
      operands.push(arg);
    }

    // A file is read from the end: probe backwards until enough newlines are
    // in hand. Reading the whole file to keep its last twenty lines is the
    // thing this shell exists not to do.
    if (operands.length === 1) {
      const path = resolve(context.cwd, operands[0] ?? "");
      const stat = context.fs.stat(path);
      if (stat === null) return fail(context, `${path}: No such file or directory`);
      return result(tailOfFile(context, path, stat.size, wanted));
    }

    const source = operands.length === 0 ? context.stdin : fileStream(context, operands);
    if (source === null) return result(empty());
    return result(lastLines(source, wanted));
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

export const wc: Command = (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-l", "-c", "-w", "-m", "--lines", "--bytes", "--words"]),
    valued: new Set(),
  });
  const wants = new Set(parsed.flags.map((flag) => flag.name));
  const only = wants.size === 1 ? [...wants][0] : null;

  const source =
    parsed.operands.length === 0 ? context.stdin : fileStream(context, parsed.operands);
  if (source === null) return result(empty());

  let lineCount = 0;
  let wordCount = 0;
  let byteCount = 0;
  let inWord = false;
  for (const chunk of source) {
    byteCount += chunk.length;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (byte === NEWLINE) lineCount++;
      // A word is a run of anything that is not whitespace, counted as the
      // run starts so the stream is never buffered.
      const blank = byte === 0x20 || byte === 0x09 || byte === NEWLINE || byte === 0x0d;
      if (blank) inWord = false;
      else if (!inWord) {
        inWord = true;
        wordCount++;
      }
    }
  }

  if (only === "-l" || only === "--lines") return result(one(encode(`${lineCount}\n`)));
  if (only === "-c" || only === "--bytes") return result(one(encode(`${byteCount}\n`)));
  if (only === "-w" || only === "--words") return result(one(encode(`${wordCount}\n`)));
  return result(one(encode(`${lineCount} ${wordCount} ${byteCount}\n`)));
};

/** Pull `-N` out of an argv, leaving the rest for the flag parser. */
function takeCountShorthand(argv: readonly string[]): {
  argv: string[];
  shorthand: number | null;
} {
  const rest: string[] = [];
  let shorthand: number | null = null;
  for (const arg of argv) {
    if (/^-[0-9]+$/.test(arg)) {
      shorthand = Number(arg.slice(1));
      continue;
    }
    rest.push(arg);
  }
  return { argv: rest, shorthand };
}

function fileStream(context: CommandContext, operands: readonly string[]): ByteStream {
  const paths = operands.map((operand) => resolve(context.cwd, operand));
  return (function* (): ByteStream {
    for (const path of paths) {
      const stat = context.fs.stat(path);
      if (stat === null) {
        context.warn(`${path}: No such file or directory`);
        continue;
      }
      yield context.fs.readFile(path);
    }
  })();
}

/**
 * `head -N file` without reading the file: read a probe from the front and
 * extend only if it held fewer than N newlines.
 */
function* takeLines(source: ByteStream, wanted: number): ByteStream {
  if (wanted === 0) return;
  let seen = 0;
  for (const chunk of source) {
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== NEWLINE) continue;
      seen++;
      if (seen < wanted) continue;
      // Stop mid-chunk and stop pulling: the source stops here too.
      yield chunk.subarray(0, index + 1);
      return;
    }
    yield chunk;
  }
}

function* takeBytes(source: ByteStream, wanted: number): ByteStream {
  let sent = 0;
  for (const chunk of source) {
    const room = wanted - sent;
    if (room <= 0) return;
    if (chunk.length <= room) {
      sent += chunk.length;
      yield chunk;
      continue;
    }
    yield chunk.subarray(0, room);
    return;
  }
}

/** A bounded ring buffer: memory is O(N), not O(input). */
function* lastLines(source: ByteStream, wanted: number): ByteStream {
  if (wanted === 0) return;
  const held: Uint8Array[] = [];
  for (const text of lines(source)) {
    held.push(text);
    if (held.length > wanted) held.shift();
  }
  yield* terminated(held);
}

/** `head -N file` in one `readRange`, extended only if the probe fell short. */
function* headOfFile(
  context: CommandContext,
  path: string,
  size: number,
  wanted: number,
): ByteStream {
  if (wanted === 0 || size === 0) return;
  let span = Math.min(size, Math.max(LINE_PROBE, wanted * 128));
  for (;;) {
    const bytes = context.fs.readRange(path, 0, span);
    let seen = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== NEWLINE) continue;
      seen++;
      if (seen < wanted) continue;
      yield bytes.subarray(0, index + 1);
      return;
    }
    // Fewer newlines than asked for: either the file is shorter than N
    // lines, or the probe was.
    if (span >= size) {
      yield bytes;
      return;
    }
    span = Math.min(size, span * 4);
  }
}

function* tailOfFile(
  context: CommandContext,
  path: string,
  size: number,
  wanted: number,
): ByteStream {
  if (wanted === 0 || size === 0) return;
  let span = Math.min(size, Math.max(LINE_PROBE, wanted * 128));
  for (;;) {
    const offset = Math.max(0, size - span);
    const bytes = context.fs.readRange(path, offset, span);
    const newlines = countNewlines(bytes, offset === 0);
    if (newlines >= wanted || offset === 0) {
      yield* lastLines(one(bytes), wanted);
      return;
    }
    if (span >= size) {
      yield* lastLines(one(bytes), wanted);
      return;
    }
    span = Math.min(size, span * 4);
  }
}

function countNewlines(bytes: Uint8Array, includeFirst: boolean): number {
  let found = includeFirst ? 1 : 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === NEWLINE) found++;
  }
  return found;
}

function* one(bytes: Uint8Array): ByteStream {
  if (bytes.length > 0) yield bytes;
}

function* empty(): ByteStream {
  // Nothing.
}

export const readCommands: ReadonlyMap<string, Command> = new Map([
  ["cat", cat],
  ["head", head],
  ["tail", tail],
  ["wc", wc],
]);

export { concat };
