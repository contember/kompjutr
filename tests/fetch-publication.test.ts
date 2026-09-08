import { describe, expect, it } from "vitest";

import {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
} from "../packages/do/src/db/db.js";
import { SqliteGitDatabase, type StoreOptions } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const MAPPED_CANDIDATE_COUNT = 1_024;

const metadata = {
  actor: { name: "Fetch Bot", email: "fetch@example.test" },
  reason: "fetch: mapped refs",
  timestamp: 1_800_000_000,
  timezoneOffset: 0,
};

class CodedTooBigStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;
  #queryFragment: string | null = null;
  writesBeforeFailure = 0;

  constructor(private readonly inner: SqliteTestStorage) {
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        if (this.#queryFragment !== null && query.includes(this.#queryFragment)) {
          this.#queryFragment = null;
          throw Object.assign(new Error("injected coded SQLite value failure"), {
            code: "SQLITE_TOOBIG",
          });
        }
        if (this.#queryFragment !== null && /^\s*(?:DELETE|INSERT|UPDATE)\b/.test(query)) {
          this.writesBeforeFailure++;
        }
        return this.inner.sql.exec<Row>(query, ...bindings);
      },
    };
  }

  arm(queryFragment: string): void {
    this.#queryFragment = queryFragment;
    this.writesBeforeFailure = 0;
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function openCodedTooBig() {
  const storage = new SqliteTestStorage();
  const db = new TestDatabase(storage);
  const faultStorage = new CodedTooBigStorage(storage);
  const database = new SqliteGitDatabase(new Database(faultStorage));
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  return { db, faultStorage, store: database.openCheckout(checkout) };
}

function open(options: StoreOptions = {}) {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db, options);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  return { db, database, store: database.openCheckout(checkout) };
}

function durablePublicationState(db: TestDatabase) {
  return {
    refs: db.all<Record<string, unknown>>(
      "SELECT repo_id, name, target FROM git_refs ORDER BY repo_id, name",
    ),
    shallow: db.all<Record<string, unknown>>(
      "SELECT repo_id, oid FROM git_shallow ORDER BY repo_id, oid",
    ),
    directReflogs: db.all<Record<string, unknown>>(
      "SELECT * FROM git_reflog_entries ORDER BY repo_id, ordinal",
    ),
    checkoutReflogs: db.all<Record<string, unknown>>(
      "SELECT * FROM git_checkout_reflog_entries ORDER BY repo_id, ordinal",
    ),
    reflogState: db.all<Record<string, unknown>>(
      "SELECT repo_id, next_ordinal FROM git_reflog_state ORDER BY repo_id",
    ),
    repositoryRevisions: db.all<Record<string, unknown>>(
      `SELECT id AS repo_id, fetch_generation, shallow_revision, checkout_revision
         FROM git_repositories ORDER BY id`,
    ),
    maintenanceControl: db.all<Record<string, unknown>>(
      "SELECT repo_id, root_epoch, next_run_id FROM git_maintenance_control ORDER BY repo_id",
    ),
  };
}

describe("exact fetch publication", () => {
  it("publishes the former tracking-prefix first excess across a cold reopen", () => {
    const { db, store } = open();
    const base = "refs/remotes/";
    const prefix = `${base}${"r".repeat(1_025 - base.length - 1)}/`;
    const tracking = `${prefix}main`;
    const target = "1".repeat(40);
    expect(prefix).toHaveLength(1_025);
    const token = store.beginFetchPublication(prefix);
    try {
      expect(
        store.publishFetchRefs(token, { trackingPuts: [{ name: tracking, target }] }, metadata),
      ).toBe(true);
    } finally {
      token.dispose();
    }
    expect(store.getRef(tracking)).toBe(target);
    expect(
      db.scalar<string>("SELECT tracking_prefix FROM git_fetch_namespaces WHERE repo_id = 1"),
    ).toBe(prefix);

    const reopenedDatabase = new SqliteGitDatabase(new TestDatabase(db.storage));
    const reopenedCheckout = reopenedDatabase.checkoutAt("/repo");
    if (reopenedCheckout === null) throw new Error("reopened checkout is missing");
    const reopened = reopenedDatabase.openCheckout(reopenedCheckout);
    expect(reopened.getRef(tracking)).toBe(target);
  });

  it("publishes several namespaces with legacy tracking, tags, shallow state, and reflogs", () => {
    const { db, store } = open();
    const branch = "refs/heads/release";
    const checkpoint = "refs/checkpoints/nightly";
    const tag = "refs/tags/v1";
    const tracking = "refs/remotes/origin/main";
    const branchOid = "1".repeat(40);
    const checkpointOid = "2".repeat(40);
    const tagOid = "3".repeat(40);
    const trackingOid = "4".repeat(40);
    const shallowOid = "5".repeat(40);
    store.setHead(`ref: ${tracking}`);
    const token = store.beginFetchPublication("refs/remotes/origin/", [branch, checkpoint, tag]);

    try {
      expect(token.exactRefs).toEqual([
        { name: branch, target: null },
        { name: checkpoint, target: null },
        { name: tag, target: null },
      ]);
      expect(
        store.publishFetchRefs(
          token,
          {
            exactPuts: [
              { name: branch, target: branchOid },
              { name: checkpoint, target: checkpointOid },
            ],
            trackingPuts: [{ name: tracking, target: trackingOid }],
            remoteHead: `ref: ${tracking}`,
            globalTagPuts: [{ name: tag, target: tagOid }],
            shallowAdd: [shallowOid],
          },
          metadata,
        ),
      ).toBe(true);
      expect(store.getRef(branch)).toBe(branchOid);
      expect(store.getRef(checkpoint)).toBe(checkpointOid);
      expect(store.getRef(tag)).toBe(tagOid);
      expect(store.getRef(tracking)).toBe(trackingOid);
      expect(store.getRef("refs/remotes/origin/HEAD")).toBe(`ref: ${tracking}`);
      expect(store.shallow()).toEqual(new Set([shallowOid]));
      for (const name of [branch, checkpoint, tag, tracking]) {
        expect(store.reflog(name)[0]).toMatchObject({
          oldRaw: null,
          reason: metadata.reason,
        });
      }
      expect(store.reflog("refs/remotes/origin/HEAD")[0]).toMatchObject({
        oldRaw: null,
        newRaw: `ref: ${tracking}`,
        reason: metadata.reason,
      });
      expect(store.reflog("HEAD")[0]).toMatchObject({
        oldRaw: `ref: ${tracking}`,
        newRaw: `ref: ${tracking}`,
        oldOid: null,
        newOid: trackingOid,
        reason: metadata.reason,
      });
    } finally {
      token.dispose();
    }

    const committed = durablePublicationState(db);
    expect(committed.repositoryRevisions).toEqual([
      {
        repo_id: 1,
        fetch_generation: 1,
        shallow_revision: 1,
        checkout_revision: 2,
      },
    ]);
    const reopenedDb = new TestDatabase(db.storage);
    const reopenedDatabase = new SqliteGitDatabase(reopenedDb);
    const reopenedCheckout = reopenedDatabase.checkoutAt("/repo");
    if (reopenedCheckout === null) throw new Error("reopened checkout is missing");
    const reopened = reopenedDatabase.openCheckout(reopenedCheckout);
    expect(reopened.getRef(branch)).toBe(branchOid);
    expect(reopened.getRef(checkpoint)).toBe(checkpointOid);
    expect(reopened.getRef(tag)).toBe(tagOid);
    expect(reopened.getRef(tracking)).toBe(trackingOid);
    expect(reopened.getRef("refs/remotes/origin/HEAD")).toBe(`ref: ${tracking}`);
    expect(reopened.shallow()).toEqual(new Set([shallowOid]));
    expect(reopened.head()).toBe(`ref: ${tracking}`);
    for (const name of [branch, checkpoint, tag, tracking, "refs/remotes/origin/HEAD"]) {
      expect(reopened.reflog(name)).toEqual(store.reflog(name));
    }
    expect(reopened.reflog("HEAD")).toEqual(store.reflog("HEAD"));
    expect(reopened.reflog("HEAD")[0]).toMatchObject({
      oldRaw: `ref: ${tracking}`,
      newRaw: `ref: ${tracking}`,
      oldOid: null,
      newOid: trackingOid,
      reason: metadata.reason,
    });
    expect(durablePublicationState(reopenedDb)).toEqual(committed);
  });

  it("rolls every destination and shallow update back when one exact candidate is stale", () => {
    const { store } = open();
    const first = "refs/checkpoints/first";
    const second = "refs/changes/second";
    const originalFirst = "1".repeat(40);
    const originalSecond = "2".repeat(40);
    const winner = "3".repeat(40);
    store.setRef(first, originalFirst);
    store.setRef(second, originalSecond);
    const firstLog = store.reflog(first);
    const token = store.beginFetchPublication("refs/remotes/origin/", [first, second]);

    try {
      store.setRef(second, winner);
      expect(() =>
        store.publishFetchRefs(
          token,
          {
            exactPuts: [
              { name: first, target: "4".repeat(40) },
              { name: second, target: "5".repeat(40) },
            ],
            trackingPuts: [{ name: "refs/remotes/origin/main", target: "6".repeat(40) }],
            shallowAdd: ["7".repeat(40)],
          },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef(first)).toBe(originalFirst);
      expect(store.getRef(second)).toBe(winner);
      expect(store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(store.shallow()).toEqual(new Set());
      expect(store.reflog(first)).toEqual(firstLog);
    } finally {
      token.dispose();
    }
  });

  it("rolls tracking rows and namespace revisions back after coded SQLite value failure", () => {
    const { db, faultStorage, store } = openCodedTooBig();
    const tracking = "refs/remotes/origin/main";
    const token = store.beginFetchPublication("refs/remotes/origin/");
    const before = durablePublicationState(db);
    expect(before.repositoryRevisions).toEqual([
      { repo_id: 1, fetch_generation: 1, shallow_revision: 0, checkout_revision: 1 },
    ]);

    faultStorage.arm("UPDATE git_fetch_namespaces SET revision = revision + 1");
    try {
      expect(() =>
        store.publishFetchRefs(
          token,
          { trackingPuts: [{ name: tracking, target: "1".repeat(40) }] },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ name: "GitError", code: "E2BIG" }));
      expect(faultStorage.writesBeforeFailure).toBeGreaterThan(0);
      expect(durablePublicationState(db)).toEqual(before);
      expect(store.getRef(tracking)).toBeNull();

      const coldDb = new TestDatabase(db.storage);
      const coldDatabase = new SqliteGitDatabase(coldDb);
      const coldCheckout = coldDatabase.checkoutAt("/repo");
      if (coldCheckout === null) throw new Error("reopened fetch rollback checkout is missing");
      const coldStore = coldDatabase.openCheckout(coldCheckout);
      expect(durablePublicationState(coldDb)).toEqual(before);
      expect(coldStore.getRef(tracking)).toBeNull();
    } finally {
      token.dispose();
    }
  });

  it("rolls ref, reflog, and shallow writes back when final revision advancement fails", () => {
    const { db, store } = open();
    const checkpoint = "refs/checkpoints/rollback";
    const tag = "refs/tags/rollback";
    const tracking = "refs/remotes/origin/main";
    store.setHead(`ref: ${tracking}`);
    db.run(
      "UPDATE git_repositories SET shallow_revision = ? WHERE id = 1",
      Number.MAX_SAFE_INTEGER,
    );
    const token = store.beginFetchPublication("refs/remotes/origin/", [checkpoint, tag]);
    const before = durablePublicationState(db);
    expect(before.checkoutReflogs).toHaveLength(1);
    expect(before.repositoryRevisions).toEqual([
      {
        repo_id: 1,
        fetch_generation: 1,
        shallow_revision: Number.MAX_SAFE_INTEGER,
        checkout_revision: 2,
      },
    ]);

    try {
      expect(() =>
        store.publishFetchRefs(
          token,
          {
            exactPuts: [{ name: checkpoint, target: "1".repeat(40) }],
            globalTagPuts: [{ name: tag, target: "2".repeat(40) }],
            trackingPuts: [{ name: tracking, target: "3".repeat(40) }],
            remoteHead: `ref: ${tracking}`,
            shallowAdd: ["4".repeat(40)],
          },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(durablePublicationState(db)).toEqual(before);
    } finally {
      token.dispose();
    }
  });

  it("accepts an idempotent exact winner and rejects a different winner", () => {
    const { store } = open();
    const name = "refs/checkpoints/release";
    const same = store.beginFetchPublication("refs/remotes/origin/", [name]);
    const winner = store.beginFetchPublication("refs/remotes/upstream/", [name]);

    try {
      expect(
        store.publishFetchRefs(winner, { exactPuts: [{ name, target: "1".repeat(40) }] }, metadata),
      ).toBe(true);
      expect(
        store.publishFetchRefs(same, { exactPuts: [{ name, target: "1".repeat(40) }] }, metadata),
      ).toBe(false);
    } finally {
      same.dispose();
      winner.dispose();
    }

    const stale = store.beginFetchPublication("refs/remotes/mirror/", [name]);
    const replacement = store.beginFetchPublication("refs/remotes/vendor/", [name]);
    try {
      store.publishFetchRefs(
        replacement,
        { exactPuts: [{ name, target: "2".repeat(40) }] },
        metadata,
      );
      expect(() =>
        store.publishFetchRefs(stale, { exactPuts: [{ name, target: "3".repeat(40) }] }, metadata),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef(name)).toBe("2".repeat(40));
    } finally {
      stale.dispose();
      replacement.dispose();
    }
  });

  it("rejects invalid candidate authority and token ownership without mutation", () => {
    const { database, store } = open();
    expect(() =>
      store.beginFetchPublication("refs/remotes/origin/", [
        "refs/checkpoints/duplicate",
        "refs/checkpoints/duplicate",
      ]),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() => store.beginFetchPublication("refs/remotes/origin/", ["HEAD"])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );

    const symbolic = "refs/checkpoints/symbolic";
    store.setRef(symbolic, "ref: refs/heads/main");
    expect(() => store.beginFetchPublication("refs/remotes/origin/", [symbolic])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );

    const issued = "refs/checkpoints/issued";
    const token = store.beginFetchPublication("refs/remotes/origin/", [issued]);
    try {
      expect(() =>
        store.publishFetchRefs(
          token,
          { exactPuts: [{ name: "refs/checkpoints/unissued", target: "1".repeat(40) }] },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(() =>
        store.publishFetchRefs(
          token,
          {
            exactPuts: [{ name: issued, target: "ref: refs/heads/main" }],
          },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(() =>
        store.publishFetchRefs(
          token,
          {
            exactPuts: [
              { name: issued, target: "1".repeat(40) },
              { name: issued, target: "1".repeat(40) },
            ],
          },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));

      const otherCheckout = database.createRepository("/other", "ref: refs/heads/main");
      const other = database.openCheckout(otherCheckout);
      expect(() => other.publishFetchRefs(token, {}, metadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
    } finally {
      token.dispose();
    }

    const disposed = store.beginFetchPublication("refs/remotes/disposed/", [issued]);
    disposed.dispose();
    expect(() => store.publishFetchRefs(disposed, {}, metadata)).toThrowError(
      expect.objectContaining({ code: "ESTALEFETCH" }),
    );
    expect(store.getRef(issued)).toBeNull();
  });

  it("fences create-attached/remove ABA with no checkout reflog evidence", () => {
    const { database, store } = open();
    const branch = "refs/heads/feature";
    const token = store.beginFetchPublication("refs/remotes/origin/", [branch]);

    try {
      const linked = database.createCheckout(1, "/linked", `ref: ${branch}`);
      database.removeCheckout(linked.id, () => undefined);
      expect(() =>
        store.publishFetchRefs(
          token,
          { exactPuts: [{ name: branch, target: "1".repeat(40) }] },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef(branch)).toBeNull();
      expect(store.reflog(branch)).toEqual([]);
    } finally {
      token.dispose();
    }
  });

  it("fences HEAD ABA after its retained checkout reflog evidence is deleted", () => {
    const { db, store } = open();
    const branch = "refs/heads/feature";
    const token = store.beginFetchPublication("refs/remotes/origin/", [branch]);

    try {
      store.setHead(`ref: ${branch}`);
      store.setHead("ref: refs/heads/main");
      db.run("DELETE FROM git_checkout_reflog_entries WHERE repo_id = 1");
      expect(db.scalar<number>("SELECT count(*) FROM git_checkout_reflog_entries")).toBe(0);
      expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
        2,
      );
      expect(() =>
        store.publishFetchRefs(
          token,
          { exactPuts: [{ name: branch, target: "1".repeat(40) }] },
          metadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.head()).toBe("ref: refs/heads/main");
      expect(store.getRef(branch)).toBeNull();
    } finally {
      token.dispose();
    }
  });

  it("publishes exact candidates within the statement target", () => {
    const { db, store } = open();
    const branch = "refs/heads/sql-bound";
    const candidates = [
      branch,
      ...Array.from(
        { length: MAPPED_CANDIDATE_COUNT - 1 },
        (_, index) => `refs/checkpoints/ref-${index.toString().padStart(4, "0")}`,
      ),
    ];
    expect(candidates).toHaveLength(MAPPED_CANDIDATE_COUNT);
    expect(store.head()).toBe("ref: refs/heads/main");
    db.storage.resetCounters();
    const token = store.beginFetchPublication("refs/remotes/origin/", candidates);

    try {
      expect(
        store.publishFetchRefs(
          token,
          {
            exactPuts: candidates.map((name, index) => ({
              name,
              target: index.toString(16).padStart(40, "0"),
            })),
          },
          metadata,
        ),
      ).toBe(true);
      expect(db.storage.statementCount).toBeLessThan(1_000);
    } finally {
      token.dispose();
    }
  });

  it("retains legacy capacity for 1,025 distinct tag candidates", () => {
    const { store } = open();
    const tags = Array.from(
      { length: MAPPED_CANDIDATE_COUNT + 1 },
      (_, index) => `refs/tags/t-${index.toString(36)}`,
    );
    const token = store.beginFetchPublication("refs/remotes/origin/", tags);
    try {
      expect(token.exactRefs).toHaveLength(MAPPED_CANDIDATE_COUNT + 1);
      expect(token.globalRefs).toEqual(token.exactRefs);
    } finally {
      token.dispose();
    }
  });
});
