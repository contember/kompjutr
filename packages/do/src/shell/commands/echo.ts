// Bash's builtin `echo`. Leading words made only of `n`, `e`, and `E` are
// options; the first other word starts the operands. `-e` interprets escapes
// byte-for-byte, so `\x` and `\0` sequences may produce non-UTF-8 output.

import { type ByteStream, concat, encode } from "../exec/bytes.js";
import { type Command, fail, result } from "../exec/context.js";

const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["e", 0x1b],
  ["E", 0x1b],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
  ["\\", 0x5c],
]);

class UnsupportedEscape extends Error {}

export const echo: Command = (context) => {
  let newline = true;
  let escapes = false;
  let first = 0;
  for (; first < context.argv.length; first++) {
    const word = context.argv[first] ?? "";
    if (!/^-[neE]+$/.test(word)) break;
    for (const flag of word.slice(1)) {
      if (flag === "n") newline = false;
      else escapes = flag === "e";
    }
  }

  const text = context.argv.slice(first).join(" ");
  if (!escapes) return result(one(encode(newline ? `${text}\n` : text)));

  try {
    const expanded = interpretEscapes(text);
    const bytes =
      newline && !expanded.stopped ? concat([expanded.bytes, encode("\n")]) : expanded.bytes;
    return result(one(bytes));
  } catch (error) {
    if (error instanceof UnsupportedEscape) return fail(context, error.message, 2);
    throw error;
  }
};

function interpretEscapes(text: string): { bytes: Uint8Array; stopped: boolean } {
  const chunks: Uint8Array[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal === "") return;
    chunks.push(encode(literal));
    literal = "";
  };
  const byte = (value: number): void => {
    flush();
    chunks.push(Uint8Array.of(value));
  };

  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (char !== "\\" || next === "") {
      literal += char;
      index++;
      continue;
    }

    const simple = SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) {
      byte(simple);
      index += 2;
      continue;
    }
    if (next === "c") {
      flush();
      return { bytes: concat(chunks), stopped: true };
    }
    if (next === "0") {
      const digits = /^[0-7]{0,3}/.exec(text.slice(index + 2))?.[0] ?? "";
      byte(Number.parseInt(digits === "" ? "0" : digits, 8) & 0xff);
      index += 2 + digits.length;
      continue;
    }
    if (next === "x") {
      const digits = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(index + 2))?.[0];
      if (digits === undefined) {
        literal += "\\x";
      } else {
        byte(Number.parseInt(digits, 16));
      }
      index += 2 + (digits?.length ?? 0);
      continue;
    }
    if (next === "u" || next === "U") {
      throw new UnsupportedEscape(`the \\${next} escape is not supported`);
    }
    literal += `\\${next}`;
    index += 2;
  }
  flush();
  return { bytes: concat(chunks), stopped: false };
}

function* one(bytes: Uint8Array): ByteStream {
  if (bytes.length > 0) yield bytes;
}
