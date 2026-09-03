import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";
import type {
  DiscoverFilesOptions,
  DiscoverFilesPage,
  HandleReadBatch,
  RealPath,
  RegularFileHandle,
} from "../src/fs/types.js";
import type {
  IgnoreLimitResource,
  IgnorePattern,
  IgnoreSourceHashStep,
} from "../src/git/ignore/index.js";
import {
  IGNORE_LIMITS,
  IgnoreLimitError,
  loadIgnoreMatcher,
  WorktreeIgnoreMatcher,
} from "../src/git/ignore/index.js";
import { compilePattern } from "../src/git/ignore/pattern.js";
import type { Worktree } from "../src/git/ops/worktree/worktree.js";
import { GitFixture } from "./helpers/git.js";
import type { SqliteTestStorage } from "./helpers/storage.js";
import { makeRepo, type TestWorkspace, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

class MeasuringIgnoreWorktree extends CountingWorktree {
  discoveryCalls = 0;
  discoveryStatements = 0;
  contentCalls = 0;
  contentStatements = 0;

  constructor(
    inner: Worktree,
    private readonly storage: SqliteTestStorage,
  ) {
    super(inner);
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
    return page;
  }

  override readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch {
    const before = this.storage.statementCount;
    const batch = super.readFileHandles(handles, options);
    this.contentCalls++;
    this.contentStatements += this.storage.statementCount - before;
    return batch;
  }
}

class SplitReadWorktree extends MeasuringIgnoreWorktree {
  override readFileHandles(handles: readonly RegularFileHandle[]): HandleReadBatch {
    const first = handles[0];
    if (first === undefined) return { files: new Map<RealPath, Uint8Array>(), remaining: [] };
    const batch = super.readFileHandles([first]);
    return { files: batch.files, remaining: [...batch.remaining, ...handles.slice(1)] };
  }
}

class StalledIgnoreWorktree extends CountingWorktree {
  override readFileHandles(handles: readonly RegularFileHandle[]): HandleReadBatch {
    return {
      files: new Map<RealPath, Uint8Array>(),
      remaining: [...handles],
    };
  }
}

function writeIgnoreFiles(workspace: TestWorkspace, count: number, contents = "x\n"): void {
  const bytes = new TextEncoder().encode(contents);
  const entries: { path: string; bytes: Uint8Array }[] = [];
  for (let index = 0; index < count; index++) {
    entries.push({ path: `/d${String(index).padStart(4, "0")}/.gitignore`, bytes });
  }
  workspace.worktree.writeFiles(entries);
}

function commentsOfSize(size: number): string {
  let remaining = size;
  let out = "";
  while (remaining >= 4_000) {
    out += `#${"x".repeat(3_998)}\n`;
    remaining -= 4_000;
  }
  if (remaining > 0) out += `#${"x".repeat(remaining - 1)}`;
  return out;
}

function expectLimit(work: () => void, resource: IgnoreLimitResource): IgnoreLimitError {
  try {
    work();
  } catch (error) {
    if (error instanceof IgnoreLimitError) {
      expect(error.code).toBe("E2BIG");
      expect(error.resource).toBe(resource);
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${resource} limit`);
}

function requiredPattern(source: string): IgnorePattern {
  const pattern = compilePattern(source);
  if (pattern === null) throw new Error(`pattern did not compile: ${source}`);
  return pattern;
}

function legacyTrieNodeCount(paths: readonly string[]): number {
  const sorted = [...paths].sort();
  let previous = "";
  let nodes = 0;
  for (const path of sorted) {
    let shared = 0;
    while (shared < previous.length && previous[shared] === path[shared]) shared++;
    nodes += path.length - shared;
    previous = path;
  }
  return nodes;
}

function maximumCollisionMatcher(): {
  matcher: WorktreeIgnoreMatcher;
  queryDirectory: string;
  sourceLength: number;
} {
  const sourceLength = 4_084;
  const shared = "s".repeat(sourceLength - 6);
  const pattern = requiredPattern("never");
  const rules = new Map<string, IgnorePattern[]>();
  for (let index = 0; index < IGNORE_LIMITS.files; index++) {
    rules.set(`${shared}${index.toString(36).padStart(6, "0")}`, [pattern]);
  }
  const collide: IgnoreSourceHashStep = () => 0;
  return {
    matcher: new WorktreeIgnoreMatcher(rules, [], collide),
    queryDirectory: `${shared}absent`,
    sourceLength,
  };
}

const ROOT_DISTRIBUTED_DYNAMIC = [
  "!.github/actions/*/dist",
  "packages/**/*.tgz",
  "rustc-ice-*.txt",
  ".github/**/node_modules",
  "*.log",
  "*.cpuprofile",
  "*.heapsnapshot",
  "test/**/out/*",
  "test/**/next-env.d.ts",
  "test/**/.next*",
  "test/tmp/**",
  "**/.idea",
  "**/.#*",
  "examples/**/out/*",
  "examples/**/.env*.local",
  "*.tsbuildinfo",
  "*storybook.log",
];

const NESTED_DISTRIBUTED_DYNAMIC = [
  "*.log",
  "npm-debug.log*",
  "yarn-debug.log*",
  "yarn-error.log*",
  "lerna-debug.log*",
  ".pnpm-debug.log*",
  "report.[0-9]*.[0-9]*.[0-9]*.[0-9]*.json",
  "*.pid",
  "*.seed",
  "*.pid.lock",
  "*.lcov",
  "*.tsbuildinfo",
  "*.tgz",
  ".pnp.*",
  ".vscode/*",
  "!.vscode/*.code-snippets",
  "*.vsix",
  ".vscode/*.code-snippets",
  "*.code-workspace",
];

function distributedCorpus(): {
  matcher: ReturnType<typeof loadIgnoreMatcher>;
  paths: string[];
  patterns: number;
  sourceFiles: number;
  workspace: TestWorkspace;
} {
  const workspace = makeRepo("/");
  const rootRules = [
    ...ROOT_DISTRIBUTED_DYNAMIC,
    ...Array.from({ length: 26 }, (_, index) => `root-literal-${index}`),
  ];
  const nestedRules = [
    ...NESTED_DISTRIBUTED_DYNAMIC,
    ...Array.from({ length: 59 }, (_, index) => `nested-literal-${index}`),
  ];
  const entries = [
    { path: "/.gitignore", bytes: new TextEncoder().encode(`${rootRules.join("\n")}\n`) },
    {
      path: "/examples/cms-payload/.gitignore",
      bytes: new TextEncoder().encode(`${nestedRules.join("\n")}\n`),
    },
    ...Array.from({ length: 327 }, (_, source) => {
      const count = source < 23 ? 17 : 16;
      const rules = Array.from({ length: count }, (_, rule) => `literal-${source}-${rule}`);
      return {
        path: `/distributed/d${String(source).padStart(3, "0")}/.gitignore`,
        bytes: new TextEncoder().encode(`${rules.join("\n")}\n`),
      };
    }),
  ];
  workspace.worktree.writeFiles(entries);
  workspace.storage.resetCounters();
  const matcher = loadIgnoreMatcher(workspace.worktree, "/");
  const longest =
    "turbopack/crates/turbopack-tests/tests/snapshot/intermediate-tree-shake/rename-side-effect-free-facade/output/53446_snapshot_intermediate-tree-shake_rename-side-effect-free-facade_input_cbcbaae7._.js.map";
  const paths = Array.from({ length: 24_252 }, (_, index) => {
    if (index === 0) return longest;
    if (index % 2 === 0) {
      return `examples/cms-payload/src/feature-${index % 101}/component-${index}.tsx`;
    }
    const source = index % 327;
    return `distributed/d${String(source).padStart(3, "0")}/literal-${source}-${index % 16}`;
  });
  const patterns = rootRules.length + nestedRules.length + 327 * 16 + 23;
  return { matcher, paths, patterns, sourceFiles: entries.length, workspace };
}

/**
 * Every case is checked against `git check-ignore`, so the oracle is git
 * itself rather than a reading of gitignore(5).
 */
const CASES: { name: string; files: Record<string, string>; paths: string[] }[] = [
  {
    name: "plain names and extensions",
    files: { ".gitignore": "*.log\nbuild\ntemp.txt\n" },
    paths: ["a.log", "deep/b.log", "build", "build/out.js", "temp.txt", "keep.txt", "logs/a.txt"],
  },
  {
    name: "anchoring",
    files: { ".gitignore": "/root-only.txt\ndocs/notes.md\nanywhere.txt\n" },
    paths: [
      "root-only.txt",
      "sub/root-only.txt",
      "docs/notes.md",
      "sub/docs/notes.md",
      "anywhere.txt",
      "sub/anywhere.txt",
    ],
  },
  {
    name: "directory-only patterns",
    files: { ".gitignore": "cache/\n" },
    paths: ["cache", "cache/x.txt", "cache.txt", "sub/cache/y.txt"],
  },
  {
    name: "negation",
    files: { ".gitignore": "*.log\n!keep.log\ndist/\n!dist/important.txt\n" },
    paths: ["a.log", "keep.log", "dist/important.txt", "dist/other.txt"],
  },
  {
    name: "double star",
    files: { ".gitignore": "**/node_modules\nsrc/**/generated\nvendor/**\n" },
    paths: [
      "node_modules",
      "a/b/node_modules",
      "src/generated",
      "src/a/b/generated",
      "vendor",
      "vendor/x/y.txt",
      "src/keep.ts",
    ],
  },
  {
    name: "character classes and question marks",
    files: { ".gitignore": "file?.txt\n*.[oa]\n[!x]ignored.txt\n" },
    paths: [
      "file1.txt",
      "file10.txt",
      "main.o",
      "main.a",
      "main.c",
      "yignored.txt",
      "xignored.txt",
    ],
  },
  {
    name: "nested gitignore overrides its parent",
    files: {
      ".gitignore": "*.txt\n",
      "sub/.gitignore": "!allowed.txt\n",
      "other/.gitignore": "*.md\n",
    },
    paths: ["a.txt", "sub/a.txt", "sub/allowed.txt", "other/b.md", "b.md"],
  },
  {
    name: "comments, blanks and escapes",
    files: { ".gitignore": "# a comment\n\n\\#hash.txt\ntrailing   \n" },
    paths: ["#hash.txt", "trailing", "a comment"],
  },
  {
    name: "ranges, escaped wildcards and an unclosed class",
    files: { ".gitignore": "file[0-9].txt\nliteral\\*.txt\nopen[\n" },
    paths: ["file7.txt", "filex.txt", "literal*.txt", "literalx.txt", "open[", "openx"],
  },
  {
    name: "reviewer wildcard and escape failures",
    files: { ".gitignore": "b*\\*\n**/*?.js\n[\\]]\ndangling\\\n" },
    paths: [
      "b*",
      "branch*",
      "branch",
      "x.js",
      "a/x.js",
      "a/.js",
      "]",
      "[",
      "dangling",
      "dangling\\",
    ],
  },
  {
    name: "UTF-8 byte widths for question marks",
    files: { ".gitignore": "one?\ntwo??\nfour????\n" },
    paths: ["onex", "oneé", "twoé", "two🙂", "four🙂", "fouréé"],
  },
  {
    name: "POSIX, negated, escaped and malformed classes",
    files: {
      ".gitignore": "digit[[:digit:]].txt\nnot-digit[![:digit:]].txt\nclose[\\]].txt\nbad[abc\n",
    },
    paths: [
      "digit7.txt",
      "digitx.txt",
      "not-digitx.txt",
      "not-digit7.txt",
      "close].txt",
      "closex.txt",
      "bad[abc",
    ],
  },
  {
    name: "all star forms and globstar boundaries",
    files: { ".gitignore": "***.tmp\nfoo/**\na/**/b\n***/\\*\n" },
    paths: [
      "*",
      "star/*",
      "star/deep/*",
      "x.tmp",
      "deep/x.tmp",
      "foo",
      "foo/a",
      "foo/a/b",
      "a/b",
      "a/x/b",
      "a/x/y/b",
      "a/x/c",
    ],
  },
  {
    name: "globstar paths wider than one mask word",
    files: { ".gitignore": "transforms/__testfixtures__/**/*.js\n" },
    paths: [
      "transforms/__testfixtures__/example.js",
      "transforms/__testfixtures__/nested/example.js",
      "transforms/__testfixtures__/nested/example.ts",
    ],
  },
  {
    name: "escaped slash and trailing slash",
    files: { ".gitignore": "escaped\\/path\ndir-only/\n" },
    paths: ["escaped/path", "escaped", "dir-only", "dir-only/file", "dir-only.txt"],
  },
  {
    name: "BOM, CRLF and escaped trailing spaces",
    files: {
      ".gitignore": "\uFEFFroot.txt\r\ntrimmed   \r\nliteral\\ \r\n",
      "nested/.gitignore": "\uFEFFnested.txt\r\n",
    },
    paths: ["root.txt", "trimmed", "literal ", "literal", "nested/nested.txt"],
  },
];

const fixtures: GitFixture[] = [];
const timingIt = process.env.KOMPJUTR_TIMING_GATE === "1" ? it : it.skip;
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

describe("gitignore", () => {
  for (const testCase of CASES) {
    it(`matches git check-ignore: ${testCase.name}`, () => {
      const fixture = new GitFixture().init();
      fixtures.push(fixture);
      const workspace = makeRepo("/");

      for (const [path, contents] of Object.entries(testCase.files)) {
        fixture.write(path, contents);
        writeWorkFile(workspace, `/${path}`, contents);
      }
      // A path that another path sits under is a directory on both sides;
      // check-ignore classifies directories differently from files.
      for (const path of testCase.paths) {
        const isDirectory = testCase.paths.some((other) => other.startsWith(`${path}/`));
        if (isDirectory) {
          fixture.write(`${path}/.keep`, "");
          workspace.worktree.makeDirectories([`/${path}`]);
          continue;
        }
        fixture.write(path, "x\n");
        writeWorkFile(workspace, `/${path}`, "x\n");
      }

      const matcher = loadIgnoreMatcher(workspace.worktree, "/");
      for (const path of testCase.paths) {
        const isDirectory = workspace.worktree.stat(`/${path}`)?.type === "dir";
        let expected: boolean;
        try {
          fixture.git("check-ignore", "-q", "--no-index", path);
          expected = true;
        } catch {
          expected = false;
        }
        expect(matcher.ignores(path, isDirectory), `${testCase.name}: ${path}`).toBe(expected);
      }
    });
  }

  it("discovers and reads all rules in one statement each regardless of depth", () => {
    for (const depth of [10, 100]) {
      const workspace = makeRepo("/");
      let directory = "";
      for (let index = 0; index < depth; index++) {
        directory += `/d${index}`;
        writeWorkFile(workspace, `${directory}/.gitignore`, `ignored-${index}\n`);
      }
      const measured = new MeasuringIgnoreWorktree(workspace.worktree, workspace.storage);
      workspace.storage.resetCounters();

      const matcher = loadIgnoreMatcher(measured, "/");

      expect(measured.discoveryCalls).toBe(1);
      expect(measured.discoveryStatements).toBe(1);
      expect(measured.contentCalls).toBe(1);
      expect(measured.contentStatements).toBe(1);
      // The aggregate includes incidental root resolution, not only source paging.
      expect(workspace.storage.statementCount).toBeLessThan(1_000);
      expect(matcher.ignores(`${directory.slice(1)}/ignored-${depth - 1}`, false)).toBe(true);

      workspace.storage.resetCounters();
      for (let index = 0; index < 50; index++) {
        matcher.ignores(`${directory.slice(1)}/file-${index}`, false);
      }
      expect(workspace.storage.statementCount).toBe(0);
    }
  });

  it("pages discovery and content reads through the file-count ceiling", () => {
    const workspace = makeRepo("/");
    writeIgnoreFiles(workspace, IGNORE_LIMITS.files);
    const measured = new MeasuringIgnoreWorktree(workspace.worktree, workspace.storage);
    workspace.storage.resetCounters();

    loadIgnoreMatcher(measured, "/");

    const contentPages = IGNORE_LIMITS.files / IGNORE_LIMITS.discoveryPage;
    expect(measured.discoveryCalls).toBe(contentPages);
    expect(measured.discoveryStatements).toBe(contentPages);
    expect(measured.contentCalls).toBe(contentPages);
    expect(measured.contentStatements).toBe(contentPages);
    // The aggregate includes incidental root resolution, not only source paging.
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("fails closed when discovery proves there is a 1,025th file", () => {
    const workspace = makeRepo("/");
    writeIgnoreFiles(workspace, IGNORE_LIMITS.files + 1);
    const measured = new MeasuringIgnoreWorktree(workspace.worktree, workspace.storage);
    workspace.storage.resetCounters();

    const error = expectLimit(() => loadIgnoreMatcher(measured, "/"), "files");

    expect(error.observed).toBe(IGNORE_LIMITS.files + 1);
    const contentPages = IGNORE_LIMITS.files / IGNORE_LIMITS.discoveryPage;
    expect(measured.discoveryCalls).toBe(contentPages);
    expect(measured.contentCalls).toBe(contentPages - 1);
  });

  it("does not follow a symlink named .gitignore", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("rules", "*.log\n");
    fixture.symlink("rules", ".gitignore");
    fixture.write("a.log", "x\n");

    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/rules", "*.log\n");
    workspace.worktree.symlink("rules", "/.gitignore");
    writeWorkFile(workspace, "/a.log", "x\n");

    const git = spawnSync("git", ["check-ignore", "-q", "--no-index", "a.log"], {
      cwd: fixture.dir,
    });
    expect(git.status).toBe(1);
    expect(loadIgnoreMatcher(workspace.worktree, "/").ignores("a.log", false)).toBe(false);
  });

  it("retries content reads until every discovered rule file is loaded", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a/.gitignore", "*.a\n");
    writeWorkFile(workspace, "/b/.gitignore", "*.b\n");
    const measured = new SplitReadWorktree(workspace.worktree, workspace.storage);
    workspace.storage.resetCounters();

    const matcher = loadIgnoreMatcher(measured, "/");

    expect(measured.discoveryCalls).toBe(1);
    expect(measured.contentCalls).toBe(2);
    expect(measured.contentStatements).toBe(2);
    expect(matcher.ignores("a/file.a", false)).toBe(true);
    expect(matcher.ignores("b/file.b", false)).toBe(true);
  });

  it("continues handle-read retries after the former eighth statement", () => {
    const workspace = makeRepo("/");
    writeIgnoreFiles(workspace, 9);
    const split = new SplitReadWorktree(workspace.worktree, workspace.storage);

    const matcher = loadIgnoreMatcher(split, "/");

    expect(split.contentCalls).toBe(9);
    expect(matcher.ignores("d0008/x", false)).toBe(true);
  });

  it("caps one file, aggregate bytes, physical lines and compiled patterns", () => {
    const oversized = makeRepo("/");
    writeWorkFile(oversized, "/.gitignore", "#".repeat(IGNORE_LIMITS.fileBytes + 1));
    expectLimit(() => loadIgnoreMatcher(oversized.worktree, "/"), "fileBytes");

    const aggregate = makeRepo("/");
    const part = `#${"x".repeat(200_000)}`;
    for (let index = 0; index < 5; index++) {
      writeWorkFile(aggregate, `/d${index}/.gitignore`, part);
    }
    expectLimit(() => loadIgnoreMatcher(aggregate.worktree, "/"), "rawBytes");

    const longLine = makeRepo("/");
    writeWorkFile(longLine, "/.gitignore", "x".repeat(IGNORE_LIMITS.patternBytes + 1));
    expectLimit(() => loadIgnoreMatcher(longLine.worktree, "/"), "patternBytes");

    const patterns = makeRepo("/");
    writeWorkFile(patterns, "/.gitignore", "x\n".repeat(IGNORE_LIMITS.patterns + 1));
    expectLimit(() => loadIgnoreMatcher(patterns.worktree, "/"), "patterns");

    const compiledBytes = makeRepo("/");
    const compiledLine = `${"x".repeat(4_000)}\n`;
    writeWorkFile(compiledBytes, "/.gitignore", compiledLine.repeat(32));
    writeWorkFile(compiledBytes, "/nested/.gitignore", compiledLine.repeat(33));
    expectLimit(() => loadIgnoreMatcher(compiledBytes.worktree, "/"), "compiledBytes");

    const wildcardSegments = makeRepo("/");
    writeWorkFile(
      wildcardSegments,
      "/.gitignore",
      "*?\n".repeat(IGNORE_LIMITS.wildcardSegments + 1),
    );
    expectLimit(() => loadIgnoreMatcher(wildcardSegments.worktree, "/"), "wildcardSegments");
  });

  it("charges extra patterns to the same fail-closed byte budget", () => {
    const workspace = makeRepo("/");
    workspace.storage.resetCounters();
    const extra = `#${"x".repeat(IGNORE_LIMITS.rawBytes)}`;

    const error = expectLimit(
      () => loadIgnoreMatcher(workspace.worktree, "/", { extra: [extra] }),
      "rawBytes",
    );

    expect(error.path).toBe("options.extra");
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("admits the distributed production-corpus shape without rejecting ordinary paths", () => {
    const { matcher, paths, patterns, sourceFiles, workspace } = distributedCorpus();

    for (const path of paths) matcher.ignores(path, false);

    expect(paths).toHaveLength(24_252);
    expect(patterns).toBe(5_376);
    expect(sourceFiles).toBe(329);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
  });

  it("gives a nested source precedence over more than 2,048 parent rules", () => {
    const parent = [
      ...Array.from({ length: 2_049 }, (_, index) => `never-${index}`),
      "target",
    ].join("\n");
    const fixture = new GitFixture()
      .init()
      .write(".gitignore", `${parent}\n`)
      .write("sub/.gitignore", "!target\n")
      .write("sub/target", "x");
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", `${parent}\n`);
    writeWorkFile(workspace, "/sub/.gitignore", "!target\n");

    expect(() => fixture.git("check-ignore", "-q", "--no-index", "sub/target")).toThrow();
    expect(loadIgnoreMatcher(workspace.worktree, "/").ignores("sub/target", false)).toBe(false);
  });

  it("fails instead of looping when a handle read makes no progress", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", "*.log\n");
    const stalled = new StalledIgnoreWorktree(workspace.worktree);

    expect(() => loadIgnoreMatcher(stalled, "/")).toThrowError(/made no progress/);
  });

  it("applies extra, root, nested and parent-barrier precedence exactly", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", "!root.txt\nblocked/\nlink/\n");
    writeWorkFile(workspace, "/nested/.gitignore", "!allowed.txt\nlast.txt\n!last.txt\n");
    workspace.worktree.symlink("target", "/link");
    const matcher = loadIgnoreMatcher(workspace.worktree, "/", {
      extra: ["root.txt\nnested/allowed.txt\n"],
    });

    expect(matcher.ignores("root.txt", false)).toBe(false);
    expect(matcher.ignores("nested/allowed.txt", false)).toBe(false);
    expect(matcher.ignores("nested/last.txt", false)).toBe(false);
    expect(matcher.ignores("blocked/reincluded.txt", false)).toBe(true);
    expect(matcher.ignores("link", false)).toBe(false);
  });

  it("matches git across a seeded 2,000-path differential corpus", () => {
    const rules = [
      ...Array.from({ length: 32 }, (_, index) => `literal-${index}`),
      ...Array.from({ length: 16 }, (_, index) => `file-${index}-*.txt`),
      "**/*?.js",
      "src/**/generated",
      "[[:digit:]]-report.[oa]",
      "escaped\\*name",
      "directory/",
      "!directory/keep.txt",
    ].join("\n");
    const fixture = new GitFixture().init().write(".gitignore", `${rules}\n`);
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", `${rules}\n`);
    const matcher = loadIgnoreMatcher(workspace.worktree, "/");

    let seed = 0x5eed1234;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const paths: string[] = [];
    for (let index = 0; index < 2_000; index++) {
      const depth = 1 + (next() % 4);
      const segments: string[] = [];
      for (let level = 0; level < depth; level++) {
        const value = next();
        const stem = value % 7 === 0 ? `literal-${value % 32}` : `file-${value % 16}-${value % 97}`;
        const suffix = value % 5 === 0 ? ".txt" : value % 11 === 0 ? ".js" : "";
        segments.push(`${stem}${suffix}`);
      }
      paths.push(segments.join("/"));
    }
    const oracle = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd: fixture.dir,
      input: `${paths.join("\0")}\0`,
      encoding: "utf8",
    });
    if (oracle.error !== undefined) throw oracle.error;
    const ignored = new Set(oracle.stdout.split("\0").filter((path) => path.length > 0));
    for (const path of paths) {
      expect(matcher.ignores(path, false), path).toBe(ignored.has(path));
    }
  });
});

describe("bounded ignore pattern matcher", () => {
  it("accepts every exact matcher boundary and rejects the next unit", () => {
    const empty = loadIgnoreMatcher(makeRepo("/").worktree, "/");
    expect(empty.ignores("x".repeat(IGNORE_LIMITS.queryBytes), false)).toBe(false);
    expectLimit(() => empty.ignores("x".repeat(IGNORE_LIMITS.queryBytes + 1), false), "queryBytes");
    expect(
      empty.ignores(
        Array.from({ length: IGNORE_LIMITS.querySegments }, () => "x").join("/"),
        false,
      ),
    ).toBe(false);
    expectLimit(
      () =>
        empty.ignores(
          Array.from({ length: IGNORE_LIMITS.querySegments + 1 }, () => "x").join("/"),
          false,
        ),
      "querySegments",
    );

    const wildcard = makeRepo("/");
    const runtimeWildcards = Array.from(
      { length: 32 },
      (_, index) => `*a[${"y".repeat(index + 1)}]`,
    );
    writeWorkFile(wildcard, "/.gitignore", `${runtimeWildcards.join("\n")}\n`);
    const wildcardMatcher = loadIgnoreMatcher(wildcard.worktree, "/");
    expect(wildcardMatcher.ignores(`${"x".repeat(125)}ay`, false)).toBe(true);
    const workError = expectLimit(
      () => wildcardMatcher.ignores(`${"x".repeat(126)}ay`, false),
      "matcherWork",
    );
    expect(workError.observed).toBe(IGNORE_LIMITS.matcherWork + 1);

    const patternCount = makeRepo("/");
    writeWorkFile(patternCount, "/.gitignore", "literal\n".repeat(IGNORE_LIMITS.patterns));
    loadIgnoreMatcher(patternCount.worktree, "/");
    writeWorkFile(patternCount, "/.gitignore", "literal\n".repeat(IGNORE_LIMITS.patterns + 1));
    expectLimit(() => loadIgnoreMatcher(patternCount.worktree, "/"), "patterns");

    const compiled = makeRepo("/");
    const exactCompiled = Array.from(
      { length: 64 },
      (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(3_998)}`,
    );
    writeWorkFile(compiled, "/.gitignore", `${exactCompiled.slice(0, 32).join("\n")}\n`);
    writeWorkFile(compiled, "/nested/.gitignore", `${exactCompiled.slice(32).join("\n")}\n`);
    loadIgnoreMatcher(compiled.worktree, "/");
    exactCompiled[63] = `${exactCompiled[63]}x`;
    writeWorkFile(compiled, "/nested/.gitignore", `${exactCompiled.slice(32).join("\n")}\n`);
    const compiledError = expectLimit(
      () => loadIgnoreMatcher(compiled.worktree, "/"),
      "compiledBytes",
    );
    expect(compiledError.observed).toBe(IGNORE_LIMITS.compiledBytes + 1);

    const patternBytes = makeRepo("/");
    writeWorkFile(patternBytes, "/.gitignore", "x".repeat(IGNORE_LIMITS.patternBytes));
    loadIgnoreMatcher(patternBytes.worktree, "/");
    writeWorkFile(patternBytes, "/.gitignore", "x".repeat(IGNORE_LIMITS.patternBytes + 1));
    expectLimit(() => loadIgnoreMatcher(patternBytes.worktree, "/"), "patternBytes");

    const fileBytes = makeRepo("/");
    writeWorkFile(fileBytes, "/.gitignore", commentsOfSize(IGNORE_LIMITS.fileBytes));
    loadIgnoreMatcher(fileBytes.worktree, "/");
    writeWorkFile(fileBytes, "/.gitignore", commentsOfSize(IGNORE_LIMITS.fileBytes + 1));
    expectLimit(() => loadIgnoreMatcher(fileBytes.worktree, "/"), "fileBytes");

    const rawBytes = makeRepo("/");
    for (let index = 0; index < 5; index++) {
      writeWorkFile(rawBytes, `/r${index}/.gitignore`, commentsOfSize(200_000));
    }
    loadIgnoreMatcher(rawBytes.worktree, "/");
    writeWorkFile(rawBytes, "/r4/.gitignore", commentsOfSize(200_001));
    expectLimit(() => loadIgnoreMatcher(rawBytes.worktree, "/"), "rawBytes");

    const nfa = makeRepo("/");
    const atLimit = Array.from({ length: 512 }, () => "abc/**/*");
    writeWorkFile(nfa, "/.gitignore", `${atLimit.join("\n")}\n`);
    loadIgnoreMatcher(nfa.worktree, "/");
    writeWorkFile(nfa, "/.gitignore", `${[...atLimit, "abc/**/*"].join("\n")}\n`);
    const nfaError = expectLimit(() => loadIgnoreMatcher(nfa.worktree, "/"), "totalNfaStates");
    expect(nfaError.observed).toBe(IGNORE_LIMITS.totalNfaStates + 8);

    const exactNfa = makeRepo("/");
    const exactRule = `a/**/${"b".repeat(59)}`;
    const exactPath = `a/x/${"b".repeat(59)}`;
    const exactGit = new GitFixture()
      .init()
      .write(".gitignore", `${exactRule}\n`)
      .write(exactPath, "x");
    fixtures.push(exactGit);
    expect(() => exactGit.git("check-ignore", "-q", "--no-index", exactPath)).not.toThrow();
    writeWorkFile(exactNfa, "/.gitignore", `${exactRule}\n`);
    expect(loadIgnoreMatcher(exactNfa.worktree, "/").ignores(exactPath, false)).toBe(true);

    const oversizedNfa = makeRepo("/");
    const oversizedRule = `a/**/${"b".repeat(60)}`;
    const oversizedPath = `a/x/${"b".repeat(60)}`;
    const git = new GitFixture()
      .init()
      .write(".gitignore", `${oversizedRule}\n`)
      .write(oversizedPath, "x");
    fixtures.push(git);
    expect(() => git.git("check-ignore", "-q", "--no-index", oversizedPath)).not.toThrow();
    writeWorkFile(oversizedNfa, "/.gitignore", `${oversizedRule}\n`);
    const oversizedNfaError = expectLimit(
      () => loadIgnoreMatcher(oversizedNfa.worktree, "/"),
      "nfaStates",
    );
    expect(oversizedNfaError.observed).toBeGreaterThan(IGNORE_LIMITS.nfaStates);
  });

  it("handles maximum-length wildcard input without recursion", () => {
    const pattern = compilePattern("?".repeat(IGNORE_LIMITS.patternBytes));
    if (pattern === null) throw new Error("pattern did not compile");

    expect(pattern.test("x".repeat(IGNORE_LIMITS.patternBytes))).toBe(true);
    expect(pattern.test("x".repeat(IGNORE_LIMITS.patternBytes - 1))).toBe(false);
  });

  it("keeps globstars, ranges, escapes and unclosed classes bounded", () => {
    const cases: { pattern: string; path: string; expected: boolean }[] = [
      { pattern: "src/**/generated", path: "src/a/b/generated", expected: true },
      { pattern: "vendor/**", path: "vendor/a/b", expected: true },
      { pattern: "file[0-9].txt", path: "deep/file7.txt", expected: true },
      { pattern: "\\!literal", path: "!literal", expected: true },
      { pattern: "open[", path: "open[", expected: false },
      { pattern: "*.txt", path: "deep/file.txt", expected: true },
      {
        pattern: "transforms/__testfixtures__/**/*.js",
        path: "transforms/__testfixtures__/nested/example.js",
        expected: true,
      },
      { pattern: "*.txt", path: "deep/file.txt/more", expected: false },
    ];

    for (const testCase of cases) {
      const pattern = compilePattern(testCase.pattern);
      if (pattern === null) throw new Error(`pattern did not compile: ${testCase.pattern}`);
      expect(pattern.test(testCase.path), testCase.pattern).toBe(testCase.expected);
    }
  });

  it("stores low-sharing maximum-length source paths once in a flat index", () => {
    const sourceLength = 4_084;
    const directories = Array.from({ length: IGNORE_LIMITS.files }, (_, index) => {
      const prefix = `${index.toString(36).padStart(4, "0")}-`;
      return `${prefix}${"x".repeat(sourceLength - prefix.length)}`;
    });
    const pattern = requiredPattern("never");
    const rules = new Map<string, IgnorePattern[]>();
    for (const directory of directories) rules.set(directory, [pattern]);

    const matcher = new WorktreeIgnoreMatcher(rules, []);
    const stats = matcher.sourceIndexStats();
    const legacyNodes = legacyTrieNodeCount(directories);

    expect(stats).toEqual({
      sources: IGNORE_LIMITS.files,
      buckets: IGNORE_LIMITS.files,
      bucketEntries: IGNORE_LIMITS.files,
      sourceBytes: IGNORE_LIMITS.files * sourceLength,
      maxBucketEntries: 1,
    });
    expect(legacyNodes * 24).toBeGreaterThan(100_000_000);
  });

  it("verifies exact source bytes inside a hash-collision bucket", () => {
    const collide: IgnoreSourceHashStep = () => 0;
    const matcher = new WorktreeIgnoreMatcher(
      new Map([
        ["alpha", [requiredPattern("only-alpha")]],
        ["beta", [requiredPattern("only-beta")]],
      ]),
      [],
      collide,
    );

    expect(matcher.sourceIndexStats()).toEqual({
      sources: 2,
      buckets: 1,
      bucketEntries: 2,
      sourceBytes: 9,
      maxBucketEntries: 2,
    });
    expect(matcher.ignores("alpha/only-alpha", false)).toBe(true);
    expect(matcher.ignores("alpha/only-beta", false)).toBe(false);
    expect(matcher.ignores("beta/only-beta", false)).toBe(true);
    expect(matcher.ignores("beta/only-alpha", false)).toBe(false);
  });

  it("charges every duplicate literal candidate before comparing it", () => {
    const workspace = makeRepo("/");
    const literal = "x".repeat(31);
    writeWorkFile(workspace, "/.gitignore", `${literal}\n`.repeat(7_812));
    const matcher = loadIgnoreMatcher(workspace.worktree, "/");

    const error = expectLimit(() => matcher.ignores(literal, false), "matcherWork");

    expect(error.observed).toBe(IGNORE_LIMITS.matcherWork + 1);
  });

  it("charges both sides of an adversarial literal hash collision", () => {
    const workspace = makeRepo("/");
    const control = makeRepo("/");
    const left = "c-026r5wh-dsd";
    const right = "c-1h8h1e5-111h";
    const unrelated = Array.from({ length: 7_300 }, (_, index) => `unrelated-${index}`);
    writeWorkFile(
      workspace,
      "/.gitignore",
      `${[
        ...Array.from({ length: 512 }, (_, index) => (index % 2 === 0 ? left : right)),
        ...unrelated,
      ].join("\n")}\n`,
    );
    writeWorkFile(
      control,
      "/.gitignore",
      `${[...Array.from({ length: 256 }, () => right), ...unrelated].join("\n")}\n`,
    );
    const matcher = loadIgnoreMatcher(workspace.worktree, "/");
    const controlMatcher = loadIgnoreMatcher(control.worktree, "/");

    const error = expectLimit(() => matcher.ignores(right, false), "matcherWork");

    expect(error.observed).toBe(IGNORE_LIMITS.matcherWork + 1);
    expect(controlMatcher.ignores(right, false)).toBe(true);
  });

  it("charges full source bytes for one-boundary hash collisions and fails closed", () => {
    const { matcher, queryDirectory, sourceLength } = maximumCollisionMatcher();
    const path = `${queryDirectory}/file`;

    const error = expectLimit(() => matcher.ignores(path, false), "matcherWork");
    expect(error.observed).toBe(new TextEncoder().encode(path).byteLength + sourceLength);
  });

  it("evaluates 63 maximum-length anchored deterministic rules without hidden token work", () => {
    const rule = `/?${"x".repeat(3_998)}?`;
    const rules = Array.from({ length: 63 }, () => rule);
    const workspace = makeRepo("/");
    const matcher = loadIgnoreMatcher(workspace.worktree, "/", { extra: [rules.join("\n")] });

    expect(new TextEncoder().encode(rule)).toHaveLength(4_001);
    expect(matcher.ignores("z", false)).toBe(false);
    const error = expectLimit(
      () =>
        loadIgnoreMatcher(workspace.worktree, "/", {
          extra: [[...rules, rule].join("\n")],
        }),
      "compiledBytes",
    );
    expect(error.observed).toBe(256_064);
  });

  it("admits 8,192 compiled-never rules without runtime dispatch", () => {
    const workspace = makeRepo("/");
    const rules = Array.from({ length: IGNORE_LIMITS.patterns }, () => "never\\");
    const matcher = loadIgnoreMatcher(workspace.worktree, "/", { extra: [rules.join("\n")] });

    expect(matcher.ignores("never", false)).toBe(false);
    const error = expectLimit(
      () =>
        loadIgnoreMatcher(workspace.worktree, "/", {
          extra: [[...rules, "never\\"].join("\n")],
        }),
      "patterns",
    );
    expect(error.observed).toBe(IGNORE_LIMITS.patterns + 1);
  });

  timingIt("loads and evaluates 100 and 1,000 unrelated paths at the work ceiling", () => {
    const workspace = makeRepo("/");
    const runtimeWildcards = Array.from(
      { length: 32 },
      (_, index) => `*a[${"y".repeat(index + 1)}]`,
    );
    writeWorkFile(workspace, "/.gitignore", `${runtimeWildcards.join("\n")}\n`);
    const path = "x".repeat(121);
    const run = (count: number): number => {
      const start = performance.now();
      const matcher = loadIgnoreMatcher(workspace.worktree, "/");
      for (let index = 0; index < count; index++) {
        expect(matcher.ignores(`${path}${String(index).padStart(4, "0")}ay`, false)).toBe(true);
      }
      return performance.now() - start;
    };
    run(10);
    const small = run(100);
    const large = run(1_000);
    expect(large).toBeLessThan(100);
    expect(large / small).toBeLessThanOrEqual(12);
  });

  timingIt("evaluates 1,000 paths against the distributed production-corpus shape", () => {
    const { matcher, paths } = distributedCorpus();
    const run = (count: number): number => {
      const start = performance.now();
      for (let index = 0; index < count; index++) {
        matcher.ignores(paths[index] ?? "missing", false);
      }
      return performance.now() - start;
    };
    run(10);
    const small = run(100);
    const large = run(1_000);

    expect(large).toBeLessThan(100);
    expect(large / small).toBeLessThanOrEqual(12);
  });

  timingIt("bounds anchored maximum-token and compiled-never dispatch", () => {
    const workspace = makeRepo("/");
    const anchoredRule = `/?${"x".repeat(3_998)}?`;
    const anchored = loadIgnoreMatcher(workspace.worktree, "/", {
      extra: [Array.from({ length: 63 }, () => anchoredRule).join("\n")],
    });
    const never = loadIgnoreMatcher(workspace.worktree, "/", {
      extra: [Array.from({ length: IGNORE_LIMITS.patterns }, () => "never\\").join("\n")],
    });
    const run = (matcher: ReturnType<typeof loadIgnoreMatcher>): number => {
      const start = performance.now();
      for (let index = 0; index < 1_000; index++) {
        expect(matcher.ignores(`z${index}`, false)).toBe(false);
      }
      return performance.now() - start;
    };
    run(anchored);
    run(never);

    expect(run(anchored)).toBeLessThan(100);
    expect(run(never)).toBeLessThan(100);
  });

  timingIt("indexes 1,024 long common-prefix rule sources before matching", () => {
    const workspace = makeRepo("/");
    const prefix = "p".repeat(2_000);
    const entries = Array.from({ length: IGNORE_LIMITS.files }, (_, index) => ({
      path: `/${prefix}-${String(index).padStart(4, "0")}/.gitignore`,
      bytes: new TextEncoder().encode("never\n"),
    }));
    workspace.worktree.writeFiles(entries);
    const matcher = loadIgnoreMatcher(workspace.worktree, "/");
    const path = `${prefix}-absent/file`;
    const run = (count: number): number => {
      const start = performance.now();
      for (let index = 0; index < count; index++) {
        expect(matcher.ignores(`${path}-${index}`, false)).toBe(false);
      }
      return performance.now() - start;
    };
    run(10);
    const small = run(100);
    const large = run(1_000);
    expect(large).toBeLessThan(100);
    expect(large / small).toBeLessThanOrEqual(12);
  });

  timingIt("fails one maximum-length source collision within bounded time", () => {
    const { matcher, queryDirectory } = maximumCollisionMatcher();
    const path = `${queryDirectory}/file`;

    const start = performance.now();
    expectLimit(() => matcher.ignores(path, false), "matcherWork");
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
  });
});
