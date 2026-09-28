// `tr` as uutils 0.2.2 runs it: stdin only, byte-oriented, translate, delete,
// squeeze, and the delete-then-squeeze / translate-then-squeeze chains. It
// holds no input: each chunk maps through a 256-entry table, and squeezing
// carries one byte of state across chunks.

import { type ByteStream, encode } from "../../exec/bytes.js";
import type { Command, CommandResult } from "../../exec/context.js";
import {
  type ClapCommand,
  ClapError,
  type ClapParsed,
  has,
  parseClap,
  withBuiltins,
} from "./clap.js";
import { quote } from "./records.js";
import { failWith, refuseBuiltins } from "./refusal.js";
import { solveSets, TrSetError } from "./tr-sets.js";

const TR: ClapCommand = {
  name: "tr",
  usage: "tr [OPTION]... SET1 [SET2]",
  trailingOperands: true,
  options: withBuiltins([
    { id: "complement", short: "c", long: "complement", repeatable: true },
    { id: "complement", short: "C", repeatable: true },
    { id: "delete", short: "d", long: "delete", repeatable: true },
    { id: "squeeze", short: "s", long: "squeeze-repeats", repeatable: true },
    { id: "truncate", short: "t", long: "truncate-set1", repeatable: true },
  ]),
};

const TRY_HELP = "Try 'tr --help' for more information.\n";

type Step = (byte: number) => number | null;

export const tr: Command = (context) => {
  let parsed: ClapParsed;
  try {
    parsed = parseClap(TR, context.argv);
  } catch (error) {
    if (error instanceof ClapError) return failWith(context, error.rendered);
    throw error;
  }
  const refused = refuseBuiltins(context, parsed);
  if (refused !== null) return refused;

  const deleting = has(parsed, "delete");
  const squeezing = has(parsed, "squeeze");
  const sets = parsed.operands;
  const usage = (message: string): CommandResult =>
    failWith(context, `tr: ${message}\n${TRY_HELP}`);
  const [first, second, third] = sets;
  if (first === undefined) return usage("missing operand");
  if (!(deleting || squeezing) && second === undefined) {
    return usage(
      `missing operand after ${quote(first)}\nTwo strings must be given when translating.`,
    );
  }
  if (deleting && squeezing && second === undefined) {
    return usage(
      `missing operand after ${quote(first)}\nTwo strings must be given when deleting and squeezing.`,
    );
  }
  if (second !== undefined && deleting && !squeezing) {
    return third === undefined
      ? usage(
          `extra operand ${quote(second)}\nOnly one string may be given when deleting without squeezing repeats.`,
        )
      : usage(`extra operand ${quote(second)}`);
  }
  if (third !== undefined) return usage(`extra operand ${quote(third)}`);

  const trailingBackslashes = /\\*$/.exec(first)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) {
    context.warn("warning: an unescaped backslash at end of string is not portable");
  }

  const translating = !deleting && second !== undefined;
  let step: Step;
  try {
    const { set1, set2 } = solveSets(
      encode(first),
      encode(second ?? ""),
      {
        complement: has(parsed, "complement"),
        truncate: has(parsed, "truncate") && translating,
        translating,
      },
      (message) => context.warn(`warning: ${message}`),
    );
    if (deleting) {
      const remove = deleteStep(set1);
      step = squeezing ? chain(remove, squeezeStep(set2)) : remove;
    } else if (squeezing && second === undefined) {
      step = squeezeStep(set1);
    } else if (squeezing) {
      step = chain(translateStep(set1, set2), squeezeStep(set2));
    } else {
      step = translateStep(set1, set2);
    }
  } catch (error) {
    if (error instanceof TrSetError) return failWith(context, `tr: ${error.message}\n`);
    throw error;
  }

  const input = context.stdin;
  const stdout = (async function* (): ByteStream {
    if (input === null) return;
    for await (const chunk of input) {
      const out = new Uint8Array(chunk.length);
      let length = 0;
      for (const byte of chunk) {
        const mapped = step(byte);
        if (mapped !== null) out[length++] = mapped;
      }
      if (length > 0) yield out.subarray(0, length);
    }
  })();
  return { stdout, status: () => 0, truncated: () => false };
};

function membership(set: readonly number[]): boolean[] {
  const table = new Array<boolean>(256).fill(false);
  for (const byte of set) table[byte] = true;
  return table;
}

function deleteStep(set: readonly number[]): Step {
  const table = membership(set);
  return (byte) => (table[byte] === true ? null : byte);
}

function squeezeStep(set: readonly number[]): Step {
  const table = membership(set);
  let previous: number | null = null;
  return (byte) => {
    const repeated = table[byte] === true && previous === byte;
    previous = byte;
    return repeated ? null : byte;
  };
}

function translateStep(set1: readonly number[], set2: readonly number[]): Step {
  const table = Array.from({ length: 256 }, (_, byte) => byte);
  const fallback = set2[set2.length - 1];
  if (fallback === undefined) {
    if (set1.length > 0)
      throw new TrSetError("when not truncating set1, string2 must be non-empty");
    return (byte) => byte;
  }
  set1.forEach((from, index) => {
    table[from] = set2[index] ?? fallback;
  });
  return (byte) => table[byte] ?? byte;
}

function chain(first: Step, second: Step): Step {
  return (byte) => {
    const mapped = first(byte);
    return mapped === null ? null : second(mapped);
  };
}
