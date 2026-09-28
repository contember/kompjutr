// What a list, pipeline, or compound command runs against.
//
// A runner is an async generator of output segments: each yielded stream is
// the stdout of one pipeline, drained or closed by the consumer before the
// runner resumes. The top level writes segments to the public sink; a
// compound stage flattens them into its own lazily produced stdout, so a
// downstream `head` that stops pulling stops the body as well.

import type { PlannedCompound } from "../../plan/types.js";
import type { LoopBudget, UnboundVariable } from "../arguments.js";
import { type ByteStream, encode } from "../bytes.js";
import type { BoundedFs, Command } from "../context.js";
import type { ShellState } from "./state.js";

/** A shared stdin position that each pipeline borrows from in turn. */
export interface StdinCursor {
  borrow(): ByteStream | null;
}

/** A shell's own stderr: where a command's unredirected diagnostics go. */
export interface DiagnosticPort {
  writeBytes(bytes: Uint8Array): void;
  write(stream: ByteStream): Promise<void>;
  /** Bytes a command may still send here: the terminal sink's room, or unbounded for a pipe or file. */
  limit(): number;
  /** Everything written here is dropped, as under `{ …; } 2>/dev/null`. */
  readonly discards: boolean;
}

export interface ShellIO {
  readonly stdin: StdinCursor | null;
  readonly stderr: DiagnosticPort;
  /** The same bound for the unredirected stdout of a list's last stage. */
  stdoutLimit(): number;
}

/** Shared by every shell of one run. */
export interface Runtime {
  readonly fs: BoundedFs;
  readonly commands: ReadonlyMap<string, Command>;
  readonly loops: LoopBudget;
  now(): number;
  /** Set once any settled command reports truncation. */
  truncated: boolean;
  /** Runs a compound command's body; injected so the pipeline need not import the interpreter. */
  compound(stage: PlannedCompound, frame: Frame): Segments;
}

export interface Frame {
  readonly shell: ShellState;
  readonly io: ShellIO;
  /** Enclosing loops that `break` and `continue` may leave in this shell. */
  readonly loops: number;
  /**
   * In an `if` condition, a non-final `&&`/`||` operand, or under `!`, and
   * in everything such a command contains: `set -e` does not exit there.
   */
  readonly errexitIgnored: boolean;
}

/** A request to leave enclosing constructs, carried up to the one that consumes it. */
export type Flow =
  | { readonly kind: "exit" }
  | { readonly kind: "break" | "continue"; readonly levels: number };

export const EXIT: Flow = { kind: "exit" };

export interface Outcome {
  readonly status: number;
  readonly flow: Flow | null;
}

export type Segments<Result extends Outcome = Outcome> = AsyncGenerator<
  ByteStream,
  Result,
  undefined
>;

export interface PipelineOutcome extends Outcome {
  /** The pipeline is one compound command whose body ran, not one whose redirection failed. */
  readonly compoundRan: boolean;
}

/** Bash exits a shell that fails fatally, such as on `set -u`, with this status. */
export function fatalStatus(frame: Frame): number {
  return frame.shell.options.errexit || frame.shell.forked ? 1 : 127;
}

/** Word expansion fails before redirections apply, so the shell's own stderr hears it. */
export function reportUnbound(frame: Frame, line: number, error: UnboundVariable): void {
  frame.io.stderr.writeBytes(encode(`bash: line ${line}: ${error.message}\n`));
}
