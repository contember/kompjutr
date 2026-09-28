// The mutable state of one shell: working directory, last status, options, and
// variables. A group shares its shell's state; a subshell and every stage of
// a multi-stage pipeline run on a copy, so nothing they change leaks back.

import type { Parameters } from "../arguments.js";
import type { RetainedBudget } from "../context.js";
import { utf8Bytes } from "../utf8.js";

export interface ShellOptions {
  /** `set -e`. */
  errexit: boolean;
  /** `set -u`. */
  nounset: boolean;
  /** `set -o pipefail`. */
  pipefail: boolean;
}

interface Binding {
  readonly value: string;
  readonly exported: boolean;
  readonly release: () => void;
}

/**
 * Shell variables layered over the caller's frozen environment snapshot. Every
 * snapshot entry is exported; a variable the run sets stays a shell variable
 * unless its name was exported, as Bash keeps a loop variable out of `env`.
 * Values the run sets are reserved against the retained budget.
 */
export class Variables {
  readonly #overlay = new Map<string, Binding>();
  #exported: Readonly<Record<string, string>> | undefined | null = null;

  constructor(
    private readonly base: Readonly<Record<string, string>> | undefined,
    private readonly retained: RetainedBudget,
  ) {}

  get(name: string): string | undefined {
    const bound = this.#overlay.get(name);
    if (bound !== undefined) return bound.value;
    if (this.base === undefined || !Object.hasOwn(this.base, name)) return undefined;
    return this.base[name];
  }

  set(name: string, value: string): void {
    const previous = this.#overlay.get(name);
    const exported =
      previous?.exported ?? (this.base !== undefined && Object.hasOwn(this.base, name));
    const release = this.retained.retain(utf8Bytes(name) + utf8Bytes(value), "shell variable");
    previous?.release();
    this.#overlay.set(name, { value, exported, release });
    if (exported) this.#exported = null;
  }

  /** What commands see as `CommandContext.env`: the exported variables. */
  exported(): Readonly<Record<string, string>> | undefined {
    if (this.#exported !== null) return this.#exported;
    let exported = this.base;
    for (const [name, binding] of this.#overlay) {
      if (!binding.exported) continue;
      exported = { ...exported, [name]: binding.value };
    }
    this.#exported = exported === this.base ? exported : Object.freeze(exported);
    return this.#exported;
  }

  clone(): Variables {
    const copy = new Variables(this.base, this.retained);
    try {
      for (const [name, binding] of this.#overlay) {
        const release = this.retained.retain(
          utf8Bytes(name) + utf8Bytes(binding.value),
          "shell variable",
        );
        copy.#overlay.set(name, { ...binding, release });
      }
    } catch (error) {
      copy.release();
      throw error;
    }
    return copy;
  }

  release(): void {
    for (const binding of this.#overlay.values()) binding.release();
    this.#overlay.clear();
  }
}

export class ShellState {
  constructor(
    public cwd: string,
    /** `$?`: the status of the most recent pipeline. */
    public status: number,
    readonly options: ShellOptions,
    readonly variables: Variables,
    /**
     * Inside `( … )` or a compound pipeline stage. Bash exits such a shell
     * with status 1 where the top-level shell exits with 127.
     */
    readonly forked: boolean,
  ) {}

  static initial(
    cwd: string,
    env: Readonly<Record<string, string>> | undefined,
    retained: RetainedBudget,
  ): ShellState {
    return new ShellState(
      cwd,
      0,
      { errexit: false, nounset: false, pipefail: false },
      new Variables(env, retained),
      false,
    );
  }

  /** A copy for a subshell; `forked` marks a compound body. */
  clone(forked: boolean): ShellState {
    return new ShellState(
      this.cwd,
      this.status,
      { ...this.options },
      this.variables.clone(),
      this.forked || forked,
    );
  }

  release(): void {
    this.variables.release();
  }

  parameters(): Parameters {
    const options = this.options;
    return {
      value: (name) => (name === "?" ? String(this.status) : this.variables.get(name)),
      get nounset() {
        return options.nounset;
      },
    };
  }
}
