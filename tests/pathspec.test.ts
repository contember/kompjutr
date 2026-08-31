import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkoutTree } from "../src/core/ops/checkout.js";
import {
  type CompiledReadPathspec,
  compileReadPathspec,
  type LsFilesOptions,
} from "../src/core/ops/pathspec.js";
import { lsFilesAtRef } from "../src/core/ops/reads.js";
import {
  lsFiles,
  lsFilesWithWorktree,
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

function withCompiledPathspec<T>(
  options: LsFilesOptions,
  use: (pathspec: CompiledReadPathspec) => T,
): T {
  const pathspec = compileReadPathspec(options);
  return use(pathspec);
}

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

  it("uses literal prefix scans without reading unrelated index rows", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("dir/a", oid));
    workspace.repo.checkout.indexPut(indexEntry("dir/sub/b", oid));
    workspace.repo.checkout.indexPut(indexEntry("other/a", oid));

    expect(lsFiles(workspace.repo, { paths: ["dir"] })).toEqual(["dir/a", "dir/sub/b"]);
  });

  it("coalesces redundant literal scans", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("dir/a", oid));
    workspace.repo.checkout.indexPut(indexEntry("dir/sub/b", oid));

    expect(
      lsFiles(workspace.repo, {
        paths: ["dir", "./dir", "dir//sub", "dir/sub/../sub"],
      }),
    ).toEqual(["dir/a", "dir/sub/b"]);
  });

  it("uses one bounded derived-tree traversal for literal ref selectors", async () => {
    const { workspace } = await parityRepo();
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();

    expect(
      lsFilesAtRef(workspace.repo, "HEAD", {
        paths: ["dir", "dir/sub/b.ts", "./dir//sub/../a.ts"],
      }),
    ).toEqual(["dir/a.ts", "dir/sub/b.ts", "dir/sub/c.js"]);
    expect(
      [...workspace.storage.histogram].filter(([query]) =>
        query.startsWith("WITH RECURSIVE params(repo_id, root_oid"),
      ),
    ).toEqual([[expect.any(String), 1]]);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
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
      { limits: { maxMatcherWork: "one" } },
    ]) {
      expect(() => Reflect.apply(compileReadPathspec, undefined, [input])).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }

    expect(withCompiledPathspec({ paths: [] }, (pathspec) => pathspec.collect(["a"]))).toEqual([
      "a",
    ]);
    expect(() => compileReadPathspec({ paths: [""] })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("fails closed immediately above every injected structural limit", () => {
    expect(() =>
      withCompiledPathspec({ paths: ["?"], limits: { maxWildcardTokens: 1 } }, () => {}),
    ).not.toThrow();
    expect(() =>
      compileReadPathspec({ paths: ["?"], limits: { maxWildcardTokens: 0 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    expect(
      withCompiledPathspec({ paths: ["x".repeat(2_201)] }, (pathspec) =>
        pathspec.collect(["x".repeat(2_201)]),
      ),
    ).toEqual(["x".repeat(2_201)]);

    const cumulative = Array.from(
      { length: 40 },
      (_, index) => `${index.toString().padStart(2, "0")}-${"y".repeat(1_700)}`,
    );
    expect(
      withCompiledPathspec({ paths: cumulative }, (pathspec) =>
        pathspec.collect([cumulative[39] ?? ""]),
      ),
    ).toEqual([cumulative[39]]);
  });

  it("fails rather than truncating matcher work", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array([1]));
    workspace.repo.checkout.indexPut(indexEntry("a", oid));
    workspace.repo.checkout.indexPut(indexEntry("b", oid));

    expect(lsFiles(workspace.repo, { paths: ["?"], limits: { maxMatcherWork: 2 } })).toEqual([
      "a",
      "b",
    ]);
    expect(() =>
      lsFiles(workspace.repo, { paths: ["?"], limits: { maxMatcherWork: 1 } }),
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
    expect(MAX_LS_FILES_EXCLUDE_ROOTS).toBe(8_192);
  });

  it("accepts an exclude root beyond the former checkout-root byte ceiling", () => {
    const workspace = makeRepo("/");
    const root = `/nested-${"x".repeat(5_000)}`;

    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeRoots: [root],
      }),
    ).toEqual([]);
  });

  it("accepts the global routing ceiling and applies the limit after coalescing", () => {
    const workspace = makeRepo("/");
    const roots = Array.from(
      { length: MAX_LS_FILES_EXCLUDE_ROOTS },
      (_, index) => `/routing-${index.toString().padStart(4, "0")}`,
    );

    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeRoots: roots.slice(0, 1_025),
      }),
    ).toEqual([]);
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeRoots: roots,
      }),
    ).toEqual([]);
    expect(() =>
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeRoots: [...roots, "/routing-first-excess"],
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        others: true,
        excludeRoots: Array.from(
          { length: MAX_LS_FILES_EXCLUDE_ROOTS + 1 },
          () => "/routing-parent",
        ),
      }),
    ).toEqual([]);
  });

  it("validates selection combinations and crosses former pattern and prefix caps", () => {
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

    const cached = [
      ...Array.from(
        { length: 256 },
        (_, index) => `cached-${index.toString().padStart(3, "0")}\\x`,
      ),
      "cached-last",
    ];
    expect(cached).toHaveLength(257);
    expect(
      withCompiledPathspec({ paths: cached }, (pathspec) => pathspec.scanPrefixes?.length),
    ).toBe(513);
    expect(lsFiles(workspace.repo, { paths: cached })).toEqual([]);

    const exact = [
      ...Array.from({ length: 64 }, (_, index) => `p${index.toString().padStart(2, "0")}\\x`),
      "first-excess",
    ];
    expect(
      withCompiledPathspec({ paths: exact }, (pathspec) => pathspec.scanPrefixes?.length),
    ).toBe(129);
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, { others: true, paths: exact }),
    ).toEqual([]);
  });

  it("collects the selected row after 100,000 direct iterable rows", () => {
    let traversed = 0;
    function* rows(): Generator<string> {
      for (let index = 0; index < 100_000; index++) {
        traversed++;
        yield `a${index.toString().padStart(6, "0")}.txt`;
      }
      traversed++;
      yield "z-selected";
    }
    const pathspec = compileReadPathspec({ paths: ["*selected"] });
    expect(pathspec.scanPrefixes).toBeNull();
    expect(pathspec.collect(rows())).toEqual(["z-selected"]);
    expect(traversed).toBe(100_001);
  });

  it("streams the 100,001st cached index row through leading-wildcard public paths", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", new Uint8Array(0));
    workspace.storage.db.exec(`
      WITH RECURSIVE sequence(i) AS (
        VALUES (0) UNION ALL SELECT i + 1 FROM sequence WHERE i + 1 < 100001
      )
      INSERT INTO git_index
        (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
      SELECT ${workspace.repo.checkout.checkoutId},
             CASE WHEN i = 100000 THEN 'z-selected' ELSE printf('a%06d.txt', i) END,
             0, 33188,
             '${oid}', NULL, NULL, NULL, NULL
        FROM sequence
    `);

    expect(lsFiles(workspace.repo, { paths: ["*selected"] })).toEqual(["z-selected"]);
    expect(
      lsFilesWithWorktree(workspace.repo, workspace.worktree, {
        cached: true,
        others: true,
        paths: ["*selected"],
      }),
    ).toEqual(["z-selected"]);
    expect(
      workspace.repo.checkout.db.scalar<number>(
        "SELECT count(*) FROM git_index WHERE checkout_id = ?",
        workspace.repo.checkout.checkoutId,
      ),
    ).toBe(100_001);
  });

  it("selects after merging 50,001 index and 50,001 worktree rows", () => {
    const indexed = 50_001;
    const walked = 50_001;
    const synthetic = syntheticWorktreeSelection(walked, { prefix: "b", selectedLast: true });
    const oid = synthetic.workspace.repo.store.write("blob", new Uint8Array(0));
    synthetic.workspace.storage.db.exec(`
      WITH RECURSIVE sequence(i) AS (
        VALUES (0) UNION ALL SELECT i + 1 FROM sequence WHERE i + 1 < ${indexed}
      )
      INSERT INTO git_index
        (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
      SELECT ${synthetic.workspace.repo.checkout.checkoutId}, printf('a%06d.txt', i), 0, 33188,
             '${oid}', NULL, NULL, NULL, NULL
        FROM sequence
    `);

    expect(
      lsFilesWithWorktree(synthetic.workspace.repo, synthetic.worktree, {
        cached: true,
        others: true,
        paths: ["*selected"],
      }),
    ).toEqual(["z-selected"]);
    expect(indexed).toBeLessThanOrEqual(100_000);
    expect(walked).toBeLessThanOrEqual(100_000);
    expect(indexed + walked).toBe(100_002);
    expect(synthetic.scanCalls()).toBe(51);
    expect(synthetic.scannedRows()).toBe(walked);
    expect(synthetic.maxScanLimit()).toBe(WORKTREE_SCAN_PAGE);
  });

  it("continues after the former 100,000-row worktree scan ceiling", () => {
    const formerLimit = 100_000;
    const exact = syntheticWorktreeSelection(formerLimit);
    const result = lsFilesWithWorktree(exact.workspace.repo, exact.worktree, {
      others: true,
      paths: ["never"],
    });
    expect(result).toEqual([]);
    expect(exact.scanCalls()).toBe(101);
    expect(exact.scannedRows()).toBe(formerLimit);
    expect(exact.maxScanLimit()).toBe(WORKTREE_SCAN_PAGE);

    const excess = syntheticWorktreeSelection(formerLimit + 1, { selectedLast: true });
    expect(
      lsFilesWithWorktree(excess.workspace.repo, excess.worktree, {
        others: true,
        paths: ["*selected"],
      }),
    ).toEqual(["z-selected"]);
    expect(excess.scanCalls()).toBe(101);
    expect(excess.scannedRows()).toBe(formerLimit + 1);
    expect(excess.maxScanLimit()).toBe(WORKTREE_SCAN_PAGE);
  });
});

function syntheticWorktreeSelection(
  total: number,
  fixtureOptions: { prefix?: string; selectedLast?: boolean } = {},
): {
  workspace: TestRepository;
  worktree: Worktree;
  scanCalls(): number;
  scannedRows(): number;
  maxScanLimit(): number;
} {
  const workspace = makeRepo("/");
  const prefix = fixtureOptions.prefix ?? "p";
  let calls = 0;
  let rows = 0;
  let maxLimit = 0;
  const scan = (_root: string, options: ScanOptions): ScanEntry[] => {
    calls++;
    maxLimit = Math.max(maxLimit, options.limit);
    const prior = options.after;
    const start = prior === undefined ? 0 : Number.parseInt(prior.slice(2), 10) + 1;
    const end = Math.min(total, start + options.limit);
    const page: ScanEntry[] = [];
    for (let index = start; index < end; index++) {
      page.push({
        path:
          fixtureOptions.selectedLast === true && index === total - 1
            ? "/z-selected"
            : `/${prefix}${index.toString().padStart(6, "0")}`,
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
    rows += page.length;
    return page;
  };
  const worktree = new CountingWorktree(workspace.worktree);
  Object.defineProperty(worktree, "scan", { value: scan });
  return {
    workspace,
    worktree,
    scanCalls: () => calls,
    scannedRows: () => rows,
    maxScanLimit: () => maxLimit,
  };
}
