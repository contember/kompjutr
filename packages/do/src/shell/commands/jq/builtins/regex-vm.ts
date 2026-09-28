// A Pike VM: the pattern runs as a set of threads stepped once per code
// point, so matching costs O(text × program) whatever the pattern. Thread
// order carries priority, which gives the leftmost-first, greedy-or-lazy
// result a backtracking engine such as Oniguruma returns, captures included.
// A backtracking engine can take exponential time and JavaScript's has no
// limit; this one cannot.

import { JqRefusal } from "../errors.js";
import { type Assertion, RegexFailure, type RegexNode, WORD_CLASS } from "./regex-syntax.js";

type Instruction =
  | { readonly op: "char"; readonly test: (code: number) => boolean }
  | { readonly op: "split"; readonly first: number; readonly second: number }
  | { readonly op: "jump"; readonly to: number }
  | { readonly op: "save"; readonly slot: number }
  | { readonly op: "assert"; readonly assertion: Assertion }
  | { readonly op: "loop"; readonly slot: number; readonly head: number; readonly exit: number }
  | { readonly op: "match" };

export interface Program {
  readonly code: readonly Instruction[];
  readonly slots: number;
  /** Per instruction, the register of its innermost unbounded loop, or -1. */
  readonly loops: Int32Array;
}

/** Bytes charged per instruction: the program is held for the whole match. */
export const INSTRUCTION_BYTES = 32;

export function compileProgram(
  root: RegexNode,
  groups: number,
  ignoreCase: boolean,
  charge: (bytes: number) => void,
): Program {
  const code: Instruction[] = [];
  const captureSlots = (groups + 1) * 2;
  let registers = captureSlots;
  const matchers = new Map<string, (code: number) => boolean>();
  const loops: number[] = [];
  const enclosing: number[] = [];
  const emit = (instruction: Instruction): number => {
    if (code.length % 1024 === 0) charge(1024 * INSTRUCTION_BYTES);
    code.push(instruction);
    loops.push(enclosing[enclosing.length - 1] ?? -1);
    return code.length - 1;
  };
  const patch = (at: number, instruction: Instruction): void => {
    code[at] = instruction;
  };
  const matcher = (source: string): ((code: number) => boolean) => {
    const cached = matchers.get(source);
    if (cached !== undefined) return cached;
    const regex = characterRegex(source, ignoreCase);
    const seen = new Map<number, boolean>();
    const test = (point: number): boolean => {
      let result = seen.get(point);
      if (result === undefined) {
        result = regex.test(String.fromCodePoint(point));
        seen.set(point, result);
      }
      return result;
    };
    matchers.set(source, test);
    return test;
  };

  const compile = (node: RegexNode): void => {
    switch (node.kind) {
      case "char":
        emit({ op: "char", test: matcher(node.source) });
        return;
      case "any":
        emit({ op: "char", test: node.newline ? () => true : (point) => point !== 0x0a });
        return;
      case "assert":
        emit({ op: "assert", assertion: node.assertion });
        return;
      case "concat":
        for (const item of node.items) compile(item);
        return;
      case "alt": {
        const exits: number[] = [];
        node.items.forEach((item, index) => {
          if (index === node.items.length - 1) {
            compile(item);
            return;
          }
          const split = emit({ op: "jump", to: -1 });
          compile(item);
          exits.push(emit({ op: "jump", to: -1 }));
          patch(split, { op: "split", first: split + 1, second: code.length });
        });
        for (const exit of exits) patch(exit, { op: "jump", to: code.length });
        return;
      }
      case "group":
        emit({ op: "save", slot: node.index * 2 });
        compile(node.node);
        emit({ op: "save", slot: node.index * 2 + 1 });
        return;
      case "repeat":
        for (let count = 0; count < node.min; count++) compile(node.node);
        if (node.max === null) {
          // An iteration that consumed nothing leaves the loop, as Oniguruma's
          // empty check does; the register remembers where it began.
          const slot = registers++;
          const loop = emit({ op: "jump", to: -1 });
          emit({ op: "save", slot });
          enclosing.push(slot);
          compile(node.node);
          const check = emit({ op: "jump", to: -1 });
          enclosing.pop();
          patch(loop, branch(node.lazy, loop + 1, code.length));
          patch(check, { op: "loop", slot, head: loop, exit: code.length });
          return;
        }
        {
          const skips: number[] = [];
          for (let count = node.min; count < node.max; count++) {
            skips.push(emit({ op: "jump", to: -1 }));
            compile(node.node);
          }
          for (const skip of skips) patch(skip, branch(node.lazy, skip + 1, code.length));
        }
        return;
    }
  };

  emit({ op: "save", slot: 0 });
  compile(root);
  emit({ op: "save", slot: 1 });
  emit({ op: "match" });
  return { code, slots: registers, loops: Int32Array.from(loops) };
}

/** A one-code-point test; a class JavaScript rejects fails as Oniguruma would or is refused. */
function characterRegex(source: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(`^(?:${source})$`, ignoreCase ? "ui" : "u");
  } catch (error) {
    if (error instanceof SyntaxError && error.message.includes("Range out of order")) {
      throw new RegexFailure("empty range in char class");
    }
    throw new JqRefusal(`regex character class ${source} is not supported`);
  }
}

function branch(lazy: boolean, body: number, exit: number): Instruction {
  return lazy
    ? { op: "split", first: exit, second: body }
    : { op: "split", first: body, second: exit };
}

interface Thread {
  readonly pc: number;
  readonly caps: Int32Array;
}

interface ThreadList {
  readonly threads: Thread[];
  readonly generation: number;
}

export class Matcher {
  readonly #marks: Uint32Array;
  #generation = 0;
  readonly #isWord: (point: number) => boolean;

  constructor(
    private readonly program: Program,
    private readonly text: readonly number[],
  ) {
    this.#marks = new Uint32Array(program.code.length * 2);
    const word = new RegExp(`^${WORD_CLASS}$`, "u");
    const seen = new Map<number, boolean>();
    this.#isWord = (point) => {
      let result = seen.get(point);
      if (result === undefined) {
        result = word.test(String.fromCodePoint(point));
        seen.set(point, result);
      }
      return result;
    };
  }

  /**
   * An empty match between the bytes of the code point before `from`, where
   * jq resumes after an empty match; nothing can be consumed there.
   */
  matchInside(from: number, notEmpty: boolean): Int32Array | null {
    if (notEmpty) return null;
    const list = this.#list();
    this.#add(list, 0, this.#fresh(), from, true);
    for (const thread of list.threads) {
      if (this.program.code[thread.pc]?.op === "match") return thread.caps;
    }
    return null;
  }

  /** The leftmost match at or after `from`, as capture slots in code points. */
  search(from: number, notEmpty: boolean): Int32Array | null {
    const text = this.text;
    let current = this.#list();
    let matched: Int32Array | null = null;
    for (let position = from; ; position++) {
      if (matched === null) this.#add(current, 0, this.#fresh(), position, false);
      const next = this.#list();
      for (const thread of current.threads) {
        const instruction = this.program.code[thread.pc];
        if (instruction?.op === "match") {
          if (notEmpty && thread.caps[0] === thread.caps[1]) continue;
          matched = thread.caps;
          break;
        }
        if (
          instruction?.op === "char" &&
          position < text.length &&
          instruction.test(text[position] ?? 0)
        ) {
          this.#add(next, thread.pc + 1, thread.caps, position + 1, false);
        }
      }
      if (position >= text.length) break;
      current = next;
      if (current.threads.length === 0 && matched !== null) break;
    }
    return matched;
  }

  #list(): ThreadList {
    this.#generation++;
    return { threads: [], generation: this.#generation };
  }

  #fresh(): Int32Array {
    return new Int32Array(this.program.slots).fill(-1);
  }

  /** Follows jumps, splits, saves, and assertions in priority order. */
  #add(list: ThreadList, pc: number, caps: Int32Array, position: number, inside: boolean): void {
    const stack: Thread[] = [{ pc, caps }];
    const code = this.program.code;
    for (let thread = stack.pop(); thread !== undefined; thread = stack.pop()) {
      // A state inside a loop is also keyed by whether its iteration has
      // consumed anything yet: an iteration that starts here and one that
      // arrives here after consuming continue differently at the loop check.
      const loop = this.program.loops[thread.pc] ?? -1;
      const fresh = loop >= 0 && thread.caps[loop] === position ? 1 : 0;
      const mark = thread.pc * 2 + fresh;
      if (this.#marks[mark] === list.generation) continue;
      this.#marks[mark] = list.generation;
      const instruction = code[thread.pc];
      if (instruction === undefined) continue;
      switch (instruction.op) {
        case "jump":
          stack.push({ pc: instruction.to, caps: thread.caps });
          break;
        case "split":
          stack.push({ pc: instruction.second, caps: thread.caps });
          stack.push({ pc: instruction.first, caps: thread.caps });
          break;
        case "save": {
          const saved = thread.caps.slice();
          saved[instruction.slot] = position;
          stack.push({ pc: thread.pc + 1, caps: saved });
          break;
        }
        case "loop":
          stack.push({
            pc: thread.caps[instruction.slot] === position ? instruction.exit : instruction.head,
            caps: thread.caps,
          });
          break;
        case "assert":
          if (this.#holds(instruction.assertion, position, inside)) {
            stack.push({ pc: thread.pc + 1, caps: thread.caps });
          }
          break;
        default:
          list.threads.push(thread);
      }
    }
  }

  #holds(assertion: Assertion, position: number, inside: boolean): boolean {
    const text = this.text;
    if (inside) {
      // Between the bytes of one code point: no edge, and both sides are that code point.
      return assertion === "not-word";
    }
    switch (assertion) {
      case "start":
        return position === 0;
      case "end":
        return position === text.length;
      case "end-newline":
        return (
          position === text.length || (position === text.length - 1 && text[position] === 0x0a)
        );
      case "word":
      case "not-word": {
        const before = position > 0 && this.#isWord(text[position - 1] ?? 0);
        const after = position < text.length && this.#isWord(text[position] ?? 0);
        return (before !== after) === (assertion === "word");
      }
    }
  }
}
