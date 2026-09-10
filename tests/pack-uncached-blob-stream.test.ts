import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { PackIngestInflater } from "../packages/git/src/store/pack/ingest/ingest-inflate.js";
import { PackReader } from "../packages/git/src/store/pack/ingest/ingest-reader.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

afterEach(() => vi.restoreAllMocks());

function nativePack(repo: GitFixture, oids: string[], ofs = false): Uint8Array {
  return new Uint8Array(
    execFileSync(
      "git",
      [
        "pack-objects",
        "--stdout",
        "--window=50",
        "--depth=10",
        ...(ofs ? ["--delta-base-offset"] : []),
      ],
      { cwd: repo.dir, input: `${oids.join("\n")}\n`, maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}

function open(db: TestDatabase, cacheEntryLimit = 1024) {
  const database = new SqliteGitDatabase(db, { cacheEntryLimit });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  database
    .openCheckout(checkout)
    .shared.registerPromisorRemote("origin", "https://example.test/repo.git");
  return {
    store: database.openCheckout(checkout).shared,
    cold: () => new SqliteGitDatabase(db).openCheckout(checkout).shared,
  };
}

describe("uncached full blob streaming", () => {
  it.each([1023, 1024, 1025])(
    "selects the path at the cache threshold for %i bytes",
    async (size) => {
      const repo = new GitFixture().init();
      const db = new TestDatabase();
      try {
        const oid = repo.writeObject("blob", randomBytes(size));
        const pack = nativePack(repo, [oid]);
        const { store, cold } = open(db);
        store.addPromisedBlobs("origin", [oid]);
        expect(store.promisedMissing([oid])).toEqual([oid]);
        const probe = vi.spyOn(PackIngestInflater.prototype, "inflateAt");
        await store.packs.ingest(slices(pack, 7));
        expect(probe).toHaveBeenCalledTimes(1);
        const result = probe.mock.results[0];
        expect(result?.type).toBe("return");
        if (result?.type !== "return") throw new Error("missing inflation result");
        expect(result.value.data === null).toBe(size > 1024);
        expect(result.value.streamedOid).toBe(size > 1024 ? oid : null);
        expect(cold().promisedMissing([oid])).toEqual([]);
        expect(cold().read(oid)?.data).toEqual(repo.catFile(oid));
      } finally {
        db.storage.db.close();
        repo.dispose();
      }
    },
  );

  it.each([false, true])(
    "resolves native delta children of an uncached base (OFS=%s)",
    async (ofs) => {
      const repo = new GitFixture().init();
      const db = new TestDatabase();
      try {
        const body = randomBytes(32 * 1024);
        const oids: string[] = [];
        for (let i = 0; i < 4; i++) {
          body[i] = i;
          oids.push(repo.writeObject("blob", body));
        }
        const pack = nativePack(repo, oids, ofs);
        const { store, cold } = open(db);
        const headers = vi.spyOn(PackReader.prototype, "entryHeader");
        const probe = vi.spyOn(PackIngestInflater.prototype, "inflateAt");
        await store.packs.ingest(slices(pack, 4096));
        expect(
          headers.mock.results.some(
            (r) => r.type === "return" && r.value.kind === (ofs ? "ofs" : "ref"),
          ),
        ).toBe(true);
        expect(
          probe.mock.results.some(
            (r) => r.type === "return" && r.value.data === null && r.value.streamedOid !== null,
          ),
        ).toBe(true);
        const reopened = cold();
        for (const oid of oids) expect(reopened.read(oid)?.data).toEqual(repo.catFile(oid));
      } finally {
        db.storage.db.close();
        repo.dispose();
      }
    },
  );

  it("streams an incompressible blob across physical rows and fulfills its promise", async () => {
    const repo = new GitFixture().init();
    const db = new TestDatabase();
    try {
      const oid = repo.writeObject("blob", randomBytes(2 * 1024 * 1024 + 1));
      const pack = nativePack(repo, [oid]);
      expect(pack.length).toBeGreaterThan(2 * 1024 * 1024);
      const { store, cold } = open(db, 2 * 1024 * 1024);
      store.addPromisedBlobs("origin", [oid]);
      const probe = vi.spyOn(PackIngestInflater.prototype, "inflateAt");
      await store.packs.ingest(slices(pack, 64 * 1024));
      expect(
        probe.mock.results.some(
          (r) => r.type === "return" && r.value.data === null && r.value.streamedOid === oid,
        ),
      ).toBe(true);
      expect(cold().promisedMissing([oid])).toEqual([]);
      const native = execFileSync("git", ["cat-file", "blob", oid], {
        cwd: repo.dir,
        maxBuffer: 8 * 1024 * 1024,
      });
      expect(cold().read(oid)?.data).toEqual(new Uint8Array(native));
    } finally {
      db.storage.db.close();
      repo.dispose();
    }
  });

  it.each(["size", "checksum"])(
    "rejects native-invalid %s without fulfilling the promise",
    async (kind) => {
      const repo = new GitFixture().init();
      const db = new TestDatabase();
      try {
        const oid = repo.writeObject("blob", randomBytes(2048));
        const pack = nativePack(repo, [oid]);
        if (kind === "size") {
          pack[12] = pack[12]! ^ 1;
          pack.set(createHash("sha1").update(pack.subarray(0, -20)).digest(), pack.length - 20);
        } else {
          pack[pack.length - 1] = pack[pack.length - 1]! ^ 1;
        }
        expect(() =>
          execFileSync("git", ["index-pack", "--strict", "--stdin"], {
            cwd: repo.dir,
            input: pack,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        ).toThrow();
        const { store, cold } = open(db);
        store.addPromisedBlobs("origin", [oid]);
        await expect(store.packs.ingest(slices(pack, 64))).rejects.toThrow(
          kind === "size" ? /size/ : /checksum/,
        );
        expect(cold().has(oid)).toBe(false);
        expect(cold().promisedMissing([oid])).toEqual([oid]);
      } finally {
        db.storage.db.close();
        repo.dispose();
      }
    },
  );
});
