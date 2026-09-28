// GNU patch's safe traversal of a file name from the patch: directory
// components are followed one at a time, and a symbolic link among them is
// followed only while it stays inside the working directory — a relative
// target may not climb above it, an absolute one must point into it. The
// last component is never followed. A name given on the command line skips
// the check, as in GNU.

import type { BoundedFs } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";

/** `dangling`: a directory component is a symbolic link to nothing. */
export type Reach = "inside" | "outside" | "dangling";

/** Links followed before GNU gives up with ELOOP, which it reports as unsafe. */
const MAX_LINKS = 40;

export function reach(fs: BoundedFs, cwd: string, name: string): Reach {
  const pending = name.split("/").slice(0, -1);
  let directory = cwd;
  let depth = 0;
  let links = 0;
  let viaLink = false;
  for (let component = pending.shift(); component !== undefined; component = pending.shift()) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (--depth < 0) return "outside";
      directory = resolve(directory, "..");
      continue;
    }
    const path = resolve(directory, component);
    const stat = fs.stat(path);
    if (stat === null) return viaLink ? "dangling" : "inside";
    if (stat.type === "symlink") {
      if (++links > MAX_LINKS) return "outside";
      const target = fs.readlink(path);
      if (target.startsWith("/")) {
        const inside = target === cwd || target.startsWith(`${cwd}/`);
        if (!inside) return "outside";
        directory = cwd;
        depth = 0;
        pending.unshift(...target.slice(cwd.length).split("/"));
      } else {
        pending.unshift(...target.split("/"));
      }
      viaLink = true;
      continue;
    }
    if (stat.type !== "dir") return "inside";
    directory = path;
    depth++;
    viaLink = false;
  }
  return "inside";
}
