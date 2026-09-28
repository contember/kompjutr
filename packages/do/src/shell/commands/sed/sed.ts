// `sed` over stdin or files as one stream, or with `-i` over each file in
// place. Lines are decoded one at a time; `$` needs one line of lookahead.
// `-i` holds a file's output against the retained budget and publishes it
// once, so a failed script leaves the file unchanged.

import { type ByteStream, concat, decode, empty, encode, NEWLINE } from "../../exec/bytes.js";
import { type Command, type RetainedBudget, result } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { parseFlags, UsageError } from "../flags.js";
import { streamFile } from "../read.js";
import { type Address, parseScripts, type SedCommand, SedScriptError } from "./script.js";

interface Record {
  readonly text: string;
  readonly terminated: boolean;
  readonly last: boolean;
}

export const sed: Command = async (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-i"]),
    valued: new Set(["-e", "--expression"]),
  });
  const names = new Set(parsed.flags.map((flag) => flag.name));
  const quiet = names.has("-n") || names.has("--quiet") || names.has("--silent");
  const extended = names.has("-E") || names.has("-r") || names.has("--regexp-extended");
  const inPlace = names.has("-i");
  const scripts = parsed.flags.flatMap((flag) => (flag.value === null ? [] : [flag.value]));
  const operands = [...parsed.operands];
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) throw new UsageError("no script specified");
    scripts.push(script);
  }

  let commands: SedCommand[];
  try {
    commands = parseScripts(scripts, extended);
  } catch (error) {
    if (!(error instanceof SedScriptError)) throw error;
    context.warn(error.message);
    return { stdout: empty(), status: () => 1, truncated: () => false };
  }

  let status = 0;
  const readable = (operand: string): ByteStream | null => {
    const path = resolve(context.cwd, operand);
    const stat = context.fs.stat(path);
    if (stat?.type === "file") return streamFile(context, path, stat.size, "sed input");
    context.warn(
      `can't read ${operand}: ${stat === null ? "No such file or directory" : "Is a directory"}`,
    );
    status = 2;
    return null;
  };

  if (inPlace) {
    if (operands.length === 0) throw new UsageError("no input files");
    for (const operand of operands) {
      const source = readable(operand);
      if (source === null) continue;
      const run = new Run(commands, quiet, context.fs.retained);
      const held: Uint8Array[] = [];
      const releases: Array<() => void> = [];
      try {
        for await (const chunk of run.execute(records(source, context.fs.retained))) {
          releases.push(context.fs.retained.retain(chunk.length, "sed -i output"));
          held.push(chunk);
        }
        context.fs.writeFileStream(resolve(context.cwd, operand), held);
      } finally {
        for (const release of releases) release();
      }
      if (run.quitStatus !== null) return result(empty(), run.quitStatus);
    }
    return result(empty(), status);
  }

  const run = new Run(commands, quiet, context.fs.retained);
  const input =
    operands.length === 0
      ? context.stdin
      : (function* (): ByteStream {
          for (const operand of operands) {
            const source = readable(operand);
            if (source !== null) yield* source;
          }
        })();
  const stream = input === null ? empty() : run.execute(records(input, context.fs.retained));
  return {
    stdout: stream,
    status: () => run.quitStatus ?? status,
    truncated: () => false,
  };
};

interface Cycle {
  readonly number: number;
  readonly last: boolean;
  /** Whether the input line had a newline; the pattern space is written the same way. */
  readonly terminated: boolean;
  pattern: string;
  printed: boolean;
  readonly appended: string[];
}

type Outcome = "next" | "end" | "quit";

interface RangeState {
  active: boolean;
  /** A numeric end line, when the end address fixes one at the start. */
  endLine: number | null;
}

class Run {
  quitStatus: number | null = null;
  readonly #ranges = new Map<SedCommand, RangeState>();
  // A last line without a newline is written without one; any later output
  // supplies it first, as GNU sed does.
  #owed = false;

  constructor(
    private readonly commands: readonly SedCommand[],
    private readonly quiet: boolean,
    private readonly retained: RetainedBudget,
  ) {}

  async *execute(input: AsyncGenerator<Record, void, undefined>): ByteStream {
    let number = 0;
    for await (const record of input) {
      number++;
      const release = this.retained.retain(record.text.length * 2, "sed pattern space");
      try {
        const cycle: Cycle = {
          number,
          last: record.last,
          terminated: record.terminated,
          pattern: record.text,
          printed: !this.quiet,
          appended: [],
        };
        const outcome = yield* this.#apply(this.commands, cycle);
        if (cycle.printed) yield this.#write(cycle.pattern, cycle.terminated);
        for (const text of cycle.appended) yield this.#write(text, true);
        if (outcome === "quit") return;
      } finally {
        release();
      }
    }
  }

  *#apply(
    commands: readonly SedCommand[],
    cycle: Cycle,
  ): Generator<Uint8Array, Outcome, undefined> {
    for (const command of commands) {
      if (this.#selects(command, cycle) === command.negated) continue;
      const action = command.action;
      switch (action.kind) {
        case "s": {
          const replaced = substitute(cycle.pattern, action);
          if (replaced === null) break;
          cycle.pattern = replaced;
          if (action.print) yield this.#write(cycle.pattern, cycle.terminated);
          break;
        }
        case "p":
          yield this.#write(cycle.pattern, cycle.terminated);
          break;
        case "=":
          yield this.#write(String(cycle.number), true);
          break;
        case "i":
          yield this.#write(action.text, true);
          break;
        case "a":
          cycle.appended.push(action.text);
          break;
        case "c":
          // A range is replaced once, at its end.
          if (command.to === null || this.#ranges.get(command)?.active !== true) {
            yield this.#write(action.text, true);
          }
          cycle.printed = false;
          return "end";
        case "d":
          cycle.printed = false;
          return "end";
        case "q":
          this.quitStatus = action.status;
          return "quit";
        case "block": {
          const outcome = yield* this.#apply(action.commands, cycle);
          if (outcome !== "next") return outcome;
          break;
        }
      }
    }
    return "next";
  }

  #write(text: string, terminated: boolean): Uint8Array {
    const bytes = encode(`${this.#owed ? "\n" : ""}${text}${terminated ? "\n" : ""}`);
    this.#owed = !terminated;
    return bytes;
  }

  #selects(command: SedCommand, cycle: Cycle): boolean {
    const { from, to } = command;
    if (from === null) return true;
    if (to === null) return matches(from, cycle);
    let range = this.#ranges.get(command);
    if (range === undefined) {
      // `0,/re/` is open before the first line, so the end may match line 1.
      range = { active: from.kind === "line" && from.line === 0, endLine: null };
      this.#ranges.set(command, range);
    }
    if (range.active) {
      const closes = range.endLine !== null ? cycle.number >= range.endLine : matches(to, cycle);
      if (closes) range.active = false;
      return true;
    }
    if (!matches(from, cycle)) return false;
    if (to.kind === "line" || to.kind === "relative") {
      // A line end at or before the start closes the range at once.
      range.endLine = to.kind === "line" ? to.line : cycle.number + to.count;
      range.active = range.endLine > cycle.number;
    } else {
      range.endLine = null;
      range.active = !(to.kind === "last" && cycle.last);
    }
    return true;
  }
}

function matches(address: Address, cycle: Cycle): boolean {
  switch (address.kind) {
    case "line":
      return cycle.number === address.line;
    case "relative":
      return false;
    case "last":
      return cycle.last;
    case "regex":
      return address.pattern.test(cycle.pattern);
  }
}

/** The pattern space after `s`, or null when nothing matched the chosen occurrences. */
function substitute(
  pattern: string,
  action: Extract<SedCommand["action"], { readonly kind: "s" }>,
): string | null {
  const regex = new RegExp(action.pattern.source, `${action.pattern.flags}g`);
  let seen = 0;
  let replaced = false;
  const result = pattern.replace(regex, (...args: unknown[]) => {
    const match = typeof args[0] === "string" ? args[0] : "";
    seen++;
    if (seen < action.occurrence || (seen > action.occurrence && !action.global)) return match;
    replaced = true;
    const groups = args.slice(0, -2);
    let out = "";
    for (const part of action.replacement) {
      if (part.kind === "text") out += part.value;
      else {
        const group = groups[part.index];
        if (typeof group === "string") out += group;
      }
    }
    return out;
  });
  return replaced ? result : null;
}

/** Lines with their newline state and whether another line follows. */
async function* records(
  source: ByteStream,
  retained: RetainedBudget,
): AsyncGenerator<Record, void, undefined> {
  let pending: { text: string; terminated: boolean } | null = null;
  let partial: Uint8Array[] = [];
  let partialRelease: Array<() => void> = [];
  const take = (tail: Uint8Array, terminated: boolean): { text: string; terminated: boolean } => {
    const bytes = partial.length === 0 ? tail : concat([...partial, tail]);
    for (const release of partialRelease) release();
    partial = [];
    partialRelease = [];
    return { text: decode(bytes), terminated };
  };
  for await (const chunk of source) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== NEWLINE) continue;
      const line = take(chunk.subarray(start, index), true);
      if (pending !== null) yield { ...pending, last: false };
      pending = line;
      start = index + 1;
    }
    if (start < chunk.length) {
      partialRelease.push(retained.retain(chunk.length - start, "sed partial line"));
      partial.push(chunk.slice(start));
    }
  }
  if (partial.length > 0) {
    if (pending !== null) yield { ...pending, last: false };
    pending = take(new Uint8Array(0), false);
  }
  if (pending !== null) yield { ...pending, last: true };
}
