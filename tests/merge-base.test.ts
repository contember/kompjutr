import { describe, expect, it } from "vitest";

import {
  MAX_MERGE_BASES,
  MERGE_BASE_SQL_STATEMENTS,
  selectMergeBases,
} from "../src/core/ops/merge-base.js";
import { Repository } from "../src/core/repository.js";
import { type RepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

interface Harness {
  db: TestDatabase;
  store: RepoStore;
  repo: Repository;
}

function harness(): Harness {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const store = database.open(database.create("/repo", "ref: refs/heads/main"));
  return { db, store, repo: new Repository(store, "/repo") };
}

function importCommits(store: RepoStore, fixture: GitFixture, oids: readonly string[]): void {
  const seen = new Set<string>();
  for (const oid of oids) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    expect(store.write("commit", fixture.catFile(oid))).toBe(oid);
  }
}

function importReachable(store: RepoStore, fixture: GitFixture, tips: readonly string[]): void {
  const output = fixture.git("rev-list", ...tips);
  importCommits(store, fixture, output === "" ? [] : output.split("\n"));
}

function compareOids(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function gitBases(fixture: GitFixture, left: string, right: string): string[] {
  const output = fixture.git("merge-base", "--all", left, right);
  return output === "" ? [] : output.split("\n").sort(compareOids);
}

function divergentFixture(): {
  fixture: GitFixture;
  base: string;
  current: string;
  incoming: string;
} {
  const fixture = new GitFixture().init();
  fixture.write("file", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "current", base);
  fixture.write("current", "current\n");
  const current = fixture.commit("current");
  fixture.git("checkout", "-q", "-b", "incoming", base);
  fixture.write("incoming", "incoming\n");
  const incoming = fixture.commit("incoming");
  return { fixture, base, current, incoming };
}

describe("bounded merge-base selection", () => {
  it("matches Git for already-merged and fast-forward histories", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "one\n");
      const first = fixture.commit("first");
      fixture.write("file", "two\n");
      const second = fixture.commit("second");
      fixture.write("file", "three\n");
      const third = fixture.commit("third");
      const { db, store, repo } = harness();
      importReachable(store, fixture, [third]);
      db.storage.resetCounters();

      expect(fixture.git("merge-base", "--is-ancestor", second, third)).toBe("");
      expect(selectMergeBases(repo, { currentOid: second, incomingOid: third })).toMatchObject({
        kind: "fast-forward",
        bases: [second],
        commits: 3,
        sqlStatements: MERGE_BASE_SQL_STATEMENTS,
      });
      expect(db.storage.statementCount).toBe(MERGE_BASE_SQL_STATEMENTS);

      expect(fixture.git("merge-base", "--is-ancestor", second, third)).toBe("");
      expect(
        selectMergeBases(new Repository(store, "/repo"), {
          currentOid: third,
          incomingOid: second,
        }),
      ).toMatchObject({ kind: "already-merged", bases: [second], commits: 3 });
      expect(gitBases(fixture, first, third)).toEqual([first]);
    } finally {
      fixture.dispose();
    }
  });

  it("returns only the best common ancestor for a divergent graph", () => {
    const { fixture, base, current, incoming } = divergentFixture();
    try {
      const { store, repo } = harness();
      importReachable(store, fixture, [current, incoming]);
      const selection = selectMergeBases(repo, { currentOid: current, incomingOid: incoming });

      expect(gitBases(fixture, current, incoming)).toEqual([base]);
      expect(selection).toMatchObject({ kind: "divergent", bases: [base], commits: 3 });
    } finally {
      fixture.dispose();
    }
  });

  it("distinguishes unrelated histories from a shallow proof boundary", () => {
    const unrelated = new GitFixture().init();
    try {
      unrelated.write("main", "main\n");
      const current = unrelated.commit("main");
      unrelated.git("checkout", "-q", "--orphan", "incoming");
      unrelated.remove("main");
      unrelated.write("incoming", "incoming\n");
      const incoming = unrelated.commit("incoming");
      const unrelatedHarness = harness();
      importReachable(unrelatedHarness.store, unrelated, [current, incoming]);

      expect(() => unrelated.git("merge-base", "--all", current, incoming)).toThrow();
      expect(
        selectMergeBases(unrelatedHarness.repo, { currentOid: current, incomingOid: incoming }),
      ).toMatchObject({ kind: "unrelated", bases: [], commits: 2 });
    } finally {
      unrelated.dispose();
    }

    const shallow = divergentFixture();
    try {
      const shallowHarness = harness();
      importReachable(shallowHarness.store, shallow.fixture, [shallow.current, shallow.incoming]);
      shallowHarness.store.setShallow([shallow.current]);
      shallowHarness.repo.invalidateShallow();
      shallow.fixture.write(".git/shallow", `${shallow.current}\n`);

      expect(() => gitBases(shallow.fixture, shallow.current, shallow.incoming)).toThrow();
      expect(
        selectMergeBases(shallowHarness.repo, {
          currentOid: shallow.current,
          incomingOid: shallow.incoming,
        }),
      ).toMatchObject({ kind: "shallow", bases: [], commits: 3 });
    } finally {
      shallow.fixture.dispose();
    }
  });

  it("matches every best base in a criss-cross graph in deterministic order", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "base\n");
      const root = fixture.commit("root");
      fixture.git("checkout", "-q", "-b", "left", root);
      fixture.write("left", "left\n");
      const left = fixture.commit("left");
      fixture.git("checkout", "-q", "-b", "right", root);
      fixture.write("right", "right\n");
      const right = fixture.commit("right");
      const leftTree = fixture.git("show", "-s", "--format=%T", left);
      const rightTree = fixture.git("show", "-s", "--format=%T", right);
      const current = fixture.git(
        "commit-tree",
        leftTree,
        "-p",
        left,
        "-p",
        right,
        "-m",
        "left merge",
      );
      const incoming = fixture.git(
        "commit-tree",
        rightTree,
        "-p",
        right,
        "-p",
        left,
        "-m",
        "right merge",
      );
      const { store, repo } = harness();
      importReachable(store, fixture, [current, incoming]);
      const expected = gitBases(fixture, current, incoming);
      const selection = selectMergeBases(repo, { currentOid: current, incomingOid: incoming });

      expect(expected).toEqual([left, right].sort(compareOids));
      expect(selection).toMatchObject({ kind: "divergent", bases: expected, commits: 5 });
      expect(() =>
        selectMergeBases(new Repository(store, "/repo"), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxBases: 1 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    } finally {
      fixture.dispose();
    }
  });

  it("accepts exact union graph bounds and rejects the preceding boundary", () => {
    const { fixture, current, incoming } = divergentFixture();
    try {
      const { db, store, repo } = harness();
      importReachable(store, fixture, [current, incoming]);
      const measured = selectMergeBases(repo, { currentOid: current, incomingOid: incoming });
      const before = store.objectCount();

      expect(
        selectMergeBases(new Repository(store, "/repo"), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxCommits: measured.commits, maxRetainedBytes: measured.retainedBytes },
        }),
      ).toMatchObject({ commits: measured.commits, retainedBytes: measured.retainedBytes });
      expect(() =>
        selectMergeBases(new Repository(store, "/repo"), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxCommits: measured.commits - 1 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(() =>
        selectMergeBases(new Repository(store, "/repo"), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxRetainedBytes: measured.retainedBytes - 1 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(store.objectCount()).toBe(before);

      db.storage.resetCounters();
      expect(() =>
        selectMergeBases(new Repository(store, "/repo"), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxSqlStatements: MERGE_BASE_SQL_STATEMENTS - 1 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(db.storage.statementCount).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects attempts to raise hard limits", () => {
    const { repo } = harness();
    expect(() =>
      selectMergeBases(repo, {
        currentOid: "1".repeat(40),
        incomingOid: "2".repeat(40),
        limits: { maxBases: MAX_MERGE_BASES + 1 },
      }),
    ).toThrow(RangeError);
  });
});
