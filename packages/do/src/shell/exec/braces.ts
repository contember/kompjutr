// Brace generation: the words a marked argument stands for, in Bash's order
// (the rightmost expression varies fastest). Lazy on purpose — the caller
// counts each word against the argv ceiling as it arrives, so `{1..100000000}`
// fails at the ceiling without being materialised.

import type { ArgumentPart, BraceSequence, FlatPart } from "../plan/types.js";

export function hasBraces(parts: readonly ArgumentPart[]): boolean {
  return parts.some((part) => part.kind === "brace" || part.kind === "sequence");
}

/** The only parts of a word with no brace nodes, typed as such. */
export function flatParts(parts: readonly ArgumentPart[]): FlatPart[] {
  const flat: FlatPart[] = [];
  for (const part of parts) {
    if (part.kind !== "brace" && part.kind !== "sequence") flat.push(part);
  }
  return flat;
}

export function* generateWords(parts: readonly ArgumentPart[]): Generator<FlatPart[]> {
  const nodes: Array<Extract<ArgumentPart, { readonly kind: "brace" | "sequence" }>> = [];
  for (const part of parts) {
    if (part.kind === "brace" || part.kind === "sequence") nodes.push(part);
  }
  const choices: Array<Iterator<FlatPart[]>> = [];
  const current: FlatPart[][] = [];
  for (let index = 0; index < nodes.length; index++) {
    if (!restart(nodes, choices, current, index)) return;
  }

  for (;;) {
    yield assemble(parts, current);
    let index = nodes.length - 1;
    while (index >= 0 && !advance(choices, current, index)) index--;
    if (index < 0) return;
    for (let later = index + 1; later < nodes.length; later++) {
      if (!restart(nodes, choices, current, later)) return;
    }
  }
}

function advance(
  choices: Array<Iterator<FlatPart[]>>,
  current: FlatPart[][],
  index: number,
): boolean {
  const next = choices[index]?.next();
  if (next === undefined || next.done === true) return false;
  current[index] = next.value;
  return true;
}

function restart(
  nodes: ReadonlyArray<Extract<ArgumentPart, { readonly kind: "brace" | "sequence" }>>,
  choices: Array<Iterator<FlatPart[]>>,
  current: FlatPart[][],
  index: number,
): boolean {
  const node = nodes[index];
  if (node === undefined) return false;
  const iterator =
    node.kind === "brace" ? alternatives(node.alternatives) : sequence(node.sequence);
  const first = iterator.next();
  if (first.done === true) return false;
  choices[index] = iterator;
  current[index] = first.value;
  return true;
}

function* alternatives(alternatives: readonly (readonly ArgumentPart[])[]): Generator<FlatPart[]> {
  for (const alternative of alternatives) yield* generateWords(alternative);
}

function* sequence(sequence: BraceSequence): Generator<FlatPart[]> {
  const start = BigInt(sequence.start);
  const end = BigInt(sequence.end);
  const delta = start <= end ? sequence.step : -sequence.step;
  for (let value = start; delta > 0n ? value <= end : value >= end; value += delta) {
    const text =
      sequence.kind === "integer"
        ? padded(value, sequence.width)
        : String.fromCharCode(Number(value));
    yield [{ kind: "literal", value: text, quoted: false }];
  }
}

/** Zero-padded to `width`, with the sign counting toward the width. */
function padded(value: bigint, width: number): string {
  if (value < 0n) return `-${(-value).toString().padStart(width - 1, "0")}`;
  return value.toString().padStart(width, "0");
}

/** One word from the current choices; adjacent unquoted literals merge, as tilde expansion reads them. */
function assemble(parts: readonly ArgumentPart[], current: readonly FlatPart[][]): FlatPart[] {
  const word: FlatPart[] = [];
  let node = 0;
  const append = (part: FlatPart): void => {
    const last = word[word.length - 1];
    if (part.kind === "literal" && !part.quoted && last?.kind === "literal" && !last.quoted) {
      word[word.length - 1] = { kind: "literal", value: last.value + part.value, quoted: false };
      return;
    }
    word.push(part);
  };
  for (const part of parts) {
    if (part.kind === "brace" || part.kind === "sequence") {
      for (const generated of current[node] ?? []) append(generated);
      node++;
    } else {
      append(part);
    }
  }
  return word;
}
