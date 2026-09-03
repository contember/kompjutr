import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { iterateSqlCursor, readBlob, type SqlDatabase } from "../src/db/db.js";
import { concat, utf8, utf8Decoder } from "../src/git/common/bytes.js";
import {
  type Commit,
  hashObject,
  isTreeMode,
  MODE_FILE,
  MODE_TREE,
  serializeCommit,
  serializeTag,
  serializeTree,
} from "../src/git/common/objects.js";
import {
  catFile,
  collectDirectTreeEntries,
  collectRecursiveTreeEntries,
  log,
  lsFilesAtRef,
  lsTree,
  MAX_LS_TREE_ENTRIES,
  show,
} from "../src/git/ops/repository/reads.js";
import { Repository } from "../src/git/ops/repository/repository.js";
import { treeStream } from "../src/git/ops/tree/tree-stream.js";
import {
  readAuthenticatedObjectOwned,
  SqliteGitDatabase,
  WALK_TREE_SQL,
} from "../src/git/store/index.js";
import { encodeDeltaHeader } from "../src/git/store/pack/delta.js";
import { PackWriter } from "../src/git/store/pack/writer.js";
import { commitCacheBytes } from "../src/git/store/trees/commits.js";
import { TREE_WALK_PATH_BYTES, TREE_WALK_STATE_BYTES } from "../src/git/store/trees/tree-walk.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const timingGate = process.env.KOMPJUTR_TIMING_GATE === "1";

class TraversalPayloadProbeDatabase extends TestDatabase {
  traversalPayloadRows = 0;
  traversalClosures = 0;

  resetTraversalProbe(): void {
    this.traversalPayloadRows = 0;
    this.traversalClosures = 0;
  }

  override iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    const rows = super.iterate(query, ...bindings);
    if (query !== WALK_TREE_SQL) return rows;
    const probe = this;
    return (function* (): Generator<Record<string, unknown>> {
      try {
        for (const row of rows) {
          if (row.path !== null) probe.traversalPayloadRows++;
          yield row;
        }
      } finally {
        probe.traversalClosures++;
      }
    })();
  }
}

let fixture: GitFixture;
let fixtureDb: TestDatabase;
let repo: Repository;

describe("SQL cursor adapter", () => {
  const populated = () => {
    const storage = new SqliteTestStorage();
    storage.sql.exec("CREATE TABLE numbers (value INTEGER PRIMARY KEY)");
    for (let value = 1; value <= 5; value++) {
      storage.sql.exec("INSERT INTO numbers (value) VALUES (?)", value);
    }
    storage.resetCounters();
    return storage;
  };

  it("prefetches one row and toArray consumes only the remainder", () => {
    const storage = populated();
    const cursor = storage.sql.exec<{ value: number }>("SELECT value FROM numbers ORDER BY value");

    expect(storage.statementCount).toBe(1);
    expect(storage.rowCount).toBe(1);
    expect(cursor.next()).toEqual({ done: false, value: { value: 1 } });
    expect(storage.rowCount).toBe(1);
    expect(cursor.toArray()).toEqual([{ value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }]);
    expect(storage.rowCount).toBe(5);
  });

  it("interleaves identical native cursors without sharing statement state", () => {
    const storage = populated();
    const first = storage.sql.exec<{ value: number }>("SELECT value FROM numbers ORDER BY value");
    const second = storage.sql.exec<{ value: number }>("SELECT value FROM numbers ORDER BY value");

    expect(first.next().value).toEqual({ value: 1 });
    expect(second.next().value).toEqual({ value: 1 });
    expect(first.next().value).toEqual({ value: 2 });
    expect(second.next().value).toEqual({ value: 2 });

    const firstWalk = storage
      .iterate("SELECT value FROM numbers ORDER BY value")
      [Symbol.iterator]();
    const secondWalk = storage
      .iterate("SELECT value FROM numbers ORDER BY value")
      [Symbol.iterator]();
    expect(firstWalk.next().value).toEqual({ value: 1 });
    expect(secondWalk.next().value).toEqual({ value: 1 });
    expect(firstWalk.next().value).toEqual({ value: 2 });
    expect(secondWalk.next().value).toEqual({ value: 2 });
  });

  it("executes an unconsumed write and never falls back to toArray iteration", () => {
    const storage = populated();
    storage.sql.exec("INSERT INTO numbers (value) VALUES (6)");
    expect(
      storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM numbers").toArray(),
    ).toEqual([{ count: 6 }]);

    const cursor = storage.sql.exec<{ value: number }>("SELECT value FROM numbers");
    Object.defineProperty(cursor, Symbol.iterator, { value: undefined });
    expect(() => [...iterateSqlCursor(cursor)]).toThrow(/not iterable/);
  });
});

beforeAll(async () => {
  fixture = new GitFixture().init();
  fixture.write("README.md", "# demo\n");
  fixture.write("src/a.ts", "export const a = 1;\n");
  fixture.write("src/nested/b.ts", "export const b = 2;\n");
  fixture.write("src/\ue000.ts", "private use\n");
  fixture.write("src/\ud83d\ude00.ts", "non-BMP\n");
  fixture.commit("first");
  fixture.write("src/a.ts", "export const a = 2;\n");
  fixture.commit("second");
  fixture.git("checkout", "-q", "-b", "side", "HEAD~1");
  fixture.write("side.txt", "on the side\n");
  fixture.commit("side commit");
  fixture.git("checkout", "-q", "main");
  fixture.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  fixture.git("tag", "v1");
  fixture.git("tag", "-a", "v1-annotated", "-m", "annotated release");

  fixtureDb = new TestDatabase();
  const database = new SqliteGitDatabase(fixtureDb);
  const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
  await importFixture(fixture, store);
  repo = new Repository(store);
});

afterAll(() => fixture.dispose());

describe("rev-parse", () => {
  it("matches git for refs, suffixes and abbreviations", () => {
    for (const expression of [
      "HEAD",
      "main",
      "side",
      "v1",
      "HEAD~1",
      "HEAD~2",
      "HEAD^",
      "HEAD^2",
      "HEAD^1^",
      "refs/heads/main",
    ]) {
      expect(repo.revParse(expression), expression).toBe(fixture.git("rev-parse", expression));
    }
    const head = fixture.git("rev-parse", "HEAD");
    expect(repo.revParse(head.slice(0, 8))).toBe(head);
  });

  it("keeps annotated tag identity until an explicit peel", () => {
    const raw = repo.revParse("v1-annotated");
    const peeled = repo.revParse("v1-annotated^0");

    expect(raw).toBe(fixture.git("rev-parse", "v1-annotated"));
    expect(peeled).toBe(fixture.git("rev-parse", "v1-annotated^0"));
    expect(repo.typeOf(raw)).toBe("tag");
    expect(repo.typeOf(peeled)).toBe("commit");
    expect(raw).not.toBe(peeled);
  });

  it("matches typed peeling and revision paths while retaining entry modes", () => {
    for (const expression of [
      "v1-annotated^{}",
      "v1-annotated^{tag}",
      "v1-annotated^{commit}",
      "v1-annotated^{tree}",
      "v1-annotated~0",
      "v1-annotated^{}~2^{tree}",
      "HEAD^{commit}",
      "HEAD^{tree}",
      "HEAD:src/a.ts",
      "HEAD:src",
      "HEAD:",
    ]) {
      expect(repo.revParse(expression), expression).toBe(fixture.git("rev-parse", expression));
    }

    expect(repo.resolveRevision("HEAD:src/a.ts")).toEqual({
      oid: fixture.git("rev-parse", "HEAD:src/a.ts"),
      mode: "100644",
    });
    expect(repo.resolveRevision("HEAD:src")).toEqual({
      oid: fixture.git("rev-parse", "HEAD:src"),
      mode: "40000",
    });
  });

  it("returns undefined only for semantic absence", () => {
    const phantom = "f".repeat(40);
    expect(repo.tryRevParse("missing")).toBeUndefined();
    expect(repo.tryRevParse("deadbeef")).toBeUndefined();
    expect(repo.tryRevParse("HEAD:missing.txt")).toBeUndefined();
    expect(repo.tryRevParse(phantom)).toBe(phantom);
    expect(repo.tryRevParse(`${phantom}^{}`)).toBeUndefined();

    expect(() => repo.tryRevParse("HEAD^{blob}")).toThrow(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    expect(() => repo.tryRevParse("HEAD^{bogus}")).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => repo.tryRevParse("missing^{bogus}")).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(repo.tryRevParse(`HEAD${"^{}".repeat(32)}`)).toBe(repo.revParse("HEAD"));
    expect(() => repo.tryRevParse(`HEAD${"^{}".repeat(33)}`)).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => repo.tryRevParse(`missing${"~0".repeat(33)}`)).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("throws when stored revisions promise missing objects", () => {
    const db = new TestDatabase();
    const store = openScale(db);
    const local = new Repository(store);
    const missing = "f".repeat(40);
    const identity = {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: 1,
      timezoneOffset: 0,
    };
    const commit = (tree: string, parent: string[] = []): string =>
      store.write(
        "commit",
        serializeCommit({
          tree,
          parent,
          author: identity,
          committer: identity,
          message: "fixture\n",
        }),
      );

    store.setRef("refs/heads/main", missing);
    expect(() => local.tryRevParse("main")).toThrow(expect.objectContaining({ code: "ENOTFOUND" }));

    const emptyTree = store.write("tree", new Uint8Array(0));
    const missingParent = commit(emptyTree, [missing]);
    store.setRef("refs/heads/main", missingParent);
    expect(() => local.tryRevParse("main^")).toThrow(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );

    const missingTree = commit(missing);
    store.setRef("refs/heads/main", missingTree);
    expect(() => local.tryRevParse("main^{tree}")).toThrow(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );

    const danglingTag = store.write(
      "tag",
      serializeTag({
        object: missing,
        type: "commit",
        tag: "dangling",
        tagger: identity,
        message: "dangling\n",
      }),
    );
    store.setRef("refs/tags/dangling", danglingTag);
    expect(() => local.tryRevParse("dangling^{}")).toThrow(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );

    const missingEntryTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "missing.txt", oid: missing }]),
    );
    store.setRef("refs/heads/main", commit(missingEntryTree));
    expect(() => local.tryRevParse("main:missing.txt")).toThrow(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );

    const wrongEntryTree = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "wrong.txt", oid: emptyTree }]),
    );
    store.setRef("refs/heads/main", commit(wrongEntryTree));
    expect(() => local.tryRevParse("main:wrong.txt")).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("reports an unknown revision", () => {
    expect(() => repo.revParse("nope")).toThrow(/unknown revision/);
    expect(() => repo.revParse("HEAD~32")).toThrow(/unknown revision/);
    expect(() => repo.revParse("HEAD~33")).toThrow(expect.objectContaining({ code: "E2BIG" }));
  });

  it("accepts the former expression first excess", () => {
    const expression = `HEAD${" ".repeat(1_021)}`;
    expect(repo.revParse(expression)).toBe(repo.revParse("HEAD"));
  });

  it("bounds composed traversals and parses suffix decimals without numeric overflow", () => {
    expect(repo.revParse(`HEAD${"^0".repeat(32)}`)).toBe(repo.revParse("HEAD"));
    expect(() => repo.revParse(`HEAD${"^0".repeat(33)}`)).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => repo.revParse(`HEAD^${"9".repeat(1_019)}`)).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("reports the current branch", () => {
    expect(repo.head().ref).toBe("refs/heads/main");
    expect(repo.branches().sort()).toEqual(["main", "side"]);
    expect(repo.tags()).toEqual(["v1", "v1-annotated"]);
  });
});

describe("log", () => {
  it("visits the same commits git does", () => {
    const ours = log(repo).map((entry) => entry.oid);
    const theirs = fixture.git("rev-list", "HEAD").split("\n");
    expect(ours).toEqual(theirs);
  });

  it("honours depth", () => {
    expect(log(repo, { depth: 2 })).toHaveLength(2);
    expect(log(repo, { depth: 0 })).toHaveLength(1);
    expect(log(repo, { depth: -1 })).toHaveLength(1);
    expect(log(repo, { depth: 1.5 })).toHaveLength(2);
    expect(log(repo, { depth: Number.NaN })).toHaveLength(log(repo).length);
  });

  it("reads authorship the way git records it", () => {
    const head = show(repo, { ref: "HEAD" }).commit;
    expect(head.author.name).toBe("Fixture");
    expect(head.author.email).toBe("fixture@example.com");
    expect(head.author.timestamp).toBe(Number(fixture.git("show", "-s", "--format=%at", "HEAD")));
    expect(head.message.trim()).toBe("merge side");
    expect(head.parent).toHaveLength(2);
  });

  it("matches first-parent and literal path history without reading blob payloads", () => {
    const expected = (args: string[]): string[] => {
      const output = fixture.git("log", "--format=%H", ...args);
      return output === "" ? [] : output.split("\n");
    };

    expect(log(repo, { firstParent: true }).map((entry) => entry.oid)).toEqual(
      expected(["--first-parent"]),
    );
    for (const path of ["src/a.ts", "side.txt", "missing.txt"]) {
      expect(
        log(repo, { paths: [path] }).map((entry) => entry.oid),
        path,
      ).toEqual(expected(["--", path]));
    }
    expect(log(repo, { paths: ["src/a.ts"], depth: 1 }).map((entry) => entry.oid)).toEqual(
      expected(["-n", "1", "--", "src/a.ts"]),
    );
    expect(log(repo, { paths: ["side.txt"], firstParent: true }).map((entry) => entry.oid)).toEqual(
      expected(["--first-parent", "--", "side.txt"]),
    );

    fixtureDb.storage.histogram = new Map();
    fixtureDb.storage.resetCounters();
    log(repo, { paths: ["src/a.ts"] });
    expect([...fixtureDb.storage.histogram.keys()].join("\n")).not.toContain("git_object_chunks");
  });

  it("matches root, one-parent, and explicit merge-mainline patches", () => {
    const cases = [
      {
        ref: "HEAD~2",
        ours: show(repo, { ref: "HEAD~2", patch: true }).patch,
        theirs: fixture.git("show", "--format=", "--root", "HEAD~2"),
      },
      {
        ref: "HEAD^",
        ours: show(repo, { ref: "HEAD^", patch: true }).patch,
        theirs: fixture.git("show", "--format=", "HEAD^"),
      },
      {
        ref: "HEAD mainline 1",
        ours: show(repo, { ref: "HEAD", patch: true, mainline: 1 }).patch,
        theirs: fixture.git("show", "--format=", "--first-parent", "HEAD"),
      },
      {
        ref: "HEAD mainline 2",
        ours: show(repo, { ref: "HEAD", patch: true, mainline: 2 }).patch,
        theirs: fixture.git("diff", "HEAD^2", "HEAD"),
      },
    ];
    for (const entry of cases) expect(entry.ours?.trimEnd(), entry.ref).toBe(entry.theirs);
    expect(() => show(repo, { ref: "HEAD", patch: true })).toThrow(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("matches exact rename and move-plus-edit path selection without following names", async () => {
    const renamed = new GitFixture().init();
    try {
      renamed.write("old.txt", "content\n").commit("base");
      renamed.git("mv", "old.txt", "new.txt");
      renamed.commit("rename");
      renamed.git("mv", "new.txt", "moved.txt");
      renamed.write("moved.txt", "changed\n").commit("move and edit");
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
      await importFixture(renamed, store);
      const local = new Repository(store);
      for (const path of ["old.txt", "new.txt", "moved.txt"]) {
        const expected = renamed.git("log", "--format=%H", "--", path);
        expect(
          log(local, { paths: [path] }).map((entry) => entry.oid),
          path,
        ).toEqual(expected === "" ? [] : expected.split("\n"));
      }
    } finally {
      renamed.dispose();
    }
  });

  it("prunes a merge parent whose selected-path change was discarded", async () => {
    const merged = new GitFixture().init();
    try {
      merged.write("tracked.txt", "base\n").commit("base");
      merged.git("checkout", "-q", "-b", "side");
      merged.write("tracked.txt", "side\n");
      const discarded = merged.commit("discarded side change");
      merged.git("checkout", "-q", "main");
      merged.write("main.txt", "main\n").commit("main");
      merged.git("merge", "-q", "--no-ff", "-s", "ours", "-m", "discard side", "side");
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
      await importFixture(merged, store);
      const local = new Repository(store);
      const expected = merged.git("log", "--format=%H", "--", "tracked.txt").split("\n");
      const actual = log(local, { paths: ["tracked.txt"] }).map((entry) => entry.oid);
      expect(actual).toEqual(expected);
      expect(actual).not.toContain(discarded);
    } finally {
      merged.dispose();
    }
  });
});

describe("bounded commit graph reads", () => {
  it("preserves unborn HEAD and explicit missing-ref semantics", () => {
    const db = new TestDatabase();
    const repo = new Repository(openScale(db));

    expect(log(repo)).toEqual([]);
    expect(() => log(repo, { ref: "missing" })).toThrow(/unknown revision/);
  });

  it("fills 256 cold point misses in bounded batches and reuses them warm", () => {
    const { db, repo } = logFixture(256);
    db.run("DELETE FROM git_commits WHERE repo_id = ?", 1);
    db.storage.resetCounters();

    expect(log(repo, { depth: 256 })).toHaveLength(256);
    const cold = db.storage.statementCount;
    expect(cold).toBeLessThan(1_500);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_commits WHERE repo_id = ?", 1)).toBe(256);

    db.storage.resetCounters();
    expect(log(repo, { depth: 256 })).toHaveLength(256);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("uses one graph cursor for depth 257 and preserves every projected field", () => {
    const { db, repo } = logFixture(257);
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    const entries = log(repo, { depth: 257 });

    expect(entries).toHaveLength(257);
    expect(entries[0]?.message).toContain("\0tail");
    expect(entries[0]?.author.name).toBe("Au\0thor");
    expect(entries[0]?.parent).toHaveLength(1);
    const statements = [...db.storage.histogram.entries()];
    expect(
      statements.filter(([query]) => query.startsWith("WITH RECURSIVE params(repo_id, root_oid")),
    ).toHaveLength(1);
    expect(statements.map(([query]) => query).join("\n")).not.toContain("git_object_chunks");
    expect(db.storage.statementCount).toBeLessThan(1_000);

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    expect(log(repo, { depth: 257, firstParent: true })).toHaveLength(257);
    expect(
      [...db.storage.histogram.keys()].filter((query) =>
        query.startsWith("WITH RECURSIVE params(repo_id, root_oid"),
      ),
    ).toHaveLength(1);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("authenticates an unavailable deep cache through the uncached path", () => {
    const { db, repo, oids } = logFixture(257);
    db.run("DELETE FROM git_commits WHERE repo_id = ? AND oid = ?", 1, oids[0]);
    db.storage.histogram = new Map();
    db.storage.resetCounters();

    expect(log(repo, { depth: 257 })).toHaveLength(257);
    expect(
      db.storage.histogram.get(
        "WITH /* loose-object-payload */ wanted(ordinal, oid) AS ( SELECT CAST(key AS INTEGER), value FROM json_each(?) ) SELECT ",
      ),
    ).toBe(257);
  });

  it("rejects a coordinated cached cycle on point and indexed log paths", () => {
    const { repo, oids } = logFixture(2);
    const parent = oids[0];
    const root = oids[1];
    if (parent === undefined || root === undefined) throw new Error("cycle fixture is incomplete");
    const cached = repo.store.cachedCommit(parent);
    if (cached === null) throw new Error("cycle fixture cache is missing");
    const parents = [root];
    const changed: Commit = { ...cached.commit, parent: parents };
    repo.store.db.run(
      "UPDATE git_commits SET parents = ?, cache_bytes = ? WHERE repo_id = ? AND oid = ?",
      JSON.stringify(parents),
      commitCacheBytes(changed),
      1,
      parent,
    );

    expect(() => log(repo, { depth: 2 })).toThrow(/cycle/);
    expect(() => log(repo, { depth: 257 })).toThrow(/cycle/);
  });

  it("accepts DAG reuse on point and indexed log paths", () => {
    const { repo, oids } = logFixture(1);
    const base = oids[0];
    if (base === undefined) throw new Error("DAG fixture base is missing");
    const write = (message: string, parent: string[], timestamp: number): string =>
      repo.store.write(
        "commit",
        serializeCommit({
          tree: "1".repeat(40),
          parent,
          author: {
            name: "Author",
            email: "author@example.test",
            timestamp,
            timezoneOffset: 0,
          },
          committer: {
            name: "Committer",
            email: "committer@example.test",
            timestamp,
            timezoneOffset: 0,
          },
          message,
        }),
      );
    const left = write("left\n", [base], 1);
    const right = write("right\n", [base], 2);
    const root = write("root\n", [left, right], 3);
    repo.store.setRef("refs/heads/main", root);

    expect(log(repo, { depth: 2 })).toHaveLength(2);
    expect(log(repo, { depth: 257 }).map((entry) => entry.oid)).toEqual([root, right, left, base]);
  });

  it("walks 1,000 indexed commits under the working-set wall gate", () => {
    const { db, repo } = logFixture(1_000);
    db.storage.resetCounters();
    const started = performance.now();
    expect(log(repo)).toHaveLength(1_000);
    const elapsed = performance.now() - started;

    expect(db.storage.statementCount).toBeLessThan(1_000);
    if (timingGate) expect(elapsed).toBeLessThan(100);
  });
});

describe("ls-tree and cat-file", () => {
  it("exposes bounded blob batches through Repository", () => {
    const firstData = utf8.encode("first\n");
    const secondData = utf8.encode("second\n");
    const first = repo.store.write("blob", firstData);
    const second = repo.store.write("blob", secondData);
    expect(repo.readBlobs([first, second, first], { budgetBytes: firstData.length })).toEqual({
      blobs: new Map([[first, firstData]]),
      remaining: [second],
      bytes: firstData.length,
    });
  });

  it("lists one level like git", () => {
    const ours = lsTree(repo, "HEAD").map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`);
    const theirs = fixture.git("ls-tree", "HEAD").split("\n");
    expect(ours).toEqual(theirs);
  });

  it("lists a subdirectory", () => {
    const ours = lsTree(repo, "HEAD", "src").map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`);
    const theirs = fixture.git("-c", "core.quotePath=false", "ls-tree", "HEAD", "src/").split("\n");
    expect(ours).toEqual(theirs);
  });

  it("lists recursive entries in Git path order with one traversal statement", () => {
    fixtureDb.storage.histogram = new Map();
    fixtureDb.storage.resetCounters();

    const ours = lsTree(repo, "HEAD", "", { recursive: true }).map(
      (entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}`,
    );
    const theirs = fixture.git("-c", "core.quotePath=false", "ls-tree", "-r", "HEAD").split("\n");
    expect(ours).toEqual(theirs);
    const walkStatements = [...fixtureDb.storage.histogram].filter(([query]) =>
      query.startsWith("WITH RECURSIVE params(repo_id, root_oid"),
    );
    expect(walkStatements).toEqual([[expect.any(String), 1]]);

    const database = new SqliteGitDatabase(fixtureDb);
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("cold repository is missing");
    const cold = new Repository(database.openCheckout(checkout));
    expect(lsTree(cold, "HEAD", "src", { recursive: true })).toEqual(
      lsTree(repo, "HEAD", "src", { recursive: true }),
    );
  });

  it("preserves recursive gitlinks as commit entries", async () => {
    const gitlink = new GitFixture().init();
    try {
      gitlink.write("base.txt", "base\n");
      const target = gitlink.commit("base");
      gitlink.git("update-index", "--add", "--cacheinfo", `160000,${target},vendor/module`);
      gitlink.git("commit", "-q", "-m", "add gitlink");
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      );
      await importFixture(gitlink, store);

      const ours = lsTree(new Repository(store), "HEAD", "", { recursive: true }).map(
        (entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.path}`,
      );
      expect(ours).toEqual(gitlink.git("ls-tree", "-r", "HEAD").split("\n"));
      expect(ours.some((entry) => entry.startsWith("160000 commit "))).toBe(true);
    } finally {
      gitlink.dispose();
    }
  });

  it("keeps the recursive structural limit without truncating results", () => {
    const entry = { mode: MODE_FILE, name: "leaf", oid: "1".repeat(40) };
    const rows = function* (count: number, path: string) {
      for (let index = 0; index < count; index++) yield { path, entry };
    };

    expect(collectRecursiveTreeEntries(rows(MAX_LS_TREE_ENTRIES, "x"))).toHaveLength(
      MAX_LS_TREE_ENTRIES,
    );
    expect(() => collectRecursiveTreeEntries(rows(MAX_LS_TREE_ENTRIES + 1, "x"))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    expect(collectRecursiveTreeEntries(rows(8_192, "x".repeat(900)))).toHaveLength(8_192);
  });

  it("projects nonrecursive entries", () => {
    const entries = [
      { mode: MODE_FILE, name: "a.txt", oid: "1".repeat(40) },
      { mode: MODE_FILE, name: "long-name.txt", oid: "2".repeat(40) },
    ];
    const expected = collectDirectTreeEntries(entries, "dir/");

    expect(collectDirectTreeEntries(entries, "dir/")).toEqual(expected);
  });

  it("materializes an authenticated nonrecursive source", () => {
    const db = new TestDatabase();
    const store = openScale(db);
    const tree = serializeTree([
      { mode: MODE_FILE, name: "a.txt", oid: numberedOid(1) },
      { mode: MODE_FILE, name: "long-name.txt", oid: numberedOid(2) },
    ]);
    const treeOid = store.write("tree", tree);
    const local = new Repository(store);
    const expected = [
      { mode: "100644", path: "a.txt", oid: numberedOid(1), type: "blob" },
      { mode: "100644", path: "long-name.txt", oid: numberedOid(2), type: "blob" },
    ];

    expect(lsTree(local, treeOid)).toEqual(expected);
    expect(local.store.cacheBytes().objects).toBe(0);
    expect(store.readAuthenticatedObject(treeOid, "tree")?.data).toEqual(tree);
    expect(local.store.cacheBytes().objects).toBe(0);
  });

  it("materializes a packed authenticated nonrecursive source", async () => {
    const db = new TestDatabase();
    const setup = openScale(db);
    const tree = serializeTree([
      { mode: MODE_FILE, name: "a.txt", oid: numberedOid(1) },
      { mode: MODE_FILE, name: "long-name.txt", oid: numberedOid(2) },
    ]);
    const treeOid = hashObject("tree", tree);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", tree);
    writer.finish();
    const pack = concat(chunks);
    await setup.packs.ingest(slices(pack, 64));

    const database = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("packed ls-tree checkout disappeared");
    const store = database.openCheckout(checkout);
    const local = new Repository(store);
    const expected = [
      { mode: "100644", path: "a.txt", oid: numberedOid(1), type: "blob" },
      { mode: "100644", path: "long-name.txt", oid: numberedOid(2), type: "blob" },
    ];

    expect(lsTree(local, treeOid)).toEqual(expected);
    expect(store.cacheBytes()).toEqual({ objects: 0, chunks: 0 });
  });

  it("rejects a cold corrupt packed source", async () => {
    const db = new TestDatabase();
    const setup = openScale(db);
    const tree = serializeTree([
      { mode: MODE_FILE, name: "a.txt", oid: numberedOid(1) },
      { mode: MODE_FILE, name: "long-name.txt", oid: numberedOid(2) },
    ]);
    const treeOid = hashObject("tree", tree);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", tree);
    writer.finish();
    await setup.packs.ingest(slices(concat(chunks), 64));

    const source = db.one<{ data_off: number; data: unknown }>(
      `SELECT object.data_off, data.data
         FROM git_pack_objects object
         JOIN git_pack_data data
           ON data.repo_id = object.repo_id AND data.pack_id = object.pack_id AND data.seq = 0
        WHERE object.repo_id = ? AND object.oid = ?`,
      1,
      treeOid,
    );
    if (source === undefined || !Number.isSafeInteger(source.data_off)) {
      throw new Error("packed corrupt-source fixture is incomplete");
    }
    const corrupted = readBlob(source.data).slice();
    if (source.data_off < 0 || source.data_off >= corrupted.length) {
      throw new Error("packed corrupt-source offset is invalid");
    }
    corrupted[source.data_off] = corrupted[source.data_off]! ^ 0xff;
    db.run(
      "UPDATE git_pack_data SET data = ? WHERE repo_id = ? AND pack_id = 1 AND seq = 0",
      corrupted,
      1,
    );

    const database = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("packed corrupt-source checkout disappeared");
    const store = database.openCheckout(checkout);
    const histogram = new Map<string, number>();
    db.storage.histogram = histogram;
    db.storage.resetCounters();
    expect(() => readAuthenticatedObjectOwned(store.shared, treeOid, "tree")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(
      [...histogram.keys()].some((query) => query.startsWith("WITH requested(pack_id, seq)")),
    ).toBe(true);
    expect(store.cacheBytes()).toEqual({ objects: 0, chunks: 0 });
  });

  it("lists every path in a tree", () => {
    expect(lsFilesAtRef(repo, "HEAD")).toEqual(
      fixture.git("-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "HEAD").split("\n"),
    );
  });

  it("reads a blob through the <ref>:<path> shorthand", () => {
    const result = catFile(repo, "HEAD:src/a.ts");
    expect(utf8Decoder.decode(result.bytes)).toBe("export const a = 2;\n");
    expect(result.type).toBe("blob");
  });
});

interface TreeScale {
  root: string;
  objects: Uint8Array[];
}

function numberedOid(value: number): string {
  return value.toString(16).padStart(40, "0");
}

/** Unique trees spread over the same 13 generations as the target fixture. */
function treeScale(leafCount = 3_334): TreeScale {
  const internalCount = 12;
  const leaves: { oid: string; data: Uint8Array }[] = [];
  for (let i = 0; i < leafCount; i++) {
    const data = serializeTree([
      { mode: MODE_FILE, name: `file-${i}.txt`, oid: numberedOid(i + 1) },
    ]);
    leaves.push({ oid: hashObject("tree", data), data });
  }

  const internal: Uint8Array[] = [];
  let child: string | null = null;
  for (let level = internalCount - 1; level >= 0; level--) {
    const start = Math.floor((level * leafCount) / internalCount);
    const end = Math.floor(((level + 1) * leafCount) / internalCount);
    const entries = leaves.slice(start, end).map((leaf, at) => ({
      mode: MODE_TREE,
      name: `leaf-${String(start + at).padStart(4, "0")}`,
      oid: leaf.oid,
    }));
    if (child !== null) entries.push({ mode: MODE_TREE, name: "spine", oid: child });
    const data = serializeTree(entries);
    internal.unshift(data);
    child = hashObject("tree", data);
  }
  if (child === null) throw new Error("tree scale has no root");
  return { root: child, objects: [...leaves.map((leaf) => leaf.data), ...internal] };
}

class BindingDatabase implements SqlDatabase {
  widestBindings = 0;
  maxResultBytes = 0;

  constructor(readonly inner = new TestDatabase()) {}

  #measure(bindings: unknown[]): void {
    this.widestBindings = Math.max(this.widestBindings, bindings.length);
  }

  #measureResult(rows: readonly object[]): void {
    let bytes = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) bytes += value.byteLength;
        else if (value instanceof ArrayBuffer) bytes += value.byteLength;
      }
    }
    this.maxResultBytes = Math.max(this.maxResultBytes, bytes);
  }

  run(query: string, ...bindings: unknown[]): void {
    this.#measure(bindings);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#measure(bindings);
    const rows = this.inner.all<Row>(query, ...bindings);
    this.#measureResult(rows);
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#measure(bindings);
    const row = this.inner.one<Row>(query, ...bindings);
    if (row !== undefined) this.#measureResult([row]);
    return row;
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#measure(bindings);
    return this.inner.scalar<T>(query, ...bindings);
  }

  *iterate(query: string, ...bindings: unknown[]): Generator<Record<string, unknown>> {
    this.#measure(bindings);
    for (const row of this.inner.iterate(query, ...bindings)) {
      this.#measureResult([row]);
      yield row;
    }
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function openScale(db: SqlDatabase) {
  const database = new SqliteGitDatabase(db);
  const row = database.createRepository("/repo", "ref: refs/heads/main");
  return database.openCheckout(row);
}

function reopenScale(db: SqlDatabase): Repository {
  const database = new SqliteGitDatabase(db);
  const row = database.findCheckout("/repo");
  if (row === null) throw new Error("scale repository is missing");
  return new Repository(database.openCheckout(row));
}

function logFixture(count: number): {
  db: TestDatabase;
  repo: Repository;
  oids: string[];
} {
  const db = new TestDatabase();
  const store = openScale(db);
  const oids = store.writeObjects((batch) => {
    const written: string[] = [];
    for (let index = 0; index < count; index++) {
      const commit: Commit = {
        tree: "1".repeat(40),
        parent: written.length === 0 ? [] : [written[written.length - 1]!],
        author: {
          name: index === count - 1 ? "Au\0thor" : "Author",
          email: "author@example.test",
          timestamp: index,
          timezoneOffset: -60,
        },
        committer: {
          name: "Committer",
          email: "committer@example.test",
          timestamp: index,
          timezoneOffset: 90,
        },
        message: `commit ${index}\0tail\n`,
        gpgsig: index === count - 1 ? "signature\0tail" : undefined,
      };
      written.push(batch.write("commit", serializeCommit(commit)));
    }
    return written;
  });
  const head = oids[oids.length - 1];
  if (head === undefined) throw new Error("log fixture needs at least one commit");
  store.setRef("refs/heads/main", head);
  return { db, repo: new Repository(store), oids };
}

function* legacyWalk(
  repo: Repository,
  oid: string,
  prefix = "",
): Generator<{ path: string; mode: string; oid: string }> {
  for (const entry of repo.readTree(oid)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) yield* legacyWalk(repo, entry.oid, path);
    else yield { path, mode: entry.mode, oid: entry.oid };
  }
}

describe("batched tree reads", () => {
  it("does no work before first next and yields no BLOB column", () => {
    const db = new BindingDatabase();
    const store = openScale(db);
    const oid = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "file", oid: numberedOid(1) }]),
    );
    db.inner.storage.resetCounters();
    db.maxResultBytes = 0;
    const iterator = store.walkTree(oid);

    expect(db.inner.storage.statementCount).toBe(0);
    expect(iterator.next()).toEqual({
      done: false,
      value: { path: "file", mode: MODE_FILE, oid: numberedOid(1) },
    });
    expect(db.inner.storage.statementCount).toBe(1);
    expect(db.maxResultBytes).toBe(0);
  });

  it("preserves walkTree's packed traversal order", () => {
    const tree = repo.headTree();
    if (tree === null) throw new Error("fixture has no HEAD tree");
    const expected = [...repo.walkTree(tree)].map(({ path, entry }) => ({
      path,
      mode: entry.mode,
      oid: entry.oid,
    }));
    expect([...treeStream(repo, tree)]).toEqual(expected);
  });

  it("preserves walkTree's commit-oid shorthand", () => {
    const head = repo.head().oid;
    if (head === null) throw new Error("fixture has no HEAD");
    const expected = [...repo.walkTree(head)].map(({ path, entry }) => ({
      path,
      mode: entry.mode,
      oid: entry.oid,
    }));
    expect([...treeStream(repo, head)]).toEqual(expected);
  });

  it("prefers a packed delta base over a corrupt loose duplicate", async () => {
    const base = serializeTree([{ mode: MODE_FILE, name: "a", oid: numberedOid(1) }]);
    const baseOid = hashObject("tree", base);
    const target = serializeTree([
      { mode: MODE_FILE, name: "a", oid: numberedOid(1) },
      { mode: MODE_FILE, name: "b", oid: numberedOid(2) },
    ]);
    const targetOid = hashObject("tree", target);
    const delta = concat([
      encodeDeltaHeader(base.length, target.length),
      new Uint8Array([target.length]),
      target,
    ]);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("tree", base);
    writer.refDelta(baseOid, delta);
    writer.finish();

    const db = new TestDatabase();
    const store = openScale(db);
    await store.packs.ingest(slices(concat(chunks), 64));
    db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size) VALUES (1, ?, 'tree', ?)",
      baseOid,
      base.length,
    );
    db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (1, ?, 0, ?)",
      baseOid,
      new Uint8Array([0]),
    );
    const cold = reopenScale(db);
    db.storage.resetCounters();

    expect([...treeStream(cold, targetOid)]).toEqual([
      { path: "a", mode: MODE_FILE, oid: numberedOid(1) },
      { path: "b", mode: MODE_FILE, oid: numberedOid(2) },
    ]);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("does not fall through a corrupt loose-shadowed requested object", async () => {
    const tree = serializeTree([{ mode: MODE_FILE, name: "a", oid: numberedOid(1) }]);
    const oid = hashObject("tree", tree);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", tree);
    writer.finish();
    const db = new TestDatabase();
    const store = openScale(db);
    await store.packs.ingest(slices(concat(chunks), 64));
    db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size) VALUES (1, ?, 'tree', ?)",
      oid,
      tree.length,
    );
    db.run(
      "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (1, ?, 0, ?)",
      oid,
      new Uint8Array([0]),
    );

    expect(() => [...treeStream(reopenScale(db), oid)]).toThrow();
  });

  it("reads shuffled trees from a 16 MB pack in physical order", async () => {
    const count = 500;
    const children = Array.from({ length: count }, (_, index) => {
      const data = serializeTree([
        { mode: MODE_FILE, name: `file-${index}`, oid: numberedOid(index + 1) },
      ]);
      return { index, data, oid: hashObject("tree", data) };
    });
    const root = serializeTree(
      children.map((child) => ({
        mode: MODE_TREE,
        name: `dir-${String(child.index).padStart(3, "0")}`,
        oid: child.oid,
      })),
    );
    const rootOid = hashObject("tree", root);
    const physical = Array.from({ length: 8 }, (_, group) =>
      children.filter((child) => child.index % 8 === group),
    ).flat();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(count * 2 + 1);
    for (const child of physical) {
      writer.object("tree", child.data);
      writer.object("blob", new Uint8Array(randomBytes(32 * 1024)));
    }
    writer.object("tree", root);
    writer.finish();

    const db = new BindingDatabase();
    const store = openScale(db);
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    const cold = reopenScale(db);
    db.inner.storage.resetCounters();
    db.widestBindings = 0;
    db.maxResultBytes = 0;

    const actual = [...treeStream(cold, rootOid)];
    expect(actual).toEqual(
      children.map((child) => ({
        path: `dir-${String(child.index).padStart(3, "0")}/file-${child.index}`,
        mode: MODE_FILE,
        oid: numberedOid(child.index + 1),
      })),
    );
    expect(db.inner.storage.statementCount).toBeLessThan(1_000);
    expect(db.widestBindings).toBeLessThanOrEqual(100);
    expect(db.maxResultBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(cold.store.cacheBytes().chunks).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(cold.store.cacheBytes().objects).toBeLessThanOrEqual(16 * 1024 * 1024);
  }, 90_000);

  it.each(["loose", "packed"])(
    "reads a 3,346-tree %s HEAD within the statement target with exact parity",
    async (storage) => {
      const scale = treeScale();
      const db = new TestDatabase();
      const store = openScale(db);
      if (storage === "loose") {
        store.writeObjects((batch) => {
          for (const data of scale.objects) batch.write("tree", data);
        });
      } else {
        const chunks: Uint8Array[] = [];
        const writer = new PackWriter((chunk) => chunks.push(chunk));
        writer.header(scale.objects.length);
        for (const data of scale.objects) writer.object("tree", data);
        writer.finish();
        await store.packs.ingest(slices(concat(chunks), 64 * 1024));
      }

      const scalar = reopenScale(db);
      db.storage.resetCounters();
      const expected = [...legacyWalk(scalar, scale.root)];
      const batched = reopenScale(db);
      db.storage.resetCounters();
      const actual = [...treeStream(batched, scale.root)];
      const statements = db.storage.statementCount;

      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(3_334);
      expect(statements).toBeLessThan(1_000);

      db.storage.resetCounters();
      expect([...treeStream(batched, scale.root)]).toEqual(actual);
      expect(db.storage.statementCount).toBeLessThan(1_000);
    },
    30_000,
  );

  it("scales by depth rather than tree count", () => {
    const measure = (leafCount: number): number => {
      const scale = treeScale(leafCount);
      const db = new TestDatabase();
      const store = openScale(db);
      store.writeObjects((batch) => {
        for (const data of scale.objects) batch.write("tree", data);
      });
      const cold = reopenScale(db);
      db.storage.resetCounters();
      expect([...treeStream(cold, scale.root)]).toHaveLength(leafCount);
      return db.storage.statementCount;
    };

    expect(measure(322)).toBeLessThan(1_000);
    expect(measure(3_334)).toBeLessThan(1_000);
  });

  const deepTree = (depth: number, leaf: string) => {
    const db = new TestDatabase();
    const store = openScale(db);
    const leafOid = "f".repeat(40);
    let child = store.write("tree", serializeTree([{ mode: MODE_FILE, name: leaf, oid: leafOid }]));
    for (let at = 0; at < depth; at++) {
      child = store.write("tree", serializeTree([{ mode: MODE_TREE, name: "d", oid: child }]));
    }
    return { db, store, root: child, leafOid };
  };

  const packedDeepTree = async (depth: number, leaf: string) => {
    const db = new TestDatabase();
    const store = openScale(db);
    const leafOid = "f".repeat(40);
    const objects: Uint8Array[] = [];
    let data = serializeTree([{ mode: MODE_FILE, name: leaf, oid: leafOid }]);
    objects.push(data);
    let root = hashObject("tree", data);
    for (let at = 0; at < depth; at++) {
      data = serializeTree([{ mode: MODE_TREE, name: "d", oid: root }]);
      objects.push(data);
      root = hashObject("tree", data);
    }
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(objects.length);
    for (const object of objects) writer.object("tree", object);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    return { db, store, root, leafOid };
  };

  it("accepts a 2,200-byte path repeatedly under the working-set wall gate", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { db, store, root, leafOid } = deepTree(1_098, "leaf");
      db.storage.resetCounters();
      const started = performance.now();
      const entries = [...store.walkTree(root)];
      const elapsed = performance.now() - started;

      expect(entries).toEqual([
        { path: `${"d/".repeat(1_098)}leaf`, mode: MODE_FILE, oid: leafOid },
      ]);
      expect(db.storage.statementCount).toBeLessThan(1_000);
      if (timingGate) expect(elapsed).toBeLessThan(100);
    }
  }, 30_000);

  it("accepts a packed 2,200-byte path repeatedly under the wall gate", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { db, store, root, leafOid } = await packedDeepTree(1_098, "leaf");
      db.storage.resetCounters();
      const started = performance.now();
      const entries = [...store.walkTree(root)];
      const elapsed = performance.now() - started;

      expect(entries).toEqual([
        { path: `${"d/".repeat(1_098)}leaf`, mode: MODE_FILE, oid: leafOid },
      ]);
      expect(db.storage.statementCount).toBeLessThan(1_000);
      if (timingGate) expect(elapsed).toBeLessThan(100);
    }
  }, 30_000);

  it("authenticates the former 2,201-byte excess", () => {
    const { db, store, root, leafOid } = deepTree(1_099, "lea");
    db.storage.resetCounters();
    const started = performance.now();
    const entries = [...store.walkTree(root)];
    const elapsed = performance.now() - started;

    expect(entries).toEqual([{ path: `${"d/".repeat(1_099)}lea`, mode: MODE_FILE, oid: leafOid }]);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    if (timingGate) expect(elapsed).toBeLessThan(100);
  }, 30_000);

  it("projects a shallow ASCII path within the fixed traversal cap", () => {
    const db = new TraversalPayloadProbeDatabase();
    const store = openScale(db);
    const name = "x".repeat(512 * 1024);
    const leafOid = numberedOid(1);
    const root = store.write("tree", serializeTree([{ mode: MODE_FILE, name, oid: leafOid }]));
    const expected = [{ path: name, mode: MODE_FILE, oid: leafOid }];

    db.resetTraversalProbe();
    expect([...store.walkTree(root)]).toEqual(expected);
    expect(db.traversalPayloadRows).toBe(1);
    expect(db.traversalClosures).toBe(1);
  });

  const longQueue = (count: number) => {
    const db = new TestDatabase();
    const store = openScale(db);
    const root = store.write(
      "tree",
      serializeTree(
        Array.from({ length: count }, (_, at) => ({
          mode: MODE_FILE,
          name: `${String(at).padStart(4, "0")}-${"x".repeat(1_995)}`,
          oid: numberedOid(at + 1),
        })),
      ),
    );
    return { db, store, root };
  };

  it("bounds the whole priority queue at the exact long-row suffix boundary", () => {
    const accepted = longQueue(7_332);
    accepted.db.storage.resetCounters();
    expect([...accepted.store.walkTree(accepted.root)]).toHaveLength(7_332);
    expect(accepted.db.storage.statementCount).toBeLessThan(1_000);

    const rejected = longQueue(7_333);
    rejected.db.storage.resetCounters();
    expect(() => [...rejected.store.walkTree(rejected.root)]).toThrow(/queue exceeds 16 MiB/);
    expect(rejected.db.storage.statementCount).toBeLessThan(1_000);
  }, 30_000);

  it("reclaims queue bytes independently of which deep sibling sorts last", () => {
    const walk = (reverse: boolean) => {
      const db = new TestDatabase();
      const store = openScale(db);
      const branch = (leafOid: string) => {
        let oid = store.write(
          "tree",
          serializeTree([{ mode: MODE_FILE, name: "leaf", oid: leafOid }]),
        );
        for (let depth = 0; depth < 100; depth++) {
          oid = store.write("tree", serializeTree([{ mode: MODE_TREE, name: "d", oid }]));
        }
        return oid;
      };
      const first = branch(numberedOid(1));
      const second = branch(numberedOid(2));
      const root = store.write(
        "tree",
        serializeTree([
          { mode: MODE_TREE, name: "a", oid: reverse ? second : first },
          { mode: MODE_TREE, name: "z", oid: reverse ? first : second },
        ]),
      );
      db.storage.resetCounters();
      const entries = [...store.walkTree(root)];
      expect(db.storage.statementCount).toBeLessThan(1_000);
      return entries.map((entry) => entry.path);
    };

    expect(walk(false)).toEqual(walk(true));
  });

  it("rejects an active-stack tree cycle but permits DAG reuse", () => {
    const db = new TestDatabase();
    const store = openScale(db);
    const leafOid = "e".repeat(40);
    const child = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "leaf", oid: leafOid }]),
    );
    const root = store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "a", oid: child },
        { mode: MODE_TREE, name: "b", oid: child },
      ]),
    );
    expect([...store.walkTree(root)]).toEqual([
      { path: "a/leaf", mode: MODE_FILE, oid: leafOid },
      { path: "b/leaf", mode: MODE_FILE, oid: leafOid },
    ]);

    db.run(
      `UPDATE git_tree_entries SET oid = ?
        WHERE source_key = (
          SELECT source_key FROM git_tree_sources
           WHERE repo_id = 1 AND tree_oid = ? AND storage = 'loose' AND source_id = 0
        ) AND ordinal = 0`,
      root,
      root,
    );
    expect(() => [...store.walkTree(root)]).toThrow(/tree cycle/);
  });

  it("rejects an effective tree repointed to a same-shaped source identity", () => {
    const db = new TestDatabase();
    const store = openScale(db);
    const first = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "a", oid: numberedOid(1) }]),
    );
    const second = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "b", oid: numberedOid(2) }]),
    );
    const secondSource = db.scalar<number>(
      "SELECT source_key FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
      second,
    );
    if (secondSource === undefined) throw new Error("second tree source is missing");
    expect(() =>
      db.run(
        "UPDATE git_tree_effective SET source_key = ? WHERE repo_id = 1 AND tree_oid = ?",
        secondSource,
        first,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("projects tree traversal rows without BLOB payloads", () => {
    const db = new BindingDatabase();
    const store = openScale(db);
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: numberedOid(1) }]);
    const oid = store.write("tree", data);
    db.maxResultBytes = 0;

    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: numberedOid(1) }]);
    expect(db.maxResultBytes).toBe(0);
  });

  it("uses the tree-entry primary key without an outer temporary sort", () => {
    const db = new TestDatabase();
    openScale(db);
    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${WALK_TREE_SQL}`,
        1,
        "0".repeat(40),
        TREE_WALK_PATH_BYTES,
        TREE_WALK_STATE_BYTES,
        16 * 1024 * 1024,
        192,
      )
      .map((row) => row.detail);

    expect(plan.some((detail) => /SEARCH e USING PRIMARY KEY/.test(detail))).toBe(true);
    expect(plan.some((detail) => /TEMP B-TREE FOR ORDER BY/.test(detail))).toBe(false);
  });

  it("streams 50,002 packed entries with one SQL statement", async () => {
    const count = 50_002;
    const data = serializeTree(
      Array.from({ length: count }, (_, at) => ({
        mode: MODE_FILE,
        name: `f-${String(at).padStart(5, "0")}`,
        oid: numberedOid(at + 1),
      })),
    );
    const oid = hashObject("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const db = new TestDatabase();
    const store = openScale(db);
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));
    db.storage.resetCounters();

    let seen = 0;
    for (const entry of store.walkTree(oid)) {
      expect(entry.path).toBe(`f-${String(seen).padStart(5, "0")}`);
      seen++;
    }
    expect(seen).toBe(count);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  }, 30_000);

  it("streams 1,000 entries under the working-set wall gate", () => {
    const count = 1_000;
    const data = serializeTree(
      Array.from({ length: count }, (_, at) => ({
        mode: MODE_FILE,
        name: `f-${String(at).padStart(4, "0")}`,
        oid: numberedOid(at + 1),
      })),
    );
    const db = new TestDatabase();
    const store = openScale(db);
    const oid = store.write("tree", data);
    db.storage.resetCounters();
    const started = performance.now();
    expect([...store.walkTree(oid)]).toHaveLength(count);
    const elapsed = performance.now() - started;

    expect(db.storage.statementCount).toBeLessThan(1_000);
    if (timingGate) expect(elapsed).toBeLessThan(100);
  });
});
