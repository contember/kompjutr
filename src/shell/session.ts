// The persistent working directory.
//
// 60 % of the corpus's command lines carry a `cd X &&` prefix, and none of
// them is a `cd` on its own: the agents are compensating for a directory
// that did not survive the previous call. So the shell owns `cwd` — but a
// Durable Object is evicted whenever it goes idle, which makes a field the
// wrong place for it. It is a row.
//
// Cost: one write per `cd`, and one read per isolate. The value is then
// cached for the isolate's lifetime, which is exactly the lifetime eviction
// invalidates anyway; an exec that does not `cd` pays nothing.

import type { SqlDatabase } from "../db/db.js";

export const SHELL_SCHEMA_VERSION = 1;

export const DEFAULT_CWD = "/";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS shell_sessions (
     session_id TEXT NOT NULL PRIMARY KEY,
     cwd TEXT NOT NULL,
     rev INTEGER NOT NULL DEFAULT 0
   ) WITHOUT ROWID`,
];

export function initializeShellSchema(db: SqlDatabase): void {
  for (const statement of STATEMENTS) db.run(statement);
}

interface SessionRow {
  cwd: string;
}

export class ShellSession {
  #cwd: string | null = null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly sessionId: string,
    private readonly initialCwd: string = DEFAULT_CWD,
  ) {}

  /** One statement the first time, none after that. */
  cwd(): string {
    if (this.#cwd !== null) return this.#cwd;
    const row = this.db.one<SessionRow>(
      "SELECT cwd FROM shell_sessions WHERE session_id = ?",
      this.sessionId,
    );
    this.#cwd = row?.cwd ?? this.initialCwd;
    return this.#cwd;
  }

  /**
   * Persist a new working directory. The caller validates it first — a
   * session must never hold a `cwd` that is not there.
   */
  setCwd(path: string): void {
    if (path === this.#cwd) return;
    this.db.run(
      `INSERT INTO shell_sessions (session_id, cwd, rev) VALUES (?, ?, 1)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, rev = rev + 1`,
      this.sessionId,
      path,
    );
    this.#cwd = path;
  }

  /** Drop the cache, as an eviction would. Used by tests. */
  forget(): void {
    this.#cwd = null;
  }
}
