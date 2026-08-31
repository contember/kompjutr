import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { expectText } from "../common/rows.js";
import { jsonPages } from "./json-pages.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";

export interface ShallowTableOwner {
  readShallowOwned(): Set<string>;
}

export function readShallowOwned(store: ShallowTableOwner): Set<string> {
  return store.readShallowOwned();
}

function requireShallowGeneration(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function advanceShallowRevision(db: SqlDatabase, repoId: number, expected: number): void {
  if (expected === Number.MAX_SAFE_INTEGER) {
    throw new GitError("E2BIG", "shallow revision is exhausted");
  }
  const updated = db.one<{ shallow_revision: unknown }>(
    `UPDATE git_repositories SET shallow_revision = shallow_revision + 1
        WHERE id = ? AND shallow_revision = ?
        RETURNING shallow_revision`,
    repoId,
    expected,
  );
  if (
    updated === undefined ||
    requireShallowGeneration(updated.shallow_revision, "updated shallow revision", 1) !==
      expected + 1
  ) {
    const current = db.scalar<unknown>(
      "SELECT shallow_revision FROM git_repositories WHERE id = ?",
      repoId,
    );
    requireShallowGeneration(current, "stored shallow revision", 0);
    throw new CorruptError("shallow revision changed during synchronous publication");
  }
}

export class ShallowTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  read(): Set<string> {
    return new Set(
      this.db
        .all<{ oid: unknown }>("SELECT oid FROM git_shallow WHERE repo_id = ?", this.repoId)
        .map((row) => expectText(row.oid, "stored shallow object id")),
    );
  }

  set(add: Iterable<string>, remove: Iterable<string> = []): void {
    const checked = function* (oids: Iterable<string>): Generator<string> {
      for (const oid of oids) {
        if (!isOid(oid)) throw new CorruptError(`invalid shallow object id ${oid}`);
        yield oid;
      }
    };
    this.db.transactionSync(() => {
      const shallowRevision = requireShallowGeneration(
        this.db.scalar<unknown>(
          "SELECT shallow_revision FROM git_repositories WHERE id = ?",
          this.repoId,
        ),
        "stored shallow revision",
        0,
      );
      let mutated = false;
      for (const page of jsonPages(checked(remove), "shallow deletion")) {
        mutated = true;
        this.db.run(
          "DELETE FROM git_shallow WHERE repo_id = ? AND oid IN (SELECT value FROM json_each(?))",
          this.repoId,
          page,
        );
      }
      for (const page of jsonPages(checked(add), "shallow update")) {
        mutated = true;
        this.db.run(
          `INSERT OR IGNORE INTO git_shallow (repo_id, oid)
           SELECT ?, value FROM json_each(?)`,
          this.repoId,
          page,
        );
      }
      if (mutated) {
        advanceShallowRevision(this.db, this.repoId, shallowRevision);
        bumpMaintenanceRootEpoch(this.db, this.repoId);
      }
    });
  }
}
