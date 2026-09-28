// Searching a pipe stage's input rather than the filesystem — R5 in
// docs/archive/plans/shell.md. `ls | grep foo` and `grep a | grep b` are 12 corpus
// lines between them, and neither should issue a second query.
//
// Pull-based like everything else: the generator only consumes as much of
// its input as its consumer asks for, so `… | grep x | head -5` still stops
// the source behind it.

import { type ByteStream, decode, encode, lines } from "../../exec/bytes.js";
import type { CommandResult, RetainedBudget } from "../../exec/context.js";
import type { SearchMode } from "./search.js";
import { type OnlyMatching, renderSelected } from "./search-output.js";

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
  /** `-o`: matches replace whole lines. */
  readonly onlyMatching: OnlyMatching | null;
}

export interface StreamSearchResult extends CommandResult {
  matched(): boolean;
}

export function searchStream(
  stdin: ByteStream,
  options: StreamSearch,
  retained: RetainedBudget,
): StreamSearchResult {
  let matched = false;

  const stream = (async function* (): ByteStream {
    const label = options.name ?? "(standard input)";
    const history: Array<{ bytes: Uint8Array; release(): void }> = [];
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
      const line = {
        name: label,
        number: at,
        withFilename: options.withFilename,
        lineNumbers: options.lineNumbers,
      };
      yield* renderSelected(line, text, isMatch, options.invert, options.onlyMatching, retained);
    }

    try {
      for await (const text of lines(stdin, retained)) {
        number++;
        const releaseDecoded = retained.retain(text.length * 2, "search decoded line");
        let hit: boolean;
        try {
          options.pattern.lastIndex = 0;
          hit = options.pattern.test(decode(text)) !== options.invert;
        } finally {
          releaseDecoded();
        }

        if (hit) {
          matched = true;
          hits++;
          // `-l` needs one selected line; the rest of the input is not read.
          if (options.mode === "files") break;
          if (options.mode === "content") {
            // `-B n`: the lines held back, oldest first.
            for (let index = 0; index < history.length; index++) {
              const held = history[index];
              if (held === undefined) continue;
              yield* put(number - history.length + index, held.bytes, false);
              held.release();
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
          const release = retained.retain(text.length, "search context lines");
          history.push({ bytes: text.slice(), release });
          if (history.length > options.before) history.shift()?.release();
        }
      }
    } finally {
      for (const held of history) held.release();
    }

    if (options.mode === "count") yield encode(`${hits}\n`);
    // `-l` over a pipe names the stream once, as grep does; `-L` names it
    // exactly when nothing matched.
    if (options.mode === "files" && matched) yield encode(`${label}\n`);
    if (options.mode === "files-without-match" && !matched) yield encode(`${label}\n`);
  })();

  return {
    stdout: stream,
    status: () => (matched ? 0 : 1),
    truncated: () => false,
    matched: () => matched,
  };
}
