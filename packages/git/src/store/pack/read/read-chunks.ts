// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — packs stored as fixed-size chunk rows follow dgit's src/git/packstore.ts.

import { readBlob, type SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../../common/errors.js";
import { int, RowShape } from "../../../common/rows.js";
import { PACK_CHUNK } from "../shared.js";

const INVALID_CHUNK = "pack chunk query returned invalid coordinates";

const CHUNK_COORDINATES_ROW = new RowShape(
  {
    pack_id: int(0, Number.MAX_SAFE_INTEGER, INVALID_CHUNK),
    seq: int(0, Number.MAX_SAFE_INTEGER, INVALID_CHUNK),
  },
  INVALID_CHUNK,
);

export interface PackChunkCoordinate {
  packId: number;
  seq: number;
}

export interface PackChunkSlice extends PackChunkCoordinate {
  start: number;
  end: number;
}

/** Sparse object reads must not allocate a whole physical row for a few compressed bytes. */
export function loadPackSlices(
  db: SqlDatabase,
  repoId: number,
  slices: readonly PackChunkSlice[],
  visit: (packId: number, seq: number, start: number, data: Uint8Array) => void,
): void {
  if (slices.length === 0) return;
  const requested = new Map(slices.map((slice) => [`${slice.packId}:${slice.seq}`, slice]));
  for (const row of db.iterate(
    `WITH requested(pack_id, seq, start, end) AS (
       SELECT json_extract(value, '$.packId'), json_extract(value, '$.seq'),
              json_extract(value, '$.start'), json_extract(value, '$.end') FROM json_each(?)
     )
     SELECT d.pack_id, d.seq, substr(d.data, r.start + 1, r.end - r.start) AS data
       FROM requested r JOIN git_pack_data d
         ON d.repo_id = ? AND d.pack_id = r.pack_id AND d.seq = r.seq
      WHERE length(d.data) <= ${PACK_CHUNK}
      ORDER BY d.pack_id, d.seq`,
    JSON.stringify(slices),
    repoId,
  )) {
    const { pack_id: packId, seq } = CHUNK_COORDINATES_ROW.decode(row);
    const key = `${packId}:${seq}`;
    const slice = requested.get(key);
    const data = readBlob(row.data);
    if (slice === undefined || data.length !== slice.end - slice.start) {
      throw new CorruptError(`pack ${packId}: chunk ${seq} is truncated`);
    }
    visit(packId, seq, slice.start, data);
    requested.delete(key);
  }
  for (const slice of requested.values()) {
    throw new CorruptError(`pack ${slice.packId}: missing chunk ${slice.seq}`);
  }
}

const CHUNK_SQL = `WITH requested(pack_id, seq) AS (
           SELECT json_extract(value, '$.p'), json_extract(value, '$.q') FROM json_each(?)
         )
         SELECT d.pack_id, d.seq, d.data
           FROM requested r
           JOIN git_pack_data d
             ON d.repo_id = ? AND d.pack_id = r.pack_id AND d.seq = r.seq
          WHERE length(d.data) <= ${PACK_CHUNK}
          ORDER BY d.pack_id, d.seq`;

/**
 * Loads distinct physical `git_pack_data` rows in one statement and hands each
 * to `visit` as the cursor yields it, so only one row is live at a time. A row
 * that is absent or larger than `PACK_CHUNK` is a missing chunk.
 */
export function loadPackChunks(
  db: SqlDatabase,
  repoId: number,
  chunks: readonly PackChunkCoordinate[],
  visit: (packId: number, seq: number, data: Uint8Array) => void,
): void {
  if (chunks.length === 0) return;
  const requested = chunks
    .map((chunk) => ({ p: chunk.packId, q: chunk.seq }))
    .sort((left, right) => left.p - right.p || left.q - right.q);
  const returned = new Set<string>();
  for (const row of db.iterate(CHUNK_SQL, JSON.stringify(requested), repoId)) {
    const { pack_id: packId, seq } = CHUNK_COORDINATES_ROW.decode(row);
    returned.add(`${packId}:${seq}`);
    visit(packId, seq, readBlob(row.data));
  }
  for (const chunk of requested) {
    if (!returned.has(`${chunk.p}:${chunk.q}`)) {
      throw new CorruptError(`pack ${chunk.p}: missing chunk ${chunk.q}`);
    }
  }
}
