// Git wildmatch compiled over UTF-8 bytes. The public `test` callback is kept
// for compatibility; the worktree matcher uses the byte evaluator directly.

export { type ByteGlobPattern, compileByteGlob } from "./byte-glob.js";
export {
  compilePattern,
  compilePatternBytes,
  encodePath,
  patternLimits,
  patternLiteral,
  patternMatchesNever,
} from "./pattern-compile.js";
export { compareLiteralBytes, type MatchDepth, matchPatternDepths } from "./pattern-match.js";
export type { EncodedPath, IgnorePattern } from "./pattern-types.js";
