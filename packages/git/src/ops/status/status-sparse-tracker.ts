import type { IndexEntry } from "../../store/index.js";
import type { TargetEntry } from "../checkout/checkout.js";
import type { IndexTrackerSeedEntry } from "../core/context.js";
import type { WorktreePath } from "../worktree/worktree-io.js";
import { type BufferedStatusRow, octalMode } from "./status-rows.js";

const SPARSE_INDEX_DIRTY = 1;
const SPARSE_WORKTREE_DIRTY = 2;

/** Bounded dirty-leaf snapshot collected only by the eager repair pass. */
export class FullStatusTrackerSeed {
  #entries = new Map<string, number>();
  #available = true;
  #finished = false;

  get resealable(): boolean {
    return this.#available && this.#finished;
  }

  observeConflict(path: string): void {
    this.#mark(path, SPARSE_INDEX_DIRTY | SPARSE_WORKTREE_DIRTY);
  }

  observeUntracked(path: string): void {
    this.#mark(path, SPARSE_WORKTREE_DIRTY);
  }

  observeTracked(
    head: TargetEntry | undefined,
    entry: IndexEntry | undefined,
    worktree: WorktreePath | undefined,
    buffered: BufferedStatusRow | null,
  ): void {
    let flags = 0;
    if (
      entry?.mode === 0o160000 ||
      (head === undefined) !== (entry === undefined) ||
      (head !== undefined &&
        entry !== undefined &&
        (head.oid !== entry.oid || head.mode !== octalMode(entry.mode)))
    ) {
      flags |= SPARSE_INDEX_DIRTY;
    }

    if (entry === undefined) {
      if (worktree !== undefined) flags |= SPARSE_WORKTREE_DIRTY;
    } else if (entry.mode !== 0o160000) {
      if (worktree === undefined) flags |= SPARSE_WORKTREE_DIRTY;
      else if (buffered?.kind === "ready" && buffered.detail.worktree !== " ") {
        flags |= SPARSE_WORKTREE_DIRTY;
      }
    }
    this.#mark(head?.path ?? entry?.path ?? worktree?.path ?? "", flags);
  }

  observeHashed(path: string, dirty: boolean): void {
    if (dirty) this.#mark(path, SPARSE_WORKTREE_DIRTY);
  }

  finish(): void {
    this.#finished = true;
  }

  *entries(): Generator<IndexTrackerSeedEntry> {
    for (const [path, flags] of this.#entries) yield { path, flags };
  }

  #mark(path: string, flags: number): void {
    if (!this.#available || flags === 0) return;
    const previous = this.#entries.get(path);
    if (previous !== undefined) {
      this.#entries.set(path, previous | flags);
      return;
    }
    if (!trackerPathRepresentable(path)) {
      this.#disable();
      return;
    }
    this.#entries.set(path, flags);
  }

  #disable(): void {
    this.#available = false;
    this.#entries = new Map();
  }
}

function trackerPathRepresentable(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.endsWith("/") || path.includes("\0")) {
    return false;
  }
  let segmentStart = 0;
  for (let at = 0; at < path.length; at++) {
    const unit = path.charCodeAt(at);
    if (unit === 0x2f) {
      if (!validTrackerSegment(path, segmentStart, at)) return false;
      segmentStart = at + 1;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(++at);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return validTrackerSegment(path, segmentStart, path.length);
}

function validTrackerSegment(path: string, start: number, end: number): boolean {
  const length = end - start;
  return !(
    length === 0 ||
    (length === 1 && path.charCodeAt(start) === 0x2e) ||
    (length === 2 && path.charCodeAt(start) === 0x2e && path.charCodeAt(start + 1) === 0x2e)
  );
}
