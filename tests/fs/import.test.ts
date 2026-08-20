import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Workspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import {
  assertComputerImportCurrent,
  COMPUTER_IMPORT_ACKNOWLEDGEMENT,
  type ImportFromComputerOptions,
  importFromComputer,
} from "../../src/fs/import.js";
import { initializeFsSchema } from "../../src/fs/schema.js";
import { realpath as resolveRealpath } from "../../src/fs/store/resolve.js";
import { type ShadowReadSource, shadowReads } from "../../src/fs/testing.js";
import { type RealPath, S_IFDIR, S_IFREG, type ScanEntry, type Stat } from "../../src/fs/types.js";
import { readBlob, type SqlDatabase } from "../../src/sqlite/db.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

class RecordingDatabase implements SqlDatabase {
  statementCount = 0;
  maxBindings = 0;
  maxBlobResultBytes = 0;

  constructor(private readonly inner: SqlDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.record(bindings);
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.record(bindings);
    const rows = this.inner.all<Row>(query, ...bindings);
    let bytes = 0;
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) bytes += value.byteLength;
        else if (value instanceof ArrayBuffer) bytes += value.byteLength;
      }
    }
    this.maxBlobResultBytes = Math.max(this.maxBlobResultBytes, bytes);
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    return row === undefined ? undefined : Object.values(row)[0];
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }

  private record(bindings: readonly unknown[]): void {
    this.statementCount++;
    this.maxBindings = Math.max(this.maxBindings, bindings.length);
  }
}

const COMPUTER_SCHEMA = [
  `CREATE TABLE vfs_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  `CREATE TABLE vfs_nodes (
     inode INTEGER PRIMARY KEY AUTOINCREMENT,
     type TEXT NOT NULL CHECK(type IN ('file','dir','symlink')),
     mode INTEGER NOT NULL DEFAULT 493,
     mtime INTEGER NOT NULL,
     rev INTEGER NOT NULL DEFAULT 0,
     mount_root TEXT,
     stub_size INTEGER,
     manifest_hash BLOB,
     link_target TEXT,
     size INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE vfs_dirents (
     parent_inode INTEGER NOT NULL,
     name TEXT NOT NULL,
     child_inode INTEGER NOT NULL,
     PRIMARY KEY (parent_inode, name)
   ) WITHOUT ROWID`,
  `CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode)`,
  `CREATE TABLE vfs_blobs (
     hash BLOB PRIMARY KEY,
     size INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   )`,
  `CREATE TABLE vfs_blob_bytes (
     hash BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
     bytes BLOB NOT NULL
   )`,
  `CREATE TABLE vfs_chunks (
     inode INTEGER NOT NULL,
     idx INTEGER NOT NULL,
     hash BLOB NOT NULL,
     size INTEGER NOT NULL,
     PRIMARY KEY (inode, idx)
   ) WITHOUT ROWID`,
  `CREATE TABLE vfs_manifests (
     hash BLOB PRIMARY KEY,
     size INTEGER NOT NULL,
     encoded BLOB NOT NULL,
     last_seen INTEGER NOT NULL DEFAULT 0
   )`,
];

function computerDatabase(options: { rootMode?: number; rootMtime?: number; rev?: number } = {}): {
  storage: SqliteTestStorage;
  db: TestDatabase;
} {
  const storage = new SqliteTestStorage();
  const db = new TestDatabase(storage);
  for (const statement of COMPUTER_SCHEMA) db.run(statement);
  db.run("INSERT INTO vfs_meta (k, v) VALUES ('schema_version', 5), ('rev', ?)", options.rev ?? 1);
  db.run(
    `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, size)
     VALUES (1, 'dir', ?, ?, 0, 0)`,
    options.rootMode ?? 0o755,
    options.rootMtime ?? 1_600_000_000_000,
  );
  initializeFsSchema(db, () => 1_500_000_000_000);
  return { storage, db };
}

function contentHash(seed: number): Uint8Array {
  const hash = new Uint8Array(32);
  const view = new DataView(hash.buffer);
  for (let at = 0; at < hash.length; at += 4) {
    view.setUint32(at, seed * 2_654_435_761 + at * 4_052_011);
  }
  return hash;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

interface FixtureChunk {
  idx: number;
  hash: Uint8Array;
  bytes: Uint8Array;
}

function encodedManifest(chunks: readonly FixtureChunk[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      chunks: chunks.map((chunk) => ({ hash: hex(chunk.hash), size: chunk.bytes.length })),
    }),
  );
}

function insertDirectory(
  db: SqlDatabase,
  inode: number,
  parent: number,
  name: string,
  mode: number,
  mtime: number,
): void {
  db.run(
    `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, size)
     VALUES (?, 'dir', ?, ?, 17, 0)`,
    inode,
    mode,
    mtime,
  );
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parent,
    name,
    inode,
  );
}

function insertFile(
  db: SqlDatabase,
  inode: number,
  parent: number,
  name: string,
  bytes: Uint8Array,
  mode: number,
  mtime: number,
): Uint8Array {
  const chunks: FixtureChunk[] = [];
  for (let at = 0, idx = 0; at < bytes.length; at += 8, idx++) {
    chunks.push({
      idx,
      hash: contentHash(inode * 1_000 + idx),
      bytes: bytes.subarray(at, at + 8),
    });
  }
  const encoded = encodedManifest(chunks);
  const manifestHash = sha256(encoded);
  db.run(
    `INSERT INTO vfs_nodes
       (inode, type, mode, mtime, rev, manifest_hash, size)
     VALUES (?, 'file', ?, ?, 17, ?, ?)`,
    inode,
    mode,
    mtime,
    manifestHash,
    bytes.length,
  );
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parent,
    name,
    inode,
  );
  db.run(
    "INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, 17)",
    manifestHash,
    bytes.length,
    encoded,
  );
  for (const chunk of chunks) {
    db.run(
      "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 17)",
      chunk.hash,
      chunk.bytes.length,
    );
    db.run("INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)", chunk.hash, chunk.bytes);
    db.run(
      "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      inode,
      chunk.idx,
      chunk.hash,
      chunk.bytes.length,
    );
  }
  return manifestHash;
}

function insertManifestlessFile(
  db: SqlDatabase,
  inode: number,
  parent: number,
  name: string,
  bytes: Uint8Array,
): void {
  insertFile(db, inode, parent, name, bytes, 0o644, 1);
  db.run("UPDATE vfs_nodes SET manifest_hash = NULL WHERE inode = ?", inode);
}

function insertSymlink(
  db: SqlDatabase,
  inode: number,
  parent: number,
  name: string,
  target: string,
  mtime: number,
): void {
  db.run(
    `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, link_target, size)
     VALUES (?, 'symlink', 511, ?, 17, ?, 0)`,
    inode,
    mtime,
    target,
  );
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parent,
    name,
    inode,
  );
}

interface ImportedRow {
  path: string;
  inode: number;
  type: string;
  mode: number;
  mtime: number;
  size: number;
  nlink: number;
  link_target: string | null;
  content_id: unknown;
}

function importedRow(db: SqlDatabase, path: string): ImportedRow | undefined {
  return db.one<ImportedRow>(
    `SELECT path.path AS path, path.inode AS inode, node.type AS type,
            node.mode AS mode, node.mtime AS mtime, node.size AS size,
            node.nlink AS nlink, node.link_target AS link_target,
            node.content_id AS content_id
       FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
      WHERE path.path = ?`,
    path,
  );
}

function importedBytes(db: SqlDatabase, path: string): Uint8Array {
  const rows = db.all<{ bytes: unknown }>(
    `SELECT chunk.bytes AS bytes
       FROM fs_paths path JOIN fs_chunks chunk ON chunk.inode = path.inode
      WHERE path.path = ? ORDER BY chunk.idx`,
    path,
  );
  const chunks = rows.map((row) => readBlob(row.bytes));
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const ACKNOWLEDGED: ImportFromComputerOptions = {
  acknowledgement: COMPUTER_IMPORT_ACKNOWLEDGEMENT,
};

interface ProviderFileExpected {
  path: string;
  bytes: Uint8Array;
  mode: number;
  mtime: number;
  size: number;
}

function providerComputerDatabase(): {
  directory: string;
  storage: SqliteTestStorage;
  db: TestDatabase;
  expected: ProviderFileExpected[];
} {
  const directory = mkdtempSync(join(tmpdir(), "kompjutr-import-"));
  const databasePath = join(directory, "computer.sqlite");
  const sourceStorage = new SqliteTestStorage(databasePath);
  let sourceOpen = true;
  try {
    let now = 1_700_000_000_000;
    const workspace = new Workspace({ storage: sourceStorage, now: () => now });
    const provider = workspace.provider();

    provider.createFileSync("/created", { mode: 0o600 });

    now++;
    provider.createFileSync("/range", { mode: 0o640 });
    now++;
    provider.writeRangeSync("/range", Buffer.from("range"), 2, { mode: 0o620 });

    now++;
    provider.writeFileSync("/truncated", Buffer.from("truncate-me"), { mode: 0o610 });
    now++;
    provider.truncateFileSync("/truncated", 8);

    now++;
    provider.createFileSync("/fd", { mode: 0o660 });
    now++;
    const fd = provider.openSync("/fd", "r+");
    provider.writeSync(fd, Buffer.from("fd-write"), 0, 8, 0);
    provider.closeSync(fd);

    now++;
    provider.openWriteBufferForCreateSync("/released", { mode: 0o630 });
    provider.writeRangeSync("/released", Buffer.from("released"), 0);
    now++;
    provider.releaseWriteBufferSync("/released");

    const paths = ["/created", "/range", "/truncated", "/fd", "/released"];
    const expected = paths.map((path): ProviderFileExpected => {
      const bytes = provider.readFileSync(path);
      if (typeof bytes === "string") throw new Error(`unexpected encoded read for ${path}`);
      const stat = provider.statSync(path);
      return {
        path,
        bytes: new Uint8Array(bytes),
        mode: stat.mode & 0o7777,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    });
    const source = new TestDatabase(sourceStorage);
    expect(
      source.scalar<number>("SELECT count(*) FROM vfs_nodes WHERE manifest_hash IS NULL"),
    ).toBe(6);

    // Reopening models the required fresh isolate after all buffers are released.
    sourceStorage.db.close();
    sourceOpen = false;
    const storage = new SqliteTestStorage(databasePath);
    const db = new TestDatabase(storage);
    initializeFsSchema(db, () => 1_500_000_000_000);
    return { directory, storage, db, expected };
  } catch (error) {
    if (sourceOpen) sourceStorage.db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

describe("importFromComputer", () => {
  it("requires the quiescent fresh-isolate acknowledgement before any SQL", () => {
    const { storage, db } = computerDatabase();
    storage.resetCounters();

    expect(() => Reflect.apply(importFromComputer, undefined, [db])).toThrow(
      COMPUTER_IMPORT_ACKNOWLEDGEMENT,
    );
    expect(() =>
      Reflect.apply(importFromComputer, undefined, [db, { acknowledgement: "not-quiescent" }]),
    ).toThrow(COMPUTER_IMPORT_ACKNOWLEDGEMENT);
    expect(storage.statementCount).toBe(0);
  });

  it("round-trips root, paths, bytes, modes, targets, mtimes and content identities", () => {
    const rootMode = 0o751;
    const rootMtime = 1_610_000_000_000;
    const { storage, db } = computerDatabase({ rootMode, rootMtime, rev: 17 });
    const code = new TextEncoder().encode("const π = 3;\n");
    insertDirectory(db, 2, 1, "src", 0o750, 1_620_000_000_000);
    const codeManifest = insertFile(db, 3, 2, "code.ts", code, 0o751, 1_620_000_000_001);
    insertFile(db, 4, 1, "empty", new Uint8Array(0), 0o640, 1_620_000_000_002);
    insertSymlink(db, 5, 1, "code-link", "/src/code.ts", 1_620_000_000_003);
    insertDirectory(db, 6, 1, "repo", 0o755, 1_620_000_000_004);
    insertDirectory(db, 7, 1, ".git", 0o700, 1_620_000_000_005);
    insertFile(db, 8, 7, "config", new TextEncoder().encode("root history"), 0o600, 1);
    insertDirectory(db, 9, 6, ".git", 0o700, 1_620_000_000_006);
    insertFile(db, 10, 9, "config", new TextEncoder().encode("nested history"), 0o600, 1);
    insertDirectory(db, 11, 6, "mounted", 0o755, 1_620_000_000_007);
    db.run("UPDATE vfs_nodes SET mount_root = '/repo/mounted' WHERE inode = 11");
    insertFile(db, 12, 11, "inside.txt", new TextEncoder().encode("mounted data"), 0o644, 1);
    // Import trusts committed chunks, not a stale cached node size.
    db.run("UPDATE vfs_nodes SET size = 999 WHERE inode = 3");
    db.run("UPDATE fs_meta SET v = 50_000 WHERE k = 'next_inode'");

    const recorded = new RecordingDatabase(db);
    storage.resetCounters();
    const result = importFromComputer(recorded, {
      acknowledgement: COMPUTER_IMPORT_ACKNOWLEDGEMENT,
      now: () => 1_800_000_000_000,
    });

    expect(result).toEqual({ entries: 5, files: 2, bytes: code.length, vfsRev: 17 });
    expect(recorded.statementCount).toBe(8);
    expect(storage.statementCount).toBe(8);
    expect(recorded.maxBlobResultBytes).toBe(0);
    expect(recorded.maxBindings).toBe(2);

    expect(importedRow(db, "/")?.mode).toBe(rootMode);
    expect(importedRow(db, "/")?.mtime).toBe(rootMtime);
    expect(importedRow(db, "/src")).toMatchObject({
      type: "dir",
      mode: 0o750,
      mtime: 1_620_000_000_000,
    });
    expect(importedBytes(db, "/src/code.ts")).toEqual(code);
    expect(importedRow(db, "/src/code.ts")?.size).toBe(code.length);
    expect(importedBytes(db, "/empty")).toEqual(new Uint8Array(0));
    expect(importedRow(db, "/src/code.ts")?.inode).toBeGreaterThanOrEqual(50_000);
    expect(importedRow(db, "/src/code.ts")?.content_id).toEqual(codeManifest);
    expect(importedRow(db, "/code-link")).toMatchObject({
      type: "symlink",
      mode: 0o777,
      mtime: 1_620_000_000_003,
      size: 12,
      link_target: "/src/code.ts",
    });
    expect(importedRow(db, "/.git")).toBeUndefined();
    expect(importedRow(db, "/repo/.git")).toBeUndefined();
    expect(importedRow(db, "/repo/mounted")).toBeUndefined();
    expect(importedRow(db, "/repo/mounted/inside.txt")).toBeUndefined();
    expect(importedRow(db, "/repo")).toBeDefined();
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(50_005);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(17);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'imported_vfs_rev'")).toBe(17);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'imported_at'")).toBe(
      1_800_000_000_000,
    );
    expect(() => assertComputerImportCurrent(db)).not.toThrow();

    // Construct Computer only after import, matching the acknowledged precondition.
    const workspace = new Workspace({ storage, now: () => 1_900_000_000_000 });
    workspace.provider().writeFileSync("/post-import", Buffer.from([9]));
    expect(() => assertComputerImportCurrent(db)).toThrow("vfs_meta.rev moved from 17 to 18");
  });

  it("imports manifestless files committed by the real Computer provider", () => {
    const { directory, storage, db, expected } = providerComputerDatabase();
    try {
      const recorded = new RecordingDatabase(db);
      storage.resetCounters();
      const result = importFromComputer(recorded, ACKNOWLEDGED);

      expect(result.entries).toBe(expected.length);
      expect(result.files).toBe(expected.length);
      expect(result.bytes).toBe(expected.reduce((total, file) => total + file.bytes.length, 0));
      expect(recorded.statementCount).toBe(8);
      expect(storage.statementCount).toBe(8);
      expect(recorded.maxBlobResultBytes).toBe(0);
      expect(recorded.maxBindings).toBe(2);

      for (const file of expected) {
        expect(importedBytes(db, file.path), file.path).toEqual(file.bytes);
        expect(importedRow(db, file.path), file.path).toMatchObject({
          type: "file",
          mode: file.mode,
          mtime: file.mtime,
          size: file.size,
          content_id: null,
        });
      }
    } finally {
      storage.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a non-fresh target filesystem", () => {
    const { db } = computerDatabase();
    db.run(
      `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
       VALUES (2, 'dir', 493, 1, 0, 0, 1)`,
    );
    db.run("INSERT INTO fs_paths (path, parent, inode) VALUES ('/used', '/', 2)");
    expect(() => importFromComputer(db, ACKNOWLEDGED)).toThrow("requires fresh fs_* tables");
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(2);
  });

  it("rejects Computer schema versions other than v5 before mutation", () => {
    const { storage, db } = computerDatabase();
    db.run("UPDATE vfs_meta SET v = 4 WHERE k = 'schema_version'");
    const recorded = new RecordingDatabase(db);
    storage.resetCounters();

    expect(() => importFromComputer(recorded, ACKNOWLEDGED)).toThrow(
      "unsupported Computer filesystem schema version: 4",
    );
    expect(recorded.statementCount).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM fs_meta WHERE k = 'imported_vfs_rev'")).toBe(0);
  });

  it("rolls back corrupt Computer sources before changing fs_*", () => {
    const corruptions: { name: string; apply(db: SqlDatabase): void }[] = [
      {
        name: "missing blob bytes",
        apply(db) {
          insertFile(db, 2, 1, "broken", new Uint8Array([1, 2, 3]), 0o644, 1);
          db.run("DELETE FROM vfs_blob_bytes");
        },
      },
      {
        name: "non-contiguous chunk order",
        apply(db) {
          insertFile(db, 2, 1, "broken", new Uint8Array(12), 0o644, 1);
          db.run("UPDATE vfs_chunks SET idx = 3 WHERE inode = 2 AND idx = 1");
        },
      },
      {
        name: "missing trailing chunk",
        apply(db) {
          insertFile(db, 2, 1, "broken", new Uint8Array(12), 0o644, 1);
          db.run("DELETE FROM vfs_chunks WHERE inode = 2 AND idx = 1");
        },
      },
      {
        name: "missing all chunks",
        apply(db) {
          insertFile(db, 2, 1, "broken", new Uint8Array([1, 2, 3]), 0o644, 1);
          db.run("DELETE FROM vfs_chunks WHERE inode = 2");
        },
      },
      {
        name: "manifestless missing trailing chunk",
        apply(db) {
          insertManifestlessFile(db, 2, 1, "broken", new Uint8Array(12));
          db.run("DELETE FROM vfs_chunks WHERE inode = 2 AND idx = 1");
        },
      },
      {
        name: "manifestless missing all chunks",
        apply(db) {
          insertManifestlessFile(db, 2, 1, "broken", new Uint8Array([1, 2, 3]));
          db.run("DELETE FROM vfs_chunks WHERE inode = 2");
        },
      },
      {
        name: "null symlink target",
        apply(db) {
          db.run(
            `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, link_target, size)
             VALUES (2, 'symlink', 511, 1, 1, NULL, 0)`,
          );
          db.run(
            "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (1, 'broken', 2)",
          );
        },
      },
    ];

    for (const corruption of corruptions) {
      const { storage, db } = computerDatabase({ rootMode: 0o750, rootMtime: 123 });
      corruption.apply(db);
      const recorded = new RecordingDatabase(db);
      storage.resetCounters();

      expect(() => importFromComputer(recorded, ACKNOWLEDGED), corruption.name).toThrow(
        "Computer filesystem integrity check failed",
      );
      expect(recorded.statementCount, corruption.name).toBe(1);
      expect(recorded.maxBlobResultBytes, corruption.name).toBe(0);
      expect(db.scalar<number>("SELECT count(*) FROM fs_paths"), corruption.name).toBe(1);
      expect(db.scalar<number>("SELECT count(*) FROM fs_nodes"), corruption.name).toBe(1);
      expect(db.scalar<number>("SELECT count(*) FROM fs_chunks"), corruption.name).toBe(0);
      expect(
        db.scalar<number>(
          "SELECT count(*) FROM fs_meta WHERE k IN ('imported_vfs_rev', 'imported_at')",
        ),
        corruption.name,
      ).toBe(0);
      expect(importedRow(db, "/"), corruption.name).toMatchObject({
        mode: 0o755,
        mtime: 1_500_000_000_000,
      });
    }
  });

  it("accepts a fresh standalone database with no Computer tables", () => {
    const db = new TestDatabase();
    initializeFsSchema(db);
    expect(() => assertComputerImportCurrent(db)).not.toThrow();
  });
});

interface SeedResult {
  entries: number;
  files: number;
  bytes: number;
}

function seededComputerDatabase(
  fileCount: number,
  totalBytes: number,
): {
  storage: SqliteTestStorage;
  db: TestDatabase;
  expected: SeedResult;
} {
  const { storage, db } = computerDatabase({ rootMode: 0o750, rootMtime: 1_600_000_000_123 });
  const directoryCount = Math.max(1, Math.floor((fileCount * 3_345) / 9_329));
  const sqlite = storage.db;
  const insertNode = sqlite.prepare(
    `INSERT INTO vfs_nodes
       (inode, type, mode, mtime, rev, manifest_hash, link_target, size)
     VALUES (?, ?, ?, ?, 777, ?, NULL, ?)`,
  );
  const insertDirent = sqlite.prepare(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
  );
  const insertBlob = sqlite.prepare(
    "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, 777)",
  );
  const insertBlobBytes = sqlite.prepare("INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?)");
  const insertChunk = sqlite.prepare(
    "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, 0, ?, ?)",
  );
  const insertManifest = sqlite.prepare(
    "INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, 777)",
  );

  sqlite.exec("BEGIN");
  try {
    for (let i = 0; i < directoryCount; i++) {
      const inode = 2 + i;
      insertNode.run(inode, "dir", 0o700 | (i % 0o77), 1_650_000_000_000 + i, null, 0);
      insertDirent.run(1, `dir-${i.toString().padStart(4, "0")}`, inode);
    }

    const baseSize = Math.floor(totalBytes / fileCount);
    let remainder = totalBytes % fileCount;
    for (let i = 0; i < fileCount; i++) {
      const inode = 2 + directoryCount + i;
      const parent = 2 + (i % directoryCount);
      const size = baseSize + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      const chunkHash = contentHash(inode);
      const bytes = new Uint8Array(size);
      bytes.fill(i & 0xff);
      const encoded = encodedManifest([{ idx: 0, hash: chunkHash, bytes }]);
      const manifestHash = sha256(encoded);

      insertNode.run(
        inode,
        "file",
        i % 17 === 0 ? 0o755 : 0o644,
        1_660_000_000_000 + i,
        manifestHash,
        size,
      );
      insertDirent.run(parent, `file-${i.toString().padStart(5, "0")}.ts`, inode);
      insertManifest.run(manifestHash, size, encoded);
      insertBlob.run(chunkHash, size);
      insertBlobBytes.run(chunkHash, bytes);
      insertChunk.run(inode, chunkHash, size);
    }
    sqlite.prepare("UPDATE vfs_meta SET v = 777 WHERE k = 'rev'").run();
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }

  db.run("UPDATE fs_meta SET v = 100_000 WHERE k = 'next_inode'");
  return {
    storage,
    db,
    expected: { entries: directoryCount + fileCount, files: fileCount, bytes: totalBytes },
  };
}

const SOURCE_WALK = `
WITH RECURSIVE walk(inode, path) AS (
  SELECT 1, '/'
  UNION ALL
  SELECT dirent.child_inode,
         CASE WHEN walk.path = '/'
              THEN '/' || dirent.name
              ELSE walk.path || '/' || dirent.name END
    FROM walk
    JOIN vfs_dirents dirent ON dirent.parent_inode = walk.inode
   WHERE dirent.name <> '.git'
)
SELECT walk.path AS path,
       source.inode AS source_inode,
       target_path.inode AS target_inode,
       source.type AS source_type,
       source.mode AS source_mode,
       source.mtime AS source_mtime,
       source.size AS source_size,
       source.link_target AS source_target,
       source.manifest_hash AS source_content_id,
       target.type AS target_type,
       target.mode AS target_mode,
       target.mtime AS target_mtime,
       target.size AS target_size,
       target.link_target AS target_target,
       target.content_id AS target_content_id
  FROM walk
  JOIN vfs_nodes source ON source.inode = walk.inode
  LEFT JOIN fs_paths target_path ON target_path.path = walk.path
  LEFT JOIN fs_nodes target ON target.inode = target_path.inode`;

function runScale(
  fileCount: number,
  totalBytes: number,
): {
  statements: number;
  maxBlobResultBytes: number;
} {
  const { storage, db, expected } = seededComputerDatabase(fileCount, totalBytes);
  const recorded = new RecordingDatabase(db);
  storage.resetCounters();
  const result = importFromComputer(recorded, {
    acknowledgement: COMPUTER_IMPORT_ACKNOWLEDGEMENT,
    now: () => 1_900_000_000_000,
  });

  expect(result).toEqual({ ...expected, vfsRev: 777 });
  expect(recorded.statementCount).toBe(8);
  expect(storage.statementCount).toBe(8);
  expect(recorded.maxBindings).toBe(2);
  expect(recorded.maxBlobResultBytes).toBe(0);
  expect(
    db.scalar<number>(
      `SELECT count(*) FROM (${SOURCE_WALK}) row
        WHERE target_inode IS NULL
           OR (path = '/' AND target_inode <> 1)
           OR (path <> '/' AND target_inode < 100000)
           OR source_type <> target_type
           OR source_mode <> target_mode
           OR source_mtime <> target_mtime
           OR source_size <> target_size
           OR NOT (source_target IS target_target)
           OR NOT (source_content_id IS target_content_id)`,
    ),
  ).toBe(0);
  expect(
    db.scalar<number>(
      `WITH RECURSIVE walk(inode, path) AS (
         SELECT 1, '/'
         UNION ALL
         SELECT dirent.child_inode,
                CASE WHEN walk.path = '/'
                     THEN '/' || dirent.name
                     ELSE walk.path || '/' || dirent.name END
           FROM walk
           JOIN vfs_dirents dirent ON dirent.parent_inode = walk.inode
          WHERE dirent.name <> '.git'
       )
       SELECT count(*)
         FROM walk
         JOIN vfs_nodes source ON source.inode = walk.inode AND source.type = 'file'
         JOIN vfs_chunks source_chunk ON source_chunk.inode = source.inode
         JOIN vfs_blob_bytes source_bytes ON source_bytes.hash = source_chunk.hash
         LEFT JOIN fs_paths target_path ON target_path.path = walk.path
         LEFT JOIN fs_chunks target_chunk
           ON target_chunk.inode = target_path.inode AND target_chunk.idx = source_chunk.idx
        WHERE target_chunk.inode IS NULL
           OR NOT (source_bytes.bytes IS target_chunk.bytes)`,
    ),
  ).toBe(0);
  expect(recorded.statementCount).toBeLessThan(1_000);
  return { statements: recorded.statementCount, maxBlobResultBytes: recorded.maxBlobResultBytes };
}

describe("Computer import scale", () => {
  it("uses the same eight statements at Prettier scale and at one tenth scale", () => {
    const small = runScale(933, 2_404_379);
    const prettier = runScale(9_329, 24_043_793);

    expect(small).toEqual({ statements: 8, maxBlobResultBytes: 0 });
    expect(prettier).toEqual({ statements: 8, maxBlobResultBytes: 0 });
  }, 30_000);
});

interface ReadValues {
  revision: number;
  real: RealPath;
  stat: Stat;
  bytes: Uint8Array;
  target: string;
  entries: { name: string; type: "file" | "dir" | "symlink" }[];
  scan: ScanEntry[];
  remaining: string[];
  glob: string[];
}

function readSource(values: ReadValues): ShadowReadSource {
  return {
    rev: () => values.revision,
    realpath: () => values.real,
    stat: () => values.stat,
    statTarget: () => values.stat,
    exists: () => true,
    readFile: () => values.bytes,
    readRange: (_path, offset, length) => values.bytes.subarray(offset, offset + length),
    readlink: () => values.target,
    readdir: () => values.entries,
    scan: () => values.scan,
    readFiles: (paths) => ({
      files: new Map(paths.map((path) => [path, values.bytes])),
      remaining: values.remaining,
    }),
    glob: () => values.glob,
  };
}

function readValues(real: RealPath, overrides: Partial<ReadValues> = {}): ReadValues {
  const stat: Stat = {
    type: "file",
    mode: S_IFREG | 0o644,
    size: 3,
    mtime: 123,
    ino: 1,
    nlink: 1,
    rev: 7,
    target: null,
    contentId: new Uint8Array([1, 2]),
  };
  return {
    revision: 17,
    real,
    stat,
    bytes: new Uint8Array([1, 2, 3]),
    target: "/target",
    entries: [
      { name: "child", type: "file" },
      { name: "dir", type: "dir" },
    ],
    scan: [{ path: "/file", ...stat }],
    remaining: ["/later"],
    glob: ["/a", "/b"],
    ...overrides,
  };
}

function resolvedRoot(): RealPath {
  const db = new TestDatabase();
  initializeFsSchema(db);
  return resolveRealpath(db, "/");
}

describe("shadowReads", () => {
  it("compares and returns every Filesystem read method while exposing no mutators", () => {
    const real = resolvedRoot();
    const primaryValues = readValues(real);
    const comparisonStat = { ...primaryValues.stat, ino: 99, rev: 999 };
    const comparisonValues = readValues(real, {
      stat: comparisonStat,
      scan: [{ path: "/file", ...comparisonStat }],
    });
    const shadow = shadowReads(readSource(primaryValues), readSource(comparisonValues));

    expect(shadow.rev()).toBe(17);
    expect(shadow.realpath("/")).toBe(real);
    expect(shadow.stat("/file")).toBe(primaryValues.stat);
    expect(shadow.statTarget("/file")).toBe(primaryValues.stat);
    expect(shadow.exists("/file")).toBe(true);
    expect(shadow.readFile("/file")).toEqual(new Uint8Array([1, 2, 3]));
    expect(shadow.readRange("/file", 1, 2)).toEqual(new Uint8Array([2, 3]));
    expect(shadow.readlink("/link")).toBe("/target");
    expect(shadow.readdir("/")).toEqual(primaryValues.entries);
    expect(shadow.scan("/", { limit: 10 })).toEqual(primaryValues.scan);
    expect(shadow.readFiles(["/file"])).toEqual({
      files: new Map([["/file", new Uint8Array([1, 2, 3])]]),
      remaining: ["/later"],
    });
    expect(shadow.glob("/", "*")).toEqual(["/a", "/b"]);
    expect(Object.keys(shadow).sort()).toEqual(
      [
        "exists",
        "glob",
        "readFile",
        "readFiles",
        "readRange",
        "readdir",
        "readlink",
        "realpath",
        "rev",
        "scan",
        "stat",
        "statTarget",
      ].sort(),
    );
    expect("writeFile" in shadow).toBe(false);
  });

  it("detects semantic value mismatches", () => {
    const real = resolvedRoot();
    const primary = readSource(readValues(real));
    const comparison = readSource(readValues(real, { glob: ["/different"] }));
    expect(() => shadowReads(primary, comparison).glob("/", "*")).toThrow(
      "returned different values",
    );
  });

  it("rethrows matching errors and detects different errors", () => {
    const real = resolvedRoot();
    const left = readSource(readValues(real));
    const right = readSource(readValues(real));
    const leftMissing = Object.assign(new Error("left missing"), { code: "ENOENT" });
    const rightMissing = Object.assign(new Error("right missing"), { code: "ENOENT" });
    left.readFile = () => {
      throw leftMissing;
    };
    right.readFile = () => {
      throw rightMissing;
    };
    expect(() => shadowReads(left, right).readFile("/missing")).toThrow(leftMissing);

    right.readFile = () => {
      throw Object.assign(new Error("wrong type"), { code: "EISDIR" });
    };
    expect(() => shadowReads(left, right).readFile("/missing")).toThrow("threw different errors");

    right.readFile = () => new Uint8Array(0);
    expect(() => shadowReads(left, right).readFile("/missing")).toThrow(
      "succeeded in only one runtime",
    );
  });

  it("does not ignore semantic stat differences", () => {
    const real = resolvedRoot();
    const primaryValues = readValues(real);
    const changed: Stat = { ...primaryValues.stat, type: "dir", mode: S_IFDIR | 0o755 };
    expect(() =>
      shadowReads(readSource(primaryValues), readSource(readValues(real, { stat: changed }))).stat(
        "/file",
      ),
    ).toThrow("returned different values");
  });
});
