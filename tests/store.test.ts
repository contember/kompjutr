import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { concat, utf8 } from "../src/core/bytes.js";
import { hashObject, MODE_FILE, serializeCommit, serializeTree } from "../src/core/objects.js";
import type { ReplayStateMetadata } from "../src/core/ops/operation-state.js";
import { encodeDeltaHeader } from "../src/core/pack/delta.js";
import { PackWriter } from "../src/core/pack/writer.js";
import { retainedStringBytes } from "../src/core/retained.js";
import { deflate } from "../src/core/zlib.js";
import { MAX_OPERATION_MEMORY_BYTES } from "../src/memory.js";
import { BLOB_ID_CACHE_ELIGIBILITY_BYTES } from "../src/sqlite/blob-id-cache.js";
import { blob, readBlob } from "../src/sqlite/db.js";
import {
  MAX_BLOB_ID_CACHE_ROWS,
  MAX_INDEX_PATH_BYTES,
  MAX_ROUTING_CHECKOUTS,
  MAX_ROUTING_CHECKOUTS_RETAINED_BYTES,
  MAX_ROUTING_ROOTS_UTF8_BYTES,
  MAX_TRACKING_REF_REVISIONS,
} from "../src/sqlite/schema.js";
import {
  ancestors,
  blobIdMismatchRetainedBytes,
  CONFIG_SECTION_MOVE_UPDATE_SQL,
  configGetOwned,
  contentIdKey,
  createRefMutationMemoryOwner,
  MAX_CONFIG_SECTION_MOVE_ROWS,
  MAX_REF_MUTATION_RETAINED_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  SqliteGitDatabase,
  type StoreOptions,
  writeBatchOwned,
} from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { slices } from "./helpers/git.js";

function open(options: StoreOptions = {}) {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db, options);
  const repository = database.createRepository("/repo", "ref: refs/heads/main");
  return { db, database, store: database.openCheckout(repository) };
}

function assertMemoryCoordinatorIdle(store: ReturnType<typeof open>["store"]): void {
  expect(store.shared.memory.activeCount).toBe(0);
  expect(store.shared.memory.totalBytes).toBe(0);
}

function insertRawBlob(db: TestDatabase, repoId: number, data: Uint8Array): string {
  const oid = hashObject("blob", data);
  db.run(
    "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, 'blob', ?, 'raw')",
    repoId,
    oid,
    data.length,
  );
  db.run(
    "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, 0, ?)",
    repoId,
    oid,
    blob(data),
  );
  return oid;
}

describe("path helpers", () => {
  it("walks ancestors nearest first", () => {
    expect(ancestors("/a/b/c")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    expect(ancestors("/")).toEqual(["/"]);
  });
});

describe("repository registry", () => {
  it("resolves the nearest registered ancestor", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    database.createRepository("/", "ref: refs/heads/main");
    database.createRepository("/projects/app", "ref: refs/heads/main");
    expect(database.findCheckout("/projects/app/src/index.ts")?.root).toBe("/projects/app");
    expect(database.findCheckout("/projects/other")?.root).toBe("/");
    expect(database.findCheckout("/projects/appliance")?.root).toBe("/");
  });

  it("creates no .git rows of any kind", () => {
    const { database } = open();
    const tables = database.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "git_blob_id_state",
      "git_blob_ids",
      "git_checkout_reflog_entries",
      "git_checkouts",
      "git_commits",
      "git_config",
      "git_fetch_namespaces",
      "git_identity_control",
      "git_index",
      "git_index_dirty",
      "git_index_state",
      "git_loose_gc_candidates",
      "git_loose_object_lifecycle",
      "git_maintenance_control",
      "git_maintenance_objects",
      "git_maintenance_repack_batches",
      "git_maintenance_repack_objects",
      "git_maintenance_runs",
      "git_maintenance_shallow",
      "git_meta",
      "git_object_chunks",
      "git_objects",
      "git_operation_state",
      "git_operation_steps",
      "git_operation_touched",
      "git_pack_data",
      "git_pack_entries",
      "git_pack_gc_candidates",
      "git_pack_ingest_control",
      "git_pack_meta",
      "git_pack_objects",
      "git_pack_pending",
      "git_reflog_entries",
      "git_reflog_state",
      "git_refs",
      "git_repositories",
      "git_scratch_index_entries",
      "git_scratch_indexes",
      "git_shallow",
      "git_tracking_ref_revisions",
      "git_tree_effective",
      "git_tree_entries",
      "git_tree_sources",
    ]);
  });

  it("does not install cross-schema triggers in a Git-only database", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    expect(
      database.db.scalar<number>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'index_tracker_%'",
      ),
    ).toBe(0);
  });

  it("creates one primary checkout atomically with its checkout revision", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    db.storage.resetCounters();

    const repository = database.createRepository("/repo/../canonical", "ref: refs/heads/main");

    expect(repository).toEqual({
      id: 1,
      repoId: 1,
      root: "/canonical",
      head: "ref: refs/heads/main",
      isPrimary: true,
    });
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.one("SELECT repo_id, is_primary FROM git_checkouts")).toEqual({
      repo_id: 1,
      is_primary: 1,
    });
    expect(db.one("SELECT complete FROM git_index_state WHERE checkout_id = 1")).toEqual({
      complete: 0,
    });
    expect(db.scalar<number>("SELECT checkout_revision FROM git_repositories WHERE id = 1")).toBe(
      1,
    );

    expect(() => database.createRepository("/canonical", "ref: refs/heads/other")).toThrow();
    expect(db.scalar<number>("SELECT count(*) FROM git_repositories")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM git_checkouts")).toBe(1);
  });

  it("advances checkout revision for create, HEAD change, and removal", () => {
    const { db, database, store } = open();
    const revision = (): number => {
      const stored = db.scalar<number>(
        "SELECT checkout_revision FROM git_repositories WHERE id = 1",
      );
      if (stored === undefined) throw new Error("checkout revision is missing");
      return stored;
    };
    expect(revision()).toBe(1);

    const linked = database.createCheckout(1, "/linked", "ref: refs/heads/linked");
    expect(revision()).toBe(2);
    const linkedStore = database.openCheckout(linked);
    linkedStore.setHead("1".repeat(40));
    expect(revision()).toBe(3);
    linkedStore.setHead("1".repeat(40));
    expect(revision()).toBe(3);
    expect(() =>
      database.removeCheckout(linked.id, () => {
        throw new Error("injected checkout root removal failure");
      }),
    ).toThrow(/injected checkout root removal failure/);
    expect(revision()).toBe(3);
    expect(database.checkoutAt("/linked")).not.toBeNull();
    database.removeCheckout(linked.id, () => undefined);
    expect(revision()).toBe(4);
    expect(store.head()).toBe("ref: refs/heads/main");
  });

  it("rolls checkout mutations back on corrupt or exhausted checkout revision", () => {
    const exhausted = open();
    const linked = exhausted.database.createCheckout(1, "/linked", "ref: refs/heads/linked");
    exhausted.db.run(
      "UPDATE git_repositories SET checkout_revision = ? WHERE id = 1",
      Number.MAX_SAFE_INTEGER,
    );
    let removalCalled = false;
    expect(() =>
      exhausted.database.removeCheckout(linked.id, () => {
        removalCalled = true;
        return undefined;
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(removalCalled).toBe(false);
    expect(exhausted.database.checkoutAt("/linked")).not.toBeNull();
    const originalHead = exhausted.store.head();
    const originalOrdinal = exhausted.db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1",
    );
    expect(() => exhausted.store.setHead("1".repeat(40))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(exhausted.store.head()).toBe(originalHead);
    expect(
      exhausted.db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1"),
    ).toBe(originalOrdinal);
    expect(() =>
      exhausted.database.createCheckout(1, "/must-roll-back", "ref: refs/heads/other"),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(exhausted.database.checkoutAt("/must-roll-back")).toBeNull();

    const corrupt = open();
    corrupt.db.run("PRAGMA ignore_check_constraints = ON");
    corrupt.db.run("UPDATE git_repositories SET checkout_revision = zeroblob(1) WHERE id = 1");
    corrupt.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      corrupt.store.beginFetchPublication("refs/remotes/origin/", ["refs/heads/next"]),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(() =>
      corrupt.database.createCheckout(1, "/corrupt", "ref: refs/heads/corrupt"),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(corrupt.database.checkoutAt("/corrupt")).toBeNull();
    assertMemoryCoordinatorIdle(corrupt.store);
  });

  it("caps checkout listing per store and keeps branch attachment unique", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.createRepository("/primary", "ref: refs/heads/main");
    expect(() =>
      db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (2, ?, '/duplicate-branch', 'ref: refs/heads/main', 0)`,
        repository.repoId,
      ),
    ).toThrow(/UNIQUE/);
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (2) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1024
       )
       INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       SELECT id, ?, '/checkout-' || printf('%04d', id), ?, 0 FROM sequence`,
      repository.repoId,
      "1".repeat(40),
    );
    expect(database.listCheckouts(repository.repoId)).toHaveLength(1_024);

    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (1025, ?, '/checkout-1025', ?, 0)`,
      repository.repoId,
      "1".repeat(40),
    );
    expect(() => database.listCheckouts(repository.repoId)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("does not apply the per-store checkout cap to global routing", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < ?
       )
       INSERT INTO git_repositories (id) SELECT id FROM sequence`,
      MAX_ROUTING_CHECKOUTS,
    );
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < ?
       )
       INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       SELECT id + 2000, id, '/repo-' || printf('%04d', id), ?, 1 FROM sequence`,
      MAX_ROUTING_CHECKOUTS,
      "1".repeat(40),
    );

    const checkouts = database.listRoutingCheckouts();
    expect(checkouts).toHaveLength(MAX_ROUTING_CHECKOUTS);
    expect(checkouts.every((checkout) => checkout.id !== checkout.repoId)).toBe(true);
    expect(database.listRoutingRoots()).toHaveLength(MAX_ROUTING_CHECKOUTS);
    expect(MAX_ROUTING_CHECKOUTS_RETAINED_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_ROUTING_ROOTS_UTF8_BYTES).toBe(6 * 1024 * 1024);
  });

  it("shares one 8 MiB object cache across repositories", () => {
    const database = new SqliteGitDatabase(new TestDatabase());
    const first = database.openCheckout(database.createRepository("/one", "ref: refs/heads/main"));
    const second = database.openCheckout(database.createRepository("/two", "ref: refs/heads/main"));
    for (let index = 0; index < 10; index++) {
      const data = new Uint8Array(1024 * 1024).fill(index);
      (index < 5 ? first : second).write("blob", data);
    }
    expect(first.cacheBytes().objects).toBe(8 * 1024 * 1024);
    expect(second.cacheBytes()).toEqual(first.cacheBytes());
  });

  it("isolates equal oids by repository and store generation and caches warm reads", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const firstRow = database.createRepository("/one", "ref: refs/heads/main");
    const secondRow = database.createRepository("/two", "ref: refs/heads/main");
    const first = database.openCheckout(firstRow);
    const data = utf8.encode("same object, isolated cache\n");
    const oid = first.write("blob", data);
    expect(insertRawBlob(db, secondRow.repoId, data)).toBe(oid);
    const second = database.openCheckout(secondRow);

    db.storage.resetCounters();
    expect(second.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBeGreaterThan(0);
    db.storage.resetCounters();
    expect(second.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBe(0);

    first.destroy();
    second.destroy();
    const recreated = database.createRepository("/recreated", "ref: refs/heads/main");
    expect(recreated.repoId).toBeGreaterThan(secondRow.repoId);
    expect(insertRawBlob(db, recreated.repoId, data)).toBe(oid);
    const replacement = database.openCheckout(recreated);
    db.storage.resetCounters();
    expect(replacement.read(oid)?.data).toEqual(data);
    expect(db.storage.statementCount).toBeGreaterThan(0);
  });

  it("owns reflog rows through repository lifecycle foreign keys", () => {
    const { db, store } = open();
    store.setRef("refs/tags/x", "1".repeat(40));
    expect(() =>
      db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (999, 0)"),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO git_reflog_entries
           (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         VALUES (999, 'refs/tags/x', 1, NULL, ?, NULL, ?, NULL, NULL, 0, 0, 'orphan')`,
        "1".repeat(40),
        "1".repeat(40),
      ),
    ).toThrow();

    store.destroy();
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_state")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_repositories")).toBe(0);
  });

  it("composes shared state with isolated checkout state and evicts the whole store", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const repository = database.createRepository("/primary", "ref: refs/heads/main");
    const primary = database.openCheckout(repository);
    const secondaryId = 101;
    db.run(
      `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       VALUES (?, ?, '/secondary', 'ref: refs/heads/secondary', 0)`,
      secondaryId,
      repository.repoId,
    );
    const secondaryRow = database.checkoutAt("/secondary");
    if (secondaryRow === null) throw new Error("secondary checkout is missing");
    expect(Object.isFrozen(secondaryRow)).toBe(true);
    expect(Reflect.set(secondaryRow, "repoId", repository.repoId + 1)).toBe(false);
    expect(Reflect.set(secondaryRow, "root", "/forged")).toBe(false);
    expect(Reflect.set(secondaryRow, "head", "1".repeat(40))).toBe(false);
    expect(Reflect.set(secondaryRow, "isPrimary", true)).toBe(false);
    expect(secondaryRow.id).toBe(secondaryId);
    expect(secondaryRow.repoId).toBe(repository.repoId);
    expect(secondaryRow.root).toBe("/secondary");
    expect(secondaryRow.head).toBe("ref: refs/heads/secondary");
    expect(secondaryRow.isPrimary).toBe(false);
    expect(secondaryRow.id).not.toBe(secondaryRow.repoId);
    for (const forged of [
      { ...secondaryRow, repoId: repository.repoId + 1 },
      { ...secondaryRow, root: "/forged" },
      { ...secondaryRow, isPrimary: true },
    ]) {
      expect(() => database.openCheckout(forged)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
    expect(() => database.openCheckout({ ...secondaryRow, head: "1".repeat(40) })).not.toThrow();
    const secondary = database.openCheckout(secondaryRow);
    expect(() =>
      database.openCheckout({ ...secondaryRow, repoId: repository.repoId + 1 }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));

    expect(primary.shared).toBe(secondary.shared);
    expect(primary.shared).toBe(database.openShared(repository.repoId));
    expect(primary.packs).toBe(secondary.packs);
    const firstBlob = primary.write("blob", utf8.encode("primary\n"));
    const secondBlob = secondary.write("blob", utf8.encode("secondary\n"));
    expect(secondary.read(firstBlob)?.data).toEqual(utf8.encode("primary\n"));
    primary.setRef("refs/tags/shared", firstBlob);
    expect(secondary.getRef("refs/tags/shared")).toBe(firstBlob);
    primary.shared.setRef("refs/heads/main", firstBlob);
    expect(primary.reflog("HEAD")).toEqual([
      expect.objectContaining({ oldOid: null, newOid: firstBlob, reason: "ref update" }),
    ]);
    expect(secondary.reflog("HEAD")).toEqual([]);
    secondary.configSet("shared.value", "yes");
    expect(primary.configGet("shared.value")).toBe("yes");
    expect(() => primary.shared.getRef("HEAD")).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );

    secondary.setHead(secondBlob);
    expect(primary.head()).toBe("ref: refs/heads/main");
    expect(secondary.head()).toBe(secondBlob);
    expect(secondary.reflog("HEAD")).toEqual([
      expect.objectContaining({ oldRaw: "ref: refs/heads/secondary", newRaw: secondBlob }),
    ]);
    const branchConflictBefore = {
      head: secondary.head(),
      ordinal: db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        repository.repoId,
      ),
      directEntries: db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        repository.repoId,
      ),
      headEntries: db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE repo_id = ?",
        repository.repoId,
      ),
    };
    expect(() => secondary.setHead("ref: refs/heads/main")).toThrowError(
      expect.objectContaining({ code: "EBRANCHINUSE" }),
    );
    expect(() =>
      secondary.mutateRefs(
        {
          head: "ref: refs/heads/main",
          puts: [{ name: "refs/tags/must-roll-back", target: secondBlob }],
        },
        { actor: null, reason: "branch conflict", timestamp: 0, timezoneOffset: 0 },
      ),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHINUSE" }));
    expect(secondary.head()).toBe(branchConflictBefore.head);
    expect(secondary.getRef("refs/tags/must-roll-back")).toBeNull();
    expect(
      db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        repository.repoId,
      ),
    ).toBe(branchConflictBefore.ordinal);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        repository.repoId,
      ),
    ).toBe(branchConflictBefore.directEntries);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE repo_id = ?",
        repository.repoId,
      ),
    ).toBe(branchConflictBefore.headEntries);
    expect(
      db
        .all<{ ordinal: number }>(
          `SELECT ordinal FROM git_reflog_entries WHERE repo_id = ?
         UNION ALL
         SELECT ordinal FROM git_checkout_reflog_entries WHERE repo_id = ?
         ORDER BY ordinal`,
          repository.repoId,
          repository.repoId,
        )
        .map((row) => row.ordinal),
    ).toEqual([1, 2, 3, 4]);
    expect(
      db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        repository.repoId,
      ),
    ).toBe(4);
    primary.indexPut({
      path: "tracked",
      stage: 0,
      mode: 0o100644,
      oid: firstBlob,
      size: null,
      mtime: null,
      ino: null,
    });
    secondary.indexPut({
      path: "tracked",
      stage: 0,
      mode: 0o100644,
      oid: secondBlob,
      size: null,
      mtime: null,
      ino: null,
    });
    expect(primary.indexGet("tracked")?.oid).toBe(firstBlob);
    expect(secondary.indexGet("tracked")?.oid).toBe(secondBlob);

    const person = {
      name: "Fixture",
      email: "fixture@example.com",
      timestamp: 1_700_000_000,
      timezoneOffset: 0,
    };
    const tree = primary.write("tree", serializeTree([]));
    const original = primary.write(
      "commit",
      serializeCommit({ tree, parent: [], author: person, committer: person, message: "base\n" }),
    );
    const source = primary.write(
      "commit",
      serializeCommit({
        tree,
        parent: [original],
        author: person,
        committer: person,
        message: "source\n",
      }),
    );
    const operation: ReplayStateMetadata = {
      kind: "cherry-pick",
      originalHeadRef: "refs/heads/secondary",
      originalHeadOid: original,
      phase: "empty",
      emptyReason: "result",
      sourceOid: source,
      selectedParentOid: original,
      mainline: null,
      currentLabel: "HEAD",
      incomingLabel: source.slice(0, 7),
      message: "source\n",
      author: null,
      committer: null,
    };
    secondary.writeOperationState(operation, []);
    expect(primary.readOperationState()).toBeNull();
    expect(secondary.requireOperationState("cherry-pick").state).toEqual(operation);

    const oldShared = primary.shared;
    primary.destroy();
    expect(db.scalar<number>("SELECT count(*) FROM git_repositories")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_checkouts")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_index")).toBe(0);
    expect(db.scalar<number>("SELECT count(*) FROM git_operation_state")).toBe(0);
    const replacement = database.openCheckout(
      database.createRepository("/replacement", "ref: refs/heads/main"),
    );
    expect(replacement.shared).not.toBe(oldShared);
    expect(replacement.read(firstBlob)).toBeNull();
  });
});

describe("blob id batches", () => {
  it("round-trips 9,329 opaque binary ids in bounded statements", () => {
    const { db, store } = open();
    const mappings = Array.from({ length: 9_329 }, (_, index) => {
      const contentId = new Uint8Array(20);
      contentId[0] = index & 0xff;
      contentId[1] = (index >>> 8) & 0xff;
      contentId[2] = 0;
      return { contentId, oid: index.toString(16).padStart(40, "0") };
    });
    mappings.push({ contentId: new Uint8Array(0), oid: "f".repeat(40) });
    db.storage.resetCounters();
    store.upsertBlobIds(mappings);
    const writtenStatements = db.storage.statementCount;
    const found = store.lookupBlobIds(mappings.map((mapping) => mapping.contentId));
    const totalStatements = db.storage.statementCount;

    expect(writtenStatements).toBeLessThan(1_000);
    expect(db.scalar<number>("SELECT generation FROM git_blob_id_state WHERE repo_id = 1")).toBe(3);
    expect(totalStatements).toBeLessThan(1_000);
    expect(found.size).toBe(mappings.length);
    for (const mapping of mappings) {
      expect(found.get(contentIdKey(mapping.contentId))).toBe(mapping.oid);
    }

    db.storage.resetCounters();
    expect(store.blobIdMismatches(mappings)).toEqual(new Map());
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.storage.rowCount).toBe(0);
  });

  it("returns only mismatched and missing expected identities", () => {
    const { db, store } = open();
    const matching = new Uint8Array([0, 1, 0]);
    const mismatched = new Uint8Array([0, 2, 0]);
    const missing = new Uint8Array([0, 3, 0]);
    const matchingOid = "1".repeat(40);
    const actualOid = "2".repeat(40);
    db.storage.resetCounters();
    store.upsertBlobIds([
      { contentId: matching, oid: matchingOid },
      { contentId: mismatched, oid: actualOid },
    ]);
    expect(db.storage.statementCount).toBeLessThan(1_000);

    db.storage.resetCounters();
    const result = store.blobIdMismatches([
      { contentId: matching, oid: matchingOid },
      { contentId: mismatched, oid: "3".repeat(40) },
      { contentId: missing, oid: "4".repeat(40) },
      // Conflicting expectations for one identity must still expose its actual oid.
      { contentId: matching, oid: "5".repeat(40) },
    ]);

    expect(result).toEqual(
      new Map([
        [1, actualOid],
        [2, null],
        [3, matchingOid],
      ]),
    );
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.storage.rowCount).toBe(3);
  });

  it("preserves absolute mismatch ordinals around oversized uncached ids", () => {
    const { store } = open();
    const oversized = new Uint8Array(BLOB_ID_CACHE_ELIGIBILITY_BYTES + 1).fill(9);
    const cacheable = new Uint8Array([1, 2, 3]);
    const storedOid = "1".repeat(40);
    const expectedOid = "2".repeat(40);
    store.upsertBlobIds([{ contentId: cacheable, oid: storedOid }]);

    expect(
      store.blobIdMismatches([
        { contentId: oversized, oid: "3".repeat(40) },
        { contentId: cacheable, oid: expectedOid },
      ]),
    ).toEqual(
      new Map([
        [0, null],
        [1, storedOid],
      ]),
    );
    expect(
      store.blobIdMismatches([
        { contentId: cacheable, oid: expectedOid },
        { contentId: oversized, oid: "3".repeat(40) },
      ]),
    ).toEqual(
      new Map([
        [1, null],
        [0, storedOid],
      ]),
    );
    assertMemoryCoordinatorIdle(store);
  });

  it("snapshots yielded cacheable ids and does not retain oversized mismatch inputs", () => {
    const { store } = open();
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    const firstKey = contentIdKey(first);
    const secondKey = contentIdKey(second);
    const firstOid = "1".repeat(40);
    const secondOid = "2".repeat(40);
    const replacementOid = "3".repeat(40);
    store.upsertBlobIds(
      (function* () {
        yield { contentId: first, oid: firstOid };
        first.fill(9);
        yield { contentId: second, oid: secondOid };
        second.fill(8);
        yield { contentId: new Uint8Array([1, 2, 3]), oid: replacementOid };
      })(),
    );

    const lookup = new Uint8Array([1, 2, 3]);
    expect(
      store.lookupBlobIds(
        (function* () {
          yield lookup;
          lookup.fill(7);
        })(),
      ),
    ).toEqual(new Map([[firstKey, replacementOid]]));

    const expected = new Uint8Array([4, 5, 6]);
    expect(
      store.blobIdMismatches(
        (function* () {
          yield { contentId: expected, oid: secondOid };
          expected.fill(6);
        })(),
      ),
    ).toEqual(new Map());
    expect(store.lookupBlobIds([new Uint8Array([4, 5, 6])])).toEqual(
      new Map([[secondKey, secondOid]]),
    );

    const oversized = new Uint8Array(8 * 1024 * 1024).fill(5);
    expect(store.blobIdMismatches([{ contentId: oversized, oid: firstOid }])).toEqual(
      new Map([[0, null]]),
    );
    expect(store.shared.memory.highWaterBytes).toBeLessThan(oversized.length);
    assertMemoryCoordinatorIdle(store);
  });

  it("charges expected and returned identity maps exactly and releases every path", () => {
    const oid = "1".repeat(40);
    const mappings = Array.from({ length: 2_048 }, (_, index) => ({
      contentId: new Uint8Array([index & 0xff, index >>> 8]),
      oid,
    }));

    const measured = open();
    expect(measured.store.blobIdMismatches(mappings).size).toBe(mappings.length);
    const operationBytes = measured.store.shared.memory.highWaterBytes;
    expect(operationBytes).toBeGreaterThan(
      mappings.reduce((bytes, mapping) => bytes + blobIdMismatchRetainedBytes(mapping), 0),
    );
    assertMemoryCoordinatorIdle(measured.store);

    const exact = open();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    try {
      expect(exact.store.blobIdMismatches(mappings).size).toBe(mappings.length);
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const excess = open();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    try {
      expect(() => excess.store.blobIdMismatches(mappings)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
    } finally {
      excessBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(excess.store);
  });

  it("rejects invalid expected identities and fails closed on corrupt mappings", () => {
    const { store } = open();
    const contentId = new Uint8Array([9]);
    expect(() => store.blobIdMismatches([{ contentId, oid: "not-an-oid" }])).toThrow(
      /invalid blob oid/,
    );
    const longId = new Uint8Array(BLOB_ID_CACHE_ELIGIBILITY_BYTES + 1).fill(7);
    store.upsertBlobIds([{ contentId: longId, oid: "1".repeat(40) }]);
    expect(store.db.scalar<number>("SELECT count(*) FROM git_blob_ids")).toBe(0);
    expect(store.lookupBlobIds([longId])).toEqual(new Map());
    expect(store.blobIdMismatches([{ contentId: longId, oid: "1".repeat(40) }])).toEqual(
      new Map([[0, null]]),
    );

    store.upsertBlobIds([{ contentId, oid: "1".repeat(40) }]);
    store.db.run(
      "INSERT INTO git_blob_ids (repo_id, content_id, oid, generation) VALUES (?, ?, ?, ?)",
      1,
      blob(longId),
      "1".repeat(40),
      1,
    );
    expect(store.db.scalar<number>("SELECT count(*) FROM git_blob_ids")).toBe(2);
    expect(store.lookupBlobIds([longId])).toEqual(new Map());
    store.db.run("PRAGMA ignore_check_constraints = ON");
    store.db.run("UPDATE git_blob_ids SET oid = 'broken' WHERE repo_id = ?", 1);
    store.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() => store.blobIdMismatches([{ contentId, oid: "2".repeat(40) }])).toThrow(
      /invalid mapping/,
    );
  });

  it("isolates mappings and removes them with their repository", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const first = database.openCheckout(database.createRepository("/one", "ref: refs/heads/main"));
    const second = database.openCheckout(database.createRepository("/two", "ref: refs/heads/main"));
    const contentId = new Uint8Array([0, 255, 0]);
    first.upsertBlobIds([{ contentId, oid: "1".repeat(40) }]);
    second.upsertBlobIds([{ contentId, oid: "2".repeat(40) }]);
    expect(first.lookupBlobIds([contentId]).get(contentIdKey(contentId))).toBe("1".repeat(40));
    expect(second.lookupBlobIds([contentId]).get(contentIdKey(contentId))).toBe("2".repeat(40));
    first.destroy();
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids")).toBe(1);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_blob_id_state")).toBe(1);
  });

  it("rejects null, unknown, and malformed cache control rows", () => {
    const { db, store } = open();
    const retained = new Uint8Array([7]);
    store.upsertBlobIds([{ contentId: retained, oid: "1".repeat(40) }]);

    for (const operation of [null, "unknown"]) {
      expect(() =>
        db.run("INSERT INTO git_blob_id_updates VALUES (1, zeroblob(0), '', ?, -1)", operation),
      ).toThrow(/invalid blob id cache operation/);
    }
    expect(() =>
      db.run("INSERT INTO git_blob_id_updates VALUES (0, zeroblob(0), '', 'finish', 0)"),
    ).toThrow(/invalid blob id cache finish/);
    expect(store.lookupBlobIds([retained])).toEqual(new Map([["07", "1".repeat(40)]]));
  });

  it("evicts the oldest generations at the hard per-repository row cap", () => {
    const { db, store } = open();
    const page = (start: number, count: number, oid: string) =>
      Array.from({ length: count }, (_, offset) => {
        const value = start + offset;
        return {
          contentId: new Uint8Array([
            value & 0xff,
            (value >>> 8) & 0xff,
            (value >>> 16) & 0xff,
            (value >>> 24) & 0xff,
          ]),
          oid,
        };
      });
    const generationRows = 4_096;
    for (let generation = 0; generation < 17; generation++) {
      store.upsertBlobIds(
        page(
          generation * generationRows,
          generationRows,
          (generation + 1).toString(16).padStart(40, "0"),
        ),
      );
    }
    const newestOid = (17).toString(16).padStart(40, "0");
    const newestContentId = page(16 * generationRows, 1, newestOid)[0]!.contentId;

    expect(db.scalar<number>("SELECT COUNT(*) FROM git_blob_ids WHERE repo_id = 1")).toBe(
      MAX_BLOB_ID_CACHE_ROWS,
    );
    expect(store.lookupBlobIds([new Uint8Array(4)])).toEqual(new Map());
    expect(store.lookupBlobIds([newestContentId]).get(contentIdKey(newestContentId))).toBe(
      newestOid,
    );
  });

  it("rolls back a cache update when its generation is exhausted", () => {
    const { db, store } = open();
    const retained = new Uint8Array([1]);
    store.upsertBlobIds([{ contentId: retained, oid: "1".repeat(40) }]);
    db.run(
      "UPDATE git_blob_id_state SET generation = ? WHERE repo_id = 1",
      Number.MAX_SAFE_INTEGER,
    );

    expect(() =>
      store.upsertBlobIds([{ contentId: new Uint8Array([2]), oid: "2".repeat(40) }]),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(store.lookupBlobIds([retained, new Uint8Array([2])])).toEqual(
      new Map([["01", "1".repeat(40)]]),
    );
    expect(db.scalar<number>("SELECT generation FROM git_blob_id_state WHERE repo_id = 1")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("loose objects", () => {
  it("accepts a tree name above the removed parser cache threshold", () => {
    const { store } = open();
    const name = "a".repeat(2_201);
    const data = concat([
      utf8.encode("100644 "),
      utf8.encode(name),
      new Uint8Array([0]),
      new Uint8Array(20),
    ]);
    const oid = store.write("tree", data);
    expect(store.objectCount()).toBe(1);
    expect([...store.walkTree(oid)]).toEqual([
      { path: name, mode: MODE_FILE, oid: "0".repeat(40) },
    ]);
  });

  it("round-trips through chunked storage", () => {
    const { store } = open();
    const data = new TextEncoder().encode("hello world\n");
    const oid = store.write("blob", data);
    expect(oid).toBe(hashObject("blob", data));
    expect(store.has(oid)).toBe(true);
    expect(store.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("stores objects through the exact 4 KiB raw boundary", () => {
    const { store } = open();
    for (const size of [0, 1, 4_095, 4_096, 4_097]) {
      const data = new Uint8Array(randomBytes(size));
      const oid = store.write("blob", data);
      const row = store.db.one<{ stored: string; data: unknown }>(
        `SELECT o.stored, c.data FROM git_objects o
          JOIN git_object_chunks c ON c.repo_id = o.repo_id AND c.oid = o.oid
         WHERE o.repo_id = ? AND o.oid = ? AND c.seq = 0`,
        1,
        oid,
      );
      if (row === undefined) throw new Error(`missing loose row for ${oid}`);
      expect(row.stored).toBe(size <= 4_096 ? "raw" : "zlib");
      if (size <= 4_096) expect(readBlob(row.data)).toEqual(data);
      expect(oid).toBe(hashObject("blob", data));
      expect(store.read(oid)?.data).toEqual(data);
    }
  });

  it("chunks objects larger than one row", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(3_500_000));
    const oid = store.write("blob", data);
    const chunks = store.db.scalar<number>(
      "SELECT COUNT(*) FROM git_object_chunks WHERE oid = ?",
      oid,
    );
    expect(chunks).toBeGreaterThan(1);
    expect(store.read(oid)?.data.length).toBe(data.length);
  });

  it("keeps large scalar, batch, and streamed commits authoritative when cache-ineligible", () => {
    const person = {
      name: "Large Commit",
      email: "large@example.test",
      timestamp: 1_700_000_000,
      timezoneOffset: 0,
    };
    const data = serializeCommit({
      tree: "1".repeat(40),
      parent: [],
      author: person,
      committer: person,
      message: `${"m".repeat(2_100_000)}\n`,
    });
    const expectedOid = hashObject("commit", data);

    const scalar = open();
    expect(scalar.store.write("commit", data)).toBe(expectedOid);
    expect(scalar.store.readAuthenticatedObject(expectedOid, "commit")?.data).toEqual(data);
    expect(scalar.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(0);
    assertMemoryCoordinatorIdle(scalar.store);

    const batch = open();
    expect(batch.store.writeObjects((writer) => writer.write("commit", data))).toBe(expectedOid);
    expect(batch.store.readAuthenticatedObject(expectedOid, "commit")?.data).toEqual(data);
    expect(batch.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(0);
    assertMemoryCoordinatorIdle(batch.store);

    const streamed = open();
    expect(
      streamed.store.writeStream("commit", data.length, function* () {
        for (let offset = 0; offset < data.length; offset += 64 * 1024) {
          yield data.subarray(offset, offset + 64 * 1024);
        }
      }),
    ).toBe(expectedOid);
    expect(streamed.store.readAuthenticatedObject(expectedOid, "commit")?.data).toEqual(data);
    expect(streamed.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(0);
    assertMemoryCoordinatorIdle(streamed.store);
  });

  it("resolves unambiguous prefixes only", () => {
    const { store } = open();
    const oid = store.write("blob", new TextEncoder().encode("a"));
    expect(store.resolvePrefix(oid.slice(0, 7))).toBe(oid);
    expect(store.resolvePrefix("0".repeat(8))).toBeNull();
  });

  it("reads 1,000 loose blobs in a bounded batch within the statement target", () => {
    const { db, store } = open();
    const expected = new Map<string, Uint8Array>();
    store.writeObjects((batch) => {
      for (let index = 0; index < 1_000; index++) {
        const data = new Uint8Array(257).fill(index & 0xff);
        data[0] = index & 0xff;
        data[1] = index >>> 8;
        expected.set(batch.write("blob", data), data);
      }
    });
    const wanted = [...expected.keys()];
    db.storage.resetCounters();
    const read = store.readBlobs([wanted[0]!, ...wanted, wanted[0]!], {
      budgetBytes: 1024 * 1024,
    });
    expect(read.remaining).toEqual([]);
    expect(read.blobs.size).toBe(expected.size);
    for (const [oid, data] of expected) expect(read.blobs.get(oid)).toEqual(data);
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("returns remaining at object boundaries and admits an oversized first singleton", () => {
    const { store } = open();
    const first = store.write("blob", new Uint8Array(10));
    const second = store.write("blob", new Uint8Array(20));
    expect(store.readBlobs([first, second], { budgetBytes: 10 })).toEqual({
      blobs: new Map([[first, new Uint8Array(10)]]),
      remaining: [second],
      bytes: 10,
    });
    expect(store.readBlobs([second], { budgetBytes: 10 })).toEqual({
      blobs: new Map([[second, new Uint8Array(20)]]),
      remaining: [],
      bytes: 20,
    });
  });

  it("reads a valid first object above the pack batching target as one singleton", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(PACK_BLOB_BATCH_TARGET_BYTES + 1));
    const oid = store.write("blob", data);

    expect(store.readBlobs([oid], { budgetBytes: 1 })).toEqual({
      blobs: new Map([[oid, data]]),
      remaining: [],
      bytes: data.length,
    });
    assertMemoryCoordinatorIdle(store);
  });

  it("reads two packed 2.2 MiB objects under an 8 MiB caller target", async () => {
    const { store } = open();
    const first = new Uint8Array(randomBytes(2_200_000));
    const second = new Uint8Array(randomBytes(2_200_000));
    const firstOid = hashObject("blob", first);
    const secondOid = hashObject("blob", second);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", first);
    writer.object("blob", second);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64 * 1024));

    const objects = store.readObjects([firstOid, secondOid], { budgetBytes: 8 * 1024 * 1024 });
    expect([...objects.objects.keys()]).toEqual([firstOid, secondOid]);
    expect(objects.objects.get(firstOid)).toEqual({ type: "blob", data: first });
    expect(objects.objects.get(secondOid)).toEqual({ type: "blob", data: second });
    expect(objects.remaining).toEqual([]);
    expect(objects.bytes).toBe(first.length + second.length);
    assertMemoryCoordinatorIdle(store);

    const blobs = store.readBlobs([secondOid, firstOid, secondOid], {
      budgetBytes: 8 * 1024 * 1024,
    });
    expect([...blobs.blobs.keys()]).toEqual([secondOid, firstOid]);
    expect(blobs.blobs.get(secondOid)).toEqual(second);
    expect(blobs.blobs.get(firstOid)).toEqual(first);
    expect(blobs.remaining).toEqual([]);
    expect(blobs.bytes).toBe(first.length + second.length);
    assertMemoryCoordinatorIdle(store);
  });

  it("owns mixed loose and packed output once through final map assembly", async () => {
    const db = new TestDatabase();
    const setupDatabase = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
    const setup = setupDatabase.openCheckout(
      setupDatabase.createRepository("/repo", "ref: refs/heads/main"),
    );
    const loose = new Uint8Array(randomBytes(300_000));
    const packed = new Uint8Array(randomBytes(300_001));
    const looseOid = setup.write("blob", loose);
    const packedOid = hashObject("blob", packed);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("blob", packed);
    writer.finish();
    await setup.packs.ingest(slices(concat(chunks), 64 * 1024));

    const reopen = (): ReturnType<typeof open>["store"] => {
      const database = new SqliteGitDatabase(db, { chunkBytes: 0, objectCacheBytes: 0 });
      const checkout = database.findCheckout("/repo");
      if (checkout === null) throw new Error("mixed object checkout disappeared");
      return database.openCheckout(checkout);
    };
    const read = (store: ReturnType<typeof open>["store"]): void => {
      expect(store.readObjects([looseOid, packedOid], { budgetBytes: 1024 * 1024 })).toEqual({
        objects: new Map([
          [looseOid, { type: "blob", data: loose }],
          [packedOid, { type: "blob", data: packed }],
        ]),
        remaining: [],
        bytes: loose.length + packed.length,
      });
    };

    const current = reopen();
    read(current);
    assertMemoryCoordinatorIdle(current);
  });

  it("owns a large loose delta base once during a packed read", async () => {
    const db = new TestDatabase();
    const options: StoreOptions = { chunkBytes: 0, objectCacheBytes: 0 };
    const setupDatabase = new SqliteGitDatabase(db, options);
    const setup = setupDatabase.openCheckout(
      setupDatabase.createRepository("/repo", "ref: refs/heads/main"),
    );
    const base = new Uint8Array(4_500_000).fill(0x61);
    const baseOid = setup.write("blob", base);
    const target = new Uint8Array([0x62]);
    const targetOid = hashObject("blob", target);
    const packChunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => packChunks.push(chunk));
    writer.header(1);
    writer.refDelta(
      baseOid,
      concat([encodeDeltaHeader(base.length, target.length), new Uint8Array([1]), target]),
    );
    writer.finish();
    await setup.packs.ingest(slices(concat(packChunks), 64 * 1024));

    const reopen = (): ReturnType<typeof open>["store"] => {
      const database = new SqliteGitDatabase(db, options);
      const checkout = database.findCheckout("/repo");
      if (checkout === null) throw new Error("packed read checkout disappeared");
      return database.openCheckout(checkout);
    };
    const run = (store: ReturnType<typeof open>["store"]): void => {
      expect(store.readBlobs([targetOid], { budgetBytes: 8 * 1024 * 1024 })).toEqual({
        blobs: new Map([[targetOid, target]]),
        remaining: [],
        bytes: target.length,
      });
    };

    const current = reopen();
    run(current);
    assertMemoryCoordinatorIdle(current);
  });

  it("validates complete metadata beyond the selected prefix", () => {
    const { db, store } = open();
    const present = insertRawBlob(db, 1, new Uint8Array(10));
    const missing = "f".repeat(40);
    expect(() => store.readObjects([present, missing], { budgetBytes: 10 })).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    assertMemoryCoordinatorIdle(store);
  });

  it("pre-admits complete object metadata before its query", () => {
    const wanted = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(40, "0"));
    const run = (opened: ReturnType<typeof open>): void => {
      expect(() => opened.store.readObjects(wanted)).toThrowError(
        expect.objectContaining({ code: "ENOTFOUND" }),
      );
    };

    const measured = open();
    measured.db.storage.resetCounters();
    run(measured);
    const operationBytes = measured.store.shared.memory.highWaterBytes;
    expect(measured.db.storage.statementCount).toBe(1);
    assertMemoryCoordinatorIdle(measured.store);

    const exact = open();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    try {
      exact.db.storage.resetCounters();
      run(exact);
      expect(exact.db.storage.statementCount).toBe(1);
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const excess = open();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    try {
      excess.db.storage.resetCounters();
      expect(() => excess.store.readObjects(wanted)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(excess.db.storage.statementCount).toBe(0);
    } finally {
      excessBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(excess.store);
  });

  it("pre-admits loose rows and payloads before opening the payload cursor", () => {
    const data = new Uint8Array(randomBytes(900_000));
    const prepare = (): ReturnType<typeof open> => {
      const opened = open();
      insertRawBlob(opened.db, 1, data);
      return opened;
    };
    const run = (opened: ReturnType<typeof open>) =>
      opened.store.readBlobs([hashObject("blob", data)], { budgetBytes: 2 * 1024 * 1024 });

    const measured = prepare();
    measured.db.storage.resetCounters();
    expect(run(measured).blobs.values().next().value).toEqual(data);
    const operationBytes = measured.store.shared.memory.highWaterBytes;
    expect(measured.db.storage.statementCount).toBe(3);
    assertMemoryCoordinatorIdle(measured.store);

    const exact = prepare();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    try {
      exact.db.storage.resetCounters();
      expect(run(exact).blobs.values().next().value).toEqual(data);
      expect(exact.db.storage.statementCount).toBe(3);
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const excess = prepare();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    try {
      excess.db.storage.resetCounters();
      expect(() => run(excess)).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(excess.db.storage.statementCount).toBe(2);
    } finally {
      excessBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(excess.store);
  });
});

describe("effective tree sources", () => {
  const effective = (db: TestDatabase, repoId: number, oid: string) =>
    db.one<{ storage: string; source_id: number }>(
      `SELECT source.storage, source.source_id FROM git_tree_effective effective
       JOIN git_tree_sources source ON source.source_key = effective.source_key
       WHERE effective.repo_id = ? AND effective.tree_oid = ?`,
      repoId,
      oid,
    );

  it("tracks single and batch loose tree writes", () => {
    const { db, store } = open();
    const first = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const second = serializeTree([{ mode: MODE_FILE, name: "b", oid: "2".repeat(40) }]);
    const firstOid = store.write("tree", first);
    const secondOid = store.writeObjects((batch) => batch.write("tree", second));

    expect(effective(db, 1, firstOid)).toEqual({ storage: "loose", source_id: 0 });
    expect(effective(db, 1, secondOid)).toEqual({ storage: "loose", source_id: 0 });
  });

  it("indexes a raw tree written through the streaming path", () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "streamed", oid: "3".repeat(40) }]);
    const oid = store.writeStream("tree", data.length, function* () {
      yield data.subarray(0, 7);
      yield data.subarray(7);
    });

    expect(
      db.scalar<string>("SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?", 1, oid),
    ).toBe("raw");
    expect([...store.walkTree(oid)]).toEqual([
      { path: "streamed", mode: MODE_FILE, oid: "3".repeat(40) },
    ]);
  });

  it("removes stale parsed rows before rewriting a deleted loose tree", () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = store.write("tree", data);
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(
      db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = 1 AND tree_oid = ?",
        oid,
      ),
    ).toBe(0);

    expect(store.write("tree", data)).toBe(oid);
    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: "1".repeat(40) }]);
  });

  it("falls back to a complete packed copy when the loose tree is deleted", async () => {
    const { db, store } = open();
    const data = serializeTree([{ mode: MODE_FILE, name: "a", oid: "1".repeat(40) }]);
    const oid = store.write("tree", data);
    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(1);
    writer.object("tree", data);
    writer.finish();
    const { packId } = await store.packs.ingest(slices(concat(chunks), 64));

    expect(effective(db, 1, oid)).toEqual({ storage: "loose", source_id: 0 });
    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(effective(db, 1, oid)).toEqual({ storage: "pack", source_id: packId });
    expect([...store.walkTree(oid)]).toEqual([{ path: "a", mode: MODE_FILE, oid: "1".repeat(40) }]);
  });

  it("isolates identical tree ids between repositories", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db);
    const first = database.openCheckout(database.createRepository("/one", "ref: refs/heads/main"));
    const second = database.openCheckout(database.createRepository("/two", "ref: refs/heads/main"));
    const data = serializeTree([{ mode: MODE_FILE, name: "same", oid: "1".repeat(40) }]);
    const oid = first.write("tree", data);
    expect(second.write("tree", data)).toBe(oid);

    db.run("DELETE FROM git_objects WHERE repo_id = 1 AND oid = ?", oid);
    expect(effective(db, 1, oid)).toBeUndefined();
    expect(effective(db, 2, oid)).toEqual({ storage: "loose", source_id: 0 });
    expect([...second.walkTree(oid)]).toHaveLength(1);
  });
});

describe("object batches", () => {
  const chunkCount = (store: ReturnType<typeof open>["store"], oid: string) =>
    store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE oid = ?", oid);

  it("round-trips every payload shape through the ordinary read path", () => {
    const { store } = open();
    const shapes: Uint8Array[] = [
      new Uint8Array(0),
      utf8.encode("a tree entry or two\n"),
      new Uint8Array(randomBytes(4_096)),
      new Uint8Array(randomBytes(4_097)),
      // Random, so it neither compresses nor fits in one 1 MiB chunk row.
      new Uint8Array(randomBytes(3_500_000)),
      new Uint8Array(randomBytes(200_000)),
    ];
    const oids = store.writeObjects((batch) => shapes.map((data) => batch.write("blob", data)));
    // Identity by length plus hash: a megabyte-scale deep compare costs
    // more than the whole rest of this file.
    const same = (actual: Uint8Array, expected: Uint8Array) => {
      expect(actual.length).toBe(expected.length);
      expect(hashObject("blob", actual)).toBe(hashObject("blob", expected));
    };
    shapes.forEach((data, at) => {
      const oid = oids[at]!;
      expect(oid).toBe(hashObject("blob", data));
      expect(store.has(oid)).toBe(true);
      expect(store.typeAndSize(oid)).toEqual({ type: "blob", size: data.length });
      expect(
        store.db.scalar<string>(
          "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
          1,
          oid,
        ),
      ).toBe(data.length <= 4_096 ? "raw" : "zlib");
      same(store.read(oid)?.data ?? new Uint8Array(1), data);
      same(concat([...(store.readChunks(oid) ?? [])]), data);
    });
    expect(chunkCount(store, oids[4]!)).toBeGreaterThan(1);
  });

  it("stores empty blobs and trees as one non-null raw BLOB chunk", () => {
    const { store } = open();
    const empty = new Uint8Array(0);
    const [blobOid, treeOid] = store.writeObjects((batch) => [
      batch.write("blob", empty),
      batch.write("tree", empty),
    ]);

    const objects: { type: "blob" | "tree"; oid: string | undefined }[] = [
      { type: "blob", oid: blobOid },
      { type: "tree", oid: treeOid },
    ];
    for (const { type, oid } of objects) {
      if (oid === undefined) throw new Error(`missing empty ${type} oid`);
      expect(oid).toBe(hashObject(type, empty));
      expect(
        store.db.scalar<string>(
          "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
          1,
          oid,
        ),
      ).toBe("raw");
      expect(
        store.db.one<{ seq: number; dataType: string; bytes: number }>(
          `SELECT seq, typeof(data) AS dataType, length(data) AS bytes
             FROM git_object_chunks WHERE repo_id = ? AND oid = ?`,
          1,
          oid,
        ),
      ).toEqual({ seq: 0, dataType: "blob", bytes: 0 });
      expect(store.read(oid)).toEqual({ type, data: empty });
    }

    if (treeOid === undefined) throw new Error("missing empty tree oid");
    expect(
      store.db.scalar<number>(
        "SELECT COUNT(*) FROM git_tree_sources WHERE repo_id = ? AND tree_oid = ?",
        1,
        treeOid,
      ),
    ).toBe(1);
    expect([...store.walkTree(treeOid)]).toEqual([]);
  });

  it("stages an object without writing a row until it is flushed", () => {
    const { store } = open();
    const data = utf8.encode("deferred\n");
    const batch = store.writeBatch();
    const oid = batch.write("blob", data);
    expect(oid).toBe(hashObject("blob", data));
    expect(store.has(oid)).toBe(false);
    expect(chunkCount(store, oid)).toBe(0);
    batch.flush();
    expect(store.has(oid)).toBe(true);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("charges owned staged payloads across writes and clears on flush and error", () => {
    const { store } = open();
    const owner = store.reserveMemory();
    const batch = writeBatchOwned(store.shared, owner, {
      payloadBytes: MAX_OPERATION_MEMORY_BYTES,
      flushEvery: 16,
    });
    try {
      const first = utf8.encode("first staged object\n");
      const second = new Uint8Array(randomBytes(8_192));
      const firstOid = batch.write("blob", first);
      const firstBytes = owner.currentBytes;
      expect(firstBytes).toBeGreaterThan(first.byteLength);
      const secondOid = batch.write("blob", second);
      expect(owner.currentBytes).toBeGreaterThan(firstBytes + second.byteLength);
      expect(store.has(firstOid)).toBe(false);
      expect(store.has(secondOid)).toBe(false);

      batch.flush();
      expect(owner.currentBytes).toBe(0);
      expect(store.has(firstOid)).toBe(true);
      expect(store.has(secondOid)).toBe(true);

      expect(() => batch.write("commit", utf8.encode("not a commit"))).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(owner.currentBytes).toBe(0);
    } finally {
      batch.dispose();
      owner.dispose();
    }
    store.shared.memory.assertIdle();
  });

  it("admits commit parsing at the exact input-derived transient boundary", () => {
    const person = {
      name: "Commit Parser",
      email: "parser@example.test",
      timestamp: 1_700_000_000,
      timezoneOffset: 0,
    };
    const data = serializeCommit({
      tree: "1".repeat(40),
      parent: [],
      author: person,
      committer: person,
      message: `${"parsed commit body ".repeat(4_096)}\n`,
    });

    const measured = open();
    const probe = measured.store.reserveMemory();
    const measuredBatch = writeBatchOwned(measured.store.shared, probe, {
      payloadBytes: MAX_OPERATION_MEMORY_BYTES,
      flushEvery: 2,
    });
    try {
      measuredBatch.write("commit", data);
    } finally {
      measuredBatch.dispose();
    }
    const operationBytes = probe.highWaterBytes;
    probe.dispose();
    measured.store.shared.memory.assertIdle();

    const exact = open();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactOwner = exact.store.reserveMemory();
    const exactBatch = writeBatchOwned(exact.store.shared, exactOwner, {
      payloadBytes: MAX_OPERATION_MEMORY_BYTES,
      flushEvery: 2,
    });
    try {
      exactBatch.write("commit", data);
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactBatch.dispose();
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    exact.store.shared.memory.assertIdle();

    const excess = open();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const excessOwner = excess.store.reserveMemory();
    const excessBatch = writeBatchOwned(excess.store.shared, excessOwner, {
      payloadBytes: MAX_OPERATION_MEMORY_BYTES,
      flushEvery: 2,
    });
    try {
      expect(() => excessBatch.write("commit", data)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(excessOwner.currentBytes).toBe(0);
      expect(excess.db.scalar<number>("SELECT count(*) FROM git_objects")).toBe(0);
      expect(excess.db.scalar<number>("SELECT count(*) FROM git_commits")).toBe(0);
    } finally {
      excessBatch.dispose();
      excessOwner.dispose();
      excessBlocker.dispose();
    }
    excess.store.shared.memory.assertIdle();
  });

  it("owns multi-object flush transients through exact commit or atomic failure", () => {
    const objects = [
      new Uint8Array(randomBytes(24_000)),
      new Uint8Array(randomBytes(32_000)),
      new Uint8Array(randomBytes(40_000)),
    ];
    const options = { payloadBytes: MAX_OPERATION_MEMORY_BYTES, flushEvery: 4 };

    const measured = open();
    const probe = measured.store.reserveMemory();
    const measuredBatch = writeBatchOwned(measured.store.shared, probe, options);
    for (const data of objects) measuredBatch.write("blob", data);
    const stagedBytes = probe.highWaterBytes;
    measuredBatch.flush();
    const operationBytes = probe.highWaterBytes;
    expect(operationBytes).toBeGreaterThan(stagedBytes + 1);
    expect(probe.currentBytes).toBe(0);
    measuredBatch.dispose();
    probe.dispose();
    measured.store.shared.memory.assertIdle();

    const exact = open();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactOwner = exact.store.reserveMemory();
    const exactBatch = writeBatchOwned(exact.store.shared, exactOwner, options);
    try {
      for (const data of objects) exactBatch.write("blob", data);
      exactBatch.flush();
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
      expect(exact.db.scalar<number>("SELECT count(*) FROM git_objects")).toBe(objects.length);
    } finally {
      exactBatch.dispose();
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    exact.store.shared.memory.assertIdle();

    const excess = open();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const excessOwner = excess.store.reserveMemory();
    const excessBatch = writeBatchOwned(excess.store.shared, excessOwner, options);
    try {
      for (const data of objects) excessBatch.write("blob", data);
      expect(() => excessBatch.flush()).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(excessOwner.currentBytes).toBe(0);
      expect(excess.db.scalar<number>("SELECT count(*) FROM git_objects")).toBe(0);
      expect(excess.db.scalar<number>("SELECT count(*) FROM git_object_chunks")).toBe(0);
    } finally {
      excessBatch.dispose();
      excessOwner.dispose();
      excessBlocker.dispose();
    }
    excess.store.shared.memory.assertIdle();
  });

  it("owns raw and zlib blob bytes before the caller can mutate them", () => {
    const { store } = open();
    const inputs = [new Uint8Array(randomBytes(4_096)), new Uint8Array(randomBytes(4_097))];
    const expected = inputs.map((data) => data.slice());
    const batch = store.writeBatch();
    const oids = inputs.map((data) => batch.write("blob", data));
    for (const data of inputs) data.fill(0);
    batch.flush();

    expected.forEach((data, index) => {
      const oid = oids[index];
      if (oid === undefined) throw new Error(`missing oid ${index}`);
      expect(oid).toBe(hashObject("blob", data));
      expect(store.read(oid)?.data).toEqual(data);
    });
  });

  it("owns raw and zlib tree bytes used by the parsed index", () => {
    const { store } = open();
    const rawEntries = [{ mode: MODE_FILE, name: "raw", oid: "1".repeat(40) }];
    const zlibEntries = Array.from({ length: 160 }, (_, index) => ({
      mode: MODE_FILE,
      name: `file-${String(index).padStart(3, "0")}.txt`,
      oid: String(index).padStart(40, "0"),
    }));
    const raw = serializeTree(rawEntries);
    const zlib = serializeTree(zlibEntries);
    const rawExpected = raw.slice();
    const zlibExpected = zlib.slice();
    expect(raw.length).toBeLessThanOrEqual(4_096);
    expect(zlib.length).toBeGreaterThan(4_096);
    const batch = store.writeBatch();
    const rawOid = batch.write("tree", raw);
    const zlibOid = batch.write("tree", zlib);
    raw.fill(0);
    zlib.fill(0);
    batch.flush();

    expect(store.read(rawOid)?.data).toEqual(rawExpected);
    expect(store.read(zlibOid)?.data).toEqual(zlibExpected);
    expect([...store.walkTree(rawOid)].map((row) => row.path)).toEqual(["raw"]);
    expect([...store.walkTree(zlibOid)].map((row) => row.path)).toEqual(
      zlibEntries.map((row) => row.name),
    );
  });

  it("removes the chunks a shorter write of the same oid does not reach", () => {
    const { store } = open();
    const data = new Uint8Array(randomBytes(700_000));
    // writeStream rows at 64 KiB, the batch at 1 MiB, so the same oid goes
    // from many chunks to one. Content addressing makes that the only way
    // two writes of one oid can disagree on chunk count.
    const oid = store.writeStream("blob", data.length, function* () {
      yield data;
    });
    const before = chunkCount(store, oid) ?? 0;
    expect(before).toBeGreaterThan(1);

    // Drop the metadata row only: an interrupted write leaves exactly this,
    // chunks with nothing pointing at them, and `has` says no.
    store.db.run("DELETE FROM git_objects WHERE oid = ?", oid);
    expect(store.has(oid)).toBe(false);

    store.writeObjects((batch) => batch.write("blob", data));
    expect(chunkCount(store, oid)).toBe(1);
    expect(hashObject("blob", store.read(oid)?.data ?? new Uint8Array(1))).toBe(oid);
  });

  it("writes nothing for an object that is already stored", () => {
    const { store } = open();
    const data = utf8.encode("already here\n");
    const oid = store.write("blob", data);
    const written = () =>
      store.db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks WHERE repo_id = ?", 1);
    const before = written();
    store.writeObjects((batch) => batch.write("blob", data));
    expect(written()).toBe(before);
    expect(store.read(oid)?.data).toEqual(data);
  });

  it("does not rewrite an existing small legacy-zlib object as raw", () => {
    const { store } = open();
    const data = utf8.encode("legacy compressed bytes\n");
    const oid = store.writeObjects((batch) => batch.write("blob", data));
    store.db.run("UPDATE git_objects SET stored = 'zlib' WHERE repo_id = ? AND oid = ?", 1, oid);
    store.db.run(
      "UPDATE git_object_chunks SET data = ? WHERE repo_id = ? AND oid = ? AND seq = 0",
      deflate(data),
      1,
      oid,
    );

    store.writeObjects((batch) => batch.write("blob", data));

    expect(
      store.db.scalar<string>(
        "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
        1,
        oid,
      ),
    ).toBe("zlib");
    expect(store.read(oid)?.data).toEqual(data);
  });
});

describe("bulk existence", () => {
  it("answers for loose, packed, both and absent exactly as has() does", async () => {
    const { db, store } = open();
    const looseOnly = utf8.encode("loose only\n");
    const packedOnly = utf8.encode("packed only\n");
    const both = utf8.encode("loose and packed\n");
    const looseOid = store.write("blob", looseOnly);
    const bothOid = store.write("blob", both);
    const packedOid = hashObject("blob", packedOnly);
    const absentOid = "0".repeat(40);

    const chunks: Uint8Array[] = [];
    const writer = new PackWriter((chunk) => chunks.push(chunk));
    writer.header(2);
    writer.object("blob", packedOnly);
    writer.object("blob", both);
    writer.finish();
    await store.packs.ingest(slices(concat(chunks), 64));

    const oids = [looseOid, packedOid, bothOid, absentOid];
    const present = store.hasAll(oids);
    for (const oid of oids) expect(present.has(oid)).toBe(store.has(oid));
    expect([...present].sort()).toEqual([looseOid, packedOid, bothOid].sort());
    expect(store.missing(oids)).toEqual([absentOid]);

    // One statement for the whole list, spanning both tables.
    db.storage.resetCounters();
    store.hasAll(oids);
    expect(db.storage.statementCount).toBe(1);
  });

  it("holds its own against an empty list and against duplicates", () => {
    const { store } = open();
    const oid = store.write("blob", utf8.encode("dup\n"));
    expect(store.hasAll([]).size).toBe(0);
    expect(store.missing([])).toEqual([]);
    expect(store.missing([oid, oid])).toEqual([]);
    expect(store.missing(["1".repeat(40), "1".repeat(40)])).toEqual(["1".repeat(40)]);
  });
});

describe("refs, config and index", () => {
  const fetchMetadata = {
    actor: null,
    reason: "fetch publication",
    timestamp: 1_800_000_000,
    timezoneOffset: 0,
  };

  it("stores shared refs relationally with HEAD on the checkout row", () => {
    const { store } = open();
    store.setRef("refs/heads/main", "a".repeat(40));
    store.setRef("refs/remotes/origin/main", "b".repeat(40));
    expect(store.getRef("refs/heads/main")).toBe("a".repeat(40));
    expect(store.listRefs("refs/heads/")).toEqual([
      { name: "refs/heads/main", target: "a".repeat(40) },
    ]);
    expect(store.head()).toBe("ref: refs/heads/main");
    store.setHead("c".repeat(40));
    expect(store.getRef("HEAD")).toBe("c".repeat(40));
  });

  it("owns a single long listed ref row at the exact shared boundary", () => {
    const name = `refs/tags/${"n".repeat(1_500_001)}`;
    const target = "1".repeat(40);
    const rowTextBytes = utf8.encode(name).byteLength + utf8.encode(target).byteLength;
    const operationBytes = 1_224 + 5 * rowTextBytes;
    expect(operationBytes).toBeLessThan(MAX_REF_MUTATION_RETAINED_BYTES);
    const prepare = (): ReturnType<typeof open> => {
      const opened = open();
      opened.db.run("INSERT INTO git_refs (repo_id, name, target) VALUES (1, ?, ?)", name, target);
      return opened;
    };

    const exact = prepare();
    const externalBytes = MAX_REF_MUTATION_RETAINED_BYTES - operationBytes;
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", externalBytes);
    try {
      expect(exact.store.listRefs()).toEqual([{ name, target }]);
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_REF_MUTATION_RETAINED_BYTES);
      expect(exactBlocker.currentBytes).toBe(externalBytes);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const over = prepare();
    const overBlocker = over.store.reserveMemory();
    overBlocker.set("other", externalBytes + 1);
    try {
      expect(() => over.store.listRefs()).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(over.db.scalar<number>("SELECT count(*) FROM git_refs WHERE repo_id = 1")).toBe(1);
      expect(overBlocker.currentBytes).toBe(externalBytes + 1);
    } finally {
      overBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(over.store);
  });

  it("streams repository refs with symbolic targets in strict Git byte order", () => {
    const { database, store } = open();
    const direct = "1".repeat(40);
    const privateUse = "refs/tags/\ue000";
    const supplementary = "refs/tags/\u{10000}";
    store.updateRefs([
      { name: supplementary, target: direct },
      { name: "refs/heads/main", target: direct },
      { name: privateUse, target: direct },
      {
        name: "refs/remotes/origin/HEAD",
        target: "ref: refs/remotes/origin/main",
      },
    ]);
    const foreign = database.openCheckout(
      database.createRepository("/foreign", "ref: refs/heads/main"),
    );
    foreign.setRef("refs/heads/foreign", "2".repeat(40));

    expect([...store.shared.iterateRefs()]).toEqual([
      { name: "refs/heads/main", target: direct },
      {
        name: "refs/remotes/origin/HEAD",
        target: "ref: refs/remotes/origin/main",
      },
      { name: privateUse, target: direct },
      { name: supplementary, target: direct },
    ]);
  });

  it.each([
    ["name", "UPDATE git_refs SET name = '' WHERE repo_id = 1"],
    ["target", "UPDATE git_refs SET target = 'broken' WHERE repo_id = 1"],
    ["name type", "UPDATE git_refs SET name = CAST('refs/heads/main' AS BLOB) WHERE repo_id = 1"],
    [
      "target type",
      "UPDATE git_refs SET target = CAST(printf('%040d', 0) AS BLOB) WHERE repo_id = 1",
    ],
  ])("rejects a corrupt stored ref %s while streaming", (_field, corruption) => {
    const { db, store } = open();
    store.setRef("refs/heads/main", "1".repeat(40));
    db.run(corruption);

    expect(() => [...store.shared.iterateRefs()]).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it.each([
    [
      "name",
      "UPDATE git_refs SET name = CAST(x'726566732f68656164732ff09080' AS TEXT) WHERE repo_id = 1",
    ],
    ["target", "UPDATE git_refs SET target = CAST(x'f09080' AS TEXT) WHERE repo_id = 1"],
  ])("rejects non-canonical UTF-8 in a stored ref %s", (field, corruption) => {
    const { db, store } = open();
    store.setRef("refs/heads/main", "1".repeat(40));
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(corruption);
    db.run("PRAGMA ignore_check_constraints = OFF");

    expect(() => store.listRefs()).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(() => [...store.shared.iterateRefs()]).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    if (field === "target") {
      expect(() => store.getRef("refs/heads/main")).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
    assertMemoryCoordinatorIdle(store);
  });

  it.each([
    ["non-canonical UTF-8", "CAST(x'f09080' AS TEXT)"],
    ["a non-text type", "CAST(printf('%040d', 0) AS BLOB)"],
  ])("rejects %s in persisted HEAD state", (_case, expression) => {
    const { db, database, store } = open();
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(`UPDATE git_checkouts SET head = ${expression} WHERE repo_id = 1`);
    db.run("PRAGMA ignore_check_constraints = OFF");

    expect(() => store.head()).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(() => database.checkoutAt("/repo")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => store.reflog("HEAD")).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    assertMemoryCoordinatorIdle(store);
  });

  it("rejects non-canonical UTF-8 in tracking control rows", () => {
    const revision = open();
    revision.store
      .beginTrackingRefPublication("refs/remotes/origin/", "refs/remotes/origin/main")
      .dispose();
    revision.db.run("PRAGMA ignore_check_constraints = ON");
    revision.db.run(
      `UPDATE git_tracking_ref_revisions
          SET ref_name = CAST(x'726566732f72656d6f7465732f6f726967696e2ff09080' AS TEXT)
        WHERE repo_id = 1`,
    );
    revision.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() => revision.store.beginFetchPublication("refs/remotes/origin/")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    assertMemoryCoordinatorIdle(revision.store);

    const namespace = open();
    namespace.store.beginFetchPublication("refs/remotes/origin/").dispose();
    namespace.db.run("PRAGMA ignore_check_constraints = ON");
    namespace.db.run(
      `UPDATE git_fetch_namespaces
          SET tracking_prefix = CAST(x'726566732f72656d6f7465732ff090802f' AS TEXT)
        WHERE repo_id = 1`,
    );
    namespace.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() => namespace.store.beginFetchPublication("refs/remotes/upstream/")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    assertMemoryCoordinatorIdle(namespace.store);
  });

  it("lets only the newest same-namespace fetch publish, including after its raw no-op", () => {
    const { store } = open();
    const name = "refs/remotes/origin/main";
    const current = "1".repeat(40);
    store.setRef(name, current);
    const older = store.beginFetchPublication("refs/remotes/origin/");
    const newer = store.beginFetchPublication("refs/remotes/origin/");

    try {
      expect(newer.generation).toBe(older.generation + 1);
      expect(
        store.publishFetchRefs(newer, { trackingPuts: [{ name, target: current }] }, fetchMetadata),
      ).toBe(false);
      expect(() =>
        store.publishFetchRefs(
          older,
          { trackingPuts: [{ name, target: "2".repeat(40) }] },
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef(name)).toBe(current);
    } finally {
      older.dispose();
      newer.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("fences overlapping tracking prefixes and lets disjoint prefixes commute", () => {
    const { store } = open();
    const broad = store.beginFetchPublication("refs/remotes/team/");
    const narrow = store.beginFetchPublication("refs/remotes/team/sub/");
    const origin = store.beginFetchPublication("refs/remotes/origin/");
    const upstream = store.beginFetchPublication("refs/remotes/upstream/");

    try {
      expect(() => store.publishFetchRefs(broad, {}, fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
      expect(
        store.publishFetchRefs(
          narrow,
          {
            trackingPuts: [{ name: "refs/remotes/team/sub/main", target: "1".repeat(40) }],
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(
        store.publishFetchRefs(
          upstream,
          {
            trackingPuts: [{ name: "refs/remotes/upstream/main", target: "2".repeat(40) }],
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(
        store.publishFetchRefs(
          origin,
          {
            trackingPuts: [{ name: "refs/remotes/origin/main", target: "3".repeat(40) }],
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(store.listRefs("refs/remotes/")).toEqual([
        { name: "refs/remotes/origin/main", target: "3".repeat(40) },
        { name: "refs/remotes/team/sub/main", target: "1".repeat(40) },
        { name: "refs/remotes/upstream/main", target: "2".repeat(40) },
      ]);
    } finally {
      broad.dispose();
      narrow.dispose();
      origin.dispose();
      upstream.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("detects generic tracking ABA while unrelated local branches coexist", () => {
    const { db, store } = open();
    const tracking = "refs/remotes/origin/main";
    const local = "refs/heads/local";
    const first = "1".repeat(40);
    store.setRef(tracking, first);
    store.setRef(local, "a".repeat(40));
    const stale = store.beginFetchPublication("refs/remotes/origin/");

    try {
      store.setRef(tracking, "2".repeat(40));
      store.setRef(tracking, first);
      const revision = db.scalar<number>(
        "SELECT revision FROM git_fetch_namespaces WHERE repo_id = 1 AND tracking_prefix = ?",
        "refs/remotes/origin/",
      );
      expect(revision).toBe(2);
      store.setRef(local, "b".repeat(40));
      expect(
        db.scalar<number>(
          "SELECT revision FROM git_fetch_namespaces WHERE repo_id = 1 AND tracking_prefix = ?",
          "refs/remotes/origin/",
        ),
      ).toBe(revision);
      expect(() =>
        store.publishFetchRefs(
          stale,
          { trackingPuts: [{ name: tracking, target: first }] },
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
    } finally {
      stale.dispose();
    }

    const fresh = store.beginFetchPublication("refs/remotes/origin/");
    try {
      store.setRef(local, "c".repeat(40));
      expect(
        store.publishFetchRefs(
          fresh,
          { trackingPuts: [{ name: tracking, target: "3".repeat(40) }] },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(store.getRef(tracking)).toBe("3".repeat(40));
      expect(store.getRef(local)).toBe("c".repeat(40));
    } finally {
      fresh.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("detects tracking ABA from a store opened before the fetch namespace existed", () => {
    const first = open();
    const tracking = "refs/remotes/origin/main";
    const original = "1".repeat(40);
    first.store.setRef(tracking, original);
    const secondDatabase = new SqliteGitDatabase(new TestDatabase(first.db.storage));
    const checkout = secondDatabase.checkoutAt("/repo");
    if (checkout === null) throw new Error("shared checkout is missing");
    const second = secondDatabase.openCheckout(checkout);
    const token = second.beginFetchPublication("refs/remotes/origin/");

    try {
      first.store.setRef(tracking, "2".repeat(40));
      first.store.setRef(tracking, original);
      expect(() =>
        second.publishFetchRefs(
          token,
          { trackingPuts: [{ name: tracking, target: "3".repeat(40) }] },
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(second.getRef(tracking)).toBe(original);
    } finally {
      token.dispose();
    }
    assertMemoryCoordinatorIdle(first.store);
    assertMemoryCoordinatorIdle(second);
  });

  it("fences a tracking fallback after a newer same-target fetch generation", () => {
    const { store } = open();
    const prefix = "refs/remotes/origin/";
    const tracking = `${prefix}main`;
    const original = "1".repeat(40);
    store.setRef(tracking, original);
    const fallback = store.beginTrackingRefPublication(prefix, tracking);
    const newer = store.beginFetchPublication(prefix);

    try {
      expect(
        store.publishFetchRefs(
          newer,
          { trackingPuts: [{ name: tracking, target: original }] },
          fetchMetadata,
        ),
      ).toBe(false);
      expect(() => store.publishTrackingRef(fallback, "2".repeat(40), fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
      expect(store.getRef(tracking)).toBe(original);
    } finally {
      fallback.dispose();
      newer.dispose();
    }

    const independent = store.beginTrackingRefPublication(prefix, tracking);
    const upstream = store.beginFetchPublication("refs/remotes/upstream/");
    try {
      expect(
        store.publishFetchRefs(
          upstream,
          {
            trackingPuts: [{ name: "refs/remotes/upstream/main", target: "3".repeat(40) }],
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(store.publishTrackingRef(independent, "2".repeat(40), fetchMetadata)).toBe(true);
      expect(store.getRef(tracking)).toBe("2".repeat(40));
    } finally {
      independent.dispose();
      upstream.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("keeps a pending narrower fetch disjoint from first broad tracking publication", () => {
    const { store } = open();
    const narrowPrefix = "refs/remotes/team/sub/";
    const narrowRef = `${narrowPrefix}main`;
    const broadPrefix = "refs/remotes/team/";
    const broadRef = `${broadPrefix}main`;
    const historicalBroad = store.beginFetchPublication(broadPrefix);
    try {
      expect(store.publishFetchRefs(historicalBroad, {}, fetchMetadata)).toBe(false);
    } finally {
      historicalBroad.dispose();
    }
    const tracking = store.beginTrackingRefPublication(broadPrefix, broadRef);
    const fetch = store.beginFetchPublication(narrowPrefix);

    try {
      expect(store.publishTrackingRef(tracking, "1".repeat(40), fetchMetadata)).toBe(true);
      expect(
        store.publishFetchRefs(
          fetch,
          { trackingPuts: [{ name: narrowRef, target: "2".repeat(40) }] },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(store.getRef(broadRef)).toBe("1".repeat(40));
      expect(store.getRef(narrowRef)).toBe("2".repeat(40));
    } finally {
      fetch.dispose();
      tracking.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("lets a fresh tracking observation supersede an older tracking snapshot", () => {
    const { store } = open();
    const prefix = "refs/remotes/origin/";
    const tracking = `${prefix}main`;
    store.setRef(tracking, "1".repeat(40));
    const fallback = store.beginTrackingRefPublication(prefix, tracking);
    const fetch = store.beginFetchPublication(prefix);
    let fresh: ReturnType<typeof store.beginTrackingRefPublication> | null = null;

    try {
      expect(
        store.publishFetchRefs(
          fetch,
          { trackingPuts: [{ name: tracking, target: "2".repeat(40) }] },
          fetchMetadata,
        ),
      ).toBe(true);
      fresh = store.beginTrackingRefPublication(prefix, tracking);
      expect(fresh.target).toBe("2".repeat(40));
      expect(store.publishTrackingRef(fresh, "3".repeat(40), fetchMetadata)).toBe(true);
      expect(store.getRef(tracking)).toBe("3".repeat(40));
      expect(() => store.publishTrackingRef(fallback, "4".repeat(40), fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
    } finally {
      fallback.dispose();
      fetch.dispose();
      fresh?.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it.each([
    { label: "put", initial: "1".repeat(40), target: "1".repeat(40) },
    { label: "delete", initial: null, target: null },
  ])("fences an older pending fetch after an idempotent tracking $label", ({ initial, target }) => {
    const { store } = open();
    const prefix = "refs/remotes/origin/";
    const tracking = `${prefix}main`;
    if (initial !== null) store.setRef(tracking, initial);
    const older = store.beginFetchPublication(prefix);
    const observation = store.beginTrackingRefPublication(prefix, tracking);

    try {
      expect(store.publishTrackingRef(observation, target, fetchMetadata)).toBe(false);
      expect(() =>
        store.publishFetchRefs(
          older,
          { trackingPuts: [{ name: tracking, target: "2".repeat(40) }] },
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef(tracking)).toBe(initial);
    } finally {
      older.dispose();
      observation.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("creates a durable exact tracking revision before first fetch and detects ABA", () => {
    const { db, store } = open();
    const prefix = "refs/remotes/origin/";
    const tracking = `${prefix}${"m".repeat(1_025 - prefix.length)}`;
    expect(tracking).toHaveLength(1_025);
    const original = "1".repeat(40);
    store.setRef(tracking, original);
    const stale = store.beginTrackingRefPublication(prefix, tracking);

    try {
      expect(
        db.scalar<number>(
          "SELECT revision FROM git_tracking_ref_revisions WHERE repo_id = 1 AND ref_name = ?",
          tracking,
        ),
      ).toBe(0);
      store.setRef(tracking, "2".repeat(40));
      store.setRef(tracking, original);
      expect(
        db.scalar<number>(
          "SELECT revision FROM git_tracking_ref_revisions WHERE repo_id = 1 AND ref_name = ?",
          tracking,
        ),
      ).toBe(2);
      expect(() => store.publishTrackingRef(stale, "3".repeat(40), fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
      expect(store.getRef(tracking)).toBe(original);
    } finally {
      stale.dispose();
    }
    const reopenedDatabase = new SqliteGitDatabase(new TestDatabase(db.storage));
    const reopenedCheckout = reopenedDatabase.checkoutAt("/repo");
    if (reopenedCheckout === null) throw new Error("reopened checkout is missing");
    const reopened = reopenedDatabase.openCheckout(reopenedCheckout);
    expect(reopened.getRef(tracking)).toBe(original);
    expect(
      reopened.db.scalar<number>(
        "SELECT revision FROM git_tracking_ref_revisions WHERE repo_id = 1 AND ref_name = ?",
        tracking,
      ),
    ).toBe(2);
    assertMemoryCoordinatorIdle(store);
    assertMemoryCoordinatorIdle(reopened);
  });

  it("enforces the exact tracking revision cardinality from stored rows", () => {
    const { db, store } = open();
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (0) UNION ALL SELECT id + 1 FROM sequence WHERE id < ?
       )
       INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision)
       SELECT 1, 'refs/remotes/bound/' || printf('%06d', id), 0 FROM sequence`,
      MAX_TRACKING_REF_REVISIONS - 1,
    );
    expect(
      db.scalar<number>("SELECT count(*) FROM git_tracking_ref_revisions WHERE repo_id = 1"),
    ).toBe(MAX_TRACKING_REF_REVISIONS);
    expect(() =>
      store.beginTrackingRefPublication("refs/remotes/overflow/", "refs/remotes/overflow/main"),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    db.run(
      "INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision) VALUES (1, ?, 0)",
      "refs/remotes/overflow/main",
    );
    expect(() => store.setRef("refs/heads/main", "1".repeat(40))).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(store.getRef("refs/heads/main")).toBeNull();
    assertMemoryCoordinatorIdle(store);
  });

  it("rejects a tracking token when its repository disappeared", () => {
    const { db, store } = open();
    db.run("DELETE FROM git_repositories WHERE id = 1");
    expect(() =>
      store.beginTrackingRefPublication("refs/remotes/origin/", "refs/remotes/origin/main"),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    assertMemoryCoordinatorIdle(store);
  });

  it("rejects disposed, consumed, and cross-repository tracking tokens", () => {
    const { database, store } = open();
    const prefix = "refs/remotes/origin/";
    const tracking = `${prefix}main`;
    const disposed = store.beginTrackingRefPublication(prefix, tracking);
    disposed.dispose();
    expect(() => store.publishTrackingRef(disposed, "1".repeat(40), fetchMetadata)).toThrowError(
      expect.objectContaining({ code: "ESTALEFETCH" }),
    );

    const secondRepository = database.createRepository("/other", "ref: refs/heads/main");
    const second = database.openCheckout(secondRepository);
    const foreign = store.beginTrackingRefPublication(prefix, tracking);
    try {
      expect(() => second.publishTrackingRef(foreign, "2".repeat(40), fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
    } finally {
      foreign.dispose();
    }

    const consumed = store.beginTrackingRefPublication(prefix, tracking);
    try {
      expect(store.publishTrackingRef(consumed, "3".repeat(40), fetchMetadata)).toBe(true);
      expect(() => store.publishTrackingRef(consumed, "4".repeat(40), fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
    } finally {
      consumed.dispose();
    }
    assertMemoryCoordinatorIdle(store);
    assertMemoryCoordinatorIdle(second);
  });

  it("publishes an exact remote HEAD update and prune in one ref transaction", () => {
    const { store } = open();
    const prefix = "refs/remotes/origin/";
    store.updateRefs([
      { name: `${prefix}HEAD`, target: `ref: ${prefix}old` },
      { name: `${prefix}main`, target: "1".repeat(40) },
      { name: `${prefix}old`, target: "2".repeat(40) },
    ]);
    const token = store.beginFetchPublication(prefix);

    try {
      expect(token.trackingRefs).toEqual([
        { name: `${prefix}HEAD`, target: `ref: ${prefix}old` },
        { name: `${prefix}main`, target: "1".repeat(40) },
        { name: `${prefix}old`, target: "2".repeat(40) },
      ]);
      expect(
        store.publishFetchRefs(
          token,
          {
            trackingPuts: [{ name: `${prefix}main`, target: "3".repeat(40) }],
            trackingKeep: [`${prefix}main`],
            remoteHead: `ref: ${prefix}main`,
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(store.listRefs(prefix)).toEqual([
        { name: `${prefix}HEAD`, target: `ref: ${prefix}main` },
        { name: `${prefix}main`, target: "3".repeat(40) },
      ]);
      expect(store.reflog(`${prefix}old`)[0]).toMatchObject({
        oldRaw: "2".repeat(40),
        newRaw: null,
        reason: "fetch publication",
      });
    } finally {
      token.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("accepts an idempotent global tag winner and rejects a different target", () => {
    const { store } = open();
    const tag = "refs/tags/release";
    const same = store.beginFetchPublication("refs/remotes/origin/", [tag]);
    const winner = store.beginFetchPublication("refs/remotes/upstream/", [tag]);

    try {
      expect(
        store.publishFetchRefs(
          winner,
          { globalTagPuts: [{ name: tag, target: "1".repeat(40) }] },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(
        store.publishFetchRefs(
          same,
          { globalTagPuts: [{ name: tag, target: "1".repeat(40) }] },
          fetchMetadata,
        ),
      ).toBe(false);
    } finally {
      same.dispose();
      winner.dispose();
    }

    const different = store.beginFetchPublication("refs/remotes/mirror/", [tag]);
    const replacement = store.beginFetchPublication("refs/remotes/vendor/", [tag]);
    try {
      store.publishFetchRefs(
        replacement,
        { globalTagPuts: [{ name: tag, target: "2".repeat(40) }] },
        fetchMetadata,
      );
      expect(() =>
        store.publishFetchRefs(
          different,
          { globalTagPuts: [{ name: tag, target: "3".repeat(40) }] },
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef(tag)).toBe("2".repeat(40));
    } finally {
      different.dispose();
      replacement.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("checks only selected global tags and accepts an idempotent concurrent winner", () => {
    const { store } = open();
    const ignored = "refs/tags/ignored";
    const selected = "refs/tags/selected";
    store.setRef(selected, "0".repeat(40));
    const token = store.beginFetchPublication("refs/remotes/origin/", [ignored, selected]);

    try {
      store.setRef(ignored, "1".repeat(40));
      store.setRef(selected, "2".repeat(40));
      expect(
        store.publishFetchRefs(
          token,
          {
            trackingPuts: [{ name: "refs/remotes/origin/main", target: "3".repeat(40) }],
            globalTagPuts: [{ name: selected, target: "2".repeat(40) }],
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(store.getRef(ignored)).toBe("1".repeat(40));
      expect(store.getRef(selected)).toBe("2".repeat(40));
      expect(store.getRef("refs/remotes/origin/main")).toBe("3".repeat(40));
    } finally {
      token.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("serializes global shallow mutations across disjoint fetch namespaces", () => {
    const { db, store } = open();
    const origin = store.beginFetchPublication("refs/remotes/origin/");
    const upstream = store.beginFetchPublication("refs/remotes/upstream/");
    const originShallow = "1".repeat(40);
    const upstreamShallow = "2".repeat(40);

    try {
      expect(
        store.publishFetchRefs(
          upstream,
          {
            trackingPuts: [{ name: "refs/remotes/upstream/main", target: upstreamShallow }],
            shallowAdd: [upstreamShallow],
          },
          fetchMetadata,
        ),
      ).toBe(true);
      expect(() =>
        store.publishFetchRefs(
          origin,
          {
            trackingPuts: [{ name: "refs/remotes/origin/main", target: originShallow }],
            shallowAdd: [originShallow],
          },
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.getRef("refs/remotes/origin/main")).toBeNull();
      expect(store.shallow()).toEqual(new Set([upstreamShallow]));
      expect(db.scalar<number>("SELECT shallow_revision FROM git_repositories WHERE id = 1")).toBe(
        1,
      );
    } finally {
      origin.dispose();
      upstream.dispose();
    }

    const stale = store.beginFetchPublication("refs/remotes/origin/");
    try {
      store.setShallow(["3".repeat(40)]);
      expect(() =>
        store.publishFetchRefs(stale, { shallowRemove: [upstreamShallow] }, fetchMetadata),
      ).toThrowError(expect.objectContaining({ code: "ESTALEFETCH" }));
      expect(store.shallow()).toEqual(new Set([upstreamShallow, "3".repeat(40)]));
    } finally {
      stale.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("snapshots shallow boundaries authoritatively across live store views", () => {
    const first = open();
    const oldBoundary = "1".repeat(40);
    const currentBoundary = "2".repeat(40);
    first.store.setShallow([oldBoundary]);
    expect(first.store.shallow()).toEqual(new Set([oldBoundary]));

    const secondDatabase = new SqliteGitDatabase(new TestDatabase(first.db.storage));
    const checkout = secondDatabase.checkoutAt("/repo");
    if (checkout === null) throw new Error("shared checkout is missing");
    const second = secondDatabase.openCheckout(checkout);
    second.setShallow([currentBoundary], [oldBoundary]);
    const token = first.store.beginFetchPublication("refs/remotes/origin/");
    try {
      expect(token.shallow).toEqual([currentBoundary]);
      expect(token.shallowRevision).toBe(2);
    } finally {
      token.dispose();
    }
    assertMemoryCoordinatorIdle(first.store);
    assertMemoryCoordinatorIdle(second);
  });

  it("rejects disposed, consumed, and cross-repository publication tokens", () => {
    const { database, store } = open();
    const secondRepository = database.createRepository("/other", "ref: refs/heads/main");
    const second = database.openCheckout(secondRepository);
    const disposed = store.beginFetchPublication("refs/remotes/origin/");
    disposed.dispose();
    expect(disposed.disposed).toBe(true);
    expect(() => store.publishFetchRefs(disposed, {}, fetchMetadata)).toThrowError(
      expect.objectContaining({ code: "ESTALEFETCH" }),
    );

    const foreign = store.beginFetchPublication("refs/remotes/upstream/");
    try {
      expect(() => second.publishFetchRefs(foreign, {}, fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
    } finally {
      foreign.dispose();
    }

    const consumed = store.beginFetchPublication("refs/remotes/vendor/");
    try {
      expect(store.publishFetchRefs(consumed, {}, fetchMetadata)).toBe(false);
      expect(() => store.publishFetchRefs(consumed, {}, fetchMetadata)).toThrowError(
        expect.objectContaining({ code: "ESTALEFETCH" }),
      );
    } finally {
      consumed.dispose();
    }
    assertMemoryCoordinatorIdle(store);
    assertMemoryCoordinatorIdle(second);
  });

  it("fails closed on corrupt or exhausted fetch generations and revisions", () => {
    const corruptGeneration = open();
    corruptGeneration.db.run("PRAGMA ignore_check_constraints = ON");
    corruptGeneration.db.run(
      "UPDATE git_repositories SET fetch_generation = zeroblob(1) WHERE id = 1",
    );
    corruptGeneration.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      corruptGeneration.store.beginFetchPublication("refs/remotes/origin/"),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    assertMemoryCoordinatorIdle(corruptGeneration.store);

    const exhaustedGeneration = open();
    exhaustedGeneration.db.run(
      "UPDATE git_repositories SET fetch_generation = ? WHERE id = 1",
      Number.MAX_SAFE_INTEGER,
    );
    expect(() =>
      exhaustedGeneration.store.beginFetchPublication("refs/remotes/origin/"),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    assertMemoryCoordinatorIdle(exhaustedGeneration.store);

    const corruptNamespaceControl = open();
    const tracking = "refs/remotes/origin/main";
    corruptNamespaceControl.store.setRef(tracking, "1".repeat(40));
    const corruptNamespaceToken =
      corruptNamespaceControl.store.beginFetchPublication("refs/remotes/origin/");
    try {
      corruptNamespaceControl.db.run(
        "UPDATE git_repositories SET fetch_generation = 0 WHERE id = 1",
      );
      expect(() => corruptNamespaceControl.store.setRef(tracking, "2".repeat(40))).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(corruptNamespaceControl.store.getRef(tracking)).toBe("1".repeat(40));
    } finally {
      corruptNamespaceToken.dispose();
    }
    assertMemoryCoordinatorIdle(corruptNamespaceControl.store);

    const corruptRevision = open();
    const corruptToken = corruptRevision.store.beginFetchPublication("refs/remotes/origin/");
    try {
      corruptRevision.db.run("PRAGMA ignore_check_constraints = ON");
      corruptRevision.db.run(
        "UPDATE git_fetch_namespaces SET revision = zeroblob(1) WHERE repo_id = 1",
      );
      corruptRevision.db.run("PRAGMA ignore_check_constraints = OFF");
      expect(() =>
        corruptRevision.store.publishFetchRefs(corruptToken, {}, fetchMetadata),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    } finally {
      corruptToken.dispose();
    }
    assertMemoryCoordinatorIdle(corruptRevision.store);

    const exhaustedRevision = open();
    const exhaustedToken = exhaustedRevision.store.beginFetchPublication("refs/remotes/origin/");
    try {
      exhaustedRevision.db.run(
        "UPDATE git_fetch_namespaces SET revision = ? WHERE repo_id = 1",
        Number.MAX_SAFE_INTEGER,
      );
      expect(() =>
        exhaustedRevision.store.setRef("refs/remotes/origin/main", "1".repeat(40)),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(exhaustedRevision.store.getRef("refs/remotes/origin/main")).toBeNull();
    } finally {
      exhaustedToken.dispose();
    }
    assertMemoryCoordinatorIdle(exhaustedRevision.store);

    const corruptTrackingRevision = open();
    const corruptTrackingToken = corruptTrackingRevision.store.beginTrackingRefPublication(
      "refs/remotes/origin/",
      "refs/remotes/origin/main",
    );
    try {
      corruptTrackingRevision.db.run("PRAGMA ignore_check_constraints = ON");
      corruptTrackingRevision.db.run(
        "UPDATE git_tracking_ref_revisions SET revision = zeroblob(1) WHERE repo_id = 1",
      );
      corruptTrackingRevision.db.run("PRAGMA ignore_check_constraints = OFF");
      expect(() =>
        corruptTrackingRevision.store.publishTrackingRef(
          corruptTrackingToken,
          "1".repeat(40),
          fetchMetadata,
        ),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    } finally {
      corruptTrackingToken.dispose();
    }
    assertMemoryCoordinatorIdle(corruptTrackingRevision.store);

    const exhaustedTrackingRevision = open();
    const exhaustedTrackingToken = exhaustedTrackingRevision.store.beginTrackingRefPublication(
      "refs/remotes/origin/",
      "refs/remotes/origin/main",
    );
    try {
      exhaustedTrackingRevision.db.run(
        "UPDATE git_tracking_ref_revisions SET revision = ? WHERE repo_id = 1",
        Number.MAX_SAFE_INTEGER,
      );
      expect(() =>
        exhaustedTrackingRevision.store.setRef("refs/remotes/origin/main", "1".repeat(40)),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(exhaustedTrackingRevision.store.getRef("refs/remotes/origin/main")).toBeNull();
    } finally {
      exhaustedTrackingToken.dispose();
    }
    assertMemoryCoordinatorIdle(exhaustedTrackingRevision.store);

    const corruptShallowRevision = open();
    corruptShallowRevision.db.run("PRAGMA ignore_check_constraints = ON");
    corruptShallowRevision.db.run(
      "UPDATE git_repositories SET shallow_revision = zeroblob(1) WHERE id = 1",
    );
    corruptShallowRevision.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() =>
      corruptShallowRevision.store.beginFetchPublication("refs/remotes/origin/"),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    assertMemoryCoordinatorIdle(corruptShallowRevision.store);

    const exhaustedShallowRevision = open();
    exhaustedShallowRevision.db.run(
      "UPDATE git_repositories SET shallow_revision = ? WHERE id = 1",
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => exhaustedShallowRevision.store.setShallow(["1".repeat(40)])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(exhaustedShallowRevision.store.shallow()).toEqual(new Set());
    assertMemoryCoordinatorIdle(exhaustedShallowRevision.store);
  });

  it("bounds fetch namespace count, retained inputs, and shared operation memory", () => {
    const namespaceBound = open();
    namespaceBound.db.run("UPDATE git_repositories SET fetch_generation = 1 WHERE id = 1");
    namespaceBound.db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1024
       )
       INSERT INTO git_fetch_namespaces
         (repo_id, tracking_prefix, latest_generation, revision)
       SELECT 1, 'refs/remotes/n-' || printf('%04d', id) || '/', 1, 0 FROM sequence`,
    );
    expect(() => namespaceBound.store.beginFetchPublication("refs/remotes/overflow/")).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    assertMemoryCoordinatorIdle(namespaceBound.store);

    const inputBound = open();
    const candidates = function* (): Generator<string> {
      for (let index = 0; index <= 100_000; index++) {
        yield `refs/tags/${index.toString(36)}`;
      }
    };
    expect(() =>
      inputBound.store.beginFetchPublication("refs/remotes/origin/", candidates()),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(
      inputBound.db.scalar<number>("SELECT fetch_generation FROM git_repositories WHERE id = 1"),
    ).toBe(0);
    assertMemoryCoordinatorIdle(inputBound.store);

    const memoryBound = open();
    const blocker = memoryBound.store.reserveMemory();
    blocker.set("other", MAX_REF_MUTATION_RETAINED_BYTES);
    try {
      expect(() => memoryBound.store.beginFetchPublication("refs/remotes/origin/")).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(() =>
        memoryBound.store.beginTrackingRefPublication(
          "refs/remotes/origin/",
          "refs/remotes/origin/main",
        ),
      ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(blocker.currentBytes).toBe(MAX_REF_MUTATION_RETAINED_BYTES);
    } finally {
      blocker.dispose();
    }
    assertMemoryCoordinatorIdle(memoryBound.store);
  });

  it.each(["tracking observation", "stored ref"])(
    "owns the previous long %s row at the exact ordered-scan boundary",
    (kind) => {
      const prefix = "refs/remotes/origin/";
      const long = "r".repeat(1_000_001);
      const names =
        kind === "tracking observation"
          ? [`${prefix}a${long}`, `${prefix}b${long}`]
          : [`refs/tags/a${long}`, `refs/tags/b${long}`];
      const prepare = (): ReturnType<typeof open> => {
        const opened = open();
        if (kind === "tracking observation") {
          opened.db.run(
            `INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision)
             VALUES (1, ?, 0), (1, ?, 0)`,
            names[0],
            names[1],
          );
        } else {
          opened.db.run(
            `INSERT INTO git_refs (repo_id, name, target)
             VALUES (1, ?, ?), (1, ?, ?)`,
            names[0],
            "1".repeat(40),
            names[1],
            "2".repeat(40),
          );
        }
        return opened;
      };
      const run = (opened: ReturnType<typeof open>): void => {
        const token = opened.store.beginFetchPublication(prefix);
        token.dispose();
      };
      const durableState = (opened: ReturnType<typeof open>): Record<string, unknown> => ({
        repository: opened.db.all<Record<string, unknown>>(
          "SELECT fetch_generation FROM git_repositories WHERE id = 1",
        ),
        tracking: opened.db.all<Record<string, unknown>>(
          `SELECT length(CAST(ref_name AS BLOB)) AS name_bytes, revision
             FROM git_tracking_ref_revisions WHERE repo_id = 1 ORDER BY ref_name`,
        ),
        refs: opened.db.all<Record<string, unknown>>(
          `SELECT length(CAST(name AS BLOB)) AS name_bytes, target
             FROM git_refs WHERE repo_id = 1 ORDER BY name`,
        ),
        namespaces: opened.db.all<Record<string, unknown>>(
          `SELECT tracking_prefix, latest_generation, revision
             FROM git_fetch_namespaces WHERE repo_id = 1 ORDER BY tracking_prefix`,
        ),
      });

      const measured = prepare();
      run(measured);
      const operationBytes = measured.store.shared.memory.highWaterBytes;
      expect(operationBytes).toBeGreaterThan(3 * 1024 * 1024);
      expect(operationBytes).toBeLessThan(MAX_REF_MUTATION_RETAINED_BYTES);
      assertMemoryCoordinatorIdle(measured.store);

      const externalBytes = MAX_REF_MUTATION_RETAINED_BYTES - operationBytes;
      const exact = prepare();
      const exactBlocker = exact.store.reserveMemory();
      exactBlocker.set("other", externalBytes);
      try {
        run(exact);
        expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_REF_MUTATION_RETAINED_BYTES);
        expect(exactBlocker.currentBytes).toBe(externalBytes);
      } finally {
        exactBlocker.dispose();
      }
      assertMemoryCoordinatorIdle(exact.store);

      const over = prepare();
      const before = durableState(over);
      const overBlocker = over.store.reserveMemory();
      overBlocker.set("other", externalBytes + 1);
      try {
        expect(() => run(over)).toThrowError(expect.objectContaining({ code: "E2BIG" }));
        expect(durableState(over)).toEqual(before);
        expect(overBlocker.currentBytes).toBe(externalBytes + 1);
      } finally {
        overBlocker.dispose();
      }
      assertMemoryCoordinatorIdle(over.store);
    },
  );

  it("publishes 9,329 tracking refs within the statement target", () => {
    const { db, store } = open();
    const refs = Array.from({ length: 9_329 }, (_, index) => ({
      name: `refs/remotes/origin/branch-${index.toString().padStart(4, "0")}`,
      target: index.toString(16).padStart(40, "0"),
    }));
    const token = store.beginFetchPublication("refs/remotes/origin/");

    try {
      db.storage.resetCounters();
      expect(store.publishFetchRefs(token, { trackingPuts: refs }, fetchMetadata)).toBe(true);
      expect(db.storage.statementCount).toBeLessThan(1_000);
      expect(db.scalar<number>("SELECT count(*) FROM git_refs WHERE repo_id = 1")).toBe(9_329);
      expect(store.getRef("refs/remotes/origin/branch-0000")).toBe("0".repeat(40));
      expect(store.getRef("refs/remotes/origin/branch-9328")).toBe(
        (9_328).toString(16).padStart(40, "0"),
      );
    } finally {
      token.dispose();
    }
    assertMemoryCoordinatorIdle(store);
  });

  it("publishes exact tracking state within the statement target", () => {
    const { db, store } = open();
    db.run("UPDATE git_repositories SET fetch_generation = 1 WHERE id = 1");
    db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1024
       )
       INSERT INTO git_fetch_namespaces
         (repo_id, tracking_prefix, latest_generation, revision)
       SELECT 1, 'refs/remotes/n-' || printf('%04d', id) || '/', 1, 0 FROM sequence`,
    );

    db.storage.resetCounters();
    const token = store.beginTrackingRefPublication(
      "refs/remotes/origin/",
      "refs/remotes/origin/main",
    );
    expect(db.storage.statementCount).toBeLessThan(1_000);
    try {
      db.storage.resetCounters();
      expect(store.publishTrackingRef(token, "1".repeat(40), fetchMetadata)).toBe(true);
      expect(db.storage.statementCount).toBeLessThan(1_000);
      expect(store.getRef("refs/remotes/origin/main")).toBe("1".repeat(40));
    } finally {
      token.dispose();
    }
    expect(db.scalar<number>("SELECT count(*) FROM git_fetch_namespaces WHERE repo_id = 1")).toBe(
      1_024,
    );
    assertMemoryCoordinatorIdle(store);
  });

  it("updates 9,329 refs and shallow boundaries in bounded statements", () => {
    const { db, store } = open();
    const refs = Array.from({ length: 9_329 }, (_, index) => ({
      name: `refs/remotes/origin/branch-${index.toString().padStart(4, "0")}`,
      target: index.toString(16).padStart(40, "0"),
    }));
    const oids = refs.map((ref) => ref.target);

    db.storage.resetCounters();
    store.updateRefs(refs);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(9_329);
    expect(
      db.all<{ ref_name: string; ordinal: number }>(
        `SELECT ref_name, ordinal FROM git_reflog_entries
          WHERE ordinal IN (1, 9329) ORDER BY ordinal`,
      ),
    ).toEqual([
      { ref_name: "refs/remotes/origin/branch-0000", ordinal: 1 },
      { ref_name: "refs/remotes/origin/branch-9328", ordinal: 9_329 },
    ]);
    expect(store.listRefs("refs/remotes/origin/")).toHaveLength(refs.length);

    db.storage.resetCounters();
    store.updateRefs(
      refs.slice(0, 1_000),
      refs.slice(-1_000).map((ref) => ref.name),
    );
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
      10_329,
    );
    expect(
      db.all<{ ref_name: string; ordinal: number }>(
        `SELECT ref_name, ordinal FROM git_reflog_entries
          WHERE ordinal IN (9330, 10329) ORDER BY ordinal`,
      ),
    ).toEqual([
      { ref_name: "refs/remotes/origin/branch-8329", ordinal: 9_330 },
      { ref_name: "refs/remotes/origin/branch-9328", ordinal: 10_329 },
    ]);
    expect(store.listRefs("refs/remotes/origin/")).toHaveLength(refs.length - 1_000);

    db.storage.resetCounters();
    store.setShallow(oids);
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(store.shallow().size).toBe(oids.length);

    db.storage.resetCounters();
    store.setShallow([], oids.slice(0, 1_000));
    expect(db.storage.statementCount).toBeLessThan(1_000);
    expect(store.shallow().size).toBe(oids.length - 1_000);
  });

  it("records exact direct create, no-op, delete, and checked-out HEAD transitions", () => {
    const now = 1_800_000_000;
    const { db, store } = open({ now: () => now * 1_000 });
    const oid = "a".repeat(40);

    store.setRef("refs/heads/main", oid);
    store.setRef("refs/heads/main", oid);
    expect(store.reflog("refs/heads/main")).toEqual([
      {
        refName: "refs/heads/main",
        ordinal: 1,
        oldRaw: null,
        newRaw: oid,
        oldOid: null,
        newOid: oid,
        actor: null,
        timestamp: now,
        timezoneOffset: 0,
        reason: "ref update",
      },
    ]);
    expect(store.reflog("HEAD")).toEqual([
      {
        refName: "HEAD",
        ordinal: 2,
        oldRaw: "ref: refs/heads/main",
        newRaw: "ref: refs/heads/main",
        oldOid: null,
        newOid: oid,
        actor: null,
        timestamp: now,
        timezoneOffset: 0,
        reason: "ref update",
      },
    ]);
    expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
      2,
    );

    store.deleteRef("refs/heads/main");
    expect(store.reflog("refs/heads/main")[0]).toMatchObject({
      ordinal: 3,
      oldRaw: oid,
      newRaw: null,
      oldOid: oid,
      newOid: null,
      reason: "ref delete",
    });
    expect(store.reflog("HEAD")[0]).toMatchObject({
      ordinal: 4,
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/main",
      oldOid: oid,
      newOid: null,
      reason: "ref delete",
    });
  });

  it("keeps raw identity for same-OID retargets and symbolic unresolved endpoints", () => {
    const { store } = open({ now: () => 1_800_000_000_000 });
    const oid = "a".repeat(40);
    store.setRef("refs/heads/main", oid);
    store.setRef("refs/heads/alias", oid);
    store.setRef("refs/heads/main", "ref: refs/heads/alias");

    expect(store.reflog("refs/heads/main")[0]).toMatchObject({
      oldRaw: oid,
      newRaw: "ref: refs/heads/alias",
      oldOid: oid,
      newOid: oid,
    });
    expect(store.reflog("HEAD")[0]).toMatchObject({
      ordinal: 5,
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/main",
      oldOid: oid,
      newOid: oid,
      reason: "ref update",
    });
    store.setHead("ref: refs/heads/alias");
    expect(store.reflog("HEAD")[0]).toMatchObject({
      ordinal: 6,
      oldRaw: "ref: refs/heads/main",
      newRaw: "ref: refs/heads/alias",
      oldOid: oid,
      newOid: oid,
    });

    store.setRef("refs/heads/dangling", "ref: refs/heads/missing");
    store.setRef("refs/heads/cycle-b", "ref: refs/heads/dangling");
    store.setRef("refs/heads/dangling", "ref: refs/heads/cycle-b");
    expect(store.reflog("refs/heads/dangling")[0]).toMatchObject({
      oldRaw: "ref: refs/heads/missing",
      newRaw: "ref: refs/heads/cycle-b",
      oldOid: null,
      newOid: null,
    });
  });

  it("normalizes duplicate and overlapping batches to one ordered final-state event", () => {
    const { store } = open({ now: () => 1_800_000_000_000 });
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const third = "3".repeat(40);
    store.setRef("refs/tags/x", first);

    store.updateRefs(
      [
        { name: "refs/tags/y", target: first },
        { name: "refs/tags/x", target: second },
        { name: "refs/tags/x", target: third },
      ],
      ["refs/tags/x", "refs/tags/y", "refs/tags/missing"],
    );

    expect(store.getRef("refs/tags/x")).toBe(third);
    expect(store.getRef("refs/tags/y")).toBe(first);
    expect(store.reflog("refs/tags/x")[0]).toMatchObject({
      oldRaw: first,
      newRaw: third,
      reason: "ref batch update",
    });
    expect(store.reflog("refs/tags/y")).toHaveLength(1);
  });

  it("orders mixed batch history by Git bytes and records only pre-to-final rows", () => {
    const { db, store } = open({ now: () => 1_800_000_000_000 });
    const ascii = "refs/tags/a";
    const bmp = "refs/tags/\ue000";
    const astral = "refs/tags/\u{10000}";
    store.updateRefs(
      [
        { name: astral, target: "1".repeat(40) },
        { name: bmp, target: "2".repeat(40) },
        { name: astral, target: "3".repeat(40) },
        { name: ascii, target: "4".repeat(40) },
      ],
      [astral, bmp, "refs/tags/missing"],
    );

    expect(
      db.all<{ ref_name: string; ordinal: number; old_raw: null; new_raw: string }>(
        `SELECT ref_name, ordinal, old_raw, new_raw
           FROM git_reflog_entries ORDER BY ordinal`,
      ),
    ).toEqual([
      { ref_name: ascii, ordinal: 1, old_raw: null, new_raw: "4".repeat(40) },
      { ref_name: bmp, ordinal: 2, old_raw: null, new_raw: "2".repeat(40) },
      { ref_name: astral, ordinal: 3, old_raw: null, new_raw: "3".repeat(40) },
    ]);
  });

  it("rolls back refs, history, and ordinal after a late SQL failure", () => {
    const { db, store } = open({ now: () => 1_800_000_000_000 });
    const name = "refs/tags/x";
    const before = "1".repeat(40);
    store.setRef(name, before);
    db.run(`CREATE TRIGGER fail_reflog_insert
      BEFORE INSERT ON git_reflog_entries
      WHEN NEW.ref_name = 'refs/tags/x'
      BEGIN SELECT RAISE(ABORT, 'injected reflog insert failure'); END`);
    const entries = db.scalar<number>("SELECT count(*) FROM git_reflog_entries");
    const ordinal = db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1",
    );

    expect(() => store.setRef(name, "2".repeat(40))).toThrow(/injected reflog insert failure/);
    expect(store.getRef(name)).toBe(before);
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(entries);
    expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
      ordinal,
    );
  });

  it("fails a stale CAS before changing current state, history, or ordinal", () => {
    const { db, store } = open({ now: () => 1_800_000_000_000 });
    const current = "1".repeat(40);
    store.setRef("refs/tags/x", current);
    const count = db.scalar<number>("SELECT count(*) FROM git_reflog_entries");
    const ordinal = db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1",
    );

    expect(() =>
      store.updateRefExpected("refs/tags/x", "2".repeat(40), "3".repeat(40)),
    ).toThrowError(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(store.getRef("refs/tags/x")).toBe(current);
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(count);
    expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
      ordinal,
    );
  });

  it("compares conditional mutations against an absent raw ref", () => {
    const { db, store } = open({ now: () => 1_800_000_000_000 });
    const name = "refs/tags/new";
    const first = "1".repeat(40);
    store.mutateRefs(
      { puts: [{ name, target: first }], expected: { name, target: null } },
      { actor: null, reason: "absent CAS", timestamp: 1_800_000_000, timezoneOffset: 0 },
    );
    expect(store.getRef(name)).toBe(first);
    expect(store.reflog(name)).toHaveLength(1);
    const ordinal = db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1",
    );

    expect(() =>
      store.mutateRefs(
        { puts: [{ name, target: "2".repeat(40) }], expected: { name, target: null } },
        { actor: null, reason: "stale absent CAS", timestamp: 1_800_000_000, timezoneOffset: 0 },
      ),
    ).toThrowError(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(store.getRef(name)).toBe(first);
    expect(store.reflog(name)).toHaveLength(1);
    expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
      ordinal,
    );
  });

  it("conditionally deletes one ref and rejects stale or ambiguous destinations atomically", () => {
    const { db, store } = open({ now: () => 1_800_000_000_000 });
    const name = "refs/tags/x";
    const current = "1".repeat(40);
    const metadata = {
      actor: null,
      reason: "conditional delete",
      timestamp: 1_800_000_000,
      timezoneOffset: 0,
    };
    store.setRef(name, current);

    store.mutateRefs({ deletes: [name], expected: { name, target: current } }, metadata);
    expect(store.getRef(name)).toBeNull();
    expect(store.reflog(name)[0]).toMatchObject({ oldRaw: current, newRaw: null });

    store.setRef(name, current);
    const count = db.scalar<number>("SELECT count(*) FROM git_reflog_entries");
    const ordinal = db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1",
    );
    expect(() =>
      store.mutateRefs({ deletes: [name], expected: { name, target: "2".repeat(40) } }, metadata),
    ).toThrowError(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(() =>
      store.mutateRefs(
        {
          puts: [{ name, target: "3".repeat(40) }],
          deletes: [name],
          expected: { name, target: current },
        },
        metadata,
      ),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      store.mutateRefs(
        { deletes: ["refs/tags/other"], expected: { name, target: current } },
        metadata,
      ),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(store.getRef(name)).toBe(current);
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(count);
    expect(db.scalar<number>("SELECT next_ordinal FROM git_reflog_state WHERE repo_id = 1")).toBe(
      ordinal,
    );
  });

  it("rejects corrupt old/new endpoints, identity, and ordinal shapes on reads", () => {
    const corruptions = [
      "old_oid = NULL",
      `old_oid = '${"3".repeat(40)}'`,
      `old_oid = '${"A".repeat(40)}'`,
      "new_oid = NULL",
      `new_oid = '${"3".repeat(40)}'`,
      `new_oid = '${"B".repeat(40)}'`,
      "old_raw = NULL, old_oid = '1111111111111111111111111111111111111111'",
      "new_raw = NULL, new_oid = '2222222222222222222222222222222222222222'",
      "actor_name = zeroblob(1), actor_email = 'actor@example.com'",
      "actor_name = 'Actor', actor_email = NULL",
      "ordinal = 0",
      "reason = zeroblob(1)",
    ];
    for (const corruption of corruptions) {
      const { db, store } = open({ now: () => 1_800_000_000_000 });
      store.setRef("refs/tags/x", "1".repeat(40));
      store.setRef("refs/tags/x", "2".repeat(40));
      db.run("PRAGMA ignore_check_constraints = ON");
      db.run(
        `UPDATE git_reflog_entries SET ${corruption}
          WHERE ref_name = 'refs/tags/x' AND ordinal = 2`,
      );
      db.run("PRAGMA ignore_check_constraints = OFF");

      expect(() => store.reflog("refs/tags/x"), corruption).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
  });

  it("rejects malformed symbolic raw shapes at both DDL endpoints", () => {
    const { db } = open();
    const direct = "1".repeat(40);
    const malformed = [
      "ref: ",
      "ref: HEAD",
      "ref: ref: refs/heads/main",
      "ref: refs/heads/main\0suffix",
      "ref: refs/heads/main\n",
      "ref: refs/heads/main\r",
    ];
    for (const raw of malformed) {
      for (const endpoint of ["old", "new"]) {
        const oldRaw = endpoint === "old" ? raw : direct;
        const newRaw = endpoint === "new" ? raw : direct;
        const oldOid = endpoint === "old" ? null : direct;
        const newOid = endpoint === "new" ? null : direct;
        expect(
          () =>
            db.run(
              `INSERT INTO git_reflog_entries
                 (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
                  actor_name, actor_email, timestamp, timezone, reason)
               VALUES (1, 'refs/tags/x', 1, ?, ?, ?, ?, NULL, NULL, 0, 0, 'constraint')`,
              oldRaw,
              newRaw,
              oldOid,
              newOid,
            ),
          `${endpoint}: ${JSON.stringify(raw)}`,
        ).toThrow();
      }
    }
    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(0);
  });

  it("rejects corrupt reflog allocation state before mutating refs", () => {
    const corruptions = ["next_ordinal = zeroblob(1)", "next_ordinal = -1", "next_ordinal = 0"];
    for (const corruption of corruptions) {
      const { db, store } = open({ now: () => 1_800_000_000_000 });
      store.setRef("refs/tags/x", "1".repeat(40));
      db.run("PRAGMA ignore_check_constraints = ON");
      db.run(`UPDATE git_reflog_state SET ${corruption} WHERE repo_id = 1`);
      db.run("PRAGMA ignore_check_constraints = OFF");

      expect(() => store.setRef("refs/tags/y", "2".repeat(40)), corruption).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(store.getRef("refs/tags/y")).toBeNull();
      expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(1);
    }
  });

  it("admits the measured ref aggregate exactly and rejects one external byte more", () => {
    const target = "1".repeat(40);
    const prefix = "refs/tags/";
    const suffixBytes = 6;
    const baseNameBytes = prefix.length + suffixBytes;
    const nameBytes = 1_025;
    const count = 8_192;
    const name = (index: number): string =>
      `${prefix}${index.toString(36).padStart(suffixBytes, "0")}${"x".repeat(nameBytes - baseNameBytes)}`;
    const puts = function* (): Generator<{ name: string; target: string }> {
      for (let index = 0; index < count; index++) yield { name: name(index), target };
    };
    expect(name(0)).toHaveLength(nameBytes);

    const measured = open({ now: () => 1_800_000_000_000 });
    assertMemoryCoordinatorIdle(measured.store);
    measured.db.storage.resetCounters();
    measured.store.updateRefs(puts());
    const measuredHighWater = measured.store.shared.memory.highWaterBytes;
    expect(measuredHighWater).toBeGreaterThan(32 * 1024 * 1024);
    expect(measuredHighWater).toBeLessThan(MAX_REF_MUTATION_RETAINED_BYTES);
    expect(measured.db.storage.statementCount).toBeLessThan(1_000);
    expect(measured.db.scalar<number>("SELECT count(*) FROM git_refs")).toBe(count);
    expect(measured.db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(count);
    expect(measured.store.getRef(name(0))).toBe(target);
    expect(measured.store.getRef(name(count - 1))).toBe(target);
    assertMemoryCoordinatorIdle(measured.store);

    const exact = open({ now: () => 1_800_000_000_000 });
    const exactBlocker = exact.store.reserveMemory();
    const externalBytes = MAX_REF_MUTATION_RETAINED_BYTES - measuredHighWater;
    exactBlocker.set("other", externalBytes);
    exact.db.storage.resetCounters();
    try {
      exact.store.updateRefs(puts());
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_REF_MUTATION_RETAINED_BYTES);
      expect(exact.db.storage.statementCount).toBeLessThan(1_000);
      expect(exact.db.scalar<number>("SELECT count(*) FROM git_refs")).toBe(count);
      expect(exact.db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(count);
      expect(exact.store.getRef(name(0))).toBe(target);
      expect(exact.store.getRef(name(count - 1))).toBe(target);
      expect(exactBlocker.currentBytes).toBe(externalBytes);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const over = open({ now: () => 1_800_000_000_000 });
    const overBlocker = over.store.reserveMemory();
    overBlocker.set("other", externalBytes + 1);
    over.db.storage.resetCounters();
    try {
      expect(() => over.store.updateRefs(puts())).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(over.db.storage.statementCount).toBeLessThan(1_000);
      expect(over.db.scalar<number>("SELECT count(*) FROM git_refs")).toBe(0);
      expect(over.db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(0);
      expect(overBlocker.currentBytes).toBe(externalBytes + 1);
    } finally {
      overBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(over.store);
  });

  it("retains only the newest 1,024 entries per ref", () => {
    const now = 1_800_000_000;
    const { db, store } = open({ now: () => now * 1_000 });
    for (let index = 0; index < 1_025; index++) {
      store.mutateRefs(
        { puts: [{ name: "refs/tags/x", target: (index % 2 === 0 ? "1" : "2").repeat(40) }] },
        { actor: null, reason: "retention witness", timestamp: now, timezoneOffset: 0 },
      );
    }

    expect(db.scalar<number>("SELECT count(*) FROM git_reflog_entries")).toBe(1_024);
    const entries = store.reflog("refs/tags/x");
    expect(entries).toHaveLength(1_024);
    expect(entries.at(-1)?.ordinal).toBe(2);
  });

  it("keeps the exact 90-day boundary and removes one second older", () => {
    const now = 2_000_000_000;
    const cutoff = now - 90 * 24 * 60 * 60;
    const { db, store } = open({ now: () => now * 1_000 });
    store.mutateRefs(
      { puts: [{ name: "refs/tags/x", target: "1".repeat(40) }] },
      { actor: null, reason: "too old", timestamp: cutoff - 1, timezoneOffset: 0 },
    );
    store.mutateRefs(
      { puts: [{ name: "refs/tags/x", target: "2".repeat(40) }] },
      { actor: null, reason: "boundary", timestamp: cutoff, timezoneOffset: 0 },
    );
    store.mutateRefs(
      { puts: [{ name: "refs/tags/x", target: "3".repeat(40) }] },
      { actor: null, reason: "current", timestamp: now, timezoneOffset: 0 },
    );

    expect(store.reflog("refs/tags/x").map((entry) => entry.reason)).toEqual([
      "current",
      "boundary",
    ]);
    expect(
      db.all<{ timestamp: number; reason: string }>(
        "SELECT timestamp, reason FROM git_reflog_entries ORDER BY ordinal",
      ),
    ).toEqual([
      { timestamp: cutoff, reason: "boundary" },
      { timestamp: now, reason: "current" },
    ]);
  });

  it("keeps multi-valued config in order", () => {
    const { store } = open();
    store.configSet("user.email", "a@example.com");
    store.configAdd("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    store.configAdd("remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    expect(store.configGet("user.email")).toBe("a@example.com");
    expect(store.configGetAll("remote.origin.fetch")).toHaveLength(2);
    expect(store.configPaths("remote.")).toEqual(["remote.origin.fetch"]);
    store.configUnset("user.email");
    expect(store.configGet("user.email")).toBeUndefined();
  });

  it("reads one config value at the exact byte bound and rejects one byte more", () => {
    const path = "remote.origin.url";
    const exact = open();
    exact.store.configSet(path, "x".repeat(8_192));
    exact.db.storage.resetCounters();
    expect(exact.store.configGetSingleBounded(path, 8_192)).toEqual({
      kind: "single",
      value: "x".repeat(8_192),
    });
    expect(exact.db.storage.statementCount).toBeLessThan(1_000);

    const over = open();
    over.store.configSet(path, "x".repeat(8_193));
    over.db.storage.resetCounters();
    expect(() => over.store.configGetSingleBounded(path, 8_192)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(over.db.storage.statementCount).toBeLessThan(1_000);
  });

  it("retains an owned config value and refuses one byte before reading its payload", () => {
    const path = "user.name";
    const value = "v".repeat(8_192);
    const valueBytes = utf8.encode(value).byteLength;
    const retainedValueBytes = 256 + 8 + retainedStringBytes(value);
    const operationBytes = retainedValueBytes + 512 + 2 * valueBytes;
    const setup = open();
    setup.store.configSet(path, value);

    const exactDb = new TestDatabase(setup.db.storage);
    const exactDatabase = new SqliteGitDatabase(exactDb);
    const exactCheckout = exactDatabase.checkoutAt("/repo");
    if (exactCheckout === null) throw new Error("owned config checkout is missing");
    const exactStore = exactDatabase.openCheckout(exactCheckout);
    const exactBlocker = exactStore.shared.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    const exactOwner = createRefMutationMemoryOwner(exactStore.shared);
    exactDb.storage.histogram = new Map();
    exactDb.storage.resetCounters();
    try {
      expect(configGetOwned(exactStore.shared, path, exactOwner)).toBe(value);
      expect(exactOwner.memoryReservation().currentBytes).toBe(retainedValueBytes);
      expect(exactOwner.owns(value)).toBe(true);
      expect(exactStore.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
      expect(exactDb.storage.statementCount).toBe(2);
    } finally {
      exactOwner.dispose();
      exactBlocker.dispose();
    }
    exactStore.shared.memory.assertIdle();

    const overDb = new TestDatabase(setup.db.storage);
    const overDatabase = new SqliteGitDatabase(overDb);
    const overCheckout = overDatabase.checkoutAt("/repo");
    if (overCheckout === null) throw new Error("owned config checkout is missing");
    const overStore = overDatabase.openCheckout(overCheckout);
    const overBlocker = overStore.shared.reserveMemory();
    overBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    const overOwner = createRefMutationMemoryOwner(overStore.shared);
    overDb.storage.histogram = new Map();
    overDb.storage.resetCounters();
    try {
      expect(() => configGetOwned(overStore.shared, path, overOwner)).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(overOwner.memoryReservation().currentBytes).toBe(256);
      expect(overDb.storage.statementCount).toBe(1);
    } finally {
      overOwner.dispose();
      overBlocker.dispose();
    }
    overStore.shared.memory.assertIdle();
  });

  it("detects a multi-valued config key after inspecting only two metadata rows", () => {
    const { db, store } = open();
    const path = "remote.origin.url";
    store.configAdd(path, "one");
    store.configAdd(path, "two");
    store.configAdd(path, "three");

    db.storage.resetCounters();
    expect(store.configGetSingleBounded(path, 8_192)).toEqual({ kind: "multiple" });
    expect(db.storage.statementCount).toBeLessThan(1_000);
  });

  it("rejects corrupt config value types and non-canonical UTF-8", () => {
    const path = "remote.origin.url";
    const blobValue = open();
    blobValue.store.configSet(path, "old");
    blobValue.db.run(
      "UPDATE git_config SET value = zeroblob(4) WHERE repo_id = 1 AND path = ?",
      path,
    );
    blobValue.db.storage.resetCounters();
    expect(() => blobValue.store.configGetSingleBounded(path, 8_192)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(blobValue.db.storage.statementCount).toBeLessThan(1_000);

    const invalidUtf8 = open();
    invalidUtf8.store.configSet(path, "old");
    invalidUtf8.db.run(
      "UPDATE git_config SET value = CAST(x'f09080' AS TEXT) WHERE repo_id = 1 AND path = ?",
      path,
    );
    expect(() => invalidUtf8.store.configGetSingleBounded(path, 8_192)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("moves an exact config section while preserving paths and sequences", () => {
    const { db, store } = open();
    store.configAdd("branch.old.merge", "refs/heads/main");
    store.configAdd("branch.old.remote", "first");
    store.configAdd("branch.old.remote", "second");
    store.configSet("branch.old.child.remote", "dotted sibling");
    store.configSet("branch.older.remote", "untouched");

    store.configMoveSection("branch.old.", "branch.new.");

    expect(store.configPaths("branch.old.")).toEqual(["branch.old.child.remote"]);
    expect(store.configGetAll("branch.new.remote")).toEqual(["first", "second"]);
    expect(
      db.all<{ path: string; seq: number; value: string }>(
        "SELECT path, seq, value FROM git_config WHERE repo_id = 1 ORDER BY path, seq",
      ),
    ).toEqual([
      { path: "branch.new.merge", seq: 0, value: "refs/heads/main" },
      { path: "branch.new.remote", seq: 0, value: "first" },
      { path: "branch.new.remote", seq: 1, value: "second" },
      { path: "branch.old.child.remote", seq: 0, value: "dotted sibling" },
      { path: "branch.older.remote", seq: 0, value: "untouched" },
    ]);
  });

  it("moves a config section beside a dotted destination sibling without absorbing it", () => {
    const { store } = open();
    store.configSet("branch.old.remote", "origin");
    store.configSet("branch.new.child.remote", "sibling");

    store.configMoveSection("branch.old.", "branch.new.");

    expect(store.configGet("branch.new.remote")).toBe("origin");
    expect(store.configGet("branch.new.child.remote")).toBe("sibling");
  });

  it("refuses a config section destination before changing the source", () => {
    const { store } = open();
    store.configSet("branch.old.remote", "origin");
    store.configSet("branch.new.merge", "refs/heads/main");

    expect(() => store.configMoveSection("branch.old.", "branch.new.")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(store.configGet("branch.old.remote")).toBe("origin");
    expect(store.configGet("branch.new.merge")).toBe("refs/heads/main");
  });

  it("detects exact config section destinations in both dotted rename directions", () => {
    const intoDotted = open();
    intoDotted.store.configSet("branch.foo.remote", "source");
    intoDotted.store.configSet("branch.foo.bar.remote", "destination");
    expect(() => intoDotted.store.configMoveSection("branch.foo.", "branch.foo.bar.")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(intoDotted.store.configGet("branch.foo.remote")).toBe("source");
    expect(intoDotted.store.configGet("branch.foo.bar.remote")).toBe("destination");

    const fromDotted = open();
    fromDotted.store.configSet("branch.foo.bar.remote", "source");
    fromDotted.store.configSet("branch.foo.remote", "destination");
    expect(() => fromDotted.store.configMoveSection("branch.foo.bar.", "branch.foo.")).toThrowError(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(fromDotted.store.configGet("branch.foo.bar.remote")).toBe("source");
    expect(fromDotted.store.configGet("branch.foo.remote")).toBe("destination");
  });

  it("bounds inspected config section candidates but ignores unrelated sparse config", () => {
    const crowded = open();
    crowded.store.configSet("branch.old.remote", "origin");
    for (let index = 0; index < MAX_CONFIG_SECTION_MOVE_ROWS; index++) {
      crowded.store.configSet(
        `branch.old.child-${index.toString().padStart(4, "0")}.remote`,
        "sibling",
      );
    }
    expect(() => crowded.store.configMoveSection("branch.old.", "branch.new.")).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(crowded.store.configGet("branch.old.remote")).toBe("origin");
    expect(crowded.store.configGet("branch.new.remote")).toBeUndefined();

    const sparse = open();
    sparse.store.configSet("branch.old.remote", "origin");
    for (let index = 0; index <= MAX_CONFIG_SECTION_MOVE_ROWS; index++) {
      sparse.store.configSet(`remote.unrelated-${index.toString().padStart(4, "0")}.url`, "x");
    }
    const mutationPlan = sparse.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${CONFIG_SECTION_MOVE_UPDATE_SQL}`,
      "branch.new.",
      "branch.old.",
      1,
      "branch.old.",
      "branch.old/",
      JSON.stringify([{ path: "branch.old.remote", seq: 0 }]),
    );
    expect(mutationPlan.map((row) => row.detail)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /SEARCH git_config USING .*\(repo_id=\? AND path>[?]? AND path<[?]?\)/,
        ),
      ]),
    );
    sparse.db.storage.resetCounters();
    sparse.store.configMoveSection("branch.old.", "branch.new.");
    expect(sparse.db.storage.statementCount).toBeLessThan(1_000);
    expect(sparse.store.configGet("branch.new.remote")).toBe("origin");
  });

  it("rejects invalid config section inputs before issuing SQL", () => {
    const { db, store } = open();
    const calls: readonly (readonly unknown[])[] = [
      [42, "branch.new."],
      ["branch.old.", null],
      ["branch.old", "branch.new."],
      ["branch..old.", "branch.new."],
      ["branch.\ud800.", "branch.new."],
      [`${"x".repeat(MAX_INDEX_PATH_BYTES + 1)}.`, "branch.new."],
    ];
    for (const args of calls) {
      db.storage.resetCounters();
      expect(() => Reflect.apply(store.configMoveSection, store, args)).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^(EINVAL|E2BIG)$/) }),
      );
      expect(db.storage.statementCount).toBe(0);
    }
  });

  it("accepts the exact config section row bound and rejects one more", () => {
    const exact = open();
    for (let index = 0; index < MAX_CONFIG_SECTION_MOVE_ROWS; index++) {
      exact.store.configSet(`branch.old.key-${index.toString().padStart(4, "0")}`, "x");
    }
    exact.db.storage.resetCounters();
    exact.store.configMoveSection("branch.old.", "branch.new.");
    expect(exact.db.storage.statementCount).toBeLessThan(1_000);
    expect(exact.store.configPaths("branch.new.")).toHaveLength(MAX_CONFIG_SECTION_MOVE_ROWS);

    const over = open();
    for (let index = 0; index <= MAX_CONFIG_SECTION_MOVE_ROWS; index++) {
      over.store.configSet(`branch.old.key-${index.toString().padStart(4, "0")}`, "x");
    }
    expect(() => over.store.configMoveSection("branch.old.", "branch.new.")).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(over.store.configPaths("branch.old.")).toHaveLength(MAX_CONFIG_SECTION_MOVE_ROWS + 1);
    expect(over.store.configPaths("branch.new.")).toEqual([]);
  });

  it("pre-admits the bounded config path row before opening its cursor", () => {
    const prepare = (): ReturnType<typeof open> => {
      const opened = open();
      opened.store.configSet("branch.new.remote", "origin");
      return opened;
    };
    const run = (opened: ReturnType<typeof open>): void => {
      opened.store.configMoveSection("branch.old.", "branch.new.");
    };

    const measured = prepare();
    measured.db.storage.resetCounters();
    expect(() => run(measured)).toThrowError(expect.objectContaining({ code: "EEXIST" }));
    const operationBytes = measured.store.shared.memory.highWaterBytes;
    expect(measured.db.storage.statementCount).toBe(1);
    assertMemoryCoordinatorIdle(measured.store);

    const exact = prepare();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    try {
      exact.db.storage.resetCounters();
      expect(() => run(exact)).toThrowError(expect.objectContaining({ code: "EEXIST" }));
      expect(exact.db.storage.statementCount).toBe(1);
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const excess = prepare();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    try {
      excess.db.storage.resetCounters();
      expect(() => run(excess)).toThrowError(expect.objectContaining({ code: "E2BIG" }));
      expect(excess.db.storage.statementCount).toBe(0);
    } finally {
      excessBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(excess.store);
  });

  it("streams config values above the former text cap with exact owner cleanup", () => {
    const path = "branch.old.remote";
    const value = "x".repeat(1_100_000);
    const prepare = (): ReturnType<typeof open> => {
      const opened = open();
      opened.store.configSet(path, value);
      return opened;
    };

    const measured = prepare();
    measured.store.configMoveSection("branch.old.", "branch.new.");
    expect(measured.store.configGet("branch.new.remote")).toBe(value);
    const operationBytes = measured.store.shared.memory.highWaterBytes;
    assertMemoryCoordinatorIdle(measured.store);

    const exact = prepare();
    const exactBlocker = exact.store.reserveMemory();
    exactBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes);
    try {
      exact.store.configMoveSection("branch.old.", "branch.new.");
      expect(exact.store.shared.memory.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
      expect(exact.store.configGet("branch.new.remote")).toBe(value);
    } finally {
      exactBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(exact.store);

    const excess = prepare();
    const excessBlocker = excess.store.reserveMemory();
    excessBlocker.set("other", MAX_OPERATION_MEMORY_BYTES - operationBytes + 1);
    try {
      expect(() => excess.store.configMoveSection("branch.old.", "branch.new.")).toThrowError(
        expect.objectContaining({ code: "E2BIG" }),
      );
      expect(excess.store.configGet(path)).toBe(value);
      expect(excess.store.configGet("branch.new.remote")).toBeUndefined();
    } finally {
      excessBlocker.dispose();
    }
    assertMemoryCoordinatorIdle(excess.store);
  });

  it("rejects corrupt config section rows before mutation", () => {
    const corruptValue = open();
    corruptValue.store.configSet("branch.old.remote", "origin");
    corruptValue.db.run(
      "UPDATE git_config SET value = zeroblob(4) WHERE repo_id = 1 AND path = 'branch.old.remote'",
    );
    expect(() => corruptValue.store.configMoveSection("branch.old.", "branch.new.")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(corruptValue.db.scalar<number>("SELECT count(*) FROM git_config")).toBe(1);

    const corruptSequence = open();
    corruptSequence.store.configSet("branch.old.remote", "origin");
    corruptSequence.db.run(
      "UPDATE git_config SET seq = 0.5 WHERE repo_id = 1 AND path = 'branch.old.remote'",
    );
    expect(() =>
      corruptSequence.store.configMoveSection("branch.old.", "branch.new."),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(corruptSequence.db.scalar<number>("SELECT count(*) FROM git_config")).toBe(1);

    const emptyVariable = open();
    emptyVariable.store.configSet("branch.old.", "invalid");
    expect(() => emptyVariable.store.configMoveSection("branch.old.", "branch.new.")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(emptyVariable.db.scalar<number>("SELECT count(*) FROM git_config")).toBe(1);

    const invalidValueUtf8 = open();
    invalidValueUtf8.store.configSet("branch.old.remote", "old");
    invalidValueUtf8.db.run(
      `UPDATE git_config SET value = CAST(x'f09080' AS TEXT)
        WHERE repo_id = 1 AND path = 'branch.old.remote'`,
    );
    expect(() =>
      invalidValueUtf8.store.configMoveSection("branch.old.", "branch.new."),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(invalidValueUtf8.db.scalar<number>("SELECT count(*) FROM git_config")).toBe(1);

    const invalidPathUtf8 = open();
    invalidPathUtf8.store.configSet("branch.old.remote", "origin");
    invalidPathUtf8.db.run(
      `UPDATE git_config SET path = CAST(x'6272616e63682e6f6c642ef09080' AS TEXT)
        WHERE repo_id = 1 AND path = 'branch.old.remote'`,
    );
    expect(() =>
      invalidPathUtf8.store.configMoveSection("branch.old.", "branch.new."),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(invalidPathUtf8.db.scalar<number>("SELECT count(*) FROM git_config")).toBe(1);

    const forbiddenVariable = open();
    const nulPath = "branch.old.bad\0name";
    forbiddenVariable.store.configSet(nulPath, "origin");
    expect(() =>
      forbiddenVariable.store.configMoveSection("branch.old.", "branch.new."),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(forbiddenVariable.store.configGet(nulPath)).toBe("origin");
    expect(forbiddenVariable.store.configPaths("branch.new.")).toEqual([]);
  });

  it("keeps a config section move in the caller's transaction rollback", () => {
    const { db, store } = open();
    store.configSet("branch.old.remote", "origin");

    expect(() =>
      db.transactionSync(() => {
        store.configMoveSection("branch.old.", "branch.new.");
        throw new Error("injected failure");
      }),
    ).toThrow(/injected failure/);
    expect(store.configGet("branch.old.remote")).toBe("origin");
    expect(store.configGet("branch.new.remote")).toBeUndefined();
  });

  it("keys the index by path and stage", () => {
    const { store } = open();
    store.indexPut({
      path: "src/a.ts",
      stage: 0,
      mode: 0o100644,
      oid: "a".repeat(40),
      size: 12,
      mtime: 5,
      ino: 7,
    });
    expect(store.indexGet("src/a.ts")?.oid).toBe("a".repeat(40));
    expect(store.hasConflicts()).toBe(false);
    store.indexPut({
      path: "src/a.ts",
      stage: 2,
      mode: 0o100644,
      oid: "b".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    expect(store.hasConflicts()).toBe(true);
    expect(store.indexEntries()).toHaveLength(2);
    store.indexRemove("src/a.ts");
    expect(store.indexEntries()).toHaveLength(0);
  });
});
