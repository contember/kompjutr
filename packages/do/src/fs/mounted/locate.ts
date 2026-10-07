// Virtual path → mount, before any statement runs.
//
// A canonical path is classified by prefix alone. A non-canonical one is
// walked lexically through the synthetic directories, which hold no
// symlinks, until it enters a mount; the rest of it is resolved in real
// space. Only a `..` after the mount prefix needs the store before the
// operation itself: it may leave the mount the way a kernel bind mount
// lets it, so it is resolved first, confined, and the walk continues in
// virtual space from the mount's parent.

import type { SqlDatabase } from "../../db/db.js";
import { filesystemError } from "../errors.js";
import { assertWellFormedPath, dirname, isCanonicalPath } from "../path.js";
import { resolveWithin } from "../store/resolve.js";
import { type Mount, type MountTable, realOf, virtualOf } from "./mounts.js";

export type Location =
  | {
      readonly kind: "mount";
      readonly mount: Mount;
      /** The real path the operation resolves; it contains no `..`. */
      readonly real: string;
      /** The canonical virtual path, when the input was canonical. */
      readonly virtual: string | null;
    }
  | { readonly kind: "synthetic"; readonly path: string }
  | {
      readonly kind: "absent";
      /** True when the parent is a synthetic directory. */
      readonly parentSynthetic: boolean;
    };

const ABSENT_UNDER_SYNTHETIC: Location = { kind: "absent", parentSynthetic: true };
const ABSENT: Location = { kind: "absent", parentSynthetic: false };

function componentsOf(path: string): string[] {
  const rooted = path.replace(/^\/+/, "");
  return rooted === "" ? [] : rooted.split("/");
}

function locateCanonical(table: MountTable, path: string): Location {
  const place = table.place(path);
  if (place.kind === "mount") {
    return {
      kind: "mount",
      mount: place.mount,
      real: realOf(place.mount, place.rest),
      virtual: path,
    };
  }
  if (place.kind === "synthetic") return { kind: "synthetic", path };
  return table.isSynthetic(dirname(path)) ? ABSENT_UNDER_SYNTHETIC : ABSENT;
}

/** Locate a virtual path. Statement-free unless a `..` follows a mount prefix. */
export function locate(db: SqlDatabase, table: MountTable, input: string): Location {
  assertWellFormedPath(input);
  let path = input;
  for (;;) {
    if (isCanonicalPath(path)) return locateCanonical(table, path);
    const step = walk(table, path, input);
    if (step.kind !== "climb") return step.location;

    const resolved = resolveWithin(db, step.mount.source, step.real, false, step.mount.top);
    if (typeof resolved === "string") {
      return locateCanonical(table, virtualOf(step.mount, resolved));
    }
    if (resolved.breach === "outside") return ABSENT;
    const parent = dirname(step.mount.path);
    path = `${parent === "/" ? "" : parent}/${resolved.rest.join("/")}`;
  }
}

type Step =
  | { readonly kind: "done"; readonly location: Location }
  | { readonly kind: "climb"; readonly mount: Mount; readonly real: string };

function walk(table: MountTable, path: string, input: string): Step {
  const root = table.mountAt("/");
  const components = componentsOf(path);
  if (root !== undefined) return entered(root, components, 0);

  const parts: string[] = [];
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    if (component === undefined || component === "" || component === ".") continue;
    if (component === "..") {
      parts.pop();
      continue;
    }
    parts.push(component);
    const current = `/${parts.join("/")}`;
    const mount = table.mountAt(current);
    if (mount !== undefined) return entered(mount, components, index + 1);
    if (table.isSynthetic(current)) continue;

    const remaining = components.slice(index + 1);
    if (remaining.includes("..")) {
      throw filesystemError("ENOENT", "no such file or directory", input);
    }
    const final = remaining.every((part) => part === "" || part === ".");
    return { kind: "done", location: final ? ABSENT_UNDER_SYNTHETIC : ABSENT };
  }
  return { kind: "done", location: { kind: "synthetic", path: `/${parts.join("/")}` } };
}

function entered(mount: Mount, components: readonly string[], from: number): Step {
  const rest = components.slice(from);
  const real = realOf(mount, rest.length === 0 ? "" : `/${rest.join("/")}`);
  if (rest.includes("..")) return { kind: "climb", mount, real };
  return { kind: "done", location: { kind: "mount", mount, real, virtual: null } };
}
