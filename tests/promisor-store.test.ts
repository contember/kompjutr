import { describe, expect, it } from "vitest";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { JSON_BATCH_ROWS } from "../packages/git/src/store/core/json-pages.js";
import { MAX_PROMISED_BLOB_LOOKUP_OIDS } from "../packages/git/src/store/fetch/promisor.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { readMaintenanceRootEpoch } from "../packages/git/src/store/maintenance/control.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { promiseMaintenance } from "./helpers/promise-maintenance.js";

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

const looseWriters = [
  {
    label: "scalar",
    write: (store: ReturnType<typeof open>["store"], data: Uint8Array) => store.write("blob", data),
    size: 16,
  },
  {
    label: "raw stream",
    write: (store: ReturnType<typeof open>["store"], data: Uint8Array) =>
      store.writeStream("blob", data.length, () => [data]),
    size: 16,
  },
  {
    label: "compressed stream",
    write: (store: ReturnType<typeof open>["store"], data: Uint8Array) =>
      store.writeStream("blob", data.length, () => [data]),
    size: 8192,
  },
  {
    label: "batch",
    write: (store: ReturnType<typeof open>["store"], data: Uint8Array) =>
      store.writeObjects((batch) => batch.write("blob", data)),
    size: 16,
  },
];

describe("promisor store", () => {
  it("rolls back promise fulfillment and epoch when streamed bytes change during publication", () => {
    const { db, store } = open();
    store.registerPromisorRemote("origin", "https://example.test/repo.git");
    const data = new Uint8Array(8192).fill(1);
    const oid = hashObject("blob", data);
    store.addPromisedBlobs("origin", [oid]);
    const epoch = readMaintenanceRootEpoch(db, store.repoId);
    let reads = 0;
    expect(() =>
      store.writeStream("blob", data.length, () => [
        ++reads === 1 ? data : new Uint8Array(data.length).fill(2),
      ]),
    ).toThrow(/stream changed/);
    expect(store.promisedMissing([oid])).toEqual([oid]);
    expect(store.has(oid)).toBe(false);
    expect(readMaintenanceRootEpoch(db, store.repoId)).toBe(epoch);
  });

  it.each(looseWriters)(
    "invalidates only actual $label fulfillment and rolls back on epoch exhaustion",
    ({ write, size }) => {
      const { db, store } = open();
      const epoch = () => readMaintenanceRootEpoch(db, store.repoId);
      const initialEpoch = epoch();
      store.registerPromisorRemote("origin", "https://example.test/repo.git");
      const data = new Uint8Array(size).fill(1);
      const oid = hashObject("blob", data);
      store.addPromisedBlobs("origin", [oid]);
      write(store, data);
      expect(epoch()).toBe(initialEpoch + 1);
      expect(store.promisedBlobCount()).toBe(0);
      write(store, data);
      write(store, new Uint8Array(size).fill(2));
      expect(epoch()).toBe(initialEpoch + 1);

      const rejected = new Uint8Array(size).fill(3);
      const rejectedOid = hashObject("blob", rejected);
      store.addPromisedBlobs("origin", [rejectedOid]);
      db.run(
        "UPDATE git_maintenance_control SET root_epoch = ? WHERE repo_id = ?",
        Number.MAX_SAFE_INTEGER,
        store.repoId,
      );
      expect(() => write(store, rejected)).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(store.promisedMissing([rejectedOid])).toEqual([rejectedOid]);
      expect(store.has(rejectedOid)).toBe(false);
      expect(epoch()).toBe(Number.MAX_SAFE_INTEGER);
    },
  );

  it("keeps historical catFile hydration after partial clone and cold maintenance", async () => {
    const origin = new GitFixture().init();
    origin.write("old.txt", "historical\n");
    const first = origin.commit("first");
    const oid = origin.git("rev-parse", `${first}:old.txt`);
    const data = new Uint8Array(origin.gitBinary("cat-file", "blob", oid));
    origin.remove("old.txt");
    origin.write("current.txt", "current\n");
    const head = origin.commit("second");
    origin.git("config", "uploadpack.allowFilter", "true");
    const server = await startGitServer(origin.dir);
    const fixture = promiseMaintenance();
    try {
      await fixture.runtime().git.clone({ url: server.url, dir: "/repo", filter: "blob:none" });
      expect(fixture.store().promisedMissing([oid])).toEqual([oid]);
      await fixture.until("classify-loose");
      expect(fixture.marked(oid)).toBe(0);
      const hydrated = await fixture
        .runtime()
        .git.catFile({ dir: "/repo", oid: first, filepath: "old.txt" });
      expect(hydrated.bytes).toEqual(data);
      expect(fixture.store().promisedBlobCount()).toBe(0);
      expect(await fixture.call()).toMatchObject({ phase: "roots", restarted: true });
      await fixture.until("sweep-loose");
      expect(fixture.marked(oid)).toBe(1);
      fixture.clock.value += GC_GRACE_MS + 1;
      await fixture.until("finish");
      const requests = server.requests.length;
      await fixture.expectReadable(head, oid, data);
      expect(server.requests).toHaveLength(requests);
    } finally {
      await server.close();
      origin.dispose();
    }
  });

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
    const epoch = () => readMaintenanceRootEpoch(db, store.repoId);
    const initialEpoch = epoch();
    let promiseCountDuringPublication = -1;

    await store.packs.ingest(slices(singleBlobPack(data), 7), {
      lifecycle: {
        reserved() {},
        published() {
          promiseCountDuringPublication = store.promisedBlobCount();
          expect(epoch()).toBe(initialEpoch + 1);
        },
      },
    });

    expect(promiseCountDuringPublication).toBe(0);
    expect(store.promisedBlobCount()).toBe(0);
    expect(store.has(oid)).toBe(true);
    await store.packs.ingest(slices(singleBlobPack(data), 7));
    expect(epoch()).toBe(initialEpoch + 1);

    const rollbackData = utf8.encode("publication rolls back\n");
    const rollbackOid = hashObject("blob", rollbackData);
    store.addPromisedBlobs("origin", [rollbackOid]);
    await expect(
      store.packs.ingest(slices(singleBlobPack(rollbackData), 7), {
        lifecycle: {
          reserved() {},
          published() {
            expect(store.promisedBlobCount()).toBe(0);
            expect(epoch()).toBe(initialEpoch + 2);
            throw new Error("injected publication failure");
          },
        },
      }),
    ).rejects.toThrow(/injected publication failure/);
    expect(store.promisedMissing([rollbackOid])).toEqual([rollbackOid]);
    expect(store.has(rollbackOid)).toBe(false);
    expect(epoch()).toBe(initialEpoch + 1);
    expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
      2,
    );
  });
});
