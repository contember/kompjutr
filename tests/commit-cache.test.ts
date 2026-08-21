import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { GitError } from "../src/core/errors.js";
import { type Commit, hashObject, parseCommit, serializeCommit } from "../src/core/objects.js";
import {
  commitCacheBytes,
  indexCommitSource,
  MAX_COMMIT_CACHE_BYTES,
  MAX_INDEXED_COMMIT_BYTES,
  prepareCommitCache,
} from "../src/sqlite/commits.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

class MeasuredDatabase implements SqlDatabase {
  widestStringBytes = 0;
  widestCommitRows = 0;
  commitStatements = 0;
  readonly #encoder = new TextEncoder();

  constructor(readonly inner: TestDatabase) {}

  #measure(query: string, bindings: unknown[]): void {
    const isCommitInsert = query.includes("INSERT INTO git_commits");
    if (isCommitInsert) this.commitStatements++;
    for (const binding of bindings) {
      if (typeof binding !== "string") continue;
      const bytes = this.#encoder.encode(binding).byteLength;
      if (bytes > this.widestStringBytes) this.widestStringBytes = bytes;
      if (!isCommitInsert) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(binding);
      } catch {
        continue;
      }
      if (Array.isArray(decoded) && decoded.length > this.widestCommitRows) {
        this.widestCommitRows = decoded.length;
      }
    }
  }

  run(query: string, ...bindings: unknown[]): void {
    this.#measure(query, bindings);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#measure(query, bindings);
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#measure(query, bindings);
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#measure(query, bindings);
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.#measure(query, bindings);
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function open(db: SqlDatabase = new TestDatabase()) {
  const database = new SqliteGitDatabase(db);
  const repository = database.create("/repo", "ref: refs/heads/main");
  return database.open(repository);
}

function fixture(message = "subject\n\nbody\n"): Commit {
  return {
    tree: "1".repeat(40),
    parent: ["2".repeat(40), "3".repeat(40)],
    author: {
      name: "Åuthor",
      email: "author@example.test",
      timestamp: 1_700_000_001,
      timezoneOffset: -330,
    },
    committer: {
      name: "Committer",
      email: "committer@example.test",
      timestamp: 1_700_000_099,
      timezoneOffset: 480,
    },
    gpgsig: "-----BEGIN SIGNATURE-----\nline two\n-----END SIGNATURE-----",
    message,
  };
}

function chunks(data: Uint8Array, width: number): () => Iterable<Uint8Array> {
  return function* () {
    for (let at = 0; at < data.length; at += width) yield data.subarray(at, at + width);
  };
}

describe("parsed commit cache", () => {
  it("normalizes both signed zero timezone spellings before caching", () => {
    const store = open();
    for (const timezone of ["+0000", "-0000"]) {
      const data = utf8.encode(
        `tree ${"1".repeat(40)}\nauthor Author <author@example.test> 1 ${timezone}\ncommitter Committer <committer@example.test> 2 ${timezone}\n\nmessage\n`,
      );
      const parsed = parseCommit(data);
      const oid = store.write("commit", data);
      const cached = store.cachedCommit(oid)?.commit;

      expect(parsed.author.timezoneOffset).toBe(0);
      expect(parsed.committer.timezoneOffset).toBe(0);
      expect(Object.is(parsed.author.timezoneOffset, -0)).toBe(false);
      expect(Object.is(parsed.committer.timezoneOffset, -0)).toBe(false);
      expect(cached).toEqual(parsed);
      expect(Object.is(cached?.author.timezoneOffset, -0)).toBe(false);
      expect(Object.is(cached?.committer.timezoneOffset, -0)).toBe(false);
    }
  });

  it("preserves the exact Commit projection on scalar, streamed and batched writes", () => {
    const store = open();
    const scalarCommit = fixture("scalar\n");
    const streamCommit = fixture(`${"streamed".repeat(700)}\n`);
    const batchCommit = fixture(`${"batch".repeat(1_000)}\n`);
    delete batchCommit.gpgsig;
    const scalarData = serializeCommit(scalarCommit);
    const streamData = serializeCommit(streamCommit);
    const batchData = serializeCommit(batchCommit);
    const scalarOid = store.write("commit", scalarData);
    const streamOid = store.writeStream("commit", streamData.length, chunks(streamData, 113));
    const batchOid = store.writeObjects((batch) => batch.write("commit", batchData));

    for (const { oid, data, commit } of [
      { oid: scalarOid, data: scalarData, commit: scalarCommit },
      { oid: streamOid, data: streamData, commit: streamCommit },
      { oid: batchOid, data: batchData, commit: batchCommit },
    ]) {
      expect(store.cachedCommit(oid)).toMatchObject({
        repoId: 1,
        oid,
        commit,
        objectSize: data.length,
        cacheBytes: commitCacheBytes(commit),
      });
    }
  });

  it("charges a large accepted commit below the shared retained-memory cap", () => {
    const commit = fixture("m".repeat(600 * 1024));
    const data = serializeCommit(commit);
    const oid = hashObject("commit", data);
    const entry = prepareCommitCache({ repoId: 1, oid, data });

    expect(data.length).toBeLessThan(MAX_INDEXED_COMMIT_BYTES);
    expect(entry.cacheBytes).toBeGreaterThan(1_200_000);
    expect(entry.cacheBytes).toBeLessThan(1_300_000);
    expect(entry.cacheBytes).toBeLessThanOrEqual(MAX_COMMIT_CACHE_BYTES);
  });

  it("round-trips NUL in every arbitrary text projection field", () => {
    const store = open();
    const commit = fixture("message\0tail\n");
    commit.author.name = "Au\0thor";
    commit.author.email = "author\0@example.test";
    commit.committer.name = "Com\0mitter";
    commit.committer.email = "committer\0@example.test";
    commit.gpgsig = "signature\0tail";
    const data = serializeCommit(commit);
    const parsed = parseCommit(data);
    const oid = store.write("commit", data);

    expect(store.cachedCommit(oid)?.commit).toEqual(parsed);
    expect(
      store.db.one(
        `SELECT typeof(author_name) AS author_name,
                typeof(author_email) AS author_email,
                typeof(committer_name) AS committer_name,
                typeof(committer_email) AS committer_email,
                typeof(message) AS message, typeof(gpgsig) AS gpgsig
           FROM git_commits WHERE repo_id = ? AND oid = ?`,
        1,
        oid,
      ),
    ).toEqual({
      author_name: "blob",
      author_email: "blob",
      committer_name: "blob",
      committer_email: "blob",
      message: "blob",
      gpgsig: "blob",
    });
  });

  it("lazily inserts once and validates the raw source before returning a row", () => {
    const store = open();
    const commit = fixture();
    const data = serializeCommit(commit);
    const oid = store.write("commit", data);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oid);

    expect(store.cachedCommit(oid)).toBeNull();
    expect(store.cacheCommit(oid, data)?.commit).toEqual(commit);
    expect(store.cacheCommit(oid, data)?.commit).toEqual(commit);
    expect(
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_commits WHERE repo_id = ? AND oid = ?",
        1,
        oid,
      ),
    ).toBe(1);

    for (const rewrite of [
      () => store.write("commit", data),
      () => store.writeStream("commit", data.length, chunks(data, 17)),
      () => store.writeObjects((batch) => batch.write("commit", data)),
    ]) {
      store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oid);
      expect(rewrite()).toBe(oid);
      expect(store.cachedCommit(oid)?.commit).toEqual(commit);
    }

    store.db.run("UPDATE git_objects SET size = size + 1 WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(store.cachedCommit(oid)).toBeNull();
    store.db.run("UPDATE git_objects SET size = size - 1 WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(store.cachedCommit(oid)?.commit).toEqual(commit);
    store.db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(store.cachedCommit(oid)).toBeNull();
  });

  it("batch-inserts prepared point misses through the RepoStore seam", () => {
    const store = open();
    const sources = [fixture("first\n"), fixture("second\n")].map((commit) => {
      const data = serializeCommit(commit);
      const oid = store.write("commit", data);
      return { data, oid };
    });
    store.db.run("DELETE FROM git_commits WHERE repo_id = ?", 1);
    const entries = sources.map(({ data, oid }) => {
      const entry = prepareCommitCache({ repoId: 1, oid, data });
      return entry;
    });

    expect(store.cacheCommits(entries)).toEqual({
      eligible: 2,
      skipped: 0,
      written: 2,
      statements: 1,
    });
    expect(sources.map(({ oid }) => store.cachedCommit(oid)?.commit.message)).toEqual([
      "first\n",
      "second\n",
    ]);
  });

  it("fails closed on corrupted cached fields and byte accounting", () => {
    const store = open();
    const data = serializeCommit(fixture());
    const oid = store.write("commit", data);

    store.db.run(
      "UPDATE git_commits SET parents = 'not-json' WHERE repo_id = ? AND oid = ?",
      1,
      oid,
    );
    expect(() => store.cachedCommit(oid)).toThrow(/invalid parents/);
    store.db.run(
      "UPDATE git_commits SET parents = ?, cache_bytes = cache_bytes + 1 WHERE repo_id = ? AND oid = ?",
      JSON.stringify(fixture().parent),
      1,
      oid,
    );
    expect(() => store.cachedCommit(oid)).toThrow(/invalid byte charge/);
    expect(store.cacheCommit(oid, data)?.commit).toEqual(fixture());
    expect(store.cachedCommit(oid)?.commit).toEqual(fixture());
    store.db.run(
      "UPDATE git_commits SET message = ? WHERE repo_id = ? AND oid = ?",
      utf8.encode("x".repeat(fixture().message.length)),
      1,
      oid,
    );
    expect(store.cachedCommit(oid)?.commit.message).toBe("x".repeat(fixture().message.length));
    expect(store.cacheCommit(oid, data)?.commit).toEqual(fixture());
    expect(store.cachedCommit(oid)?.commit).toEqual(fixture());
  });

  it("rejects lazy cache bytes whose oid names different content", () => {
    const store = open();
    const data = serializeCommit(fixture("source\n"));
    const oid = store.write("commit", data);
    const wrong = serializeCommit(fixture("changed\n"));

    expect(() => prepareCommitCache({ repoId: 1, oid, data: wrong })).toThrow(/does not match/);
    expect(() => store.cacheCommit(oid, wrong)).toThrow(/does not match/);
    expect(store.cachedCommit(oid)?.commit.message).toBe("source\n");
  });

  it("rejects every inadmissible loose commit atomically", () => {
    const malformed = utf8.encode("not a commit");
    const oversized = serializeCommit(fixture(`${"x".repeat(MAX_INDEXED_COMMIT_BYTES)}\n`));
    const expanding = serializeCommit(fixture(`${"\0".repeat(220_000)}\n`));
    const numeric = serializeCommit({
      ...fixture(),
      author: { ...fixture().author, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    });
    const cases = [
      { data: malformed, code: "ECORRUPT" },
      { data: oversized, code: "E2BIG" },
      { data: expanding, code: "E2BIG" },
      { data: numeric, code: "E2BIG" },
    ];

    for (const { data, code } of cases) {
      for (const write of [
        (store: ReturnType<typeof open>) => store.write("commit", data),
        (store: ReturnType<typeof open>) =>
          store.writeStream("commit", data.length, chunks(data, 113)),
        (store: ReturnType<typeof open>) =>
          store.writeObjects((batch) => {
            batch.write("blob", utf8.encode("must roll back\n"));
            return batch.write("commit", data);
          }),
      ]) {
        const store = open();
        let error: unknown;
        try {
          write(store);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(GitError);
        if (!(error instanceof GitError)) throw new Error("expected GitError");
        expect(error.code).toBe(code);
        expect(store.objectCount()).toBe(0);
        expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks")).toBe(0);
        expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
      }
    }
  });

  it("ignores a lazy row without a matching raw source", () => {
    const db = new TestDatabase();
    const store = open(db);
    const data = serializeCommit(fixture());
    const oid = hashObject("commit", data);

    expect(indexCommitSource(db, { repoId: 1, oid, data })).toBeNull();
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    expect(store.cachedCommit(oid)).toBeNull();
  });

  it("accepts only complete, size-matched pack sources", () => {
    const db = new TestDatabase();
    const store = open(db);
    const commit = fixture();
    const data = serializeCommit(commit);
    const oid = hashObject("commit", data);
    db.run(
      "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, ?, ?, ?, ?)",
      1,
      7,
      data.length,
      1,
      "complete",
      0,
    );
    db.run(
      `INSERT INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      1,
      oid,
      7,
      12,
      13,
      data.length,
      "commit",
      data.length,
      data.length,
    );

    indexCommitSource(db, { repoId: 1, oid, data });
    expect(store.cachedCommit(oid)?.commit).toEqual(commit);
    db.run("UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = ? AND pack_id = ?", 1, 7);
    expect(store.cachedCommit(oid)).toBeNull();
    db.run("UPDATE git_pack_meta SET state = 'complete' WHERE repo_id = ? AND pack_id = ?", 1, 7);
    db.run("UPDATE git_pack_objects SET size = size + 1 WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(store.cachedCommit(oid)).toBeNull();
  });

  it("batches 3,293 commits within row, binding and statement ceilings", () => {
    const inner = new TestDatabase();
    const db = new MeasuredDatabase(inner);
    const store = open(db);
    const commits = Array.from({ length: 3_293 }, (_, index) =>
      serializeCommit(fixture(`commit ${index}\n`)),
    );
    inner.storage.resetCounters();
    db.widestStringBytes = 0;
    db.widestCommitRows = 0;
    db.commitStatements = 0;

    const oids = store.writeObjects((batch) => commits.map((data) => batch.write("commit", data)));

    expect(new Set(oids).size).toBe(commits.length);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits WHERE repo_id = ?", 1)).toBe(
      commits.length,
    );
    expect({
      widestStringBytes: db.widestStringBytes,
      widestCommitRows: db.widestCommitRows,
      commitStatements: db.commitStatements,
      statements: inner.storage.statementCount,
    }).toEqual({
      widestStringBytes: 908_203,
      widestCommitRows: 2_048,
      commitStatements: 3,
      statements: 11,
    });
  });

  it("destroy removes derived commit rows with the repository", () => {
    const store = open();
    store.write("commit", serializeCommit(fixture()));
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(1);

    store.destroy();

    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
  });
});
