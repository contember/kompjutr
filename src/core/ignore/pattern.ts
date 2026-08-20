// Git wildmatch compiled over UTF-8 bytes. The public `test` callback is kept
// for compatibility; the worktree matcher uses the byte evaluator directly.

const SLASH = 0x2f;
const STAR = 0x2a;
const QUESTION = 0x3f;
const OPEN_CLASS = 0x5b;
const CLOSE_CLASS = 0x5d;
const BACKSLASH = 0x5c;

type TokenKind = "literal" | "any" | "star" | "class";

interface Token {
  kind: TokenKind;
  byte: number;
  bits: Uint32Array | null;
}

type NfaKind = "literal" | "any" | "star" | "class" | "globBoundary" | "globBody" | "starAny";

interface NfaState {
  kind: NfaKind;
  byte: number;
  bits: Uint32Array | null;
}

type Compiled =
  | { kind: "literalBasename"; literal: Uint8Array; wildcardSegments: 0; nfaStates: 0 }
  | { kind: "literalPath"; literal: Uint8Array; wildcardSegments: 0; nfaStates: 0 }
  | {
      kind: "deterministic";
      anchored: boolean;
      tokens: readonly Token[];
      wildcardSegments: number;
      nfaStates: 0;
      hasStar: boolean;
    }
  | {
      kind: "nfa";
      states: readonly NfaState[];
      wildcardSegments: number;
      nfaStates: number;
    }
  | { kind: "never"; wildcardSegments: number; nfaStates: number };

export interface IgnorePattern {
  negated: boolean;
  directoryOnly: boolean;
  iterative: boolean;
  test: (relative: string) => boolean;
}

export interface EncodedPath {
  bytes: Uint8Array;
  starts: Uint16Array;
  ends: Uint16Array;
  segments: number;
}

const compiledPatterns = new WeakMap<IgnorePattern, Compiled>();
const ENCODER = new TextEncoder();

function bitHas(bits: Uint32Array, byte: number): boolean {
  return ((bits[byte >>> 5] ?? 0) & (1 << (byte & 31))) !== 0;
}

function bitSet(bits: Uint32Array, byte: number): void {
  const word = byte >>> 5;
  bits[word] = (bits[word] ?? 0) | (1 << (byte & 31));
}

function fillRange(bits: Uint32Array, from: number, to: number): void {
  if (from > to) return;
  for (let byte = from; byte <= to; byte++) bitSet(bits, byte);
}

function addPosix(bits: Uint32Array, name: Uint8Array): boolean {
  let text = "";
  for (const byte of name) text += String.fromCharCode(byte);
  switch (text) {
    case "alnum":
      fillRange(bits, 0x30, 0x39);
      fillRange(bits, 0x41, 0x5a);
      fillRange(bits, 0x61, 0x7a);
      return true;
    case "alpha":
      fillRange(bits, 0x41, 0x5a);
      fillRange(bits, 0x61, 0x7a);
      return true;
    case "blank":
      bitSet(bits, 0x09);
      bitSet(bits, 0x20);
      return true;
    case "cntrl":
      fillRange(bits, 0x00, 0x1f);
      bitSet(bits, 0x7f);
      return true;
    case "digit":
      fillRange(bits, 0x30, 0x39);
      return true;
    case "graph":
      fillRange(bits, 0x21, 0x7e);
      return true;
    case "lower":
      fillRange(bits, 0x61, 0x7a);
      return true;
    case "print":
      fillRange(bits, 0x20, 0x7e);
      return true;
    case "punct":
      fillRange(bits, 0x21, 0x2f);
      fillRange(bits, 0x3a, 0x40);
      fillRange(bits, 0x5b, 0x60);
      fillRange(bits, 0x7b, 0x7e);
      return true;
    case "space":
      for (const byte of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) bitSet(bits, byte);
      return true;
    case "upper":
      fillRange(bits, 0x41, 0x5a);
      return true;
    case "xdigit":
      fillRange(bits, 0x30, 0x39);
      fillRange(bits, 0x41, 0x46);
      fillRange(bits, 0x61, 0x66);
      return true;
    default:
      return false;
  }
}

interface ParsedClass {
  bits: Uint32Array;
  end: number;
}

function classByte(bytes: Uint8Array, at: number): { byte: number; end: number } | null {
  const byte = bytes[at];
  if (byte === undefined) return null;
  if (byte === BACKSLASH) {
    const escaped = bytes[at + 1];
    return escaped === undefined ? null : { byte: escaped, end: at + 2 };
  }
  return { byte, end: at + 1 };
}

function parseClass(bytes: Uint8Array, start: number): ParsedClass | null {
  let index = start + 1;
  let negated = false;
  if (bytes[index] === 0x21 || bytes[index] === 0x5e) {
    negated = true;
    index++;
  }
  const bits = new Uint32Array(8);
  let first = true;
  let prior: number | undefined;
  while (index < bytes.length) {
    if (bytes[index] === CLOSE_CLASS && !first) {
      if (negated) {
        for (let word = 0; word < bits.length; word++) bits[word] = ~(bits[word] ?? 0);
      }
      bits[SLASH >>> 5] = (bits[SLASH >>> 5] ?? 0) & ~(1 << (SLASH & 31));
      return { bits, end: index + 1 };
    }
    if (bytes[index] === OPEN_CLASS && bytes[index + 1] === 0x3a) {
      let close = index + 2;
      while (
        close + 1 < bytes.length &&
        !(bytes[close] === 0x3a && bytes[close + 1] === CLOSE_CLASS)
      ) {
        close++;
      }
      if (close + 1 < bytes.length && addPosix(bits, bytes.subarray(index + 2, close))) {
        index = close + 2;
        prior = undefined;
        first = false;
        continue;
      }
    }
    const parsed = classByte(bytes, index);
    if (parsed === null) return null;
    if (
      parsed.byte === 0x2d &&
      prior !== undefined &&
      bytes[parsed.end] !== CLOSE_CLASS &&
      parsed.end < bytes.length
    ) {
      const upper = classByte(bytes, parsed.end);
      if (upper === null) return null;
      fillRange(bits, prior, upper.byte);
      prior = undefined;
      index = upper.end;
      first = false;
      continue;
    }
    bitSet(bits, parsed.byte);
    prior = parsed.byte;
    index = parsed.end;
    first = false;
  }
  return null;
}

function escaped(bytes: Uint8Array, index: number): boolean {
  let count = 0;
  for (let at = index - 1; at >= 0 && bytes[at] === BACKSLASH; at--) count++;
  return count % 2 === 1;
}

function tokensOf(bytes: Uint8Array): { tokens: Token[]; valid: boolean; hasStar: boolean } {
  const tokens: Token[] = [];
  let hasStar = false;
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index];
    if (byte === undefined) break;
    if (byte === BACKSLASH) {
      const literal = bytes[index + 1];
      if (literal === undefined) return { tokens, valid: false, hasStar };
      tokens.push({ kind: "literal", byte: literal, bits: null });
      index += 2;
    } else if (byte === STAR) {
      while (bytes[index + 1] === STAR) index++;
      tokens.push({ kind: "star", byte: 0, bits: null });
      hasStar = true;
      index++;
    } else if (byte === QUESTION) {
      tokens.push({ kind: "any", byte: 0, bits: null });
      index++;
    } else if (byte === OPEN_CLASS) {
      const parsed = parseClass(bytes, index);
      if (parsed === null) return { tokens, valid: false, hasStar };
      tokens.push({ kind: "class", byte: 0, bits: parsed.bits });
      index = parsed.end;
    } else {
      tokens.push({ kind: "literal", byte, bits: null });
      index++;
    }
  }
  return { tokens, valid: true, hasStar };
}

function literalOf(tokens: readonly Token[]): Uint8Array | null {
  const literal = new Uint8Array(tokens.length);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.kind !== "literal") return null;
    literal[index] = token.byte;
  }
  return literal;
}

function wildcardSegments(bytes: Uint8Array): number {
  let count = 0;
  let wildcard = false;
  for (let index = 0; index <= bytes.length; index++) {
    const byte = bytes[index];
    if (index === bytes.length || (byte === SLASH && !escaped(bytes, index))) {
      if (wildcard) count++;
      wildcard = false;
      continue;
    }
    if (byte === BACKSLASH) {
      index++;
      continue;
    }
    if (byte === STAR || byte === QUESTION || byte === OPEN_CLASS) wildcard = true;
  }
  return count;
}

function hasGlobstar(bytes: Uint8Array): boolean {
  let segmentStart = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && (bytes[index] !== SLASH || escaped(bytes, index))) continue;
    const length = index - segmentStart;
    let allStars = length >= 2;
    for (let at = segmentStart; at < index && allStars; at++) allStars = bytes[at] === STAR;
    if (allStars) {
      return true;
    }
    segmentStart = index + 1;
  }
  return false;
}

function compileNfa(bytes: Uint8Array): NfaState[] | null {
  const states: NfaState[] = [];
  let segmentStart = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && (bytes[index] !== SLASH || escaped(bytes, index))) continue;
    const segmentEnd = index;
    const length = segmentEnd - segmentStart;
    let globstar = length >= 2;
    for (let at = segmentStart; at < segmentEnd && globstar; at++) {
      globstar = bytes[at] === STAR;
    }
    if (globstar) {
      if (index < bytes.length) {
        states.push({ kind: "globBoundary", byte: 0, bits: null });
        states.push({ kind: "globBody", byte: 0, bits: null });
      } else {
        states.push({ kind: "starAny", byte: 0, bits: null });
      }
    } else {
      const parsed = tokensOf(bytes.subarray(segmentStart, segmentEnd));
      if (!parsed.valid) return null;
      for (const token of parsed.tokens) states.push({ ...token });
      if (index < bytes.length) states.push({ kind: "literal", byte: SLASH, bits: null });
    }
    segmentStart = index + 1;
  }
  return states;
}

function matchToken(token: Token, byte: number): boolean {
  if (token.kind === "literal") return token.byte === byte;
  if (token.kind === "any") return byte !== SLASH;
  if (token.kind === "class") return token.bits !== null && bitHas(token.bits, byte);
  return false;
}

function matchDeterministic(
  tokens: readonly Token[],
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  let tokenIndex = 0;
  let byteIndex = start;
  let starIndex = -1;
  let retry = start;
  while (byteIndex < end) {
    const token = tokens[tokenIndex];
    const byte = bytes[byteIndex];
    if (
      token !== undefined &&
      byte !== undefined &&
      token.kind !== "star" &&
      matchToken(token, byte)
    ) {
      tokenIndex++;
      byteIndex++;
    } else if (token?.kind === "star") {
      starIndex = tokenIndex++;
      retry = byteIndex;
    } else if (starIndex >= 0 && retry < end && bytes[retry] !== SLASH) {
      tokenIndex = starIndex + 1;
      byteIndex = ++retry;
    } else {
      return false;
    }
  }
  while (tokens[tokenIndex]?.kind === "star") tokenIndex++;
  return tokenIndex === tokens.length;
}

function epsilon(states: readonly NfaState[], mask: number): number {
  let expanded = mask >>> 0;
  for (;;) {
    const before = expanded;
    for (let index = 0; index < states.length; index++) {
      if ((expanded & (1 << index)) === 0) continue;
      const kind = states[index]?.kind;
      if (kind === "star" || kind === "starAny") expanded |= 1 << (index + 1);
      else if (kind === "globBoundary") expanded |= 1 << (index + 2);
    }
    expanded >>>= 0;
    if (expanded === before) return expanded;
  }
}

function nfaStep(states: readonly NfaState[], mask: number, byte: number): number {
  let next = 0;
  for (let index = 0; index < states.length; index++) {
    if ((mask & (1 << index)) === 0) continue;
    const state = states[index];
    if (state === undefined) continue;
    if (state.kind === "star") {
      if (byte !== SLASH) next |= 1 << index;
    } else if (state.kind === "starAny") {
      next |= 1 << index;
    } else if (state.kind === "globBoundary") {
      if (byte === SLASH) next |= 1 << index;
      else next |= 1 << (index + 1);
    } else if (state.kind === "globBody") {
      if (byte === SLASH) next |= 1 << (index - 1);
      else next |= 1 << index;
    } else if (
      state.kind === "literal"
        ? state.byte === byte
        : state.kind === "any"
          ? byte !== SLASH
          : state.kind === "class" && state.bits !== null
            ? bitHas(state.bits, byte)
            : false
    ) {
      next |= 1 << (index + 1);
    }
  }
  return epsilon(states, next >>> 0);
}

function equalBytes(
  left: Uint8Array,
  leftStart: number,
  leftEnd: number,
  right: Uint8Array,
): boolean {
  if (leftEnd - leftStart !== right.length) return false;
  for (let index = 0; index < right.length; index++) {
    if (left[leftStart + index] !== right[index]) return false;
  }
  return true;
}

export function encodePath(path: string, maxSegments = 128): EncodedPath {
  const bytes = ENCODER.encode(path);
  const starts = new Uint16Array(maxSegments);
  const ends = new Uint16Array(maxSegments);
  let segments = 0;
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && bytes[index] !== SLASH) continue;
    if (segments < maxSegments) {
      starts[segments] = start;
      ends[segments] = index;
    }
    segments++;
    start = index + 1;
  }
  return { bytes, starts, ends, segments };
}

function finalMatch(compiled: Compiled, path: EncodedPath): boolean {
  if (compiled.kind === "never" || path.segments === 0) return false;
  const last = path.segments - 1;
  const start = path.starts[last] ?? 0;
  const end = path.ends[last] ?? path.bytes.length;
  if (compiled.kind === "literalBasename")
    return equalBytes(path.bytes, start, end, compiled.literal);
  if (compiled.kind === "literalPath")
    return equalBytes(path.bytes, 0, path.bytes.length, compiled.literal);
  if (compiled.kind === "deterministic") {
    return compiled.anchored
      ? matchDeterministic(compiled.tokens, path.bytes, 0, path.bytes.length)
      : matchDeterministic(compiled.tokens, path.bytes, start, end);
  }
  let mask = epsilon(compiled.states, 1);
  for (const byte of path.bytes) mask = nfaStep(compiled.states, mask, byte);
  return (mask & (1 << compiled.states.length)) !== 0;
}

/** Compile one physical rule line without decoding or re-encoding it. */
export function compilePatternBytes(line: Uint8Array): IgnorePattern | null {
  let start = 0;
  let end = line.length;
  while (end > start && line[end - 1] === 0x20 && !escaped(line, end - 1)) end--;
  if (end <= start || line[start] === 0x23) return null;

  let negated = false;
  if (line[start] === 0x21) {
    negated = true;
    start++;
  }
  if (end <= start) return null;

  let directoryOnly = false;
  if (line[end - 1] === SLASH) {
    directoryOnly = true;
    end--;
    if (end > start && line[end - 1] === BACKSLASH && escaped(line, end)) end--;
  }
  if (end <= start) return null;

  let anchored = line[start] === SLASH || (line[start] === BACKSLASH && line[start + 1] === SLASH);
  if (line[start] === SLASH) start++;
  else if (line[start] === BACKSLASH && line[start + 1] === SLASH) start += 2;
  for (let index = start; index < end && !anchored; index++) {
    if (line[index] === SLASH || (line[index] === BACKSLASH && line[index + 1] === SLASH)) {
      anchored = true;
    } else if (line[index] === BACKSLASH) {
      index++;
    }
  }
  const body = line.subarray(start, end);
  const wildcards = wildcardSegments(body);
  let compiled: Compiled;
  if (anchored && hasGlobstar(body)) {
    const states = compileNfa(body);
    const aggregateStates = states?.reduce(
      (count, state) => count + (state.kind === "literal" ? 0 : 1),
      0,
    );
    compiled =
      states === null
        ? { kind: "never", wildcardSegments: wildcards, nfaStates: 0 }
        : states.length > 31
          ? { kind: "never", wildcardSegments: wildcards, nfaStates: states.length + 1 }
          : {
              kind: "nfa",
              states,
              wildcardSegments: wildcards,
              nfaStates: aggregateStates ?? 0,
            };
  } else {
    const parsed = tokensOf(body);
    if (!parsed.valid) {
      compiled = { kind: "never", wildcardSegments: wildcards, nfaStates: 0 };
    } else {
      const literal = literalOf(parsed.tokens);
      compiled =
        literal !== null
          ? anchored
            ? { kind: "literalPath", literal, wildcardSegments: 0, nfaStates: 0 }
            : { kind: "literalBasename", literal, wildcardSegments: 0, nfaStates: 0 }
          : {
              kind: "deterministic",
              anchored,
              tokens: parsed.tokens,
              wildcardSegments: wildcards,
              nfaStates: 0,
              hasStar: parsed.hasStar,
            };
    }
  }

  const pattern: IgnorePattern = {
    negated,
    directoryOnly,
    iterative: compiled.kind === "nfa" || (compiled.kind === "deterministic" && compiled.hasStar),
    test(relative: string): boolean {
      return finalMatch(compiled, encodePath(relative));
    },
  };
  compiledPatterns.set(pattern, compiled);
  return pattern;
}

/** String compatibility entry point. Loading `.gitignore` files uses bytes. */
export function compilePattern(line: string): IgnorePattern | null {
  return compilePatternBytes(ENCODER.encode(line));
}

export function patternLimits(pattern: IgnorePattern): {
  nfaStates: number;
  wildcardSegments: number;
} {
  const compiled = compiledPatterns.get(pattern);
  return {
    nfaStates: compiled?.nfaStates ?? 0,
    wildcardSegments: compiled?.wildcardSegments ?? 0,
  };
}

export function patternLiteral(
  pattern: IgnorePattern,
): { basename: boolean; bytes: Uint8Array } | null {
  const compiled = compiledPatterns.get(pattern);
  if (compiled?.kind === "literalBasename") return { basename: true, bytes: compiled.literal };
  if (compiled?.kind === "literalPath") return { basename: false, bytes: compiled.literal };
  return null;
}

export function bytesEqual(
  path: Uint8Array,
  start: number,
  end: number,
  literal: Uint8Array,
): boolean {
  return equalBytes(path, start, end, literal);
}

export type MatchDepth = (depth: number) => void;

/** Cost charged before `matchPatternDepths` executes. */
export function patternWork(pattern: IgnorePattern, bytes: number, _segments: number): number {
  const compiled = compiledPatterns.get(pattern);
  if (compiled === undefined || compiled.kind === "never") return 1;
  if (compiled.kind === "literalBasename" || compiled.kind === "literalPath") return 1;
  if (compiled.kind === "nfa") return Math.max(1, bytes * (compiled.states.length + 1));
  return compiled.hasStar
    ? Math.max(1, bytes * Math.min(8, compiled.tokens.length))
    : Math.max(1, bytes);
}

/** Evaluate one applicable rule once and report every matched candidate depth. */
export function matchPatternDepths(
  pattern: IgnorePattern,
  path: EncodedPath,
  sourceDepth: number,
  isDirectory: boolean,
  matched: MatchDepth,
): void {
  const compiled = compiledPatterns.get(pattern);
  if (compiled === undefined || compiled.kind === "never") return;
  const firstDepth = sourceDepth + 1;
  if (firstDepth > path.segments) return;

  const accepts = (depth: number): void => {
    if (!pattern.directoryOnly || depth < path.segments || isDirectory) matched(depth);
  };
  if (compiled.kind === "literalBasename") {
    for (let depth = firstDepth; depth <= path.segments; depth++) {
      const index = depth - 1;
      if (
        equalBytes(path.bytes, path.starts[index] ?? 0, path.ends[index] ?? 0, compiled.literal)
      ) {
        accepts(depth);
      }
    }
    return;
  }

  const start = path.starts[sourceDepth] ?? 0;
  if (compiled.kind === "literalPath") {
    const depth =
      sourceDepth + compiled.literal.reduce((count, byte) => count + (byte === SLASH ? 1 : 0), 1);
    const end = path.ends[depth - 1];
    if (end !== undefined && equalBytes(path.bytes, start, end, compiled.literal)) accepts(depth);
    return;
  }
  if (compiled.kind === "deterministic") {
    if (!compiled.anchored) {
      for (let depth = firstDepth; depth <= path.segments; depth++) {
        const index = depth - 1;
        if (
          matchDeterministic(
            compiled.tokens,
            path.bytes,
            path.starts[index] ?? 0,
            path.ends[index] ?? 0,
          )
        ) {
          accepts(depth);
        }
      }
      return;
    }
    let slashes = 0;
    for (const token of compiled.tokens)
      if (token.kind === "literal" && token.byte === SLASH) slashes++;
    const depth = sourceDepth + slashes + 1;
    const end = path.ends[depth - 1];
    if (end !== undefined && matchDeterministic(compiled.tokens, path.bytes, start, end))
      accepts(depth);
    return;
  }

  let mask = epsilon(compiled.states, 1);
  for (let depth = firstDepth; depth <= path.segments; depth++) {
    const end = path.ends[depth - 1] ?? path.bytes.length;
    const from = depth === firstDepth ? start : (path.starts[depth - 1] ?? end);
    if (depth > firstDepth) mask = nfaStep(compiled.states, mask, SLASH);
    for (let index = from; index < end; index++) {
      const byte = path.bytes[index];
      if (byte !== undefined) mask = nfaStep(compiled.states, mask, byte);
    }
    if ((mask & (1 << compiled.states.length)) !== 0) accepts(depth);
  }
}
