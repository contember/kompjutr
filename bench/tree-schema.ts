// Compares the frozen v11 tree projection with the v12 source-key layout.

import { execFileSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { FIXTURES, prepareFixture } from "./fixtures.js";

type Layout = "v11-wide" | "v12-surrogate";

interface TreeSource {
  treeOid: string;
  storage: "pack";
  sourceId: number;
  objectSize: number;
  entryCount: number;
  baseCost: number;
}

interface TreeEntry {
  treeOid: string;
  storage: "pack";
  sourceId: number;
  ordinal: number;
  mode: string;
  name: string;
  nameBytes: Uint8Array;
  oid: string;
  rawEntry: Uint8Array;
  cumulativeBase: number;
}

interface Dataset {
  sources: TreeSource[];
  entries: TreeEntry[];
}

interface FixtureMetadata {
  url: string;
  ref: string;
  revision: string;
  trackedPaths: number;
  treeCount: number;
  immediateEntryCount: number;
}

interface RowCounts {
  gitTreeSources: number;
  gitTreeEntries: number;
  gitTreeEffective: number;
}

interface LogicalSnapshot {
  checksum: string;
  rowCounts: RowCounts;
}

interface WorkloadProfile {
  sqlStatements: number;
  returnedRows: number;
  checksum: string;
}

interface Profiles {
  traversal: WorkloadProfile;
  exactNameLookup: WorkloadProfile;
}

interface PageUsage {
  name: string;
  pages: number;
  bytes: number;
}

interface StorageResult {
  databaseBytes: number;
  pageSize: number;
  pageCount: number;
  objects: {
    gitTreeSources: PageUsage;
    gitTreeEntries: PageUsage;
    nameIndex: PageUsage;
    gitTreeEffective: PageUsage;
    autoindexes: PageUsage[];
  };
  combinedTreeContract: {
    pages: number;
    bytes: number;
    bytesPerEntry: number;
  };
}

interface LayoutResult {
  layout: Layout;
  logical: LogicalSnapshot;
  profiles: Profiles;
  storage: StorageResult | null;
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

interface ScalarDelta {
  old: number;
  new: number;
  absolute: number;
  percent: number | null;
}

interface PageDelta {
  pages: ScalarDelta;
  bytes: ScalarDelta;
}

interface DeltaResult {
  gitTreeSources: PageDelta;
  gitTreeEntries: PageDelta;
  nameIndex: PageDelta;
  gitTreeEffective: PageDelta;
  autoindexes: PageDelta;
  combinedTreeContract: PageDelta;
  bytesPerEntry: ScalarDelta;
}

const BENCHMARK_PATH = "bench/tree-schema.ts";
const REGISTER_PATH = "./bench/register.mjs";
const LEASE_MARKER = "KOMPJUTR_TREE_SCHEMA_BENCH_LEASED";
const TREE_QUEUE_ROW_FIXED_BYTES = 64 + 4 * 8 + 96;
const LOOKUP_SAMPLES = 2_048;
const OID_PATTERN = /^[0-9a-f]{40}$/;
const NAME_INDEX = "git_tree_entries_by_name_bytes";
const TREE_OBJECTS = ["git_tree_sources", "git_tree_entries", NAME_INDEX, "git_tree_effective"];

let fixtureDirectory = "";

function checkedAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${label} is missing at index ${index}`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not text`);
  return value;
}

function requireBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${label} is not a BLOB`);
  return value;
}

function requireOid(value: string, label: string): string {
  if (!OID_PATTERN.test(value)) throw new Error(`${label} is not a SHA-1 OID: ${value}`);
  return value;
}

function parseNonnegativeInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function compareAscii(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let at = 0; at < length; at++) {
    const difference = left.charCodeAt(at) - right.charCodeAt(at);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function git(args: string[]): string {
  if (fixtureDirectory === "") throw new Error("fixture was not prepared");
  return execFileSync("git", args, {
    cwd: fixtureDirectory,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 1 << 28,
  });
}

function findByte(bytes: Uint8Array, byte: number, start: number, end = bytes.length): number {
  for (let at = start; at < end; at++) if (bytes[at] === byte) return at;
  return -1;
}

function ascii(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function decodeOid(bytes: Uint8Array): string {
  if (bytes.byteLength !== 20) throw new Error(`binary OID has ${bytes.byteLength} bytes`);
  let oid = "";
  for (const byte of bytes) oid += byte.toString(16).padStart(2, "0");
  return requireOid(oid, "binary OID");
}

function loadTreeOids(): string[] {
  const output = git([
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype)",
  ]);
  const oids: string[] = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const fields = line.split(" ");
    const oid = fields[0];
    const type = fields[1];
    if (oid === undefined || type === undefined) throw new Error(`invalid object row: ${line}`);
    if (type === "tree") oids.push(requireOid(oid, "tree OID"));
  }
  oids.sort(compareAscii);
  return oids;
}

function loadDataset(): Dataset {
  const treeOids = loadTreeOids();
  const output = new Uint8Array(
    execFileSync("git", ["cat-file", "--batch"], {
      cwd: fixtureDirectory,
      input: `${treeOids.join("\n")}\n`,
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 1 << 28,
    }),
  );
  const sources: TreeSource[] = [];
  const entries: TreeEntry[] = [];
  const nameDecoder = new TextDecoder();
  let at = 0;
  for (const expectedOid of treeOids) {
    const headerEnd = findByte(output, 10, at);
    if (headerEnd < 0) throw new Error("cat-file tree header is truncated");
    const header = ascii(output.subarray(at, headerEnd)).split(" ");
    const oid = header[0];
    const type = header[1];
    const sizeText = header[2];
    if (oid !== expectedOid || type !== "tree" || sizeText === undefined) {
      throw new Error(`unexpected cat-file tree header: ${header.join(" ")}`);
    }
    const objectSize = parseNonnegativeInteger(sizeText, "tree object size");
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + objectSize;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`tree ${oid} content is truncated`);
    }
    let cursor = contentStart;
    let ordinal = 0;
    let cumulativeBase = 0;
    while (cursor < contentEnd) {
      const space = findByte(output, 32, cursor, contentEnd);
      const nul = findByte(output, 0, space + 1, contentEnd);
      if (space < 0 || nul < 0 || nul + 21 > contentEnd) {
        throw new Error(`tree ${oid} has an invalid entry`);
      }
      const mode = ascii(output.subarray(cursor, space));
      const nameBytes = output.slice(space + 1, nul);
      const entryOid = decodeOid(output.subarray(nul + 1, nul + 21));
      const rawEntry = output.slice(cursor, nul + 21);
      cumulativeBase +=
        TREE_QUEUE_ROW_FIXED_BYTES + nameBytes.length + mode.length + entryOid.length;
      entries.push({
        treeOid: expectedOid,
        storage: "pack",
        sourceId: 1,
        ordinal,
        mode,
        name: nameDecoder.decode(nameBytes),
        nameBytes,
        oid: entryOid,
        rawEntry,
        cumulativeBase,
      });
      ordinal++;
      cursor = nul + 21;
    }
    sources.push({
      treeOid: expectedOid,
      storage: "pack",
      sourceId: 1,
      objectSize,
      entryCount: ordinal,
      baseCost: cumulativeBase,
    });
    at = contentEnd + 1;
  }
  if (at !== output.length) throw new Error("cat-file tree output has trailing bytes");
  return { sources, entries };
}

function oldSchema(): string {
  return `
    CREATE TABLE git_tree_sources (
      repo_id INTEGER NOT NULL,
      tree_oid TEXT NOT NULL,
      storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
      source_id INTEGER NOT NULL,
      object_size INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      base_cost INTEGER NOT NULL,
      PRIMARY KEY (repo_id, tree_oid, storage, source_id)
    ) WITHOUT ROWID;
    CREATE TABLE git_tree_entries (
      repo_id INTEGER NOT NULL,
      tree_oid TEXT NOT NULL,
      storage TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      mode TEXT NOT NULL,
      name TEXT COLLATE BINARY NOT NULL,
      name_bytes BLOB NOT NULL,
      oid TEXT NOT NULL,
      raw_entry BLOB NOT NULL,
      cumulative_base INTEGER NOT NULL,
      PRIMARY KEY (repo_id, tree_oid, storage, source_id, ordinal),
      FOREIGN KEY (repo_id, tree_oid, storage, source_id)
        REFERENCES git_tree_sources (repo_id, tree_oid, storage, source_id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    ) WITHOUT ROWID;
    CREATE INDEX git_tree_entries_by_name_bytes
      ON git_tree_entries (repo_id, tree_oid, storage, source_id, name_bytes)
      WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200;
    CREATE TABLE git_tree_effective (
      repo_id INTEGER NOT NULL,
      tree_oid TEXT NOT NULL,
      storage TEXT NOT NULL CHECK (storage IN ('loose', 'pack')),
      source_id INTEGER NOT NULL,
      PRIMARY KEY (repo_id, tree_oid)
    ) WITHOUT ROWID;
  `;
}

function newSchema(): string {
  return `
    CREATE TABLE git_tree_sources (
      source_key INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
      tree_oid TEXT NOT NULL CHECK (
        typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40
      ),
      storage TEXT NOT NULL CHECK (typeof(storage) = 'text' AND storage IN ('loose', 'pack')),
      source_id INTEGER NOT NULL CHECK (typeof(source_id) = 'integer' AND source_id >= 0),
      complete INTEGER NOT NULL CHECK (typeof(complete) = 'integer' AND complete IN (0, 1)),
      object_size INTEGER NOT NULL CHECK (typeof(object_size) = 'integer' AND object_size >= 0),
      entry_count INTEGER CHECK (
        (complete = 0 AND entry_count IS NULL) OR
        (complete = 1 AND typeof(entry_count) = 'integer' AND entry_count >= 0)
      ),
      base_cost INTEGER CHECK (
        (complete = 0 AND base_cost IS NULL) OR
        (complete = 1 AND typeof(base_cost) = 'integer' AND base_cost >= 0)
      ),
      UNIQUE (repo_id, tree_oid, storage, source_id),
      UNIQUE (source_key, repo_id, tree_oid)
    );
    CREATE TABLE git_tree_entries (
      source_key INTEGER NOT NULL CHECK (typeof(source_key) = 'integer' AND source_key >= 1),
      ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
      mode TEXT NOT NULL CHECK (
        typeof(mode) = 'text' AND mode IN ('40000','040000','100644','100755','120000','160000')
      ),
      name_bytes BLOB NOT NULL CHECK (
        typeof(name_bytes) = 'blob' AND length(name_bytes) BETWEEN 1 AND 2200
      ),
      oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40),
      raw_entry BLOB NOT NULL CHECK (typeof(raw_entry) = 'blob'),
      cumulative_base INTEGER NOT NULL CHECK (
        typeof(cumulative_base) = 'integer' AND cumulative_base >= 0
      ),
      PRIMARY KEY (source_key, ordinal),
      FOREIGN KEY (source_key)
        REFERENCES git_tree_sources (source_key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    ) WITHOUT ROWID;
    CREATE INDEX git_tree_entries_by_name_bytes
      ON git_tree_entries (source_key, name_bytes)
      WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200;
    CREATE VIEW git_tree_entries_wide AS
      SELECT s.repo_id, s.tree_oid, s.storage, s.source_id,
             e.source_key, e.ordinal, e.mode,
             CAST(e.name_bytes AS TEXT) AS name, e.name_bytes, e.oid,
             e.raw_entry, e.cumulative_base
        FROM git_tree_entries e
        JOIN git_tree_sources s ON s.source_key = e.source_key;
    CREATE TABLE git_tree_effective (
      repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
      tree_oid TEXT NOT NULL CHECK (
        typeof(tree_oid) = 'text' AND length(CAST(tree_oid AS BLOB)) = 40
      ),
      source_key INTEGER NOT NULL CHECK (typeof(source_key) = 'integer' AND source_key >= 1),
      PRIMARY KEY (repo_id, tree_oid),
      FOREIGN KEY (source_key, repo_id, tree_oid)
        REFERENCES git_tree_sources (source_key, repo_id, tree_oid)
    ) WITHOUT ROWID;
  `;
}

function populateOld(db: DatabaseSync, dataset: Dataset): void {
  const source = db.prepare("INSERT INTO git_tree_sources VALUES (1, ?, ?, ?, ?, ?, ?)");
  const effective = db.prepare("INSERT INTO git_tree_effective VALUES (1, ?, ?, ?)");
  for (const row of dataset.sources) {
    source.run(
      row.treeOid,
      row.storage,
      row.sourceId,
      row.objectSize,
      row.entryCount,
      row.baseCost,
    );
    effective.run(row.treeOid, row.storage, row.sourceId);
  }
  const entry = db.prepare("INSERT INTO git_tree_entries VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of dataset.entries) {
    entry.run(
      row.treeOid,
      row.storage,
      row.sourceId,
      row.ordinal,
      row.mode,
      row.name,
      row.nameBytes,
      row.oid,
      row.rawEntry,
      row.cumulativeBase,
    );
  }
}

function populateNew(db: DatabaseSync, dataset: Dataset): void {
  const source = db.prepare(
    "INSERT INTO git_tree_sources " +
      "(repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost) " +
      "VALUES (1, ?, ?, ?, 1, ?, ?, ?) RETURNING source_key",
  );
  const effective = db.prepare("INSERT INTO git_tree_effective VALUES (1, ?, ?)");
  const keys = new Map<string, number>();
  for (const row of dataset.sources) {
    const inserted = source.get(
      row.treeOid,
      row.storage,
      row.sourceId,
      row.objectSize,
      row.entryCount,
      row.baseCost,
    );
    if (inserted === undefined) throw new Error(`source insert returned no key for ${row.treeOid}`);
    const sourceKey = requireInteger(inserted.source_key, "source key");
    keys.set(row.treeOid, sourceKey);
    effective.run(row.treeOid, sourceKey);
  }
  const entry = db.prepare("INSERT INTO git_tree_entries VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of dataset.entries) {
    const sourceKey = keys.get(row.treeOid);
    if (sourceKey === undefined) throw new Error(`tree entry has no source key: ${row.treeOid}`);
    entry.run(
      sourceKey,
      row.ordinal,
      row.mode,
      row.nameBytes,
      row.oid,
      row.rawEntry,
      row.cumulativeBase,
    );
  }
}

function buildDatabase(path: string, layout: Layout, dataset: Dataset): void {
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec("PRAGMA page_size = 4096; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY");
    memory.exec(layout === "v11-wide" ? oldSchema() : newSchema());
    if (layout === "v11-wide") populateOld(memory, dataset);
    else populateNew(memory, dataset);
    memory.prepare("VACUUM INTO ?").run(path);
  } finally {
    memory.close();
  }
}

function hashText(hash: Hash, value: string): void {
  hash.update(`${value.length}:`);
  hash.update(value);
}

function hashBytes(hash: Hash, value: Uint8Array): void {
  hash.update(`${value.byteLength}:`);
  hash.update(value);
}

function hashEntry(hash: Hash, row: Record<string, unknown>): void {
  hashText(hash, String(requireInteger(row.ordinal, "tree ordinal")));
  hashText(hash, requireText(row.mode, "tree mode"));
  hashText(hash, requireText(row.name, "tree name"));
  hashBytes(hash, requireBytes(row.name_bytes, "tree name bytes"));
  hashText(hash, requireOid(requireText(row.oid, "entry OID"), "entry OID"));
  hashBytes(hash, requireBytes(row.raw_entry, "raw tree entry"));
  hashText(hash, String(requireInteger(row.cumulative_base, "tree cumulative base")));
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get();
  if (row === undefined) throw new Error(`${table} count returned no row`);
  return requireInteger(row.count, `${table} count`);
}

function snapshot(db: DatabaseSync, layout: Layout): LogicalSnapshot {
  const hash = createHash("sha256");
  const sourcesSql =
    layout === "v11-wide"
      ? "SELECT tree_oid, storage, source_id, object_size, entry_count, base_cost " +
        "FROM git_tree_sources ORDER BY repo_id, tree_oid, storage, source_id"
      : "SELECT tree_oid, storage, source_id, complete, object_size, entry_count, base_cost " +
        "FROM git_tree_sources ORDER BY repo_id, tree_oid, storage, source_id";
  for (const row of db.prepare(sourcesSql).iterate()) {
    hashText(hash, "source");
    hashText(hash, requireOid(requireText(row.tree_oid, "tree OID"), "tree OID"));
    hashText(hash, requireText(row.storage, "tree storage"));
    hashText(hash, String(requireInteger(row.source_id, "tree source ID")));
    if (layout === "v12-surrogate" && requireInteger(row.complete, "tree complete") !== 1) {
      throw new Error("measured v12 source is incomplete");
    }
    hashText(hash, String(requireInteger(row.object_size, "tree object size")));
    hashText(hash, String(requireInteger(row.entry_count, "tree entry count")));
    hashText(hash, String(requireInteger(row.base_cost, "tree base cost")));
  }
  const entriesSql =
    layout === "v11-wide"
      ? "SELECT tree_oid, storage, source_id, ordinal, mode, name, name_bytes, oid, " +
        "raw_entry, cumulative_base FROM git_tree_entries " +
        "ORDER BY repo_id, tree_oid, storage, source_id, ordinal"
      : "SELECT tree_oid, storage, source_id, ordinal, mode, name, name_bytes, oid, " +
        "raw_entry, cumulative_base FROM git_tree_entries_wide " +
        "ORDER BY repo_id, tree_oid, storage, source_id, ordinal";
  for (const row of db.prepare(entriesSql).iterate()) {
    hashText(hash, "entry");
    hashText(hash, requireOid(requireText(row.tree_oid, "entry tree OID"), "entry tree OID"));
    hashText(hash, requireText(row.storage, "entry storage"));
    hashText(hash, String(requireInteger(row.source_id, "entry source ID")));
    hashEntry(hash, row);
  }
  const effectiveSql =
    layout === "v11-wide"
      ? "SELECT tree_oid, storage, source_id FROM git_tree_effective ORDER BY repo_id, tree_oid"
      : "SELECT f.tree_oid, s.storage, s.source_id FROM git_tree_effective f " +
        "JOIN git_tree_sources s ON s.source_key = f.source_key " +
        "ORDER BY f.repo_id, f.tree_oid";
  for (const row of db.prepare(effectiveSql).iterate()) {
    hashText(hash, "effective");
    hashText(
      hash,
      requireOid(requireText(row.tree_oid, "effective tree OID"), "effective tree OID"),
    );
    hashText(hash, requireText(row.storage, "effective storage"));
    hashText(hash, String(requireInteger(row.source_id, "effective source ID")));
  }
  return {
    checksum: hash.digest("hex"),
    rowCounts: {
      gitTreeSources: countRows(db, "git_tree_sources"),
      gitTreeEntries: countRows(db, "git_tree_entries"),
      gitTreeEffective: countRows(db, "git_tree_effective"),
    },
  };
}

function traversalProfile(
  db: DatabaseSync,
  layout: Layout,
  sources: readonly TreeSource[],
): WorkloadProfile {
  const sql =
    layout === "v11-wide"
      ? "SELECT e.ordinal, e.mode, e.name, e.name_bytes, e.oid, e.raw_entry, " +
        "e.cumulative_base FROM git_tree_effective f JOIN git_tree_entries e " +
        "ON e.repo_id = f.repo_id AND e.tree_oid = f.tree_oid " +
        "AND e.storage = f.storage AND e.source_id = f.source_id " +
        "WHERE f.repo_id = ? AND f.tree_oid = ? ORDER BY e.ordinal"
      : "SELECT e.ordinal, e.mode, CAST(e.name_bytes AS TEXT) AS name, e.name_bytes, e.oid, " +
        "e.raw_entry, e.cumulative_base FROM git_tree_effective f " +
        "JOIN git_tree_sources s ON s.source_key = f.source_key " +
        "JOIN git_tree_entries e ON e.source_key = s.source_key " +
        "WHERE f.repo_id = ? AND f.tree_oid = ? AND s.complete = 1 ORDER BY e.ordinal";
  const statement = db.prepare(sql);
  const hash = createHash("sha256");
  let returnedRows = 0;
  for (const source of sources) {
    for (const row of statement.iterate(1, source.treeOid)) {
      hashText(hash, source.treeOid);
      hashEntry(hash, row);
      returnedRows++;
    }
  }
  return { sqlStatements: sources.length, returnedRows, checksum: hash.digest("hex") };
}

function sampleLookups(entries: readonly TreeEntry[]): TreeEntry[] {
  const count = Math.min(LOOKUP_SAMPLES, entries.length);
  const samples: TreeEntry[] = [];
  for (let index = 0; index < count; index++) {
    samples.push(checkedAt(entries, Math.floor((index * entries.length) / count), "lookup entry"));
  }
  return samples;
}

function lookupProfile(
  db: DatabaseSync,
  layout: Layout,
  entries: readonly TreeEntry[],
): WorkloadProfile {
  const sql =
    layout === "v11-wide"
      ? "SELECT e.ordinal, e.mode, e.name, e.name_bytes, e.oid, e.raw_entry, " +
        "e.cumulative_base FROM git_tree_effective f JOIN git_tree_entries e " +
        "ON e.repo_id = f.repo_id AND e.tree_oid = f.tree_oid " +
        "AND e.storage = f.storage AND e.source_id = f.source_id " +
        "WHERE f.repo_id = ? AND f.tree_oid = ? AND e.name_bytes = ?"
      : "SELECT e.ordinal, e.mode, CAST(e.name_bytes AS TEXT) AS name, e.name_bytes, e.oid, " +
        "e.raw_entry, e.cumulative_base FROM git_tree_effective f " +
        "JOIN git_tree_sources s ON s.source_key = f.source_key " +
        "JOIN git_tree_entries e ON e.source_key = s.source_key " +
        "WHERE f.repo_id = ? AND f.tree_oid = ? AND s.complete = 1 AND e.name_bytes = ?";
  const statement = db.prepare(sql);
  const samples = sampleLookups(entries);
  const hash = createHash("sha256");
  let returnedRows = 0;
  for (const sample of samples) {
    for (const row of statement.iterate(1, sample.treeOid, sample.nameBytes)) {
      hashText(hash, sample.treeOid);
      hashEntry(hash, row);
      returnedRows++;
    }
  }
  if (returnedRows !== samples.length) {
    throw new Error(`exact-name workload returned ${returnedRows} rows for ${samples.length} keys`);
  }
  return { sqlStatements: samples.length, returnedRows, checksum: hash.digest("hex") };
}

function pragmaInteger(db: DatabaseSync, query: string, key: string): number {
  const row = db.prepare(query).get();
  if (row === undefined) throw new Error(`${query} returned no row`);
  return requireInteger(row[key], key);
}

function findUsage(usages: readonly PageUsage[], name: string): PageUsage {
  const usage = usages.find((candidate) => candidate.name === name);
  if (usage === undefined) throw new Error(`dbstat omitted ${name}`);
  return usage;
}

function storageResult(db: DatabaseSync, path: string, entryCount: number): StorageResult {
  const usages: PageUsage[] = [];
  for (const row of db
    .prepare(
      "SELECT name, count(*) AS pages, sum(pgsize) AS bytes " +
        "FROM dbstat GROUP BY name ORDER BY name",
    )
    .iterate()) {
    usages.push({
      name: requireText(row.name, "dbstat name"),
      pages: requireInteger(row.pages, "dbstat pages"),
      bytes: requireInteger(row.bytes, "dbstat bytes"),
    });
  }
  const gitTreeSources = findUsage(usages, "git_tree_sources");
  const gitTreeEntries = findUsage(usages, "git_tree_entries");
  const nameIndex = findUsage(usages, NAME_INDEX);
  const gitTreeEffective = findUsage(usages, "git_tree_effective");
  const autoindexes = usages.filter((usage) => usage.name.startsWith("sqlite_autoindex_git_tree_"));
  const included = new Set<string>(TREE_OBJECTS);
  for (const usage of autoindexes) included.add(usage.name);
  const unexpected = usages.filter(
    (usage) => usage.name.includes("git_tree_") && !included.has(usage.name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `unclassified tree dbstat objects: ${unexpected.map((row) => row.name).join(", ")}`,
    );
  }
  const contractObjects = [
    gitTreeSources,
    gitTreeEntries,
    nameIndex,
    gitTreeEffective,
    ...autoindexes,
  ];
  const pages = contractObjects.reduce((total, usage) => total + usage.pages, 0);
  const bytes = contractObjects.reduce((total, usage) => total + usage.bytes, 0);
  return {
    databaseBytes: statSync(path).size,
    pageSize: pragmaInteger(db, "PRAGMA page_size", "page_size"),
    pageCount: pragmaInteger(db, "PRAGMA page_count", "page_count"),
    objects: { gitTreeSources, gitTreeEntries, nameIndex, gitTreeEffective, autoindexes },
    combinedTreeContract: {
      pages,
      bytes,
      bytesPerEntry: bytes / entryCount,
    },
  };
}

function runLayout(
  directory: string,
  layout: Layout,
  dataset: Dataset,
  checkOnly: boolean,
): LayoutResult {
  const path = join(directory, `${layout}.sqlite`);
  buildDatabase(path, layout, dataset);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      layout,
      logical: snapshot(db, layout),
      profiles: {
        traversal: traversalProfile(db, layout, dataset.sources),
        exactNameLookup: lookupProfile(db, layout, dataset.entries),
      },
      storage: checkOnly ? null : storageResult(db, path, dataset.entries.length),
    };
  } finally {
    db.close();
  }
}

function assertEquivalent(old: LayoutResult, next: LayoutResult): void {
  const oldLogical = JSON.stringify(old.logical);
  const nextLogical = JSON.stringify(next.logical);
  if (oldLogical !== nextLogical) {
    throw new Error(`tree layouts differ logically\nv11 ${oldLogical}\nv12 ${nextLogical}`);
  }
  const oldProfiles = JSON.stringify(old.profiles);
  const nextProfiles = JSON.stringify(next.profiles);
  if (oldProfiles !== nextProfiles) {
    throw new Error(`tree workload profiles differ\nv11 ${oldProfiles}\nv12 ${nextProfiles}`);
  }
}

function scalarDelta(old: number, next: number): ScalarDelta {
  return {
    old,
    new: next,
    absolute: next - old,
    percent: old === 0 ? null : ((next - old) / old) * 100,
  };
}

function pageDelta(old: PageUsage, next: PageUsage): PageDelta {
  return { pages: scalarDelta(old.pages, next.pages), bytes: scalarDelta(old.bytes, next.bytes) };
}

function summedUsage(name: string, usages: readonly PageUsage[]): PageUsage {
  return {
    name,
    pages: usages.reduce((total, usage) => total + usage.pages, 0),
    bytes: usages.reduce((total, usage) => total + usage.bytes, 0),
  };
}

function requireStorage(result: LayoutResult): StorageResult {
  if (result.storage === null) throw new Error(`${result.layout} has no measurement storage`);
  return result.storage;
}

function deltaResult(old: LayoutResult, next: LayoutResult): DeltaResult {
  const oldStorage = requireStorage(old);
  const nextStorage = requireStorage(next);
  const oldCombined: PageUsage = {
    name: "combined tree contract",
    pages: oldStorage.combinedTreeContract.pages,
    bytes: oldStorage.combinedTreeContract.bytes,
  };
  const nextCombined: PageUsage = {
    name: "combined tree contract",
    pages: nextStorage.combinedTreeContract.pages,
    bytes: nextStorage.combinedTreeContract.bytes,
  };
  return {
    gitTreeSources: pageDelta(
      oldStorage.objects.gitTreeSources,
      nextStorage.objects.gitTreeSources,
    ),
    gitTreeEntries: pageDelta(
      oldStorage.objects.gitTreeEntries,
      nextStorage.objects.gitTreeEntries,
    ),
    nameIndex: pageDelta(oldStorage.objects.nameIndex, nextStorage.objects.nameIndex),
    gitTreeEffective: pageDelta(
      oldStorage.objects.gitTreeEffective,
      nextStorage.objects.gitTreeEffective,
    ),
    autoindexes: pageDelta(
      summedUsage("autoindexes", oldStorage.objects.autoindexes),
      summedUsage("autoindexes", nextStorage.objects.autoindexes),
    ),
    combinedTreeContract: pageDelta(oldCombined, nextCombined),
    bytesPerEntry: scalarDelta(
      oldStorage.combinedTreeContract.bytesPerEntry,
      nextStorage.combinedTreeContract.bytesPerEntry,
    ),
  };
}

function sqliteVersion(): string {
  const db = new DatabaseSync(":memory:");
  try {
    const row = db.prepare("SELECT sqlite_version() AS version").get();
    if (row === undefined) throw new Error("SQLite version query returned no row");
    return requireText(row.version, "SQLite version");
  } finally {
    db.close();
  }
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
    "2",
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
  const output = execFileSync(checkedAt(command, 0, "lease executable"), command.slice(1), {
    encoding: "utf8",
    env: { ...process.env, [LEASE_MARKER]: "1" },
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  });
  process.stdout.write(output);
}

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
      entryCommand: "npm run bench:tree-schema -- --check",
      executedCommand: null,
      affinity,
    };
  }
  if (process.env[LEASE_MARKER] !== "1") throw new Error("measurement child lacks lease marker");
  if (platform() !== "linux") throw new Error("measurement lease verification requires Linux");
  if (affinity.observedLogicalCpus !== 1) {
    throw new Error(
      `cpu-lease --no-smt must expose one logical CPU, observed ${affinity.observedCpuList ?? "none"}`,
    );
  }
  return {
    required: true,
    active: true,
    requestedVcpus: 2,
    noSmt: true,
    entryCommand: "npm run bench:tree-schema",
    executedCommand: leaseCommand(args),
    affinity,
  };
}

function trackedPathCount(): number {
  return git(["ls-files", "-z"])
    .split("\0")
    .filter((path) => path !== "").length;
}

function main(): void {
  const args = process.argv.slice(2);
  const checkOnly = args.length === 1 && args[0] === "--check";
  if (args.length !== 0 && !checkOnly) throw new Error(`unknown arguments: ${args.join(" ")}`);
  fixtureDirectory = prepareFixture(FIXTURES.nextjs);
  if (!checkOnly && process.env[LEASE_MARKER] !== "1") {
    runLeasedChild(args);
    return;
  }
  const lease = leaseEvidence(checkOnly, args);
  const dataset = loadDataset();
  const fixture: FixtureMetadata = {
    url: FIXTURES.nextjs.url,
    ref: FIXTURES.nextjs.ref,
    revision: requireOid(git(["rev-parse", "HEAD"]).trim(), "fixture revision"),
    trackedPaths: trackedPathCount(),
    treeCount: dataset.sources.length,
    immediateEntryCount: dataset.entries.length,
  };
  const temporary = mkdtempSync(join(tmpdir(), "kompjutr-tree-schema-"));
  try {
    const old = runLayout(temporary, "v11-wide", dataset, checkOnly);
    const next = runLayout(temporary, "v12-surrogate", dataset, checkOnly);
    assertEquivalent(old, next);
    const measuredAt = new Date().toISOString();
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: checkOnly ? "correctness" : "measurement",
          environment: {
            date: measuredAt.slice(0, 10),
            measuredAt,
            node: process.version,
            sqlite: sqliteVersion(),
            platform: platform(),
            release: release(),
            arch: process.arch,
            cpu: cpus()[0]?.model ?? "unknown",
            cpuLease: lease,
          },
          fixture,
          equivalence: {
            equivalent: true,
            checksum: old.logical.checksum,
            rowCounts: { old: old.logical.rowCounts, new: next.logical.rowCounts },
          },
          profiles: {
            equivalent: true,
            old: old.profiles,
            new: next.profiles,
          },
          layouts: { old, new: next },
          delta: checkOnly ? null : deltaResult(old, next),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main();
