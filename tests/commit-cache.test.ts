import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { hasErrorCode } from "../src/core/errors.js";
import { type Commit, hashObject, parseCommit, serializeCommit } from "../src/core/objects.js";
import { Repository, walkIndexedOwned, walkOwned } from "../src/core/repository.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import {
  COMMIT_CACHE_FLUSH_BYTES,
  commitCacheBytes,
  commitCacheMaterializationBytes,
  commitCacheSqlPayloadBytes,
  commitGraphBytes,
  commitPreparationTransientBytes,
  indexCommitSource,
  MAX_LOG_COMMITS,
  prepareCommitCache,
  WALK_COMMIT_GRAPH_SQL,
} from "../src/sqlite/commits.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { readShallowOwned, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

const FORMER_LOG_STATE_BYTES = 32 * 1024 * 1024;
const FORMER_INDEXED_COMMIT_BYTES = 1024 * 1024;
const MEMORY_EXCESS_COMMIT_MESSAGE_BYTES = 4 * 1024 * 1024;

class MeasuredDatabase implements SqlDatabase {
  widestStringBytes = 0;
  widestCommitRows = 0;
  widestResultBlob = 0;
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

  *iterate(query: string, ...bindings: unknown[]): Generator<Record<string, unknown>> {
    this.#measure(query, bindings);
    for (const row of this.inner.iterate(query, ...bindings)) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array && value.byteLength > this.widestResultBlob) {
          this.widestResultBlob = value.byteLength;
        }
      }
      yield row;
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function open(db: SqlDatabase = new TestDatabase()) {
  const database = new SqliteGitDatabase(db);
  const repository = database.createRepository("/repo", "ref: refs/heads/main");
  return database.openCheckout(repository);
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

function commitChain(store: ReturnType<typeof open>, count: number): string[] {
  return store.writeObjects((batch) => {
    const oids: string[] = [];
    for (let index = 0; index < count; index++) {
      const commit = fixture(`commit ${index}\n`);
      commit.parent = oids.length === 0 ? [] : [oids[oids.length - 1]!];
      commit.committer.timestamp = index;
      oids.push(batch.write("commit", serializeCommit(commit)));
    }
    return oids;
  });
}

function insertAuthoritativeCommit(db: SqlDatabase, data: Uint8Array): string {
  const oid = hashObject("commit", data);
  db.run(
    "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, 'commit', ?, 'raw')",
    1,
    oid,
    data.length,
  );
  for (let offset = 0, sequence = 0; offset < data.length; offset += 1024 * 1024, sequence++) {
    db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
      1,
      oid,
      sequence,
      data.subarray(offset, offset + 1024 * 1024),
    );
  }
  return oid;
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

    expect(data.length).toBeLessThan(FORMER_INDEXED_COMMIT_BYTES);
    expect(entry.cacheBytes).toBeGreaterThan(1_200_000);
    expect(entry.cacheBytes).toBeLessThan(1_300_000);
    expect(entry.cacheBytes).toBeLessThanOrEqual(COMMIT_CACHE_FLUSH_BYTES);
  });

  it("reads and traverses an authoritative commit above the former cache threshold uncached", () => {
    const db = new TestDatabase();
    const store = open(db);
    const commit = fixture(`${"m".repeat(2_100_000)}\n`);
    commit.parent = [];
    const data = serializeCommit(commit);
    const oid = insertAuthoritativeCommit(db, data);
    store.shared.markLoose();
    const repo = new Repository(store);

    expect(data.length).toBeGreaterThan(FORMER_INDEXED_COMMIT_BYTES);
    expect(store.cachedCommit(oid)).toBeNull();
    expect(repo.readCommit(oid).message).toBe(commit.message);
    expect(store.cachedCommit(oid)).toBeNull();
    expect([...repo.walkIndexed(oid)].map((entry) => entry.oid)).toEqual([oid]);
    expect(store.cachedCommit(oid)).toBeNull();
    store.shared.memory.assertIdle();
  });

  it("admits authoritative bytes before allocation and retains the parsed commit for its caller", () => {
    const db = new TestDatabase();
    const store = open(db);
    const expected = fixture(`${"owned".repeat(10_000)}\n`);
    expected.parent = [];
    const data = serializeCommit(expected);
    const oid = insertAuthoritativeCommit(db, data);
    store.shared.markLoose();
    const repo = new Repository(store);
    const owner = store.reserveMemory();
    const originalRead = repo.store.readAuthenticatedObject.bind(repo.store);
    let admittedBeforeRead: number | undefined;
    repo.store.readAuthenticatedObject = (candidate, type) => {
      admittedBeforeRead = owner.currentBytes;
      return originalRead(candidate, type);
    };

    let commit: Commit;
    try {
      commit = repo.readAuthenticatedCommitOwned(oid, owner);
    } finally {
      repo.store.readAuthenticatedObject = originalRead;
    }
    expect(admittedBeforeRead).toBe(commitPreparationTransientBytes(data.length));
    expect(owner.currentBytes).toBe(commitCacheBytes(commit));
    expect(commit.message).toBe(expected.message);
    owner.dispose();
    store.shared.memory.assertIdle();

    expect(repo.readAuthenticatedCommit(oid).message).toBe(expected.message);
    store.shared.memory.assertIdle();
  });

  it("charges the documented fixed graph slots before payload and parents", () => {
    const commit: Commit = {
      tree: "1".repeat(40),
      parent: [],
      author: { name: "", email: "", timestamp: 0, timezoneOffset: 0 },
      committer: { name: "", email: "", timestamp: 0, timezoneOffset: 0 },
      message: "",
    };

    expect(commitCacheBytes(commit)).toBe(592);
    expect(commitGraphBytes(commit)).toBe(596);
  });

  it("round-trips NUL in every arbitrary text projection field", () => {
    const store = open();
    const commit = fixture("message\0tail\n");
    commit.parent = [];
    commit.author.name = "Au\0thor";
    commit.author.email = "author\0@example.test";
    commit.committer.name = "Com\0mitter";
    commit.committer.email = "committer\0@example.test";
    commit.gpgsig = "signature\0tail";
    const data = serializeCommit(commit);
    const parsed = parseCommit(data);
    const oid = store.write("commit", data);

    expect(store.cachedCommit(oid)?.commit).toEqual(parsed);
    expect([...store.commitGraph(oid)][0]?.commit).toEqual(parsed);
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

  it("batch-inserts prepared point misses through the shared-store seam", () => {
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

    const result = store.cacheCommits(entries);
    expect(result).toEqual({
      eligible: 2,
      skipped: 0,
      written: 2,
      statements: expect.any(Number),
    });
    expect(result.statements).toBeLessThan(1_000);
    expect(sources.map(({ oid }) => store.cachedCommit(oid)?.commit.message)).toEqual([
      "first\n",
      "second\n",
    ]);
  });

  it("fails closed on corrupted cached fields and byte accounting", () => {
    const store = open();
    const data = serializeCommit(fixture());
    const oid = store.write("commit", data);

    store.db.run("PRAGMA ignore_check_constraints = ON");
    store.db.run(
      "UPDATE git_commits SET parents = 'not-json' WHERE repo_id = ? AND oid = ?",
      1,
      oid,
    );
    store.db.run("PRAGMA ignore_check_constraints = OFF");
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

  it("rejects malformed, unsafe-numeric, and real-memory-excess commits atomically", () => {
    const malformed = utf8.encode("not a commit");
    const oversized = serializeCommit(
      fixture(`${"x".repeat(MEMORY_EXCESS_COMMIT_MESSAGE_BYTES)}\n`),
    );
    const numeric = serializeCommit({
      ...fixture(),
      author: { ...fixture().author, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    });
    const cases = [
      { data: malformed, code: "ECORRUPT" },
      { data: oversized, code: "E2BIG" },
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
        expect(hasErrorCode(error, code)).toBe(true);
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

  it("batches 3,293 commits within row and binding limits", () => {
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
    }).toEqual({
      widestStringBytes: 908_203,
      widestCommitRows: 2_048,
    });
    expect(db.commitStatements).toBeLessThan(1_000);
    expect(inner.storage.statementCount).toBeLessThan(1_000);
  });

  it("destroy removes derived commit rows with the repository", () => {
    const db = new TestDatabase();
    const store = open(db);
    store.write("commit", serializeCommit(fixture()));
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(1);

    store.destroy();

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
  });

  it("walks one source-validated graph cursor without object payload reads", () => {
    const db = new TestDatabase();
    const store = open(db);
    const oids = commitChain(store, 4);
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    const entries = [...store.commitGraph(oids[3]!)];

    expect(new Set(entries.map((entry) => entry.oid))).toEqual(new Set(oids));
    expect(db.storage.statementCount).toBe(1);
    expect([...db.storage.histogram.keys()].join("\n")).not.toContain("git_object_chunks");
    expect(entries[3]?.commit).toEqual(store.cachedCommit(entries[3]!.oid)?.commit);
  });

  it("enforces the absolute count with an injected 3/4 negative control", () => {
    const db = new TestDatabase();
    const store = open(db);
    const oids = commitChain(store, 4);
    expect(MAX_LOG_COMMITS).toBe(50_000);

    db.storage.resetCounters();
    expect(() => [...store.commitGraph(oids[3]!, { maxCommits: 3 })]).toThrow(/50000 commit limit/);
    expect(db.storage.statementCount).toBe(1);
    expect([...store.commitGraph(oids[3]!, { maxCommits: 4 })]).toHaveLength(4);
  });

  it("accepts the exact graph-byte boundary and rejects one byte less", () => {
    const store = open();
    const oid = commitChain(store, 1)[0]!;
    const commit = store.cachedCommit(oid)!.commit;
    const bytes = commitCacheMaterializationBytes(commit);

    expect([...store.commitGraph(oid, { maxBytes: bytes })]).toHaveLength(1);
    expect(() => [...store.commitGraph(oid, { maxBytes: bytes - 1 })]).toThrow(
      /retained-memory capacity/,
    );
  });

  it("pre-admits point-cache SQL payload coexistence at the exact shared boundary", () => {
    const measured = open();
    const oid = commitChain(measured, 1)[0]!;
    const measuredOwner = measured.reserveMemory();
    expect([...walkOwned(new Repository(measured), oid, measuredOwner)]).toHaveLength(1);
    const operationBytes = measuredOwner.highWaterBytes;
    expect(measuredOwner.currentBytes).toBe(0);
    measuredOwner.dispose();
    measured.shared.memory.assertIdle();

    for (const excess of [0, 1]) {
      const store = open();
      const candidate = commitChain(store, 1)[0]!;
      const blocker = store.reserveMemory();
      blocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + excess);
      const owner = store.reserveMemory();
      try {
        const read = () => [...walkOwned(new Repository(store), candidate, owner)];
        if (excess === 0) expect(read()).toHaveLength(1);
        else expect(read).toThrowError(expect.objectContaining({ code: "E2BIG" }));
        expect(owner.currentBytes).toBe(0);
      } finally {
        owner.dispose();
        blocker.dispose();
      }
      store.shared.memory.assertIdle();
    }
  });

  it("retains an owned graph at the exact shared-memory boundary and releases it", () => {
    const measure = open();
    const oid = commitChain(measure, 1)[0]!;
    const measuredOwner = measure.reserveMemory();
    expect([...walkIndexedOwned(new Repository(measure), oid, measuredOwner)]).toHaveLength(1);
    const operationBytes = measuredOwner.highWaterBytes;
    expect(measuredOwner.currentBytes).toBe(0);
    measuredOwner.dispose();

    const exactBlocker = measure.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactOwner = measure.reserveMemory();
    try {
      expect([...walkIndexedOwned(new Repository(measure), oid, exactOwner)]).toHaveLength(1);
      expect(exactOwner.currentBytes).toBe(0);
      expect(measure.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    measure.shared.memory.assertIdle();

    const excess = open();
    const excessOid = commitChain(excess, 1)[0]!;
    const excessBlocker = excess.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const excessOwner = excess.reserveMemory();
    try {
      expect(() => [
        ...walkIndexedOwned(new Repository(excess), excessOid, excessOwner),
      ]).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(excessOwner.currentBytes).toBe(0);
    } finally {
      excessOwner.dispose();
      excessBlocker.dispose();
    }
    excess.shared.memory.assertIdle();
  });

  it("streams a full shallow boundary at the exact shared-memory limit", () => {
    const boundaries = Array.from({ length: 2_048 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );
    const measured = open();
    measured.setShallow(boundaries);
    const probe = measured.reserveMemory();
    expect(readShallowOwned(measured.shared, probe)).toEqual(new Set(boundaries));
    const operationBytes = probe.highWaterBytes;
    expect(probe.currentBytes).toBeLessThan(operationBytes);
    probe.dispose();
    measured.shared.memory.assertIdle();

    const exact = open();
    exact.setShallow(boundaries);
    const exactBlocker = exact.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactOwner = exact.reserveMemory();
    try {
      expect(readShallowOwned(exact.shared, exactOwner)).toEqual(new Set(boundaries));
      expect(exact.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    exact.shared.memory.assertIdle();

    const excess = open();
    excess.setShallow(boundaries);
    const excessBlocker = excess.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const excessOwner = excess.reserveMemory();
    try {
      expect(() => readShallowOwned(excess.shared, excessOwner)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
    } finally {
      excessOwner.dispose();
      excessBlocker.dispose();
    }
    excess.shared.memory.assertIdle();
  });

  it("rejects understated oversized payload metadata without returning its BLOB", () => {
    const inner = new TestDatabase();
    const db = new MeasuredDatabase(inner);
    const store = open(db);
    const oid = commitChain(store, 1)[0]!;
    store.db.run(
      "UPDATE git_commits SET message = zeroblob(?) WHERE repo_id = ? AND oid = ?",
      40 * 1024 * 1024,
      1,
      oid,
    );
    db.widestResultBlob = 0;

    expect(() => [...store.commitGraph(oid)]).toThrow(/retained-memory capacity/);
    expect(db.widestResultBlob).toBe(0);
  });

  it("owns a graph above 32 MiB and rejects its exact aggregate first excess", () => {
    const store = open();
    let parent: string | undefined;
    let root: string | undefined;
    let bytes = 0;
    let payloadBytes = 0;
    for (let index = 0; bytes <= FORMER_LOG_STATE_BYTES; index++) {
      const commit = fixture(`${"m".repeat(500_000)}${index}\n`);
      commit.parent = parent === undefined ? [] : [parent];
      commit.committer.timestamp = index;
      const oid = store.write("commit", serializeCommit(commit));
      const cached = store.cachedCommit(oid);
      if (cached === null) throw new Error("large graph cache row is missing");
      bytes += commitGraphBytes(cached.commit);
      payloadBytes = Math.max(payloadBytes, commitCacheSqlPayloadBytes(cached.commit));
      root = oid;
      parent = oid;
    }
    if (root === undefined) throw new Error("large graph has no root");
    const repo = new Repository(store);

    expect(bytes).toBeGreaterThan(FORMER_LOG_STATE_BYTES);
    const operationBytes = bytes + payloadBytes;
    expect([...repo.walkIndexed(root, { maxBytes: operationBytes })]).not.toHaveLength(0);
    expect(() => [...repo.walkIndexed(root, { maxBytes: operationBytes - 1 })]).toThrow(
      /retained-memory capacity/,
    );
    store.shared.memory.assertIdle();
  }, 30_000);

  it("stops at shallow commits before requiring their parents", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.setShallow([root!]);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, parent);
    store.db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", 1, parent);

    expect([...store.commitGraph(root!)]).toHaveLength(1);
  });

  it("reports an unavailable cache before returning a graph row", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, parent);
    const walk = store.commitGraph(root!)[Symbol.iterator]();

    expect(() => walk.next()).toThrow(/cache is unavailable/);
  });

  it("fails closed on a corrupt cached parent reached from an uncached root", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, root);
    store.db.run("PRAGMA ignore_check_constraints = ON");
    store.db.run(
      "UPDATE git_commits SET parents = 'not-json' WHERE repo_id = ? AND oid = ?",
      1,
      parent,
    );
    store.db.run("PRAGMA ignore_check_constraints = OFF");
    const repo = new Repository(store);

    expect(() => [...repo.walkIndexed(root!)]).toThrow(/cache row is corrupt/);
    store.shared.memory.assertIdle();
  });

  it("fails a corrupt tail row before returning the valid root", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.db.run("PRAGMA ignore_check_constraints = ON");
    store.db.run(
      "UPDATE git_commits SET parents = 'not-json' WHERE repo_id = ? AND oid = ?",
      1,
      parent,
    );
    store.db.run("PRAGMA ignore_check_constraints = OFF");
    const walk = store.commitGraph(root!)[Symbol.iterator]();

    expect(() => walk.next()).toThrow(/cache is corrupt/);
  });

  it("never falls back from a corrupt cache row and releases direct and caller owners", () => {
    const store = open();
    const oid = commitChain(store, 1)[0]!;
    store.db.run("PRAGMA ignore_check_constraints = ON");
    store.db.run(
      "UPDATE git_commits SET parents = 'not-json' WHERE repo_id = ? AND oid = ?",
      1,
      oid,
    );
    store.db.run("PRAGMA ignore_check_constraints = OFF");
    const repo = new Repository(store);

    expect(() => [...repo.walkIndexed(oid)]).toThrow(/cache is corrupt/);
    store.shared.memory.assertIdle();

    const owner = store.reserveMemory();
    const iterator = walkIndexedOwned(repo, oid, owner)[Symbol.iterator]();
    expect(() => iterator.next()).toThrow(/cache is corrupt/);
    expect(owner.currentBytes).toBe(0);
    owner.dispose();
    store.shared.memory.assertIdle();
  });

  it("releases direct and caller-owned graph iterators on early return", () => {
    const store = open();
    const oid = commitChain(store, 2)[1]!;
    const repo = new Repository(store);
    const direct = repo.walkIndexed(oid);
    expect(direct.next().done).toBe(false);
    direct.return(undefined);
    store.shared.memory.assertIdle();

    const owner = store.reserveMemory();
    const owned = walkIndexedOwned(repo, oid, owner)[Symbol.iterator]();
    expect(owned.next().done).toBe(false);
    owned.return?.();
    expect(owner.currentBytes).toBe(0);
    owner.dispose();
    store.shared.memory.assertIdle();
  });

  it("leaves graph cycles to fail-closed Repository validation", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    const changed = fixture("commit 0\n");
    changed.parent = [root!];
    changed.committer.timestamp = 0;
    store.db.run(
      "UPDATE git_commits SET parents = ?, cache_bytes = ? WHERE repo_id = ? AND oid = ?",
      JSON.stringify(changed.parent),
      commitCacheBytes(changed),
      1,
      parent,
    );

    expect([...store.commitGraph(root!)]).toHaveLength(2);
  });

  it("uses primary-key graph lookups without an outer sort", () => {
    const store = open();
    const oid = commitChain(store, 1)[0]!;
    const plan = store.db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${WALK_COMMIT_GRAPH_SQL}`,
        1,
        oid,
        50_000,
        32 * 1024 * 1024,
        32 * 1024 * 1024,
        1024 * 1024,
        512,
        64,
      )
      .map((row) => row.detail)
      .join("\n");

    expect(plan).toMatch(/SEARCH c USING PRIMARY KEY \(repo_id=\? AND oid=\?\)/);
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    expect(plan).not.toContain("git_object_chunks");
  });

  it("isolates identical commit graphs and shallow boundaries by repository", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const first = database.openCheckout(
      database.createRepository("/first", "ref: refs/heads/main"),
    );
    const second = database.openCheckout(
      database.createRepository("/second", "ref: refs/heads/main"),
    );
    const firstOids = commitChain(first, 2);
    const secondOids = commitChain(second, 2);
    expect(firstOids).toEqual(secondOids);
    const root = firstOids[1];
    if (root === undefined) throw new Error("isolated graph root is missing");
    first.setShallow([root]);

    expect([...first.commitGraph(root)]).toHaveLength(1);
    expect([...second.commitGraph(root)]).toHaveLength(2);
  });
});
