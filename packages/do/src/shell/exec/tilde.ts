// Tilde expansion, after brace generation and before parameter expansion.
//
// A tilde prefix starts at an unquoted `~` at the start of a word — or, in a
// `NAME=value` argument, right after the `=` or an unquoted `:` — and runs to
// the next unquoted `/`, or `/` or `:` in an assignment. This is Bash's
// `bash_tilde_find_word`: a quoted character before the terminator keeps the
// whole prefix literal. A bare prefix becomes `HOME` from the frozen run env,
// as a quoted value: Bash neither splits nor globs it. Any other prefix
// (`~user`, `~+`, `~-`, `~:x`) is refused: this runtime has no passwd
// database or directory stack, and Bash's readline fallback is not modelled.

import { ShellSyntaxError } from "../parse/ast.js";
import type { FlatPart } from "./braces.js";

type Prefix =
  | { readonly kind: "home"; readonly end: number }
  | { readonly kind: "literal" }
  | { readonly kind: "named"; readonly text: string };

export function expandTildes(
  parts: readonly FlatPart[],
  assignment: boolean,
  env: Readonly<Record<string, string>> | undefined,
): FlatPart[] {
  const first = parts[0];
  if (!assignment && !(first?.kind === "literal" && !first.quoted && first.value.startsWith("~"))) {
    return [...parts];
  }

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
        const prefix = scanPrefix(parts, index, part.value, position + 1, assignment);
        if (prefix.kind === "named") refuseNamed(prefix.text);
        if (prefix.kind === "home") {
          if (text !== "") out.push({ kind: "literal", value: text, quoted: false });
          text = "";
          out.push({ kind: "literal", value: home(env), quoted: true });
          position = prefix.end;
          eligible = false;
          continue;
        }
      }
      text += char;
      position++;
      eligible = assignment && (char === ":" || (char === "=" && index === 0 && !equalsSeen));
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
  assignment: boolean,
): Prefix {
  let end = position;
  while (end < value.length && !isTerminator(value.charAt(end), assignment)) end++;
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
    while (partEnd < part.value.length && !isTerminator(part.value.charAt(partEnd), assignment)) {
      partEnd++;
    }
    text += part.value.slice(0, partEnd);
    if (partEnd < part.value.length) break;
  }
  return text === "~" ? { kind: "home", end } : { kind: "named", text };
}

function isTerminator(char: string, assignment: boolean): boolean {
  return char === "/" || (assignment && char === ":");
}

function home(env: Readonly<Record<string, string>> | undefined): string {
  const value = env === undefined || !Object.hasOwn(env, "HOME") ? undefined : env.HOME;
  if (value === undefined) {
    // Bash would fall back to the passwd entry, which this runtime does not have.
    throw new ShellSyntaxError("tilde expansion", "tilde expansion needs HOME in the run env", 0);
  }
  return value;
}

function refuseNamed(prefix: string): never {
  throw new ShellSyntaxError(
    "tilde expansion",
    `tilde expansion of \`${prefix}\` is not supported; only \`~\` and \`~/\` expand`,
    0,
  );
}
