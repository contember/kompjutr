import { GitError } from "../core/errors.js";

export const MAX_OPERATION_MEMORY_BYTES = 64 * 1024 * 1024;

export type MemoryCategory =
  | "pool"
  | "base"
  | "flat"
  | "compressed"
  | "packRow"
  | "metadata"
  | "tree"
  | "commit"
  | "protocol"
  | "other";

type Resize = (previous: number, next: number) => void;
type Release = (bytes: number) => void;
const RESERVATION_TOKEN = Symbol("MemoryReservation");

function invalidBytes(): GitError {
  return new GitError("EINVAL", "operation memory bytes must be a safe nonnegative integer");
}

function memoryLimit(): GitError {
  return new GitError(
    "E2BIG",
    `operation memory exceeds the ${MAX_OPERATION_MEMORY_BYTES}-byte limit`,
  );
}

/** One hard memory budget shared by all operations using this coordinator. */
export class MemoryCoordinator {
  #totalBytes = 0;
  #highWaterBytes = 0;
  #activeCount = 0;

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get highWaterBytes(): number {
    return this.#highWaterBytes;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  reserve(): MemoryReservation {
    this.#activeCount++;
    return new MemoryReservation(
      RESERVATION_TOKEN,
      (previous, next) => this.#resize(previous, next),
      (bytes) => this.#release(bytes),
    );
  }

  assertIdle(): void {
    if (this.#activeCount !== 0 || this.#totalBytes !== 0) {
      throw new Error("memory coordinator still has active reservations");
    }
  }

  #resize(previous: number, next: number): void {
    if (previous > this.#totalBytes) throw new Error("memory coordinator accounting is corrupt");
    const withoutPrevious = this.#totalBytes - previous;
    if (next > MAX_OPERATION_MEMORY_BYTES - withoutPrevious) throw memoryLimit();
    const total = withoutPrevious + next;
    this.#totalBytes = total;
    this.#highWaterBytes = Math.max(this.#highWaterBytes, total);
  }

  #release(bytes: number): void {
    if (this.#activeCount <= 0 || bytes > this.#totalBytes) {
      throw new Error("memory coordinator accounting is corrupt");
    }
    this.#totalBytes -= bytes;
    this.#activeCount--;
  }
}

/** Operation-local fixed-category accounting against a shared coordinator. */
export class MemoryReservation {
  #resize: Resize | null;
  #release: Release | null;
  #currentBytes = 0;
  #highWaterBytes = 0;
  #pool = 0;
  #base = 0;
  #flat = 0;
  #compressed = 0;
  #packRow = 0;
  #metadata = 0;
  #tree = 0;
  #commit = 0;
  #protocol = 0;
  #other = 0;

  constructor(token: typeof RESERVATION_TOKEN, resize: Resize, release: Release) {
    if (token !== RESERVATION_TOKEN) throw new Error("memory reservation must use a coordinator");
    this.#resize = resize;
    this.#release = release;
  }

  get currentBytes(): number {
    return this.#currentBytes;
  }

  get highWaterBytes(): number {
    return this.#highWaterBytes;
  }

  get disposed(): boolean {
    return this.#resize === null;
  }

  set(category: MemoryCategory, bytes: number): void {
    const resize = this.#resize;
    if (resize === null) throw new Error("memory reservation is disposed");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalidBytes();
    const previous = this.#read(category);
    if (previous === bytes) return;
    const withoutPrevious = this.#currentBytes - previous;
    if (bytes > Number.MAX_SAFE_INTEGER - withoutPrevious) throw memoryLimit();
    const current = withoutPrevious + bytes;
    resize(previous, bytes);
    this.#write(category, bytes);
    this.#currentBytes = current;
    this.#highWaterBytes = Math.max(this.#highWaterBytes, current);
  }

  clear(category: MemoryCategory): void {
    this.set(category, 0);
  }

  assertEmpty(): void {
    if (this.#currentBytes !== 0) throw new Error("memory reservation still owns bytes");
  }

  dispose(): void {
    const release = this.#release;
    if (release === null) return;
    const bytes = this.#currentBytes;
    release(bytes);
    this.#pool = 0;
    this.#base = 0;
    this.#flat = 0;
    this.#compressed = 0;
    this.#packRow = 0;
    this.#metadata = 0;
    this.#tree = 0;
    this.#commit = 0;
    this.#protocol = 0;
    this.#other = 0;
    this.#currentBytes = 0;
    this.#resize = null;
    this.#release = null;
  }

  #read(category: MemoryCategory): number {
    switch (category) {
      case "pool":
        return this.#pool;
      case "base":
        return this.#base;
      case "flat":
        return this.#flat;
      case "compressed":
        return this.#compressed;
      case "packRow":
        return this.#packRow;
      case "metadata":
        return this.#metadata;
      case "tree":
        return this.#tree;
      case "commit":
        return this.#commit;
      case "protocol":
        return this.#protocol;
      case "other":
        return this.#other;
      default:
        throw new GitError("EINVAL", "operation memory category is invalid");
    }
  }

  #write(category: MemoryCategory, bytes: number): void {
    switch (category) {
      case "pool":
        this.#pool = bytes;
        return;
      case "base":
        this.#base = bytes;
        return;
      case "flat":
        this.#flat = bytes;
        return;
      case "compressed":
        this.#compressed = bytes;
        return;
      case "packRow":
        this.#packRow = bytes;
        return;
      case "metadata":
        this.#metadata = bytes;
        return;
      case "tree":
        this.#tree = bytes;
        return;
      case "commit":
        this.#commit = bytes;
        return;
      case "protocol":
        this.#protocol = bytes;
        return;
      case "other":
        this.#other = bytes;
        return;
    }
  }
}
