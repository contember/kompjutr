// The repository: everything reachable from the object store and the refs,
// with no knowledge of Computer, DOFS or HTTP.

import { isAbbreviatedOid, isOid } from "./bytes.js";
import { CorruptError, ObjectNotFoundError, RefNotFoundError } from "./errors.js";
import {
  type Commit,
  isTreeMode,
  type ObjectType,
  parseCommit,
  parseTag,
  parseTree,
  type RawObject,
  type Tag,
  type TreeEntry,
} from "./objects.js";
import type { RepoStore } from "../sqlite/store.js";

/** Where a short ref name is looked up, in git's own order. */
const REF_SEARCH = [
  (name: string) => name,
  (name: string) => `refs/${name}`,
  (name: string) => `refs/tags/${name}`,
  (name: string) => `refs/heads/${name}`,
  (name: string) => `refs/remotes/${name}`,
  (name: string) => `refs/remotes/${name}/HEAD`,
];

export interface ResolvedHead {
  /** Full ref name HEAD points at, or null when detached. */
  ref: string | null;
  /** The commit HEAD resolves to, or null on an unborn branch. */
  oid: string | null;
}

export class Repository {
  #shallow: Set<string> | null = null;

  constructor(
    readonly store: RepoStore,
    readonly root: string,
  ) {}

  /** Commits whose parents this repository deliberately does not have. */
  shallow(): Set<string> {
    if (this.#shallow === null) this.#shallow = this.store.shallow();
    return this.#shallow;
  }

  invalidateShallow(): void {
    this.#shallow = null;
  }

  // -- objects --------------------------------------------------------

  read(oid: string): RawObject {
    const object = this.store.read(oid);
    if (object === null) throw new ObjectNotFoundError(oid);
    return object;
  }

  has(oid: string): boolean {
    return this.store.has(oid);
  }

  typeOf(oid: string): ObjectType {
    const found = this.store.typeAndSize(oid);
    if (found === null) throw new ObjectNotFoundError(oid);
    return found.type;
  }

  readCommit(oid: string): Commit {
    const object = this.read(oid);
    if (object.type !== "commit") throw new CorruptError(`${oid} is a ${object.type}, not a commit`);
    return parseCommit(object.data);
  }

  readTree(oid: string): TreeEntry[] {
    const object = this.read(oid);
    if (object.type === "commit") return this.readTree(parseCommit(object.data).tree);
    if (object.type !== "tree") throw new CorruptError(`${oid} is a ${object.type}, not a tree`);
    return parseTree(object.data);
  }

  readBlob(oid: string): Uint8Array {
    const object = this.read(oid);
    if (object.type !== "blob") throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
    return object.data;
  }

  readTag(oid: string): Tag {
    const object = this.read(oid);
    if (object.type !== "tag") throw new CorruptError(`${oid} is a ${object.type}, not a tag`);
    return parseTag(object.data);
  }

  /** Follow annotated tags down to the object they ultimately name. */
  peel(oid: string, want: ObjectType = "commit"): string {
    let current = oid;
    for (let hops = 0; hops < 16; hops++) {
      const type = this.typeOf(current);
      if (type === want || type !== "tag") return current;
      current = this.readTag(current).object;
    }
    throw new CorruptError(`tag chain from ${oid} is too deep`);
  }

  // -- refs -----------------------------------------------------------

  /** The full name of the ref `name` denotes, or null. */
  expandRef(name: string): string | null {
    if (name === "HEAD") return "HEAD";
    for (const candidate of REF_SEARCH) {
      const full = candidate(name);
      if (this.store.getRef(full) !== null) return full;
    }
    return null;
  }

  /** Resolve a ref name (following symrefs) to an oid, or null. */
  resolveRef(name: string): string | null {
    let current = name;
    for (let hops = 0; hops < 8; hops++) {
      const full = this.expandRef(current);
      if (full === null) return null;
      const value = this.store.getRef(full);
      if (value === null) return null;
      if (value.startsWith("ref: ")) {
        current = value.slice(5).trim();
        continue;
      }
      return value;
    }
    throw new CorruptError(`symbolic ref loop at ${name}`);
  }

  head(): ResolvedHead {
    const raw = this.store.head();
    if (raw.startsWith("ref: ")) {
      const ref = raw.slice(5).trim();
      const value = this.store.getRef(ref);
      return { ref, oid: value === null ? null : value };
    }
    return { ref: null, oid: isOid(raw) ? raw : null };
  }

  branches(): string[] {
    return this.store.listRefs("refs/heads/").map((row) => row.name.slice("refs/heads/".length));
  }

  tags(): string[] {
    return this.store.listRefs("refs/tags/").map((row) => row.name.slice("refs/tags/".length));
  }

  // -- revisions ------------------------------------------------------

  /**
   * `gitrevisions(7)` subset: a ref, a full or abbreviated oid, and the
   * `^`, `^N` and `~N` suffixes, chained.
   */
  revParse(expression: string): string {
    const trimmed = expression.trim();
    if (trimmed === "") throw new RefNotFoundError(expression);

    // Split the base name from its suffix chain at the first ^ or ~ that
    // is not part of the name.
    let split = trimmed.length;
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]!;
      if (char === "^" || char === "~") {
        split = i;
        break;
      }
    }
    const base = trimmed.slice(0, split);
    const suffix = trimmed.slice(split);

    let oid = this.#resolveBase(base);
    let position = 0;
    while (position < suffix.length) {
      const operator = suffix[position++]!;
      let digits = "";
      while (position < suffix.length && suffix[position]! >= "0" && suffix[position]! <= "9") {
        digits += suffix[position++]!;
      }
      if (operator === "~") {
        const count = digits === "" ? 1 : Number.parseInt(digits, 10);
        for (let i = 0; i < count; i++) oid = this.#firstParent(oid, expression);
      } else if (operator === "^") {
        const which = digits === "" ? 1 : Number.parseInt(digits, 10);
        if (which === 0) {
          oid = this.peel(oid);
          continue;
        }
        oid = this.#parent(oid, which, expression);
      } else {
        throw new RefNotFoundError(expression);
      }
    }
    return oid;
  }

  #resolveBase(base: string): string {
    if (base === "") throw new RefNotFoundError(base);
    const viaRef = this.resolveRef(base);
    if (viaRef !== null) return viaRef;
    if (isOid(base) && this.store.has(base)) return base;
    if (isAbbreviatedOid(base)) {
      const resolved = this.store.resolvePrefix(base);
      if (resolved !== null) return resolved;
    }
    throw new RefNotFoundError(base);
  }

  #firstParent(oid: string, expression: string): string {
    return this.#parent(oid, 1, expression);
  }

  #parent(oid: string, which: number, expression: string): string {
    const commit = this.readCommit(this.peel(oid));
    const parent = commit.parent[which - 1];
    if (parent === undefined) throw new RefNotFoundError(expression);
    return parent;
  }

  // -- walking --------------------------------------------------------

  /** Commits reachable from `oid`, first-parent-first, in commit-date order. */
  *walk(oid: string): Generator<{ oid: string; commit: Commit }> {
    const seen = new Set<string>();
    // A small priority queue keyed on committer time reproduces git log's
    // default ordering closely enough for a history walk.
    const queue: { oid: string; commit: Commit }[] = [];
    const push = (candidate: string): void => {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      const commit = this.readCommit(candidate);
      let index = queue.length;
      while (index > 0 && queue[index - 1]!.commit.committer.timestamp < commit.committer.timestamp) {
        index--;
      }
      queue.splice(index, 0, { oid: candidate, commit });
    };

    const boundary = this.shallow();
    push(this.peel(oid));
    while (queue.length > 0) {
      const next = queue.shift()!;
      yield next;
      if (boundary.has(next.oid)) continue;
      for (const parent of next.commit.parent) push(parent);
    }
  }

  /** The entry at `path` inside a tree, or null. */
  resolveTreePath(treeOid: string, path: string): TreeEntry | null {
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) return { mode: "40000", name: "", oid: treeOid };
    let current = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const entries = this.readTree(current);
      const match = entries.find((entry) => entry.name === segments[i]);
      if (match === undefined) return null;
      if (i === segments.length - 1) return match;
      if (!isTreeMode(match.mode)) return null;
      current = match.oid;
    }
    return null;
  }

  /** Every blob and submodule entry under a tree, as repo-relative paths. */
  *walkTree(treeOid: string, prefix = ""): Generator<{ path: string; entry: TreeEntry }> {
    for (const entry of this.readTree(treeOid)) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) {
        yield* this.walkTree(entry.oid, path);
      } else {
        yield { path, entry };
      }
    }
  }

  /** The tree of the commit HEAD points at, or null on an unborn branch. */
  headTree(): string | null {
    const { oid } = this.head();
    if (oid === null) return null;
    return this.readCommit(this.peel(oid)).tree;
  }
}
