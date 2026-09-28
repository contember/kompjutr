// awk programs and statements, and the checks mawk makes after parsing:
// every called function defined, arguments typed against parameters, and —
// ours alone — no recursion. With loops limited to `for (k in a)` and a
// non-recursive call graph, every program's work is bounded by its input.

import { AwkSyntaxError } from "../errors.js";
import type { Expr, FunctionDefinition, Program, Rule, Slot, Statement } from "./ast.js";
import { scan } from "./lexer.js";
import type { SymbolEntry } from "./parse-base.js";
import { CallParser, GETLINE_REFUSAL } from "./parse-calls.js";
import type { Token } from "./tokens.js";

const LOOP_REFUSAL = "has no structural bound: only `for (key in array)' loops are supported";

interface FunctionState {
  readonly definition: FunctionDefinition;
  readonly locals: Map<string, SymbolEntry>;
}

class ProgramParser extends CallParser {
  readonly begin: Statement[] = [];
  readonly end: Statement[] = [];
  readonly rules: Rule[] = [];
  readonly functions = new Map<string, FunctionState>();

  program(): Program {
    while (!this.is("eof")) this.item();
    this.resolve();
    const functions = new Map<string, FunctionDefinition>();
    for (const [name, state] of this.functions) functions.set(name, state.definition);
    return {
      begin: this.begin,
      end: this.end,
      rules: this.rules,
      functions,
      globals: this.globalList.map((entry) => ({
        name: entry.name,
        array: entry.kind === "array",
      })),
    };
  }

  private item(): void {
    const token = this.token;
    if (token.kind === "keyword" && (token.value === "BEGIN" || token.value === "END")) {
      this.advance();
      this.scope = token.value === "BEGIN" ? "begin" : "end";
      if (!this.is("{")) throw this.syntaxError();
      (token.value === "BEGIN" ? this.begin : this.end).push(this.block());
      this.scope = "main";
      return;
    }
    if (token.kind === "keyword" && token.value === "function") {
      this.functionDefinition();
      return;
    }
    if (token.kind === "{") {
      this.rules.push({ pattern: null, action: this.block() });
      return;
    }
    const from = this.expression();
    let pattern: Rule["pattern"] = { kind: "expr", expr: from };
    if (this.is(",")) {
      this.advance();
      pattern = { kind: "range", from, to: this.expression() };
    }
    if (this.is("{")) {
      this.rules.push({ pattern, action: this.block() });
      return;
    }
    if (!this.is("newline") && !this.is(";")) throw this.syntaxError();
    this.advance();
    this.rules.push({ pattern, action: null });
  }

  private functionDefinition(): void {
    this.advance();
    const name = this.token;
    if (name.kind !== "funcname") throw this.syntaxError();
    this.advance();
    if (this.functions.has(name.value)) throw this.error(`redefinition of ${name.value}`, name);
    this.expect("(");
    const locals = new Map<string, SymbolEntry>();
    const params: string[] = [];
    while (this.is("name")) {
      const param = this.advance();
      if (locals.has(param.value)) {
        throw this.error(`${param.value} is duplicated in argument list`, param);
      }
      locals.set(param.value, { name: param.value, index: params.length, kind: "none" });
      params.push(param.value);
      if (!this.is(",")) break;
      this.advance();
    }
    this.expect(")");
    if (!this.is("{")) throw this.syntaxError();
    this.locals = locals;
    this.scope = "function";
    this.currentFunction = name.value;
    const body = this.block();
    const definition: FunctionDefinition = {
      name: name.value,
      params,
      arrays: params.map(() => false),
      body,
    };
    this.functions.set(name.value, { definition, locals });
    this.locals = null;
    this.scope = "main";
    this.currentFunction = null;
  }

  block(): Statement {
    this.expect("{");
    const body: Statement[] = [];
    while (!this.is("}")) {
      if (this.is("eof")) throw this.syntaxError();
      body.push(this.statement());
    }
    this.advance();
    return { kind: "block", body };
  }

  private separator(): void {
    if (this.is("newline") || this.is(";") || this.is("fake;")) {
      this.advance();
      return;
    }
    if (this.is("|") && this.peek(1).kind === "keyword" && this.peek(1).value === "getline") {
      throw this.refuse(GETLINE_REFUSAL, this.peek(1));
    }
    throw this.syntaxError();
  }

  private statement(): Statement {
    const token = this.token;
    switch (token.kind) {
      case "{":
        return this.block();
      case "newline":
      case ";":
      case "fake;":
        this.advance();
        return { kind: "empty" };
      case "keyword":
        return this.keywordStatement(token);
      default: {
        const expr = this.expression();
        this.separator();
        return { kind: "expr", expr };
      }
    }
  }

  private keywordStatement(token: Token): Statement {
    switch (token.value) {
      case "if":
        return this.ifStatement();
      case "for":
        return this.forStatement();
      case "while":
        throw this.refuse(`\`while' ${LOOP_REFUSAL}`);
      case "do":
        throw this.refuse(`\`do' ${LOOP_REFUSAL}`);
      case "print":
      case "printf":
        return this.printStatement(token);
      case "delete": {
        this.advance();
        const name = this.expect("name");
        const array = this.useArray(name.value, name);
        let subscripts: Expr[] | null = null;
        if (this.is("[")) {
          this.advance();
          subscripts = this.list("]");
        }
        this.separator();
        return { kind: "delete", array, subscripts };
      }
      case "exit":
      case "return": {
        this.advance();
        if (token.value === "return" && this.scope !== "function") {
          throw this.error("return outside function body", token);
        }
        const value =
          this.is("newline") || this.is(";") || this.is("fake;") ? null : this.expression();
        this.separator();
        return { kind: token.value === "exit" ? "exit" : "return", value };
      }
      case "next":
      case "nextfile": {
        this.advance();
        if (this.scope !== "main") throw this.error(`improper use of ${token.value}`, token);
        this.separator();
        return { kind: token.value === "next" ? "next" : "nextfile" };
      }
      case "break":
      case "continue": {
        this.advance();
        if (this.loopDepth === 0)
          throw this.error(`${token.value} statement outside of loop`, token);
        this.separator();
        return { kind: token.value === "break" ? "break" : "continue" };
      }
      case "getline":
        throw this.refuse(GETLINE_REFUSAL);
      case "length":
      case "split":
      case "sub":
      case "gsub":
      case "match": {
        const expr = this.expression();
        this.separator();
        return { kind: "expr", expr };
      }
      default:
        throw this.syntaxError();
    }
  }

  private ifStatement(): Statement {
    this.advance();
    this.expect("(");
    const test = this.expression();
    this.expect(")");
    const then = this.statement();
    if (!this.isKeyword("else")) return { kind: "if", test, then, otherwise: null };
    this.advance();
    return { kind: "if", test, then, otherwise: this.statement() };
  }

  private forStatement(): Statement {
    const start = this.advance();
    this.expect("(");
    const variable = this.token;
    const isForIn =
      variable.kind === "name" && this.peek(1).kind === "keyword" && this.peek(1).value === "in";
    if (!isForIn) throw this.refuse(`C-style \`for' ${LOOP_REFUSAL}`, start);
    this.advance();
    this.advance();
    const name = this.expect("name");
    this.expect(")");
    const ref = this.useScalar(variable.value, variable);
    const array = this.useArray(name.value, name);
    this.loopDepth++;
    const body = this.statement();
    this.loopDepth--;
    return { kind: "forIn", variable: ref, array, body };
  }

  private printStatement(token: Token): Statement {
    this.advance();
    let args: Expr[] = [];
    if (this.is("(") && this.groupedArguments()) {
      this.advance();
      if (this.is(")")) this.advance();
      else args = this.list(")");
    } else if (!this.endsPrint()) {
      args.push(this.expression());
      while (this.is(",")) {
        this.advance();
        args.push(this.expression());
      }
    }
    if (this.is("redirect")) {
      throw this.refuse(
        this.token.value === "|"
          ? "output pipes are not supported: awk cannot run commands"
          : "output redirection is not supported: print writes to standard output only",
      );
    }
    this.separator();
    if (token.value === "printf") {
      if (args.length === 0) throw this.error("no arguments in call to printf", token);
      return { kind: "printf", args };
    }
    return { kind: "print", args };
  }

  private endsPrint(): boolean {
    return ["newline", ";", "fake;", "redirect", "}"].includes(this.token.kind);
  }

  /** Whether the `(` at the cursor wraps the whole argument list, as in `print (a, b) > f`. */
  private groupedArguments(): boolean {
    let depth = 0;
    for (let offset = 0; ; offset++) {
      const token = this.peek(offset);
      if (token.kind === "eof") return false;
      if (token.kind === "(") depth++;
      else if (token.kind === ")" && --depth === 0) {
        const after = this.peek(offset + 1).kind;
        return ["newline", ";", "fake;", "redirect", "}"].includes(after);
      }
    }
  }

  /** Checks after parsing: calls, argument types, and the refusal of recursion. */
  private resolve(): void {
    const eof = this.tokens[this.tokens.length - 1];
    for (const call of this.calls) {
      const callee = this.functions.get(call.name);
      if (callee === undefined) {
        throw new AwkSyntaxError(eof?.line ?? call.line, `function ${call.name} never defined`);
      }
      if (call.args.length > callee.definition.params.length) {
        throw this.error(`too many arguments in call to ${call.name}`, call.token);
      }
    }
    this.refuseRecursion();
    this.typeArguments();
    for (const state of this.functions.values()) {
      state.definition.params.forEach((param, index) => {
        state.definition.arrays[index] = state.locals.get(param)?.kind === "array";
      });
    }
  }

  private refuseRecursion(): void {
    const edges = new Map<string, PendingCallEdge[]>();
    for (const call of this.calls) {
      if (call.caller === null) continue;
      const list = edges.get(call.caller) ?? [];
      list.push({ callee: call.name, token: call.token });
      edges.set(call.caller, list);
    }
    const done = new Set<string>();
    const path: string[] = [];
    const visit = (name: string): void => {
      if (done.has(name)) return;
      path.push(name);
      for (const edge of edges.get(name) ?? []) {
        const cycleStart = path.indexOf(edge.callee);
        if (cycleStart !== -1) {
          const cycle = [...path.slice(cycleStart), edge.callee].join(" -> ");
          throw this.refuse(
            `recursive function calls are not supported: ${cycle} has no structural bound`,
            edge.token,
          );
        }
        visit(edge.callee);
      }
      path.pop();
      done.add(name);
    };
    for (const name of this.functions.keys()) visit(name);
  }

  /** Propagate array-ness through bare-name arguments until nothing changes. */
  private typeArguments(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const call of this.calls) {
        const callee = this.functions.get(call.name);
        if (callee === undefined) continue;
        call.args.forEach((arg, index) => {
          const param = callee.locals.get(callee.definition.params[index] ?? "");
          if (param === undefined) return;
          const entry = arg.kind === "name" ? this.entryOf(arg.slot, call.caller) : null;
          const argKind = arg.kind === "expr" ? "scalar" : (entry?.kind ?? "none");
          if (param.kind !== "none" && argKind !== "none" && param.kind !== argKind) {
            throw this.error(`type error in arg(${index + 1}) in call to ${call.name}`, call.token);
          }
          if (param.kind === "none" && argKind !== "none") {
            param.kind = argKind;
            changed = true;
          } else if (entry !== null && entry.kind === "none" && param.kind !== "none") {
            entry.kind = param.kind;
            changed = true;
          }
        });
      }
    }
  }

  private entryOf(slot: Slot, caller: string | null): SymbolEntry | null {
    if (slot.scope === "global") return this.globalList[slot.index] ?? null;
    if (caller === null) return null;
    return this.functions.get(caller)?.locals.get(slot.name) ?? null;
  }
}

interface PendingCallEdge {
  readonly callee: string;
  readonly token: Token;
}

/**
 * Parse a program. `scalars` are the names `-v` assigned before parsing,
 * which mawk has already made variables.
 */
export function parseProgram(source: string, scalars: readonly string[]): Program {
  const parser = new ProgramParser(scan(source), scalars);
  return parser.program();
}
