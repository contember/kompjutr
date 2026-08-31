import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError } from "../common/errors.js";
import { expectSafeInteger, expectText, int, nullable, RowShape, text } from "../common/rows.js";
import type { RefLogActor, RefLogEntry, RefLogMetadata, RefLogReadOptions } from "./contracts.js";
import { requireSafeId } from "./lifecycle.js";
import { refTextBytes, requireRefName } from "./ref-validation.js";
import { MAX_REFLOG_ORDINAL, MAX_REFLOG_TIMEZONE_MINUTES } from "./reflog-schema.js";

export const REFLOG_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const REFLOG_RETENTION_ROWS = 1_024;
export const MAX_REFLOG_ROOT_SCAN_ENTRIES = 9_727;

export type Clock = () => number;

export interface RefLogEvent {
  refName: string;
  ordinal: number;
  oldRaw: string | null;
  newRaw: string | null;
  oldOid: string | null;
  newOid: string | null;
  actorName: string | null;
  actorEmail: string | null;
  timestamp: number;
  timezoneOffset: number;
  reason: string;
}

export interface CheckoutRefLogEvent extends RefLogEvent {
  checkoutId: number;
}

const REFLOG_ENTRY_ROW = new RowShape({
  ref_name: text(),
  ordinal: int(1, MAX_REFLOG_ORDINAL),
  old_raw: nullable(text()),
  new_raw: nullable(text()),
  old_oid: nullable(text()),
  new_oid: nullable(text()),
  actor_name: nullable(text()),
  actor_email: nullable(text()),
  timestamp: int(0, MAX_REFLOG_ORDINAL),
  timezone: int(-MAX_REFLOG_TIMEZONE_MINUTES, MAX_REFLOG_TIMEZONE_MINUTES),
  reason: text(),
});

export function requireSafeRefLogInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  return expectSafeInteger(value, minimum, maximum, label);
}

export function requireStoredRefLogEntry(row: unknown): RefLogEntry {
  const stored = REFLOG_ENTRY_ROW.decode(row);
  const actor: RefLogActor | null =
    stored.actor_name === null
      ? null
      : {
          name: stored.actor_name,
          email: expectText(stored.actor_email, "reflog actor email"),
        };
  return {
    refName: stored.ref_name,
    ordinal: stored.ordinal,
    oldRaw: stored.old_raw,
    newRaw: stored.new_raw,
    oldOid: stored.old_oid,
    newOid: stored.new_oid,
    actor,
    timestamp: stored.timestamp,
    timezoneOffset: stored.timezone,
    reason: stored.reason,
  };
}

export function requireRefLogReadInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new GitError("EINVAL", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function requireRefLogLimit(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 1_000) {
    throw new GitError("E2BIG", "reflog limit exceeds 1,000 entries");
  }
  return requireRefLogReadInteger(value, "reflog limit", 0, 1_000);
}

export function requireRefLogHeader(row: Record<string, unknown>, repoId: number): number {
  const stored = new RowShape({
    repo_id: int(1),
    head: text(),
    next_ordinal: int(0, MAX_REFLOG_ORDINAL),
    latest_ordinal: nullable(int(1, MAX_REFLOG_ORDINAL)),
  }).decode(row);
  if (stored.repo_id !== repoId) {
    throw new CorruptError("reflog header belongs to another repository");
  }
  const nextOrdinal = stored.next_ordinal;
  const latest = stored.latest_ordinal;
  if ((nextOrdinal === 0 && latest !== null) || (latest ?? 0) > nextOrdinal) {
    throw new CorruptError("reflog state precedes its newest entry");
  }
  return nextOrdinal;
}

export function validateRefLogMetadata(metadata: RefLogMetadata): RefLogMetadata {
  if (
    !Number.isSafeInteger(metadata.timestamp) ||
    metadata.timestamp < 0 ||
    metadata.timestamp > MAX_REFLOG_ORDINAL
  ) {
    throw new GitError("EINVAL", "reflog timestamp must be a safe nonnegative epoch second");
  }
  if (
    !Number.isSafeInteger(metadata.timezoneOffset) ||
    metadata.timezoneOffset < -MAX_REFLOG_TIMEZONE_MINUTES ||
    metadata.timezoneOffset > MAX_REFLOG_TIMEZONE_MINUTES
  ) {
    throw new GitError("EINVAL", "reflog timezone offset is outside its bounded range");
  }
  if (typeof metadata.reason !== "string" || metadata.reason === "") {
    throw new GitError("EINVAL", "reflog reason is required");
  }
  refTextBytes(metadata.reason, "reflog reason", "input");
  if (metadata.actor !== null) {
    if (metadata.actor.name === "" || metadata.actor.email === "") {
      throw new GitError("EINVAL", "reflog actor name and email are required together");
    }
    refTextBytes(metadata.actor.name, "reflog actor name", "input");
    refTextBytes(metadata.actor.email, "reflog actor email", "input");
    if (
      metadata.actor.name.includes("<") ||
      metadata.actor.name.includes(">") ||
      metadata.actor.email.includes("<") ||
      metadata.actor.email.includes(">")
    ) {
      throw new GitError("EINVAL", "reflog actor identity contains an invalid character");
    }
  }
  return metadata;
}

function nowSeconds(clock: Clock): number {
  const nowMilliseconds = clock();
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    throw new GitError("EINVAL", "Git store clock must return non-negative integer milliseconds");
  }
  const now = Math.floor(nowMilliseconds / 1_000);
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_REFLOG_ORDINAL) {
    throw new GitError("EINVAL", "reflog clock must return a safe nonnegative epoch time");
  }
  return now;
}

/** Active stored entries for one exact ref, newest first. */
export function readRefLog(
  db: SqlDatabase,
  repoId: number,
  checkoutId: number,
  clock: Clock,
  refName: string,
  options: RefLogReadOptions = {},
): RefLogEntry[] {
  const name = requireRefName(refName, "reflog ref name", "input", true);
  const now = nowSeconds(clock);
  const limit =
    options.limit === undefined ? REFLOG_RETENTION_ROWS : requireRefLogLimit(options.limit);
  const before =
    options.before === undefined
      ? undefined
      : requireRefLogReadInteger(options.before, "reflog cursor", 1, MAX_REFLOG_ORDINAL);
  const cutoff = Math.max(0, now - REFLOG_RETENTION_SECONDS);
  const active: RefLogEntry[] = [];
  let headerSeen = false;
  let nextOrdinal = 0;
  let entryCount = 0;
  const headerSql = `SELECT 0 AS kind, repository.id AS repo_id, checkout.head,
              state.next_ordinal,
              (SELECT max(ordinal) FROM (
                 SELECT direct.ordinal FROM git_reflog_entries direct
                  WHERE direct.repo_id = repository.id
                 UNION ALL
                 SELECT local.ordinal FROM git_checkout_reflog_entries local
                  WHERE local.repo_id = repository.id
               )) AS latest_ordinal,
              NULL AS ref_name, NULL AS ordinal, NULL AS old_raw, NULL AS new_raw,
              NULL AS old_oid, NULL AS new_oid, NULL AS actor_name, NULL AS actor_email,
              NULL AS timestamp, NULL AS timezone, NULL AS reason
         FROM git_repositories repository
         JOIN git_reflog_state state ON state.repo_id = repository.id
         JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? AND checkout.id = ?`;
  const rows =
    name === "HEAD"
      ? db.iterate(
          `${headerSql}
             UNION ALL
             SELECT 1 AS kind, NULL AS repo_id, NULL AS head, NULL AS next_ordinal,
                    NULL AS latest_ordinal, 'HEAD' AS ref_name, entry.ordinal,
                    entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                    entry.actor_name, entry.actor_email, entry.timestamp, entry.timezone,
                    entry.reason
               FROM git_checkout_reflog_entries entry
              WHERE entry.repo_id = ? AND entry.checkout_id = ?
              ORDER BY kind, ordinal DESC
              LIMIT ${REFLOG_RETENTION_ROWS + 2}`,
          repoId,
          checkoutId,
          repoId,
          checkoutId,
        )
      : db.iterate(
          `${headerSql}
             UNION ALL
             SELECT 1 AS kind, NULL AS repo_id, NULL AS head, NULL AS next_ordinal,
                    NULL AS latest_ordinal, entry.ref_name, entry.ordinal,
                    entry.old_raw, entry.new_raw, entry.old_oid, entry.new_oid,
                    entry.actor_name, entry.actor_email, entry.timestamp, entry.timezone,
                    entry.reason
               FROM git_reflog_entries entry INDEXED BY git_reflog_entries_by_ref
              WHERE entry.repo_id = ? AND entry.ref_name = ?
              ORDER BY kind, ordinal DESC
              LIMIT ${REFLOG_RETENTION_ROWS + 2}`,
          repoId,
          checkoutId,
          repoId,
          name,
        );
  for (const row of rows) {
    if (row.kind === 0) {
      if (headerSeen) throw new CorruptError("reflog query returned duplicate headers");
      headerSeen = true;
      nextOrdinal = requireRefLogHeader(row, repoId);
      continue;
    }
    if (row.kind !== 1 || !headerSeen) {
      throw new CorruptError("reflog query returned an invalid row sequence");
    }
    entryCount++;
    if (entryCount > REFLOG_RETENTION_ROWS) {
      throw new GitError("E2BIG", "reflog row count exceeds its retained history bound");
    }
    const entry = requireStoredRefLogEntry(row);
    if (entry.refName !== name) throw new CorruptError("reflog query returned another ref");
    if (entry.ordinal > nextOrdinal) {
      throw new CorruptError("reflog entry exceeds the repository allocation state");
    }
    if (entry.timestamp >= cutoff) active.push(entry);
  }
  if (!headerSeen) throw new CorruptError("repository is missing its reflog state");
  const page: RefLogEntry[] = [];
  for (const entry of active) {
    if (before !== undefined && entry.ordinal >= before) continue;
    if (page.length < limit) page.push(entry);
  }
  return page;
}

/** Distinct active reflog roots in strict byte order. */
export function* activeRefLogOids(
  db: SqlDatabase,
  repoId: number,
  checkoutId: number,
  clock: Clock,
): Generator<string> {
  const now = nowSeconds(clock);
  const cutoff = Math.max(0, now - REFLOG_RETENTION_SECONDS);
  const header = db.one<Record<string, unknown>>(
    `SELECT repository.id AS repo_id, checkout.head, state.next_ordinal,
              (SELECT max(ordinal) FROM (
                 SELECT direct.ordinal FROM git_reflog_entries direct
                  WHERE direct.repo_id = repository.id
                 UNION ALL
                 SELECT local.ordinal FROM git_checkout_reflog_entries local
                  WHERE local.repo_id = repository.id
               )) AS latest_ordinal
         FROM git_repositories repository
         JOIN git_reflog_state state ON state.repo_id = repository.id
         JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? AND checkout.id = ?`,
    repoId,
    checkoutId,
  );
  if (header === undefined) throw new CorruptError("repository is missing its reflog state");
  const nextOrdinal = requireRefLogHeader(header, repoId);
  let previousRef: string | null = null;
  let directEntriesForRef = 0;
  let previousCheckoutId: number | null = null;
  let checkoutEntries = 0;
  let scannedEntries = 0;
  for (const row of db.iterate(
    `WITH direct_ranked AS (
         SELECT entry.*, NULL AS checkout_id,
                row_number() OVER (
                  PARTITION BY entry.ref_name ORDER BY entry.ordinal DESC
                ) AS retained_rank
           FROM git_reflog_entries entry INDEXED BY git_reflog_entries_by_ref
          WHERE entry.repo_id = ?
       ), checkout_ranked AS (
         SELECT entry.*, 'HEAD' AS ref_name,
                row_number() OVER (
                  PARTITION BY entry.checkout_id ORDER BY entry.ordinal DESC
                ) AS retained_rank
           FROM git_checkout_reflog_entries entry
          WHERE entry.repo_id = ?
       ), retained AS (
         SELECT 0 AS kind, checkout_id, ref_name, ordinal,
                old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason
           FROM direct_ranked WHERE retained_rank <= ${REFLOG_RETENTION_ROWS}
         UNION ALL
         SELECT 1 AS kind, checkout_id, ref_name, ordinal,
                old_raw, new_raw, old_oid, new_oid, actor_name, actor_email,
                timestamp, timezone, reason
           FROM checkout_ranked WHERE retained_rank <= ${REFLOG_RETENTION_ROWS}
       ), retained_limited AS MATERIALIZED (
         SELECT * FROM retained
          ORDER BY kind, ref_name COLLATE BINARY, checkout_id, ordinal DESC
          LIMIT ${MAX_REFLOG_ROOT_SCAN_ENTRIES + 1}
       ), output AS (
         SELECT retained_limited.*, NULL AS root_oid FROM retained_limited
         UNION ALL
         SELECT 2 AS kind, NULL AS checkout_id, NULL AS ref_name, NULL AS ordinal,
                NULL AS old_raw, NULL AS new_raw,
                NULL AS old_oid, NULL AS new_oid, NULL AS actor_name, NULL AS actor_email,
                NULL AS timestamp, NULL AS timezone, NULL AS reason, endpoint.oid AS root_oid
           FROM (
             SELECT oid FROM (
               SELECT old_oid AS oid FROM retained_limited WHERE timestamp >= ?
               UNION ALL
               SELECT new_oid AS oid FROM retained_limited WHERE timestamp >= ?
             ) WHERE oid IS NOT NULL GROUP BY oid
           ) endpoint
       )
       SELECT kind, checkout_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
              actor_name, actor_email, timestamp, timezone, reason, root_oid
         FROM output
       ORDER BY kind, ref_name COLLATE BINARY, checkout_id, ordinal DESC, root_oid COLLATE BINARY`,
    repoId,
    repoId,
    cutoff,
    cutoff,
  )) {
    if (row.kind === 0) {
      scannedEntries++;
      if (scannedEntries > MAX_REFLOG_ROOT_SCAN_ENTRIES) {
        throw new GitError("E2BIG", "reflog root scan exceeds its structural row bound");
      }
      const entry = requireStoredRefLogEntry(row);
      if (entry.ordinal > nextOrdinal) {
        throw new CorruptError("reflog entry exceeds the repository allocation state");
      }
      if (previousRef === null || entry.refName !== previousRef) {
        previousRef = entry.refName;
        directEntriesForRef = 0;
      }
      directEntriesForRef++;
      if (directEntriesForRef > REFLOG_RETENTION_ROWS) {
        throw new CorruptError("reflog root query exceeded its retained row bound");
      }
      continue;
    }
    if (row.kind === 1) {
      scannedEntries++;
      if (scannedEntries > MAX_REFLOG_ROOT_SCAN_ENTRIES) {
        throw new GitError("E2BIG", "reflog root scan exceeds its structural row bound");
      }
      const ownerCheckoutId = requireSafeId(row.checkout_id, "checkout reflog owner id");
      const entry = requireStoredRefLogEntry(row);
      if (entry.refName !== "HEAD" || entry.ordinal > nextOrdinal) {
        throw new CorruptError("checkout reflog entry is invalid");
      }
      if (ownerCheckoutId !== previousCheckoutId) {
        previousCheckoutId = ownerCheckoutId;
        checkoutEntries = 0;
      }
      checkoutEntries++;
      if (checkoutEntries > REFLOG_RETENTION_ROWS) {
        throw new CorruptError("checkout reflog query exceeded its retained row bound");
      }
      continue;
    }
    if (row.kind !== 2) {
      throw new CorruptError("reflog root query returned an invalid object id");
    }
    yield expectText(row.root_oid, "reflog root object id");
  }
}
