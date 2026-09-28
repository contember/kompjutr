// Field splitting over resolved segments, with the fixed default IFS: space,
// tab, and newline. A script cannot change IFS (the planner refuses it).

import type { Segment } from "./segments.js";

export interface FieldPart {
  readonly value: string;
  readonly globActive: boolean;
}

export type Field = readonly FieldPart[];

export function* splitFields(segments: readonly Segment[]): Generator<Field> {
  let field: FieldPart[] = [];
  let preserveEmpty = false;

  for (const segment of segments) {
    if (segment.mode === "literal" || segment.mode === "quoted") {
      if (segment.value !== "") field.push({ value: segment.value, globActive: false });
      preserveEmpty ||= segment.mode === "quoted";
      continue;
    }
    if (segment.mode === "glob") {
      field.push({ value: segment.value, globActive: true });
      continue;
    }

    const value = segment.value;
    let start = 0;
    for (let index = 0; index <= value.length; index++) {
      if (index < value.length && !isIfsWhitespace(value.charAt(index))) continue;
      if (index > start) {
        field.push({ value: value.slice(start, index), globActive: true });
      }
      if (index < value.length) {
        if (field.length > 0 || preserveEmpty) yield field;
        field = [];
        preserveEmpty = false;
        while (isIfsWhitespace(value.charAt(index + 1))) index++;
      }
      start = index + 1;
    }
  }

  if (field.length > 0 || preserveEmpty) yield field;
}

export function fieldText(field: Field): string {
  let value = "";
  for (const part of field) value += part.value;
  return value;
}

export function fieldPattern(field: Field): string {
  let pattern = "";
  for (const part of field) {
    pattern += part.globActive ? part.value : escapeGlob(part.value);
  }
  return pattern;
}

export function fieldHasGlob(field: Field): boolean {
  return field.some((part) => part.globActive && /[*?[]/.test(part.value));
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (match) => `[${match}]`);
}

function isIfsWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n";
}
