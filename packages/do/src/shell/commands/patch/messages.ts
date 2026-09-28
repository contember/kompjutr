// What `patch` says and how it stops. GNU patch writes progress to stdout
// and fatal errors to stderr as `patch: **** …`; a usage error adds getopt's
// "Try" line. Stdout is held against the retained budget until the command
// settles, because the files are published before it is returned.

import { concat, encode } from "../../exec/bytes.js";
import type { RetainedBudget } from "../../exec/context.js";

/**
 * A fatal error: exit status 2 after the queued outputs are published. GNU's
 * own carry its `****` marker; this patch's refusals do not.
 */
export class PatchFatal extends Error {
  readonly detail: Uint8Array;

  constructor(
    detail: string | Uint8Array,
    readonly marked = true,
  ) {
    super(typeof detail === "string" ? detail : "patch fatal error");
    this.name = "PatchFatal";
    this.detail = typeof detail === "string" ? encode(detail) : detail;
  }

  /** The complete stderr line. */
  diagnostic(): Uint8Array {
    return joinBytes(this.marked ? "patch: **** " : "patch: ", this.detail, "\n");
  }
}

/** A command-line error, reported before any input is read. */
export class PatchUsage extends Error {
  constructor(
    message: string,
    /** Whether getopt's "Try 'patch --help'" line follows. */
    readonly tryHelp = true,
  ) {
    super(message);
    this.name = "PatchUsage";
  }
}

/** Stdout, in order, reserved on the retained budget as it grows. */
export class Transcript {
  readonly #chunks: Uint8Array[] = [];
  readonly #releases: Array<() => void> = [];

  constructor(private readonly budget: RetainedBudget) {}

  say(text: string | Uint8Array): void {
    const bytes = typeof text === "string" ? encode(text) : text;
    if (bytes.length === 0) return;
    this.#releases.push(this.budget.retain(bytes.length, "patch output"));
    this.#chunks.push(bytes);
  }

  get chunks(): readonly Uint8Array[] {
    return this.#chunks;
  }

  release(): void {
    for (const release of this.#releases) release();
    this.#releases.length = 0;
  }
}

/** Text and raw bytes, as one buffer. */
export function joinBytes(...parts: ReadonlyArray<string | Uint8Array>): Uint8Array {
  return concat(parts.map((part) => (typeof part === "string" ? encode(part) : part)));
}
