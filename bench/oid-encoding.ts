// Representative schema prototype for ADR 0005. It deliberately stays separate
// from the production schema so the decision can precede a coordinated migration.

import { execFileSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { FIXTURES, prepareFixture } from "./fixtures.js";

type Encoding = "text" | "blob";
type Workload = "packed-nextjs" | "loose-shaped";

interface ObjectRecord {
  oid: string;
  type: string;
  size: number;
}

interface PackLocation {
  packId: number;
  offset: number;
  storedSize: number;
  baseOid: string | null;
}

interface PackFile {
  packId: number;
  path: string;
  bytes: Uint8Array;
}

interface IndexEntry {
  path: string;
  mode: number;
  oid: string;
  size: number;
}

interface CommitRecord {
  oid: string;
  parents: string[];
  tree: string;
  objectSize: number;
}

interface TreeSource {
  treeOid: string;
  storage: "loose" | "pack";
  sourceId: number;
  objectSize: number;
  entryCount: number;
  baseCost: number;
}

interface TreeEntry {
  treeOid: string;
  storage: "loose" | "pack";
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
  workload: Workload;
  objects: ObjectRecord[];
  packLocations: Map<string, PackLocation>;
  packs: PackFile[];
  index: IndexEntry[];
  commits: CommitRecord[];
  trees: TreeSource[];
  treeEntries: TreeEntry[];
  refs: { name: string; target: string }[];
  shallow: string[];
  conversionOids: string[];
}

interface FixtureMetadata {
  directory: string;
  ref: string;
  url: string;
  revision: string;
  git: string;
  trackedPaths: number;
  reachableObjects: number;
  uniquePackedObjects: number;
  storedPackEntries: number;
  packFiles: number;
  packBytes: number;
  trees: number;
  treeEntries: number;
}

interface Snapshot {
  rowCounts: Record<string, number>;
  decodedOidCount: number;
  decodedOidSetChecksum: string;
  rowOrderChecksum: string;
  traversal: TraversalResult;
}

interface TraversalResult {
  treeRows: number;
  commitRows: number;
  checksum: string;
}

interface PageUsage {
  name: string;
  bytes: number;
  pages: number;
}

interface SizeResult {
  fileBytes: number;
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  usedPageBytes: number;
  objects: PageUsage[];
}

interface TimingResult {
  repetitions: number;
  warmups: number;
  lookupKeys: number;
  conversionOids: number;
  statementsPerRepetition: {
    lookup: number;
    treeTraversal: number;
    commitTraversal: number;
    boundaryEncode: number;
    boundaryDecode: number;
  };
  rowsPerRepetition: {
    lookup: number;
    treeTraversal: number;
    commitTraversal: number;
  };
  lookupNs: number[];
  treeTraversalNs: number[];
  commitTraversalNs: number[];
  boundaryEncodeNs: number[];
  boundaryDecodeNs: number[];
}

interface DatabaseResult {
  encoding: Encoding;
  workload: Workload;
  snapshot: Snapshot;
  size: SizeResult;
  timings: TimingResult | null;
}

interface Options {
  checkOnly: boolean;
  repetitions: number;
  warmups: number;
}

interface LeaseEvidence {
  command: string[];
  observedCpuList: string;
  observedLogicalCpus: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_PATH = fileURLToPath(import.meta.url);
const REGISTER_PATH = join(HERE, "register.mjs");
const LEASE_MARKER = "KOMPJUTR_OID_BENCH_LEASED";
const PACK_CHUNK_BYTES = 1024 * 1024;
const LOOSE_OBJECTS = 32_768;
const LOOSE_COMMITS = 4_096;
const LOOSE_TREES = 4_096;
const LOOSE_TREE_FANOUT = 8;
const LOOKUP_KEYS = 2_048;
const OID_PATTERN = /^[0-9a-f]{40}$/;
const HEX: string[] = [];
const TABLES = [
  "git_refs",
  "git_index",
  "git_blob_ids",
  "git_shallow",
  "git_objects",
  "git_object_chunks",
  "git_pack_meta",
  "git_pack_data",
  "git_pack_objects",
  "git_commits",
  "git_tree_sources",
  "git_tree_entries",
  "git_tree_effective",
];

for (let value = 0; value < 256; value++) HEX.push(value.toString(16).padStart(2, "0"));

let timingSink = 0;
let fixtureDirectory = "";

function checkedAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${label} is missing at index ${index}`);
  return value;
}

function byteAt(bytes: Uint8Array, index: number, label: string): number {
  const value = bytes[index];
  if (value === undefined) throw new Error(`${label} is missing at byte ${index}`);
  return value;
}

function compareAscii(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let at = 0; at < length; at++) {
    const difference = left.charCodeAt(at) - right.charCodeAt(at);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function parseNonnegativeInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

function parseOptions(args: readonly string[]): Options {
  let checkOnly = false;
  let repetitions = 12;
  let warmups = 3;
  for (const arg of args) {
    if (arg === "--check") {
      checkOnly = true;
      continue;
    }
    if (arg.startsWith("--repetitions=")) {
      repetitions = parsePositiveInteger(arg.slice("--repetitions=".length), "repetitions");
      continue;
    }
    if (arg.startsWith("--warmups=")) {
      warmups = parsePositiveInteger(arg.slice("--warmups=".length), "warmups");
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { checkOnly, repetitions, warmups };
}

function fixturePath(): string {
  if (fixtureDirectory === "") throw new Error("fixture was not prepared");
  return fixtureDirectory;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: fixturePath(),
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 1 << 28,
  });
}

function requireOid(value: string, label: string): string {
  if (!OID_PATTERN.test(value)) throw new Error(`${label} is not a SHA-1 OID: ${value}`);
  return value;
}

function encodeBlob(oid: string): Uint8Array {
  requireOid(oid, "OID");
  const bytes = new Uint8Array(20);
  for (let at = 0; at < bytes.length; at++) {
    bytes[at] = Number.parseInt(oid.slice(at * 2, at * 2 + 2), 16);
  }
  return bytes;
}

function decodeBlob(bytes: Uint8Array): string {
  if (bytes.byteLength !== 20) throw new Error(`BLOB OID has ${bytes.byteLength} bytes`);
  let oid = "";
  for (const byte of bytes) oid += checkedAt(HEX, byte, "hex table");
  return oid;
}

function encodeOid(encoding: Encoding, oid: string): string | Uint8Array {
  return encoding === "text" ? requireOid(oid, "OID") : encodeBlob(oid);
}

function decodeOid(encoding: Encoding, value: unknown): string {
  if (encoding === "text") {
    if (typeof value !== "string") throw new Error("TEXT OID did not round-trip as text");
    return requireOid(value, "stored OID");
  }
  if (!(value instanceof Uint8Array)) throw new Error("BLOB OID did not round-trip as bytes");
  return decodeBlob(value);
}

function encodeParents(encoding: Encoding, parents: readonly string[]): string | Uint8Array {
  if (encoding === "text") return parents.map((oid) => requireOid(oid, "parent OID")).join(" ");
  const bytes = new Uint8Array(parents.length * 20);
  for (const [index, parent] of parents.entries()) bytes.set(encodeBlob(parent), index * 20);
  return bytes;
}

function decodeParents(encoding: Encoding, value: unknown): string[] {
  if (encoding === "text") {
    if (typeof value !== "string") throw new Error("TEXT parents did not round-trip as text");
    if (value === "") return [];
    return value.split(" ").map((oid) => requireOid(oid, "stored parent OID"));
  }
  if (!(value instanceof Uint8Array)) throw new Error("BLOB parents did not round-trip as bytes");
  if (value.byteLength % 20 !== 0) throw new Error("BLOB parents length is not divisible by 20");
  const parents: string[] = [];
  for (let at = 0; at < value.byteLength; at += 20) {
    parents.push(decodeBlob(value.subarray(at, at + 20)));
  }
  return parents;
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

function lineCount(value: string): number {
  let count = 0;
  for (const line of value.split("\n")) if (line !== "") count++;
  return count;
}

function loadObjects(): ObjectRecord[] {
  const output = git([
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ]);
  const objects: ObjectRecord[] = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const fields = line.split(" ");
    const oid = fields[0];
    const type = fields[1];
    const sizeText = fields[2];
    if (oid === undefined || type === undefined || sizeText === undefined) {
      throw new Error(`invalid cat-file row: ${line}`);
    }
    objects.push({
      oid: requireOid(oid, "fixture object"),
      type,
      size: parseNonnegativeInteger(sizeText, "object size"),
    });
  }
  objects.sort((left, right) => compareAscii(left.oid, right.oid));
  return objects;
}

function loadPackFiles(): PackFile[] {
  const directory = join(fixturePath(), ".git", "objects", "pack");
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".pack"))
    .sort(compareAscii);
  return names.map((name, index) => ({
    packId: index + 1,
    path: name,
    bytes: new Uint8Array(readFileSync(join(directory, name))),
  }));
}

function loadPackLocations(): { locations: Map<string, PackLocation>; storedEntries: number } {
  const directory = join(fixturePath(), ".git", "objects", "pack");
  const indexes = readdirSync(directory)
    .filter((name) => name.endsWith(".idx"))
    .sort(compareAscii);
  const locations = new Map<string, PackLocation>();
  let storedEntries = 0;
  for (const [index, name] of indexes.entries()) {
    const output = git(["verify-pack", "-v", join(directory, name)]);
    for (const line of output.split("\n")) {
      const fields = line.trim().split(/\s+/);
      const oid = fields[0];
      if (oid === undefined || !OID_PATTERN.test(oid)) continue;
      const storedSizeText = fields[3];
      const offsetText = fields[4];
      if (storedSizeText === undefined || offsetText === undefined) {
        throw new Error(`invalid verify-pack row: ${line}`);
      }
      storedEntries++;
      if (locations.has(oid)) continue;
      const baseField = fields[6];
      const baseOid = baseField === undefined ? null : requireOid(baseField, "delta base");
      locations.set(oid, {
        packId: index + 1,
        offset: parsePositiveInteger(offsetText, "pack offset"),
        storedSize: parsePositiveInteger(storedSizeText, "stored object size"),
        baseOid,
      });
    }
  }
  return { locations, storedEntries };
}

function loadIndex(objects: ReadonlyMap<string, ObjectRecord>): IndexEntry[] {
  const listing = git(["ls-files", "-s", "-z"]);
  const entries: IndexEntry[] = [];
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const header = record.slice(0, tab).split(" ");
    const mode = header[0];
    const oid = header[1];
    const stage = header[2];
    if (tab < 0 || mode === undefined || oid === undefined || stage !== "0") {
      throw new Error(`invalid ls-files row: ${record}`);
    }
    entries.push({
      path: record.slice(tab + 1),
      mode: Number.parseInt(mode, 8),
      oid: requireOid(oid, "index OID"),
      size: objects.get(oid)?.size ?? 0,
    });
  }
  return entries;
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

function makeRawTreeEntry(mode: string, nameBytes: Uint8Array, oid: string): Uint8Array {
  const modeBytes = new TextEncoder().encode(mode);
  const raw = new Uint8Array(modeBytes.length + nameBytes.length + 22);
  raw.set(modeBytes, 0);
  raw[modeBytes.length] = 32;
  raw.set(nameBytes, modeBytes.length + 1);
  raw[modeBytes.length + nameBytes.length + 1] = 0;
  raw.set(encodeBlob(oid), modeBytes.length + nameBytes.length + 2);
  return raw;
}

function treeEntryCost(mode: string, nameBytes: Uint8Array): number {
  return 192 + nameBytes.length + mode.length + 40;
}

function loadTrees(
  objects: readonly ObjectRecord[],
  locations: ReadonlyMap<string, PackLocation>,
): { sources: TreeSource[]; entries: TreeEntry[] } {
  const treeOids = objects.filter((object) => object.type === "tree").map((object) => object.oid);
  const output = new Uint8Array(
    execFileSync("git", ["cat-file", "--batch"], {
      cwd: fixturePath(),
      input: `${treeOids.join("\n")}\n`,
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 1 << 28,
    }),
  );
  const sources: TreeSource[] = [];
  const entries: TreeEntry[] = [];
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
    const size = parseNonnegativeInteger(sizeText, "tree size");
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`tree ${oid} content is truncated`);
    }
    const location = locations.get(oid);
    if (location === undefined) throw new Error(`tree ${oid} has no pack location`);
    let cursor = contentStart;
    let ordinal = 0;
    let cumulativeBase = 0;
    const nameDecoder = new TextDecoder();
    while (cursor < contentEnd) {
      const space = findByte(output, 32, cursor, contentEnd);
      const nul = findByte(output, 0, space + 1, contentEnd);
      if (space < 0 || nul < 0 || nul + 21 > contentEnd) {
        throw new Error(`tree ${oid} has an invalid entry`);
      }
      const mode = ascii(output.subarray(cursor, space));
      const nameBytes = output.slice(space + 1, nul);
      const entryOid = decodeBlob(output.subarray(nul + 1, nul + 21));
      const rawEntry = output.slice(cursor, nul + 21);
      cumulativeBase += treeEntryCost(mode, nameBytes);
      entries.push({
        treeOid: oid,
        storage: "pack",
        sourceId: location.packId,
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
      treeOid: oid,
      storage: "pack",
      sourceId: location.packId,
      objectSize: size,
      entryCount: ordinal,
      baseCost: cumulativeBase,
    });
    at = contentEnd + 1;
  }
  if (at !== output.length) throw new Error("cat-file tree output has trailing bytes");
  return { sources, entries };
}

function loadCommit(): CommitRecord {
  const oid = requireOid(git(["rev-parse", "HEAD"]).trim(), "fixture revision");
  const body = git(["cat-file", "-p", oid]);
  let tree = "";
  const parents: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("tree ")) tree = requireOid(line.slice(5), "commit tree");
    if (line.startsWith("parent ")) parents.push(requireOid(line.slice(7), "commit parent"));
    if (line === "") break;
  }
  if (tree === "") throw new Error("fixture commit has no tree");
  return {
    oid,
    parents,
    tree,
    objectSize: parseNonnegativeInteger(git(["cat-file", "-s", oid]).trim(), "commit size"),
  };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function loadPackedDataset(): {
  dataset: Dataset;
  fixture: FixtureMetadata;
  paths: string[];
  storedPackEntries: number;
} {
  const objects = loadObjects();
  const objectsByOid = new Map<string, ObjectRecord>();
  for (const object of objects) objectsByOid.set(object.oid, object);
  const packs = loadPackFiles();
  const { locations, storedEntries } = loadPackLocations();
  for (const object of objects) {
    if (!locations.has(object.oid)) throw new Error(`packed object ${object.oid} has no location`);
  }
  const index = loadIndex(objectsByOid);
  const commit = loadCommit();
  const trees = loadTrees(objects, locations);
  const reachableObjects = lineCount(git(["rev-list", "--objects", "--all"]));
  const packBytes = packs.reduce((total, pack) => total + pack.bytes.byteLength, 0);
  return {
    dataset: {
      workload: "packed-nextjs",
      objects,
      packLocations: locations,
      packs,
      index,
      commits: [commit],
      trees: trees.sources,
      treeEntries: trees.entries,
      refs: [{ name: "refs/heads/main", target: commit.oid }],
      shallow: [],
      conversionOids: objects.map((object) => object.oid),
    },
    fixture: {
      directory: "bench/.fixtures/nextjs",
      ref: FIXTURES.nextjs.ref,
      url: FIXTURES.nextjs.url,
      revision: commit.oid,
      git: git(["--version"]).trim(),
      trackedPaths: index.length,
      reachableObjects,
      uniquePackedObjects: objects.length,
      storedPackEntries: storedEntries,
      packFiles: packs.length,
      packBytes,
      trees: trees.sources.length,
      treeEntries: trees.entries.length,
    },
    paths: index.map((entry) => entry.path),
    storedPackEntries: storedEntries,
  };
}

function loosePayload(oid: string): Uint8Array {
  const source = encodeBlob(oid);
  const payload = new Uint8Array(64);
  payload.set(source, 0);
  payload.set(source, 20);
  payload.set(source, 40);
  payload.set(source.subarray(0, 4), 60);
  return payload;
}

function buildLooseDataset(paths: readonly string[]): Dataset {
  const oids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < LOOSE_OBJECTS; index++) {
    const oid = sha1(`kompjutr oid encoding loose object ${index}`);
    if (seen.has(oid)) throw new Error(`synthetic OID collision at ${index}`);
    seen.add(oid);
    oids.push(oid);
  }
  const commitOids = oids.slice(0, LOOSE_COMMITS);
  const treeOids = oids.slice(LOOSE_COMMITS, LOOSE_COMMITS + LOOSE_TREES);
  const blobOids = oids.slice(LOOSE_COMMITS + LOOSE_TREES);
  const objects: ObjectRecord[] = oids.map((oid, index) => ({
    oid,
    type: index < LOOSE_COMMITS ? "commit" : index < LOOSE_COMMITS + LOOSE_TREES ? "tree" : "blob",
    size: 64,
  }));
  objects.sort((left, right) => compareAscii(left.oid, right.oid));

  const commits: CommitRecord[] = [];
  for (let index = 0; index < commitOids.length; index++) {
    const parents: string[] = [];
    if (index > 0) parents.push(checkedAt(commitOids, index - 1, "commit parent"));
    if (index > 64 && index % 64 === 0) {
      parents.push(checkedAt(commitOids, index - 32, "merge parent"));
    }
    commits.push({
      oid: checkedAt(commitOids, index, "commit OID"),
      parents,
      tree: checkedAt(treeOids, index % treeOids.length, "commit tree"),
      objectSize: 192 + parents.length * 48,
    });
  }

  const trees: TreeSource[] = [];
  const treeEntries: TreeEntry[] = [];
  const textEncoder = new TextEncoder();
  for (const [treeIndex, treeOid] of treeOids.entries()) {
    let cumulativeBase = 0;
    let objectSize = 0;
    for (let ordinal = 0; ordinal < LOOSE_TREE_FANOUT; ordinal++) {
      const mode = ordinal % 7 === 0 ? "40000" : "100644";
      const name = `entry-${ordinal.toString().padStart(2, "0")}`;
      const nameBytes = textEncoder.encode(name);
      const oid = checkedAt(
        blobOids,
        (treeIndex * LOOSE_TREE_FANOUT + ordinal) % blobOids.length,
        "tree entry OID",
      );
      const rawEntry = makeRawTreeEntry(mode, nameBytes, oid);
      cumulativeBase += treeEntryCost(mode, nameBytes);
      objectSize += rawEntry.length;
      treeEntries.push({
        treeOid,
        storage: "loose",
        sourceId: 0,
        ordinal,
        mode,
        name,
        nameBytes,
        oid,
        rawEntry,
        cumulativeBase,
      });
    }
    trees.push({
      treeOid,
      storage: "loose",
      sourceId: 0,
      objectSize,
      entryCount: LOOSE_TREE_FANOUT,
      baseCost: cumulativeBase,
    });
  }

  const objectsByOid = new Map<string, ObjectRecord>();
  for (const object of objects) objectsByOid.set(object.oid, object);
  for (const commit of commits) {
    const object = objectsByOid.get(commit.oid);
    if (object === undefined) throw new Error(`missing loose commit object ${commit.oid}`);
    object.size = commit.objectSize;
  }
  for (const tree of trees) {
    const object = objectsByOid.get(tree.treeOid);
    if (object === undefined) throw new Error(`missing loose tree object ${tree.treeOid}`);
    object.size = tree.objectSize;
  }

  const index: IndexEntry[] = paths.map((path, index) => ({
    path,
    mode: 0o100644,
    oid: checkedAt(blobOids, index % blobOids.length, "index OID"),
    size: 64,
  }));
  return {
    workload: "loose-shaped",
    objects,
    packLocations: new Map<string, PackLocation>(),
    packs: [],
    index,
    commits,
    trees,
    treeEntries,
    refs: [
      {
        name: "refs/heads/main",
        target: checkedAt(commitOids, commitOids.length - 1, "tip commit"),
      },
    ],
    shallow: commitOids.filter((_oid, index) => index % 128 === 0),
    conversionOids: oids,
  };
}

function schema(encoding: Encoding): string {
  const oid = encoding === "text" ? "TEXT" : "BLOB";
  return `
    CREATE TABLE git_refs (
      repo_id INTEGER NOT NULL, name TEXT NOT NULL, target ${oid} NOT NULL,
      PRIMARY KEY (repo_id, name)
    );
    CREATE TABLE git_index (
      repo_id INTEGER NOT NULL, path TEXT NOT NULL, stage INTEGER NOT NULL,
      mode INTEGER NOT NULL, oid ${oid} NOT NULL, size INTEGER, mtime INTEGER,
      ino INTEGER, rev INTEGER,
      PRIMARY KEY (repo_id, path, stage)
    );
    CREATE TABLE git_blob_ids (
      repo_id INTEGER NOT NULL, content_id BLOB NOT NULL, oid ${oid} NOT NULL,
      PRIMARY KEY (repo_id, content_id)
    ) WITHOUT ROWID;
    CREATE TABLE git_shallow (
      repo_id INTEGER NOT NULL, oid ${oid} NOT NULL,
      PRIMARY KEY (repo_id, oid)
    );
    CREATE TABLE git_objects (
      repo_id INTEGER NOT NULL, oid ${oid} NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      stored TEXT NOT NULL DEFAULT 'zlib',
      PRIMARY KEY (repo_id, oid)
    );
    CREATE TABLE git_object_chunks (
      repo_id INTEGER NOT NULL, oid ${oid} NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY (repo_id, oid, seq)
    );
    CREATE TABLE git_pack_meta (
      repo_id INTEGER NOT NULL, pack_id INTEGER NOT NULL, size INTEGER NOT NULL,
      count INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY (repo_id, pack_id)
    );
    CREATE TABLE git_pack_data (
      repo_id INTEGER NOT NULL, pack_id INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY (repo_id, pack_id, seq)
    );
    CREATE TABLE git_pack_objects (
      repo_id INTEGER NOT NULL, oid ${oid} NOT NULL, pack_id INTEGER NOT NULL,
      offset INTEGER NOT NULL, data_off INTEGER NOT NULL, data_len INTEGER NOT NULL,
      type TEXT NOT NULL, size INTEGER NOT NULL, entry_size INTEGER NOT NULL, base_oid ${oid},
      PRIMARY KEY (repo_id, oid)
    );
    CREATE INDEX git_pack_objects_loc ON git_pack_objects (repo_id, pack_id, offset);
    CREATE TABLE git_commits (
      repo_id INTEGER NOT NULL, oid ${oid} NOT NULL, parents ${oid} NOT NULL,
      tree ${oid} NOT NULL, author_name BLOB NOT NULL, author_email BLOB NOT NULL,
      author_time INTEGER NOT NULL, author_timezone INTEGER NOT NULL,
      committer_name BLOB NOT NULL, committer_email BLOB NOT NULL,
      committer_time INTEGER NOT NULL, committer_timezone INTEGER NOT NULL,
      message BLOB NOT NULL, gpgsig BLOB, object_size INTEGER NOT NULL,
      cache_bytes INTEGER NOT NULL,
      PRIMARY KEY (repo_id, oid)
    ) WITHOUT ROWID;
    CREATE TABLE git_tree_sources (
      repo_id INTEGER NOT NULL, tree_oid ${oid} NOT NULL, storage TEXT NOT NULL,
      source_id INTEGER NOT NULL, object_size INTEGER NOT NULL, entry_count INTEGER NOT NULL,
      base_cost INTEGER NOT NULL,
      PRIMARY KEY (repo_id, tree_oid, storage, source_id)
    ) WITHOUT ROWID;
    CREATE TABLE git_tree_entries (
      repo_id INTEGER NOT NULL, tree_oid ${oid} NOT NULL, storage TEXT NOT NULL,
      source_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, mode TEXT NOT NULL,
      name TEXT COLLATE BINARY NOT NULL, name_bytes BLOB NOT NULL, oid ${oid} NOT NULL,
      raw_entry BLOB NOT NULL, cumulative_base INTEGER NOT NULL,
      PRIMARY KEY (repo_id, tree_oid, storage, source_id, ordinal),
      FOREIGN KEY (repo_id, tree_oid, storage, source_id)
        REFERENCES git_tree_sources (repo_id, tree_oid, storage, source_id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
    ) WITHOUT ROWID;
    CREATE INDEX git_tree_entries_by_name_bytes
      ON git_tree_entries (repo_id, tree_oid, storage, source_id, name_bytes)
      WHERE typeof(name_bytes) = 'blob' AND length(name_bytes) <= 2200;
    CREATE TABLE git_tree_effective (
      repo_id INTEGER NOT NULL, tree_oid ${oid} NOT NULL, storage TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      PRIMARY KEY (repo_id, tree_oid)
    ) WITHOUT ROWID;
  `;
}

function bindNullableOid(encoding: Encoding, oid: string | null): SQLInputValue {
  return oid === null ? null : encodeOid(encoding, oid);
}

function populate(db: DatabaseSync, encoding: Encoding, dataset: Dataset): void {
  const ref = db.prepare("INSERT INTO git_refs VALUES (1, ?, ?)");
  for (const row of dataset.refs) ref.run(row.name, encodeOid(encoding, row.target));

  const index = db.prepare("INSERT INTO git_index VALUES (1, ?, 0, ?, ?, ?, ?, ?, ?)");
  const blobId = db.prepare("INSERT INTO git_blob_ids VALUES (1, ?, ?)");
  for (const [ordinal, row] of dataset.index.entries()) {
    const oid = encodeOid(encoding, row.oid);
    index.run(row.path, row.mode, oid, row.size, 1_600_000_000 + ordinal, ordinal + 1, ordinal);
    blobId.run(encodeBlob(sha1(`content ${row.path}`)), oid);
  }

  const shallow = db.prepare("INSERT INTO git_shallow VALUES (1, ?)");
  for (const oid of dataset.shallow) shallow.run(encodeOid(encoding, oid));

  const object = db.prepare("INSERT INTO git_objects VALUES (1, ?, ?, ?, 'zlib')");
  const objectChunk = db.prepare("INSERT INTO git_object_chunks VALUES (1, ?, 0, ?)");
  if (dataset.workload === "loose-shaped") {
    for (const row of dataset.objects) {
      const oid = encodeOid(encoding, row.oid);
      object.run(oid, row.type, row.size);
      objectChunk.run(oid, loosePayload(row.oid));
    }
  }

  const packMeta = db.prepare(
    "INSERT INTO git_pack_meta VALUES (1, ?, ?, ?, 'complete', 1600000000)",
  );
  const packData = db.prepare("INSERT INTO git_pack_data VALUES (1, ?, ?, ?)");
  for (const pack of dataset.packs) {
    let seq = 0;
    for (let at = 0; at < pack.bytes.byteLength; at += PACK_CHUNK_BYTES) {
      packData.run(pack.packId, seq, pack.bytes.subarray(at, at + PACK_CHUNK_BYTES));
      seq++;
    }
    let count = 0;
    for (const location of dataset.packLocations.values()) {
      if (location.packId === pack.packId) count++;
    }
    packMeta.run(pack.packId, pack.bytes.byteLength, count);
  }

  const packObject = db.prepare(
    "INSERT INTO git_pack_objects VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  if (dataset.workload === "packed-nextjs") {
    for (const row of dataset.objects) {
      const location = dataset.packLocations.get(row.oid);
      if (location === undefined) throw new Error(`missing location for ${row.oid}`);
      packObject.run(
        encodeOid(encoding, row.oid),
        location.packId,
        location.offset,
        location.offset,
        location.storedSize,
        row.type,
        row.size,
        location.storedSize,
        bindNullableOid(encoding, location.baseOid),
      );
    }
  }

  const commit = db.prepare(
    "INSERT INTO git_commits VALUES " +
      "(1, ?, ?, ?, ?, ?, 1600000000, 0, ?, ?, 1600000000, 0, ?, NULL, ?, ?)",
  );
  const authorName = new TextEncoder().encode("Benchmark Author");
  const authorEmail = new TextEncoder().encode("benchmark@example.com");
  const message = new TextEncoder().encode("OID encoding benchmark commit\n");
  for (const row of dataset.commits) {
    commit.run(
      encodeOid(encoding, row.oid),
      encodeParents(encoding, row.parents),
      encodeOid(encoding, row.tree),
      authorName,
      authorEmail,
      authorName,
      authorEmail,
      message,
      row.objectSize,
      256 + row.parents.length * 40,
    );
  }

  const treeSource = db.prepare("INSERT INTO git_tree_sources VALUES (1, ?, ?, ?, ?, ?, ?)");
  const treeEffective = db.prepare("INSERT INTO git_tree_effective VALUES (1, ?, ?, ?)");
  for (const row of dataset.trees) {
    const oid = encodeOid(encoding, row.treeOid);
    treeSource.run(oid, row.storage, row.sourceId, row.objectSize, row.entryCount, row.baseCost);
    treeEffective.run(oid, row.storage, row.sourceId);
  }

  const treeEntry = db.prepare(
    "INSERT INTO git_tree_entries VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of dataset.treeEntries) {
    treeEntry.run(
      encodeOid(encoding, row.treeOid),
      row.storage,
      row.sourceId,
      row.ordinal,
      row.mode,
      row.name,
      row.nameBytes,
      encodeOid(encoding, row.oid),
      row.rawEntry,
      row.cumulativeBase,
    );
  }
}

function buildDatabase(path: string, encoding: Encoding, dataset: Dataset): void {
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec("PRAGMA page_size = 4096; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY");
    memory.exec(schema(encoding));
    populate(memory, encoding, dataset);
    memory.prepare("VACUUM INTO ?").run(path);
  } finally {
    memory.close();
  }
}

function hashString(hash: Hash, value: string): void {
  hash.update(`${value.length}:`);
  hash.update(value);
}

function hashBytes(hash: Hash, value: Uint8Array): void {
  hash.update(`${value.byteLength}:`);
  hash.update(value);
}

function observeOid(hash: Hash, oids: Set<string>, oid: string): void {
  hashString(hash, oid);
  oids.add(oid);
}

function rowCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get();
    if (row === undefined) throw new Error(`count query returned no row for ${table}`);
    counts[table] = requireInteger(row.count, `${table} count`);
  }
  return counts;
}

function snapshot(db: DatabaseSync, encoding: Encoding): Snapshot {
  const hash = createHash("sha256");
  const oids = new Set<string>();

  for (const row of db
    .prepare("SELECT name, target FROM git_refs ORDER BY repo_id, name")
    .iterate()) {
    hashString(hash, "ref");
    hashString(hash, requireText(row.name, "ref name"));
    observeOid(hash, oids, decodeOid(encoding, row.target));
  }
  for (const row of db
    .prepare(
      "SELECT path, mode, oid, size, mtime, ino, rev FROM git_index " +
        "ORDER BY repo_id, path, stage",
    )
    .iterate()) {
    hashString(hash, "index");
    hashString(hash, requireText(row.path, "index path"));
    hashString(hash, String(requireInteger(row.mode, "index mode")));
    observeOid(hash, oids, decodeOid(encoding, row.oid));
    hashString(hash, String(requireInteger(row.size, "index size")));
    hashString(hash, String(requireInteger(row.mtime, "index mtime")));
    hashString(hash, String(requireInteger(row.ino, "index inode")));
    hashString(hash, String(requireInteger(row.rev, "index revision")));
  }
  for (const row of db
    .prepare("SELECT content_id, oid FROM git_blob_ids ORDER BY repo_id, content_id")
    .iterate()) {
    hashString(hash, "blob-id");
    hashBytes(hash, requireBytes(row.content_id, "content ID"));
    observeOid(hash, oids, decodeOid(encoding, row.oid));
  }
  for (const row of db.prepare("SELECT oid FROM git_shallow ORDER BY repo_id, oid").iterate()) {
    hashString(hash, "shallow");
    observeOid(hash, oids, decodeOid(encoding, row.oid));
  }
  for (const row of db
    .prepare("SELECT oid, type, size, stored FROM git_objects ORDER BY repo_id, oid")
    .iterate()) {
    hashString(hash, "object");
    observeOid(hash, oids, decodeOid(encoding, row.oid));
    hashString(hash, requireText(row.type, "object type"));
    hashString(hash, String(requireInteger(row.size, "object size")));
    hashString(hash, requireText(row.stored, "object encoding"));
  }
  for (const row of db
    .prepare("SELECT oid, seq, data FROM git_object_chunks ORDER BY repo_id, oid, seq")
    .iterate()) {
    hashString(hash, "object-chunk");
    observeOid(hash, oids, decodeOid(encoding, row.oid));
    hashString(hash, String(requireInteger(row.seq, "object chunk sequence")));
    hashBytes(hash, requireBytes(row.data, "object chunk"));
  }
  for (const row of db
    .prepare(
      "SELECT pack_id, size, count, state, created FROM git_pack_meta ORDER BY repo_id, pack_id",
    )
    .iterate()) {
    hashString(hash, "pack-meta");
    hashString(hash, String(requireInteger(row.pack_id, "pack ID")));
    hashString(hash, String(requireInteger(row.size, "pack size")));
    hashString(hash, String(requireInteger(row.count, "pack count")));
    hashString(hash, requireText(row.state, "pack state"));
    hashString(hash, String(requireInteger(row.created, "pack creation time")));
  }
  for (const row of db
    .prepare("SELECT pack_id, seq, data FROM git_pack_data ORDER BY repo_id, pack_id, seq")
    .iterate()) {
    hashString(hash, "pack-data");
    hashString(hash, String(requireInteger(row.pack_id, "pack ID")));
    hashString(hash, String(requireInteger(row.seq, "pack chunk sequence")));
    hashBytes(hash, requireBytes(row.data, "pack data"));
  }
  for (const row of db
    .prepare(
      "SELECT oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid " +
        "FROM git_pack_objects ORDER BY repo_id, oid",
    )
    .iterate()) {
    hashString(hash, "pack-object");
    observeOid(hash, oids, decodeOid(encoding, row.oid));
    hashString(hash, String(requireInteger(row.pack_id, "pack object pack ID")));
    hashString(hash, String(requireInteger(row.offset, "pack object offset")));
    hashString(hash, String(requireInteger(row.data_off, "pack object data offset")));
    hashString(hash, String(requireInteger(row.data_len, "pack object data length")));
    hashString(hash, requireText(row.type, "pack object type"));
    hashString(hash, String(requireInteger(row.size, "pack object size")));
    hashString(hash, String(requireInteger(row.entry_size, "pack object entry size")));
    if (row.base_oid === null) hashString(hash, "no-base");
    else observeOid(hash, oids, decodeOid(encoding, row.base_oid));
  }
  for (const row of db
    .prepare(
      "SELECT oid, parents, tree, author_name, author_email, author_time, author_timezone, " +
        "committer_name, committer_email, committer_time, committer_timezone, message, " +
        "gpgsig, object_size, cache_bytes FROM git_commits ORDER BY repo_id, oid",
    )
    .iterate()) {
    hashString(hash, "commit");
    observeOid(hash, oids, decodeOid(encoding, row.oid));
    const parents = decodeParents(encoding, row.parents);
    hashString(hash, String(parents.length));
    for (const parent of parents) observeOid(hash, oids, parent);
    observeOid(hash, oids, decodeOid(encoding, row.tree));
    hashBytes(hash, requireBytes(row.author_name, "author name"));
    hashBytes(hash, requireBytes(row.author_email, "author email"));
    hashString(hash, String(requireInteger(row.author_time, "author time")));
    hashString(hash, String(requireInteger(row.author_timezone, "author timezone")));
    hashBytes(hash, requireBytes(row.committer_name, "committer name"));
    hashBytes(hash, requireBytes(row.committer_email, "committer email"));
    hashString(hash, String(requireInteger(row.committer_time, "committer time")));
    hashString(hash, String(requireInteger(row.committer_timezone, "committer timezone")));
    hashBytes(hash, requireBytes(row.message, "commit message"));
    if (row.gpgsig !== null) hashBytes(hash, requireBytes(row.gpgsig, "commit signature"));
    else hashString(hash, "no-signature");
    hashString(hash, String(requireInteger(row.object_size, "commit size")));
    hashString(hash, String(requireInteger(row.cache_bytes, "commit cache bytes")));
  }
  for (const row of db
    .prepare(
      "SELECT tree_oid, storage, source_id, object_size, entry_count, base_cost " +
        "FROM git_tree_sources " +
        "ORDER BY repo_id, tree_oid, storage, source_id",
    )
    .iterate()) {
    hashString(hash, "tree-source");
    observeOid(hash, oids, decodeOid(encoding, row.tree_oid));
    hashString(hash, requireText(row.storage, "tree storage"));
    hashString(hash, String(requireInteger(row.source_id, "tree source ID")));
    hashString(hash, String(requireInteger(row.object_size, "tree object size")));
    hashString(hash, String(requireInteger(row.entry_count, "tree entry count")));
    hashString(hash, String(requireInteger(row.base_cost, "tree base cost")));
  }
  for (const row of db
    .prepare(
      "SELECT tree_oid, storage, source_id, ordinal, mode, name, name_bytes, oid, " +
        "raw_entry, cumulative_base " +
        "FROM git_tree_entries ORDER BY repo_id, tree_oid, storage, source_id, ordinal",
    )
    .iterate()) {
    hashString(hash, "tree-entry");
    observeOid(hash, oids, decodeOid(encoding, row.tree_oid));
    hashString(hash, requireText(row.storage, "tree entry storage"));
    hashString(hash, String(requireInteger(row.source_id, "tree entry source ID")));
    hashString(hash, String(requireInteger(row.ordinal, "tree entry ordinal")));
    hashString(hash, requireText(row.mode, "tree entry mode"));
    hashString(hash, requireText(row.name, "tree entry name"));
    hashBytes(hash, requireBytes(row.name_bytes, "tree entry name"));
    observeOid(hash, oids, decodeOid(encoding, row.oid));
    hashBytes(hash, requireBytes(row.raw_entry, "raw tree entry"));
    hashString(hash, String(requireInteger(row.cumulative_base, "tree cumulative base")));
  }
  for (const row of db
    .prepare(
      "SELECT tree_oid, storage, source_id FROM git_tree_effective ORDER BY repo_id, tree_oid",
    )
    .iterate()) {
    hashString(hash, "tree-effective");
    observeOid(hash, oids, decodeOid(encoding, row.tree_oid));
    hashString(hash, requireText(row.storage, "effective tree storage"));
    hashString(hash, String(requireInteger(row.source_id, "effective tree source ID")));
  }

  const sortedOids = Array.from(oids).sort(compareAscii);
  const oidHash = createHash("sha256");
  for (const oid of sortedOids) hashString(oidHash, oid);
  return {
    rowCounts: rowCounts(db),
    decodedOidCount: sortedOids.length,
    decodedOidSetChecksum: oidHash.digest("hex"),
    rowOrderChecksum: hash.digest("hex"),
    traversal: traversalResult(db, encoding),
  };
}

function traversalResult(db: DatabaseSync, encoding: Encoding): TraversalResult {
  const hash = createHash("sha256");
  let treeRows = 0;
  for (const row of db
    .prepare(
      "SELECT tree_oid, ordinal, oid, name_bytes FROM git_tree_entries " +
        "WHERE repo_id = 1 ORDER BY tree_oid, storage, source_id, ordinal",
    )
    .iterate()) {
    observeOid(hash, new Set<string>(), decodeOid(encoding, row.tree_oid));
    hashString(hash, String(requireInteger(row.ordinal, "traversal ordinal")));
    observeOid(hash, new Set<string>(), decodeOid(encoding, row.oid));
    hashBytes(hash, requireBytes(row.name_bytes, "traversal name"));
    treeRows++;
  }
  let commitRows = 0;
  for (const row of db
    .prepare("SELECT oid, parents, tree FROM git_commits WHERE repo_id = 1 ORDER BY oid")
    .iterate()) {
    observeOid(hash, new Set<string>(), decodeOid(encoding, row.oid));
    for (const parent of decodeParents(encoding, row.parents)) {
      observeOid(hash, new Set<string>(), parent);
    }
    observeOid(hash, new Set<string>(), decodeOid(encoding, row.tree));
    commitRows++;
  }
  return { treeRows, commitRows, checksum: hash.digest("hex") };
}

function pragmaInteger(db: DatabaseSync, query: string, key: string): number {
  const row = db.prepare(query).get();
  if (row === undefined) throw new Error(`${query} returned no row`);
  return requireInteger(row[key], key);
}

function sizeResult(db: DatabaseSync, path: string): SizeResult {
  const objects: PageUsage[] = [];
  for (const row of db
    .prepare(
      "SELECT name, sum(pgsize) AS bytes, count(*) AS pages FROM dbstat GROUP BY name ORDER BY name",
    )
    .iterate()) {
    objects.push({
      name: requireText(row.name, "dbstat name"),
      bytes: requireInteger(row.bytes, "dbstat bytes"),
      pages: requireInteger(row.pages, "dbstat pages"),
    });
  }
  const pageSize = pragmaInteger(db, "PRAGMA page_size", "page_size");
  const pageCount = pragmaInteger(db, "PRAGMA page_count", "page_count");
  const freelistPages = pragmaInteger(db, "PRAGMA freelist_count", "freelist_count");
  return {
    fileBytes: statSync(path).size,
    pageSize,
    pageCount,
    freelistPages,
    usedPageBytes: (pageCount - freelistPages) * pageSize,
    objects,
  };
}

function mixOid(checksum: number, oid: string): number {
  let result = checksum;
  for (let at = 0; at < oid.length; at++)
    result = Math.imul(result ^ oid.charCodeAt(at), 16_777_619);
  return result >>> 0;
}

function measured(run: () => number): number {
  const started = process.hrtime.bigint();
  const checksum = run();
  const elapsed = Number(process.hrtime.bigint() - started);
  timingSink = (timingSink ^ checksum) >>> 0;
  return elapsed;
}

function series(warmups: number, repetitions: number, run: () => number): number[] {
  for (let index = 0; index < warmups; index++) run();
  const values: number[] = [];
  for (let index = 0; index < repetitions; index++) values.push(measured(run));
  return values;
}

function sampleLookupOids(dataset: Dataset): string[] {
  const source = dataset.conversionOids;
  const count = Math.min(LOOKUP_KEYS, source.length);
  const values: string[] = [];
  for (let index = 0; index < count; index++) {
    values.push(checkedAt(source, Math.floor((index * source.length) / count), "lookup OID"));
  }
  return values;
}

function timingResult(
  db: DatabaseSync,
  encoding: Encoding,
  dataset: Dataset,
  options: Options,
): TimingResult {
  const lookupOids = sampleLookupOids(dataset);
  const lookupTable = dataset.workload === "packed-nextjs" ? "git_pack_objects" : "git_objects";
  const lookup = db.prepare(`SELECT oid FROM ${lookupTable} WHERE repo_id = 1 AND oid = ?`);
  const encoded = dataset.conversionOids.map((oid) => encodeOid(encoding, oid));

  const runLookup = (): number => {
    let checksum = 2_166_136_261;
    for (const oid of lookupOids) {
      const row = lookup.get(encodeOid(encoding, oid));
      if (row === undefined) throw new Error(`lookup missed ${oid}`);
      checksum = mixOid(checksum, decodeOid(encoding, row.oid));
    }
    return checksum;
  };
  const runTreeTraversal = (): number => {
    let checksum = 2_166_136_261;
    for (const row of db
      .prepare(
        "SELECT tree_oid, ordinal, oid FROM git_tree_entries WHERE repo_id = 1 " +
          "ORDER BY tree_oid, storage, source_id, ordinal",
      )
      .iterate()) {
      checksum = mixOid(checksum, decodeOid(encoding, row.tree_oid));
      checksum = Math.imul(checksum ^ requireInteger(row.ordinal, "tree ordinal"), 16_777_619);
      checksum = mixOid(checksum, decodeOid(encoding, row.oid));
    }
    return checksum >>> 0;
  };
  const runCommitTraversal = (): number => {
    let checksum = 2_166_136_261;
    for (const row of db
      .prepare("SELECT oid, parents, tree FROM git_commits WHERE repo_id = 1 ORDER BY oid")
      .iterate()) {
      checksum = mixOid(checksum, decodeOid(encoding, row.oid));
      for (const parent of decodeParents(encoding, row.parents))
        checksum = mixOid(checksum, parent);
      checksum = mixOid(checksum, decodeOid(encoding, row.tree));
    }
    return checksum >>> 0;
  };
  const runEncode = (): number => {
    let checksum = 2_166_136_261;
    for (const oid of dataset.conversionOids) {
      const value = encodeOid(encoding, oid);
      checksum =
        typeof value === "string"
          ? Math.imul(checksum ^ value.charCodeAt(0), 16_777_619)
          : Math.imul(checksum ^ byteAt(value, 0, "encoded OID"), 16_777_619);
    }
    return checksum >>> 0;
  };
  const runDecode = (): number => {
    let checksum = 2_166_136_261;
    for (const value of encoded) checksum = mixOid(checksum, decodeOid(encoding, value));
    return checksum;
  };

  return {
    repetitions: options.repetitions,
    warmups: options.warmups,
    lookupKeys: lookupOids.length,
    conversionOids: dataset.conversionOids.length,
    statementsPerRepetition: {
      lookup: lookupOids.length,
      treeTraversal: 1,
      commitTraversal: 1,
      boundaryEncode: 0,
      boundaryDecode: 0,
    },
    rowsPerRepetition: {
      lookup: lookupOids.length,
      treeTraversal: dataset.treeEntries.length,
      commitTraversal: dataset.commits.length,
    },
    lookupNs: series(options.warmups, options.repetitions, runLookup),
    treeTraversalNs: series(options.warmups, options.repetitions, runTreeTraversal),
    commitTraversalNs: series(options.warmups, options.repetitions, runCommitTraversal),
    boundaryEncodeNs: series(options.warmups, options.repetitions, runEncode),
    boundaryDecodeNs: series(options.warmups, options.repetitions, runDecode),
  };
}

function runDatabase(
  directory: string,
  encoding: Encoding,
  dataset: Dataset,
  options: Options,
): DatabaseResult {
  const path = join(directory, `${dataset.workload}-${encoding}.sqlite`);
  buildDatabase(path, encoding, dataset);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const logical = snapshot(db, encoding);
    return {
      encoding,
      workload: dataset.workload,
      snapshot: logical,
      size: sizeResult(db, path),
      timings: options.checkOnly ? null : timingResult(db, encoding, dataset, options),
    };
  } finally {
    db.close();
  }
}

function assertEquivalent(text: DatabaseResult, blob: DatabaseResult): void {
  if (text.workload !== blob.workload) throw new Error("workload mismatch");
  const textSnapshot = JSON.stringify(text.snapshot);
  const blobSnapshot = JSON.stringify(blob.snapshot);
  if (textSnapshot !== blobSnapshot) {
    throw new Error(
      `${text.workload} variants are not logically equivalent\nTEXT ${textSnapshot}\nBLOB ${blobSnapshot}`,
    );
  }
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

function verifyLease(args: readonly string[]): LeaseEvidence {
  if (process.env[LEASE_MARKER] !== "1") throw new Error("timed child lacks its lease marker");
  if (platform() !== "linux") throw new Error("timed lease verification requires Linux /proc");
  const status = readFileSync("/proc/self/status", "utf8");
  const prefix = "Cpus_allowed_list:";
  const line = status.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error("/proc/self/status has no Cpus_allowed_list");
  const observedCpuList = line.slice(prefix.length).trim();
  const observedLogicalCpus = countCpuList(observedCpuList);
  if (observedLogicalCpus !== 1) {
    throw new Error(
      `cpu-lease --no-smt must expose one logical CPU, observed ${observedCpuList || "none"}`,
    );
  }
  return { command: leaseCommand(args), observedCpuList, observedLogicalCpus };
}

function main(): void {
  const args = process.argv.slice(2);
  const options = parseOptions(args);
  fixtureDirectory = prepareFixture(FIXTURES.nextjs);
  if (!options.checkOnly && process.env[LEASE_MARKER] !== "1") {
    runLeasedChild(args);
    return;
  }
  const lease = options.checkOnly ? null : verifyLease(args);
  const temporary = mkdtempSync(join(tmpdir(), "kompjutr-oid-encoding-"));
  try {
    const loaded = loadPackedDataset();
    const loose = buildLooseDataset(loaded.paths);
    const results: DatabaseResult[] = [];
    for (const dataset of [loaded.dataset, loose]) {
      const text = runDatabase(temporary, "text", dataset, options);
      const blob = runDatabase(temporary, "blob", dataset, options);
      assertEquivalent(text, blob);
      results.push(text, blob);
    }
    const environment = {
      measuredAt: new Date().toISOString(),
      node: process.version,
      sqlite: sqliteVersion(),
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      cpuReservation: lease,
    };
    const equivalence = results
      .filter((result) => result.encoding === "text")
      .map((result) => ({ workload: result.workload, ...result.snapshot }));
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: options.checkOnly ? "correctness" : "measurement",
          environment,
          fixture: loaded.fixture,
          prototype: {
            looseObjects: LOOSE_OBJECTS,
            looseCommits: LOOSE_COMMITS,
            looseTrees: LOOSE_TREES,
            looseTreeEntries: LOOSE_TREES * LOOSE_TREE_FANOUT,
            parentsEncoding: {
              text: "space-separated 40-byte lowercase hex OIDs",
              blob: "ordered concatenation of 20-byte OIDs; zero parents is a zero-length BLOB",
            },
          },
          equivalence,
          results,
          timingSink,
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
