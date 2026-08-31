import { blob, type SqlDatabase } from "../../db/db.js";
import { concat, isOid, toHex } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { expectSafeInteger, expectText } from "../common/rows.js";
import { BLOB_ID_CACHE_ELIGIBILITY_BYTES, BLOB_ID_GENERATION_EXHAUSTED } from "./blob-id-cache.js";
import type { BlobIdMapping } from "./contracts.js";

/** Opaque content ids encoded into one SQL BLOB parameter per statement. */
export const CONTENT_ID_PAYLOAD = 1024 * 1024;
export const CONTENT_ID_PAGE = 4096;

export interface ContentIdPage {
  payload: Uint8Array;
  rows: { a: number; n: number }[];
}

export interface ExpectedContentIdPage {
  payload: Uint8Array;
  rows: { i: number; a: number; n: number; o: string }[];
}

export interface ExpectedBlobIdMapping extends BlobIdMapping {
  ordinal: number;
}

export interface BlobIdWriteRow {
  a: number;
  n: number;
  o: string;
}

/** Stable, collision-free key for an opaque binary content id. */
export function contentIdKey(contentId: Uint8Array): string {
  return toHex(contentId);
}

export function* contentIdPages(contentIds: Iterable<Uint8Array>): Generator<ContentIdPage> {
  const unique = new Map<string, Uint8Array>();
  for (const contentId of contentIds) {
    if (contentId.length > BLOB_ID_CACHE_ELIGIBILITY_BYTES) continue;
    const snapshot = contentId.slice();
    const key = contentIdKey(snapshot);
    unique.set(key, snapshot);
  }
  let parts: Uint8Array[] = [];
  let rows: { a: number; n: number }[] = [];
  let length = 0;
  for (const contentId of unique.values()) {
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      yield { payload: concat(parts), rows };
      parts = [];
      rows = [];
      length = 0;
    }
    rows.push({ a: length + 1, n: contentId.length });
    parts.push(contentId);
    length += contentId.length;
  }
  if (rows.length > 0) yield { payload: concat(parts), rows };
}

export function writeBlobIdPage(
  db: SqlDatabase,
  repoId: number,
  payload: Uint8Array,
  rows: readonly BlobIdWriteRow[],
  begin: boolean,
  finish: boolean,
): void {
  try {
    db.run(
      `WITH input(repo_id, payload, batch) AS MATERIALIZED (VALUES (?, ?, ?))
       INSERT INTO git_blob_id_updates (repo_id, content_id, oid, operation, ordinal)
       SELECT repo_id, content_id, oid, operation, ordinal
         FROM (
           SELECT CAST(repo_id AS INTEGER) AS repo_id, zeroblob(0) AS content_id, '' AS oid,
                  'begin' AS operation, -1 AS ordinal
             FROM input WHERE json_extract(batch, '$.b') = 1
           UNION ALL
           SELECT CAST(repo_id AS INTEGER),
                  CASE WHEN json_extract(j.value, '$.n') = 0 THEN zeroblob(0)
                       ELSE substr(payload, json_extract(j.value, '$.a'),
                                            json_extract(j.value, '$.n'))
                   END,
                  json_extract(j.value, '$.o'), 'mapping', CAST(j.key AS INTEGER)
             FROM input, json_each(input.batch, '$.r') j
           UNION ALL
           SELECT CAST(repo_id AS INTEGER), zeroblob(0), '', 'finish',
                  json_array_length(batch, '$.r')
             FROM input WHERE json_extract(batch, '$.f') = 1
         )
        ORDER BY ordinal`,
      repoId,
      blob(payload),
      JSON.stringify({ b: begin ? 1 : 0, f: finish ? 1 : 0, r: rows }),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes(BLOB_ID_GENERATION_EXHAUSTED)) {
      throw new GitError("E2BIG", BLOB_ID_GENERATION_EXHAUSTED, { cause: error });
    }
    throw error;
  }
}

/** Expected mappings in pages whose BLOB and JSON inputs stay bounded. */
export function* expectedContentIdPages(
  mappings: readonly ExpectedBlobIdMapping[],
): Generator<ExpectedContentIdPage> {
  let parts: Uint8Array[] = [];
  let rows: { i: number; a: number; n: number; o: string }[] = [];
  let length = 0;
  for (const mapping of mappings) {
    if (mapping === undefined) continue;
    if (
      rows.length > 0 &&
      (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      yield { payload: concat(parts), rows };
      parts = [];
      rows = [];
      length = 0;
    }
    rows.push({
      i: mapping.ordinal,
      a: length + 1,
      n: mapping.contentId.length,
      o: mapping.oid,
    });
    parts.push(mapping.contentId);
    length += mapping.contentId.length;
  }
  if (rows.length > 0) yield { payload: concat(parts), rows };
}

export class InitialBlobIdBuffer {
  #payload: Uint8Array | null = null;
  #rows: BlobIdWriteRow[] = [];
  #length = 0;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  willCache(mapping: BlobIdMapping): boolean {
    return mapping.contentId.length <= BLOB_ID_CACHE_ELIGIBILITY_BYTES;
  }

  needsFlush(mapping: BlobIdMapping): boolean {
    if (!this.willCache(mapping)) return false;
    return (
      this.#rows.length >= CONTENT_ID_PAGE ||
      this.#length + mapping.contentId.length > CONTENT_ID_PAYLOAD
    );
  }

  validate(mapping: BlobIdMapping): void {
    if (!isOid(mapping.oid)) throw new GitError("EINVAL", `invalid blob oid ${mapping.oid}`);
  }

  add(mapping: BlobIdMapping): void {
    this.validate(mapping);
    if (!this.willCache(mapping)) return;
    if (
      this.#rows.length > 0 &&
      (this.#rows.length >= CONTENT_ID_PAGE ||
        this.#length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
    ) {
      this.flush();
    }
    if (this.#payload === null) this.#payload = new Uint8Array(CONTENT_ID_PAYLOAD);
    const payload = this.#payload;
    payload.set(mapping.contentId, this.#length);
    this.#rows.push({ a: this.#length + 1, n: mapping.contentId.length, o: mapping.oid });
    this.#length += mapping.contentId.length;
  }

  flush(): void {
    if (this.#rows.length === 0) return;
    const payload = this.#payload;
    if (payload === null) throw new Error("initial blob id buffer is disposed");
    writeBlobIdPage(this.db, this.repoId, payload, this.#rows, true, true);
    this.#rows = [];
    this.#length = 0;
  }

  finish(): void {
    this.flush();
  }

  dispose(): void {
    this.#payload = null;
    this.#rows = [];
    this.#length = 0;
  }
}

export class BlobIdTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookup(contentIds: Iterable<Uint8Array>): Map<string, string> {
    const found = new Map<string, string>();
    for (const page of contentIdPages(contentIds)) {
      for (const row of this.db.iterate(
        `WITH ids(content_id) AS MATERIALIZED (
             SELECT CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                         ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                     END
               FROM json_each(?)
           )
           SELECT lower(hex(ids.content_id)) AS content_key, b.oid
             FROM ids
             JOIN git_blob_ids b ON b.repo_id = ? AND b.content_id = ids.content_id`,
        blob(page.payload),
        JSON.stringify(page.rows),
        this.repoId,
      )) {
        const contentKey = expectText(row.content_key, "blob content key");
        const oid = expectText(row.oid, "stored blob object id");
        found.set(contentKey, oid);
      }
    }
    return found;
  }

  /** Return the ordinals of expected mappings that are absent or disagree. */
  mismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    const retained: ExpectedBlobIdMapping[] = [];
    const mismatches = new Map<number, string | null>();
    let capturedCount = 0;
    for (const mapping of expected) {
      if (!isOid(mapping.oid)) throw new GitError("EINVAL", `invalid blob oid ${mapping.oid}`);
      const cacheable = mapping.contentId.length <= BLOB_ID_CACHE_ELIGIBILITY_BYTES;
      if (cacheable) {
        retained.push({
          ordinal: capturedCount,
          contentId: mapping.contentId.slice(),
          oid: mapping.oid,
        });
      } else {
        mismatches.set(capturedCount, null);
      }
      capturedCount++;
    }

    for (const page of expectedContentIdPages(retained)) {
      for (const row of this.db.iterate(
        `WITH expected(ordinal, content_id, expected_oid) AS MATERIALIZED (
             SELECT json_extract(value, '$.i'),
                    CASE WHEN json_extract(value, '$.n') = 0 THEN zeroblob(0)
                         ELSE substr(?, json_extract(value, '$.a'), json_extract(value, '$.n'))
                     END,
                    json_extract(value, '$.o')
               FROM json_each(?)
           )
           SELECT expected.ordinal, b.oid
             FROM expected
             LEFT JOIN git_blob_ids b
               ON b.repo_id = ? AND b.content_id = expected.content_id
            WHERE b.oid IS NULL OR b.oid <> expected.expected_oid`,
        blob(page.payload),
        JSON.stringify(page.rows),
        this.repoId,
      )) {
        const returnedOrdinal = expectSafeInteger(row.ordinal, 0, capturedCount - 1);
        const oid = row.oid === null ? null : expectText(row.oid, "stored blob object id");
        mismatches.set(returnedOrdinal, oid);
      }
    }
    return mismatches;
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsert(mappings: Iterable<BlobIdMapping>): void {
    const unique = new Map<string, BlobIdMapping>();
    for (const mapping of mappings) {
      if (!isOid(mapping.oid)) throw new GitError("EINVAL", `invalid blob oid ${mapping.oid}`);
      if (mapping.contentId.length > BLOB_ID_CACHE_ELIGIBILITY_BYTES) continue;
      const snapshot: BlobIdMapping = {
        contentId: mapping.contentId.slice(),
        oid: mapping.oid,
      };
      const key = contentIdKey(snapshot.contentId);
      unique.set(key, snapshot);
    }
    if (unique.size === 0) return;
    this.db.transactionSync(() => {
      let parts: Uint8Array[] = [];
      let rows: { a: number; n: number; o: string }[] = [];
      let length = 0;
      const flush = (): void => {
        if (rows.length === 0) return;
        writeBlobIdPage(this.db, this.repoId, concat(parts), rows, true, true);
        parts = [];
        rows = [];
        length = 0;
      };
      for (const mapping of unique.values()) {
        if (
          rows.length > 0 &&
          (rows.length >= CONTENT_ID_PAGE || length + mapping.contentId.length > CONTENT_ID_PAYLOAD)
        ) {
          flush();
        }
        rows.push({ a: length + 1, n: mapping.contentId.length, o: mapping.oid });
        parts.push(mapping.contentId);
        length += mapping.contentId.length;
      }
      flush();
    });
  }
}
