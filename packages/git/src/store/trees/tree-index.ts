import type { SqlDatabase } from "@kompjutr/sqlite";
import { TreeParser } from "../../common/objects.js";
import { TreeIndexBatch, TreeSourceIndexer } from "./tree-index-batch.js";

export { TREE_QUEUE_ROW_FIXED_BYTES } from "./tree-index-batch.js";

/** One stored copy of a tree; every copy of an OID shares one projection. */
export interface TreeSource {
  repoId: number;
  treeOid: string;
  objectSize: number;
}

export interface TreeSourceInput extends TreeSource {
  chunks: Iterable<Uint8Array>;
}

function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

/**
 * Parse one tree into `batch`; `write: false` validates without queueing rows.
 * When it queues a complete projection, the subtree OIDs it names are
 * appended to `subtrees`; an unprojectable tree's subtrees need no closure.
 */
export function parseTreeSourceInto(
  batch: TreeIndexBatch,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
  write = true,
  subtrees: string[] = [],
): void {
  const parser = new TreeParser();
  try {
    const indexer = new TreeSourceIndexer(source, batch, write);
    const named: string[] = [];
    for (const chunk of chunks) {
      indexer.acceptChunk(chunk.length);
      for (const parsed of parser.push(chunk)) {
        indexer.push(parsed);
        if (isTreeMode(parsed.entry.mode)) named.push(parsed.entry.oid);
      }
    }
    indexer.finish(parser.finish());
    if (indexer.queuedProjection) for (const oid of named) subtrees.push(oid);
  } finally {
    parser.dispose();
  }
}

/** Incrementally parse and index one tree. The caller owns the transaction. */
export class TreeIndexSink {
  readonly #parser: TreeParser;
  readonly #batch: TreeIndexBatch;
  readonly #source: TreeSourceIndexer;
  #finished = false;

  constructor(db: SqlDatabase, source: TreeSource) {
    this.#parser = new TreeParser();
    try {
      this.#batch = new TreeIndexBatch(db, { seeded: false });
    } catch (error) {
      this.#parser.dispose();
      throw error;
    }
    try {
      this.#source = new TreeSourceIndexer(source, this.#batch);
    } catch (error) {
      this.#parser.dispose();
      this.#batch.dispose();
      throw error;
    }
  }

  get retainedRows(): number {
    return this.#batch.retainedRows;
  }

  push(chunk: Uint8Array): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    try {
      this.#source.acceptChunk(chunk.length);
      for (const parsed of this.#parser.push(chunk)) this.#source.push(parsed);
    } catch (error) {
      this.#dispose();
      throw error;
    }
  }

  finish(): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    this.#finished = true;
    try {
      this.#source.finish(this.#parser.finish());
      this.#batch.flush();
    } finally {
      this.#dispose();
    }
  }

  dispose(): void {
    this.#dispose();
  }

  #dispose(): void {
    this.#finished = true;
    this.#parser.dispose();
    this.#batch.dispose();
  }
}

export function createTreeIndexSink(db: SqlDatabase, source: TreeSource): TreeIndexSink {
  return new TreeIndexSink(db, source);
}

/**
 * A repeated tree OID is parsed again but writes nothing: its entries are
 * already queued. Returns the subtree OIDs the trees name when a seeded tree
 * names one without a projection row, and none otherwise.
 */
function indexTreePass(
  db: SqlDatabase,
  sources: Iterable<TreeSourceInput>,
  seeded: boolean,
): string[] {
  const batch = new TreeIndexBatch(db, { seeded });
  const subtrees: string[] = [];
  try {
    const queued = new Set<string>();
    for (const source of sources) {
      const key = `${source.repoId}:${source.treeOid}`;
      parseTreeSourceInto(batch, source, source.chunks, !queued.has(key), subtrees);
      queued.add(key);
    }
    batch.flush();
    return batch.openSubtrees ? subtrees : [];
  } finally {
    batch.dispose();
  }
}

/** Seed and index tree projections; a complete one gets no entries. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  indexTreePass(db, sources, false);
}

/**
 * Index loose trees whose `git_objects` insert trigger already seeded the
 * projection, so no seed statement runs; a complete one gets no entries.
 */
export function indexSeededTreeSources(
  db: SqlDatabase,
  sources: Iterable<TreeSourceInput>,
): string[] {
  return indexTreePass(db, sources, true);
}

/** Index one loose tree whose object insert seeded its projection; returns its unclosed subtrees' OIDs. */
export function indexSeededTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): string[] {
  return indexSeededTreeSources(db, [{ ...source, chunks }]);
}

/** Seed and index one tree projection through the streaming sink. The caller owns the transaction. */
export function indexTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  const sink = createTreeIndexSink(db, source);
  try {
    for (const chunk of chunks) sink.push(chunk);
    sink.finish();
  } finally {
    sink.dispose();
  }
}
