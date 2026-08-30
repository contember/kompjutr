import { describe, expect, it } from "vitest";

import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
} from "../src/sqlite/db.js";
import {
  createRefMutationMemoryOwner,
  SqliteGitDatabase,
  type StoreOptions,
} from "../src/sqlite/store.js";
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
  #queryObserver: ((query: string) => void) | null = null;
  writesBeforeFailure = 0;

  constructor(private readonly inner: SqliteTestStorage) {
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        this.#queryObserver?.(query);
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

  observeQueries(observer: ((query: string) => void) | null): void {
    this.#queryObserver = observer;
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

function expectIdle(store: ReturnType<typeof open>["store"]): void {
  const probe = store.reserveMemory();
  try {
    probe.set("other", MAX_OPERATION_MEMORY_BYTES);
  } finally {
    probe.dispose();
  }
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
    expectIdle(store);
    expectIdle(reopened);
  });

  it("owns a long singleton namespace JSON aggregate at the exact shared boundary", () => {
    const prefix = `refs/remotes/${"p".repeat(1_500_001)}/`;
    const prepare = (): ReturnType<typeof open> => {
      const opened = open();
      const seed = opened.store.beginFetchPublication(prefix);
      seed.dispose();
      return opened;
    };
    const fenceState = (db: TestDatabase): Record<string, unknown> => ({
      repository: db.all<Record<string, unknown>>(
        "SELECT fetch_generation FROM git_repositories WHERE id = 1",
      ),
      namespaces: db.all<Record<string, unknown>>(
        `SELECT length(CAST(tracking_prefix AS BLOB)) AS prefix_bytes,
                latest_generation, revision
           FROM git_fetch_namespaces WHERE repo_id = 1`,
      ),
    });

    const measured = prepare();
    const measuredToken = measured.store.beginFetchPublication(prefix);
    const operationBytes = measured.store.shared.memory.highWaterBytes;
    measuredToken.dispose();
    expect(operationBytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(operationBytes).toBeLessThan(MAX_OPERATION_MEMORY_BYTES);
    expectIdle(measured.store);

    const externalBytes = MAX_OPERATION_MEMORY_BYTES - operationBytes;
    const exact = prepare();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", externalBytes);
    try {
      const token = exact.store.beginFetchPublication(prefix);
      try {
        expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
      } finally {
        token.dispose();
      }
      expect(exactBlocker.currentBytes).toBe(externalBytes);
    } finally {
      exactBlocker.dispose();
    }
    expectIdle(exact.store);

    const over = prepare();
    const before = fenceState(over.db);
    const overBlocker = over.store.reserveMemory();
    overBlocker.set("other", externalBytes + 1);
    try {
      expect(() => over.store.beginFetchPublication(prefix)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(fenceState(over.db)).toEqual(before);
      expect(overBlocker.currentBytes).toBe(externalBytes + 1);
    } finally {
      overBlocker.dispose();
    }
    expectIdle(over.store);
  });

  it("owns a long tracking target row at the exact boundary and rolls back one byte over", () => {
    const prefix = "refs/remotes/origin/";
    const name = `${prefix}main`;
    const target = `ref: refs/heads/${"t".repeat(1_500_001)}`;
    const operationBytes = 1_168 + 2 * prefix.length + 2 * name.length + 3 * target.length;
    expect(operationBytes).toBeLessThan(MAX_OPERATION_MEMORY_BYTES);
    const prepare = (): ReturnType<typeof open> => {
      const opened = open();
      opened.db.run("INSERT INTO git_refs (repo_id, name, target) VALUES (1, ?, ?)", name, target);
      return opened;
    };

    const exact = prepare();
    const externalBytes = MAX_OPERATION_MEMORY_BYTES - operationBytes;
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", externalBytes);
    try {
      const token = exact.store.beginTrackingRefPublication(prefix, name);
      try {
        expect(token.target).toBe(target);
        expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
      } finally {
        token.dispose();
      }
      expect(exactBlocker.currentBytes).toBe(externalBytes);
    } finally {
      exactBlocker.dispose();
    }
    expectIdle(exact.store);

    const over = prepare();
    const overBlocker = over.store.reserveMemory();
    overBlocker.set("other", externalBytes + 1);
    try {
      expect(() => over.store.beginTrackingRefPublication(prefix, name)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(
        over.db.scalar<number>("SELECT count(*) FROM git_tracking_ref_revisions WHERE repo_id = 1"),
      ).toBe(0);
      expect(over.store.getRef(name)).toBe(target);
      expect(overBlocker.currentBytes).toBe(externalBytes + 1);
    } finally {
      overBlocker.dispose();
    }
    expectIdle(over.store);
  });

  it("adds the exact selected tracking revision row charge before decode", () => {
    const prefix = "refs/remotes/origin/";
    const name = `${prefix}${"n".repeat(1_000_001)}`;
    const initial = "1".repeat(40);
    const updated = "2".repeat(40);
    const { db, faultStorage, store } = openCodedTooBig();
    db.run("INSERT INTO git_refs (repo_id, name, target) VALUES (1, ?, ?)", name, initial);
    db.run(
      "INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision) VALUES (1, ?, 0)",
      name,
    );
    let metadataBytes: number | null = null;
    let payloadBytes: number | null = null;
    faultStorage.observeQueries((query) => {
      if (query.includes("AS max_ref_name_bytes")) {
        metadataBytes = store.shared.memory.totalBytes;
      } else if (query.includes("AS ref_name_bytes")) {
        payloadBytes = store.shared.memory.totalBytes;
      }
    });
    try {
      store.setRef(name, updated);
    } finally {
      faultStorage.observeQueries(null);
    }
    if (metadataBytes === null || payloadBytes === null) {
      throw new Error("tracking revision scan did not execute both phases");
    }
    expect(payloadBytes - metadataBytes).toBe(304 + 3 * name.length);
    expect(store.getRef(name)).toBe(updated);
    expect(
      db.scalar<number>(
        "SELECT revision FROM git_tracking_ref_revisions WHERE repo_id = 1 AND ref_name = ?",
        name,
      ),
    ).toBe(1);
    expectIdle(store);
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
    expectIdle(store);
    expectIdle(reopened);
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
    expectIdle(store);
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
      expectIdle(coldStore);
    } finally {
      token.dispose();
    }
    expectIdle(store);
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
    expectIdle(store);
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
    expectIdle(store);
  });

  it("rejects invalid candidate authority and token ownership without mutation", () => {
    const { db, database, store } = open();
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

    db.run(
      "INSERT INTO git_refs (repo_id, name, target) VALUES (1, 'refs/checkpoints/corrupt', zeroblob(1))",
    );
    expect(() =>
      store.beginFetchPublication("refs/remotes/corrupt/", ["refs/checkpoints/corrupt"]),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expectIdle(store);
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
    expectIdle(store);
  });

  it("rejects foreign and disposed publication owners before SQL", () => {
    const { db, database, store } = open();
    const token = store.beginFetchPublication("refs/remotes/origin/");
    const otherCheckout = database.createRepository("/other", "ref: refs/heads/main");
    const other = database.openCheckout(otherCheckout);
    const foreignOwner = createRefMutationMemoryOwner(other.shared);
    const disposedOwner = createRefMutationMemoryOwner(store.shared);
    disposedOwner.dispose();
    try {
      db.storage.resetCounters();
      expect(() =>
        store.beginFetchPublication("refs/remotes/foreign-owner/", [], undefined, foreignOwner),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(db.storage.statementCount).toBe(0);

      db.storage.resetCounters();
      expect(() =>
        store.beginFetchPublication("refs/remotes/disposed-owner/", [], undefined, disposedOwner),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(db.storage.statementCount).toBe(0);

      db.storage.resetCounters();
      expect(() => store.publishFetchRefs(token, {}, metadata, foreignOwner)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(db.storage.statementCount).toBe(0);

      db.storage.resetCounters();
      expect(() => store.publishFetchRefs(token, {}, metadata, disposedOwner)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(db.storage.statementCount).toBe(0);

      expect(store.publishFetchRefs(token, {}, metadata)).toBe(false);
    } finally {
      token.dispose();
      foreignOwner.dispose();
      disposedOwner.dispose();
    }
    expectIdle(store);
    expectIdle(other);
  });

  it("binds owned candidate aliases to the issuing owner until token disposal", () => {
    const { db, store } = open();
    const owner = createRefMutationMemoryOwner(store.shared);
    const candidateText = "refs/tags/owned-candidate";
    const candidate = owner.construct(candidateText.length, () => candidateText);
    const token = store.beginFetchPublication(
      "refs/remotes/origin/",
      [candidate],
      undefined,
      owner,
    );
    try {
      db.storage.resetCounters();
      expect(() => store.publishFetchRefs(token, {}, metadata)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(db.storage.statementCount).toBe(0);

      owner.dispose();
      expect(token.disposed).toBe(true);
      db.storage.resetCounters();
      expect(() => store.publishFetchRefs(token, {}, metadata, owner)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
      expect(db.storage.statementCount).toBe(0);
    } finally {
      token.dispose();
      owner.dispose();
    }
    expectIdle(store);
  });

  it("charges mixed non-owned plan strings while accepting the internal owner seam", () => {
    const { store } = open();
    const owner = createRefMutationMemoryOwner(store.shared);
    const candidateText = "refs/tags/mixed-owner";
    const candidate = owner.construct(candidateText.length, () => candidateText);
    const target = "1".repeat(40);
    expect(owner.owns(candidate)).toBe(true);
    expect(owner.owns(target)).toBe(false);
    const token = store.beginFetchPublication(
      "refs/remotes/origin/",
      [candidate],
      undefined,
      owner,
    );
    try {
      expect(
        store.publishFetchRefs(
          token,
          { globalTagPuts: [{ name: candidate, target }] },
          metadata,
          owner,
        ),
      ).toBe(true);
    } finally {
      token.dispose();
      owner.dispose();
    }
    expectIdle(store);
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
    expectIdle(store);
  });

  it("shares the caller reservation and publishes exact candidates within the statement target", () => {
    const { db, store } = open();
    const reservation = store.reserveMemory();
    reservation.set("protocol", 4_096);
    reservation.set("other", 2_048);
    const callerBytes = 6_144;
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
    const token = store.beginFetchPublication("refs/remotes/origin/", candidates, reservation);

    try {
      expect(reservation.currentBytes).toBeGreaterThan(callerBytes);
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
      expect(reservation.highWaterBytes).toBeLessThan(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      token.dispose();
    }
    expect(reservation.currentBytes).toBe(callerBytes);
    reservation.clear("protocol");
    reservation.clear("other");
    reservation.dispose();
    expectIdle(store);
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
    expectIdle(store);
  });

  it("keeps sibling token and caller bytes while rejecting foreign reservations", () => {
    const { database, store } = open();
    const reservation = store.reserveMemory();
    reservation.set("protocol", 4_096);
    reservation.set("other", 2_048);
    const callerBytes = reservation.currentBytes;
    const first = store.beginFetchPublication("refs/remotes/first/", [], reservation);
    const firstBytes = reservation.currentBytes;
    const second = store.beginFetchPublication("refs/remotes/second/", [], reservation);
    const bothBytes = reservation.currentBytes;
    expect(firstBytes).toBeGreaterThan(callerBytes);
    expect(bothBytes).toBeGreaterThan(firstBytes);

    first.dispose();
    expect(reservation.currentBytes).toBeGreaterThan(callerBytes);
    expect(reservation.currentBytes).toBeLessThan(bothBytes);
    expect(second.disposed).toBe(false);
    const beforeFailure = reservation.currentBytes;
    expect(() =>
      store.beginFetchPublication(
        "refs/remotes/duplicate/",
        ["refs/tags/duplicate", "refs/tags/duplicate"],
        reservation,
      ),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(reservation.currentBytes).toBe(beforeFailure);

    const otherCheckout = database.createRepository("/other", "ref: refs/heads/main");
    const other = database.openCheckout(otherCheckout);
    const otherReservation = other.reserveMemory();
    try {
      expect(() =>
        store.beginFetchPublication("refs/remotes/foreign-repository/", [], otherReservation),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    } finally {
      otherReservation.dispose();
    }
    const foreign = open();
    const foreignReservation = foreign.store.reserveMemory();
    try {
      expect(() =>
        store.beginFetchPublication("refs/remotes/foreign-coordinator/", [], foreignReservation),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    } finally {
      foreignReservation.dispose();
    }

    second.dispose();
    expect(reservation.currentBytes).toBe(callerBytes);
    reservation.dispose();
    expectIdle(store);
    expectIdle(other);
    expectIdle(foreign.store);
  });

  it("invalidates publication tokens when the caller disposes their parent reservation", () => {
    const { store } = open();
    const reservation = store.reserveMemory();
    const token = store.beginFetchPublication(
      "refs/remotes/origin/",
      ["refs/tags/v1"],
      reservation,
    );
    reservation.dispose();
    expect(token.disposed).toBe(true);
    expect(() =>
      store.publishFetchRefs(
        token,
        { globalTagPuts: [{ name: "refs/tags/v1", target: "1".repeat(40) }] },
        metadata,
      ),
    ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
    token.dispose();
    expectIdle(store);
  });

  it("preserves an exactly full caller reservation after a failed child allocation", () => {
    const excess = open();

    const full = excess.store.reserveMemory();
    full.set("protocol", MAX_OPERATION_MEMORY_BYTES);
    try {
      expect(() =>
        excess.store.beginFetchPublication("refs/remotes/upstream/", [], full),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(full.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      full.dispose();
    }
    expectIdle(excess.store);
  });
});
