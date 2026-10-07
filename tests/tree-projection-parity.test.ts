import { afterAll, describe, expect, it } from "vitest";
import { readBlob } from "../packages/do/src/db/db.js";
import { displayMode, typeForMode } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TREE_QUEUE_ROW_FIXED_BYTES } from "../packages/git/src/store/schema/schema.js";
import { ensureTreeClosure } from "../packages/git/src/store/trees/tree-closure.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

interface ListedEntry {
  mode: string;
  type: string;
  oid: string;
  name: string;
  cumulativeBase: number;
}

const fixture = buildFixture();
const trees = fixture
  .git("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")
  .split("\n")
  .map((line) => line.split(" "))
  .filter(([, type]) => type === "tree")
  .map(([oid]) => oid!);
const expected = new Map(trees.map((oid) => [oid, lsTree(oid)]));
/** Every tree after the subtrees it names, the order a loose writer builds them in. */
const bottomUp = subtreesFirst();

afterAll(() => fixture.dispose());

/**
 * Duplicate subtrees, deep nesting, a gitlink, a symlink, an executable, and
 * two 2,100-entry directories whose versions arrive as deltas over three
 * commits; the long-named one exceeds a pack tree batch on its own.
 */
function buildFixture(): GitFixture {
  const git = new GitFixture().init();
  for (let at = 0; at < 2_100; at++) {
    const name = String(at).padStart(5, "0");
    git.write(`wide/f${name}`, `${at}\n`);
    git.write(`long/${name}-${"x".repeat(240)}`, `${at}\n`);
  }
  for (const copy of ["twin-a", "twin-b"]) {
    git.write(`${copy}/same.txt`, "same\n");
    git.write(`${copy}/inner/same.txt`, "inner\n");
  }
  git.write("a/b/c/d/e/deep.txt", "deep\n");
  git.write("names/žluť.txt", "utf-8\n");
  git.write("names/😀.txt", "astral\n");
  git.writeExecutable("bin/run", "#!/bin/sh\n");
  git.symlink("names/žluť.txt", "link");
  git.git("add", "-A");
  git.git("update-index", "--add", "--cacheinfo", `160000,${"ab".repeat(20)},vendor/module`);
  git.git("commit", "-q", "-m", "base");
  for (let change = 0; change < 3; change++) {
    const name = String(change * 700).padStart(5, "0");
    git.write(`wide/f${name}`, `changed ${change}\n`);
    git.write(`long/${name}-${"x".repeat(240)}`, `changed ${change}\n`);
    git.write(`a/b/c/d/e/deep.txt`, `deep ${change}\n`);
    git.git("add", "-A");
    git.git("commit", "-q", "-m", `change ${change}`);
  }
  return git;
}

function lsTree(oid: string): ListedEntry[] {
  const out = fixture.gitBinary("ls-tree", "-z", oid);
  const entries: ListedEntry[] = [];
  let start = 0;
  let cumulativeBase = 0;
  for (let at = 0; at < out.length; at++) {
    if (out[at] !== 0) continue;
    const record = out.subarray(start, at);
    const tab = record.indexOf(0x09);
    const [mode, type, entryOid] = record.subarray(0, tab).toString("latin1").split(" ");
    const name = record.subarray(tab + 1);
    // ls-tree pads a subtree's mode; the raw tree stores the five-byte "40000".
    const rawModeLength = mode === "040000" ? 5 : mode!.length;
    cumulativeBase += TREE_QUEUE_ROW_FIXED_BYTES + name.length + rawModeLength + entryOid!.length;
    entries.push({
      mode: mode!,
      type: type!,
      oid: entryOid!,
      name: name.toString("hex"),
      cumulativeBase,
    });
    start = at + 1;
  }
  return entries;
}

function subtreesFirst(): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (oid: string): void => {
    if (visited.has(oid)) return;
    visited.add(oid);
    for (const entry of expected.get(oid) ?? []) if (entry.type === "tree") visit(entry.oid);
    ordered.push(oid);
  };
  for (const oid of trees) visit(oid);
  return ordered;
}

function projected(db: TestDatabase, oid: string): ListedEntry[] {
  const source = db.one<{ complete: number; entry_count: number; base_cost: number }>(
    "SELECT complete, entry_count, base_cost FROM git_tree_sources WHERE tree_oid = ?",
    oid,
  );
  const rows = db.all<{
    ordinal: number;
    mode: string;
    name_bytes: Uint8Array;
    oid: string;
    cumulative_base: number;
  }>(
    `SELECT e.ordinal, e.mode, e.name_bytes, e.oid, e.cumulative_base
       FROM git_tree_entries e
       JOIN git_tree_sources s ON s.source_key = e.source_key
      WHERE s.tree_oid = ?
      ORDER BY e.ordinal`,
    oid,
  );
  expect(source).toEqual({
    complete: 1,
    entry_count: rows.length,
    base_cost: rows.at(-1)?.cumulative_base ?? 0,
  });
  expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_, ordinal) => ordinal));
  return rows.map((row) => ({
    mode: displayMode(row.mode),
    type: typeForMode(row.mode),
    oid: row.oid,
    name: Buffer.from(readBlob(row.name_bytes)).toString("hex"),
    cumulativeBase: row.cumulative_base,
  }));
}

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 1024 * 1024 });
  const store = database.openCheckout(database.createRepository("/repo", "ref: refs/heads/main"));
  return { db, store };
}

/** Count every later projection write: entry inserts and deletes, source updates. */
function watchProjectionWrites(db: TestDatabase): () => number {
  db.run("CREATE TEMP TABLE projection_writes (n INTEGER)");
  for (const [name, event] of [
    ["entry_insert", "INSERT ON main.git_tree_entries"],
    ["entry_delete", "DELETE ON main.git_tree_entries"],
    ["source_update", "UPDATE ON main.git_tree_sources"],
  ]) {
    db.run(
      `CREATE TEMP TRIGGER ${name} AFTER ${event}
       BEGIN INSERT INTO projection_writes VALUES (1); END`,
    );
  }
  return () => db.scalar<number>("SELECT count(*) FROM projection_writes") ?? 0;
}

function expectParity(db: TestDatabase): void {
  expect(db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(trees.length);
  for (const [oid, entries] of expected) expect(projected(db, oid), oid).toEqual(entries);
}

describe("tree projection parity with git ls-tree", () => {
  it("covers duplicate, nested, gitlink and >2,048-entry trees", () => {
    const listed = [...expected.values()];
    expect(Math.max(...listed.map((entries) => entries.length))).toBeGreaterThan(2_048);
    expect(listed.some((entries) => entries.some((entry) => entry.mode === "160000"))).toBe(true);
    expect(fixture.git("rev-parse", "HEAD:twin-a")).toBe(fixture.git("rev-parse", "HEAD:twin-b"));
  });

  it("projects every tree of an ingested pack exactly when a walk first reads it", async () => {
    const { db, store } = open();
    await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
    expect(db.scalar<number>("SELECT count(*) FROM git_tree_sources")).toBe(0);
    for (const oid of trees) [...store.walkTree(oid)];
    expectParity(db);

    // An incremental fetch that sees every tree again, then walks, writes no projection row.
    const projectionWrites = watchProjectionWrites(db);
    await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
    for (const oid of trees) [...store.walkTree(oid)];
    expect(projectionWrites()).toBe(0);
    expectParity(db);
  });

  it("writes nothing when a tree closure is ensured again", async () => {
    const { db, store } = open();
    await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
    ensureTreeClosure(db, store.repoId, store, trees);
    expectParity(db);

    const projectionWrites = watchProjectionWrites(db);
    ensureTreeClosure(db, store.repoId, store, trees);
    expect(projectionWrites()).toBe(0);
    expectParity(db);
  });

  it("projects every loose tree exactly, written singly or in one batch", () => {
    const raw = bottomUp.map((oid) => new Uint8Array(fixture.gitBinary("cat-file", "tree", oid)));
    const single = open();
    for (const data of [...raw, ...raw]) single.store.write("tree", data);
    expectParity(single.db);

    const batched = open();
    batched.store.writeObjects((batch) => {
      for (const data of [...raw, ...raw]) batch.write("tree", data);
    });
    expectParity(batched.db);
  });
});
