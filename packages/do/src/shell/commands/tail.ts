// `tail`. A file is read from the end in widening range probes; `-n +N`
// streams from line N without buffering lines.

import { type ByteStream, empty, lines, NEWLINE, one, terminated } from "../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { count, UsageError } from "./flags.js";
import { fileStream, LINE_PROBE } from "./read.js";

export const tail: Command = (context) => {
  try {
    let wanted = 10;
    // `-n +N` starts at line N instead of keeping the last N.
    let fromLine: number | null = null;
    const setLines = (value: string): void => {
      if (value.startsWith("+")) {
        fromLine = count(value.slice(1), "-n");
        return;
      }
      wanted = count(value, "-n");
      fromLine = null;
    };
    const operands: string[] = [];
    for (let index = 0; index < context.argv.length; index++) {
      const arg = context.argv[index];
      if (arg === undefined) continue;
      if (/^-[0-9]+$/.test(arg)) {
        setLines(arg.slice(1));
        continue;
      }
      if (arg === "-n" || arg === "--lines") {
        setLines(context.argv[index + 1] ?? "");
        index++;
        continue;
      }
      if (/^-n\+?[0-9]+$/.test(arg)) {
        setLines(arg.slice(2));
        continue;
      }
      if (arg.startsWith("-")) throw new UsageError(`invalid option -- '${arg}'`);
      operands.push(arg);
    }

    const only = operands.length === 1 ? (operands[0] ?? "") : null;
    const onlyPath = only === null ? null : resolve(context.cwd, only);
    const onlyStat = onlyPath === null ? null : context.fs.stat(onlyPath);
    if (only !== null && onlyStat === null) {
      return fail(context, `cannot open '${only}' for reading: No such file or directory`);
    }

    if (fromLine !== null) {
      const source = operands.length === 0 ? context.stdin : fileStream(context, operands);
      if (source === null) return result(empty());
      return result(skipLines(source, Math.max(0, fromLine - 1)));
    }

    // A file is read from the end: probe backwards until enough newlines are
    // in hand. Reading the whole file to keep its last twenty lines is the
    // thing this shell exists not to do.
    if (onlyPath !== null && onlyStat !== null) {
      return result(tailOfFile(context, onlyPath, onlyStat.size, wanted));
    }

    const source = operands.length === 0 ? context.stdin : fileStream(context, operands);
    if (source === null) return result(empty());
    return result(lastLines(source, wanted, context.fs.retained));
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

/** Drops the first `skipped` lines and streams the rest without buffering lines. */
async function* skipLines(source: ByteStream, skipped: number): ByteStream {
  let seen = 0;
  for await (const chunk of source) {
    if (seen >= skipped) {
      yield chunk;
      continue;
    }
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== NEWLINE) continue;
      seen++;
      if (seen < skipped) continue;
      if (index + 1 < chunk.length) yield chunk.subarray(index + 1);
      break;
    }
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
