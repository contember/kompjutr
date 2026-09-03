import { blob } from "../../db/db.js";
import { concat } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { hashObject, type ObjectType } from "../common/objects.js";
import { insertCommitCaches, prepareCommitCache } from "./commits.js";
import type { ObjectBatch, ObjectBatchOptions, OwnedObjectBatch } from "./contracts.js";
import { isThenableResult } from "./json-pages.js";
import {
  type ChunkPayload,
  COMMIT_STAGE_CACHE_BYTES,
  DEFAULT_OBJECT_FLUSH,
  encodeLoose,
  looseEncoding,
  nowMilliseconds,
  OBJECT_CHUNK,
  OBJECT_PAYLOAD,
  type ObjectBatchContext,
  requireCommitCacheWrites,
  requireStorableObjectSize,
  type StagedObject,
} from "./objects-shared.js";
import { indexSeededTreeSources } from "./tree-index.js";

export function createObjectWriteBatch(
  context: ObjectBatchContext,
  options: ObjectBatchOptions,
  mutate: (body: () => void) => void = (body) => body(),
): OwnedObjectBatch {
  const payloadBytes = options.payloadBytes ?? OBJECT_PAYLOAD;
  const flushEvery = options.flushEvery ?? DEFAULT_OBJECT_FLUSH;
  // Keyed by oid: a tree build re-emits identical subtrees, and one
  // (oid, seq) may appear at most once in a payload.
  const staged = new Map<string, StagedObject>();
  let bytes = 0;
  let commitBytes = 0;
  let active = true;
  const requireActive = (): void => {
    if (!active) throw new GitError("EINVAL", "object batch is disposed");
  };
  const clear = (): void => {
    staged.clear();
    bytes = 0;
    commitBytes = 0;
  };
  const flush = (): void => {
    requireActive();
    if (staged.size === 0) return;
    try {
      mutate(() => flushObjects(context, [...staged.values()], payloadBytes));
    } finally {
      clear();
    }
  };
  return {
    write: (type: ObjectType, data: Uint8Array): string => {
      requireActive();
      try {
        requireStorableObjectSize(type, data.length);
        const oid = hashObject(type, data);
        if (staged.has(oid)) return oid;
        const stored = looseEncoding(data.length);
        const storedData = stored === "raw" ? data.slice() : encodeLoose(data, stored);
        const object: StagedObject = { oid, type, size: data.length, stored, storedData };
        if (type === "tree") object.treeData = stored === "raw" ? storedData : data.slice();
        if (type === "commit") {
          const commitEntry = prepareCommitCache({ repoId: context.repoId, oid, data });
          object.commitEntry = commitEntry;
        }
        const nextBytes =
          bytes +
          storedData.length +
          (object.treeData !== undefined && object.treeData !== storedData
            ? object.treeData.length
            : 0);
        const nextCommitBytes = commitBytes + (object.commitEntry?.cacheBytes ?? 0);
        staged.set(oid, object);
        bytes = nextBytes;
        commitBytes = nextCommitBytes;
        // After staging, never before: an object's chunks and its metadata
        // row have to land in the same flush, whatever its size.
        if (
          bytes >= payloadBytes ||
          commitBytes >= COMMIT_STAGE_CACHE_BYTES ||
          staged.size >= flushEvery
        ) {
          flush();
        }
        return oid;
      } catch (error) {
        clear();
        throw error;
      }
    },
    flush,
    dispose: (): void => {
      if (!active) return;
      clear();
      active = false;
    },
  };
}

export function writeObjects<T>(
  context: ObjectBatchContext,
  body: (batch: ObjectBatch) => T,
  options: ObjectBatchOptions,
): T {
  const batch = createObjectWriteBatch(context, options);
  try {
    const result = body(batch);
    if (isThenableResult(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new GitError("EINVAL", "object batch callback must be synchronous");
    }
    batch.flush();
    return result;
  } finally {
    batch.dispose();
  }
}

function flushObjects(
  context: ObjectBatchContext,
  staged: StagedObject[],
  payloadBytes: number,
): void {
  const byOid = new Map(staged.map((object) => [object.oid, object]));
  const commitEntries = staged.flatMap((object) =>
    object.commitEntry === undefined ? [] : [object.commitEntry],
  );
  const meta = JSON.stringify(
    staged.map((object) => ({ o: object.oid, t: object.type, s: object.size, e: object.stored })),
  );
  let wroteLoose = false;
  context.db.transactionSync(() => {
    const fresh: StagedObject[] = [];
    for (const row of context.db.iterate(
      `INSERT INTO git_objects (repo_id, oid, type, size, stored)
       SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.t'),
              json_extract(j.value, '$.s'), json_extract(j.value, '$.e')
         FROM json_each(?) j
        WHERE NOT EXISTS (
          SELECT 1
            FROM git_pack_objects packed
            JOIN git_pack_meta pack
              ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
             AND pack.state = 'complete'
           WHERE packed.repo_id = ?
             AND packed.oid = json_extract(j.value, '$.o')
        )
       ON CONFLICT(repo_id, oid) DO NOTHING
       RETURNING oid`,
      context.repoId,
      meta,
      context.repoId,
    )) {
      if (typeof row.oid !== "string") {
        throw new CorruptError("object metadata insert returned an invalid oid");
      }
      const object = byOid.get(row.oid);
      if (object === undefined) {
        throw new CorruptError("object metadata insert returned an unknown oid");
      }
      fresh.push(object);
    }
    if (fresh.length === 0) {
      requireCommitCacheWrites(insertCommitCaches(context.db, commitEntries), commitEntries.length);
      return;
    }
    wroteLoose = true;

    const payloads: ChunkPayload[] = [{ parts: [], length: 0, rows: [] }];
    for (const object of fresh) {
      const storedData = object.storedData;
      for (
        let seq = 0, offset = 0;
        offset < storedData.length || seq === 0;
        seq++, offset += OBJECT_CHUNK
      ) {
        const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
        let current = payloads[payloads.length - 1]!;
        if (current.length > 0 && current.length + part.length > payloadBytes) {
          current = { parts: [], length: 0, rows: [] };
          payloads.push(current);
        }
        // `a` is a 1-based byte offset: substr() counts bytes over a BLOB.
        current.rows.push({ o: object.oid, q: seq, a: current.length + 1, n: part.length });
        current.parts.push(part);
        current.length += part.length;
      }
    }

    const oids = JSON.stringify(fresh.map((object) => object.oid));
    context.db.run(
      `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
       SELECT ?, value, ? FROM json_each(?)`,
      context.repoId,
      nowMilliseconds(context),
      oids,
    );
    // The transaction keeps metadata invisible until all chunks and parsed
    // tree rows are ready, while RETURNING replaces a separate probe.
    context.db.run(
      "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
      context.repoId,
      oids,
    );
    for (const payload of payloads) {
      context.db.run(
        `INSERT INTO git_object_chunks (repo_id, oid, seq, data)
         SELECT ?, json_extract(j.value, '$.o'), json_extract(j.value, '$.q'),
                CASE WHEN json_extract(j.value, '$.n') = 0 THEN zeroblob(0)
                     ELSE substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.n'))
                 END
           FROM json_each(?) j
          WHERE true
         ON CONFLICT(repo_id, oid, seq) DO UPDATE SET data = excluded.data`,
        context.repoId,
        blob(concat(payload.parts)),
        JSON.stringify(payload.rows),
      );
    }
    indexSeededTreeSources(
      context.db,
      fresh.flatMap((object) => {
        if (object.type !== "tree" || object.treeData === undefined) return [];
        return [
          {
            repoId: context.repoId,
            treeOid: object.oid,
            storage: "loose",
            sourceId: 0,
            objectSize: object.size,
            chunks: [object.treeData],
          },
        ];
      }),
    );
    requireCommitCacheWrites(insertCommitCaches(context.db, commitEntries), commitEntries.length);
  });
  if (wroteLoose) context.cacheKeys.markLoose();
}
