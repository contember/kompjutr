import { afterEach, describe, expect, it, vi } from "vitest";
import { toHex, utf8 } from "../packages/git/src/common/bytes.js";
import { ByteLru } from "../packages/git/src/common/lru.js";
import { hashObject, serializeCommit } from "../packages/git/src/common/objects.js";
import { PromisorTable } from "../packages/git/src/store/fetch/promisor.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { ExternalReferenceCheck } from "../packages/git/src/store/pack/ingest/ingest-references-external.js";
import { packGraphSql } from "../packages/git/src/store/pack/read/read-graph-sql.js";
import { PackReadEngine } from "../packages/git/src/store/pack/read.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { lifecycleDelta, lifecyclePack } from "./helpers/pack-maintenance.js";

const opened: TestDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) db.storage.db.close();
});

function fixture() {
  const db = new TestDatabase();
  opened.push(db);
  const database = new SqliteGitDatabase(db, { objectCacheBytes: 0, cacheEntryLimit: 0 });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const ingest = (bytes: Uint8Array) => store.packs.ingest(slices(bytes, 64));
  const full = (data: Uint8Array) =>
    ingest(lifecyclePack((writer) => writer.object("blob", data), 1));
  const starts = (oid: string, pending: number | null = null) =>
    db
      .all<{ pack_id: number; offset: number; start: number }>(
        packGraphSql(16),
        JSON.stringify([oid]),
        store.repoId,
        pending,
        store.repoId,
        pending,
        store.repoId,
        store.repoId,
      )
      .filter((row) => row.start === 1);
  return { db, store, ingest, full, starts };
}

describe("derived canonical pack copies", () => {
  it("reads one copy from the earliest complete pack through every read surface", async () => {
    const { db, store, full, starts } = fixture();
    const data = utf8.encode("canonical duplicate\n");
    const oid = hashObject("blob", data);
    const first = await full(data);
    const second = await full(data);
    expect(second.packId).toBeGreaterThan(first.packId);
    expect(store.packs.lookup(oid)).toMatchObject({ packId: first.packId, offset: 12 });
    expect(store.packs.completePackedEntry(oid)).toEqual({
      packId: first.packId,
      type: "blob",
      size: data.length,
    });
    expect(store.packs.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
    expect(store.objectInfo([oid])).toEqual([
      { oid, type: "blob", size: data.length, source: "pack", chunkRows: 0 },
    ]);
    expect([...store.readObjects([oid]).objects]).toEqual([[oid, { type: "blob", data }]]);
    expect(store.packs.count()).toBe(1);
    expect(store.packs.oids()).toEqual([oid]);
    expect(starts(oid)).toMatchObject([{ pack_id: first.packId, offset: 12 }]);
    expect(store.hasAll([oid])).toEqual(new Set([oid]));
    expect(store.writeObjects((batch) => batch.write("blob", data))).toBe(oid);
    expect(db.scalar<number>("SELECT count(*) FROM git_objects")).toBe(0);
  });

  it("starts at the earlier forward REF delta and cold-reads the same bytes as Git", async () => {
    const { store, ingest, starts } = fixture();
    const data = utf8.encode("forward duplicate\n");
    const oid = hashObject("blob", data);
    const bytes = lifecyclePack((writer) => {
      writer.refDelta(oid, lifecycleDelta(data.length, data));
      writer.object("blob", data);
    }, 2);
    const git = new GitFixture().init();
    try {
      const path = `.git/objects/pack/pack-${toHex(bytes.subarray(-20))}.pack`;
      git.write(path, bytes);
      git.git("index-pack", path);
      const expected = git.gitBinary("cat-file", "blob", oid);
      const pack = await ingest(bytes);
      const entry = store.packs.lookup(oid);
      expect(entry).toMatchObject({ packId: pack.packId, offset: 12 });
      expect(entry?.baseOffset).toBeGreaterThan(12);
      expect(starts(oid)).toMatchObject([{ pack_id: pack.packId, offset: 12 }]);
      expect(store.packs.read(oid)?.data).toEqual(new Uint8Array(expected));
      expect(store.packs.count()).toBe(1);
    } finally {
      git.dispose();
    }
  });

  it("keeps prefix ambiguity when the first matching OID has duplicate copies", async () => {
    const { store, full } = fixture();
    const byPrefix = new Map<string, Uint8Array>();
    let pair: [Uint8Array, Uint8Array] | undefined;
    for (let index = 0; index < 2000; index++) {
      const data = utf8.encode(`prefix collision ${index}\n`);
      const prefix = hashObject("blob", data).slice(0, 4);
      const previous = byPrefix.get(prefix);
      if (previous !== undefined) {
        pair = [previous, data];
        break;
      }
      byPrefix.set(prefix, data);
    }
    if (pair === undefined) throw new Error("fixture must have a four-digit prefix collision");
    const [a, b] = pair;
    await full(a);
    await full(a);
    await full(b);
    await full(b);
    const aOid = hashObject("blob", a);
    const bOid = hashObject("blob", b);
    expect(new Set(store.packs.findPrefix(aOid.slice(0, 4), 2))).toEqual(new Set([aOid, bOid]));
    expect(store.resolvePrefix(aOid.slice(0, 4))).toBeNull();
    expect(store.packs.count()).toBe(2);
  });

  it("ignores an earlier pending copy and preserves the pending pack's own start", async () => {
    const { db, store, full, starts } = fixture();
    const data = utf8.encode("pending duplicate\n");
    const oid = hashObject("blob", data);
    const pending = await full(data);
    const complete = await full(data);
    db.run("UPDATE git_pack_meta SET state = 'pending' WHERE pack_id = ?", pending.packId);
    expect(store.packs.lookup(oid)?.packId).toBe(complete.packId);
    expect(store.packs.completePackedEntry(oid)?.packId).toBe(complete.packId);
    expect(store.packs.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
    expect(store.objectInfo([oid])).toMatchObject([{ source: "pack", size: data.length }]);
    expect(store.readObjects([oid]).objects.get(oid)?.data).toEqual(data);
    expect(store.packs.count()).toBe(1);
    expect(store.packs.oids()).toEqual([oid]);
    expect(store.packs.findPrefix(oid.slice(0, 4), 2)).toEqual([oid]);
    expect(starts(oid)).toMatchObject([{ pack_id: complete.packId }]);
    expect(starts(oid, pending.packId)).toMatchObject([{ pack_id: pending.packId }]);
    const reader = new PackReadEngine(
      db,
      store.repoId,
      new ByteLru(0, (object) => object.data.length),
      new ByteLru(0, (chunk) => chunk.length),
      "pending-test",
      { cacheGeneration: 0, activePending: new Set([pending.packId]) },
      0,
      16,
    );
    expect(
      reader.readObjectsBounded([oid], pending.packId, "blob", false, true).get(oid)?.data,
    ).toEqual(data);

    db.run("UPDATE git_pack_meta SET state = 'pending' WHERE pack_id = ?", complete.packId);
    expect(store.packs.lookup(oid)).toBeNull();
    expect(store.packs.completePackedEntry(oid)).toBeNull();
    expect(store.packs.typeAndSize(oid)).toBeNull();
    expect(() => store.objectInfo([oid])).toThrow();
    expect(() => store.readObjects([oid])).toThrow();
    expect(store.packs.count()).toBe(0);
    expect(store.packs.oids()).toEqual([]);
    expect(store.packs.findPrefix(oid.slice(0, 4), 2)).toEqual([]);
    expect(starts(oid)).toEqual([]);
    expect(store.hasAll([oid])).toEqual(new Set());
  });

  it("pins OID and physical seeks in the issued read, connectivity and write queries", async () => {
    const { db, store, full } = fixture();
    const data = utf8.encode("query plan\n");
    const oid = hashObject("blob", data);
    await full(data);
    await full(data);
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    const all = vi.spyOn(db, "all");
    const iterate = vi.spyOn(db, "iterate");
    const run = vi.spyOn(db, "run");
    store.packs.lookup(oid);
    store.packs.typeAndSize(oid);
    store.packs.completePackedEntry(oid);
    store.packs.count();
    store.packs.findPrefix(oid.slice(0, 4), 2);
    store.packs.oids();
    store.objectInfo([oid]);
    store.readObjects([oid]);
    store.hasAll([oid]);
    store.writeObjects((batch) => batch.write("blob", data));
    store.addPromisedBlobs("origin", [oid]);
    store.promisedMissing([oid]);
    new PromisorTable(db, store.repoId).addUnresolvedBlobs("origin", [oid]);
    const identity = {
      name: "Fixture",
      email: "fixture@example.test",
      timestamp: 0,
      timezoneOffset: 0,
    };
    store.write(
      "commit",
      serializeCommit({
        tree: "1".repeat(40),
        parent: [],
        author: identity,
        committer: identity,
        message: "plan fixture\n",
      }),
    );
    const external = new ExternalReferenceCheck(
      db,
      store.repoId,
      store,
      {
        reached: () => new Set(),
      },
      false,
    );
    expect(external.add([{ oid, expected: "blob" }])).toEqual([]);
    expect(() => external.add([{ oid, expected: "tree" }])).toThrow(/requires .* to be a tree/);
    const queries = new Map(
      [...all.mock.calls, ...iterate.mock.calls, ...run.mock.calls]
        .filter(([sql]) => sql.includes("git_pack_entries"))
        .map(([sql, ...bindings]) => [sql, bindings]),
    );
    expect(queries.size).toBe(16);
    vi.restoreAllMocks();
    for (const [sql, bindings] of queries) {
      const plan = db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...bindings)
        .map((row) => row.detail);
      const seek =
        sql.includes("SELECT DISTINCT") || sql.includes("COUNT(DISTINCT")
          ? /SEARCH object USING COVERING INDEX git_pack_entries_by_oid \(repo_id=\?/
          : /SEARCH candidate USING COVERING INDEX git_pack_entries_by_oid \(repo_id=\? AND oid=\?\)/;
      expect(
        plan.some((row) => seek.test(row)),
        sql,
      ).toBe(true);
      for (const row of plan) {
        expect(row, sql).not.toMatch(/^SCAN (candidate|packed|object|entry)\b/);
        expect(row, sql).not.toMatch(/USING PRIMARY KEY \(repo_id=\?\)(?: |$)/);
      }
    }
  });
});
