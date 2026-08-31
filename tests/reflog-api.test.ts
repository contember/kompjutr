import { describe, expect, it } from "vitest";

import { recoverRef } from "../src/core/ops/ref-log.js";
import { Repository } from "../src/core/repository.js";
import { createGit, type Git, type GitRecoverRefOptions } from "../src/git/client.js";
import {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
  type SqlDatabase,
} from "../src/sqlite/db.js";
import {
  MAX_REFLOG_ROOT_SCAN_BYTES,
  MAX_REFLOG_ROOT_SCAN_ENTRIES,
  type RefLogMetadata,
  SqliteGitDatabase,
} from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const NOW_SECONDS = 1_800_000_000;
const NOW_MILLISECONDS = NOW_SECONDS * 1_000;
const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const ACTOR = { name: "Recovery Actor", email: "recovery@example.com" };
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const THIRD = "3".repeat(40);

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

function durableRefMutationState(db: TestDatabase) {
  return {
    refs: db.all<Record<string, unknown>>(
      "SELECT repo_id, name, target FROM git_refs ORDER BY repo_id, name",
    ),
    checkouts: db.all<Record<string, unknown>>(
      "SELECT id, repo_id, head FROM git_checkouts ORDER BY id",
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
    revisions: db.all<Record<string, unknown>>(
      "SELECT id, checkout_revision FROM git_repositories ORDER BY id",
    ),
    roots: db.all<Record<string, unknown>>(
      "SELECT repo_id, root_epoch FROM git_maintenance_control ORDER BY repo_id",
    ),
  };
}

function bindGit(workspace: TestRepository, database = workspace.database): Git {
  return createGit()({
    database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: ACTOR,
  });
}

function metadata(reason: string, timestamp = NOW_SECONDS): RefLogMetadata {
  return { actor: null, reason, timestamp, timezoneOffset: 0 };
}

function seedRefLog(
  db: SqlDatabase,
  repoId: number,
  ref: string,
  count: number,
  timestamp = NOW_SECONDS,
): void {
  db.transactionSync(() => {
    db.run("DELETE FROM git_reflog_entries WHERE repo_id = ?", repoId);
    db.run("DELETE FROM git_checkout_reflog_entries WHERE repo_id = ?", repoId);
    db.run("UPDATE git_reflog_state SET next_ordinal = 0 WHERE repo_id = ?", repoId);
    if (count === 0) return;
    const sequence = `WITH RECURSIVE sequence(ordinal) AS (
         VALUES (1)
         UNION ALL
         SELECT ordinal + 1 FROM sequence WHERE ordinal < ?
       )`;
    const endpoints = `SELECT ordinal,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END AS old_raw,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END AS new_raw,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END AS old_oid,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END AS new_oid,
              ? - (ordinal % 3) AS timestamp
         FROM sequence`;
    if (ref === "HEAD") {
      const checkoutId = db.scalar<unknown>(
        "SELECT id FROM git_checkouts WHERE repo_id = ? AND is_primary = 1",
        repoId,
      );
      if (typeof checkoutId !== "number" || !Number.isSafeInteger(checkoutId) || checkoutId < 1) {
        throw new Error("seed checkout is missing");
      }
      db.run(
        `${sequence}
       INSERT INTO git_checkout_reflog_entries
         (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       SELECT ?, ?, ordinal, old_raw, new_raw, old_oid, new_oid,
              NULL, NULL, timestamp, 0, 'seed-' || ordinal
         FROM (${endpoints})`,
        count,
        checkoutId,
        repoId,
        FIRST,
        SECOND,
        SECOND,
        FIRST,
        FIRST,
        SECOND,
        SECOND,
        FIRST,
        timestamp,
      );
    } else {
      db.run(
        `${sequence}
       INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       SELECT ?, ?, ordinal, old_raw, new_raw, old_oid, new_oid,
              NULL, NULL, timestamp, 0, 'seed-' || ordinal
         FROM (${endpoints})`,
        count,
        repoId,
        ref,
        FIRST,
        SECOND,
        SECOND,
        FIRST,
        FIRST,
        SECOND,
        SECOND,
        FIRST,
        timestamp,
      );
    }
    db.run("UPDATE git_reflog_state SET next_ordinal = ? WHERE repo_id = ?", count, repoId);
  });
}

function appendRefLog(db: SqlDatabase, repoId: number, ref: string, ordinal: number): void {
  db.transactionSync(() => {
    if (ref === "HEAD") {
      const checkoutId = db.scalar<unknown>(
        "SELECT id FROM git_checkouts WHERE repo_id = ? AND is_primary = 1",
        repoId,
      );
      if (typeof checkoutId !== "number" || !Number.isSafeInteger(checkoutId) || checkoutId < 1) {
        throw new Error("append checkout is missing");
      }
      db.run(
        `INSERT INTO git_checkout_reflog_entries
         (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, 'append')`,
        checkoutId,
        repoId,
        ordinal,
        FIRST,
        THIRD,
        FIRST,
        THIRD,
        NOW_SECONDS,
      );
    } else {
      db.run(
        `INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, 'append')`,
        repoId,
        ref,
        ordinal,
        FIRST,
        THIRD,
        FIRST,
        THIRD,
        NOW_SECONDS,
      );
    }
    db.run("UPDATE git_reflog_state SET next_ordinal = ? WHERE repo_id = ?", ordinal, repoId);
  });
}

function seedCombinedActiveRefLogs(
  db: SqlDatabase,
  repoId: number,
  checkoutIds: readonly number[],
  checkoutRows: number,
  directRows: number,
): readonly string[] {
  const checkoutEndpoints: string[] = [];
  db.transactionSync(() => {
    db.run("DELETE FROM git_reflog_entries WHERE repo_id = ?", repoId);
    db.run("DELETE FROM git_checkout_reflog_entries WHERE repo_id = ?", repoId);
    db.run("UPDATE git_reflog_state SET next_ordinal = 0 WHERE repo_id = ?", repoId);
    let allocated = 0;
    for (let index = 0; index < checkoutIds.length; index++) {
      const checkoutId = checkoutIds[index];
      if (checkoutId === undefined) throw new Error("combined seed checkout is missing");
      const oldOid = (0x1_000 + index * 2).toString(16).padStart(40, "0");
      const newOid = (0x1_001 + index * 2).toString(16).padStart(40, "0");
      checkoutEndpoints.push(oldOid, newOid);
      db.run(
        `WITH RECURSIVE sequence(offset) AS (
           VALUES (1)
           UNION ALL
           SELECT offset + 1 FROM sequence WHERE offset < ?
         )
         INSERT INTO git_checkout_reflog_entries
           (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         SELECT ?, ?, ? + offset, ?, ?, ?, ?, NULL, NULL, ?, 0,
                'combined-checkout-' || offset
           FROM sequence`,
        checkoutRows,
        checkoutId,
        repoId,
        allocated,
        oldOid,
        newOid,
        oldOid,
        newOid,
        NOW_SECONDS,
      );
      allocated += checkoutRows;
    }
    if (directRows > 0) {
      db.run(
        `WITH RECURSIVE sequence(offset) AS (
           VALUES (1)
           UNION ALL
           SELECT offset + 1 FROM sequence WHERE offset < ?
         )
         INSERT INTO git_reflog_entries
           (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         SELECT ?, 'refs/tags/combined-' || printf('%04d', offset), ? + offset,
                ?, ?, ?, ?, NULL, NULL, ?, 0, 'combined-direct-' || offset
           FROM sequence`,
        directRows,
        repoId,
        allocated,
        FIRST,
        SECOND,
        FIRST,
        SECOND,
        NOW_SECONDS,
      );
      allocated += directRows;
    }
    db.run("UPDATE git_reflog_state SET next_ordinal = ? WHERE repo_id = ?", allocated, repoId);
  });
  return Object.freeze(checkoutEndpoints);
}

class GuardedDatabase implements SqlDatabase {
  readonly inner = new TestDatabase();
  iterateCalls = 0;
  closedIterators = 0;
  forbidAll = false;
  rootScanRows = 0;
  rootScanTextBytes: number | null = null;
  rootScanMaxRowBytes = 0;
  rootScanHeadBytes = 1;

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    if (this.forbidAll) throw new Error("db.all is forbidden during the root stream");
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    if (
      this.rootScanTextBytes !== null &&
      query.includes("direct.rows + local.rows AS rows") &&
      query.includes("AS max_row_bytes")
    ) {
      return this.inner.one<Row>(
        "SELECT ? AS rows, ? AS text_bytes, ? AS max_row_bytes, ? AS head_bytes",
        this.rootScanRows,
        this.rootScanTextBytes,
        this.rootScanMaxRowBytes,
        this.rootScanHeadBytes,
      );
    }
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.iterateCalls++;
    const source = this.inner.iterate(query, ...bindings);
    const owner = this;
    return (function* (): Generator<Record<string, unknown>> {
      try {
        yield* source;
      } finally {
        owner.closedIterators++;
      }
    })();
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

describe("public reflog listing", () => {
  it("round-trips former ref, target, identity, and reason first excesses", () => {
    const workspace = makeRepo("/");
    const ref = `refs/tags/${"r".repeat(1_015)}`;
    const rawTarget = `ref: refs/heads/${"t".repeat(1_009)}`;
    const actor = { name: "n".repeat(1_025), email: "e".repeat(1_025) };
    const longMetadata = {
      actor,
      reason: "reason-".padEnd(257, "r"),
      timestamp: NOW_SECONDS,
      timezoneOffset: 0,
    };
    expect(ref).toHaveLength(1_025);
    expect(rawTarget).toHaveLength(1_025);
    expect(longMetadata.reason).toHaveLength(257);

    expect(
      workspace.repo.store.mutateRefs({ puts: [{ name: ref, target: rawTarget }] }, longMetadata),
    ).toBe(true);
    expect(workspace.repo.store.getRef(ref)).toBe(rawTarget);
    const entries = workspace.repo.store.reflog(ref);
    expect(entries).toEqual([
      expect.objectContaining({
        refName: ref,
        oldRaw: null,
        newRaw: rawTarget,
        actor,
        reason: longMetadata.reason,
      }),
    ]);

    const reopenedDatabase = new SqliteGitDatabase(new TestDatabase(workspace.storage));
    const reopenedCheckout = reopenedDatabase.checkoutAt("/");
    if (reopenedCheckout === null) throw new Error("reopened checkout is missing");
    const reopened = reopenedDatabase.openCheckout(reopenedCheckout);
    expect(reopened.getRef(ref)).toBe(rawTarget);
    expect(reopened.reflog(ref)).toEqual(entries);
  });

  it("mutates refs with ref state above the former 48 MiB cap", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    workspace.repo.store.db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < 20000
       )
       INSERT INTO git_refs (repo_id, name, target)
       SELECT ?, 'refs/tags/' || printf('%05d', id) || printf('%0*d', 1010, 0), ?
         FROM sequence`,
      workspace.repo.store.repoId,
      FIRST,
    );

    workspace.repo.store.setRef("refs/tags/new", SECOND);

    expect(workspace.repo.store.getRef("refs/tags/new")).toBe(SECOND);
  });

  it("bounds pages and keeps an exclusive ordinal cursor stable across append and reopen", async () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    const ref = "refs/heads/history";
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, ref, 1_001);
    const git = bindGit(workspace);

    await expect(git.reflog({ ref, limit: 0 })).resolves.toEqual([]);
    await expect(git.reflog({ ref, limit: 1 })).resolves.toHaveLength(1);
    await expect(git.reflog({ ref, limit: 100 })).resolves.toHaveLength(100);
    await expect(git.reflog({ ref })).resolves.toHaveLength(100);
    await expect(git.reflog({ ref, limit: 1_000 })).resolves.toHaveLength(1_000);
    await expect(git.reflog({ ref, limit: 1_001 })).rejects.toMatchObject({ code: "E2BIG" });
    await expect(git.reflog({ ref, limit: 1.5 })).rejects.toMatchObject({ code: "EINVAL" });
    await expect(git.reflog({ ref, before: 0 })).rejects.toMatchObject({ code: "EINVAL" });

    const firstPage = await git.reflog({ ref, limit: 1 });
    expect(firstPage[0]?.ordinal).toBe(1_001);
    appendRefLog(workspace.repo.store.db, workspace.repo.store.repoId, ref, 1_002);
    const secondPage = await git.reflog({ ref, limit: 1, before: 1_001 });
    expect(secondPage[0]?.ordinal).toBe(1_000);

    const reopenedDatabase = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
      now: () => NOW_MILLISECONDS,
    });
    const reopened = createGit()({
      database: reopenedDatabase,
      worktree: workspace.worktree,
      now: workspace.context.now,
      timezoneOffset: workspace.context.timezoneOffset,
      defaultIdentity: ACTOR,
    });
    await expect(reopened.reflog({ ref, limit: 2 })).resolves.toMatchObject([
      { ordinal: 1_002, reason: "append" },
      { ordinal: 1_001, reason: "seed-1001" },
    ]);
  });

  it("orders equal and backward timestamps by ordinal and validates corrupt off-page rows", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    const ref = "refs/tags/timestamps";
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, ref, 3);
    expect(workspace.repo.reflog(ref, { limit: 1 }).map((entry) => entry.ordinal)).toEqual([3]);

    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      "UPDATE git_reflog_entries SET reason = zeroblob(1) WHERE repo_id = ? AND ordinal = 1",
      workspace.repo.store.repoId,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");
    expect(() => workspace.repo.reflog(ref, { limit: 1 })).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("uses one metadata preflight and one payload read for a complete page", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 100);
    workspace.storage.resetCounters();

    expect(workspace.repo.reflog("HEAD", { limit: 100 })).toHaveLength(100);
    expect(workspace.storage.statementCount).toBe(2);
  });
});

describe("HEAD reflog selectors", () => {
  it("selects zero through 1,023, accepts leading zero, and rejects other selector forms", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 1_024);
    const listed = workspace.repo.reflog("HEAD");

    expect(workspace.repo.revParse("HEAD@{0}")).toBe(listed[0]?.newOid);
    expect(workspace.repo.revParse("HEAD@{000}")).toBe(listed[0]?.newOid);
    expect(workspace.repo.revParse("HEAD@{1023}")).toBe(listed[1_023]?.newOid);
    for (const expression of [
      "HEAD@{1024}",
      "HEAD@{}",
      "HEAD@{-1}",
      "HEAD@{yesterday}",
      "main@{0}",
      "HEAD@{upstream}",
    ]) {
      expect(() => workspace.repo.revParse(expression), expression).toThrow(
        expect.objectContaining({ code: "ENOTFOUND" }),
      );
    }
  });

  it("composes with suffixes and rejects null or expired selected endpoints", async () => {
    let now = NOW_MILLISECONDS;
    const workspace = makeRepo("/", { startTime: now, now: () => now });
    const git = bindGit(workspace);
    await expect(git.revParse({ ref: "HEAD@{0}" })).rejects.toMatchObject({ code: "ENOTFOUND" });
    writeWorkFile(workspace, "/tracked.txt", "one\n");
    await git.add({ paths: ["tracked.txt"] });
    const first = (await git.commit({ message: "first" })).oid;
    writeWorkFile(workspace, "/tracked.txt", "two\n");
    await git.add({ paths: ["tracked.txt"] });
    await git.commit({ message: "second" });
    expect(await git.revParse({ ref: "HEAD@{0}^" })).toBe(first);

    workspace.repo.mutateRefs({ head: "ref: refs/heads/unborn" }, metadata("unborn"));
    await expect(git.revParse({ ref: "HEAD@{0}" })).rejects.toMatchObject({ code: "ENOTFOUND" });

    now += (RETENTION_SECONDS + 1) * 1_000;
    await expect(git.revParse({ ref: "HEAD@{1}" })).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("selects interleaved HEAD histories by checkout across a cold reopen", async () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    const first = workspace.repo.store.write("blob", new TextEncoder().encode("first\n"));
    const second = workspace.repo.store.write("blob", new TextEncoder().encode("second\n"));
    const third = workspace.repo.store.write("blob", new TextEncoder().encode("third\n"));
    workspace.repo.mutateRefs({ head: first }, metadata("seed-a"));
    const checkoutB = workspace.database.createCheckout(
      workspace.repo.store.repoId,
      "/checkout-b",
      first,
    );
    const repositoryB = new Repository(workspace.database.openCheckout(checkoutB));
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 0);

    workspace.repo.mutateRefs({ head: second }, metadata("a-1"));
    repositoryB.mutateRefs({ head: third }, metadata("b-1"));
    workspace.repo.mutateRefs({ head: third }, metadata("a-2"));
    repositoryB.mutateRefs({ head: second }, metadata("b-2"));

    expect(workspace.repo.checkout.reflog("HEAD").map((entry) => entry.ordinal)).toEqual([3, 1]);
    expect(repositoryB.checkout.reflog("HEAD").map((entry) => entry.ordinal)).toEqual([4, 2]);
    const git = bindGit(workspace);
    await expect(git.reflog({ dir: "/", ref: "HEAD" })).resolves.toMatchObject([
      { reason: "a-2", newOid: third },
      { reason: "a-1", newOid: second },
    ]);
    await expect(git.reflog({ dir: "/checkout-b", ref: "HEAD" })).resolves.toMatchObject([
      { reason: "b-2", newOid: second },
      { reason: "b-1", newOid: third },
    ]);
    await expect(git.revParse({ dir: "/", ref: "HEAD@{0}" })).resolves.toBe(third);
    await expect(git.revParse({ dir: "/", ref: "HEAD@{1}" })).resolves.toBe(second);
    await expect(git.revParse({ dir: "/checkout-b", ref: "HEAD@{0}" })).resolves.toBe(second);
    await expect(git.revParse({ dir: "/checkout-b", ref: "HEAD@{1}" })).resolves.toBe(third);

    const reopenedDatabase = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
      now: () => NOW_MILLISECONDS,
    });
    const reopened = bindGit(workspace, reopenedDatabase);
    await expect(
      reopened.revParse({ dir: "/checkout-b", ref: "HEAD@{0}" }),
      "checkout B opens first",
    ).resolves.toBe(second);
    await expect(
      reopened.revParse({ dir: "/", ref: "HEAD@{0}" }),
      "checkout A opens after B",
    ).resolves.toBe(third);
    await expect(reopened.revParse({ dir: "/checkout-b", ref: "HEAD@{1}" })).resolves.toBe(third);
    await expect(reopened.revParse({ dir: "/", ref: "HEAD@{1}" })).resolves.toBe(second);
  });
});

describe("reflog recovery", () => {
  it("recovers either endpoint, recreates deletion, and records actor, time, and causal HEAD", async () => {
    const workspace = makeRepo("/", {
      startTime: NOW_MILLISECONDS,
      timezoneOffset: -90,
      now: () => NOW_MILLISECONDS,
    });
    const git = bindGit(workspace);
    const oldOid = workspace.repo.store.write("blob", new TextEncoder().encode("old"));
    const newOid = workspace.repo.store.write("blob", new TextEncoder().encode("new"));
    workspace.repo.mutateRefs(
      { puts: [{ name: "refs/heads/main", target: oldOid }] },
      metadata("old"),
    );
    workspace.repo.mutateRefs(
      { puts: [{ name: "refs/heads/main", target: newOid }] },
      metadata("new"),
    );
    const movement = (await git.reflog({ ref: "refs/heads/main", limit: 1 }))[0];
    if (movement === undefined) throw new Error("missing movement entry");

    await git.recoverRef({
      ref: "refs/heads/main",
      source: { ref: "refs/heads/main", ordinal: movement.ordinal, endpoint: "old" },
      expectedCurrent: newOid,
    });
    expect(workspace.repo.store.getRef("refs/heads/main")).toBe(oldOid);
    expect((await git.reflog({ ref: "refs/heads/main", limit: 1 }))[0]).toMatchObject({
      newOid: oldOid,
      actor: ACTOR,
      timestamp: NOW_SECONDS,
      timezoneOffset: -90,
      reason: "recover-ref",
    });
    expect((await git.reflog({ ref: "HEAD", limit: 1 }))[0]).toMatchObject({
      newOid: oldOid,
      reason: "recover-ref",
    });

    workspace.repo.mutateRefs({ deletes: ["refs/heads/main"] }, metadata("delete"));
    const deletion = (await git.reflog({ ref: "refs/heads/main", limit: 1 }))[0];
    if (deletion === undefined) throw new Error("missing deletion entry");
    await git.recoverRef({
      ref: "refs/heads/main",
      source: { ref: "refs/heads/main", ordinal: deletion.ordinal, endpoint: "old" },
      expectedCurrent: null,
    });
    expect(workspace.repo.store.getRef("refs/heads/main")).toBe(oldOid);

    const creation = (await git.reflog({ ref: "refs/heads/main" })).at(-1);
    if (creation === undefined) throw new Error("missing creation entry");
    await expect(
      git.recoverRef({
        ref: "refs/tags/null",
        source: { ref: "refs/heads/main", ordinal: creation.ordinal, endpoint: "old" },
        expectedCurrent: null,
      }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("uses exact symbolic expected state and refuses stale and no-op recovery", async () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    const git = bindGit(workspace);
    const oid = workspace.repo.store.write("blob", new TextEncoder().encode("recover"));
    workspace.repo.mutateRefs(
      { puts: [{ name: "refs/tags/source", target: oid }] },
      metadata("source"),
    );
    const source = workspace.repo.reflog("refs/tags/source")[0];
    if (source === undefined) throw new Error("missing source entry");
    workspace.repo.mutateRefs(
      { puts: [{ name: "refs/heads/destination", target: "ref: refs/tags/source" }] },
      metadata("symbolic"),
    );

    await expect(
      git.recoverRef({
        ref: "refs/heads/destination",
        source: { ref: "refs/tags/source", ordinal: source.ordinal, endpoint: "new" },
        expectedCurrent: FIRST,
      }),
    ).rejects.toMatchObject({ code: "ESTALEHEAD" });
    await git.recoverRef({
      ref: "refs/heads/destination",
      source: { ref: "refs/tags/source", ordinal: source.ordinal, endpoint: "new" },
      expectedCurrent: "ref: refs/tags/source",
    });
    expect(workspace.repo.store.getRef("refs/heads/destination")).toBe(oid);
    const beforeCount = workspace.repo.store.db.scalar<number>(
      "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );
    const beforeOrdinal = workspace.repo.store.db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );

    await expect(
      git.recoverRef({
        ref: "refs/heads/destination",
        source: { ref: "refs/tags/source", ordinal: source.ordinal, endpoint: "new" },
        expectedCurrent: oid,
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(beforeCount);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(beforeOrdinal);
  });

  it("refuses an expired source even while its selected object still exists", async () => {
    let now = NOW_MILLISECONDS;
    const workspace = makeRepo("/", { startTime: now, now: () => now });
    const git = bindGit(workspace);
    const oid = workspace.repo.store.write("blob", new TextEncoder().encode("retained object"));
    workspace.repo.mutateRefs(
      { puts: [{ name: "refs/tags/source", target: oid }] },
      metadata("source"),
    );
    const source = workspace.repo.reflog("refs/tags/source")[0];
    if (source === undefined) throw new Error("missing source entry");
    now += (RETENTION_SECONDS + 1) * 1_000;

    await expect(
      git.recoverRef({
        ref: "refs/heads/expired",
        source: { ref: "refs/tags/source", ordinal: source.ordinal, endpoint: "new" },
        expectedCurrent: null,
      }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(workspace.repo.has(oid)).toBe(true);
    expect(workspace.repo.store.getRef("refs/heads/expired")).toBeNull();
  });

  it("refuses direct core recovery while an operation journal is active", async () => {
    const workspace = makeRepo("/", { startTime: NOW_MILLISECONDS, now: () => NOW_MILLISECONDS });
    const git = bindGit(workspace);
    writeWorkFile(workspace, "/tracked.txt", "committed\n");
    await git.add({ paths: ["tracked.txt"] });
    const oid = (await git.commit({ message: "committed" })).oid;
    const source = workspace.repo.reflog("refs/heads/main")[0];
    if (source === undefined) throw new Error("missing source entry");
    workspace.repo.checkout.writeOperationState(
      {
        kind: "cherry-pick",
        originalHeadRef: "refs/heads/main",
        originalHeadOid: oid,
        phase: "empty",
        emptyReason: "result",
        sourceOid: oid,
        selectedParentOid: null,
        mainline: null,
        currentLabel: "HEAD",
        incomingLabel: oid.slice(0, 7),
        message: "committed\n",
        author: null,
        committer: null,
      },
      [],
    );
    const beforeCount = workspace.repo.store.db.scalar<number>(
      "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );
    const beforeOrdinal = workspace.repo.store.db.scalar<number>(
      "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );

    expect(() =>
      recoverRef(workspace.context, workspace.repo, {
        ref: "refs/heads/recovered",
        source: { ref: "refs/heads/main", ordinal: source.ordinal, endpoint: "new" },
        expectedCurrent: null,
      }),
    ).toThrow(expect.objectContaining({ code: "EOPACTIVE" }));
    expect(workspace.repo.store.getRef("refs/heads/recovered")).toBeNull();
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(beforeCount);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(beforeOrdinal);
  });

  it("refuses expired, missing-object, corrupt, and non-direct recovery without mutation", async () => {
    let now = NOW_MILLISECONDS;
    const workspace = makeRepo("/", { startTime: now, now: () => now });
    const git = bindGit(workspace);
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "refs/tags/source", 1);
    const source = workspace.repo.reflog("refs/tags/source")[0];
    if (source === undefined) throw new Error("missing source entry");
    const recovery: GitRecoverRefOptions = {
      ref: "refs/heads/recovered",
      source: { ref: "refs/tags/source", ordinal: source.ordinal, endpoint: "new" },
      expectedCurrent: null,
    };

    await expect(git.recoverRef(recovery)).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(workspace.repo.store.getRef(recovery.ref)).toBeNull();
    await expect(git.recoverRef({ ...recovery, ref: "HEAD" })).rejects.toMatchObject({
      code: "EINVAL",
    });

    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      "UPDATE git_reflog_entries SET reason = zeroblob(1) WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");
    await expect(git.recoverRef(recovery)).rejects.toMatchObject({ code: "ECORRUPT" });
    expect(workspace.repo.store.getRef(recovery.ref)).toBeNull();

    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "refs/tags/source", 1);
    now += (RETENTION_SECONDS + 1) * 1_000;
    await expect(git.recoverRef(recovery)).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(workspace.repo.store.getRef(recovery.ref)).toBeNull();
  });
});

describe("active reflog roots", () => {
  it.each([
    [
      "ref name",
      `UPDATE git_reflog_entries
          SET ref_name = CAST(x'726566732f746167732ff09080' AS TEXT)
        WHERE repo_id = ?`,
    ],
    [
      "raw endpoint",
      `UPDATE git_reflog_entries SET old_raw = CAST(x'f09080' AS TEXT) WHERE repo_id = ?`,
    ],
    [
      "identity",
      `UPDATE git_reflog_entries
          SET actor_name = CAST(x'f09080' AS TEXT), actor_email = 'actor@example.test'
        WHERE repo_id = ?`,
    ],
    ["reason", `UPDATE git_reflog_entries SET reason = CAST(x'f09080' AS TEXT) WHERE repo_id = ?`],
    [
      "reason type",
      `UPDATE git_reflog_entries SET reason = CAST('reason' AS BLOB) WHERE repo_id = ?`,
    ],
  ])("rejects non-canonical UTF-8 in a persisted reflog %s", (_field, corruption) => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "refs/tags/source", 1);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(corruption, workspace.repo.store.repoId);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");

    expect(() => workspace.repo.activeRefLogOids().next()).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("preflights unbounded persisted text against the fixed scan cap", () => {
    const db = new GuardedDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(repository);
    db.rootScanRows = 1;
    db.rootScanTextBytes = MAX_REFLOG_ROOT_SCAN_BYTES;
    db.rootScanMaxRowBytes = MAX_REFLOG_ROOT_SCAN_BYTES;
    db.iterateCalls = 0;

    expect(() => store.activeRefLogOids().next()).toThrow(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(db.iterateCalls).toBe(0);
  });

  it("deduplicates active non-null endpoints in SQL and excludes expired roots", () => {
    let now = NOW_MILLISECONDS;
    const workspace = makeRepo("/", { now: () => now });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 10);
    workspace.repo.mutateRefs(
      { puts: [{ name: "refs/tags/created", target: THIRD }] },
      metadata("null-old-endpoint"),
    );

    expect([...workspace.repo.activeRefLogOids()]).toEqual([FIRST, SECOND, THIRD]);
    now += (RETENTION_SECONDS + 1) * 1_000;
    expect([...workspace.repo.activeRefLogOids()]).toEqual([]);
  });

  it("fails closed on a persisted 1,025th row without cleaning it up", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 1_025);
    expect(() => workspace.repo.reflog("HEAD")).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(1_025);

    const coldDatabase = new SqliteGitDatabase(new TestDatabase(workspace.storage));
    const coldCheckout = coldDatabase.checkoutAt("/");
    if (coldCheckout === null) throw new Error("reopened corrupt reflog checkout is missing");
    expect(() => coldDatabase.openCheckout(coldCheckout).reflog("HEAD")).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("is lazy, uses one iterate query, never calls all, and closes early", () => {
    const db = new GuardedDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(repository);
    seedRefLog(db, store.repoId, "HEAD", 10);
    db.iterateCalls = 0;
    db.closedIterators = 0;
    db.forbidAll = true;

    const roots = store.activeRefLogOids();
    expect(db.iterateCalls).toBe(0);
    expect(roots.next()).toEqual({ done: false, value: FIRST });
    expect(db.iterateCalls).toBe(1);
    roots.return(undefined);
    expect(db.iterateCalls).toBe(1);
    expect(db.closedIterators).toBe(1);
  });

  it("enumerates the valid 9,329-ref mutation shape in one validated traversal", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    const refs = Array.from({ length: 9_329 }, (_, index) => ({
      name: `refs/remotes/origin/branch-${index.toString().padStart(4, "0")}`,
      target: index.toString(16).padStart(40, "0"),
    }));
    workspace.repo.store.updateRefs(refs);
    workspace.storage.resetCounters();

    const roots = [...workspace.repo.activeRefLogOids()];
    expect(roots).toHaveLength(9_329);
    expect(roots[0]).toBe("0".repeat(40));
    expect(roots.at(-1)).toBe((9_328).toString(16).padStart(40, "0"));
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("accepts 9,727 combined retained rows and rejects 9,728 before traversal", () => {
    const db = new GuardedDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(repository);
    const checkoutIds = [repository.id];
    for (let index = 1; index < 8; index++) {
      checkoutIds.push(database.createCheckout(store.repoId, `/checkout-${index}`, FIRST).id);
    }
    const checkoutRows = 1_024;
    const directRows = MAX_REFLOG_ROOT_SCAN_ENTRIES - checkoutIds.length * checkoutRows;
    const checkoutEndpoints = seedCombinedActiveRefLogs(
      db,
      store.repoId,
      checkoutIds,
      checkoutRows,
      directRows,
    );
    db.forbidAll = true;
    db.iterateCalls = 0;

    expect(
      db.scalar<number>("SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?", store.repoId),
    ).toBe(directRows);
    expect(
      db.scalar<number>(
        "SELECT count(DISTINCT ref_name) FROM git_reflog_entries WHERE repo_id = ?",
        store.repoId,
      ),
    ).toBe(directRows);
    expect(
      db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE repo_id = ?",
        store.repoId,
      ),
    ).toBe(checkoutIds.length * checkoutRows);
    for (const checkoutId of checkoutIds) {
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM git_checkout_reflog_entries WHERE checkout_id = ?",
          checkoutId,
        ),
      ).toBe(checkoutRows);
    }
    expect(directRows + checkoutIds.length * checkoutRows).toBe(9_727);
    expect(new Set(checkoutEndpoints).size).toBe(checkoutEndpoints.length);
    const accepted = store.activeRefLogOids();
    expect(db.iterateCalls).toBe(0);
    const roots = [...accepted];
    expect(roots).toHaveLength(checkoutEndpoints.length + 2);
    expect(roots).toEqual(expect.arrayContaining([FIRST, SECOND, ...checkoutEndpoints]));
    expect(db.iterateCalls).toBe(1);

    appendRefLog(db, store.repoId, "refs/tags/root-overflow", MAX_REFLOG_ROOT_SCAN_ENTRIES + 1);
    expect(
      db.scalar<number>(
        `SELECT (SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?)
              + (SELECT count(*) FROM git_checkout_reflog_entries WHERE repo_id = ?)`,
        store.repoId,
        store.repoId,
      ),
    ).toBe(9_728);
    db.iterateCalls = 0;
    db.closedIterators = 0;
    const over = store.activeRefLogOids();
    expect(() => over.next()).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(db.iterateCalls).toBe(0);
    expect(db.closedIterators).toBe(0);
  });

  it("validates every retained row before yielding a root", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 3);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      "UPDATE git_checkout_reflog_entries SET old_oid = NULL WHERE repo_id = ? AND ordinal = 1",
      workspace.repo.store.repoId,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");

    const roots = workspace.repo.activeRefLogOids();
    expect(() => roots.next()).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("fails closed on persisted cross-owner checkout reflog corruption", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const first = database.createRepository("/first", "ref: refs/heads/main");
    const second = database.createRepository("/second", "ref: refs/heads/main");
    const secondStore = database.openCheckout(second);
    db.run(
      `INSERT INTO git_checkout_reflog_entries
         (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, 0, 'cross-owner')`,
      first.id,
      first.repoId,
      FIRST,
      SECOND,
      FIRST,
      SECOND,
      NOW_SECONDS,
    );
    db.run("UPDATE git_reflog_state SET next_ordinal = 1 WHERE repo_id = ?", first.repoId);
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.run(
        "UPDATE git_checkout_reflog_entries SET repo_id = ? WHERE checkout_id = ?",
        second.repoId,
        first.id,
      );
      db.run("UPDATE git_reflog_state SET next_ordinal = 0 WHERE repo_id = ?", first.repoId);
      db.run("UPDATE git_reflog_state SET next_ordinal = 1 WHERE repo_id = ?", second.repoId);
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }
    expect(db.scalar<unknown>("PRAGMA foreign_keys")).toBe(1);

    expect(() => secondStore.activeRefLogOids().next()).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });

  it("routes negative and non-integer ordinals through corruption validation", () => {
    const corruptions: readonly unknown[] = [-1, new Uint8Array([1])];
    for (const ordinal of corruptions) {
      const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
      seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 3);
      workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
      workspace.repo.store.db.run(
        "UPDATE git_checkout_reflog_entries SET ordinal = ? WHERE repo_id = ? AND ordinal = 1",
        ordinal,
        workspace.repo.store.repoId,
      );
      workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");

      expect(() => workspace.repo.activeRefLogOids().next(), String(ordinal)).toThrow(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }
  });

  it("validates allocation state before listing or yielding roots", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 3);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      "UPDATE git_reflog_state SET next_ordinal = 2 WHERE repo_id = ?",
      workspace.repo.store.repoId,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");

    expect(() => workspace.repo.reflog("HEAD")).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => workspace.repo.activeRefLogOids().next()).toThrow(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
  });
});

describe("mutation publication result", () => {
  it("returns false only for no event and true after publication", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    expect(workspace.repo.mutateRefs({}, metadata("none"))).toBe(false);
    expect(
      workspace.repo.mutateRefs(
        { puts: [{ name: "refs/tags/published", target: FIRST }] },
        metadata("publish"),
      ),
    ).toBe(true);
    expect(
      workspace.repo.mutateRefs(
        { puts: [{ name: "refs/tags/published", target: FIRST }] },
        metadata("same"),
      ),
    ).toBe(false);
  });

  it("does not report publication when the transaction fails", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    workspace.repo.store.db.run(`CREATE TRIGGER fail_publication
      BEFORE INSERT ON git_reflog_entries
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END`);
    expect(() =>
      workspace.repo.mutateRefs(
        { puts: [{ name: "refs/tags/fail", target: FIRST }] },
        metadata("fail"),
      ),
    ).toThrow(/injected publication failure/);
    expect(workspace.repo.store.getRef("refs/tags/fail")).toBeNull();
  });

  it("rolls ref, HEAD, and reflog state back after a coded SQLite value failure", () => {
    const storage = new SqliteTestStorage();
    const snapshotDb = new TestDatabase(storage);
    const faultStorage = new CodedTooBigStorage(storage);
    const database = new SqliteGitDatabase(new Database(faultStorage));
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const repo = new Repository(database.openCheckout(checkout));
    const before = durableRefMutationState(snapshotDb);

    faultStorage.arm("INSERT INTO git_checkout_reflog_entries");
    expect(() =>
      repo.mutateRefs(
        { puts: [{ name: "refs/heads/main", target: FIRST }] },
        metadata("coded SQLite rollback"),
      ),
    ).toThrowError(expect.objectContaining({ name: "GitError", code: "E2BIG" }));
    expect(faultStorage.writesBeforeFailure).toBeGreaterThan(0);
    expect(durableRefMutationState(snapshotDb)).toEqual(before);
    expect(repo.checkout.head()).toBe("ref: refs/heads/main");
    expect(repo.store.getRef("refs/heads/main")).toBeNull();
    expect(repo.reflog("HEAD")).toEqual([]);
    expect(repo.reflog("refs/heads/main")).toEqual([]);

    const coldDatabase = new SqliteGitDatabase(new TestDatabase(storage));
    const coldCheckout = coldDatabase.checkoutAt("/repo");
    if (coldCheckout === null) throw new Error("reopened rollback checkout is missing");
    const coldStore = coldDatabase.openCheckout(coldCheckout);
    expect(durableRefMutationState(new TestDatabase(storage))).toEqual(before);
    expect(coldStore.head()).toBe("ref: refs/heads/main");
    expect(coldStore.getRef("refs/heads/main")).toBeNull();
    expect(coldStore.reflog("HEAD")).toEqual([]);
  });
});
