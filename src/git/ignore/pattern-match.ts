import { bitHas } from "./pattern-tokens.js";
import {
  type Compiled,
  compiledPatterns,
  type EncodedPath,
  type IgnorePattern,
  type NfaState,
  SLASH,
  type Token,
} from "./pattern-types.js";

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

export function deterministicMatch(
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

export function finalMatch(compiled: Compiled, path: EncodedPath): boolean {
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
