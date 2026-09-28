// The scan pages a walk reads, and what it can learn from the page in hand.
//
// Emptiness: a directory's children, if any, follow it within `[d/, d0)`, so
// the page usually answers without another statement. Only a directory on the
// last row of a full page costs a single-row `scan`.
//
// Liveness: an `-exec` command can remove or change rows the walk already
// holds. After a command ran, the next row re-reads one page from the previous
// row onward, so the walk evaluates rows as they are now: a row missing from
// the re-read is gone. One `scan` per command run, not one `stat` per row.

import { comparePaths, subtreeSuccessor } from "../../../fs/path.js";
import { SCAN_STREAM_PAGE } from "../../../fs/store/scan/scan-stream.js";
import type { ScanEntry, ScanOptions } from "../../../fs/types.js";
import type { CommandContext } from "../../exec/context.js";

export class ScanPages {
  #page: ScanEntry[] = [];
  #previous: string | undefined;
  #checkedAt = 0;
  /** Rows re-read after a command ran, or null while the page in hand is current. */
  #fresh: Map<string, ScanEntry> | null = null;
  /** The last re-read row of a full page; null when the re-read reached the end. */
  #horizon: string | null = null;

  /** `runs` counts `-exec` invocations; null when the expression has none. */
  constructor(
    private readonly context: CommandContext,
    private readonly start: string,
    private readonly runs: (() => number) | null,
  ) {}

  readonly read = (options: ScanOptions): ScanEntry[] => {
    this.#page = this.context.fs.scan(this.start, options);
    this.#fresh = null;
    this.#checkedAt = this.runs?.() ?? 0;
    return this.#page;
  };

  /** `entry` as it is now, or null when a command removed it. Called once per row, in order. */
  current(entry: ScanEntry): ScanEntry | null {
    const previous = this.#previous;
    this.#previous = entry.path;
    if (this.runs === null) return entry;
    if (this.runs() !== this.#checkedAt) this.#reread(previous);
    while (this.#fresh !== null) {
      const row = this.#fresh.get(entry.path);
      if (row !== undefined) return row;
      if (this.#horizon === null || comparePaths(entry.path, this.#horizon) <= 0) return null;
      this.#reread(this.#horizon);
    }
    return entry;
  }

  /** Whether `directory`, a row of the current page, has children. */
  hasChildren(directory: string): boolean {
    const page = this.#page;
    const lower = `${directory}/`;
    let low = 0;
    let high = page.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (comparePaths(page[middle]?.path ?? "", lower) < 0) low = middle + 1;
      else high = middle;
    }
    const next = page[low];
    if (next !== undefined) return comparePaths(next.path, subtreeSuccessor(directory)) < 0;
    if (page.length < SCAN_STREAM_PAGE) return false;
    return hasDescendants(this.context, directory);
  }

  #reread(after: string | undefined): void {
    const rows = this.context.fs.scan(
      this.start,
      after === undefined ? { limit: SCAN_STREAM_PAGE } : { after, limit: SCAN_STREAM_PAGE },
    );
    this.#fresh = new Map(rows.map((row) => [row.path, row]));
    this.#horizon = rows.length < SCAN_STREAM_PAGE ? null : (rows.at(-1)?.path ?? null);
    this.#checkedAt = this.runs?.() ?? 0;
  }
}

export function hasDescendants(context: CommandContext, directory: string): boolean {
  return context.fs.scan(directory, { limit: 1 }).length > 0;
}
