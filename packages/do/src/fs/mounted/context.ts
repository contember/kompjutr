// What every part of a mounted view shares: the store, the mount table, and
// the two translations at its edge — virtual roots in, real paths out of
// errors.

import type { SqlDatabase } from "../../db/db.js";
import { filesystemError } from "../errors.js";
import { createFilesystemOps, type FilesystemOps } from "../ops.js";
import { isCanonicalPath, normalize } from "../path.js";
import { confinedResolver, resolveWithin } from "../store/resolve.js";
import type { RealPath } from "../types.js";
import { realRealPath } from "./items.js";
import { type Location, locate } from "./locate.js";
import { inSource, type Mount, type MountTable, virtualOf } from "./mounts.js";

export class ViewContext {
  readonly #ops = new Map<Mount, FilesystemOps>();

  constructor(
    readonly db: SqlDatabase,
    readonly table: MountTable,
    readonly now: () => number,
    private readonly sources: ReadonlyMap<Mount, RealPath>,
  ) {}

  /** Single-path operations whose every resolution stays inside the mount. */
  ops(mount: Mount): FilesystemOps {
    let ops = this.#ops.get(mount);
    if (ops === undefined) {
      ops = createFilesystemOps(this.db, {
        now: this.now,
        resolver: confinedResolver(this.db, mount.source, mount.top),
      });
      this.#ops.set(mount, ops);
    }
    return ops;
  }

  locate(path: string): Location {
    return locate(this.db, this.table, path);
  }

  /** The mount's source as the store's resolved path. */
  source(mount: Mount): RealPath {
    const source = this.sources.get(mount);
    if (source === undefined) throw new Error("mounted view: mount is not in its table");
    return source;
  }

  /**
   * Run store work and rewrite the real paths its errors quote into virtual
   * ones, so a caller never learns where a mount's source lives.
   */
  translating<T>(mounts: readonly Mount[], work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof Error) rewriteError(error, mounts);
      throw error;
    }
  }
}

function toVirtual(mounts: readonly Mount[], path: string): string {
  let best: Mount | undefined;
  for (const mount of mounts) {
    if (!inSource(mount, path)) continue;
    if (best === undefined || mount.base.length > best.base.length) best = mount;
  }
  return best === undefined ? path : virtualOf(best, path);
}

function rewriteError(error: Error, mounts: readonly Mount[]): void {
  error.message = error.message.replace(
    /'(\/[^']*)'/g,
    (_match, path: string) => `'${toVirtual(mounts, path)}'`,
  );
  if ("path" in error && typeof error.path === "string") {
    error.path = toVirtual(mounts, error.path);
  }
}

/** A root a paged call starts from. */
export type ViewRoot =
  | { readonly kind: "mount"; readonly mount: Mount; readonly real: RealPath }
  | { readonly kind: "above"; readonly path: string }
  /** Absent, or a root that would leave its mount: it has no rows. */
  | { readonly kind: "none"; readonly path: string };

/**
 * Resolve a caller's root as the store resolves one: following every
 * symlink, one statement inside a mount, none above the mounts. A root that
 * is absent or would leave its mount has no rows.
 */
export function resolveRoot(context: ViewContext, input: string): ViewRoot {
  const location = context.locate(input);
  if (location.kind === "synthetic") return { kind: "above", path: location.path };
  if (location.kind === "absent") return { kind: "none", path: normalize(input) };
  const { mount } = location;
  const real = context.translating([mount], () =>
    resolveWithin(context.db, mount.source, location.real, true, mount.top),
  );
  return typeof real === "string"
    ? { kind: "mount", mount, real }
    : { kind: "none", path: normalize(input) };
}

/** A root the caller already resolved through this view. No statement. */
export function resolvedRoot(context: ViewContext, root: RealPath): ViewRoot {
  if (!isCanonicalPath(root)) return { kind: "none", path: normalize(root) };
  const place = context.table.place(root);
  if (place.kind === "synthetic") return { kind: "above", path: root };
  if (place.kind === "absent") return { kind: "none", path: root };
  return { kind: "mount", mount: place.mount, real: realRealPath(place.mount, root) };
}

export function readOnly(path: string): Error {
  return filesystemError("EROFS", "read-only file system", path);
}

export function missing(path: string): Error {
  return filesystemError("ENOENT", "no such file or directory", path);
}
