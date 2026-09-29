// The files `patch` reads and writes, relative to its working directory.
//
// Names from a diff are looked up without leaving the working directory: a
// symbolic link in a directory position is followed only while its target
// is relative and never climbs above the directory it started from, which is
// how GNU treats such names. A name that would leave is missing when read
// and invalid when written. A final symbolic link is never followed.
//
// Git-style patches are queued, as GNU queues them: each output is staged in
// a hidden file beside its target (or in the nearest existing ancestor
// directory) and later patches in the same run read the staged state. The
// queue is published in order at the end, or discarded when the run fails.

import type { Stat } from "../../../fs/types.js";
import type { BoundedFs } from "../../exec/context.js";

export type Lookup =
  | { readonly safe: true; readonly path: string; readonly stat: Stat | null }
  | { readonly safe: false };

type Pending =
  | { readonly kind: "staged"; readonly staged: string; readonly size: number }
  | { readonly kind: "deleted" };

interface QueueEntry {
  readonly target: string;
  readonly staged: string | null;
  readonly mode: number | null;
}

const MAX_LINK_EXPANSIONS = 40;

export class Workspace {
  readonly #pending = new Map<string, Pending>();
  readonly #queue: QueueEntry[] = [];
  readonly #backedUp = new Set<string>();
  /** Queued targets whose original must be backed up when published. */
  readonly #backups = new Set<string>();
  #stagedCount = 0;

  constructor(
    private readonly fs: BoundedFs,
    readonly root: string,
  ) {}

  /** Resolve a diff name inside the working directory. */
  lookup(name: string): Lookup {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    const leaf = parts.pop();
    const directory = this.#walk(parts);
    if (directory === null) return { safe: false };
    if (leaf === undefined) return { safe: true, path: directory.path, stat: null };
    const path = directory.path === "/" ? `/${leaf}` : `${directory.path}/${leaf}`;
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

  /** Whether writing a diff name would stay inside the working directory. */
  writable(name: string): boolean {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    parts.pop();
    return this.#walk(parts) !== null;
  }

  /** Replace or create a file now, backing up the original first when asked. */
  writeNow(path: string, chunks: Iterable<Uint8Array>, backup: boolean, mode: number | null): void {
    if (backup) this.#backup(path);
    this.#ensureParent(path);
    this.fs.writeFileStream(path, chunks);
    if (mode !== null) this.fs.chmod(path, mode & 0o7777);
  }

  removeNow(path: string, backup: boolean): void {
    if (backup) this.#backup(path);
    this.fs.removeFiles([path]);
    this.#pruneParents(path);
  }

  writeReject(path: string, chunks: Iterable<Uint8Array>, append: boolean): void {
    this.#ensureParent(path);
    this.fs.writeFileStream(path, chunks, { append });
  }

  /** Stage an output for publishing at the end of the run. */
  stage(path: string, chunks: Iterable<Uint8Array>, backup: boolean, mode: number | null): void {
    const staged = this.#stagingPath(path);
    this.fs.writeFileStream(staged, chunks);
    const size = this.fs.stat(staged)?.size ?? 0;
    const previous = this.#pending.get(path);
    this.#pending.set(path, { kind: "staged", staged, size });
    this.#queue.push({ target: path, staged, mode });
    if (backup) this.#backups.add(path);
    if (previous?.kind === "staged") this.#dropStaged(previous.staged);
  }

  /** Stage a copy made inside the store, for renames and copies without hunks. */
  stageCopy(source: string, path: string, mode: number | null): void {
    const pending = this.#pending.get(source);
    const from = pending?.kind === "staged" ? pending.staged : source;
    const staged = this.#stagingPath(path);
    this.fs.copyFiles([{ source: from, destination: staged }]);
    const size = this.fs.stat(staged)?.size ?? 0;
    this.#pending.set(path, { kind: "staged", staged, size });
    this.#queue.push({ target: path, staged, mode });
  }

  queueDelete(path: string, backup: boolean): void {
    const previous = this.#pending.get(path);
    this.#pending.set(path, { kind: "deleted" });
    this.#queue.push({ target: path, staged: null, mode: null });
    if (backup) this.#backups.add(path);
    if (previous?.kind === "staged") this.#dropStaged(previous.staged);
  }

  queueMode(path: string, mode: number): void {
    this.#queue.push({ target: path, staged: null, mode });
  }

  /** Move every queued output into place, in order. */
  publish(): void {
    const live = new Set<string>();
    for (const pending of this.#pending.values()) {
      if (pending.kind === "staged") live.add(pending.staged);
    }
    for (const entry of this.#queue) {
      if (entry.staged !== null) {
        if (!live.has(entry.staged)) continue;
        if (this.#backups.has(entry.target)) this.#backup(entry.target);
        this.#ensureParent(entry.target);
        this.fs.rename(entry.staged, entry.target);
        if (entry.mode !== null) this.fs.chmod(entry.target, entry.mode & 0o7777);
      } else if (entry.mode !== null) {
        if (this.fs.stat(entry.target) !== null) this.fs.chmod(entry.target, entry.mode & 0o7777);
      } else if (this.fs.stat(entry.target) !== null) {
        if (this.#backups.has(entry.target)) this.#backup(entry.target);
        this.fs.removeFiles([entry.target]);
        this.#pruneParents(entry.target);
      }
    }
    this.#forget();
  }

  /** Remove every staged file; nothing queued is published. */
  discard(): void {
    for (const pending of this.#pending.values()) {
      if (pending.kind === "staged") this.#dropStaged(pending.staged);
    }
    this.#forget();
  }

  #forget(): void {
    this.#pending.clear();
    this.#queue.length = 0;
    this.#backups.clear();
  }

  #dropStaged(staged: string): void {
    if (this.fs.stat(staged) !== null) this.fs.removeFiles([staged]);
  }

  #stagingPath(path: string): string {
    const slash = path.lastIndexOf("/");
    let directory = slash <= 0 ? "/" : path.slice(0, slash);
    while (directory !== "/" && this.fs.stat(directory)?.type !== "dir") {
      const up = directory.lastIndexOf("/");
      directory = up <= 0 ? "/" : directory.slice(0, up);
    }
    const base = path.slice(slash + 1);
    for (;;) {
      this.#stagedCount++;
      const candidate = `${directory === "/" ? "" : directory}/.${base}.patch-${this.#stagedCount}~`;
      if (this.fs.stat(candidate) === null) return candidate;
    }
  }

  #backup(path: string): void {
    if (this.#backedUp.has(path)) return;
    this.#backedUp.add(path);
    if (this.fs.stat(path)?.type !== "file") return;
    this.fs.copyFiles([{ source: path, destination: `${path}.orig` }]);
  }

  #ensureParent(path: string): void {
    const slash = path.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : path.slice(0, slash);
    if (this.fs.stat(parent) === null) this.fs.makeDirectories([parent]);
  }

  /** GNU removes directories a deletion left empty, up to the working directory. */
  #pruneParents(path: string): void {
    let directory = path.slice(0, path.lastIndexOf("/"));
    while (directory.length > this.root.length && directory.startsWith(`${this.root}/`)) {
      if (this.fs.readdir(directory).length > 0) return;
      this.fs.rmdir(directory);
      directory = directory.slice(0, directory.lastIndexOf("/"));
    }
  }
}
