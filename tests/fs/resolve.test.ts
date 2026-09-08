import { describe, expect, it } from "vitest";
import {
  Database,
  type DurableObjectStorageLike,
  type SqlDatabase,
} from "../../packages/do/src/db/db.js";
import { initializeFsSchema } from "../../packages/do/src/fs/schema.js";
import { allocateInodes } from "../../packages/do/src/fs/store/meta.js";
import { realpath, realpathNoFollow, realpaths } from "../../packages/do/src/fs/store/resolve.js";
import type { EntryType } from "../../packages/do/src/fs/types.js";
import { TestDatabase } from "../helpers/db.js";

interface Spec {
  path: string;
  type?: EntryType;
  target?: string;
}

function setup(specs: readonly Spec[]): TestDatabase {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 1_700_000_000_000);
  if (specs.length === 0) return db;
  const first = allocateInodes(db, specs.length);
  specs.forEach((spec, index) => {
    const type = spec.type ?? "file";
    const slash = spec.path.lastIndexOf("/");
    const parent = slash === 0 ? "/" : spec.path.slice(0, slash);
    db.run(
      `INSERT INTO fs_nodes
         (inode, type, mode, mtime, size, rev, nlink, link_target)
       VALUES (?, ?, ?, 0, ?, 0, 1, ?)`,
      first + index,
      type,
      type === "dir" ? 0o755 : type === "symlink" ? 0o777 : 0o644,
      new TextEncoder().encode(spec.target ?? "").length,
      spec.target ?? null,
    );
    db.run(
      "INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)",
      spec.path,
      parent,
      first + index,
    );
  });
  return db;
}

class RecordingDatabase implements SqlDatabase {
  readonly queries: { query: string; bindings: unknown[] }[] = [];

  constructor(private readonly inner: SqlDatabase) {}

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
}

describe("ordered path resolution", () => {
  it.each(["/file/child", "/file/", "/file//", "/file/../target"])(
    "checks a file before consuming the remainder of %s",
    (path) => {
      const db = setup([{ path: "/file" }, { path: "/target" }]);
      expect(() => realpath(db, path)).toThrowError(expect.objectContaining({ code: "ENOTDIR" }));
    },
  );

  it("expands a nested symlink before applying a following parent segment", () => {
    const db = setup([
      { path: "/real", type: "dir" },
      { path: "/real/nested", type: "dir" },
      { path: "/real/target" },
      { path: "/alias", type: "symlink", target: "/real/nested" },
    ]);
    expect(realpath(db, "/alias/../target")).toBe("/real/target");
  });

  it("resolves relative targets from the real link parent", () => {
    const db = setup([
      { path: "/base", type: "dir" },
      { path: "/base/real", type: "dir" },
      { path: "/base/real/nested", type: "dir" },
      { path: "/base/real/target" },
      { path: "/base/alias", type: "symlink", target: "real/nested" },
    ]);
    expect(realpath(db, "/base/alias/../target")).toBe("/base/real/target");
  });

  it("preserves root clamping and non-ASCII components", () => {
    const db = setup([{ path: "/cíl" }, { path: "/odkaz", type: "symlink", target: "../../cíl" }]);
    expect(realpath(db, "/odkaz")).toBe("/cíl");
    expect(realpath(db, "/../../cíl")).toBe("/cíl");
  });

  it("keeps missing leaves available to write operations", () => {
    const db = setup([{ path: "/dir", type: "dir" }]);
    expect(realpath(db, "/dir/missing")).toBe("/dir/missing");
    expect(realpath(db, "/dir/missing/descendant")).toBe("/dir/missing/descendant");
  });

  it("does not escape a missing component through a parent segment", () => {
    const db = setup([{ path: "/important" }]);
    let outcome: unknown;
    try {
      outcome = realpath(db, "/missing/../important");
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toMatchObject({ code: "ENOENT" });
    expect(outcome).not.toBe("/important");
  });

  it("does not escape a missing symlink target through a parent segment", () => {
    const db = setup([
      { path: "/important" },
      { path: "/link", type: "symlink", target: "missing/../important" },
    ]);
    let outcome: unknown;
    try {
      outcome = realpath(db, "/link");
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toMatchObject({ code: "ENOENT" });
    expect(outcome).not.toBe("/important");
  });

  it("leaves only a final named link unresolved for no-follow calls", () => {
    const db = setup([
      { path: "/real", type: "dir" },
      { path: "/real/file" },
      { path: "/alias", type: "symlink", target: "/real" },
    ]);
    expect(realpathNoFollow(db, "/alias")).toBe("/alias");
    expect(realpathNoFollow(db, "/alias/file")).toBe("/real/file");
    expect(realpathNoFollow(db, "/alias/")).toBe("/real");
  });

  it("allows forty follows and rejects the forty-first", () => {
    const specs: Spec[] = [{ path: "/target" }];
    for (let index = 39; index >= 0; index--) {
      specs.push({
        path: `/ok-${index}`,
        type: "symlink",
        target: index === 39 ? "/target" : `/ok-${index + 1}`,
      });
    }
    for (let index = 40; index >= 0; index--) {
      specs.push({
        path: `/loop-${index}`,
        type: "symlink",
        target: index === 40 ? "/target" : `/loop-${index + 1}`,
      });
    }
    const db = setup(specs);
    expect(realpath(db, "/ok-0")).toBe("/target");
    expect(() => realpath(db, "/loop-0")).toThrowError(expect.objectContaining({ code: "ELOOP" }));
  });

  it("resolves paths and symlink targets beyond the former 4096-unit boundary", () => {
    const target = `/${"😀".repeat(2_048)}x`;
    const db = setup([{ path: target }, { path: "/link", type: "symlink", target }]);

    expect(target.length).toBe(4_098);
    expect(realpath(db, target)).toBe(target);
    expect(realpath(db, "/link")).toBe(target);
  });

  it("normalizes an engine-reported long-value failure", () => {
    const storage: DurableObjectStorageLike = {
      sql: {
        exec() {
          throw Object.assign(new Error("value too large"), { code: "SQLITE_TOOBIG" });
        },
      },
    };

    expect(() => realpath(new Database(storage), `/${"x".repeat(4_096)}`)).toThrowError(
      expect.objectContaining({ code: "E2BIG", message: "SQLite rejected a value as too large" }),
    );
  });
});

describe("resolution query shape", () => {
  it("resolves a deep no-symlink path with one indexed, result-bounded statement", () => {
    const depth = 48;
    const specs: Spec[] = [];
    const parts: string[] = [];
    for (let index = 0; index < depth; index++) {
      parts.push(`d${index}`);
      specs.push({ path: `/${parts.join("/")}`, type: "dir" });
    }
    for (let index = 0; index < 200; index++) specs.push({ path: `/noise-${index}` });

    const db = setup(specs);
    const recording = new RecordingDatabase(db);
    const target = `/${parts.join("/")}`;
    db.storage.resetCounters();

    expect(realpath(recording, target)).toBe(target);
    expect(db.storage.statementCount).toBe(1);
    expect(db.storage.rowCount).toBe(depth + 1);
    expect(recording.queries).toHaveLength(1);

    const issued = recording.queries[0];
    if (issued === undefined) throw new Error("resolver issued no statement");
    expect(issued.bindings).toHaveLength(1);
    expect(issued.query).toContain("json_each(?)");
    expect(issued.query).toContain("n.link_target AS link_target");
    expect(issued.query).not.toContain("substr(n.link_target");

    const plan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${issued.query}`, ...issued.bindings)
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("SEARCH p USING PRIMARY KEY (path=?)");
    expect(plan).not.toContain("SCAN p");
  });

  it("batches adversarial aggregate prefix bindings below 1.5 MB", () => {
    const db = setup([]);
    const recording = new RecordingDatabase(db);
    const paths: string[] = [];
    for (let pathIndex = 0; pathIndex < 30; pathIndex++) {
      const parts: string[] = [];
      for (let depth = 0; depth < 200; depth++) parts.push(`p${pathIndex}-${depth}`);
      paths.push(`/${parts.join("/")}`);
    }
    db.storage.resetCounters();

    expect(realpaths(recording, paths)).toEqual(paths);
    expect(recording.queries.length).toBeGreaterThan(1);
    expect(recording.queries.length).toBeLessThan(1_000);
    for (const query of recording.queries) {
      const binding = query.bindings[0];
      expect(typeof binding).toBe("string");
      if (typeof binding === "string") {
        expect(new TextEncoder().encode(binding).byteLength).toBeLessThanOrEqual(1_500_000);
      }
    }
  });
});
