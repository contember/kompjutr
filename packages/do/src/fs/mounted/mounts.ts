// The mount table of a mounted view: which virtual directories map onto which
// real ones, and the synthetic directories above them.
//
// Virtual and real paths translate by prefix. A mount at `/` has the empty
// prefix and a source at `/` the empty base, so `virtual = prefix + rest` and
// `real = base + rest` hold for every mount, with `rest` either empty or
// starting with `/`.

import { filesystemError } from "../errors.js";
import { assertWellFormedPath, comparePaths, isCanonicalPath, prefixesOf } from "../path.js";
import { S_IFDIR, type Stat } from "../types.js";

export type MountMode = "rw" | "ro";

export interface MountSpec {
  /** Absolute canonical path inside the view. */
  readonly path: string;
  /** Absolute canonical real directory it shows. */
  readonly source: string;
  readonly mode: MountMode;
}

export interface Mount {
  readonly path: string;
  readonly source: string;
  readonly mode: MountMode;
  readonly prefix: string;
  readonly base: string;
  /** Mounted at `/`: its source is the top of the namespace, as a chroot's is. */
  readonly top: boolean;
}

/** Where a canonical virtual path lies. */
export type Place =
  | { readonly kind: "mount"; readonly mount: Mount; readonly rest: string }
  | { readonly kind: "synthetic" }
  | { readonly kind: "absent" };

const SYNTHETIC_MODE = S_IFDIR | 0o555;

function isUnder(path: string, directory: string): boolean {
  return directory === "/" ? path !== "/" : path.startsWith(`${directory}/`);
}

function checkCanonical(path: string, what: string): void {
  assertWellFormedPath(path, what);
  if (!isCanonicalPath(path)) {
    throw filesystemError("EINVAL", `${what} must be an absolute canonical path`, path);
  }
}

export class MountTable {
  /** In `comparePaths` order of their virtual paths. */
  readonly mounts: readonly Mount[];
  readonly #synthetic: ReadonlyMap<string, number>;
  readonly #children: ReadonlyMap<string, readonly string[]>;

  constructor(specs: readonly MountSpec[]) {
    const mounts: Mount[] = [];
    for (const spec of specs) {
      checkCanonical(spec.path, "mount path");
      checkCanonical(spec.source, "mount source");
      if (spec.mode !== "rw" && spec.mode !== "ro") {
        throw filesystemError("EINVAL", "mount mode must be 'rw' or 'ro'", spec.path);
      }
      mounts.push({
        path: spec.path,
        source: spec.source,
        mode: spec.mode,
        prefix: spec.path === "/" ? "" : spec.path,
        base: spec.source === "/" ? "" : spec.source,
        top: spec.path === "/",
      });
    }
    mounts.sort((left, right) => comparePaths(left.path, right.path));
    for (const mount of mounts) {
      for (const other of mounts) {
        if (other === mount) continue;
        if (other.path === mount.path || isUnder(other.path, mount.path)) {
          throw filesystemError("EINVAL", `mount overlaps '${other.path}'`, mount.path);
        }
      }
    }

    const children = new Map<string, Set<string>>();
    for (const mount of mounts) {
      const prefixes = prefixesOf(mount.path);
      for (let index = 1; index < prefixes.length; index++) {
        const parent = prefixes[index - 1];
        const child = prefixes[index];
        if (parent === undefined || child === undefined) continue;
        const set = children.get(parent) ?? new Set<string>();
        set.add(child);
        children.set(parent, set);
      }
    }
    // `/` is synthetic unless it is itself a mount.
    if (mounts.length === 0) children.set("/", new Set());
    const synthetic = [...children.keys()].sort(comparePaths);
    this.#synthetic = new Map(synthetic.map((path, index) => [path, -(index + 1)]));
    this.#children = new Map(
      [...children].map(([parent, set]) => [parent, [...set].sort(comparePaths)]),
    );
    this.mounts = mounts;
  }

  /** Classify a canonical virtual path. Lexical; no statement. */
  place(path: string): Place {
    for (const mount of this.mounts) {
      if (path === mount.path) return { kind: "mount", mount, rest: "" };
      if (mount.prefix === "") return { kind: "mount", mount, rest: path };
      if (path.startsWith(`${mount.prefix}/`)) {
        return { kind: "mount", mount, rest: path.slice(mount.prefix.length) };
      }
    }
    return this.#synthetic.has(path) ? { kind: "synthetic" } : { kind: "absent" };
  }

  isSynthetic(path: string): boolean {
    return this.#synthetic.has(path);
  }

  /** Children of a synthetic directory, as canonical virtual paths in path order. */
  childrenOf(path: string): readonly string[] {
    return this.#children.get(path) ?? [];
  }

  /** Synthetic directories strictly under `root`, in path order. */
  syntheticUnder(root: string): string[] {
    return [...this.#synthetic.keys()].filter((path) => isUnder(path, root));
  }

  /** Mounts strictly under `root`, in path order. */
  mountsUnder(root: string): Mount[] {
    return this.mounts.filter((mount) => isUnder(mount.path, root));
  }

  /** The mount at exactly this virtual path. */
  mountAt(path: string): Mount | undefined {
    return this.mounts.find((mount) => mount.path === path);
  }

  /**
   * A synthetic directory's metadata. The inode is negative and distinct per
   * directory, so it can neither collide with a stored one nor alias another.
   */
  syntheticStat(path: string): Stat {
    return {
      type: "dir",
      mode: SYNTHETIC_MODE,
      size: 0,
      mtime: 0,
      ino: this.#synthetic.get(path) ?? 0,
      nlink: 2,
      rev: 0,
      target: null,
      contentId: null,
    };
  }
}

/** The real path behind `rest` of a mount. */
export function realOf(mount: Mount, rest: string): string {
  const real = `${mount.base}${rest}`;
  return real === "" ? "/" : real;
}

/** The virtual path of a real path under a mount's source. */
export function virtualOf(mount: Mount, real: string): string {
  const rest = mount.base === "" ? (real === "/" ? "" : real) : real.slice(mount.base.length);
  const virtual = `${mount.prefix}${rest}`;
  return virtual === "" ? "/" : virtual;
}

/** Whether a real path lies in or under a mount's source. */
export function inSource(mount: Mount, real: string): boolean {
  return mount.base === "" || real === mount.base || real.startsWith(`${mount.base}/`);
}
