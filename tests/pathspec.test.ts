import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkoutTree } from "../src/core/ops/checkout.js";
import {
  compileReadPathspec,
  LS_FILES_INDEX_PAGE,
  lsFilesResultRetainedBytes,
  MAX_LS_FILES_COMBINED_PATTERNS,
  MAX_LS_FILES_PATTERNS,
  MAX_LS_FILES_SCAN_PREFIXES,
  MAX_LS_FILES_SCAN_ROWS,
  MAX_LS_FILES_SQL_STATEMENTS,
} from "../src/core/ops/pathspec.js";
import { lsFilesAtRef } from "../src/core/ops/reads.js";
import {
  lsFiles,
  lsFilesWithWorktree,
  MAX_LS_FILES_CACHED_SQL_STATEMENTS,
  MAX_LS_FILES_COMBINED_FIXED_STATEMENTS,
  MAX_LS_FILES_COMBINED_IGNORE_STATEMENTS,
  MAX_LS_FILES_COMBINED_INDEX_STATEMENTS,
  MAX_LS_FILES_COMBINED_SQL_STATEMENTS,
  MAX_LS_FILES_COMBINED_WORKTREE_STATEMENTS,
  MAX_LS_FILES_EXCLUDE_ROOT_UTF8_BYTES,
  MAX_LS_FILES_EXCLUDE_ROOTS,
} from "../src/core/ops/staging.js";
import { WORKTREE_SCAN_PAGE } from "../src/core/ops/worktree-io.js";
import { comparePaths } from "../src/core/streams.js";
import type { Worktree } from "../src/core/worktree.js";
import type {
  DiscoverFilesOptions,
  DiscoverFilesPage,
  HandleReadBatch,
  RealPath,
  RegularFileHandle,
  ScanEntry,
  ScanOptions,
} from "../src/fs/types.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import type { SqliteTestStorage } from "./helpers/storage.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

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

function gitLsFilesSelection(
  fixture: GitFixture,
  selection: readonly string[],
  paths: readonly string[] = [],
): string[] {
  const output = fixture.gitBinary("ls-files", "-z", ...selection, "--", ...paths).toString("utf8");
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

class StatementCountingWorktree extends CountingWorktree {
  realpathCalls = 0;
  realpathStatements = 0;
  scanCalls = 0;
  scanStatements = 0;
  discoveryCalls = 0;
  discoveryStatements = 0;
  discoverySourceRows = 0;
  maxDiscoveryExcludeRoots = 0;
  handleReadCalls = 0;
  handleReadStatements = 0;

  constructor(
    inner: Worktree,
    private readonly storage: SqliteTestStorage,
  ) {
    super(inner);
  }

  override realpath(path: string): RealPath {
    const before = this.storage.statementCount;
    const resolved = super.realpath(path);
    this.realpathCalls++;
    this.realpathStatements += this.storage.statementCount - before;
    return resolved;
  }

  override scan(root: string, options: ScanOptions): ScanEntry[] {
    const before = this.storage.statementCount;
    const page = super.scan(root, options);
    this.scanCalls++;
    this.scanStatements += this.storage.statementCount - before;
    return page;
  }

  override discoverFiles(
    root: RealPath,
    pattern: string,
    options?: DiscoverFilesOptions,
  ): DiscoverFilesPage {
    const before = this.storage.statementCount;
    const page = super.discoverFiles(root, pattern, options);
    this.discoveryCalls++;
    this.discoveryStatements += this.storage.statementCount - before;
    this.discoverySourceRows += page.handles.length;
    this.maxDiscoveryExcludeRoots = Math.max(
      this.maxDiscoveryExcludeRoots,
      options?.excludeRoots?.length ?? 0,
    );
    return page;
  }

  override readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch {
    const before = this.storage.statementCount;
    const batch = super.readFileHandles(handles, options);
    this.handleReadCalls++;
    this.handleReadStatements += this.storage.statementCount - before;
    return batch;
  }
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

describe("ls-files selection", () => {
  it("matches Git for cached, others, standard ignores, symlinks, and builder globs", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture
      .write("tracked.txt", "tracked\n")
      .write("assets/tracked-abc.svg", "tracked svg\n")
      .commit("selection base");
    fixture
      .write(".gitignore", "*.log\n")
      .write("ignored.log", "ignored\n")
      .write("assets/.gitignore", "*.tmp\n")
      .write("assets/ignored.tmp", "ignored nested\n")
      .write("assets/fresh-abc.svg", "fresh nested\n")
      .write("fresh-abc.svg", "fresh root\n")
      .write("plain.txt", "plain\n")
      .symlink("plain.txt", "link.txt");

    const workspace = makeRepo("/");
    await importFixture(fixture, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    writeWorkFile(workspace, "/.gitignore", "*.log\n");
    writeWorkFile(workspace, "/ignored.log", "ignored\n");
    writeWorkFile(workspace, "/assets/.gitignore", "*.tmp\n");
    writeWorkFile(workspace, "/assets/ignored.tmp", "ignored nested\n");
    writeWorkFile(workspace, "/assets/fresh-abc.svg", "fresh nested\n");
    writeWorkFile(workspace, "/fresh-abc.svg", "fresh root\n");
    writeWorkFile(workspace, "/plain.txt", "plain\n");
    workspace.worktree.symlink("plain.txt", "/link.txt");

    const cases: Array<{
      git: string[];
      native: { cached?: boolean; others?: boolean; excludeStandard?: boolean; paths?: string[] };
      paths?: string[];
    }> = [
      { git: ["--cached"], native: {} },
      { git: ["--others"], native: { others: true } },
      {
        git: ["--others", "--exclude-standard"],
        native: { others: true, excludeStandard: true },
      },
      { git: ["--cached", "--others"], native: { cached: true, others: true } },
      {
        git: ["--cached", "--others", "--exclude-standard"],
        native: { cached: true, others: true, excludeStandard: true },
      },
      {
        git: ["--cached", "--others", "--exclude-standard"],
        native: {
          cached: true,
          others: true,
          excludeStandard: true,
          paths: ["*-abc.svg"],
        },
        paths: ["*-abc.svg"],
      },
      {
        git: ["--cached", "--others", "--exclude-standard"],
        native: {
          cached: true,
          others: true,
          excludeStandard: true,
          paths: ["assets"],
        },
        paths: ["assets"],
      },
    ];

    for (const testCase of cases) {
      // The typed API keeps its unique global byte order across source categories.
      const expected = gitLsFilesSelection(fixture, testCase.git, testCase.paths).sort(
        comparePaths,
      );
      expect(lsFilesWithWorktree(workspace.repo, workspace.worktree, testCase.native)).toEqual(
        expected,
      );
    }
  });

  it("returns an empty selection for an empty repository and cached false", () => {
    const workspace = makeRepo("/");
    expect(lsFilesWithWorktree(workspace.repo, workspace.worktree, { others: true })).toEqual([]);
    expect(lsFilesWithWorktree(workspace.repo, workspace.worktree, { cached: false })).toEqual([]);
  });

  it("deduplicates conflict stages and removes them from the untracked side", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("conflict.txt", "base\n").commit("conflict base");

    const workspace = makeRepo("/");
    await importFixture(fixture, workspace.repo.checkout);
    checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
    const rows: IndexEntry[] = [];
    let indexInfo = `0 ${"0".repeat(40)}\tconflict.txt\n`;
    for (const stage of [1, 2, 3]) {
      const contents = `stage ${stage}\n`;
      const oid = fixture.gitInput(contents, "hash-object", "-w", "--stdin");
      expect(workspace.repo.store.write("blob", new TextEncoder().encode(contents))).toBe(oid);
      indexInfo += `100644 ${oid} ${stage}\tconflict.txt\n`;
      rows.push(indexEntry("conflict.txt", oid, stage));
    }
    fixture.gitInput(indexInfo, "update-index", "--index-info");
    workspace.repo.checkout.indexReplace(rows);

    const git = gitLsFilesSelection(fixture, ["--cached", "--others"]);
    expect(git.filter((path) => path === "conflict.txt")).toHaveLength(3);
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, { cached: true, others: true }),
    ).toEqual(["conflict.txt"]);
    expect(lsFilesWithWorktree(workspace.repo, workspace.worktree, { others: true })).toEqual([]);
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        cached: true,
        others: true,
        limits: { maxScanRows: 3 },
      }),
    ).toEqual(["conflict.txt"]);
    expect(() =>
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        cached: true,
        others: true,
        limits: { maxScanRows: 2 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("prunes a nested checkout while recording Git's directory-row divergence", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("kept.txt", "kept\n");
    fixture.write("nested/inside.txt", "inside\n");
    const nested = new GitFixture(join(fixture.dir, "nested")).init();

    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    writeWorkFile(workspace, "/nested/inside.txt", "inside\n");
    const git = gitLsFilesSelection(fixture, ["--others"]);
    expect(git).toContain("nested/");
    expect(lsFilesWithWorktree(workspace.repo, workspace.worktree, { others: true })).toEqual([
      "kept.txt",
      "nested/inside.txt",
    ]);
    writeWorkFile(workspace, "/nested/.gitignore", "ignored\n".repeat(8_193));
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeStandard: true,
        excludeRoots: ["/nested"],
      }),
    ).toEqual(["kept.txt"]);
    nested.dispose();
  });

  it("prunes excluded ignore sources before pagination and still finds a later parent rule", () => {
    const workspace = makeRepo("/");
    const empty = new Uint8Array(0);
    const nestedRules: Array<{ path: string; bytes: Uint8Array }> = [];
    for (let index = 0; index < 1_025; index++) {
      nestedRules.push({
        path: `/nested/d${index.toString().padStart(4, "0")}/.gitignore`,
        bytes: empty,
      });
    }
    workspace.worktree.writeFiles(nestedRules);
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    writeWorkFile(workspace, "/z/.gitignore", "*.log\n");
    writeWorkFile(workspace, "/z/ignored.log", "ignored\n");
    writeWorkFile(workspace, "/z/visible.txt", "visible\n");

    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeStandard: true,
        excludeRoots: ["/nested"],
      }),
    ).toEqual(["kept.txt", "z/.gitignore", "z/visible.txt"]);
  });

  it("coalesces 65 redundant nested roots before applying the effective limit", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    writeWorkFile(workspace, "/nested/.gitignore", "*.txt\n");
    writeWorkFile(workspace, "/nested/hidden.txt", "hidden\n");
    const measured = new StatementCountingWorktree(workspace.worktree, workspace.storage);

    expect(
      lsFilesWithWorktree(workspace.repo, measured, {
        others: true,
        excludeStandard: true,
        excludeRoots: Array.from({ length: 65 }, () => "/nested"),
      }),
    ).toEqual(["kept.txt"]);
    expect(measured.maxDiscoveryExcludeRoots).toBe(1);
    expect(measured.discoverySourceRows).toBe(0);
  });

  it("prunes 65 sibling roots with one bounded ignore-discovery statement", () => {
    const workspace = makeRepo("/");
    const roots = Array.from(
      { length: 65 },
      (_, index) => `/nested-${index.toString().padStart(2, "0")}`,
    );
    for (const root of roots) {
      writeWorkFile(workspace, `${root}/.gitignore`, "*.txt\n");
      writeWorkFile(workspace, `${root}/hidden.txt`, "hidden\n");
    }
    writeWorkFile(workspace, "/kept.txt", "kept\n");
    writeWorkFile(workspace, "/z/.gitignore", "*.log\n");
    writeWorkFile(workspace, "/z/hidden.log", "hidden\n");
    writeWorkFile(workspace, "/z/visible.txt", "visible\n");
    const measured = new StatementCountingWorktree(workspace.worktree, workspace.storage);
    workspace.storage.resetCounters();

    expect(
      lsFilesWithWorktree(workspace.repo, measured, {
        others: true,
        excludeStandard: true,
        excludeRoots: roots,
      }),
    ).toEqual(["kept.txt", "z/.gitignore", "z/visible.txt"]);
    expect(measured.maxDiscoveryExcludeRoots).toBe(65);
    expect(measured.discoveryCalls).toBe(1);
    expect(measured.discoveryStatements).toBe(1);
    expect(measured.discoverySourceRows).toBe(1);
    expect(MAX_LS_FILES_EXCLUDE_ROOTS).toBe(1_024);
    expect(MAX_LS_FILES_EXCLUDE_ROOT_UTF8_BYTES).toBe(4 * 1024 * 1024);
  });

  it("validates selection combinations and enforces the combined pattern cap", () => {
    const workspace = makeRepo("/");
    expect(() => Reflect.apply(lsFiles, undefined, [workspace.repo, null])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() =>
      Reflect.apply(lsFiles, undefined, [workspace.repo, { excludeStandard: true }]),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      Reflect.apply(lsFiles, undefined, [workspace.repo, { others: true }]),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    expect(() =>
      Reflect.apply(lsFilesAtRef, undefined, [workspace.repo, "HEAD", { cached: true }]),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    for (const key of ["cached", "others", "excludeStandard"]) {
      expect(() =>
        Reflect.apply(lsFiles, undefined, [workspace.repo, { [key]: "yes" }]),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    }

    const exact = Array.from({ length: MAX_LS_FILES_COMBINED_PATTERNS }, (_, index) => `p${index}`);
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, { others: true, paths: exact }),
    ).toEqual([]);
    expect(() =>
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        paths: [...exact, "first-excess"],
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("succeeds at the merged row limit and fails first-excess without truncation", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("a", oid));
    workspace.repo.checkout.indexPut(indexEntry("b", oid));
    writeWorkFile(workspace, "/a", "tracked\n");
    writeWorkFile(workspace, "/c", "fresh\n");

    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        cached: true,
        others: true,
        limits: { maxScanRows: 3 },
      }),
    ).toEqual(["a", "b", "c"]);
    expect(() =>
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        cached: true,
        others: true,
        limits: { maxScanRows: 2 },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("uses the 101st worktree scan as the exact terminal or first-excess probe", () => {
    const exact = syntheticWorktreeSelection(MAX_LS_FILES_SCAN_ROWS);
    const result = lsFilesWithWorktree(exact.workspace.repo, exact.workspace.worktree, {
      others: true,
      paths: ["never"],
    });
    expect(result).toEqual([]);
    expect(exact.scanCalls()).toBe(101);

    const excess = syntheticWorktreeSelection(MAX_LS_FILES_SCAN_ROWS + 1);
    expect(() =>
      lsFilesWithWorktree(excess.workspace.repo, excess.workspace.worktree, {
        others: true,
        paths: ["never"],
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(excess.scanCalls()).toBe(101);
  });

  it("measures the combined SQL ceiling and separates its conservative reserve", () => {
    const workspace = combinedCostWorkspace();
    const measured = new StatementCountingWorktree(workspace.worktree, workspace.storage);
    const patterns = Array.from(
      { length: MAX_LS_FILES_COMBINED_PATTERNS },
      (_, index) => `p${index.toString().padStart(2, "0")}\\x`,
    );
    expect(
      compileReadPathspec({ paths: patterns }, MAX_LS_FILES_COMBINED_PATTERNS).scanPrefixes,
    ).toHaveLength(128);
    workspace.storage.resetCounters();

    expect(
      lsFilesWithWorktree(workspace.repo, measured, {
        others: true,
        excludeStandard: true,
        paths: patterns,
      }),
    ).toEqual([]);

    const measuredWorktreePages = measured.scanCalls;
    const measuredIgnoreStatements = measured.discoveryStatements + measured.handleReadStatements;
    const measuredHelperStatements =
      measured.realpathStatements + (measured.scanStatements - measured.scanCalls);
    const measuredIndexStatements =
      workspace.storage.statementCount -
      measured.scanStatements -
      measured.discoveryStatements -
      measured.handleReadStatements -
      measured.realpathStatements;

    expect(measuredIndexStatements).toBe(518);
    expect(measuredWorktreePages).toBe(MAX_LS_FILES_COMBINED_WORKTREE_STATEMENTS);
    expect(measured.discoveryCalls).toBe(8);
    expect(measured.handleReadCalls).toBe(8);
    expect(measuredIgnoreStatements).toBe(MAX_LS_FILES_COMBINED_IGNORE_STATEMENTS);
    expect(measuredHelperStatements).toBe(3);
    expect(workspace.storage.statementCount).toBe(638);

    const conservativeReserve =
      MAX_LS_FILES_COMBINED_INDEX_STATEMENTS -
      measuredIndexStatements +
      (MAX_LS_FILES_COMBINED_FIXED_STATEMENTS - measuredHelperStatements);
    expect(conservativeReserve).toBe(62);
    expect(workspace.storage.statementCount + conservativeReserve).toBe(
      MAX_LS_FILES_COMBINED_SQL_STATEMENTS,
    );
  });

  it("pins the cached and conservative combined SQL allocation", () => {
    expect(MAX_LS_FILES_CACHED_SQL_STATEMENTS).toBe(903);
    expect(MAX_LS_FILES_COMBINED_INDEX_STATEMENTS).toBe(519);
    expect(MAX_LS_FILES_COMBINED_WORKTREE_STATEMENTS).toBe(101);
    expect(MAX_LS_FILES_COMBINED_IGNORE_STATEMENTS).toBe(16);
    expect(MAX_LS_FILES_COMBINED_FIXED_STATEMENTS).toBe(64);
    expect(MAX_LS_FILES_COMBINED_SQL_STATEMENTS).toBe(700);
    expect(WORKTREE_SCAN_PAGE).toBe(1_000);
  });
});

function syntheticWorktreeSelection(total: number): {
  workspace: TestRepository;
  scanCalls(): number;
} {
  const workspace = makeRepo("/");
  let calls = 0;
  const scan = (_root: string, options: ScanOptions): ScanEntry[] => {
    calls++;
    const prior = options.after;
    const start = prior === undefined ? 0 : Number.parseInt(prior.slice(2), 10) + 1;
    const end = Math.min(total, start + options.limit);
    const page: ScanEntry[] = [];
    for (let index = start; index < end; index++) {
      page.push({
        path: `/p${index.toString().padStart(6, "0")}`,
        type: "file",
        mode: 0o100644,
        size: 0,
        mtime: 0,
        ino: index + 1,
        nlink: 1,
        rev: 0,
        target: null,
        contentId: null,
      });
    }
    return page;
  };
  Object.defineProperty(workspace.worktree, "scan", { value: scan });
  return { workspace, scanCalls: () => calls };
}

function combinedCostWorkspace(): TestRepository {
  const workspace = makeRepo("/");
  const rows = MAX_LS_FILES_SCAN_ROWS;
  const inodeBase = 10_000_000;
  const oid = workspace.repo.store.write("blob", new Uint8Array(0));
  workspace.repo.checkout.db.run(
    `WITH RECURSIVE seq(i) AS (
       VALUES (0) UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?
     )
     INSERT INTO fs_nodes (inode, type, mode, mtime, size, rev, nlink)
     SELECT ? + i, 'file', 420, 0, 0, 1, 1 FROM seq`,
    rows,
    inodeBase,
  );
  workspace.repo.checkout.db.run(
    `WITH RECURSIVE seq(i) AS (
       VALUES (0) UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?
     )
     INSERT INTO fs_paths (path, parent, inode)
     SELECT CASE
              WHEN i < 1024 THEN printf('/p00\\x/d%06d/.gitignore', i)
              ELSE printf('/p00\\x/file%06d', i)
            END,
            '/', ? + i
       FROM seq`,
    rows,
    inodeBase,
  );
  workspace.repo.checkout.db.run(
    `WITH RECURSIVE seq(i) AS (
       VALUES (0) UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?
     )
     INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
     SELECT ?,
            CASE
              WHEN i < 1024 THEN printf('p00\\x/d%06d/.gitignore', i)
              ELSE printf('p00\\x/file%06d', i)
            END,
            0, 33188, ?, NULL, NULL, NULL, NULL
       FROM seq`,
    rows,
    workspace.repo.checkout.checkoutId,
    oid,
  );
  return workspace;
}
