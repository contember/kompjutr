import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import {
  type MaintenanceResult,
  maintainRepository,
  type RepositoryKind,
  SqliteGitDatabase,
} from "../packages/git/src/index.js";
import { GC_GRACE_MS } from "../packages/git/src/store/maintenance/sweep.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture, slices } from "./helpers/git.js";

const NOW = 1_800_000_000_000;

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db, { now: () => NOW });
  return { db, database };
}

function completeMaintenance(database: SqliteGitDatabase, repoId: number, nowMs = NOW) {
  let result: MaintenanceResult;
  for (let step = 0; step < 100; step++) {
    result = maintainRepository(database, repoId, { nowMs });
    if (result.status === "complete") return result;
  }
  throw new Error("maintenance did not complete");
}

describe("bare repository ownership", () => {
  it("creates and cold opens an empty bare repository without routing or checkout state", () => {
    const { db, database } = open();
    const store = database.createBareRepository();
    const kind: RepositoryKind = store.kind;
    expect(kind).toBe("bare");
    expect(store.defaultBranch()).toBe("refs/heads/main");
    expect(database.listCheckouts(store.repoId)).toEqual([]);
    expect(database.listRoutingRoots()).toEqual([]);
    expect(database.listRoutingCheckouts()).toEqual([]);
    expect(database.findCheckout("/")).toBeNull();
    expect(store.reflog("refs/heads/main")).toEqual([]);
    expect(db.scalar("SELECT count(*) FROM git_index_state")).toBe(0);
    const reopened = new SqliteGitDatabase(db).openBareRepository(store.repoId);
    expect(reopened.kind).toBe("bare");
    expect(reopened.listRefs()).toEqual([]);
    expect(reopened.defaultBranch()).toBe(store.defaultBranch());
    expect(completeMaintenance(database, store.repoId).reachableObjects).toBe(0);
  });

  it("keeps the default branch independent of refs and attached checkout HEAD", () => {
    const { db, database } = open();
    const store = database.createBareRepository("refs/heads/trunk");
    const row = database.createCheckout(store.repoId, "/attached", "ref: refs/heads/topic");
    const checkout = database.openCheckout(row);
    store.setDefaultBranch("refs/heads/unborn");
    expect(checkout.head()).toBe("ref: refs/heads/topic");
    expect(store.getRef("refs/heads/unborn")).toBeNull();
    expect(new SqliteGitDatabase(db).openBareRepository(store.repoId).defaultBranch()).toBe(
      "refs/heads/unborn",
    );
    for (const invalid of [
      "HEAD",
      "main",
      "refs/tags/tag",
      "refs/heads/",
      "refs/heads/a..b",
      "refs/heads/a\0b",
    ]) {
      expect(() => store.setDefaultBranch(invalid)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(() => database.createBareRepository(invalid)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
    expect(db.scalar("SELECT count(*) FROM git_repositories")).toBe(1);
    expect(store.defaultBranch()).toBe("refs/heads/unborn");
  });

  it("preserves workspace and provisional clone ownership errors", () => {
    const { database } = open();
    const workspace = database.createRepository("/workspace", "ref: refs/heads/main");
    expect(database.openShared(workspace.repoId).kind).toBe("workspace");
    expect(() => database.openBareRepository(workspace.repoId)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => database.removeCheckout(workspace.id, () => undefined)).toThrowError(
      expect.objectContaining({ code: "EPRIMARYWORKTREE" }),
    );
    const owner = database.beginProvisionalClone(
      "/clone",
      "ref: refs/heads/main",
      NOW,
      () => undefined,
    );
    expect(() => database.openBareRepository(owner.checkout.repoId)).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    expect(() => database.openBareRepository(99_999)).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    expect(() => database.openBareRepository(0)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    database.discardProvisionalClone(owner, NOW, () => undefined);
  });

  it("cold opens native Git objects and refs without a checkout", async () => {
    const { db, database } = open();
    const fixture = new GitFixture().init();
    try {
      fixture.write("file.txt", "content\n");
      const oid = fixture.commit("initial");
      const store = database.createBareRepository();
      await store.packs.ingest(slices(fixture.packAll(), 13));
      store.setRef("refs/heads/main", oid);
      const cold = new SqliteGitDatabase(db, { now: () => NOW }).openBareRepository(store.repoId);
      expect(cold.read(oid)?.data).toEqual(
        new Uint8Array(fixture.gitBinary("cat-file", "commit", oid)),
      );
      expect(cold.getRef("refs/heads/main")).toBe(fixture.git("rev-parse", "refs/heads/main"));
      expect(cold.reflog("refs/heads/main")[0]).toMatchObject({ newOid: oid });
      expect(database.listCheckouts(store.repoId)).toEqual([]);
      expect(completeMaintenance(database, store.repoId).reachableObjects).toBe(3);
    } finally {
      fixture.dispose();
    }
  });

  it("retains refs, reflogs and objects after the first and last checkout are removed", () => {
    const { database } = open();
    const store = database.createBareRepository();
    const first = database.createCheckout(store.repoId, "/repo/a", "ref: refs/heads/main");
    const second = database.createCheckout(store.repoId, "/repo/a/b", "ref: refs/heads/topic");
    expect(first.isPrimary).toBe(false);
    expect(second.isPrimary).toBe(false);
    const checkout = database.openCheckout(first);
    const oid = store.write("blob", utf8.encode("one"));
    store.setRef("refs/heads/main", oid);
    expect(checkout.reflog("HEAD")[0]).toMatchObject({ oldOid: null, newOid: oid });
    expect(database.openCheckout(second).reflog("HEAD")).toEqual([]);
    expect(database.findCheckout("/repo/a/b/file")?.id).toBe(second.id);
    expect(database.listRoutingRoots()).toEqual(["/repo/a", "/repo/a/b"]);
    expect(database.listRoutingCheckouts().map((row) => row.id)).toEqual([first.id, second.id]);
    const removed: string[] = [];
    database.removeCheckout(first.id, (row) => {
      removed.push(row.root);
    });
    expect(removed).toEqual(["/repo/a"]);
    expect(() => checkout.head()).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => database.openCheckout(first)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    database.removeCheckouts(store.repoId, [second.id]);
    expect(database.openBareRepository(store.repoId)).toBe(store);
    expect(database.listCheckouts(store.repoId)).toEqual([]);
    store.updateRefExpected("refs/heads/main", oid, store.write("blob", utf8.encode("two")));
    expect(store.reflog("refs/heads/main")).toHaveLength(2);
    store.deleteRef("refs/heads/main");
    expect(store.reflog("refs/heads/main")).toHaveLength(3);
    expect(store.read(oid)?.data).toEqual(utf8.encode("one"));
    expect(() => store.getRef("HEAD")).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() => store.reflog("HEAD")).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("rolls back a failed first attachment and protects attached branches", () => {
    const { database } = open();
    const store = database.createBareRepository();
    expect(() =>
      database.createCheckout(store.repoId, "/failed", "ref: refs/heads/main", () => {
        throw new Error("initialization failed");
      }),
    ).toThrow("initialization failed");
    expect(database.listCheckouts(store.repoId)).toEqual([]);
    const row = database.createCheckout(store.repoId, "/attached", "ref: refs/heads/main");
    expect(() =>
      database.createCheckout(store.repoId, "/duplicate", "ref: refs/heads/main"),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHINUSE" }));
    expect(() =>
      database.removeCheckout(row.id, () => {
        throw new Error("removal failed");
      }),
    ).toThrow("removal failed");
    expect(database.openCheckout(row).head()).toBe("ref: refs/heads/main");
  });

  it("collects unreachable objects with no checkout and preserves another repository", () => {
    const { database } = open();
    const store = database.createBareRepository();
    const other = database.createBareRepository();
    const unreachable = store.write("blob", utf8.encode("unreachable"));
    const retained = other.write("blob", utf8.encode("retained"));
    other.setRef("refs/tags/retained", retained);
    completeMaintenance(database, store.repoId);
    const result = completeMaintenance(database, store.repoId, NOW + GC_GRACE_MS);
    expect(result.reclaimedObjects).toBe(1);
    expect(store.has(unreachable)).toBe(false);
    expect(other.read(retained)?.data).toEqual(utf8.encode("retained"));
    expect(() => maintainRepository(database, store.repoId, { nowMs: -1 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("invalidates remembered primary rows even when their checkout facade was never opened", () => {
    const { database } = open();
    const row = database.createRepository("/work", "ref: refs/heads/main");
    const other = database.createRepository("/other", "ref: refs/heads/main");
    database.openShared(row.repoId).destroy();
    expect(() => database.openCheckout(row)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => database.openCheckout(row.id)).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    expect(database.openCheckout(other).head()).toBe("ref: refs/heads/main");
  });

  it("destroys repository-owned rows and invalidates shared and checkout handles", () => {
    const { db, database } = open();
    const store = database.createBareRepository();
    const row = database.createCheckout(store.repoId, "/attached", "ref: refs/heads/main");
    const checkout = database.openCheckout(row);
    const oid = store.write("blob", utf8.encode("cached"));
    store.setRef("refs/tags/cached", oid);
    store.configSet("user.name", "Bare");
    store.read(oid);
    store.destroy();
    for (const action of [
      () => store.read(oid),
      () => store.getRef("refs/tags/cached"),
      () => store.reflog("refs/tags/cached"),
      () => store.configGet("user.name"),
      () => store.write("blob", utf8.encode("late")),
      () => store.defaultBranch(),
      () => store.setDefaultBranch("refs/heads/late"),
      () => store.destroy(),
      () => database.openBareRepository(store.repoId),
      () => maintainRepository(database, store.repoId, { nowMs: NOW }),
    ]) {
      expect(action).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));
    }
    expect(() => checkout.head()).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(database.listRoutingRoots()).toEqual([]);
    expect(db.scalar("SELECT count(*) FROM git_objects")).toBe(0);
    expect(db.scalar("SELECT count(*) FROM git_reflog_entries")).toBe(0);
    expect(database.createBareRepository().repoId).toBeGreaterThan(store.repoId);
  });
});
