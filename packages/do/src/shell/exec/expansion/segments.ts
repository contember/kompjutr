// Parameter expansion and command substitution, left to right as Bash
// performs them, into segments that remember how each piece may split and
// match paths. A `${NAME:=word}` assignment is visible to the expansions after
// it, and each substitution updates `$?` before the next one runs.

import { ShellSyntaxError } from "../../parse/ast.js";
import { expandTildes } from "../../plan/tilde.js";
import type { FlatPart, Plan } from "../../plan/types.js";
import type { BoundedFs } from "../context.js";
import { utf8Bytes } from "../utf8.js";

/**
 * `literal`: unquoted source text, which neither splits nor matches paths
 * (its glob characters are `glob` segments). `quoted`: quoted text or a quoted
 * expansion; it keeps an empty field. `split`: an unquoted expansion result,
 * which splits on IFS and matches paths.
 */
export interface Segment {
  readonly value: string;
  readonly mode: "literal" | "quoted" | "glob" | "split";
}

/** The values `$NAME` and `$?` expand to. */
export interface Parameters {
  /** A set parameter's value, or undefined when it is unset. */
  value(name: string): string | undefined;
  /** `${NAME:=word}`. */
  assign(name: string, value: string): void;
  /** `set -u`: expanding an unset parameter fails. */
  readonly nounset: boolean;
}

/** A command substitution's output, trailing newlines removed, and its reservation. */
export interface Captured {
  readonly text: string;
  release(): void;
}

/** What word expansion reads and runs. */
export interface Expansion {
  readonly fs: BoundedFs;
  readonly cwd: string;
  readonly parameters: Parameters;
  /** Runs the list in a subshell and captures its stdout; updates `$?`. */
  substitute(body: Plan): Promise<Captured>;
}

/**
 * A word that cannot expand: `set -u` met an unset name, or `${NAME:?word}`
 * fired. Bash reports it and ends the shell that expanded it.
 */
export class ExpansionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpansionFailure";
  }
}

/**
 * Every segment of `parts` in order. Reservations of substitution output are
 * appended to `held`, for the caller to release once the word is used. In the
 * word of an unquoted `${NAME:-word}`, unquoted text splits like an expansion.
 */
export async function resolveParts(
  parts: readonly FlatPart[],
  expansion: Expansion,
  held: Array<() => void>,
  operand = false,
): Promise<Segment[]> {
  const segments: Segment[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case "literal":
        segments.push({
          value: part.value,
          mode: part.quoted ? "quoted" : operand ? "split" : "literal",
        });
        break;
      case "glob":
        segments.push({ value: part.value, mode: "glob" });
        break;
      case "parameter":
        segments.push(expanded(parameterValue(expansion.parameters, part.name), part.quoted));
        break;
      case "length": {
        const value = parameterValue(expansion.parameters, part.name);
        segments.push(expanded(String(length(value, expansion.parameters)), part.quoted));
        break;
      }
      case "substitution": {
        const captured = await expansion.substitute(part.body);
        held.push(() => captured.release());
        segments.push(expanded(captured.text, part.quoted));
        break;
      }
      case "conditional":
        segments.push(...(await conditional(part, expansion, held)));
        break;
    }
  }
  return segments;
}

export function joinSegments(segments: readonly Segment[]): string {
  let text = "";
  for (const segment of segments) text += segment.value;
  return text;
}

export function parameterValue(parameters: Parameters, name: string): string {
  const value = parameters.value(name);
  if (value !== undefined) return value;
  if (parameters.nounset) throw new ExpansionFailure(`${name}: unbound variable`);
  return "";
}

export function homeOf(parameters: Parameters): () => string {
  return () => {
    const value = parameters.value("HOME");
    if (value === undefined) {
      // Bash would fall back to the passwd entry, which this runtime does not have.
      throw new ShellSyntaxError("tilde expansion", "tilde expansion needs HOME in the run env", 0);
    }
    return value;
  };
}

async function conditional(
  part: Extract<FlatPart, { readonly kind: "conditional" }>,
  expansion: Expansion,
  held: Array<() => void>,
): Promise<Segment[]> {
  const parameters = expansion.parameters;
  const value = parameters.value(part.name);
  const colon = part.operator.startsWith(":");
  const missing = value === undefined || (colon && value === "");
  const word = async (): Promise<Segment[]> => {
    const parts = expandTildes(part.word, "word", homeOf(parameters));
    const segments = await resolveParts(parts, expansion, held, !part.quoted);
    // A quoted expansion is one field even when it expands to nothing.
    return part.quoted ? [...segments, { value: "", mode: "quoted" }] : segments;
  };
  const current = (): Segment[] => [expanded(value ?? "", part.quoted)];

  switch (part.operator) {
    case "-":
    case ":-":
      return missing ? word() : current();
    case "+":
    case ":+":
      return missing ? (part.quoted ? [{ value: "", mode: "quoted" }] : []) : word();
    case "=":
    case ":=": {
      if (!missing) return current();
      const assigned = joinSegments(await word());
      parameters.assign(part.name, assigned);
      return [expanded(assigned, part.quoted)];
    }
    case "?":
    case ":?": {
      if (!missing) return current();
      const message = joinSegments(await word());
      const fallback = colon ? "parameter null or not set" : "parameter not set";
      throw new ExpansionFailure(`${part.name}: ${message === "" ? fallback : message}`);
    }
  }
}

/** Characters under a UTF-8 locale, bytes under any other, as Bash counts `${#NAME}`. */
function length(value: string, parameters: Parameters): number {
  const locale = [
    parameters.value("LC_ALL"),
    parameters.value("LC_CTYPE"),
    parameters.value("LANG"),
  ].find((candidate) => candidate !== undefined && candidate !== "");
  if (locale !== undefined && /utf-?8/i.test(locale)) {
    let characters = 0;
    for (const _character of value) characters++;
    return characters;
  }
  return utf8Bytes(value);
}

function expanded(value: string, quoted: boolean): Segment {
  return { value, mode: quoted ? "quoted" : "split" };
}
