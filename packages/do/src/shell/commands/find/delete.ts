// `-delete`, batched. The walk is post-order, so a directory is queued after
// everything under it. A non-recursive `removeFiles` refuses a directory that
// still has children *before* it deletes anything, so a directory cannot share
// a call with its own children: each queued path carries a generation — one
// more than the highest generation among its queued children — and a flush
// removes generation 0, then 1, and so on. A flush costs one call per
// generation, not one per path, and nothing unseen is ever removed.
//
// When a call fails as a whole, its generation is retried one path at a time
// so that each failure gets GNU's own diagnostic.

import type { CommandContext } from "../../exec/context.js";
import { isFilesystemError } from "../../exec/redirections.js";

/**
 * Deletions settle at most this many paths behind the walk — about one scan
 * page — so the paths held and the JSON bound into one statement stay
 * proportional to a page rather than to the tree.
 */
const DELETE_BATCH = 1_000;

const REASONS: ReadonlyMap<string, string> = new Map([
  ["ENOTEMPTY", "Directory not empty"],
  ["ENOENT", "No such file or directory"],
  ["ENOTDIR", "Not a directory"],
  ["EINVAL", "Invalid argument"],
  ["EBUSY", "Device or resource busy"],
  ["EACCES", "Permission denied"],
  ["EPERM", "Operation not permitted"],
]);

export interface Removal {
  /** What `removeFiles` is handed. */
  readonly path: string;
  /** What a diagnostic names. */
  readonly display: string;
}

export class Deleter {
  #generations: Removal[][] = [];
  #pending = 0;
  #epoch = 0;
  #failed = false;
  #releases: Array<() => void> = [];

  /**
   * `immediate` removes each path as it is queued and reports the real
   * outcome. An `-exec` command can change the tree between two entries,
   * which would make what the walk saw a guess.
   */
  constructor(
    private readonly context: CommandContext,
    readonly immediate: boolean,
  ) {}

  /** Advances on every flush; a generation recorded in an older epoch is gone. */
  get epoch(): number {
    return this.#epoch;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** False only when an immediate removal failed. */
  queue(removal: Removal, generation: number): boolean {
    let batch = this.#generations[generation];
    if (batch === undefined) {
      batch = [];
      this.#generations[generation] = batch;
    }
    batch.push(removal);
    this.#releases.push(
      this.context.fs.retained.retain(
        (removal.path.length + removal.display.length) * 2,
        "find -delete batch",
      ),
    );
    this.#pending++;
    if (this.immediate) return this.flush();
    if (this.#pending >= DELETE_BATCH) this.flush();
    return true;
  }

  /** Reports a removal find decided cannot succeed without asking the filesystem. */
  refuse(display: string, reason: string): void {
    this.context.warn(`cannot delete '${display}': ${reason}`);
    this.#failed = true;
  }

  /** Drops what is still queued, for a walk that failed before its final flush. */
  discard(): void {
    for (const release of this.#releases) release();
    this.#generations = [];
    this.#releases = [];
    this.#pending = 0;
  }

  /** Removes everything queued. True when every removal succeeded. */
  flush(): boolean {
    const generations = this.#generations;
    const releases = this.#releases;
    this.#generations = [];
    this.#releases = [];
    this.#pending = 0;
    this.#epoch++;
    let succeeded = true;
    try {
      for (const batch of generations) {
        if (batch === undefined || batch.length === 0) continue;
        if (!this.#remove(batch)) succeeded = false;
      }
    } finally {
      for (const release of releases) release();
    }
    return succeeded;
  }

  #remove(batch: readonly Removal[]): boolean {
    try {
      this.context.fs.removeFiles(
        batch.map((removal) => removal.path),
        { force: false },
      );
      return true;
    } catch (error) {
      if (!isFilesystemError(error) || batch.length === 1) {
        this.#report(batch[0], error);
        return false;
      }
    }
    let succeeded = true;
    for (const removal of batch) {
      try {
        this.context.fs.removeFiles([removal.path], { force: false });
      } catch (error) {
        this.#report(removal, error);
        succeeded = false;
      }
    }
    return succeeded;
  }

  #report(removal: Removal | undefined, error: unknown): void {
    if (removal === undefined || !isFilesystemError(error)) throw error;
    this.refuse(removal.display, REASONS.get(error.code) ?? error.message);
  }
}
