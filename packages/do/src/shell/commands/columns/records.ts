// Record streaming shared by the line and column filters.
//
// A record is the bytes up to a terminator (newline, or NUL under `-z`); the
// final record may lack one, and `terminated` says so, because every tool here
// treats that case differently. Only the record being assembled is retained,
// against the shared budget, so an over-long line fails loudly instead of
// growing without bound.

import { type ByteStream, concat, encode } from "../../exec/bytes.js";
import type { CommandContext, RetainedBudget } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { streamFile } from "../read.js";

export interface Record {
  /** The record without its terminator. */
  readonly bytes: Uint8Array;
  readonly terminated: boolean;
}

export async function* records(
  stream: ByteStream,
  terminator: number,
  budget: RetainedBudget,
): AsyncGenerator<Record, void, undefined> {
  let carry: Uint8Array | null = null;
  let releaseCarry: (() => void) | null = null;
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (let index = chunk.indexOf(terminator); index !== -1; ) {
        const slice = chunk.subarray(start, index);
        const bytes: Uint8Array = carry === null ? slice : concat([carry, slice]);
        const release = budget.retain(bytes.length, "column filter line");
        releaseCarry?.();
        carry = null;
        releaseCarry = null;
        try {
          yield { bytes, terminated: true };
        } finally {
          release();
        }
        start = index + 1;
        index = chunk.indexOf(terminator, start);
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        const length = (carry?.length ?? 0) + rest.length;
        const release = budget.retain(length, "column filter line");
        const next: Uint8Array = carry === null ? rest.slice() : concat([carry, rest]);
        releaseCarry?.();
        carry = next;
        releaseCarry = release;
      }
    }
    if (carry !== null) yield { bytes: carry, terminated: false };
  } finally {
    releaseCarry?.();
  }
}

export type Opened =
  | { readonly kind: "stream"; readonly stream: ByteStream }
  | { readonly kind: "missing" }
  | { readonly kind: "directory" };

/** A file operand, or stdin for `-` when the tool reads it that way. */
export function open(context: CommandContext, operand: string, dashIsStdin: boolean): Opened {
  if (dashIsStdin && operand === "-") return { kind: "stream", stream: context.stdin ?? empty() };
  const path = resolve(context.cwd, operand);
  const stat = context.fs.statTarget(path);
  if (stat === null) return { kind: "missing" };
  if (stat.type === "dir") return { kind: "directory" };
  return { kind: "stream", stream: streamFile(context, path, stat.size, "column filter input") };
}

function* empty(): ByteStream {}

/**
 * Collects output into chunks of a useful size. A consumer that stops pulling
 * stops the producer at the next flush, so batching never outruns `head`.
 */
export class OutputBuffer {
  #parts: Uint8Array[] = [];
  #length = 0;

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#parts.push(bytes);
    this.#length += bytes.length;
  }

  text(value: string): void {
    this.push(encode(value));
  }

  byte(value: number): void {
    this.push(Uint8Array.of(value));
  }

  get full(): boolean {
    return this.#length >= FLUSH_BYTES;
  }

  take(): Uint8Array | null {
    if (this.#length === 0) return null;
    const joined =
      this.#parts.length === 1 ? (this.#parts[0] ?? new Uint8Array()) : concat(this.#parts);
    this.#parts = [];
    this.#length = 0;
    return joined;
  }
}

const FLUSH_BYTES = 16 * 1024;

/** Bytes as Rust's `String::from_utf8_lossy` prints them. */
export function lossy(bytes: Uint8Array): Uint8Array {
  for (const byte of bytes) {
    if (byte >= 0x80) return encode(LOSSY.decode(bytes));
  }
  return bytes;
}

const LOSSY = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** uucore's `quote()` for the operands these tools name in diagnostics. */
export function quote(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!/["$`\\]/.test(text)) return `"${text}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
