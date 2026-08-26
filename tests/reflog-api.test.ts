import { describe, expect, it } from "vitest";

import { recoverRef } from "../src/core/ops/ref-log.js";
import { createGit, type Git, type GitRecoverRefOptions } from "../src/git/client.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import {
  MAX_REFLOG_ROOT_RETAINED_BYTES,
  MAX_REFLOG_ROOT_SCAN_BYTES,
  MAX_REFLOG_ROOT_SCAN_ENTRIES,
  REFLOG_ROOT_ENDPOINT_BYTES,
  REFLOG_ROOT_JS_HEADROOM_BYTES,
  REFLOG_ROOT_OBJECT_CACHE_BYTES,
  REFLOG_ROOT_PACK_ROW_CACHE_BYTES,
  REFLOG_ROOT_SCAN_FIXED_BYTES,
  type RefLogMetadata,
  SqliteGitDatabase,
} from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

const NOW_SECONDS = 1_800_000_000;
const NOW_MILLISECONDS = NOW_SECONDS * 1_000;
const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const ACTOR = { name: "Recovery Actor", email: "recovery@example.com" };
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const THIRD = "3".repeat(40);

function bindGit(workspace: TestRepository): Git {
  return createGit()({
    database: workspace.database,
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
    db.run("UPDATE git_reflog_state SET next_ordinal = 0 WHERE repo_id = ?", repoId);
    if (count === 0) return;
    db.run(
      `WITH RECURSIVE sequence(ordinal) AS (
         VALUES (1)
         UNION ALL
         SELECT ordinal + 1 FROM sequence WHERE ordinal < ?
       )
       INSERT INTO git_reflog_entries
         (repo_id, ref_name, ordinal, old_raw, new_raw, old_oid, new_oid,
          actor_name, actor_email, timestamp, timezone, reason)
       SELECT ?, ?, ordinal,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END,
              CASE ordinal % 2 WHEN 0 THEN ? ELSE ? END,
              NULL, NULL, ? - (ordinal % 3), 0, 'seed-' || ordinal
         FROM sequence`,
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
    db.run("UPDATE git_reflog_state SET next_ordinal = ? WHERE repo_id = ?", count, repoId);
  });
}

function appendRefLog(db: SqlDatabase, repoId: number, ref: string, ordinal: number): void {
  db.transactionSync(() => {
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
    db.run("UPDATE git_reflog_state SET next_ordinal = ? WHERE repo_id = ?", ordinal, repoId);
  });
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

describe("public reflog listing", () => {
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

  it("uses one compound traversal statement for a complete page", () => {
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

    workspace.repo.store.mutateRefs({ head: "ref: refs/heads/unborn" }, metadata("unborn"));
    await expect(git.revParse({ ref: "HEAD@{0}" })).rejects.toMatchObject({ code: "ENOTFOUND" });

    now += (RETENTION_SECONDS + 1) * 1_000;
    await expect(git.revParse({ ref: "HEAD@{1}" })).rejects.toMatchObject({ code: "ENOTFOUND" });
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
    workspace.repo.store.mutateRefs(
      { puts: [{ name: "refs/heads/main", target: oldOid }] },
      metadata("old"),
    );
    workspace.repo.store.mutateRefs(
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

    workspace.repo.store.mutateRefs({ deletes: ["refs/heads/main"] }, metadata("delete"));
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
    workspace.repo.store.mutateRefs(
      { puts: [{ name: "refs/tags/source", target: oid }] },
      metadata("source"),
    );
    const source = workspace.repo.reflog("refs/tags/source")[0];
    if (source === undefined) throw new Error("missing source entry");
    workspace.repo.store.mutateRefs(
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
    workspace.repo.store.mutateRefs(
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
    workspace.repo.store.writeOperationState(
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
  it("keeps SQL state, shared caches, and JS headroom strictly below 100 MiB", () => {
    expect(
      MAX_REFLOG_ROOT_SCAN_BYTES +
        REFLOG_ROOT_OBJECT_CACHE_BYTES +
        REFLOG_ROOT_PACK_ROW_CACHE_BYTES +
        REFLOG_ROOT_JS_HEADROOM_BYTES,
    ).toBe(MAX_REFLOG_ROOT_RETAINED_BYTES);
    expect(MAX_REFLOG_ROOT_RETAINED_BYTES).toBe(100 * 1024 * 1024 - 1);
    expect(REFLOG_ROOT_OBJECT_CACHE_BYTES).toBe(8 * 1024 * 1024);
    expect(REFLOG_ROOT_PACK_ROW_CACHE_BYTES).toBe(4 * 1024 * 1024);
    expect(REFLOG_ROOT_JS_HEADROOM_BYTES).toBe(4 * 1024 * 1024);
    expect(
      REFLOG_ROOT_SCAN_FIXED_BYTES + 2 * REFLOG_ROOT_ENDPOINT_BYTES * MAX_REFLOG_ROOT_SCAN_ENTRIES,
    ).toBeLessThanOrEqual(MAX_REFLOG_ROOT_SCAN_BYTES);
    expect(
      REFLOG_ROOT_SCAN_FIXED_BYTES +
        2 * REFLOG_ROOT_ENDPOINT_BYTES * (MAX_REFLOG_ROOT_SCAN_ENTRIES + 1),
    ).toBeGreaterThan(MAX_REFLOG_ROOT_SCAN_BYTES);
    expect(MAX_REFLOG_ROOT_SCAN_ENTRIES).toBe(9_727);
  });

  it("deduplicates active non-null endpoints in SQL and excludes expired roots", () => {
    let now = NOW_MILLISECONDS;
    const workspace = makeRepo("/", { now: () => now });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 10);
    workspace.repo.store.mutateRefs(
      { puts: [{ name: "refs/tags/created", target: THIRD }] },
      metadata("null-old-endpoint"),
    );

    expect([...workspace.repo.activeRefLogOids()]).toEqual([FIRST, SECOND, THIRD]);
    now += (RETENTION_SECONDS + 1) * 1_000;
    expect([...workspace.repo.activeRefLogOids()]).toEqual([]);
  });

  it("excludes the 1,025th row before physical cleanup", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 1_025);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      `UPDATE git_reflog_entries
          SET old_raw = ?, old_oid = ?, new_raw = ?, new_oid = ?
        WHERE repo_id = ? AND ordinal = 1`,
      THIRD,
      THIRD,
      FIRST,
      FIRST,
      workspace.repo.store.repoId,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");

    const listed = workspace.repo.reflog("HEAD");
    expect(listed).toHaveLength(1_024);
    expect(listed.at(-1)?.ordinal).toBe(2);
    expect(workspace.repo.reflog("HEAD", { before: 2, limit: 1 })).toEqual([]);
    expect([...workspace.repo.activeRefLogOids()]).toEqual([FIRST, SECOND]);
  });

  it("is lazy, uses one iterate query, never calls all, and closes early", () => {
    const db = new GuardedDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.create("/repo", "ref: refs/heads/main");
    const store = database.open(repository);
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

  it("enumerates the valid 9,329-ref mutation shape in one statement", () => {
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
    expect(workspace.storage.statementCount).toBe(1);
  });

  it("accepts the exact SQL-state budget and rejects one physical row over before grouping", () => {
    const db = new GuardedDatabase();
    const database = new SqliteGitDatabase(db, { now: () => NOW_MILLISECONDS });
    const repository = database.create("/repo", "ref: refs/heads/main");
    const store = database.open(repository);
    seedRefLog(db, store.repoId, "HEAD", MAX_REFLOG_ROOT_SCAN_ENTRIES);
    db.forbidAll = true;
    db.iterateCalls = 0;

    expect([...store.activeRefLogOids()]).toEqual([FIRST, SECOND]);
    expect(db.iterateCalls).toBe(1);

    appendRefLog(db, store.repoId, "HEAD", MAX_REFLOG_ROOT_SCAN_ENTRIES + 1);
    db.iterateCalls = 0;
    db.closedIterators = 0;
    const over = store.activeRefLogOids();
    expect(() => over.next()).toThrow(expect.objectContaining({ code: "E2BIG" }));
    expect(db.iterateCalls).toBe(1);
    expect(db.closedIterators).toBe(1);
  });

  it("validates every retained row before yielding a root", () => {
    const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
    seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 3);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      "UPDATE git_reflog_entries SET old_oid = NULL WHERE repo_id = ? AND ordinal = 1",
      workspace.repo.store.repoId,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");

    const roots = workspace.repo.activeRefLogOids();
    expect(() => roots.next()).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
  });

  it("routes negative and non-integer ordinals through corruption validation", () => {
    const corruptions: readonly unknown[] = [-1, new Uint8Array([1])];
    for (const ordinal of corruptions) {
      const workspace = makeRepo("/", { now: () => NOW_MILLISECONDS });
      seedRefLog(workspace.repo.store.db, workspace.repo.store.repoId, "HEAD", 3);
      workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
      workspace.repo.store.db.run(
        "UPDATE git_reflog_entries SET ordinal = ? WHERE repo_id = ? AND ordinal = 1",
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
    expect(workspace.repo.store.mutateRefs({}, metadata("none"))).toBe(false);
    expect(
      workspace.repo.store.mutateRefs(
        { puts: [{ name: "refs/tags/published", target: FIRST }] },
        metadata("publish"),
      ),
    ).toBe(true);
    expect(
      workspace.repo.store.mutateRefs(
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
      workspace.repo.store.mutateRefs(
        { puts: [{ name: "refs/tags/fail", target: FIRST }] },
        metadata("fail"),
      ),
    ).toThrow(/injected publication failure/);
    expect(workspace.repo.store.getRef("refs/tags/fail")).toBeNull();
  });
});
