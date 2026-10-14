import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readBlob } from "@kompjutr/sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { PACK_CHUNK } from "../packages/git/src/store/pack/shared.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

describe("sparse packed object reads", () => {
  const db = new TestDatabase();
  const native = new GitFixture();
  const small: string[] = [];
  const padding: string[] = [];
  let repoId = 0;
  let packId = 0;

  beforeAll(async () => {
    native.init();
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(45);
    for (let group = 0; group < 5; group++) {
      for (let item = 0; item < 8; item++) {
        const data = utf8.encode(`small object ${group}/${item}\n`);
        small.push(hashObject("blob", data));
        writer.object("blob", data);
      }
      const data = randomBytes(PACK_CHUNK + 1024);
      padding.push(hashObject("blob", data));
      writer.object("blob", data);
    }
    writer.finish();
    const bytes = concat(chunks);
    expect(bytes.length).toBeGreaterThan(5 * PACK_CHUNK);
    execFileSync("git", ["index-pack", "--stdin", "--fix-thin"], {
      cwd: native.dir,
      input: bytes,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const store = new SqliteGitDatabase(db).createBareRepository();
    repoId = store.repoId;
    packId = (await store.packs.ingest(slices(bytes, 64 * 1024))).packId;
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    native.dispose();
    db.storage.db.close();
  });

  const cold = () => new SqliteGitDatabase(db, { objectCacheBytes: 0 }).openBareRepository(repoId);

  function measureBlobs(): { bytes: number; rows: number } {
    const cost = { bytes: 0, rows: 0 };
    const iterate = db.iterate.bind(db);
    vi.spyOn(db, "iterate").mockImplementation(function* (query, ...bindings) {
      for (const row of iterate(query, ...bindings)) {
        if (row.data !== undefined) {
          cost.bytes += readBlob(row.data).length;
          cost.rows++;
        }
        yield row;
      }
    });
    return cost;
  }

  it("returns only requested compressed bytes across a pack larger than the row cache", () => {
    const store = cold();
    const expected = db.scalar<number>(
      `SELECT sum(data_len) FROM git_pack_entries WHERE repo_id = ? AND pack_id = ?
       AND oid IN (SELECT value FROM json_each(?))`,
      repoId,
      packId,
      JSON.stringify(small),
    );
    if (expected === undefined) throw new Error("missing compressed entry sizes");
    const cost = measureBlobs();
    for (let round = 0; round < 3; round++) {
      for (let item = 0; item < 8; item++) {
        for (let group = 0; group < 5; group++) {
          const oid = small[group * 8 + item]!;
          expect(store.read(oid)?.data).toEqual(native.catFile(oid));
        }
      }
    }
    expect(cost.rows).toBe(3 * small.length);
    expect(cost.bytes).toBe(3 * expected);
    expect(cost.bytes).toBeLessThan(PACK_CHUNK);
  });

  it("uses full row cache hits and does not cache partial slices as full rows", () => {
    const store = cold();
    const first = small[0]!;
    const second = small[1]!;
    const cost = measureBlobs();
    expect(store.read(first)?.data).toEqual(native.catFile(first));
    expect(store.read(second)?.data).toEqual(native.catFile(second));
    expect(cost.rows).toBe(2);
    expect(store.packs.readRaw(packId, 0, 4)).toEqual(utf8.encode("PACK"));
    expect(store.read(first)?.data).toEqual(native.catFile(first));
    expect(store.read(second)?.data).toEqual(native.catFile(second));
    expect(cost.rows).toBe(2);
  });

  it("scatters cross-chunk slices into complete objects", () => {
    const store = cold();
    const result = store.packs.readObjects(padding.slice(0, 2));
    for (const oid of padding.slice(0, 2))
      expect(result.get(oid)?.data).toEqual(native.catFile(oid));
  });

  it.each(["missing", "truncated"])("rejects a %s physical row", (damage) => {
    const row = db.one<{ data: unknown }>(
      "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = 0",
      repoId,
      packId,
    );
    if (row === undefined) throw new Error("missing fixture chunk");
    const original = readBlob(row.data);
    try {
      if (damage === "missing") {
        db.run(
          "DELETE FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = 0",
          repoId,
          packId,
        );
      } else {
        db.run(
          "UPDATE git_pack_data SET data = substr(data, 1, 10) WHERE repo_id = ? AND pack_id = ? AND seq = 0",
          repoId,
          packId,
        );
      }
      expect(() => cold().read(small[0]!)).toThrow(
        expect.objectContaining({ code: "ECORRUPT", message: expect.stringContaining(damage) }),
      );
    } finally {
      db.run(
        "INSERT OR REPLACE INTO git_pack_data (repo_id, pack_id, seq, data) VALUES (?, ?, 0, ?)",
        repoId,
        packId,
        original,
      );
    }
  });
});
