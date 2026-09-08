// `cat`, `head`, `tail`, `wc` — 161 corpus invocations between them, and
// almost all of `head`/`tail` were pipeline truncation rather than a file
// read. The ones that do name a file lower to `readRange`, so `head -20` of
// a 40 MB file is one statement over a few kilobytes.

import {
  type ByteStream,
  concat,
  encode,
  lines,
  NEWLINE,
  restoreUnused,
  terminated,
} from "../exec/bytes.js";
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
    let pending: readonly string[] = paths;
    while (pending.length > 0) {
      if (context.fs.retained.available === 0) {
        context.fs.retained.retain(1, "cat batch");
      }
      const batch = context.fs.readFiles(pending, {
        budget: context.fs.readBudget,
        maxBytes: context.fs.retained.available,
        deferOversized: true,
      });
      const consumed = pending.length - batch.remaining.length;
      if (consumed === 0) {
        const path = pending[0];
        if (path === undefined) return;
        const stat = context.fs.statTarget(path);
        if (stat === null) {
          context.warn(`${path}: No such file or directory`);
          status = 1;
        } else {
          yield* streamFile(context, path, stat.size, "cat file");
        }
        pending = pending.slice(1);
        continue;
      }

      let held = 0;
      for (const bytes of batch.files.values()) held += bytes.length;
      const release = context.fs.retained.retain(held, "cat batch");
      try {
        for (let index = 0; index < consumed; index++) {
          const path = pending[index];
          if (path === undefined) continue;
          const bytes = batch.files.get(path);
          if (bytes === undefined) {
            context.warn(`${path}: No such file or directory`);
            status = 1;
          } else yield bytes;
        }
      } finally {
        release();
      }
      pending = batch.remaining;
    }
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
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
    let headings: "auto" | "always" | "never" = "auto";
    for (const flag of parsed.flags) {
      if (flag.name === "-n" || flag.name === "--lines") {
        wanted = count(flag.value ?? "", "-n");
        unit = "lines";
      } else if (flag.name === "-c" || flag.name === "--bytes") {
        wanted = count(flag.value ?? "", "-c");
        unit = "bytes";
      } else if (flag.name === "-q") {
        headings = "never";
      } else if (flag.name === "-v") {
        headings = "always";
      }
    }
    const operands = parsed.operands;

    if (operands.length > 0) {
      let status = 0;
      const stdout = headFiles(context, operands, wanted, unit, headings, () => {
        status = 1;
      });
      return { stdout, status: () => status, truncated: () => false };
    }

    const source = context.stdin;
    if (source === null) return result(empty());
    const selected = unit === "bytes" ? takeBytes(source, wanted) : takeLines(source, wanted);
    return result(headings === "always" ? headed("standard input", selected) : selected);
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

function* headFiles(
  context: CommandContext,
  operands: readonly string[],
  wanted: number,
  unit: "lines" | "bytes",
  headings: "auto" | "always" | "never",
  failed: () => void,
): ByteStream {
  const showHeadings = headings === "always" || (headings === "auto" && operands.length > 1);
  let emittedSection = false;
  for (const operand of operands) {
    const path = resolve(context.cwd, operand);
    const stat = context.fs.stat(path);
    if (stat === null) {
      context.warn(`${operand}: No such file or directory`);
      failed();
      continue;
    }
    if (showHeadings) {
      if (emittedSection) yield encode("\n");
      yield encode(`==> ${operand} <==\n`);
      emittedSection = true;
    }
    if (unit === "lines") {
      yield* headOfFile(context, path, stat.size, wanted);
    } else if (wanted > 0) {
      yield context.fs.readRange(path, 0, Math.min(stat.size, wanted));
    }
  }
}

async function* headed(name: string, source: ByteStream): ByteStream {
  yield encode(`==> ${name} <==\n`);
  for await (const chunk of source) yield chunk;
}

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
    return result(lastLines(source, wanted, context.fs.retained));
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

export const wc: Command = async (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-l", "-c", "-w", "-m", "--lines", "--bytes", "--words", "--chars"]),
    valued: new Set(),
  });
  const wants = new Set(parsed.flags.map((flag) => flag.name));

  const source =
    parsed.operands.length === 0 ? context.stdin : fileStream(context, parsed.operands);
  if (source === null) return result(empty());

  let lineCount = 0;
  let wordCount = 0;
  let byteCount = 0;
  let characterCount = 0;
  let inWord = false;
  const decoder = new TextDecoder();
  for await (const chunk of source) {
    byteCount += chunk.length;
    for (const _character of decoder.decode(chunk, { stream: true })) characterCount++;
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
  for (const _character of decoder.decode()) characterCount++;

  const requested = parsed.flags.length > 0;
  const counts: number[] = [];
  if (!requested || wants.has("-l") || wants.has("--lines")) counts.push(lineCount);
  if (!requested || wants.has("-w") || wants.has("--words")) counts.push(wordCount);
  if (wants.has("-m") || wants.has("--chars")) counts.push(characterCount);
  if (!requested || wants.has("-c") || wants.has("--bytes")) counts.push(byteCount);
  return result(one(encode(`${counts.join(" ")}\n`)));
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
      yield* streamFile(context, path, stat.size, "file input");
    }
  })();
}

function* streamFile(
  context: CommandContext,
  path: string,
  size: number,
  label: string,
): ByteStream {
  let offset = 0;
  while (offset < size) {
    if (context.fs.retained.available === 0) context.fs.retained.retain(1, label);
    const length = Math.min(context.fs.readBudget, context.fs.retained.available, size - offset);
    const release = context.fs.retained.retain(length, label);
    try {
      yield context.fs.readRange(path, offset, length);
    } finally {
      release();
    }
    offset += length;
  }
}

/**
 * `head -N file` without reading the file: read a probe from the front and
 * extend only if it held fewer than N newlines.
 */
async function* takeLines(source: ByteStream, wanted: number): ByteStream {
  if (wanted === 0) return;
  let seen = 0;
  for await (const chunk of source) {
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== NEWLINE) continue;
      seen++;
      if (seen < wanted) continue;
      const end = index + 1;
      try {
        yield chunk.subarray(0, end);
      } finally {
        restoreUnused(source, chunk.subarray(end));
      }
      return;
    }
    yield chunk;
  }
}

async function* takeBytes(source: ByteStream, wanted: number): ByteStream {
  if (wanted === 0) return;
  let sent = 0;
  for await (const chunk of source) {
    const room = wanted - sent;
    if (room <= 0) return;
    if (chunk.length <= room) {
      sent += chunk.length;
      yield chunk;
      continue;
    }
    try {
      yield chunk.subarray(0, room);
    } finally {
      restoreUnused(source, chunk.subarray(room));
    }
    return;
  }
}

/** A bounded ring buffer: memory is O(N), not O(input). */
async function* lastLines(
  source: ByteStream,
  wanted: number,
  retained: CommandContext["fs"]["retained"],
): ByteStream {
  if (wanted === 0) return;
  const held: Array<{ bytes: Uint8Array; release(): void }> = [];
  try {
    for await (const text of lines(source, retained)) {
      const release = retained.retain(text.length, "tail line buffer");
      held.push({ bytes: text.slice(), release });
      if (held.length > wanted) held.shift()?.release();
    }
    for await (const chunk of terminated(held.map((entry) => entry.bytes))) yield chunk;
  } finally {
    for (const entry of held) entry.release();
  }
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
    const release = context.fs.retained.retain(span, "head range probe");
    try {
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
    } finally {
      release();
    }
    span = Math.min(size, span * 4);
  }
}

async function* tailOfFile(
  context: CommandContext,
  path: string,
  size: number,
  wanted: number,
): ByteStream {
  if (wanted === 0 || size === 0) return;
  let span = Math.min(size, Math.max(LINE_PROBE, wanted * 128));
  for (;;) {
    const offset = Math.max(0, size - span);
    const release = context.fs.retained.retain(span, "tail range probe");
    try {
      const bytes = context.fs.readRange(path, offset, span);
      const newlines = countNewlines(bytes, offset === 0);
      if (newlines >= wanted || offset === 0) {
        for await (const chunk of lastLines(one(bytes), wanted, context.fs.retained)) yield chunk;
        return;
      }
      if (span >= size) {
        for await (const chunk of lastLines(one(bytes), wanted, context.fs.retained)) yield chunk;
        return;
      }
    } finally {
      release();
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
