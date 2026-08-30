import { GitError } from "../../core/errors.js";
import type { ObjectType, RawObject } from "../../core/objects.js";
import { retainedStringBytes } from "../../core/retained.js";
import type { MemoryReservation } from "../../memory.js";
import type { PackCacheOptions } from "../packs.js";
import type { CheckoutStore } from "./checkout.js";

export type BoundedSingleConfigValue =
  | { readonly kind: "missing" }
  | { readonly kind: "single"; readonly value: string }
  | { readonly kind: "multiple" };

export type ConfigValueCardinality = "missing" | "single" | "multiple";

export interface StoreOptions extends PackCacheOptions {
  /** Database-wide bytes of inflated objects held hot across reads. */
  objectCacheBytes?: number;
  /** Clock in milliseconds since the Unix epoch. */
  now?: () => number;
}

export interface CheckoutRow {
  readonly id: number;
  readonly repoId: number;
  readonly root: string;
  readonly head: string;
  readonly isPrimary: boolean;
}

export interface ProvisionalCloneOwner {
  readonly checkout: CheckoutRow;
  readonly generation: number;
  readonly store: CheckoutStore;
}

export type RepositoryLifecycle = "ready" | "provisional";

export interface RefRow {
  name: string;
  target: string;
}

export interface RefLogActor {
  name: string;
  email: string;
}

export interface RefLogMetadata {
  actor: RefLogActor | null;
  reason: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface RefMutationExpected {
  name: string;
  target: string | null;
}

export interface RefMutation {
  puts?: Iterable<RefRow>;
  deletes?: Iterable<string>;
  head?: string;
  expected?: RefMutationExpected;
}

export const REF_MUTATION_MEMORY_OWNER_TOKEN = Symbol("RefMutationMemoryOwner");

/** Store-issued ownership for derived strings retained through a ref operation. */
export class RefMutationMemoryOwner {
  readonly #reservation: MemoryReservation;
  readonly #strings: string[] = [];
  #retained = 256;

  constructor(token: typeof REF_MUTATION_MEMORY_OWNER_TOKEN, reservation: MemoryReservation) {
    if (token !== REF_MUTATION_MEMORY_OWNER_TOKEN) {
      throw new GitError("EINVAL", "ref mutation memory owner must be issued by the store");
    }
    this.#reservation = reservation;
    this.#reservation.set("other", this.#retained);
  }

  construct<T extends string>(units: number, construct: () => T): T {
    this.#reservation.set("other", this.#retained + 8 + retainedStringUnits(units));
    return this.retain(construct());
  }

  retain<T extends string>(value: T): T {
    this.#retained += 8 + retainedStringBytes(value);
    this.#reservation.set("other", this.#retained);
    this.#strings.push(value);
    return value;
  }

  memoryReservation(): MemoryReservation {
    return this.#reservation;
  }

  owns(value: string): boolean {
    return this.#strings.includes(value);
  }

  dispose(): void {
    this.#reservation.dispose();
  }
}

export interface FetchPublicationExpectedRef {
  readonly name: string;
  readonly target: string | null;
}

export class FetchPublicationToken {
  readonly #isDisposed: () => boolean;
  readonly #dispose: () => void;

  constructor(
    readonly generation: number,
    readonly trackingPrefix: string,
    readonly namespaceRevision: number,
    readonly shallowRevision: number,
    readonly shallow: readonly string[],
    readonly trackingRefs: readonly Readonly<RefRow>[],
    readonly exactRefs: readonly FetchPublicationExpectedRef[],
    isDisposed: () => boolean,
    dispose: () => void,
  ) {
    this.#isDisposed = isDisposed;
    this.#dispose = dispose;
  }

  /** Legacy tag-publication snapshot. */
  get globalRefs(): readonly FetchPublicationExpectedRef[] {
    return this.exactRefs;
  }

  get disposed(): boolean {
    return this.#isDisposed();
  }

  dispose(): void {
    this.#dispose();
  }
}

export class TrackingRefPublicationToken {
  readonly #isDisposed: () => boolean;
  readonly #dispose: () => void;

  constructor(
    readonly trackingPrefix: string,
    readonly refName: string,
    readonly target: string | null,
    isDisposed: () => boolean,
    dispose: () => void,
  ) {
    this.#isDisposed = isDisposed;
    this.#dispose = dispose;
  }

  get disposed(): boolean {
    return this.#isDisposed();
  }

  dispose(): void {
    this.#dispose();
  }
}

export interface FetchPublicationPlan {
  /** Tracking refs learned from the advertisement, excluding the remote HEAD symref. */
  trackingPuts?: Iterable<RefRow>;
  /** When present, prune tracking refs absent from this advertised keep-set. */
  trackingKeep?: Iterable<string>;
  /** `undefined` leaves remote HEAD alone; `null` deletes it. */
  remoteHead?: string | null;
  /** Global tags selected from the candidates supplied when the token was issued. */
  globalTagPuts?: Iterable<RefRow>;
  /** Exact direct refs selected from the candidates supplied when the token was issued. */
  exactPuts?: Iterable<RefRow>;
  shallowAdd?: Iterable<string>;
  shallowRemove?: Iterable<string>;
}

export interface RefLogEntry {
  refName: string;
  ordinal: number;
  oldRaw: string | null;
  newRaw: string | null;
  oldOid: string | null;
  newOid: string | null;
  actor: RefLogActor | null;
  timestamp: number;
  timezoneOffset: number;
  reason: string;
}

export interface RefLogReadOptions {
  /** Maximum rows returned. Public reads cap this at 1,000. */
  limit?: number;
  /** Resume strictly before this repository-wide ordinal. */
  before?: number;
}

export interface IndexEntry {
  path: string;
  stage: number;
  /** Full git mode, e.g. 0o100644. */
  mode: number;
  oid: string;
  /** Working-tree facts recorded when the entry was written, for status. */
  size: number | null;
  mtime: number | null;
  ino: number | null;
  /** Monotonic filesystem revision, absent on indexes created before schema v5. */
  rev?: number | null;
}

export interface IndexScanOptions {
  /** Resume strictly after this (path, stage). */
  after?: { path: string; stage: number };
  /** Only the path equal to, or under, this repo-relative prefix. */
  prefix?: string;
  /** Rows per round trip. This is the memory bound of the scan. */
  pageSize?: number;
}

export interface IndexApplyOptions {
  /** Mutations buffered before a batch is written. */
  flushEvery?: number;
}

export interface ObjectBatchOptions {
  /** Stored bytes buffered before a flush, and the cap on one payload. */
  payloadBytes?: number;
  /** Objects buffered before a flush. */
  flushEvery?: number;
}

export interface BlobIdMapping {
  contentId: Uint8Array;
  oid: string;
}

export interface InitialStateSession {
  readonly retainedBytes: number;
  put(entry: IndexEntry): void;
  addBlobId(mapping: BlobIdMapping): void;
}

export type InitialStateResult<T> = { available: false } | { available: true; value: T };

export interface BlobReadBatch {
  /** Complete blob contents, keyed by oid in first-occurrence input order. */
  blobs: Map<string, Uint8Array>;
  /** Deduplicated oids deferred to the next call. */
  remaining: string[];
  /** Sum of the returned blob sizes. */
  bytes: number;
}

export interface ObjectReadBatch {
  /** Complete objects, keyed by oid in first-occurrence input order. */
  objects: Map<string, RawObject>;
  /** Deduplicated oids deferred to the next call. */
  remaining: string[];
  /** Sum of the returned inflated object sizes. */
  bytes: number;
}

export interface ObjectReadInfo {
  oid: string;
  type: ObjectType;
  size: number;
  source: "loose" | "pack";
  /** Stored loose rows; zero for packed objects. */
  chunkRows: number;
}

/**
 * A bounded sink for loose object writes. `write` hashes and encodes, so
 * the oid it returns is final, but no row exists until `flush`: a staged
 * object is invisible to `read`, `has` and `readChunks` until then.
 */
export interface ObjectBatch {
  write(type: ObjectType, data: Uint8Array): string;
  /** Write whatever is staged. Called for you when `writeObjects` returns. */
  flush(): void;
}

/** Internal staged-write scope tied to an existing repository operation. */
export interface OwnedObjectBatch extends ObjectBatch {
  dispose(): void;
}

export function retainedStringUnits(units: number): number {
  return 48 + 2 * units;
}

/** A bounded, ordered mutation sink over the index. */
export interface IndexSink {
  put(entry: IndexEntry): void;
  remove(path: string): void;
  /** Apply whatever is buffered. Called for you when `indexApply` returns. */
  flush(): void;
}

/** The bounded ordered index operations shared by checkout and scratch rows. */
export interface IndexStore {
  indexScan(options?: IndexScanOptions): IterableIterator<IndexEntry>;
  indexApply<T>(body: (sink: IndexSink) => T, options?: IndexApplyOptions): T;
  indexReplace(entries: Iterable<IndexEntry>, options?: IndexApplyOptions): void;
  hasConflicts(): boolean;
}
