// A leftmost-longest matcher for mawk's regular expressions.
//
// POSIX awk reports the leftmost match and, among those, the longest — `a|ab`
// matches all of "ab". The tree compiles to a small NFA program that runs as a
// Pike VM: one pass over the text, each live state tagged with the earliest
// start that reached it. That is linear in the text for every pattern.

import { literalText, parseRegex, type RegexNode } from "./regex-parse.js";

const CHAR = 0;
const SET = 1;
const SPLIT = 2;
const JUMP = 3;
const BOL = 4;
const EOL = 5;
const MATCH = 6;

/** Program instructions are this many bytes, for the retained-memory check. */
const INSTRUCTION_BYTES = 16;

export interface Match {
  readonly start: number;
  readonly end: number;
}

export interface SearchResult {
  readonly match: Match | null;
  /** The text ended while the match could still change: more input is needed. */
  readonly hitEnd: boolean;
}

class Builder {
  readonly ops: number[] = [];
  readonly first: number[] = [];
  readonly second: number[] = [];
  readonly sets: Uint8Array[] = [];

  emit(op: number, first = 0, second = 0): number {
    this.ops.push(op);
    this.first.push(first);
    this.second.push(second);
    return this.ops.length - 1;
  }

  patch(at: number, first: number, second: number): void {
    this.first[at] = first;
    this.second[at] = second;
  }

  node(node: RegexNode): void {
    switch (node.kind) {
      case "set": {
        const single = singleCode(node.set);
        if (single !== -1) this.emit(CHAR, single);
        else {
          this.sets.push(node.set);
          this.emit(SET, this.sets.length - 1);
        }
        return;
      }
      case "bol":
        this.emit(BOL);
        return;
      case "eol":
        this.emit(EOL);
        return;
      case "empty":
        return;
      case "concat":
        for (const item of node.items) this.node(item);
        return;
      case "alt": {
        const jumps: number[] = [];
        node.items.forEach((item, index) => {
          if (index === node.items.length - 1) {
            this.node(item);
            return;
          }
          const split = this.emit(SPLIT);
          this.node(item);
          jumps.push(this.emit(JUMP));
          this.patch(split, split + 1, this.ops.length);
        });
        for (const jump of jumps) this.patch(jump, this.ops.length, 0);
        return;
      }
      case "repeat":
        this.repeat(node.node, node.min, node.max);
        return;
    }
  }

  private repeat(node: RegexNode, min: number, max: number): void {
    for (let count = 0; count < min; count++) this.node(node);
    if (max === Infinity) {
      const split = this.emit(SPLIT);
      this.node(node);
      this.emit(JUMP, split);
      this.patch(split, split + 1, this.ops.length);
      return;
    }
    const splits: number[] = [];
    for (let count = min; count < max; count++) {
      splits.push(this.emit(SPLIT));
      this.node(node);
    }
    for (const split of splits) this.patch(split, split + 1, this.ops.length);
  }
}

function singleCode(set: Uint8Array): number {
  let only = -1;
  for (let code = 0; code < 256; code++) {
    if (set[code] !== 1) continue;
    if (only !== -1) return -1;
    only = code;
  }
  return only;
}

/** Instructions a tree compiles to, counted before building so a huge interval is refused first. */
function programSize(node: RegexNode): number {
  switch (node.kind) {
    case "set":
    case "bol":
    case "eol":
      return 1;
    case "empty":
      return 0;
    case "concat":
      return node.items.reduce((sum, item) => sum + programSize(item), 0);
    case "alt":
      return node.items.reduce((sum, item) => sum + programSize(item) + 2, 0);
    case "repeat": {
      const inner = programSize(node.node);
      const copies = node.max === Infinity ? node.min + 1 : node.max;
      return inner * copies + (node.max === Infinity ? 2 : node.max - node.min);
    }
  }
}

export class Regex {
  readonly #ops: Uint8Array;
  readonly #first: Int32Array;
  readonly #second: Int32Array;
  readonly #sets: readonly Uint8Array[];
  readonly #literal: string | null;
  /** Characters that can begin a match, when nothing but a character can. */
  readonly #leading: Uint8Array | null;
  readonly #current: ThreadList;
  readonly #next: ThreadList;
  #best: Match | null = null;
  #hitEnd = false;

  /** `guard` sees the program's size in bytes before it is built. */
  constructor(
    readonly source: string,
    guard: (bytes: number) => void,
  ) {
    const tree = parseRegex(source);
    guard((programSize(tree) + 1) * INSTRUCTION_BYTES);
    this.#literal = literalText(tree);
    const builder = new Builder();
    builder.node(tree);
    builder.emit(MATCH);
    this.#ops = Uint8Array.from(builder.ops);
    this.#first = Int32Array.from(builder.first);
    this.#second = Int32Array.from(builder.second);
    this.#sets = builder.sets;
    this.#current = new ThreadList(this.#ops.length);
    this.#next = new ThreadList(this.#ops.length);
    this.#leading = this.#leadingSet();
  }

  /** Whether this is the empty regular expression, which `split` treats as per-character. */
  get empty(): boolean {
    return this.source.length === 0;
  }

  test(text: string): boolean {
    return this.search(text, 0, true, true).match !== null;
  }

  /** The leftmost-longest match at or after `from`. `^` holds only at 0 with `atStart`. */
  search(text: string, from: number, atStart: boolean, final: boolean): SearchResult {
    if (this.#literal !== null && final) {
      const at = text.indexOf(this.#literal, from);
      return {
        match: at === -1 ? null : { start: at, end: at + this.#literal.length },
        hitEnd: false,
      };
    }
    this.#best = null;
    this.#hitEnd = false;
    let current = this.#current;
    let next = this.#next;
    let position = from;
    current.clear();
    this.#add(current, 0, position, position, text, atStart, final);
    for (;;) {
      if (current.size === 0) {
        if (this.#best !== null || position >= text.length) break;
        position = this.#skip(text, position + 1);
        current.clear();
        this.#add(current, 0, position, position, text, atStart, final);
        continue;
      }
      if (position >= text.length) {
        if (!final) this.#hitEnd = true;
        break;
      }
      const code = text.charCodeAt(position);
      next.clear();
      const bestStart = this.#bestStart();
      for (let index = 0; index < current.size; index++) {
        const pc = current.states[index] ?? 0;
        const start = current.starts[index] ?? 0;
        if (start > bestStart) continue;
        const op = this.#ops[pc];
        const argument = this.#first[pc] ?? 0;
        const matches = op === CHAR ? argument === code : this.#sets[argument]?.[code] === 1;
        if (matches) this.#add(next, pc + 1, start, position + 1, text, atStart, final);
      }
      if (this.#best === null) {
        this.#add(next, 0, position + 1, position + 1, text, atStart, final);
      }
      const swap = current;
      current = next;
      next = swap;
      position++;
    }
    if (!final && this.#best === null) this.#hitEnd = true;
    return { match: this.#best, hitEnd: this.#hitEnd };
  }

  /** Read through a method: `#add` updates the best match behind the type checker's back. */
  #bestStart(): number {
    return this.#best?.start ?? Number.POSITIVE_INFINITY;
  }

  #skip(text: string, position: number): number {
    const leading = this.#leading;
    if (leading === null) return position;
    let at = position;
    while (at < text.length && leading[text.charCodeAt(at)] !== 1) at++;
    return at;
  }

  #add(
    list: ThreadList,
    entry: number,
    start: number,
    position: number,
    text: string,
    atStart: boolean,
    final: boolean,
  ): void {
    const stack = [entry];
    while (stack.length > 0) {
      const pc = stack.pop() ?? 0;
      if (!list.visit(pc)) continue;
      switch (this.#ops[pc]) {
        case JUMP:
          stack.push(this.#first[pc] ?? 0);
          break;
        case SPLIT:
          stack.push(this.#second[pc] ?? 0, this.#first[pc] ?? 0);
          break;
        case BOL:
          if (position === 0 && atStart) stack.push(pc + 1);
          break;
        case EOL:
          if (position === text.length) {
            if (final) stack.push(pc + 1);
            else this.#hitEnd = true;
          }
          break;
        case MATCH: {
          const best = this.#best;
          if (
            best === null ||
            start < best.start ||
            (start === best.start && position > best.end)
          ) {
            this.#best = { start, end: position };
          }
          break;
        }
        default:
          list.push(pc, start);
      }
    }
  }

  /** The first-character set when every path from the start must consume one. */
  #leadingSet(): Uint8Array | null {
    const set = new Uint8Array(256);
    const seen = new Uint8Array(this.#ops.length);
    const stack = [0];
    while (stack.length > 0) {
      const pc = stack.pop() ?? 0;
      if (seen[pc] === 1) continue;
      seen[pc] = 1;
      switch (this.#ops[pc]) {
        case JUMP:
          stack.push(this.#first[pc] ?? 0);
          break;
        case SPLIT:
          stack.push(this.#first[pc] ?? 0, this.#second[pc] ?? 0);
          break;
        case BOL:
          break;
        case CHAR:
          set[this.#first[pc] ?? 0] = 1;
          break;
        case SET: {
          const members = this.#sets[this.#first[pc] ?? 0];
          if (members !== undefined)
            for (let code = 0; code < 256; code++) set[code] ||= members[code] ?? 0;
          break;
        }
        default:
          return null;
      }
    }
    return set;
  }
}

/** A set of NFA states, in insertion order, with the start each was reached from. */
class ThreadList {
  readonly states: Int32Array;
  readonly starts: Float64Array;
  readonly #stamp: Uint32Array;
  #generation = 0;
  size = 0;

  constructor(capacity: number) {
    this.states = new Int32Array(capacity);
    this.starts = new Float64Array(capacity);
    this.#stamp = new Uint32Array(capacity);
  }

  clear(): void {
    this.size = 0;
    this.#generation++;
    if (this.#generation === 0xffffffff) {
      this.#stamp.fill(0);
      this.#generation = 1;
    }
  }

  /** False when `pc` was already reached in this step, by an earlier (leftmost) start. */
  visit(pc: number): boolean {
    if (this.#stamp[pc] === this.#generation) return false;
    this.#stamp[pc] = this.#generation;
    return true;
  }

  push(pc: number, start: number): void {
    this.states[this.size] = pc;
    this.starts[this.size] = start;
    this.size++;
  }
}
