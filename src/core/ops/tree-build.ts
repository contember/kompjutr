// Turning the index into a tree hierarchy.
//
// This is the operation Computer's client cannot survive: isomorphic-git
// materialises the whole `.git/index` and then a nested inode graph of the
// whole tree, and the isolate runs out of memory between 535 and 985
// tracked files. Here the index is rows and the build is a single
// bottom-up pass, so the only thing held live is the directory stack of
// the path currently being visited.

import type { IndexEntry } from "../../sqlite/store.js";
import { MODE_TREE, serializeTree, type TreeEntry } from "../objects.js";
import type { Repository } from "../repository.js";

/** A directory the pass is currently inside, with the entries seen so far. */
interface OpenDirectory {
  name: string;
  entries: TreeEntry[];
}

/**
 * Write every tree the stage-0 index describes and return the root's oid.
 *
 * `entries` must be in git's byte order over the full path, which is what
 * `RepoStore.indexScan()` yields: SQLite orders TEXT by UTF-8 bytes,
 * and a byte-ordered path list visits each directory contiguously and in
 * exactly the order git's tree rule ("a subtree sorts as `name/`") puts
 * its entries in. Re-sorting here would cost a second full-index pass for
 * nothing.
 */
export function buildTree(repo: Repository, entries: Iterable<IndexEntry>): string {
  const stack: OpenDirectory[] = [{ name: "", entries: [] }];
  // Segment names of the directories currently open below the root.
  const open: string[] = [];

  for (const entry of entries) {
    if (entry.stage !== 0) continue;
    const segments = entry.path.split("/");
    const depth = segments.length - 1;

    let shared = 0;
    while (shared < depth && shared < open.length && open[shared] === segments[shared]) shared++;
    while (open.length > shared) closeTop(repo, stack, open);
    for (let level = shared; level < depth; level++) {
      stack.push({ name: segments[level]!, entries: [] });
      open.push(segments[level]!);
    }

    stack[stack.length - 1]!.entries.push({
      mode: entry.mode.toString(8),
      name: segments[depth]!,
      oid: entry.oid,
    });
  }

  while (open.length > 0) closeTop(repo, stack, open);
  return writeTree(repo, stack[0]!.entries);
}

function closeTop(repo: Repository, stack: OpenDirectory[], open: string[]): void {
  const finished = stack.pop()!;
  open.pop();
  stack[stack.length - 1]!.entries.push({
    mode: MODE_TREE,
    name: finished.name,
    oid: writeTree(repo, finished.entries),
  });
}

/** `RepoStore.write` hashes first and returns early when the tree already exists, which is the reuse. */
function writeTree(repo: Repository, entries: TreeEntry[]): string {
  return repo.store.write("tree", serializeTree(entries));
}
