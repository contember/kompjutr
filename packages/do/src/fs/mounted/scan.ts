// `scan`, `scanStream`, and `listEntries` through a mounted view.
//
// A root inside a mount is the store's own page with its paths rebased: the
// same statements, no more. A root above the mounts walks the items under it
// in path order — a synthetic directory costs nothing, a mount root one
// metadata read, a mount's subtree one page statement.

import { comparePaths, subtreeSuccessor } from "../path.js";
import { orderedScan } from "../store/scan/scan-stream.js";
import { listEntries as storeListEntries, scan as storeScan } from "../store/scan.js";
import type {
  ListCursor,
  ListItem,
  ListOptions,
  ListPage,
  OrderedScanOptions,
  ScanEntry,
  ScanOptions,
} from "../types.js";
import type { ViewContext, ViewRoot } from "./context.js";
import {
  type Item,
  itemsUnder,
  keyOf,
  mountBounds,
  mountRootStat,
  pointVisible,
  type Resume,
  realIn,
  resumeIn,
  virtualEntry,
} from "./items.js";
import { type Mount, virtualOf } from "./mounts.js";

function checkScanOptions(options: ScanOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`scan: limit must be a positive integer, got ${options.limit}`);
  }
  if (options.after !== undefined && options.afterSubtree !== undefined) {
    throw new Error("scan: after and afterSubtree are mutually exclusive");
  }
}

function storeOptions(resume: Resume, options: ScanOptions, limit: number): ScanOptions | null {
  const base = { limit, filesOnly: options.filesOnly };
  switch (resume.kind) {
    case "skip":
      return null;
    case "whole":
      return base;
    case "after":
      return { ...base, after: resume.real };
    case "afterSubtree":
      return { ...base, afterSubtree: resume.real };
  }
}

/** One page under a resolved view root. */
export function scanPage(context: ViewContext, root: ViewRoot, options: ScanOptions): ScanEntry[] {
  checkScanOptions(options);
  if (root.kind === "none") return [];
  if (root.kind === "mount") {
    const { mount } = root;
    const { lower, upper } = mountBounds(mount);
    const page = storeOptions(resumeIn(mount, lower, upper, options), options, options.limit);
    if (page === null) return [];
    return context.translating([mount], () =>
      storeScan(context.db, root.real, page).map((entry) => virtualEntry(mount, entry)),
    );
  }
  return scanAbove(context, root.path, options);
}

function scanAbove(context: ViewContext, root: string, options: ScanOptions): ScanEntry[] {
  const out: ScanEntry[] = [];
  for (const item of itemsUnder(context.table, root)) {
    const wanted = options.limit - out.length;
    if (wanted <= 0) break;
    if (item.kind !== "tree") {
      if (options.filesOnly === true || !pointVisible(item.path, options)) continue;
      const stat =
        item.kind === "synthetic"
          ? context.table.syntheticStat(item.path)
          : mountRootStat(context.db, context.source(item.mount));
      if (stat !== null) out.push({ ...stat, path: item.path });
      continue;
    }
    const { mount } = item;
    const page = storeOptions(resumeIn(mount, item.lower, item.upper, options), options, wanted);
    if (page === null) continue;
    const rows = context.translating([mount], () =>
      storeScan(context.db, context.source(mount), page),
    );
    for (const entry of rows) out.push(virtualEntry(mount, entry));
    if (rows.length >= wanted) break;
  }
  return out;
}

/** The streamed form: `orderedScan` over the view's own pages. */
export function scanStreamFrom(
  context: ViewContext,
  root: ViewRoot,
  options: OrderedScanOptions,
): Iterable<ScanEntry> {
  return orderedScan((pageOptions) => scanPage(context, root, pageOptions), options);
}

// -- listEntries ---------------------------------------------------------

const LIST_PAGE_MAX = 1_000;

type Group =
  | { readonly kind: "synthetic"; readonly directory: string }
  /** The mount root's own group, its subtree's groups, or both at once. */
  | { readonly kind: "mount"; readonly mount: Mount; readonly part: "root" | "tree" | "all" };

function groupKey(group: Group): string {
  if (group.kind === "synthetic") return group.directory;
  return group.part === "tree" ? `${group.mount.path}/` : group.mount.path;
}

/**
 * Directory groups under a synthetic root in directory order. A mount whose
 * root group and subtree groups are adjacent is listed in one statement.
 */
function groupsUnder(context: ViewContext, root: string, recursive: boolean): Group[] {
  const groups: Group[] = [{ kind: "synthetic", directory: root }];
  if (!recursive) return groups;
  const items: Item[] = itemsUnder(context.table, root);
  const keys = items.map(keyOf);
  for (const item of items) {
    if (item.kind === "synthetic") groups.push({ kind: "synthetic", directory: item.path });
    if (item.kind !== "mount-root") continue;
    const { mount } = item;
    const lower = `${mount.path}/`;
    const between = keys.some(
      (key) => comparePaths(key, mount.path) > 0 && comparePaths(key, lower) < 0,
    );
    if (between) {
      groups.push({ kind: "mount", mount, part: "root" }, { kind: "mount", mount, part: "tree" });
    } else {
      groups.push({ kind: "mount", mount, part: "all" });
    }
  }
  return groups.sort((left, right) => comparePaths(groupKey(left), groupKey(right)));
}

function checkListLimit(options: ListOptions): number {
  const limit = options.limit ?? LIST_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX) {
    throw new Error(
      `listEntries: limit must be an integer from 1 to ${LIST_PAGE_MAX}, got ${limit}`,
    );
  }
  return limit;
}

function realCursor(mount: Mount, cursor: ListCursor): ListCursor {
  return {
    directory: realIn(mount, cursor.directory),
    path: cursor.path === null ? null : realIn(mount, cursor.path),
  };
}

function virtualItem(mount: Mount, item: ListItem): ListItem {
  return {
    directory: virtualOf(mount, item.directory),
    entry: item.entry === null ? null : virtualEntry(mount, item.entry),
  };
}

function inMount(mount: Mount, path: string): boolean {
  return mount.prefix === "" || path === mount.path || path.startsWith(`${mount.prefix}/`);
}

function pageOf(items: ListItem[], more: boolean): ListPage {
  const last = items[items.length - 1];
  return {
    items,
    next:
      more && last !== undefined
        ? { directory: last.directory, path: last.entry?.path ?? null }
        : null,
  };
}

/** One `listEntries` page under a resolved view root. */
export function listPage(context: ViewContext, root: ViewRoot, options: ListOptions): ListPage {
  const limit = checkListLimit(options);
  if (root.kind === "none") {
    const after = options.after;
    const done = after !== undefined && comparePaths(after.directory, root.path) >= 0;
    return { items: done ? [] : [{ directory: root.path, entry: null }], next: null };
  }
  if (root.kind === "mount") {
    const { mount } = root;
    const after = options.after;
    let real: ListCursor | undefined;
    if (after !== undefined) {
      if (inMount(mount, after.directory)) real = realCursor(mount, after);
      else if (comparePaths(after.directory, mount.path) > 0) return { items: [], next: null };
    }
    return context.translating([mount], () => {
      const page = storeListEntries(context.db, root.real, {
        after: real,
        limit,
        recursive: options.recursive,
      });
      return pageOf(
        page.items.map((item) => virtualItem(mount, item)),
        page.next !== null,
      );
    });
  }
  return listAbove(context, root.path, options, limit);
}

function syntheticItems(context: ViewContext, directory: string): ListItem[] {
  const items: ListItem[] = [];
  for (const child of context.table.childrenOf(directory)) {
    const mount = context.table.mountAt(child);
    const stat =
      mount === undefined
        ? context.table.syntheticStat(child)
        : mountRootStat(context.db, context.source(mount));
    if (stat !== null) items.push({ directory, entry: { ...stat, path: child } });
  }
  return items.length === 0 ? [{ directory, entry: null }] : items;
}

function covers(group: Group & { kind: "mount" }, directory: string): boolean {
  const { mount, part } = group;
  if (part === "root") return directory === mount.path;
  const under = directory.startsWith(`${mount.path}/`);
  return part === "tree" ? under : under || directory === mount.path;
}

function listAbove(
  context: ViewContext,
  root: string,
  options: ListOptions,
  limit: number,
): ListPage {
  const after = options.after;
  const out: ListItem[] = [];
  for (const group of groupsUnder(context, root, options.recursive === true)) {
    const wanted = limit - out.length;
    if (wanted <= 0) return pageOf(out, true);
    if (group.kind === "synthetic") {
      const { directory } = group;
      if (after !== undefined && comparePaths(directory, after.directory) < 0) continue;
      let items = syntheticItems(context, directory);
      if (after !== undefined && directory === after.directory) {
        const from = after.path;
        items = items.filter(
          (item) => from !== null && item.entry !== null && comparePaths(item.entry.path, from) > 0,
        );
      }
      out.push(...items.slice(0, wanted));
      if (items.length > wanted) return pageOf(out, true);
      continue;
    }

    const { mount } = group;
    const source = context.source(mount);
    const skipRoot: ListCursor = { directory: source, path: subtreeSuccessor(source) };
    let cursor: ListCursor | undefined = group.part === "tree" ? skipRoot : undefined;
    if (after !== undefined && covers(group, after.directory)) {
      cursor = realCursor(mount, after);
    } else if (after !== undefined && comparePaths(after.directory, groupKey(group)) >= 0) {
      continue;
    }
    const page = context.translating([mount], () =>
      storeListEntries(context.db, source, {
        after: cursor,
        limit: wanted,
        recursive: group.part !== "root",
      }),
    );
    for (const item of page.items) out.push(virtualItem(mount, item));
    if (page.next !== null) return pageOf(out, true);
  }
  return pageOf(out, false);
}
