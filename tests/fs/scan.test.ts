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
import { initializeFsSchema } from "../../src/fs/schema.js";
import { allocateInodes } from "../../src/fs/store/meta.js";
import { realpath } from "../../src/fs/store/resolve.js";
import { glob, scan } from "../../src/fs/store/scan.js";
import {
  type EntryType,
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

  constructor(private readonly inner: SqlDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    this.queries.push({ query, bindings });
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.queries.push({ query, bindings });
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.queries.push({ query, bindings });
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.queries.push({ query, bindings });
    return this.inner.scalar<T>(query, ...bindings);
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
      ...pathsOf(scanAll(BIG.db, BIG.root, 1000, { after: subtreeSuccessor(skipped) })),
    ];

    expect(pruned).toHaveLength(BIG_ROWS - FILES_PER_DIR);
    expect(pruned).toEqual(full.filter((path) => !path.startsWith(`${skipped}/`)));
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
