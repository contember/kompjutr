import { describe, expect, it } from "vitest";

import { hashObject } from "../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "./helpers/db.js";

const NOW = 1_800_000_000_123;

function open() {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db, { now: () => NOW });
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  return { db, checkout, store: database.openCheckout(checkout) };
}

describe("maintenance schema", () => {
  it("cascades transient run rows while retaining independent grace candidates", () => {
    const { db, checkout } = open();
    const oid = hashObject("blob", new Uint8Array([1]));
    db.run(
      "INSERT INTO git_objects (repo_id, oid, type, size) VALUES (?, ?, 'blob', 1)",
      checkout.repoId,
      oid,
    );
    db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 7, 12, 0, 'complete', ?)`,
      checkout.repoId,
      NOW,
    );
    db.run(
      `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
       VALUES (?, 0, 2)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_runs
         (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
       VALUES (?, 1, 0, 'roots', ?, 'refs')`,
      checkout.repoId,
      NOW,
    );
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, edge_cursor)
       VALUES (?, 1, ?, 1, 0, 0, 0)`,
      checkout.repoId,
      oid,
    );
    db.run(
      "INSERT INTO git_maintenance_shallow (repo_id, run_id, oid) VALUES (?, 1, ?)",
      checkout.repoId,
      oid,
    );
    db.run(
      "INSERT INTO git_loose_gc_candidates (repo_id, oid, unreachable_since_ms) VALUES (?, ?, ?)",
      checkout.repoId,
      oid,
      NOW,
    );
    db.run(
      `INSERT INTO git_pack_gc_candidates (repo_id, pack_id, unreachable_since_ms)
       VALUES (?, 7, ?)`,
      checkout.repoId,
      NOW,
    );

    db.run("DELETE FROM git_maintenance_runs WHERE repo_id = ?", checkout.repoId);

    for (const table of ["git_maintenance_objects", "git_maintenance_shallow"]) {
      expect(db.scalar<number>(`SELECT COUNT(*) FROM ${table}`), table).toBe(0);
    }
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_loose_gc_candidates")).toBe(1);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_gc_candidates")).toBe(1);

    db.run("DELETE FROM git_repositories WHERE id = ?", checkout.repoId);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_maintenance_control")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_loose_gc_candidates")).toBe(0);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_gc_candidates")).toBe(0);
  });
});
