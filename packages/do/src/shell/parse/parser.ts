// Tokens to a Script. The grammar is flat on purpose — statements joined by
// `&&`/`||`/`;` or a newline, each a pipeline of simple commands — because the
// corpus has no nesting to represent: `&&` outside a leading `cd` appears twice
// in 614 lines and control flow five times, and both are rejected.

import {
  type Pipeline,
  type Redirection,
  type Script,
  ShellSyntaxError,
  type SimpleCommand,
  type Statement,
  type Word,
  wordText,
} from "./ast.js";
import { type Operator, type Token, tokenize } from "./lexer.js";

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
    this.#skipNewlines();
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

  /** A newline separates statements exactly as `;` does. */
  #connector(): "&&" | "||" | ";" | null {
    const token = this.tokens[this.#index];
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
    this.#index++;
    this.#skipNewlines();
    if (this.#index < this.tokens.length) return connector;
    if (connector !== ";") {
      throw new ShellSyntaxError(
        "statement",
        `expected a command after \`${connector}\``,
        token.offset,
      );
    }
    // A trailing `;` or newline ends the script rather than promising another statement.
    return null;
  }

  #pipeline(): Pipeline {
    let negated = false;
    while (this.#peekBang()) {
      negated = !negated;
      this.#index++;
    }
    const commands: SimpleCommand[] = [this.#command()];
    while (this.#peekOperator() === "|") {
      this.#index++;
      this.#skipNewlines();
      commands.push(this.#command());
    }
    return { kind: "Pipeline", commands, negated };
  }

  /** Only a bare `!` word negates; `!x` is an ordinary word. */
  #peekBang(): boolean {
    const token = this.tokens[this.#index];
    if (token?.type !== "word") return false;
    const [part, ...rest] = token.word.parts;
    return rest.length === 0 && part?.kind === "Literal" && part.value === "!";
  }

  #skipNewlines(): void {
    while (this.tokens[this.#index]?.type === "newline") this.#index++;
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

      if (token.type === "op" && isRedirectionOperator(token.value)) {
        // No explicit fd: the `<` family reads stdin, everything else writes stdout.
        redirections.push(this.#redirection(token.value.startsWith("<") ? 0 : 1, token.offset));
        continue;
      }

      break; // `|`, `&&`, `||`, `;`, and a newline end the command.
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
      if (target.word.parts.some((part) => part.kind === "Parameter")) {
        throw new ShellSyntaxError(
          "parameter expansion",
          "parameters in redirection targets are not supported",
          target.offset,
        );
      }
      const text = wordText(target.word);
      if (!/^[0-9]+$/.test(text)) {
        throw new ShellSyntaxError("redirection", `\`>&${text}\` is not a descriptor`, offset);
      }
      this.#index++;
      return { kind: "Redirection", fd, op: ">&", targetFd: Number(text) };
    }

    if (operator.value === "<<" || operator.value === "<<-") {
      const body = this.tokens[this.#index];
      if (body?.type !== "hereDocument") {
        throw new ShellSyntaxError("here-document", "expected a here-document body", offset);
      }
      this.#index++;
      return { kind: "Redirection", fd, op: "<<", body: body.body };
    }

    if (operator.value === "<<<") {
      const target = this.tokens[this.#index];
      if (target?.type !== "word") {
        throw new ShellSyntaxError("redirection", "expected a word after <<<", offset);
      }
      this.#index++;
      return { kind: "Redirection", fd, op: "<<<", target: target.word };
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

function isRedirectionOperator(value: Operator): boolean {
  return value !== "|" && value !== "||" && value !== "&&" && value !== ";";
}
