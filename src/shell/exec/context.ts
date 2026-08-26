// What a command is handed, and the ceilings it runs under.
//
// Bounds are a property of the executor, not of the agent's discipline: an
// agent that forgets `| head` must still get a bounded result. Every command
// reaches the filesystem through `BoundedFs`, which counts the calls, so a
// pathological pattern cannot walk a million rows however the command is
// written.

import type {
  ContentSearchOptions,
  ContentSearchPage,
  CopyBatch,
  CopyEntry,
  CopyOptions,
  Dirent,
  DiscoverFilesOptions,
  DiscoverFilesPage,
  Filesystem,
  GlobOptions,
  GlobPage,
  HandleReadBatch,
  ListOptions,
  ListPage,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  StreamWriteOptions,
  TouchOptions,
  WriteEntry,
  WriteOptions,
} from "../../fs/types.js";
import type { ByteStream } from "./bytes.js";

const DEFAULT_RETAINED_BYTES = 16 * 1024 * 1024;

export interface Limits {
  /** Bytes of stdout before the result is marked truncated. */
  readonly maxOutputBytes: number;
  /** Filesystem calls one exec may make. */
  readonly maxOperations: number;
  /** Bytes per SQL statement, handed straight to the bulk reads. */
  readonly readBudget: number;
  /** Shell-owned intermediate bytes retained at once. Default 16 MiB. */
  readonly maxRetainedBytes?: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxOutputBytes: 1_000_000,
  maxOperations: 10_000,
  readBudget: 1_500_000,
  maxRetainedBytes: DEFAULT_RETAINED_BYTES,
};

/** Raised when a ceiling is hit. Carries which one, so the message can say. */
export class ShellLimitError extends Error {
  readonly limit: "arguments" | "operations" | "output" | "retained";

  constructor(limit: "arguments" | "operations" | "output" | "retained", message: string) {
    super(message);
    this.name = "ShellLimitError";
    this.limit = limit;
  }
}

/** Tracks live intermediate bytes. Callers release reservations as buffers leave scope. */
export class RetainedBudget {
  #held = 0;

  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new ShellLimitError("retained", "maxRetainedBytes must be a positive safe integer");
    }
  }

  get available(): number {
    return this.max - this.#held;
  }

  retain(bytes: number, label: string): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ShellLimitError("retained", `${label} has an invalid retained size`);
    }
    if (this.#held + bytes > this.max) {
      throw new ShellLimitError(
        "retained",
        `${label} exceeds the ${this.max}-byte retained-memory limit`,
      );
    }
    this.#held += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held -= bytes;
    };
  }
}

/**
 * The filesystem, with every call counted against `maxOperations`.
 *
 * Only the surface commands actually use is exposed. A command that wants
 * something else has to be given it here, which is the point: the set of
 * things a command can do to the database stays visible in one file.
 */
export class BoundedFs {
  #operations = 0;
  readonly retained: RetainedBudget;

  constructor(
    private readonly fs: Filesystem,
    private readonly limits: Limits,
  ) {
    this.retained = new RetainedBudget(limits.maxRetainedBytes ?? DEFAULT_RETAINED_BYTES);
  }

  get operations(): number {
    return this.#operations;
  }

  get readBudget(): number {
    return Math.min(this.limits.readBudget, this.retained.max);
  }

  get maxRetainedBytes(): number {
    return this.retained.max;
  }

  #charge(): void {
    this.#operations++;
    if (this.#operations > this.limits.maxOperations) {
      throw new ShellLimitError(
        "operations",
        `exceeded ${this.limits.maxOperations} filesystem operations`,
      );
    }
  }

  realpath(path: string): RealPath {
    this.#charge();
    return this.fs.realpath(path);
  }

  stat(path: string): Stat | null {
    this.#charge();
    return this.fs.stat(path);
  }

  statTarget(path: string): Stat | null {
    this.#charge();
    return this.fs.statTarget(path);
  }

  readFile(path: string): Uint8Array {
    this.#charge();
    return this.fs.readFile(path);
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    this.#charge();
    return this.fs.readRange(path, offset, length);
  }

  readdir(path: string): Dirent[] {
    this.#charge();
    return this.fs.readdir(path);
  }

  scan(root: string, options: ScanOptions): ScanEntry[] {
    this.#charge();
    return this.fs.scan(root, options);
  }

  discoverFiles(
    root: RealPath,
    pattern: string,
    options?: DiscoverFilesOptions,
  ): DiscoverFilesPage {
    this.#charge();
    return this.fs.discoverFiles(root, pattern, options);
  }

  discoverFilesContaining(
    root: RealPath,
    pattern: string,
    needle: Uint8Array,
    options?: ContentSearchOptions,
  ): ContentSearchPage {
    this.#charge();
    return this.fs.discoverFilesContaining(root, pattern, needle, options);
  }

  readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch {
    this.#charge();
    return this.fs.readFileHandles(handles, options);
  }

  readFiles(paths: readonly string[], options?: ReadOptions): ReadBatch {
    this.#charge();
    return this.fs.readFiles(paths, options);
  }

  glob(root: string, pattern: string, options?: { limit?: number }): string[] {
    this.#charge();
    return this.fs.glob(root, pattern, options);
  }

  globPage(root: string, pattern: string, options?: GlobOptions): GlobPage {
    this.#charge();
    return this.fs.globPage(root, pattern, options);
  }

  listEntries(root: string, options?: ListOptions): ListPage {
    this.#charge();
    return this.fs.listEntries(root, options);
  }

  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
    this.#charge();
    this.fs.writeFiles(entries, options);
  }

  copyFiles(entries: readonly CopyEntry[], options?: CopyOptions): CopyBatch {
    this.#charge();
    return this.fs.copyFiles(entries, options);
  }

  touchFiles(paths: readonly string[], options?: TouchOptions): void {
    this.#charge();
    this.fs.touchFiles(paths, options);
  }

  writeFileStream(path: string, chunks: Iterable<Uint8Array>, options?: StreamWriteOptions): void {
    this.#charge();
    this.fs.writeFileStream(path, chunks, options);
  }

  makeDirectories(paths: readonly string[]): void {
    this.#charge();
    this.fs.makeDirectories(paths);
  }

  removeFiles(paths: readonly string[], options?: RemoveOptions): void {
    this.#charge();
    this.fs.removeFiles(paths, options);
  }

  rename(oldPath: string, newPath: string): void {
    this.#charge();
    this.fs.rename(oldPath, newPath);
  }
}

export interface CommandContext {
  readonly fs: BoundedFs;
  /** Absolute, already resolved against the session. */
  readonly cwd: string;
  /** Arguments after the command name, globs already expanded. */
  readonly argv: readonly string[];
  /** The previous stage, or null when this command is first. */
  readonly stdin: ByteStream | null;
  /** From a lifted `head -N`. Sizes the first discovery page. */
  readonly limitHint: number | null;
  /** Write a diagnostic. Already honours `2>/dev/null` and `2>&1`. */
  warn(message: string): void;
  /** Change the session's working directory. Only `cd` uses it. */
  chdir(path: string): void;
  /**
   * Run another registered command. Only `xargs` uses it, and it exists as
   * a named seam rather than a registry handed to every command so that the
   * set of commands able to invoke others stays one grep away.
   *
   * The sub-invocation shares this context's `fs`, so its filesystem calls
   * count against the same ceiling — a `xargs` over ten thousand paths
   * cannot escape the budget by spreading the work across invocations.
   *
   * Returns null when no such command is registered.
   */
  invoke(name: string, argv: readonly string[]): CommandResult | null;
}

export interface CommandResult {
  readonly stdout: ByteStream;
  /** Valid once stdout is fully drained. */
  status(): number;
}

export type Command = (context: CommandContext) => CommandResult;

/** A command that produces its whole output at once. */
export function result(stdout: ByteStream, status = 0): CommandResult {
  return { stdout, status: () => status };
}

/**
 * A command whose exit status is only known after its stream is consumed —
 * `grep` returns 1 when nothing matched, and that is not known up front.
 */
export function deferred(build: (setStatus: (code: number) => void) => ByteStream): CommandResult {
  let status = 0;
  const stdout = build((code) => {
    status = code;
  });
  return { stdout, status: () => status };
}

/** A failed command: a diagnostic on stderr and a non-zero status. */
export function fail(context: CommandContext, message: string, status = 1): CommandResult {
  context.warn(message);
  return { stdout: (function* () {})(), status: () => status };
}
