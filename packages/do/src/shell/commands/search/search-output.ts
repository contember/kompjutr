// Output shared by the filesystem search and the pipe search: one line with
// its `path:number:` prefix, the `-o` form that prints each match alone, and
// the `-q` form that prints nothing and stops at the first match.
//
// GNU grep and rg disagree about `-o` around the match: rg keeps context
// lines and prints whole selected lines under `-v`; GNU prints neither.

import { type ByteStream, decode, encode, NEWLINE } from "../../exec/bytes.js";
import { type CommandResult, type RetainedBudget, result } from "../../exec/context.js";

export interface LineLabel {
  readonly name: string;
  readonly number: number;
  readonly withFilename: boolean;
  readonly lineNumbers: boolean;
}

/** Context lines use `-` where matches use `:`, as both greps do. */
export function renderLine(label: LineLabel, text: Uint8Array, isMatch: boolean): Uint8Array {
  const head = encode(prefix(label, isMatch ? ":" : "-"));
  const out = new Uint8Array(head.length + text.length + 1);
  out.set(head, 0);
  out.set(text, head.length);
  out[head.length + text.length] = NEWLINE;
  return out;
}

export interface OnlyMatching {
  /** A global copy of the search pattern; its `lastIndex` is owned here. */
  readonly pattern: RegExp;
  readonly keepsContext: boolean;
  readonly invertedPrintsLines: boolean;
}

export function onlyMatchingFor(pattern: RegExp, surface: "grep" | "rg"): OnlyMatching {
  const flags = pattern.global ? pattern.flags : `${pattern.flags}g`;
  return {
    pattern: new RegExp(pattern.source, flags),
    keepsContext: surface === "rg",
    invertedPrintsLines: surface === "rg",
  };
}

/** One selected or context line, in the form `-o` asks for when it is set. */
export function* renderSelected(
  label: LineLabel,
  text: Uint8Array,
  isMatch: boolean,
  invert: boolean,
  only: OnlyMatching | null,
  retained: RetainedBudget,
): Generator<Uint8Array, void, undefined> {
  if (only === null) {
    yield renderLine(label, text, isMatch);
  } else if (!isMatch) {
    if (only.keepsContext) yield renderLine(label, text, false);
  } else if (invert) {
    if (only.invertedPrintsLines) yield renderLine(label, text, true);
  } else {
    yield* renderMatches(label, text, only.pattern, retained);
  }
}

/** `-o`: every non-empty match of `pattern` in `text`, one per line. */
function* renderMatches(
  label: LineLabel,
  text: Uint8Array,
  pattern: RegExp,
  retained: RetainedBudget,
): Generator<Uint8Array, void, undefined> {
  const release = retained.retain(text.length * 2, "search decoded line");
  try {
    const head = prefix(label, ":");
    pattern.lastIndex = 0;
    for (const match of decode(text).matchAll(pattern)) {
      if (match[0] !== "") yield encode(`${head}${match[0]}\n`);
    }
  } finally {
    release();
  }
}

/**
 * `-q`: stop pulling at the first output, print nothing, and succeed when a
 * line was selected even if an earlier path failed. The search runs in
 * `-l` mode so a literal pattern is still answered by the database.
 */
export async function quietly(
  stdout: ByteStream,
  status: () => number,
  matched: () => boolean,
): Promise<CommandResult> {
  for await (const _first of stdout) break;
  return result(nothing(), matched() ? 0 : status());
}

function* nothing(): ByteStream {
  // `-q` writes nothing.
}

function prefix(label: LineLabel, separator: string): string {
  let head = "";
  if (label.withFilename) head += `${label.name}${separator}`;
  if (label.lineNumbers) head += `${label.number}${separator}`;
  return head;
}
