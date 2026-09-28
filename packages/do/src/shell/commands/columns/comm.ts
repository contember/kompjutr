// `comm` as uutils 0.2.2 runs it. Lines compare as bytes with their terminator
// appended, as the reference compares them. Order checking is on unless both
// operands are the same bytes, and an unsorted input is reported once per
// file, either stopping the walk (`--check-order`) or at the end.

import { type ByteStream, encode } from "../../exec/bytes.js";
import type { Command, CommandContext } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import {
  type ClapCommand,
  ClapError,
  type ClapOption,
  type ClapParsed,
  conflict,
  has,
  parseClap,
  unexpectedOperand,
  withBuiltins,
} from "./clap.js";
import { lossy, OutputBuffer, open, type Record, records } from "./records.js";
import { failWith, refuseBuiltins } from "./refusal.js";

const CHECK_ORDER: ClapOption = { id: "check-order", long: "check-order", repeatable: true };
const NO_CHECK_ORDER: ClapOption = { id: "nocheck-order", long: "nocheck-order", repeatable: true };

const COMM: ClapCommand = {
  name: "comm",
  usage: "comm [OPTION]... FILE1 FILE2",
  options: withBuiltins([
    { id: "1", short: "1", repeatable: true },
    { id: "2", short: "2", repeatable: true },
    { id: "3", short: "3", repeatable: true },
    {
      id: "output-delimiter",
      long: "output-delimiter",
      value: "STR",
      hyphenValues: true,
      repeatable: true,
    },
    { id: "zero-terminated", short: "z", long: "zero-terminated", repeatable: true },
    { id: "total", long: "total", repeatable: true },
    CHECK_ORDER,
    NO_CHECK_ORDER,
  ]),
};

export const comm: Command = async (context) => {
  let parsed: ClapParsed;
  try {
    parsed = parseClap(COMM, context.argv);
    const extra = parsed.operands[2];
    if (extra !== undefined) throw unexpectedOperand(COMM, extra);
  } catch (error) {
    if (error instanceof ClapError) return failWith(context, error.rendered);
    throw error;
  }
  const refused = refuseBuiltins(context, parsed);
  if (refused !== null) return refused;
  const checkIndex = parsed.matches.findIndex((match) => match.id === "check-order");
  const noCheckIndex = parsed.matches.findIndex((match) => match.id === "nocheck-order");
  if (checkIndex !== -1 && noCheckIndex !== -1) {
    const [first, second] =
      checkIndex < noCheckIndex ? [CHECK_ORDER, NO_CHECK_ORDER] : [NO_CHECK_ORDER, CHECK_ORDER];
    return failWith(context, conflict(first, second).rendered);
  }
  const [file1, file2] = parsed.operands;
  if (file1 === undefined || file2 === undefined) {
    const missing = file1 === undefined ? "  <FILE1>\n  <FILE2>\n" : "  <FILE2>\n";
    return failWith(
      context,
      `error: the following required arguments were not provided:\n${missing}\nUsage: ${COMM.usage}\n\nFor more information, try '--help'.\n`,
    );
  }

  const terminator = has(parsed, "zero-terminated") ? 0 : 0x0a;
  const shared = new SharedStdin(context, terminator);
  const reader1 = openReader(context, file1, terminator, shared);
  if (typeof reader1 === "string") return failWith(context, `comm: ${file1}: ${reader1}\n`);
  const reader2 = openReader(context, file2, terminator, shared);
  if (typeof reader2 === "string") {
    reader1.close();
    return failWith(context, `comm: ${file2}: ${reader2}\n`);
  }
  const delimiters = parsed.matches.flatMap((match) =>
    match.id === "output-delimiter" && match.value !== null ? [match.value] : [],
  );
  if (delimiters.some((delimiter) => delimiter !== delimiters[0])) {
    reader1.close();
    reader2.close();
    return failWith(context, "comm: multiple conflicting output delimiters specified\n");
  }
  const delimiter = delimiters[0] ?? "\t";
  const options: Options = {
    delimiter: delimiter === "" ? "\0" : delimiter,
    suppress: [has(parsed, "1"), has(parsed, "2"), has(parsed, "3")],
    total: has(parsed, "total"),
    terminator,
    checkOrder: has(parsed, "check-order"),
    shouldCheckOrder:
      !has(parsed, "nocheck-order") &&
      (has(parsed, "check-order") || !sameBytes(context, file1, file2)),
  };

  let status = 0;
  const stdout = walk(context, reader1, reader2, options, () => {
    status = 1;
  });
  return { stdout, status: () => status, truncated: () => false };
};

interface Options {
  readonly delimiter: string;
  readonly suppress: readonly [boolean, boolean, boolean];
  readonly total: boolean;
  readonly terminator: number;
  readonly checkOrder: boolean;
  readonly shouldCheckOrder: boolean;
}

async function* walk(
  context: CommandContext,
  reader1: LineReader,
  reader2: LineReader,
  options: Options,
  failed: () => void,
): ByteStream {
  const out = new OutputBuffer();
  const column2 = encode(options.delimiter.repeat(options.suppress[0] ? 0 : 1));
  const column3 = encode(
    options.delimiter.repeat((options.suppress[0] ? 0 : 1) + (options.suppress[1] ? 0 : 1)),
  );
  const checker1 = new OrderChecker(context, "1", options.checkOrder);
  const checker2 = new OrderChecker(context, "2", options.checkOrder);
  const totals = [0, 0, 0];
  let inputError = false;
  try {
    let line1 = await reader1.next();
    let line2 = await reader2.next();
    for (;;) {
      if (line1 === null && line2 === null) break;
      const order = line1 === null ? 1 : line2 === null ? -1 : compareBytes(line1, line2);
      if (order < 0 && line1 !== null) {
        if (options.shouldCheckOrder && !checker1.verify(line1)) break;
        if (!options.suppress[0]) out.push(lossy(line1));
        line1 = await reader1.next();
        totals[0] = (totals[0] ?? 0) + 1;
      } else if (order > 0 && line2 !== null) {
        if (options.shouldCheckOrder && !checker2.verify(line2)) break;
        if (!options.suppress[1]) {
          out.push(column2);
          out.push(lossy(line2));
        }
        line2 = await reader2.next();
        totals[1] = (totals[1] ?? 0) + 1;
      } else if (line1 !== null && line2 !== null) {
        if (options.shouldCheckOrder && (!checker1.verify(line1) || !checker2.verify(line2))) break;
        if (!options.suppress[2]) {
          out.push(column3);
          out.push(lossy(line1));
        }
        line1 = await reader1.next();
        line2 = await reader2.next();
        totals[2] = (totals[2] ?? 0) + 1;
      }
      if ((checker1.hasError || checker2.hasError) && !options.checkOrder) inputError = true;
      if (out.full) {
        const chunk = out.take();
        if (chunk !== null) yield chunk;
      }
    }
    if (options.total) {
      const d = options.delimiter;
      out.text(`${totals[0]}${d}${totals[1]}${d}${totals[2]}${d}total`);
      out.byte(options.terminator);
    }
    const rest = out.take();
    if (rest !== null) yield rest;
    if (options.shouldCheckOrder && (checker1.hasError || checker2.hasError)) {
      if (inputError) context.warn("input is not in sorted order");
      failed();
    }
  } finally {
    reader1.close();
    reader2.close();
    checker1.close();
    checker2.close();
  }
}

class OrderChecker {
  #last: Uint8Array | null = null;
  #release: () => void = () => {};
  hasError = false;

  constructor(
    private readonly context: CommandContext,
    private readonly file: "1" | "2",
    private readonly checkOrder: boolean,
  ) {}

  verify(line: Uint8Array): boolean {
    const ordered = this.#last === null || compareBytes(line, this.#last) >= 0;
    if (!ordered && !this.hasError) {
      this.context.warn(`file ${this.file} is not in sorted order`);
      this.hasError = true;
    }
    const release = this.context.fs.retained.retain(line.length, "comm order line");
    this.#release();
    this.#last = line;
    this.#release = release;
    return ordered || !this.checkOrder;
  }

  close(): void {
    this.#release();
  }
}

/** One line at a time, terminator appended, held against the budget. */
class LineReader {
  #release: () => void = () => {};

  constructor(
    private readonly context: CommandContext,
    private readonly source: AsyncIterator<Record>,
    private readonly terminator: number,
  ) {}

  async next(): Promise<Uint8Array | null> {
    const step = await this.source.next();
    this.#release();
    this.#release = () => {};
    if (step.done === true) return null;
    const bytes = step.value.bytes;
    this.#release = this.context.fs.retained.retain(bytes.length + 1, "comm line");
    const line = new Uint8Array(bytes.length + 1);
    line.set(bytes);
    line[bytes.length] = this.terminator;
    return line;
  }

  close(): void {
    this.#release();
    this.#release = () => {};
    void this.source.return?.();
  }
}

/** `comm - -` reads alternate lines from one stdin, as the reference's shared buffer does. */
class SharedStdin {
  #records: AsyncGenerator<Record, void, undefined> | null = null;

  constructor(
    private readonly context: CommandContext,
    private readonly terminator: number,
  ) {}

  get iterator(): AsyncIterator<Record> {
    this.#records ??= records(
      this.context.stdin ?? (function* (): ByteStream {})(),
      this.terminator,
      this.context.fs.retained,
    );
    const shared = this.#records;
    return { next: () => shared.next(), return: () => shared.return() };
  }
}

function openReader(
  context: CommandContext,
  operand: string,
  terminator: number,
  shared: SharedStdin,
): LineReader | string {
  if (operand === "-") return new LineReader(context, shared.iterator, terminator);
  const opened = open(context, operand, false);
  if (opened.kind === "missing") return "No such file or directory";
  if (opened.kind === "directory") return "Is a directory";
  return new LineReader(
    context,
    records(opened.stream, terminator, context.fs.retained)[Symbol.asyncIterator](),
    terminator,
  );
}

/** Two regular files with equal bytes skip the order check, as the reference does. */
function sameBytes(context: CommandContext, operand1: string, operand2: string): boolean {
  if (operand1 === "-" || operand2 === "-") return false;
  const path1 = resolve(context.cwd, operand1);
  const path2 = resolve(context.cwd, operand2);
  const stat1 = context.fs.statTarget(path1);
  const stat2 = context.fs.statTarget(path2);
  if (stat1 === null || stat2 === null || stat1.size !== stat2.size) return false;
  const id1 = stat1.contentId;
  const id2 = stat2.contentId;
  if (
    id1 !== null &&
    id2 !== null &&
    id1.length === id2.length &&
    id1.every((b, i) => b === id2[i])
  ) {
    return true;
  }
  const step = Math.max(1, Math.floor(context.fs.readBudget / 2));
  for (let offset = 0; offset < stat1.size; offset += step) {
    const length = Math.min(step, stat1.size - offset);
    const release = context.fs.retained.retain(length * 2, "comm identity probe");
    try {
      const left = context.fs.readRange(path1, offset, length);
      const right = context.fs.readRange(path2, offset, length);
      if (compareBytes(left, right) !== 0) return false;
    } finally {
      release();
    }
  }
  return true;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
