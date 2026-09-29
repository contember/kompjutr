// The files `patch` reads and writes, relative to its working directory.
//
// Names from a diff are looked up without leaving the working directory: a
// symbolic link in a directory position is followed only while its target
// is relative and never climbs above the directory it started from, which is
// how GNU treats such names. A name that would leave is missing when read
// and invalid when written. A final symbolic link is never followed.
//
// Git-style patches are queued, as GNU queues them. Their outputs are staged
// in one hidden directory per run, and later patches in the run read the
// staged state. Publishing is a bulk backup copy, a bulk copy of the staged
// outputs into place, and one removal of deleted files and the staging
// directory; a failed run removes the directory in one call. Both need the
// filesystem, so a run that fails by exhausting `maxOperations` cannot clean
// up and leaves the staging directory behind.

import type { Stat } from "../../../fs/types.js";
import type { BoundedFs } from "../../exec/context.js";

export type Lookup =
  | { readonly safe: true; readonly path: string; readonly stat: Stat | null }
  | { readonly safe: false };

type Pending =
  | { readonly kind: "staged"; readonly staged: string; readonly size: number }
  | { readonly kind: "deleted" };

const MAX_LINK_EXPANSIONS = 40;
/** Large enough that one copy call is limited only by its entry page. */
const WHOLE_BATCH = Number.MAX_SAFE_INTEGER;

export class Workspace {
  /** Final queued state per target, in the order targets were first queued. */
  readonly #pending = new Map<string, Pending>();
  readonly #modes = new Map<string, number>();
  /** Queued targets whose original must be backed up when published. */
  readonly #backups = new Set<string>();
  /** Files this run already wrote or backed up: GNU never backs them up again. */
  readonly #touched = new Set<string>();
  #staging: string | null = null;
  #stagedCount = 0;

  constructor(
    private readonly fs: BoundedFs,
    readonly root: string,
  ) {}

  /** Resolve a diff name inside the working directory. */
  lookup(name: string): Lookup {
    const parts = name.split("/").filter((part) => part !== "");
    const leaf = parts.pop();
    if (leaf === undefined || leaf === "." || leaf === "..") {
      const directory = this.#walk(leaf === undefined ? parts : [...parts, leaf]);
      if (directory === null || this.#inStaging(directory.path)) return { safe: false };
      const stat = directory.missing > 0 ? null : this.fs.stat(directory.path);
      return { safe: true, path: directory.path, stat };
    }
    const directory = this.#walk(parts);
    if (directory === null) return { safe: false };
    const path = directory.path === "/" ? `/${leaf}` : `${directory.path}/${leaf}`;
    if (this.#inStaging(path)) return { safe: false };
    if (directory.missing > 0) return { safe: true, path, stat: null };
    return { safe: true, path, stat: this.stat(path) };
  }

  /** Directories that creating a diff name would have to make. */
  missingDirectories(name: string): number {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    parts.pop();
    return this.#walk(parts)?.missing ?? parts.length;
  }

  /** An operand names its file directly, links and all. */
  direct(path: string): Lookup {
    return { safe: true, path, stat: this.stat(path) };
  }

  /** The state a later patch sees, queued outputs included. */
  stat(path: string): Stat | null {
    const pending = this.#pending.get(path);
    if (pending?.kind === "deleted") return null;
    // As in GNU, a queued output shows only for a file that already exists.
    if (pending?.kind === "staged") {
      if (this.fs.stat(path) === null) return null;
      const staged = this.fs.stat(pending.staged);
      return staged === null ? null : { ...staged, size: pending.size };
    }
    return this.fs.stat(path);
  }

  queued(path: string): boolean {
    return this.#pending.has(path);
  }

  read(path: string): Uint8Array {
    const pending = this.#pending.get(path);
    return this.fs.readFile(pending?.kind === "staged" ? pending.staged : path);
  }

  /**
   * Walk directory components, following links that stay inside. Returns
   * null when a link leaves; `missing` counts components from the first one
   * that does not exist.
   */
  #walk(parts: readonly string[]): { path: string; missing: number } | null {
    const queue = [...parts];
    const stack: string[] = [];
    let expansions = 0;
    let missing = 0;
    while (queue.length > 0) {
      const part = queue.shift() ?? "";
      if (part === "." || part === "") continue;
      if (part === "..") {
        if (stack.pop() === undefined) return null;
        if (missing > 0) missing--;
        continue;
      }
      if (missing > 0) {
        stack.push(part);
        missing++;
        continue;
      }
      const path = this.#join(stack, part);
      const stat = this.fs.stat(path);
      if (stat?.type === "symlink") {
        const target = this.fs.readlink(path);
        expansions++;
        if (target.startsWith("/") || expansions > MAX_LINK_EXPANSIONS) return null;
        queue.unshift(...target.split("/"));
        continue;
      }
      stack.push(part);
      if (stat?.type !== "dir") missing = 1;
    }
    return { path: this.#join(stack, null), missing };
  }

  #join(stack: readonly string[], part: string | null): string {
    const parts = part === null ? stack : [...stack, part];
    const tail = parts.join("/");
    if (tail === "") return this.root;
    return this.root === "/" ? `/${tail}` : `${this.root}/${tail}`;
  }

  #inStaging(path: string): boolean {
    return (
      this.#staging !== null && (path === this.#staging || path.startsWith(`${this.#staging}/`))
    );
  }

  /** Whether writing a diff name would stay inside the working directory. */
  writable(name: string): boolean {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    parts.pop();
    const directory = this.#walk(parts);
    return directory !== null && !this.#inStaging(directory.path);
  }

  /** Replace or create a file now, backing up the original first when asked. */
  writeNow(path: string, chunks: Iterable<Uint8Array>, backup: boolean, mode: number | null): void {
    if (backup) this.#backup([path]);
    this.#touched.add(path);
    this.#ensureParent(path);
    this.fs.writeFileStream(path, chunks);
    if (mode !== null) this.fs.chmod(path, mode & 0o7777);
  }

  removeNow(path: string, backup: boolean): void {
    if (backup) this.#backup([path]);
    this.#touched.add(path);
    this.fs.removeFiles([path]);
    this.#pruneParents([path]);
  }

  isLink(path: string): boolean {
    return this.fs.stat(path)?.type === "symlink";
  }

  /** GNU replaces a reject file that is a symbolic link rather than writing through it. */
  writeReject(path: string, chunks: Iterable<Uint8Array>, append: boolean): void {
    const existing = this.fs.stat(path);
    if (existing?.type === "symlink") this.fs.removeFiles([path]);
    else this.#ensureParent(path);
    this.fs.writeFileStream(path, chunks, { append: append && existing?.type === "file" });
  }

  /** Stage an output for publishing at the end of the run, with the mode it will have. */
  stage(path: string, chunks: Iterable<Uint8Array>, backup: boolean, mode: number | null): void {
    const staged = this.#stagingFile();
    this.fs.writeFileStream(staged, chunks);
    const stat = this.fs.stat(staged);
    if (mode !== null && stat !== null && stat.mode !== (mode & 0o7777)) {
      this.fs.chmod(staged, mode & 0o7777);
    }
    this.#queue(path, { kind: "staged", staged, size: stat?.size ?? 0 }, backup);
  }

  /** Stage a copy made inside the store, for renames and copies without hunks. */
  stageCopy(source: string, path: string, mode: number | null): void {
    const pending = this.#pending.get(source);
    const from = pending?.kind === "staged" ? pending.staged : source;
    const staged = this.#stagingFile();
    this.fs.copyFiles([{ source: from, destination: staged }], { budget: WHOLE_BATCH });
    const stat = this.fs.stat(staged);
    if (mode !== null && stat !== null && stat.mode !== (mode & 0o7777)) {
      this.fs.chmod(staged, mode & 0o7777);
    }
    this.#queue(path, { kind: "staged", staged, size: stat?.size ?? 0 }, false);
  }

  queueDelete(path: string, backup: boolean): void {
    this.#queue(path, { kind: "deleted" }, backup);
  }

  queueMode(path: string, mode: number): void {
    this.#modes.set(path, mode & 0o7777);
  }

  // A queued output counts as written: a later patch to the file makes no backup.
  #queue(path: string, state: Pending, backup: boolean): void {
    this.#pending.set(path, state);
    if (backup && !this.#touched.has(path)) this.#backups.add(path);
    this.#touched.add(path);
  }

  /** Put every queued output in place: backups, then outputs, then removals. */
  publish(): void {
    const copies: Array<{ source: string; destination: string }> = [];
    const removals: string[] = [];
    for (const [target, pending] of this.#pending) {
      if (pending.kind === "staged") copies.push({ source: pending.staged, destination: target });
      else if (this.fs.stat(target) !== null) removals.push(target);
    }
    this.#backupNow([...this.#backups].filter((target) => this.#pending.has(target)));
    this.#copyAll(copies);
    const staging = this.#staging;
    if (removals.length > 0 || staging !== null) {
      this.fs.removeFiles(staging === null ? removals : [...removals, staging], {
        recursive: true,
        force: true,
      });
    }
    this.#staging = null;
    this.#pruneParents(removals);
    for (const [target, mode] of this.#modes) {
      if (!this.#pending.has(target) && this.fs.stat(target) !== null) this.fs.chmod(target, mode);
    }
    this.#forget();
  }

  /** Remove the staging directory; nothing queued is published. */
  discard(): void {
    const staging = this.#staging;
    this.#staging = null;
    this.#forget();
    if (staging !== null) this.fs.removeFiles([staging], { recursive: true, force: true });
  }

  #forget(): void {
    this.#pending.clear();
    this.#modes.clear();
    this.#backups.clear();
  }

  #copyAll(entries: ReadonlyArray<{ source: string; destination: string }>): void {
    let remaining = entries;
    while (remaining.length > 0) {
      remaining = this.fs.copyFiles(remaining, { budget: WHOLE_BATCH }).remaining;
    }
  }

  #stagingFile(): string {
    if (this.#staging === null) {
      const prefix = this.root === "/" ? "" : this.root;
      let candidate = `${prefix}/.patch-staging~`;
      for (let attempt = 1; this.fs.stat(candidate) !== null; attempt++) {
        candidate = `${prefix}/.patch-staging-${attempt}~`;
      }
      this.fs.makeDirectories([candidate]);
      this.#staging = candidate;
    }
    this.#stagedCount++;
    return `${this.#staging}/${this.#stagedCount}`;
  }

  #backup(paths: readonly string[]): void {
    const fresh = paths.filter((path) => !this.#touched.has(path));
    for (const path of fresh) this.#touched.add(path);
    this.#backupNow(fresh);
  }

  #backupNow(paths: readonly string[]): void {
    const copies: Array<{ source: string; destination: string }> = [];
    for (const path of paths) {
      if (this.fs.stat(path)?.type === "file")
        copies.push({ source: path, destination: `${path}.orig` });
    }
    this.#copyAll(copies);
  }

  #ensureParent(path: string): void {
    const parent = parentOf(path);
    if (this.fs.stat(parent) === null) this.fs.makeDirectories([parent]);
  }

  /** GNU removes directories a deletion left empty, up to the working directory. */
  #pruneParents(paths: readonly string[]): void {
    const inside = this.root === "/" ? "/" : `${this.root}/`;
    for (const path of paths) {
      for (
        let directory = parentOf(path);
        directory.startsWith(inside) && directory !== this.root;
      ) {
        if (this.fs.stat(directory) === null) {
          directory = parentOf(directory);
          continue;
        }
        if (this.fs.readdir(directory).length > 0) break;
        this.fs.rmdir(directory);
        directory = parentOf(directory);
      }
    }
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}
