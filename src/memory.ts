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

class MemoryError extends Error {
  override readonly name = "GitError";

  constructor(
    readonly code: "EINVAL" | "E2BIG",
    message: string,
  ) {
    super(message);
  }
}

function invalidBytes(): MemoryError {
  return new MemoryError("EINVAL", "operation memory bytes must be a safe nonnegative integer");
}

function memoryLimit(): MemoryError {
  return new MemoryError(
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

  /** Exact unused capacity shared by every active reservation. */
  get remainingBytes(): number {
    return MAX_OPERATION_MEMORY_BYTES - this.#totalBytes;
  }

  get highWaterBytes(): number {
    return this.#highWaterBytes;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  reserve(owner?: object): MemoryReservation {
    this.#activeCount++;
    return new MemoryReservation(
      RESERVATION_TOKEN,
      this,
      (previous, next) => this.#resize(previous, next),
      (bytes) => this.#release(bytes),
      owner ?? null,
    );
  }

  owns(reservation: MemoryReservation, owner?: object): boolean {
    return reservation.belongsTo(this, owner);
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
  readonly #coordinator: MemoryCoordinator;
  readonly #owner: object | null;
  readonly #parent: MemoryReservation | null;
  readonly #children = new Set<MemoryReservation>();
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

  constructor(
    token: typeof RESERVATION_TOKEN,
    coordinator: MemoryCoordinator,
    resize: Resize,
    release: Release | null,
    owner: object | null,
    parent: MemoryReservation | null = null,
  ) {
    if (token !== RESERVATION_TOKEN) throw new Error("memory reservation must use a coordinator");
    this.#coordinator = coordinator;
    this.#resize = resize;
    this.#release = release;
    this.#owner = owner;
    this.#parent = parent;
  }

  get currentBytes(): number {
    return this.#currentBytes;
  }

  get highWaterBytes(): number {
    return this.#highWaterBytes;
  }

  /** Exact capacity still available from the shared coordinator. */
  get remainingBytes(): number {
    return this.#coordinator.remainingBytes;
  }

  get disposed(): boolean {
    return this.#resize === null;
  }

  belongsTo(coordinator: MemoryCoordinator, owner?: object): boolean {
    return this.#coordinator === coordinator && (owner === undefined || this.#owner === owner);
  }

  /** Create an independently disposable additive scope under this operation. */
  scope(): MemoryReservation {
    const resize = this.#resize;
    if (resize === null) throw new Error("memory reservation is disposed");
    const child = new MemoryReservation(
      RESERVATION_TOKEN,
      this.#coordinator,
      resize,
      null,
      this.#owner,
      this,
    );
    this.#children.add(child);
    return child;
  }

  set(category: MemoryCategory, bytes: number): void {
    if (this.#resize === null) throw new Error("memory reservation is disposed");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalidBytes();
    const previous = this.#read(category);
    if (previous === bytes) return;
    const delta = bytes - previous;
    const root = this.#root();
    const resize = root.#resize;
    if (resize === null) throw new Error("memory reservation is disposed");
    const rootBytes = root.#currentBytes;
    if (delta > Number.MAX_SAFE_INTEGER - rootBytes) throw memoryLimit();
    const rootNext = rootBytes + delta;
    resize(rootBytes, rootNext);
    this.#write(category, bytes);
    let current: MemoryReservation | null = this;
    while (current !== null) {
      current.#currentBytes += delta;
      current.#highWaterBytes = Math.max(current.#highWaterBytes, current.#currentBytes);
      current = current.#parent;
    }
  }

  clear(category: MemoryCategory): void {
    this.set(category, 0);
  }

  assertEmpty(): void {
    if (this.#currentBytes !== 0) throw new Error("memory reservation still owns bytes");
  }

  dispose(): void {
    if (this.#resize === null) return;
    const parent = this.#parent;
    if (parent === null) {
      const release = this.#release;
      if (release === null) throw new Error("root memory reservation has no release callback");
      release(this.#currentBytes);
    } else {
      const root = this.#root();
      const resize = root.#resize;
      if (resize === null) throw new Error("memory reservation is disposed");
      const bytes = this.#currentBytes;
      resize(root.#currentBytes, root.#currentBytes - bytes);
      let current: MemoryReservation | null = parent;
      while (current !== null) {
        current.#currentBytes -= bytes;
        current = current.#parent;
      }
      parent.#children.delete(this);
    }
    this.#invalidateTree();
  }

  #root(): MemoryReservation {
    let root: MemoryReservation = this;
    while (root.#parent !== null) root = root.#parent;
    return root;
  }

  #invalidateTree(): void {
    const pending: MemoryReservation[] = [this];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      for (const child of current.#children) pending.push(child);
      current.#children.clear();
      current.#clearCategories();
      current.#currentBytes = 0;
      current.#resize = null;
      current.#release = null;
    }
  }

  #clearCategories(): void {
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
        throw new MemoryError("EINVAL", "operation memory category is invalid");
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
