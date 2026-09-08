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
  it("records loose births atomically for scalar, streamed, and batch writes", () => {
    const { db, store } = open();
    const scalar = store.write("blob", new Uint8Array([1]));
    const rawStreamedData = new Uint8Array([2, 2]);
    const rawStreamed = store.writeStream("blob", rawStreamedData.length, () => [rawStreamedData]);
    const streamedData = new Uint8Array(5_000).fill(2);
    const streamed = store.writeStream("blob", streamedData.length, () => [streamedData]);
    const batched = store.writeObjects((batch) => [
      batch.write("blob", new Uint8Array([3])),
      batch.write("blob", new Uint8Array([4])),
    ]);

    const expected = [scalar, rawStreamed, streamed, ...batched].sort();
    expect(
      db
        .all<{ oid: string; created_ms: number }>(
          `SELECT oid, created_ms FROM git_loose_object_lifecycle
            WHERE repo_id = ? ORDER BY oid COLLATE BINARY`,
          store.sharedRepoId,
        )
        .map((row) => row.oid),
    ).toEqual(expected);
    expect(
      db.all<{ created_ms: number }>("SELECT created_ms FROM git_loose_object_lifecycle"),
    ).toEqual(expected.map(() => ({ created_ms: NOW })));
    expect(
      db.scalar<string>(
        "SELECT stored FROM git_objects WHERE repo_id = ? AND oid = ?",
        store.sharedRepoId,
        rawStreamed,
      ),
    ).toBe("raw");
  });

  it("rolls every loose write path back when its lifecycle insert fails", () => {
    const writers = [
      (store: ReturnType<typeof open>["store"]) => store.write("blob", new Uint8Array([1])),
      (store: ReturnType<typeof open>["store"]) =>
        store.writeStream("blob", 2, () => [new Uint8Array([2, 2])]),
      (store: ReturnType<typeof open>["store"]) =>
        store.writeStream("blob", 5_000, () => [new Uint8Array(5_000).fill(2)]),
      (store: ReturnType<typeof open>["store"]) =>
        store.writeObjects((batch) => batch.write("blob", new Uint8Array([3]))),
    ];

    for (const write of writers) {
      const { db, store } = open();
      db.run(`CREATE TRIGGER fail_loose_lifecycle
        BEFORE INSERT ON git_loose_object_lifecycle
        BEGIN SELECT RAISE(ABORT, 'injected lifecycle failure'); END`);

      expect(() => write(store)).toThrow(/injected lifecycle failure/);
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_objects")).toBe(0);
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_object_chunks")).toBe(0);
      expect(db.scalar<number>("SELECT COUNT(*) FROM git_loose_object_lifecycle")).toBe(0);
    }
  });

  it("allows one oversized repack object but rejects an oversized multi-object batch", () => {
    const { db, checkout } = open();
    db.run(
      `INSERT INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
       VALUES (?, 0, 2)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_runs
         (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source)
       VALUES (?, 1, 0, 'repack', ?, 'done')`,
      checkout.repoId,
      NOW,
    );
    const insert = `INSERT INTO git_maintenance_repack_batches
      (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
      VALUES (?, 1, ?, 'selected', NULL, ?, ?, 0)`;

    db.run(insert, checkout.repoId, 1, 2_048, 32 * 1024 * 1024);
    db.run("DELETE FROM git_maintenance_repack_batches WHERE repo_id = ?", checkout.repoId);
    expect(() => db.run(insert, checkout.repoId, 2, 2_048, 32 * 1024 * 1024 + 1)).toThrow(
      /CHECK constraint/,
    );
    db.run(insert, checkout.repoId, 3, 1, Number.MAX_SAFE_INTEGER);

    expect(
      db.one<{ object_count: number; inflated_bytes: number }>(
        `SELECT object_count, inflated_bytes FROM git_maintenance_repack_batches
          WHERE repo_id = ?`,
        checkout.repoId,
      ),
    ).toEqual({ object_count: 1, inflated_bytes: Number.MAX_SAFE_INTEGER });
  });

  it("cascades transient run rows while retaining independent grace candidates", () => {
    const { db, checkout } = open();
    const oid = hashObject("blob", new Uint8Array([1]));
    db.run(
      `INSERT INTO git_objects (repo_id, oid, type, size, stored)
       VALUES (?, ?, 'blob', 1, 'raw')`,
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
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
       VALUES (?, 1, ?, 1, 0, 0, 0, 0)`,
      checkout.repoId,
      oid,
    );
    db.run(
      "INSERT INTO git_maintenance_shallow (repo_id, run_id, oid) VALUES (?, 1, ?)",
      checkout.repoId,
      oid,
    );
    db.run(
      `INSERT INTO git_maintenance_repack_batches
         (repo_id, run_id, batch_id, state, pack_id, object_count, inflated_bytes, stored_bytes)
       VALUES (?, 1, 1, 'selected', NULL, 1, 1, 0)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_repack_objects
         (repo_id, run_id, batch_id, oid, ordinal, type, size)
       VALUES (?, 1, 1, ?, 0, 'blob', 1)`,
      checkout.repoId,
      oid,
    );
    for (const state of ["pending", "published"]) {
      expect(() =>
        db.run(
          "UPDATE git_maintenance_repack_batches SET state = ?, pack_id = 8 WHERE repo_id = ?",
          state,
          checkout.repoId,
        ),
      ).toThrow(/FOREIGN KEY constraint/);
    }
    db.run(
      `UPDATE git_maintenance_repack_batches
          SET state = 'pending', pack_id = 7 WHERE repo_id = ?`,
      checkout.repoId,
    );
    expect(() =>
      db.run("DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = 7", checkout.repoId),
    ).toThrow(/FOREIGN KEY constraint/);
    db.run(
      `UPDATE git_maintenance_repack_batches
          SET state = 'selected', pack_id = NULL WHERE repo_id = ?`,
      checkout.repoId,
    );
    db.run("DELETE FROM git_pack_meta WHERE repo_id = ? AND pack_id = 7", checkout.repoId);
    expect(db.scalar<number>("SELECT COUNT(*) FROM git_pack_meta")).toBe(0);
    db.run(
      `INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created)
       VALUES (?, 7, 12, 0, 'complete', ?)`,
      checkout.repoId,
      NOW,
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

    for (const table of [
      "git_maintenance_objects",
      "git_maintenance_shallow",
      "git_maintenance_repack_batches",
      "git_maintenance_repack_objects",
    ]) {
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
