// What `patch` tells the user. GNU writes its progress, its questions, and
// the default answers it takes without a terminal to stdout, and only fatal
// errors to stderr. The whole run's progress is held, reserved, until stdout
// is consumed or closed, because the work does not wait for stdout's reader.

import type { RetainedBudget } from "../../exec/context.js";

/** GNU's fatal path: `patch: **** <message>` on stderr and status 2. */
export class PatchFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchFatalError";
  }
}

/** A refusal of input this command does not implement: `patch: <message>`, status 2. */
export class PatchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchRefusal";
  }
}

const ENCODER = new TextEncoder();

const FIRST_CHUNK = 16;
const LARGEST_CHUNK = 64 * 1024;

export class Report {
  #chunks: Uint8Array[] = [];
  #releases: Array<() => void> = [];
  #current = new Uint8Array(0);
  #used = 0;

  constructor(
    private readonly budget: RetainedBudget,
    readonly silent: boolean,
  ) {}

  /** A line GNU prints even under `-s`. */
  always(text: string): void {
    this.bytes(ENCODER.encode(text));
  }

  /** A line `-s` suppresses. */
  verbose(text: string): void {
    if (!this.silent) this.always(text);
  }

  // Messages are copied into reserved chunks that double up to 64 KiB, so a
  // run of many short messages holds a few buffers, not an object apiece.
  bytes(bytes: Uint8Array): void {
    let at = 0;
    while (at < bytes.length) {
      if (this.#used === this.#current.length) this.#nextChunk(bytes.length - at);
      const length = Math.min(this.#current.length - this.#used, bytes.length - at);
      this.#current.set(bytes.subarray(at, at + length), this.#used);
      this.#used += length;
      at += length;
    }
  }

  #nextChunk(wanted: number): void {
    this.#seal();
    const doubled = Math.max(FIRST_CHUNK, this.#current.length * 2);
    const size = Math.min(LARGEST_CHUNK, Math.max(doubled, Math.min(wanted, LARGEST_CHUNK)));
    this.#releases.push(this.budget.retain(size, "patch messages"));
    this.#current = new Uint8Array(size);
    this.#used = 0;
  }

  #seal(): void {
    if (this.#used > 0) this.#chunks.push(this.#current.subarray(0, this.#used));
  }

  /** Hand the buffered output over with its reservation; the receiver releases it. */
  handOver(): { readonly chunks: readonly Uint8Array[]; release(): void } {
    this.#seal();
    const chunks = this.#chunks;
    const releases = this.#releases;
    this.#chunks = [];
    this.#releases = [];
    this.#current = new Uint8Array(0);
    this.#used = 0;
    return {
      chunks,
      release: () => {
        for (const release of releases) release();
      },
    };
  }
}

/** Plural as GNU spells it: `1 line`, `-1 lines`, `2 hunks`. */
export function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

const SHELL_SPECIAL = /[\s!"$&'()*;<=>?[\\^`|]/;

/**
 * A file name as GNU's default `shell` quoting style prints it: bare when
 * the shell would read it back unchanged, otherwise single-quoted, or
 * double-quoted when it holds a single quote and nothing that double quotes
 * would expand.
 */
export function quoteName(name: string): string {
  if (name !== "" && !SHELL_SPECIAL.test(name) && !/^[#~]/.test(name)) return name;
  if (name.includes("'")) {
    if (!/[$`\\"!]/.test(name)) return `"${name}"`;
    return `'${name.replaceAll("'", "'\\''")}'`;
  }
  return `'${name}'`;
}
