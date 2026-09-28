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

export class FieldState {
  #record = "";
  #recordValue: Value | undefined;
  #texts: string[] = [];
  /** Assigned values; `undefined` means the field still holds its input text. */
  #values: Array<Value | undefined> = [];

  constructor(
    private readonly split: (text: string) => string[],
    private readonly join: (values: readonly Value[]) => string,
    private readonly toText: (value: Value) => string,
  ) {}

  get record(): string {
    return this.#record;
  }

  get count(): number {
    return this.#texts.length;
  }

  /** Approximate bytes held by the record and its fields. */
  get bytes(): number {
    return this.#record.length * 2 + this.#texts.length * 16;
  }

  setRecord(text: string, value?: Value): void {
    this.#record = text;
    this.#recordValue = value;
    this.#texts = this.split(text);
    this.#values = [];
  }

  get(index: number): Value {
    if (index === 0) {
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
    while (this.#texts.length < index) {
      this.#texts.push("");
      this.#values[this.#texts.length - 1] = "";
    }
    this.#texts[index - 1] = this.toText(value);
    this.#values[index - 1] = value;
    this.#rebuild();
  }

  setCount(count: number): void {
    if (count < this.#texts.length) {
      this.#texts.length = count;
      this.#values.length = Math.min(this.#values.length, count);
    }
    while (this.#texts.length < count) {
      this.#texts.push("");
      this.#values[this.#texts.length - 1] = "";
    }
    this.#rebuild();
  }

  /** A lone field becomes `$0` with its type; several join to a plain string. */
  #rebuild(): void {
    if (this.#texts.length === 1) {
      this.#recordValue = this.get(1);
      this.#record = this.#texts[0] ?? "";
      return;
    }
    const values: Value[] = [];
    for (let index = 1; index <= this.#texts.length; index++) values.push(this.get(index));
    this.#record = this.join(values);
    this.#recordValue = this.#record;
  }
}
