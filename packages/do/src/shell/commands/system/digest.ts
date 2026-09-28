// Whole-input digests for the checksum commands. crypto.subtle hashes one
// buffer, not a stream, so an input is held whole under the retained budget
// while it is hashed and released straight after.

import { drainBounded, empty } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";

export interface Algorithm {
  /** The crypto.subtle name. */
  readonly digest: "SHA-1" | "SHA-256" | "SHA-512";
  /** The BSD tag and the name in check-line warnings. */
  readonly tag: string;
}

export type Verbosity = "normal" | "quiet" | "status" | "warn";

export type Input =
  | { readonly kind: "missing" }
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly path: string; readonly size: number }
  | { readonly kind: "stdin" };

export function openInput(context: CommandContext, operand: string): Input {
  if (operand === "-") return { kind: "stdin" };
  const path = resolve(context.cwd, operand);
  const stat = context.fs.statTarget(path);
  if (stat === null) return { kind: "missing" };
  if (stat.type !== "file") return { kind: "directory" };
  return { kind: "file", path, size: stat.size };
}

/** The lowercase hex digest of one whole input, retained only while it is hashed. */
export async function digestInput(
  context: CommandContext,
  algorithm: Algorithm,
  input: Extract<Input, { kind: "file" | "stdin" }>,
): Promise<string> {
  const held =
    input.kind === "stdin"
      ? await drainBounded(context.stdin ?? empty(), context.fs.retained, `${algorithm.tag} input`)
      : readWhole(context, input.path, input.size, `${algorithm.tag} input`);
  try {
    const digest = await crypto.subtle.digest(algorithm.digest, held.bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } finally {
    held.release();
  }
}

function readWhole(
  context: CommandContext,
  path: string,
  size: number,
  label: string,
): { bytes: Uint8Array; release: () => void } {
  const release = context.fs.retained.retain(size, label);
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(context.fs.readBudget, size - offset);
      const releasePiece = context.fs.retained.retain(length, label);
      try {
        const piece = context.fs.readRange(path, offset, length);
        if (piece.length === 0) break;
        bytes.set(piece, offset);
        offset += piece.length;
      } finally {
        releasePiece();
      }
    }
    return { bytes: bytes.subarray(0, offset), release };
  } catch (error) {
    release();
    throw error;
  }
}
