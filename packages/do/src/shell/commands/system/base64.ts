// `base64` streams both ways. Encoding carries at most two bytes between
// chunks and wraps across chunk boundaries; decoding carries at most one
// partial quantum. uutils' decoder is strict: newlines are skipped, padding is
// optional but must complete the final quantum, and the unused low bits of a
// final partial quantum must be zero.

import { type ByteStream, concat, empty, encode } from "../../exec/bytes.js";
import { type Command, type CommandContext, deferred, fail, result } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { streamFile } from "../read.js";
import { type CommandSpec, has, last, parseCommandLine, parseFailure } from "./clap.js";
import { maybeQuote } from "./quote.js";

const FAILED = 1;
const DEFAULT_WRAP = 76;
// Work is done in fixed slices so the extra memory stays constant whatever
// chunk size the input arrives in. Encoding slices are whole 3-byte groups.
const ENCODE_SLICE = 3 * 16 * 1024;
const DECODE_SLICE = 64 * 1024;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SEXTETS = new Map(Array.from(ALPHABET, (char, index) => [char.charCodeAt(0), index]));
const PAD = 0x3d;
const NEWLINE = 0x0a;
const RETURN = 0x0d;

const SPEC: CommandSpec = {
  usage: "base64 [OPTION]... [FILE]",
  options: [
    { name: "decode", short: ["d", "D"], repeatable: true },
    { name: "ignore-garbage", short: ["i"], repeatable: true },
    { name: "wrap", short: ["w"], value: "required", valueName: "COLS", repeatable: true },
    { name: "help", short: ["h"], refused: true },
    { name: "version", short: ["V"], refused: true },
  ],
};

class InvalidInput extends Error {}

export const base64: Command = (context) => {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(context.argv, SPEC);
  } catch (error) {
    const failed = parseFailure(context, error, FAILED);
    if (failed !== null) return failed;
    throw error;
  }

  const [operand = "-", extra] = parsed.operands;
  if (extra !== undefined) {
    context.warn(`extra operand '${extra}'`);
    context.diagnostic(encode("Try 'base64 --help' for more information.\n"));
    return result(empty(), FAILED);
  }
  const wrapText = last(parsed, "wrap");
  let wrap = DEFAULT_WRAP;
  if (wrapText !== undefined && wrapText !== null) {
    if (!/^[0-9]+$/.test(wrapText)) return fail(context, `invalid wrap size: '${wrapText}'`);
    wrap = Number(wrapText);
  }

  let source: ByteStream;
  if (operand === "-") {
    source = context.stdin ?? empty();
  } else {
    const path = resolve(context.cwd, operand);
    const stat = context.fs.statTarget(path);
    if (stat === null) return fail(context, `${maybeQuote(operand)}: No such file or directory`);
    if (stat.type !== "file") return fail(context, "read error: Is a directory");
    source = streamFile(context, path, stat.size, "base64 input");
  }

  if (!has(parsed, "decode")) return result(encodeStream(context, source, wrap));
  const ignoreGarbage = has(parsed, "ignore-garbage");
  return deferred((setStatus) => decodeStream(context, source, ignoreGarbage, setStatus));
};

async function* encodeStream(
  context: CommandContext,
  source: ByteStream,
  wrap: number,
): ByteStream {
  let carry: Uint8Array = new Uint8Array(0);
  let column = 0;
  let wrote = false;
  const emit = function* (
    bytes: Uint8Array,
    final: boolean,
  ): Generator<Uint8Array, void, undefined> {
    if (bytes.length === 0 && !(final && wrote && wrap > 0)) return;
    // Reserved before encoding: the UTF-16 text, its wrapped copy, and the bytes.
    const encodedLength = Math.ceil(bytes.length / 3) * 4;
    const lineBreaks = wrap > 0 ? Math.ceil(encodedLength / wrap) + 1 : 0;
    const release = context.fs.retained.retain((encodedLength + lineBreaks) * 5, "base64 output");
    try {
      const text = wrapped(encodeBytes(bytes), wrap, column);
      column = text.column;
      wrote ||= text.text.length > 0;
      const out = encode(final && wrote && wrap > 0 ? `${text.text}\n` : text.text);
      if (out.length > 0) yield out;
    } finally {
      release();
    }
  };

  for await (const chunk of source) {
    let offset = 0;
    if (carry.length > 0) {
      const needed = 3 - carry.length;
      if (chunk.length < needed) {
        carry = concat([carry, chunk]);
        continue;
      }
      yield* emit(concat([carry, chunk.subarray(0, needed)]), false);
      offset = needed;
    }
    while (chunk.length - offset >= 3) {
      const whole = chunk.length - offset - ((chunk.length - offset) % 3);
      const end = offset + Math.min(ENCODE_SLICE, whole);
      yield* emit(chunk.subarray(offset, end), false);
      offset = end;
    }
    carry = chunk.slice(offset);
  }
  yield* emit(carry, true);
}

function wrapped(
  text: string,
  wrap: number,
  startColumn: number,
): { text: string; column: number } {
  if (wrap === 0) return { text, column: 0 };
  let out = "";
  let column = startColumn;
  let index = 0;
  while (index < text.length) {
    if (column === wrap) {
      out += "\n";
      column = 0;
    }
    const take = Math.min(wrap - column, text.length - index);
    out += text.slice(index, index + take);
    column += take;
    index += take;
  }
  return { text: out, column };
}

function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const word = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    text += ALPHABET.charAt((word >> 18) & 63) + ALPHABET.charAt((word >> 12) & 63);
    text += b === undefined ? "=" : ALPHABET.charAt((word >> 6) & 63);
    text += c === undefined ? "=" : ALPHABET.charAt(word & 63);
  }
  return text;
}

async function* decodeStream(
  context: CommandContext,
  source: ByteStream,
  ignoreGarbage: boolean,
  setStatus: (status: number) => void,
): ByteStream {
  const quantum: number[] = [];
  let padding = 0;
  // Each slice's bytes are held until the next slice decodes cleanly, so an
  // input that fails within its last slice prints nothing of that slice, as
  // the reference prints nothing for a short invalid input.
  let pending: HeldOutput | null = null;
  try {
    for await (const chunk of source) {
      for (let start = 0; start < chunk.length; start += DECODE_SLICE) {
        const slice = chunk.subarray(start, start + DECODE_SLICE);
        // A carried partial quantum can complete inside a short slice.
        const output = holdOutput(context, slice.length + 3);
        try {
          for (const byte of slice) {
            if (byte === NEWLINE || byte === RETURN) continue;
            const sextet = SEXTETS.get(byte);
            if (sextet !== undefined) {
              if (padding > 0) throw new InvalidInput();
              quantum.push(sextet);
              if (quantum.length === 4) {
                output.push(quantumBytes(quantum));
                quantum.length = 0;
              }
              continue;
            }
            if (byte === PAD) {
              padding++;
              if (quantum.length < 2 || quantum.length + padding > 4) throw new InvalidInput();
              continue;
            }
            if (!ignoreGarbage) throw new InvalidInput();
          }
        } catch (error) {
          output.release();
          throw error;
        }
        if (pending !== null) yield* flush(pending);
        pending = output;
      }
    }
    if (padding > 0 && quantum.length + padding !== 4) throw new InvalidInput();
    if (quantum.length === 1) throw new InvalidInput();
    const tail = quantum.length > 1 ? quantumBytes(quantum) : [];
    if (pending !== null) yield* flush(pending);
    pending = null;
    if (tail.length > 0) yield* held(context, Uint8Array.from(tail));
  } catch (error) {
    if (!(error instanceof InvalidInput)) throw error;
    context.warn("error: invalid input");
    setStatus(FAILED);
  } finally {
    pending?.release();
  }
}

interface HeldOutput {
  readonly bytes: Uint8Array;
  length: number;
  push(bytes: readonly number[]): void;
  release(): void;
}

function holdOutput(context: CommandContext, capacity: number): HeldOutput {
  const release = context.fs.retained.retain(capacity, "base64 output");
  const output: HeldOutput = {
    bytes: new Uint8Array(capacity),
    length: 0,
    push(bytes) {
      output.bytes.set(bytes, output.length);
      output.length += bytes.length;
    },
    release,
  };
  return output;
}

function* flush(output: HeldOutput): Generator<Uint8Array, void, undefined> {
  try {
    if (output.length > 0) yield output.bytes.subarray(0, output.length);
  } finally {
    output.release();
  }
}

/** Three bytes from a full quantum, or fewer from a final partial one. */
function quantumBytes(quantum: readonly number[]): number[] {
  const [a = 0, b = 0, c, d] = quantum;
  if (c === undefined) {
    if ((b & 0x0f) !== 0) throw new InvalidInput();
    return [(a << 2) | (b >> 4)];
  }
  if (d === undefined) {
    if ((c & 0x03) !== 0) throw new InvalidInput();
    return [(a << 2) | (b >> 4), ((b & 0x0f) << 4) | (c >> 2)];
  }
  return [(a << 2) | (b >> 4), ((b & 0x0f) << 4) | (c >> 2), ((c & 0x03) << 6) | d];
}

function* held(context: CommandContext, bytes: Uint8Array): Generator<Uint8Array, void, undefined> {
  const release = context.fs.retained.retain(bytes.length, "base64 output");
  try {
    yield bytes;
  } finally {
    release();
  }
}
