import { describe, expect, it } from "vitest";

import {
  countAheadBehind,
  MAX_MERGE_BASES,
  mergeBase,
  selectMergeBases,
} from "../src/core/ops/merge-base.js";
import { Repository } from "../src/core/repository.js";
import { type CheckoutStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

interface Harness {
  db: TestDatabase;
  store: CheckoutStore;
  repo: Repository;
}

function harness(): Harness {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
  return { db, store, repo: new Repository(store) };
}

function importCommits(store: CheckoutStore, fixture: GitFixture, oids: readonly string[]): void {
  const seen = new Set<string>();
  for (const oid of oids) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    expect(store.write("commit", fixture.catFile(oid))).toBe(oid);
  }
}

function importReachable(store: CheckoutStore, fixture: GitFixture, tips: readonly string[]): void {
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

function gitAheadBehind(
  fixture: GitFixture,
  current: string,
  incoming: string,
): { ahead: number; behind: number } {
  const output = fixture.git("rev-list", "--left-right", "--count", `${current}...${incoming}`);
  const [ahead, behind] = output.split(/\s+/).map(Number);
  if (ahead === undefined || behind === undefined) throw new Error("git returned invalid counts");
  return { ahead, behind };
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
      const { store, repo } = harness();
      importReachable(store, fixture, [third]);

      expect(fixture.git("merge-base", "--is-ancestor", second, third)).toBe("");
      expect(selectMergeBases(repo, { currentOid: second, incomingOid: third })).toMatchObject({
        kind: "fast-forward",
        bases: [second],
        commits: 3,
      });

      expect(fixture.git("merge-base", "--is-ancestor", second, third)).toBe("");
      expect(
        selectMergeBases(new Repository(store), {
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

  it("resolves public revision inputs and returns only kind and all best bases", () => {
    const { fixture, base, current, incoming } = divergentFixture();
    try {
      const { db, store, repo } = harness();
      importReachable(store, fixture, [current, incoming]);
      store.setRef("refs/heads/current", current);
      store.setRef("refs/heads/incoming", incoming);

      expect(mergeBase(repo, { current: "current", incoming: "incoming" })).toEqual({
        kind: "divergent",
        bases: [base],
      });

      const database = new SqliteGitDatabase(db);
      const checkout = database.findCheckout("/repo");
      if (checkout === null) throw new Error("cold repository is missing");
      expect(
        mergeBase(new Repository(database.openCheckout(checkout)), {
          current: current,
          incoming: `${incoming}^{commit}`,
        }),
      ).toEqual({ kind: "divergent", bases: [base] });
    } finally {
      fixture.dispose();
    }
  });

  it("counts bounded ahead and behind histories with one graph traversal per side", () => {
    const { fixture, current, incoming } = divergentFixture();
    try {
      const { store, repo } = harness();
      importReachable(store, fixture, [current, incoming]);

      expect(countAheadBehind(repo, { currentOid: current, incomingOid: incoming })).toMatchObject({
        ...gitAheadBehind(fixture, current, incoming),
        commits: 3,
      });
      expect(() =>
        countAheadBehind(new Repository(store), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxCommits: 2 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      const blob = store.write("blob", new Uint8Array([1]));
      expect(() =>
        countAheadBehind(new Repository(store), {
          currentOid: current,
          incomingOid: blob,
        }),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
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
      expect(
        countAheadBehind(shallowHarness.repo, {
          currentOid: shallow.current,
          incomingOid: shallow.incoming,
        }),
      ).toMatchObject(gitAheadBehind(shallow.fixture, shallow.current, shallow.incoming));
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
        selectMergeBases(new Repository(store), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxBases: 1 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    } finally {
      fixture.dispose();
    }
  });

  it("accepts the exact union graph commit bound and rejects the preceding boundary", () => {
    const { fixture, current, incoming } = divergentFixture();
    try {
      const { store, repo } = harness();
      importReachable(store, fixture, [current, incoming]);
      const measured = selectMergeBases(repo, { currentOid: current, incomingOid: incoming });
      const before = store.objectCount();

      expect(
        selectMergeBases(new Repository(store), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxCommits: measured.commits },
        }),
      ).toMatchObject({ commits: measured.commits, retainedBytes: measured.retainedBytes });
      expect(() =>
        selectMergeBases(new Repository(store), {
          currentOid: current,
          incomingOid: incoming,
          limits: { maxCommits: measured.commits - 1 },
        }),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(store.objectCount()).toBe(before);
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
