import { describe, expect, expectTypeOf, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import {
  type CheckoutRow,
  type CheckoutStore,
  MAX_CHECKOUT_LIST_RETAINED_BYTES,
  SqliteGitDatabase,
} from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { makeRepo } from "./helpers/workspace.js";

const OID = "1".repeat(40);
const OTHER_OID = "2".repeat(40);

class CheckoutCursorDatabase implements SqlDatabase {
  constructor(
    private readonly inner: SqlDatabase,
    private readonly checkoutRows: readonly Record<string, unknown>[],
  ) {}

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    if (query.includes("WHERE id IN (SELECT value FROM json_each(?))")) {
      return this.checkoutRows;
    }
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function repository() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const primary = database.createRepository("/primary", "ref: refs/heads/main");
  const store = database.openCheckout(primary);
  return { db, database, primary, store };
}

function insertBusyOperation(db: TestDatabase, checkoutId: number): void {
  db.run(
    `INSERT INTO git_operation_state
       (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
        current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
        current_step, step_count, current_label, incoming_label, message,
        author_name, author_email, committer_name, committer_email,
        touched_count, retained_bytes, integrity_oid)
     VALUES (?, 'merge', 'refs/heads/topic', ?, 'conflicted', NULL,
             ?, ?, NULL, NULL, 'commit', 'merge',
             0, 0, 'HEAD', 'topic', 'merge topic',
             NULL, NULL, NULL, NULL, 0, 0, ?)`,
    checkoutId,
    OID,
    OID,
    OTHER_OID,
    OID,
  );
}

function checkoutStorageRow(db: TestDatabase, checkoutId: number): Record<string, unknown> {
  const row = db.one<Record<string, unknown>>(
    `SELECT id AS checkout_id, repo_id, root, head, is_primary
       FROM git_checkouts WHERE id = ?`,
    checkoutId,
  );
  if (row === undefined) throw new Error(`checkout ${checkoutId} is missing`);
  return row;
}

describe("checkout lifecycle storage", () => {
  it("creates initialized checkout state atomically and installs its facade after success", () => {
    const { db, database, primary } = repository();
    let initialized: CheckoutStore | null = null;

    const checkout = database.createCheckout(
      primary.repoId,
      "/session",
      "ref: refs/heads/session",
      (store) => {
        initialized = store;
        store.indexPut({
          path: "tracked.txt",
          stage: 0,
          mode: 0o100644,
          oid: OID,
          size: null,
          mtime: null,
          ino: null,
        });
      },
    );

    expect(checkout).toEqual({
      id: 2,
      repoId: primary.repoId,
      root: "/session",
      head: "ref: refs/heads/session",
      isPrimary: false,
    });
    expect(Object.isFrozen(checkout)).toBe(true);
    expect(database.openCheckout(checkout)).toBe(initialized);
    expect(db.one("SELECT complete FROM git_index_state WHERE checkout_id = 2")).toEqual({
      complete: 0,
    });
    expect(database.openCheckout(checkout).indexGet("tracked.txt")?.oid).toBe(OID);
  });

  it("composes checkout creation with the filesystem index-state trigger", () => {
    const workspace = makeRepo("/");

    const checkout = workspace.database.createCheckout(
      workspace.repo.store.repoId,
      "/session",
      OTHER_OID,
    );

    expect(
      workspace.database.db.scalar<number>(
        "SELECT count(*) FROM git_index_state WHERE checkout_id = ?",
        checkout.id,
      ),
    ).toBe(1);
  });

  it("rolls back failed initialization without installing its facade or publications", () => {
    const { db, database, primary, store } = repository();
    const failedStores: CheckoutStore[] = [];
    let rolledBackOid: string | null = null;
    const preexistingOid = store.write("blob", utf8.encode("preexisting\n"));

    expect(() =>
      database.createCheckout(primary.repoId, "/failed", "ref: refs/heads/failed", (checkout) => {
        failedStores.push(checkout);
        checkout.indexPut({
          path: "partial.txt",
          stage: 0,
          mode: 0o100644,
          oid: OID,
          size: null,
          mtime: null,
          ino: null,
        });
        checkout.setRef("refs/heads/failed", OID);
        rolledBackOid = checkout.write("blob", utf8.encode("rolled back\n"));
        throw new Error("injected initialization failure");
      }),
    ).toThrow("injected initialization failure");

    expect(database.checkoutAt("/failed")).toBeNull();
    expect(store.getRef("refs/heads/failed")).toBeNull();
    expect(db.scalar<number>("SELECT count(*) FROM git_index WHERE path = 'partial.txt'")).toBe(0);
    if (rolledBackOid === null) throw new Error("rollback object was not written");
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
        primary.repoId,
        rolledBackOid,
      ),
    ).toBe(0);
    expect(store.has(rolledBackOid)).toBe(false);
    expect(store.read(rolledBackOid)).toBeNull();
    expect(store.has(preexistingOid)).toBe(true);
    expect(store.read(preexistingOid)?.data).toEqual(utf8.encode("preexisting\n"));

    const retry = database.createCheckout(primary.repoId, "/failed", OTHER_OID);
    const escaped = failedStores[0];
    if (escaped === undefined) throw new Error("failed checkout facade did not escape");
    const retryStore = database.openCheckout(retry);
    expect(retry.id).toBe(2);
    expect(retryStore).not.toBe(escaped);
    expect(retryStore.indexGet("partial.txt")).toBeNull();
    expect(() =>
      escaped.indexPut({
        path: "escaped.txt",
        stage: 0,
        mode: 0o100644,
        oid: OID,
        size: null,
        mtime: null,
        ino: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "EWORKTREENOTFOUND" }));
    expect(retryStore.indexGet("escaped.txt")).toBeNull();
  });

  it("reports exact registered-root and attached-branch conflicts", () => {
    const { database, primary } = repository();
    const topic = database.createCheckout(primary.repoId, "/topic", "ref: refs/heads/topic");

    expect(() => database.createCheckout(primary.repoId, "/topic", OTHER_OID)).toThrowError(
      expect.objectContaining({ code: "EWORKTREEEXISTS" }),
    );
    expect(() =>
      database.createCheckout(primary.repoId, "/another", "ref: refs/heads/topic"),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHINUSE" }));
    expect(() =>
      database.createCheckout(primary.repoId, "/main", "ref: refs/heads/main"),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHINUSE" }));
    expect(database.checkoutAt("/topic")).toEqual(topic);
    expect(database.checkoutAt("/another")).toBeNull();
    expect(database.checkoutAt("/main")).toBeNull();
  });

  it("accepts checkout 1,024 and rejects 1,025 before mutation", () => {
    const { db, database, primary } = repository();
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (2) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1023
       )
       INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       SELECT id, ?, '/session-' || printf('%04d', id), ?, 0 FROM sequence`,
      primary.repoId,
      OID,
    );
    db.run("UPDATE git_identity_control SET last_checkout_id = 1023 WHERE singleton = 1");

    const accepted = database.createCheckout(primary.repoId, "/session-1024", OTHER_OID);
    expect(accepted.id).toBe(1_024);
    expect(database.listCheckouts(primary.repoId)).toHaveLength(1_024);
    const before = {
      checkouts: db.scalar<number>("SELECT count(*) FROM git_checkouts"),
      indexStates: db.scalar<number>("SELECT count(*) FROM git_index_state"),
    };

    db.storage.resetCounters();
    expect(() => database.createCheckout(primary.repoId, "/session-1025", OID)).toThrowError(
      expect.objectContaining({ code: "EWORKTREELIMIT" }),
    );
    expect(db.storage.statementCount).toBe(3);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.scalar<number>("SELECT count(*) FROM git_checkouts")).toBe(before.checkouts);
    expect(db.scalar<number>("SELECT count(*) FROM git_index_state")).toBe(before.indexStates);
  });

  it("retains the exact 6 MiB maximum in one ordered frozen listing", () => {
    expect(MAX_CHECKOUT_LIST_RETAINED_BYTES).toBe(6 * 1024 * 1024);
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    db.run("INSERT INTO git_repositories (id) VALUES (1)");
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1024
       )
       INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       SELECT id, 1,
              printf('/%04d%0*d', id, 4091, 0),
              printf('ref: refs/tags/%0*d', 1009, id),
              CASE id WHEN 1 THEN 1 ELSE 0 END
         FROM sequence`,
    );
    db.run(
      `UPDATE git_identity_control
          SET last_repo_id = 1, last_checkout_id = 1024
        WHERE singleton = 1`,
    );

    db.storage.resetCounters();
    const checkouts = database.listCheckouts(1);

    expect(checkouts).toHaveLength(1_024);
    expect(Object.isFrozen(checkouts)).toBe(true);
    expect(checkouts.every(Object.isFrozen)).toBe(true);
    expect(utf8.encode(checkouts[0]?.root ?? "").byteLength).toBe(4_096);
    expect(utf8.encode(checkouts[0]?.head ?? "").byteLength).toBe(1_024);
    expect(db.storage.statementCount).toBe(2);
  });

  it("removes private state while preserving shared objects, refs, and caches", () => {
    const { db, database, primary, store } = repository();
    const checkout = database.createCheckout(primary.repoId, "/session", OTHER_OID);
    const session = database.openCheckout(checkout);
    const blob = store.write("blob", utf8.encode("shared\n"));
    store.setRef("refs/tags/shared", blob);
    session.indexPut({
      path: "private.txt",
      stage: 0,
      mode: 0o100644,
      oid: blob,
      size: null,
      mtime: null,
      ino: null,
    });
    session.setHead(OID);
    db.run(
      "INSERT INTO git_index_dirty (checkout_id, path, flags) VALUES (?, 'private.txt', 1)",
      checkout.id,
    );
    let removedRoot: string | null = null;

    const removed = database.removeCheckout(checkout.id, (row) => {
      expect(Object.isFrozen(row)).toBe(true);
      removedRoot = row.root;
    });

    expect(removed).toEqual(expect.objectContaining({ id: checkout.id, root: "/session" }));
    expect(removedRoot).toBe("/session");
    expect(database.checkoutAt("/session")).toBeNull();
    expect(
      db.scalar<number>("SELECT count(*) FROM git_index WHERE checkout_id = ?", checkout.id),
    ).toBe(0);
    expect(
      db.scalar<number>("SELECT count(*) FROM git_index_dirty WHERE checkout_id = ?", checkout.id),
    ).toBe(0);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE checkout_id = ?",
        checkout.id,
      ),
    ).toBe(0);
    expect(store.getRef("refs/tags/shared")).toBe(blob);
    expect(store.read(blob)?.data).toEqual(utf8.encode("shared\n"));
    expect(database.openShared(primary.repoId)).toBe(store.shared);
    expect(() => database.openCheckout(checkout)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
  });

  it("keeps the primary shared backend alive after a B-first cold open removes B", () => {
    const db = new TestDatabase();
    const setup = new SqliteGitDatabase(db);
    const primary = setup.createRepository("/primary", "ref: refs/heads/main");
    const setupStore = setup.openCheckout(primary);
    const before = setupStore.write("blob", utf8.encode("before removal\n"));
    setupStore.setRef("refs/tags/shared", before);
    setup.createCheckout(primary.repoId, "/secondary", OTHER_OID);

    const cold = new SqliteGitDatabase(db);
    const secondaryRow = cold.checkoutAt("/secondary");
    if (secondaryRow === null) throw new Error("cold secondary checkout is missing");
    const secondary = cold.openCheckout(secondaryRow);
    const shared = secondary.shared;
    const primaryRow = cold.checkoutAt("/primary");
    if (primaryRow === null) throw new Error("cold primary checkout is missing");
    const survivor = cold.openCheckout(primaryRow);
    expect(secondary.packs).toBe(survivor.packs);
    expect(shared.packs).toBe(survivor.packs);

    cold.removeCheckout(secondaryRow.id, () => undefined);

    expect(() => secondary.indexGet("private.txt")).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => secondary.shared).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => secondary.packs).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );

    expect(shared.read(before)?.data).toEqual(utf8.encode("before removal\n"));
    const after = shared.write("blob", utf8.encode("after removal\n"));
    shared.setRef("refs/tags/shared", after);
    expect(shared.getRef("refs/tags/shared")).toBe(after);
    expect(shared.reflog("refs/tags/shared")[0]).toMatchObject({
      oldOid: before,
      newOid: after,
      reason: "ref update",
    });
    shared.configSet("survivor.value", "alive");
    expect(survivor.shared.configGet("survivor.value")).toBe("alive");
    expect(shared.packs.count()).toBe(0);
    expect(new Set(shared.activeRefLogOids())).toEqual(new Set([before, after]));
  });

  it("rolls back the root callback and keeps the cached checkout on failed removal", () => {
    const { database, primary } = repository();
    const checkout = database.createCheckout(primary.repoId, "/session", OTHER_OID);
    const cached = database.openCheckout(checkout);

    expect(() =>
      database.removeCheckout(checkout.id, () => {
        cached.indexPut({
          path: "rolled-back.txt",
          stage: 0,
          mode: 0o100644,
          oid: OID,
          size: null,
          mtime: null,
          ino: null,
        });
        throw new Error("injected root removal failure");
      }),
    ).toThrow("injected root removal failure");

    expect(database.checkoutAt("/session")).not.toBeNull();
    expect(database.openCheckout(checkout)).toBe(cached);
    expect(cached.indexGet("rolled-back.txt")).toBeNull();
  });

  it("revokes a removed facade before the root gets a new checkout identity", () => {
    const { database, primary } = repository();
    const removedRow = database.createCheckout(primary.repoId, "/session", OTHER_OID);
    const removedStore = database.openCheckout(removedRow);
    database.removeCheckout(removedRow.id, () => undefined);

    const recreated = database.createCheckout(primary.repoId, "/session", OTHER_OID);
    const current = database.openCheckout(recreated);
    expect(recreated.id).toBeGreaterThan(removedRow.id);
    expect(() =>
      removedStore.indexPut({
        path: "escaped.txt",
        stage: 0,
        mode: 0o100644,
        oid: OID,
        size: null,
        mtime: null,
        ino: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "EWORKTREENOTFOUND" }));
    expect(current.indexGet("escaped.txt")).toBeNull();
  });

  it("rejects remembered rows after exact recreation with or without a warm new facade", () => {
    for (const warm of [false, true]) {
      const { db, database, primary } = repository();
      const stale = database.createCheckout(primary.repoId, "/session", OTHER_OID);
      database.removeCheckout(stale.id, () => undefined);
      db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (?, ?, ?, ?, 0)`,
        stale.id,
        stale.repoId,
        stale.root,
        stale.head,
      );
      db.run(
        `INSERT INTO git_index_state
           (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
        stale.id,
      );
      if (warm) {
        const current = database.checkoutAt(stale.root);
        if (current === null) throw new Error("recreated checkout is missing");
        database.openCheckout(current);
      }

      expect(() => database.openCheckout(stale)).toThrowError(
        expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
      );
      expect(database.openCheckout({ ...stale }).checkoutId).toBe(stale.id);
    }
  });

  it("aborts a bulk removal unchanged when one checkout has a live operation", () => {
    const { db, database, primary } = repository();
    const first = database.createCheckout(primary.repoId, "/first", OID);
    const second = database.createCheckout(primary.repoId, "/second", OTHER_OID);
    insertBusyOperation(db, second.id);

    db.storage.histogram = new Map();
    db.storage.resetCounters();
    expect(() => database.removeCheckouts(primary.repoId, [first.id, second.id])).toThrowError(
      expect.objectContaining({ code: "EWORKTREEBUSY" }),
    );

    expect(database.checkoutAt("/first")).not.toBeNull();
    expect(database.checkoutAt("/second")).not.toBeNull();
    const busyQueries = [...(db.storage.histogram?.entries() ?? [])].filter(([query]) =>
      query.includes("FROM git_operation_state operation"),
    );
    expect(busyQueries).toEqual([[expect.any(String), 1]]);
  });

  it("bulk-removes the maximum non-primary set in seven statements and is idempotent", () => {
    const { db, database, primary } = repository();
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (2) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1024
       )
       INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       SELECT id, ?, '/session-' || printf('%04d', id), ?, 0 FROM sequence`,
      primary.repoId,
      OID,
    );
    db.run("UPDATE git_identity_control SET last_checkout_id = 1024 WHERE singleton = 1");
    const ids = Array.from({ length: 1_023 }, (_, index) => index + 2);

    db.storage.resetCounters();
    const removed = database.removeCheckouts(primary.repoId, ids);

    expect(removed).toHaveLength(1_023);
    expect(Object.isFrozen(removed)).toBe(true);
    expect(removed.every(Object.isFrozen)).toBe(true);
    expect(db.storage.statementCount).toBe(7);
    expect(database.listCheckouts(primary.repoId)).toEqual([primary]);
    expect(database.removeCheckouts(primary.repoId, ids)).toEqual([]);
  });

  it("rejects unexpected and duplicate checkout rows before bulk deletion", () => {
    const modes: readonly ("unexpected" | "duplicate")[] = ["unexpected", "duplicate"];
    for (const mode of modes) {
      const { db, primary, database } = repository();
      const first = database.createCheckout(primary.repoId, "/first", OID);
      const second = database.createCheckout(primary.repoId, "/second", OTHER_OID);
      const firstRow = checkoutStorageRow(db, first.id);
      const injectedRows =
        mode === "unexpected"
          ? [firstRow, checkoutStorageRow(db, second.id)]
          : [firstRow, firstRow];
      const malicious = new SqliteGitDatabase(new CheckoutCursorDatabase(db, injectedRows));

      expect(() => malicious.removeCheckouts(primary.repoId, [first.id])).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(database.checkoutAt("/first")).not.toBeNull();
      expect(database.checkoutAt("/second")).not.toBeNull();
    }
  });

  it("requires synchronous lifecycle callbacks in its type surface", () => {
    const { database } = repository();

    expectTypeOf(database.createCheckout)
      .parameter(3)
      .toEqualTypeOf<((store: CheckoutStore) => undefined) | undefined>();
    expectTypeOf(database.removeCheckout)
      .parameter(1)
      .toEqualTypeOf<(checkout: CheckoutRow) => undefined>();
  });

  it("rejects unknown, primary, busy, and asynchronous single removals before deletion", () => {
    const { db, database, primary } = repository();
    const checkout = database.createCheckout(primary.repoId, "/session", OTHER_OID);
    let callbackCalls = 0;

    expect(() =>
      database.removeCheckout(999, () => {
        callbackCalls++;
      }),
    ).toThrowError(expect.objectContaining({ code: "EWORKTREENOTFOUND" }));
    expect(() =>
      database.removeCheckout(primary.id, () => {
        callbackCalls++;
      }),
    ).toThrowError(expect.objectContaining({ code: "EPRIMARYWORKTREE" }));
    insertBusyOperation(db, checkout.id);
    expect(() =>
      database.removeCheckout(checkout.id, () => {
        callbackCalls++;
      }),
    ).toThrowError(expect.objectContaining({ code: "EWORKTREEBUSY" }));
    expect(callbackCalls).toBe(0);
    expect(database.checkoutAt("/session")).not.toBeNull();

    db.run("DELETE FROM git_operation_state WHERE checkout_id = ?", checkout.id);
    expect(() =>
      Reflect.apply(database.removeCheckout, database, [
        checkout.id,
        async () => {
          callbackCalls++;
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(callbackCalls).toBe(1);
    expect(database.checkoutAt("/session")).not.toBeNull();
  });
});
