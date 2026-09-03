import pako from "pako";
import { blob } from "../../../db/db.js";
import { toHex } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { hashObject, type ObjectType, objectHeader } from "../../common/objects.js";
import { Sha1 } from "../../common/sha1.js";
import { insertCommitCaches, prepareCommitCache } from "../trees/commits.js";
import { indexSeededTreeSource } from "../trees/tree-index.js";
import { hasObject } from "./objects-query.js";
import {
  encodeLoose,
  looseEncoding,
  nowMilliseconds,
  OBJECT_CHUNK,
  type ObjectWriteContext,
  requireCommitCacheWrites,
  requireStorableObjectSize,
  STREAM_CHUNK,
} from "./objects-shared.js";

export function writeObject(
  context: ObjectWriteContext,
  type: ObjectType,
  data: Uint8Array,
): string {
  requireStorableObjectSize(type, data.length);
  const oid = hashObject(type, data);
  const commitEntry =
    type === "commit" ? prepareCommitCache({ repoId: context.repoId, oid, data }) : undefined;
  if (hasObject(context, oid)) {
    if (commitEntry !== undefined) {
      requireCommitCacheWrites(insertCommitCaches(context.db, [commitEntry]), 1);
    }
    return oid;
  }
  const stored = looseEncoding(data.length);
  const storedData = encodeLoose(data, stored);
  const createdMs = nowMilliseconds(context);
  context.db.transactionSync(() => {
    context.db.run(
      "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, ?)",
      context.repoId,
      oid,
      type,
      data.length,
      stored,
    );
    context.db.run(
      `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
       VALUES (?, ?, ?)`,
      context.repoId,
      oid,
      createdMs,
    );
    context.db.run(
      "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
      context.repoId,
      oid,
    );
    for (
      let seq = 0, offset = 0;
      offset < storedData.length || seq === 0;
      seq++, offset += OBJECT_CHUNK
    ) {
      const part = storedData.subarray(offset, offset + OBJECT_CHUNK);
      if (part.length === 0) {
        context.db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, zeroblob(0))",
          context.repoId,
          oid,
          seq,
        );
      } else {
        context.db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          context.repoId,
          oid,
          seq,
          blob(part),
        );
      }
    }
    if (type === "tree") {
      indexSeededTreeSource(
        context.db,
        {
          repoId: context.repoId,
          treeOid: oid,
          storage: "loose",
          sourceId: 0,
          objectSize: data.length,
        },
        [data],
      );
    }
    if (commitEntry !== undefined) {
      requireCommitCacheWrites(insertCommitCaches(context.db, [commitEntry]), 1);
    }
  });
  context.cacheKeys.markLoose();
  context.objects.set(context.cacheKeys.objectCacheKey(oid), { type, data });
  return oid;
}

export function writeObjectStream(
  context: ObjectWriteContext,
  type: ObjectType,
  size: number,
  chunks: () => Iterable<Uint8Array>,
): string {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new GitError("EINVAL", "streamed object size must be a safe nonnegative integer");
  }
  requireStorableObjectSize(type, size);
  const hash = new Sha1().update(objectHeader(type, size));
  const commitData = type === "commit" ? new Uint8Array(size) : undefined;
  let hashed = 0;
  for (const chunk of chunks()) {
    if (hashed + chunk.length <= size) commitData?.set(chunk, hashed);
    hashed += chunk.length;
    hash.update(chunk);
  }
  if (hashed !== size) {
    throw new CorruptError(`streamed ${hashed} bytes for a ${type} declared as ${size}`);
  }
  const oid = toHex(hash.digest());
  const commitEntry =
    commitData === undefined
      ? undefined
      : prepareCommitCache({ repoId: context.repoId, oid, data: commitData });
  if (hasObject(context, oid)) {
    if (commitEntry !== undefined) {
      requireCommitCacheWrites(insertCommitCaches(context.db, [commitEntry]), 1);
    }
    return oid;
  }

  const stored = looseEncoding(size);
  if (stored === "raw") {
    const data = commitData ?? new Uint8Array(size);
    const storageHash = new Sha1().update(objectHeader(type, size));
    let offset = 0;
    for (const chunk of chunks()) {
      if (offset + chunk.length > size) {
        throw new CorruptError(`stream changed after hashing ${oid}`);
      }
      data.set(chunk, offset);
      storageHash.update(chunk);
      offset += chunk.length;
    }
    if (offset !== size) throw new CorruptError(`stream changed after hashing ${oid}`);
    if (toHex(storageHash.digest()) !== oid) {
      throw new CorruptError(`stream changed after hashing ${oid}`);
    }
    const createdMs = nowMilliseconds(context);
    context.db.transactionSync(() => {
      context.db.run(
        "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'raw')",
        context.repoId,
        oid,
        type,
        size,
      );
      context.db.run(
        `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
         VALUES (?, ?, ?)`,
        context.repoId,
        oid,
        createdMs,
      );
      context.db.run(
        "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
        context.repoId,
        oid,
      );
      if (data.length === 0) {
        context.db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, zeroblob(0))",
          context.repoId,
          oid,
        );
      } else {
        context.db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
          context.repoId,
          oid,
          blob(data),
        );
      }
      if (type === "tree") {
        indexSeededTreeSource(
          context.db,
          {
            repoId: context.repoId,
            treeOid: oid,
            storage: "loose",
            sourceId: 0,
            objectSize: size,
          },
          [data],
        );
      }
      if (commitEntry !== undefined) {
        requireCommitCacheWrites(insertCommitCaches(context.db, [commitEntry]), 1);
      }
    });
    context.cacheKeys.markLoose();
    return oid;
  }

  const rows: Uint8Array[] = [];
  const deflate = new pako.Deflate({ chunkSize: STREAM_CHUNK });
  deflate.onData = (chunk) => {
    if (!(chunk instanceof Uint8Array))
      throw new CorruptError("deflate produced a non-binary chunk");
    rows.push(chunk);
  };

  const createdMs = nowMilliseconds(context);
  context.db.transactionSync(() => {
    context.db.run(
      "INSERT OR REPLACE INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, ?, ?, 'zlib')",
      context.repoId,
      oid,
      type,
      size,
    );
    context.db.run(
      `INSERT INTO git_loose_object_lifecycle (repo_id, oid, created_ms)
       VALUES (?, ?, ?)`,
      context.repoId,
      oid,
      createdMs,
    );
    context.db.run(
      "DELETE FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
      context.repoId,
      oid,
    );
    let seq = 0;
    const drain = (): void => {
      for (const row of rows) {
        context.db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          context.repoId,
          oid,
          seq++,
          blob(row),
        );
      }
      rows.length = 0;
    };
    const storageChunks = function* (): Generator<Uint8Array> {
      const storageHash = new Sha1().update(objectHeader(type, size));
      let streamed = 0;
      for (const chunk of chunks()) {
        const offset = streamed;
        streamed += chunk.length;
        if (streamed > size) throw new CorruptError(`stream changed after hashing ${oid}`);
        commitData?.set(chunk, offset);
        storageHash.update(chunk);
        deflate.push(chunk, false);
        if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
        drain();
        yield chunk;
      }
      deflate.push(new Uint8Array(0), true);
      if (deflate.err !== 0) throw new CorruptError(`deflate failed: ${deflate.msg}`);
      drain();
      if (streamed !== size || toHex(storageHash.digest()) !== oid) {
        throw new CorruptError(`stream changed after hashing ${oid}`);
      }
    };
    const storage = storageChunks();
    if (type === "tree") {
      indexSeededTreeSource(
        context.db,
        {
          repoId: context.repoId,
          treeOid: oid,
          storage: "loose",
          sourceId: 0,
          objectSize: size,
        },
        storage,
      );
    } else {
      for (const _chunk of storage) {
        // Storage and hashing advance together without retaining the object.
      }
    }
    // An empty object still deserves one row, matching `write`.
    if (seq === 0) {
      context.db.run(
        "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
        context.repoId,
        oid,
        0,
        blob(new Uint8Array(0)),
      );
    }
    if (commitEntry !== undefined) {
      requireCommitCacheWrites(insertCommitCaches(context.db, [commitEntry]), 1);
    }
  });
  context.cacheKeys.markLoose();
  return oid;
}
