import { describe, expect, it } from "vitest";
import { readBlob, type SqlDatabase } from "../../src/db/db.js";
import { hasErrorCode } from "../../src/fs/errors.js";
import { initializeFsSchema } from "../../src/fs/schema.js";
import {
  createInitialWorktreeWriter,
  type InitialWorktreeSession,
} from "../../src/fs/store/initial-write.js";
import { writeFiles } from "../../src/fs/store/write.js";
import { TestDatabase } from "../helpers/db.js";

interface EntryRow {
  path: string;
  parent: string;
  inode: number;
  type: string;
  mode: number;
  mtime: number;
  size: number;
  rev: number;
  target: string | null;
  content_id: unknown;
}

const ENTRY_SQL = `
SELECT path.path, path.parent, path.inode, node.type, node.mode, node.mtime,
       node.size, node.rev, node.link_target AS target, node.content_id
  FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode`;

function setup(): TestDatabase {
  const db = new TestDatabase();
  initializeFsSchema(db, () => 100);
  return db;
}

function generatedChunks(size: number, chunkSize = 128 * 1024): Iterable<Uint8Array> {
  return {
    *[Symbol.iterator](): Iterator<Uint8Array> {
      const chunk = new Uint8Array(chunkSize).fill(0x5a);
      let remaining = size;
      while (remaining > 0) {
        const length = Math.min(chunk.length, remaining);
        yield chunk.subarray(0, length);
        remaining -= length;
      }
    },
  };
}

function requiredSession(session: InitialWorktreeSession | undefined): InitialWorktreeSession {
  if (session === undefined) throw new Error("test did not capture the initial worktree session");
  return session;
}

function entryAt(db: SqlDatabase, path: string): EntryRow | undefined {
  return db.one<EntryRow>(`${ENTRY_SQL} WHERE path.path = ?`, path);
}

function bytesAt(db: SqlDatabase, path: string): Uint8Array {
  const rows = db.all<{ bytes: unknown }>(
    `SELECT chunk.bytes
       FROM fs_paths path JOIN fs_chunks chunk ON chunk.inode = path.inode
      WHERE path.path = ? ORDER BY chunk.idx`,
    path,
  );
  const size = rows.reduce((sum, row) => sum + readBlob(row.bytes).length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const row of rows) {
    const chunk = readBlob(row.bytes);
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function relativeSnapshot(db: SqlDatabase, root: string): object[] {
  return db
    .all<EntryRow>(
      `${ENTRY_SQL} WHERE path.path >= ? AND path.path < ? ORDER BY path.path`,
      `${root}/`,
      `${root}0`,
    )
    .map((row) => ({
      path: row.path.slice(root.length + 1),
      parent: row.parent === root ? "" : row.parent.slice(root.length + 1),
      type: row.type,
      mode: row.mode,
      mtime: row.mtime,
      size: row.size,
      target: row.target,
      contentId: row.content_id === null ? null : [...readBlob(row.content_id)],
      bytes: row.type === "file" ? [...bytesAt(db, row.path)] : [],
    }));
}

class RecordingDatabase implements SqlDatabase {
  widestBlob = 0;
  widestString = 0;
  contentWrites = 0;

  constructor(
    private readonly inner: SqlDatabase,
    private readonly failContentAt: number | null = null,
  ) {}

  #record(bindings: unknown[]): void {
    for (const binding of bindings) {
      if (binding instanceof Uint8Array) {
        this.widestBlob = Math.max(this.widestBlob, binding.length);
      } else if (typeof binding === "string") {
        this.widestString = Math.max(this.widestString, new TextEncoder().encode(binding).length);
      }
    }
  }

  run(query: string, ...bindings: unknown[]): void {
    this.#record(bindings);
    if (query.includes("INSERT INTO fs_chunks")) {
      this.contentWrites++;
      if (this.contentWrites === this.failContentAt) throw new Error("injected content failure");
    }
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    this.#record(bindings);
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    this.#record(bindings);
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    this.#record(bindings);
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.#record(bindings);
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function writeFixture(db: SqlDatabase, root: string): void {
  const result = createInitialWorktreeWriter(db, () => 500).tryRun(root, (session) => {
    session.writeFile("bin/run", new Uint8Array([1, 2]), {
      mode: 0o100755,
      contentId: new Uint8Array([9, 8, 7]),
    });
    session.writeFile("deep/a/file.txt", new Uint8Array([3, 4, 5]));
    session.writeSymlink("link", "deep/a/file.txt");
    session.writeFile("readme.md", new Uint8Array([6]), { mode: 0o100640 });
    return "done";
  });
  expect(result).toEqual({ kind: "committed", value: "done" });
}

describe("InitialWorktreeWriter", () => {
  it("produces the same deep tree for an absent and an existing empty root", () => {
    const absent = setup();
    writeFiles(absent, [{ path: "/repo-file", bytes: new Uint8Array([0]) }], {}, () => 200);
    writeFixture(absent, "/repo");

    const existing = setup();
    writeFiles(existing, [{ path: "/repo" }], {}, () => 300);
    writeFixture(existing, "/repo");

    expect(relativeSnapshot(absent, "/repo")).toEqual(relativeSnapshot(existing, "/repo"));
    expect(entryAt(absent, "/repo")?.type).toBe("dir");
    expect(entryAt(absent, "/repo/bin/run")?.mode).toBe(0o755);
    expect(entryAt(absent, "/repo/link")?.mode).toBe(0o777);
  });

  it("owns content ids and accepts the former 1 MiB first excess", () => {
    const accepted = setup();
    const contentId = new Uint8Array([1, 2, 3, 4]);
    expect(
      createInitialWorktreeWriter(accepted).tryRun("/repo", (session) => {
        session.writeSymlink("link", "target", { contentId });
        contentId.fill(9);
      }),
    ).toEqual({ kind: "committed", value: undefined });
    const stored = entryAt(accepted, "/repo/link")?.content_id;
    expect(stored === null || stored === undefined ? stored : [...readBlob(stored)]).toEqual([
      1, 2, 3, 4,
    ]);
    const formerExcess = setup();
    const largeContentId = new Uint8Array(1024 * 1024 + 1).fill(0x5a);
    expect(
      createInitialWorktreeWriter(formerExcess).tryRun("/repo", (session) => {
        session.writeSymlink("link", "target", {
          contentId: largeContentId,
        });
      }),
    ).toEqual({ kind: "committed", value: undefined });
    const largeStored = entryAt(formerExcess, "/repo/link")?.content_id;
    expect(
      largeStored === null || largeStored === undefined ? largeStored : readBlob(largeStored),
    ).toEqual(largeContentId);
  });

  it("writes former size/path excesses and a symlink above the JSON page target", () => {
    const db = setup();
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(0x33);
    const longPath = "p".repeat(4_097);
    const target = "t".repeat(1_500_001);

    expect(
      createInitialWorktreeWriter(db).tryRun("/repo", (session) => {
        session.writeFile("large.bin", bytes);
        session.writeFile(longPath, new Uint8Array([7]));
        session.writeSymlink("zz-link", target);
      }),
    ).toEqual({ kind: "committed", value: undefined });

    expect(bytesAt(db, "/repo/large.bin")).toEqual(bytes);
    expect(bytesAt(db, `/repo/${longPath}`)).toEqual(new Uint8Array([7]));
    expect(entryAt(db, "/repo/zz-link")).toMatchObject({ size: target.length, target });
  });

  it("bumps revision once and commits one contiguous inode range", () => {
    const db = setup();
    const result = createInitialWorktreeWriter(db, () => 700).tryRun("/repo", (session) => {
      session.writeFile("a/b/c.txt", new Uint8Array([1]));
      session.writeFile("z.txt", new Uint8Array([2]));
      return 42;
    });

    expect(result).toEqual({ kind: "committed", value: 42 });
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(1);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(7);
    expect(
      db.all<{ inode: number }>("SELECT inode FROM fs_nodes WHERE inode > 1 ORDER BY inode"),
    ).toEqual([{ inode: 2 }, { inode: 3 }, { inode: 4 }, { inode: 5 }, { inode: 6 }]);
    expect(
      db.all<{ rev: number }>("SELECT DISTINCT rev FROM fs_nodes WHERE inode > 1 ORDER BY rev"),
    ).toEqual([{ rev: 1 }]);
  });

  it("leaves an absent root and both meta counters untouched for an empty body", () => {
    const db = setup();
    const result = createInitialWorktreeWriter(db, () => 800).tryRun("/repo", () => "empty");
    expect(result).toEqual({ kind: "committed", value: "empty" });
    expect(entryAt(db, "/repo")).toBeUndefined();
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(2);
  });

  it("treats the seeded root as an eligible empty worktree", () => {
    const db = setup();
    expect(
      createInitialWorktreeWriter(db, () => 850).tryRun("/", (session) => {
        session.writeFile("root.txt", new Uint8Array([1]));
      }),
    ).toEqual({ kind: "committed", value: undefined });
    expect(entryAt(db, "/root.txt")).toMatchObject({ type: "file", rev: 1 });
  });

  it("streams a file larger than 3 MiB with bounded bindings and exact chunks", () => {
    const inner = setup();
    const db = new RecordingDatabase(inner);
    const size = 3 * 1024 * 1024 + 123;

    createInitialWorktreeWriter(db, () => 900).tryRun("/repo", (session) => {
      session.writeFileStream("large.bin", size, generatedChunks(size, 73_001), {
        mode: 0o100600,
        contentId: new Uint8Array([1, 2, 3, 4]),
      });
    });

    expect(entryAt(inner, "/repo/large.bin")).toMatchObject({ size, mode: 0o600, rev: 1 });
    expect(
      inner.all<{ idx: number; size: number }>(
        `SELECT chunk.idx, length(chunk.bytes) AS size
           FROM fs_paths path JOIN fs_chunks chunk ON chunk.inode = path.inode
          WHERE path.path = '/repo/large.bin' ORDER BY chunk.idx`,
      ),
    ).toEqual([
      { idx: 0, size: 512 * 1024 },
      { idx: 1, size: 512 * 1024 },
      { idx: 2, size: 512 * 1024 },
      { idx: 3, size: 512 * 1024 },
      { idx: 4, size: 512 * 1024 },
      { idx: 5, size: 512 * 1024 },
      { idx: 6, size: 123 },
    ]);
    expect(db.contentWrites).toBe(4);
    expect(db.widestBlob).toBe(1024 * 1024);
    expect(db.widestString).toBeLessThanOrEqual(1_500_000);
  });

  it.each([
    { name: "short", size: 3, chunks: [new Uint8Array([1, 2])] },
    { name: "long", size: 2, chunks: [new Uint8Array([1, 2, 3])] },
  ])("rolls back a $name declared-size stream", ({ size, chunks }) => {
    const db = setup();
    expect(() =>
      createInitialWorktreeWriter(db).tryRun("/repo", (session) => {
        session.writeFileStream("bad.bin", size, chunks);
      }),
    ).toThrow(/declared|shorter/);
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM fs_nodes")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM fs_chunks")).toBe(0);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(2);
  });

  it.each([
    {
      name: "backward",
      write(session: InitialWorktreeSession) {
        session.writeFile("b", new Uint8Array([1]));
        session.writeFile("a", new Uint8Array([2]));
      },
    },
    {
      name: "duplicate",
      write(session: InitialWorktreeSession) {
        session.writeFile("a", new Uint8Array([1]));
        session.writeFile("a", new Uint8Array([2]));
      },
    },
    {
      name: "escape",
      write(session: InitialWorktreeSession) {
        session.writeFile("a", new Uint8Array([1]));
        session.writeFile("../outside", new Uint8Array([2]));
      },
    },
  ])("rolls back a $name input error", ({ write }) => {
    const db = setup();
    expect(() =>
      createInitialWorktreeWriter(db).tryRun("/repo", (session) => write(session)),
    ).toThrow();
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM fs_nodes")).toBe(1);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(2);
  });

  it("returns unavailable for non-empty, symlink and symlink-ancestor roots", () => {
    const nonempty = setup();
    writeFiles(nonempty, [{ path: "/repo/file", bytes: new Uint8Array([1]) }]);
    let called = false;
    expect(
      createInitialWorktreeWriter(nonempty).tryRun("/repo", () => {
        called = true;
      }),
    ).toEqual({ kind: "unavailable" });
    expect(called).toBe(false);

    const symlink = setup();
    writeFiles(symlink, [{ path: "/repo", target: "/target" }]);
    expect(createInitialWorktreeWriter(symlink).tryRun("/repo", () => {})).toEqual({
      kind: "unavailable",
    });

    const ancestor = setup();
    writeFiles(ancestor, [{ path: "/mount", target: "/target" }]);
    expect(createInitialWorktreeWriter(ancestor).tryRun("/mount/repo", () => {})).toEqual({
      kind: "unavailable",
    });
  });

  it("rolls back rows and counters after an injected mid-flush failure", () => {
    const inner = setup();
    const db = new RecordingDatabase(inner, 2);
    const size = 3 * 1024 * 1024;
    expect(() =>
      createInitialWorktreeWriter(db).tryRun("/repo", (session) => {
        session.writeFileStream("large", size, generatedChunks(size));
      }),
    ).toThrow(/injected content failure/);
    expect(inner.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
    expect(inner.scalar<number>("SELECT count(*) FROM fs_nodes")).toBe(1);
    expect(inner.scalar<number>("SELECT count(*) FROM fs_chunks")).toBe(0);
    expect(inner.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
    expect(inner.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(2);
  });

  it("invalidates a captured session after a thrown or asynchronous body", () => {
    for (const asyncBody of [false, true]) {
      const db = setup();
      let captured: InitialWorktreeSession | undefined;
      if (asyncBody) {
        expect(() =>
          createInitialWorktreeWriter(db).tryRun("/repo", async (session) => {
            captured = session;
            session.writeFile("before", new Uint8Array([1]));
          }),
        ).toThrow(/synchronous/);
      } else {
        expect(() =>
          createInitialWorktreeWriter(db).tryRun("/repo", (session) => {
            captured = session;
            session.writeFile("before", new Uint8Array([1]));
            throw new Error("body failed");
          }),
        ).toThrow(/body failed/);
      }
      const session = requiredSession(captured);
      expect(() => session.writeFile("later", new Uint8Array(1024 * 1024))).toThrow(/closed/);
      expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
      expect(db.scalar<number>("SELECT count(*) FROM fs_nodes")).toBe(1);
      expect(db.scalar<number>("SELECT count(*) FROM fs_chunks")).toBe(0);
      expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
      expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(2);
    }
  });

  it("runs afterClose inside the transaction after closing the session", () => {
    const db = setup();
    let captured: InitialWorktreeSession | undefined;
    let observedValue: number | undefined;
    let observedRows: number | undefined;
    const result = createInitialWorktreeWriter(db).tryRun(
      "/repo",
      (session) => {
        captured = session;
        session.writeFile("file.txt", new Uint8Array([1]));
        return 42;
      },
      (value) => {
        observedValue = value;
        observedRows = db.scalar<number>("SELECT count(*) FROM fs_paths");
        expect(() => requiredSession(captured).writeFile("late.txt", new Uint8Array([2]))).toThrow(
          /closed/,
        );
      },
    );

    expect(result).toEqual({ kind: "committed", value: 42 });
    expect(observedValue).toBe(42);
    expect(observedRows).toBe(3);
  });

  it.each([
    {
      name: "throwing",
      afterClose() {
        throw new Error("afterClose failed");
      },
      message: /afterClose failed/,
    },
    {
      name: "asynchronous",
      async afterClose() {},
      message: /afterClose must be synchronous/,
    },
  ])("rolls back and invalidates after a $name afterClose", ({ afterClose, message }) => {
    const db = setup();
    let captured: InitialWorktreeSession | undefined;
    expect(() =>
      createInitialWorktreeWriter(db).tryRun(
        "/repo",
        (session) => {
          captured = session;
          session.writeFile("file.txt", new Uint8Array([1]));
        },
        afterClose,
      ),
    ).toThrow(message);
    expect(() => requiredSession(captured).writeFile("late.txt", new Uint8Array([2]))).toThrow(
      /closed/,
    );
    expect(db.scalar<number>("SELECT count(*) FROM fs_paths")).toBe(1);
    expect(db.scalar<number>("SELECT count(*) FROM fs_nodes")).toBe(1);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(0);
    expect(db.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(2);
  });

  it("admits exactly 128 combined root/path segments and rejects the next one", () => {
    const root = `/${Array.from({ length: 64 }, (_, index) => `r${index}`).join("/")}`;
    const acceptedPath = Array.from({ length: 64 }, (_, index) => `a${index}`).join("/");
    const accepted = setup();
    writeFiles(accepted, [{ path: root }]);
    expect(
      createInitialWorktreeWriter(accepted).tryRun(root, (session) => {
        session.writeFile(acceptedPath, new Uint8Array([1]));
      }),
    ).toEqual({ kind: "committed", value: undefined });

    const rejected = setup();
    writeFiles(rejected, [{ path: root }]);
    const revision = rejected.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'");
    const nextInode = rejected.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'");
    let thrown: unknown;
    try {
      createInitialWorktreeWriter(rejected).tryRun(root, (session) => {
        session.writeFile(`${acceptedPath}/extra`, new Uint8Array([1]));
      });
    } catch (error) {
      thrown = error;
    }
    expect(hasErrorCode(thrown, "E2BIG")).toBe(true);
    expect(
      rejected.scalar<number>(
        "SELECT count(*) FROM fs_paths WHERE path >= ? AND path < ?",
        `${root}/`,
        `${root}0`,
      ),
    ).toBe(0);
    expect(rejected.scalar<number>("SELECT v FROM fs_meta WHERE k = 'rev'")).toBe(revision);
    expect(rejected.scalar<number>("SELECT v FROM fs_meta WHERE k = 'next_inode'")).toBe(nextInode);
  });

  it("keeps metadata and content bindings bounded across thousands of files", () => {
    const inner = setup();
    const db = new RecordingDatabase(inner);
    createInitialWorktreeWriter(db, () => 1_000).tryRun("/repo", (session) => {
      for (let index = 0; index < 8_000; index++) {
        const suffix = String(index).padStart(5, "0");
        session.writeFile(`d${suffix.slice(0, 2)}/f${suffix}`, new Uint8Array([index & 0xff]));
      }
    });
    expect(
      inner.scalar<number>(
        "SELECT count(*) FROM fs_paths WHERE path >= '/repo/' AND path < '/repo0'",
      ),
    ).toBe(8_008);
    expect(db.widestBlob).toBeLessThanOrEqual(1024 * 1024);
    expect(db.widestString).toBeLessThanOrEqual(1_500_000);
  });

  it("uses stable filesystem errors for malformed paths", () => {
    const db = setup();
    let thrown: unknown;
    try {
      createInitialWorktreeWriter(db).tryRun("/repo", (session) =>
        session.writeFile("../escape", new Uint8Array()),
      );
    } catch (error) {
      thrown = error;
    }
    expect(hasErrorCode(thrown, "EINVAL")).toBe(true);
  });
});
