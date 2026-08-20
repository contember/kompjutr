import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashObject } from "../src/core/objects.js";
import { ancestors, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

function open() {
  const database = new SqliteGitDatabase(new TestDatabase());
  const repository = database.create("/repo", "ref: refs/heads/main");
  return { database, store: database.open(repository) };
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
    ]);
  });
});

describe("loose objects", () => {
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
