// Searching a pipe stage's input rather than the filesystem — R5 in
// docs/plans/shell.md. `ls | grep foo` and `grep a | grep b` are 12 corpus
// lines between them, and neither should issue a second query.
//
// Pull-based like everything else: the generator only consumes as much of
// its input as its consumer asks for, so `… | grep x | head -5` still stops
// the source behind it.

import { type ByteStream, decode, encode, lines, NEWLINE } from "../exec/bytes.js";
import type { CommandResult } from "../exec/context.js";
import type { SearchMode } from "./search.js";

export interface StreamSearch {
  readonly pattern: RegExp;
  readonly invert: boolean;
  readonly mode: SearchMode;
  readonly lineNumbers: boolean;
  readonly before: number;
  readonly after: number;
  readonly withFilename: boolean;
  /** The label to print when `withFilename`. `(standard input)` in grep. */
  readonly name: string | null;
}

export function searchStream(stdin: ByteStream, options: StreamSearch): CommandResult {
  let matched = false;

  const stream = (function* (): ByteStream {
    const label = options.name ?? "(standard input)";
    const history: Uint8Array[] = [];
    const context = options.before > 0 || options.after > 0;
    let number = 0;
    let hits = 0;
    let pendingAfter = 0;
    /** The last line number put out, so a gap can be marked. 0 = none yet. */
    let emitted = 0;

    function* put(at: number, text: Uint8Array, isMatch: boolean): ByteStream {
      // A gap between context groups is marked, as both greps do.
      if (context && emitted > 0 && at > emitted + 1) yield encode("--\n");
      emitted = at;
      yield render(label, at, text, isMatch, options);
    }

    for (const text of lines(stdin)) {
      number++;
      options.pattern.lastIndex = 0;
      const hit = options.pattern.test(decode(text)) !== options.invert;

      if (hit) {
        matched = true;
        hits++;
        if (options.mode === "content") {
          // `-B n`: the lines held back, oldest first.
          for (let index = 0; index < history.length; index++) {
            const held = history[index];
            if (held === undefined) continue;
            yield* put(number - history.length + index, held, false);
          }
          history.length = 0;
          yield* put(number, text, true);
          pendingAfter = options.after;
        }
        continue;
      }

      if (options.mode !== "content") continue;

      if (pendingAfter > 0) {
        pendingAfter--;
        yield* put(number, text, false);
        continue;
      }

      if (options.before > 0) {
        history.push(text);
        if (history.length > options.before) history.shift();
      }
    }

    if (options.mode === "count") yield encode(`${hits}\n`);
    // `-l` over a pipe names the stream once, as grep does; `-L` names it
    // exactly when nothing matched.
    if (options.mode === "files" && matched) yield encode(`${label}\n`);
    if (options.mode === "files-without-match" && !matched) yield encode(`${label}\n`);
  })();

  return { stdout: stream, status: () => (matched ? 0 : 1) };
}

function render(
  label: string,
  number: number,
  text: Uint8Array,
  isMatch: boolean,
  options: StreamSearch,
): Uint8Array {
  const separator = isMatch ? ":" : "-";
  let prefix = "";
  if (options.withFilename) prefix += `${label}${separator}`;
  if (options.lineNumbers) prefix += `${number}${separator}`;
  const head = encode(prefix);
  const out = new Uint8Array(head.length + text.length + 1);
  out.set(head, 0);
  out.set(text, head.length);
  out[head.length + text.length] = NEWLINE;
  return out;
}
