import { finalMatch } from "./pattern-match.js";
import {
  compileNfa,
  escaped,
  hasGlobstar,
  leadingGlobstarBasename,
  literalEdge,
  literalOf,
  nfaLiteralPrefix,
  targetSegments,
  tokensOf,
  wildcardSegments,
} from "./pattern-tokens.js";
import {
  BACKSLASH,
  type Compiled,
  compiledPatterns,
  ENCODER,
  type EncodedPath,
  type IgnorePattern,
  SLASH,
} from "./pattern-types.js";

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
