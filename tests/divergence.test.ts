import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { serializeCommit, serializeTree } from "../src/core/objects.js";
import {
  divergence,
  MAX_MERGE_BASE_COMMITS,
  MAX_MERGE_BASE_RETAINED_BYTES,
} from "../src/core/ops/merge-base.js";
import { Repository } from "../src/core/repository.js";
import { MAX_LOG_COMMITS, MAX_LOG_STATE_BYTES } from "../src/sqlite/commits.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { type CheckoutRow, type CheckoutStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

class GraphProbeDatabase implements SqlDatabase {
  graphCursors = 0;

  constructor(readonly inner = new TestDatabase()) {}

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    if (query.includes("reachable(oid) AS")) this.graphCursors++;
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

interface Harness {
  db: GraphProbeDatabase;
  database: SqliteGitDatabase;
  checkout: CheckoutRow;
  store: CheckoutStore;
  repo: Repository;
}

function harness(): Harness {
  const db = new GraphProbeDatabase();
  const database = new SqliteGitDatabase(db);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  return { db, database, checkout, store, repo: new Repository(store) };
}

function importReachable(store: CheckoutStore, fixture: GitFixture, tips: readonly string[]): void {
  const output = fixture.git("rev-list", ...tips);
  if (output === "") return;
  for (const oid of output.split("\n")) {
    expect(store.write("commit", fixture.catFile(oid))).toBe(oid);
  }
}

function gitCounts(
  fixture: GitFixture,
  current: string,
  upstream: string,
): { ahead: number; behind: number } {
  const output = fixture.git("rev-list", "--left-right", "--count", `${current}...${upstream}`);
  const parts = output.split(/\s+/);
  const ahead = Number(parts[0]);
  const behind = Number(parts[1]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new Error("git returned invalid divergence counts");
  }
  return { ahead, behind };
}

function divergentFixture(): {
  fixture: GitFixture;
  base: string;
  current: string;
  upstream: string;
} {
  const fixture = new GitFixture().init();
  fixture.write("base", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "current", base);
  fixture.write("current", "current\n");
  const current = fixture.commit("current");
  fixture.git("checkout", "-q", "-b", "upstream", base);
  fixture.write("upstream", "upstream\n");
  const upstream = fixture.commit("upstream");
  return { fixture, base, current, upstream };
}

describe("bounded divergence", () => {
  it("matches real Git counts for identical, ahead, behind, and diverged histories", () => {
    const linear = new GitFixture().init();
    try {
      linear.write("file", "one\n");
      const first = linear.commit("first");
      linear.write("file", "two\n");
      const second = linear.commit("second");
      linear.write("file", "three\n");
      const third = linear.commit("third");
      const { store, repo } = harness();
      importReachable(store, linear, [third]);

      expect(divergence(repo, { current: first, upstream: first })).toEqual({
        relationship: "identical",
        ...gitCounts(linear, first, first),
      });
      expect(divergence(repo, { current: third, upstream: first })).toEqual({
        relationship: "ahead",
        ...gitCounts(linear, third, first),
      });
      expect(divergence(repo, { current: first, upstream: third })).toEqual({
        relationship: "behind",
        ...gitCounts(linear, first, third),
      });
      expect(divergence(repo, { current: second, upstream: first })).toEqual({
        relationship: "ahead",
        ...gitCounts(linear, second, first),
      });
    } finally {
      linear.dispose();
    }

    const split = divergentFixture();
    try {
      const { store, repo } = harness();
      importReachable(store, split.fixture, [split.current, split.upstream]);
      expect(divergence(repo, { current: split.current, upstream: split.upstream })).toEqual({
        relationship: "diverged",
        ...gitCounts(split.fixture, split.current, split.upstream),
      });
    } finally {
      split.fixture.dispose();
    }
  });

  it("matches real Git for criss-cross history with multiple merge bases", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("base", "base\n");
      const base = fixture.commit("base");
      fixture.git("checkout", "-q", "-b", "left", base);
      fixture.write("left", "left\n");
      const left = fixture.commit("left");
      fixture.git("checkout", "-q", "-b", "right", base);
      fixture.write("right", "right\n");
      const right = fixture.commit("right");
      const current = fixture.git(
        "commit-tree",
        fixture.git("rev-parse", `${left}^{tree}`),
        "-p",
        left,
        "-p",
        right,
        "-m",
        "current",
      );
      const upstream = fixture.git(
        "commit-tree",
        fixture.git("rev-parse", `${right}^{tree}`),
        "-p",
        right,
        "-p",
        left,
        "-m",
        "upstream",
      );
      const mergeBases = fixture.git("merge-base", "--all", current, upstream).split("\n").sort();
      expect(mergeBases).toEqual([left, right].sort());

      const { store, repo } = harness();
      importReachable(store, fixture, [current, upstream]);
      expect(divergence(repo, { current, upstream })).toEqual({
        relationship: "diverged",
        ...gitCounts(fixture, current, upstream),
      });
    } finally {
      fixture.dispose();
    }
  });

  it("resolves detached HEAD, annotated tags, and revision suffixes without doubling graph work", () => {
    const split = divergentFixture();
    try {
      split.fixture.git("tag", "-a", "v-current", "-m", "current tag", split.current);
      split.fixture.git("tag", "-a", "v-upstream", "-m", "upstream tag", split.upstream);
      const currentTag = split.fixture.git("rev-parse", "v-current");
      const upstreamTag = split.fixture.git("rev-parse", "v-upstream");
      const { db, store, repo } = harness();
      importReachable(store, split.fixture, [split.current, split.upstream]);
      expect(store.write("tag", split.fixture.catFile(currentTag))).toBe(currentTag);
      expect(store.write("tag", split.fixture.catFile(upstreamTag))).toBe(upstreamTag);
      store.setRef("refs/tags/v-current", currentTag);
      store.setRef("refs/tags/v-upstream", upstreamTag);
      store.setRef("refs/heads/upstream", split.upstream);
      store.setHead(split.current);
      db.graphCursors = 0;

      expect(divergence(repo, { current: "v-current", upstream: "v-upstream" })).toEqual({
        relationship: "diverged",
        ...gitCounts(split.fixture, "v-current", "v-upstream"),
      });
      expect(db.graphCursors).toBe(2);

      expect(divergence(repo, { current: "HEAD", upstream: `${split.current}~1` })).toEqual({
        relationship: "ahead",
        ...gitCounts(split.fixture, split.current, `${split.current}~1`),
      });
    } finally {
      split.fixture.dispose();
    }
  });

  it("matches real Git counts for a shallow boundary on either side", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "one\n");
      const first = fixture.commit("first");
      fixture.write("file", "two\n");
      const second = fixture.commit("second");
      fixture.write("file", "three\n");
      const third = fixture.commit("third");
      fixture.write(".git/shallow", `${second}\n`);

      const shallow = harness();
      importReachable(shallow.store, fixture, [first, third]);
      shallow.store.setShallow([second]);
      shallow.repo.invalidateShallow();
      expect(divergence(shallow.repo, { current: third, upstream: first })).toEqual({
        relationship: "shallow",
        ...gitCounts(fixture, third, first),
      });
      expect(divergence(shallow.repo, { current: first, upstream: third })).toEqual({
        relationship: "shallow",
        ...gitCounts(fixture, first, third),
      });
    } finally {
      fixture.dispose();
    }
  });

  it("reports unrelated history after checking shallow boundaries", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("current", "current\n");
      const current = fixture.commit("current");
      fixture.git("checkout", "-q", "--orphan", "upstream");
      fixture.remove("current");
      fixture.write("upstream", "upstream\n");
      const upstream = fixture.commit("upstream");
      const unrelated = harness();
      importReachable(unrelated.store, fixture, [current, upstream]);

      expect(divergence(unrelated.repo, { current, upstream })).toEqual({
        relationship: "unrelated",
        ...gitCounts(fixture, current, upstream),
      });
    } finally {
      fixture.dispose();
    }
  });

  it("rejects an unborn side because divergence requires two resolvable revisions", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "main\n");
      const main = fixture.commit("main");
      fixture.git("symbolic-ref", "HEAD", "refs/heads/unborn");
      expect(() =>
        fixture.git("rev-list", "--left-right", "--count", "HEAD...refs/heads/main"),
      ).toThrow();

      const { store, repo } = harness();
      importReachable(store, fixture, [main]);
      store.setRef("refs/heads/main", main);
      store.setHead("ref: refs/heads/unborn");
      expect(() => divergence(repo, { current: "HEAD", upstream: "main" })).toThrow(
        expect.objectContaining({ code: "ENOTFOUND" }),
      );
      expect(() => divergence(repo, { current: "main", upstream: "unborn" })).toThrow(
        expect.objectContaining({ code: "ENOTFOUND" }),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("fails closed for missing, non-commit, and corrupt graph inputs", () => {
    const split = divergentFixture();
    try {
      const { db, store, repo } = harness();
      importReachable(store, split.fixture, [split.current, split.upstream]);
      expect(() => divergence(repo, { current: "missing", upstream: split.upstream })).toThrow(
        expect.objectContaining({ code: "ENOTFOUND" }),
      );
      const blob = store.write("blob", utf8.encode("not a commit\n"));
      expect(() => divergence(repo, { current: blob, upstream: split.upstream })).toThrow(
        expect.objectContaining({ code: "ECORRUPT" }),
      );

      db.run("UPDATE git_commits SET parents = json_array(oid) WHERE oid = ?", split.current);
      expect(() => divergence(repo, { current: split.current, upstream: split.upstream })).toThrow(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    } finally {
      split.fixture.dispose();
    }
  });

  it("retains the fixed 50k/32 MiB graph ceilings and survives a cold reopen", () => {
    expect(MAX_MERGE_BASE_COMMITS).toBe(MAX_LOG_COMMITS);
    expect(MAX_MERGE_BASE_COMMITS).toBe(50_000);
    expect(MAX_MERGE_BASE_RETAINED_BYTES).toBe(MAX_LOG_STATE_BYTES);
    expect(MAX_MERGE_BASE_RETAINED_BYTES).toBe(32 * 1024 * 1024);

    const active = harness();
    const person = {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
    };
    let root = "";
    let tip = "";
    for (let index = 0; index < 20; index++) {
      tip = active.store.write(
        "commit",
        serializeCommit({
          tree: "1".repeat(40),
          parent: tip === "" ? [] : [tip],
          author: person,
          committer: person,
          message: `${index}\n${"x".repeat(850_000)}`,
        }),
      );
      if (root === "") root = tip;
    }
    expect(() => divergence(active.repo, { current: tip, upstream: root })).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const split = divergentFixture();
    try {
      const warm = harness();
      importReachable(warm.store, split.fixture, [split.current, split.upstream]);
      warm.store.setRef("refs/heads/main", split.current);
      warm.store.setRef("refs/heads/upstream", split.upstream);
      const coldDatabase = new SqliteGitDatabase(warm.db);
      const cold = new Repository(coldDatabase.openCheckout(warm.checkout.id));

      expect(divergence(cold, { current: "HEAD", upstream: "upstream" })).toEqual({
        relationship: "diverged",
        ...gitCounts(split.fixture, split.current, split.upstream),
      });
    } finally {
      split.fixture.dispose();
    }
  });

  it("rejects an actual graph above the 50,000-commit ceiling", () => {
    const active = harness();
    const tree = active.store.write("tree", serializeTree([]));
    const person = {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
    };
    let root = "";
    const tip = active.store.writeObjects((batch) => {
      let parent = "";
      for (let index = 0; index <= MAX_MERGE_BASE_COMMITS; index++) {
        parent = batch.write(
          "commit",
          serializeCommit({
            tree,
            parent: parent === "" ? [] : [parent],
            author: person,
            committer: person,
            message: `commit ${index}\n`,
          }),
        );
        if (root === "") root = parent;
      }
      return parent;
    });

    let failure: unknown;
    try {
      divergence(active.repo, { current: tip, upstream: root });
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(expect.objectContaining({ code: "E2BIG" }));
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("50000 commit limit");
    }
  });
});
