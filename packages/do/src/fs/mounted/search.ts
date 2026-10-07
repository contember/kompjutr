// Pattern-bearing pages through a mounted view: `glob`, `globPage`,
// `discoverFiles`, and `discoverFilesContaining`.
//
// The caller's pattern speaks virtual paths. Each mount gets the real
// pattern `mountPattern` derives, so the GLOB stays pushed down in the one
// statement the store would issue; a superset pattern is filtered here, and
// its page keeps the store's cursor, so a page may come back short with a
// continuation.

import { normalize } from "../path.js";
import { DISCOVERY_PAGE_MAX, validatePattern } from "../store/scan/scan-shared.js";
import {
  discoverFiles as storeDiscoverFiles,
  glob as storeGlob,
  globPage as storeGlobPage,
} from "../store/scan.js";
import { discoverFilesContaining as storeSearch } from "../store/search.js";
import type {
  ContentSearchOptions,
  ContentSearchPage,
  DiscoverFilesOptions,
  DiscoverFilesPage,
  GlobOptions,
  GlobPage,
  RealPath,
  RegularFileHandle,
} from "../types.js";
import type { ViewContext, ViewRoot } from "./context.js";
import { type CompiledGlob, compileSqlGlob, type MountPattern, mountPattern } from "./glob.js";
import {
  type Item,
  itemsUnder,
  mountBounds,
  pointVisible,
  realIn,
  realRealPath,
  resumeIn,
  virtualRealPath,
} from "./items.js";
import { type Mount, virtualOf } from "./mounts.js";

function checkLimit(operation: string, limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
    throw new Error(
      `${operation}: limit must be an integer from 1 to ${DISCOVERY_PAGE_MAX}, got ${limit}`,
    );
  }
}

/** The mounts a page under `root` reads, in path order, with nothing else. */
function mountsOf(context: ViewContext, root: ViewRoot): { mount: Mount; real: RealPath }[] {
  if (root.kind === "none") return [];
  if (root.kind === "mount") return [{ mount: root.mount, real: root.real }];
  return itemsUnder(context.table, root.path)
    .filter((item): item is Item & { kind: "tree" } => item.kind === "tree")
    .map((item) => ({ mount: item.mount, real: context.source(item.mount) }));
}

/** A virtual resolved cursor as a real one: undefined starts, null skips. */
function realAfter(mount: Mount, after: RealPath | string | undefined): string | undefined | null {
  const { lower, upper } = mountBounds(mount);
  const resume = resumeIn(mount, lower, upper, { after });
  if (resume.kind === "skip") return null;
  return resume.kind === "after" ? resume.real : undefined;
}

function realAfterPath(mount: Mount, after: RealPath | undefined): RealPath | undefined | null {
  if (after === undefined) return undefined;
  const real = realAfter(mount, after);
  if (real === null) return null;
  return real === undefined ? undefined : realRealPath(mount, after);
}

function virtualHandle(mount: Mount, handle: RegularFileHandle): RegularFileHandle {
  return { ...handle, path: virtualRealPath(mount, handle.path) };
}

function keep(pattern: MountPattern, glob: CompiledGlob, path: string): boolean {
  return pattern.exact || glob.test(path);
}

// -- glob ------------------------------------------------------------------

export function globPageFrom(
  context: ViewContext,
  root: ViewRoot,
  pattern: string,
  options: GlobOptions,
): GlobPage {
  validatePattern(pattern, "globPage");
  const limit = options.limit ?? DISCOVERY_PAGE_MAX;
  checkLimit("globPage", limit);
  const glob = compileSqlGlob(pattern);
  const paths: string[] = [];
  const items: Item[] =
    root.kind === "above"
      ? itemsUnder(context.table, root.path)
      : root.kind === "mount"
        ? [{ kind: "tree", mount: root.mount, ...mountBounds(root.mount) }]
        : [];
  for (const item of items) {
    const wanted = limit - paths.length;
    if (wanted <= 0) return { paths, next: paths[paths.length - 1] ?? null };
    if (item.kind !== "tree") {
      if (pointVisible(item.path, options) && glob.test(item.path)) paths.push(item.path);
      continue;
    }
    const { mount } = item;
    const real = mountPattern(glob, mount);
    const after = realAfter(mount, options.after);
    if (real === null || after === null) continue;
    const realRoot = root.kind === "mount" ? root.real : context.source(mount);
    const page = context.translating([mount], () =>
      storeGlobPage(context.db, realRoot, real.sql, { after, limit: wanted }),
    );
    for (const found of page.paths) {
      const path = virtualOf(mount, found);
      if (keep(real, glob, path)) paths.push(path);
    }
    if (page.next !== null) return { paths, next: virtualOf(mount, page.next) };
  }
  return { paths, next: null };
}

export function globFrom(
  context: ViewContext,
  root: ViewRoot,
  pattern: string,
  options: { limit?: number },
): string[] {
  validatePattern(pattern, "glob");
  if (root.kind === "mount") {
    const { mount } = root;
    const real = mountPattern(compileSqlGlob(pattern), mount);
    if (real === null) return [];
    if (real.exact) {
      return context.translating([mount], () =>
        storeGlob(context.db, root.real, real.sql, options).map((path) => virtualOf(mount, path)),
      );
    }
  }
  const out: string[] = [];
  let after: string | undefined;
  for (;;) {
    const wanted = Math.min(DISCOVERY_PAGE_MAX, (options.limit ?? Infinity) - out.length);
    if (wanted <= 0) return out;
    const page = globPageFrom(context, root, pattern, { after, limit: wanted });
    out.push(...page.paths);
    if (page.next === null) return out;
    after = page.next;
  }
}

// -- discovery ---------------------------------------------------------------

/** Split virtual excluded roots by mount; a mount wholly excluded is skipped. */
function excludedIn(
  root: string,
  mount: Mount,
  input: readonly string[] | undefined,
): string[] | null {
  const prefix = root === "/" ? "/" : `${root}/`;
  const out: string[] = [];
  for (let index = 0; index < (input?.length ?? 0); index++) {
    const path = input?.[index];
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.includes("\0") ||
      normalize(path) !== path ||
      (path !== root && !path.startsWith(prefix))
    ) {
      throw new Error(`discoverFiles: excluded root ${index} is not canonical under '${root}'`);
    }
    if (path === mount.path || mount.path.startsWith(path === "/" ? "/" : `${path}/`)) return null;
    if (path.startsWith(`${mount.prefix}/`)) out.push(realIn(mount, path));
  }
  return out;
}

export function discoverFrom(
  context: ViewContext,
  root: ViewRoot,
  pattern: string,
  options: DiscoverFilesOptions,
): DiscoverFilesPage {
  validatePattern(pattern, "discoverFiles");
  const limit = options.limit ?? DISCOVERY_PAGE_MAX;
  checkLimit("discoverFiles", limit);
  const glob = compileSqlGlob(pattern);
  const handles: RegularFileHandle[] = [];
  const virtualRoot = root.kind === "mount" ? virtualRealPath(root.mount, root.real) : root.path;
  for (const { mount, real: realRoot } of mountsOf(context, root)) {
    const wanted = limit - handles.length;
    if (wanted <= 0) break;
    const excludeRoots = excludedIn(virtualRoot, mount, options.excludeRoots);
    const real = mountPattern(glob, mount);
    const after = realAfterPath(mount, options.after);
    if (excludeRoots === null || real === null || after === null) continue;
    const page = context.translating([mount], () =>
      storeDiscoverFiles(context.db, realRoot, real.sql, { after, limit: wanted, excludeRoots }),
    );
    for (const handle of page.handles) {
      const found = virtualHandle(mount, handle);
      if (keep(real, glob, found.path)) handles.push(found);
    }
    if (page.next !== null) return { handles, next: virtualRealPath(mount, page.next) };
  }
  return { handles, next: null };
}

export function searchFrom(
  context: ViewContext,
  root: ViewRoot,
  pattern: string,
  needle: Uint8Array,
  options: ContentSearchOptions,
): ContentSearchPage {
  validatePattern(pattern, "discoverFilesContaining");
  const limit = options.limit ?? DISCOVERY_PAGE_MAX;
  checkLimit("discoverFilesContaining", limit);
  const glob = compileSqlGlob(pattern);
  const matched: RegularFileHandle[] = [];
  const undecided: RegularFileHandle[] = [];
  for (const { mount, real: realRoot } of mountsOf(context, root)) {
    const wanted = limit - matched.length - undecided.length;
    if (wanted <= 0) break;
    const real = mountPattern(glob, mount);
    const after = realAfterPath(mount, options.after);
    if (real === null || after === null) continue;
    const page = context.translating([mount], () =>
      storeSearch(context.db, realRoot, real.sql, needle, { ...options, after, limit: wanted }),
    );
    const collect = (from: readonly RegularFileHandle[], to: RegularFileHandle[]): void => {
      for (const handle of from) {
        const found = virtualHandle(mount, handle);
        if (keep(real, glob, found.path)) to.push(found);
      }
    };
    collect(page.matched, matched);
    collect(page.undecided, undecided);
    if (page.next !== null) {
      return { matched, undecided, next: virtualRealPath(mount, page.next) };
    }
  }
  return { matched, undecided, next: null };
}
