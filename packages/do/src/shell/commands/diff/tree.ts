// Directory comparison as GNU diff does it: at each level the two listings are
// merge-joined by name in byte order, and a common subdirectory is compared
// (under `-r`) at its place in that order, before the next name. Each side is
// a paged listing, so a level holds one page per side and the walk holds one
// level per depth. Symlinks are followed, as GNU follows them by default.

import { basename, comparePaths, join } from "../../../fs/path.js";
import type { ListCursor, ScanEntry, Stat } from "../../../fs/types.js";
import { encode } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import { type Comparison, comparePair, raise, type Side } from "./pair.js";

/** One listing statement's worth of entries. */
const PAGE = 1_000;

interface Ancestry {
  readonly a: readonly number[];
  readonly b: readonly number[];
}

const ROOT: Ancestry = { a: [], b: [] };

/** A pair of operands or entries: files, directories, or one absent under `-N`. */
export function* compareSides(
  comparison: Comparison,
  a: Side,
  b: Side,
  ancestry: Ancestry | null,
): Generator<Uint8Array, void, undefined> {
  if (a.ino !== null && a.ino === b.ino && a.kind === "dir") return;
  const aKind = a.kind === "absent" ? b.kind : a.kind;
  const bKind = b.kind === "absent" ? a.kind : b.kind;
  if (aKind === "dir" && bKind === "dir") {
    if (ancestry !== null && !comparison.options.recursive) {
      yield encode(`Common subdirectories: ${a.name} and ${b.name}\n`);
      return;
    }
    yield* compareDirectories(comparison, a, b, ancestry ?? ROOT);
    return;
  }
  if (aKind === "dir" || bKind === "dir") {
    raise(comparison, 1);
    yield encode(`File ${a.name} is a ${describe(a)} while file ${b.name} is a ${describe(b)}\n`);
    return;
  }
  const output = comparePair(comparison, a, b, ancestry !== null);
  if (output !== null) yield output;
}

function* compareDirectories(
  comparison: Comparison,
  a: Side,
  b: Side,
  ancestry: Ancestry,
): Generator<Uint8Array, void, undefined> {
  const aLoops = a.kind === "absent" || (a.ino !== null && ancestry.a.includes(a.ino));
  const bLoops = b.kind === "absent" || (b.ino !== null && ancestry.b.includes(b.ino));
  if (aLoops && bLoops) {
    comparison.context.warn(`${a.kind === "absent" ? b.name : a.name}: recursive directory loop`);
    raise(comparison, 2);
    return;
  }
  const below: Ancestry = {
    a: a.ino === null ? ancestry.a : [...ancestry.a, a.ino],
    b: b.ino === null ? ancestry.b : [...ancestry.b, b.ino],
  };
  const left = listing(comparison.context, a);
  const right = listing(comparison.context, b);
  let l = left.next();
  let r = right.next();
  while (!l.done || !r.done) {
    const order = l.done ? 1 : r.done ? -1 : comparePaths(l.value.name, r.value.name);
    const aEntry = order <= 0 && !l.done ? l.value : null;
    const bEntry = order >= 0 && !r.done ? r.value : null;
    if (aEntry !== null) l = left.next();
    if (bEntry !== null) r = right.next();
    yield* compareEntries(comparison, a, b, aEntry, bEntry, below);
  }
}

interface Entry {
  readonly name: string;
  readonly stat: ScanEntry;
}

function* compareEntries(
  comparison: Comparison,
  aParent: Side,
  bParent: Side,
  aEntry: Entry | null,
  bEntry: Entry | null,
  ancestry: Ancestry,
): Generator<Uint8Array, void, undefined> {
  const name = aEntry?.name ?? bEntry?.name ?? "";
  if ((aEntry === null || bEntry === null) && !comparison.options.newFile) {
    raise(comparison, 1);
    yield encode(`Only in ${(aEntry === null ? bParent : aParent).name}: ${name}\n`);
    return;
  }
  const a = child(comparison, aParent, name, aEntry);
  const b = child(comparison, bParent, name, bEntry);
  if (a === null || b === null) return;
  yield* compareSides(comparison, a, b, ancestry);
}

/** The entry as a side, following a symlink; null (after a diagnostic) when it dangles. */
function child(
  comparison: Comparison,
  parent: Side,
  name: string,
  entry: Entry | null,
): Side | null {
  const side = { name: childName(parent.name, name), path: join(parent.path, name) };
  if (entry === null) return absent(side.name, side.path);
  const target =
    entry.stat.type === "symlink" ? comparison.context.fs.statTarget(side.path) : entry.stat;
  if (target === null) {
    comparison.context.warn(`${side.name}: No such file or directory`);
    raise(comparison, 2);
    return null;
  }
  return present(side.name, side.path, target);
}

export function present(name: string, path: string, stat: Stat): Side {
  return {
    name,
    path,
    kind: stat.type === "dir" ? "dir" : "file",
    size: stat.size,
    mtime: stat.mtime,
    ino: stat.ino,
    contentId: stat.contentId,
    bytes: null,
  };
}

export function absent(name: string, path: string): Side {
  return { name, path, kind: "absent", size: 0, mtime: 0, ino: null, contentId: null, bytes: null };
}

/** gnulib's file_name_concat: trailing slashes collapse into one separator. */
export function childName(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

function describe(side: Side): string {
  if (side.kind === "dir") return "directory";
  return side.size === 0 ? "regular empty file" : "regular file";
}

function* listing(context: CommandContext, side: Side): Generator<Entry, void, undefined> {
  if (side.kind === "absent") return;
  let after: ListCursor | undefined;
  for (;;) {
    const page = context.fs.listEntries(
      side.path,
      after === undefined ? { limit: PAGE } : { after, limit: PAGE },
    );
    for (const item of page.items) {
      if (item.entry !== null) yield { name: basename(item.entry.path), stat: item.entry };
    }
    if (page.next === null) return;
    after = page.next;
  }
}
