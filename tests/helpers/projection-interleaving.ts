// The ADR-0030 interleaving scenario, shared by the Node adapters and a
// Miniflare Durable Object so all run the same code. It imports nothing Node-only.

import type { SqlDatabase } from "../../packages/do/src/db/db.js";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createSqliteSparseCapability } from "../../packages/git/src/do-fs/index.js";
import { initializeIndexTracker } from "../../packages/git/src/do-fs/indexes/index-tracker.js";
import { checkoutTree } from "../../packages/git/src/ops/checkout/checkout.js";
import type { GitContext } from "../../packages/git/src/ops/core/context.js";
import { merge } from "../../packages/git/src/ops/merge/merge.js";
import { initRepository } from "../../packages/git/src/ops/repository/init.js";
import { status } from "../../packages/git/src/ops/status/status-core.js";
import { formatPorcelainV1 } from "../../packages/git/src/ops/status/status-format.js";
import { SqliteGitDatabase } from "../../packages/git/src/store/index.js";

export interface InterleavingInput {
  /** A pack holding every object of the fixture. */
  pack: Uint8Array;
  refs: { name: string; target: string }[];
  /** The incoming branch the merge takes. */
  theirs: string;
  /** A path and contents the worktree changes before status. */
  dirty: { path: string; text: string };
}

export interface InterleavingResult {
  statusFault: string;
  statusFaultRows: number;
  porcelain: string;
  mergeFault: string;
  rowsBeforeMergeFault: number;
  rowsAfterMergeFault: number;
  mergeTree: string;
  unclosedSubtrees: number;
}

/**
 * Throws from the `armed`-th marker write of an on-demand closure: the
 * unseeded marker only object-sourced projection emits. The entries of that
 * closure are already written, so the fault lands mid-closure.
 */
export class ClosureFaultDatabase implements SqlDatabase {
  readonly mutationScope: object | undefined;
  #armed = 0;
  #seen = 0;

  constructor(private readonly inner: SqlDatabase) {
    this.mutationScope = inner.mutationScope;
  }

  arm(closure: number): void {
    this.#armed = closure;
    this.#seen = 0;
  }

  run(query: string, ...bindings: unknown[]): void {
    if (
      this.#armed > 0 &&
      query.startsWith("INSERT INTO git_tree_sources") &&
      ++this.#seen === this.#armed
    ) {
      throw new Error(`injected closure fault ${this.#armed}`);
    }
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

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}

/** Status over an unprojected HEAD, then a merge whose base and incoming trees are unprojected. */
export async function runInterleaving(
  db: ClosureFaultDatabase,
  input: InterleavingInput,
): Promise<InterleavingResult> {
  const now = () => 1_577_836_800_000;
  const context: GitContext = {
    database: new SqliteGitDatabase(db),
    worktree: createFilesystem(db, { now }),
    sparseWorkspace: createSqliteSparseCapability(db).workspace,
    now,
    timezoneOffset: () => 0,
  };
  initializeIndexTracker(db);
  const repo = initRepository(context, { dir: "/repo" });
  await repo.store.packs.ingest(
    (async function* () {
      yield input.pack;
    })(),
  );
  for (const ref of input.refs) repo.store.setRef(ref.name, ref.target);
  repo.store.configSet("user.name", "Fixture");
  repo.store.configSet("user.email", "fixture@example.com");
  checkoutTree(repo, context.worktree, repo.headTree());
  context.worktree.writeFiles([
    {
      path: `/repo/${input.dirty.path}`,
      bytes: new TextEncoder().encode(input.dirty.text),
      mode: 0o644,
    },
  ]);
  // The empty projected set is downward-closed: the state right after a clone's ingest.
  db.transactionSync(() => db.run("DELETE FROM git_tree_sources"));
  const rows = () => db.scalar<number>("SELECT count(*) FROM git_tree_sources") ?? -1;

  db.arm(1);
  const statusFault = errorMessage(() => status(repo, context.worktree));
  const statusFaultRows = rows();
  db.arm(0);
  const porcelain = formatPorcelainV1(status(repo, context.worktree));

  const rowsBeforeMergeFault = rows();
  db.arm(2);
  const mergeFault = errorMessage(() =>
    merge(context, repo, context.worktree, { theirs: input.theirs }),
  );
  const rowsAfterMergeFault = rows();
  db.arm(0);
  const merged = merge(context, repo, context.worktree, { theirs: input.theirs });
  if (merged.oid === undefined) throw new Error("merge produced no commit");
  return {
    statusFault,
    statusFaultRows,
    porcelain,
    mergeFault,
    rowsBeforeMergeFault,
    rowsAfterMergeFault,
    mergeTree: repo.readCommit(merged.oid).tree,
    unclosedSubtrees:
      db.scalar<number>(
        `SELECT count(*) FROM git_tree_sources parent
           JOIN git_tree_entries entry ON entry.source_key = parent.source_key
          WHERE parent.complete = 1 AND entry.mode IN ('40000', '040000')
            AND NOT EXISTS (
              SELECT 1 FROM git_tree_sources child
               WHERE child.repo_id = parent.repo_id AND child.tree_oid = entry.oid
            )`,
      ) ?? -1,
  };
}
