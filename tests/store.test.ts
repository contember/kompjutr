import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import { hashObject, MODE_FILE, serializeTree } from "../src/core/objects.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { ancestors, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const repository = database.create("/repo", "ref: refs/heads/main");
  return { db, database, store: database.open(repository) };
}

describe("path helpers", () => {
  it("walks ancestors nearest first", () => {
    expect(ancestors("/a/b/c")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    expect(ancestors("/")).toEqual(["/"]);
  });
});

describe("repository registry", () => {
  it("resolves the nearest registered ancestor", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    database.create("/", "ref: refs/heads/main");
    database.create("/projects/app", "ref: refs/heads/main");
    expect(database.find("/projects/app/src/index.ts")?.root).toBe("/projects/app");
    expect(database.find("/projects/other")?.root).toBe("/");
    expect(database.find("/projects/appliance")?.root).toBe("/");
  });

  it("creates no .git rows of any kind", () => {
    const { database } = open();
    const tables = database.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "git_blob_ids",
      "git_commits",
      "git_config",
      "git_index",
      "git_meta",
      "git_object_chunks",
      "git_objects",
      "git_pack_data",
      "git_pack_meta",
      "git_pack_objects",
      "git_pack_pending",
      "git_refs",
      "git_repositories",
      "git_shallow",
      "git_tree_effective",
      "git_tree_entries",
      "git_tree_sources",
    ]);
  });
});

describe("loose objects", () => {
  it("rejects an oversized tree name while the parser field is growing", () => {
    const { store } = open();
    const data = concat([
      utf8.encode("100644 "),
      new Uint8Array(2_201).fill(0x61),
      new Uint8Array([0]),
      new Uint8Array(20),
    ]);
    expect(() => store.write("tree", data)).toThrow(/entry name is too long/);
    expect(store.objectCount()).toBe(0);
  });

  it("round-trips through chunked storage", () => {
    const { store } = open();
    const data = new TextEncoder().encode("hello world\n");
    const oid = store.write("blob", data);
    expect(oid).toBe(hashObject("blob", data));
    expect(store.has(oid)).toBe(true);
    expect(store.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("chunks objects larger than one row", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(3_500_000));
    const oid = store.write("blob", data);
    const chunks = store.db.scalar<number>(
      "SELECT COUNT(*) FROM git_object_chunks WHERE oid = ?",
      oid,
    );
    expect(chunks).toBeGreaterThan(1);
    expect(store.read(oid)?.data.length).toBe(data.length);
  });

  it("resolves unambiguous prefixes only", () => {
    const { store } = open();
    const oid = store.write("blob", new TextEncoder().encode("a"));
    expect(store.resolvePrefix(oid.slice(0, 7))).toBe(oid);
    expect(store.resolvePrefix("0".repeat(8))).toBeNull();
  });
});

describe("effective tree sources", () => {
  const effective = (db: TestDatabase, repoId: number, oid: string) =>
    db.one<{ storage: string; source_id: number }>(
      "SELECT storage, source_id FROM git_tree_effective WHERE repo_id = ? AND tree_oid = ?",
      repoId,
      oid,
    );

  it("tracks single and batch loose tree writes", () => {
    const { db, store } = open();
    const first = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const second = serializeTree([{ mode: MODE_FILE, name: "b", oid: "2".repeat(40) }]);
    const firstOid = store.write("tree", first);
    const secondOid = store.writeObjects((batch) => batch.write("tree", second));

    expect(effective(db, 1, firstOid)).toEqual({ storage: "loose", source_id: 0 });
    expect(effective(db, 1, secondOid)).toEqual({ storage: "loose", source_id: 0 });
  });

  it("removes stale parsed rows before rewriting a deleted loose tree", () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = store.write("tree", data);
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(
      db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toBe(0);

    expect(store.write("tree", data)).toBe(oid);
    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: "1".repeat(40) }]);
  });

  it("falls back to a complete packed copy when the loose tree is deleted", async () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = store.write("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const { packId } = await store.packs.ingest(slices(concat(chunks), 64));

    expect(effective(db, 1, oid)).toEqual({ storage: "loose", source_id: 0 });
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(effective(db, 1, oid)).toEqual({ storage: "pack", source_id: packId });
    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: "1".repeat(40) }]);
  });

  it("isolates identical tree ids between repositories", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const first = database.open(database.create("/one", "ref: refs/heads/main"));
    const second = database.open(database.create("/two", "ref: refs/heads/main"));
    const data = serializeTree([{ mode: MODE_FILE, name: "same", oid: "1".repeat(40) }]);
    const oid = first.write("tree", data);
    expect(second.write("tree", data)).toBe(oid);

    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(effective(db, 1, oid)).toBeUndefined();
    expect(effective(db, 2, oid)).toEqual({ storage: "loose", source_id: 0 });
    expect([...second.walkTree(oid)]).toHaveLength(1);
  });
});

describe("object batches", () => {
  const chunkCount = (store: ReturnType<typeof open>["store"], oid: string) =>
    store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE oid = ?", oid);

  it("round-trips every payload shape through the ordinary read path", () => {
    const { store } = open();
    const shapes: Uint8Array[] = [
      new Uint8Array(0),
      utf8.encode("a tree entry or two\n"),
      // Random, so it neither compresses nor fits in one 1 MiB chunk row.
      new Uint8Array(randomBytes(3_500_000)),
      new Uint8Array(randomBytes(200_000)),
    ];
    const oids = store.writeObjects((batch) => shapes.map((data) => batch.write("blob", data)));
    // Identity by length plus hash: a megabyte-scale deep compare costs
    // more than the whole rest of this file.
    const same = (actual: Uint8Array, expected: Uint8Array) => {
      expect(actual.length).toBe(expected.length);
      expect(hashObject("blob", actual)).toBe(hashObject("blob", expected));
    };
    shapes.forEach((data, at) => {
      const oid = oids[at]!;
      expect(oid).toBe(hashObject("blob", data));
      expect(store.has(oid)).toBe(true);
      expect(store.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
      same(store.read(oid)?.data ?? new Uint8Array(1), data);
      same(concat([...(store.readChunks(oid) ?? [])]), data);
    });
    expect(chunkCount(store, oids[2]!)).toBeGreaterThan(1);
  });

  it("stages an object without writing a row until it is flushed", () => {
    const { store } = open();
    const data = utf8.encode("deferred\n");
    const batch = store.writeBatch();
    const oid = batch.write("blob", data);
    expect(oid).toBe(hashObject("blob", data));
    expect(store.has(oid)).toBe(false);
    expect(chunkCount(store, oid)).toBe(0);
    batch.flush();
    expect(store.has(oid)).toBe(true);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("removes the chunks a shorter write of the same oid does not reach", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(700_000));
    // writeStream rows at 64 KiB, the batch at 1 MiB, so the same oid goes
    // from many chunks to one. Content addressing makes that the only way
    // two writes of one oid can disagree on chunk count.
    const oid = store.writeStream("blob", data.length, function* () {
      yield data;
    });
    const before = chunkCount(store, oid) ?? 0;
    expect(before).toBeGreaterThan(1);

    // Drop the metadata row only: an interrupted write leaves exactly this,
    // chunks with nothing pointing at them, and `has` says no.
    store.db.run("DELETE FROM git_objects WHERE oid = ?", oid);
    expect(store.has(oid)).toBe(false);

    store.writeObjects((batch) => batch.write("blob", data));
    expect(chunkCount(store, oid)).toBe(1);
    expect(hashObject("blob", store.read(oid)?.data ?? new Uint8Array(1))).toBe(oid);
  });

  it("writes nothing for an object that is already stored", () => {
    const { store } = open();
    const data = utf8.encode("already here\n");
    const oid = store.write("blob", data);
    const written = () =>
      store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE repo_id = ?", 1);
    const before = written();
    store.writeObjects((batch) => batch.write("blob", data));
    expect(written()).toBe(before);
    expect(store.read(oid)?.data).toEqual(data);
  });
});

describe("bulk existence", () => {
  it("answers for loose, packed, both and absent exactly as has() does", async () => {
    const { db, store } = open();
    const looseOnly = utf8.encode("loose only\n");
    const packedOnly = utf8.encode("packed only\n");
    const both = utf8.encode("loose and packed\n");
    const looseOid = store.write("blob", looseOnly);
    const bothOid = store.write("blob", both);
    const packedOid = hashObject("blob", packedOnly);
    const absentOid = "0".repeat(40);

    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", packedOnly);
    writer.object("blob", both);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));

    const oids = [looseOid, packedOid, bothOid, absentOid];
    const present = store.hasAll(oids);
    for (const oid of oids) expect(present.has(oid)).toBe(store.has(oid));
    expect([...present].sort()).toEqual([looseOid, packedOid, bothOid].sort());
    expect(store.missing(oids)).toEqual([absentOid]);

    // One statement for the whole list, spanning both tables.
    db.storage.resetCounters();
    store.hasAll(oids);
    expect(db.storage.statementCount).toBe(1);
  });

  it("holds its own against an empty list and against duplicates", () => {
    const { store } = open();
    const oid = store.write("blob", utf8.encode("dup\n"));
    expect(store.hasAll([]).size).toBe(0);
    expect(store.missing([])).toEqual([]);
    expect(store.missing([oid, oid])).toEqual([]);
    expect(store.missing(["1".repeat(40), "1".repeat(40)])).toEqual(["1".repeat(40)]);
  });
});

describe("refs, config and index", () => {
  it("stores refs relationally with HEAD on the repository row", () => {
    const { store } = open();
    store.setRef("refs/heads/main", "a".repeat(40));
    store.setRef("refs/remotes/origin/main", "b".repeat(40));
    expect(store.getRef("refs/heads/main")).toBe("a".repeat(40));
    expect(store.listRefs("refs/heads/")).toEqual([
      { name: "refs/heads/main", target: "a".repeat(40) },
    ]);
    expect(store.head()).toBe("ref: refs/heads/main");
    store.setHead("c".repeat(40));
    expect(store.getRef("HEAD")).toBe("c".repeat(40));
  });

  it("keeps multi-valued config in order", () => {
    const { store } = open();
    store.configSet("user.email", "a@example.com");
    store.configAdd("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    store.configAdd("remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    expect(store.configGet("user.email")).toBe("a@example.com");
    expect(store.configGetAll("remote.origin.fetch")).toHaveLength(2);
    expect(store.configPaths("remote.")).toEqual(["remote.origin.fetch"]);
    store.configUnset("user.email");
    expect(store.configGet("user.email")).toBeUndefined();
  });

  it("keys the index by path and stage", () => {
    const { store } = open();
    store.indexPut({
      path: "src/a.ts",
      stage: 0,
      mode: 0o100644,
      oid: "a".repeat(40),
      size: 12,
      mtime: 5,
      ino: 7,
    });
    expect(store.indexGet("src/a.ts")?.oid).toBe("a".repeat(40));
    expect(store.hasConflicts()).toBe(false);
    store.indexPut({
      path: "src/a.ts",
      stage: 2,
      mode: 0o100644,
      oid: "b".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    expect(store.hasConflicts()).toBe(true);
    expect(store.indexEntries()).toHaveLength(2);
    store.indexRemove("src/a.ts");
    expect(store.indexEntries()).toHaveLength(0);
  });
});
