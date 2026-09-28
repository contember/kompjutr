// `tee`: copies its input to stdout and to each file. Every file is created or
// truncated before input is read, as tee opens them first, and each publishes
// once when input ends. Bytes are held against the retained budget until
// then. A consumer that stops early does not shorten the files: the rest of
// the input is still read into them.

import { type ByteStream, isAsyncByteStream } from "../exec/bytes.js";
import type { Command } from "../exec/context.js";
import { strerror } from "../exec/errno.js";
import { resolve } from "../exec/execute.js";
import { isFilesystemError } from "../exec/redirections.js";
import { parseFlags } from "./flags.js";

export const tee: Command = (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-a", "--append"]),
    valued: new Set(),
  });
  const append = parsed.flags.length > 0;

  let status = 0;
  const write = (operand: string, chunks: readonly Uint8Array[], appending: boolean): boolean => {
    try {
      context.fs.writeFileStream(resolve(context.cwd, operand), chunks, { append: appending });
      return true;
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
      context.warn(`${operand}: ${strerror(error)}`);
      status = 1;
      return false;
    }
  };
  const targets = parsed.operands.filter((operand) => write(operand, [], append));

  const input = context.stdin;
  const stream = (async function* (): ByteStream {
    if (input === null) return;
    const source = isAsyncByteStream(input) ? input : toAsync(input);
    const held: Uint8Array[] = [];
    const releases: Array<() => void> = [];
    let finished = false;
    try {
      for (;;) {
        const next = await source.next();
        if (next.done === true) break;
        releases.push(context.fs.retained.retain(next.value.length, "tee file bytes"));
        held.push(next.value.slice());
        yield next.value;
      }
      finished = true;
    } finally {
      try {
        if (!finished) {
          for (let next = await source.next(); next.done !== true; next = await source.next()) {
            releases.push(context.fs.retained.retain(next.value.length, "tee file bytes"));
            held.push(next.value.slice());
          }
        }
        for (const operand of targets) write(operand, held, true);
      } finally {
        for (const release of releases) release();
      }
    }
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
};

async function* toAsync(stream: Iterator<Uint8Array, void, undefined>): ByteStream {
  for (let next = stream.next(); next.done !== true; next = stream.next()) yield next.value;
}
