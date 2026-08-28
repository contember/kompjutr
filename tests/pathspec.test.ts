import { afterEach, describe, expect, it } from "vitest";

import { checkoutTree } from "../src/core/ops/checkout.js";
import {
  compileReadPathspec,
  LS_FILES_INDEX_PAGE,
  lsFilesResultRetainedBytes,
  MAX_LS_FILES_PATTERNS,
  MAX_LS_FILES_SCAN_PREFIXES,
  MAX_LS_FILES_SCAN_ROWS,
  MAX_LS_FILES_SQL_STATEMENTS,
} from "../src/core/ops/pathspec.js";
import { lsFilesAtRef } from "../src/core/ops/reads.js";
import { lsFiles } from "../src/core/ops/staging.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

async function parityRepo(): Promise<{ fixture: GitFixture; workspace: TestRepository }> {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  for (const path of [
    "!file",
    "^file",
    "a-x",
    "a/x",
    "acx",
    "ax",
    "back\\slash",
    "backslash",
    "dir/a.ts",
    "dir/sub/b.ts",
    "dir/sub/c.js",
    "double\\x",
    "double\\\\x",
    "f\\oo",
    "file1",
    "filea",
    "foo/bar/child",
    "nested/root-one.svg",
    "mark?",
    "mark\\?",
    "root-one.svg",
    "star*/child",
    "trail\\",
    "z.ts",
    "\ue000.ts",
    "\u{10000}.ts",
  ]) {
    fixture.write(path, `${path}\n`);
  }
  fixture.commit("pathspec corpus");

  const workspace = makeRepo("/");
  await importFixture(fixture, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  return { fixture, workspace };
}

function gitLsFiles(fixture: GitFixture, paths: readonly string[]): string[] {
  const output = fixture.gitBinary("ls-files", "-z", "--", ...paths).toString("utf8");
  return output === "" ? [] : output.slice(0, -1).split("\0");
}

function indexEntry(path: string, oid: string, stage = 0): IndexEntry {
  return {
    path,
    stage,
    mode: 0o100644,
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}

describe("ls-files pathspec", () => {
  it("matches Git default pathspec globs in Git byte order", async () => {
    const { fixture, workspace } = await parityRepo();
    const cases = [
      ["*.ts"],
      ["dir/*.ts"],
      ["dir/**"],
      ["root-*.svg"],
      ["a?x"],
      ["a[/]x"],
      ["file[1a]"],
      ["dir/a.ts"],
      ["!file"],
      ["^file"],
      ["^file", "*.js", "!file"],
      ["nothing-*.txt"],
      ["./dir//a.ts"],
      ["dir/./a.ts"],
      ["dir//*.ts"],
      ["dir/sub/../a.ts"],
      ["dir/../root-one.svg"],
      ["dir/.."],
      ["back\\slash"],
      ["double\\\\x"],
      ["f\\oo"],
      ["star\\*"],
      ["foo\\/bar"],
      ["mark\\?"],
      ["trail\\"],
    ];

    for (const paths of cases) {
      const expected = gitLsFiles(fixture, paths);
      expect(lsFiles(workspace.repo, { paths }), paths.join(" ")).toEqual(expected);
      expect(lsFilesAtRef(workspace.repo, "HEAD", { paths }), `HEAD ${paths.join(" ")}`).toEqual(
        expected,
      );
    }
  });

  it("keeps the no-path order and deduplicates conflict stages", async () => {
    const { fixture, workspace } = await parityRepo();
    const existing = workspace.repo.checkout.indexEntries().find((entry) => entry.path === "a/x");
    if (existing === undefined) throw new Error("missing parity index entry");
    workspace.repo.checkout.indexPut({ ...existing, stage: 1 });
    workspace.repo.checkout.indexPut({ ...existing, stage: 2 });

    expect(lsFiles(workspace.repo)).toEqual(gitLsFiles(fixture, []));
    expect(lsFiles(workspace.repo, { paths: ["a?x"] })).toEqual(["a-x", "a/x", "acx"]);
  });

  it("uses literal prefix scans without charging unrelated index rows", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("dir/a", oid));
    workspace.repo.checkout.indexPut(indexEntry("dir/sub/b", oid));
    workspace.repo.checkout.indexPut(indexEntry("other/a", oid));

    expect(lsFiles(workspace.repo, { paths: ["dir"], limits: { maxScanRows: 2 } })).toEqual([
      "dir/a",
      "dir/sub/b",
    ]);
    expect(() =>
      lsFiles(workspace.repo, { paths: ["dir"], limits: { maxScanRows: 1 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("coalesces redundant literal scans before charging the row budget", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("dir/a", oid));
    workspace.repo.checkout.indexPut(indexEntry("dir/sub/b", oid));

    expect(
      lsFiles(workspace.repo, {
        paths: ["dir", "./dir", "dir//sub", "dir/sub/../sub"],
        limits: { maxScanRows: 2 },
      }),
    ).toEqual(["dir/a", "dir/sub/b"]);
  });

  it("uses one bounded derived-tree traversal for literal ref selectors", async () => {
    const { workspace } = await parityRepo();
    const totalRows = lsFilesAtRef(workspace.repo, "HEAD").length;
    workspace.storage.resetCounters();

    expect(
      lsFilesAtRef(workspace.repo, "HEAD", {
        paths: ["dir", "dir/sub/b.ts", "./dir//sub/../a.ts"],
        limits: { maxScanRows: totalRows },
      }),
    ).toEqual(["dir/a.ts", "dir/sub/b.ts", "dir/sub/c.js"]);
    expect(workspace.storage.statementCount).toBeLessThanOrEqual(10);
    expect(() =>
      lsFilesAtRef(workspace.repo, "HEAD", {
        paths: ["dir"],
        limits: { maxScanRows: totalRows - 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("rejects unsupported leading root and magic forms", () => {
    for (const path of ["/file", ":file", ":!file", ":^file", ":/", ":(glob)file"]) {
      expect(() => compileReadPathspec({ paths: [path] }), path).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
    for (const path of ["../file", "dir/../../file"]) {
      expect(() => compileReadPathspec({ paths: [path] }), path).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it("validates runtime structure and canonical strings before compilation", () => {
    for (const input of [
      null,
      [],
      { paths: "file" },
      { paths: [1] },
      { paths: ["bad\0path"] },
      { paths: ["bad\ud800path"] },
      { paths: ["bad\udc00path"] },
      { limits: [] },
      { limits: { maxScanRows: "one" } },
    ]) {
      expect(() => Reflect.apply(compileReadPathspec, undefined, [input])).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }

    expect(compileReadPathspec({ paths: [] }).collect(["a"])).toEqual(["a"]);
    expect(() => compileReadPathspec({ paths: [""] })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("fails closed immediately above every injected structural limit", () => {
    expect(() => compileReadPathspec({ paths: ["?"], limits: { maxPatterns: 1 } })).not.toThrow();
    expect(() => compileReadPathspec({ paths: ["?"], limits: { maxPatterns: 0 } })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() =>
      compileReadPathspec({ paths: ["?"], limits: { maxPatternBytes: 1, maxInputBytes: 1 } }),
    ).not.toThrow();
    expect(() =>
      compileReadPathspec({ paths: ["?"], limits: { maxPatternBytes: 0 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() => compileReadPathspec({ paths: ["?"], limits: { maxInputBytes: 0 } })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() =>
      compileReadPathspec({ paths: ["?"], limits: { maxWildcardTokens: 1 } }),
    ).not.toThrow();
    expect(() =>
      compileReadPathspec({ paths: ["?"], limits: { maxWildcardTokens: 0 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    const worstCaseIndexStatements =
      Math.ceil(MAX_LS_FILES_SCAN_ROWS / LS_FILES_INDEX_PAGE) + MAX_LS_FILES_SCAN_PREFIXES;
    expect(MAX_LS_FILES_SCAN_PREFIXES).toBe(512);
    expect(MAX_LS_FILES_SCAN_PREFIXES).toBe(MAX_LS_FILES_PATTERNS * 2);
    expect(worstCaseIndexStatements).toBe(903);
    expect(worstCaseIndexStatements).toBeLessThan(MAX_LS_FILES_SQL_STATEMENTS);
  });

  it("fails rather than truncating scan, matcher, or retained results", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("a", oid));
    workspace.repo.checkout.indexPut(indexEntry("b", oid));

    expect(lsFiles(workspace.repo, { limits: { maxScanRows: 2 } })).toEqual(["a", "b"]);
    expect(() => lsFiles(workspace.repo, { limits: { maxScanRows: 1 } })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    expect(lsFiles(workspace.repo, { paths: ["?"], limits: { maxMatcherWork: 2 } })).toEqual([
      "a",
      "b",
    ]);
    expect(() =>
      lsFiles(workspace.repo, { paths: ["?"], limits: { maxMatcherWork: 1 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    const oneResult = lsFilesResultRetainedBytes("a");
    expect(
      lsFiles(workspace.repo, {
        paths: ["a"],
        limits: { maxRetainedBytes: oneResult },
      }),
    ).toEqual(["a"]);
    expect(() =>
      lsFiles(workspace.repo, {
        paths: ["a"],
        limits: { maxRetainedBytes: oneResult - 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
});
