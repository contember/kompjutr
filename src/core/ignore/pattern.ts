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
  | { kind: "literalBasename"; literal: Uint8Array; wildcardSegments: number; nfaStates: 0 }
  | { kind: "literalPath"; literal: Uint8Array; wildcardSegments: number; nfaStates: 0 }
  | {
      kind: "deterministic";
      anchored: boolean;
      tokens: readonly Token[];
      literalPrefix: Uint8Array;
      literalSuffix: Uint8Array;
      wildcardSegments: number;
      nfaStates: 0;
      hasStar: boolean;
      targetSegments: number;
    }
  | {
      kind: "nfa";
      states: readonly NfaState[];
      literalPrefix: Uint8Array;
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

function parseClass(bytes: Uint8Array, start: number, slashSensitive = true): ParsedClass | null {
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
      if (slashSensitive) {
        bits[SLASH >>> 5] = (bits[SLASH >>> 5] ?? 0) & ~(1 << (SLASH & 31));
      }
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

function tokensOf(
  bytes: Uint8Array,
  options: { slashSensitive?: boolean; unmatchedClassLiteral?: boolean } = {},
): { tokens: Token[]; valid: boolean; hasStar: boolean } {
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
      const parsed = parseClass(bytes, index, options.slashSensitive ?? true);
      if (parsed === null) {
        if (options.unmatchedClassLiteral !== true) return { tokens, valid: false, hasStar };
        tokens.push({ kind: "literal", byte, bits: null });
        index++;
      } else {
        tokens.push({ kind: "class", byte: 0, bits: parsed.bits });
        index = parsed.end;
      }
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

function literalEdge(tokens: readonly Token[], fromStart: boolean): Uint8Array {
  let length = 0;
  while (length < tokens.length) {
    const index = fromStart ? length : tokens.length - length - 1;
    if (tokens[index]?.kind !== "literal") break;
    length++;
  }
  const edge = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    const token = tokens[fromStart ? index : tokens.length - length + index];
    edge[index] = token?.byte ?? 0;
  }
  return edge;
}

function targetSegments(tokens: readonly Token[]): number {
  let segments = 1;
  for (const token of tokens) {
    if (token.kind === "literal" && token.byte === SLASH) segments++;
  }
  return segments;
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

function leadingGlobstarBasename(bytes: Uint8Array): Uint8Array | null {
  let slash = 0;
  while (slash < bytes.byteLength && (bytes[slash] !== SLASH || escaped(bytes, slash))) slash++;
  if (slash < 2 || slash >= bytes.byteLength) return null;
  for (let index = 0; index < slash; index++) if (bytes[index] !== STAR) return null;
  for (let index = slash + 1; index < bytes.byteLength; index++) {
    if (bytes[index] === SLASH && !escaped(bytes, index)) return null;
  }
  return bytes.subarray(slash + 1);
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

function nfaLiteralPrefix(states: readonly NfaState[]): Uint8Array {
  let length = 0;
  while (states[length]?.kind === "literal") length++;
  const prefix = new Uint8Array(length);
  for (let index = 0; index < length; index++) prefix[index] = states[index]?.byte ?? 0;
  return prefix;
}

function matchToken(token: Token, byte: number, slashSensitive = true): boolean {
  if (token.kind === "literal") return token.byte === byte;
  if (token.kind === "any") return !slashSensitive || byte !== SLASH;
  if (token.kind === "class") return token.bits !== null && bitHas(token.bits, byte);
  return false;
}

function matchDeterministic(
  tokens: readonly Token[],
  bytes: Uint8Array,
  start: number,
  end: number,
  maxWork = Number.MAX_SAFE_INTEGER,
  slashSensitive = true,
): { matched: boolean; work: number } {
  let tokenIndex = 0;
  let byteIndex = start;
  let starIndex = -1;
  let retry = start;
  let work = 0;
  while (byteIndex < end) {
    work++;
    if (work > maxWork) return { matched: false, work };
    const token = tokens[tokenIndex];
    const byte = bytes[byteIndex];
    if (
      token !== undefined &&
      byte !== undefined &&
      token.kind !== "star" &&
      matchToken(token, byte, slashSensitive)
    ) {
      tokenIndex++;
      byteIndex++;
    } else if (token?.kind === "star") {
      starIndex = tokenIndex++;
      retry = byteIndex;
    } else if (starIndex >= 0 && retry < end && (!slashSensitive || bytes[retry] !== SLASH)) {
      tokenIndex = starIndex + 1;
      byteIndex = ++retry;
    } else {
      return { matched: false, work };
    }
  }
  while (tokens[tokenIndex]?.kind === "star") {
    work++;
    if (work > maxWork) return { matched: false, work };
    tokenIndex++;
  }
  return { matched: tokenIndex === tokens.length, work };
}

function maskHas(mask: Uint32Array, index: number): boolean {
  return ((mask[index >>> 5] ?? 0) & (1 << (index & 31))) !== 0;
}

function maskSet(mask: Uint32Array, index: number): void {
  const word = index >>> 5;
  mask[word] = (mask[word] ?? 0) | (1 << (index & 31));
}

function epsilon(
  states: readonly NfaState[],
  mask: Uint32Array,
  maxWork = Number.MAX_SAFE_INTEGER,
): number {
  let work = 0;
  for (let word = 0; word < mask.length; word++) {
    let pending = mask[word] ?? 0;
    while (pending !== 0) {
      const bit = pending & -pending;
      pending = (pending & ~bit) >>> 0;
      work++;
      if (work > maxWork) return work;
      const index = word * 32 + (31 - Math.clz32(bit));
      const kind = states[index]?.kind;
      const target =
        kind === "star" || kind === "starAny"
          ? index + 1
          : kind === "globBoundary"
            ? index + 2
            : -1;
      if (target < 0 || maskHas(mask, target)) continue;
      maskSet(mask, target);
      if (target >>> 5 === word) pending = (pending | (1 << (target & 31))) >>> 0;
    }
  }
  return work;
}

function nfaStep(
  states: readonly NfaState[],
  current: Uint32Array,
  next: Uint32Array,
  byte: number,
  maxWork = Number.MAX_SAFE_INTEGER,
): number {
  let work = 0;
  next.fill(0);
  for (let word = 0; word < current.length; word++) {
    let pending = current[word] ?? 0;
    while (pending !== 0) {
      const bit = pending & -pending;
      pending = (pending & ~bit) >>> 0;
      work++;
      if (work > maxWork) return work;
      const index = word * 32 + (31 - Math.clz32(bit));
      const state = states[index];
      if (state === undefined) continue;
      if (state.kind === "star") {
        if (byte !== SLASH) maskSet(next, index);
      } else if (state.kind === "starAny") {
        maskSet(next, index);
      } else if (state.kind === "globBoundary") {
        if (byte === SLASH) maskSet(next, index);
        else maskSet(next, index + 1);
      } else if (state.kind === "globBody") {
        if (byte === SLASH) maskSet(next, index - 1);
        else maskSet(next, index);
      } else if (
        state.kind === "literal"
          ? state.byte === byte
          : state.kind === "any"
            ? byte !== SLASH
            : state.kind === "class" && state.bits !== null
              ? bitHas(state.bits, byte)
              : false
      ) {
        maskSet(next, index + 1);
      }
    }
  }
  return work + epsilon(states, next, maxWork - work);
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

function prefixMatch(
  prefix: Uint8Array,
  bytes: Uint8Array,
  start: number,
  maxWork = Number.MAX_SAFE_INTEGER,
): { matched: boolean; work: number } {
  let work = 1;
  if (work > maxWork || bytes.byteLength - start < prefix.byteLength) {
    return { matched: false, work };
  }
  for (let index = 0; index < prefix.byteLength; index++) {
    work++;
    if (work > maxWork) return { matched: false, work };
    if (bytes[start + index] !== prefix[index]) return { matched: false, work };
  }
  return { matched: true, work };
}

function suffixMatch(
  suffix: Uint8Array,
  bytes: Uint8Array,
  end: number,
  maxWork = Number.MAX_SAFE_INTEGER,
): { matched: boolean; work: number } {
  let work = 1;
  if (work > maxWork || end < suffix.byteLength) return { matched: false, work };
  const start = end - suffix.byteLength;
  for (let index = 0; index < suffix.byteLength; index++) {
    work++;
    if (work > maxWork) return { matched: false, work };
    if (bytes[start + index] !== suffix[index]) return { matched: false, work };
  }
  return { matched: true, work };
}

function deterministicMatch(
  compiled: Extract<Compiled, { kind: "deterministic" }>,
  bytes: Uint8Array,
  start: number,
  end: number,
  maxWork = Number.MAX_SAFE_INTEGER,
  slashSensitive = true,
): { matched: boolean; work: number } {
  let work = 0;
  if (compiled.literalPrefix.byteLength > 0) {
    const prefix = prefixMatch(compiled.literalPrefix, bytes, start, maxWork);
    work += prefix.work;
    if (!prefix.matched || work > maxWork) return { matched: false, work };
  }
  if (compiled.literalSuffix.byteLength > 0) {
    const suffix = suffixMatch(compiled.literalSuffix, bytes, end, maxWork - work);
    work += suffix.work;
    if (!suffix.matched || work > maxWork) return { matched: false, work };
  }
  const result = matchDeterministic(
    compiled.tokens,
    bytes,
    start,
    end,
    maxWork - work,
    slashSensitive,
  );
  return { matched: result.matched, work: work + result.work };
}

export interface ByteGlobPattern {
  /** Literal bytes after pathspec escaping, or null when the program has a wildcard. */
  readonly literal: Uint8Array | null;
  readonly literalPrefix: Uint8Array;
  readonly tokenCount: number;
  readonly wildcardTokens: number;
  match(bytes: Uint8Array, maxWork?: number): { matched: boolean; work: number };
}

/** Compile one whole-path glob while sharing the ignore engine's byte evaluator. */
export function compileByteGlob(
  bytes: Uint8Array,
  options: { slashSensitive?: boolean; unmatchedClassLiteral?: boolean } = {},
): ByteGlobPattern | null {
  const slashSensitive = options.slashSensitive ?? true;
  const parsed = tokensOf(bytes, {
    slashSensitive,
    unmatchedClassLiteral: options.unmatchedClassLiteral,
  });
  if (!parsed.valid) return null;
  const literal = literalOf(parsed.tokens);
  const literalPrefix = literalEdge(parsed.tokens, true);
  const compiled: Extract<Compiled, { kind: "deterministic" }> = {
    kind: "deterministic",
    anchored: true,
    tokens: parsed.tokens,
    literalPrefix,
    literalSuffix: literalEdge(parsed.tokens, false),
    wildcardSegments: 0,
    nfaStates: 0,
    hasStar: parsed.hasStar,
    targetSegments: 1,
  };
  let wildcardTokens = 0;
  for (const token of parsed.tokens) {
    if (token.kind !== "literal") wildcardTokens++;
  }
  return {
    literal,
    literalPrefix,
    tokenCount: parsed.tokens.length,
    wildcardTokens,
    match(
      path: Uint8Array,
      maxWork = Number.MAX_SAFE_INTEGER,
    ): {
      matched: boolean;
      work: number;
    } {
      return deterministicMatch(compiled, path, 0, path.byteLength, maxWork, slashSensitive);
    },
  };
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
      ? deterministicMatch(compiled, path.bytes, 0, path.bytes.length).matched
      : deterministicMatch(compiled, path.bytes, start, end).matched;
  }
  const prefix = prefixMatch(compiled.literalPrefix, path.bytes, 0);
  if (!prefix.matched) return false;
  let current = new Uint32Array(2);
  let next = new Uint32Array(2);
  maskSet(current, 0);
  epsilon(compiled.states, current);
  for (const byte of path.bytes) {
    nfaStep(compiled.states, current, next, byte);
    const swap = current;
    current = next;
    next = swap;
  }
  return maskHas(current, compiled.states.length);
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
  const globstarBasename = anchored ? leadingGlobstarBasename(body) : null;
  if (globstarBasename !== null) {
    const parsed = tokensOf(globstarBasename);
    if (!parsed.valid) {
      compiled = { kind: "never", wildcardSegments: wildcards, nfaStates: 0 };
    } else {
      const literal = literalOf(parsed.tokens);
      compiled =
        literal !== null
          ? { kind: "literalBasename", literal, wildcardSegments: wildcards, nfaStates: 0 }
          : {
              kind: "deterministic",
              anchored: false,
              tokens: parsed.tokens,
              literalPrefix: literalEdge(parsed.tokens, true),
              literalSuffix: literalEdge(parsed.tokens, false),
              wildcardSegments: wildcards,
              nfaStates: 0,
              hasStar: parsed.hasStar,
              targetSegments: 1,
            };
    }
  } else if (anchored && hasGlobstar(body)) {
    const states = compileNfa(body);
    compiled =
      states === null
        ? { kind: "never", wildcardSegments: wildcards, nfaStates: 0 }
        : states.length >= 64
          ? { kind: "never", wildcardSegments: wildcards, nfaStates: states.length + 1 }
          : {
              kind: "nfa",
              states,
              literalPrefix: nfaLiteralPrefix(states),
              wildcardSegments: wildcards,
              nfaStates: states.length + 1,
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
            ? { kind: "literalPath", literal, wildcardSegments: wildcards, nfaStates: 0 }
            : { kind: "literalBasename", literal, wildcardSegments: wildcards, nfaStates: 0 }
          : {
              kind: "deterministic",
              anchored,
              tokens: parsed.tokens,
              literalPrefix: literalEdge(parsed.tokens, true),
              literalSuffix: literalEdge(parsed.tokens, false),
              wildcardSegments: wildcards,
              nfaStates: 0,
              hasStar: parsed.hasStar,
              targetSegments: targetSegments(parsed.tokens),
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

export function patternMatchesNever(pattern: IgnorePattern): boolean {
  return compiledPatterns.get(pattern)?.kind === "never";
}

export function compareLiteralBytes(
  path: Uint8Array,
  start: number,
  end: number,
  literal: Uint8Array,
  maxWork = Number.MAX_SAFE_INTEGER,
): { matched: boolean; work: number } {
  let work = 1;
  if (work > maxWork || end - start !== literal.byteLength) return { matched: false, work };
  for (let index = 0; index < literal.byteLength; index++) {
    work++;
    if (work > maxWork) return { matched: false, work };
    if (path[start + index] !== literal[index]) return { matched: false, work };
  }
  return { matched: true, work };
}

export type MatchDepth = (depth: number) => void;

/** Evaluate one applicable rule once and report every matched candidate depth. */
export function matchPatternDepths(
  pattern: IgnorePattern,
  path: EncodedPath,
  sourceDepth: number,
  isDirectory: boolean,
  matched: MatchDepth,
  maxWork = Number.MAX_SAFE_INTEGER,
): number {
  const compiled = compiledPatterns.get(pattern);
  if (compiled === undefined || compiled.kind === "never") return 0;
  const firstDepth = sourceDepth + 1;
  if (firstDepth > path.segments) return 0;

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
    return 0;
  }

  const start = path.starts[sourceDepth] ?? 0;
  if (compiled.kind === "literalPath") {
    const depth =
      sourceDepth + compiled.literal.reduce((count, byte) => count + (byte === SLASH ? 1 : 0), 1);
    const end = path.ends[depth - 1];
    if (end !== undefined && equalBytes(path.bytes, start, end, compiled.literal)) accepts(depth);
    return 0;
  }
  if (compiled.kind === "deterministic") {
    let work = 0;
    if (!compiled.anchored) {
      for (let depth = firstDepth; depth <= path.segments; depth++) {
        const index = depth - 1;
        const result = deterministicMatch(
          compiled,
          path.bytes,
          path.starts[index] ?? 0,
          path.ends[index] ?? 0,
          maxWork - work,
        );
        work += result.work;
        if (work > maxWork) return work;
        if (result.matched) {
          accepts(depth);
        }
      }
      return work;
    }
    const depth = sourceDepth + compiled.targetSegments;
    const end = path.ends[depth - 1];
    if (end === undefined) return 0;
    const result = deterministicMatch(compiled, path.bytes, start, end, maxWork);
    if (result.matched) accepts(depth);
    return result.work;
  }

  let work = 0;
  const prefix = prefixMatch(compiled.literalPrefix, path.bytes, start, maxWork);
  work += prefix.work;
  if (!prefix.matched || work > maxWork) return work;
  let current = new Uint32Array(2);
  let next = new Uint32Array(2);
  maskSet(current, 0);
  work += epsilon(compiled.states, current, maxWork - work);
  if (work > maxWork) return work;
  for (let depth = firstDepth; depth <= path.segments; depth++) {
    const end = path.ends[depth - 1] ?? path.bytes.length;
    const from = depth === firstDepth ? start : (path.starts[depth - 1] ?? end);
    if (depth > firstDepth) {
      work += nfaStep(compiled.states, current, next, SLASH, maxWork - work);
      if (work > maxWork) return work;
      const swap = current;
      current = next;
      next = swap;
    }
    for (let index = from; index < end; index++) {
      const byte = path.bytes[index];
      if (byte !== undefined) {
        work += nfaStep(compiled.states, current, next, byte, maxWork - work);
        if (work > maxWork) return work;
        const swap = current;
        current = next;
        next = swap;
      }
    }
    if (maskHas(current, compiled.states.length)) accepts(depth);
  }
  return work;
}
