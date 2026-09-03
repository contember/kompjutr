import { deterministicMatch } from "./pattern-match.js";
import { literalEdge, literalOf, tokensOf } from "./pattern-tokens.js";
import type { Compiled } from "./pattern-types.js";

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
