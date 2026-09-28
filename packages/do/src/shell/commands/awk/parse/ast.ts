// The parsed awk program. Names are resolved while parsing: every variable is
// a global slot, a function-local slot, or one of the special variables, and
// every array reference names its slot the same way.

export const SPECIAL_VARIABLES = [
  "NR",
  "FNR",
  "NF",
  "FS",
  "OFS",
  "ORS",
  "RS",
  "FILENAME",
  "SUBSEP",
  "RSTART",
  "RLENGTH",
  "CONVFMT",
  "OFMT",
  "ARGC",
] as const;

export type SpecialName = (typeof SPECIAL_VARIABLES)[number];

export type Slot =
  | { readonly scope: "global"; readonly index: number; readonly name: string }
  | { readonly scope: "local"; readonly index: number; readonly name: string };

export type VariableRef = Slot | { readonly scope: "special"; readonly name: SpecialName };

export type LValue =
  | { readonly kind: "variable"; readonly ref: VariableRef }
  | { readonly kind: "element"; readonly array: Slot; readonly subscripts: readonly Expr[] }
  | { readonly kind: "field"; readonly index: Expr };

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=";
export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export type ArithmeticOp = "+" | "-" | "*" | "/" | "%" | "^";

/** A user function argument: an expression, or a bare name that may pass an array. */
export type CallArgument =
  | { readonly kind: "expr"; readonly expr: Expr }
  | { readonly kind: "name"; readonly slot: Slot };

export type Expr =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  /** A bare `/re/`, which matches against `$0`. */
  | { readonly kind: "regex"; readonly source: string; readonly line: number }
  | LValue
  | {
      readonly kind: "assign";
      readonly op: AssignOp;
      readonly target: LValue;
      readonly value: Expr;
    }
  | {
      readonly kind: "conditional";
      readonly test: Expr;
      readonly then: Expr;
      readonly otherwise: Expr;
    }
  | { readonly kind: "or" | "and"; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "in"; readonly subscripts: readonly Expr[]; readonly array: Slot }
  | {
      readonly kind: "match";
      readonly negated: boolean;
      readonly subject: Expr;
      readonly pattern: Expr;
    }
  | {
      readonly kind: "compare";
      readonly op: CompareOp;
      readonly left: Expr;
      readonly right: Expr;
    }
  | { readonly kind: "concat"; readonly left: Expr; readonly right: Expr }
  | {
      readonly kind: "arithmetic";
      readonly op: ArithmeticOp;
      readonly left: Expr;
      readonly right: Expr;
    }
  | { readonly kind: "not" | "negate" | "plus"; readonly operand: Expr }
  | {
      readonly kind: "increment";
      readonly delta: 1 | -1;
      readonly prefix: boolean;
      readonly target: LValue;
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: readonly CallArgument[];
      readonly line: number;
    }
  | { readonly kind: "builtin"; readonly name: string; readonly args: readonly Expr[] }
  | { readonly kind: "arrayLength"; readonly array: Slot }
  /** `length(name)` where `name` was not yet typed: an array's size or a string's length. */
  | { readonly kind: "lengthOfName"; readonly slot: Slot }
  | {
      readonly kind: "split";
      readonly source: Expr;
      readonly array: Slot;
      readonly separator: Expr | null;
    }
  | {
      readonly kind: "substitute";
      readonly global: boolean;
      readonly pattern: Expr;
      readonly replacement: Expr;
      readonly target: LValue;
    }
  | { readonly kind: "matchFunction"; readonly subject: Expr; readonly pattern: Expr };

export type Statement =
  | { readonly kind: "expr"; readonly expr: Expr }
  | { readonly kind: "print"; readonly args: readonly Expr[] }
  | { readonly kind: "printf"; readonly args: readonly Expr[] }
  | {
      readonly kind: "if";
      readonly test: Expr;
      readonly then: Statement;
      readonly otherwise: Statement | null;
    }
  | {
      readonly kind: "forIn";
      readonly variable: VariableRef;
      readonly array: Slot;
      readonly body: Statement;
    }
  | { readonly kind: "block"; readonly body: readonly Statement[] }
  | { readonly kind: "next" | "nextfile" | "break" | "continue" | "empty" }
  | { readonly kind: "exit" | "return"; readonly value: Expr | null }
  | {
      readonly kind: "delete";
      readonly array: Slot;
      readonly subscripts: readonly Expr[] | null;
    };

export type Pattern =
  | { readonly kind: "expr"; readonly expr: Expr }
  | { readonly kind: "range"; readonly from: Expr; readonly to: Expr };

export interface Rule {
  readonly pattern: Pattern | null;
  /** Null prints `$0`. */
  readonly action: Statement | null;
}

export interface FunctionDefinition {
  readonly name: string;
  readonly params: readonly string[];
  /** Which parameters the body uses as arrays; resolved after parsing. */
  readonly arrays: boolean[];
  readonly body: Statement;
}

export interface Program {
  readonly begin: readonly Statement[];
  readonly end: readonly Statement[];
  readonly rules: readonly Rule[];
  readonly functions: ReadonlyMap<string, FunctionDefinition>;
  /** Global slot names, and which slots are arrays. */
  readonly globals: readonly { readonly name: string; readonly array: boolean }[];
}
