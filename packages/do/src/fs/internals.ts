// What a view built over a filesystem needs from the filesystem itself.
//
// A mounted view reads and writes the same tables, so it shares the store's
// clock and its mutation epoch: a write through either side must invalidate
// the paged-root caches of both, or a continuation page would reuse a root
// resolved before a symlink moved.

import type { SqlDatabase } from "../db/db.js";
import type { Filesystem, RealPath } from "./types.js";

export interface FilesystemInternals {
  readonly db: SqlDatabase;
  readonly now: () => number;
  /** Advance the shared mutation epoch. */
  mutated(): void;
  epoch(): number;
}

const registry = new WeakMap<Filesystem, FilesystemInternals>();

export function registerFilesystem(filesystem: Filesystem, internals: FilesystemInternals): void {
  registry.set(filesystem, internals);
}

/** The internals of a filesystem built by `createFilesystem`, or undefined. */
export function filesystemInternals(filesystem: Filesystem): FilesystemInternals | undefined {
  return registry.get(filesystem);
}

/**
 * Resolved roots of paged calls, kept so a continuation page does not
 * resolve its root again. Any mutation since the root was stored drops it.
 */
export class ResolvedRoots<T = RealPath> {
  #epoch: number;
  readonly #roots = new Map<string, T>();

  constructor(private readonly epoch: () => number) {
    this.#epoch = epoch();
  }

  get(root: string): T | undefined {
    this.#sync();
    return this.#roots.get(root);
  }

  /** Keep `resolved` while a continuation is expected, drop it otherwise. */
  keep(root: string, resolved: T, continues: boolean): void {
    this.#sync();
    if (continues) this.#roots.set(root, resolved);
    else this.#roots.delete(root);
  }

  #sync(): void {
    const current = this.epoch();
    if (current === this.#epoch) return;
    this.#roots.clear();
    this.#epoch = current;
  }
}
