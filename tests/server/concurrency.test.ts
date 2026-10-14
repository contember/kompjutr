import { describe, expect, it } from "vitest";
import { createGitServer, SqliteGitDatabase } from "../../packages/git/src/index.js";
import { PACK_INGEST_LEASE_MS } from "../../packages/git/src/store/pack/shared.js";
import {
  cleanupTransfers,
  TRANSFER_TTL_MS,
} from "../../packages/git/src/store/transfer/lifetime.js";
import { TestDatabase } from "../helpers/db.js";
import { GitFixture, slices } from "../helpers/git.js";
import {
  assertColdTip,
  concurrentRepository,
  finishMaintenance,
  firstYieldBarrier,
  uploadRequest,
  verifyDownload,
} from "../helpers/server-concurrency.js";
import { runGit } from "../helpers/server-oracle-http.js";

const MAX_PACK_BYTES = 16 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const OLD_LOG = { actor: null, reason: "fixture state", timestamp: 0, timezoneOffset: 0 };

describe("Smart HTTP concurrent schedules", () => {
  it.each(["left", "right"])(
    "receive/receive: %s publishes first; the competing reservation and stale retry cannot overwrite it",
    async (winner) => {
      const barrier = firstYieldBarrier();
      const fixture = await concurrentRepository({ yieldNow: barrier.yieldNow });
      const first = winner === "left" ? fixture.left : fixture.right;
      const second = winner === "left" ? fixture.right : fixture.left;
      const competitor = createGitServer(fixture.store, { maxPackBytes: MAX_PACK_BYTES });
      try {
        const pending = fixture.server.fetch(fixture.push(fixture.base, first));
        await barrier.entered;
        expect((await competitor.fetch(fixture.push(fixture.base, second))).status).toBe(409);
        assertColdTip(fixture.db, fixture.store.repoId, fixture.native, fixture.base);
        barrier.release();
        expect(await (await pending).text()).toContain("ok refs/heads/main");
        expect(await (await competitor.fetch(fixture.push(fixture.base, second))).text()).toContain(
          "stale old object id",
        );
        assertColdTip(fixture.db, fixture.store.repoId, fixture.native, first);
        expect(await (await competitor.fetch(fixture.push(first, second))).text()).toContain(
          "ok refs/heads/main",
        );
        assertColdTip(fixture.db, fixture.store.repoId, fixture.native, second);
      } finally {
        barrier.release();
        fixture.native.dispose();
      }
    },
  );

  it.each([true, false])("upload/receive: upload snapshot comes first=%s", async (uploadFirst) => {
    const fixture = await concurrentRepository();
    const server = await fixture.listen();
    try {
      let download: Response;
      if (uploadFirst) {
        download = await fixture.server.fetch(uploadRequest(fixture.base));
        await runGit(fixture.native.dir, ["push", server.url, "main"]);
      } else {
        await runGit(fixture.native.dir, ["push", server.url, "main"]);
        expect((await fixture.server.fetch(uploadRequest(fixture.base))).status).toBe(400);
        download = await fixture.server.fetch(uploadRequest(fixture.right));
      }
      assertColdTip(fixture.db, fixture.store.repoId, fixture.native, fixture.right);
      await verifyDownload(
        download,
        uploadFirst ? fixture.base : fixture.right,
        uploadFirst ? fixture.right : fixture.left,
      );
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
      fixture.native.dispose();
    }
  });

  it.each([true, false])(
    "receive/checkout: checkout attachment comes first=%s",
    async (attachFirst) => {
      const barrier = firstYieldBarrier();
      const fixture = await concurrentRepository({ yieldNow: barrier.yieldNow });
      try {
        const pending = fixture.server.fetch(fixture.push(fixture.base, fixture.right));
        await barrier.entered;
        if (attachFirst)
          fixture.database.createCheckout(
            fixture.store.repoId,
            "/attached",
            "ref: refs/heads/main",
          );
        barrier.release();
        const text = await (await pending).text();
        if (attachFirst) expect(text).toContain("branch is attached to a checkout");
        else {
          expect(text).toContain("ok refs/heads/main");
          fixture.database.createCheckout(
            fixture.store.repoId,
            "/attached",
            "ref: refs/heads/main",
          );
        }
        const expected = attachFirst ? fixture.base : fixture.right;
        assertColdTip(fixture.db, fixture.store.repoId, fixture.native, expected);
        const cold = new SqliteGitDatabase(fixture.db);
        const checkout = cold.findCheckout("/attached");
        expect(checkout?.head).toBe("ref: refs/heads/main");
        expect(
          checkout === null ? null : cold.openCheckout(checkout).getRef("refs/heads/main"),
        ).toBe(expected);
      } finally {
        barrier.release();
        fixture.native.dispose();
      }
    },
  );

  it.each([true, false])(
    "restart/publication: restart comes before publication=%s",
    async (restartFirst) => {
      const barrier = firstYieldBarrier();
      let now = 1_800_000_000_000;
      const fixture = await concurrentRepository({ now: () => now, yieldNow: barrier.yieldNow });
      try {
        const pending = fixture.server.fetch(fixture.push(fixture.base, fixture.right));
        await barrier.entered;
        if (restartFirst) {
          const cold = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
          expect(cold.getRef("refs/heads/main")).toBe(fixture.base);
          now += PACK_INGEST_LEASE_MS + 1;
          const successor = createGitServer(cold, { maxPackBytes: MAX_PACK_BYTES, now: () => now });
          expect(
            await (await successor.fetch(fixture.push(fixture.base, fixture.left))).text(),
          ).toContain("ok refs/heads/main");
          barrier.release();
          expect((await pending).status).toBe(409);
          assertColdTip(fixture.db, fixture.store.repoId, fixture.native, fixture.left);
        } else {
          barrier.release();
          const response = await pending;
          await response.body?.cancel("lost success response before restart");
          assertColdTip(fixture.db, fixture.store.repoId, fixture.native, fixture.right);
          const cold = new SqliteGitDatabase(fixture.db).openBareRepository(fixture.store.repoId);
          const retries = createGitServer(cold, { maxPackBytes: MAX_PACK_BYTES });
          expect(
            await (await retries.fetch(fixture.push(fixture.base, fixture.right))).text(),
          ).toContain("stale old object id");
          expect(
            cold.reflog("refs/heads/main").filter((entry) => entry.reason === "push"),
          ).toHaveLength(1);
          assertColdTip(fixture.db, fixture.store.repoId, fixture.native, fixture.right);
        }
      } finally {
        barrier.release();
        fixture.native.dispose();
      }
    },
  );

  it.each([true, false])(
    "upload/GC: transfer root is acquired before sweeping=%s",
    async (uploadFirst) => {
      let now = 0;
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db, { now: () => now });
      const store = database.createBareRepository();
      const server = createGitServer(store, { maxPackBytes: MAX_PACK_BYTES, now: () => now });
      const native = new GitFixture().init();
      try {
        native.write("file", "collectible");
        const oid = native.commit("collectible");
        await store.packs.ingest(slices(native.packAll(), 8192), { now: () => now });
        store.mutateRefs({ puts: [{ name: "refs/heads/main", target: oid }] }, OLD_LOG);
        store.mutateRefs({ deletes: ["refs/heads/main"] }, OLD_LOG);
        now = 100 * DAY;
        finishMaintenance(database, store.repoId, now);
        now += 16 * DAY;
        let response: Response | undefined;
        if (uploadFirst) {
          store.mutateRefs({ puts: [{ name: "refs/heads/main", target: oid }] }, OLD_LOG);
          response = await server.fetch(uploadRequest(oid));
          store.mutateRefs({ deletes: ["refs/heads/main"] }, OLD_LOG);
        }
        finishMaintenance(database, store.repoId, now);
        const cold = new SqliteGitDatabase(db).openBareRepository(store.repoId);
        expect(cold.getRef("refs/heads/main")).toBeNull();
        if (response !== undefined) {
          expect(cold.read(oid)?.type).toBe("commit");
          await verifyDownload(response, oid);
          finishMaintenance(database, store.repoId, now);
          now += 16 * DAY;
          finishMaintenance(database, store.repoId, now);
        } else expect((await server.fetch(uploadRequest(oid))).status).toBe(400);
        expect(new SqliteGitDatabase(db).openBareRepository(store.repoId).read(oid)).toBeNull();
      } finally {
        native.dispose();
      }
    },
  );

  it("expired paused upload cannot read after cold cleanup and GC", async () => {
    let now = 0;
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { now: () => now });
    const store = database.createBareRepository();
    const server = createGitServer(store, { maxPackBytes: MAX_PACK_BYTES, now: () => now });
    const native = new GitFixture().init();
    try {
      native.write("file", "expires");
      const oid = native.commit("expires");
      await store.packs.ingest(slices(native.packAll(), 8192), { now: () => now });
      store.mutateRefs({ puts: [{ name: "refs/heads/main", target: oid }] }, OLD_LOG);
      now = 100 * DAY;
      const response = await server.fetch(uploadRequest(oid));
      store.mutateRefs({ deletes: ["refs/heads/main"] }, OLD_LOG);
      now += TRANSFER_TTL_MS + 1;
      const coldDatabase = new SqliteGitDatabase(db);
      const coldStore = coldDatabase.openBareRepository(store.repoId);
      while (!cleanupTransfers(coldStore, now)) {}
      finishMaintenance(coldDatabase, store.repoId, now);
      now += 16 * DAY;
      finishMaintenance(coldDatabase, store.repoId, now);
      expect(coldStore.read(oid)).toBeNull();
      await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "ESTALE" });
      expect(
        new SqliteGitDatabase(db).openBareRepository(store.repoId).getRef("refs/heads/main"),
      ).toBeNull();
    } finally {
      native.dispose();
    }
  });
});
