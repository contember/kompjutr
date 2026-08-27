import { describe, expect, it } from "vitest";
import { utf8 } from "../src/core/bytes.js";
import { assertRepositoryReadable, reopenTestRepository } from "./helpers/repository-invariants.js";
import { makeRepo } from "./helpers/workspace.js";

const MISSING_OID = "0000000000000000000000000000000000000000";

function addReadableState(): ReturnType<typeof makeRepo> {
  const workspace = makeRepo();
  const blob = workspace.repo.store.write("blob", utf8.encode("durable\n"));
  workspace.repo.store.setRef("refs/tags/durable", blob);
  workspace.repo.checkout.indexPut({
    path: "durable.txt",
    stage: 0,
    mode: 0o100644,
    oid: blob,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  });
  return workspace;
}

describe("repository interleaving invariants", () => {
  it("reopens fresh handles over the same durable repository state", () => {
    const workspace = addReadableState();

    const cold = reopenTestRepository(workspace);

    expect(cold.repo).not.toBe(workspace.repo);
    expect(cold.repo.store).not.toBe(workspace.repo.store);
    expect(cold.database).not.toBe(workspace.database);
    expect(cold.worktree).not.toBe(workspace.worktree);
    expect(cold.repo.store.getRef("refs/tags/durable")).toBe(
      workspace.repo.store.getRef("refs/tags/durable"),
    );
    expect(() => assertRepositoryReadable(cold.repo)).not.toThrow();
  });

  it("does not reuse a warm object cache after cold reopen", () => {
    const workspace = addReadableState();
    const oid = workspace.repo.store.getRef("refs/tags/durable");
    if (oid === null) throw new Error("missing durable fixture ref");
    workspace.repo.read(oid);
    workspace.database.db.run(
      "DELETE FROM git_objects WHERE repo_id = ? AND oid = ?",
      workspace.repo.store.repoId,
      oid,
    );

    expect(() => workspace.repo.read(oid)).not.toThrow();
    const cold = reopenTestRepository(workspace);
    expect(() => cold.repo.read(oid)).toThrow();
    expect(() => assertRepositoryReadable(cold.repo)).toThrow();
  });

  it("fails closed when a visible ref does not resolve", () => {
    const workspace = addReadableState();
    workspace.database.db.run(
      "UPDATE git_refs SET target = ? WHERE repo_id = ? AND name = ?",
      MISSING_OID,
      workspace.repo.store.repoId,
      "refs/tags/durable",
    );

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow();
  });

  it("guards an oversized stored ref target before returning it to JavaScript", () => {
    const workspace = addReadableState();
    workspace.database.db.run(
      "UPDATE git_refs SET target = zeroblob(2097152) WHERE repo_id = ? AND name = ?",
      workspace.repo.store.repoId,
      "refs/tags/durable",
    );

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow(
      "interleaving invariant target of refs/tags/durable is invalid",
    );
  });

  it("reads referenced payload bytes after metadata validation", () => {
    const workspace = addReadableState();
    const blob = workspace.repo.store.write("blob", new Uint8Array(8 * 1024));
    workspace.repo.store.setRef("refs/tags/compressed", blob);
    workspace.database.db.run(
      `UPDATE git_object_chunks SET data = zeroblob(length(data))
        WHERE repo_id = ? AND oid = ?`,
      workspace.repo.store.repoId,
      blob,
    );

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow();
  });

  it("fails closed when a non-gitlink index object does not resolve", () => {
    const workspace = addReadableState();
    workspace.database.db.run(
      "UPDATE git_index SET oid = ? WHERE checkout_id = ? AND path = ?",
      MISSING_OID,
      workspace.repo.checkout.checkoutId,
      "durable.txt",
    );

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow();
  });

  it("guards and validates malformed index rows before using them", () => {
    const workspace = addReadableState();
    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    try {
      workspace.database.db.run(
        "UPDATE git_index SET mode = 1.5 WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "durable.txt",
      );
    } finally {
      workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
    }

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow(
      "interleaving invariant index mode is invalid",
    );
  });

  it("distinguishes invalid index metadata from a legitimate null", () => {
    const workspace = addReadableState();
    workspace.database.db.run("PRAGMA ignore_check_constraints = ON");
    try {
      workspace.database.db.run(
        "UPDATE git_index SET size = 1.5 WHERE checkout_id = ? AND path = ?",
        workspace.repo.checkout.checkoutId,
        "durable.txt",
      );
    } finally {
      workspace.database.db.run("PRAGMA ignore_check_constraints = OFF");
    }

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow(
      "interleaving invariant index size is invalid",
    );
  });

  it("requires a complete tracker baseline to name a tree", () => {
    const workspace = addReadableState();
    const blob = workspace.repo.store.write("blob", utf8.encode("not a tree\n"));
    workspace.database.db.run(
      `INSERT INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
       VALUES (?, ?, 1, 1)
       ON CONFLICT(checkout_id) DO UPDATE SET
         baseline_tree_oid = excluded.baseline_tree_oid,
         format = excluded.format,
         complete = excluded.complete`,
      workspace.repo.checkout.checkoutId,
      blob,
    );

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow(
      "interleaving invariant index baseline is not a tree",
    );
  });

  it("reads the complete tracker baseline payload after reopen", () => {
    const workspace = addReadableState();
    const tree = workspace.repo.store.write("tree", new Uint8Array());
    workspace.database.db.run(
      `INSERT INTO git_index_state (checkout_id, baseline_tree_oid, format, complete)
       VALUES (?, ?, 1, 1)
       ON CONFLICT(checkout_id) DO UPDATE SET
         baseline_tree_oid = excluded.baseline_tree_oid,
         format = excluded.format,
         complete = excluded.complete`,
      workspace.repo.checkout.checkoutId,
      tree,
    );
    workspace.database.db.run(
      "UPDATE git_object_chunks SET data = x'01' WHERE repo_id = ? AND oid = ?",
      workspace.repo.store.repoId,
      tree,
    );

    const cold = reopenTestRepository(workspace);
    expect(() => assertRepositoryReadable(cold.repo)).toThrow();
  });

  it("streams its bounded row checks within the operation statement limit", () => {
    const workspace = addReadableState();
    const oid = workspace.repo.store.getRef("refs/tags/durable");
    if (oid === null) throw new Error("missing durable fixture ref");
    workspace.database.db.run(
      `WITH RECURSIVE sequence(ordinal) AS (
         VALUES (0)
         UNION ALL SELECT ordinal + 1 FROM sequence WHERE ordinal < 4096
       )
       INSERT INTO git_refs (repo_id, name, target)
       SELECT ?, printf('refs/tags/bulk-%04d', ordinal), ? FROM sequence`,
      workspace.repo.store.repoId,
      oid,
    );
    workspace.storage.resetCounters();

    assertRepositoryReadable(workspace.repo);

    expect(workspace.storage.rowCount).toBeGreaterThan(4_096);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("bounds worst-case symbolic ref resolution below the statement limit", () => {
    const workspace = addReadableState();
    const oid = workspace.repo.store.getRef("refs/tags/durable");
    if (oid === null) throw new Error("missing durable fixture ref");
    workspace.repo.store.setRef("refs/tags/chain-6", oid);
    for (let ordinal = 5; ordinal >= 0; ordinal--) {
      workspace.repo.store.setRef(
        `refs/tags/chain-${ordinal}`,
        `ref: refs/tags/chain-${ordinal + 1}`,
      );
    }
    for (let ordinal = 0; ordinal < 32; ordinal++) {
      workspace.repo.store.setRef(`refs/tags/root-${ordinal}`, "ref: refs/tags/chain-0");
    }
    workspace.storage.resetCounters();

    assertRepositoryReadable(workspace.repo);

    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });
});
