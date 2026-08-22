/**
 * Byte-budgeted LRU. Every cache in the package is bounded by bytes
 * rather than entry count, so nothing grows with repository size.
 */
const MIN_ENTRY_BYTES = 256;

export class ByteLru<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #sizeOf: (value: V) => number;
  #budget: number;
  #bytes = 0;

  constructor(budget: number, sizeOf: (value: V) => number) {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new RangeError("LRU budget must be a safe nonnegative integer");
    }
    this.#budget = budget;
    this.#sizeOf = sizeOf;
  }

  get budget(): number {
    return this.#budget;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const hit = this.#entries.get(key);
    if (hit === undefined) return undefined;
    // Re-insert so the most recently used entry sits last.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): void {
    const size = this.#entryBytes(value);
    // A single entry may never take more than a quarter of the budget,
    // otherwise one large object evicts everything else.
    if (size > this.#budget / 4) return;
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#bytes -= this.#entryBytes(existing);
      this.#entries.delete(key);
    }
    this.#entries.set(key, value);
    this.#bytes += size;
    this.#evict();
  }

  delete(key: K): void {
    const existing = this.#entries.get(key);
    if (existing === undefined) return;
    this.#bytes -= this.#entryBytes(existing);
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #evict(): void {
    while (this.#bytes > this.#budget) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) return;
      const value = this.#entries.get(oldest.value)!;
      this.#bytes -= this.#entryBytes(value);
      this.#entries.delete(oldest.value);
    }
  }

  #entryBytes(value: V): number {
    const bytes = this.#sizeOf(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("LRU entry size must be a safe nonnegative integer");
    }
    return Math.max(bytes, MIN_ENTRY_BYTES);
  }
}
