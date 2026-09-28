// `$0`, its fields, and field splitting.
//
// mawk splits eagerly, with the FS in force when the record is set. A field
// read from input is a possible strnum; an assigned field keeps the assigned
// value. Assigning a field or NF rebuilds `$0` with OFS; assigning `$0`
// re-splits it.

import type { Regex } from "./regex/regex.js";
import { isAwkSpace, maybeNumber, type Value } from "./values.js";

/** How FS (or a `split` separator) divides text. */
export type Splitter =
  | { readonly kind: "space" }
  | { readonly kind: "empty" }
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "regex"; readonly regex: Regex };

export function splitText(text: string, splitter: Splitter): string[] {
  if (text.length === 0) return [];
  switch (splitter.kind) {
    case "space":
      return spaceSplit(text);
    case "empty":
      return Array.from({ length: text.length }, (_, index) => text.charAt(index));
    case "char":
      return text.split(splitter.char);
    case "regex":
      return splitter.regex.empty
        ? Array.from({ length: text.length }, (_, index) => text.charAt(index))
        : regexSplit(text, splitter.regex);
  }
}

function spaceSplit(text: string): string[] {
  const fields: string[] = [];
  let index = 0;
  for (;;) {
    while (index < text.length && isAwkSpace(text.charCodeAt(index))) index++;
    if (index >= text.length) return fields;
    const start = index;
    while (index < text.length && !isAwkSpace(text.charCodeAt(index))) index++;
    fields.push(text.slice(start, index));
  }
}

/** Only matches of positive length separate fields. */
function regexSplit(text: string, regex: Regex): string[] {
  const fields: string[] = [];
  let start = 0;
  let atStart = true;
  while (start < text.length) {
    const match = positiveMatch(regex, text, start, atStart);
    if (match === null) {
      fields.push(text.slice(start));
      return fields;
    }
    fields.push(text.slice(start, match.start));
    start = match.end;
    atStart = false;
  }
  fields.push("");
  return fields;
}

/** The next match of positive length: empty matches are stepped over one character at a time. */
function positiveMatch(
  regex: Regex,
  text: string,
  from: number,
  atStart: boolean,
): { start: number; end: number } | null {
  let position = from;
  let bol = atStart;
  while (position < text.length) {
    const { match } = regex.search(text, position, bol && position === 0, true);
    if (match === null) return null;
    if (match.end > match.start) return match;
    position = match.start + 1;
    bol = false;
  }
  return null;
}

/** Bytes charged per field beyond its text: the slot and its cached value. */
const FIELD_OVERHEAD = 16;

/**
 * Field and NF assignments only mark `$0` stale, with the OFS in force then;
 * it is joined when read, so assigning n fields costs O(n), not O(n^2).
 * Every growth is charged before it is allocated.
 */
export class FieldState {
  #record = "";
  #recordValue: Value | undefined;
  #texts: string[] = [];
  /** Assigned values; `undefined` means the field still holds its input text. */
  #values: Array<Value | undefined> = [];
  #textBytes = 0;
  /** The OFS to rebuild `$0` with, or null when `$0` is current. */
  #staleWith: string | null = null;
  #charged = 0;

  constructor(
    private readonly split: (text: string) => string[],
    private readonly toText: (value: Value) => string,
    private readonly separator: () => string,
    /** Charges (or, negative, credits) retained bytes; throws at the limit. */
    private readonly charge: (delta: number) => void,
  ) {}

  get record(): string {
    this.#sync();
    return this.#record;
  }

  get count(): number {
    return this.#texts.length;
  }

  setRecord(text: string, value?: Value): void {
    this.#reserve(text.length * 2);
    this.#record = text;
    this.#recordValue = value;
    this.#staleWith = null;
    this.#texts = this.split(text);
    this.#values = [];
    this.#textBytes = text.length;
    this.#account();
  }

  get(index: number): Value {
    if (index === 0) {
      this.#sync();
      this.#recordValue ??= maybeNumber(this.#record);
      return this.#recordValue;
    }
    if (index > this.#texts.length) return "";
    const assigned = this.#values[index - 1];
    if (assigned !== undefined) return assigned;
    const value = maybeNumber(this.#texts[index - 1] ?? "");
    this.#values[index - 1] = value;
    return value;
  }

  set(index: number, value: Value): void {
    if (index === 0) {
      this.setRecord(this.toText(value), value);
      return;
    }
    const text = this.toText(value);
    this.#extend(index);
    this.#reserve(text.length);
    this.#textBytes += text.length - (this.#texts[index - 1] ?? "").length;
    this.#texts[index - 1] = text;
    this.#values[index - 1] = value;
    this.#staleWith = this.separator();
    this.#account();
  }

  setCount(count: number): void {
    if (count < this.#texts.length) {
      for (let index = count; index < this.#texts.length; index++) {
        this.#textBytes -= (this.#texts[index] ?? "").length;
      }
      this.#texts.length = count;
      this.#values.length = Math.min(this.#values.length, count);
    }
    this.#extend(count);
    this.#staleWith = this.separator();
    this.#account();
  }

  #extend(count: number): void {
    if (count <= this.#texts.length) return;
    this.#reserve((count - this.#texts.length) * FIELD_OVERHEAD);
    while (this.#texts.length < count) {
      this.#texts.push("");
      this.#values[this.#texts.length - 1] = "";
    }
  }

  /** A lone field becomes `$0` with its type; several join to a plain string. */
  #sync(): void {
    const separator = this.#staleWith;
    if (separator === null) return;
    this.#staleWith = null;
    const count = this.#texts.length;
    if (count === 1) {
      this.#recordValue = this.get(1);
      this.#record = this.#texts[0] ?? "";
    } else {
      this.#reserve((this.#textBytes + Math.max(0, count - 1) * separator.length) * 2);
      this.#record = this.#texts.join(separator);
      this.#recordValue = this.#record;
    }
    this.#account();
  }

  #reserve(bytes: number): void {
    this.charge(bytes);
    this.#charged += bytes;
  }

  /** Settle the charge to the current estimate once an operation has finished. */
  #account(): void {
    const record = this.#staleWith === null ? this.#record.length * 2 : 0;
    const estimate = record + this.#textBytes + this.#texts.length * FIELD_OVERHEAD;
    this.charge(estimate - this.#charged);
    this.#charged = estimate;
  }
}
