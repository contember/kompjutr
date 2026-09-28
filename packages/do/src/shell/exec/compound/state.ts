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

/**
 * A bound value and its reservation, measured once when bound. Copies of a
 * shell share it until one of them rebinds the name: the retained budget
 * counts distinct values, not copies of the same immutable string.
 */
class Binding {
  #holders = 1;

  constructor(
    /** Undefined for a name that is unset: a tombstone over the snapshot, or exported with no value. */
    readonly value: string | undefined,
    readonly exported: boolean,
    readonly bytes: number,
    private readonly release: () => void,
  ) {}

  /** No other copy holds it, so dropping it frees its bytes. */
  get sole(): boolean {
    return this.#holders === 1;
  }

  hold(): void {
    this.#holders++;
  }

  drop(): void {
    this.#holders--;
    if (this.#holders === 0) this.release();
  }
}

/** An overlay shared by copies of a shell until one of them writes. */
interface Overlay {
  readonly bindings: Map<string, Binding>;
  owners: number;
  exported: Readonly<Record<string, string>> | undefined | null;
}

/**
 * Shell variables layered over the caller's frozen environment snapshot. Every
 * snapshot entry starts exported; a variable the run sets stays a shell
 * variable unless its name is exported, as in Bash. `unset` leaves a
 * tombstone over the snapshot, and the snapshot object is never mutated.
 * A copy shares its overlay and copies it on its first write, so a subshell
 * or pipeline stage costs nothing until it assigns.
 */
export class Variables {
  #overlay: Overlay;
  #released = false;

  constructor(
    private readonly base: Readonly<Record<string, string>> | undefined,
    private readonly retained: RetainedBudget,
    overlay?: Overlay,
  ) {
    this.#overlay = overlay ?? { bindings: new Map(), owners: 1, exported: null };
  }

  get(name: string): string | undefined {
    const bound = this.#overlay.bindings.get(name);
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
    return this.#overlay.bindings.get(name)?.exported ?? this.#base(name) !== undefined;
  }

  /** This copy's own overlay, copied from the shared one on the first write. */
  #writable(): Map<string, Binding> {
    const shared = this.#overlay;
    if (shared.owners > 1) {
      for (const binding of shared.bindings.values()) binding.hold();
      shared.owners--;
      this.#overlay = { bindings: new Map(shared.bindings), owners: 1, exported: null };
    }
    this.#overlay.exported = null;
    return this.#overlay.bindings;
  }

  #bind(name: string, value: string | undefined, exported: boolean): void {
    const bytes = utf8Bytes(name) + (value === undefined ? 0 : utf8Bytes(value));
    const bindings = this.#writable();
    const previous = bindings.get(name);
    // Free the old value first: a reassignment that fits once it is gone must succeed.
    const freed = previous?.sole === true;
    bindings.delete(name);
    previous?.drop();
    try {
      bindings.set(name, this.#reserve(value, exported, bytes));
    } catch (error) {
      if (previous !== undefined) {
        if (freed) {
          bindings.set(name, this.#reserve(previous.value, previous.exported, previous.bytes));
        } else {
          previous.hold();
          bindings.set(name, previous);
        }
      }
      throw error;
    }
  }

  #reserve(value: string | undefined, exported: boolean, bytes: number): Binding {
    return new Binding(value, exported, bytes, this.retained.retain(bytes, "shell variable"));
  }

  /** What commands see as `CommandContext.env`: the exported variables that have values. */
  exported(): Readonly<Record<string, string>> | undefined {
    const overlay = this.#overlay;
    if (overlay.exported !== null) return overlay.exported;
    let changed = false;
    for (const [name, binding] of overlay.bindings) {
      changed ||= binding.exported || this.#base(name) !== undefined;
    }
    if (!changed) {
      overlay.exported = this.base;
      return this.base;
    }
    // Snapshot names keep their place, as uutils `env` prints a reassigned name.
    const entries: Array<readonly [string, string]> = [];
    for (const name in this.base) {
      if (!Object.hasOwn(this.base, name)) continue;
      const value = overlay.bindings.has(name) ? this.#exportedValue(name) : this.base[name];
      if (value !== undefined) entries.push([name, value]);
    }
    for (const name of overlay.bindings.keys()) {
      if (this.#base(name) !== undefined) continue;
      const value = this.#exportedValue(name);
      if (value !== undefined) entries.push([name, value]);
    }
    overlay.exported = Object.freeze(Object.fromEntries(entries));
    return overlay.exported;
  }

  #exportedValue(name: string): string | undefined {
    const binding = this.#overlay.bindings.get(name);
    return binding?.exported === true ? binding.value : undefined;
  }

  /** A copy for a subshell or pipeline stage: O(1), sharing every binding. */
  clone(): Variables {
    this.#overlay.owners++;
    return new Variables(this.base, this.retained, this.#overlay);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const overlay = this.#overlay;
    overlay.owners--;
    if (overlay.owners > 0) return;
    for (const binding of overlay.bindings.values()) binding.drop();
    overlay.bindings.clear();
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
