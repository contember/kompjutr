// Words to arguments. A command substitution's list is planned here, so a
// refusal inside it fails the script before anything runs; the planner is
// passed in because it is the caller.

import type { Script, Word, WordPart } from "../parse/ast.js";
import { markBraces } from "./braces.js";
import { refuseNamedTildes } from "./tilde.js";
import type { Argument, FlatPart, Plan } from "./types.js";

export type ListPlanner = (script: Script) => Plan;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

export function argumentPart(part: WordPart, plan: ListPlanner): FlatPart {
  switch (part.kind) {
    case "Parameter":
      return { kind: "parameter", name: part.name, quoted: part.quoted };
    case "ParameterLength":
      return { kind: "length", name: part.name, quoted: part.quoted };
    case "ParameterOperation":
      return {
        kind: "conditional",
        name: part.name,
        operator: part.operator,
        word: part.word.map((inner) => argumentPart(inner, plan)),
        quoted: part.quoted,
      };
    case "CommandSubstitution":
      return { kind: "substitution", body: plan(part.body), quoted: part.quoted };
    case "Glob":
      return { kind: "glob", value: part.value };
    default:
      return { kind: "literal", value: part.value, quoted: part.kind !== "Literal" };
  }
}

/**
 * A command argument. Brace expansion applies to an ordinary word; a
 * `declaration` (an `export` operand shaped `NAME=value`) takes none, as Bash
 * treats it like an assignment.
 */
export function toArgument(word: Word, plan: ListPlanner, declaration = false): Argument {
  const shaped = isAssignmentShaped(word);
  if (!(declaration && shaped)) {
    const braces = markBraces(word.parts, (part) => argumentPart(part, plan));
    if (braces !== null) return { kind: "word", parts: braces };
  }
  const kind = !shaped ? "word" : declaration ? "declaration" : "assignment";
  const parts = word.parts.map((part) => argumentPart(part, plan));
  refuseNamedTildes(parts, kind);
  return { kind, parts };
}

/** An assignment's whole word: no brace expansion, tilde after `=` and each `:`. */
export function assignmentArgument(word: Word, plan: ListPlanner): Argument {
  const parts = word.parts.map((part) => argumentPart(part, plan));
  refuseNamedTildes(parts, "assignment");
  return { kind: "assignment", parts };
}

/**
 * Here-text admits tilde expansion (a here-string only) and every expansion,
 * but no brace or pathname expansion. A here-string keeps its unquoted
 * literals unquoted, which only tilde expansion observes.
 */
export function hereText(word: Word, hereString: boolean, plan: ListPlanner): Argument {
  const parts = word.parts.map((part): FlatPart => {
    if (part.kind === "Literal" || part.kind === "Glob") {
      return { kind: "literal", value: part.value, quoted: !hereString };
    }
    return argumentPart(part, plan);
  });
  if (!hereString) return { kind: "word", parts };
  refuseNamedTildes(parts, "here-string");
  return { kind: "here-string", parts };
}

export function isAssignmentShaped(word: Word): boolean {
  const first = word.parts[0];
  return first?.kind === "Literal" && ASSIGNMENT.test(first.value);
}
