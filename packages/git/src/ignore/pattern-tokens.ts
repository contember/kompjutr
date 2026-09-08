import {
  BACKSLASH,
  CLOSE_CLASS,
  type NfaState,
  OPEN_CLASS,
  QUESTION,
  SLASH,
  STAR,
  type Token,
} from "./pattern-types.js";

export function bitHas(bits: Uint32Array, byte: number): boolean {
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

export function escaped(bytes: Uint8Array, index: number): boolean {
  let count = 0;
  for (let at = index - 1; at >= 0 && bytes[at] === BACKSLASH; at--) count++;
  return count % 2 === 1;
}

export function tokensOf(
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

export function literalOf(tokens: readonly Token[]): Uint8Array | null {
  const literal = new Uint8Array(tokens.length);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.kind !== "literal") return null;
    literal[index] = token.byte;
  }
  return literal;
}

export function literalEdge(tokens: readonly Token[], fromStart: boolean): Uint8Array {
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

export function targetSegments(tokens: readonly Token[]): number {
  let segments = 1;
  for (const token of tokens) {
    if (token.kind === "literal" && token.byte === SLASH) segments++;
  }
  return segments;
}

export function wildcardSegments(bytes: Uint8Array): number {
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

export function hasGlobstar(bytes: Uint8Array): boolean {
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

export function leadingGlobstarBasename(bytes: Uint8Array): Uint8Array | null {
  let slash = 0;
  while (slash < bytes.byteLength && (bytes[slash] !== SLASH || escaped(bytes, slash))) slash++;
  if (slash < 2 || slash >= bytes.byteLength) return null;
  for (let index = 0; index < slash; index++) if (bytes[index] !== STAR) return null;
  for (let index = slash + 1; index < bytes.byteLength; index++) {
    if (bytes[index] === SLASH && !escaped(bytes, index)) return null;
  }
  return bytes.subarray(slash + 1);
}

export function compileNfa(bytes: Uint8Array): NfaState[] | null {
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

export function nfaLiteralPrefix(states: readonly NfaState[]): Uint8Array {
  let length = 0;
  while (states[length]?.kind === "literal") length++;
  const prefix = new Uint8Array(length);
  for (let index = 0; index < length; index++) prefix[index] = states[index]?.byte ?? 0;
  return prefix;
}
