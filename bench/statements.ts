import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createFilesystem } from "../packages/do/src/fs/filesystem.js";
import { CHUNK_SIZE } from "../packages/do/src/fs/schema.js";
import { createInitialWorktreeWriter } from "../packages/do/src/fs/store/initial-write.js";
import { Workspace } from "../packages/do/src/runtime/workspace.js";
import { createGit } from "../packages/git/src/client.js";
import { concat, utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject, MODE_FILE, serializeTree } from "../packages/git/src/common/objects.js";
import { createSqliteCommitTreeSnapshotSource } from "../packages/git/src/do-fs/index.js";
import {
  advanceIndexTrackerBaseline,
  INDEX_DIRTY,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
  WORKTREE_DIRTY,
} from "../packages/git/src/do-fs/indexes/index-tracker.js";
import { loadIgnoreMatcher } from "../packages/git/src/ignore/index.js";
import { checkoutTree } from "../packages/git/src/ops/checkout/checkout.js";
import { tryInitialCheckout } from "../packages/git/src/ops/checkout/initial-checkout.js";
import { diff as diffIndexWorktree } from "../packages/git/src/ops/diff/diff.js";
import { merge, mergeAbort, mergeContinue } from "../packages/git/src/ops/merge/merge.js";
import { selectMergeBases } from "../packages/git/src/ops/merge/merge-base.js";
import { rebase } from "../packages/git/src/ops/rebase/rebase.js";
import { planRebase } from "../packages/git/src/ops/rebase/rebase-plan.js";
import { checkout } from "../packages/git/src/ops/refs/refs.js";
import { cherryPick, cherryPickContinue } from "../packages/git/src/ops/replay/cherry-pick.js";
import { preflightReplayCommitObjects } from "../packages/git/src/ops/replay/replay-revision.js";
import { commit } from "../packages/git/src/ops/repository/commit.js";
import { Repository } from "../packages/git/src/ops/repository/repository.js";
import { add, lsFiles, lsFilesWithWorktree, rm } from "../packages/git/src/ops/staging/staging.js";
import { eagerStatus } from "../packages/git/src/ops/status/status.js";
import { dirtyPaths } from "../packages/git/src/ops/worktree/worktree-io.js";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { advanceMaintenanceMark } from "../packages/git/src/store/maintenance/reachability.js";
import { encodeDeltaHeader } from "../packages/git/src/store/pack/delta.js";
import { PackWriter } from "../packages/git/src/store/pack/writer.js";
import { TestDatabase } from "../tests/helpers/db.js";
import { GitFixture, slices } from "../tests/helpers/git.js";
import { startGitServer } from "../tests/helpers/http-backend.js";
import { importFixture } from "../tests/helpers/import.js";
import { collectReplay } from "../tests/helpers/integration.js";
import { SqliteTestStorage } from "../tests/helpers/storage.js";
import { makeRepo, type TestRepository, writeWorkFile } from "../tests/helpers/workspace.js";
import { type GatedRow, type GateOutcome, gateRows } from "./statement-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const TARGET_STATEMENTS = 1_000;
const IDENTITY = { name: "Statement Bench", email: "statements@example.com" };
const EXPECTED_SCHEMA_OBJECTS: readonly string[] = [
  "index:git_blob_ids_by_generation",
  "index:git_checkout_reflog_entries_by_ordinal",
  "index:git_checkout_reflog_entries_by_timestamp",
  "index:git_checkouts_attached_branch",
  "index:git_checkouts_primary",
  "index:git_maintenance_objects_queue",
  "index:git_pack_entries_by_base",
  "index:git_pack_entries_by_oid",
  "index:git_pack_graph_pending",
  "index:git_pack_objects_loc",
  "index:git_pack_objects_reverse",
  "index:git_pack_pending_by_base",
  "index:git_reflog_entries_by_ref",
  "index:git_reflog_entries_by_timestamp",
  "index:git_tree_entries_by_name_bytes",
  "table:git_blob_id_state",
  "table:git_blob_ids",
  "table:git_checkout_reflog_entries",
  "table:git_checkouts",
  "table:git_commits",
  "table:git_config",
  "table:git_fetch_namespaces",
  "table:git_identity_control",
  "table:git_index",
  "table:git_index_dirty",
  "table:git_index_state",
  "table:git_integration_object_chunks",
  "table:git_integration_objects",
  "table:git_integration_plan_entries",
  "table:git_integration_plans",
  "table:git_integration_reservations",
  "table:git_integration_touched",
  "table:git_integration_tree_entries",
  "table:git_integration_workspaces",
  "table:git_loose_gc_candidates",
  "table:git_maintenance_control",
  "table:git_maintenance_objects",
  "table:git_maintenance_runs",
  "table:git_maintenance_shallow",
  "table:git_meta",
  "table:git_object_chunks",
  "table:git_objects",
  "table:git_operation_state",
  "table:git_operation_steps",
  "table:git_operation_touched",
  "table:git_pack_commit_staging",
  "table:git_pack_data",
  "table:git_pack_entries",
  "table:git_pack_gc_candidates",
  "table:git_pack_graph_affected",
  "table:git_pack_graph_memo",
  "table:git_pack_graph_operations",
  "table:git_pack_graph_path",
  "table:git_pack_ingest_control",
  "table:git_pack_meta",
  "table:git_pack_objects",
  "table:git_pack_pending",
  "table:git_pack_read_frontier",
  "table:git_pack_read_pages",
  "table:git_pack_read_scopes",
  "table:git_promised_blobs",
  "table:git_promisor_remotes",
  "table:git_reflog_entries",
  "table:git_reflog_state",
  "table:git_refs",
  "table:git_repositories",
  "table:git_scratch_index_entries",
  "table:git_scratch_indexes",
  "table:git_shallow",
  "table:git_tracking_ref_revisions",
  "table:git_tree_effective",
  "table:git_tree_entries",
  "table:git_tree_sources",
  "trigger:git_blob_id_updates_begin",
  "trigger:git_blob_id_updates_finish",
  "trigger:git_blob_id_updates_invalid",
  "trigger:git_blob_id_updates_mapping",
  "trigger:git_checkouts_identity_immutable",
  "trigger:git_promised_blobs_loose_present",
  "trigger:git_tree_effective_loose_delete",
  "trigger:git_tree_effective_loose_insert",
  "trigger:git_tree_effective_pack_complete",
  "trigger:git_tree_effective_pack_delete",
  "trigger:git_tree_effective_pack_hide",
  "view:git_blob_id_updates",
];

type RequiredRow =
  | "schema.init"
  | "fs.redirect.stream"
  | "ls-files.cached"
  | "ls-files.combined"
  | "ignore.load"
  | "sparse.prune"
  | "checkout.remove"
  | "worktree.guard"
  | "staging.add"
  | "staging.rm"
  | "status.full"
  | "status.sparse-clean"
  | "status.sparse-dirty"
  | "staging.add-selected"
  | "worktree.list"
  | "checkout.initial"
  | "commit.sparse"
  | "diff.index-worktree"
  | "fetch.publication"
  | "merge-base.select"
  | "merge.virtual-base"
  | "merge.apply"
  | "merge.recovery"
  | "merge.restore"
  | "replay.preflight"
  | "replay.plan"
  | "replay.recovery"
  | "rebase.plan"
  | "rebase.transition"
  | "rebase.transition-n"
  | "rebase.transition-2n"
  | "pack.uncached-read"
  | "pack.fallback-audit"
  | "index-tracker.dirty"
  | "index-tracker.reseal"
  | "maintenance.mark-depth-n"
  | "maintenance.mark-depth-2n"
  | "transport.discovery"
  | "transport.fetch"
  | "transport.push";

const REQUIRED_ROWS: readonly RequiredRow[] = [
  "schema.init",
  "fs.redirect.stream",
  "ls-files.cached",
  "ls-files.combined",
  "ignore.load",
  "sparse.prune",
  "checkout.remove",
  "worktree.guard",
  "staging.add",
  "staging.rm",
  "status.full",
  "status.sparse-clean",
  "status.sparse-dirty",
  "staging.add-selected",
  "worktree.list",
  "checkout.initial",
  "commit.sparse",
  "diff.index-worktree",
  "fetch.publication",
  "merge-base.select",
  "merge.virtual-base",
  "merge.apply",
  "merge.recovery",
  "merge.restore",
  "replay.preflight",
  "replay.plan",
  "replay.recovery",
  "rebase.plan",
  "rebase.transition",
  "rebase.transition-n",
  "rebase.transition-2n",
  "pack.uncached-read",
  "pack.fallback-audit",
  "index-tracker.dirty",
  "index-tracker.reseal",
  "maintenance.mark-depth-n",
  "maintenance.mark-depth-2n",
  "transport.discovery",
  "transport.fetch",
  "transport.push",
];

interface ResultRow {
  operation: RequiredRow;
  statements: number;
  rowsRead: number;
  targetStatements: number;
  target: "pass" | "miss";
  baselineStatements: number | null;
  baselineRowsRead: number | null;
}

interface NextjsReference {
  operation: "git.clone" | "git.commit (100)" | "git.checkout main (force)";
  statements: number;
  rowsRead: number;
  /** Provenance, reported for a measured row and documentation on a frozen one. */
  source: string;
}

interface StatementReport {
  version: 1;
  targetStatements: number;
  rows: ResultRow[];
  nextjsReferences: NextjsReference[];
}

interface History {
  fixture: GitFixture;
  base: string;
  current: string;
  incoming: string;
}

// Frozen at the pre-sprint implementation; the status.sparse, staging.add-selected
// and worktree.list rows at fc25987. A target miss is reported separately.
const BASELINE_STATEMENTS: Partial<Record<RequiredRow, number>> = {
  "schema.init": 97,
  "fs.redirect.stream": 32,
  "ls-files.cached": 1,
  "ls-files.combined": 6,
  "ignore.load": 3,
  "sparse.prune": 126,
  "checkout.remove": 39,
  "worktree.guard": 7,
  "staging.add": 18,
  "staging.rm": 27,
  "status.full": 28,
  "status.sparse-clean": 7,
  "status.sparse-dirty": 24,
  "staging.add-selected": 25,
  "worktree.list": 9,
  "checkout.initial": 24,
  "commit.sparse": 37,
  "diff.index-worktree": 35,
  "fetch.publication": 22,
  "merge-base.select": 9,
  "merge.virtual-base": 204,
  "merge.apply": 147,
  "merge.recovery": 101,
  "merge.restore": 90,
  "replay.preflight": 5,
  "replay.plan": 37,
  "replay.recovery": 115,
  "rebase.plan": 18,
  "rebase.transition": 404,
  "rebase.transition-n": 699,
  "rebase.transition-2n": 1279,
  "pack.uncached-read": 3,
  "pack.fallback-audit": 20,
  "index-tracker.dirty": 2,
  "index-tracker.reseal": 8,
  "maintenance.mark-depth-n": 398,
  "maintenance.mark-depth-2n": 783,
  "transport.discovery": 2,
  "transport.fetch": 82,
  "transport.push": 50,
};

const BASELINE_ROWS_READ: Partial<Record<RequiredRow, number>> = {
  "schema.init": 92,
  "fs.redirect.stream": 4,
  "ls-files.cached": 2,
  "ls-files.combined": 13,
  "ignore.load": 7,
  "sparse.prune": 247,
  "checkout.remove": 32,
  "worktree.guard": 12,
  "staging.add": 26,
  "staging.rm": 31,
  "status.full": 31,
  "status.sparse-clean": 5,
  "status.sparse-dirty": 23,
  "staging.add-selected": 33,
  "worktree.list": 14,
  "checkout.initial": 21,
  "commit.sparse": 28,
  "diff.index-worktree": 35,
  "fetch.publication": 12,
  "merge-base.select": 10,
  "merge.virtual-base": 159,
  "merge.apply": 116,
  "merge.recovery": 73,
  "merge.restore": 70,
  "replay.preflight": 10,
  "replay.plan": 24,
  "replay.recovery": 77,
  "rebase.plan": 19,
  "rebase.transition": 413,
  "rebase.transition-n": 689,
  "rebase.transition-2n": 1273,
  "pack.uncached-read": 2,
  "pack.fallback-audit": 4,
  "index-tracker.dirty": 1_025,
  "index-tracker.reseal": 3,
  "maintenance.mark-depth-n": 332,
  "maintenance.mark-depth-2n": 653,
  "transport.discovery": 2,
  "transport.fetch": 64,
  "transport.push": 57,
};

const FULL_INDEX_SCAN_SQL =
  "SELECT entry.path, entry.stage, entry.mode, entry.oid, entry.size, entry.mtime, entry.ino, entry.rev FROM git_index entr";
const TRACKER_DIRTY_SQL = "SELECT path, flags FROM git_index_dirty WHERE checkout_id = ?";
const SPARSE_HYDRATE_WORKTREE_SQL = "WITH wanted(ordinal, relative) AS MATERIALIZED";
const SELECTED_EXACT_INDEX_SQL =
  "WITH wanted(path) AS MATERIALIZED ( SELECT json_extract(value, '$.p') FROM json_each(?) ) SELECT candidate.path";

const FROZEN_NEXTJS_REFERENCES: readonly NextjsReference[] = [
  {
    operation: "git.clone",
    statements: 1_029,
    rowsRead: 164_285,
    source:
      "2026-09-23 HEAD: commit promotion stopped recounting staged rows (-2 statements, " +
      "-2 rows). 2026-09-22 HEAD, rebaselined with per-commit attribution. Statements fell from the " +
      "2026-09-07 pre-split 2,381 at bc9bd3f (lease-guard pairs) and e7d31b0 (admission page " +
      "256 -> 4,096). Rows rose from 79,273 through two correctness validations: 3fc7965 " +
      "fetched-connectivity (+67,208) and 491189b pack graph admission (+68,595), the latter " +
      "then reduced by 50,198 by seeding only delta participants.",
  },
  {
    operation: "git.commit (100)",
    statements: 52,
    rowsRead: 725,
    source:
      "2026-09-22 HEAD. 51/724 held from the 2026-09-07 pre-split baseline until 924fb06, " +
      "whose source-generation bump adds one UPDATE and its RETURNING row per batch flush " +
      "(ADR-0025, accepted consequence). Measured against its direct parent 2e1d48e.",
  },
  {
    operation: "git.checkout main (force)",
    statements: 102,
    rowsRead: 25_189,
    source: "2026-09-07 pre-split HEAD baseline",
  },
];

async function withQueries<T>(
  storage: SqliteTestStorage,
  run: () => T | Promise<T>,
): Promise<{ value: T; queries: string }> {
  const histogram = new Map<string, number>();
  storage.histogram = histogram;
  try {
    const value = await run();
    return { value, queries: [...histogram.keys()].join("\n") };
  } finally {
    storage.histogram = null;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameStrings(actual: readonly string[], expected: readonly string[], label: string): void {
  assert(actual.length === expected.length, `${label}: expected ${expected.length} rows`);
  for (let index = 0; index < expected.length; index++) {
    assert(actual[index] === expected[index], `${label}: mismatch at row ${index}`);
  }
}

function schemaObjects(db: TestDatabase): string[] {
  const objects: string[] = [];
  for (const row of db.iterate(
    `SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  )) {
    assert(
      (row.type === "index" ||
        row.type === "table" ||
        row.type === "trigger" ||
        row.type === "view") &&
        typeof row.name === "string",
      "schema catalog returned a malformed object",
    );
    objects.push(`${row.type}:${row.name}`);
  }
  return objects;
}

function sameBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  assert(actual.length === expected.length, `${label}: expected ${expected.length} bytes`);
  for (let index = 0; index < expected.length; index++) {
    assert(actual[index] === expected[index], `${label}: mismatch at byte ${index}`);
  }
}

function singleBlobPack(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object("blob", data);
  writer.finish();
  return concat(chunks);
}

interface ExpectedFile {
  path: string;
  content: string;
}

function assertTreeIndexWorktree(
  workspace: TestRepository,
  treeOid: string,
  expected: readonly ExpectedFile[],
  label: string,
): void {
  const tree = [...workspace.repo.walkTree(treeOid)];
  sameStrings(
    tree.map((row) => row.path),
    expected.map((row) => row.path),
    `${label} tree paths`,
  );
  const index = [...workspace.repo.checkout.indexScan()];
  assert(index.length === expected.length, `${label}: index row count changed`);
  const worktreePaths = workspace.worktree
    .scan("/", { filesOnly: true, limit: expected.length + 1 })
    .map((entry) => entry.path.slice(1));
  sameStrings(
    worktreePaths,
    expected.map((row) => row.path),
    `${label} worktree paths`,
  );
  for (let ordinal = 0; ordinal < expected.length; ordinal++) {
    const wanted = expected[ordinal];
    const treeRow = tree[ordinal];
    const indexRow = index[ordinal];
    assert(wanted !== undefined && treeRow !== undefined, `${label}: tree row is missing`);
    assert(indexRow !== undefined, `${label}: index row is missing`);
    assert(indexRow.path === wanted.path && indexRow.stage === 0, `${label}: index path changed`);
    assert(
      indexRow.oid === treeRow.entry.oid && indexRow.mode.toString(8) === treeRow.entry.mode,
      `${label}: index differs from tree at ${wanted.path}`,
    );
    const expectedBytes = utf8.encode(wanted.content);
    const object = workspace.repo.read(treeRow.entry.oid);
    assert(object.type === "blob", `${label}: ${wanted.path} is not a blob`);
    sameBytes(object.data, expectedBytes, `${label} tree content at ${wanted.path}`);
    sameBytes(
      workspace.worktree.readFile(`/${wanted.path}`),
      expectedBytes,
      `${label} worktree content at ${wanted.path}`,
    );
  }
}

async function measure<T>(
  rows: ResultRow[],
  storage: SqliteTestStorage,
  operation: RequiredRow,
  run: () => T | Promise<T>,
  verify: (value: T) => void | Promise<void>,
): Promise<T> {
  storage.resetCounters();
  const value = await run();
  const statements = storage.statementCount;
  const rowsRead = storage.rowCount;
  await verify(value);
  assert(Number.isSafeInteger(statements) && statements >= 0, `${operation}: invalid SQL count`);
  assert(Number.isSafeInteger(rowsRead) && rowsRead >= 0, `${operation}: invalid row count`);
  rows.push({
    operation,
    statements,
    rowsRead,
    targetStatements: TARGET_STATEMENTS,
    target: statements <= TARGET_STATEMENTS ? "pass" : "miss",
    baselineStatements: BASELINE_STATEMENTS[operation] ?? null,
    baselineRowsRead: BASELINE_ROWS_READ[operation] ?? null,
  });
  return value;
}

async function imported(fixture: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(fixture, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  return workspace;
}

function cleanHistory(): History {
  const fixture = new GitFixture().init();
  fixture.write("base.txt", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic", base);
  fixture.write("topic.txt", "topic\n");
  const incoming = fixture.commit("topic");
  fixture.git("checkout", "-q", "main");
  fixture.write("main.txt", "main\n");
  const current = fixture.commit("main");
  return { fixture, base, current, incoming };
}

function conflictingHistory(): History {
  const fixture = new GitFixture().init();
  fixture.write("conflict.txt", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic", base);
  fixture.write("conflict.txt", "incoming\n");
  const incoming = fixture.commit("topic");
  fixture.git("checkout", "-q", "main");
  fixture.write("conflict.txt", "current\n");
  const current = fixture.commit("main");
  return { fixture, base, current, incoming };
}

function crissCrossHistory(): History {
  const fixture = new GitFixture().init();
  fixture.write("conflict.txt", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "side-a");
  fixture.write("conflict.txt", "a1\n");
  const a1 = fixture.commit("A1");
  fixture.git("checkout", "-q", "-b", "side-b", base);
  fixture.write("conflict.txt", "b1\n");
  const b1 = fixture.commit("B1");
  fixture.git("checkout", "-q", "side-a");
  assert(fixture.gitResult("merge", "--no-edit", b1).status !== 0, "side-a merge must conflict");
  fixture.write("conflict.txt", "a1+b1\n");
  fixture.commit("merge B1 into A1");
  fixture.git("checkout", "-q", "side-b");
  assert(fixture.gitResult("merge", "--no-edit", a1).status !== 0, "side-b merge must conflict");
  fixture.write("conflict.txt", "b1+a1\n");
  fixture.commit("merge A1 into B1");
  fixture.git("checkout", "-q", "side-a");
  fixture.write("conflict.txt", "a2\n");
  const current = fixture.commit("A2");
  fixture.git("checkout", "-q", "side-b");
  fixture.write("conflict.txt", "b2\n");
  const incoming = fixture.commit("B2");
  fixture.git("checkout", "-q", "side-a");
  return { fixture, base, current, incoming };
}

function rebaseHistory(stepCount = 2, constantTree = false): History {
  const fixture = new GitFixture().init();
  fixture.write("base.txt", "base\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "upstream", base);
  fixture.write("upstream.txt", "upstream\n");
  const incoming = fixture.commit("upstream");
  fixture.git("checkout", "-q", "main");
  let current = base;
  for (let ordinal = 1; ordinal <= stepCount; ordinal++) {
    const content = ordinal === 1 ? "one\n" : ordinal === 2 ? "two\n" : `${ordinal}\n`;
    fixture.write(constantTree ? "current.txt" : `current-${ordinal}.txt`, content);
    current = fixture.commit(`current ${ordinal}`);
  }
  return { fixture, base, current, incoming };
}

async function basicRows(rows: ResultRow[]): Promise<void> {
  const schemaStorage = new SqliteTestStorage();
  let schemaDb: TestDatabase | null = null;
  await measure(
    rows,
    schemaStorage,
    "schema.init",
    () => {
      schemaDb = new TestDatabase(schemaStorage);
      return new SqliteGitDatabase(schemaDb);
    },
    () => {
      assert(schemaDb !== null, "schema database was not created");
      assert(
        schemaDb.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'") === "1",
        "schema version was not initialized",
      );
      sameStrings(schemaObjects(schemaDb), EXPECTED_SCHEMA_OBJECTS, "schema catalog");
      const coldDb = new TestDatabase(schemaStorage);
      new SqliteGitDatabase(coldDb);
      assert(
        coldDb.scalar<string>("SELECT value FROM git_meta WHERE key = 'schema_version'") === "1",
        "schema version did not survive a cold reopen",
      );
      sameStrings(schemaObjects(coldDb), EXPECTED_SCHEMA_OBJECTS, "cold schema catalog");
    },
  );

  const redirectDb = new TestDatabase();
  const fs = createFilesystem(redirectDb, { now: () => 2_000 });
  const redirectChunks = Array.from({ length: 12 }, (_, index) =>
    new Uint8Array(CHUNK_SIZE + index).fill(index + 1),
  );
  await measure(
    rows,
    redirectDb.storage,
    "fs.redirect.stream",
    () => fs.writeFileStream("/redirect.bin", redirectChunks),
    () => {
      const content = fs.readFile("/redirect.bin");
      const expectedLength = redirectChunks.reduce((total, chunk) => total + chunk.length, 0);
      const expected = new Uint8Array(expectedLength);
      let offset = 0;
      for (const chunk of redirectChunks) {
        expected.set(chunk, offset);
        offset += chunk.length;
      }
      sameBytes(content, expected, "stream redirect content");
    },
  );

  const listing = makeRepo("/");
  listing.repo.store.configSet("user.name", IDENTITY.name);
  listing.repo.store.configSet("user.email", IDENTITY.email);
  writeWorkFile(listing, "/tracked/a.ts", "a\n");
  writeWorkFile(listing, "/tracked/b.ts", "b\n");
  writeWorkFile(listing, "/.gitignore", "ignored.txt\n");
  add(listing.repo, listing.worktree, { paths: [], all: true });
  commit(listing.context, listing.repo, { message: "listing fixture" });
  writeWorkFile(listing, "/untracked.txt", "untracked\n");
  writeWorkFile(listing, "/ignored.txt", "ignored\n");
  await measure(
    rows,
    listing.storage,
    "ls-files.cached",
    () => lsFiles(listing.repo, { paths: ["tracked"] }),
    (value) => sameStrings(value, ["tracked/a.ts", "tracked/b.ts"], "cached ls-files"),
  );
  await measure(
    rows,
    listing.storage,
    "ls-files.combined",
    () =>
      lsFilesWithWorktree(listing.repo, listing.worktree, {
        cached: true,
        others: true,
        excludeStandard: true,
      }),
    (value) =>
      sameStrings(
        value,
        [".gitignore", "tracked/a.ts", "tracked/b.ts", "untracked.txt"],
        "combined ls-files",
      ),
  );
}

async function ignoreLoadRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  writeWorkFile(workspace, "/.gitignore", "*.log\n!important.log\nroot-only\n");
  writeWorkFile(workspace, "/src/.gitignore", "*.tmp\n!important.tmp\n");
  writeWorkFile(workspace, "/src/generated/.gitignore", "*\n!keep.txt\n");
  await measure(
    rows,
    workspace.storage,
    "ignore.load",
    () => loadIgnoreMatcher(workspace.worktree, "/"),
    (matcher) => {
      assert(matcher.ignores("debug.log", false), "root ignore rule was not loaded");
      assert(!matcher.ignores("important.log", false), "root ignore negation was not loaded");
      assert(matcher.ignores("root-only", false), "literal root ignore rule was not loaded");
      assert(matcher.ignores("src/cache.tmp", false), "nested ignore rule was not loaded");
      assert(!matcher.ignores("src/important.tmp", false), "nested ignore negation was not loaded");
      assert(matcher.ignores("src/generated/drop.txt", false), "deep ignore rule was not loaded");
      assert(
        !matcher.ignores("src/generated/keep.txt", false),
        "deep ignore negation was not loaded",
      );
      assert(!matcher.ignores("src/kept.ts", false), "ignore loader changed an unrelated path");
    },
  );
}

async function sparseRow(rows: ResultRow[]): Promise<void> {
  const fixture = new GitFixture().init();
  try {
    for (let index = 0; index < 12; index++) {
      fixture.write(`prune-${String(index).padStart(2, "0")}/file.txt`, `${index}\n`);
    }
    fixture.write("keep/file.txt", "keep\n");
    const base = fixture.commit("wide base");
    for (let index = 0; index < 12; index++) {
      fixture.remove(`prune-${String(index).padStart(2, "0")}`);
    }
    fixture.write("keep/file.txt", "changed\n");
    const target = fixture.commit("pruned target");
    const workspace = await imported(fixture);
    let reseals = 0;
    const sparseContext = {
      ...workspace.context,
      indexTracker: {
        reseal(checkoutId: number, baselineTreeOid: string | null): boolean {
          reseals++;
          return resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, []);
        },
        advanceBaseline(checkoutId: number, baselineTreeOid: string | null): boolean {
          return advanceIndexTrackerBaseline(workspace.database.db, checkoutId, baselineTreeOid);
        },
      },
    };
    assert(
      resealIndexTracker(
        workspace.database.db,
        workspace.repo.checkout.checkoutId,
        workspace.repo.headTree(),
        [],
      ),
      "sparse fixture did not seed its tracker",
    );
    checkout(sparseContext, workspace.repo, workspace.worktree, { ref: base, force: true });
    const resealsBeforeTarget = reseals;
    await measure(
      rows,
      workspace.storage,
      "sparse.prune",
      () => checkout(sparseContext, workspace.repo, workspace.worktree, { ref: target }),
      () => {
        assert(reseals === resealsBeforeTarget + 1, "checkout did not use the sparse prune path");
        assert(workspace.repo.head().oid === target, "sparse checkout did not publish target");
        const targetTree = workspace.repo.readCommit(target).tree;
        assert(workspace.repo.headTree() === targetTree, "sparse checkout published another tree");
        for (let index = 0; index < 12; index++) {
          const root = `/prune-${String(index).padStart(2, "0")}`;
          assert(workspace.worktree.stat(root) === null, `sparse checkout kept ${root}`);
        }
        assertTreeIndexWorktree(
          workspace,
          targetTree,
          [{ path: "keep/file.txt", content: "changed\n" }],
          "sparse checkout",
        );
      },
    );
  } finally {
    fixture.dispose();
  }
}

async function checkoutRemoveRow(rows: ResultRow[]): Promise<void> {
  const fixture = new GitFixture().init();
  try {
    fixture.write("keep.txt", "before\n");
    fixture.write("drop.txt", "drop\n");
    fixture.write("nested/remove.txt", "nested\n");
    const base = fixture.commit("removal base");
    fixture.write("keep.txt", "after\n");
    fixture.remove("drop.txt");
    fixture.remove("nested");
    const target = fixture.commit("removal target");
    fixture.git("checkout", "-q", "-b", "source", base);
    const workspace = await imported(fixture);
    const targetTree = workspace.repo.readCommit(target).tree;
    await measure(
      rows,
      workspace.storage,
      "checkout.remove",
      () => checkoutTree(workspace.repo, workspace.worktree, targetTree, { prune: true }),
      () => {
        assert(workspace.repo.head().oid === base, "checkout removal moved HEAD");
        assert(workspace.repo.headTree() !== targetTree, "checkout removal moved HEAD tree");
        assertTreeIndexWorktree(
          workspace,
          targetTree,
          [{ path: "keep.txt", content: "after\n" }],
          "checkout removal",
        );
        assert(workspace.worktree.stat("/drop.txt") === null, "checkout kept removed file");
        assert(workspace.worktree.stat("/nested") === null, "checkout kept pruned directory");
      },
    );
  } finally {
    fixture.dispose();
  }
}

async function worktreeGuardRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  const files = [
    { path: "changed.txt", content: "before\n" },
    { path: "deleted.txt", content: "deleted\n" },
    { path: "stable.txt", content: "stable\n" },
  ];
  for (const file of files) writeWorkFile(workspace, `/${file.path}`, file.content);
  add(workspace.repo, workspace.worktree, { paths: [], all: true });
  const base = commit(workspace.context, workspace.repo, { message: "guard base" }).oid;
  const baseTree = workspace.repo.readCommit(base).tree;
  writeWorkFile(workspace, "/changed.txt", "after\n");
  workspace.worktree.removeFiles(["/deleted.txt"]);
  await measure(
    rows,
    workspace.storage,
    "worktree.guard",
    () => dirtyPaths(workspace.repo, workspace.worktree),
    (dirty) => {
      sameStrings(dirty, ["changed.txt", "deleted.txt"], "dirty worktree guard");
      assert(workspace.repo.head().oid === base, "worktree guard moved HEAD");
      assert(workspace.repo.headTree() === baseTree, "worktree guard moved HEAD tree");
      sameStrings(
        [...workspace.repo.checkout.indexScan()].map((entry) => entry.path),
        files.map((file) => file.path),
        "worktree guard index",
      );
      sameBytes(
        workspace.worktree.readFile("/changed.txt"),
        utf8.encode("after\n"),
        "worktree guard changed file",
      );
      assert(workspace.worktree.stat("/deleted.txt") === null, "worktree guard restored deletion");
      sameBytes(
        workspace.worktree.readFile("/stable.txt"),
        utf8.encode("stable\n"),
        "worktree guard stable file",
      );
    },
  );
}

async function stagingAddRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  const files = [
    { path: "a.txt", content: "alpha\n" },
    { path: "dir/b.txt", content: "bravo\n" },
    { path: "z.txt", content: "zulu\n" },
  ];
  for (const file of files) writeWorkFile(workspace, `/${file.path}`, file.content);
  await measure(
    rows,
    workspace.storage,
    "staging.add",
    () => add(workspace.repo, workspace.worktree, { paths: [], all: true }),
    () => {
      assert(workspace.repo.head().oid === null, "staging add created HEAD");
      const index = [...workspace.repo.checkout.indexScan()];
      assert(index.length === files.length, "staging add changed index row count");
      for (let ordinal = 0; ordinal < files.length; ordinal++) {
        const expected = files[ordinal];
        const entry = index[ordinal];
        assert(expected !== undefined && entry !== undefined, "staging add lost an index row");
        const bytes = utf8.encode(expected.content);
        const oid = hashObject("blob", bytes);
        assert(
          entry.path === expected.path &&
            entry.stage === 0 &&
            entry.mode === 0o100644 &&
            entry.oid === oid,
          `staging add changed ${expected.path}`,
        );
        const object = workspace.repo.store.readAuthenticatedObject(oid, "blob");
        assert(object !== null && object.type === "blob", `staging add lost ${expected.path} blob`);
        sameBytes(object.data, bytes, `staging add blob ${expected.path}`);
        sameBytes(
          workspace.worktree.readFile(`/${expected.path}`),
          bytes,
          `staging add worktree ${expected.path}`,
        );
      }
    },
  );
}

async function stagingRmRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  const files = [
    { path: "drop.txt", content: "drop\n" },
    { path: "keep.txt", content: "keep\n" },
    { path: "nested/remove.txt", content: "nested\n" },
  ];
  for (const file of files) writeWorkFile(workspace, `/${file.path}`, file.content);
  add(workspace.repo, workspace.worktree, { paths: [], all: true });
  const base = commit(workspace.context, workspace.repo, { message: "rm base" }).oid;
  const baseTree = workspace.repo.readCommit(base).tree;
  await measure(
    rows,
    workspace.storage,
    "staging.rm",
    () =>
      rm(workspace.repo, workspace.worktree, {
        paths: ["drop.txt", "nested"],
        recursive: true,
      }),
    () => {
      assert(workspace.repo.head().oid === base, "staging rm moved HEAD");
      assert(workspace.repo.headTree() === baseTree, "staging rm moved HEAD tree");
      sameStrings(
        [...workspace.repo.checkout.indexScan()].map((entry) => entry.path),
        ["keep.txt"],
        "staging rm index",
      );
      sameStrings(
        workspace.worktree.scan("/", { filesOnly: true, limit: 2 }).map((entry) => entry.path),
        ["/keep.txt"],
        "staging rm worktree",
      );
      assert(workspace.worktree.stat("/drop.txt") === null, "staging rm kept selected file");
      assert(workspace.worktree.stat("/nested") === null, "staging rm kept selected directory");
      assert(
        workspace.repo.resolveTreePath(baseTree, "drop.txt") !== null &&
          workspace.repo.resolveTreePath(baseTree, "nested/remove.txt") !== null,
        "staging rm changed the committed tree",
      );
      sameBytes(
        workspace.worktree.readFile("/keep.txt"),
        utf8.encode("keep\n"),
        "staging rm kept bytes",
      );
    },
  );
}

async function statusFullRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  writeWorkFile(workspace, "/a.txt", "before\n");
  writeWorkFile(workspace, "/stable.txt", "stable\n");
  add(workspace.repo, workspace.worktree, { paths: [], all: true });
  const base = commit(workspace.context, workspace.repo, { message: "status base" }).oid;
  const baseTree = workspace.repo.readCommit(base).tree;
  const baseBlob = hashObject("blob", utf8.encode("before\n"));
  writeWorkFile(workspace, "/a.txt", "after\n");
  writeWorkFile(workspace, "/z-untracked.txt", "untracked\n");
  const sparseWorkspace = workspace.context.sparseWorkspace;
  assert(sparseWorkspace !== undefined, "full status fixture has no sparse source");
  const statusContext = {
    sparseWorkspace,
    indexTracker: {
      reseal: (
        checkoutId: number,
        baselineTreeOid: string | null,
        entries: Iterable<{
          path: string;
          flags: number;
        }>,
      ) => resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries),
      advanceBaseline: () => false,
    },
  };
  await measure(
    rows,
    workspace.storage,
    "status.full",
    () => eagerStatus(workspace.repo, workspace.worktree, {}, statusContext),
    (statusRows) => {
      assert(statusRows.length === 2, "full status changed row count");
      const tracked = statusRows[0];
      const untracked = statusRows[1];
      assert(
        tracked !== undefined &&
          "headMode" in tracked &&
          tracked.path === "a.txt" &&
          tracked.index === " " &&
          tracked.worktree === "M" &&
          tracked.headMode === "100644" &&
          tracked.indexMode === "100644" &&
          tracked.worktreeMode === "100644" &&
          tracked.headOid === baseBlob &&
          tracked.indexOid === baseBlob,
        "full status changed tracked row",
      );
      assert(
        untracked !== undefined &&
          "headMode" in untracked &&
          untracked.path === "z-untracked.txt" &&
          untracked.index === " " &&
          untracked.worktree === "?" &&
          untracked.headMode === "000000" &&
          untracked.indexMode === "000000" &&
          untracked.worktreeMode === "000000" &&
          untracked.headOid === "0".repeat(40) &&
          untracked.indexOid === "0".repeat(40),
        "full status changed untracked row",
      );
      assert(workspace.repo.head().oid === base, "full status moved HEAD");
      assert(workspace.repo.headTree() === baseTree, "full status moved HEAD tree");
      const state = readIndexTrackerState(
        workspace.database.db,
        workspace.repo.checkout.checkoutId,
      );
      assert(
        state.available && state.baselineTreeOid === baseTree,
        "full status did not reseal its tracker",
      );
      const dirty = [...sparseWorkspace.dirtyPaths(workspace.repo.checkout.checkoutId)];
      assert(
        dirty.length === 2 &&
          dirty[0]?.path === "a.txt" &&
          dirty[0].flags === WORKTREE_DIRTY &&
          dirty[1]?.path === "z-untracked.txt" &&
          dirty[1].flags === WORKTREE_DIRTY,
        "full status changed tracker seed",
      );
    },
  );
}

async function statusSparseRows(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  writeWorkFile(workspace, "/a.txt", "before\n");
  writeWorkFile(workspace, "/stable.txt", "stable\n");
  add(workspace.repo, workspace.worktree, { paths: [], all: true });
  const base = commit(workspace.context, workspace.repo, { message: "status base" }).oid;
  const baseTree = workspace.repo.readCommit(base).tree;
  const baseBlob = hashObject("blob", utf8.encode("before\n"));
  const sparseWorkspace = workspace.context.sparseWorkspace;
  assert(sparseWorkspace !== undefined, "sparse status fixture has no sparse source");
  let reseals = 0;
  const statusContext = {
    sparseWorkspace,
    indexTracker: {
      reseal: (
        checkoutId: number,
        baselineTreeOid: string | null,
        entries: Iterable<{
          path: string;
          flags: number;
        }>,
      ) => {
        reseals++;
        return resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries);
      },
      advanceBaseline: () => false,
    },
  };
  assert(
    resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baseTree, []),
    "sparse status fixture did not seal its tracker",
  );
  const assertSparsePath = (queries: string, label: string): void => {
    assert(queries.includes(TRACKER_DIRTY_SQL), `${label} did not read tracker dirty paths`);
    assert(!queries.includes(FULL_INDEX_SCAN_SQL), `${label} fell back to a full index scan`);
  };

  await measure(
    rows,
    workspace.storage,
    "status.sparse-clean",
    () =>
      withQueries(workspace.storage, () =>
        eagerStatus(workspace.repo, workspace.worktree, {}, statusContext),
      ),
    ({ value: statusRows, queries }) => {
      assert(statusRows.length === 0, "clean sparse status reported rows");
      assertSparsePath(queries, "clean sparse status");
      assert(reseals === 0, "clean sparse status resealed its tracker");
    },
  );

  writeWorkFile(workspace, "/a.txt", "after\n");
  writeWorkFile(workspace, "/z-untracked.txt", "untracked\n");
  await measure(
    rows,
    workspace.storage,
    "status.sparse-dirty",
    () =>
      withQueries(workspace.storage, () =>
        eagerStatus(workspace.repo, workspace.worktree, {}, statusContext),
      ),
    ({ value: statusRows, queries }) => {
      assertSparsePath(queries, "dirty sparse status");
      assert(
        queries.includes(SPARSE_HYDRATE_WORKTREE_SQL),
        "dirty sparse status did not hydrate its candidates",
      );
      assert(reseals === 1, "dirty sparse status did not reseal its tracker");
      assert(statusRows.length === 2, "dirty sparse status changed row count");
      const tracked = statusRows[0];
      const untracked = statusRows[1];
      assert(
        tracked !== undefined &&
          tracked.path === "a.txt" &&
          tracked.index === " " &&
          tracked.worktree === "M" &&
          "headOid" in tracked &&
          tracked.headOid === baseBlob &&
          tracked.indexOid === baseBlob,
        "dirty sparse status changed tracked row",
      );
      assert(
        untracked !== undefined &&
          untracked.path === "z-untracked.txt" &&
          untracked.index === " " &&
          untracked.worktree === "?",
        "dirty sparse status changed untracked row",
      );
      assert(workspace.repo.head().oid === base, "sparse status moved HEAD");
      assert(workspace.repo.headTree() === baseTree, "sparse status moved HEAD tree");
    },
  );
}

async function stagingAddSelectedRow(rows: ResultRow[]): Promise<void> {
  const storage = new SqliteTestStorage();
  const workspace = new Workspace({
    storage,
    git: createGit(),
    now: () => 1_600_000_000_000,
    defaultGitIdentity: IDENTITY,
  });
  const git = workspace.git;
  await git.init({ dir: "/repo" });
  for (const path of ["a.txt", "dir/b.txt", "dir/c.txt", "z.txt"]) {
    workspace.filesystem.writeFiles([
      { path: `/repo/${path}`, bytes: utf8.encode(`${path}\n`), mode: 0o644 },
    ]);
  }
  await git.add({ dir: "/repo", paths: [], all: true });
  const base = (await git.commit({ dir: "/repo", message: "selected base" })).oid;
  workspace.filesystem.writeFiles([
    { path: "/repo/dir/b.txt", bytes: utf8.encode("changed\n"), mode: 0o644 },
    { path: "/repo/new.txt", bytes: utf8.encode("new\n"), mode: 0o644 },
    { path: "/repo/z.txt", bytes: utf8.encode("unstaged\n"), mode: 0o644 },
  ]);
  await measure(
    rows,
    storage,
    "staging.add-selected",
    () => withQueries(storage, () => git.add({ dir: "/repo", paths: ["dir/b.txt", "new.txt"] })),
    async ({ queries }) => {
      assert(
        queries.includes(SELECTED_EXACT_INDEX_SQL),
        "selected add skipped the selected source",
      );
      assert(!queries.includes(FULL_INDEX_SCAN_SQL), "selected add fell back to a full index scan");
      assert(
        (await git.revParse({ dir: "/repo", ref: "HEAD" })) === base,
        "selected add moved HEAD",
      );
      const entries = await git.status({ dir: "/repo" });
      sameStrings(
        entries.map((entry) => `${entry.index}${entry.worktree} ${entry.path}`),
        ["M  dir/b.txt", "A  new.txt", " M z.txt"],
        "selected add status",
      );
    },
  );
}

async function worktreeListRow(rows: ResultRow[]): Promise<void> {
  const storage = new SqliteTestStorage();
  const workspace = new Workspace({
    storage,
    git: createGit(),
    now: () => 1_600_000_000_000,
    defaultGitIdentity: IDENTITY,
  });
  const git = workspace.git;
  await git.init({ dir: "/repo" });
  workspace.filesystem.writeFiles([
    { path: "/repo/file.txt", bytes: utf8.encode("file\n"), mode: 0o644 },
  ]);
  await git.add({ dir: "/repo", paths: ["file.txt"] });
  const base = (await git.commit({ dir: "/repo", message: "worktree base" })).oid;
  await git.worktreeAdd({
    dir: "/repo",
    root: "/left",
    target: { kind: "new-branch", name: "left" },
  });
  await git.worktreeAdd({
    dir: "/repo",
    root: "/right",
    target: { kind: "detached", startPoint: base },
  });
  await measure(
    rows,
    storage,
    "worktree.list",
    () => git.worktreeList({ dir: "/repo" }),
    (worktrees) => {
      sameStrings(
        worktrees.map((entry) => `${entry.root} ${entry.head} ${entry.isPrimary} ${entry.state}`),
        [
          "/left ref: refs/heads/left false present",
          "/repo ref: refs/heads/main true present",
          `/right ${base} false present`,
        ],
        "worktree list",
      );
    },
  );
}

async function checkoutInitialRow(rows: ResultRow[]): Promise<void> {
  const fixture = new GitFixture().init();
  try {
    fixture.write("README.md", "initial\n");
    fixture.write("bin/run.txt", "run\n");
    fixture.write("src/app.ts", "export const app = true;\n");
    const target = fixture.commit("initial checkout target");
    const workspace = makeRepo("/");
    await importFixture(fixture, workspace.repo.checkout);
    const targetTree = workspace.repo.readCommit(target).tree;
    const now = (): number => 1_577_836_800_000;
    const context = {
      ...workspace.context,
      initialWorktree: createInitialWorktreeWriter(
        workspace.database.db,
        now,
        (candidate) => candidate === workspace.database,
      ),
      indexTracker: {
        reseal: (
          checkoutId: number,
          baselineTreeOid: string | null,
          entries: Iterable<{
            path: string;
            flags: number;
          }>,
        ) => resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries),
        advanceBaseline: () => false,
      },
    };
    await measure(
      rows,
      workspace.storage,
      "checkout.initial",
      () =>
        tryInitialCheckout(context, workspace.repo, targetTree, { requireSharedDatabase: true }),
      (materialized) => {
        assert(materialized, "initial checkout did not use create-only materialisation");
        assert(workspace.repo.head().oid === target, "initial checkout moved HEAD");
        assertTreeIndexWorktree(
          workspace,
          targetTree,
          [
            { path: "README.md", content: "initial\n" },
            { path: "bin/run.txt", content: "run\n" },
            { path: "src/app.ts", content: "export const app = true;\n" },
          ],
          "initial checkout",
        );
        const state = readIndexTrackerState(
          workspace.database.db,
          workspace.repo.checkout.checkoutId,
        );
        assert(
          state.available && state.baselineTreeOid === targetTree,
          "initial checkout did not publish tracker state",
        );
        assert(
          [...iterateIndexTrackerDirty(workspace.database.db, workspace.repo.checkout.checkoutId)]
            .length === 0,
          "initial checkout published dirty tracker rows",
        );
      },
    );
  } finally {
    fixture.dispose();
  }
}

async function commitSparseRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  writeWorkFile(workspace, "/change.txt", "before\n");
  writeWorkFile(workspace, "/stable.txt", "stable\n");
  add(workspace.repo, workspace.worktree, { paths: [], all: true });
  const base = commit(workspace.context, workspace.repo, { message: "sparse base" }).oid;
  const baselineTree = workspace.repo.readCommit(base).tree;
  assert(
    resealIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId, baselineTree, []),
    "sparse commit fixture did not seal",
  );
  writeWorkFile(workspace, "/change.txt", "after\n");
  add(workspace.repo, workspace.worktree, { paths: ["change.txt"] });
  const changedBlob = hashObject("blob", utf8.encode("after\n"));
  const stableBlob = hashObject("blob", utf8.encode("stable\n"));
  const expectedTree = hashObject(
    "tree",
    serializeTree([
      { mode: MODE_FILE, name: "change.txt", oid: changedBlob },
      { mode: MODE_FILE, name: "stable.txt", oid: stableBlob },
    ]),
  );
  const context = {
    ...workspace.context,
    commitTrees: createSqliteCommitTreeSnapshotSource(workspace.database.db),
    indexTracker: {
      reseal: (
        checkoutId: number,
        treeOid: string | null,
        entries: Iterable<{
          path: string;
          flags: number;
        }>,
      ) => resealIndexTracker(workspace.database.db, checkoutId, treeOid, entries),
      advanceBaseline: (checkoutId: number, treeOid: string | null) =>
        advanceIndexTrackerBaseline(workspace.database.db, checkoutId, treeOid),
    },
  };
  const histogram = new Map<string, number>();
  workspace.storage.histogram = histogram;
  await measure(
    rows,
    workspace.storage,
    "commit.sparse",
    () => {
      const result = commit(context, workspace.repo, { message: "sparse result" });
      return { result, queries: [...histogram.keys()] };
    },
    ({ result, queries }) => {
      assert(workspace.repo.head().oid === result.oid, "sparse commit did not publish HEAD");
      const committed = workspace.repo.readCommit(result.oid);
      sameStrings(committed.parent, [base], "sparse commit parents");
      assert(committed.tree === expectedTree, "sparse commit changed resulting tree");
      assertTreeIndexWorktree(
        workspace,
        expectedTree,
        [
          { path: "change.txt", content: "after\n" },
          { path: "stable.txt", content: "stable\n" },
        ],
        "sparse commit",
      );
      const state = readIndexTrackerState(
        workspace.database.db,
        workspace.repo.checkout.checkoutId,
      );
      assert(
        state.available && state.baselineTreeOid === expectedTree,
        "sparse commit did not advance tracker baseline",
      );
      const dirty = [
        ...iterateIndexTrackerDirty(workspace.database.db, workspace.repo.checkout.checkoutId),
      ];
      assert(
        dirty.length === 1 && dirty[0]?.path === "change.txt" && dirty[0].flags === 3,
        "sparse commit changed tracker dirty state",
      );
      const measuredQueries = queries.join("\n");
      assert(
        measuredQueries.includes("WITH wanted(path) AS MATERIALIZED"),
        "sparse commit skipped snapshot",
      );
      assert(
        !measuredQueries.includes(
          "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id",
        ),
        "sparse commit fell back to a full index scan",
      );
    },
  );
}

async function diffIndexWorktreeRow(rows: ResultRow[]): Promise<void> {
  const fixture = new GitFixture().init();
  try {
    fixture.write("file.txt", "before\n");
    const base = fixture.commit("diff base");
    fixture.write("file.txt", "after\n");
    const expectedDiff = fixture.git("diff", "--", "file.txt");
    const workspace = await imported(fixture);
    writeWorkFile(workspace, "/file.txt", "after\n");
    const indexOid = hashObject("blob", utf8.encode("before\n"));
    await measure(
      rows,
      workspace.storage,
      "diff.index-worktree",
      () => diffIndexWorktree(workspace.repo, workspace.worktree),
      (output) => {
        assert(output.trimEnd() === expectedDiff, "index-worktree diff changed exact output");
        assert(workspace.repo.head().oid === base, "index-worktree diff moved HEAD");
        assert(
          workspace.repo.checkout.indexGet("file.txt")?.oid === indexOid,
          "index-worktree diff changed index",
        );
        sameBytes(
          workspace.worktree.readFile("/file.txt"),
          utf8.encode("after\n"),
          "index-worktree diff worktree",
        );
        assert(workspace.repo.checkout.readOperationState() === null, "diff wrote a journal");
      },
    );
  } finally {
    fixture.dispose();
  }
}

async function fetchPublicationRow(rows: ResultRow[]): Promise<void> {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const branch = "refs/heads/release";
  const checkpoint = "refs/checkpoints/nightly";
  const tag = "refs/tags/v1";
  const tracking = "refs/remotes/origin/main";
  const destinations = [branch, checkpoint, tag];
  const branchRef = { name: branch, target: "1".repeat(40) };
  const checkpointRef = { name: checkpoint, target: "2".repeat(40) };
  const trackingRef = { name: tracking, target: "4".repeat(40) };
  const tagRef = { name: tag, target: "3".repeat(40) };
  const expectedRefs = [checkpointRef, branchRef, trackingRef, tagRef];
  const shallowOid = "5".repeat(40);
  const metadata = {
    actor: IDENTITY,
    reason: "fetch: statement benchmark",
    timestamp: 1_800_000_000,
    timezoneOffset: 0,
  };
  const token = store.beginFetchPublication("refs/remotes/origin/", destinations);
  try {
    await measure(
      rows,
      db.storage,
      "fetch.publication",
      () =>
        store.publishFetchRefs(
          token,
          {
            exactPuts: [branchRef, checkpointRef, tagRef],
            trackingPuts: [trackingRef],
            shallowAdd: [shallowOid],
          },
          metadata,
        ),
      (published) => {
        assert(published === true, "fetch publication did not commit");
        const actualRefs = store.listRefs();
        assert(actualRefs.length === expectedRefs.length, "fetch publication changed ref count");
        for (let index = 0; index < expectedRefs.length; index++) {
          const actual = actualRefs[index];
          const expected = expectedRefs[index];
          assert(
            actual !== undefined &&
              expected !== undefined &&
              actual.name === expected.name &&
              actual.target === expected.target,
            `fetch publication changed ref ${index}`,
          );
        }
        const shallow = [...store.shallow()];
        sameStrings(shallow, [shallowOid], "fetch shallow state");
        const ordinals: number[] = [];
        for (const expected of expectedRefs) {
          const log = store.reflog(expected.name);
          assert(log.length === 1, `fetch reflog count changed for ${expected.name}`);
          const entry = log[0];
          assert(entry !== undefined, `fetch reflog is missing for ${expected.name}`);
          assert(
            entry.refName === expected.name &&
              entry.oldRaw === null &&
              entry.newRaw === expected.target &&
              entry.oldOid === null &&
              entry.newOid === expected.target &&
              entry.actor !== null &&
              entry.actor.name === IDENTITY.name &&
              entry.actor.email === IDENTITY.email &&
              entry.timestamp === metadata.timestamp &&
              entry.timezoneOffset === metadata.timezoneOffset &&
              entry.reason === metadata.reason,
            `fetch reflog changed for ${expected.name}`,
          );
          ordinals.push(entry.ordinal);
        }
        ordinals.sort((left, right) => left - right);
        assert(
          ordinals.length === 4 &&
            ordinals[0] === 1 &&
            ordinals[1] === 2 &&
            ordinals[2] === 3 &&
            ordinals[3] === 4,
          "fetch reflog ordinals changed",
        );
        assert(
          db.scalar<number>(
            "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
            checkout.repoId,
          ) === 4,
          "fetch reflog allocation state changed",
        );
      },
    );
  } finally {
    token.dispose();
  }
}

async function mergeRows(rows: ResultRow[]): Promise<void> {
  const selected = cleanHistory();
  try {
    const workspace = await imported(selected.fixture);
    await measure(
      rows,
      workspace.storage,
      "merge-base.select",
      () =>
        selectMergeBases(workspace.repo, {
          currentOid: selected.current,
          incomingOid: selected.incoming,
        }),
      (value) => {
        assert(value.kind === "divergent", "merge-base relation changed");
        sameStrings(value.bases, [selected.base], "merge-base selection");
      },
    );
  } finally {
    selected.fixture.dispose();
  }

  const virtual = crissCrossHistory();
  try {
    assert(
      virtual.fixture.gitResult("merge", "side-b").status !== 0,
      "native recursive virtual-base fixture did not conflict",
    );
    const expectedStageOneOid = virtual.fixture.git("rev-parse", ":1:conflict.txt");
    const expectedStageTwoOid = virtual.fixture.git("rev-parse", ":2:conflict.txt");
    const expectedStageThreeOid = virtual.fixture.git("rev-parse", ":3:conflict.txt");
    const expectedStageOne = new Uint8Array(virtual.fixture.gitBinary("show", ":1:conflict.txt"));
    const expectedWorktree = new Uint8Array(
      readFileSync(join(virtual.fixture.dir, "conflict.txt")),
    );
    const workspace = await imported(virtual.fixture);
    await measure(
      rows,
      workspace.storage,
      "merge.virtual-base",
      () => merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "side-b" }),
      (value) => {
        assert(
          value.conflicted === true && value.pendingCommit === true,
          "recursive virtual-base merge did not leave a pending conflict",
        );
        const stageOne = workspace.repo.checkout.indexGet("conflict.txt", 1);
        const stageTwo = workspace.repo.checkout.indexGet("conflict.txt", 2);
        const stageThree = workspace.repo.checkout.indexGet("conflict.txt", 3);
        assert(
          stageOne?.oid === expectedStageOneOid &&
            stageTwo?.oid === expectedStageTwoOid &&
            stageThree?.oid === expectedStageThreeOid &&
            stageOne.mode === stageTwo.mode &&
            stageTwo.mode === stageThree.mode &&
            workspace.repo.checkout.indexGet("conflict.txt", 0) === null,
          "recursive merge changed its exact conflict stages",
        );
        const synthetic = workspace.repo.read(stageOne.oid);
        assert(synthetic.type === "blob", "virtual stage-one base is not a blob");
        sameBytes(synthetic.data, expectedStageOne, "virtual stage-one content");
        assert(workspace.repo.head().oid === virtual.current, "virtual-base merge moved HEAD");
        assert(
          workspace.repo.headTree() === workspace.repo.readCommit(virtual.current).tree,
          "virtual-base merge changed HEAD tree",
        );
        const journal = workspace.repo.checkout.readMergeState();
        assert(
          journal !== null &&
            journal.state.originalHeadRef === "refs/heads/side-a" &&
            journal.state.originalHeadOid === virtual.current &&
            journal.state.currentParentOid === virtual.current &&
            journal.state.incomingParentOid === virtual.incoming &&
            journal.state.phase === "conflicted" &&
            journal.state.mode === "commit" &&
            journal.state.mergeOrigin === "merge" &&
            journal.touched.length === 1 &&
            journal.touched[0]?.path === "conflict.txt",
          "virtual-base merge changed its conflict journal",
        );
        sameBytes(
          workspace.worktree.readFile("/conflict.txt"),
          expectedWorktree,
          "virtual-base conflict worktree",
        );
      },
    );
  } finally {
    virtual.fixture.dispose();
  }

  const applied = cleanHistory();
  try {
    const workspace = await imported(applied.fixture);
    await measure(
      rows,
      workspace.storage,
      "merge.apply",
      () => merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
      (value) => {
        assert(value.oid !== undefined, "clean merge did not create a commit");
        assert(workspace.repo.head().oid === value.oid, "clean merge did not publish HEAD");
        const result = workspace.repo.readCommit(value.oid);
        sameStrings(result.parent, [applied.current, applied.incoming], "merge parents");
        assert(result.tree === workspace.repo.headTree(), "clean merge published another tree");
        assert(workspace.repo.checkout.readMergeState() === null, "clean merge kept a journal");
        assertTreeIndexWorktree(
          workspace,
          result.tree,
          [
            { path: "base.txt", content: "base\n" },
            { path: "main.txt", content: "main\n" },
            { path: "topic.txt", content: "topic\n" },
          ],
          "clean merge",
        );
      },
    );
  } finally {
    applied.fixture.dispose();
  }

  const recovered = conflictingHistory();
  try {
    const workspace = await imported(recovered.fixture);
    const initial = merge(workspace.context, workspace.repo, workspace.worktree, {
      theirs: "topic",
    });
    assert(initial.conflicted === true, "merge recovery fixture did not conflict");
    writeWorkFile(workspace, "/conflict.txt", "resolved\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"] });
    await measure(
      rows,
      workspace.storage,
      "merge.recovery",
      () => mergeContinue(workspace.context, workspace.repo),
      (value) => {
        assert(value.oid !== undefined, "merge recovery did not commit");
        assert(workspace.repo.head().oid === value.oid, "merge recovery did not publish HEAD");
        const result = workspace.repo.readCommit(value.oid);
        sameStrings(
          result.parent,
          [recovered.current, recovered.incoming],
          "merge recovery parents",
        );
        assert(result.tree === workspace.repo.headTree(), "merge recovery published another tree");
        assert(
          workspace.repo.checkout.readMergeState() === null,
          "merge journal survived recovery",
        );
        assertTreeIndexWorktree(
          workspace,
          result.tree,
          [{ path: "conflict.txt", content: "resolved\n" }],
          "merge recovery",
        );
      },
    );
  } finally {
    recovered.fixture.dispose();
  }

  const restored = conflictingHistory();
  try {
    const workspace = await imported(restored.fixture);
    const initial = merge(workspace.context, workspace.repo, workspace.worktree, {
      theirs: "topic",
    });
    assert(initial.conflicted === true, "merge restore fixture did not conflict");
    await measure(
      rows,
      workspace.storage,
      "merge.restore",
      () => mergeAbort(workspace.repo, workspace.worktree),
      () => {
        assert(workspace.repo.head().oid === restored.current, "merge abort moved HEAD");
        assert(workspace.repo.checkout.readMergeState() === null, "merge abort kept its journal");
        const restoredTree = workspace.repo.readCommit(restored.current).tree;
        assert(workspace.repo.headTree() === restoredTree, "merge abort restored another tree");
        assertTreeIndexWorktree(
          workspace,
          restoredTree,
          [{ path: "conflict.txt", content: "current\n" }],
          "merge abort",
        );
      },
    );
  } finally {
    restored.fixture.dispose();
  }
}

async function replayRows(rows: ResultRow[]): Promise<void> {
  const planned = cleanHistory();
  try {
    const workspace = await imported(planned.fixture);
    const preflightOids = [planned.base, planned.current, planned.incoming, planned.current];
    const preflightDb = new TestDatabase(workspace.storage);
    const preflightDatabase = new SqliteGitDatabase(preflightDb, {
      chunkBytes: 0,
      objectCacheBytes: 0,
    });
    const preflightCheckout = preflightDatabase.checkoutAt("/");
    assert(preflightCheckout !== null, "replay preflight cold reopen lost its checkout");
    const preflightRepo = new Repository(preflightDatabase.openCheckout(preflightCheckout));
    await measure(
      rows,
      preflightDb.storage,
      "replay.preflight",
      () => preflightReplayCommitObjects(preflightRepo, preflightOids),
      () => {
        assert(preflightRepo.head().oid === planned.current, "replay preflight moved HEAD");
        const baseCommit = preflightRepo.readCommit(planned.base);
        const currentCommit = preflightRepo.readCommit(planned.current);
        const incomingCommit = preflightRepo.readCommit(planned.incoming);
        sameStrings(baseCommit.parent, [], "preflight base parents");
        sameStrings(currentCommit.parent, [planned.base], "preflight current parents");
        sameStrings(incomingCommit.parent, [planned.base], "preflight incoming parents");
        const plan = collectReplay(preflightRepo, {
          kind: "cherry-pick",
          source: "topic",
          currentOid: planned.current,
        });
        assert(
          plan.sourceOid === planned.incoming &&
            plan.selectedParentOid === planned.base &&
            plan.currentOid === planned.current &&
            plan.baseTreeOid === baseCommit.tree &&
            plan.currentTreeOid === currentCommit.tree &&
            plan.incomingTreeOid === incomingCommit.tree &&
            plan.integration.entries.length === 1 &&
            plan.integration.entries[0]?.path === "topic.txt",
          "replay preflight changed the authenticated plan",
        );
        assert(
          preflightRepo.headTree() === currentCommit.tree,
          "replay preflight changed HEAD tree",
        );
        assert(
          preflightRepo.checkout.readOperationState() === null,
          "replay preflight wrote a journal",
        );
        assertTreeIndexWorktree(
          workspace,
          currentCommit.tree,
          [
            { path: "base.txt", content: "base\n" },
            { path: "main.txt", content: "main\n" },
          ],
          "replay preflight end state",
        );
      },
    );
    const preflightRow = rows[rows.length - 1];
    assert(
      preflightRow?.operation === "replay.preflight" &&
        preflightRow.statements > 0 &&
        preflightRow.rowsRead > 0,
      "replay preflight did not execute measured SQL",
    );
    await measure(
      rows,
      workspace.storage,
      "replay.plan",
      () =>
        collectReplay(workspace.repo, {
          kind: "cherry-pick",
          source: "topic",
          currentOid: planned.current,
        }),
      (value) => {
        assert(value.sourceOid === planned.incoming, "replay plan selected another commit");
        assert(value.currentOid === planned.current, "replay plan changed current commit");
        const baseTree = workspace.repo.readCommit(planned.base).tree;
        const currentTree = workspace.repo.readCommit(planned.current).tree;
        const incomingTree = workspace.repo.readCommit(planned.incoming).tree;
        assert(value.selectedParentOid === planned.base, "replay plan selected another parent");
        assert(value.baseTreeOid === baseTree, "replay plan selected another base tree");
        assert(value.currentTreeOid === currentTree, "replay plan selected another current tree");
        assert(
          value.incomingTreeOid === incomingTree,
          "replay plan selected another incoming tree",
        );
        sameStrings(
          value.integration.entries.map((entry) => entry.path),
          ["topic.txt"],
          "replay integration queue",
        );
        const replayEntry = value.integration.entries[0];
        const incomingEntry = workspace.repo.resolveTreePath(incomingTree, "topic.txt");
        assert(
          replayEntry?.kind === "clean" &&
            replayEntry.before === null &&
            replayEntry.result !== null &&
            incomingEntry !== null &&
            replayEntry.result.oid === incomingEntry.oid &&
            replayEntry.result.mode === incomingEntry.mode &&
            replayEntry.content === null,
          "replay integration queue changed its exact result",
        );
        assert(
          workspace.repo.checkout.readOperationState() === null,
          "replay plan wrote a journal",
        );
        assertTreeIndexWorktree(
          workspace,
          currentTree,
          [
            { path: "base.txt", content: "base\n" },
            { path: "main.txt", content: "main\n" },
          ],
          "replay plan input",
        );
      },
    );
  } finally {
    planned.fixture.dispose();
  }

  const recovered = conflictingHistory();
  try {
    const workspace = await imported(recovered.fixture);
    const initial = cherryPick(workspace.context, workspace.repo, workspace.worktree, {
      source: "topic",
    });
    assert(initial.outcome === "conflicted", "replay recovery fixture did not conflict");
    writeWorkFile(workspace, "/conflict.txt", "resolved replay\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"] });
    await measure(
      rows,
      workspace.storage,
      "replay.recovery",
      () => cherryPickContinue(workspace.context, workspace.repo),
      (value) => {
        assert(value.outcome === "committed", "replay recovery did not commit");
        assert(workspace.repo.head().oid === value.oid, "replay recovery did not publish HEAD");
        const result = workspace.repo.readCommit(value.oid);
        sameStrings(result.parent, [recovered.current], "replay recovery parents");
        assert(result.tree === workspace.repo.headTree(), "replay recovery published another tree");
        assert(workspace.repo.checkout.readOperationState() === null, "replay journal survived");
        assertTreeIndexWorktree(
          workspace,
          result.tree,
          [{ path: "conflict.txt", content: "resolved replay\n" }],
          "replay recovery",
        );
      },
    );
  } finally {
    recovered.fixture.dispose();
  }
}

async function rebaseRows(rows: ResultRow[]): Promise<void> {
  const planned = rebaseHistory();
  try {
    const workspace = await imported(planned.fixture);
    const first = planned.fixture.git("rev-parse", `${planned.current}^`);
    await measure(
      rows,
      workspace.storage,
      "rebase.plan",
      () => planRebase(workspace.repo, { upstream: "upstream", currentOid: planned.current }),
      (value) => {
        assert(value.relation === "replay", "rebase plan relation changed");
        assert(value.originalHeadOid === planned.current, "rebase plan changed original HEAD");
        assert(value.upstreamOid === planned.incoming, "rebase plan selected another upstream");
        assert(value.baseOid === planned.base, "rebase plan selected another base");
        sameStrings(
          value.steps.map((step) => step.sourceOid),
          [first, planned.current],
          "rebase source queue",
        );
        sameStrings(
          value.steps.map((step) => step.selectedParentOid ?? ""),
          [planned.base, first],
          "rebase parent queue",
        );
        for (const step of value.steps) {
          assert(
            step.mainline === null && step.outcome === "pending" && step.resultOid === null,
            "rebase plan changed pending queue state",
          );
        }
        assert(
          workspace.repo.checkout.readOperationState() === null,
          "rebase plan wrote a journal",
        );
        assertTreeIndexWorktree(
          workspace,
          workspace.repo.readCommit(planned.current).tree,
          [
            { path: "base.txt", content: "base\n" },
            { path: "current-1.txt", content: "one\n" },
            { path: "current-2.txt", content: "two\n" },
          ],
          "rebase plan input",
        );
      },
    );
  } finally {
    planned.fixture.dispose();
  }

  const transitioned = rebaseHistory();
  try {
    const workspace = await imported(transitioned.fixture);
    await measure(
      rows,
      workspace.storage,
      "rebase.transition",
      () =>
        rebase(workspace.context, workspace.repo, workspace.worktree, [], { upstream: "upstream" }),
      (value) => {
        assert(value.outcome === "completed", "clean rebase did not complete");
        assert(value.replayed === 2, "clean rebase replayed another queue length");
        assert(value.skipped === 0 && value.fastForward === false, "clean rebase result changed");
        assert(workspace.repo.head().oid === value.oid, "clean rebase did not publish HEAD");
        const result = workspace.repo.readCommit(value.oid);
        const rewrittenFirst = result.parent[0];
        assert(rewrittenFirst !== undefined, "clean rebase lost its first replayed commit");
        sameStrings(
          workspace.repo.readCommit(rewrittenFirst).parent,
          [transitioned.incoming],
          "first rebased parents",
        );
        sameStrings(result.parent, [rewrittenFirst], "final rebased parents");
        assert(result.tree === workspace.repo.headTree(), "clean rebase published another tree");
        assert(workspace.repo.checkout.readOperationState() === null, "rebase journal survived");
        assertTreeIndexWorktree(
          workspace,
          result.tree,
          [
            { path: "base.txt", content: "base\n" },
            { path: "current-1.txt", content: "one\n" },
            { path: "current-2.txt", content: "two\n" },
            { path: "upstream.txt", content: "upstream\n" },
          ],
          "clean rebase",
        );
      },
    );
  } finally {
    transitioned.fixture.dispose();
  }

  const measureScale = async (
    operation: "rebase.transition-n" | "rebase.transition-2n",
    steps: number,
  ): Promise<void> => {
    const history = rebaseHistory(steps, true);
    try {
      const workspace = await imported(history.fixture);
      await measure(
        rows,
        workspace.storage,
        operation,
        () =>
          rebase(workspace.context, workspace.repo, workspace.worktree, [], {
            upstream: "upstream",
          }),
        (value) => {
          assert(value.outcome === "completed", `${operation} did not complete`);
          assert(value.replayed === steps, `${operation} replayed another queue length`);
          assert(value.skipped === 0 && value.fastForward === false, `${operation} changed`);
          assert(workspace.repo.checkout.readOperationState() === null, `${operation} survived`);
        },
      );
    } finally {
      history.fixture.dispose();
    }
  };
  await measureScale("rebase.transition-n", 4);
  await measureScale("rebase.transition-2n", 8);
}

async function packUncachedReadRow(rows: ResultRow[]): Promise<void> {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const data = utf8.encode("cold packed source authentication\n");
  const oid = hashObject("blob", data);
  const packed = await store.packs.ingest(slices(singleBlobPack(data), 64));

  const genericDb = new TestDatabase(db.storage);
  const genericDatabase = new SqliteGitDatabase(genericDb, { chunkBytes: 0, objectCacheBytes: 0 });
  const genericCheckout = genericDatabase.checkoutAt("/repo");
  assert(genericCheckout !== null, "generic uncached read lost its checkout");
  const generic = genericDatabase.openCheckout(genericCheckout);
  await measure(
    rows,
    genericDb.storage,
    "pack.uncached-read",
    () => generic.readAuthenticatedObject(oid, "blob"),
    (object) => {
      assert(
        object !== null && object.type === "blob",
        "generic uncached read lost the packed blob",
      );
      sameBytes(object.data, data, "generic uncached authenticated blob");
      assert(
        generic.packs.completePackedEntry(oid)?.packId === packed.packId,
        "generic uncached read changed canonical pack ownership",
      );
    },
  );
}

async function packFallbackAuditRow(rows: ResultRow[]): Promise<void> {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const checkout = database.createRepository("/repo", "ref: refs/heads/main");
  const store = database.openCheckout(checkout);
  const data = utf8.encode("authenticated fallback audit\n");
  const oid = hashObject("blob", data);
  const pack = singleBlobPack(data);
  const primary = await store.packs.ingest(slices(pack, 64));
  const fallback = await store.packs.ingest(slices(pack, 64));
  assert(primary.packId !== fallback.packId, "fallback pack reused the primary id");
  assert(
    store.packs.completePackedEntry(oid)?.packId === primary.packId,
    "primary pack did not own the object before fallback audit",
  );

  const coldDb = new TestDatabase(db.storage);
  const coldDatabase = new SqliteGitDatabase(coldDb, { chunkBytes: 0, objectCacheBytes: 0 });
  const coldCheckout = coldDatabase.checkoutAt("/repo");
  assert(coldCheckout !== null, "fallback audit cold reopen lost its checkout");
  const cold = coldDatabase.openCheckout(coldCheckout);
  await measure(
    rows,
    coldDb.storage,
    "pack.fallback-audit",
    () => cold.packs.deleteCompletePacks([primary.packId]),
    (removed) => {
      assert(removed === 1, "fallback audit did not delete the primary pack");
      assert(
        cold.packs.completePackedEntry(oid)?.packId === fallback.packId,
        "fallback audit did not promote the authenticated fallback",
      );
    },
  );

  const authenticatedDb = new TestDatabase(db.storage);
  const authenticatedDatabase = new SqliteGitDatabase(authenticatedDb, {
    chunkBytes: 0,
    objectCacheBytes: 0,
  });
  const authenticatedCheckout = authenticatedDatabase.checkoutAt("/repo");
  assert(authenticatedCheckout !== null, "fallback audit result lost its checkout");
  const authenticated = authenticatedDatabase.openCheckout(authenticatedCheckout);
  assert(
    authenticated.packs.completePackedEntry(oid)?.packId === fallback.packId,
    "fallback promotion did not survive a cold reopen",
  );
  const object = authenticated.readAuthenticatedObject(oid, "blob");
  assert(object !== null && object.type === "blob", "fallback object failed authentication");
  sameBytes(object.data, data, "authenticated fallback object");
  assert(
    authenticatedDb.scalar<number>(
      "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND state = 'complete'",
      authenticated.sharedRepoId,
    ) === 1,
    "fallback audit left another complete pack",
  );
}

async function indexTrackerDirtyRow(rows: ResultRow[]): Promise<void> {
  const workspace = makeRepo("/");
  const checkoutId = workspace.repo.checkout.checkoutId;
  const baseline = workspace.repo.store.write("tree", serializeTree([]));
  const entries = Array.from({ length: 1_024 }, (_, index) => ({
    path: `dirty-${String(index).padStart(4, "0")}`,
    flags: index % 2 === 0 ? INDEX_DIRTY : WORKTREE_DIRTY,
  }));
  assert(
    resealIndexTracker(workspace.database.db, checkoutId, baseline, entries),
    "index tracker fixture did not seal",
  );
  await measure(
    rows,
    workspace.storage,
    "index-tracker.dirty",
    () => [...iterateIndexTrackerDirty(workspace.database.db, checkoutId)],
    (dirty) => {
      assert(dirty.length === entries.length, "index tracker traversal changed row count");
      for (let index = 0; index < entries.length; index++) {
        const actual = dirty[index];
        const expected = entries[index];
        assert(
          actual !== undefined &&
            expected !== undefined &&
            actual.path === expected.path &&
            actual.flags === expected.flags,
          `index tracker traversal changed row ${index}`,
        );
      }
      const state = readIndexTrackerState(workspace.database.db, checkoutId);
      assert(
        state.available && state.baselineTreeOid === baseline,
        "index tracker traversal changed reseal state",
      );
    },
  );

  const nextBlob = workspace.repo.store.write("blob", utf8.encode("next baseline\n"));
  const nextBaseline = workspace.repo.store.write(
    "tree",
    serializeTree([{ mode: MODE_FILE, name: "next.txt", oid: nextBlob }]),
  );
  await measure(
    rows,
    workspace.storage,
    "index-tracker.reseal",
    () => resealIndexTracker(workspace.database.db, checkoutId, nextBaseline, entries),
    (resealed) => {
      assert(resealed, "index tracker did not reseal after traversal");
      const state = readIndexTrackerState(workspace.database.db, checkoutId);
      assert(
        state.available && state.baselineTreeOid === nextBaseline,
        "index tracker lost its post-traversal reseal state",
      );
      const dirty = [...iterateIndexTrackerDirty(workspace.database.db, checkoutId)];
      assert(dirty.length === entries.length, "index tracker reseal changed row count");
      for (let index = 0; index < entries.length; index++) {
        const actual = dirty[index];
        const expected = entries[index];
        assert(
          actual !== undefined &&
            expected !== undefined &&
            actual.path === expected.path &&
            actual.flags === expected.flags,
          `index tracker reseal changed row ${index}`,
        );
      }
    },
  );
}

/** One packed delta chain of `depth` edges, terminating in a full blob. */
function markChainPack(depth: number): { bytes: Uint8Array; headOid: string } {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(depth + 1);
  let value = utf8.encode("mark chain terminal\n");
  let oid = hashObject("blob", value);
  writer.object("blob", value);
  for (let index = 0; index < depth; index++) {
    const baseLength = value.length;
    const baseOid = oid;
    value = utf8.encode(`mark chain link ${index}\n`);
    oid = hashObject("blob", value);
    writer.refDelta(
      baseOid,
      concat([encodeDeltaHeader(baseLength, value.length), new Uint8Array([value.length]), value]),
    );
  }
  writer.finish();
  return { bytes: concat(chunks), headOid: oid };
}

/** Dependency work over a chain of N and 2N canonical physical edges. */
async function maintenanceMarkRows(rows: ResultRow[]): Promise<void> {
  const depths: readonly (readonly [RequiredRow, number])[] = [
    ["maintenance.mark-depth-n", 64],
    ["maintenance.mark-depth-2n", 128],
  ];
  for (const [operation, depth] of depths) {
    const db = new TestDatabase();
    const database = new SqliteGitDatabase(db, { objectCacheBytes: 0 });
    const checkout = database.createRepository("/repo", "ref: refs/heads/main");
    const store = database.openCheckout(checkout);
    const chain = markChainPack(depth);
    await store.packs.ingest(slices(chain.bytes, 64 * 1024));
    const generation = db.scalar<number>(
      "SELECT source_generation FROM git_repositories WHERE id = ?",
      checkout.repoId,
    );
    assert(generation !== undefined, "maintenance mark fixture lost its source generation");
    db.run(
      `INSERT OR IGNORE INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
       VALUES (?, 0, 2)`,
      checkout.repoId,
    );
    db.run(
      `INSERT INTO git_maintenance_runs
         (repo_id, run_id, observed_root_epoch, observed_source_generation, phase, started_ms,
          root_source, reachable_objects, queued_objects)
       VALUES (?, 1, 0, ?, 'mark', 1, 'done', 0, 1)`,
      checkout.repoId,
      generation,
    );
    db.run(
      `INSERT INTO git_maintenance_objects
         (repo_id, run_id, oid, source_mask, expanded, shallow_boundary, physical_only, edge_cursor)
       VALUES (?, 1, ?, 1, 0, 0, 0, 0)`,
      checkout.repoId,
      chain.headOid,
    );
    await measure(
      rows,
      db.storage,
      operation,
      () => {
        for (let calls = 0; calls < 10_000; calls++) {
          if (advanceMaintenanceMark(store.shared).status === "complete") return calls + 1;
        }
        throw new Error("maintenance mark did not complete");
      },
      (calls) => {
        assert(calls > 0, "maintenance mark made no progress");
        assert(
          db.scalar<string>(
            "SELECT phase FROM git_maintenance_runs WHERE repo_id = ?",
            checkout.repoId,
          ) === "classify-loose",
          "maintenance mark did not settle",
        );
        assert(
          db.scalar<number>(
            "SELECT count(*) FROM git_maintenance_objects WHERE repo_id = ?",
            checkout.repoId,
          ) ===
            depth + 1,
          "maintenance mark did not reach the whole chain",
        );
      },
    );
  }
}

async function transportRows(rows: ResultRow[]): Promise<void> {
  const fixture = new GitFixture().init();
  fixture.write("README.md", "base\n");
  const base = fixture.commit("base");
  const server = await startGitServer(fixture.dir);
  try {
    const discoveryStorage = new SqliteTestStorage();
    const discoveryWorkspace = new Workspace({
      storage: discoveryStorage,
      git: createGit(),
      now: () => 1_600_000_000_000,
      defaultGitIdentity: IDENTITY,
    });
    const discoveryGit = discoveryWorkspace.git;
    await discoveryGit.init({ dir: "/" });
    await measure(
      rows,
      discoveryStorage,
      "transport.discovery",
      () => discoveryGit.lsRemote({ url: server.url }),
      (value) => {
        assert(
          value.refs.some((ref) => ref.name === "refs/heads/main" && ref.oid === base),
          "discovery lost main",
        );
      },
    );

    const storage = new SqliteTestStorage();
    const workspace = new Workspace({
      storage,
      git: createGit(),
      now: () => 1_600_000_000_000,
      defaultGitIdentity: IDENTITY,
    });
    await workspace.git.clone({ url: server.url, dir: "/repo" });
    fixture.write("remote.txt", "remote\n");
    const remote = fixture.commit("remote");
    await measure(
      rows,
      storage,
      "transport.fetch",
      () => workspace.git.fetch({ dir: "/repo" }),
      async () => {
        assert(
          (await workspace.git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" })) ===
            remote,
          "fetch did not publish tracking state",
        );
      },
    );

    workspace.filesystem.writeFile("/repo/local.txt", utf8.encode("local\n"));
    await workspace.git.add({ dir: "/repo", paths: ["local.txt"] });
    const local = (await workspace.git.commit({ dir: "/repo", message: "local" })).oid;
    await measure(
      rows,
      storage,
      "transport.push",
      () => workspace.git.push({ dir: "/repo", remoteRef: "statement-bench" }),
      (value) => {
        assert(value.ok === true, "push did not report success");
        assert(
          fixture.git("rev-parse", "refs/heads/statement-bench") === local,
          "push did not publish the remote branch",
        );
      },
    );
  } finally {
    await server.close();
    fixture.dispose();
  }
}

function nextjsRow(
  value: unknown,
  operation: NextjsReference["operation"],
  source: string,
): NextjsReference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Reflect.get(value, "operation") !== operation) return null;
  if (Reflect.get(value, "status") !== "ok") return null;
  const statements = Reflect.get(value, "statements");
  const rowsRead = Reflect.get(value, "rows");
  if (!Number.isSafeInteger(statements) || typeof statements !== "number" || statements < 0) {
    return null;
  }
  if (!Number.isSafeInteger(rowsRead) || typeof rowsRead !== "number" || rowsRead < 0) return null;
  return { operation, statements, rowsRead, source };
}

function requiredNextjsOperation(value: unknown): NextjsReference["operation"] | null {
  if (typeof value !== "string") return null;
  for (const reference of FROZEN_NEXTJS_REFERENCES) {
    if (reference.operation === value) return reference.operation;
  }
  return null;
}

function parseNextjsReferences(value: unknown, source: string): NextjsReference[] {
  if (!Array.isArray(value)) throw new Error("Next.js benchmark result is not an array");
  const found: NextjsReference[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const operation = requiredNextjsOperation(Reflect.get(candidate, "operation"));
    if (operation === null) continue;
    const row = nextjsRow(candidate, operation, source);
    if (row === null) throw new Error(`Next.js benchmark has malformed ${operation}`);
    if (found.some((existing) => existing.operation === operation)) {
      throw new Error(`Next.js benchmark duplicates ${operation}`);
    }
    found.push(row);
  }
  return FROZEN_NEXTJS_REFERENCES.map((baseline) => {
    const row = found.find((candidate) => candidate.operation === baseline.operation);
    if (row === undefined) throw new Error(`Next.js benchmark is missing ${baseline.operation}`);
    return row;
  });
}

function checkNextjsReferenceParser(): void {
  const valid = FROZEN_NEXTJS_REFERENCES.map((reference) => ({
    operation: reference.operation,
    status: "ok",
    statements: reference.statements,
    rows: reference.rowsRead,
  }));
  const duplicate = valid[0];
  const firstReference = FROZEN_NEXTJS_REFERENCES[0];
  assert(
    duplicate !== undefined && firstReference !== undefined,
    "Next.js parser fixture is empty",
  );
  assert(
    parseNextjsReferences([...valid, { operation: "git.status", status: "error" }], "self-test")
      .length === 3,
    "Next.js parser rejected unrelated phases",
  );
  const expectFailure = (input: unknown, label: string): void => {
    let failed = false;
    try {
      parseNextjsReferences(input, "self-test");
    } catch {
      failed = true;
    }
    assert(failed, `Next.js parser accepted ${label}`);
  };
  expectFailure(valid.slice(0, -1), "a missing required row");
  expectFailure([...valid, duplicate], "a duplicate required row");
  expectFailure(
    [
      {
        operation: firstReference.operation,
        status: "ok",
        statements: -1,
        rows: 0,
      },
      ...valid,
    ],
    "a malformed required row before a valid duplicate",
  );
}

interface NextjsInput {
  references: NextjsReference[];
  /** Only an explicitly named result gates; the default result is report-only. */
  gated: boolean;
}

function readNextjsReferences(path: string, source: string): NextjsReference[] {
  return parseNextjsReferences(JSON.parse(readFileSync(path, "utf8")), source);
}

function loadNextjsReferences(explicitPath: string | undefined): NextjsInput {
  if (explicitPath !== undefined) {
    return { references: readNextjsReferences(explicitPath, explicitPath), gated: true };
  }
  try {
    return {
      references: readNextjsReferences(
        join(RESULTS, "nextjs-workflow.json"),
        "bench/results/nextjs-workflow.json",
      ),
      gated: false,
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return { references: FROZEN_NEXTJS_REFERENCES.map((row) => ({ ...row })), gated: false };
    }
    throw error;
  }
}

function nextjsGateRows(references: readonly NextjsReference[]): GatedRow[] {
  return references.map((reference) => {
    const baseline = FROZEN_NEXTJS_REFERENCES.find(
      (candidate) => candidate.operation === reference.operation,
    );
    if (baseline === undefined) throw new Error(`unexpected Next.js row: ${reference.operation}`);
    return {
      operation: `nextjs:${reference.operation}`,
      statements: reference.statements,
      rowsRead: reference.rowsRead,
      baselineStatements: baseline.statements,
      baselineRowsRead: baseline.rowsRead,
    };
  });
}

function structuralFailures(rows: readonly ResultRow[]): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.operation)) failures.push(`duplicate statement row: ${row.operation}`);
    seen.add(row.operation);
  }
  for (const required of REQUIRED_ROWS) {
    if (!seen.has(required)) failures.push(`missing statement row: ${required}`);
  }
  const n = rows.find((row) => row.operation === "rebase.transition-n");
  const twoN = rows.find((row) => row.operation === "rebase.transition-2n");
  if (n !== undefined && twoN !== undefined) {
    if (twoN.statements > n.statements * 2 || twoN.rowsRead > n.rowsRead * 2) {
      failures.push(
        `rebase transition growth is not linear: N=${n.statements}/${n.rowsRead}, 2N=${twoN.statements}/${twoN.rowsRead}`,
      );
    }
  }
  const markN = rows.find((row) => row.operation === "maintenance.mark-depth-n");
  const mark2N = rows.find((row) => row.operation === "maintenance.mark-depth-2n");
  if (markN !== undefined && mark2N !== undefined) {
    if (mark2N.statements > markN.statements * 2.5 || mark2N.rowsRead > markN.rowsRead * 2.5) {
      failures.push(
        `maintenance mark growth is not linear: N=${markN.statements}/${markN.rowsRead}, ` +
          `2N=${mark2N.statements}/${mark2N.rowsRead}`,
      );
    }
  }
  return failures;
}

function checkReport(report: StatementReport, nextjsGated: boolean): GateOutcome {
  const outcome = gateRows(report.rows);
  outcome.failures.push(...structuralFailures(report.rows));
  const nextjs = gateRows(nextjsGateRows(report.nextjsReferences));
  outcome.notes.push(...nextjs.notes);
  if (nextjsGated) {
    outcome.failures.push(...nextjs.failures);
  } else {
    for (const failure of nextjs.failures) {
      outcome.notes.push(`${failure} (report-only; pass --nextjs <path> to gate)`);
    }
  }
  return outcome;
}

function printTable(report: StatementReport): void {
  process.stdout.write("operation\tSQL\trows\ttarget\tbaseline SQL\tbaseline rows\n");
  for (const row of report.rows) {
    process.stdout.write(
      `${row.operation}\t${row.statements}\t${row.rowsRead}\t${row.target}\t${row.baselineStatements}\t${row.baselineRowsRead}\n`,
    );
  }
  for (const row of report.nextjsReferences) {
    const target = row.statements <= TARGET_STATEMENTS ? "pass" : "miss";
    process.stdout.write(
      `nextjs:${row.operation}\t${row.statements}\t${row.rowsRead}\t${target}\t${row.source}\n`,
    );
  }
}

const { values: options } = parseArgs({
  options: { check: { type: "boolean", default: false }, nextjs: { type: "string" } },
});
const nextjs = loadNextjsReferences(options.nextjs);

const rows: ResultRow[] = [];
await basicRows(rows);
await ignoreLoadRow(rows);
await sparseRow(rows);
await checkoutRemoveRow(rows);
await worktreeGuardRow(rows);
await stagingAddRow(rows);
await stagingRmRow(rows);
await statusFullRow(rows);
await statusSparseRows(rows);
await stagingAddSelectedRow(rows);
await worktreeListRow(rows);
await checkoutInitialRow(rows);
await commitSparseRow(rows);
await diffIndexWorktreeRow(rows);
await fetchPublicationRow(rows);
await mergeRows(rows);
await replayRows(rows);
await rebaseRows(rows);
await packUncachedReadRow(rows);
await packFallbackAuditRow(rows);
await indexTrackerDirtyRow(rows);
await maintenanceMarkRows(rows);
await transportRows(rows);

const report: StatementReport = {
  version: 1,
  targetStatements: TARGET_STATEMENTS,
  rows,
  nextjsReferences: nextjs.references,
};
mkdirSync(RESULTS, { recursive: true });
writeFileSync(join(RESULTS, "statements.json"), `${JSON.stringify(report, null, 2)}\n`);
printTable(report);
if (options.check) {
  checkNextjsReferenceParser();
  const outcome = checkReport(report, nextjs.gated);
  for (const note of outcome.notes) process.stdout.write(`note: ${note}\n`);
  for (const failure of outcome.failures) process.stderr.write(`FAIL: ${failure}\n`);
  if (outcome.failures.length > 0) process.exitCode = 1;
}
