import type { SqlDatabase } from "@kompjutr/sqlite";
import { TreeParser } from "../../common/objects.js";
import { expectSafeInteger } from "../../common/rows.js";
import { seedTreeSources, TreeIndexBatch, TreeSourceIndexer } from "./tree-index-batch.js";

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

/** The caller supplies a bounded batch of already authenticated pack occurrences. */
export function indexPackTreeSources(db: SqlDatabase, sources: readonly TreeSourceInput[]): void {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = projectionKey(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const completed = new Set<number>();
  for (const row of db.iterate(
    `SELECT CAST(j.key AS INTEGER) AS ordinal FROM json_each(?) j
       JOIN git_tree_sources s
         ON s.repo_id = json_extract(j.value, '$.repoId')
        AND s.tree_oid = json_extract(j.value, '$.treeOid')
      WHERE s.complete = 1`,
    JSON.stringify(unique.map(({ repoId, treeOid }) => ({ repoId, treeOid }))),
  )) {
    completed.add(expectSafeInteger(row.ordinal, 0, unique.length - 1, "tree source ordinal"));
  }
  indexTreeSources(
    db,
    unique.filter((_, ordinal) => !completed.has(ordinal)),
  );
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

function projectionKey(source: TreeSource): string {
  return `${source.repoId}:${source.treeOid}`;
}

/** A repeated tree OID is parsed again but writes nothing: its entries are already queued. */
function indexTreePass(batch: TreeIndexBatch, sources: Iterable<TreeSourceInput>): void {
  const queued = new Set<string>();
  for (const source of sources) {
    const parser = new TreeParser();
    try {
      const key = projectionKey(source);
      const write = !queued.has(key);
      queued.add(key);
      const indexer = new TreeSourceIndexer(source, batch, write);
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

/** Seed and index tree projections; a complete one gets no entries. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const arraySources = Array.isArray(sources) ? sources : null;
  if (arraySources?.every((source: TreeSourceInput) => Array.isArray(source.chunks))) {
    seedTreeSources(db, arraySources);
    const batch = new TreeIndexBatch(db, true, false, false);
    try {
      indexTreePass(batch, arraySources);
    } finally {
      batch.dispose();
    }
    return;
  }
  const batch = new TreeIndexBatch(db, false, false, false);
  try {
    indexTreePass(batch, sources);
  } finally {
    batch.dispose();
  }
}

/**
 * Index loose trees whose `git_objects` insert trigger already seeded the
 * projection, so no seed statement runs; a complete one gets no entries.
 */
export function indexSeededTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const batch = new TreeIndexBatch(db, true, false, true);
  try {
    indexTreePass(batch, sources);
  } finally {
    batch.dispose();
  }
}

/** Index one loose tree whose object insert seeded its projection. */
export function indexSeededTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  indexSeededTreeSources(db, [{ ...source, chunks }]);
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
