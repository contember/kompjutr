// Foreign-key enforcement is a connection-level contract owned by the store,
// not an assumption about an adapter's SQLite build defaults.

import { Workspace } from "@cloudflare/computer";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { createSqliteGitClient } from "../src/compat/computer.js";
import { Database, type SqlDatabase } from "../src/sqlite/db.js";
import { SCHEMA_VERSION } from "../src/sqlite/schema.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

interface ForeignKeyDatabase {
  run(query: string, ...bindings: unknown[]): void;
  scalar<T>(query: string, ...bindings: unknown[]): T | undefined;
}

function expectForeignKeysEnabled(db: ForeignKeyDatabase): void {
  expect(db.scalar<unknown>("PRAGMA foreign_keys")).toBe(1);
}

function insertTreeEntry(db: ForeignKeyDatabase, sourceKey: number): void {
  db.run(
    `INSERT INTO git_tree_entries
       (source_key, ordinal, mode, name_bytes, oid, raw_entry, cumulative_base)
     VALUES (?, 0, '100644', ?, ?, ?, 0)`,
    sourceKey,
    new TextEncoder().encode("file"),
    "1".repeat(40),
    new Uint8Array([1]),
  );
}

function insertTreeSource(
  db: ForeignKeyDatabase,
  storage: "loose" | "pack",
  sourceId: number,
  treeOid: string,
): void {
  db.run(
    `INSERT INTO git_tree_sources
       (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
     VALUES (91, ?, ?, ?, 1, 1, 1, 1)`,
    treeOid,
    storage,
    sourceId,
  );
}

function expectEnforcedBehavior(db: ForeignKeyDatabase): void {
  expectForeignKeysEnabled(db);
  db.run("INSERT OR IGNORE INTO git_repositories (id) VALUES (91)");

  expect(() => insertTreeEntry(db, 999)).toThrow(/FOREIGN KEY constraint failed/);

  const sources: readonly {
    storage: "loose" | "pack";
    sourceId: number;
    treeOid: string;
  }[] = [
    { storage: "loose", sourceId: 0, treeOid: "a".repeat(40) },
    { storage: "pack", sourceId: 7, treeOid: "b".repeat(40) },
  ];
  for (const source of sources) {
    insertTreeSource(db, source.storage, source.sourceId, source.treeOid);
    const sourceKey = db.scalar<number>(
      `SELECT source_key FROM git_tree_sources
        WHERE repo_id = 91 AND tree_oid = ? AND storage = ? AND source_id = ?`,
      source.treeOid,
      source.storage,
      source.sourceId,
    );
    if (sourceKey === undefined) throw new Error("tree source insert did not return a key");
    insertTreeEntry(db, sourceKey);

    // Delete the parent directly so no explicit cleanup path can hide a failed cascade.
    db.run(
      `DELETE FROM git_tree_sources
       WHERE repo_id = 91 AND tree_oid = ? AND storage = ? AND source_id = ?`,
      source.treeOid,
      source.storage,
      source.sourceId,
    );
    expect(
      db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries WHERE source_key = ?", sourceKey),
    ).toBe(0);
  }
}

class IgnoringForeignKeysDatabase implements SqlDatabase {
  readonly inner = new TestDatabase();

  run(query: string, ...bindings: unknown[]): void {
    if (query === "PRAGMA foreign_keys = ON") return;
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
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

describe("foreign-key contract", () => {
  it("enforces foreign keys through TestDatabase on fresh and reopened stores", () => {
    const storage = new SqliteTestStorage();
    const fresh = new TestDatabase(storage);
    fresh.run("PRAGMA foreign_keys = OFF");

    new SqliteGitDatabase(fresh);
    expectEnforcedBehavior(fresh);

    fresh.run("PRAGMA foreign_keys = OFF");
    const reopened = new TestDatabase(storage);
    new SqliteGitDatabase(reopened);
    expectForeignKeysEnabled(reopened);
  });

  it("preserves current loose and packed tree sources across reopen", () => {
    const storage = new SqliteTestStorage();
    const first = new TestDatabase(storage);
    first.run("PRAGMA foreign_keys = OFF");
    new SqliteGitDatabase(first);
    first.run("INSERT INTO git_repositories (id) VALUES (91)");

    insertTreeSource(first, "loose", 0, "a".repeat(40));
    const looseKey = first.scalar<number>(
      "SELECT source_key FROM git_tree_sources WHERE repo_id = 91 AND storage = 'loose'",
    );
    if (looseKey === undefined) throw new Error("loose tree source missing");
    insertTreeEntry(first, looseKey);
    insertTreeSource(first, "pack", 7, "b".repeat(40));
    const packKey = first.scalar<number>(
      "SELECT source_key FROM git_tree_sources WHERE repo_id = 91 AND storage = 'pack'",
    );
    if (packKey === undefined) throw new Error("packed tree source missing");
    insertTreeEntry(first, packKey);
    expect(first.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'")).toBe(
      String(SCHEMA_VERSION),
    );

    first.run("PRAGMA foreign_keys = OFF");
    const reopened = new TestDatabase(storage);
    new SqliteGitDatabase(reopened);

    expectForeignKeysEnabled(reopened);
    expect(
      reopened.all<{ storage: string; source_id: number; tree_oid: string }>(
        `SELECT storage, source_id, tree_oid
         FROM git_tree_sources WHERE repo_id = 91 ORDER BY source_id`,
      ),
    ).toEqual([
      { storage: "loose", source_id: 0, tree_oid: "a".repeat(40) },
      { storage: "pack", source_id: 7, tree_oid: "b".repeat(40) },
    ]);
    expect(
      reopened.all<{ storage: string; source_id: number; tree_oid: string }>(
        `SELECT storage, source_id, tree_oid
         FROM git_tree_entries_wide WHERE repo_id = 91 ORDER BY source_id`,
      ),
    ).toEqual([
      { storage: "loose", source_id: 0, tree_oid: "a".repeat(40) },
      { storage: "pack", source_id: 7, tree_oid: "b".repeat(40) },
    ]);
  });

  it("enforces foreign keys through the Durable Object database adapter", () => {
    const storage = new SqliteTestStorage();
    storage.db.exec("PRAGMA foreign_keys = OFF");
    const db = new Database(storage);

    new SqliteGitDatabase(db);

    expectEnforcedBehavior(db);
  });

  it("enforces foreign keys through the Computer provider adapter", async () => {
    const storage = new SqliteTestStorage();
    storage.db.exec("PRAGMA foreign_keys = OFF");
    const workspace = new Workspace({ storage, git: createSqliteGitClient() });

    await workspace.git.init({});

    expectEnforcedBehavior(workspace.provider().db);
  });

  it("enforces foreign keys after a real workerd Durable Object reopen", async () => {
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        compatibilityDate: "2026-08-20",
        durableObjects: { PROBE: { className: "ForeignKeyProbe", useSQLite: true } },
        script: `
          export class ForeignKeyProbe {
            constructor(state) {
              this.state = state;
              const sql = state.storage.sql;
              this.before = [...sql.exec("PRAGMA foreign_keys")][0].foreign_keys;
              sql.exec("PRAGMA foreign_keys = ON");
              this.after = [...sql.exec("PRAGMA foreign_keys")][0].foreign_keys;
              sql.exec("CREATE TABLE IF NOT EXISTS fk_probe (value INTEGER NOT NULL)");
            }

            fetch(request) {
              const path = new URL(request.url).pathname;
              const sql = this.state.storage.sql;
              if (path === "/seed") {
                sql.exec("INSERT INTO fk_probe VALUES (7)");
              } else if (path === "/disable-and-abort") {
                sql.exec("PRAGMA foreign_keys = OFF");
                this.state.abort("foreign-key reopen witness");
              }
              const rows = [...sql.exec("SELECT COUNT(*) AS count FROM fk_probe")];
              return Response.json({ before: this.before, after: this.after, rows: rows[0].count });
            }
          }

          export default {
            fetch(request, env) {
              const id = env.PROBE.idFromName("contract");
              return env.PROBE.get(id).fetch(request);
            }
          };
        `,
      }),
    );

    try {
      const initial = await miniflare.dispatchFetch("http://localhost/seed");
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({ before: 1, after: 1, rows: 1 });

      const eviction = await miniflare.dispatchFetch("http://localhost/disable-and-abort");
      expect(eviction.status).toBe(500);
      expect(await eviction.text()).toContain("foreign-key reopen witness");

      const reopened = await miniflare.dispatchFetch("http://localhost/inspect");
      expect(reopened.status).toBe(200);
      expect(await reopened.json()).toEqual({ before: 1, after: 1, rows: 1 });
    } finally {
      await miniflare.dispose();
    }
  });

  it("fails before schema initialization when an adapter cannot enable enforcement", () => {
    const db = new IgnoringForeignKeysDatabase();
    db.inner.run("PRAGMA foreign_keys = OFF");

    expect(() => new SqliteGitDatabase(db)).toThrow(
      "SQLite adapter did not enable foreign-key enforcement",
    );
    expect(
      db.inner.scalar<number>(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'git_meta'",
      ),
    ).toBe(0);
  });
});
