// SQLite GLOB, evaluated in JS where a mounted view needs it.
//
// A view's caller writes a pattern over virtual paths, and the store matches
// patterns against whole real paths. Rewriting the virtual mount prefix into
// the real one can push a short pattern past the platform's 50-byte cap, so
// the prefix is consumed here instead: the pattern's state after reading the
// mount prefix is what must match the rest of the path. When that state is a
// single position the real pattern is exact; otherwise a leading `*` stands
// for the source and the range bound confines it, and the superset is
// filtered here against the virtual path.

import { GLOB_PATTERN_MAX_BYTES } from "../store/scan/scan-shared.js";
import type { Mount } from "./mounts.js";

type Token =
  | { readonly kind: "star"; readonly source: string }
  | { readonly kind: "one"; readonly source: string }
  | { readonly kind: "literal"; readonly source: string; readonly char: string }
  | {
      readonly kind: "set";
      readonly source: string;
      readonly negated: boolean;
      readonly ranges: readonly (readonly [number, number])[];
    }
  /** An unterminated `[`, which SQLite matches against nothing. */
  | { readonly kind: "never"; readonly source: string };

export interface CompiledGlob {
  readonly tokens: readonly Token[];
  test(path: string): boolean;
}

const ENCODER = new TextEncoder();

function codePoint(char: string): number {
  return char.codePointAt(0) ?? 0;
}

function parseSet(chars: readonly string[], start: number): { token: Token; end: number } | null {
  let index = start + 1;
  let negated = false;
  if (chars[index] === "^") {
    negated = true;
    index++;
  }
  const ranges: [number, number][] = [];
  let first = true;
  while (index < chars.length) {
    const char = chars[index];
    if (char === undefined) break;
    if (char === "]" && !first) {
      return {
        token: { kind: "set", source: chars.slice(start, index + 1).join(""), negated, ranges },
        end: index + 1,
      };
    }
    first = false;
    const next = chars[index + 1];
    const high = chars[index + 2];
    if (next === "-" && high !== undefined && high !== "]") {
      ranges.push([codePoint(char), codePoint(high)]);
      index += 3;
      continue;
    }
    ranges.push([codePoint(char), codePoint(char)]);
    index++;
  }
  return null;
}

function tokenize(pattern: string): Token[] {
  const chars = [...pattern];
  const tokens: Token[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === undefined) break;
    if (char === "*") {
      tokens.push({ kind: "star", source: "*" });
      index++;
    } else if (char === "?") {
      tokens.push({ kind: "one", source: "?" });
      index++;
    } else if (char === "[") {
      const set = parseSet(chars, index);
      if (set === null) {
        tokens.push({ kind: "never", source: chars.slice(index).join("") });
        break;
      }
      tokens.push(set.token);
      index = set.end;
    } else {
      tokens.push({ kind: "literal", source: char, char });
      index++;
    }
  }
  return tokens;
}

function accepts(token: Token, char: string): boolean {
  switch (token.kind) {
    case "star":
    case "one":
      return true;
    case "literal":
      return token.char === char;
    case "set": {
      const point = codePoint(char);
      const inside = token.ranges.some(([low, high]) => point >= low && point <= high);
      return inside !== token.negated;
    }
    case "never":
      return false;
  }
}

/** Add every position reachable without input: a `*` may match nothing. */
function closure(tokens: readonly Token[], states: Iterable<number>): Set<number> {
  const out = new Set<number>();
  for (let state of states) {
    out.add(state);
    while (tokens[state]?.kind === "star") {
      state++;
      out.add(state);
    }
  }
  return out;
}

function step(tokens: readonly Token[], states: ReadonlySet<number>, char: string): Set<number> {
  const next: number[] = [];
  for (const state of states) {
    const token = tokens[state];
    if (token === undefined || !accepts(token, char)) continue;
    next.push(token.kind === "star" ? state : state + 1);
  }
  return closure(tokens, next);
}

/** Positions the pattern can be at after reading `text` from its start. */
function statesAfter(tokens: readonly Token[], text: string): Set<number> {
  let states = closure(tokens, [0]);
  for (const char of text) {
    if (states.size === 0) break;
    states = step(tokens, states, char);
  }
  return states;
}

export function compileSqlGlob(pattern: string): CompiledGlob {
  const tokens = tokenize(pattern);
  return {
    tokens,
    test: (path) => statesAfter(tokens, path).has(tokens.length),
  };
}

function escapeLiteral(text: string): string {
  return text.replace(/[*?[]/g, (char) => `[${char}]`);
}

function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/** The real pattern for paths under one mount, or null when none can match. */
export interface MountPattern {
  readonly sql: string;
  /** False when `sql` is a superset the caller must filter. */
  readonly exact: boolean;
}

export function mountPattern(glob: CompiledGlob, mount: Mount): MountPattern | null {
  const { tokens } = glob;
  const states = statesAfter(tokens, mount.prefix);
  if (states.size === 0) return null;
  const sourceOf = (from: number): string =>
    tokens
      .slice(from)
      .map((token) => token.source)
      .join("");
  if (states.size === 1) {
    const [state] = states;
    if (state !== undefined) {
      const exact = `${escapeLiteral(mount.base)}${sourceOf(state)}`;
      if (byteLength(exact) <= GLOB_PATTERN_MAX_BYTES) return { sql: exact, exact: true };
    }
  }
  const last = Math.max(...states);
  const rest = sourceOf(last);
  return { sql: tokens[last]?.kind === "star" ? rest : `*${rest}`, exact: false };
}
