export const SLASH = 0x2f;
export const STAR = 0x2a;
export const QUESTION = 0x3f;
export const OPEN_CLASS = 0x5b;
export const CLOSE_CLASS = 0x5d;
export const BACKSLASH = 0x5c;

export type TokenKind = "literal" | "any" | "star" | "class";

export interface Token {
  kind: TokenKind;
  byte: number;
  bits: Uint32Array | null;
}

export type NfaKind =
  | "literal"
  | "any"
  | "star"
  | "class"
  | "globBoundary"
  | "globBody"
  | "starAny";

export interface NfaState {
  kind: NfaKind;
  byte: number;
  bits: Uint32Array | null;
}

export type Compiled =
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

export const compiledPatterns = new WeakMap<IgnorePattern, Compiled>();
export const ENCODER: { encode(input?: string): Uint8Array } = new TextEncoder();
