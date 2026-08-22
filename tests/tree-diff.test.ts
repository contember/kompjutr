import { describe, expect, it } from "vitest";

import { concat } from "../src/core/bytes.js";
import { GitError } from "../src/core/errors.js";
import {
  MODE_COMMIT,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_SYMLINK,
  MODE_TREE,
  parseTreeStream,
  serializeTree,
} from "../src/core/objects.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { Repository } from "../src/core/repository.js";
import { joinSorted } from "../src/core/streams.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

const oid = (digit: number): string => digit.toString(16).padStart(40, "0");

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const row = database.create("/repo", "ref: refs/heads/main");
  const store = database.open(row);
  return { db, store, repo: new Repository(store, row.root) };
}

describe("tree diff", () => {
  it("is lazy and skips equal roots without SQL", () => {
    const { db, store } = open();
    const tree = store.write("tree", serializeTree([{ mode: MODE_FILE, name: "a", oid: oid(1) }]));
    db.storage.resetCounters();
    const iterator = store.walkTreeDiff(tree, null);
    expect(db.storage.statementCount).toBe(0);
    expect(iterator.next().value).toEqual({
      path: "a",
      beforeMode: MODE_FILE,
      beforeOid: oid(1),
      afterMode: null,
      afterOid: null,
    });
    expect(db.storage.statementCount).toBe(1);
    db.storage.resetCounters();
    expect([...store.walkTreeDiff(tree, tree)]).toEqual([]);
    expect([...store.walkTreeDiff(null, null)]).toEqual([]);
    expect(db.storage.statementCount).toBe(0);
  });

  it("reports additions, deletions, content and mode changes", () => {
    const { store, repo } = open();
    const before = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "deleted", oid: oid(1) },
        { mode: MODE_FILE, name: "mode", oid: oid(2) },
        { mode: MODE_FILE, name: "modified", oid: oid(3) },
      ]),
    );
    const after = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "added", oid: oid(4) },
        { mode: MODE_EXECUTABLE, name: "mode", oid: oid(2) },
        { mode: MODE_FILE, name: "modified", oid: oid(5) },
      ]),
    );

    expect([...repo.walkTreeDiff(before, after)]).toEqual([
      { path: "added", beforeMode: null, beforeOid: null, afterMode: MODE_FILE, afterOid: oid(4) },
      {
        path: "deleted",
        beforeMode: MODE_FILE,
        beforeOid: oid(1),
        afterMode: null,
        afterOid: null,
      },
      {
        path: "mode",
        beforeMode: MODE_FILE,
        beforeOid: oid(2),
        afterMode: MODE_EXECUTABLE,
        afterOid: oid(2),
      },
      {
        path: "modified",
        beforeMode: MODE_FILE,
        beforeOid: oid(3),
        afterMode: MODE_FILE,
        afterOid: oid(5),
      },
    ]);
  });

  it("handles file-tree transitions and all leaf modes", () => {
    const { store } = open();
    const child = store.write(
      "tree",
      serializeTree([
        { mode: MODE_SYMLINK, name: "link", oid: oid(4) },
        { mode: MODE_COMMIT, name: "module", oid: oid(5) },
      ]),
    );
    const before = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "a", oid: oid(1) },
        { mode: MODE_TREE, name: "z", oid: child },
      ]),
    );
    const after = store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "a", oid: child },
        { mode: MODE_EXECUTABLE, name: "z", oid: oid(6) },
      ]),
    );
    expect([...store.walkTreeDiff(before, after)]).toEqual([
      { path: "a", beforeMode: MODE_FILE, beforeOid: oid(1), afterMode: null, afterOid: null },
      {
        path: "a/link",
        beforeMode: null,
        beforeOid: null,
        afterMode: MODE_SYMLINK,
        afterOid: oid(4),
      },
      {
        path: "a/module",
        beforeMode: null,
        beforeOid: null,
        afterMode: MODE_COMMIT,
        afterOid: oid(5),
      },
      {
        path: "z",
        beforeMode: null,
        beforeOid: null,
        afterMode: MODE_EXECUTABLE,
        afterOid: oid(6),
      },
      {
        path: "z/link",
        beforeMode: MODE_SYMLINK,
        beforeOid: oid(4),
        afterMode: null,
        afterOid: null,
      },
      {
        path: "z/module",
        beforeMode: MODE_COMMIT,
        beforeOid: oid(5),
        afterMode: null,
        afterOid: null,
      },
    ]);
  });

  it("skips corrupt equal child projections", () => {
    const { db, store } = open();
    const equal = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "hidden", oid: oid(1) }]),
    );
    const before = store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "equal", oid: equal },
        { mode: MODE_FILE, name: "visible", oid: oid(2) },
      ]),
    );
    const after = store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "equal", oid: equal },
        { mode: MODE_FILE, name: "visible", oid: oid(3) },
      ]),
    );
    db.run("UPDATE git_tree_entries SET oid = ? WHERE repo_id = 1 AND tree_oid = ?", oid(9), equal);
    expect([...store.walkTreeDiff(before, after)]).toEqual([
      {
        path: "visible",
        beforeMode: MODE_FILE,
        beforeOid: oid(2),
        afterMode: MODE_FILE,
        afterOid: oid(3),
      },
    ]);
  });

  it("matches a merge of complete tree streams and uses one statement", () => {
    const { db, store } = open();
    const leftChild = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "x", oid: oid(1) }]),
    );
    const rightChild = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "x", oid: oid(2) }]),
    );
    const before = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "\uE000", oid: oid(3) },
        { mode: MODE_TREE, name: "dir", oid: leftChild },
      ]),
    );
    const after = store.write(
      "tree",
      serializeTree([
        { mode: MODE_FILE, name: "\u{1F600}", oid: oid(4) },
        { mode: MODE_TREE, name: "dir", oid: rightChild },
      ]),
    );
    const expected = [
      ...joinSorted(store.walkTree(before), store.walkTree(after), {
        left: (entry) => entry.path,
        right: (entry) => entry.path,
      }),
    ]
      .filter((row) => row.left?.mode !== row.right?.mode || row.left?.oid !== row.right?.oid)
      .map((row) => ({
        path: row.path,
        beforeMode: row.left?.mode ?? null,
        beforeOid: row.left?.oid ?? null,
        afterMode: row.right?.mode ?? null,
        afterOid: row.right?.oid ?? null,
      }));
    db.storage.resetCounters();
    expect([...store.walkTreeDiff(before, after)]).toEqual(expected);
    expect(db.storage.statementCount).toBe(1);
  });

  it("fails closed on a visited projection but not an equal subtree", () => {
    const { db, store } = open();
    const beforeChild = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "x", oid: oid(1) }]),
    );
    const afterChild = store.write(
      "tree",
      serializeTree([{ mode: MODE_FILE, name: "x", oid: oid(2) }]),
    );
    const before = store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "dir", oid: beforeChild }]),
    );
    const after = store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "dir", oid: afterChild }]),
    );
    db.run(
      "UPDATE git_tree_entries SET oid = ? WHERE repo_id = 1 AND tree_oid = ?",
      oid(8),
      beforeChild,
    );
    expect(() => [...store.walkTreeDiff(before, after)]).toThrow(/integrity check failed/);
  });

  it("permits DAG reuse and rejects an active-stack cycle", () => {
    const { db, store } = open();
    const leaf = store.write("tree", serializeTree([{ mode: MODE_FILE, name: "x", oid: oid(1) }]));
    const before = store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "a", oid: leaf },
        { mode: MODE_TREE, name: "b", oid: leaf },
      ]),
    );
    const after = store.write(
      "tree",
      serializeTree([
        { mode: MODE_TREE, name: "a", oid: leaf },
        {
          mode: MODE_TREE,
          name: "b",
          oid: store.write("tree", serializeTree([{ mode: MODE_FILE, name: "x", oid: oid(2) }])),
        },
      ]),
    );
    expect([...store.walkTreeDiff(before, after)]).toEqual([
      {
        path: "b/x",
        beforeMode: MODE_FILE,
        beforeOid: oid(1),
        afterMode: MODE_FILE,
        afterOid: oid(2),
      },
    ]);

    const cycleChild = store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "x", oid: leaf }]),
    );
    const cycleRoot = store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "root", oid: cycleChild }]),
    );
    const changed = [
      ...parseTreeStream([serializeTree([{ mode: MODE_TREE, name: "x", oid: cycleRoot }])]),
    ][0];
    if (changed === undefined) throw new Error("cycle fixture is empty");
    db.run(
      `UPDATE git_tree_entries SET oid = ?, raw_entry = ?
        WHERE repo_id = 1 AND tree_oid = ? AND ordinal = 0`,
      cycleRoot,
      changed.rawEntry,
      cycleChild,
    );
    expect(() => [...store.walkTreeDiff(cycleRoot, null)]).toThrow(/tree cycle/);
  });

  it("streams one hundred nested changes in one statement under the wall gate", () => {
    const { db, store } = open();
    const beforeEntries = [];
    const afterEntries = [];
    for (let index = 0; index < 100; index++) {
      const name = `d-${String(index).padStart(3, "0")}`;
      const beforeChild = store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: "file", oid: oid(index + 1) }]),
      );
      const afterChild = store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: "file", oid: oid(index + 101) }]),
      );
      beforeEntries.push({ mode: MODE_TREE, name, oid: beforeChild });
      afterEntries.push({ mode: MODE_TREE, name, oid: afterChild });
    }
    const before = store.write("tree", serializeTree(beforeEntries));
    const after = store.write("tree", serializeTree(afterEntries));
    db.storage.resetCounters();
    const started = performance.now();
    const actual = [...store.walkTreeDiff(before, after)];
    const elapsed = performance.now() - started;
    expect(actual).toHaveLength(100);
    expect(db.storage.statementCount).toBe(1);
    expect(elapsed).toBeLessThan(100);
  });

  it("streams a flat fifty-thousand-entry addition with bounded SQL", () => {
    const { db, store } = open();
    const count = 50_000;
    const tree = store.write(
      "tree",
      serializeTree(
        Array.from({ length: count }, (_, index) => ({
          mode: MODE_FILE,
          name: `f-${String(index).padStart(5, "0")}`,
          oid: oid(index + 1),
        })),
      ),
    );
    db.storage.resetCounters();
    let seen = 0;
    for (const entry of store.walkTreeDiff(null, tree)) {
      expect(entry.path).toBe(`f-${String(seen).padStart(5, "0")}`);
      seen++;
    }
    expect(seen).toBe(count);
    expect(db.storage.statementCount).toBe(1);
  }, 30_000);

  it("accepts exactly 2,200 path bytes and rejects 2,201", () => {
    const make = (leafName: string) => {
      const { db, store } = open();
      let root = store.write(
        "tree",
        serializeTree([{ mode: MODE_FILE, name: leafName, oid: oid(1) }]),
      );
      for (let depth = 0; depth < 1_098; depth++) {
        root = store.write("tree", serializeTree([{ mode: MODE_TREE, name: "d", oid: root }]));
      }
      db.storage.resetCounters();
      return { db, store, root };
    };
    const accepted = make("leaf");
    expect([...accepted.store.walkTreeDiff(null, accepted.root)]).toEqual([
      {
        path: `${"d/".repeat(1_098)}leaf`,
        beforeMode: null,
        beforeOid: null,
        afterMode: MODE_FILE,
        afterOid: oid(1),
      },
    ]);
    expect(accepted.db.storage.statementCount).toBe(1);
    const rejected = make("leaff");
    expect(() => [...rejected.store.walkTreeDiff(null, rejected.root)]).toThrow(
      /path exceeds 2200 bytes/,
    );
    expect(rejected.db.storage.statementCount).toBe(1);
  }, 30_000);

  it("reads only complete packed tree sources", async () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "packed", oid: oid(1) }]);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const { packId } = await store.packs.ingest(slices(concat(chunks), 64));
    const tree = store.write("tree", data);
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", tree);
    expect([...store.walkTreeDiff(null, tree)]).toHaveLength(1);
    db.run(
      "UPDATE git_pack_meta SET state = 'receiving' WHERE repo_id = 1 AND pack_id = ?",
      packId,
    );
    expect(() => [...store.walkTreeDiff(null, tree)]).toThrow(/reimport or reclone/);
  });

  it("rejects a deep wide frontier before yielding a leaf", () => {
    const { db, store } = open();
    const count = 500;
    let before = store.write(
      "tree",
      serializeTree(
        Array.from({ length: count }, (_, index) => ({
          mode: MODE_FILE,
          name: `f-${String(index).padStart(3, "0")}`,
          oid: oid(index + 1),
        })),
      ),
    );
    let after = store.write(
      "tree",
      serializeTree(
        Array.from({ length: count }, (_, index) => ({
          mode: MODE_FILE,
          name: `f-${String(index).padStart(3, "0")}`,
          oid: oid(index + count + 1),
        })),
      ),
    );
    for (let depth = 0; depth < 1_000; depth++) {
      before = store.write("tree", serializeTree([{ mode: MODE_TREE, name: "d", oid: before }]));
      after = store.write("tree", serializeTree([{ mode: MODE_TREE, name: "d", oid: after }]));
    }
    db.storage.resetCounters();
    let seen = 0;
    let error: unknown;
    try {
      for (const _entry of store.walkTreeDiff(before, after)) seen++;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("E2BIG");
    expect(error.message).toMatch(/queue exceeds 16 MiB/);
    expect(seen).toBe(0);
    expect(db.storage.statementCount).toBe(1);
  }, 30_000);

  it("charges a long unilateral prefix twice before expanding its leaves", () => {
    const { db, store } = open();
    const leafCount = 5_000;
    const child = store.write(
      "tree",
      serializeTree(
        Array.from({ length: leafCount }, (_, index) => ({
          mode: MODE_FILE,
          name: `f-${String(index).padStart(4, "0")}`,
          oid: oid(index + 1),
        })),
      ),
    );
    const tree = store.write(
      "tree",
      serializeTree([{ mode: MODE_TREE, name: "d".repeat(2_000), oid: child }]),
    );

    const expectRejected = (before: string | null, after: string | null): void => {
      db.storage.resetCounters();
      let seen = 0;
      let error: unknown;
      try {
        for (const _entry of store.walkTreeDiff(before, after)) seen++;
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GitError);
      if (!(error instanceof GitError)) throw new Error("expected GitError");
      expect(error.code).toBe("E2BIG");
      expect(error.message).toMatch(/queue exceeds 16 MiB/);
      expect(seen).toBe(0);
      expect(db.storage.statementCount).toBe(1);
    };
    expectRejected(null, tree);
    expectRejected(tree, null);
  });

  it("charges unilateral leaf names in both path and sort key", () => {
    const { db, store } = open();
    const leafCount = 5_000;
    const prefix = "n".repeat(1_994);
    const tree = store.write(
      "tree",
      serializeTree(
        Array.from({ length: leafCount }, (_, index) => ({
          mode: MODE_FILE,
          name: `${prefix}${String(index).padStart(4, "0")}`,
          oid: oid(index + 1),
        })),
      ),
    );

    db.storage.resetCounters();
    let seen = 0;
    let error: unknown;
    try {
      for (const _entry of store.walkTreeDiff(null, tree)) seen++;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitError);
    if (!(error instanceof GitError)) throw new Error("expected GitError");
    expect(error.code).toBe("E2BIG");
    expect(error.message).toMatch(/queue exceeds 16 MiB/);
    expect(seen).toBe(0);
    expect(db.storage.statementCount).toBe(1);
  }, 30_000);
});
