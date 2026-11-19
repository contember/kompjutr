// The shell schema is versioned, and a database written before the version
// was recorded opens, keeps its sessions, and is migrated forward.
import { describe, expect, it } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { SHELL_SCHEMA_VERSION } from "../../packages/do/src/shell/schema.js";
import { TestDatabase } from "../helpers/db.js";

// Exactly what @kompjutr/do@0.1.7 and earlier ran; never edit.
const VERSION_ONE_STATEMENT = `CREATE TABLE IF NOT EXISTS shell_sessions (
     session_id TEXT NOT NULL PRIMARY KEY,
     cwd TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 0
   ) WITHOUT ROWID`;

const ENCODER = new TextEncoder();

function withRepo(db: TestDatabase) {
  const fs = createFilesystem(db, { now: () => 1700000000000 });
  fs.writeFiles([{ path: "/repo/src/alpha.ts", bytes: ENCODER.encode("alpha\n") }]);
  return fs;
}

function schemaSql(db: TestDatabase): unknown[] {
  return db.all(
    "SELECT name, sql FROM sqlite_schema WHERE name LIKE 'shell\\_%' ESCAPE '\\' ORDER BY name",
  );
}

function storedVersion(db: TestDatabase): unknown {
  return db.scalar("SELECT v FROM shell_meta WHERE k = 'schema_version'");
}

function versionOneDatabase(): TestDatabase {
  const db = new TestDatabase();
  db.run(VERSION_ONE_STATEMENT);
  db.run("INSERT INTO shell_sessions (session_id, cwd, rev) VALUES ('agent-1', '/repo/src', 3)");
  return db;
}

describe("shell schema", () => {
  it("records the current version on a new database", () => {
    const db = new TestDatabase();
    createShell({ fs: withRepo(db) });
    expect(storedVersion(db)).toBe(SHELL_SCHEMA_VERSION);
  });

  it("migrates a version 1 database and keeps its sessions", async () => {
    const db = versionOneDatabase();
    const shell = createShell({ fs: withRepo(db), sessionId: "agent-1", cwd: "/" });

    expect(shell.cwd()).toBe("/repo/src");
    expect((await shell.run("ls")).stdout).toBe("alpha.ts\n");
    expect(storedVersion(db)).toBe(SHELL_SCHEMA_VERSION);

    const fresh = new TestDatabase();
    createShell({ fs: withRepo(fresh) });
    expect(schemaSql(db)).toEqual(schemaSql(fresh));

    await shell.run("cd ..");
    expect(db.one("SELECT cwd, rev FROM shell_sessions WHERE session_id = 'agent-1'")).toEqual({
      cwd: "/repo",
      rev: 4,
    });
    // Reopening the migrated database is the ordinary current-version path.
    expect(createShell({ fs: withRepo(db), sessionId: "agent-1" }).cwd()).toBe("/repo");
  });

  it("refuses a version it does not know", () => {
    const db = new TestDatabase();
    const fs = withRepo(db);
    createShell({ fs });
    db.run("UPDATE shell_meta SET v = ? WHERE k = 'schema_version'", SHELL_SCHEMA_VERSION + 1);
    expect(() => createShell({ fs })).toThrow(
      expect.objectContaining({ code: "EIO", message: expect.stringMatching(/unsupported/) }),
    );
  });

  it("refuses an unversioned table that is not version 1", () => {
    const db = new TestDatabase();
    db.run("CREATE TABLE shell_sessions (session_id TEXT PRIMARY KEY, cwd TEXT)");
    expect(() => createShell({ fs: withRepo(db) })).toThrow(
      expect.objectContaining({ code: "EIO" }),
    );
  });
});
