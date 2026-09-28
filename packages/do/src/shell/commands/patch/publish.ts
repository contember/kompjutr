// Where patched bytes land, as GNU patch places them. Each output file is
// written once, whole. A git-style patch that modifies a file is queued until
// the input moves on, so every git patch reads the tree as it was before the
// diff; a second patch to the same file flushes the queue first. Deletions
// wait until the whole input has been read, so a file deleted and recreated
// survives, and a fatal error publishes the queue but deletes nothing. A
// backup is made once per file per run, from the first version replaced,
// and copied before the file is replaced so the original is never missing.
// A queued output waits in a staging file beside its target rather than in
// memory, so a diff touching many large files stays within the retained
// budget; `discard` removes staging files when the run fails.

import { concat } from "../../exec/bytes.js";
import type { BoundedFs } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { isFilesystemError } from "../../exec/redirections.js";

/** What this run did to a path, standing in for GNU's inode table. */
type Mark = "created" | "delete-later";

interface Queued {
  readonly path: string;
  /** The staging file holding the new content, already at its final mode. */
  readonly staged: string;
  readonly backup: boolean;
}

interface Deletion {
  readonly name: string;
  readonly backup: boolean;
}

export class Publisher {
  readonly #marks = new Map<string, Mark>();
  readonly #queue: Queued[] = [];
  /** Git outputs whose file a later git patch must see flushed first. */
  readonly #pending = new Set<string>();
  readonly #deletions: Deletion[] = [];

  constructor(
    private readonly fs: BoundedFs,
    private readonly cwd: string,
  ) {}

  path(name: string): string {
    return resolve(this.cwd, name);
  }

  /** Whether an earlier patch scheduled this file's deletion. */
  deleteScheduled(name: string): boolean {
    return this.#marks.get(this.path(name)) === "delete-later";
  }

  /**
   * Before a git patch writes `name`: publish the queue if it holds an earlier
   * version of the file. True when it did, so the input must be read again.
   */
  claim(name: string, exists: boolean): boolean {
    if (!exists) return false;
    const path = this.path(name);
    const flushed = this.#pending.has(path);
    if (flushed) {
      this.flush();
      if (this.fs.stat(path) === null) return true;
    }
    this.#pending.add(path);
    return flushed;
  }

  /** Write now, or queue when a git patch modifies an existing file. */
  output(name: string, bytes: Uint8Array, mode: number, backup: boolean, queued: boolean): void {
    const path = this.path(name);
    if (!queued) {
      this.#move(path, bytes, mode, backup);
      return;
    }
    const staged = this.#stagingPath(path);
    this.fs.writeFiles([{ path: staged, bytes, mode }], { parents: true });
    this.#queue.push({ path, staged, backup });
  }

  flush(): void {
    for (let next = this.#queue[0]; next !== undefined; next = this.#queue[0]) {
      if (next.backup) this.#backup(next.path, this.fs.stat(next.path) !== null);
      this.fs.rename(next.staged, next.path);
      this.#queue.shift();
      this.#marks.set(next.path, "created");
    }
  }

  /** Remove the staging files of outputs that will not be published. */
  discard(): void {
    const staged = this.#queue.map((queued) => queued.staged);
    this.#queue.length = 0;
    if (staged.length > 0) this.fs.removeFiles(staged, { force: true });
  }

  #stagingPath(path: string): string {
    for (let attempt = 0; ; attempt++) {
      const candidate = `${path}.kompjutr-patch${attempt === 0 ? "" : `-${attempt}`}`;
      const taken = this.#queue.some((queued) => queued.staged === candidate);
      if (!taken && this.fs.stat(candidate) === null) return candidate;
    }
  }

  deleteLater(name: string, backup: boolean): void {
    this.#marks.set(this.path(name), "delete-later");
    this.#deletions.push({ name, backup });
  }

  /** Keep a copy of the original when nothing else replaces it. */
  backupInPlace(name: string): void {
    const path = this.path(name);
    if (this.fs.stat(path) !== null) this.#backup(path, true);
  }

  /** A reject file: a new one replaces what is there; later rejects in this run append. */
  reject(name: string, chunks: readonly Uint8Array[]): void {
    const path = this.path(name);
    if (this.#marks.get(path) === "created" && this.fs.stat(path) !== null) {
      this.fs.writeFileStream(path, chunks, { append: true });
      return;
    }
    let size = 0;
    for (const chunk of chunks) size += chunk.length;
    const release = this.fs.retained.retain(size, "patch reject");
    try {
      this.fs.writeFiles([{ path, bytes: concat(chunks), mode: 0o644 }], { parents: true });
    } finally {
      release();
    }
    this.#marks.set(path, "created");
  }

  /** Perform the deletions, once the whole input is read. */
  finish(): void {
    for (const deletion of this.#deletions) {
      const path = this.path(deletion.name);
      if (this.#marks.get(path) !== "delete-later") continue;
      if (deletion.backup) this.#backup(path, this.fs.stat(path) !== null, true);
      else this.fs.removeFiles([path], { force: true });
      this.#removeEmptyParents(deletion.name);
    }
  }

  #move(path: string, bytes: Uint8Array, mode: number, backup: boolean): void {
    if (backup) this.#backup(path, this.fs.stat(path) !== null);
    this.fs.writeFiles([{ path, bytes, mode }], { parents: true });
    this.#marks.set(path, "created");
  }

  /** A deleted file's backup takes its place; a replaced file's is a copy. */
  #backup(path: string, exists: boolean, removing = false): void {
    if (this.#marks.get(path) === "created") return;
    const backup = `${path}.orig`;
    if (exists && removing) this.fs.rename(path, backup);
    else if (exists) this.fs.copyFiles([{ source: path, destination: backup }]);
    else
      this.fs.writeFiles([{ path: backup, bytes: new Uint8Array(0), mode: 0o644 }], {
        parents: true,
      });
  }

  /** GNU's `removedirs`: drop each now-empty directory the name passes through. */
  #removeEmptyParents(name: string): void {
    for (let index = name.length - 1; index > 0; index--) {
      if (name.charAt(index) !== "/" || name.charAt(index - 1) === "/") continue;
      const component = name.slice(name.lastIndexOf("/", index - 1) + 1, index);
      if (component === "." || component === "..") continue;
      try {
        this.fs.rmdir(this.path(name.slice(0, index)));
      } catch (error) {
        if (!isFilesystemError(error)) throw error;
      }
    }
  }
}
