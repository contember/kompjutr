import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { hasCanonicalRefSyntax } from "../../common/ref-name.js";
import { expectSafeInteger, expectText } from "../../common/rows.js";
import { normalizeRemoteUrl } from "../../protocol/remote.js";
import type { PromisedBlob, PromisorRemote } from "../core/contracts.js";
import { jsonPages, utf8ByteLength } from "../core/json-pages.js";

export const MAX_PROMISOR_REMOTE_NAME_BYTES = 8 * 1_024;
export const MAX_PROMISOR_URL_BYTES = 1_500_000;
export const MAX_PROMISED_BLOB_LOOKUP_OIDS = 4_096;

function requireRemoteName(remoteName: string): string {
  if (
    typeof remoteName !== "string" ||
    !hasCanonicalRefSyntax(remoteName) ||
    utf8ByteLength(remoteName) > MAX_PROMISOR_REMOTE_NAME_BYTES
  ) {
    throw new GitError("EINVAL", "promisor remote name is invalid");
  }
  return remoteName;
}

function requireRemoteUrl(url: string): string {
  if (typeof url !== "string") throw new GitError("EINVAL", "promisor remote URL is invalid");
  const normalized = normalizeRemoteUrl(url);
  if (utf8ByteLength(normalized) > MAX_PROMISOR_URL_BYTES) {
    throw new GitError("E2BIG", "promisor remote URL exceeds its storage bound");
  }
  return normalized;
}

function requirePromisorRemote(row: Record<string, unknown>): PromisorRemote {
  const remoteName = expectText(row.remote_name, "promisor remote name");
  const url = expectText(row.url, "promisor remote URL");
  if (row.filter !== "blob:none") throw new CorruptError("promisor remote filter is invalid");
  return { remoteName, url, filter: "blob:none" };
}

export class PromisorTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  register(remoteName: string, url: string): PromisorRemote {
    const checkedName = requireRemoteName(remoteName);
    const checkedUrl = requireRemoteUrl(url);
    return this.db.transactionSync(() => {
      this.db.run(
        `INSERT INTO git_promisor_remotes (repo_id, remote_name, url, filter)
         VALUES (?, ?, ?, 'blob:none')
         ON CONFLICT(repo_id, remote_name) DO NOTHING`,
        this.repoId,
        checkedName,
        checkedUrl,
      );
      const stored = this.#read(checkedName);
      if (stored === null) throw new CorruptError("registered promisor remote is missing");
      if (stored.url !== checkedUrl) {
        throw new GitError("ESTALE", `promisor remote ${checkedName} points to another URL`);
      }
      return stored;
    });
  }

  read(remoteName: string): PromisorRemote | null {
    return this.#read(requireRemoteName(remoteName));
  }

  #read(remoteName: string): PromisorRemote | null {
    const row = this.db.one<Record<string, unknown>>(
      `SELECT remote_name, url, filter FROM git_promisor_remotes
        WHERE repo_id = ? AND remote_name = ?`,
      this.repoId,
      remoteName,
    );
    return row === undefined ? null : requirePromisorRemote(row);
  }

  addBlobs(remoteName: string, oids: Iterable<string>): void {
    const checkedName = requireRemoteName(remoteName);
    const checkedOids = function* (): Generator<string> {
      for (const oid of oids) {
        if (typeof oid !== "string" || !isOid(oid)) {
          throw new GitError("EINVAL", "promised blob batch contains an invalid object id");
        }
        yield oid;
      }
    };
    this.db.transactionSync(() => {
      if (this.#read(checkedName) === null) {
        throw new GitError("ENOREMOTE", `promisor remote ${checkedName} is not registered`);
      }
      for (const page of jsonPages(checkedOids(), "promised blob")) {
        this.db.run(
          `INSERT INTO git_promised_blobs (repo_id, oid, remote_name, type)
           SELECT ?, value, ?, 'blob' FROM json_each(?) input
            WHERE NOT EXISTS (
              SELECT 1 FROM git_objects loose
               WHERE loose.repo_id = ? AND loose.oid = input.value
            )
              AND NOT EXISTS (
                SELECT 1 FROM git_pack_objects packed
                JOIN git_pack_meta pack
                  ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
                 AND pack.state = 'complete'
                 WHERE packed.repo_id = ? AND packed.oid = input.value
              )
           ON CONFLICT(repo_id, oid) DO NOTHING`,
          this.repoId,
          checkedName,
          page,
          this.repoId,
          this.repoId,
        );
      }
    });
  }

  addBlobsFromPackTrees(remoteName: string, packId: number): void {
    const checkedName = requireRemoteName(remoteName);
    if (!Number.isSafeInteger(packId) || packId < 0) {
      throw new GitError("EINVAL", "promisor pack id is invalid");
    }
    this.db.transactionSync(() => {
      if (this.#read(checkedName) === null) {
        throw new GitError("ENOREMOTE", `promisor remote ${checkedName} is not registered`);
      }
      this.db.run(
        `INSERT INTO git_promised_blobs (repo_id, oid, remote_name, type)
         SELECT ?, entry.oid, ?, 'blob'
           FROM git_tree_sources source
           JOIN git_tree_entries entry ON entry.source_key = source.source_key
          WHERE source.repo_id = ? AND source.storage = 'pack' AND source.source_id = ?
            AND source.complete = 1
            AND entry.mode NOT IN ('40000', '040000', '160000')
            AND NOT EXISTS (
              SELECT 1 FROM git_objects loose
               WHERE loose.repo_id = ? AND loose.oid = entry.oid
            )
            AND NOT EXISTS (
              SELECT 1 FROM git_pack_objects packed
              JOIN git_pack_meta pack
                ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
               AND pack.state = 'complete'
               WHERE packed.repo_id = ? AND packed.oid = entry.oid
            )
         ON CONFLICT(repo_id, oid) DO NOTHING`,
        this.repoId,
        checkedName,
        this.repoId,
        packId,
        this.repoId,
        this.repoId,
      );
    });
  }

  promisedMissing(oids: readonly string[]): string[] {
    return this.promisedMissingDetails(oids).map((entry) => entry.oid);
  }

  promisedMissingDetails(oids: readonly string[]): PromisedBlob[] {
    if (oids.length > MAX_PROMISED_BLOB_LOOKUP_OIDS) {
      throw new GitError(
        "E2BIG",
        `promised blob lookup exceeds ${MAX_PROMISED_BLOB_LOOKUP_OIDS} inputs`,
      );
    }
    const wanted: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < oids.length; index++) {
      const oid = oids[index];
      if (typeof oid !== "string" || !isOid(oid)) {
        throw new GitError("EINVAL", "promised blob lookup contains an invalid object id");
      }
      if (!seen.has(oid)) {
        seen.add(oid);
        wanted.push(oid);
      }
    }
    if (wanted.length === 0) return [];

    const missing: PromisedBlob[] = [];
    let nextOrdinal = 0;
    for (const row of this.db.iterate(
      `WITH wanted(ordinal, oid) AS MATERIALIZED (
         SELECT CAST(key AS INTEGER), value FROM json_each(?)
       )
       SELECT wanted.ordinal, promised.oid, promised.remote_name
         FROM wanted
         JOIN git_promised_blobs promised
           ON promised.repo_id = ? AND promised.oid = wanted.oid
        WHERE NOT EXISTS (
          SELECT 1 FROM git_objects loose
           WHERE loose.repo_id = ? AND loose.oid = wanted.oid
        )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_objects packed
            JOIN git_pack_meta pack
              ON pack.repo_id = packed.repo_id AND pack.pack_id = packed.pack_id
             AND pack.state = 'complete'
             WHERE packed.repo_id = ? AND packed.oid = wanted.oid
          )
        ORDER BY wanted.ordinal`,
      JSON.stringify(wanted),
      this.repoId,
      this.repoId,
      this.repoId,
    )) {
      const ordinal = expectSafeInteger(
        row.ordinal,
        nextOrdinal,
        wanted.length - 1,
        "promised blob ordinal",
      );
      const oid = expectText(row.oid, "promised blob object id");
      if (wanted[ordinal] !== oid) throw new CorruptError("promised blob lookup changed identity");
      missing.push({
        oid,
        remoteName: expectText(row.remote_name, "promised blob remote name"),
      });
      nextOrdinal = ordinal + 1;
    }
    return missing;
  }

  count(): number {
    const count = this.db.scalar<unknown>(
      "SELECT count(*) FROM git_promised_blobs WHERE repo_id = ?",
      this.repoId,
    );
    return expectSafeInteger(count, 0, Number.MAX_SAFE_INTEGER, "promised blob count");
  }

  *iterate(): Generator<PromisedBlob> {
    for (const row of this.db.iterate(
      `SELECT oid, remote_name FROM git_promised_blobs
        WHERE repo_id = ? ORDER BY oid COLLATE BINARY`,
      this.repoId,
    )) {
      const oid = expectText(row.oid, "promised blob object id");
      if (!isOid(oid)) throw new CorruptError("promised blob object id is invalid");
      yield {
        oid,
        remoteName: expectText(row.remote_name, "promised blob remote name"),
      };
    }
  }
}
