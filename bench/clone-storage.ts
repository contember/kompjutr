// What a clone costs in SQLite bytes, and where those bytes go.
//
// A Durable Object bills stored bytes and caps one database at 10 GB, so the
// size a clone leaves behind is a first-class number rather than a footnote to
// wall time. Each fixture is measured three ways: the whole `git.clone`, the
// same work decomposed into fetch and checkout so bytes can be attributed to
// git data versus the working tree, and what real git writes to disk for the
// identical clone.
//
// Sizes are `page_count * page_size`, which is what `SqlStorage.databaseSize`
// reports on the platform. `dbstat` attributes pages to individual tables and
// indexes, and its `payload` column is the row bytes those pages carry, so
// allocated minus payload is b-tree overhead rather than data.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { type GitServer, startGitServer } from "../tests/helpers/http-backend.js";
import {
  FIXTURE_NAMES,
  FIXTURES,
  type Fixture,
  type FixtureName,
  isFixtureName,
  ORIGIN_BRANCH,
  prepareFixture,
  trackedEntries,
} from "./fixtures.js";
import { type Harness, harness } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const REGISTER_PATH = join(HERE, "register.mjs");
const BENCHMARK_PATH = join(HERE, "clone-storage.ts");
const LEASE_MARKER = "KOMPJUTR_CLONE_STORAGE_LEASED";
/** Two whole SMT pairs, one thread each: one for the client, one for the origin. */
const LEASE_VCPUS = 4;
const LEASE_LOGICAL_CPUS = 2;
const REPO = "/repo";

/**
 * Every table the runtime may create, mapped to the cost it belongs to.
 * A table missing from here fails the run: an unclassified table would
 * silently drop out of the totals and make the report understate the cost.
 */
const TABLE_GROUPS = new Map<string, string>([
  ["git_pack_meta", "pack"],
  ["git_pack_data", "pack"],
  ["git_pack_objects", "pack"],
  ["git_pack_pending", "pack"],
  ["git_objects", "loose objects"],
  ["git_object_chunks", "loose objects"],
  ["git_commits", "loose objects"],
  ["git_tree_sources", "tree projection"],
  ["git_tree_entries", "tree projection"],
  ["git_tree_effective", "tree projection"],
  ["git_index", "index"],
  ["git_index_state", "index"],
  ["git_index_dirty", "index"],
  ["git_blob_ids", "index"],
  ["git_blob_id_state", "index"],
  ["fs_meta", "working tree"],
  ["fs_nodes", "working tree"],
  ["fs_paths", "working tree"],
  ["fs_chunks", "working tree"],
  ["git_meta", "repository"],
  ["git_repositories", "repository"],
  ["git_refs", "repository"],
  ["git_config", "repository"],
  ["git_shallow", "repository"],
  ["git_reflog_state", "repository"],
  ["git_reflog_entries", "repository"],
  ["git_operation_state", "repository"],
  ["git_operation_steps", "repository"],
  ["git_operation_touched", "repository"],
  ["shell_sessions", "repository"],
  ["sqlite_schema", "schema"],
  ["sqlite_sequence", "schema"],
]);

const GROUP_ORDER = [
  "pack",
  "loose objects",
  "tree projection",
  "index",
  "working tree",
  "repository",
  "schema",
] as const;

/** Tables whose row count says something about the bytes above it. */
const COUNTED_TABLES = [
  "git_pack_data",
  "git_pack_objects",
  "git_objects",
  "git_object_chunks",
  "git_commits",
  "git_tree_sources",
  "git_tree_entries",
  "git_index",
  "git_blob_ids",
  "fs_nodes",
  "fs_paths",
  "fs_chunks",
] as const;

interface Sample {
  /** The operation label, as the report prints it. */
  name: string;
  wallMs: number;
  statements: number;
  rows: number;
  /** `page_count * page_size` once the operation returned. */
  databaseBytes: number;
}

interface ObjectUsage {
  name: string;
  table: string;
  kind: "table" | "index";
  pages: number;
  allocatedBytes: number;
  payloadBytes: number;
  unusedBytes: number;
}

interface GroupUsage {
  group: string;
  pages: number;
  allocatedBytes: number;
  payloadBytes: number;
}

interface StorageSnapshot {
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  /** What the platform would report: `page_count * page_size`. */
  databaseBytes: number;
  /** The main database file after a truncating WAL checkpoint. */
  fileBytes: number;
  /** `page_count * page_size` after VACUUM. A local diagnostic only. */
  vacuumedBytes: number;
  attributedBytes: number;
  payloadBytes: number;
  objects: ObjectUsage[];
  groups: GroupUsage[];
  rowCounts: Record<string, number>;
}

interface CheckoutFacts {
  head: string;
  indexEntries: number;
  worktreeFiles: number;
}

interface GitBaseline {
  wallMs: number;
  gitDirBytes: number;
  worktreeBytes: number;
  worktreeFiles: number;
  worktreeDirectories: number;
  worktreeSymlinks: number;
}

interface FixtureResult {
  fixture: FixtureName;
  url: string;
  ref: string;
  revision: string;
  trackedFiles: number;
  clone: Sample;
  cloneFacts: CheckoutFacts;
  storage: StorageSnapshot;
  phases: Sample[];
  phasedFacts: CheckoutFacts;
  /** Decomposed total minus whole-clone total. Zero would be luck, not a law. */
  phasedDivergenceBytes: number;
  git: GitBaseline;
}

interface CpuAffinity {
  observedCpuList: string | null;
  observedLogicalCpus: number | null;
}

interface LeaseEvidence {
  required: boolean;
  active: boolean;
  requestedVcpus: number;
  noSmt: boolean;
  entryCommand: string;
  executedCommand: string[] | null;
  affinity: CpuAffinity;
}

function checkedAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not an integer: ${String(value)}`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not text: ${String(value)}`);
  return value;
}

function parseNonnegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} is not a non-negative integer: ${value}`);
  return Number.parseInt(value, 10);
}

function pragmaInteger(db: DatabaseSync, query: string, key: string): number {
  const row = db.prepare(query).get();
  if (row === undefined) throw new Error(`${query} returned no row`);
  return requireInteger(Reflect.get(row, key), key);
}

function scalarInteger(db: DatabaseSync, query: string, key: string): number {
  const row = db.prepare(query).get();
  if (row === undefined) throw new Error(`${query} returned no row`);
  return requireInteger(Reflect.get(row, key), key);
}

/**
 * A measured region. The counters are reset first, so a phase never carries
 * a previous phase's statements, and the size is read afterwards through
 * prepared statements the harness does not count.
 */
async function measure(instance: Harness, name: string, run: () => Promise<void>): Promise<Sample> {
  instance.storage.resetCounters();
  const started = performance.now();
  await run();
  const wallMs = performance.now() - started;
  return {
    name,
    wallMs,
    statements: instance.storage.statementCount,
    rows: instance.storage.rowCount,
    databaseBytes: instance.storage.databaseSize(),
  };
}

function objectUsage(db: DatabaseSync): ObjectUsage[] {
  const usages: ObjectUsage[] = [];
  const statement = db.prepare(
    "SELECT d.name AS name, s.type AS type, s.tbl_name AS tbl_name, " +
      "count(*) AS pages, sum(d.pgsize) AS allocated, " +
      "sum(d.payload) AS payload, sum(d.unused) AS unused " +
      "FROM dbstat d LEFT JOIN sqlite_schema s ON s.name = d.name " +
      "GROUP BY d.name ORDER BY d.name",
  );
  for (const row of statement.iterate()) {
    const name = requireText(Reflect.get(row, "name"), "dbstat name");
    const type = Reflect.get(row, "type");
    const table = Reflect.get(row, "tbl_name");
    usages.push({
      name,
      // sqlite_schema does not describe itself, and it is a table.
      table: typeof table === "string" ? table : name,
      kind: type === "index" ? "index" : "table",
      pages: requireInteger(Reflect.get(row, "pages"), "dbstat pages"),
      allocatedBytes: requireInteger(Reflect.get(row, "allocated"), "dbstat allocated"),
      payloadBytes: requireInteger(Reflect.get(row, "payload"), "dbstat payload"),
      unusedBytes: requireInteger(Reflect.get(row, "unused"), "dbstat unused"),
    });
  }
  return usages;
}

function groupUsage(objects: readonly ObjectUsage[]): GroupUsage[] {
  const totals = new Map<string, GroupUsage>();
  const unclassified: string[] = [];
  for (const usage of objects) {
    const group = TABLE_GROUPS.get(usage.table);
    if (group === undefined) {
      unclassified.push(usage.table);
      continue;
    }
    const total = totals.get(group) ?? {
      group,
      pages: 0,
      allocatedBytes: 0,
      payloadBytes: 0,
    };
    total.pages += usage.pages;
    total.allocatedBytes += usage.allocatedBytes;
    total.payloadBytes += usage.payloadBytes;
    totals.set(group, total);
  }
  if (unclassified.length > 0) {
    throw new Error(`unclassified tables: ${[...new Set(unclassified)].sort().join(", ")}`);
  }
  const ordered: GroupUsage[] = [];
  for (const group of GROUP_ORDER) {
    const total = totals.get(group);
    if (total !== undefined) ordered.push(total);
  }
  if (ordered.length !== totals.size) {
    throw new Error("a measured group is missing from the report order");
  }
  return ordered;
}

function rowCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = scalarInteger(db, `SELECT count(*) AS n FROM ${table}`, "n");
  }
  return counts;
}

/**
 * The size the platform would bill, plus the two local views that explain it:
 * the file once WAL is folded back in, and what VACUUM could reclaim.
 */
function storageSnapshot(instance: Harness, path: string): StorageSnapshot {
  const db = instance.storage.db;
  const objects = objectUsage(db);
  const groups = groupUsage(objects);
  const pageSize = pragmaInteger(db, "PRAGMA page_size", "page_size");
  const pageCount = pragmaInteger(db, "PRAGMA page_count", "page_count");
  const freelistPages = pragmaInteger(db, "PRAGMA freelist_count", "freelist_count");
  const counts = rowCounts(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const fileBytes = statSync(path).size;
  db.exec("VACUUM");
  const vacuumedBytes = pragmaInteger(db, "PRAGMA page_count", "page_count") * pageSize;
  return {
    pageSize,
    pageCount,
    freelistPages,
    databaseBytes: pageCount * pageSize,
    fileBytes,
    vacuumedBytes,
    attributedBytes: objects.reduce((total, usage) => total + usage.allocatedBytes, 0),
    payloadBytes: objects.reduce((total, usage) => total + usage.payloadBytes, 0),
    objects,
    groups,
    rowCounts: counts,
  };
}

/**
 * What the checkout actually produced. A size measured over the wrong tree
 * is worse than no size at all, so every run proves its own end state.
 */
async function checkoutFacts(instance: Harness): Promise<CheckoutFacts> {
  const head = await instance.git.revParse({ dir: REPO, ref: "HEAD" });
  return {
    head,
    indexEntries: scalarInteger(
      instance.storage.db,
      "SELECT count(*) AS n FROM git_index WHERE stage = 0",
      "n",
    ),
    worktreeFiles: scalarInteger(
      instance.storage.db,
      "SELECT count(*) AS n FROM fs_paths p JOIN fs_nodes n ON n.inode = p.inode " +
        `WHERE p.path GLOB '${REPO}/*' AND n.type <> 'dir'`,
      "n",
    ),
  };
}

function assertCheckout(
  facts: CheckoutFacts,
  revision: string,
  files: number,
  label: string,
): void {
  if (facts.head !== revision) {
    throw new Error(`${label} checked out ${facts.head}, expected ${revision}`);
  }
  if (facts.indexEntries !== files) {
    throw new Error(`${label} indexed ${facts.indexEntries} paths, expected ${files}`);
  }
  if (facts.worktreeFiles !== files) {
    throw new Error(`${label} wrote ${facts.worktreeFiles} worktree files, expected ${files}`);
  }
}

function openHarness(directory: string, name: string): { instance: Harness; path: string } {
  const path = join(directory, `${name}.sqlite`);
  return { instance: harness("sqlite", path), path };
}

async function runClone(
  directory: string,
  fixture: Fixture,
  url: string,
): Promise<{ sample: Sample; facts: CheckoutFacts; storage: StorageSnapshot }> {
  const { instance, path } = openHarness(directory, `${fixture.name}-clone`);
  try {
    const sample = await measure(instance, "git.clone", async () => {
      await instance.git.clone({
        url,
        dir: REPO,
        ref: ORIGIN_BRANCH,
        depth: 1,
        singleBranch: true,
      });
    });
    const facts = await checkoutFacts(instance);
    return { sample, facts, storage: storageSnapshot(instance, path) };
  } finally {
    instance.storage.db.close();
  }
}

/**
 * The same clone, split at the seams the size question cares about. This is a
 * decomposition, not the clone path: `clone` has an initial-checkout fast path
 * that only a fresh repository can take, so the totals are reported side by
 * side instead of being assumed equal.
 */
async function runPhases(
  directory: string,
  fixture: Fixture,
  url: string,
): Promise<{ samples: Sample[]; facts: CheckoutFacts }> {
  const { instance } = openHarness(directory, `${fixture.name}-phases`);
  try {
    const samples: Sample[] = [];
    samples.push(
      await measure(instance, "git.init + remoteAdd", async () => {
        await instance.git.init({ dir: REPO, defaultBranch: ORIGIN_BRANCH });
        await instance.git.remoteAdd({ dir: REPO, name: "origin", url });
      }),
    );
    let fetchHead: string | null = null;
    samples.push(
      await measure(instance, "git.fetch", async () => {
        const result = await instance.git.fetch({
          dir: REPO,
          remote: "origin",
          ref: ORIGIN_BRANCH,
          depth: 1,
          singleBranch: true,
          tags: false,
        });
        fetchHead = result.fetchHead;
      }),
    );
    const tip = fetchHead;
    if (tip === null) throw new Error("fetch advertised no usable ref");
    samples.push(
      await measure(instance, "git.updateRef", async () => {
        await instance.git.updateRef({
          dir: REPO,
          ref: `refs/heads/${ORIGIN_BRANCH}`,
          value: tip,
          force: true,
        });
      }),
    );
    samples.push(
      await measure(instance, "git.checkout", async () => {
        await instance.git.checkout({ dir: REPO, ref: ORIGIN_BRANCH });
      }),
    );
    return { samples, facts: await checkoutFacts(instance) };
  } finally {
    instance.storage.db.close();
  }
}

interface TreeFacts {
  bytes: number;
  files: number;
  directories: number;
  symlinks: number;
}

/**
 * Apparent bytes, counted per entry. `du` would round every directory up to a
 * block and inflate the baseline the SQLite side is compared against.
 */
function treeFacts(root: string, exclude: string | null): TreeFacts {
  const args = [root];
  if (exclude !== null) args.push("-path", exclude, "-prune", "-o");
  args.push("-printf", "%y %s\\n");
  const listing = execFileSync("find", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const facts: TreeFacts = { bytes: 0, files: 0, directories: 0, symlinks: 0 };
  for (const line of listing.split("\n")) {
    if (line === "") continue;
    const kind = line.slice(0, 1);
    const size = parseNonnegativeInteger(line.slice(2), "find size");
    if (kind === "d") {
      facts.directories++;
      continue;
    }
    if (kind === "l") {
      facts.symlinks++;
      facts.bytes += size;
      continue;
    }
    if (kind !== "f") throw new Error(`unexpected entry type from find: ${kind}`);
    facts.files++;
    facts.bytes += size;
  }
  return facts;
}

/**
 * Run a child without blocking the event loop. The origin is an HTTP server
 * inside this process, so a synchronous git would deadlock against it.
 */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
}

/** The same clone, run by real git against the same origin. */
async function runGitBaseline(
  directory: string,
  fixture: Fixture,
  url: string,
): Promise<GitBaseline> {
  const target = join(directory, `${fixture.name}-git`);
  const started = performance.now();
  await run("git", [
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--branch",
    ORIGIN_BRANCH,
    url,
    target,
  ]);
  const wallMs = performance.now() - started;
  const gitDir = treeFacts(join(target, ".git"), null);
  const worktree = treeFacts(target, join(target, ".git"));
  rmSync(target, { recursive: true, force: true });
  return {
    wallMs,
    gitDirBytes: gitDir.bytes,
    worktreeBytes: worktree.bytes,
    worktreeFiles: worktree.files,
    worktreeDirectories: worktree.directories,
    worktreeSymlinks: worktree.symlinks,
  };
}

async function runFixture(directory: string, fixture: Fixture): Promise<FixtureResult> {
  const dir = prepareFixture(fixture);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const trackedFiles = trackedEntries(dir).length;
  let origin: GitServer | null = null;
  try {
    origin = await startGitServer(join(dir, ".git"));
    const cloned = await runClone(directory, fixture, origin.url);
    assertCheckout(cloned.facts, revision, trackedFiles, `${fixture.name} clone`);
    const phased = await runPhases(directory, fixture, origin.url);
    assertCheckout(phased.facts, revision, trackedFiles, `${fixture.name} phased clone`);
    const git = await runGitBaseline(directory, fixture, origin.url);
    if (git.worktreeFiles + git.worktreeSymlinks !== trackedFiles) {
      throw new Error(
        `git wrote ${git.worktreeFiles + git.worktreeSymlinks} files, expected ${trackedFiles}`,
      );
    }
    const phasedTotal = checkedAt(phased.samples, phased.samples.length - 1, "last phase");
    return {
      fixture: fixture.name,
      url: fixture.url,
      ref: fixture.ref,
      revision,
      trackedFiles,
      clone: cloned.sample,
      cloneFacts: cloned.facts,
      storage: cloned.storage,
      phases: phased.samples,
      phasedFacts: phased.facts,
      phasedDivergenceBytes: phasedTotal.databaseBytes - cloned.sample.databaseBytes,
      git,
    };
  } finally {
    await origin?.close();
  }
}

/** KiB below a mebibyte: a size table that prints `0.0 MiB` says nothing. */
function size(bytes: number): string {
  if (Math.abs(bytes) >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function ratio(value: number, against: number): string {
  if (against === 0) return "n/a";
  return `${(value / against).toFixed(2)}×`;
}

function percent(value: number, against: number): string {
  if (against === 0) return "n/a";
  return `${((value / against) * 100).toFixed(1)}%`;
}

function integer(value: number): string {
  return value.toLocaleString("en-US");
}

function summaryTable(results: readonly FixtureResult[]): string[] {
  const lines = [
    "| Fixture | Files | SQLite DB | After VACUUM | git `.git` | git worktree | git total | DB / git | `git.clone` | `git clone` | SQL | Rows |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const result of results) {
    const gitTotal = result.git.gitDirBytes + result.git.worktreeBytes;
    lines.push(
      `| \`${result.fixture}\` | ${integer(result.trackedFiles)} | ` +
        `${size(result.storage.databaseBytes)} | ${size(result.storage.vacuumedBytes)} | ` +
        `${size(result.git.gitDirBytes)} | ${size(result.git.worktreeBytes)} | ` +
        `${size(gitTotal)} | ${ratio(result.storage.databaseBytes, gitTotal)} | ` +
        `${result.clone.wallMs.toFixed(0)} ms | ${result.git.wallMs.toFixed(0)} ms | ` +
        `${integer(result.clone.statements)} | ${integer(result.clone.rows)} |`,
    );
  }
  return lines;
}

function groupTable(result: FixtureResult): string[] {
  const lines = [
    "| Group | Pages | Allocated | Payload | Overhead | Share |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const group of result.storage.groups) {
    lines.push(
      `| ${group.group} | ${integer(group.pages)} | ${size(group.allocatedBytes)} | ` +
        `${size(group.payloadBytes)} | ` +
        `${percent(group.allocatedBytes - group.payloadBytes, group.allocatedBytes)} | ` +
        `${percent(group.allocatedBytes, result.storage.databaseBytes)} |`,
    );
  }
  // dbstat attributes no page to the freelist, the lock page or the header.
  const attributedPages = result.storage.objects.reduce((total, usage) => total + usage.pages, 0);
  const free = result.storage.databaseBytes - result.storage.attributedBytes;
  lines.push(
    `| free and unattributed | ${integer(result.storage.pageCount - attributedPages)} | ` +
      `${size(free)} | — | — | ${percent(free, result.storage.databaseBytes)} |`,
  );
  lines.push(
    `| **total** | ${integer(result.storage.pageCount)} | ` +
      `**${size(result.storage.databaseBytes)}** | ` +
      `${size(result.storage.payloadBytes)} | ` +
      `${percent(result.storage.databaseBytes - result.storage.payloadBytes, result.storage.databaseBytes)} | ` +
      "100.0% |",
  );
  return lines;
}

function objectTable(result: FixtureResult): string[] {
  const lines = [
    "| Object | Kind | Pages | Allocated | Payload | Rows |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  const ordered = [...result.storage.objects].sort(
    (left, right) => right.allocatedBytes - left.allocatedBytes,
  );
  for (const usage of ordered) {
    if (usage.pages < 2) continue;
    const rows = result.storage.rowCounts[usage.name];
    lines.push(
      `| \`${usage.name}\` | ${usage.kind} | ${integer(usage.pages)} | ` +
        `${size(usage.allocatedBytes)} | ${size(usage.payloadBytes)} | ` +
        `${rows === undefined ? "—" : integer(rows)} |`,
    );
  }
  return lines;
}

function phaseTable(result: FixtureResult): string[] {
  const lines = [
    "| Phase | Wall | SQL | Rows | DB after | Added |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  let previous = 0;
  for (const phase of result.phases) {
    lines.push(
      `| \`${phase.name}\` | ${phase.wallMs.toFixed(1)} ms | ${integer(phase.statements)} | ` +
        `${integer(phase.rows)} | ${size(phase.databaseBytes)} | ` +
        `${size(phase.databaseBytes - previous)} |`,
    );
    previous = phase.databaseBytes;
  }
  return lines;
}

function markdown(results: readonly FixtureResult[], environment: object): string {
  const lines = [
    "# Clone storage benchmark",
    "",
    "How many SQLite bytes a shallow clone costs, and which tables hold them.",
    "Generated by `npm run bench:clone-storage`; regenerated output, not a curated snapshot.",
    "",
    "```json",
    JSON.stringify(environment, null, 2),
    "```",
    "",
    "Sizes are `page_count * page_size`, the same quantity `SqlStorage.databaseSize`",
    "reports on the platform. The git baseline is a real `git clone --depth 1` from the",
    "same origin, counted as apparent bytes per entry. Small fixtures amortise nothing:",
    "read the ladder for scaling and `nextjs` for the number that matters.",
    "",
    "## Summary",
    "",
    ...summaryTable(results),
  ];
  for (const result of results) {
    const gitTotal = result.git.gitDirBytes + result.git.worktreeBytes;
    lines.push(
      "",
      `## \`${result.fixture}\` — ${result.url} at \`${result.ref}\``,
      "",
      `Revision \`${result.revision}\`, ${integer(result.trackedFiles)} tracked files.`,
      `The clone ran ${integer(result.clone.statements)} statements over ` +
        `${integer(result.clone.rows)} rows and left ${size(result.storage.databaseBytes)}, ` +
        `${ratio(result.storage.databaseBytes, gitTotal)} what git writes to disk ` +
        `(${size(result.git.gitDirBytes)} of \`.git\` plus ` +
        `${size(result.git.worktreeBytes)} of working tree).`,
      "",
      "### Where the bytes go",
      "",
      ...groupTable(result),
      "",
      "### Objects over one page",
      "",
      ...objectTable(result),
      "",
      "### Decomposed clone",
      "",
      "`init` → `fetch` → `updateRef` → `checkout`, in a separate database. This is a",
      "decomposition, not the clone path: `clone` takes an initial-checkout fast path a",
      "fresh repository alone can take.",
      "",
      ...phaseTable(result),
      "",
      `Decomposed total ${size(checkedAt(result.phases, result.phases.length - 1, "last phase").databaseBytes)} ` +
        `against ${size(result.clone.databaseBytes)} for \`git.clone\`, a difference of ` +
        `${size(result.phasedDivergenceBytes)}.`,
      "",
      "### SQLite overhead",
      "",
      `| Measure | Bytes |`,
      `| --- | ---: |`,
      `| Row payload | ${size(result.storage.payloadBytes)} |`,
      `| Allocated to tables and indexes | ${size(result.storage.attributedBytes)} |`,
      `| Database (\`page_count * page_size\`) | ${size(result.storage.databaseBytes)} |`,
      `| Main file after a truncating checkpoint | ${size(result.storage.fileBytes)} |`,
      `| Database after \`VACUUM\` | ${size(result.storage.vacuumedBytes)} |`,
      "",
      `Page size ${integer(result.storage.pageSize)} B, ${integer(result.storage.pageCount)} pages, ` +
        `${integer(result.storage.freelistPages)} on the freelist. Payload is ` +
        `${percent(result.storage.payloadBytes, result.storage.databaseBytes)} of the database; ` +
        `\`VACUUM\` would reclaim ` +
        `${percent(result.storage.databaseBytes - result.storage.vacuumedBytes, result.storage.databaseBytes)}. ` +
        "Durable Object SQL exposes no `VACUUM`, so treat that row as a diagnostic.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function countCpuList(value: string): number {
  let count = 0;
  for (const part of value.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      parseNonnegativeInteger(checkedAt(range, 0, "CPU number"), "CPU number");
      count++;
      continue;
    }
    if (range.length !== 2) throw new Error(`invalid CPU affinity component: ${part}`);
    const first = parseNonnegativeInteger(
      checkedAt(range, 0, "CPU range start"),
      "CPU range start",
    );
    const last = parseNonnegativeInteger(checkedAt(range, 1, "CPU range end"), "CPU range end");
    if (last < first) throw new Error(`descending CPU affinity range: ${part}`);
    count += last - first + 1;
  }
  return count;
}

function readCpuAffinity(): CpuAffinity {
  if (platform() !== "linux") return { observedCpuList: null, observedLogicalCpus: null };
  const status = readFileSync("/proc/self/status", "utf8");
  const prefix = "Cpus_allowed_list:";
  const line = status.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error("/proc/self/status has no Cpus_allowed_list");
  const observedCpuList = line.slice(prefix.length).trim();
  return { observedCpuList, observedLogicalCpus: countCpuList(observedCpuList) };
}

function leaseCommand(args: readonly string[]): string[] {
  return [
    "cpu-lease",
    "run",
    "-n",
    String(LEASE_VCPUS),
    "--no-smt",
    "--",
    process.execPath,
    "--experimental-transform-types",
    "--import",
    REGISTER_PATH,
    BENCHMARK_PATH,
    ...args,
  ];
}

function runLeasedChild(args: readonly string[]): void {
  const command = leaseCommand(args);
  execFileSync(checkedAt(command, 0, "lease executable"), command.slice(1), {
    encoding: "utf8",
    env: { ...process.env, [LEASE_MARKER]: "1" },
    maxBuffer: 1 << 28,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/**
 * Wall time is only a number if nothing else had the core. The origin server
 * runs inside the lease with the client, which is why this asks for two whole
 * pairs instead of one.
 */
function leaseEvidence(checkOnly: boolean, args: readonly string[]): LeaseEvidence {
  const affinity = readCpuAffinity();
  if (checkOnly) {
    if (process.env[LEASE_MARKER] === "1") {
      throw new Error("correctness mode must run outside the benchmark CPU lease");
    }
    return {
      required: false,
      active: false,
      requestedVcpus: 0,
      noSmt: false,
      entryCommand: "npm run bench:clone-storage -- --check",
      executedCommand: null,
      affinity,
    };
  }
  if (process.env[LEASE_MARKER] !== "1") throw new Error("measurement child lacks lease marker");
  if (platform() !== "linux") throw new Error("measurement lease verification requires Linux");
  if (affinity.observedLogicalCpus !== LEASE_LOGICAL_CPUS) {
    throw new Error(
      `cpu-lease --no-smt must expose ${LEASE_LOGICAL_CPUS} logical CPUs, ` +
        `observed ${affinity.observedCpuList ?? "none"}`,
    );
  }
  return {
    required: true,
    active: true,
    requestedVcpus: LEASE_VCPUS,
    noSmt: true,
    entryCommand: "npm run bench:clone-storage",
    executedCommand: leaseCommand(args),
    affinity,
  };
}

function sqliteVersion(): string {
  const db = new DatabaseSync(":memory:");
  try {
    const row = db.prepare("SELECT sqlite_version() AS version").get();
    if (row === undefined) throw new Error("sqlite_version returned no row");
    return requireText(Reflect.get(row, "version"), "sqlite version");
  } finally {
    db.close();
  }
}

/**
 * Which source the run measured. Node loads `src` once, at process start, so a
 * commit landing mid-run does not change the code under test — but a dirty tree
 * means the numbers belong to no commit at all, and the report must say so.
 */
function sourceRevision(): { revision: string; dirty: boolean } {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: HERE,
    encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain", "--", "src"], {
    cwd: HERE,
    encoding: "utf8",
  });
  return { revision, dirty: status.trim() !== "" };
}

function selectFixtures(names: readonly string[]): Fixture[] {
  const requested = names.length > 0 ? names : [...FIXTURE_NAMES];
  return requested.map((name) => {
    if (!isFixtureName(name)) throw new Error(`unknown fixture: ${name}`);
    return FIXTURES[name];
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const names = argv.filter((argument) => argument !== "--check");
  for (const name of names) {
    if (name.startsWith("-")) throw new Error(`unknown argument: ${name}`);
  }
  // Correctness mode proves the harness end to end on the cheapest fixture.
  const fixtures = selectFixtures(checkOnly && names.length === 0 ? ["express"] : names);
  // Fetched before the lease: the network is never inside a measured run.
  for (const fixture of fixtures) prepareFixture(fixture);
  if (!checkOnly && process.env[LEASE_MARKER] !== "1") {
    runLeasedChild(argv);
    return;
  }
  const lease = leaseEvidence(checkOnly, argv);
  const source = sourceRevision();
  const directory = mkdtempSync(join(tmpdir(), "kompjutr-clone-storage-"));
  const results: FixtureResult[] = [];
  try {
    for (const fixture of fixtures) {
      const result = await runFixture(directory, fixture);
      results.push(result);
      const gitTotal = result.git.gitDirBytes + result.git.worktreeBytes;
      process.stdout.write(
        `${result.fixture}: ${integer(result.trackedFiles)} files, ` +
          `${size(result.storage.databaseBytes)} database, ` +
          `${ratio(result.storage.databaseBytes, gitTotal)} git, ` +
          `clone ${result.clone.wallMs.toFixed(0)} ms in ${integer(result.clone.statements)} statements\n`,
      );
      rmSync(join(directory, `${fixture.name}-clone.sqlite`), { force: true });
      rmSync(join(directory, `${fixture.name}-phases.sqlite`), { force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const measuredAt = new Date().toISOString();
  const environment = {
    mode: checkOnly ? "correctness" : "measurement",
    date: measuredAt.slice(0, 10),
    measuredAt,
    node: process.version,
    sqlite: sqliteVersion(),
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
    source,
    cpuLease: lease,
  };
  if (checkOnly) {
    process.stdout.write("correctness run complete; results were not written\n");
    return;
  }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, "clone-storage.json"),
    `${JSON.stringify({ environment, results }, null, 2)}\n`,
  );
  writeFileSync(join(RESULTS, "clone-storage.md"), markdown(results, environment));
  process.stdout.write(`wrote ${join(RESULTS, "clone-storage.md")}\n`);
}

await main();
