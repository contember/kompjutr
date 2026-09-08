import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import { int, nullable, oneOf, RowShape, text } from "../../../common/rows.js";
import { comparePaths } from "../../../common/streams.js";
import { REFLOG_RETENTION_SECONDS } from "../../refs/reflog.js";
import type { RootCandidate, RootPage } from "./root-contracts.js";

const REF_ROOT_ROW = new RowShape({
  repo_id: int(1),
  name: text(),
  target: text(),
});
const HEAD_ROOT_ROW = new RowShape({
  checkout_id: int(1),
  repo_id: int(1),
  head: text(),
});
const REFLOG_ROOT_ROW = new RowShape({
  source_kind: oneOf([0, 1]),
  repo_id: int(1),
  ref_key: text(),
  checkout_id: nullable(int(1)),
  ordinal: int(1),
  old_oid: nullable(text()),
  new_oid: nullable(text()),
  timestamp: int(0),
});

export function rootsFromRefs(
  db: SqlDatabase,
  repoId: number,
  cursor: string | null,
  pageRows: number,
): RootPage {
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let last = cursor;
  let hasMore = false;
  for (const raw of db.iterate(
    `SELECT repo_id, name, target
       FROM git_refs
      WHERE repo_id = ? AND (? IS NULL OR name > ? COLLATE BINARY)
      ORDER BY name COLLATE BINARY LIMIT ?`,
    repoId,
    cursor,
    cursor,
    pageRows + 1,
  )) {
    const row = REF_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("ref root crossed repositories");
    if (last !== null && comparePaths(last, row.name) >= 0) {
      throw new CorruptError("ref roots are not in strict byte order");
    }
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (isOid(row.target)) {
      candidates.push({ oid: row.target, expectedType: null, optionalMissing: false });
    }
    last = row.name;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: null,
    cursorText: last,
    cursorOrdinal: null,
    hasMore,
  };
}

export function rootsFromHeads(
  db: SqlDatabase,
  repoId: number,
  cursor: number | null,
  pageRows: number,
): RootPage {
  const after = cursor ?? 0;
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let last = after;
  let hasMore = false;
  for (const raw of db.iterate(
    `SELECT id AS checkout_id, repo_id, head
       FROM git_checkouts
      WHERE repo_id = ? AND id > ? ORDER BY id LIMIT ?`,
    repoId,
    after,
    pageRows + 1,
  )) {
    const row = HEAD_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("checkout HEAD crossed repositories");
    if (row.checkout_id <= last) throw new CorruptError("checkout HEAD roots are unordered");
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (isOid(row.head)) {
      candidates.push({ oid: row.head, expectedType: null, optionalMissing: false });
    }
    last = row.checkout_id;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: rows === 0 ? cursor : last,
    cursorText: null,
    cursorOrdinal: null,
    hasMore,
  };
}

export function rootsFromReflogs(
  db: SqlDatabase,
  repoId: number,
  startedMs: number,
  cursor: number | null,
  pageRows: number,
): RootPage {
  const cutoff = Math.max(0, Math.floor(startedMs / 1_000) - REFLOG_RETENTION_SECONDS);
  const after = cursor ?? 0;
  const candidates: RootCandidate[] = [];
  let rows = 0;
  let last = after;
  let hasMore = false;
  for (const raw of db.iterate(
    `WITH direct_page AS MATERIALIZED (
       SELECT 0 AS source_kind, entry.repo_id, entry.ref_name AS ref_key,
              NULL AS checkout_id, entry.ordinal, entry.old_oid, entry.new_oid,
              entry.timestamp
         FROM git_reflog_entries entry NOT INDEXED
        WHERE entry.repo_id = ? AND entry.ordinal > ?
        ORDER BY entry.ordinal LIMIT ?
     ), checkout_page AS MATERIALIZED (
       SELECT 1 AS source_kind, entry.repo_id, 'HEAD' AS ref_key,
              entry.checkout_id, entry.ordinal, entry.old_oid, entry.new_oid,
              entry.timestamp
         FROM git_checkout_reflog_entries entry
              INDEXED BY git_checkout_reflog_entries_by_ordinal
        WHERE entry.repo_id = ? AND entry.ordinal > ?
        ORDER BY entry.ordinal LIMIT ?
     )
     SELECT source_kind, repo_id, ref_key, checkout_id, ordinal, old_oid, new_oid, timestamp
       FROM (
         SELECT source_kind, repo_id, ref_key, checkout_id, ordinal, old_oid, new_oid, timestamp
           FROM direct_page
         UNION ALL
         SELECT source_kind, repo_id, ref_key, checkout_id, ordinal, old_oid, new_oid, timestamp
           FROM checkout_page
       )
      ORDER BY ordinal LIMIT ?`,
    repoId,
    after,
    pageRows + 1,
    repoId,
    after,
    pageRows + 1,
    pageRows + 1,
  )) {
    const row = REFLOG_ROOT_ROW.decode(raw);
    if (row.repo_id !== repoId) throw new CorruptError("reflog root crossed repositories");
    if (row.ordinal <= last) throw new CorruptError("retained reflog roots are unordered");
    if (row.source_kind === 0) {
      if (row.checkout_id !== null) {
        throw new CorruptError("direct reflog root retained a checkout id");
      }
    } else {
      if (row.ref_key !== "HEAD") throw new CorruptError("checkout reflog root is not HEAD");
      if (row.checkout_id === null) {
        throw new CorruptError("checkout reflog root is missing its checkout id");
      }
    }
    if (rows === pageRows) {
      hasMore = true;
      break;
    }
    if (row.timestamp >= cutoff) {
      if (row.old_oid !== null) {
        candidates.push({ oid: row.old_oid, expectedType: null, optionalMissing: false });
      }
      if (row.new_oid !== null) {
        candidates.push({ oid: row.new_oid, expectedType: null, optionalMissing: false });
      }
    }
    last = row.ordinal;
    rows++;
  }
  return {
    candidates,
    cursorCheckoutId: null,
    cursorText: null,
    cursorOrdinal: rows === 0 ? cursor : last,
    hasMore,
  };
}
