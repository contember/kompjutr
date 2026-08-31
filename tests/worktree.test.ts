import { describe, expect, it } from "vitest";

import { fromHex } from "../src/core/bytes.js";
import { hashObject } from "../src/core/objects.js";
import { matchesPaths } from "../src/core/ops/checkout.js";
import { initRepository } from "../src/core/ops/init.js";
import {
  compilePathspecs,
  dirtyPaths,
  hashWorktreePaths,
  hashWorktreePathsOwned,
  MAX_COMPILED_PATHS,
  WORKTREE_SCAN_PAGE,
  type WorktreePath,
  walkWorktree,
  walkWorktreeEntriesStream,
  walkWorktreeEntriesStreamOwned,
  walkWorktreeStream,
} from "../src/core/ops/worktree-io.js";
import { comparePaths } from "../src/core/streams.js";
import type { Worktree } from "../src/core/worktree.js";
import type { ScanEntry, ScanOptions } from "../src/fs/types.js";
import { makeRepo, makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

/**
 * Ranged working-tree I/O, against a real Computer Workspace over
 * node:sqlite. DOFS stores files in 512 KiB chunks, so anything past
 * 512 KiB exercises the multi-chunk paths on both sides.
 */
const CHUNK = 512 * 1024;

/** Deterministic bytes, so a mismatch names the offset that drifted. */
function pattern(length: number, seed = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 7 + seed) % 251;
  return out;
}

/** Deterministic high-entropy bytes that do not collapse into a tiny zlib row. */
function incompressible(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state >>> 24;
  }
  return out;
}

function makeWorktree(): TestWorkspace["worktree"] {
  return makeWorkspace().worktree;
}

function mutateAfterFirstScan(inner: Worktree, mutate: () => void): Worktree {
  let armed = true;
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "scan") {
        return (root: string, options: ScanOptions): ScanEntry[] => {
          const entries = target.scan(root, options);
          if (armed) {
            armed = false;
            mutate();
          }
          return entries;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countScalarReads(inner: Worktree): {
  worktree: Worktree;
  counts: { stats: number; readdirs: number; reads: number };
} {
  const counts = { stats: 0, readdirs: 0, reads: 0 };
  const worktree = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "stat") {
        return (path: string): ReturnType<Worktree["stat"]> => {
          counts.stats++;
          return target.stat(path);
        };
      }
      if (property === "readdir") {
        return (path: string): ReturnType<Worktree["readdir"]> => {
          counts.readdirs++;
          return target.readdir(path);
        };
      }
      if (property === "readFile") {
        return (path: string): Uint8Array => {
          counts.reads++;
          return target.readFile(path);
        };
      }
      if (property === "readlink") {
        return (path: string): string => {
          counts.reads++;
          return target.readlink(path);
        };
      }
      if (property === "readRange") {
        return (path: string, offset: number, length: number): Uint8Array => {
          counts.reads++;
          return target.readRange(path, offset, length);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { worktree, counts };
}

function scanStat(entry: ScanEntry): WorktreePath["stat"] {
  return {
    type: entry.type,
    mode: entry.mode,
    size: entry.size,
    mtime: entry.mtime,
    ino: entry.ino,
    nlink: entry.nlink,
    rev: entry.rev,
    target: entry.target,
    contentId: entry.contentId,
  };
}

describe("worktree ranged I/O", () => {
  it("builds a multi-chunk file out of createFile and writeRange alone", () => {
    const worktree = makeWorktree();
    const size = CHUNK + 200_000;
    const expected = pattern(size);

    worktree.createFile("/deep/nested/big.bin", 0o644);
    const step = 64 * 1024;
    for (let offset = 0; offset < size; offset += step) {
      worktree.writeRange("/deep/nested/big.bin", expected.subarray(offset, offset + step), offset);
    }

    const read = worktree.readFile("/deep/nested/big.bin");
    expect(read.byteLength).toBe(size);
    expect(Buffer.from(read).equals(Buffer.from(expected))).toBe(true);
    expect(worktree.stat("/deep/nested/big.bin")?.size).toBe(size);
  });

  it("reads a multi-chunk file back through readRange in pieces", () => {
    const worktree = makeWorktree();
    const size = CHUNK + 200_000;
    const expected = pattern(size, 3);
    worktree.writeFile("/big.bin", expected, { mode: 0o644 });

    const collected = new Uint8Array(size);
    let filled = 0;
    // A step that divides neither the chunk size nor the total, so every
    // read but the last straddles a boundary somewhere.
    const step = 30_000;
    while (true) {
      const piece = worktree.readRange("/big.bin", filled, step);
      if (piece.byteLength === 0) break;
      collected.set(piece, filled);
      filled += piece.byteLength;
    }
    expect(filled).toBe(size);
    expect(Buffer.from(collected).equals(Buffer.from(expected))).toBe(true);
  });

  it("returns a short read at EOF and nothing past it", () => {
    const worktree = makeWorktree();
    worktree.writeFile("/r.txt", new TextEncoder().encode("0123456789"), { mode: 0o644 });

    expect(Buffer.from(worktree.readRange("/r.txt", 0, 4)).toString()).toBe("0123");
    // Crossing EOF: short, not padded, not an error.
    expect(Buffer.from(worktree.readRange("/r.txt", 8, 100)).toString()).toBe("89");
    expect(worktree.readRange("/r.txt", 10, 4).byteLength).toBe(0);
    expect(worktree.readRange("/r.txt", 999, 4).byteLength).toBe(0);
    expect(worktree.readRange("/r.txt", 2, 0).byteLength).toBe(0);
  });

  it("interoperates with the whole-file paths in both directions", () => {
    const worktree = makeWorktree();
    const body = pattern(CHUNK + 4096, 11);

    // writeFile out, readRange in.
    worktree.writeFile("/a.bin", body, { mode: 0o644 });
    expect(
      Buffer.from(worktree.readRange("/a.bin", 0, body.byteLength)).equals(Buffer.from(body)),
    ).toBe(true);
    expect(Buffer.from(worktree.readRange("/a.bin", CHUNK - 3, 6))).toEqual(
      Buffer.from(body.subarray(CHUNK - 3, CHUNK + 3)),
    );

    // createFile + writeRange out, readFile in.
    worktree.createFile("/b.bin", 0o644);
    worktree.writeRange("/b.bin", body, 0);
    expect(Buffer.from(worktree.readFile("/b.bin")).equals(Buffer.from(body))).toBe(true);

    // And the two files are byte-identical to each other.
    expect(
      Buffer.from(worktree.readFile("/a.bin")).equals(Buffer.from(worktree.readFile("/b.bin"))),
    ).toBe(true);
  });

  it("keeps the mode createFile was given across writeRange", () => {
    const worktree = makeWorktree();

    worktree.createFile("/exec.sh", 0o755);
    worktree.writeRange("/exec.sh", new TextEncoder().encode("#!/bin/sh\n"), 0);
    const executable = worktree.stat("/exec.sh");
    expect(executable?.type).toBe("file");
    expect(executable?.mode).toBe(0o100755);
    expect((executable?.mode ?? 0) & 0o111).not.toBe(0);

    worktree.createFile("/plain.txt", 0o644);
    worktree.writeRange("/plain.txt", new TextEncoder().encode("hi\n"), 0);
    expect(worktree.stat("/plain.txt")?.mode).toBe(0o100644);
  });

  it("truncates an existing file and re-modes it, like writeFile does", () => {
    const worktree = makeWorktree();
    worktree.writeFile("/f.txt", new TextEncoder().encode("the previous contents"), {
      mode: 0o644,
    });

    worktree.createFile("/f.txt", 0o755);
    expect(worktree.stat("/f.txt")?.size).toBe(0);
    expect(worktree.stat("/f.txt")?.mode).toBe(0o100755);

    worktree.writeRange("/f.txt", new TextEncoder().encode("new"), 0);
    expect(Buffer.from(worktree.readFile("/f.txt")).toString()).toBe("new");
  });

  it("creates the parent directories a nested path needs", () => {
    const worktree = makeWorktree();
    worktree.createFile("/x/y/z/file.txt", 0o644);
    expect(worktree.stat("/x/y")?.type).toBe("dir");
    worktree.writeRange("/x/y/z/file.txt", new TextEncoder().encode("ok"), 0);
    expect(Buffer.from(worktree.readFile("/x/y/z/file.txt")).toString()).toBe("ok");
  });

  it("extends the file, zero-filling, when writeRange lands past the end", () => {
    const worktree = makeWorktree();
    worktree.createFile("/sparse.bin", 0o644);
    worktree.writeRange("/sparse.bin", new Uint8Array([1, 2]), 0);
    worktree.writeRange("/sparse.bin", new Uint8Array([9]), 6);
    expect([...worktree.readFile("/sparse.bin")]).toEqual([1, 2, 0, 0, 0, 0, 9]);
  });

  it("refuses a writeRange to a file that does not exist", () => {
    const worktree = makeWorktree();
    expect(() => worktree.writeRange("/ghost.txt", new Uint8Array([1]), 0)).toThrow(/ghost\.txt/);
  });

  it("refuses a readRange of a file that does not exist", () => {
    const worktree = makeWorktree();
    expect(() => worktree.readRange("/ghost.txt", 0, 4)).toThrow(/ghost\.txt/);
  });

  it("follows a symlink on both ranged paths, the way readFile and writeFile do", () => {
    const worktree = makeWorktree();
    worktree.writeFile("/target.txt", new TextEncoder().encode("0123456789"), { mode: 0o644 });
    worktree.symlink("/target.txt", "/link.txt");

    expect(Buffer.from(worktree.readRange("/link.txt", 0, 4)).toString()).toBe("0123");
    worktree.writeRange("/link.txt", new TextEncoder().encode("ZZ"), 0);
    expect(Buffer.from(worktree.readFile("/target.txt")).toString()).toBe("ZZ23456789");
    // The link itself is untouched: stat is still lstat.
    expect(worktree.stat("/link.txt")?.type).toBe("symlink");

    // createFile resolves the leaf directly, so it truncates the target
    // rather than replacing the link — same as writeFile.
    worktree.createFile("/link.txt", 0o644);
    expect(worktree.stat("/link.txt")?.type).toBe("symlink");
    expect(worktree.stat("/target.txt")?.size).toBe(0);
  });
});

describe("walkWorktreeStream", () => {
  it("emits full paths in UTF-8 byte order, sorting a directory as name/", () => {
    const workspace = makeWorkspace();
    const { worktree } = workspace;
    // "a.txt" must precede "a/x" — "." is 0x2E and "/" is 0x2F — which only
    // holds if the directory "a" sorts as "a/" and not as "a".
    worktree.makeDirectories(["/a", "/ab"]);
    for (const path of ["/a.txt", "/a/x", "/a/y", "/ab/z", "/b.txt"]) {
      worktree.writeFile(path, new TextEncoder().encode("x"), { mode: 0o644 });
    }
    expect([...walkWorktreeStream(worktree, "/")]).toEqual([
      "a.txt",
      "a/x",
      "a/y",
      "ab/z",
      "b.txt",
    ]);
  });

  it("agrees with the array form, which sorted afterwards", () => {
    const { worktree } = makeWorkspace();
    worktree.makeDirectories(["/deep/er"]);
    for (const path of ["/z.txt", "/deep/b.txt", "/deep/er/c.txt", "/\u{1F600}.txt", "/.txt"]) {
      worktree.writeFile(path, new TextEncoder().encode("x"), { mode: 0o644 });
    }
    const streamed = [...walkWorktreeStream(worktree, "/")];
    const entries = [...walkWorktreeEntriesStream(worktree, "/")];
    expect(streamed).toEqual([...streamed].sort(comparePaths));
    expect(entries.map((entry) => entry.path)).toEqual(streamed);
    expect(walkWorktree(worktree, "/")).toEqual(streamed);
  });

  it("can omit directory rows when the caller needs no pruning", () => {
    const workspace = makeWorkspace();
    const directories = Array.from(
      { length: 1_001 },
      (_, index) => `/d${index.toString().padStart(4, "0")}`,
    );
    workspace.worktree.makeDirectories(directories);
    workspace.worktree.writeFiles([
      ...directories.map((directory) => ({
        path: `${directory}/file.txt`,
        bytes: new Uint8Array([1]),
      })),
      { path: "/link", target: "d0000/file.txt" },
    ]);

    workspace.storage.resetCounters();
    const regular = [...walkWorktreeEntriesStream(workspace.worktree, "/")];
    const regularStatements = workspace.storage.statementCount;
    workspace.storage.resetCounters();
    const filesOnly = [...walkWorktreeEntriesStream(workspace.worktree, "/", { filesOnly: true })];

    expect(filesOnly).toEqual(regular);
    expect(filesOnly.at(-1)?.stat.type).toBe("symlink");
    // The files-only query shape must elide directory-page work.
    expect(workspace.storage.statementCount).toBeLessThan(regularStatements);
  });

  it("rejects files-only walks that require directory pruning", () => {
    const { worktree } = makeWorkspace();
    expect(() => [
      ...walkWorktreeEntriesStream(worktree, "/", {
        filesOnly: true,
        paths: ["src"],
      }),
    ]).toThrow(/cannot prune directories/);
  });

  it("excludes a nested repository without losing scan metadata", () => {
    const { worktree } = makeWorkspace();
    worktree.makeDirectories(["/nested", "/outside"]);
    worktree.writeFiles([
      { path: "/nested/hidden.txt", bytes: new Uint8Array([1]) },
      {
        path: "/outside/kept.txt",
        bytes: new Uint8Array([2]),
        contentId: fromHex("12".repeat(20)),
      },
    ]);

    const entries = [...walkWorktreeEntriesStream(worktree, "/", { excludeRoots: ["/nested"] })];
    expect(entries.map((entry) => entry.path)).toEqual(["outside/kept.txt"]);
    expect(entries[0]?.stat.contentId).toEqual(fromHex("12".repeat(20)));
  });

  it("uses the bulk scan instead of reading directories", () => {
    const { worktree } = makeWorkspace();
    for (let i = 0; i < 20; i++) {
      worktree.makeDirectories([`/d${i}`]);
      for (let j = 0; j < 10; j++) {
        worktree.writeFile(`/d${i}/f${j}.txt`, new TextEncoder().encode("x"), { mode: 0o644 });
      }
    }
    const counting = new CountingWorktree(worktree);
    const walk = walkWorktreeStream(counting, "/");
    walk.next();
    expect(counting.readdirs).toBe(0);
    expect([...walk]).toHaveLength(199);
  });

  it("preserves an exact dir0 sibling when pruning a directory", () => {
    const { worktree } = makeWorkspace();
    worktree.makeDirectories(["/cut", "/cut0"]);
    worktree.writeFiles([
      ...Array.from({ length: 1001 }, (_, index) => ({
        path: `/cut/hidden-${index.toString().padStart(4, "0")}.txt`,
        bytes: new Uint8Array([1]),
      })),
      { path: "/cut0/kept.txt", bytes: new Uint8Array([2]) },
    ]);

    expect(walkWorktree(worktree, "/", { excludeRoots: ["/cut"] })).toEqual(["cut0/kept.txt"]);
    expect(
      walkWorktree(worktree, "/", {
        ignores: { ignores: (path) => path === "cut" },
      }),
    ).toEqual(["cut0/kept.txt"]);
    expect(walkWorktree(worktree, "/", { paths: ["cut0"] })).toEqual(["cut0/kept.txt"]);
  });

  it("prunes 1,001 sibling directories within scan pages", () => {
    const workspace = makeWorkspace();
    const directories = Array.from(
      { length: 1001 },
      (_, index) => `/s${index.toString().padStart(4, "0")}`,
    );
    workspace.worktree.makeDirectories(directories);
    workspace.worktree.writeFiles(
      directories.map((directory) => ({
        path: `${directory}/file.txt`,
        bytes: new Uint8Array([1]),
      })),
    );

    workspace.storage.resetCounters();
    expect(walkWorktree(workspace.worktree, "/", { paths: ["s1000"] })).toEqual(["s1000/file.txt"]);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("keeps prefix siblings that sort before a pruned subtree", () => {
    const { worktree } = makeWorkspace();
    worktree.makeDirectories(["/cut"]);
    worktree.writeFiles([
      { path: "/cut-keep", bytes: new Uint8Array([1]) },
      { path: "/cut.txt", bytes: new Uint8Array([2]) },
      { path: "/cut/hidden", bytes: new Uint8Array([3]) },
      { path: "/cut0", bytes: new Uint8Array([4]) },
    ]);

    expect(walkWorktree(worktree, "/", { excludeRoots: ["/cut"] })).toEqual([
      "cut-keep",
      "cut.txt",
      "cut0",
    ]);
  });

  it("does not jump from a page-ending directory over prefix siblings", () => {
    const { worktree } = makeWorkspace();
    worktree.writeFiles(
      Array.from({ length: 999 }, (_, index) => ({
        path: `/a${index.toString().padStart(3, "0")}`,
        bytes: new Uint8Array([1]),
      })),
    );
    worktree.makeDirectories(["/cut"]);
    worktree.writeFiles([
      { path: "/cut-keep", bytes: new Uint8Array([2]) },
      { path: "/cut/hidden", bytes: new Uint8Array([3]) },
      { path: "/cut0", bytes: new Uint8Array([4]) },
    ]);

    const paths = walkWorktree(worktree, "/", { excludeRoots: ["/cut"] });
    expect(paths).toHaveLength(1001);
    expect(paths.slice(-2)).toEqual(["cut-keep", "cut0"]);
  });

  it("walks 9,329 files within the statement target with exact path parity", () => {
    const measure = (
      directoryCount: number,
      fileCount: number,
    ): {
      statements: number;
      entries: WorktreePath[];
      expected: WorktreePath[];
      scalarReads: { stats: number; readdirs: number; reads: number };
    } => {
      const workspace = makeWorkspace();
      const directories = Array.from(
        { length: directoryCount },
        (_, index) => `/d${index.toString().padStart(4, "0")}`,
      );
      workspace.worktree.makeDirectories(directories);

      const byte = new Uint8Array([120]);
      const contentId = fromHex("ab".repeat(20));
      workspace.worktree.writeFiles(
        Array.from({ length: fileCount }, (_, index) => {
          const directory = index % directoryCount;
          const generation = Math.floor(index / directoryCount);
          const path = `d${directory.toString().padStart(4, "0")}/f${generation
            .toString()
            .padStart(4, "0")}.txt`;
          const entry = { path: `/${path}`, bytes: byte, mode: index % 2 === 0 ? 0o644 : 0o755 };
          return index % 3 === 0 ? { ...entry, contentId } : entry;
        }),
      );

      const expected = workspace.worktree
        .scan("/", { filesOnly: true, limit: fileCount + 1 })
        .map((entry): WorktreePath => ({ path: entry.path.slice(1), stat: scanStat(entry) }));
      const counted = countScalarReads(workspace.worktree);

      workspace.storage.resetCounters();
      const entries = [...walkWorktreeEntriesStream(counted.worktree, "/")];
      return {
        statements: workspace.storage.statementCount,
        entries,
        expected,
        scalarReads: counted.counts,
      };
    };

    const small = measure(335, 933);
    const large = measure(3346, 9329);
    // One canonical-root lookup, scan setup, then one statement per page.
    expect(small.statements).toBeLessThan(1_000);
    expect(large.statements).toBeLessThan(1_000);
    expect(large.entries).toEqual(large.expected);
    expect(large.entries.map((entry) => entry.path)).toEqual(
      large.expected.map((entry) => entry.path).sort(comparePaths),
    );
    expect(large.scalarReads).toEqual({ stats: 0, readdirs: 0, reads: 0 });
  });

  it("requires scalar stats after scan metadata is stripped", () => {
    const { worktree } = makeWorkspace();
    worktree.writeFiles([
      { path: "/a.txt", bytes: new Uint8Array([1]), contentId: fromHex("34".repeat(20)) },
      { path: "/b.txt", bytes: new Uint8Array([2]) },
    ]);
    const counted = countScalarReads(worktree);
    const entries = [...walkWorktreeEntriesStream(counted.worktree, "/")];
    expect(counted.counts).toEqual({ stats: 0, readdirs: 0, reads: 0 });

    const stripped = entries.map((entry) => entry.path);
    const reconstructed = stripped.map((path) => counted.worktree.stat(`/${path}`));
    expect(counted.counts.stats).toBe(stripped.length);
    expect(reconstructed).toEqual(entries.map((entry) => entry.stat));
  });

  it("keeps repo-relative paths when the repository root is a symlink", () => {
    const workspace = makeWorkspace();
    workspace.worktree.makeDirectories(["/real"]);
    workspace.worktree.symlink("/real", "/alias");
    workspace.worktree.writeFile("/real/file.txt", new TextEncoder().encode("contents\n"));
    const repo = initRepository(workspace.context, { dir: "/alias" });
    expect(walkWorktree(workspace.worktree, repo.root)).toEqual(["file.txt"]);
  });

  it("keeps compiled scalar pathspec results identical across edge cases", () => {
    const cases: Array<{ paths: string[] | undefined; path: string; expected: boolean }> = [
      { paths: undefined, path: "anything", expected: true },
      { paths: [], path: "anything", expected: true },
      { paths: [""], path: "anything", expected: true },
      { paths: ["."], path: "anything", expected: true },
      { paths: ["./"], path: "./child", expected: true },
      { paths: ["./"], path: "child", expected: false },
      { paths: ["/"], path: "/child", expected: true },
      { paths: ["/"], path: "child", expected: false },
      { paths: ["dir///"], path: "dir", expected: false },
      { paths: ["dir///"], path: "dir/file", expected: true },
      { paths: ["same", "same"], path: "same/child", expected: true },
      { paths: ["\ue000", "\u{10000}"], path: "\u{10000}/child", expected: true },
    ];

    for (const fixture of cases) {
      expect(matchesPaths(fixture.path, fixture.paths)).toBe(fixture.expected);
      const compiled = compilePathspecs(fixture.paths);
      expect(compiled.matches(fixture.path)).toBe(fixture.expected);
    }
    const directory = compilePathspecs(["dir///"]);
    const root = compilePathspecs(["/"]);
    expect(directory.matchesEntry("dir")).toBe(true);
    expect(root.matchesEntry("anything")).toBe(true);
  });

  it("bounds compiled pathspec count but accepts values above the former byte ceiling", () => {
    compilePathspecs(Array.from({ length: MAX_COMPILED_PATHS }, () => "x"));
    expect(() =>
      compilePathspecs(Array.from({ length: MAX_COMPILED_PATHS + 1 }, () => "x")),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    const long = "x".repeat(1024 * 1024 - 3);
    const compiled = compilePathspecs([long]);
    expect(compiled.matches(long)).toBe(true);
    expect(compiled.matchesEntry(long)).toBe(true);
  });

  it("matches a compiled pathspec beyond the former byte ceiling during traversal", () => {
    const workspace = makeRepo("/");
    const directory = "x".repeat(1024 * 1024 - 16);
    workspace.worktree.makeDirectories([`/${directory}`]);
    workspace.worktree.writeFile(`/${directory}/kept`, new Uint8Array([1]));
    const paths = [`${directory}/missing`];

    expect([...walkWorktreeEntriesStreamOwned(workspace.worktree, "/", { paths })]).toEqual([]);
  });

  it("prunes later pages after observing only the current scan page", () => {
    const workspace = makeWorkspace();
    workspace.worktree.makeDirectories(["/cut", "/kept"]);
    workspace.worktree.writeFiles([
      ...Array.from({ length: 2_500 }, (_, index) => ({
        path: `/cut/${index.toString().padStart(4, "0")}.txt`,
        bytes: new Uint8Array([1]),
      })),
      { path: "/kept/file.txt", bytes: new Uint8Array([2]) },
    ]);
    let predicateCalls = 0;
    workspace.storage.resetCounters();

    const paths = walkWorktree(workspace.worktree, "/", {
      pruneDirectory: (path) => {
        predicateCalls++;
        return path === "cut";
      },
    });

    expect(paths).toEqual(["kept/file.txt"]);
    expect(predicateCalls).toBe(2);
    // The storage counter aggregates scan and scalar rows, so it cannot isolate
    // descendant rows. This bound permits one 1,000-row page plus setup/seek rows.
    expect(workspace.storage.rowCount).toBeLessThanOrEqual(1_005);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });
});

describe("batched worktree hashing", () => {
  function candidates(count: number): {
    workspace: ReturnType<typeof makeRepo>;
    paths: WorktreePath[];
  } {
    const workspace = makeRepo("/");
    const encoder = new TextEncoder();
    workspace.worktree.writeFiles(
      Array.from({ length: count }, (_, index) => ({
        path: `/f${index.toString().padStart(4, "0")}.txt`,
        bytes: encoder.encode(`contents ${index}\n`),
      })),
    );
    const paths = workspace.worktree
      .scan("/", { filesOnly: true, limit: count + 1 })
      .map((stat) => ({ path: stat.path.slice(1), stat }));
    return { workspace, paths };
  }

  it("reads and hashes a growing path set in one bounded batch", () => {
    const small = candidates(20);
    small.workspace.storage.resetCounters();
    const smallHashes = hashWorktreePaths(
      small.workspace.repo,
      small.workspace.worktree,
      small.paths,
      { write: false },
    );
    const smallStatements = small.workspace.storage.statementCount;

    const large = candidates(200);
    large.workspace.storage.resetCounters();
    const largeHashes = hashWorktreePaths(
      large.workspace.repo,
      large.workspace.worktree,
      large.paths,
      { write: false },
    );
    const largeStatements = large.workspace.storage.statementCount;

    expect(smallHashes).toHaveLength(20);
    expect(largeHashes).toHaveLength(200);
    expect(largeHashes.get("f0123.txt")?.oid).toBe(
      hashObject("blob", new TextEncoder().encode("contents 123\n")),
    );
    expect(smallStatements).toBeLessThan(1_000);
    expect(largeStatements).toBeLessThan(1_000);
  });

  it("releases a full hash-refresh page after an injected next-page failure", () => {
    const { workspace, paths } = candidates(WORKTREE_SCAN_PAGE + 1);
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = ON");
    workspace.repo.store.db.run(
      `UPDATE fs_nodes SET type = 'injected'
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = '/f1000.txt')`,
    );
    workspace.repo.store.db.run("PRAGMA ignore_check_constraints = OFF");
    const before = workspace.repo.store.objectCount();

    expect(() =>
      hashWorktreePaths(workspace.repo, workspace.worktree, paths, { write: false }),
    ).toThrow("fs_nodes.type is not a known entry type");

    expect(workspace.repo.store.objectCount()).toBe(before);
  });

  it("continues until every readFiles budget page is hashed", () => {
    const workspace = makeRepo("/");
    const bodies = Array.from({ length: 4 }, (_, index) => pattern(CHUNK - 1, index));
    workspace.worktree.writeFiles(
      bodies.map((bytes, index) => ({ path: `/large-small-${index}.bin`, bytes })),
    );
    const paths = workspace.worktree
      .scan("/", { filesOnly: true, limit: 5 })
      .map((stat) => ({ path: stat.path.slice(1), stat }));
    const hashes = hashWorktreePaths(workspace.repo, workspace.worktree, paths, { write: false });
    expect(hashes).toHaveLength(4);
    for (let index = 0; index < bodies.length; index++) {
      expect(hashes.get(`large-small-${index}.bin`)?.oid).toBe(hashObject("blob", bodies[index]!));
    }
  });

  it("releases a range chunk and hash state after an injected read failure", () => {
    const workspace = makeRepo("/");
    const body = pattern(CHUNK + 1, 47);
    workspace.worktree.writeFile("/large.bin", body);
    const stat = workspace.worktree.scan("/", { filesOnly: true, limit: 2 })[0];
    if (stat === undefined) throw new Error("large.bin was not scanned");
    let reads = 0;
    const failing = new Proxy(workspace.worktree, {
      get(target, property, receiver) {
        if (property === "readRange") {
          return (path: string, offset: number, length: number): Uint8Array => {
            reads++;
            if (reads === 2) throw new Error("injected range failure");
            return target.readRange(path, offset, length);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = workspace.repo.store.objectCount();

    expect(() =>
      hashWorktreePaths(workspace.repo, failing, [{ path: "large.bin", stat }], {
        write: false,
      }),
    ).toThrow("injected range failure");

    expect(reads).toBe(2);
    expect(workspace.repo.store.objectCount()).toBe(before);
  });

  it("stores small blobs through one object batch", () => {
    const { workspace, paths } = candidates(200);
    workspace.storage.resetCounters();
    const hashes = hashWorktreePaths(workspace.repo, workspace.worktree, paths);
    expect(hashes).toHaveLength(200);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(workspace.repo.readBlob(hashes.get("f0123.txt")?.oid ?? "")).toEqual(
      new TextEncoder().encode("contents 123\n"),
    );
  });

  it("stages incompressible blobs across several small-file read pages", () => {
    const fixture = (): {
      workspace: ReturnType<typeof makeRepo>;
      paths: WorktreePath[];
      worktree: CountingWorktree & { batches: number };
      bodies: Uint8Array[];
    } => {
      const workspace = makeRepo("/");
      const bodies = Array.from({ length: 4 }, (_, index) => incompressible(180_000, index + 1));
      workspace.worktree.writeFiles(
        bodies.map((bytes, index) => ({ path: `/owned-${index}.bin`, bytes })),
      );
      const paths = workspace.worktree
        .scan("/", { filesOnly: true, limit: bodies.length + 1 })
        .map((stat) => ({ path: stat.path.slice(1), stat }));
      class PagedReadWorktree extends CountingWorktree {
        batches = 0;

        override readFiles(
          requested: readonly string[],
          options?: { budget?: number },
        ): ReturnType<Worktree["readFiles"]> {
          this.batches++;
          const first = requested.slice(0, 1);
          const page = super.readFiles(first, options);
          return { files: page.files, remaining: [...page.remaining, ...requested.slice(1)] };
        }
      }
      return {
        workspace,
        paths,
        worktree: new PagedReadWorktree(workspace.worktree),
        bodies,
      };
    };

    const prepared = fixture();
    const hashes = hashWorktreePathsOwned(
      prepared.workspace.repo,
      prepared.worktree,
      prepared.paths,
    );
    expect(hashes).toHaveLength(prepared.bodies.length);
    expect(prepared.worktree.batches).toBe(prepared.bodies.length);
    for (let index = 0; index < prepared.bodies.length; index++) {
      const body = prepared.bodies[index];
      if (body === undefined) throw new Error(`missing body ${index}`);
      expect(prepared.workspace.repo.readBlob(hashes.get(`owned-${index}.bin`)?.oid ?? "")).toEqual(
        body,
      );
    }
  });

  it("rolls back an injected object flush failure", () => {
    const workspace = makeRepo("/");
    const bodies = [incompressible(180_000, 11), incompressible(180_000, 12)];
    workspace.worktree.writeFiles(
      bodies.map((bytes, index) => ({ path: `/flush-${index}.bin`, bytes })),
    );
    const paths = workspace.worktree
      .scan("/", { filesOnly: true, limit: bodies.length + 1 })
      .map((stat) => ({ path: stat.path.slice(1), stat }));
    const before = workspace.repo.store.objectCount();
    workspace.repo.store.db.run(
      `CREATE TRIGGER fail_owned_worktree_object_flush
       BEFORE INSERT ON git_object_chunks
       BEGIN
         SELECT RAISE(ABORT, 'injected owned object flush failure');
       END`,
    );
    try {
      expect(() => hashWorktreePaths(workspace.repo, workspace.worktree, paths)).toThrow(
        "injected owned object flush failure",
      );
    } finally {
      workspace.repo.store.db.run("DROP TRIGGER fail_owned_worktree_object_flush");
    }

    expect(workspace.repo.store.objectCount()).toBe(before);
    expect(
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_object_chunks WHERE repo_id = ?",
        workspace.repo.checkout.repoId,
      ),
    ).toBe(0);
  });

  it("hashes a symlink from scan metadata without another filesystem read", () => {
    const workspace = makeRepo("/");
    workspace.worktree.symlink("target.txt", "/link.txt");
    const stat = workspace.worktree.scan("/", { filesOnly: true, limit: 2 })[0];
    if (stat === undefined) throw new Error("link.txt was not scanned");
    const counting = new CountingWorktree(workspace.worktree);
    const hashes = hashWorktreePaths(workspace.repo, counting, [{ path: "link.txt", stat }], {
      write: false,
    });
    expect(hashes.get("link.txt")?.oid).toBe(
      hashObject("blob", new TextEncoder().encode("target.txt")),
    );
    expect(counting.reads).toBe(0);
    expect(counting.rangeReads).toBe(0);
  });
});

describe("dirtyPaths content identity", () => {
  it("does no filesystem SQL for an index with no eligible entry", () => {
    const workspace = makeRepo("/");
    workspace.repo.checkout.indexPut({
      path: "conflict.txt",
      stage: 1,
      mode: 0o100644,
      oid: "1".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree)).toEqual([]);
    expect(filesystemStatements(workspace.storage.histogram)).toBe(0);

    workspace.repo.checkout.indexPut({
      path: "tracked.txt",
      stage: 0,
      mode: 0o100644,
      oid: "2".repeat(40),
      size: null,
      mtime: null,
      ino: null,
    });
    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree, ["elsewhere"])).toEqual([]);
    expect(filesystemStatements(workspace.storage.histogram)).toBe(0);
  });

  it("compares identities under a symlink repository root", () => {
    const workspace = makeWorkspace();
    workspace.worktree.makeDirectories(["/real"]);
    workspace.worktree.symlink("/real", "/alias");
    const repo = initRepository(workspace.context, { dir: "/alias" });
    const bytes = new TextEncoder().encode("unchanged\n");
    const oid = hashObject("blob", bytes);
    workspace.worktree.writeFiles([{ path: "/real/file.txt", bytes, contentId: fromHex(oid) }]);
    repo.checkout.indexPut({
      path: "file.txt",
      stage: 0,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });

    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    expect(dirtyPaths(repo, workspace.worktree)).toEqual([]);
    expect(contentReadStatements(workspace.storage.histogram)).toBe(0);
  });

  it("bulk-reads unresolved index entries before hashing them", () => {
    const workspace = makeRepo("/");
    const encoder = new TextEncoder();
    for (let index = 0; index < 200; index++) {
      const path = `f${index.toString().padStart(4, "0")}.txt`;
      const bytes = encoder.encode(`contents ${index}\n`);
      workspace.worktree.writeFile(`/${path}`, bytes);
      workspace.repo.checkout.indexPut({
        path,
        stage: 0,
        mode: 0o100644,
        oid: hashObject("blob", bytes),
        size: null,
        mtime: null,
        ino: null,
      });
    }

    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree)).toEqual([]);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("keeps 9,329 identity and unresolved comparisons below 1,000 statements", () => {
    const workspace = makeRepo("/");
    const bytes = new Uint8Array([120]);
    const oid = hashObject("blob", bytes);
    const paths = Array.from(
      { length: 9329 },
      (_, index) => `f${index.toString().padStart(4, "0")}.txt`,
    );
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes, contentId: fromHex(oid) })),
    );
    workspace.repo.checkout.indexReplace(
      paths.map((path) => ({
        path,
        stage: 0,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      })),
    );

    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree)).toEqual([]);
    const identities = workspace.storage.statementCount;

    workspace.worktree.writeFiles(paths.map((path) => ({ path: `/${path}`, bytes })));
    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree)).toEqual([]);
    const unresolved = workspace.storage.statementCount;

    expect(identities).toBeLessThan(1_000);
    expect(unresolved).toBeLessThan(1_000);
  });

  it("reads no content when checkout supplied the indexed blob identity", () => {
    const workspace = makeRepo("/");
    const bytes = new TextEncoder().encode("unchanged\n");
    const oid = hashObject("blob", bytes);
    workspace.worktree.writeFiles([{ path: "/clean.txt", bytes, contentId: fromHex(oid) }]);
    const stat = workspace.worktree.stat("/clean.txt");
    if (stat === null) throw new Error("clean.txt was not written");
    workspace.repo.checkout.indexPut({
      path: "clean.txt",
      stage: 0,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });

    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree)).toEqual([]);
    expect(contentReadStatements(workspace.storage.histogram)).toBe(0);

    // Negative control: a plain write clears the identity and must read the
    // changed bytes before it can report the path.
    workspace.worktree.writeFile("/clean.txt", new TextEncoder().encode("changed\n"));
    workspace.storage.resetCounters();
    expect(dirtyPaths(workspace.repo, workspace.worktree)).toEqual(["clean.txt"]);
    expect(contentReadStatements(workspace.storage.histogram)).toBeGreaterThan(0);
  });

  it("does not trust a symlink target after the path disappears", () => {
    const workspace = makeRepo("/");
    workspace.worktree.symlink("target.txt", "/link.txt");
    workspace.repo.checkout.indexPut({
      path: "link.txt",
      stage: 0,
      mode: 0o120000,
      oid: hashObject("blob", new TextEncoder().encode("target.txt")),
      size: null,
      mtime: null,
      ino: null,
    });
    const racing = mutateAfterFirstScan(workspace.worktree, () =>
      workspace.worktree.unlink("/link.txt"),
    );
    expect(dirtyPaths(workspace.repo, racing)).toEqual(["link.txt"]);
  });

  it.each(["removed", "grown", "shrunk"])(
    "reports a %s large file dirty without throwing",
    (mutation) => {
      const workspace = makeRepo("/");
      const original = pattern(CHUNK + 1, 17);
      const oid = hashObject("blob", original);
      workspace.worktree.writeFile("/large.bin", original);
      workspace.repo.checkout.indexPut({
        path: "large.bin",
        stage: 0,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      });
      const racing = mutateAfterFirstScan(workspace.worktree, () => {
        if (mutation === "removed") workspace.worktree.unlink("/large.bin");
        else if (mutation === "grown") {
          workspace.worktree.writeRange("/large.bin", new Uint8Array([1]), original.length);
        } else {
          workspace.worktree.writeFile("/large.bin", pattern(CHUNK - 1, 23));
        }
      });
      expect(dirtyPaths(workspace.repo, racing)).toEqual(["large.bin"]);
    },
  );
});

function contentReadStatements(histogram: Map<string, number>): number {
  let count = 0;
  for (const [statement, calls] of histogram) {
    if (statement.includes("FROM fs_chunks")) count += calls;
  }
  return count;
}

function filesystemStatements(histogram: Map<string, number>): number {
  let count = 0;
  for (const [statement, calls] of histogram) {
    if (/\bfs_(?:paths|nodes|chunks|meta)\b/.test(statement)) count += calls;
  }
  return count;
}
