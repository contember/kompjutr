// Brace expansion, marked. The structure is read here and generation is the
// executor's job, where the argv ceiling bounds it.
//
// This follows Bash's `braces.c`, quirks included. A `{` closes at the first
// `}` reached at its own nesting level after a `,` or `..` at that level; a
// `}` before that is literal and does not unwind the level. A matched body
// with a comma anywhere, even quoted or nested, is split at its top-level
// commas; otherwise it must be a sequence expression, or the `{` is literal
// and the search moves on.
//
// A word is flattened to atoms first: unquoted characters (literal or glob)
// can form brace syntax, quoted parts and parameters cannot.

import { ShellSyntaxError, type WordPart } from "../parse/ast.js";
import type { ArgumentPart, BraceSequence, FlatPart } from "./types.js";

type Atom =
  | { readonly kind: "char"; readonly value: string; readonly glob: boolean }
  /**
   * `quotedComma`: a quoted, not escaped, `,`, which Bash's body check still
   * sees. `escapedBlank`: `\ `, whose raw character Bash reads as a blank.
   */
  | {
      readonly kind: "part";
      readonly part: ArgumentPart;
      readonly quotedComma: boolean;
      readonly escapedBlank: boolean;
    };

/** Alternatives and generation recurse once per level; this keeps both off the stack limit. */
const NESTING_MAX = 64;

const BLANK = new Set([" ", "\t", "\n"]);
const SEQUENCE_CHARACTER = /^[0-9A-Za-z+.-]$/;
const INTMAX = (1n << 63n) - 1n;
const INTMIN = -(1n << 63n);

export function argumentPart(part: WordPart): FlatPart {
  if (part.kind === "Parameter") {
    return { kind: "parameter", name: part.name, quoted: part.quoted };
  }
  if (part.kind === "Glob") return { kind: "glob", value: part.value };
  return { kind: "literal", value: part.value, quoted: part.kind !== "Literal" };
}

/** The parts with brace expressions marked, or null when the word has none. */
export function markBraces(parts: readonly WordPart[]): ArgumentPart[] | null {
  if (!parts.some(mayOpenBrace)) return null;
  const word = new BraceWord(toAtoms(parts));
  const marked = word.mark(0, word.atoms.length, 0);
  if (!marked.some(isBraceNode)) return null;
  return marked;
}

function mayOpenBrace(part: WordPart): boolean {
  return (part.kind === "Literal" || part.kind === "Glob") && part.value.includes("{");
}

function isBraceNode(part: ArgumentPart): boolean {
  return part.kind === "brace" || part.kind === "sequence";
}

function toAtoms(parts: readonly WordPart[]): Atom[] {
  const atoms: Atom[] = [];
  for (const part of parts) {
    if (part.kind === "Literal" || part.kind === "Glob") {
      for (const value of part.value) {
        atoms.push({ kind: "char", value, glob: part.kind === "Glob" });
      }
    } else {
      const quotedComma =
        (part.kind === "SingleQuoted" || part.kind === "DoubleQuoted") && part.value.includes(",");
      const escapedBlank = part.kind === "Escaped" && BLANK.has(part.value);
      atoms.push({ kind: "part", part: argumentPart(part), quotedComma, escapedBlank });
    }
  }
  return atoms;
}

function isChar(atom: Atom | undefined, value: string): boolean {
  return atom?.kind === "char" && atom.value === value;
}

/**
 * Bash scans from each `{` with a floored level counter, which is quadratic
 * when repeated. Its walk is the same from any start, so the level-0
 * positions of every scan are chains of one "next position at or below this
 * level" forest, and each `{`'s close is two lookups along its chain.
 */
class BraceWord {
  /** Next level-0 position of a scan through this one; `length` ends the chain. */
  readonly #next: Int32Array;
  /** First position on the chain from here whose atom is a `,` or counting `..`. */
  readonly #separator: Int32Array;
  /** First position on the chain from here whose atom is `}`. */
  readonly #close: Int32Array;
  /** Commas before each position, quoted or not, for the body check. */
  readonly #commas: Int32Array;

  constructor(readonly atoms: readonly Atom[]) {
    const length = atoms.length;
    const levels = new Int32Array(length + 1);
    this.#commas = new Int32Array(length + 1);
    for (let index = 0; index < length; index++) {
      const atom = atoms[index];
      const delta = isChar(atom, "{") ? 1 : isChar(atom, "}") ? -1 : 0;
      levels[index + 1] = (levels[index] ?? 0) + delta;
      const comma = isChar(atom, ",") || (atom?.kind === "part" && atom.quotedComma);
      this.#commas[index + 1] = (this.#commas[index] ?? 0) + (comma ? 1 : 0);
    }

    this.#next = new Int32Array(length + 1).fill(length);
    const pending: number[] = [];
    for (let index = 0; index <= length; index++) {
      const level = levels[index] ?? 0;
      while (pending.length > 0 && (levels[pending[pending.length - 1] ?? 0] ?? 0) >= level) {
        this.#next[pending.pop() ?? 0] = index;
      }
      pending.push(index);
    }

    this.#separator = new Int32Array(length + 1).fill(-1);
    this.#close = new Int32Array(length + 1).fill(-1);
    for (let index = length - 1; index >= 0; index--) {
      const next = this.#next[index] ?? length;
      this.#separator[index] = this.#separates(index) ? index : (this.#separator[next] ?? -1);
      this.#close[index] = isChar(atoms[index], "}") ? index : (this.#close[next] ?? -1);
    }
  }

  #separates(index: number): boolean {
    const atoms = this.atoms;
    if (isChar(atoms[index], ",")) return true;
    return (
      isChar(atoms[index], ".") && isChar(atoms[index + 1], ".") && !isChar(atoms[index + 2], "}")
    );
  }

  /** Bash passes over a `{` after the text start or a blank when `}` follows it. */
  #opens(index: number, textStart: number): boolean {
    if (!isChar(this.atoms[index], "{")) return false;
    const previous = this.atoms[index - 1];
    const afterBlank = index === textStart || (previous?.kind === "part" && previous.escapedBlank);
    return !(afterBlank && isChar(this.atoms[index + 1], "}"));
  }

  /** The `}` closing the `{` at `open`, or -1. */
  #closing(open: number): number {
    const separator = this.#separator[open + 1] ?? -1;
    return separator === -1 ? -1 : (this.#close[separator] ?? -1);
  }

  /**
   * `textStart` is where Bash's current recursive call begins: a postamble,
   * or the text after a matched `{` whose body did not expand.
   */
  mark(start: number, end: number, depth: number): ArgumentPart[] {
    const parts: ArgumentPart[] = [];
    let literalStart = start;
    let textStart = start;
    let index = start;
    while (index < end) {
      const close = this.#opens(index, textStart) ? this.#closing(index) : -1;
      if (close === -1 || close >= end) {
        index++;
        continue;
      }
      const node = this.#node(index, close, depth);
      if (node === null) {
        index++;
        textStart = index;
        continue;
      }
      parts.push(...toParts(this.atoms, literalStart, index), node);
      index = close + 1;
      literalStart = index;
      textStart = index;
    }
    parts.push(...toParts(this.atoms, literalStart, end));
    return parts;
  }

  #node(open: number, close: number, depth: number): ArgumentPart | null {
    const value = (): string => textOf(this.atoms, open, close + 1);
    if (this.#commas[close] === this.#commas[open + 1]) {
      const sequence = parseSequence(this.atoms, open + 1, close);
      return sequence === null ? null : { kind: "sequence", value: value(), sequence };
    }
    if (depth >= NESTING_MAX) {
      throw new ShellSyntaxError(
        "brace expansion",
        `brace expansion nested deeper than ${NESTING_MAX} levels is not supported`,
        0,
      );
    }
    for (let at = open + 1; at < close; at++) {
      if (isChar(this.atoms[at], "$")) {
        // Bash re-reads each generated word, so `{$,a}X` expands `$X`.
        throw new ShellSyntaxError(
          "brace expansion",
          "an unquoted literal `$` inside brace expansion is not supported",
          0,
        );
      }
    }
    const alternatives: ArgumentPart[][] = [];
    let pieceStart = open + 1;
    for (let at = open + 1; at < close; at = this.#next[at] ?? close) {
      if (!isChar(this.atoms[at], ",")) continue;
      alternatives.push(this.mark(pieceStart, at, depth + 1));
      pieceStart = at + 1;
    }
    alternatives.push(this.mark(pieceStart, close, depth + 1));
    return { kind: "brace", value: value(), alternatives };
  }
}

function textOf(atoms: readonly Atom[], start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; index++) {
    const atom = atoms[index];
    if (atom === undefined) continue;
    if (atom.kind === "char") text += atom.value;
    else if (atom.part.kind === "parameter") text += `$${atom.part.name}`;
    else text += atom.part.value;
  }
  return text;
}

/** Regroups atoms into literal, glob, and opaque parts. */
function toParts(atoms: readonly Atom[], start: number, end: number): ArgumentPart[] {
  const parts: ArgumentPart[] = [];
  let run = "";
  let runGlob = false;
  const flush = (): void => {
    if (run === "") return;
    parts.push(
      runGlob ? { kind: "glob", value: run } : { kind: "literal", value: run, quoted: false },
    );
    run = "";
  };
  for (let index = start; index < end; index++) {
    const atom = atoms[index];
    if (atom === undefined) continue;
    if (atom.kind === "part") {
      flush();
      parts.push(atom.part);
      continue;
    }
    if (atom.glob !== runGlob) flush();
    runGlob = atom.glob;
    run += atom.value;
  }
  flush();
  return parts;
}

/** `x..y` or `x..y..step` of unquoted plain characters, or null. */
function parseSequence(atoms: readonly Atom[], start: number, end: number): BraceSequence | null {
  let text = "";
  for (let index = start; index < end; index++) {
    const atom = atoms[index];
    if (atom?.kind !== "char" || atom.glob || !SEQUENCE_CHARACTER.test(atom.value)) return null;
    text += atom.value;
  }
  const fields = text.split("..");
  const [first, last, increment] = fields;
  if (first === undefined || last === undefined || fields.length > 3) return null;
  let step = 1n;
  if (increment !== undefined) {
    const parsed = parseInteger(increment);
    if (parsed === null) return null;
    step = parsed < 0n ? -parsed : parsed;
    if (step === 0n) step = 1n;
  }

  const startNumber = parseInteger(first);
  const endNumber = parseInteger(last);
  if (startNumber !== null && endNumber !== null) {
    const padded = isZeroPadded(first) || isZeroPadded(last);
    return {
      kind: "integer",
      start: startNumber,
      end: endNumber,
      step,
      width: padded ? Math.max(first.length, last.length) : 0,
    };
  }
  if (!isLetter(first) || !isLetter(last)) return null;
  if (isUpper(first) !== isUpper(last)) {
    // Between `Z` and `a` Bash emits `[`, `\`, and `` ` `` as unquoted text.
    throw new ShellSyntaxError(
      "brace expansion",
      `character sequence {${text}} across letter cases is not supported`,
      0,
    );
  }
  return { kind: "character", start: first.charCodeAt(0), end: last.charCodeAt(0), step };
}

/** A decimal within `intmax_t`, as Bash's `legal_number` reads it. Out of range is not a sequence. */
function parseInteger(text: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(text)) return null;
  const value = BigInt(text);
  return value > INTMAX || value < INTMIN ? null : value;
}

function isZeroPadded(text: string): boolean {
  return /^-?0[0-9]/.test(text);
}

function isLetter(text: string): boolean {
  return /^[A-Za-z]$/.test(text);
}

function isUpper(text: string): boolean {
  return /^[A-Z]$/.test(text);
}
