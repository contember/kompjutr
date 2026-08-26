import { describe, expect, it } from "vitest";

import { hasErrorCode } from "../src/core/errors.js";
import {
  MODE_FILE,
  type Person,
  serializeCommit,
  serializeTag,
  serializeTree,
} from "../src/core/objects.js";
import {
  MAX_REPLAY_REVISION_CODE_UNITS,
  MAX_REPLAY_REVISION_HOPS,
  planReplay,
} from "../src/core/ops/replay.js";
import { Repository } from "../src/core/repository.js";
import { type RepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

const PERSON: Person = {
  name: "Replay Fixture",
  email: "replay@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};

interface Harness {
  db: TestDatabase;
  store: RepoStore;
  repo: Repository;
}

interface TreeFixture {
  tree: string;
  blob: string | null;
}

function harness(): Harness {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const store = database.open(database.create("/repo", "ref: refs/heads/main"));
  return { db, store, repo: new Repository(store, "/repo") };
}

function tree(store: RepoStore, content?: string): TreeFixture {
  if (content === undefined) {
    return { tree: store.write("tree", serializeTree([])), blob: null };
  }
  const blob = store.write("blob", new TextEncoder().encode(content));
  return {
    tree: store.write("tree", serializeTree([{ mode: MODE_FILE, name: "file", oid: blob }])),
    blob,
  };
}

function commit(
  store: RepoStore,
  treeOid: string,
  parent: readonly string[],
  message: string,
): string {
  return store.write(
    "commit",
    serializeCommit({
      tree: treeOid,
      parent: [...parent],
      author: PERSON,
      committer: PERSON,
      message: `${message}\n`,
    }),
  );
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

function commitCacheRows(db: TestDatabase): number {
  return db.scalar<number>("SELECT COUNT(*) FROM git_commits") ?? -1;
}

describe("one-commit replay planner", () => {
  it("maps cherry-pick and revert to opposite three-tree integrations without mutation", () => {
    const { store, repo } = harness();
    const base = tree(store, "base\n");
    const sourceTree = tree(store, "source\n");
    const currentTree = tree(store, "current\n");
    const parent = commit(store, base.tree, [], "parent");
    const source = commit(store, sourceTree.tree, [parent], "source");
    const current = commit(store, currentTree.tree, [], "current");
    store.setRef("refs/heads/main", current);
    store.setRef("refs/heads/topic", source);
    const before = {
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    };

    const cherryPick = planReplay(repo, {
      kind: "cherry-pick",
      source: "topic",
      currentOid: current,
    });
    expect(cherryPick).toMatchObject({
      kind: "cherry-pick",
      sourceOid: source,
      sourceTreeOid: sourceTree.tree,
      selectedParentOid: parent,
      selectedParentTreeOid: base.tree,
      mainline: null,
      currentOid: current,
      currentTreeOid: currentTree.tree,
      baseTreeOid: base.tree,
      incomingTreeOid: sourceTree.tree,
      labels: {
        current: "HEAD",
        base: parent.slice(0, 12),
        incoming: source.slice(0, 12),
      },
    });
    expect(cherryPick.integration.entries).toEqual([
      expect.objectContaining({
        kind: "conflict",
        path: "file",
        conflict: "content",
        stages: {
          base: { mode: MODE_FILE, oid: base.blob },
          current: { mode: MODE_FILE, oid: currentTree.blob },
          incoming: { mode: MODE_FILE, oid: sourceTree.blob },
        },
      }),
    ]);

    const revert = planReplay(repo, {
      kind: "revert",
      source: source,
      currentOid: current,
    });
    expect(revert).toMatchObject({
      kind: "revert",
      sourceOid: source,
      selectedParentOid: parent,
      currentOid: current,
      baseTreeOid: sourceTree.tree,
      incomingTreeOid: base.tree,
      labels: {
        current: "HEAD",
        base: source.slice(0, 12),
        incoming: parent.slice(0, 12),
      },
    });
    expect(revert.integration.entries).toEqual([
      expect.objectContaining({
        kind: "conflict",
        path: "file",
        conflict: "content",
        stages: {
          base: { mode: MODE_FILE, oid: sourceTree.blob },
          current: { mode: MODE_FILE, oid: currentTree.blob },
          incoming: { mode: MODE_FILE, oid: base.blob },
        },
      }),
    ]);
    expect({
      objects: store.objectCount(),
      refs: store.listRefs(),
      index: store.indexEntries(),
    }).toEqual(before);
  });

  it("generates command-specific source subject labels", () => {
    const { store, repo } = harness();
    const baseTree = tree(store, "base\n");
    const sourceTree = tree(store, "source\n");
    const currentTree = tree(store, "current\n");
    const parent = commit(store, baseTree.tree, [], "parent");
    const source = commit(store, sourceTree.tree, [parent], "source subject");
    const current = commit(store, currentTree.tree, [], "current");

    expect(
      planReplay(repo, {
        kind: "cherry-pick",
        source,
        currentOid: current,
        incomingLabelStyle: "source-subject",
      }).labels.incoming,
    ).toBe(`${source.slice(0, 7)} (source subject)`);
    expect(
      planReplay(repo, {
        kind: "revert",
        source,
        currentOid: current,
        incomingLabelStyle: "parent-of-source-subject",
      }).labels.incoming,
    ).toBe(`parent of ${source.slice(0, 7)} (source subject)`);
  });

  it("skips leading LF blank lines in command-specific source subject labels", () => {
    const { store, repo } = harness();
    const baseTree = tree(store, "base\n");
    const sourceTree = tree(store, "source\n");
    const currentTree = tree(store, "current\n");
    const parent = commit(store, baseTree.tree, [], "parent");
    const source = commit(store, sourceTree.tree, [parent], "\n\n  source subject\r\nbody");
    const current = commit(store, currentTree.tree, [], "current");

    expect(
      planReplay(repo, {
        kind: "cherry-pick",
        source,
        currentOid: current,
        incomingLabelStyle: "source-subject",
      }).labels.incoming,
    ).toBe(`${source.slice(0, 7)} (  source subject)`);
    expect(
      planReplay(repo, {
        kind: "revert",
        source,
        currentOid: current,
        incomingLabelStyle: "parent-of-source-subject",
      }).labels.incoming,
    ).toBe(`parent of ${source.slice(0, 7)} (  source subject)`);
  });

  it("uses a null parent tree for root cherry-pick and root revert", () => {
    const { store, repo } = harness();
    const empty = tree(store);
    const added = tree(store, "root\n");
    const emptyCurrent = commit(store, empty.tree, [], "empty current");
    const root = commit(store, added.tree, [], "root");

    const cherryPick = planReplay(repo, {
      kind: "cherry-pick",
      source: root,
      currentOid: emptyCurrent,
    });
    expect(cherryPick).toMatchObject({
      selectedParentOid: null,
      selectedParentTreeOid: null,
      mainline: null,
      baseTreeOid: null,
      incomingTreeOid: added.tree,
    });
    expect(cherryPick.integration.entries).toEqual([
      expect.objectContaining({ kind: "clean", path: "file", before: null }),
    ]);

    const revert = planReplay(repo, {
      kind: "revert",
      source: root,
      currentOid: root,
    });
    expect(revert).toMatchObject({
      selectedParentOid: null,
      selectedParentTreeOid: null,
      mainline: null,
      baseTreeOid: added.tree,
      incomingTreeOid: null,
    });
    expect(revert.integration.entries).toEqual([
      expect.objectContaining({ kind: "clean", path: "file", result: null }),
    ]);
  });

  it("accepts absent or one for a one-parent mainline and rejects other values", () => {
    const { store, repo } = harness();
    const firstTree = tree(store, "first\n");
    const secondTree = tree(store, "second\n");
    const parent = commit(store, firstTree.tree, [], "parent");
    const source = commit(store, secondTree.tree, [parent], "source");

    expect(
      planReplay(repo, {
        kind: "cherry-pick",
        source,
        currentOid: parent,
      }).mainline,
    ).toBeNull();
    expect(
      planReplay(repo, {
        kind: "cherry-pick",
        source,
        currentOid: parent,
        mainline: 1,
      }).mainline,
    ).toBe(1);
    expectCode(
      () => planReplay(repo, { kind: "cherry-pick", source, currentOid: parent, mainline: 2 }),
      "EINVAL",
    );
    expectCode(
      () => planReplay(repo, { kind: "revert", source, currentOid: parent, mainline: 1.5 }),
      "EINVAL",
    );
  });

  it("requires an in-range mainline for merge commits and selects it one-based", () => {
    const { store, repo } = harness();
    const firstTree = tree(store, "first\n");
    const secondTree = tree(store, "second\n");
    const mergeTree = tree(store, "merge\n");
    const first = commit(store, firstTree.tree, [], "first");
    const second = commit(store, secondTree.tree, [], "second");
    const merge = commit(store, mergeTree.tree, [first, second], "merge");

    expectCode(
      () => planReplay(repo, { kind: "cherry-pick", source: merge, currentOid: first }),
      "EINVAL",
    );
    for (const mainline of [0, 3, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(
        () =>
          planReplay(repo, {
            kind: "revert",
            source: merge,
            currentOid: first,
            mainline,
          }),
        "EINVAL",
      );
    }
    const selected = planReplay(repo, {
      kind: "revert",
      source: merge,
      currentOid: first,
      mainline: 2,
    });
    expect(selected).toMatchObject({
      selectedParentOid: second,
      selectedParentTreeOid: secondTree.tree,
      mainline: 2,
      baseTreeOid: mergeTree.tree,
      incomingTreeOid: secondTree.tree,
    });
  });

  it("allows no mainline on a root commit and rejects mainline one", () => {
    const { store, repo } = harness();
    const rootTree = tree(store, "root\n");
    const root = commit(store, rootTree.tree, [], "root");
    expectCode(
      () => planReplay(repo, { kind: "cherry-pick", source: root, currentOid: root, mainline: 1 }),
      "EINVAL",
    );
  });

  it("fails closed for missing and non-commit revisions and invalid current ids", () => {
    const { store, repo } = harness();
    const currentTree = tree(store, "current\n");
    const current = commit(store, currentTree.tree, [], "current");
    const blob = store.write("blob", new TextEncoder().encode("not a commit"));
    store.setRef("refs/heads/corrupt", blob);
    store.setRef("refs/heads/missing-object", "1".repeat(40));

    expectCode(
      () => planReplay(repo, { kind: "cherry-pick", source: "missing", currentOid: current }),
      "ENOTFOUND",
    );
    expectCode(
      () => planReplay(repo, { kind: "cherry-pick", source: "corrupt", currentOid: current }),
      "ECORRUPT",
    );
    expectCode(
      () =>
        planReplay(repo, { kind: "cherry-pick", source: "missing-object", currentOid: current }),
      "ENOTFOUND",
    );
    expectCode(
      () => planReplay(repo, { kind: "revert", source: current, currentOid: "not-an-oid" }),
      "EINVAL",
    );
    expectCode(
      () => planReplay(repo, { kind: "revert", source: current, currentOid: "2".repeat(40) }),
      "ENOTFOUND",
    );
  });

  it("validates the source revision before a competing invalid current oid", () => {
    const { repo } = harness();

    expect(() =>
      planReplay(repo, { kind: "cherry-pick", source: "", currentOid: "invalid" }),
    ).toThrowError("replay source revision is required");
    expect(() =>
      planReplay(repo, {
        kind: "revert",
        source: "x".repeat(MAX_REPLAY_REVISION_CODE_UNITS + 1),
        currentOid: "invalid",
      }),
    ).toThrowError(`replay source revision exceeds ${MAX_REPLAY_REVISION_CODE_UNITS} code units`);
  });

  it("does not populate the derived commit cache on success or a later planning failure", () => {
    const { db, store, repo } = harness();
    const baseTree = tree(store, "base\n");
    const sourceTree = tree(store, "source\n");
    const parent = commit(store, baseTree.tree, [], "parent");
    const source = commit(store, sourceTree.tree, [parent], "source");
    db.run("DELETE FROM git_commits");
    expect(commitCacheRows(db)).toBe(0);

    expect(planReplay(repo, { kind: "cherry-pick", source, currentOid: parent }).sourceOid).toBe(
      source,
    );
    expect(commitCacheRows(db)).toBe(0);

    expectCode(
      () =>
        planReplay(repo, {
          kind: "cherry-pick",
          source,
          currentOid: parent,
          limits: { maxEntries: 0 },
        }),
      "E2BIG",
    );
    expect(commitCacheRows(db)).toBe(0);
  });

  it("accepts the exact parent-hop ceiling and rejects the next hop and huge decimals", () => {
    const { store, repo } = harness();
    const unchanged = tree(store, "same\n");
    const commits: string[] = [commit(store, unchanged.tree, [], "root")];
    for (let index = 1; index <= MAX_REPLAY_REVISION_HOPS; index++) {
      commits.push(commit(store, unchanged.tree, [commits[index - 1]!], `commit ${index}`));
    }
    const tip = commits[MAX_REPLAY_REVISION_HOPS]!;

    expect(
      planReplay(repo, {
        kind: "cherry-pick",
        source: `${tip}~${MAX_REPLAY_REVISION_HOPS}`,
        currentOid: tip,
      }).sourceOid,
    ).toBe(commits[0]);
    expectCode(
      () =>
        planReplay(repo, {
          kind: "cherry-pick",
          source: `${tip}~${MAX_REPLAY_REVISION_HOPS + 1}`,
          currentOid: tip,
        }),
      "E2BIG",
    );
    expectCode(
      () =>
        planReplay(repo, {
          kind: "revert",
          source: `${tip}~999999999999999999999999999999999999999999999999999999999999`,
          currentOid: tip,
        }),
      "E2BIG",
    );
    expect(() =>
      planReplay(repo, {
        kind: "revert",
        source: `${tip}~999999999999999999999999999999999999999999999999999999999999`,
        currentOid: tip,
      }),
    ).toThrowError("replay revision ordinal exceeds the safe integer range");
  });

  it("resolves abbreviated commits, annotated tags, and bounded parent suffixes", () => {
    const { store, repo } = harness();
    const firstTree = tree(store, "first\n");
    const secondTree = tree(store, "second\n");
    const first = commit(store, firstTree.tree, [], "first");
    const second = commit(store, secondTree.tree, [first], "second");
    const tag = store.write(
      "tag",
      serializeTag({
        object: second,
        type: "commit",
        tag: "release",
        tagger: PERSON,
        message: "release\n",
      }),
    );
    store.setRef("refs/tags/release", tag);

    expect(
      planReplay(repo, { kind: "cherry-pick", source: second.slice(0, 12), currentOid: first })
        .sourceOid,
    ).toBe(second);
    expect(
      planReplay(repo, { kind: "cherry-pick", source: "release", currentOid: first }).sourceOid,
    ).toBe(second);
    expect(
      planReplay(repo, { kind: "cherry-pick", source: "release^1", currentOid: second }).sourceOid,
    ).toBe(first);
    const merge = commit(store, secondTree.tree, [first, second], "merge");
    expect(
      planReplay(repo, { kind: "cherry-pick", source: `${merge}^2`, currentOid: second }).sourceOid,
    ).toBe(second);
  });

  it("rejects a symbolic revision cycle", () => {
    const { store, repo } = harness();
    const currentTree = tree(store, "current\n");
    const current = commit(store, currentTree.tree, [], "current");
    store.setRef("refs/heads/cycle-a", "ref: refs/heads/cycle-b");
    store.setRef("refs/heads/cycle-b", "ref: refs/heads/cycle-a");
    expectCode(
      () => planReplay(repo, { kind: "revert", source: "cycle-a", currentOid: current }),
      "ECORRUPT",
    );
  });

  it("fails closed for missing, non-commit, and corrupt selected parents", () => {
    const nonCommit = harness();
    const currentTree = tree(nonCommit.store, "current\n");
    const sourceTree = tree(nonCommit.store, "source\n");
    const current = commit(nonCommit.store, currentTree.tree, [], "current");
    const blobParent = nonCommit.store.write("blob", new TextEncoder().encode("parent"));
    const nonCommitSource = commit(
      nonCommit.store,
      sourceTree.tree,
      [blobParent],
      "non-commit parent",
    );
    expectCode(
      () =>
        planReplay(nonCommit.repo, {
          kind: "cherry-pick",
          source: nonCommitSource,
          currentOid: current,
        }),
      "ECORRUPT",
    );

    const missingSource = commit(
      nonCommit.store,
      sourceTree.tree,
      ["3".repeat(40)],
      "missing parent",
    );
    expectCode(
      () =>
        planReplay(nonCommit.repo, {
          kind: "revert",
          source: missingSource,
          currentOid: current,
        }),
      "ENOTFOUND",
    );

    const corrupt = harness();
    const corruptTree = tree(corrupt.store, "corrupt\n");
    const corruptParent = commit(corrupt.store, corruptTree.tree, [], "parent");
    const corruptSource = commit(corrupt.store, corruptTree.tree, [corruptParent], "source");
    corrupt.db.run("DELETE FROM git_commits");
    corrupt.db.run(
      "UPDATE git_objects SET size = size + 1 WHERE repo_id = 1 AND oid = ?",
      corruptParent,
    );
    const coldDatabase = new SqliteGitDatabase(corrupt.db);
    const row = coldDatabase.find("/repo");
    if (row === null) throw new Error("missing corrupt replay repository");
    const coldRepo = new Repository(coldDatabase.open(row), "/repo");
    expectCode(
      () =>
        planReplay(coldRepo, {
          kind: "cherry-pick",
          source: corruptSource,
          currentOid: corruptSource,
        }),
      "ECORRUPT",
    );
    expect(commitCacheRows(corrupt.db)).toBe(0);
  });

  it("accepts the exact revision bound and rejects the next code unit before lookup", () => {
    const { store, repo } = harness();
    const rootTree = tree(store, "root\n");
    const root = commit(store, rootTree.tree, [], "root");
    const prefix = "refs/heads/";
    const exact = `${prefix}${"r".repeat(MAX_REPLAY_REVISION_CODE_UNITS - prefix.length)}`;
    store.setRef(exact, root);

    expect(
      planReplay(repo, { kind: "cherry-pick", source: exact, currentOid: root }).sourceOid,
    ).toBe(root);
    expectCode(
      () =>
        planReplay(repo, {
          kind: "cherry-pick",
          source: `${exact}x`,
          currentOid: root,
        }),
      "E2BIG",
    );
  });

  it("returns an empty plan at an exact zero-entry limit", () => {
    const { store, repo } = harness();
    const unchanged = tree(store, "same\n");
    const parent = commit(store, unchanged.tree, [], "parent");
    const source = commit(store, unchanged.tree, [parent], "empty source");

    const plan = planReplay(repo, {
      kind: "cherry-pick",
      source,
      currentOid: parent,
      limits: { maxEntries: 0 },
    });
    expect(plan.integration.entries).toEqual([]);
    expect(plan.integration.sourceRows).toBe(0);
  });
});
