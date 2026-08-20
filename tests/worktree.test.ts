import { describe, expect, it } from "vitest";

import { walkWorktree, walkWorktreeStream } from "../src/core/ops/worktree-io.js";
import { comparePaths } from "../src/core/streams.js";
import { makeWorkspace, type TestWorkspace } from "./helpers/workspace.js";
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

function makeWorktree(): TestWorkspace["worktree"] {
  return makeWorkspace().worktree;
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
    expect(streamed).toEqual([...streamed].sort(comparePaths));
    expect(walkWorktree(worktree, "/")).toEqual(streamed);
  });

  it("reads one directory at a time rather than the whole tree", () => {
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
    // The root plus the first directory, not all twenty-one.
    expect(counting.readdirs).toBeLessThanOrEqual(2);
    expect([...walk]).toHaveLength(199);
  });
});
