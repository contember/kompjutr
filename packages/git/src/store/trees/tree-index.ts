import type { SqlDatabase } from "@kompjutr/sqlite";
import { TreeParser } from "../../common/objects.js";
import { seedTreeSources, TreeIndexBatch, TreeSourceIndexer } from "./tree-index-batch.js";

export { TREE_QUEUE_ROW_FIXED_BYTES } from "./tree-index-batch.js";

export type TreeStorage = "loose" | "pack";

export interface TreeSource {
  repoId: number;
  treeOid: string;
  storage: TreeStorage;
  sourceId: number;
  objectSize: number;
}

export interface TreeSourceInput extends TreeSource {
  chunks: Iterable<Uint8Array>;
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
      this.#batch = new TreeIndexBatch(db, false, true, false);
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

function indexTreePass(
  batch: TreeIndexBatch,
  sources: Iterable<TreeSourceInput>,
  writeEntries: boolean,
  writeMarkers: boolean,
): void {
  for (const source of sources) {
    const parser = new TreeParser();
    try {
      const indexer = new TreeSourceIndexer(source, batch, writeEntries, writeMarkers);
      for (const chunk of source.chunks) {
        indexer.acceptChunk(chunk.length);
        for (const parsed of parser.push(chunk)) indexer.push(parsed);
      }
      indexer.finish(parser.finish());
    } finally {
      parser.dispose();
    }
  }
  batch.flush();
}

/** Write exact parsed-tree sources. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const arraySources = Array.isArray(sources) ? sources : null;
  if (arraySources?.every((source: TreeSourceInput) => Array.isArray(source.chunks))) {
    seedTreeSources(db, arraySources);
    const batch = new TreeIndexBatch(db, true, false, false);
    try {
      indexTreePass(batch, arraySources, true, true);
    } finally {
      batch.dispose();
    }
    return;
  }
  const batch = new TreeIndexBatch(db, false, false, false);
  try {
    indexTreePass(batch, sources, true, true);
  } finally {
    batch.dispose();
  }
}

/** Index loose trees whose object insert already seeded incomplete source rows. */
export function indexSeededTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const batch = new TreeIndexBatch(db, true, false, true);
  try {
    indexTreePass(batch, sources, true, true);
  } finally {
    batch.dispose();
  }
}

/** Index one loose tree whose object insert already seeded its incomplete source row. */
export function indexSeededTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  indexSeededTreeSources(db, [{ ...source, chunks }]);
}

/** Write one exact parsed-tree source. The caller owns the transaction. */
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
