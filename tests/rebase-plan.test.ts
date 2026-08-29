import { describe, expect, it } from "vitest";

import { hasErrorCode } from "../src/core/errors.js";
import { serializeCommit, serializeTree } from "../src/core/objects.js";
import {
  MAX_MERGE_BASE_COMMITS,
  MAX_MERGE_BASE_RETAINED_BYTES,
} from "../src/core/ops/merge-base.js";
import { MAX_MERGE_STATE_BYTES } from "../src/core/ops/merge-state.js";
import { MAX_OPERATION_STEPS } from "../src/core/ops/operation-state.js";
import { planRebase } from "../src/core/ops/rebase-plan.js";
import { MAX_REPLAY_REVISION_CODE_UNITS } from "../src/core/ops/replay.js";
import { Repository } from "../src/core/repository.js";
import { commitCacheBytes } from "../src/sqlite/commits.js";
import { type CheckoutStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";

const PERSON = {
  name: "Rebase Fixture",
  email: "rebase@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};

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

function importCommits(store: CheckoutStore, fixture: GitFixture, tips: readonly string[]): void {
  const output = fixture.git("rev-list", ...tips);
  for (const oid of output === "" ? [] : output.split("\n")) {
    expect(store.write("commit", fixture.catFile(oid))).toBe(oid);
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(hasErrorCode(error, code)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

function snapshot(store: CheckoutStore): unknown {
  return {
    objects: store.objectCount(),
    refs: store.listRefs(),
    index: store.indexEntries(),
    operation: store.readOperationState(),
  };
}

function divergentFixture(commits = 3): {
  fixture: GitFixture;
  base: string;
  current: string;
  upstream: string;
  sources: readonly string[];
} {
  const fixture = new GitFixture().init();
  fixture.write("base", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "upstream", base);
  fixture.write("upstream", "upstream\n");
  const upstream = fixture.commit("upstream");
  fixture.git("checkout", "-q", "-b", "current", base);
  for (let index = 1; index <= commits; index++) {
    fixture.write(`current-${index}`, `${index}\n`);
    fixture.commit(`current ${index}`);
  }
  const current = fixture.git("rev-parse", "HEAD");
  const sources = fixture.git("rev-list", "--reverse", "--first-parent", `${base}..${current}`);
  return {
    fixture,
    base,
    current,
    upstream,
    sources: sources === "" ? [] : sources.split("\n"),
  };
}

describe("bounded rebase planner", () => {
  it("matches Git's oldest-first selection for a divergent linear branch without mutation", () => {
    const { fixture, base, current, upstream, sources } = divergentFixture();
    try {
      const { store, repo } = harness();
      importCommits(store, fixture, [current, upstream]);
      store.setRef("refs/heads/main", current);
      store.setRef("refs/heads/upstream", upstream);
      const before = snapshot(store);
      const plan = planRebase(repo, { upstream: "upstream~0", currentOid: current });

      expect(fixture.git("merge-base", current, upstream)).toBe(base);
      expect(plan).toMatchObject({
        relation: "replay",
        originalHeadOid: current,
        upstreamOid: upstream,
        baseOid: base,
      });
      expect(plan.steps.map((step) => step.sourceOid)).toEqual(sources);
      expect(plan.steps.map((step) => step.selectedParentOid)).toEqual([
        base,
        ...sources.slice(0, -1),
      ]);
      expect(plan.steps).toEqual(
        plan.steps.map((step) => ({
          sourceOid: step.sourceOid,
          selectedParentOid: step.selectedParentOid,
          mainline: null,
          outcome: "pending",
          resultOid: null,
        })),
      );
      expect(plan.retainedBytes).toBeGreaterThan(0);
      expect(snapshot(store)).toEqual(before);
    } finally {
      fixture.dispose();
    }
  });

  it("models Git's up-to-date and fast-forward relations as zero-step plans", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("file", "one\n");
      const first = fixture.commit("first");
      fixture.write("file", "two\n");
      const second = fixture.commit("second");
      fixture.write("file", "three\n");
      const third = fixture.commit("third");
      const { store, repo } = harness();
      importCommits(store, fixture, [third]);

      expect(planRebase(repo, { upstream: second, currentOid: third })).toMatchObject({
        relation: "up-to-date",
        originalHeadOid: third,
        upstreamOid: second,
        baseOid: second,
        steps: [],
        retainedBytes: 0,
      });
      fixture.git("branch", "upstream", second);
      expect(fixture.git("rebase", "upstream")).toContain("up to date");
      expect(fixture.git("rev-parse", "HEAD")).toBe(third);

      expect(planRebase(repo, { upstream: third, currentOid: first })).toMatchObject({
        relation: "fast-forward",
        originalHeadOid: first,
        upstreamOid: third,
        baseOid: first,
        steps: [],
        retainedBytes: 0,
      });
      fixture.git("checkout", "-q", "-b", "behind", first);
      fixture.git("rebase", "main");
      expect(fixture.git("rev-parse", "HEAD")).toBe(third);
    } finally {
      fixture.dispose();
    }
  });

  it("accepts exact lower planner bounds and rejects the preceding boundary", () => {
    const { fixture, current, upstream } = divergentFixture();
    try {
      const { store, repo } = harness();
      importCommits(store, fixture, [current, upstream]);
      const measured = planRebase(repo, { upstream, currentOid: current });
      const exactLimits = {
        maxSteps: measured.steps.length,
        maxRetainedBytes: measured.retainedBytes,
        maxGraphCommits: measured.graphCommits,
        maxGraphRetainedBytes: measured.graphRetainedBytes,
      };

      expect(
        planRebase(repo, { upstream, currentOid: current, limits: exactLimits }),
      ).toMatchObject({
        steps: measured.steps,
        retainedBytes: measured.retainedBytes,
        graphCommits: measured.graphCommits,
        graphRetainedBytes: measured.graphRetainedBytes,
      });
      expectCode(
        () =>
          planRebase(repo, {
            upstream,
            currentOid: current,
            limits: { ...exactLimits, maxSteps: measured.steps.length - 1 },
          }),
        "E2BIG",
      );
      expectCode(
        () =>
          planRebase(repo, {
            upstream,
            currentOid: current,
            limits: { ...exactLimits, maxRetainedBytes: measured.retainedBytes - 1 },
          }),
        "E2BIG",
      );
      expectCode(
        () =>
          planRebase(repo, {
            upstream,
            currentOid: current,
            limits: { ...exactLimits, maxGraphCommits: measured.graphCommits - 1 },
          }),
        "E2BIG",
      );
      expectCode(
        () =>
          planRebase(repo, {
            upstream,
            currentOid: current,
            limits: {
              ...exactLimits,
              maxGraphRetainedBytes: measured.graphRetainedBytes - 1,
            },
          }),
        "E2BIG",
      );
    } finally {
      fixture.dispose();
    }
  });

  it("rejects planner limits that attempt to disable or raise hard bounds", () => {
    const { repo } = harness();
    const invalidLimits = [
      { maxSteps: 0 },
      { maxSteps: MAX_OPERATION_STEPS + 1 },
      { maxRetainedBytes: MAX_MERGE_STATE_BYTES + 1 },
      { maxGraphCommits: MAX_MERGE_BASE_COMMITS + 1 },
      { maxGraphRetainedBytes: MAX_MERGE_BASE_RETAINED_BYTES + 1 },
    ];

    for (const limits of invalidLimits) {
      expect(() =>
        planRebase(repo, { upstream: "missing", currentOid: "invalid", limits }),
      ).toThrow(RangeError);
    }
  });

  it("rejects a merge in the selected range instead of flattening it", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("base", "base\n");
      const base = fixture.commit("base");
      fixture.git("checkout", "-q", "-b", "upstream", base);
      fixture.write("upstream", "upstream\n");
      const upstream = fixture.commit("upstream");
      fixture.git("checkout", "-q", "-b", "current", base);
      fixture.write("current", "current\n");
      const currentParent = fixture.commit("current");
      fixture.git("checkout", "-q", "-b", "side", base);
      fixture.write("side", "side\n");
      const side = fixture.commit("side");
      const mergeTree = fixture.git("show", "-s", "--format=%T", currentParent);
      const current = fixture.git(
        "commit-tree",
        mergeTree,
        "-p",
        currentParent,
        "-p",
        side,
        "-m",
        "merge",
      );
      const { store, repo } = harness();
      importCommits(store, fixture, [current, upstream]);

      expect(fixture.git("rev-list", "--min-parents=2", `${base}..${current}`)).toBe(current);
      expectCode(() => planRebase(repo, { upstream, currentOid: current }), "EUNSUPPORTED");
    } finally {
      fixture.dispose();
    }
  });

  it("rejects multiple best bases, unrelated histories, and shallow proof gaps", () => {
    const crissCross = new GitFixture().init();
    try {
      crissCross.write("base", "base\n");
      const root = crissCross.commit("root");
      crissCross.git("checkout", "-q", "-b", "left", root);
      crissCross.write("left", "left\n");
      const left = crissCross.commit("left");
      crissCross.git("checkout", "-q", "-b", "right", root);
      crissCross.write("right", "right\n");
      const right = crissCross.commit("right");
      const leftTree = crissCross.git("show", "-s", "--format=%T", left);
      const rightTree = crissCross.git("show", "-s", "--format=%T", right);
      const current = crissCross.git(
        "commit-tree",
        leftTree,
        "-p",
        left,
        "-p",
        right,
        "-m",
        "left merge",
      );
      const upstream = crissCross.git(
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
      importCommits(store, crissCross, [current, upstream]);
      expect(crissCross.git("merge-base", "--all", current, upstream).split("\n")).toHaveLength(2);
      expectCode(() => planRebase(repo, { upstream, currentOid: current }), "EUNSUPPORTED");
    } finally {
      crissCross.dispose();
    }

    const unrelated = new GitFixture().init();
    try {
      unrelated.write("current", "current\n");
      const current = unrelated.commit("current");
      unrelated.git("checkout", "-q", "--orphan", "upstream");
      unrelated.remove("current");
      unrelated.write("upstream", "upstream\n");
      const upstream = unrelated.commit("upstream");
      const { store, repo } = harness();
      importCommits(store, unrelated, [current, upstream]);
      expectCode(() => planRebase(repo, { upstream, currentOid: current }), "EUNRELATED");
    } finally {
      unrelated.dispose();
    }

    const shallow = divergentFixture(1);
    try {
      const { store, repo } = harness();
      importCommits(store, shallow.fixture, [shallow.current, shallow.upstream]);
      store.setShallow([shallow.current]);
      repo.invalidateShallow();
      expectCode(
        () => planRebase(repo, { upstream: shallow.upstream, currentOid: shallow.current }),
        "ESHALLOW",
      );
    } finally {
      shallow.fixture.dispose();
    }
  });

  it("fails closed for malformed, overlong, missing, and non-commit revisions", () => {
    const { store, repo } = harness();
    const tree = store.write("tree", serializeTree([]));
    const current = store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: PERSON,
        committer: PERSON,
        message: "current\n",
      }),
    );
    const blob = store.write("blob", new TextEncoder().encode("blob"));
    store.setRef("refs/heads/blob", blob);

    expectCode(() => planRebase(repo, { upstream: "", currentOid: current }), "EINVAL");
    expectCode(
      () =>
        planRebase(repo, {
          upstream: "x".repeat(MAX_REPLAY_REVISION_CODE_UNITS + 1),
          currentOid: current,
        }),
      "E2BIG",
    );
    expectCode(() => planRebase(repo, { upstream: "HEAD^{", currentOid: current }), "ENOTFOUND");
    expectCode(() => planRebase(repo, { upstream: "missing", currentOid: current }), "ENOTFOUND");
    expectCode(() => planRebase(repo, { upstream: "blob", currentOid: current }), "ECORRUPT");
    expectCode(() => planRebase(repo, { upstream: current, currentOid: "invalid" }), "EINVAL");
    expect(() =>
      planRebase(repo, {
        upstream: `${current}~999999999999999999999999999999999999999999999999999999999999`,
        currentOid: current,
      }),
    ).toThrowError("rebase revision ordinal exceeds the safe integer range");
  });

  it("rejects a cyclic indexed graph without mutating repository state", () => {
    const { db, store, repo } = harness();
    const tree = store.write("tree", serializeTree([]));
    const base = store.write(
      "commit",
      serializeCommit({ tree, parent: [], author: PERSON, committer: PERSON, message: "base\n" }),
    );
    const upstream = store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [base],
        author: PERSON,
        committer: PERSON,
        message: "upstream\n",
      }),
    );
    const current = store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [base],
        author: PERSON,
        committer: PERSON,
        message: "current\n",
      }),
    );
    const cachedBase = store.cachedCommit(base);
    if (cachedBase === null) throw new Error("base commit cache row is missing");
    const cyclicBase = { ...cachedBase.commit, parent: [current] };
    db.run(
      "UPDATE git_commits SET parents = ?, cache_bytes = ? WHERE repo_id = ? AND oid = ?",
      JSON.stringify(cyclicBase.parent),
      commitCacheBytes(cyclicBase),
      1,
      base,
    );
    const before = snapshot(store);

    expectCode(() => planRebase(repo, { upstream, currentOid: current }), "ECORRUPT");
    expect(snapshot(store)).toEqual(before);
  });

  it("rejects a non-cyclic graph with a missing parent without mutation", () => {
    const { store, repo } = harness();
    const tree = store.write("tree", serializeTree([]));
    const upstream = store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [],
        author: PERSON,
        committer: PERSON,
        message: "upstream\n",
      }),
    );
    const current = store.write(
      "commit",
      serializeCommit({
        tree,
        parent: ["f".repeat(40)],
        author: PERSON,
        committer: PERSON,
        message: "current\n",
      }),
    );
    const before = snapshot(store);

    expectCode(() => planRebase(repo, { upstream, currentOid: current }), "ECORRUPT");
    expect(snapshot(store)).toEqual(before);
  });

  it("accepts exactly 4096 selected commits and rejects the next before returning a plan", () => {
    const { store, repo } = harness();
    const tree = store.write("tree", serializeTree([]));
    const base = store.write(
      "commit",
      serializeCommit({ tree, parent: [], author: PERSON, committer: PERSON, message: "base\n" }),
    );
    const upstream = store.write(
      "commit",
      serializeCommit({
        tree,
        parent: [base],
        author: PERSON,
        committer: PERSON,
        message: "upstream\n",
      }),
    );
    let current = base;
    let exact = base;
    for (let index = 1; index <= MAX_OPERATION_STEPS + 1; index++) {
      current = store.write(
        "commit",
        serializeCommit({
          tree,
          parent: [current],
          author: PERSON,
          committer: PERSON,
          message: `current ${index}\n`,
        }),
      );
      if (index === MAX_OPERATION_STEPS) exact = current;
    }

    expect(planRebase(repo, { upstream, currentOid: exact }).steps).toHaveLength(
      MAX_OPERATION_STEPS,
    );
    expectCode(() => planRebase(repo, { upstream, currentOid: current }), "E2BIG");
  });
});
