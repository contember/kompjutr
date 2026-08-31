// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { readBlob, type SqlDatabase } from "../../../db/db.js";
import { isOid, toHex } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import { hashObject, type ObjectType, objectHeader, type RawObject } from "../../common/objects.js";
import { Sha1 } from "../../common/sha1.js";
import { InflateInto, InflateStream } from "../../common/zlib.js";
import { PACK_PENDING_PAGE_ROWS } from "../pack-ingest-index.js";
import { applyDelta } from "./delta.js";
import {
  type AuthenticatedPackSource,
  type CompressedEntry,
  checkDeltaInflateBudget,
  checkedPackBytes,
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type ExternalObjectMetadata,
  isObjectType,
  isPackGraphLimit,
  MAX_PACK_BLOB_GRAPH_ENTRIES,
  MAX_PACK_BLOB_INPUTS,
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_MEMBERSHIP_OBJECTS,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_CHUNK,
  PACK_RANGE_BATCH_BYTES,
  PACK_RANGE_SLICE_BYTES,
  PACK_READ_BYTES,
  type PackedEntry,
  type PackGraphExit,
  type PackGraphOrigin,
  type PackGraphPage,
  type PackObjectRow,
  type PackRangeRequest,
  type PackSharedState,
  packRangeFragment,
  packRangeFragmentMask,
  pushExactInflate,
  requirePackId,
  validateDeltaWorkingSet,
  validatePackReadInputs,
} from "./shared.js";

export class PackReadEngine {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #externalBatch: ExternalBatchResolver;
  readonly #externalMetadata: ExternalMetadataResolver;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #chunks: ByteLru<string, Uint8Array>;
  readonly #cacheNamespace: string;
  readonly #sharedState: PackSharedState;
  readonly #cacheEntryLimit: number;
  readonly #maxDeltaDepth: number;
  readonly #graphPageEntries: number;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    chunks: ByteLru<string, Uint8Array>,
    cacheNamespace: string,
    externalBatch: ExternalBatchResolver,
    externalMetadata: ExternalMetadataResolver,
    sharedState: PackSharedState,
    cacheEntryLimit: number,
    maxDeltaDepth: number,
    graphPageEntries: number,
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#externalBatch = externalBatch;
    this.#externalMetadata = externalMetadata;
    this.#objects = objects;
    this.#chunks = chunks;
    this.#cacheNamespace = cacheNamespace;
    this.#sharedState = sharedState;
    this.#cacheEntryLimit = cacheEntryLimit;
    this.#maxDeltaDepth = maxDeltaDepth;
    this.#graphPageEntries = graphPageEntries;
  }

  /** Bytes the chunk cache currently holds. */
  get cachedChunkBytes(): number {
    return this.#chunks.bytes;
  }

  lookup(oid: string): PackedEntry | null {
    const row = this.#db.one<PackObjectRow>(
      `SELECT object.pack_id, object.offset, object.data_off, object.data_len,
              object.type, object.size, object.entry_size, object.base_oid
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?`,
      this.#repoId,
      oid,
    );
    if (row === undefined) return null;
    return {
      oid,
      packId: row.pack_id,
      offset: row.offset,
      dataOff: row.data_off,
      dataLen: row.data_len,
      type: row.type,
      size: row.size,
      entrySize: row.entry_size,
      baseOid: row.base_oid,
    };
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    const row = this.#db.one<{ type: ObjectType; size: number }>(
      `SELECT object.type, object.size
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?`,
      this.#repoId,
      oid,
    );
    return row ?? null;
  }

  count(): number {
    return (
      this.#db.scalar<number>(
        `SELECT COUNT(*)
           FROM git_pack_objects object
           JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND pack.state = 'complete'
          WHERE object.repo_id = ?`,
        this.#repoId,
      ) ?? 0
    );
  }

  findPrefix(prefix: string, limit: number): string[] {
    return this.#db
      .all<{ oid: string }>(
        `SELECT object.oid
           FROM git_pack_objects object
           JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND pack.state = 'complete'
          WHERE object.repo_id = ? AND object.oid >= ? AND object.oid < ?
          ORDER BY object.oid LIMIT ?`,
        this.#repoId,
        prefix,
        `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
        limit,
      )
      .map((row) => row.oid);
  }

  /** Every oid the pack index holds, in index order. */
  oids(): string[] {
    return this.#db
      .all<{ oid: string }>(
        `SELECT object.oid
           FROM git_pack_objects object
           JOIN git_pack_meta pack
             ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
            AND pack.state = 'complete'
          WHERE object.repo_id = ?
          ORDER BY object.oid`,
        this.#repoId,
      )
      .map((row) => row.oid);
  }

  /**
   * Inflate and delta-resolve an object. The base chain is walked through
   * index lookups first — bounding its length and catching cycles before
   * anything is inflated — then applied upward from the base, holding at
   * most two inflated buffers at a time.
   */
  read(oid: string): RawObject | null {
    validatePackReadInputs([oid], null);
    return this.readObjectsBounded([oid], null, null, true, new Map(), false).get(oid) ?? null;
  }

  /** Resolve packed blobs with one graph query and one physical chunk cursor. */
  readBlobs(oids: readonly string[]): Map<string, Uint8Array> {
    validatePackReadInputs(oids, "blob");
    const objects = this.readObjectsBounded(oids, null, "blob", false, new Map(), false);
    const blobs = new Map<string, Uint8Array>();
    for (const [oid, object] of objects) {
      if (object.type !== "blob") {
        throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
      }
      blobs.set(oid, object.data);
    }
    return blobs;
  }

  /**
   * Resolve a bounded mixed-object batch in physical pack order. An explicit
   * Resolve a bounded mixed-object batch in physical pack order.
   */
  readObjects(
    oids: readonly string[],
    expectedType: ObjectType | null = null,
  ): Map<string, RawObject> {
    validatePackReadInputs(oids, expectedType);
    return this.readObjectsBounded(oids, null, expectedType, false, new Map(), false);
  }

  /** Cold-read and hash one canonical object from a complete pack. */
  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    validatePackReadInputs([oid], expectedType);
    const object = this.readObjectsBounded([oid], null, expectedType, true, new Map(), true).get(
      oid,
    );
    if (object === undefined) return null;
    if (hashObject(object.type, object.data) !== oid) {
      throw new CorruptError(`packed ${expectedType} ${oid} does not match its bytes`);
    }
    return object;
  }

  /** Cold-read and hash exact canonical complete-pack sources. */
  authenticateCompleteSources(
    objects: readonly { oid: string; type: ObjectType; size: number; packId: number }[],
  ): void {
    if (objects.length < 1 || objects.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
      throw new GitError(
        "E2BIG",
        `packed source authentication exceeds ${MAX_PACK_MEMBERSHIP_OBJECTS} objects`,
      );
    }
    const requested = new Set<string>();
    for (const object of objects) {
      if (
        !isOid(object.oid) ||
        !isObjectType(object.type) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        object.size > MAX_PACK_DELTA_WORKING_BYTES ||
        !Number.isSafeInteger(object.packId) ||
        object.packId < 0
      ) {
        throw new CorruptError("canonical packed source request is invalid");
      }
      if (requested.has(object.oid)) {
        throw new CorruptError("canonical packed source request contains a duplicate object id");
      }
      requested.add(object.oid);
    }
    const encoded = JSON.stringify(objects);
    let sources = 0;
    const authenticated: AuthenticatedPackSource[] = [];
    for (const row of this.#db.iterate(
      `SELECT CAST(input.key AS INTEGER) AS ordinal,
              json_extract(input.value, '$.oid') AS expected_oid,
              json_extract(input.value, '$.type') AS expected_type,
              json_extract(input.value, '$.size') AS expected_size,
              json_extract(input.value, '$.packId') AS expected_pack_id,
              canonical.oid, canonical.type, canonical.size, canonical.pack_id,
              canonical.data_off, canonical.data_len, canonical.entry_size,
              canonical.base_oid, pack.state, pack.size AS pack_size,
              EXISTS (
                SELECT 1 FROM git_pack_entries physical
                 WHERE physical.repo_id = canonical.repo_id
                   AND physical.oid = canonical.oid
                   AND physical.pack_id = canonical.pack_id
                   AND physical.offset IS canonical.offset
                   AND physical.data_off IS canonical.data_off
                   AND physical.data_len IS canonical.data_len
                   AND physical.type IS canonical.type
                   AND physical.size IS canonical.size
                   AND physical.entry_size IS canonical.entry_size
                   AND physical.base_oid IS canonical.base_oid
              ) AS exact_source
         FROM json_each(?) input
         LEFT JOIN git_pack_objects canonical
           ON canonical.repo_id = ? AND canonical.oid = json_extract(input.value, '$.oid')
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = canonical.repo_id AND pack.pack_id = canonical.pack_id
        ORDER BY CAST(input.key AS INTEGER)`,
      encoded,
      this.#repoId,
    )) {
      const expected = objects[sources];
      if (
        expected === undefined ||
        row.ordinal !== sources ||
        row.expected_oid !== expected.oid ||
        row.expected_type !== expected.type ||
        row.expected_size !== expected.size ||
        row.expected_pack_id !== expected.packId ||
        row.oid !== expected.oid ||
        row.type !== expected.type ||
        row.size !== expected.size ||
        row.pack_id !== expected.packId ||
        row.state !== "complete" ||
        row.exact_source !== 1 ||
        typeof row.data_off !== "number" ||
        !Number.isSafeInteger(row.data_off) ||
        row.data_off < 0 ||
        typeof row.data_len !== "number" ||
        !Number.isSafeInteger(row.data_len) ||
        row.data_len < 1 ||
        typeof row.entry_size !== "number" ||
        !Number.isSafeInteger(row.entry_size) ||
        row.entry_size < 0 ||
        row.entry_size > MAX_PACK_DELTA_WORKING_BYTES ||
        (row.base_oid !== null && (typeof row.base_oid !== "string" || !isOid(row.base_oid))) ||
        typeof row.pack_size !== "number" ||
        !Number.isSafeInteger(row.pack_size) ||
        row.pack_size < 32 ||
        !Number.isSafeInteger(row.data_off + row.data_len) ||
        row.data_off + row.data_len > row.pack_size - 20 ||
        (row.base_oid === null && row.entry_size !== expected.size)
      ) {
        throw new CorruptError("canonical packed source changed before authentication");
      }
      authenticated.push({
        oid: expected.oid,
        type: expected.type,
        size: expected.size,
        packId: expected.packId,
        dataOff: row.data_off,
        dataLen: row.data_len,
        entrySize: row.entry_size,
        baseOid: row.base_oid,
      });
      sources++;
    }
    if (sources !== objects.length) {
      throw new CorruptError("canonical packed source authentication is incomplete");
    }

    let page: AuthenticatedPackSource[] = [];
    let pageBytes = 0;
    const authenticatePage = (): void => {
      if (page.length === 0) return;
      const only = page.length === 1 ? page[0] : undefined;
      if (
        only !== undefined &&
        only.dataLen > PACK_BLOB_BATCH_TARGET_BYTES &&
        only.baseOid === null
      ) {
        this.#authenticateFullPackSourceStreaming(
          only,
          "canonical packed source bytes disagree with their object id",
        );
        page = [];
        pageBytes = 0;
        return;
      }
      const read = this.readObjectsBounded(
        page.map((object) => object.oid),
        only?.packId ?? null,
        null,
        false,
        new Map(),
        true,
      );
      if (read.size !== page.length) {
        throw new CorruptError("canonical packed source authentication is incomplete");
      }
      for (const expected of page) {
        const object = read.get(expected.oid);
        if (
          object === undefined ||
          object.type !== expected.type ||
          object.data.length !== expected.size ||
          hashObject(object.type, object.data) !== expected.oid
        ) {
          throw new CorruptError("canonical packed source bytes disagree with their object id");
        }
      }
      page = [];
      pageBytes = 0;
    };
    for (const object of authenticated) {
      if (
        page.length > 0 &&
        (object.size > PACK_BLOB_BATCH_TARGET_BYTES - pageBytes ||
          object.dataLen > PACK_BLOB_BATCH_TARGET_BYTES)
      ) {
        authenticatePage();
      }
      page.push(object);
      pageBytes += object.size;
      if (
        object.size > PACK_BLOB_BATCH_TARGET_BYTES ||
        object.dataLen > PACK_BLOB_BATCH_TARGET_BYTES
      ) {
        authenticatePage();
      }
    }
    authenticatePage();
  }

  #authenticateFullPackSourceStreaming(source: AuthenticatedPackSource, message: string): void {
    if (source.baseOid !== null || source.entrySize !== source.size || source.dataLen < 1) {
      throw new CorruptError(message);
    }
    const sha = new Sha1().update(objectHeader(source.type, source.size));
    let produced = 0;
    const stream = new InflateStream((chunk) => {
      produced += chunk.length;
      if (produced > source.size) throw new CorruptError(message);
      sha.update(chunk);
    });
    let consumed = 0;
    try {
      while (!stream.ended && consumed < source.dataLen) {
        const length = Math.min(PACK_READ_BYTES, source.dataLen - consumed);
        const input = this.#readRawUncached(source.packId, source.dataOff + consumed, length);
        const used = stream.push(input);
        consumed += used;
        if (!stream.ended && used !== input.length) throw new CorruptError(message);
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(message, { cause: error });
    }
    if (
      !stream.ended ||
      consumed !== source.dataLen ||
      produced !== source.size ||
      toHex(sha.digest()) !== source.oid
    ) {
      throw new CorruptError(message);
    }
  }

  /** Use the fast union read, then page the same union graph only on structural overflow. */
  readObjectsBounded(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject>,
    bypassCache: boolean,
  ): Map<string, RawObject> {
    try {
      return this.#readObjects(oids, pendingPackId, expectedType, allowMissing, seeds, bypassCache);
    } catch (error) {
      if (!isPackGraphLimit(error)) throw error;
    }
    return this.#readObjectsPaged(
      oids,
      pendingPackId,
      expectedType,
      allowMissing,
      seeds,
      bypassCache,
    );
  }

  /** Discover one bounded union graph and resolve its checkpoint pages in reverse. */
  #readObjectsPaged(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject>,
    bypassCache: boolean,
  ): Map<string, RawObject> {
    {
      const wanted = [...new Set(oids)];
      let frontier = new Map<string, PackGraphOrigin[]>();
      for (const oid of wanted) {
        frontier.set(oid, [{ rootOid: oid, depth: 0, checkpoints: new Set([oid]) }]);
      }
      const pages: PackGraphPage[] = [];
      const seedJson = JSON.stringify([...seeds.keys()]);
      const visiblePendingPackId = pendingPackId ?? -1;

      while (frontier.size > 0) {
        let originCount = 0;
        for (const origins of frontier.values()) originCount += origins.length;
        if (!Number.isSafeInteger(originCount) || originCount < 1 || originCount > wanted.length) {
          throw new CorruptError("paged pack frontier state is invalid");
        }
        const entryLimit = Math.max(this.#graphPageEntries, frontier.size);
        const pageRoots = [...frontier.keys()];
        pages.push({ roots: pageRoots, entryLimit });
        const rootJson = JSON.stringify(pageRoots);
        const links = new Map<string, string | null>();
        let rowCount = 0;
        for (const row of this.#db.iterate(
          `WITH RECURSIVE /* pack-graph-page */
               frontier(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
               seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
               reachable(oid) AS (
                 SELECT object.oid
                   FROM frontier
                   JOIN git_pack_objects object
                     ON object.repo_id = ? AND object.oid = frontier.oid
                   JOIN git_pack_meta pack
                     ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
                    AND (pack.state = 'complete' OR object.pack_id = ?)
                 UNION
                 SELECT base.oid
                   FROM reachable
                   JOIN git_pack_objects child
                     ON child.repo_id = ? AND child.oid = reachable.oid
                   JOIN git_pack_meta child_pack
                     ON child_pack.repo_id = child.repo_id
                    AND child_pack.pack_id = child.pack_id
                    AND (child_pack.state = 'complete' OR child.pack_id = ?)
                   JOIN git_pack_objects base
                     ON base.repo_id = child.repo_id AND base.oid = child.base_oid
                   JOIN git_pack_meta base_pack
                     ON base_pack.repo_id = base.repo_id AND base_pack.pack_id = base.pack_id
                    AND (base_pack.state = 'complete' OR base.pack_id = ?)
                  WHERE NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)
                  LIMIT ${entryLimit}
               )
             SELECT object.oid, object.base_oid
               FROM reachable
               JOIN git_pack_objects object
                 ON object.repo_id = ? AND object.oid = reachable.oid`,
          rootJson,
          seedJson,
          this.#repoId,
          visiblePendingPackId,
          this.#repoId,
          visiblePendingPackId,
          visiblePendingPackId,
          this.#repoId,
        )) {
          rowCount++;
          const oid = row.oid;
          const baseOid = row.base_oid;
          if (
            rowCount > entryLimit ||
            typeof oid !== "string" ||
            !isOid(oid) ||
            (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid))) ||
            links.has(oid)
          ) {
            throw new CorruptError("paged pack graph contains invalid metadata");
          }
          links.set(oid, baseOid);
        }

        const memo = new Map<string, PackGraphExit>();
        const visiting = new Set<string>();
        const pageExit = (start: string): PackGraphExit | null => {
          if (!links.has(start)) return null;
          const path: string[] = [];
          let current = start;
          for (;;) {
            const known = memo.get(current);
            if (known !== undefined) break;
            if (visiting.has(current)) throw new CorruptError(`cyclic delta chain at ${current}`);
            visiting.add(current);
            path.push(current);
            const base = links.get(current);
            if (base === null || base === undefined || !links.has(base)) break;
            current = base;
          }
          for (let index = path.length - 1; index >= 0; index--) {
            const oid = path[index]!;
            const base = links.get(oid);
            let exit: PackGraphExit;
            if (base === null || base === undefined) exit = { oid: null, distance: 0 };
            else if (!links.has(base)) exit = { oid: base, distance: 1 };
            else {
              const next = memo.get(base);
              if (next === undefined) {
                throw new CorruptError("paged pack graph did not resolve a local dependency");
              }
              exit = { oid: next.oid, distance: next.distance + 1 };
            }
            memo.set(oid, exit);
            visiting.delete(oid);
          }
          return memo.get(start) ?? null;
        };

        const moves: { origin: PackGraphOrigin; exit: string; depth: number }[] = [];
        for (const [root, origins] of frontier) {
          const exit = pageExit(root);
          if (exit === null) continue;
          for (const origin of origins) {
            const depth = origin.depth + exit.distance;
            if (!Number.isSafeInteger(depth) || depth > this.#maxDeltaDepth) {
              throw new CorruptError(
                `delta chain deeper than ${this.#maxDeltaDepth} at ${origin.rootOid}`,
              );
            }
            if (exit.oid !== null && !seeds.has(exit.oid)) {
              moves.push({ origin, exit: exit.oid, depth });
            }
          }
        }
        if (moves.length === 0) break;

        const nextFrontier = new Map<string, PackGraphOrigin[]>();
        for (const move of moves) {
          if (move.origin.checkpoints.has(move.exit)) {
            throw new CorruptError(`cyclic delta chain at ${move.exit}`);
          }
          move.origin.depth = move.depth;
          move.origin.checkpoints.add(move.exit);
          const origins = nextFrontier.get(move.exit);
          if (origins === undefined) nextFrontier.set(move.exit, [move.origin]);
          else origins.push(move.origin);
        }
        if (nextFrontier.size === 0) {
          throw new CorruptError("paged pack graph traversal made no progress");
        }
        frontier = nextFrontier;
      }

      let checkpoint: Map<string, RawObject> | null = null;
      for (let index = pages.length - 1; index >= 0; index--) {
        const page = pages[index]!;
        let pageResult: Map<string, RawObject>;
        let pageSeeds = seeds;
        if (checkpoint !== null) {
          const combined = new Map(seeds);
          for (const [oid, object] of checkpoint) combined.set(oid, object);
          pageSeeds = combined;
        }
        try {
          pageResult = this.#readObjects(
            page.roots,
            pendingPackId,
            index === 0 ? expectedType : null,
            index === 0 ? allowMissing : true,
            pageSeeds,
            bypassCache,
            page.entryLimit,
          );
        } catch (error) {
          if (isPackGraphLimit(error)) {
            throw new CorruptError("paged packed dependency graph exceeded its discovered page");
          }
          throw error;
        }
        checkpoint = pageResult;
      }
      if (checkpoint === null) {
        throw new CorruptError("paged pack graph produced no resolution page");
      }
      return checkpoint;
    }
  }

  /** Resolve requested objects in one bounded graph and physical pack cursor. */
  #readObjects(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject> = new Map(),
    bypassCache = false,
    graphEntryLimit = this.#graphPageEntries,
  ): Map<string, RawObject> {
    if (
      !Number.isSafeInteger(graphEntryLimit) ||
      graphEntryLimit < 1 ||
      graphEntryLimit > MAX_PACK_BLOB_GRAPH_ENTRIES
    ) {
      throw new CorruptError("packed blob graph entry limit is invalid");
    }
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    if (wanted.length > MAX_PACK_BLOB_INPUTS) {
      throw new GitError("E2BIG", `blob batch exceeds ${MAX_PACK_BLOB_INPUTS} packed inputs`);
    }

    const rows = this.#db.iterate(
      `WITH RECURSIVE
         roots(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         reachable(oid) AS (
           SELECT o.oid
             FROM roots r
             CROSS JOIN git_pack_objects o
             CROSS JOIN git_pack_meta m
            WHERE o.repo_id = ? AND o.oid = r.oid
              AND m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND (m.state = 'complete' OR o.pack_id = ?)
           UNION
           SELECT base.oid
             FROM reachable r
             CROSS JOIN git_pack_objects child
             CROSS JOIN git_pack_meta child_meta
             CROSS JOIN git_pack_objects base
             CROSS JOIN git_pack_meta base_meta
            WHERE child.repo_id = ? AND child.oid = r.oid
              AND child_meta.repo_id = child.repo_id
              AND child_meta.pack_id = child.pack_id
              AND (child_meta.state = 'complete' OR child.pack_id = ?)
              AND base.repo_id = child.repo_id AND base.oid = child.base_oid
              AND base_meta.repo_id = base.repo_id
               AND base_meta.pack_id = base.pack_id
               AND (base_meta.state = 'complete' OR base.pack_id = ?)
               AND NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)
             LIMIT ${graphEntryLimit + 1}
          )
       SELECT o.oid, o.pack_id, o.offset, o.data_off, o.data_len, o.type,
              o.size, o.entry_size, o.base_oid
         FROM reachable r
         CROSS JOIN git_pack_objects o
        WHERE o.repo_id = ? AND o.oid = r.oid`,
      JSON.stringify(wanted),
      JSON.stringify([...seeds.keys()]),
      this.#repoId,
      pendingPackId ?? -1,
      this.#repoId,
      pendingPackId ?? -1,
      pendingPackId ?? -1,
      this.#repoId,
    );

    const entries = new Map<string, PackedEntry>();
    let rowCount = 0;
    for (const row of rows) {
      rowCount++;
      if (rowCount > graphEntryLimit) {
        throw new GitError("E2BIG", "packed blob dependency graph exceeds the bounded entry limit");
      }
      const oid = row.oid;
      const packId = row.pack_id;
      const offset = row.offset;
      const dataOff = row.data_off;
      const dataLen = row.data_len;
      const type = row.type;
      const size = row.size;
      const entrySize = row.entry_size;
      const baseOid = row.base_oid;
      if (
        typeof oid !== "string" ||
        !isOid(oid) ||
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        packId < 0 ||
        offset < 0 ||
        dataOff < 0 ||
        dataLen < 0 ||
        !Number.isSafeInteger(dataOff + dataLen) ||
        size < 0 ||
        size > MAX_PACK_DELTA_WORKING_BYTES ||
        entrySize < 0 ||
        entrySize > MAX_PACK_DELTA_WORKING_BYTES ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid)))
      ) {
        throw new CorruptError("packed blob index contains invalid metadata");
      }
      entries.set(oid, {
        oid,
        packId,
        offset,
        dataOff,
        dataLen,
        type,
        size,
        entrySize,
        baseOid,
      });
    }
    const available: string[] = [];
    for (const oid of wanted) {
      const entry = entries.get(oid);
      if (entry === undefined) {
        if (allowMissing) continue;
        throw new CorruptError(`packed object ${oid} has no visible source`);
      }
      if (expectedType !== null && entry.type !== expectedType) {
        throw new CorruptError(`${oid} is a ${entry.type}, not a ${expectedType}`);
      }
      available.push(oid);
    }
    const needed = new Map<string, PackedEntry>();
    const externalOids = new Set<string>();
    for (const oid of available) {
      let current = entries.get(oid)!;
      if (
        !bypassCache &&
        this.#objects.get(this.objectCacheKey(current.packId, oid)) !== undefined
      ) {
        continue;
      }
      const seen = new Set<string>();
      let depth = 0;
      for (;;) {
        if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(current.oid);
        needed.set(current.oid, current);
        if (current.baseOid === null) break;
        if (depth >= this.#maxDeltaDepth) {
          throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
        }
        depth++;
        const next = entries.get(current.baseOid);
        if (next === undefined) {
          if (seeds.has(current.baseOid)) break;
          externalOids.add(current.baseOid);
          break;
        }
        if (
          !bypassCache &&
          this.#objects.get(this.objectCacheKey(next.packId, next.oid)) !== undefined
        ) {
          break;
        }
        current = next;
      }
    }

    let compressedBytes = 0;
    const streamedCompressed = new Set<string>();
    const compressed = new Map<string, CompressedEntry>();
    const consumers = new Map<string, { entry: PackedEntry; output: CompressedEntry }[]>();
    for (const entry of needed.values()) {
      if (entry.dataLen > PACK_BLOB_BATCH_TARGET_BYTES - compressedBytes) {
        streamedCompressed.add(entry.oid);
        continue;
      }
      compressedBytes = checkedPackBytes(compressedBytes, entry.dataLen, "compressed input");
    }
    for (const entry of needed.values()) {
      if (streamedCompressed.has(entry.oid)) continue;
      const output = { bytes: new Uint8Array(entry.dataLen), filled: 0 };
      compressed.set(entry.oid, output);
      if (entry.dataLen === 0) continue;
      const first = Math.floor(entry.dataOff / PACK_CHUNK);
      const last = Math.floor((entry.dataOff + entry.dataLen - 1) / PACK_CHUNK);
      for (let seq = first; seq <= last; seq++) {
        const key = `${entry.packId}:${seq}`;
        const list = consumers.get(key);
        const consumer = { entry, output };
        if (list === undefined) consumers.set(key, [consumer]);
        else list.push(consumer);
      }
    }

    const copyChunk = (packId: number, seq: number, chunk: Uint8Array): void => {
      for (const { entry, output } of consumers.get(`${packId}:${seq}`) ?? []) {
        const chunkStart = seq * PACK_CHUNK;
        const from = Math.max(entry.dataOff, chunkStart);
        const to = Math.min(entry.dataOff + entry.dataLen, chunkStart + chunk.length);
        if (to <= from) continue;
        const target = from - entry.dataOff;
        output.bytes.set(chunk.subarray(from - chunkStart, to - chunkStart), target);
        output.filled += to - from;
      }
    };

    const missingChunks: { p: number; q: number }[] = [];
    for (const key of consumers.keys()) {
      const separator = key.indexOf(":");
      const packId = Number(key.slice(0, separator));
      const seq = Number(key.slice(separator + 1));
      const hit = bypassCache ? undefined : this.#chunks.get(this.#chunkCacheKey(packId, seq));
      if (hit === undefined) missingChunks.push({ p: packId, q: seq });
      else copyChunk(packId, seq, hit);
    }
    missingChunks.sort((left, right) => left.p - right.p || left.q - right.q);
    const returned = new Set<string>();
    if (missingChunks.length > 0) {
      for (const row of this.#db.iterate(
        `WITH requested(pack_id, seq) AS (
           SELECT json_extract(value, '$.p'), json_extract(value, '$.q') FROM json_each(?)
         )
         SELECT d.pack_id, d.seq, d.data
           FROM requested r
           JOIN git_pack_data d
             ON d.repo_id = ? AND d.pack_id = r.pack_id AND d.seq = r.seq
          WHERE length(d.data) <= ${PACK_CHUNK}
          ORDER BY d.pack_id, d.seq`,
        JSON.stringify(missingChunks),
        this.#repoId,
      )) {
        if (!Number.isSafeInteger(row.pack_id) || !Number.isSafeInteger(row.seq)) {
          throw new CorruptError("pack chunk query returned invalid coordinates");
        }
        const packId = Number(row.pack_id);
        const seq = Number(row.seq);
        const data = readBlob(row.data);
        const key = `${packId}:${seq}`;
        returned.add(key);
        if (!bypassCache) this.#chunks.set(this.#chunkCacheKey(packId, seq), data);
        copyChunk(packId, seq, data);
      }
    }
    for (const chunk of missingChunks) {
      if (!returned.has(`${chunk.p}:${chunk.q}`)) {
        throw new CorruptError(`pack ${chunk.p}: missing chunk ${chunk.q}`);
      }
    }
    for (const [oid, value] of compressed) {
      if (value.filled !== value.bytes.length) {
        throw new CorruptError(`packed blob entry ${oid} exceeds its stored chunks`);
      }
    }

    const externalMetadata = new Map<string, ExternalObjectMetadata>();
    if (externalOids.size > 0) {
      const resolvedMetadata = this.#externalMetadata([...externalOids]);
      for (const oid of externalOids) {
        const object = resolvedMetadata.get(oid);
        if (object === undefined) continue;
        if (
          !isObjectType(object.type) ||
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          object.size > MAX_PACK_DELTA_WORKING_BYTES
        ) {
          throw new CorruptError("loose base metadata is invalid");
        }
        externalMetadata.set(oid, object);
      }
    }
    let external = new Map<string, RawObject>();
    if (externalMetadata.size > 0) {
      external = this.#externalBatch([...externalMetadata.keys()]);
    }
    for (const [oid, object] of external) {
      const metadata = externalMetadata.get(oid);
      if (
        metadata === undefined ||
        metadata.type !== object.type ||
        metadata.size !== object.data.length
      ) {
        throw new CorruptError("materialized loose base disagrees with its admitted metadata");
      }
    }
    const result = new Map<string, RawObject>();
    const resolved = new Map<string, RawObject>();
    for (const oid of available) {
      const first = entries.get(oid)!;
      const cached =
        resolved.get(oid) ??
        (bypassCache ? undefined : this.#objects.get(this.objectCacheKey(first.packId, oid)));
      if (cached !== undefined) {
        result.set(oid, cached);
        continue;
      }
      const chain: PackedEntry[] = [];
      const seen = new Set<string>();
      let current = first;
      let object: RawObject | undefined;
      for (;;) {
        if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(current.oid);
        const resolvedBase = resolved.get(current.oid);
        if (resolvedBase !== undefined) {
          object = resolvedBase;
          break;
        }
        if (current.baseOid === null) {
          if (current.entrySize !== current.size) {
            throw new CorruptError(
              `pack entry at ${current.offset} has inconsistent size metadata`,
            );
          }
          object = {
            type: current.type,
            data: this.#inflateCompressed(
              current,
              compressed.get(current.oid)?.bytes,
              streamedCompressed.has(current.oid),
              bypassCache,
            ),
          };
          resolved.set(current.oid, object);
          if (!bypassCache) this.cacheObject(current.packId, current.oid, object);
          break;
        }
        if (chain.length >= this.#maxDeltaDepth) {
          throw new CorruptError(`delta chain deeper than ${this.#maxDeltaDepth} at ${oid}`);
        }
        chain.push(current);
        const next = entries.get(current.baseOid);
        if (next === undefined) {
          const seeded = seeds.get(current.baseOid);
          object = seeded ?? external.get(current.baseOid);
          if (object === undefined) {
            throw new CorruptError(`missing delta base ${current.baseOid} for ${current.oid}`);
          }
          break;
        }
        const cachedBase = bypassCache
          ? undefined
          : this.#objects.get(this.objectCacheKey(next.packId, next.oid));
        if (cachedBase !== undefined) {
          object = cachedBase;
          break;
        }
        current = next;
      }
      if (object === undefined) {
        throw new CorruptError(`packed object ${oid} did not resolve a base`);
      }
      let resolvedObject = object;
      for (let index = chain.length - 1; index >= 0; index--) {
        const entry = chain[index]!;
        checkDeltaInflateBudget(resolvedObject.data, entry.entrySize);
        const delta = this.#inflateCompressed(
          entry,
          compressed.get(entry.oid)?.bytes,
          streamedCompressed.has(entry.oid),
          bypassCache,
        );
        const targetSize = validateDeltaWorkingSet(resolvedObject.data, delta, entry.size);
        const target: RawObject = {
          type: resolvedObject.type,
          data: applyDelta(resolvedObject.data, delta),
        };
        if (targetSize !== target.data.length) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent size metadata`);
        }
        resolvedObject = target;
        resolved.set(entry.oid, resolvedObject);
        if (resolvedObject.data.length !== entry.size || resolvedObject.type !== entry.type) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent type or size`);
        }
        if (!bypassCache) this.cacheObject(entry.packId, entry.oid, resolvedObject);
      }
      if (resolvedObject.type !== first.type || resolvedObject.data.length !== first.size) {
        throw new CorruptError(`packed object ${oid} has inconsistent type or size`);
      }
      result.set(oid, resolvedObject);
      resolved.set(oid, resolvedObject);
    }
    return result;
  }

  #inflateCompressed(
    entry: PackedEntry,
    compressed: Uint8Array | undefined,
    streamed: boolean,
    bypassCache: boolean,
  ): Uint8Array {
    if (compressed === undefined) {
      if (!streamed) throw new CorruptError(`packed blob entry ${entry.oid} was not loaded`);
      return this.#inflateStoredEntry(
        entry.packId,
        entry.dataOff,
        entry.dataLen,
        entry.entrySize,
        `pack entry at ${entry.offset}`,
        bypassCache,
      );
    }
    return this.#inflateBytes(compressed, entry.entrySize, `pack entry at ${entry.offset}`);
  }

  #inflateBytes(input: Uint8Array, expectedSize: number, label: string): Uint8Array {
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded inflate limit`);
    }
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    try {
      while (!stream.ended && consumed < input.length) {
        const used = pushExactInflate(stream, input.subarray(consumed), label);
        consumed += used;
        if (!stream.ended && used === 0) {
          throw new CorruptError(`${label} inflater made no progress`);
        }
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
    }
    if (!stream.ended || consumed !== input.length) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    try {
      return stream.finish();
    } catch (error) {
      throw new CorruptError(`${label} size does not match its index metadata`, { cause: error });
    }
  }

  cacheObject(packId: number, oid: string, object: RawObject): void {
    if (object.data.length <= this.#cacheEntryLimit) {
      this.#objects.set(this.objectCacheKey(packId, oid), object);
    }
  }

  objectCacheKey(packId: number, oid: string): string {
    return `${this.#cacheNamespace}:${this.#sharedState.cacheGeneration}:pack:${packId}:${oid}`;
  }

  #chunkCacheKey(packId: number, seq: number): string {
    return `${this.#cacheNamespace}:${this.#sharedState.cacheGeneration}:row:${packId}:${seq}`;
  }

  #inflateStoredEntry(
    packId: number,
    dataOff: number,
    dataLen: number,
    expectedSize: number,
    label: string,
    bypassCache = false,
  ): Uint8Array {
    if (
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(expectedSize) ||
      dataLen < 0 ||
      expectedSize < 0 ||
      expectedSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded inflate limit`);
    }
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
      const input = bypassCache
        ? this.#readRawUncached(packId, dataOff + consumed, length)
        : this.readRaw(packId, dataOff + consumed, length);
      const used = pushExactInflate(stream, input, label);
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    }
    if (!stream.ended || consumed !== dataLen) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    try {
      return stream.finish();
    } catch (error) {
      throw new CorruptError(`${label} size does not match its index metadata`, { cause: error });
    }
  }

  readRangeBatch(packId: number, requests: readonly PackRangeRequest[]): Map<number, Uint8Array> {
    if (requests.length === 0 || requests.length > PACK_PENDING_PAGE_ROWS) {
      throw new CorruptError("pack range batch has an invalid request count");
    }
    let totalBytes = 0;
    for (const request of requests) {
      totalBytes += request.length;
      if (
        !Number.isSafeInteger(request.ordinal) ||
        !Number.isSafeInteger(request.offset) ||
        !Number.isSafeInteger(request.position) ||
        !Number.isSafeInteger(request.length) ||
        request.ordinal < 0 ||
        request.offset < 0 ||
        request.position < 0 ||
        request.length < 1 ||
        !Number.isSafeInteger(request.position + request.length) ||
        totalBytes > PACK_RANGE_BATCH_BYTES
      ) {
        throw new CorruptError("pack range batch has invalid coordinates");
      }
    }

    const outputs = new Map<number, Uint8Array>();
    const seen = new Map<number, number>();
    for (const request of requests) {
      if (outputs.has(request.offset)) {
        throw new CorruptError("pack range batch has a duplicate object offset");
      }
      outputs.set(request.offset, new Uint8Array(request.length));
      seen.set(request.offset, 0);
    }
    for (const range of this.#db.iterate(
      `WITH RECURSIVE /* pack-range substr <= ${PACK_RANGE_SLICE_BYTES} */
         requested(ordinal, object_offset, position, remaining) AS (
           SELECT json_extract(value, '$.ordinal'), json_extract(value, '$.offset'),
                  json_extract(value, '$.position'), json_extract(value, '$.length')
             FROM json_each(?)
         ),
         slices(ordinal, object_offset, position, remaining) AS (
           SELECT ordinal, object_offset, position, remaining FROM requested
           UNION ALL
           SELECT ordinal, object_offset,
                  position + min(remaining, ${PACK_RANGE_SLICE_BYTES},
                                 ${PACK_CHUNK} - position % ${PACK_CHUNK}),
                  remaining - min(remaining, ${PACK_RANGE_SLICE_BYTES},
                                  ${PACK_CHUNK} - position % ${PACK_CHUNK})
             FROM slices WHERE remaining > 0
         )
       SELECT slices.ordinal, slices.object_offset AS offset, slices.position,
              min(slices.remaining, ${PACK_RANGE_SLICE_BYTES},
                  ${PACK_CHUNK} - slices.position % ${PACK_CHUNK}) AS expected,
              substr(data.data, slices.position % ${PACK_CHUNK} + 1,
                     min(slices.remaining, ${PACK_RANGE_SLICE_BYTES},
                         ${PACK_CHUNK} - slices.position % ${PACK_CHUNK})) AS data
         FROM slices
        JOIN git_pack_data data
           ON data.repo_id = ? AND data.pack_id = ?
          AND data.seq = CAST(slices.position / ${PACK_CHUNK} AS INTEGER)
        WHERE slices.remaining > 0`,
      JSON.stringify(requests),
      this.#repoId,
      packId,
    )) {
      if (
        typeof range.ordinal !== "number" ||
        typeof range.offset !== "number" ||
        typeof range.position !== "number" ||
        typeof range.expected !== "number" ||
        !Number.isSafeInteger(range.ordinal) ||
        !Number.isSafeInteger(range.offset) ||
        !Number.isSafeInteger(range.position) ||
        !Number.isSafeInteger(range.expected) ||
        range.ordinal < 0 ||
        range.ordinal >= requests.length ||
        range.expected < 1 ||
        range.expected > PACK_RANGE_SLICE_BYTES
      ) {
        throw new CorruptError("pack range batch returned invalid coordinates");
      }
      const request = requests[range.ordinal];
      const output = outputs.get(range.offset);
      const seenMask = seen.get(range.offset);
      const fragment =
        request === undefined || typeof range.position !== "number"
          ? -1
          : packRangeFragment(request, range.position, range.expected);
      if (
        request === undefined ||
        output === undefined ||
        seenMask === undefined ||
        request.offset !== range.offset ||
        fragment < 0 ||
        (seenMask & (2 ** fragment)) !== 0
      ) {
        throw new CorruptError("pack range batch returned an unexpected slice");
      }
      const data = readBlob(range.data);
      if (data.length !== range.expected) {
        throw new CorruptError("pack range batch returned a truncated slice");
      }
      output.set(data, range.position - request.position);
      seen.set(range.offset, seenMask | (2 ** fragment));
    }
    for (const request of requests) {
      if (seen.get(request.offset) !== packRangeFragmentMask(request)) {
        throw new CorruptError(`pack ${packId}: missing range bytes`);
      }
    }
    return outputs;
  }

  /** Still-compressed bytes of a pack region, assembled from chunk rows. */
  readRaw(packId: number, offset: number, length: number): Uint8Array {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new CorruptError("pack read exceeds the bounded region limit");
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    if (first === last) {
      const chunk = this.#chunk(packId, first);
      const start = offset - first * PACK_CHUNK;
      return chunk.subarray(start, start + length);
    }
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const chunk = this.#chunk(packId, seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
    }
    return out;
  }

  #readRawUncached(packId: number, offset: number, length: number): Uint8Array {
    requirePackId(packId);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new CorruptError("uncached pack read exceeds the bounded region limit");
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const row = this.#db.one<Record<string, unknown>>(
        "SELECT pack_id, seq, data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
        this.#repoId,
        packId,
        seq,
      );
      if (row === undefined || row.pack_id !== packId || row.seq !== seq) {
        throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
      }
      const chunk = readBlob(row.data);
      if (chunk.length < 1 || chunk.length > PACK_CHUNK) {
        throw new CorruptError(`pack ${packId}: chunk ${seq} has an invalid size`);
      }
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + PACK_CHUNK);
      if (to - chunkStart > chunk.length) {
        throw new CorruptError(`pack ${packId}: chunk ${seq} is truncated`);
      }
      out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
    }
    return out;
  }

  /**
   * One decoded `git_pack_data` row through the database-wide LRU. The key
   * includes both store and invalidation generations, so deleted rows can
   * stay stale only until this bounded cache evicts them.
   */
  #chunk(packId: number, seq: number): Uint8Array {
    const key = this.#chunkCacheKey(packId, seq);
    const hit = this.#chunks.get(key);
    if (hit !== undefined) return hit;
    const row = this.#db.one<{ data: unknown }>(
      "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
      this.#repoId,
      packId,
      seq,
    );
    if (row === undefined) throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
    const chunk = readBlob(row.data);
    this.#chunks.set(key, chunk);
    return chunk;
  }

  clearCaches(): void {
    this.#sharedState.cacheGeneration++;
  }
}
