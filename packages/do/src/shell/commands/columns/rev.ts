// `rev` as util-linux 2.41 runs under `LC_ALL=C`: each line reversed byte for
// byte, its terminator kept in place. The C locale has no multibyte
// characters, so util-linux's wide-character reader fails on the first byte
// above 0x7f; that line is lost and the run stops, as it does there.

import type { ByteStream } from "../../exec/bytes.js";
import type { Command } from "../../exec/context.js";
import { OutputBuffer, open, records } from "./records.js";
import { failWith, refuse } from "./refusal.js";

const TRY_HELP = "Try 'rev --help' for more information.\n";
const LONG_OPTIONS = ["help", "version", "zero"] as const;

export const rev: Command = (context) => {
  let zero = false;
  const operands: string[] = [];
  let escaped = false;
  for (const arg of context.argv) {
    if (escaped || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      escaped = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = arg.slice(2, equals === -1 ? undefined : equals);
      const prefixed = LONG_OPTIONS.filter((candidate) => candidate.startsWith(name));
      const option = prefixed.length === 1 ? prefixed[0] : undefined;
      if (option === undefined) {
        return failWith(context, `rev: unrecognized option '${arg}'\n${TRY_HELP}`);
      }
      if (equals !== -1) {
        return failWith(
          context,
          `rev: option '--${option}' doesn't allow an argument\n${TRY_HELP}`,
        );
      }
      if (option !== "zero") return refuse(context, `--${option}`);
      zero = true;
      continue;
    }
    for (const letter of arg.slice(1)) {
      if (letter === "0") {
        zero = true;
        continue;
      }
      if (letter === "h") return refuse(context, "-h");
      if (letter === "V") return refuse(context, "-V");
      return failWith(context, `rev: invalid option -- '${letter}'\n${TRY_HELP}`);
    }
  }

  const terminator = zero ? 0 : 0x0a;
  let status = 0;
  const stdout = (async function* (): ByteStream {
    const out = new OutputBuffer();
    const sources = operands.length === 0 ? [null] : operands;
    for (const operand of sources) {
      let stream: ByteStream;
      if (operand === null) {
        if (context.stdin === null) continue;
        stream = context.stdin;
      } else {
        const opened = open(context, operand, false);
        if (opened.kind === "missing") {
          context.warn(`cannot open ${operand}: No such file or directory`);
          status = 1;
          continue;
        }
        if (opened.kind === "directory") {
          context.warn("fgetwc() failed: Is a directory");
          status = 1;
          break;
        }
        stream = opened.stream;
      }
      for await (const record of records(stream, terminator, context.fs.retained)) {
        if (record.bytes.some((byte) => byte >= 0x80)) {
          context.warn("fgetwc() failed: Invalid or incomplete multibyte or wide character");
          status = 1;
          const rest = out.take();
          if (rest !== null) yield rest;
          return;
        }
        out.push(record.bytes.slice().reverse());
        if (record.terminated) out.byte(terminator);
        if (out.full) {
          const chunk = out.take();
          if (chunk !== null) yield chunk;
        }
      }
    }
    const rest = out.take();
    if (rest !== null) yield rest;
  })();
  return { stdout, status: () => status, truncated: () => false };
};
