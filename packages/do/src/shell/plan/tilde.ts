// Tilde expansion, after brace generation and before parameter expansion.
// Pure, so the planner refuses a static named prefix before anything runs and
// the executor substitutes `HOME` from the frozen run env.
//
// A tilde prefix starts at an unquoted `~` at the start of a word. In a
// `NAME=value` argument it also starts right after the `=` or an unquoted
// `:`; in a here-string, after an unquoted `:`. It runs to the next unquoted
// `/`, or `/` or `:` outside a plain word. This is Bash's
// `bash_tilde_find_word`: a quoted character before the terminator keeps the
// whole prefix literal. A bare prefix becomes `HOME` as a quoted value: Bash
// neither splits nor globs it. Any other prefix (`~user`, `~+`, `~-`, `~:x`)
// is refused: this runtime has no passwd database or directory stack, and
// Bash's readline fallback is not modelled.

import { ShellSyntaxError } from "../parse/ast.js";
import type { Argument, FlatPart } from "./types.js";

/** Which positions start a prefix; an argument's kind names its rules. */
export type TildeMode = Argument["kind"];

type Prefix =
  | { readonly kind: "home"; readonly end: number }
  | { readonly kind: "literal" }
  | { readonly kind: "named"; readonly text: string };

/** Throws for a named prefix that is already known at plan time. */
export function refuseNamedTildes(parts: readonly FlatPart[], mode: TildeMode): void {
  expandTildes(parts, mode, () => "");
}

export function expandTildes(
  parts: readonly FlatPart[],
  mode: TildeMode,
  home: () => string,
): FlatPart[] {
  const first = parts[0];
  const leading = first?.kind === "literal" && !first.quoted && first.value.startsWith("~");
  if (mode === "word" && !leading) return [...parts];

  const assignment = mode === "assignment";
  const colons = mode !== "word";
  const out: FlatPart[] = [];
  let eligible = !assignment;
  let equalsSeen = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) continue;
    if (part.kind !== "literal" || part.quoted) {
      out.push(part);
      eligible = false;
      continue;
    }
    let text = "";
    let position = 0;
    while (position < part.value.length) {
      const char = part.value.charAt(position);
      if (eligible && char === "~") {
        const prefix = scanPrefix(parts, index, part.value, position + 1, colons);
        if (prefix.kind === "named") refuseNamed(prefix.text);
        if (prefix.kind === "home") {
          if (text !== "") out.push({ kind: "literal", value: text, quoted: false });
          text = "";
          out.push({ kind: "literal", value: home(), quoted: true });
          position = prefix.end;
          eligible = false;
          continue;
        }
      }
      text += char;
      position++;
      const opensValue = assignment && char === "=" && index === 0 && !equalsSeen;
      eligible = (colons && char === ":") || opensValue;
      if (char === "=") equalsSeen = true;
    }
    if (text !== "") out.push({ kind: "literal", value: text, quoted: false });
  }
  return out;
}

/** The prefix after the `~` at `position` in `value`, which is `parts[index]`. */
function scanPrefix(
  parts: readonly FlatPart[],
  index: number,
  value: string,
  position: number,
  colons: boolean,
): Prefix {
  let end = position;
  while (end < value.length && !isTerminator(value.charAt(end), colons)) end++;
  let text = `~${value.slice(position, end)}`;
  if (end < value.length) return text === "~" ? { kind: "home", end } : { kind: "named", text };

  for (let at = index + 1; at < parts.length; at++) {
    const part = parts[at];
    if (part === undefined) continue;
    if (part.kind === "literal" && part.quoted) return { kind: "literal" };
    if (part.kind !== "literal") {
      text += part.kind === "parameter" ? `$${part.name}` : part.value;
      continue;
    }
    let partEnd = 0;
    while (partEnd < part.value.length && !isTerminator(part.value.charAt(partEnd), colons)) {
      partEnd++;
    }
    text += part.value.slice(0, partEnd);
    if (partEnd < part.value.length) break;
  }
  return text === "~" ? { kind: "home", end } : { kind: "named", text };
}

function isTerminator(char: string, colons: boolean): boolean {
  return char === "/" || (colons && char === ":");
}

function refuseNamed(prefix: string): never {
  throw new ShellSyntaxError(
    "tilde expansion",
    `tilde expansion of \`${prefix}\` is not supported; only \`~\` and \`~/\` expand`,
    0,
  );
}
