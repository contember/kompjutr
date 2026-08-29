// P1 from §7.0 — the bulk reads.
//
// Every gate here has two halves. A statement ceiling on its own is beaten by
// an implementation that returns nothing, so each count is paired with an
// assertion on the rows it produced.
//
// The fixtures are built with direct SQL on purpose: F3, the bulk write, is
// being written in parallel with this file and cannot be imported.

import { describe, expect, it } from "vitest";

import { comparePaths, subtreeSuccessor } from "../../src/fs/path.js";
import { CHUNK_SIZE, initializeFsSchema } from "../../src/fs/schema.js";
import { allocateInodes } from "../../src/fs/store/meta.js";
import { realpath } from "../../src/fs/store/resolve.js";
import {
  DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX,
  DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES,
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES,
  DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS,
  DISCOVERY_EXCLUDE_ROOTS_MAX,
  DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES,
  DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS,
  DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES,
  discoverFiles,
  discoveryExcludeRootsJsonSegments,
  glob,
  globPage,
  listEntries,
  scan,
  validateDiscoveryExcludeRoots,
} from "../../src/fs/store/scan.js";
import { writeFiles } from "../../src/fs/store/write.js";
import {
  type EntryType,
  type ListCursor,
  type ListItem,
  type RealPath,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  type ScanEntry,
} from "../../src/fs/types.js";
import type { SqlDatabase } from "../../src/sqlite/db.js";
import { TestDatabase } from "../helpers/db.js";

const MTIME_BASE = 1_700_000_000_000;

interface Spec {
  path: string;
  type?: EntryType;
  target?: string;
}

function open(): TestDatabase {
  const db = new TestDatabase();
  initializeFsSchema(db, () => MTIME_BASE);
  return db;
}

/**
 * Insert rows straight into `fs_paths` and `fs_nodes`. Every field varies
 * with the row index so a fingerprint comparison has something to catch, and
 * every fifth file carries a `content_id` so the BLOB column is exercised.
 */
function seed(db: TestDatabase, specs: readonly Spec[]): void {
  db.transactionSync(() => {
    const first = allocateInodes(db, specs.length);
    specs.forEach((spec, index) => {
      const type = spec.type ?? "file";
      const slash = spec.path.lastIndexOf("/");
      const parent = slash === 0 ? "/" : spec.path.slice(0, slash);
      const size =
        type === "dir" ? 0 : type === "symlink" ? (spec.target?.length ?? 0) : index * 7 + 1;
      const contentId =
        type === "file" && index % 5 === 0 ? Uint8Array.from([index & 0xff, 0xab, 0xcd]) : null;

      db.run(
        `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink, link_target, content_id)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        first + index,
        type,
        type === "dir" ? 0o755 : type === "symlink" ? 0o777 : 0o644,
        MTIME_BASE + index,
        size,
        index + 1,
        spec.target ?? null,
        contentId,
      );
      db.run(
        "INSERT INTO fs_paths (path, parent, inode) VALUES (?, ?, ?)",
        spec.path,
        parent,
        first + index,
      );
    });
  });
}

function hex(bytes: Uint8Array | null): string {
  if (bytes === null) return "-";
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Every field of an entry, so "identical sequence" means every column. */
function fingerprint(entry: ScanEntry): string {
  return [
    entry.path,
    entry.type,
    entry.mode,
    entry.size,
    entry.mtime,
    entry.ino,
    entry.nlink,
    entry.rev,
    entry.target ?? "-",
    hex(entry.contentId),
  ].join("\t");
}

/** The keyset pager a caller writes: resume at the last path returned. */
function scanAll(
  db: SqlDatabase,
  root: RealPath,
  pageSize: number,
  options: { filesOnly?: boolean; after?: string } = {},
): ScanEntry[] {
  const out: ScanEntry[] = [];
  let after = options.after;
  for (;;) {
    const page = scan(db, root, { after, limit: pageSize, filesOnly: options.filesOnly });
    out.push(...page);
    if (page.length < pageSize) return out;
    const last = page[page.length - 1];
    if (last === undefined) return out;
    after = last.path;
  }
}

function pathsOf(entries: readonly ScanEntry[]): string[] {
  return entries.map((entry) => entry.path);
}

/** Pairs the scan returned out of `comparePaths` order. Expected: none. */
function misordered(paths: readonly string[]): string[] {
  return paths.filter((path, index) => {
    const previous = paths[index - 1];
    return previous !== undefined && comparePaths(previous, path) >= 0;
  });
}

/** Captures the SQL a call issues, so the plan gate needs no exported query. */
class RecordingDatabase implements SqlDatabase {
  readonly queries: { query: string; bindings: unknown[] }[] = [];
  maxResultBytes = 0;
  maxResultRows = 0;
  maxBindingBytes = 0;

  constructor(private readonly inner: SqlDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.queries.push({ query, bindings });
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.queries.push({ query, bindings });
    let bindingBytes = 0;
    for (const binding of bindings) {
      if (typeof binding === "string") bindingBytes += new TextEncoder().encode(binding).length;
      else if (binding instanceof Uint8Array) bindingBytes += binding.byteLength;
      else if (binding instanceof ArrayBuffer) bindingBytes += binding.byteLength;
      else bindingBytes += 8;
    }
    this.maxBindingBytes = Math.max(this.maxBindingBytes, bindingBytes);
    const rows = this.inner.all<Row>(query, ...bindings);
    this.maxResultRows = Math.max(this.maxResultRows, rows.length);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) this.maxResultBytes += value.byteLength;
        else if (value instanceof ArrayBuffer) this.maxResultBytes += value.byteLength;
      }
    }
    return rows;
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.queries.push({ query, bindings });
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.queries.push({ query, bindings });
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.queries.push({ query, bindings });
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function planOf(db: TestDatabase, recorder: RecordingDatabase): string {
  expect(recorder.queries).toHaveLength(1);
  const issued = recorder.queries[0];
  if (issued === undefined) throw new Error("no statement was issued");
  return db
    .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${issued.query}`, ...issued.bindings)
    .map((row) => row.detail)
    .join("\n");
}

interface BytecodeRow {
  addr: number;
  opcode: string;
  p2: number;
}

function bytecodeOf(db: TestDatabase, recorder: RecordingDatabase): BytecodeRow[] {
  expect(recorder.queries).toHaveLength(1);
  const issued = recorder.queries[0];
  if (issued === undefined) throw new Error("no statement was issued");
  return db.all<BytecodeRow>(`EXPLAIN ${issued.query}`, ...issued.bindings);
}

// ---------------------------------------------------------------------------
// The adversarial ordering fixture.
//
// '.' is 0x2E, '/' is 0x2F and '0' is 0x30, so `a` < `a.txt` < `a/x` < `a0`.
// The non-ASCII names separate UTF-8 byte order from UTF-16 code-unit order:
// U+FF21 is one unit at 0xFF21, U+1F600 is a surrogate pair starting at
// 0xD83D, so a naive JS `<` sorts those two the wrong way round.
// ---------------------------------------------------------------------------

const ADVERSARIAL: readonly Spec[] = [
  { path: "/a", type: "dir" },
  { path: "/a/x" },
  { path: "/a/y" },
  { path: "/a/Ａ.txt" },
  { path: "/a/ü.txt" },
  { path: "/a/日本.txt" },
  { path: "/a/😀.txt" },
  { path: "/a.txt" },
  { path: "/a0" },
  { path: "/link", type: "symlink", target: "/a/x" },
  { path: "/naïve" },
  { path: "/z", type: "dir" },
  { path: "/z/deep", type: "dir" },
  { path: "/z/deep/f" },
];

const ADVERSARIAL_ORDER = [
  "/a",
  "/a.txt",
  "/a/x",
  "/a/y",
  "/a/ü.txt",
  "/a/日本.txt",
  "/a/Ａ.txt",
  "/a/😀.txt",
  "/a0",
  "/link",
  "/naïve",
  "/z",
  "/z/deep",
  "/z/deep/f",
];

const NON_ASCII_ORDER = ["/a/ü.txt", "/a/日本.txt", "/a/Ａ.txt", "/a/😀.txt", "/naïve"];

function adversarial(): { db: TestDatabase; root: RealPath } {
  const db = open();
  seed(db, ADVERSARIAL);
  return { db, root: realpath(db, "/") };
}

// ---------------------------------------------------------------------------
// The 12,675-row fixture, plus the sibling names a `LIKE 'prefix%'` gets
// wrong.
// ---------------------------------------------------------------------------

const DIRS = 25;
const NUMBERED_PER_DIR = 502;
const SPECIAL_NAMES = ["Ａ.txt", "ü.txt", "日本.txt", "😀.txt"];
const FILES_PER_DIR = NUMBERED_PER_DIR + SPECIAL_NAMES.length;
/** 25 directory rows + 25 × 506 file rows. */
const BIG_ROWS = DIRS * (1 + FILES_PER_DIR);

const DECOYS = ["/repo/src-extra", "/repo/src0", "/repo/srcx", "/repo/source", "/repo/src.txt"];

function buildBig(): { db: TestDatabase; root: RealPath } {
  const specs: Spec[] = [
    { path: "/repo", type: "dir" },
    { path: "/repo/src", type: "dir" },
  ];

  for (let d = 0; d < DIRS; d++) {
    const dir = `/repo/src/d${String(d).padStart(2, "0")}`;
    specs.push({ path: dir, type: "dir" });
    for (let f = 0; f < NUMBERED_PER_DIR; f++) {
      specs.push({ path: `${dir}/f${String(f).padStart(3, "0")}.txt` });
    }
    for (const name of SPECIAL_NAMES) specs.push({ path: `${dir}/${name}` });
  }

  // Siblings a prefix match would swallow: '-' 0x2D and '.' 0x2E sort below
  // '/' 0x2F, and 'src0' is the successor bound itself.
  for (const decoy of DECOYS) {
    if (decoy.endsWith(".txt")) {
      specs.push({ path: decoy });
      continue;
    }
    specs.push({ path: decoy, type: "dir" });
    specs.push({ path: `${decoy}/f.txt` });
  }

  const db = open();
  seed(db, specs);
  return { db, root: realpath(db, "/repo/src") };
}

const BIG = buildBig();

describe("scan — order", () => {
  it("returns paths in comparePaths order", () => {
    const { db, root } = adversarial();
    const paths = pathsOf(scanAll(db, root, 1000));

    expect(paths).toEqual(ADVERSARIAL_ORDER);
    expect(paths).toEqual([...paths].sort(comparePaths));
  });

  it("sorts a < a.txt < a/x < a0, the case every merge join above depends on", () => {
    const { db, root } = adversarial();
    const paths = pathsOf(scanAll(db, root, 1000));

    expect(paths.slice(0, 4)).toEqual(["/a", "/a.txt", "/a/x", "/a/y"]);
    expect(paths.indexOf("/a")).toBeLessThan(paths.indexOf("/a.txt"));
    expect(paths.indexOf("/a.txt")).toBeLessThan(paths.indexOf("/a/x"));
    expect(paths.indexOf("/a/y")).toBeLessThan(paths.indexOf("/a0"));
  });

  it("orders non-ASCII names by code point, not by UTF-16 unit", () => {
    const { db, root } = adversarial();
    const paths = pathsOf(scanAll(db, root, 1000));

    // The fixture only proves anything if the two orders actually differ.
    const utf16 = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(utf16).not.toEqual(paths);
    expect(paths.indexOf("/a/Ａ.txt")).toBeLessThan(paths.indexOf("/a/😀.txt"));
  });

  it("returns non-ASCII paths intact", () => {
    const { db, root } = adversarial();
    const paths = pathsOf(scanAll(db, root, 1000));

    // `substr` counts bytes over a BLOB and characters over TEXT; a path
    // sliced at a byte boundary corrupts silently and only shows up here.
    expect(paths.filter((path) => /[^\x20-\x7e]/.test(path))).toEqual(NON_ASCII_ORDER);
  });

  it("keeps the 12,675-row fixture in comparePaths order too", () => {
    const paths = pathsOf(scanAll(BIG.db, BIG.root, 1000));

    expect(paths).toHaveLength(BIG_ROWS);
    expect(misordered(paths)).toEqual([]);
  });
});

describe("scan — paging", () => {
  it("returns identical sequences at page 1, 7, 1000 and unbounded", () => {
    const oneShot = scanAll(BIG.db, BIG.root, BIG_ROWS + 1).map(fingerprint);
    expect(oneShot).toHaveLength(BIG_ROWS);

    for (const pageSize of [1, 7, 1000]) {
      expect(scanAll(BIG.db, BIG.root, pageSize).map(fingerprint)).toEqual(oneShot);
    }
  });

  it("excludes the root row and never repeats one", () => {
    const paths = pathsOf(scanAll(BIG.db, BIG.root, 1000));

    expect(paths).not.toContain("/repo/src");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("resumes past a whole subtree when the caller skips it", () => {
    const skipped = "/repo/src/d00";
    const full = pathsOf(scanAll(BIG.db, BIG.root, 1000));

    const head = scan(BIG.db, BIG.root, { limit: 1 });
    expect(pathsOf(head)).toEqual([skipped]);

    // What a caller does with an ignored directory: it has the directory row
    // already, so it resumes at the successor rather than at the last path.
    const pruned = [
      skipped,
      ...pathsOf(scan(BIG.db, BIG.root, { afterSubtree: skipped, limit: BIG_ROWS })),
    ];

    expect(pruned).toHaveLength(BIG_ROWS - FILES_PER_DIR);
    expect(pruned).toEqual(full.filter((path) => !path.startsWith(`${skipped}/`)));
  });

  it("includes an exact successor sibling after pruning across a page boundary", () => {
    const db = open();
    writeFiles(db, [
      { path: "/dir/child", bytes: new Uint8Array([1]) },
      { path: "/dir0", bytes: new Uint8Array([2]) },
    ]);
    const root = realpath(db, "/");

    expect(pathsOf(scan(db, root, { limit: 1 }))).toEqual(["/dir"]);
    expect(pathsOf(scan(db, root, { afterSubtree: "/dir", limit: 1 }))).toEqual(["/dir0"]);
    expect(() => scan(db, root, { after: "/dir", afterSubtree: "/dir", limit: 1 })).toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects a non-positive page size instead of looping forever", () => {
    expect(() => scan(BIG.db, BIG.root, { limit: 0 })).toThrow(/positive integer/);
    expect(() => scan(BIG.db, BIG.root, { limit: -1 })).toThrow(/positive integer/);
  });
});

describe("scan — statement count", () => {
  it("walks 12,675 rows in 13 statements at a 1,000 page", () => {
    BIG.db.storage.resetCounters();
    const entries = scanAll(BIG.db, BIG.root, 1000);

    expect(entries).toHaveLength(BIG_ROWS);
    expect(BIG.db.storage.statementCount).toBe(13);
  });

  it("costs one statement per page, and one more for a skipped subtree", () => {
    BIG.db.storage.resetCounters();
    const first = scan(BIG.db, BIG.root, { limit: 1000 });
    expect(first).toHaveLength(1000);
    expect(BIG.db.storage.statementCount).toBe(1);

    scan(BIG.db, BIG.root, { after: subtreeSuccessor("/repo/src/d00"), limit: 1000 });
    expect(BIG.db.storage.statementCount).toBe(2);
  });
});

describe("scan — subtree bounds", () => {
  it("excludes src-extra, src0, srcx, source and src.txt", () => {
    const paths = pathsOf(scanAll(BIG.db, BIG.root, 1000));

    for (const decoy of DECOYS) {
      // The check is vacuous unless the decoy is really in the table.
      expect(BIG.db.scalar<number>("SELECT count(*) FROM fs_paths WHERE path = ?", decoy)).toBe(1);
      expect(paths).not.toContain(decoy);
      expect(paths.filter((path) => path.startsWith(`${decoy}/`))).toEqual([]);
    }
  });

  it("does not widen the range when the resume cursor sits outside it", () => {
    const paths = pathsOf(scan(BIG.db, BIG.root, { after: "/repo", limit: 1000 }));

    expect(paths[0]).toBe("/repo/src/d00");
    for (const decoy of DECOYS) expect(paths).not.toContain(decoy);
  });

  it("scans the whole tree from the root", () => {
    const { db } = adversarial();
    const paths = pathsOf(scanAll(db, realpath(db, "/"), 1000));

    expect(paths).toEqual(ADVERSARIAL_ORDER);
    expect(paths).not.toContain("/");
  });

  it("returns nothing for a subtree that is not there", () => {
    const { db } = adversarial();
    expect(scan(db, realpath(db, "/nowhere"), { limit: 10 })).toEqual([]);
  });
});

describe("scan — entry shape", () => {
  it("reports full st_mode, inode, nlink, rev, target and contentId", () => {
    const { db, root } = adversarial();
    const entries = scanAll(db, root, 1000);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    const dir = byPath.get("/a");
    const file = byPath.get("/a/x");
    const symlink = byPath.get("/link");
    if (dir === undefined || file === undefined || symlink === undefined) {
      throw new Error("fixture rows missing");
    }

    expect(dir.type).toBe("dir");
    expect(dir.mode).toBe(S_IFDIR | 0o755);
    expect(file.mode).toBe(S_IFREG | 0o644);
    expect(symlink.mode).toBe(S_IFLNK | 0o777);
    expect(symlink.target).toBe("/a/x");
    expect(file.target).toBeNull();
    expect(dir.ino).toBeGreaterThan(1);
    expect(file.nlink).toBe(1);
    expect(file.rev).toBeGreaterThan(0);
    expect(file.mtime).toBeGreaterThanOrEqual(MTIME_BASE);

    // Every fifth file carries one; the rest report null rather than empty.
    const withId = entries.filter((entry) => entry.contentId !== null);
    expect(withId.length).toBeGreaterThan(0);
    for (const entry of withId) expect(entry.contentId).toBeInstanceOf(Uint8Array);
  });
});

describe("scan — filesOnly", () => {
  it("returns the full scan minus exactly the directory rows", () => {
    const full = scanAll(BIG.db, BIG.root, 1000);
    const files = scanAll(BIG.db, BIG.root, 1000, { filesOnly: true });

    expect(full.filter((entry) => entry.type === "dir")).toHaveLength(DIRS);
    expect(files).toHaveLength(BIG_ROWS - DIRS);
    expect(files.map(fingerprint)).toEqual(
      full.filter((entry) => entry.type !== "dir").map(fingerprint),
    );
  });

  it("keeps symlinks", () => {
    const { db, root } = adversarial();
    const files = scanAll(db, root, 1000, { filesOnly: true });

    expect(pathsOf(files)).toContain("/link");
    expect(pathsOf(files)).not.toContain("/a");
    expect(files.map((entry) => entry.type)).not.toContain("dir");
  });

  it("pages the same way", () => {
    const oneShot = scanAll(BIG.db, BIG.root, BIG_ROWS + 1, { filesOnly: true }).map(fingerprint);

    for (const pageSize of [1, 7, 1000]) {
      expect(scanAll(BIG.db, BIG.root, pageSize, { filesOnly: true }).map(fingerprint)).toEqual(
        oneShot,
      );
    }
  });
});

describe("scan — query plan", () => {
  it("is an indexed range scan on the fs_paths primary key", () => {
    const recorder = new RecordingDatabase(BIG.db);
    scan(recorder, BIG.root, { limit: 10 });

    const plan = planOf(BIG.db, recorder);
    expect(plan).toContain("SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)");
    expect(plan).toContain("SEARCH fs_nodes USING INTEGER PRIMARY KEY (rowid=?)");
    expect(plan).not.toMatch(/\bSCAN\b/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("stays an indexed range scan with filesOnly", () => {
    const recorder = new RecordingDatabase(BIG.db);
    scan(recorder, BIG.root, { limit: 10, filesOnly: true });

    const plan = planOf(BIG.db, recorder);
    expect(plan).toContain("SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)");
    expect(plan).not.toMatch(/\bSCAN\b/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("stays one indexed range scan with an inclusive subtree resume", () => {
    const recorder = new RecordingDatabase(BIG.db);
    scan(recorder, BIG.root, { afterSubtree: "/repo/src/d00", limit: 10 });

    const plan = planOf(BIG.db, recorder);
    expect(plan).toContain("SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)");
    expect(plan).not.toMatch(/\bSCAN\b/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});

describe("glob", () => {
  it("matches under the subtree in path order, in one statement", () => {
    BIG.db.storage.resetCounters();
    const found = glob(BIG.db, BIG.root, "*/d01/f00*.txt");

    expect(BIG.db.storage.statementCount).toBe(1);
    expect(found).toHaveLength(10);
    expect(found[0]).toBe("/repo/src/d01/f000.txt");
    expect(found).toEqual([...found].sort(comparePaths));
  });

  it("obeys the same subtree bounds as scan", () => {
    const found = glob(BIG.db, BIG.root, "*.txt");

    expect(found).toHaveLength(BIG_ROWS - DIRS);
    for (const decoy of DECOYS) expect(found).not.toContain(decoy);
  });

  it("caps the result set when a limit is given", () => {
    expect(glob(BIG.db, BIG.root, "*.txt", { limit: 3 })).toEqual([
      "/repo/src/d00/f000.txt",
      "/repo/src/d00/f001.txt",
      "/repo/src/d00/f002.txt",
    ]);
  });

  it("pages with an explicit completeness cursor", () => {
    const first = globPage(BIG.db, BIG.root, "*.txt", { limit: 3 });
    expect(first.paths).toEqual([
      "/repo/src/d00/f000.txt",
      "/repo/src/d00/f001.txt",
      "/repo/src/d00/f002.txt",
    ]);
    expect(first.next).toBe(first.paths[2]);

    const second = globPage(BIG.db, BIG.root, "*.txt", {
      after: first.next ?? undefined,
      limit: 3,
    });
    expect(second.paths[0]).toBe("/repo/src/d00/f003.txt");
    expect(new Set([...first.paths, ...second.paths]).size).toBe(6);
  });

  it("proves completion when the result exactly fills a page", () => {
    const found = globPage(BIG.db, BIG.root, "*/d01/f00*.txt", { limit: 10 });
    expect(found.paths).toHaveLength(10);
    expect(found.next).toBeNull();
  });

  it("finds non-ASCII names", () => {
    const { db, root } = adversarial();
    expect(glob(db, root, "*/日本.txt")).toEqual(["/a/日本.txt"]);
  });

  it("is an indexed range scan too", () => {
    const recorder = new RecordingDatabase(BIG.db);
    glob(recorder, BIG.root, "*.txt", { limit: 1 });

    const plan = planOf(BIG.db, recorder);
    expect(plan).toContain("SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)");
    expect(plan).not.toMatch(/\bSCAN\b/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("rejects a pattern over the platform's 50-byte cap", () => {
    expect(() => glob(BIG.db, BIG.root, "a".repeat(50))).not.toThrow();
    expect(() => glob(BIG.db, BIG.root, "a".repeat(51))).toThrow(/51 bytes/);
    // 17 characters, 51 bytes — the cap counts bytes.
    expect(() => glob(BIG.db, BIG.root, "日".repeat(17))).toThrow(/51 bytes/);
  });
});

describe("listEntries", () => {
  it("groups recursive metadata and represents empty directories", () => {
    const db = open();
    writeFiles(db, [
      { path: "/repo/a/one.txt", bytes: new Uint8Array([1]), mode: 0o600 },
      { path: "/repo/b/two.txt", bytes: new Uint8Array([2]), mode: 0o640 },
      { path: "/repo/empty" },
    ]);
    const root = realpath(db, "/repo");
    const items: ListItem[] = [];
    let after: ListCursor | undefined;
    for (;;) {
      const page = listEntries(
        db,
        root,
        after === undefined ? { recursive: true, limit: 2 } : { recursive: true, after, limit: 2 },
      );
      items.push(...page.items);
      if (page.next === null) break;
      after = page.next;
    }

    expect(items.map((item) => [item.directory, item.entry?.path ?? null])).toEqual([
      ["/repo", "/repo/a"],
      ["/repo", "/repo/b"],
      ["/repo", "/repo/empty"],
      ["/repo/a", "/repo/a/one.txt"],
      ["/repo/b", "/repo/b/two.txt"],
      ["/repo/empty", null],
    ]);
    expect(items[3]?.entry).toMatchObject({ type: "file", mode: S_IFREG | 0o600, size: 1 });
  });

  it("returns one bounded statement per page", () => {
    BIG.db.storage.resetCounters();
    const page = listEntries(BIG.db, BIG.root, { recursive: true, limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.next).not.toBeNull();
    expect(BIG.db.storage.statementCount).toBe(1);
  });
});

describe("discoverFiles", () => {
  function nested(count: number): { db: TestDatabase; root: RealPath } {
    const db = open();
    const entries = [];
    let directory = "/repo";
    for (let index = 0; index < count; index++) {
      directory += `/d${index}`;
      entries.push({
        path: `${directory}/.gitignore`,
        bytes: new TextEncoder().encode(`ignored-${index}`),
      });
    }
    writeFiles(db, entries);
    return { db, root: realpath(db, "/repo") };
  }

  it("returns only validated regular files in canonical path order", () => {
    const db = open();
    writeFiles(db, [
      { path: "/repo/.gitignore", bytes: new TextEncoder().encode("root") },
      { path: "/repo/a/.gitignore", bytes: new TextEncoder().encode("nested") },
      { path: "/repo/z.txt", bytes: new Uint8Array([1]) },
      { path: "/target", bytes: new TextEncoder().encode("target") },
      { path: "/repo/link/.gitignore", target: "/target" },
    ]);
    const root = realpath(db, "/repo");
    const recorder = new RecordingDatabase(db);

    const { handles } = discoverFiles(recorder, root, "*/.gitignore");

    expect(handles.map((handle) => handle.path)).toEqual([
      "/repo/.gitignore",
      "/repo/a/.gitignore",
    ]);
    expect(handles.every((handle) => handle.ino > 1 && handle.rev > 0)).toBe(true);
    expect(recorder.queries).toHaveLength(1);
    expect(recorder.maxResultBytes).toBe(0);
  });

  it("keeps one statement at ten and one hundred nested files", () => {
    for (const count of [10, 100]) {
      const { db, root } = nested(count);
      db.storage.resetCounters();
      expect(discoverFiles(db, root, "*/.gitignore").handles).toHaveLength(count);
      expect(db.storage.statementCount).toBe(1);
    }
  });

  it("passes 65 coalesced exclusion ranges through one bounded JSON binding", () => {
    const db = open();
    const roots = Array.from(
      { length: 65 },
      (_, index) => `/repo/nested-${index.toString().padStart(2, "0")}`,
    );
    writeFiles(db, [
      ...roots.map((root) => ({
        path: `${root}/.gitignore`,
        bytes: new Uint8Array(0),
      })),
      { path: "/repo/z/.gitignore", bytes: new Uint8Array(0) },
    ]);
    const root = realpath(db, "/repo");
    const recorder = new RecordingDatabase(db);

    const page = discoverFiles(recorder, root, "*/.gitignore", { excludeRoots: roots });

    expect(page.handles.map((handle) => handle.path)).toEqual(["/repo/z/.gitignore"]);
    expect(recorder.queries).toHaveLength(1);
    const issued = recorder.queries[0];
    if (issued === undefined) throw new Error("discovery statement was not recorded");
    expect(issued.query).toContain("json_each(?)");
    expect(issued.query.match(/json_each\(\?\)/g)).toHaveLength(
      DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS,
    );
    expect(issued.bindings).toHaveLength(DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS);
    let sourceRows = 0;
    for (let index = 0; index < DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS; index++) {
      const ranges = issued.bindings[index];
      if (typeof ranges !== "string") throw new Error("exclusion ranges were not JSON text");
      expect(new TextEncoder().encode(ranges).byteLength).toBeLessThanOrEqual(
        DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES,
      );
      sourceRows += db.scalar<number>("SELECT count(*) FROM json_each(?)", ranges) ?? 0;
      if (index > 0) expect(ranges).toBe("[]");
    }
    expect(sourceRows).toBe(65);
    expect(recorder.maxResultRows).toBe(1);
    expect(recorder.maxResultBytes).toBe(0);
  });

  it("rolls the first JSON value over without exceeding one SQL binding", () => {
    const path = `/repo/${"x".repeat(4_090)}`;
    const item = JSON.stringify(path);
    const itemBytes = new TextEncoder().encode(item).byteLength;
    const exactItems = Math.floor(
      (DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES - 1) / (itemBytes + 1),
    );
    const segments = discoveryExcludeRootsJsonSegments(
      Array.from({ length: exactItems + 1 }, () => path),
    );

    expect(segments).toHaveLength(DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS);
    expect(new TextEncoder().encode(segments[0] ?? "").byteLength).toBeLessThanOrEqual(
      DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES,
    );
    expect(new TextEncoder().encode(segments[1] ?? "").byteLength).toBeLessThanOrEqual(
      DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES,
    );
    expect(segments[0]).not.toBe("[]");
    expect(segments[1]).not.toBe("[]");
    expect(segments.slice(2).every((segment) => segment === "[]")).toBe(true);
  });

  it("derives exact exclusion cardinality and memory bounds from global routing", () => {
    const { root } = nested(1);
    const roots = Array.from(
      { length: DISCOVERY_EXCLUDE_ROOTS_MAX },
      (_, index) => `/repo/routing-${index.toString().padStart(4, "0")}`,
    );

    expect(validateDiscoveryExcludeRoots(root, roots.slice(0, 1_025))).toHaveLength(1_025);
    expect(validateDiscoveryExcludeRoots(root, roots)).toHaveLength(8_192);
    expect(() =>
      validateDiscoveryExcludeRoots(root, [...roots, "/repo/routing-first-excess"]),
    ).toThrow(/8192 effective excluded roots/);
    expect(
      validateDiscoveryExcludeRoots(
        root,
        Array.from({ length: DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX }, () => "/repo/parent"),
      ),
    ).toEqual(["/repo/parent"]);

    expect(DISCOVERY_EXCLUDE_ROOTS_MAX).toBe(8_192);
    expect(DISCOVERY_EXCLUDE_ROOT_INPUTS_MAX).toBe(8_193);
    expect(DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES).toBe(6 * 1024 * 1024);
    expect(DISCOVERY_EXCLUDE_ROOTS_JSON_MAX_BYTES).toBe(
      DISCOVERY_EXCLUDE_ROOTS_UTF8_MAX_BYTES * 6 +
        DISCOVERY_EXCLUDE_ROOTS_MAX * 3 +
        2 +
        DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS -
        1,
    );
    expect(DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES).toBe(1_500_000);
    expect(DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENTS).toBe(26);
    expect(DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS).toBe(32);
    expect(DISCOVERY_EXCLUDE_ROOTS_JSON_SEGMENT_MAX_BYTES).toBeLessThan(2_000_000);
    expect(DISCOVERY_EXCLUDE_ROOTS_SQL_BINDINGS).toBeLessThan(100);
    expect(DISCOVERY_EXCLUDE_ROOTS_RETAINED_MAX_BYTES).toBeLessThan(100 * 1024 * 1024);

    const exactBytes = Array.from({ length: 1_536 }, (_, index) => {
      const prefix = `/repo/long-${index.toString().padStart(4, "0")}-`;
      return `${prefix}${"x".repeat(4_096 - prefix.length)}`;
    });
    expect(validateDiscoveryExcludeRoots(root, exactBytes)).toHaveLength(1_536);
    expect(() =>
      validateDiscoveryExcludeRoots(root, [...exactBytes, "/repo/utf8-first-excess"]),
    ).toThrow(/6291456 UTF-8 bytes/);
  });

  it("materializes the bounded candidate page before touching chunks", () => {
    const { db, root } = nested(100);
    const recorder = new RecordingDatabase(db);

    discoverFiles(recorder, root, "*/.gitignore", { limit: 10 });

    const plan = planOf(db, recorder);
    expect(plan).toContain("MATERIALIZE candidates");
    expect(plan).toContain("SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)");
    expect(plan).toContain("SCAN candidates");
    expect(plan).toContain("SEARCH fs_chunks USING INDEX");
    const candidateScan = plan.indexOf("SCAN candidates");
    expect(plan.indexOf("MATERIALIZE candidates")).toBeLessThan(candidateScan);
    const tempOrder = plan.indexOf("USE TEMP B-TREE FOR ORDER BY");
    if (tempOrder >= 0) expect(tempOrder).toBeGreaterThan(candidateScan);

    const chunkRootPages = new Set(
      db
        .all<{ rootpage: number }>(
          "SELECT rootpage FROM sqlite_schema WHERE tbl_name = 'fs_chunks' AND rootpage > 0",
        )
        .map((row) => row.rootpage),
    );
    const bytecode = bytecodeOf(db, recorder);
    const pageLimit = bytecode.find((row) => row.opcode === "DecrJumpZero");
    const chunkOpens = bytecode.filter(
      (row) => row.opcode === "OpenRead" && chunkRootPages.has(row.p2),
    );
    expect(pageLimit).toBeDefined();
    expect(chunkOpens.length).toBeGreaterThan(0);
    for (const open of chunkOpens) expect(open.addr).toBeGreaterThan(pageLimit?.addr ?? -1);
  });

  it("keeps candidate and chunk work page-shaped at 10,000 and 100,000 matches", () => {
    const db = open();
    db.run(
      `INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
       VALUES (2, 'dir', 493, ?, 0, 1, 1)`,
      MTIME_BASE,
    );
    db.run("INSERT INTO fs_paths (path, parent, inode) VALUES ('/repo', '/', 2)");

    const append = (from: number, to: number): void => {
      db.run(
        `WITH RECURSIVE seq(i) AS (
           VALUES (?) UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?
         )
         INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
         SELECT i + 3, 'file', 420, ?, 0, 1, 1 FROM seq`,
        from,
        to,
        MTIME_BASE,
      );
      db.run(
        `WITH RECURSIVE seq(i) AS (
           VALUES (?) UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?
         )
         INSERT INTO fs_paths (path, parent, inode)
         SELECT printf('/repo/d%06d/.gitignore', i), printf('/repo/d%06d', i), i + 3 FROM seq`,
        from,
        to,
      );
    };

    const root = realpath(db, "/repo");
    let previous = 0;
    for (const count of [10_000, 100_000]) {
      append(previous, count);
      previous = count;
      const anchor = discoverFiles(db, root, "*/.gitignore", { limit: 1 }).handles[0];
      if (anchor === undefined) throw new Error("scaling fixture anchor missing");
      const recorder = new RecordingDatabase(db);

      const page = discoverFiles(recorder, root, "*/.gitignore", {
        after: anchor.path,
        limit: 10,
      });

      expect(page.handles).toHaveLength(10);
      expect(page.next).not.toBeNull();
      expect(recorder.queries).toHaveLength(1);
      expect(recorder.maxResultRows).toBe(11);
      expect(recorder.maxResultBytes).toBe(0);
      const plan = planOf(db, recorder);
      expect(plan).toContain("MATERIALIZE candidates");
      expect(plan).toContain("SEARCH fs_paths USING PRIMARY KEY (path>? AND path<?)");
      expect(plan.indexOf("USE TEMP B-TREE FOR ORDER BY")).toBeGreaterThan(
        plan.indexOf("SCAN candidates"),
      );
    }
  });

  it("pages by canonical path with bounded rows and exact termination", () => {
    const db = open();
    const entries = [];
    for (let index = 0; index < 1002; index++) {
      entries.push({
        path: `/repo/d${String(index).padStart(4, "0")}/.gitignore`,
        bytes: new Uint8Array([index & 0xff]),
      });
    }
    writeFiles(db, entries);
    const root = realpath(db, "/repo");
    const recorder = new RecordingDatabase(db);

    const first = discoverFiles(recorder, root, "*/.gitignore");
    if (first.next === null) throw new Error("first page did not return a cursor");
    const second = discoverFiles(recorder, root, "*/.gitignore", { after: first.next });

    expect(first.handles).toHaveLength(1000);
    expect(second.handles).toHaveLength(2);
    expect(second.next).toBeNull();
    expect([...first.handles, ...second.handles].map((handle) => handle.path)).toEqual(
      entries.map((entry) => entry.path),
    );
    expect(recorder.queries).toHaveLength(2);
    expect(recorder.maxResultRows).toBe(1001);
    expect(recorder.maxResultBytes).toBe(0);
    expect(recorder.maxBindingBytes).toBeLessThan(20_000);
  });

  it("enforces the bounded page limit", () => {
    const { db, root } = nested(1);
    expect(() => discoverFiles(db, root, "*/.gitignore", { limit: 0 })).toThrow(/1 to 1000/);
    expect(() => discoverFiles(db, root, "*/.gitignore", { limit: 1001 })).toThrow(/1 to 1000/);
  });

  it("rejects corrupt content without returning BLOB payloads", () => {
    const { db, root } = nested(1);
    const inode = db.scalar<number>(
      "SELECT inode FROM fs_paths WHERE path = '/repo/d0/.gitignore'",
    );
    db.run("DELETE FROM fs_chunks WHERE inode = ? AND idx = 0", inode ?? -1);

    expect(() => discoverFiles(db, root, "*/.gitignore")).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });

  it.each([
    ["non-BLOB chunk", "UPDATE fs_chunks SET bytes = 'text' WHERE inode = ? AND idx = 0"],
    ["non-integer index", "UPDATE fs_chunks SET idx = 0.5 WHERE inode = ? AND idx = 0"],
  ])("rejects a %s", (_name, sql) => {
    const { db, root } = nested(1);
    const inode = db.scalar<number>(
      "SELECT inode FROM fs_paths WHERE path = '/repo/d0/.gitignore'",
    );
    db.run(sql, inode ?? -1);

    expect(() => discoverFiles(db, root, "*/.gitignore")).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });

  it("rejects compensating short and oversized chunks", () => {
    const db = open();
    writeFiles(db, [{ path: "/repo/.gitignore", bytes: new Uint8Array(CHUNK_SIZE + 10).fill(7) }]);
    const root = realpath(db, "/repo");
    const inode = db.scalar<number>("SELECT inode FROM fs_paths WHERE path = '/repo/.gitignore'");
    db.run(
      `UPDATE fs_chunks SET bytes = zeroblob(${CHUNK_SIZE - 1}) WHERE inode = ? AND idx = 0`,
      inode ?? -1,
    );
    db.run("UPDATE fs_chunks SET bytes = zeroblob(11) WHERE inode = ? AND idx = 1", inode ?? -1);

    expect(() => discoverFiles(db, root, "*/.gitignore")).toThrowError(
      expect.objectContaining({ code: "EIO" }),
    );
  });
});
