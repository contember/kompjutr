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

export class Report {
  #chunks: Uint8Array[] = [];
  #releases: Array<() => void> = [];

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

  bytes(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#releases.push(this.budget.retain(bytes.length, "patch messages"));
    this.#chunks.push(bytes);
  }

  /** Hand the buffered output over with its reservation; the receiver releases it. */
  handOver(): { readonly chunks: readonly Uint8Array[]; release(): void } {
    const chunks = this.#chunks;
    const releases = this.#releases;
    this.#chunks = [];
    this.#releases = [];
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
