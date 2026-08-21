// Tokens to a Script. The grammar is flat on purpose — statements joined by
// `&&`/`||`/`;`, each a pipeline of simple commands — because the corpus has
// no nesting to represent: `&&` outside a leading `cd` appears twice in 614
// lines and control flow five times, and both are rejected in the lexer.

import {
  type Pipeline,
  type Redirection,
  type Script,
  ShellSyntaxError,
  type SimpleCommand,
  type Statement,
  type Word,
} from "./ast.js";
import { type Token, tokenize } from "./lexer.js";

export function parse(source: string): Script {
  return new Parser(tokenize(source)).script();
}

/**
 * Words that would open a compound command, rejected in §2 of the plan.
 *
 * Checked here rather than in the lexer because they are reserved *in
 * command position only*: `echo done` and `xargs echo for` are ordinary
 * lines, and a lexer that rejected the word wherever it appeared broke both.
 */
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
]);

class Parser {
  #index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  script(): Script {
    const statements: Statement[] = [];
    while (this.#index < this.tokens.length) {
      const pipeline = this.#pipeline();
      const connector = this.#connector();
      statements.push({ kind: "Statement", pipeline, connector });
      if (connector === null) break;
    }
    if (this.#index < this.tokens.length) {
      const token = this.tokens[this.#index];
      throw new ShellSyntaxError("statement", "unexpected token", token?.offset ?? 0);
    }
    return { kind: "Script", statements };
  }

  #connector(): "&&" | "||" | ";" | null {
    const token = this.tokens[this.#index];
    if (token?.type !== "op") return null;
    if (token.value !== "&&" && token.value !== "||" && token.value !== ";") return null;
    this.#index++;
    // A trailing `;` ends the script rather than promising another statement.
    return this.#index >= this.tokens.length ? null : token.value;
  }

  #pipeline(): Pipeline {
    const commands: SimpleCommand[] = [this.#command()];
    while (this.#peekOperator() === "|") {
      this.#index++;
      commands.push(this.#command());
    }
    return { kind: "Pipeline", commands };
  }

  #command(): SimpleCommand {
    const words: Word[] = [];
    const redirections: Redirection[] = [];
    const start = this.tokens[this.#index]?.offset ?? 0;

    for (;;) {
      const token = this.tokens[this.#index];
      if (token === undefined) break;

      if (token.type === "word") {
        words.push(token.word);
        this.#index++;
        continue;
      }

      if (token.type === "fd") {
        this.#index++;
        redirections.push(this.#redirection(token.value, token.offset));
        continue;
      }

      if (
        token.value === ">" ||
        token.value === ">>" ||
        token.value === "<" ||
        token.value === ">&"
      ) {
        // No explicit fd: `<` reads stdin, everything else writes stdout.
        redirections.push(this.#redirection(token.value === "<" ? 0 : 1, token.offset));
        continue;
      }

      break; // `|`, `&&`, `||`, `;` end the command.
    }

    const name = words[0];
    if (name === undefined) {
      throw new ShellSyntaxError("command", "missing command name", start);
    }
    if (name.parts.every((part) => part.kind === "Literal")) {
      const text = name.parts.map((part) => part.value).join("");
      if (RESERVED.has(text)) {
        throw new ShellSyntaxError(`\`${text}\``, `\`${text}\` is not supported`, start);
      }
    }
    return { kind: "SimpleCommand", words, redirections };
  }

  #redirection(fd: number, offset: number): Redirection {
    const operator = this.tokens[this.#index];
    if (operator?.type !== "op") {
      throw new ShellSyntaxError("redirection", "expected a redirection operator", offset);
    }
    this.#index++;

    if (operator.value === ">&") {
      const target = this.tokens[this.#index];
      if (target?.type !== "word") {
        throw new ShellSyntaxError("redirection", "expected a descriptor after >&", offset);
      }
      const text = target.word.parts.map((part) => part.value).join("");
      if (!/^[0-9]+$/.test(text)) {
        throw new ShellSyntaxError("redirection", `\`>&${text}\` is not a descriptor`, offset);
      }
      this.#index++;
      return { kind: "Redirection", fd, op: ">&", targetFd: Number(text) };
    }

    if (operator.value !== ">" && operator.value !== ">>" && operator.value !== "<") {
      throw new ShellSyntaxError("redirection", "expected a redirection operator", offset);
    }

    const target = this.tokens[this.#index];
    if (target?.type !== "word") {
      throw new ShellSyntaxError("redirection", "expected a target after the operator", offset);
    }
    this.#index++;
    return { kind: "Redirection", fd, op: operator.value, target: target.word };
  }

  #peekOperator(): string | null {
    const token = this.tokens[this.#index];
    return token?.type === "op" ? token.value : null;
  }
}
