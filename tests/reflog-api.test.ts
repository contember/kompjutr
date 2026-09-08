import { describe, expect, it } from "vitest";
import {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
  type SqlDatabase,
} from "../packages/do/src/db/db.js";
import { createGit, type Git, type GitRecoverRefOptions } from "../packages/git/src/client.js";
import { recoverRef } from "../packages/git/src/ops/core/ref-log.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import {
  MAX_REFLOG_ROOT_SCAN_ENTRIES,
  type RefLogMetadata,
  SqliteGitDatabase,
} from "../packages/git/src/store/index.js";
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

  run(query: string, ...bindings: unknown[]): void {
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    if (this.forbidAll) throw new Error("db.all is forbidden during the root stream");
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
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

class ReflogWitnessDatabase implements SqlDatabase {
  readonly queries: { query: string; bindings: unknown[] }[] = [];
  allocatorRaceInjected = false;
  #allocatorRaceArmed = false;

  constructor(readonly inner = new TestDatabase()) {}

  run(query: string, ...bindings: unknown[]): void {
    this.queries.push({ query, bindings });
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.queries.push({ query, bindings });
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.queries.push({ query, bindings });
    if (
      this.#allocatorRaceArmed &&
      query.includes("UPDATE git_reflog_state SET next_ordinal = ?")
    ) {
      this.#allocatorRaceArmed = false;
      this.allocatorRaceInjected = true;
      const repoId = bindings[1];
      if (typeof repoId !== "number" || !Number.isSafeInteger(repoId)) {
        throw new Error("allocator CAS repository binding is invalid");
      }
      this.inner.run(
        "UPDATE git_reflog_state SET next_ordinal = next_ordinal + 1 WHERE repo_id = ?",
        repoId,
      );
    }
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.queries.push({ query, bindings });
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.queries.push({ query, bindings });
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }

  resetQueries(): void {
    this.queries.length = 0;
  }

  armAllocatorRace(): void {
    this.#allocatorRaceArmed = true;
    this.allocatorRaceInjected = false;
  }

  planFor(fragment: string): string[] {
    const issued = this.queries.find(({ query }) => query.includes(fragment));
    if (issued === undefined)
      throw new Error(`production query containing ${fragment} was not issued`);
    return this.inner
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${issued.query}`, ...issued.bindings)
      .map(({ detail }) => detail);
  }
}

describe("reflog query plans", () => {
  it("keeps mutation and active-root headers off both histories", () => {
    const db = new ReflogWitnessDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(repository);
    seedCombinedActiveRefLogs(db, store.repoId, [repository.id], 1_024, 1_024);

    db.resetQueries();
    store.setRef("refs/tags/query-plan", THIRD);
    const mutationPlan = db.planFor("repository.checkout_revision").join("\n");
    expect(mutationPlan).not.toContain("git_reflog_entries");
    expect(mutationPlan).not.toContain("git_checkout_reflog_entries");

    db.resetQueries();
    const roots = store.activeRefLogOids();
    expect(roots.next().done).toBe(false);
    roots.return(undefined);
    const activeRootHeaderPlan = db.planFor("checkout.head, state.next_ordinal").join("\n");
    expect(activeRootHeaderPlan).not.toContain("git_reflog_entries");
    expect(activeRootHeaderPlan).not.toContain("git_checkout_reflog_entries");
  });

  it("keeps exact reads off the unrelated history", () => {
    const db = new ReflogWitnessDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(repository);
    seedCombinedActiveRefLogs(db, store.repoId, [repository.id], 1_024, 1_024);

    db.resetQueries();
    expect(store.reflog("refs/tags/combined-0001")).toHaveLength(1);
    const directPlan = db.planFor("ORDER BY kind, ordinal DESC").join("\n");
    expect(directPlan).toContain("git_reflog_entries");
    expect(directPlan).not.toContain("git_checkout_reflog_entries");

    db.resetQueries();
    expect(store.reflog("HEAD")).toHaveLength(1_024);
    const headPlan = db.planFor("ORDER BY kind, ordinal DESC").join("\n");
    expect(headPlan).not.toContain("git_reflog_entries");
  });
});

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

  it("orders equal and backward timestamps by ordinal", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    const ref = "refs/tags/timestamps";
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, ref, 3);
    expect(workspace.repo.reflog(ref, { limit: 1 }).map((entry) => entry.ordinal)).toEqual([3]);
  });

  it("uses one statement for a complete page", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 100);
    workspace.storage.resetCounters();

    expect(workspace.repo.reflog("HEAD", { limit: 100 })).toHaveLength(100);
    expect(workspace.storage.statementCount).toBe(1);
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
    expect(() => workspace.repo.reflog("HEAD")).toThrow(expect.objectContaining({ code: "E2BIG" }));
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
      expect.objectContaining({ code: "E2BIG" }),
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
    expect(db.iterateCalls).toBe(1);
    expect(db.closedIterators).toBe(1);
  });

  it("rejects cross-owner checkout reflog writes", () => {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const first = database.createRepository("/first", "ref: refs/heads/main");
    const second = database.createRepository("/second", "ref: refs/heads/main");
    expect(() =>
      db.run(
        `INSERT INTO git_checkout_reflog_entries
           (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         VALUES (?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, 0, 'cross-owner')`,
        first.id,
        second.repoId,
        FIRST,
        SECOND,
        FIRST,
        SECOND,
        NOW_SECONDS,
      ),
    ).toThrow();
    expect(db.scalar<number>("SELECT count(*) FROM git_checkout_reflog_entries")).toBe(0);
  });

  it("rejects negative and non-integer reflog ordinals at write time", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    for (const ordinal of [-1, new Uint8Array([1])]) {
      expect(() =>
        workspace.repo.store.db.run(
          `INSERT INTO git_checkout_reflog_entries
             (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
              actor_name, actor_email, timestamp, timezone, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, 'invalid ordinal')`,
          workspace.repo.checkout.checkoutId,
          workspace.repo.store.repoId,
          ordinal,
          FIRST,
          SECOND,
          FIRST,
          SECOND,
          NOW_SECONDS,
        ),
      ).toThrow();
    }
    expect(
      workspace.repo.store.db.scalar<number>("SELECT count(*) FROM git_checkout_reflog_entries"),
    ).toBe(0);
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

  it("rolls refs, entries, and state back when the allocator changes before final CAS", () => {
    const db = new ReflogWitnessDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const repo = new Repository(database.openCheckout(checkout));
    const before = durableRefMutationState(db.inner);
    db.armAllocatorRace();

    expect(() =>
      repo.mutateRefs(
        { puts: [{ name: "refs/heads/main", target: FIRST }] },
        metadata("allocator race"),
      ),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(db.allocatorRaceInjected).toBe(true);
    expect(durableRefMutationState(db.inner)).toEqual(before);
    expect(repo.store.getRef("refs/heads/main")).toBeNull();
    expect(repo.reflog("refs/heads/main")).toEqual([]);
    expect(repo.reflog("HEAD")).toEqual([]);
  });
});
