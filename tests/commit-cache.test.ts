import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../packages/do/src/db/db.js";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hasErrorCode } from "../packages/git/src/common/errors.js";
import {
  type Commit,
  hashObject,
  parseCommit,
  serializeCommit,
  serializeTree,
} from "../packages/git/src/common/objects.js";
import { commit as commitIndexOp } from "../packages/git/src/ops/repository/commit.js";
import { log, show } from "../packages/git/src/ops/repository/reads.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import {
  COMMIT_ROW_MAX_BYTES,
  insertCommitCaches,
  MAX_LOG_COMMITS,
  prepareCommitCache,
  WALK_COMMIT_GRAPH_SQL,
} from "../packages/git/src/store/trees/commits.js";
import { TestDatabase } from "./helpers/db.js";
import { makeRepo } from "./helpers/workspace.js";

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

function insertSource(db: SqlDatabase, oid: string, data: Uint8Array): number {
  return insertCommitCaches(db, [prepareCommitCache({ repoId: 1, oid, data })]).written;
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
        messageStored: true,
      });
    }
  });

  it("indexes a commit written by commit before any log", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Fixture");
    workspace.repo.store.configSet("user.email", "fixture@example.com");
    const { oid } = commitIndexOp(workspace.context, workspace.repo, {
      message: "first\n",
      allowEmpty: true,
    });

    expect(
      workspace.repo.store.db.one(
        "SELECT message FROM git_commits WHERE repo_id = ? AND oid = ?",
        workspace.repo.store.repoId,
        oid,
      ),
    ).toEqual({ message: utf8.encode("first\n") });
  });

  it("keeps the message of a large commit whose row fits the platform ceiling", () => {
    const commit = fixture("m".repeat(600 * 1024));
    const data = serializeCommit(commit);
    const oid = hashObject("commit", data);
    const entry = prepareCommitCache({ repoId: 1, oid, data });

    expect(entry.messageStored).toBe(true);
    expect(entry.commit).toEqual(commit);
  });

  it("keeps an oversized message out of the row and reads it from the object", () => {
    const workspace = makeRepo("/");
    const store = workspace.repo.store;
    const commit = fixture(`${"m".repeat(COMMIT_ROW_MAX_BYTES)}\n`);
    commit.parent = [];
    commit.tree = store.write("tree", serializeTree([]));
    const oid = store.write("commit", serializeCommit(commit));

    expect(
      store.db.one(
        `SELECT message IS NULL AS message, gpgsig IS NULL AS gpgsig
           FROM git_commits WHERE repo_id = ? AND oid = ?`,
        store.repoId,
        oid,
      ),
    ).toEqual({ message: 1, gpgsig: 1 });
    const graph = [...store.commitGraph(oid)];
    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ oid, messageStored: false });
    expect(graph[0]?.commit.message).toBeUndefined();
    expect(log(workspace.repo, { ref: oid }).map((view) => view.message)).toEqual([commit.message]);
    expect(log(workspace.repo, { ref: oid, depth: 1 }).map((view) => view.message)).toEqual([
      commit.message,
    ]);
    expect(show(workspace.repo, { ref: oid }).commit.message).toBe(commit.message);
    expect([...workspace.repo.walkIndexed(oid)]).toEqual([{ oid, commit }]);
  });

  it("logs a history whose 40 MiB commit charges the graph only its row", () => {
    const workspace = makeRepo("/");
    const store = workspace.repo.store;
    const tree = store.write("tree", serializeTree([]));
    const large = fixture(`${"m".repeat(40 * 1024 * 1024)}\n`);
    large.tree = tree;
    large.parent = [];
    const parent = store.write("commit", serializeCommit(large));
    const child = fixture("child\n");
    child.tree = tree;
    child.parent = [parent];
    const oid = store.write("commit", serializeCommit(child));

    expect(log(workspace.repo, { ref: oid }).map((view) => view.oid)).toEqual([oid, parent]);
    expect(log(workspace.repo, { ref: oid, depth: 2 }).map((view) => view.oid)).toEqual([
      oid,
      parent,
    ]);
  }, 30_000);

  it("rejects commit headers above the row ceiling without storing them", () => {
    const store = open();
    const commit = fixture();
    commit.author.name = "a".repeat(COMMIT_ROW_MAX_BYTES);
    const data = serializeCommit(commit);

    let error: unknown;
    try {
      store.write("commit", data);
    } catch (caught) {
      error = caught;
    }
    expect(hasErrorCode(error, "E2BIG")).toBe(true);
    expect(store.objectCount()).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
  });

  it("reports a point read of a commit without a row as corruption", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, parent);
    const repo = new Repository(store);

    for (const read of [() => repo.readCommit(parent!), () => [...repo.walk(root!)]]) {
      expect(read).toThrow(
        expect.objectContaining({
          code: "ECORRUPT",
          message: expect.stringMatching(/has no parsed row/),
        }),
      );
    }
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

  it("inserts one row per key and checks source witnesses only while writing", () => {
    const store = open();
    const commit = fixture();
    const data = serializeCommit(commit);
    const oid = store.write("commit", data);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oid);

    expect(store.cachedCommit(oid)).toBeNull();
    expect(insertSource(store.db, oid, data)).toBe(1);
    expect(insertSource(store.db, oid, data)).toBe(1);
    expect(store.cachedCommit(oid)?.commit).toEqual(commit);
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

    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oid);
    store.db.run("UPDATE git_objects SET size = size + 1 WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(insertSource(store.db, oid, data)).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    store.db.run("UPDATE git_objects SET size = size - 1 WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(insertSource(store.db, oid, data)).toBe(1);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oid);
    store.db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(insertSource(store.db, oid, data)).toBe(0);
    expect(store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
  });

  it("batch-inserts prepared rows", () => {
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

    const result = insertCommitCaches(store.db, entries);
    expect(result).toEqual({ written: 2, statements: expect.any(Number) });
    expect(result.statements).toBeLessThan(1_000);
    expect(sources.map(({ oid }) => store.cachedCommit(oid)?.commit.message)).toEqual([
      "first\n",
      "second\n",
    ]);
  });

  it("decodes cached fields and trusts stored projection values", () => {
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
    expect(insertSource(store.db, oid, data)).toBe(1);
    expect(store.cachedCommit(oid)?.commit).toEqual(fixture());
    store.db.run(
      "UPDATE git_commits SET message = ? WHERE repo_id = ? AND oid = ?",
      utf8.encode("x".repeat(fixture().message.length)),
      1,
      oid,
    );
    expect(store.cachedCommit(oid)?.commit.message).toBe("x".repeat(fixture().message.length));
    expect(insertSource(store.db, oid, data)).toBe(1);
    expect(store.cachedCommit(oid)?.commit).toEqual(fixture());
  });

  it("rejects row bytes whose oid names different content", () => {
    const store = open();
    const data = serializeCommit(fixture("source\n"));
    const oid = store.write("commit", data);
    const wrong = serializeCommit(fixture("changed\n"));

    expect(() => prepareCommitCache({ repoId: 1, oid, data: wrong })).toThrow(/does not match/);
    expect(() => insertSource(store.db, oid, wrong)).toThrow(/does not match/);
    expect(store.cachedCommit(oid)?.commit.message).toBe("source\n");
  });

  it("rejects malformed and unsafe-numeric commits atomically", () => {
    const malformed = utf8.encode("not a commit");
    const numeric = serializeCommit({
      ...fixture(),
      author: { ...fixture().author, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    });
    const cases = [
      { data: malformed, code: "ECORRUPT" },
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

  it("ignores a row without a matching raw source", () => {
    const db = new TestDatabase();
    const store = open(db);
    const data = serializeCommit(fixture());
    const oid = hashObject("commit", data);

    expect(insertSource(db, oid, data)).toBe(0);
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
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    expect(insertSource(db, oid, data)).toBe(1);
    expect(store.cachedCommit(oid)?.commit).toEqual(commit);
    db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oid);
    db.run("UPDATE git_pack_meta SET state = 'pending' WHERE repo_id = ? AND pack_id = ?", 1, 7);
    expect(insertSource(db, oid, data)).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    db.run("UPDATE git_pack_meta SET state = 'complete' WHERE repo_id = ? AND pack_id = ?", 1, 7);
    db.run("UPDATE git_pack_objects SET size = size + 1 WHERE repo_id = ? AND oid = ?", 1, oid);
    expect(insertSource(db, oid, data)).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
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
      widestStringBytes: 889_771,
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

  it("charges graph state from object sizes before returning a BLOB", () => {
    const inner = new TestDatabase();
    const db = new MeasuredDatabase(inner);
    const store = open(db);
    const oids = commitChain(store, 2);
    const sizes = store.db.scalar<number>("SELECT sum(object_size) FROM git_commits");
    if (sizes === undefined) throw new Error("graph fixture has no rows");
    const charged = 2 * 512 + 2 * sizes + 64;
    db.widestResultBlob = 0;

    expect(() => [...store.commitGraph(oids[1]!, { maxBytes: charged - 1 })]).toThrow(
      /fixed state capacity/,
    );
    expect(db.widestResultBlob).toBe(0);
    expect([...store.commitGraph(oids[1]!, { maxBytes: charged })]).toHaveLength(2);
  });

  it("stops at shallow commits before requiring their parents", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.setShallow([root!]);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, parent);
    store.db.run("DELETE FROM git_objects WHERE repo_id = ? AND oid = ?", 1, parent);

    expect([...store.commitGraph(root!)]).toHaveLength(1);
  });

  it("reports a reachable commit without a row as corruption before returning a graph row", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, parent);
    const walk = store.commitGraph(root!)[Symbol.iterator]();

    expect(() => walk.next()).toThrow(
      expect.objectContaining({
        code: "ECORRUPT",
        message: expect.stringMatching(/without a row/),
      }),
    );
  });

  it("releases graph iterators on early return", () => {
    const store = open();
    const oid = commitChain(store, 2)[1]!;
    const repo = new Repository(store);
    const direct = repo.walkIndexed(oid);
    expect(direct.next().done).toBe(false);
    direct.return(undefined);
  });

  it("leaves graph cycles to fail-closed Repository validation", () => {
    const store = open();
    const [parent, root] = commitChain(store, 2);
    store.db.run(
      "UPDATE git_commits SET parents = ? WHERE repo_id = ? AND oid = ?",
      JSON.stringify([root!]),
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
        null,
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
