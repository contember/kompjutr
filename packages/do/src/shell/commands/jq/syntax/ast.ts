// The jq syntax tree. `start`/`end` are UTF-16 offsets into the program text,
// kept where jq reports a location (undefined names).

import type { JqValue } from "../value.js";

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type BinaryOperator = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=";
export type AssignOperator = "=" | "|=" | "+=" | "-=" | "*=" | "/=" | "%=" | "//=";

export type Node =
  | { readonly kind: "identity" }
  | { readonly kind: "literal"; readonly value: JqValue }
  | {
      readonly kind: "index";
      readonly target: Node;
      readonly key: Node;
      readonly optional: boolean;
    }
  | {
      readonly kind: "slice";
      readonly target: Node;
      readonly from: Node | null;
      readonly to: Node | null;
      readonly optional: boolean;
    }
  | { readonly kind: "iterate"; readonly target: Node; readonly optional: boolean }
  | {
      readonly kind: "string";
      readonly format: string | null;
      readonly parts: ReadonlyArray<string | Node>;
    }
  | { readonly kind: "format"; readonly name: string }
  | { readonly kind: "array"; readonly body: Node | null }
  | { readonly kind: "object"; readonly entries: readonly ObjectEntry[] }
  | { readonly kind: "negate"; readonly body: Node }
  | { readonly kind: "pipe"; readonly left: Node; readonly right: Node }
  | { readonly kind: "comma"; readonly left: Node; readonly right: Node }
  | {
      readonly kind: "binary";
      readonly operator: BinaryOperator;
      readonly left: Node;
      readonly right: Node;
    }
  | { readonly kind: "and"; readonly left: Node; readonly right: Node }
  | { readonly kind: "or"; readonly left: Node; readonly right: Node }
  | { readonly kind: "alternative"; readonly left: Node; readonly right: Node }
  | {
      readonly kind: "assign";
      readonly operator: AssignOperator;
      readonly left: Node;
      readonly right: Node;
    }
  | {
      readonly kind: "if";
      readonly condition: Node;
      readonly then: Node;
      readonly otherwise: Node | null;
    }
  | { readonly kind: "try"; readonly body: Node; readonly handler: Node | null }
  | {
      readonly kind: "reduce";
      readonly source: Node;
      readonly pattern: Pattern;
      readonly init: Node;
      readonly update: Node;
    }
  | {
      readonly kind: "foreach";
      readonly source: Node;
      readonly pattern: Pattern;
      readonly init: Node;
      readonly update: Node;
      readonly extract: Node | null;
    }
  | { readonly kind: "bind"; readonly source: Node; readonly pattern: Pattern; readonly body: Node }
  | ({ readonly kind: "variable"; readonly name: string } & Span)
  | ({ readonly kind: "call"; readonly name: string; readonly args: readonly Node[] } & Span)
  | { readonly kind: "define"; readonly definition: Definition; readonly body: Node }
  | { readonly kind: "label"; readonly name: string; readonly body: Node }
  | ({ readonly kind: "break"; readonly name: string } & Span);

export interface ObjectEntry {
  readonly key: Node;
  readonly value: Node;
}

export type Pattern =
  | ({ readonly kind: "variable"; readonly name: string } & Span)
  | { readonly kind: "array"; readonly items: readonly Pattern[] }
  | { readonly kind: "object"; readonly entries: readonly ObjectPatternEntry[] };

export interface ObjectPatternEntry {
  readonly key: Node;
  /** `$name` and `$name: pattern` also bind the whole value to `$name`. */
  readonly binding: ({ readonly name: string } & Span) | null;
  readonly pattern: Pattern | null;
}

export interface Parameter {
  readonly name: string;
  /** `$name`: evaluated to values; otherwise a closure. */
  readonly value: boolean;
}

export interface Definition extends Span {
  readonly name: string;
  readonly params: readonly Parameter[];
  readonly body: Node;
}

export const IDENTITY: Node = { kind: "identity" };
