// The two walks under a starting point, both over the keyset scan in path
// byte order.
//
// Pre-order evaluates each row as it arrives. `-prune` and `-maxdepth` resume
// the scan past the skipped subtree instead of reading it.
//
// Post-order (`-depth`, `-delete`) holds each directory on a stack until the
// scan passes its subtree bound. Descendants of `d` occupy the contiguous
// range `[d/, d0)`, and anything between `d` and `d/` (`d-x`, `d.txt`) sorts
// entirely before that range, so bounds on the stack are nested and a
// directory pops only after everything beneath it has been evaluated. The
// stack is as deep as the tree, never as wide.
//
// Whether a directory is empty comes from the scan itself: in post-order,
// from whether every child was deleted; in pre-order, from the next rows of
// the page already in hand. Only a directory whose children the scan did not
// read — the last row of a full page, or one cut by `-maxdepth` — costs one
// `scan` of a single row. When an `-exec` command may have changed the tree,
// emptiness always asks the filesystem.

import { comparePaths, dirname, subtreeSuccessor } from "../../../fs/path.js";
import { orderedScan, SCAN_STREAM_PAGE } from "../../../fs/store/scan/scan-stream.js";
import type { ScanEntry, ScanOptions, Stat } from "../../../fs/types.js";
import type { CommandContext } from "../../exec/context.js";
import { displayUnder } from "../../exec/display.js";
import type { Deleter } from "./delete.js";
import { type Candidate, type Evaluation, evaluate, type Visit } from "./evaluate.js";
import type { FindCommand } from "./types.js";

export interface Walk {
  readonly context: CommandContext;
  readonly command: FindCommand;
  readonly evaluation: Evaluation;
  /** The starting point as typed, and resolved. */
  readonly operand: string;
  readonly start: string;
  readonly root: Stat;
  /** An `-exec` may change the tree mid-walk, so emptiness asks the filesystem. */
  readonly live: boolean;
  /** The expression tests `-empty` or `-delete`. */
  readonly needsEmptiness: boolean;
}

export async function* preOrder(walk: Walk): AsyncGenerator<Uint8Array, void, undefined> {
  const { context, command, evaluation, operand, start, root } = walk;
  const rootVisit: Visit = { pruned: false };
  if (command.minDepth === 0) {
    const candidate: Candidate = {
      display: operand,
      stat: root,
      emptyDirectory: () => !hasDescendants(context, start),
      remove: unreachableRemoval,
    };
    yield* evaluate(command.expression, candidate, evaluation, rootVisit);
  }
  if (!descends(walk) || rootVisit.pruned) return;

  const pages = new PageLookahead(context, start);
  const real = realPrefix(context, start);
  let skipLast = false;
  for (const entry of orderedScan(pages.read, { pruneDirectory: () => skipLast })) {
    const prefix = real(entry.path);
    const depth = depthUnder(prefix, entry.path);
    const visit: Visit = { pruned: false };
    if (depth >= command.minDepth) {
      const candidate: Candidate = {
        display: displayUnder(operand, prefix, entry.path),
        stat: entry,
        emptyDirectory: () =>
          walk.live ? !hasDescendants(context, entry.path) : !pages.hasChildren(entry.path),
        remove: unreachableRemoval,
      };
      yield* evaluate(command.expression, candidate, evaluation, visit);
    }
    skipLast = visit.pruned || (command.maxDepth !== null && depth >= command.maxDepth);
  }
}

interface Frame {
  /** Real for scanned rows; the resolved operand for the starting point. */
  readonly path: string;
  readonly display: string;
  readonly stat: Stat;
  readonly depth: number;
  readonly bound: string;
  /** Children exist that the walk did not read, because `-maxdepth` cut them. */
  readonly unreadChildren: () => boolean;
  /** Something beneath survives the walk. */
  retained: boolean;
  /** Highest deletion generation queued among children, valid in `childEpoch`. */
  childGeneration: number;
  childEpoch: number;
}

export async function* postOrder(
  walk: Walk,
  deleter: Deleter | null,
): AsyncGenerator<Uint8Array, void, undefined> {
  const { context, command, operand, start, root } = walk;
  const rootFrame = frame(start, operand, root, 0, () =>
    descends(walk) ? false : root.type === "dir" && hasDescendants(context, start),
  );
  if (descends(walk)) {
    const pages = new PageLookahead(context, start);
    const real = realPrefix(context, start);
    const stack: Frame[] = [];
    const parentOf = (child: Frame): Frame => {
      const parent = dirname(child.path);
      for (let index = stack.length - 1; index >= 0; index--) {
        const candidate = stack[index];
        if (candidate?.path === parent) return candidate;
      }
      return rootFrame;
    };
    let skipLast = false;
    for (const entry of orderedScan(pages.read, { pruneDirectory: () => skipLast })) {
      for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
        if (comparePaths(entry.path, top.bound) < 0) break;
        stack.pop();
        yield* finish(walk, deleter, top, parentOf(top));
      }
      const prefix = real(entry.path);
      const depth = depthUnder(prefix, entry.path);
      const cut = command.maxDepth !== null && depth >= command.maxDepth;
      const unread =
        cut && entry.type === "dir" && walk.needsEmptiness && pages.hasChildren(entry.path);
      const current = frame(
        entry.path,
        displayUnder(operand, prefix, entry.path),
        entry,
        depth,
        () => unread,
      );
      skipLast = cut;
      if (entry.type === "dir") {
        stack.push(current);
      } else {
        yield* finish(walk, deleter, current, parentOf(current));
      }
    }
    for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
      yield* finish(walk, deleter, top, parentOf(top));
    }
  }
  yield* finish(walk, deleter, rootFrame, null);
}

function frame(
  path: string,
  display: string,
  stat: Stat,
  depth: number,
  unreadChildren: () => boolean,
): Frame {
  return {
    path,
    display,
    stat,
    depth,
    bound: subtreeSuccessor(path),
    unreadChildren,
    retained: false,
    childGeneration: -1,
    childEpoch: -1,
  };
}

/** Evaluates a popped entry, then tells its parent whether it is gone. */
async function* finish(
  walk: Walk,
  deleter: Deleter | null,
  entry: Frame,
  parent: Frame | null,
): AsyncGenerator<Uint8Array, void, undefined> {
  const outcome: { generation: number | null } = { generation: null };
  if (entry.depth >= walk.command.minDepth) {
    const candidate: Candidate = {
      display: entry.display,
      stat: entry.stat,
      emptyDirectory: () =>
        walk.live
          ? !hasDescendants(walk.context, entry.path)
          : !entry.retained && !entry.unreadChildren(),
      remove: () => {
        if (deleter === null) return unreachableRemoval();
        const removal = remove(deleter, entry);
        outcome.generation = removal.generation;
        return removal.succeeded;
      },
    };
    yield* evaluate(walk.command.expression, candidate, walk.evaluation, { pruned: false });
  }
  if (parent === null) return;
  const generation = outcome.generation;
  if (generation === null || deleter === null) {
    parent.retained = true;
  } else if (parent.childEpoch !== deleter.epoch || parent.childGeneration < generation) {
    parent.childGeneration = generation;
    parent.childEpoch = deleter.epoch;
  }
}

interface RemovalOutcome {
  readonly succeeded: boolean;
  /** The generation the entry was queued in; null when it stays. */
  readonly generation: number | null;
}

function remove(deleter: Deleter, entry: Frame): RemovalOutcome {
  if (entry.depth === 0) {
    // GNU skips `.` and reports true; other dot operands fail as rmdir(2) does.
    if (entry.display === ".") return { succeeded: true, generation: null };
    const last = entry.display.replace(/\/+$/, "").split("/").at(-1);
    const reason = last === "." ? "Invalid argument" : last === ".." ? "Directory not empty" : null;
    if (reason !== null) {
      deleter.refuse(entry.display, reason);
      return { succeeded: false, generation: null };
    }
  }
  if (
    !deleter.immediate &&
    entry.stat.type === "dir" &&
    (entry.retained || entry.unreadChildren())
  ) {
    deleter.refuse(entry.display, "Directory not empty");
    return { succeeded: false, generation: null };
  }
  const generation = entry.childEpoch === deleter.epoch ? entry.childGeneration + 1 : 0;
  return deleter.queue({ path: entry.path, display: entry.display }, generation)
    ? { succeeded: true, generation }
    : { succeeded: false, generation: null };
}

function descends(walk: Walk): boolean {
  return walk.root.type === "dir" && walk.command.maxDepth !== 0;
}

function unreachableRemoval(): boolean {
  throw new Error("find: -delete implies -depth and never runs in this walk");
}

function hasDescendants(context: CommandContext, directory: string): boolean {
  return context.fs.scan(directory, { limit: 1 }).length > 0;
}

/** Remembers the page `orderedScan` is yielding from, to look ahead within it. */
class PageLookahead {
  #page: ScanEntry[] = [];

  constructor(
    private readonly context: CommandContext,
    private readonly start: string,
  ) {}

  readonly read = (options: ScanOptions): ScanEntry[] => {
    this.#page = this.context.fs.scan(this.start, options);
    return this.#page;
  };

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
}

/**
 * Scan results carry real paths. The resolved start usually is one, so the
 * realpath call is made only when a result shows otherwise.
 */
export function realPrefix(context: CommandContext, start: string): (path: string) => string {
  let prefix: string | null = null;
  return (path) => {
    if (prefix === null) {
      prefix = isUnder(path, start) ? start : context.fs.realpath(start);
    }
    return prefix;
  };
}

function depthUnder(prefix: string, path: string): number {
  return path.slice(prefix === "/" ? 1 : prefix.length + 1).split("/").length;
}

function isUnder(path: string, directory: string): boolean {
  return path.startsWith(directory === "/" ? "/" : `${directory}/`);
}
