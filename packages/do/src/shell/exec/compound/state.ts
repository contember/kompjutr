// The mutable state of one shell: working directory, last status, options, and
// variables. A group shares its shell's state; a subshell and every stage of
// a multi-stage pipeline run on a copy, so nothing they change leaks back.

import { refuseIfs } from "../../plan/plan.js";
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
  /** Undefined for a name that is unset: a tombstone over the snapshot, or exported with no value. */
  readonly value: string | undefined;
  readonly exported: boolean;
  readonly release: () => void;
}

/**
 * Shell variables layered over the caller's frozen environment snapshot. Every
 * snapshot entry starts exported; a variable the run sets stays a shell
 * variable unless its name is exported, as in Bash. `unset` leaves a
 * tombstone over the snapshot, and the snapshot object is never mutated.
 * Bindings the run makes are reserved against the retained budget.
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
    return this.#base(name);
  }

  set(name: string, value: string): void {
    this.#bind(name, value, this.#isExported(name));
  }

  /** `export NAME[=value]`: the name stays exported through later assignments. */
  export(name: string, value?: string): void {
    this.#bind(name, value ?? this.get(name), true);
  }

  /** `export -n NAME`: the value stays, as a shell variable. */
  unexport(name: string): void {
    const value = this.get(name);
    if (value === undefined && !this.#isExported(name)) return;
    this.#bind(name, value, false);
  }

  unset(name: string): void {
    if (this.get(name) === undefined && !this.#isExported(name)) return;
    this.#bind(name, undefined, false);
  }

  #base(name: string): string | undefined {
    if (this.base === undefined || !Object.hasOwn(this.base, name)) return undefined;
    return this.base[name];
  }

  #isExported(name: string): boolean {
    return this.#overlay.get(name)?.exported ?? this.#base(name) !== undefined;
  }

  #bind(name: string, value: string | undefined, exported: boolean): void {
    const bytes = utf8Bytes(name) + (value === undefined ? 0 : utf8Bytes(value));
    const release = this.retained.retain(bytes, "shell variable");
    const previous = this.#overlay.get(name);
    previous?.release();
    this.#overlay.set(name, { value, exported, release });
    this.#exported = null;
  }

  /** What commands see as `CommandContext.env`: the exported variables that have values. */
  exported(): Readonly<Record<string, string>> | undefined {
    if (this.#exported !== null) return this.#exported;
    let changed = false;
    for (const [name, binding] of this.#overlay) {
      changed ||= binding.exported || this.#base(name) !== undefined;
    }
    if (!changed) {
      this.#exported = this.base;
      return this.base;
    }
    // Snapshot names keep their place, as uutils `env` prints a reassigned name.
    const entries: Array<readonly [string, string]> = [];
    for (const name in this.base) {
      if (!Object.hasOwn(this.base, name)) continue;
      const value = this.#overlay.has(name) ? this.#exportedValue(name) : this.base[name];
      if (value !== undefined) entries.push([name, value]);
    }
    for (const name of this.#overlay.keys()) {
      if (this.#base(name) !== undefined) continue;
      const value = this.#exportedValue(name);
      if (value !== undefined) entries.push([name, value]);
    }
    this.#exported = Object.freeze(Object.fromEntries(entries));
    return this.#exported;
  }

  #exportedValue(name: string): string | undefined {
    const binding = this.#overlay.get(name);
    return binding?.exported === true ? binding.value : undefined;
  }

  clone(): Variables {
    const copy = new Variables(this.base, this.retained);
    try {
      for (const [name, binding] of this.#overlay) {
        const bytes =
          utf8Bytes(name) + (binding.value === undefined ? 0 : utf8Bytes(binding.value));
        const release = this.retained.retain(bytes, "shell variable");
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
      assign: (name, value) => {
        refuseIfs(name);
        this.variables.set(name, value);
      },
      get nounset() {
        return options.nounset;
      },
    };
  }
}
