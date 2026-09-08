// A lone surrogate has no UTF-8 encoding. `JSON.stringify` escapes it to
// `\ud800`, which SQLite un-escapes into WTF-8, while a direct bind stores
// U+FFFD — so the name read back is not the name written. `packages/do/src/fs` rejects it
// at the resolve chokepoint, exactly as `packages/git/src` does (ADR-0007).

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const HIGH = "\uD800";
const LOW = "\uDC00";

function open(): Filesystem {
  return createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
}

function codeOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
  return "no error thrown";
}

describe("filesystem paths must be well-formed UTF-8", () => {
  it("rejects a lone high surrogate in a filename", () => {
    const fs = open();
    expect(codeOf(() => fs.writeFile(`/a${HIGH}b.txt`, ENCODER.encode("x")))).toBe("EINVAL");
    expect(fs.listEntries("/").items).toEqual([{ directory: "/", entry: null }]);
  });

  it("rejects a lone low surrogate in a filename", () => {
    const fs = open();
    expect(codeOf(() => fs.writeFile(`/a${LOW}b.txt`, ENCODER.encode("x")))).toBe("EINVAL");
  });

  it("rejects a lone surrogate in a mid-path segment", () => {
    const fs = open();
    fs.mkdir("/repo");
    expect(codeOf(() => fs.writeFile(`/repo/d${HIGH}ir/file.txt`, new Uint8Array(0)))).toBe(
      "EINVAL",
    );
    expect(codeOf(() => fs.mkdir(`/repo/d${LOW}ir`))).toBe("EINVAL");
  });

  it("rejects a reversed surrogate pair, which is two lone surrogates", () => {
    const fs = open();
    expect(codeOf(() => fs.writeFile(`/${LOW}${HIGH}.txt`, new Uint8Array(0)))).toBe("EINVAL");
  });

  it("rejects malformed paths on the bulk and metadata surfaces alike", () => {
    const fs = open();
    fs.mkdir("/repo");
    fs.writeFile("/repo/source.txt", new Uint8Array(1));
    const bad = `/repo/${HIGH}.txt`;
    expect(codeOf(() => fs.writeFiles([{ path: bad, bytes: new Uint8Array(0) }]))).toBe("EINVAL");
    expect(codeOf(() => fs.makeDirectories([bad]))).toBe("EINVAL");
    expect(codeOf(() => fs.readFiles([bad]))).toBe("EINVAL");
    expect(codeOf(() => fs.removeFiles([bad]))).toBe("EINVAL");
    expect(codeOf(() => fs.touchFiles([bad], { create: true }))).toBe("EINVAL");
    expect(codeOf(() => fs.copyFiles([{ source: "/repo", destination: bad }]))).toBe("EINVAL");
    expect(codeOf(() => fs.writeFileStream(bad, [new Uint8Array(1)]))).toBe("EINVAL");
    expect(codeOf(() => fs.stat(bad))).toBe("EINVAL");
    expect(codeOf(() => fs.exists(bad))).toBe("EINVAL");
    expect(codeOf(() => fs.readdir(bad))).toBe("EINVAL");
    expect(codeOf(() => fs.realpath(bad))).toBe("EINVAL");
    expect(codeOf(() => fs.rename("/repo", bad))).toBe("EINVAL");
    expect(codeOf(() => fs.link("/repo/source.txt", bad))).toBe("EINVAL");
  });

  it("rejects a malformed symlink target before it reaches the size CHECK", () => {
    const fs = open();
    // A lone high surrogate is where the manual byte counter used to disagree
    // with what SQLite stored, so the CHECK failed with a raw SQLite error.
    expect(codeOf(() => fs.symlink(HIGH, "/link"))).toBe("EINVAL");
    expect(codeOf(() => fs.symlink(`${HIGH}x`, "/link"))).toBe("EINVAL");
    expect(codeOf(() => fs.writeFiles([{ path: "/other", target: LOW }]))).toBe("EINVAL");
    expect(fs.stat("/link")).toBeNull();
  });

  it("round-trips a well-formed astral filename", () => {
    const fs = open();
    const path = "/repo/\u{1F600}.txt";
    fs.mkdir("/repo");
    fs.writeFile(path, ENCODER.encode("emoji"));

    expect(fs.exists(path)).toBe(true);
    expect(DECODER.decode(fs.readFile(path))).toBe("emoji");
    expect(fs.readdir("/repo").map((entry) => entry.name)).toEqual(["\u{1F600}.txt"]);
    expect(fs.scan("/repo", { limit: 10 }).map((entry) => entry.path)).toEqual([path]);
    expect(fs.readFiles([path]).files.has(path)).toBe(true);
  });

  it("round-trips a well-formed astral symlink target and directory name", () => {
    const fs = open();
    fs.makeDirectories(["/\u{1F4C1}dir"]);
    fs.writeFile("/\u{1F4C1}dir/x.txt", ENCODER.encode("v"));
    fs.symlink("/\u{1F4C1}dir/x.txt", "/\u{1F517}");

    expect(fs.readlink("/\u{1F517}")).toBe("/\u{1F4C1}dir/x.txt");
    expect(fs.stat("/\u{1F517}")?.size).toBe(ENCODER.encode("/\u{1F4C1}dir/x.txt").byteLength);
    expect(DECODER.decode(fs.readFile("/\u{1F517}"))).toBe("v");
  });

  it("pages an astral sibling set without losing a row", () => {
    const fs = open();
    fs.makeDirectories(["/p"]);
    const names = ["/p/\u{1F600}a", "/p/\u{1F600}b", "/p/\u{1F600}c"];
    fs.writeFiles(names.map((path) => ({ path, bytes: new Uint8Array(1) })));

    const seen: string[] = [];
    let after = fs.scan("/p", { limit: 1 })[0]?.path;
    while (after !== undefined) {
      seen.push(after);
      after = fs.scan("/p", { limit: 1, after })[0]?.path;
    }
    expect(seen).toEqual(names);
  });
});
