import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSqliteDatabase, type RecoveryTransactionOwner } from "@kompjutr/local";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

function database(): NodeSqliteDatabase {
  const directory = mkdtempSync(join(tmpdir(), "kompjutr-sqlite-test-"));
  directories.push(directory);
  return new NodeSqliteDatabase(join(directory, "state.sqlite"));
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("NodeSqliteDatabase", () => {
  it("rejects malformed low-level database and identity paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-sqlite-path-test-"));
    directories.push(directory);
    expect(() => new NodeSqliteDatabase(`${directory}/bad\0path`)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => new NodeSqliteDatabase(`${directory}/bad\uD800path`)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(
      () =>
        new NodeSqliteDatabase(join(directory, "state.sqlite"), {
          root: `${directory}/bad\uD800root`,
          recoveryDirectory: join(directory, "recovery"),
        }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("normalizes rows and BLOB bindings through every read surface", () => {
    const db = database();
    try {
      db.run("CREATE TABLE sample (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)");
      db.run("INSERT INTO sample VALUES (?, ?)", 1, new Uint8Array([1, 2, 3]));
      expect(db.all("SELECT id, bytes FROM sample")).toEqual([
        { id: 1, bytes: new Uint8Array([1, 2, 3]) },
      ]);
      expect(db.one("SELECT bytes FROM sample")).toEqual({ bytes: new Uint8Array([1, 2, 3]) });
      expect(db.scalar("SELECT id FROM sample")).toBe(1);
      expect([...db.iterate("SELECT id FROM sample")]).toEqual([{ id: 1 }]);
    } finally {
      db.close();
    }
  });

  it("joins nested work into the outer rollback and poisons rejected asynchronous results", async () => {
    const db = database();
    try {
      db.run("CREATE TABLE sample (value TEXT NOT NULL)");
      expect(() =>
        db.transactionSync(() => {
          db.run("INSERT INTO sample VALUES ('outer')");
          db.transactionSync(() => db.run("INSERT INTO sample VALUES ('nested')"));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(db.all("SELECT value FROM sample")).toEqual([]);
      const asynchronousResult = (): unknown =>
        Promise.resolve().then(() => db.run("INSERT INTO sample VALUES ('late')"));
      expect(() => db.transactionSync(asynchronousResult)).toThrow(
        "transactionSync closure returned an asynchronous result",
      );
      await Promise.resolve();
      expect(() => db.run("SELECT 1")).toThrowError(expect.objectContaining({ code: "EBADF" }));
    } finally {
      db.close();
    }
  });

  it("rolls back and poisons when an outer callback catches a nested asynchronous result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-async-transaction-test-"));
    const path = join(directory, "state.sqlite");
    directories.push(directory);
    const db = new NodeSqliteDatabase(path);
    db.run("CREATE TABLE sample (value TEXT NOT NULL)");
    const asynchronousResult = (): unknown =>
      Promise.resolve().then(() => db.run("INSERT INTO sample VALUES ('late')"));
    expect(() =>
      db.transactionSync(() => {
        db.run("INSERT INTO sample VALUES ('outer')");
        try {
          db.transactionSync(asynchronousResult);
        } catch {}
      }),
    ).toThrow("nested transactionSync closure returned an asynchronous result");
    await Promise.resolve();
    expect(() => db.run("SELECT 1")).toThrowError(expect.objectContaining({ code: "EBADF" }));
    const reopened = new NodeSqliteDatabase(path);
    try {
      expect(reopened.scalar("SELECT COUNT(*) FROM sample")).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("poisons the adapter when recovery rollback or uncertain classification fails", () => {
    const failures: readonly ("rollback" | "classification")[] = ["rollback", "classification"];
    for (const failure of failures) {
      let checkpointFailure = false;
      let abandoned = false;
      const recovery: RecoveryTransactionOwner = {
        begin() {},
        diskChanged: failure === "classification",
        abortOnly: false,
        checkpoint(checkpoint) {
          if (failure === "classification" && checkpoint === "before-commit") {
            checkpointFailure = true;
            throw new Error("reported commit failure");
          }
        },
        operationFailed() {},
        commitSucceeded() {},
        rollback() {
          if (failure === "rollback") throw new Error("recovery rollback failed");
        },
        settleUncertain() {
          if (checkpointFailure) throw new Error("recovery classification failed");
        },
        abandon() {
          abandoned = true;
        },
      };
      const directory = mkdtempSync(join(tmpdir(), `kompjutr-${failure}-failure-test-`));
      directories.push(directory);
      const db = new NodeSqliteDatabase(join(directory, "state.sqlite"), { recovery });
      expect(() =>
        db.transactionSync(() => {
          if (failure === "rollback") throw new Error("operation failed");
        }),
      ).toThrow(`recovery ${failure} failed`);
      expect(() => db.run("SELECT 1")).toThrowError(expect.objectContaining({ code: "EBADF" }));
      expect(abandoned).toBe(true);
      db.close();
    }
  });

  it("poisons the adapter and recovery owner when generation classification fails", () => {
    let abandoned = false;
    const recovery: RecoveryTransactionOwner = {
      begin() {},
      diskChanged: false,
      abortOnly: false,
      checkpoint() {},
      operationFailed() {},
      commitSucceeded() {},
      rollback() {},
      settleUncertain() {},
      abandon() {
        abandoned = true;
      },
    };
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-generation-failure-test-"));
    directories.push(directory);
    const db = new NodeSqliteDatabase(join(directory, "state.sqlite"), { recovery });
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run("UPDATE local_runtime_state SET recovery_generation = 'invalid'");
    expect(() => db.transactionSync(() => undefined)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(abandoned).toBe(true);
    expect(() => db.run("SELECT 1")).toThrowError(expect.objectContaining({ code: "EBADF" }));
    db.close();
  });

  it("leases observation revisions above every previously issued range", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-observation-test-"));
    const path = join(directory, "state.sqlite");
    directories.push(directory);
    const first = new NodeSqliteDatabase(path);
    const initial = first.leaseObservationRevisions(10);
    first.close();
    const second = new NodeSqliteDatabase(path);
    try {
      const next = second.leaseObservationRevisions(10);
      expect(next.start).toBe(initial.end);
    } finally {
      second.close();
    }
  });

  it("keeps an observation lease durable when the caller transaction rolls back", () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-observation-rollback-test-"));
    const path = join(directory, "state.sqlite");
    directories.push(directory);
    const first = new NodeSqliteDatabase(path);
    let leasedEnd = 0;
    try {
      expect(() =>
        first.transactionSync(() => {
          leasedEnd = first.leaseObservationRevisions(10).end;
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
    } finally {
      first.close();
    }
    const second = new NodeSqliteDatabase(path);
    try {
      expect(second.leaseObservationRevisions(10).start).toBe(leasedEnd);
    } finally {
      second.close();
    }
  });
});
