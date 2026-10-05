import { decode, lines } from "../../exec/bytes.js";
import type { RetainedBudget } from "../../exec/context.js";
import type { RecordPattern } from "./regex.js";
import type { SearchRequest } from "./search.js";
import { type JsonText, jsonText, type SearchText } from "./search-text.js";

export interface Submatch {
  readonly match: JsonText;
  readonly start: number;
  readonly end: number;
}

export interface MatchGroup {
  readonly start: number;
  end: number;
  readonly line: number;
  readonly submatches: Submatch[];
}

export function* matchGroups(
  input: SearchText,
  bytes: Uint8Array,
  compiled: RecordPattern,
  retained: RetainedBudget,
): Generator<MatchGroup> {
  if (compiled.multiline) {
    yield* multilineGroups(input, bytes, compiled.pattern, retained);
    return;
  }
  const text = input.text;
  let start = 0;
  let line = 1;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const group: MatchGroup = {
      start: input.byteOffset(start),
      end: input.byteOffset(newline < 0 ? end : end + 1),
      line,
      submatches: [],
    };
    const releases: Array<() => void> = [];
    try {
      for (const match of text.slice(start, end).matchAll(compiled.pattern)) {
        addSubmatch(
          group,
          bytes,
          input.byteOffset(start + match.index),
          input.byteOffset(start + match.index + match[0].length),
          retained,
          releases,
        );
      }
      if (group.submatches.length > 0) yield group;
    } finally {
      for (const release of releases) release();
    }
    start = end + 1;
    line++;
  }
}

function* multilineGroups(
  input: SearchText,
  bytes: Uint8Array,
  pattern: RegExp,
  retained: RetainedBudget,
): Generator<MatchGroup> {
  const text = input.text;
  let group: MatchGroup | undefined;
  let line = 1;
  let position = 0;
  const releases: Array<() => void> = [];
  try {
    for (const match of text.matchAll(pattern)) {
      const start = match.index === 0 ? 0 : text.lastIndexOf("\n", match.index - 1) + 1;
      if (start === text.length) continue;
      const matchEnd = match.index + match[0].length;
      const newline = text.indexOf("\n", Math.max(match.index, matchEnd - 1));
      const end = input.byteOffset(newline < 0 ? text.length : newline + 1);
      const byteStart = input.byteOffset(start);
      if (group !== undefined && byteStart > group.end) {
        yield group;
        for (const release of releases) release();
        releases.length = 0;
        group = undefined;
      }
      if (group === undefined) {
        for (let index = position; index < start; index++) if (text[index] === "\n") line++;
        position = start;
        group = { start: byteStart, end, line, submatches: [] };
      }
      group.end = Math.max(group.end, end);
      addSubmatch(
        group,
        bytes,
        input.byteOffset(match.index),
        input.byteOffset(matchEnd),
        retained,
        releases,
      );
    }
    if (group !== undefined) yield group;
  } finally {
    for (const release of releases) release();
  }
}

function addSubmatch(
  group: MatchGroup,
  bytes: Uint8Array,
  start: number,
  end: number,
  retained: RetainedBudget,
  releases: Array<() => void>,
): void {
  releases.push(retained.retain((end - start) * 2 + 128, "search submatch"));
  group.submatches.push({
    match: jsonText(bytes.subarray(start, end)),
    start: start - group.start,
    end: end - group.start,
  });
}

export async function matchesAnywhere(
  bytes: Uint8Array,
  request: SearchRequest,
  retained: RetainedBudget,
): Promise<boolean> {
  const chunks = (function* () {
    yield bytes;
  })();
  for await (const text of lines(chunks)) {
    if (testLine(text, request, retained)) return true;
  }
  return false;
}

export function testLine(
  text: Uint8Array,
  request: SearchRequest,
  retained: RetainedBudget,
): boolean {
  const release = retained.retain(text.length * 2, "search decoded line");
  try {
    request.pattern.lastIndex = 0;
    const hit = request.pattern.test(decode(text));
    return request.invert ? !hit : hit;
  } finally {
    release();
  }
}
