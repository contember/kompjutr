import { CorruptError, ObjectNotFoundError } from "../../common/errors.js";
import { isTreeMode, parseCommit, type RawObject, type TreeEntry } from "../../common/objects.js";
import type { SharedRepoStore } from "../../store/index.js";

interface TreeRepository {
  readonly store: Pick<SharedRepoStore, "typeAndSize" | "walkTree">;
  read(oid: string): RawObject;
  readTree(oid: string): TreeEntry[];
}

/** The entry at `path` inside a tree, or null. */
export function resolveTreePath(
  repo: Pick<TreeRepository, "readTree">,
  treeOid: string,
  path: string,
): TreeEntry | null {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return { mode: "40000", name: "", oid: treeOid };
  let current = treeOid;
  for (let index = 0; index < segments.length; index++) {
    const entries = repo.readTree(current);
    const match = entries.find((entry) => entry.name === segments[index]);
    if (match === undefined) return null;
    if (index === segments.length - 1) return match;
    if (!isTreeMode(match.mode)) return null;
    current = match.oid;
  }
  return null;
}

/** Every blob and submodule entry under a tree, as repo-relative paths. */
export function* walkTree(
  repo: TreeRepository,
  treeOid: string,
  prefix = "",
): Generator<{ path: string; entry: TreeEntry }> {
  const type = repo.store.typeAndSize(treeOid)?.type;
  if (type === undefined) throw new ObjectNotFoundError(treeOid);
  const oid = type === "commit" ? parseCommit(repo.read(treeOid).data).tree : treeOid;
  if (type !== "commit" && type !== "tree") {
    throw new CorruptError(`${treeOid} is a ${type}, not a tree`);
  }
  for (const entry of repo.store.walkTree(oid)) {
    const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
    const slash = entry.path.lastIndexOf("/");
    yield {
      path,
      entry: {
        mode: entry.mode,
        name: entry.path.slice(slash + 1),
        oid: entry.oid,
      },
    };
  }
}
