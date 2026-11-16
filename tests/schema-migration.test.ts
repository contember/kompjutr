import { readFileSync } from "node:fs";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit } from "../packages/git/src/client.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { SCHEMA_VERSION } from "../packages/git/src/store/schema/schema.js";
import {
  MIGRATED_REPOSITORIES,
  VERSION_ONE_REPOSITORIES,
  VERSION_ONE_REPOSITORY_ALTERATIONS,
} from "../packages/git/src/store/schema/schema-version-one.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const ENCODER = new TextEncoder();
const FIXTURE = readFileSync(new URL("./fixtures/workspace-0.1.4.sql", import.meta.url), "utf8");

/** Storage holding exactly what 0.1.4 wrote. */
function storeFrom014(): SqliteTestStorage {
  const storage = new SqliteTestStorage();
  storage.db.exec(`BEGIN; ${FIXTURE} COMMIT;`);
  return storage;
}

function open(storage: SqliteTestStorage): Workspace {
  return new Workspace({
    storage,
    git: createGit(),
    defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    now: () => 1577836800000,
  });
}

/** Open the Git store directly; a Workspace opens it lazily on first use. */
function openGit(storage: SqliteTestStorage): void {
  new SqliteGitDatabase(new TestDatabase(storage));
}

function schemaVersion(storage: SqliteTestStorage): unknown {
  return storage.db.prepare("SELECT value FROM git_meta WHERE key = 'schema_version'").get()?.value;
}

function schemaSql(storage: SqliteTestStorage): unknown[] {
  return storage.db
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE name LIKE 'git\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all();
}

describe("git schema migration from 0.1.4", () => {
  it("opens and uses a store 0.1.4 created", async () => {
    const storage = storeFrom014();
    const workspace = open(storage);

    expect((await workspace.git.log({ dir: "/work" })).map((commit) => commit.message)).toEqual([
      "second\n",
      "base\n",
    ]);
    expect(schemaVersion(storage)).toBe(String(SCHEMA_VERSION));
    workspace.filesystem.writeFile("/work/a.txt", ENCODER.encode("three\n"));
    await workspace.git.add({ dir: "/work", paths: ["a.txt"] });
    await workspace.git.commit({ dir: "/work", message: "third" });
    expect(
      await workspace.git.runCli({ argv: ["status", "--porcelain"], cwd: "/work" }),
    ).toMatchObject({ stdout: "", exitCode: 0 });

    // The deleted repository 3 stays retired.
    workspace.filesystem.mkdir("/fresh");
    await workspace.git.init({ dir: "/fresh" });
    expect(storage.db.prepare("SELECT max(id) AS id FROM git_repositories").get()?.id).toBe(4);

    for (let step = 0; step < 100; step++) {
      const result = await workspace.git.maintenance({ dir: "/work" });
      if (result.status !== "progress") break;
    }
    expect(storage.db.prepare("SELECT root_source FROM git_maintenance_runs").all()).toEqual([
      { root_source: "done" },
    ]);
  });

  it("keeps the 0.1.6 constraints on the migrated repository table", () => {
    const storage = storeFrom014();
    openGit(storage);

    expect(() =>
      storage.db.exec(
        "UPDATE git_repositories SET kind = 'bare', lifecycle = 'provisional', clone_expires_ms = 1 WHERE id = 2",
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      storage.db.exec("UPDATE git_repositories SET default_branch = 'main' WHERE id = 2"),
    ).toThrow(/CHECK constraint failed/);
    expect(
      storage.db.prepare("SELECT id, kind, default_branch FROM git_repositories ORDER BY id").all(),
    ).toEqual([
      { id: 1, kind: "workspace", default_branch: "refs/heads/main" },
      { id: 2, kind: "workspace", default_branch: "refs/heads/main" },
    ]);
  });

  it("keeps maintenance run progress exactly", () => {
    const storage = storeFrom014();
    const runs = storage.db.prepare("SELECT * FROM git_maintenance_runs ORDER BY repo_id").all();
    const queued = storage.db.prepare("SELECT * FROM git_maintenance_objects ORDER BY oid").all();
    expect(runs).toHaveLength(1);

    openGit(storage);

    expect(storage.db.prepare("SELECT * FROM git_maintenance_runs ORDER BY repo_id").all()).toEqual(
      runs,
    );
    expect(storage.db.prepare("SELECT * FROM git_maintenance_objects ORDER BY oid").all()).toEqual(
      queued,
    );
  });

  it("is idempotent: a migrated store reopens unchanged", () => {
    const storage = storeFrom014();
    openGit(storage);
    const migrated = schemaSql(storage);

    openGit(storage);

    expect(schemaSql(storage)).toEqual(migrated);
    expect(schemaVersion(storage)).toBe(String(SCHEMA_VERSION));
  });

  it("renumbers a version-one store 0.1.5 or 0.1.6 created", () => {
    const storage = new SqliteTestStorage();
    openGit(storage);
    const current = schemaSql(storage);
    storage.db.exec("UPDATE git_meta SET value = '1' WHERE key = 'schema_version'");

    openGit(storage);

    expect(schemaVersion(storage)).toBe(String(SCHEMA_VERSION));
    expect(schemaSql(storage)).toEqual(current);
  });

  it("refuses a version-one store that matches neither shape, without changing it", () => {
    const storage = storeFrom014();
    storage.db.exec("CREATE INDEX git_stray ON git_meta (value)");
    const before = schemaSql(storage);

    expect(() => openGit(storage)).toThrow(/unexpected object git_stray/);

    expect(schemaSql(storage)).toEqual(before);
    expect(schemaVersion(storage)).toBe("1");
  });

  it("alters the repository table to the accepted text in workerd, keeping child rows", async () => {
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        compatibilityDate: "2026-08-20",
        durableObjects: { PROBE: { className: "AlterProbe", useSQLite: true } },
        script: `
          export class AlterProbe {
            constructor(state) { this.state = state; }
            fetch() {
              const { sql } = this.state.storage;
              sql.exec(${JSON.stringify(VERSION_ONE_REPOSITORIES)});
              sql.exec(\`CREATE TABLE child (
                repo_id INTEGER NOT NULL REFERENCES git_repositories (id) ON DELETE CASCADE)\`);
              sql.exec("INSERT INTO git_repositories (id) VALUES (1)");
              sql.exec("INSERT INTO child (repo_id) VALUES (1)");
              this.state.storage.transactionSync(() => {
                for (const statement of ${JSON.stringify(VERSION_ONE_REPOSITORY_ALTERATIONS)}) {
                  sql.exec(statement);
                }
              });
              const [table] = [...sql.exec(
                "SELECT sql FROM sqlite_schema WHERE name = 'git_repositories'")];
              const [child] = [...sql.exec("SELECT count(*) AS rows FROM child")];
              return Response.json({ sql: table.sql, children: child.rows });
            }
          }
          export default {
            fetch(request, env) {
              return env.PROBE.get(env.PROBE.idFromName("alter")).fetch(request);
            }
          };
        `,
      }),
    );
    try {
      const response = await miniflare.dispatchFetch("http://localhost/");
      expect(await response.json()).toEqual({
        sql: MIGRATED_REPOSITORIES.replace(" IF NOT EXISTS", ""),
        children: 1,
      });
    } finally {
      await miniflare.dispose();
    }
  });
});
