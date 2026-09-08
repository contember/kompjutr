import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { JSON_BATCH_ROWS } from "../packages/git/src/store/core/json-pages.js";
import { MAX_PROMISED_BLOB_LOOKUP_OIDS } from "../packages/git/src/store/fetch/promisor.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const repository = database.createRepository("/repo", "ref: refs/heads/main");
  return { db, database, repository, store: database.openCheckout(repository) };
}

function oidAt(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function singleBlobPack(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object("blob", data);
  writer.finish();
  return concat(chunks);
}

describe("promisor store", () => {
  it("retains normalized remote identity and rejects re-pointing", () => {
    const { db, store } = open();

    expect(store.readPromisorRemote("origin")).toBeNull();
    expect(store.registerPromisorRemote("origin", "https://example.test/repo.git///")).toEqual({
      remoteName: "origin",
      url: "https://example.test/repo.git",
      filter: "blob:none",
    });
    expect(store.registerPromisorRemote("origin", "https://example.test/repo.git/")).toEqual(
      store.readPromisorRemote("origin"),
    );
    expect(() =>
      store.registerPromisorRemote("origin", "https://elsewhere.test/repo.git"),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(store.readPromisorRemote("origin")?.url).toBe("https://example.test/repo.git");

    expect(() =>
      db.run(
        `INSERT INTO git_promisor_remotes (repo_id, remote_name, url, filter)
         VALUES (?, 'backup', 'https://example.test/repo.git', 'tree:0')`,
        store.repoId,
      ),
    ).toThrow(/CHECK/);
  });

  it("keeps promised blobs distinct from physical objects and cleans loose writes", () => {
    const { db, store } = open();
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    const firstData = utf8.encode("first promised blob\n");
    const secondData = utf8.encode("second promised blob\n");
    const first = hashObject("blob", firstData);
    const second = hashObject("blob", secondData);

    store.addPromisedBlobs("origin", [first, second, first]);

    expect(store.promisedBlobCount()).toBe(2);
    expect([...store.iteratePromisedBlobs()]).toEqual(
      [
        { oid: first, remoteName: "origin" },
        { oid: second, remoteName: "origin" },
      ].sort((left, right) => left.oid.localeCompare(right.oid)),
    );
    expect(store.promisedMissing([second, first, second, "f".repeat(40)])).toEqual([second, first]);
    expect(store.has(first)).toBe(false);
    expect(store.read(first)).toBeNull();
    expect(store.missing([first])).toEqual([first]);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_objects WHERE repo_id = ?", store.repoId),
    ).toBe(0);
    const repo = new Repository(store);
    expect(() => repo.readBlob(first)).toThrowError(
      expect.objectContaining({ code: "EPROMISED", oids: [first] }),
    );
    expect(() => repo.typeOf(first)).toThrowError(
      expect.objectContaining({ code: "EPROMISED", oids: [first] }),
    );

    expect(store.write("blob", firstData)).toBe(first);
    expect(store.has(first)).toBe(true);
    expect(store.promisedMissing([first, second])).toEqual([second]);
    expect(store.promisedBlobCount()).toBe(1);
    expect(() =>
      db.run(
        `INSERT INTO git_promised_blobs (repo_id, oid, remote_name, type)
         VALUES (?, ?, 'origin', 'tree')`,
        store.repoId,
        "a".repeat(40),
      ),
    ).toThrow(/CHECK/);
  });

  it("owns remote and promise rows by repository and cascades remote deletion", () => {
    const { db, database, repository, store } = open();
    const otherRepository = database.createRepository("/other", "ref: refs/heads/main");
    const other = database.openCheckout(otherRepository);
    const oid = "a".repeat(40);
    store.registerPromisorRemote("origin", "https://example.test/one.git");
    other.registerPromisorRemote("origin", "https://example.test/two.git");
    store.addPromisedBlobs("origin", [oid]);
    other.addPromisedBlobs("origin", [oid]);

    db.run(
      "DELETE FROM git_promisor_remotes WHERE repo_id = ? AND remote_name = 'origin'",
      repository.repoId,
    );
    expect(store.promisedBlobCount()).toBe(0);
    expect(other.promisedBlobCount()).toBe(1);

    other.destroy();
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_promisor_remotes WHERE repo_id = ?",
        other.repoId,
      ),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_promised_blobs WHERE repo_id = ?", other.repoId),
    ).toBe(0);
  });

  it("streams promise insertion in bounded pages and bounds missing probes", () => {
    const { db, store } = open();
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    const promised = Array.from({ length: JSON_BATCH_ROWS + 1 }, (_, index) => oidAt(index));
    db.storage.resetCounters();

    store.addPromisedBlobs("origin", promised);

    expect(store.promisedBlobCount()).toBe(promised.length);
    expect(db.storage.statementCount).toBeLessThan(10);
    expect(store.promisedMissing(promised)).toEqual(promised);
    expect(() => store.promisedMissing([...promised, ...promised])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect([...store.iteratePromisedBlobs()]).toHaveLength(JSON_BATCH_ROWS + 1);
    expect(MAX_PROMISED_BLOB_LOOKUP_OIDS).toBe(4_096);
  });

  it("removes fulfilled promises atomically with successful pack publication", async () => {
    const { db, store } = open();
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    const data = utf8.encode("packed promised blob\n");
    const oid = hashObject("blob", data);
    store.addPromisedBlobs("origin", [oid]);
    let promiseCountDuringPublication = -1;

    await store.packs.ingest(slices(singleBlobPack(data), 7), {
      lifecycle: {
        reserved() {},
        published() {
          promiseCountDuringPublication = store.promisedBlobCount();
        },
      },
    });

    expect(promiseCountDuringPublication).toBe(0);
    expect(store.promisedBlobCount()).toBe(0);
    expect(store.has(oid)).toBe(true);

    const rollbackData = utf8.encode("publication rolls back\n");
    const rollbackOid = hashObject("blob", rollbackData);
    store.addPromisedBlobs("origin", [rollbackOid]);
    await expect(
      store.packs.ingest(slices(singleBlobPack(rollbackData), 7), {
        lifecycle: {
          reserved() {},
          published() {
            expect(store.promisedBlobCount()).toBe(0);
            throw new Error("injected publication failure");
          },
        },
      }),
    ).rejects.toThrow(/injected publication failure/);
    expect(store.promisedMissing([rollbackOid])).toEqual([rollbackOid]);
    expect(store.has(rollbackOid)).toBe(false);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
      1,
    );
  });
});
