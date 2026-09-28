// A position in the token list, shared by the statement and command parsers.

import { ShellSyntaxError, wordText } from "./ast.js";
import type { Operator, Token } from "./lexer.js";

export class TokenCursor {
  #index = 0;
  #newlines: number[] | null = null;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  get done(): boolean {
    return this.#index >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.#index];
  }

  advance(): void {
    this.#index++;
  }

  peekOperator(): Operator | null {
    const token = this.peek();
    return token?.type === "op" ? token.value : null;
  }

  /**
   * The text of an unquoted literal word, which is what a reserved word must
   * be. Whether it *is* reserved depends on where the parser stands.
   */
  peekKeyword(): string | null {
    const token = this.peek();
    if (token?.type !== "word") return null;
    const [part, ...rest] = token.word.parts;
    return rest.length === 0 && part?.kind === "Literal" ? part.value : null;
  }

  skipNewlines(): void {
    while (this.peek()?.type === "newline") this.#index++;
  }

  /** The offset of the current token, or the end of the source. */
  offset(): number {
    return this.peek()?.offset ?? this.source.length;
  }

  /** A syntax error at the current token, named the way Bash names it. */
  unexpected(): ShellSyntaxError {
    const token = this.peek();
    if (token === undefined) {
      return new ShellSyntaxError("syntax", "syntax error: unexpected end of input", this.offset());
    }
    const text = token.type === "newline" ? "newline" : describe(token);
    return new ShellSyntaxError(
      "syntax",
      `syntax error near unexpected token \`${text}'`,
      token.offset,
    );
  }

  lineAt(offset: number): number {
    if (this.#newlines === null) {
      this.#newlines = [];
      for (let index = this.source.indexOf("\n"); index !== -1; ) {
        this.#newlines.push(index);
        index = this.source.indexOf("\n", index + 1);
      }
    }
    let low = 0;
    let high = this.#newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.#newlines[middle] ?? offset) < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  }
}

function describe(token: Token): string {
  if (token.type === "op") return token.value;
  if (token.type === "fd") return String(token.value);
  if (token.type === "word") return wordText(token.word);
  return "here-document";
}
