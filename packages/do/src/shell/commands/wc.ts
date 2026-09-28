// `wc` in GNU's layout: one row per input, named after the operand, then a
// `total` row when there are several operands. Columns share one width: the
// digits of the operands' combined size, at least 7 when an input is not a
// regular file, and 1 when a single input prints a single count.

import { type ByteStream, encode, NEWLINE, one } from "../exec/bytes.js";
import type { Command } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { parseFlags } from "./flags.js";
import { streamFile } from "./read.js";

interface Counts {
  lines: number;
  words: number;
  characters: number;
  bytes: number;
}

type Column = keyof Counts;

export const wc: Command = async (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-l", "-c", "-w", "-m", "--lines", "--bytes", "--words", "--chars"]),
    valued: new Set(),
  });
  const columns = selectedColumns(new Set(parsed.flags.map((flag) => flag.name)));
  const operands = parsed.operands.length === 0 ? ["-"] : parsed.operands;

  let status = 0;
  let size = 0;
  let irregular = false;
  // A missing operand prints no row; a directory prints zeros. Both fail.
  const inputs: Array<{
    name: string | null;
    source: ByteStream | null;
    problem: "No such file or directory" | "Is a directory" | null;
  }> = [];
  for (const operand of operands) {
    if (operand === "-") {
      irregular = true;
      const name = parsed.operands.length === 0 ? null : "-";
      inputs.push({ name, source: context.stdin, problem: null });
      continue;
    }
    const path = resolve(context.cwd, operand);
    const stat = context.fs.stat(path);
    if (stat === null) {
      inputs.push({ name: operand, source: null, problem: "No such file or directory" });
      continue;
    }
    if (stat.type !== "file") {
      irregular = true;
      inputs.push({ name: operand, source: null, problem: "Is a directory" });
      continue;
    }
    size += stat.size;
    const source = streamFile(context, path, stat.size, "wc input");
    inputs.push({ name: operand, source, problem: null });
  }

  const width =
    inputs.length === 1 && columns.length === 1
      ? 1
      : Math.max(String(size).length, irregular ? 7 : 1);
  const total: Counts = { lines: 0, words: 0, characters: 0, bytes: 0 };
  const rows: string[] = [];
  for (const input of inputs) {
    if (input.problem !== null) {
      context.warn(`${input.name ?? "-"}: ${input.problem}`);
      status = 1;
      if (input.problem === "No such file or directory") continue;
    }
    const counts = await count(input.source);
    for (const column of columns) total[column] += counts[column];
    rows.push(row(counts, columns, width, input.name));
  }
  if (operands.length > 1) rows.push(row(total, columns, width, "total"));

  const output = rows.join("");
  return { stdout: one(encode(output)), status: () => status, truncated: () => false };
};

/** GNU's column order, whatever order the flags came in. */
function selectedColumns(flags: ReadonlySet<string>): Column[] {
  if (flags.size === 0) return ["lines", "words", "bytes"];
  const columns: Column[] = [];
  if (flags.has("-l") || flags.has("--lines")) columns.push("lines");
  if (flags.has("-w") || flags.has("--words")) columns.push("words");
  if (flags.has("-m") || flags.has("--chars")) columns.push("characters");
  if (flags.has("-c") || flags.has("--bytes")) columns.push("bytes");
  return columns;
}

function row(
  counts: Counts,
  columns: readonly Column[],
  width: number,
  name: string | null,
): string {
  const cells = columns.map((column) => String(counts[column]).padStart(width));
  return `${cells.join(" ")}${name === null ? "" : ` ${name}`}\n`;
}

async function count(source: ByteStream | null): Promise<Counts> {
  const counts: Counts = { lines: 0, words: 0, characters: 0, bytes: 0 };
  if (source === null) return counts;
  let inWord = false;
  const decoder = new TextDecoder();
  for await (const chunk of source) {
    counts.bytes += chunk.length;
    for (const _character of decoder.decode(chunk, { stream: true })) counts.characters++;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (byte === NEWLINE) counts.lines++;
      // A word is a run of anything that is not whitespace, counted as the
      // run starts so the stream is never buffered.
      const blank = byte === 0x20 || byte === 0x09 || byte === NEWLINE || byte === 0x0d;
      if (blank) inWord = false;
      else if (!inWord) {
        inWord = true;
        counts.words++;
      }
    }
  }
  for (const _character of decoder.decode()) counts.characters++;
  return counts;
}
