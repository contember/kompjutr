// Tokens to a Script: statements joined by `&&`, `||`, `;`, or a newline, each
// a pipeline whose stages are simple commands or the admitted compound
// commands — `( … )`, `{ …; }`, `if`, and `for … in` (ADR-0027).
//
// Reserved words are recognized only where Bash recognizes them: as the first
// word of a command, and `in` after `for NAME`. Everywhere else they are
// ordinary words, so `echo done }` prints both.

import {
  type Command,
  type CompoundCommand,
  type IfClause,
  type Pipeline,
  type Redirection,
  type Script,
  ShellSyntaxError,
  type Statement,
  type Word,
} from "./ast.js";
import { TokenCursor } from "./cursor.js";
import { tokenize } from "./lexer.js";
import { parseRedirection, parseSimpleCommand } from "./simple.js";

export function parse(source: string): Script {
  return new Parser(new TokenCursor(tokenize(source), source)).script();
}

/** Words that close a list: a list stops before them in command position. */
const CLOSERS = new Set(["then", "elif", "else", "fi", "do", "done", "}", "esac"]);

/** Bash keywords whose commands have no bounded execution here (ADR-0027). */
const REFUSED = new Set(["while", "until", "case", "select", "function", "time", "coproc"]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Parser {
  constructor(private readonly cursor: TokenCursor) {}

  script(): Script {
    const statements = this.#list();
    if (!this.cursor.done) throw this.cursor.unexpected();
    return { kind: "Script", statements };
  }

  /** Statements up to the end of input or a closing word or `)` in command position. */
  #list(): Statement[] {
    const statements: Statement[] = [];
    this.cursor.skipNewlines();
    while (!this.cursor.done && !this.#atListEnd()) {
      const pipeline = this.#pipeline();
      const connector = this.#connector();
      statements.push({ kind: "Statement", pipeline, connector });
      if (connector === null) break;
    }
    return statements;
  }

  /** A list that Bash requires to hold at least one command. */
  #body(): Statement[] {
    const statements = this.#list();
    if (statements.length === 0) throw this.cursor.unexpected();
    return statements;
  }

  #atListEnd(): boolean {
    if (this.cursor.peekOperator() === ")") return true;
    const keyword = this.cursor.peekKeyword();
    return keyword !== null && CLOSERS.has(keyword);
  }

  /** A newline separates statements exactly as `;` does. */
  #connector(): "&&" | "||" | ";" | null {
    const token = this.cursor.peek();
    let connector: "&&" | "||" | ";";
    if (token?.type === "newline") {
      connector = ";";
    } else if (
      token?.type === "op" &&
      (token.value === "&&" || token.value === "||" || token.value === ";")
    ) {
      connector = token.value;
    } else {
      return null;
    }
    this.cursor.advance();
    this.cursor.skipNewlines();
    if (!this.cursor.done && !this.#atListEnd()) return connector;
    if (connector !== ";") {
      throw new ShellSyntaxError(
        "statement",
        `expected a command after \`${connector}\``,
        token.offset,
      );
    }
    // A trailing `;` or newline ends the list rather than promising another statement.
    return null;
  }

  #pipeline(): Pipeline {
    let negated = false;
    while (this.cursor.peekKeyword() === "!") {
      negated = !negated;
      this.cursor.advance();
    }
    const commands: Command[] = [this.#command()];
    while (this.cursor.peekOperator() === "|") {
      this.cursor.advance();
      this.cursor.skipNewlines();
      commands.push(this.#command());
    }
    return { kind: "Pipeline", commands, negated };
  }

  #command(): Command {
    const start = this.cursor.offset();
    const line = this.cursor.lineAt(start);
    if (this.cursor.peekOperator() === "(") {
      this.cursor.advance();
      const body = this.#body();
      this.#expectOperator(")");
      return { kind: "Subshell", body, ...this.#trailing(line) };
    }

    const keyword = this.cursor.peekKeyword();
    if (keyword === "{") {
      this.cursor.advance();
      const body = this.#body();
      this.#expectKeyword("}");
      return { kind: "Group", body, ...this.#trailing(line) };
    }
    if (keyword === "if") return this.#if(line);
    if (keyword === "for") return this.#for(line, start);
    if (keyword !== null && CLOSERS.has(keyword)) throw this.cursor.unexpected();
    if (keyword !== null && REFUSED.has(keyword)) {
      throw new ShellSyntaxError(`\`${keyword}\``, `\`${keyword}\` is not supported`, start);
    }
    return parseSimpleCommand(this.cursor);
  }

  #if(line: number): CompoundCommand {
    this.cursor.advance();
    const clauses: IfClause[] = [this.#clause()];
    let otherwise: Statement[] | null = null;
    for (;;) {
      const keyword = this.cursor.peekKeyword();
      if (keyword === "elif") {
        this.cursor.advance();
        clauses.push(this.#clause());
        continue;
      }
      if (keyword === "else") {
        this.cursor.advance();
        otherwise = this.#body();
      }
      this.#expectKeyword("fi");
      return { kind: "If", clauses, otherwise, ...this.#trailing(line) };
    }
  }

  #clause(): IfClause {
    const condition = this.#body();
    this.#expectKeyword("then");
    return { condition, body: this.#body() };
  }

  #for(line: number, start: number): CompoundCommand {
    this.cursor.advance();
    const name = this.cursor.peekKeyword();
    if (name === null || !IDENTIFIER.test(name)) {
      if (this.cursor.peek()?.type !== "word") throw this.cursor.unexpected();
      throw new ShellSyntaxError("`for`", "`for` needs a variable name", start);
    }
    this.cursor.advance();
    this.cursor.skipNewlines();
    if (this.cursor.peekKeyword() !== "in") {
      throw new ShellSyntaxError(
        "`for`",
        "`for` without `in` (over positional parameters) is not supported",
        start,
      );
    }
    this.cursor.advance();

    const words: Word[] = [];
    for (let token = this.cursor.peek(); token?.type === "word"; token = this.cursor.peek()) {
      words.push(token.word);
      this.cursor.advance();
    }
    const separator = this.cursor.peek();
    if (separator?.type !== "newline" && this.cursor.peekOperator() !== ";") {
      throw this.cursor.unexpected();
    }
    this.cursor.advance();
    this.cursor.skipNewlines();
    this.#expectKeyword("do");
    const body = this.#body();
    this.#expectKeyword("done");
    return { kind: "For", name, words, body, ...this.#trailing(line) };
  }

  /** Redirections after a compound command; a further word is a syntax error. */
  #trailing(line: number): { redirections: Redirection[]; line: number } {
    const redirections: Redirection[] = [];
    for (let next = parseRedirection(this.cursor); next !== null; ) {
      redirections.push(...next);
      next = parseRedirection(this.cursor);
    }
    const token = this.cursor.peek();
    if (token?.type === "word" || this.cursor.peekOperator() === "(") {
      throw this.cursor.unexpected();
    }
    return { redirections, line };
  }

  #expectKeyword(keyword: string): void {
    if (this.cursor.peekKeyword() !== keyword) throw this.#missing(`\`${keyword}\``);
    this.cursor.advance();
  }

  #expectOperator(operator: ")"): void {
    if (this.cursor.peekOperator() !== operator) throw this.#missing(`\`${operator}\``);
    this.cursor.advance();
  }

  #missing(expected: string): ShellSyntaxError {
    if (!this.cursor.done) return this.cursor.unexpected();
    return new ShellSyntaxError(
      "syntax",
      `syntax error: unexpected end of input, expected ${expected}`,
      this.cursor.offset(),
    );
  }
}
