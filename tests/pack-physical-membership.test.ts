import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject, serializeTree } from "../packages/git/src/common/objects.js";
import { type SharedRepoStore, SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import type { PackConnectivityOptions } from "../packages/git/src/store/pack/ingest/ingest-references-check.js";
import { MAX_PACK_INGEST_OBJECTS, OFFSET_WINDOW } from "../packages/git/src/store/pack/shared.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

function entryHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 128);
    first = rest & 127;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function offsetDistance(distance: number): Uint8Array {
  const bytes = [distance & 127];
  distance = Math.floor(distance / 128);
  while (distance > 0) {
    distance--;
    bytes.unshift(128 | (distance & 127));
    distance = Math.floor(distance / 128);
  }
  return new Uint8Array(bytes);
}

const BASE = utf8.encode("physical full base\n");
const TARGET = utf8.encode("physical delta target\n");
const BASE_OID = hashObject("blob", BASE);
const TARGET_OID = hashObject("blob", TARGET);

function pack(fillers: number | null): { bytes: Uint8Array; targetOffset: number | null } {
  const header = new Uint8Array(12);
  header.set(utf8.encode("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, fillers === null ? 1 : fillers + 2);
  const chunks = [header, entryHeader(3, BASE.length), new Uint8Array(deflateSync(BASE))];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (fillers !== null) {
    for (let index = 0; index < fillers; index++) {
      const data = utf8.encode(`filler ${index}\n`);
      const entry = concat([entryHeader(3, data.length), new Uint8Array(deflateSync(data))]);
      chunks.push(entry);
      offset += entry.length;
    }
    const delta = concat([
      encodeDeltaHeader(BASE.length, TARGET.length),
      new Uint8Array([TARGET.length]),
      TARGET,
    ]);
    chunks.push(
      entryHeader(6, delta.length),
      offsetDistance(offset - 12),
      new Uint8Array(deflateSync(delta)),
    );
  }
  const body = concat(chunks);
  return {
    bytes: concat([body, createHash("sha1").update(body).digest()]),
    targetOffset: fillers === null ? null : offset,
  };
}

function repeatedTreePack(tree: Uint8Array, deltas = 0, fillers = 0, malformed = false) {
  const header = new Uint8Array(12);
  header.set(utf8.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(
    8,
    3 + fillers + (deltas === 2 ? 1 : 0) + Number(malformed),
  );
  const chunks = [header, entryHeader(3, BASE.length), deflateSync(BASE)];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const rootOffset = offset;
  const offsets = [rootOffset];
  const append = (entry: Uint8Array) => {
    chunks.push(entry);
    offset += entry.length;
  };
  append(concat([entryHeader(2, tree.length), deflateSync(tree)]));
  const appendFillers = () => {
    for (let at = 0; at < fillers; at++) {
      const data = serializeTree([{ mode: "100644", name: `filler-${at}`, oid: BASE_OID }]);
      append(concat([entryHeader(2, data.length), deflateSync(data)]));
    }
  };
  if (deltas !== 2) appendFillers();
  for (let at = 0; at < Math.max(1, deltas); at++) {
    if (deltas === 2 && at === 1) appendFillers();
    offsets.push(offset);
    if (deltas === 0) append(concat([entryHeader(2, tree.length), deflateSync(tree)]));
    else {
      const delta = concat([
        encodeDeltaHeader(tree.length, tree.length),
        new Uint8Array([
          0xf0,
          tree.length & 255,
          (tree.length >>> 8) & 255,
          (tree.length >>> 16) & 255,
        ]),
      ]);
      append(
        concat([
          entryHeader(6, delta.length),
          offsetDistance(offset - rootOffset),
          deflateSync(delta),
        ]),
      );
    }
  }
  if (malformed) {
    const invalid = tree.subarray(0, tree.length - 1);
    append(concat([entryHeader(2, invalid.length), deflateSync(invalid)]));
  }
  const body = concat(chunks);
  return { bytes: concat([body, createHash("sha1").update(body).digest()]), offsets };
}

/** The connectivity option a fetch into a fresh store passes to pack ingest. */
function fetchConnectivity(store: SharedRepoStore): PackConnectivityOptions {
  return { reachability: null, trees: store, shallow: [], unshallow: [], acceptedPacks: [] };
}

describe("pack physical offset membership", () => {
  it("ingests a native-valid pack beyond 131072 objects with a deferred delta", async () => {
    const incoming = pack(131_071);
    const native = new GitFixture().init();
    const db = new TestDatabase();
    try {
      execFileSync("git", ["index-pack", "--strict", "--stdin"], {
        cwd: native.dir,
        input: incoming.bytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout).shared;
      const ingested = await store.packs.ingest(slices(incoming.bytes, 64 * 1024));
      expect(ingested.count).toBe(131_073);
      expect(
        db.scalar<number>(
          "SELECT COUNT(*) FROM git_pack_entries WHERE pack_id = ?",
          ingested.packId,
        ),
      ).toBe(ingested.count);
      const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout).shared;
      expect(cold.read(TARGET_OID)?.data).toEqual(native.catFile(TARGET_OID));
      expect(cold.read(BASE_OID)?.data).toEqual(native.catFile(BASE_OID));
      const filler = utf8.encode("filler 131070\n");
      const fillerOid = hashObject("blob", filler);
      expect(cold.read(fillerOid)?.data).toEqual(native.catFile(fillerOid));
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });

  it("refuses a pack header that exceeds the ingest metadata allocation ceiling", async () => {
    const header = new Uint8Array(12);
    header.set(utf8.encode("PACK"));
    const view = new DataView(header.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, MAX_PACK_INGEST_OBJECTS + 1);
    const bytes = concat([header, createHash("sha1").update(header).digest()]);
    const db = new TestDatabase();
    try {
      const database = new SqliteGitDatabase(db);
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout).shared;
      await expect(store.packs.ingest(slices(bytes, 4096))).rejects.toMatchObject({
        code: "E2BIG",
      });
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
        0,
      );
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_entries")).toBe(0);
    } finally {
      db.storage.db.close();
    }
  });

  it.each([false, true])(
    "keeps exact pack projections through selection and deletion (loose shadow: %s)",
    async (loose) => {
      const tree = serializeTree([{ mode: "100644", name: "file", oid: BASE_OID }]);
      const oid = hashObject("tree", tree);
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
      const checkout = database.createRepository("/repo", "ref: refs/heads/main");
      const store = database.openCheckout(checkout).shared;
      try {
        if (loose) store.write("tree", tree);
        const first = await store.packs.ingest(slices(repeatedTreePack(tree).bytes, 4096));
        const second = await store.packs.ingest(slices(repeatedTreePack(tree, 2).bytes, 4096));
        // Ingest projects no tree (ADR-0030); a first walk creates the one shared projection.
        expect(
          db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources WHERE tree_oid = ?", oid),
        ).toBe(loose ? 1 : 0);
        expect([...store.walkTree(oid)]).toHaveLength(1);
        expect(
          db.scalar<number>(
            "SELECT COUNT(*) FROM git_tree_sources WHERE tree_oid = ? AND complete = 1",
            oid,
          ),
        ).toBe(1);
        expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(1);
        expect(store.packs.completePackedEntry(oid)?.packId).toBe(first.packId);
        expect(store.packs.deleteCompletePacks([first.packId])).toBe(1);
        const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(
          checkout,
        ).shared;
        expect(Buffer.from(cold.read(oid)?.data ?? []).equals(tree)).toBe(true);
        expect([...cold.walkTree(oid)]).toEqual([{ path: "file", mode: "100644", oid: BASE_OID }]);
        expect(cold.packs.completePackedEntry(oid)?.packId).toBe(second.packId);
        expect(cold.packs.deleteCompletePacks([second.packId])).toBe(1);
        expect(
          db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources WHERE tree_oid = ?", oid),
        ).toBe(loose ? 1 : 0);
        expect(cold.has(oid)).toBe(loose);
        if (loose) expect([...cold.walkTree(oid)]).toHaveLength(1);
      } finally {
        db.storage.db.close();
      }
    },
  );

  it("rejects a malformed later tree at fetch ingest and leaves no projection", async () => {
    const tree = serializeTree([{ mode: "100644", name: "file", oid: BASE_OID }]);
    const oid = hashObject("tree", tree);
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    try {
      // Only a fetch's reference collector parses trees at ingest (ADR-0029, ADR-0030).
      await expect(
        store.packs.ingest(slices(repeatedTreePack(tree, 2, 2048, true).bytes, 4096), {
          connectivity: fetchConnectivity(store),
        }),
      ).rejects.toThrow(/malformed tree/);
      const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout).shared;
      expect(cold.has(oid)).toBe(false);
      expect(cold.read(oid)).toBeNull();
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
        0,
      );
      // The next ingest reclaims the rejected pending pack; no projection was ever written.
      await store.packs.ingest(slices(pack(null).bytes, 4096));
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'pending'")).toBe(
        0,
      );
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
      expect(() => [...cold.walkTree(oid)]).toThrow();
    } finally {
      db.storage.db.close();
    }
  });
  describe("a tree held by a rejected pending pack", () => {
    const tree = serializeTree([{ mode: "100644", name: "file", oid: BASE_OID }]);
    const oid = hashObject("tree", tree);

    async function pendingProjection() {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
      const store = database.openCheckout(
        database.createRepository("/repo", "ref: refs/heads/main"),
      ).shared;
      // The pending pack keeps a physical entry of the tree after the malformed one fails.
      await expect(
        store.packs.ingest(slices(repeatedTreePack(tree, 0, 2048, true).bytes, 4096), {
          connectivity: fetchConnectivity(store),
        }),
      ).rejects.toThrow(/malformed tree/);
      const projection = () =>
        db.one<{ source_key: number; complete: number }>(
          "SELECT source_key, complete FROM git_tree_sources WHERE tree_oid = ?",
          oid,
        );
      const entryRows = () =>
        db.scalar<number>(
          `SELECT COUNT(*) FROM git_tree_entries e
             JOIN git_tree_sources s ON s.source_key = e.source_key
            WHERE s.tree_oid = ?`,
          oid,
        );
      const reclaim = () => store.packs.ingest(slices(pack(null).bytes, 4096));
      return { db, store, projection, entryRows, reclaim };
    }

    it("leaves no projection and lets a loose write project the tree once", async () => {
      const { db, store, projection, entryRows } = await pendingProjection();
      try {
        expect(projection()).toBeUndefined();
        expect(store.has(oid)).toBe(false);

        expect(store.write("tree", tree)).toBe(oid);
        expect(projection()).toMatchObject({ complete: 1 });
        expect(entryRows()).toBe(1);
        expect(store.write("tree", tree)).toBe(oid);
        expect(entryRows()).toBe(1);
      } finally {
        db.storage.db.close();
      }
    });

    it("keeps the projection through a loose delete and drops it on reclaim", async () => {
      const { db, store, projection, entryRows, reclaim } = await pendingProjection();
      try {
        expect(projection()).toBeUndefined();
        store.write("tree", tree);
        const before = projection();
        expect(before).toMatchObject({ complete: 1 });
        db.run("DELETE FROM git_objects WHERE oid = ?", oid);
        expect(projection()).toEqual(before);

        await reclaim();
        expect(projection()).toBeUndefined();
        expect(entryRows()).toBe(0);
      } finally {
        db.storage.db.close();
      }
    });
  });

  it("writes no streamed tree projection in a rejected ingest", async () => {
    const tree = serializeTree(
      Array.from({ length: 30000 }, (_, at) => ({
        mode: "100644",
        name: `file-${String(at).padStart(6, "0")}`,
        oid: BASE_OID,
      })),
    );
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0, maxBufferedEntry: 65536 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    const oid = hashObject("tree", tree);
    const projections = () => db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources");
    try {
      // The streamed tree reaches the collector, then a later streamed tree fails to parse.
      await expect(
        store.packs.ingest(slices(repeatedTreePack(tree, 0, 0, true).bytes, 4096), {
          connectivity: fetchConnectivity(store),
        }),
      ).rejects.toThrow(/malformed tree/);
      expect(projections()).toBe(0);
      expect(store.has(oid)).toBe(false);

      await store.packs.ingest(slices(pack(null).bytes, 4096));
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta WHERE state = 'pending'")).toBe(
        0,
      );
      expect(projections()).toBe(0);
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
    } finally {
      db.storage.db.close();
    }
  });
  it.each([
    { label: "buffered full/full", deltas: 0, fillers: 0, count: 1, maxBufferedEntry: undefined },
    { label: "buffered full/delta", deltas: 1, fillers: 0, count: 1, maxBufferedEntry: undefined },
    { label: "buffered delta/delta", deltas: 2, fillers: 0, count: 1, maxBufferedEntry: undefined },
    {
      label: "full/full across flushes",
      deltas: 0,
      fillers: 2048,
      count: 1,
      maxBufferedEntry: undefined,
    },
    {
      label: "full/delta across flushes",
      deltas: 1,
      fillers: 2048,
      count: 1,
      maxBufferedEntry: undefined,
    },
    {
      label: "delta/delta across flushes",
      deltas: 2,
      fillers: 2048,
      count: 1,
      maxBufferedEntry: undefined,
    },
    { label: "streamed full/full", deltas: 0, fillers: 0, count: 30000, maxBufferedEntry: 65536 },
    { label: "chunked delta/delta", deltas: 2, fillers: 0, count: 30000, maxBufferedEntry: 65536 },
  ])(
    "accepts native-valid repeated nonempty trees: $label",
    async ({ deltas, fillers, count, maxBufferedEntry }) => {
      const tree = serializeTree(
        Array.from({ length: count }, (_, at) => ({
          mode: "100644",
          name: `file-${String(at).padStart(6, "0")}`,
          oid: BASE_OID,
        })),
      );
      const oid = hashObject("tree", tree);
      const { bytes, offsets } = repeatedTreePack(tree, deltas, fillers);
      const native = new GitFixture().init();
      const db = new TestDatabase();
      try {
        execFileSync("git", ["index-pack", "--stdin"], {
          cwd: native.dir,
          input: bytes,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const database = new SqliteGitDatabase(db, { objectCacheBytes: 0, maxBufferedEntry });
        const checkout = database.createRepository("/repo", "ref: refs/heads/main");
        await database.openCheckout(checkout).shared.packs.ingest(slices(bytes, 4096));
        const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(
          checkout,
        ).shared;
        const nativeTree = execFileSync("git", ["cat-file", "tree", oid], {
          cwd: native.dir,
          maxBuffer: tree.length + 1024,
        });
        expect(Buffer.from(tree).equals(nativeTree)).toBe(true);
        expect(Buffer.from(cold.read(oid)?.data ?? []).equals(nativeTree)).toBe(true);
        // Ingest projects no tree; the first walk projects it from one of the copies (ADR-0030).
        expect([...cold.walkTree(oid)]).toHaveLength(count);
        expect(
          db.all<{ offset: number }>(
            "SELECT offset FROM git_pack_entries WHERE oid = ? ORDER BY offset",
            oid,
          ),
        ).toEqual(offsets.map((offset) => ({ offset })));
        expect(
          db.scalar<number>(
            "SELECT COUNT(*) FROM git_tree_sources WHERE tree_oid = ? AND complete = 1",
            oid,
          ),
        ).toBe(1);
        expect(
          db.scalar<number>(
            `SELECT COUNT(*) FROM git_tree_entries e
               JOIN git_tree_sources s ON s.source_key = e.source_key
              WHERE s.tree_oid = ?`,
            oid,
          ),
        ).toBe(count);
      } finally {
        native.dispose();
        db.storage.db.close();
      }
    },
  );
  it.each([
    { prior: true, fillers: OFFSET_WINDOW * 2 - 2, label: "retained offset window" },
    {
      prior: false,
      fillers: OFFSET_WINDOW * 2 - 1,
      label: "evicted offset with canonical base in this pack",
    },
    {
      prior: true,
      fillers: OFFSET_WINDOW * 2 - 1,
      label: "evicted offset with canonical base in older pack",
    },
  ])("accepts native-valid full pack: $label", async ({ prior, fillers, label }) => {
    const native = new GitFixture().init();
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout).shared;
    const incoming = pack(fillers);
    try {
      if (prior) {
        execFileSync("git", ["index-pack", "--strict", "--stdin"], {
          cwd: native.dir,
          input: pack(null).bytes,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      execFileSync("git", ["index-pack", "--strict", "--stdin"], {
        cwd: native.dir,
        input: incoming.bytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(native.catFile(TARGET_OID)).toEqual(TARGET);
      if (prior) await store.packs.ingest(slices(pack(null).bytes, 4096));
      let failure: unknown;
      try {
        await store.packs.ingest(slices(incoming.bytes, 4096));
      } catch (error) {
        failure = error;
      }
      const evidence = db.all<{
        base_offset: number;
        physical_oid: string | null;
      }>(
        `SELECT pending.base_offset, physical.oid AS physical_oid
          FROM git_pack_pending pending
          LEFT JOIN git_pack_entries physical ON physical.repo_id = pending.repo_id
            AND physical.pack_id = pending.pack_id AND physical.offset = pending.base_offset
          WHERE pending.repo_id = ? LIMIT 2`,
        store.repoId,
      );
      const cold = new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openCheckout(checkout).shared;
      expect(cold.read(BASE_OID)?.data).toEqual(BASE);
      if (failure !== undefined) expect(cold.has(TARGET_OID)).toBe(false);
      expect(
        failure,
        JSON.stringify({
          label,
          packBytes: incoming.bytes.length,
          targetOffset: incoming.targetOffset,
          evidence,
        }),
      ).toBeUndefined();
      expect(cold.read(TARGET_OID)?.data).toEqual(native.catFile(TARGET_OID));
    } finally {
      native.dispose();
      db.storage.db.close();
    }
  });
});
