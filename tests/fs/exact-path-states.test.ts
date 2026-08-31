import { describe, expect, it } from "vitest";

import { createExactPathStateSource } from "../../src/fs/exact-path-states.js";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { SqlDatabase } from "../../src/sqlite/db.js";
import { TestDatabase } from "../helpers/db.js";

class RecordingDatabase implements SqlDatabase {
  readonly statements: { query: string; bindings: unknown[] }[] = [];

  constructor(private readonly inner: SqlDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.statements.push({ query, bindings });
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.statements.push({ query, bindings });
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.statements.push({ query, bindings });
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.statements.push({ query, bindings });
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.statements.push({ query, bindings });
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

class CorruptStateDatabase implements SqlDatabase {
  constructor(private readonly inner: SqlDatabase) {}

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

  *iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    for (const row of this.inner.iterate(query, ...bindings))
      yield { ...row, node_type: "unknown" };
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

describe("exact path states", () => {
  it("reports exact files, directories, and symlinks without following the final symlink", () => {
    const db = new TestDatabase();
    const fs = createFilesystem(db, { now: () => 1_700_000_000_000 });
    fs.makeDirectories(["/directory", "/target"]);
    fs.writeFile("/file", new Uint8Array([1]));
    fs.symlink("/target", "/link");

    expect(
      createExactPathStateSource(db).states([
        "/",
        "/file",
        "/directory",
        "/link",
        "/link/child",
        "/missing",
      ]),
    ).toEqual(["present", "present", "present", "present", "missing", "missing"]);
  });

  it("preserves input order and duplicates and freezes the result", () => {
    const db = new TestDatabase();
    const fs = createFilesystem(db);
    fs.writeFile("/exists", new Uint8Array());

    const result = createExactPathStateSource(db).states([
      "/missing",
      "/exists",
      "/missing",
      "/",
      "/exists",
    ]);

    expect(result).toEqual(["missing", "present", "missing", "present", "present"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("pages maximal checkout roots below the JSON binding ceiling", () => {
    const db = new TestDatabase();
    createFilesystem(db);
    const recording = new RecordingDatabase(db);
    const roots = Array.from({ length: 1_024 }, (_, index) => {
      const prefix = `/${index.toString().padStart(4, "0")}-`;
      return `${prefix}${"x".repeat(4_096 - prefix.length)}`;
    });

    const result = createExactPathStateSource(recording).states(roots);

    expect(result).toHaveLength(roots.length);
    expect(new Set(result)).toEqual(new Set(["missing"]));
    expect(recording.statements).toHaveLength(3);
    for (const statement of recording.statements) {
      expect(statement.query).toContain("json_each(?)");
      const binding = statement.bindings[0];
      expect(typeof binding).toBe("string");
      if (typeof binding === "string") {
        expect(new TextEncoder().encode(binding).byteLength).toBeLessThanOrEqual(1_500_000);
      }
    }
  });

  it("sends a singleton above the JSON page target to SQLite", () => {
    const db = new TestDatabase();
    createFilesystem(db);
    const recording = new RecordingDatabase(db);
    const path = `/${"x".repeat(1_500_000)}`;

    expect(createExactPathStateSource(recording).states([path])).toEqual(["missing"]);
    expect(recording.statements).toHaveLength(1);
    const binding = recording.statements[0]?.bindings[0];
    expect(typeof binding).toBe("string");
    if (typeof binding === "string") {
      expect(new TextEncoder().encode(binding).byteLength).toBeGreaterThan(1_500_000);
    }
  });

  it("accepts a path above the former byte ceiling and still rejects invalid inputs", () => {
    const db = new TestDatabase();
    createFilesystem(db);
    const recording = new RecordingDatabase(db);
    const source = createExactPathStateSource(recording);

    expect(() => source.states(Array.from({ length: 1_025 }, () => "/missing"))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(source.states([`/${"x".repeat(4_096)}`])).toEqual(["missing"]);
    expect(recording.statements).toHaveLength(1);
    for (const path of ["relative", "/not/../canonical", "/trailing/", "/nul\0path"]) {
      expect(() => source.states([path])).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    }
    expect(recording.statements).toHaveLength(1);
  });

  it("fails closed when SQLite returns a malformed state row", () => {
    const db = new TestDatabase();
    createFilesystem(db);

    expect(() =>
      createExactPathStateSource(new CorruptStateDatabase(db)).states(["/"]),
    ).toThrowError(expect.objectContaining({ code: "EIO" }));
  });

  it("fails closed when an exact path points at a missing node", () => {
    const db = new TestDatabase();
    const fs = createFilesystem(db);
    fs.writeFile("/dangling", new Uint8Array());
    db.run(
      "DELETE FROM fs_nodes WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)",
      "/dangling",
    );

    expect(() => createExactPathStateSource(db).states(["/dangling"])).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });

  it("fails closed when an exact path points at an invalid node type", () => {
    const db = new TestDatabase();
    const fs = createFilesystem(db);
    fs.writeFile("/invalid", new Uint8Array());
    db.run("PRAGMA ignore_check_constraints = ON");
    try {
      db.run(
        "UPDATE fs_nodes SET type = 'unknown' WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)",
        "/invalid",
      );

      expect(() => createExactPathStateSource(db).states(["/invalid"])).toThrowError(
        expect.objectContaining({ code: "EIO" }),
      );
    } finally {
      db.run("PRAGMA ignore_check_constraints = OFF");
    }
  });

  it("sanitizes an oversized corrupt node type", () => {
    const db = new TestDatabase();
    const fs = createFilesystem(db);
    fs.writeFile("/invalid-large", new Uint8Array());
    db.run("PRAGMA ignore_check_constraints = ON");
    try {
      db.run(
        "UPDATE fs_nodes SET type = ? WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)",
        "x".repeat(1_500_001),
        "/invalid-large",
      );

      expect(() => createExactPathStateSource(db).states(["/invalid-large"])).toThrowError(
        expect.objectContaining({ code: "EIO" }),
      );
    } finally {
      db.run("PRAGMA ignore_check_constraints = OFF");
    }
  });
});
