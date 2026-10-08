/**
 * Byte-budgeted LRU. Every cache in the package is bounded by bytes
 * rather than entry count, so nothing grows with repository size.
 */
const MIN_ENTRY_BYTES = 256;

interface LruNode<K, V> {
  readonly key: K;
  value: V;
  bytes: number;
  older: LruNode<K, V> | null;
  newer: LruNode<K, V> | null;
}

// Recency lives in an explicit list. Evicting from the front of an
// insertion-ordered Map leaves deleted slots that every later
// `keys().next()` scans past, which made eviction dominate pack ingest.
export class ByteLru<K, V> {
  readonly #entries = new Map<K, LruNode<K, V>>();
  #oldest: LruNode<K, V> | null = null;
  #newest: LruNode<K, V> | null = null;
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
    const node = this.#entries.get(key);
    if (node === undefined) return undefined;
    this.#unlink(node);
    this.#append(node);
    return node.value;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): void {
    const size = this.#entryBytes(value);
    // A single entry may never take more than a quarter of the budget,
    // otherwise one large object evicts everything else.
    if (size > this.#budget / 4) return;
    this.delete(key);
    const node: LruNode<K, V> = { key, value, bytes: size, older: null, newer: null };
    this.#entries.set(key, node);
    this.#append(node);
    this.#bytes += size;
    this.#evict();
  }

  delete(key: K): void {
    const node = this.#entries.get(key);
    if (node === undefined) return;
    this.#remove(node);
  }

  clear(): void {
    this.#entries.clear();
    this.#oldest = null;
    this.#newest = null;
    this.#bytes = 0;
  }

  #evict(): void {
    while (this.#bytes > this.#budget && this.#oldest !== null) this.#remove(this.#oldest);
  }

  #remove(node: LruNode<K, V>): void {
    this.#unlink(node);
    this.#entries.delete(node.key);
    this.#bytes -= node.bytes;
  }

  #append(node: LruNode<K, V>): void {
    node.older = this.#newest;
    node.newer = null;
    if (this.#newest === null) this.#oldest = node;
    else this.#newest.newer = node;
    this.#newest = node;
  }

  #unlink(node: LruNode<K, V>): void {
    if (node.older === null) this.#oldest = node.newer;
    else node.older.newer = node.newer;
    if (node.newer === null) this.#newest = node.older;
    else node.newer.older = node.older;
    node.older = null;
    node.newer = null;
  }

  #entryBytes(value: V): number {
    const bytes = this.#sizeOf(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("LRU entry size must be a safe nonnegative integer");
    }
    return Math.max(bytes, MIN_ENTRY_BYTES);
  }
}
