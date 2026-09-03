// Clone-only create path for an absent or provably empty worktree. The caller
// gets no overwrite semantics: eligibility is settled before the body runs,
// and every row written by the session is a plain INSERT.

import type { SqlDatabase } from "../../db/db.js";
import { filesystemError } from "../errors.js";
import { InitialWorktreeSessionImpl } from "./initial-write-session.js";
import type { InitialWorktreeSession, InitialWriteResult } from "./initial-write-types.js";
import { isThenable, rootAncestors, validateCanonicalRoot } from "./initial-write-validation.js";

export type {
  InitialSymlinkOptions,
  InitialWorktreeSession,
  InitialWriteOptions,
  InitialWriteResult,
} from "./initial-write-types.js";

interface PreflightRow {
  ordinal: number;
  requested: string;
  path: string | null;
  type: string | null;
}

interface Preflight {
  rootExists: boolean;
  revision: number;
  nextInode: number;
}

/** Internal create-only writer for clone and eligible first checkout. */
export class InitialWorktreeWriter {
  constructor(
    private readonly db: SqlDatabase,
    private readonly clock: () => number = Date.now,
    private readonly databaseIdentity: (database: unknown) => boolean = () => false,
  ) {}

  supportsDatabase(database: unknown): boolean {
    return this.databaseIdentity(database);
  }

  tryRun<T>(
    rootInput: string,
    body: (session: InitialWorktreeSession) => T,
    afterClose?: (value: T) => unknown,
  ): InitialWriteResult<T> {
    const rootSegments = validateCanonicalRoot(rootInput);
    const root = rootInput;
    return this.db.transactionSync(() => {
      const preflight = this.#preflight(root);
      if (preflight === null) return { kind: "unavailable" };
      const timestamp = this.clock();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw filesystemError("EINVAL", "initial worktree clock returned an invalid timestamp");
      }
      if (preflight.revision === Number.MAX_SAFE_INTEGER) {
        throw filesystemError("E2BIG", "filesystem revision is exhausted");
      }
      const revision = preflight.revision + 1;
      let activeSession: InitialWorktreeSessionImpl | null = null;
      try {
        activeSession = new InitialWorktreeSessionImpl(
          this.db,
          root,
          preflight.rootExists,
          timestamp,
          revision,
          rootSegments,
          preflight.nextInode,
        );
        const value = body(activeSession);
        if (isThenable(value)) {
          throw filesystemError("EINVAL", "initial worktree body must be synchronous");
        }
        activeSession.close(preflight.revision, preflight.nextInode);
        if (afterClose !== undefined) {
          const afterResult = afterClose(value);
          if (isThenable(afterResult)) {
            void Promise.resolve(afterResult).catch(() => {});
            throw filesystemError("EINVAL", "initial worktree afterClose must be synchronous");
          }
        }
        return { kind: "committed", value };
      } finally {
        activeSession?.invalidate();
      }
    });
  }

  #preflight(root: string): Preflight | null {
    const ancestors = rootAncestors(root);
    const ancestorsJson = JSON.stringify(ancestors);
    const subtreeStart = root === "/" ? "/" : `${root}/`;
    const subtreeEnd = root === "/" ? "0" : `${root}0`;
    const rows = this.db.all<PreflightRow>(
      `WITH requested(ordinal, path) AS (
           SELECT CAST(key AS INTEGER), value FROM json_each(?)
         )
         SELECT requested.ordinal, requested.path AS requested,
                path.path, node.type
           FROM requested
           LEFT JOIN fs_paths path ON path.path = requested.path
           LEFT JOIN fs_nodes node ON node.inode = path.inode
          ORDER BY requested.ordinal`,
      ancestorsJson,
    );
    if (rows.length !== ancestors.length) throw new Error("initial worktree preflight lost a row");
    let rootExists = false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const expected = ancestors[index]!;
      if (row.ordinal !== index || row.requested !== expected) {
        throw new Error("initial worktree preflight returned invalid path metadata");
      }
      const final = index === rows.length - 1;
      if (row.path === null) {
        if (!final) return null;
        continue;
      }
      if (row.path !== expected || row.type !== "dir") return null;
      if (final) rootExists = true;
    }
    const descendants =
      root === "/"
        ? this.db.scalar<number>("SELECT count(*) FROM fs_paths WHERE path > '/' AND path < '0'")
        : this.db.scalar<number>(
            "SELECT count(*) FROM fs_paths WHERE path >= ? AND path < ?",
            subtreeStart,
            subtreeEnd,
          );
    if (typeof descendants !== "number" || !Number.isSafeInteger(descendants) || descendants < 0) {
      throw new Error("initial worktree preflight returned an invalid subtree count");
    }
    if (descendants !== 0) return null;
    const revision = this.db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'");
    const nextInode = this.db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'");
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof nextInode !== "number" ||
      !Number.isSafeInteger(nextInode) ||
      nextInode <= 0
    ) {
      throw new Error("filesystem metadata is invalid");
    }
    return { rootExists, revision, nextInode };
  }
}

export function createInitialWorktreeWriter(
  db: SqlDatabase,
  clock: () => number = Date.now,
  databaseIdentity?: (database: unknown) => boolean,
): InitialWorktreeWriter {
  return new InitialWorktreeWriter(db, clock, databaseIdentity);
}
