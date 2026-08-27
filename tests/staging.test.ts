import { afterEach, describe, expect, it } from "vitest";

import { utf8, utf8Decoder } from "../src/core/bytes.js";
import type { GitContext } from "../src/core/context.js";
import { GitError, PathspecNotFoundError } from "../src/core/errors.js";
import { IGNORE_LIMITS } from "../src/core/ignore/index.js";
import { hashObject } from "../src/core/objects.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { add, lsFiles, reset, rm } from "../src/core/ops/staging.js";
import type { Repository } from "../src/core/repository.js";
import type {
  SelectedPathResult,
  SparseIndexAncestorResult,
} from "../src/core/sparse-workspace.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import {
  createSqliteSelectedPathSource,
  createSqliteSparseWorkspaceSource,
} from "../src/sqlite/sparse-workspace.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

/**
 * The oracle throughout is `git ls-files -s`, which prints
 * `<mode> <oid> <stage>\t<path>` with the mode as six octal digits. Our
 * index stores the mode as a number, so render it the same way: `0o100644`
 * back to base 8 is already "100644", and the pad only guards a hypothetical
 * short mode.
 */
function indexLines(repo: Repository): string[] {
  return repo.checkout
    .indexEntries()
    .map(
      (entry) =>
        `${entry.mode.toString(8).padStart(6, "0")} ${entry.oid} ${entry.stage}\t${entry.path}`,
    );
}

function gitIndexLines(fixture: GitFixture): string[] {
  const output = fixture.git("ls-files", "-s");
  return output === "" ? [] : output.split("\n");
}

const fixtures: GitFixture[] = [];

function newFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

class RecordingIndexAncestorDatabase implements SqlDatabase {
  constructor(
    private readonly delegate: SqlDatabase,
    private readonly queries: string[],
  ) {}

  run(query: string, ...bindings: unknown[]): void {
    this.delegate.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.delegate.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.delegate.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.delegate.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    this.queries.push(query);
    return this.delegate.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.delegate.transactionSync(closure);
  }
}

/** A workspace whose objects, refs, working tree and index match a fixture's HEAD. */
async function clonedFrom(fixture: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/");
  await importFixture(fixture, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  // The fixture clock is frozen, so a later same-size edit would land on the
  // checkout's own mtime and read as clean — git's racily-clean window.
  workspace.tick(1000);
  return workspace;
}

function writeBoth(
  workspace: TestRepository,
  fixture: GitFixture,
  path: string,
  content: string,
): void {
  writeWorkFile(workspace, `/${path}`, content);
  fixture.write(path, content);
}

function removeBoth(workspace: TestRepository, fixture: GitFixture, path: string): void {
  workspace.worktree.unlink(`/${path}`);
  fixture.remove(path);
}

function nativeAddContext(
  workspace: TestRepository,
  statementCounts?: number[],
  rowCounts?: number[],
  ancestorStatementCounts?: number[],
  ancestorRowCounts?: number[],
  ancestorQueries?: string[],
): Pick<GitContext, "selectedPaths" | "sparseWorkspace"> {
  const source = createSqliteSelectedPathSource(workspace.database.db);
  const ancestorDatabase =
    ancestorQueries === undefined
      ? workspace.database.db
      : new RecordingIndexAncestorDatabase(workspace.database.db, ancestorQueries);
  const sparseWorkspace = createSqliteSparseWorkspaceSource(ancestorDatabase);
  const indexAncestorFacts = sparseWorkspace.indexAncestorFacts;
  if (indexAncestorFacts === undefined) throw new Error("native ancestor source is unavailable");
  return {
    sparseWorkspace: {
      ...sparseWorkspace,
      indexAncestorFacts(request) {
        const before = workspace.storage.statementCount;
        const rowsBefore = workspace.storage.rowCount;
        const result = indexAncestorFacts(request);
        ancestorStatementCounts?.push(workspace.storage.statementCount - before);
        ancestorRowCounts?.push(workspace.storage.rowCount - rowsBefore);
        return result;
      },
    },
    selectedPaths: {
      select(request) {
        const before = workspace.storage.statementCount;
        const rowsBefore = workspace.storage.rowCount;
        const result = source.select(request);
        statementCounts?.push(workspace.storage.statementCount - before);
        rowCounts?.push(workspace.storage.rowCount - rowsBefore);
        return result;
      },
    },
  };
}

type AvailableSelectedPathResult = Extract<SelectedPathResult, { available: true }>;

function fakeSelectedAddResult(
  workspace: TestRepository,
  path: string,
): AvailableSelectedPathResult {
  const stat = workspace.worktree.stat(`/${path}`);
  if (stat === null) throw new Error(`missing fake selected path: ${path}`);
  return {
    available: true,
    index: [
      {
        path,
        stage: 0,
        mode: 0o100644,
        oid: hashObject("blob", utf8.encode("indexed\n")),
        size: stat.size,
        mtime: stat.mtime,
        ino: stat.ino,
        rev: stat.rev,
      },
    ],
    worktree: [{ path, stat }],
    retainedBytes: 1_000_000,
  };
}

function requireFakeIndex(result: AvailableSelectedPathResult) {
  const entry = result.index[0];
  if (entry === undefined) throw new Error("missing fake selected index row");
  return entry;
}

function requireFakeWorktree(result: AvailableSelectedPathResult) {
  const entry = result.worktree[0];
  if (entry === undefined) throw new Error("missing fake selected worktree row");
  return entry;
}

function fakeAncestorResult(paths: readonly string[]): SparseIndexAncestorResult {
  return {
    facts: paths.map((path) => ({ path, exact: false, descendant: false })),
    retainedBytes: 10_000,
  };
}

describe("add", () => {
  it("stages mixed exact, overlapping directory, conflict, and non-BMP paths like git", () => {
    const fixture = newFixture();
    fixture.git("config", "core.quotePath", "false");
    const workspace = makeRepo("/");
    const astral = "\u{10000}.txt";
    const bmp = "\ue000.txt";
    const files: ReadonlyArray<readonly [string, string]> = [
      ["exact.txt", "exact\n"],
      ["dir/a.txt", "a\n"],
      ["dir/nested/b.txt", "b\n"],
      [astral, "astral\n"],
      [bmp, "bmp\n"],
      ["conflict.txt", "resolved\n"],
      ["unrelated.txt", "unrelated\n"],
    ];
    for (const [path, content] of files) {
      writeBoth(workspace, fixture, path, content);
    }
    const conflictRows: string[] = [];
    for (const stage of [1, 2, 3]) {
      const content = `stage ${stage}\n`;
      const oid = hashObject("blob", utf8.encode(content));
      workspace.repo.checkout.indexPut({
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      });
      expect(fixture.gitInput(content, "hash-object", "-w", "--stdin")).toBe(oid);
      conflictRows.push(`100644 ${oid} ${stage}\tconflict.txt`);
    }
    fixture.gitInput(`${conflictRows.join("\n")}\n`, "update-index", "--index-info");
    const specs = [bmp, "dir/nested", "exact.txt", "dir", astral, "conflict.txt"];
    const sourceStatements: number[] = [];

    add(
      workspace.repo,
      workspace.worktree,
      { paths: specs },
      nativeAddContext(workspace, sourceStatements),
    );
    fixture.git("add", "--", ...specs);

    expect(sourceStatements).toEqual([2, 2]);
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).not.toContain("unrelated.txt");
  });

  it("stages both file-directory replacement directions like git", async () => {
    const fixture = newFixture();
    fixture.write("to-dir", "old file\n");
    fixture.write("to-file/old.txt", "old child\n");
    fixture.commit("base");
    const workspace = await clonedFrom(fixture);

    workspace.worktree.unlink("/to-dir");
    fixture.remove("to-dir");
    writeBoth(workspace, fixture, "to-dir/new.txt", "new child\n");
    workspace.worktree.removeFiles(["/to-file"], { recursive: true, force: true });
    fixture.remove("to-file");
    writeBoth(workspace, fixture, "to-file", "new file\n");
    const sourceStatements: number[] = [];

    add(
      workspace.repo,
      workspace.worktree,
      { paths: ["to-file", "to-dir"] },
      nativeAddContext(workspace, sourceStatements),
    );
    fixture.git("add", "--", "to-file", "to-dir");

    expect(sourceStatements).toEqual([2, 2]);
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
  });

  it("removes an indexed descendant when an exact worktree path is a file", () => {
    const workspace = makeRepo("/");
    const oldOid = workspace.repo.store.write("blob", utf8.encode("old\n"));
    workspace.repo.checkout.indexReplace([
      {
        path: "a",
        stage: 0,
        mode: 0o100644,
        oid: oldOid,
        size: null,
        mtime: null,
        ino: null,
      },
      {
        path: "a/b",
        stage: 0,
        mode: 0o100644,
        oid: oldOid,
        size: null,
        mtime: null,
        ino: null,
      },
    ]);
    writeWorkFile(workspace, "/a", "resolved\n");
    const sourceStatements: number[] = [];

    add(
      workspace.repo,
      workspace.worktree,
      { paths: ["a"] },
      nativeAddContext(workspace, sourceStatements),
    );

    expect(sourceStatements).toEqual([2, 2]);
    expect(workspace.repo.checkout.indexEntries()).toEqual([
      expect.objectContaining({
        path: "a",
        stage: 0,
        mode: 0o100644,
        oid: hashObject("blob", utf8.encode("resolved\n")),
      }),
    ]);
  });

  it("keeps native ignored and unmatched semantics without publishing partial index changes", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, ".gitignore", "*.log\n");
    writeBoth(workspace, fixture, "ignored.log", "ignored\n");
    writeBoth(workspace, fixture, "kept.txt", "kept\n");
    const context = nativeAddContext(workspace);

    add(workspace.repo, workspace.worktree, { paths: [".gitignore"] }, context);
    fixture.git("add", ".gitignore");
    add(workspace.repo, workspace.worktree, { paths: ["ignored.log"] }, context);
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));

    expect(() =>
      add(workspace.repo, workspace.worktree, { paths: ["kept.txt", "missing.txt"] }, context),
    ).toThrow(PathspecNotFoundError);
    expect(lsFiles(workspace.repo)).toEqual([".gitignore"]);

    add(workspace.repo, workspace.worktree, { paths: ["ignored.log"], force: true }, context);
    fixture.git("add", "-f", "ignored.log");
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
  });

  it("falls back after a selected source finds a symlink ancestor", () => {
    const workspace = makeRepo("/");
    workspace.repo.checkout.indexPut({
      path: "link/child.txt",
      stage: 0,
      mode: 0o100644,
      oid: workspace.repo.store.write("blob", utf8.encode("old\n")),
      size: null,
      mtime: null,
      ino: null,
    });
    workspace.worktree.symlink("target", "/link");
    const sourceStatements: number[] = [];

    add(
      workspace.repo,
      workspace.worktree,
      { paths: ["link/child.txt"] },
      nativeAddContext(workspace, sourceStatements),
    );

    expect(sourceStatements).toEqual([2]);
    expect(workspace.repo.checkout.indexEntries()).toEqual([]);
  });

  it("falls back before mutation when exact classification exceeds source capacity", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "a.txt", "a\n");
    writeBoth(workspace, fixture, "b.txt", "b\n");
    const selectedPaths = createSqliteSelectedPathSource(workspace.database.db);
    const sparseWorkspace = createSqliteSparseWorkspaceSource(workspace.database.db);

    add(
      workspace.repo,
      workspace.worktree,
      { paths: ["a.txt"] },
      {
        selectedPaths,
        sparseWorkspace: {
          ...sparseWorkspace,
          indexAncestorFacts() {
            throw new GitError("E2BIG", "injected selected ancestor capacity");
          },
        },
      },
    );
    fixture.git("add", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["a.txt"]);
  });

  it("rejects malformed ancestor success before index or object mutation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    writeWorkFile(workspace, "/b.txt", "b\n");
    const selectedPaths = createSqliteSelectedPathSource(workspace.database.db);
    const sparseWorkspace = createSqliteSparseWorkspaceSource(workspace.database.db);
    const corruptions: Array<{
      name: string;
      mutate: (result: SparseIndexAncestorResult) => void;
    }> = [
      { name: "facts shape", mutate: (result) => void Reflect.set(result, "facts", null) },
      {
        name: "sparse facts",
        mutate(result) {
          delete result.facts[0];
        },
      },
      { name: "fact shape", mutate: (result) => void Reflect.set(result.facts, "0", null) },
      {
        name: "fact path",
        mutate: (result) => void Reflect.set(result.facts[0] ?? {}, "path", "unrelated.txt"),
      },
      {
        name: "fact exact",
        mutate: (result) => void Reflect.set(result.facts[0] ?? {}, "exact", 1),
      },
      {
        name: "fact descendant",
        mutate: (result) => void Reflect.set(result.facts[0] ?? {}, "descendant", 1),
      },
      {
        name: "fact order",
        mutate(result) {
          result.facts.reverse();
        },
      },
      {
        name: "fact duplicate",
        mutate(result) {
          const first = result.facts[0];
          if (first === undefined) throw new Error("missing first fake ancestor fact");
          Reflect.set(result.facts[1] ?? {}, "path", first.path);
        },
      },
      { name: "retained type", mutate: (result) => void Reflect.set(result, "retainedBytes", 1.5) },
    ];

    for (const corruption of corruptions) {
      const beforeIndex = workspace.repo.checkout.indexEntries();
      const beforeObjects = workspace.repo.store.objectCount();
      expect(
        () =>
          add(
            workspace.repo,
            workspace.worktree,
            { paths: ["a.txt", "b.txt"] },
            {
              selectedPaths,
              sparseWorkspace: {
                ...sparseWorkspace,
                indexAncestorFacts() {
                  const result = fakeAncestorResult(["a.txt", "b.txt"]);
                  corruption.mutate(result);
                  return result;
                },
              },
            },
          ),
        corruption.name,
      ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
      expect(workspace.repo.checkout.indexEntries(), corruption.name).toEqual(beforeIndex);
      expect(workspace.repo.store.objectCount(), corruption.name).toBe(beforeObjects);
    }
  });

  it("rejects ancestor retained underreport before index or object mutation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    const beforeIndex = workspace.repo.checkout.indexEntries();
    const beforeObjects = workspace.repo.store.objectCount();
    const sparseWorkspace = createSqliteSparseWorkspaceSource(workspace.database.db);

    expect(() =>
      add(
        workspace.repo,
        workspace.worktree,
        { paths: ["a.txt"] },
        {
          selectedPaths: createSqliteSelectedPathSource(workspace.database.db),
          sparseWorkspace: {
            ...sparseWorkspace,
            indexAncestorFacts() {
              return { ...fakeAncestorResult(["a.txt"]), retainedBytes: 0 };
            },
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
    expect(workspace.repo.checkout.indexEntries()).toEqual(beforeIndex);
    expect(workspace.repo.store.objectCount()).toBe(beforeObjects);
  });

  it("rejects malformed selected success facts before index or object mutation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a/file.txt", "worktree\n");
    const sparseWorkspace = createSqliteSparseWorkspaceSource(workspace.database.db);
    const corruptions: Array<{
      name: string;
      mutate: (result: AvailableSelectedPathResult) => void;
    }> = [
      { name: "availability", mutate: (result) => void Reflect.set(result, "available", 1) },
      { name: "index array", mutate: (result) => void Reflect.set(result, "index", null) },
      { name: "worktree array", mutate: (result) => void Reflect.set(result, "worktree", null) },
      {
        name: "index cardinality",
        mutate(result) {
          const entry = requireFakeIndex(result);
          for (let stage = 0; stage < 4; stage++) result.index.push({ ...entry, stage });
        },
      },
      {
        name: "worktree cardinality",
        mutate(result) {
          result.worktree.push({ ...requireFakeWorktree(result) });
        },
      },
      {
        name: "index path",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "path", "/a"),
      },
      {
        name: "index stage",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "stage", 4),
      },
      {
        name: "index mode",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "mode", 0),
      },
      {
        name: "index oid",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "oid", "bad"),
      },
      {
        name: "index size",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "size", -1),
      },
      {
        name: "index mtime",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "mtime", 0.5),
      },
      {
        name: "index inode",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "ino", 0),
      },
      {
        name: "index revision",
        mutate: (result) => void Reflect.set(requireFakeIndex(result), "rev", -1),
      },
      {
        name: "worktree path",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result), "path", "/a"),
      },
      {
        name: "worktree stat",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result), "stat", null),
      },
      {
        name: "worktree type",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "type", "other"),
      },
      {
        name: "worktree mode",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "mode", -1),
      },
      {
        name: "worktree size",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "size", -1),
      },
      {
        name: "worktree mtime",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "mtime", 0.5),
      },
      {
        name: "worktree inode",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "ino", 0),
      },
      {
        name: "worktree links",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "nlink", 0),
      },
      {
        name: "worktree revision",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "rev", -1),
      },
      {
        name: "worktree target",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "target", "bad"),
      },
      {
        name: "worktree content id",
        mutate: (result) => void Reflect.set(requireFakeWorktree(result).stat, "contentId", "bad"),
      },
      {
        name: "directory payload",
        mutate(result) {
          Reflect.set(requireFakeWorktree(result).stat, "type", "dir");
        },
      },
      {
        name: "symlink payload",
        mutate(result) {
          Reflect.set(requireFakeWorktree(result).stat, "type", "symlink");
        },
      },
    ];

    for (const corruption of corruptions) {
      const beforeIndex = workspace.repo.checkout.indexEntries();
      const beforeObjects = workspace.repo.store.objectCount();
      expect(
        () =>
          add(
            workspace.repo,
            workspace.worktree,
            { paths: ["a/file.txt"] },
            {
              sparseWorkspace,
              selectedPaths: {
                select() {
                  const result = fakeSelectedAddResult(workspace, "a/file.txt");
                  corruption.mutate(result);
                  return result;
                },
              },
            },
          ),
        corruption.name,
      ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
      expect(workspace.repo.checkout.indexEntries(), corruption.name).toEqual(beforeIndex);
      expect(workspace.repo.store.objectCount(), corruption.name).toBe(beforeObjects);
    }
  });

  it("rejects selected ordering, relation, duplicates, and retained underreport before mutation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a/file.txt", "worktree\n");
    const cases: Array<{
      name: string;
      mutate: (result: AvailableSelectedPathResult) => void;
    }> = [
      {
        name: "index duplicate",
        mutate(result) {
          result.index.push({ ...requireFakeIndex(result) });
        },
      },
      {
        name: "index order",
        mutate(result) {
          const entry = requireFakeIndex(result);
          Reflect.set(entry, "path", "a/z.txt");
          result.index.push({ ...entry, path: "a/a.txt", stage: 1 });
        },
      },
      {
        name: "worktree duplicate",
        mutate(result) {
          result.worktree.push({ ...requireFakeWorktree(result) });
        },
      },
      {
        name: "worktree order",
        mutate(result) {
          const entry = requireFakeWorktree(result);
          Reflect.set(entry, "path", "a/z.txt");
          result.worktree.push({ ...entry, path: "a/a.txt" });
        },
      },
      {
        name: "unrelated path",
        mutate(result) {
          Reflect.set(requireFakeIndex(result), "path", "b/file.txt");
        },
      },
      {
        name: "retained underreport",
        mutate(result) {
          result.retainedBytes = 0;
        },
      },
    ];

    for (const testCase of cases) {
      const beforeIndex = workspace.repo.checkout.indexEntries();
      const beforeObjects = workspace.repo.store.objectCount();
      expect(
        () =>
          add(
            workspace.repo,
            workspace.worktree,
            { paths: ["a"] },
            {
              selectedPaths: {
                select() {
                  const result = fakeSelectedAddResult(workspace, "a/file.txt");
                  testCase.mutate(result);
                  return result;
                },
              },
            },
          ),
        testCase.name,
      ).toThrow(expect.objectContaining({ code: "ECORRUPT" }));
      expect(workspace.repo.checkout.indexEntries(), testCase.name).toEqual(beforeIndex);
      expect(workspace.repo.store.objectCount(), testCase.name).toBe(beforeObjects);
    }
  });

  it("stages a single new file the way git does", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "a.txt", "a\n");
    writeBoth(workspace, fixture, "b.txt", "b\n");

    add(workspace.repo, workspace.worktree, { paths: ["a.txt"] });
    fixture.git("add", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["a.txt"]);
  });

  it("stages a directory pathspec the way git does", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "src/a.ts", "export const a = 1;\n");
    writeBoth(workspace, fixture, "src/nested/b.ts", "export const b = 2;\n");
    writeBoth(workspace, fixture, "top.txt", "top\n");

    add(workspace.repo, workspace.worktree, { paths: ["src"] });
    fixture.git("add", "src");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("does not load ignore rules when updating tracked paths", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/tracked.txt", "one\n");
    add(workspace.repo, workspace.worktree, { paths: ["tracked.txt"], force: true });
    writeWorkFile(workspace, "/.gitignore", "*?\n".repeat(IGNORE_LIMITS.wildcardSegments + 1));
    writeWorkFile(workspace, "/tracked.txt", "two\n");

    add(workspace.repo, workspace.worktree, { paths: ["tracked.txt"] });

    expect(workspace.repo.checkout.indexGet("tracked.txt")?.oid).toBe(
      hashObject("blob", utf8.encode("two\n")),
    );
    writeWorkFile(workspace, "/new.txt", "new\n");
    expect(() => add(workspace.repo, workspace.worktree, { paths: ["new.txt"] })).toThrow(
      /wildcardSegments/,
    );
  });

  it("stages new, modified and deleted tracked files with all", async () => {
    const fixture = newFixture();
    fixture.write("keep.txt", "keep\n");
    fixture.write("mod.txt", "one\n");
    fixture.write("gone.txt", "gone\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "mod.txt", "two\n");
    writeBoth(workspace, fixture, "sub/new.txt", "new\n");
    removeBoth(workspace, fixture, "gone.txt");

    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["keep.txt", "mod.txt", "sub/new.txt"]);
  });

  it("stages an executable file as 100755", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    workspace.worktree.writeFile("/run.sh", new TextEncoder().encode("#!/bin/sh\necho hi\n"), {
      mode: 0o755,
    });
    fixture.writeExecutable("run.sh", "#!/bin/sh\necho hi\n");

    add(workspace.repo, workspace.worktree, { paths: ["run.sh"] });
    fixture.git("add", "run.sh");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(indexLines(workspace.repo)[0]).toMatch(/^100755 /);
  });

  it("stages a symlink as 120000", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "target.txt", "t\n");
    workspace.worktree.symlink("target.txt", "/link");
    fixture.symlink("target.txt", "link");

    add(workspace.repo, workspace.worktree, { paths: ["."] });
    fixture.git("add", ".");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(indexLines(workspace.repo).some((line) => line.startsWith("120000 "))).toBe(true);
  });

  it("leaves untracked files alone when trackedOnly is set", async () => {
    const fixture = newFixture();
    fixture.write("tracked.txt", "one\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "tracked.txt", "two\n");
    writeBoth(workspace, fixture, "untracked.txt", "new\n");

    add(workspace.repo, workspace.worktree, { paths: [], all: true, trackedOnly: true });
    fixture.git("add", "-u");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["tracked.txt"]);
  });

  it("skips an ignored path unless force is set", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, ".gitignore", "*.log\n");
    writeBoth(workspace, fixture, "x.log", "noisy\n");

    add(workspace.repo, workspace.worktree, { paths: [".gitignore"] });
    fixture.git("add", ".gitignore");

    add(workspace.repo, workspace.worktree, { paths: ["x.log"] });
    expect(lsFiles(workspace.repo)).toEqual([".gitignore"]);

    add(workspace.repo, workspace.worktree, { paths: ["x.log"], force: true });
    fixture.git("add", "-f", "x.log");
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
  });

  it("reports a pathspec that matches nothing", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");

    expect(() => add(workspace.repo, workspace.worktree, { paths: ["nosuch.txt"] })).toThrow(
      PathspecNotFoundError,
    );
    expect(() => add(workspace.repo, workspace.worktree, { paths: ["a.txt", "nope/"] })).toThrow(
      /pathspec 'nope' did not match any files/,
    );
    expect(lsFiles(workspace.repo)).toEqual([]);
  });

  it("does nothing when the pathspec list is empty", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    add(workspace.repo, workspace.worktree, { paths: [] });
    expect(lsFiles(workspace.repo)).toEqual([]);
  });

  it("replaces conflict-only stages for present and deleted paths", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/present.txt", "resolved\n");
    for (const path of ["present.txt", "deleted.txt"]) {
      for (const stage of [1, 2, 3]) {
        workspace.repo.checkout.indexPut({
          path,
          stage,
          mode: 0o100644,
          oid: String(stage).repeat(40),
          size: null,
          mtime: null,
          ino: null,
        });
      }
    }

    add(workspace.repo, workspace.worktree, { paths: [], all: true });

    expect(workspace.repo.checkout.indexEntries()).toEqual([
      expect.objectContaining({
        path: "present.txt",
        stage: 0,
        oid: hashObject("blob", utf8.encode("resolved\n")),
      }),
    ]);
  });
});

describe("rm", () => {
  it("removes a clean tracked path from the index and working tree", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("base");
    const workspace = await clonedFrom(fixture);

    rm(workspace.repo, workspace.worktree, { paths: ["a.txt"] });
    fixture.git("rm", "-q", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["b.txt"]);
    expect(workspace.worktree.stat("/a.txt")).toBeNull();
  });

  it("keeps cached removals in the working tree", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "a.txt", "a\n");
    writeBoth(workspace, fixture, "b.txt", "b\n");
    add(workspace.repo, workspace.worktree, { paths: ["."] });
    fixture.git("add", ".");

    rm(workspace.repo, workspace.worktree, { paths: ["a.txt"], cached: true });
    fixture.git("rm", "--cached", "-q", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(workspace.worktree.stat("/a.txt")).not.toBeNull();
  });

  it("matches Git's HEAD/index/worktree safety matrix", async () => {
    const cases: Array<{
      name: string;
      stage?: string;
      worktree?: string;
      missing?: boolean;
      cached?: boolean;
      succeeds: boolean;
    }> = [
      { name: "staged", stage: "index\n", succeeds: false },
      { name: "worktree", worktree: "worktree\n", succeeds: false },
      { name: "both", stage: "index\n", worktree: "worktree\n", succeeds: false },
      { name: "already missing", missing: true, succeeds: true },
      { name: "staged then missing", stage: "index\n", missing: true, succeeds: true },
      { name: "cached staged", stage: "index\n", cached: true, succeeds: true },
      { name: "cached worktree", worktree: "worktree\n", cached: true, succeeds: true },
      {
        name: "cached both",
        stage: "index\n",
        worktree: "worktree\n",
        cached: true,
        succeeds: false,
      },
    ];

    for (const scenario of cases) {
      const fixture = newFixture();
      fixture.write("file.txt", "head\n");
      fixture.commit("base");
      const workspace = await clonedFrom(fixture);
      if (scenario.stage !== undefined) {
        writeBoth(workspace, fixture, "file.txt", scenario.stage);
        add(workspace.repo, workspace.worktree, { paths: ["file.txt"] });
        fixture.git("add", "file.txt");
      }
      if (scenario.worktree !== undefined) {
        writeBoth(workspace, fixture, "file.txt", scenario.worktree);
      }
      if (scenario.missing === true) removeBoth(workspace, fixture, "file.txt");

      const gitArgs = scenario.cached ? ["--cached", "-q", "file.txt"] : ["-q", "file.txt"];
      if (scenario.succeeds) {
        rm(workspace.repo, workspace.worktree, {
          paths: ["file.txt"],
          cached: scenario.cached,
        });
        fixture.git("rm", ...gitArgs);
        expect(indexLines(workspace.repo), scenario.name).toEqual(gitIndexLines(fixture));
      } else {
        expect(
          () =>
            rm(workspace.repo, workspace.worktree, {
              paths: ["file.txt"],
              cached: scenario.cached,
            }),
          scenario.name,
        ).toThrow(expect.objectContaining({ code: "EUNSAFEREMOVE" }));
        expect(() => fixture.git("rm", ...gitArgs), scenario.name).toThrow();
        expect(lsFiles(workspace.repo), scenario.name).toEqual(["file.txt"]);
        expect(workspace.worktree.stat("/file.txt"), scenario.name).not.toBeNull();
      }
    }
  });

  it("allows a newly staged missing path and requires force while it exists", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    writeBoth(workspace, fixture, "new.txt", "new\n");
    add(workspace.repo, workspace.worktree, { paths: ["new.txt"] });
    fixture.git("add", "new.txt");

    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["new.txt"] })).toThrow(
      expect.objectContaining({ code: "EUNSAFEREMOVE" }),
    );
    expect(() => fixture.git("rm", "-q", "new.txt")).toThrow();

    removeBoth(workspace, fixture, "new.txt");
    rm(workspace.repo, workspace.worktree, { paths: ["new.txt"] });
    fixture.git("rm", "-q", "new.txt");
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));

    const forcedFixture = newFixture();
    const forced = makeRepo("/");
    writeBoth(forced, forcedFixture, "new.txt", "new\n");
    add(forced.repo, forced.worktree, { paths: ["new.txt"] });
    forcedFixture.git("add", "new.txt");

    rm(forced.repo, forced.worktree, { paths: ["new.txt"], force: true });
    forcedFixture.git("rm", "-fq", "new.txt");
    expect(indexLines(forced.repo)).toEqual(gitIndexLines(forcedFixture));
    expect(forced.worktree.stat("/new.txt")).toBeNull();
  });

  it("requires recursive for directories and prunes only empty parents", async () => {
    const fixture = newFixture();
    fixture.write("dir/tracked.txt", "tracked\n");
    fixture.write("gone/nested/tracked.txt", "gone\n");
    fixture.commit("base");
    fixture.write("dir/untracked.txt", "untracked\n");
    const workspace = await clonedFrom(fixture);
    writeBoth(workspace, fixture, "dir/untracked.txt", "untracked\n");

    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["dir", "unmatched"] })).toThrow(
      expect.objectContaining({ code: "EISDIR" }),
    );
    expect(() => fixture.git("rm", "-q", "--", "dir", "unmatched")).toThrow(/not removing 'dir'/);
    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["unmatched", "dir"] })).toThrow(
      expect.objectContaining({ code: "EPATHSPEC" }),
    );
    expect(() => fixture.git("rm", "-q", "--", "unmatched", "dir")).toThrow(/pathspec 'unmatched'/);

    rm(workspace.repo, workspace.worktree, { paths: ["dir", "gone/"], recursive: true });
    fixture.git("rm", "-qr", "--", "dir", "gone/");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(workspace.worktree.stat("/gone")).toBeNull();
    expect(workspace.worktree.stat("/dir")?.type).toBe("dir");
    expect(utf8Decoder.decode(workspace.worktree.readFile("/dir/untracked.txt"))).toBe(
      "untracked\n",
    );
  });

  it("refuses an indexed file replaced by a working-tree directory", async () => {
    const cases = [
      { name: "plain", options: {}, git: [] },
      { name: "recursive", options: { recursive: true }, git: ["-r"] },
      {
        name: "recursive force",
        options: { recursive: true, force: true },
        git: ["-r", "-f"],
      },
    ];
    for (const scenario of cases) {
      const fixture = newFixture();
      fixture.write("file", "tracked\n");
      fixture.commit("base");
      const workspace = await clonedFrom(fixture);
      removeBoth(workspace, fixture, "file");
      writeBoth(workspace, fixture, "file/untracked.txt", "untracked\n");

      expect(
        () =>
          rm(workspace.repo, workspace.worktree, {
            paths: ["file"],
            ...scenario.options,
          }),
        scenario.name,
      ).toThrow(expect.objectContaining({ code: "EISDIR" }));
      expect(() => fixture.git("rm", "-q", ...scenario.git, "--", "file"), scenario.name).toThrow();
      expect(lsFiles(workspace.repo), scenario.name).toEqual(["file"]);
      expect(workspace.worktree.stat("/file/untracked.txt"), scenario.name).not.toBeNull();
    }
  });

  it("preserves whitespace and terminal-slash pathspec semantics", async () => {
    const fixture = newFixture();
    fixture.write(" file ", "spaces\n");
    fixture.write("file", "plain\n");
    fixture.commit("base");
    const workspace = await clonedFrom(fixture);

    rm(workspace.repo, workspace.worktree, { paths: [" file "] });
    fixture.git("rm", "-q", "--", " file ");
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(workspace.worktree.stat("/ file ")).toBeNull();

    expect(() =>
      rm(workspace.repo, workspace.worktree, { paths: ["file/"], recursive: true }),
    ).toThrow(expect.objectContaining({ code: "EPATHSPEC" }));
    expect(() => fixture.git("rm", "-qr", "--", "file/")).toThrow(/pathspec 'file\/'/);
    expect(lsFiles(workspace.repo)).toEqual(["file"]);
    expect(workspace.worktree.stat("/file")).not.toBeNull();
  });

  it("hashes authoritative bytes instead of trusting blob-id mappings", async () => {
    const fixture = newFixture();
    fixture.write("file.txt", "head\n");
    fixture.commit("base");
    const workspace = await clonedFrom(fixture);
    const entry = workspace.repo.checkout.indexGet("file.txt");
    if (entry === null) throw new Error("fixture index entry is missing");
    const forgedContentId = utf8.encode("forged-content-id");
    workspace.worktree.writeFiles([
      {
        path: "/file.txt",
        bytes: utf8.encode("different\n"),
        contentId: forgedContentId,
      },
    ]);
    workspace.repo.store.upsertBlobIds([{ contentId: forgedContentId, oid: entry.oid }]);

    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["file.txt"] })).toThrow(
      expect.objectContaining({ code: "EUNSAFEREMOVE" }),
    );

    expect(lsFiles(workspace.repo)).toEqual(["file.txt"]);
    expect(utf8Decoder.decode(workspace.worktree.readFile("/file.txt"))).toBe("different\n");
  });

  it("removes symlinks without following their targets", async () => {
    const fixture = newFixture();
    fixture.write("target.txt", "target\n");
    fixture.symlink("target.txt", "link");
    fixture.commit("base");
    const workspace = await clonedFrom(fixture);

    rm(workspace.repo, workspace.worktree, { paths: ["link"] });
    fixture.git("rm", "-q", "link");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(workspace.worktree.stat("/link")).toBeNull();
    expect(utf8Decoder.decode(workspace.worktree.readFile("/target.txt"))).toBe("target\n");
  });

  it("removes unmerged stages as a conflict resolution", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/conflict.txt", "conflict\n");
    for (const stage of [1, 2, 3]) {
      workspace.repo.checkout.indexPut({
        path: "conflict.txt",
        stage,
        mode: 0o100644,
        oid: String(stage).repeat(40),
        size: null,
        mtime: null,
        ino: null,
      });
    }

    rm(workspace.repo, workspace.worktree, { paths: ["conflict.txt"] });

    expect(workspace.repo.checkout.indexEntries()).toEqual([]);
    expect(workspace.worktree.stat("/conflict.txt")).toBeNull();
  });

  it("rolls filesystem and index removal back together", async () => {
    const fixture = newFixture();
    fixture.write("file.txt", "content\n");
    fixture.commit("base");
    const workspace = await clonedFrom(fixture);
    workspace.storage.db.exec(`CREATE TRIGGER fail_rm_index
      BEFORE DELETE ON git_index BEGIN SELECT RAISE(ABORT, 'injected index failure'); END`);

    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["file.txt"] })).toThrow(
      /injected index failure/,
    );

    expect(lsFiles(workspace.repo)).toEqual(["file.txt"]);
    expect(utf8Decoder.decode(workspace.worktree.readFile("/file.txt"))).toBe("content\n");
  });

  it("reports a pathspec that is not in the index", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/a.txt", "a\n");
    expect(() => rm(workspace.repo, workspace.worktree, { paths: ["a.txt"] })).toThrow(
      /pathspec 'a.txt' did not match any files/,
    );
  });

  it("bounds pathspec count, UTF-8 length, and retained state before mutation", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/file.txt", "content\n");
    add(workspace.repo, workspace.worktree, { paths: ["file.txt"] });
    const assertUnchanged = (): void => {
      expect(lsFiles(workspace.repo)).toEqual(["file.txt"]);
      expect(utf8Decoder.decode(workspace.worktree.readFile("/file.txt"))).toBe("content\n");
    };

    expect(() =>
      rm(workspace.repo, workspace.worktree, {
        paths: Array.from({ length: 10_001 }, () => "file.txt"),
        force: true,
      }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    assertUnchanged();

    expect(() =>
      rm(workspace.repo, workspace.worktree, {
        paths: ["x".repeat(2_201)],
        force: true,
      }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    assertUnchanged();

    const suffix = "y".repeat(2_080);
    expect(() =>
      rm(workspace.repo, workspace.worktree, {
        paths: Array.from(
          { length: 4_000 },
          (_, index) => `p${index.toString().padStart(4, "0")}-${suffix}`,
        ),
        force: true,
      }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));
    assertUnchanged();
  });
});

describe("reset", () => {
  it("resets listed paths back to HEAD and leaves the working tree alone", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "a.txt", "a changed\n");
    writeBoth(workspace, fixture, "c.txt", "c\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    reset(workspace.context, workspace.repo, workspace.worktree, { paths: ["a.txt"] });
    fixture.git("reset", "-q", "--", "a.txt");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(utf8Decoder.decode(workspace.worktree.readFile("/a.txt"))).toBe("a changed\n");
  });

  it("unstages everything when called bare", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    writeBoth(workspace, fixture, "a.txt", "a changed\n");
    writeBoth(workspace, fixture, "c.txt", "c\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    reset(workspace.context, workspace.repo, workspace.worktree, {});
    fixture.git("reset", "-q");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(lsFiles(workspace.repo)).toEqual(["a.txt"]);
    expect(workspace.worktree.stat("/c.txt")).not.toBeNull();
  });

  it("hard reset restores a deleted file and drops an added one", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "a\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("first");
    const workspace = await clonedFrom(fixture);

    removeBoth(workspace, fixture, "a.txt");
    writeBoth(workspace, fixture, "c.txt", "c\n");
    add(workspace.repo, workspace.worktree, { paths: [], all: true });
    fixture.git("add", "-A");

    reset(workspace.context, workspace.repo, workspace.worktree, { hard: true });
    fixture.git("reset", "--hard", "-q");

    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(utf8Decoder.decode(workspace.worktree.readFile("/a.txt"))).toBe("a\n");
    expect(workspace.worktree.stat("/c.txt")).toBeNull();
  });

  it("hard reset to a ref moves the current branch", async () => {
    const fixture = newFixture();
    fixture.write("a.txt", "one\n");
    fixture.commit("first");
    fixture.write("a.txt", "two\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("second");
    const workspace = await clonedFrom(fixture);

    reset(workspace.context, workspace.repo, workspace.worktree, {
      hard: true,
      ref: "HEAD~1",
    });
    fixture.git("reset", "--hard", "-q", "HEAD~1");

    expect(workspace.repo.resolveRef("refs/heads/main")).toBe(fixture.git("rev-parse", "HEAD"));
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(fixture));
    expect(utf8Decoder.decode(workspace.worktree.readFile("/a.txt"))).toBe("one\n");
    expect(workspace.worktree.stat("/b.txt")).toBeNull();
  });
});

describe("cost", () => {
  class BulkOnlyWorktree extends CountingWorktree {
    override stat(path: string): never {
      throw new Error(`scalar stat is forbidden during add: ${path}`);
    }

    override readFile(path: string): never {
      throw new Error(`scalar readFile is forbidden during add: ${path}`);
    }

    override readlink(path: string): never {
      throw new Error(`scalar readlink is forbidden during add: ${path}`);
    }
  }

  it("stages 9,329 files and exactly 1,000 changes through bounded bulk calls", () => {
    const workspace = makeRepo("/");
    const original = utf8.encode("original\n");
    const paths = Array.from({ length: 9_329 }, (_, index) => {
      const directory = index % 3_346;
      const generation = Math.floor(index / 3_346);
      return `/d${directory.toString().padStart(4, "0")}/f${generation
        .toString()
        .padStart(4, "0")}.txt`;
    });
    workspace.worktree.writeFiles(paths.map((path) => ({ path, bytes: original })));
    const worktree = new BulkOnlyWorktree(workspace.worktree);

    workspace.storage.resetCounters();
    add(workspace.repo, worktree, { paths: [], all: true });
    const first = workspace.storage.statementCount;
    expect(workspace.repo.checkout.indexEntries()).toHaveLength(paths.length);
    expect(first).toBeLessThanOrEqual(230);
    expect(worktree.bulkReadPaths).toHaveLength(paths.length);

    workspace.tick(60_000);
    const changed = paths.slice(0, 1_000);
    workspace.worktree.writeFiles(
      changed.map((path) => ({ path, bytes: utf8.encode("changed\n") })),
    );
    worktree.bulkReadPaths.length = 0;

    workspace.storage.resetCounters();
    add(workspace.repo, worktree, { paths: [], all: true });
    const second = workspace.storage.statementCount;

    expect(second).toBeLessThanOrEqual(230);
    expect(worktree.bulkReadPaths).toHaveLength(changed.length);
    expect(new Set(worktree.bulkReadPaths)).toEqual(new Set(changed));
    const changedOid = hashObject("blob", utf8.encode("changed\n"));
    const stagedChanged = workspace.repo.checkout
      .indexEntries()
      .filter((entry) => entry.oid === changedOid)
      .map((entry) => `/${entry.path}`);
    expect(stagedChanged).toHaveLength(changed.length);
    expect(new Set(stagedChanged)).toEqual(new Set(changed));

    workspace.storage.resetCounters();
    rm(workspace.repo, worktree, { paths: ["."], force: true, recursive: true });
    expect(workspace.storage.statementCount).toBeLessThanOrEqual(230);
    expect(workspace.repo.checkout.indexEntries()).toEqual([]);
    expect(workspace.worktree.scan("/", { filesOnly: true, limit: 1 })).toEqual([]);
  });

  it("stages 100 explicit paths without retaining an oversized index", () => {
    const workspace = makeRepo("/");
    const original = utf8.encode("original\n");
    const changed = utf8.encode("changed\n");
    const originalOid = workspace.repo.store.write("blob", original);
    const paths = Array.from(
      { length: 24_252 },
      (_, index) => `f${index.toString().padStart(5, "0")}.txt`,
    );
    workspace.repo.checkout.indexReplace(
      paths.map((path) => ({
        path,
        stage: 0,
        mode: 0o100644,
        oid: originalOid,
        size: original.length,
        mtime: null,
        ino: null,
      })),
    );
    const selected = paths.slice(0, 100);
    workspace.worktree.writeFiles(selected.map((path) => ({ path: `/${path}`, bytes: changed })));

    workspace.storage.resetCounters();
    add(workspace.repo, workspace.worktree, { paths: selected });

    expect(workspace.storage.statementCount).toBeLessThanOrEqual(400);
    const changedOid = hashObject("blob", changed);
    expect(
      selected.every((path) => workspace.repo.checkout.indexGet(path)?.oid === changedOid),
    ).toBe(true);
    expect(workspace.repo.checkout.indexGet(paths[100] ?? "")?.oid).toBe(originalOid);
  });

  it("selects 100 exact files from 24,252 native rows without general source scans", () => {
    const fixture = newFixture();
    const workspace = makeRepo("/");
    const original = "original\n";
    const changed = "changed\n";
    const originalBytes = utf8.encode(original);
    const changedBytes = utf8.encode(changed);
    const originalOid = workspace.repo.store.write("blob", originalBytes);
    const paths = Array.from({ length: 24_252 }, (_, index) => {
      const directory = Math.floor(index / 243);
      const file = index % 243;
      return `p${directory.toString().padStart(3, "0")}/f${file.toString().padStart(3, "0")}.ts`;
    });
    for (const path of paths) fixture.write(path, original);
    fixture.git("add", "-A");
    workspace.worktree.writeFiles(
      paths.map((path) => ({ path: `/${path}`, bytes: originalBytes })),
    );
    workspace.repo.checkout.indexReplace(
      paths.map((path) => ({
        path,
        stage: 0,
        mode: 0o100644,
        oid: originalOid,
        size: originalBytes.length,
        mtime: null,
        ino: null,
      })),
    );
    const selected = Array.from({ length: 100 }, (_, index) => paths[index * 243] ?? "");
    workspace.worktree.writeFiles(
      selected.map((path) => ({ path: `/${path}`, bytes: changedBytes })),
    );
    for (const path of selected) fixture.write(path, changed);
    const sourceStatements: number[] = [];
    const sourceRows: number[] = [];
    const ancestorStatements: number[] = [];
    const ancestorRows: number[] = [];
    const ancestorQueries: string[] = [];
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();

    add(
      workspace.repo,
      new BulkOnlyWorktree(workspace.worktree),
      { paths: selected },
      nativeAddContext(
        workspace,
        sourceStatements,
        sourceRows,
        ancestorStatements,
        ancestorRows,
        ancestorQueries,
      ),
    );
    fixture.git("add", "--", ...selected);

    const queries = [...workspace.storage.histogram.keys()];
    expect(sourceStatements).toEqual([2]);
    expect(sourceRows).toEqual([202]);
    expect(ancestorStatements).toEqual([1]);
    expect(ancestorRows).toEqual([100]);
    expect(ancestorQueries).toHaveLength(1);
    const ancestorQuery = ancestorQueries[0];
    if (ancestorQuery === undefined) throw new Error("missing recorded ancestor query");
    expect(ancestorQuery).toContain("exact_index_ancestor_rows(");
    expect(ancestorQuery).not.toContain("), index_ancestor_rows(");
    expect(queries.some((query) => query.startsWith("WITH wanted(path) AS"))).toBe(true);
    expect(queries.some((query) => query.startsWith("WITH wanted(relative) AS"))).toBe(true);
    expect(queries.some((query) => query.startsWith("WITH wanted(path, recursive)"))).toBe(false);
    expect(queries.some((query) => query.startsWith("WITH wanted(relative, recursive)"))).toBe(
      false,
    );
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    const witnesses = [...selected, paths[12_126] ?? "", paths.at(-1) ?? ""];
    const witnessSet = new Set(witnesses);
    expect(
      indexLines(workspace.repo).filter((line) => witnessSet.has(line.split("\t")[1] ?? "")),
    ).toEqual(fixture.git("ls-files", "-s", "--", ...witnesses).split("\n"));
    expect(workspace.repo.checkout.indexEntries()).toHaveLength(paths.length);
  });

  it.each([1, 100, 1_000])(
    "selects and stages %i explicit paths with flat source and bounded batch cost",
    (count) => {
      const workspace = makeRepo("/");
      const paths = Array.from(
        { length: count },
        (_, index) => `selected-${index.toString().padStart(4, "0")}.txt`,
      );
      workspace.worktree.writeFiles(
        paths.map((path) => ({ path: `/${path}`, bytes: utf8.encode("selected\n") })),
      );
      const unrelatedOid = workspace.repo.store.write("blob", utf8.encode("unrelated old\n"));
      workspace.repo.checkout.indexPut({
        path: "unrelated.txt",
        stage: 0,
        mode: 0o100644,
        oid: unrelatedOid,
        size: null,
        mtime: null,
        ino: null,
      });
      writeWorkFile(workspace, "/unrelated.txt", "unrelated changed\n");
      const worktree = new BulkOnlyWorktree(workspace.worktree);
      const sourceStatements: number[] = [];
      const batches = Math.ceil(count / 1_000);

      workspace.storage.resetCounters();
      add(workspace.repo, worktree, { paths }, nativeAddContext(workspace, sourceStatements));
      const statements = workspace.storage.statementCount;

      expect(sourceStatements).toEqual([2]);
      expect(statements).toBeLessThanOrEqual(20 + batches * 8);
      expect(statements).toBeLessThan(1_000);
      expect(worktree.bulkReadPaths).toHaveLength(count);
      expect(workspace.repo.checkout.indexGet("unrelated.txt")?.oid).toBe(unrelatedOid);
      const selectedOid = hashObject("blob", utf8.encode("selected\n"));
      expect(
        paths.every((path) => workspace.repo.checkout.indexGet(path)?.oid === selectedOid),
      ).toBe(true);
    },
  );

  it("fails rm before mutation when retained state exceeds 16 MiB", () => {
    const workspace = makeRepo("/");
    const oid = workspace.repo.store.write("blob", utf8.encode("x\n"));
    const suffix = "x".repeat(2_000);
    const entries = Array.from({ length: 4_000 }, (_, index) => ({
      path: `f${index.toString().padStart(4, "0")}-${suffix}`,
      stage: 0,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    }));
    workspace.repo.checkout.indexReplace(entries);

    expect(() =>
      rm(workspace.repo, workspace.worktree, {
        paths: ["."],
        cached: true,
        force: true,
        recursive: true,
      }),
    ).toThrow(expect.objectContaining({ code: "E2BIG" }));

    expect(workspace.repo.checkout.indexEntries()).toHaveLength(entries.length);
  });
});
