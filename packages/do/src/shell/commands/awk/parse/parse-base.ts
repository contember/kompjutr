// Token cursor, diagnostics, and the symbol table shared by the awk parsers.
//
// mawk types each name on first use — variable, array, or function — and a
// later use of the other kind is a compile error. Function parameters are
// typed by their use in the body; a bare name passed as an argument is
// resolved after parsing, from the callee's parameter types.

import { AwkSyntaxError } from "../errors.js";
import { type Slot, SPECIAL_VARIABLES, type SpecialName, type VariableRef } from "./ast.js";
import type { Token, TokenKind } from "./tokens.js";

export type SymbolKind = "none" | "scalar" | "array";

export interface SymbolEntry {
  readonly name: string;
  readonly index: number;
  kind: SymbolKind;
}

export type Scope = "begin" | "end" | "main" | "function";

const SPECIALS: ReadonlySet<string> = new Set(SPECIAL_VARIABLES);

function isSpecial(name: string): name is SpecialName {
  return SPECIALS.has(name);
}

/** The global arrays mawk defines before the program runs. */
export const PREDEFINED_ARRAYS = ["ENVIRON", "ARGV"] as const;

/**
 * Nested constructs parse recursively, so their depth is capped to keep the
 * parser and evaluator well inside a Worker's stack. mawk's own parser stack
 * overflows at about 200 levels with the same diagnostic; this cap is lower.
 * Chains of binary operators and concatenation are iterative and uncapped.
 */
export const MAX_NESTING = 100;

export class ParserBase {
  position = 0;
  #depth = 0;
  scope: Scope = "main";
  loopDepth = 0;
  readonly globals = new Map<string, SymbolEntry>();
  readonly globalList: SymbolEntry[] = [];
  locals: Map<string, SymbolEntry> | null = null;

  constructor(
    readonly tokens: readonly Token[],
    scalars: readonly string[],
  ) {
    for (const name of PREDEFINED_ARRAYS) this.global(name).kind = "array";
    for (const name of scalars) {
      if (!isSpecial(name)) this.global(name).kind = "scalar";
    }
  }

  /** Parse one nesting level; past the cap it is a syntax error at the current token. */
  nested<T>(parse: () => T): T {
    if (this.#depth >= MAX_NESTING) throw this.syntaxError();
    this.#depth++;
    try {
      return parse();
    } finally {
      this.#depth--;
    }
  }

  get token(): Token {
    const token = this.tokens[this.position] ?? this.tokens[this.tokens.length - 1];
    if (token === undefined) throw new Error("awk: the scanner produced no tokens");
    return token;
  }

  peek(offset: number): Token {
    return this.tokens[this.position + offset] ?? this.token;
  }

  advance(): Token {
    const token = this.token;
    if (this.position < this.tokens.length - 1) this.position++;
    return token;
  }

  is(kind: TokenKind, value?: string): boolean {
    const token = this.token;
    return token.kind === kind && (value === undefined || token.value === value);
  }

  isKeyword(value: string): boolean {
    return this.is("keyword", value);
  }

  expect(kind: TokenKind, value?: string): Token {
    if (!this.is(kind, value)) throw this.syntaxError();
    return this.advance();
  }

  skipNewlines(): void {
    while (this.is("newline")) this.advance();
  }

  /** A syntax error at a token, with the `missing ) near …` and `missing } near …` forms. */
  syntaxError(token: Token = this.token): AwkSyntaxError {
    const closes = ["eof", "newline", ";", "fake;", "}"];
    if (token.parens > 0 && closes.includes(token.kind)) {
      return new AwkSyntaxError(token.line, `missing ) near ${token.text}`);
    }
    const blockEnd =
      token.kind === "eof" || (token.kind === "keyword" && /^(BEGIN|END)$/.test(token.value));
    if (token.braces > 0 && blockEnd) {
      return new AwkSyntaxError(token.line, `missing } near ${token.text}`);
    }
    return new AwkSyntaxError(token.line, `syntax error at or near ${token.text}`);
  }

  error(message: string, token: Token = this.token): AwkSyntaxError {
    return new AwkSyntaxError(token.line, message);
  }

  /** An intentional refusal of an unbounded or effectful construct. */
  refuse(message: string, token: Token = this.token): AwkSyntaxError {
    return new AwkSyntaxError(token.line, message);
  }

  global(name: string): SymbolEntry {
    let entry = this.globals.get(name);
    if (entry === undefined) {
      entry = { name, index: this.globalList.length, kind: "none" };
      this.globals.set(name, entry);
      this.globalList.push(entry);
    }
    return entry;
  }

  slotOf(name: string): { slot: Slot; entry: SymbolEntry } {
    const local = this.locals?.get(name);
    if (local !== undefined)
      return { slot: { scope: "local", index: local.index, name }, entry: local };
    const entry = this.global(name);
    return { slot: { scope: "global", index: entry.index, name }, entry };
  }

  useScalar(name: string, token: Token): VariableRef {
    if (this.locals?.has(name) !== true && isSpecial(name)) return { scope: "special", name };
    const { slot, entry } = this.slotOf(name);
    if (entry.kind === "array") throw this.error(`illegal reference to array ${name}`, token);
    entry.kind = "scalar";
    return slot;
  }

  useArray(name: string, token: Token): Slot {
    if (this.locals?.has(name) !== true && isSpecial(name)) {
      throw this.error(`illegal reference to variable ${name}`, token);
    }
    const { slot, entry } = this.slotOf(name);
    if (entry.kind === "scalar") throw this.error(`illegal reference to variable ${name}`, token);
    entry.kind = "array";
    return slot;
  }

  /** A bare name that may be either kind until the program is resolved. */
  useUntyped(name: string): Slot {
    return this.slotOf(name).slot;
  }

  isSpecialName(name: string): boolean {
    return this.locals?.has(name) !== true && isSpecial(name);
  }
}
