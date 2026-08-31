// Every oid here is checked against the real git binary. The fixture pins
// the identity and both dates, so the same content has to hash to the same
// commit on both sides — anything less would only prove we agree with
// ourselves.

import { afterEach, describe, expect, it } from "vitest";

import { utf8, utf8Decoder } from "../src/git/common/bytes.js";
import { GitError } from "../src/git/common/errors.js";
import {
  hashObject,
  type Person,
  serializeCommit,
  serializeTree,
} from "../src/git/common/objects.js";
import {
  commit,
  commitIndex,
  resolveIdentity,
  writeUnpublishedCommit,
} from "../src/git/ops/commit.js";
import type { GitContext } from "../src/git/ops/context.js";
import { log } from "../src/git/ops/reads.js";
import type { CommitTreeSnapshotSource } from "../src/git/ops/sparse-workspace.js";
import { eagerStatus } from "../src/git/ops/status.js";
import { buildTree } from "../src/git/ops/tree-build.js";
import { hashWorktreePath, indexEntryFor, walkWorktree } from "../src/git/ops/worktree-io.js";
import type { IndexEntry } from "../src/git/store/index.js";
import {
  advanceIndexTrackerBaseline,
  invalidateIndexTracker,
  readIndexTrackerState,
  resealIndexTracker,
} from "../src/git/store/index-tracker.js";
import { createSqliteCommitTreeSnapshotSource } from "../src/git/store/sparse-workspace.js";
import { GitFixture } from "./helpers/git.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

/** The identity `GitFixture` commits with. */
const FIXTURE_IDENTITY = { name: "Fixture", email: "fixture@example.com" };

/**
 * SQL statements one 2,000-file commit costs. Deterministic; see the scale
 * test. The trees and commit share one bounded object batch and cache write.
 */

const fixtures: GitFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function useIdentity(workspace: TestRepository): void {
  workspace.repo.store.configSet("user.name", FIXTURE_IDENTITY.name);
  workspace.repo.store.configSet("user.email", FIXTURE_IDENTITY.email);
}

/** `git add -A`, without depending on U3's `add`. */
function stageAll(workspace: TestRepository): void {
  const paths = walkWorktree(workspace.worktree, workspace.repo.root);
  workspace.repo.checkout.indexClear();
  for (const relative of paths) {
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, relative);
    if (hashed === null) throw new Error(`cannot stage ${relative}`);
    workspace.repo.checkout.indexPut(indexEntryFor(relative, hashed));
  }
}

function stagePath(workspace: TestRepository, path: string): void {
  const hashed = hashWorktreePath(workspace.repo, workspace.worktree, path);
  if (hashed === null) throw new Error(`cannot stage ${path}`);
  workspace.repo.checkout.indexPut(indexEntryFor(path, hashed));
}

function acceleratedContext(
  workspace: TestRepository,
  commitTrees: CommitTreeSnapshotSource = createSqliteCommitTreeSnapshotSource(
    workspace.database.db,
  ),
): GitContext {
  return {
    ...workspace.context,
    commitTrees,
    indexTracker: {
      reseal: (checkoutId, baselineTreeOid, entries) =>
        resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries),
      advanceBaseline: (checkoutId, baselineTreeOid) =>
        advanceIndexTrackerBaseline(workspace.database.db, checkoutId, baselineTreeOid),
    },
  };
}

function sealCommitBaseline(workspace: TestRepository): void {
  expect(
    resealIndexTracker(
      workspace.database.db,
      workspace.repo.checkout.checkoutId,
      workspace.repo.headTree(),
      [],
    ),
  ).toBe(true);
}

function trackerOnlyContext(workspace: TestRepository): GitContext {
  return {
    ...workspace.context,
    indexTracker: {
      reseal: (checkoutId, baselineTreeOid, entries) =>
        resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries),
      advanceBaseline: (checkoutId, baselineTreeOid) =>
        advanceIndexTrackerBaseline(workspace.database.db, checkoutId, baselineTreeOid),
    },
  };
}

function publicationState(workspace: TestRepository): object {
  return {
    head: workspace.repo.head(),
    objects: workspace.repo.store.objectCount(),
    refs: workspace.repo.store.listRefs(),
    reflog: workspace.repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_reflog_entries") ?? -1,
    checkoutReflog:
      workspace.repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_checkout_reflog_entries") ??
      -1,
    tracker: readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    dirty: [
      ...(workspace.context.sparseWorkspace?.dirtyPaths(workspace.repo.checkout.checkoutId) ?? []),
    ],
  };
}

function collectTreeOids(workspace: TestRepository, root: string): Set<string> {
  const result = new Set<string>();
  const visit = (oid: string): void => {
    if (result.has(oid)) return;
    result.add(oid);
    for (const entry of workspace.repo.readTree(oid)) {
      if (entry.mode === "40000" || entry.mode === "040000") visit(entry.oid);
    }
  };
  visit(root);
  return result;
}

interface Mirror {
  fixture: GitFixture;
  workspace: TestRepository;
  write(path: string, content: string): Mirror;
  writeExecutable(path: string, content: string): Mirror;
  symlink(target: string, path: string): Mirror;
  remove(path: string): Mirror;
  /** Commit the same content on both sides and assert the tree and the commit agree. */
  expectSameCommit(message: string, extra?: string[], allowEmpty?: boolean): string;
}

/** A working tree kept byte-for-byte identical in a git checkout and in DOFS. */
function mirror(): Mirror {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  const workspace = makeRepo("/");
  useIdentity(workspace);

  const self: Mirror = {
    fixture,
    workspace,
    write(path, content) {
      fixture.write(path, content);
      writeWorkFile(workspace, `/${path}`, content);
      return self;
    },
    writeExecutable(path, content) {
      fixture.writeExecutable(path, content);
      workspace.worktree.writeFiles([
        { path: `/${path}`, bytes: utf8.encode(content), mode: 0o755 },
      ]);
      return self;
    },
    symlink(target, path) {
      fixture.symlink(target, path);
      workspace.worktree.writeFiles([{ path: `/${path}`, target }]);
      return self;
    },
    remove(path) {
      fixture.remove(path);
      workspace.worktree.unlink(`/${path}`);
      return self;
    },
    expectSameCommit(message, extra = [], allowEmpty = false) {
      fixture.git("add", "-A");
      fixture.git("commit", "-q", "-m", message, ...extra);
      const theirs = fixture.git("rev-parse", "HEAD");
      stageAll(workspace);
      const ours = commit(workspace.context, workspace.repo, { message, allowEmpty }).oid;
      // Compare the tree first: a mismatch there localises the failure.
      expect(workspace.repo.readCommit(ours).tree).toBe(fixture.git("rev-parse", "HEAD^{tree}"));
      expect(ours).toBe(theirs);
      return ours;
    },
  };
  return self;
}

describe("commit oids match git", () => {
  it("hashes a flat tree", () => {
    const repo = mirror();
    repo.write("a.txt", "a\n").write("b.txt", "b\n").write("c.txt", "c\n");
    repo.expectSameCommit("flat");
  });

  it("hashes nested directories", () => {
    const repo = mirror();
    repo
      .write("README.md", "# demo\n")
      .write("src/index.ts", "export const a = 1;\n")
      .write("src/deep/inner/value.ts", "export const b = 2;\n");
    repo.expectSameCommit("nested");
  });

  it("hashes a new subdirectory on a second commit", () => {
    const repo = mirror();
    repo.write("src/a.ts", "a\n");
    const first = repo.expectSameCommit("first");
    repo.write("src/added/b.ts", "b\n");
    const second = repo.expectSameCommit("added");
    expect(repo.workspace.repo.readCommit(second).parent).toEqual([first]);
  });

  it("hashes a tree with a path deleted", () => {
    const repo = mirror();
    repo.write("keep.txt", "keep\n").write("drop.txt", "drop\n").write("dir/gone.txt", "gone\n");
    repo.expectSameCommit("first");
    repo.remove("drop.txt").remove("dir/gone.txt");
    repo.expectSameCommit("deleted");
  });

  it("hashes an executable file as 100755", () => {
    const repo = mirror();
    repo.write("plain.txt", "plain\n").writeExecutable("run.sh", "#!/bin/sh\necho hi\n");
    const oid = repo.expectSameCommit("executable");
    const tree = repo.workspace.repo.readCommit(oid).tree;
    expect(repo.workspace.repo.resolveTreePath(tree, "run.sh")?.mode).toBe("100755");
  });

  it("hashes a symlink as 120000 over its target", () => {
    const repo = mirror();
    repo.write("real.txt", "real\n").symlink("real.txt", "link.txt");
    const oid = repo.expectSameCommit("symlink");
    const tree = repo.workspace.repo.readCommit(oid).tree;
    expect(repo.workspace.repo.resolveTreePath(tree, "link.txt")?.mode).toBe("120000");
  });

  it("orders a file against a directory sharing its prefix", () => {
    const repo = mirror();
    // "a.txt" sorts before "a/" and "a0.txt" after it: this is exactly the
    // rule that makes a subtree sort as though its name ended in "/".
    repo
      .write("a.txt", "file\n")
      .write("a0.txt", "sibling\n")
      .write("a/b.txt", "inside\n")
      .write("a/z/deep.txt", "deeper\n");
    const oid = repo.expectSameCommit("ordering");
    const tree = repo.workspace.repo.readCommit(oid).tree;
    expect(repo.workspace.repo.readTree(tree).map((entry) => entry.name)).toEqual([
      "a.txt",
      "a",
      "a0.txt",
    ]);
  });

  it("hashes a non-ASCII filename", () => {
    const repo = mirror();
    repo.write("přílohy/žluťoučký kůň.txt", "úpěl ďábelské ódy\n").write("ascii.txt", "plain\n");
    repo.expectSameCommit("non-ascii");
  });

  it("allows an empty commit explicitly and hashes the parent's tree", () => {
    const repo = mirror();
    repo.write("only.txt", "only\n");
    const first = repo.expectSameCommit("first");
    const second = repo.expectSameCommit("empty", ["--allow-empty"], true);
    const parent = repo.workspace.repo.readCommit(first);
    const empty = repo.workspace.repo.readCommit(second);
    expect(empty.tree).toBe(parent.tree);
    expect(empty.parent).toEqual([first]);
  });
});

describe("history", () => {
  it("chains the second commit onto the first and logs both", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "two\n");
    const second = repo.expectSameCommit("second");

    const commits = log(repo.workspace.repo);
    expect(commits.map((entry) => entry.oid)).toEqual([second, first]);
    expect(commits.map((entry) => entry.oid)).toEqual(
      repo.fixture.git("rev-list", "HEAD").split("\n"),
    );
    expect(repo.workspace.repo.head().ref).toBe("refs/heads/main");
    expect(repo.workspace.repo.resolveRef("refs/heads/main")).toBe(second);
  });
});

describe("explicit-parent commit seam", () => {
  it("serializes a commit above the former 1 MiB validity threshold", () => {
    const workspace = makeRepo("/");
    workspace.context.defaultIdentity = FIXTURE_IDENTITY;
    const message = "m".repeat(1024 * 1024 + 1);

    const result = writeUnpublishedCommit(workspace.repo, {
      message,
      parent: [],
      identities: resolveIdentity(workspace.context, workspace.repo, {}),
    });

    expect(workspace.repo.readCommit(result.oid).message).toBe(message);
  });

  it("writes an authoritative commit without changing any ref", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "rewritten\n");
    stageAll(repo.workspace);
    const before = {
      head: repo.workspace.repo.checkout.head(),
      refs: repo.workspace.repo.store.listRefs(),
      reflogEntries:
        repo.workspace.repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_reflog_entries") ??
        -1,
    };
    const author: Person = {
      name: "Original Author",
      email: "author@example.com",
      timestamp: 1_234_567_890,
      timezoneOffset: -60,
    };
    const committer: Person = {
      name: "Replay Committer",
      email: "committer@example.com",
      timestamp: 1_345_678_901,
      timezoneOffset: 330,
    };
    const message = "\nrewritten message\r\n\n";

    const result = repo.workspace.repo.store.db.transactionSync(() =>
      writeUnpublishedCommit(repo.workspace.repo, {
        message,
        parent: [first, first],
        identities: { author, committer },
      }),
    );

    expect(repo.workspace.repo.checkout.head()).toBe(before.head);
    expect(repo.workspace.repo.store.listRefs()).toEqual(before.refs);
    expect(
      repo.workspace.repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_reflog_entries"),
    ).toBe(before.reflogEntries);
    expect(repo.workspace.repo.resolveRef("refs/heads/main")).toBe(first);
    const expected = {
      tree: result.tree,
      parent: [first, first],
      author,
      committer,
      message,
    };
    expect(repo.workspace.repo.readCommit(result.oid)).toEqual(expected);
    expect(repo.workspace.repo.read(result.oid)).toEqual({
      type: "commit",
      data: serializeCommit(expected),
    });
    expect(repo.workspace.repo.resolveTreePath(result.tree, "a.txt")?.oid).toBe(
      repo.workspace.repo.checkout.indexGet("a.txt", 0)?.oid,
    );
    expect(repo.workspace.repo.store.cachedCommit(result.oid)?.commit).toEqual(
      repo.workspace.repo.readCommit(result.oid),
    );
  });

  it("preserves an empty unpublished message", () => {
    const workspace = makeRepo("/");
    const before = workspace.repo.head();

    const result = workspace.repo.store.db.transactionSync(() =>
      writeUnpublishedCommit(workspace.repo, {
        message: "",
        parent: [],
        identities: {
          author: {
            name: "Author",
            email: "author@example.com",
            timestamp: 1,
            timezoneOffset: 0,
          },
          committer: {
            name: "Committer",
            email: "committer@example.com",
            timestamp: 2,
            timezoneOffset: 0,
          },
        },
      }),
    );

    expect(workspace.repo.readCommit(result.oid).message).toBe("");
    expect(workspace.repo.head()).toEqual(before);
  });

  it("publishes the same object through the checked commit seam", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "two\n");
    stageAll(repo.workspace);
    const expectedHead = repo.workspace.repo.head();
    const options = {
      message: "second\n",
      parent: [first],
      identities: resolveIdentity(repo.workspace.context, repo.workspace.repo, {}),
    };

    const unpublished = repo.workspace.repo.store.db.transactionSync(() =>
      writeUnpublishedCommit(repo.workspace.repo, options),
    );
    const published = commitIndex(repo.workspace.repo, {
      ...options,
      expectedHead,
      refLogReason: "commit",
    });

    expect(published.oid).toBe(unpublished.oid);
    expect(repo.workspace.repo.resolveRef("refs/heads/main")).toBe(unpublished.oid);
    expect(repo.workspace.repo.readCommit(published.oid).tree).toBe(unpublished.tree);
  });

  it("writes ordered merge parents", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "two\n");
    const second = repo.expectSameCommit("second");
    const head = repo.workspace.repo.head();

    const result = commitIndex(repo.workspace.repo, {
      message: "merge",
      parent: [first, second],
      identities: resolveIdentity(repo.workspace.context, repo.workspace.repo, {}),
      expectedHead: head,
      refLogReason: "merge: commit",
    });

    expect(repo.workspace.repo.readCommit(result.oid).parent).toEqual([first, second]);
  });

  it("does not write an object when HEAD changed", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "two\n");
    repo.expectSameCommit("second");
    const expectedHead = repo.workspace.repo.head();
    if (expectedHead.ref === null) throw new Error("fixture HEAD is detached");
    repo.workspace.repo.store.setRef(expectedHead.ref, first);
    const before = repo.workspace.repo.store.objectCount();
    const beforeReflog = repo.workspace.repo.store.db.scalar<number>(
      "SELECT COUNT(*) FROM git_reflog_entries",
    );

    expect(() =>
      commitIndex(repo.workspace.repo, {
        message: "stale",
        parent: [first],
        identities: resolveIdentity(repo.workspace.context, repo.workspace.repo, {}),
        expectedHead,
        refLogReason: "commit",
      }),
    ).toThrow(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(repo.workspace.repo.store.objectCount()).toBe(before);
    expect(
      repo.workspace.repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_reflog_entries"),
    ).toBe(beforeReflog);
    expect(repo.workspace.repo.resolveRef(expectedHead.ref)).toBe(first);
  });
});

describe("amend", () => {
  it("replaces the tip, keeps the original parents, and matches git", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "two\n");
    const second = repo.expectSameCommit("second");

    repo.fixture.git("commit", "-q", "--amend", "-m", "second, reworded");
    const theirs = repo.fixture.git("rev-parse", "HEAD");
    const ours = commit(repo.workspace.context, repo.workspace.repo, {
      message: "second, reworded",
      amend: true,
    }).oid;

    expect(ours).toBe(theirs);
    expect(ours).not.toBe(second);
    const amended = repo.workspace.repo.readCommit(ours);
    expect(amended.parent).toEqual([first]);
    expect(log(repo.workspace.repo).map((entry) => entry.oid)).toEqual([ours, first]);
  });

  it("keeps the author date and re-stamps the committer", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    writeWorkFile(workspace, "/a.txt", "one\n");
    stageAll(workspace);
    const first = commit(workspace.context, workspace.repo, { message: "first" }).oid;

    workspace.tick(90_000);
    const amended = commit(workspace.context, workspace.repo, {
      message: "reworded",
      amend: true,
    }).oid;

    const before = workspace.repo.readCommit(first);
    const after = workspace.repo.readCommit(amended);
    expect(after.author.timestamp).toBe(before.author.timestamp);
    expect(after.committer.timestamp).toBe(before.committer.timestamp + 90);
    expect(after.parent).toEqual([]);
  });

  it("refuses to amend an unborn HEAD", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    expect(() =>
      commit(workspace.context, workspace.repo, { message: "nothing", amend: true }),
    ).toThrow(/cannot amend/);
  });
});

describe("identity", () => {
  it("lets each source win in turn", () => {
    const workspace = makeRepo("/");
    workspace.context.defaultIdentity = { name: "Default", email: "default@example.com" };
    workspace.repo.store.configSet("user.name", "Config");
    workspace.repo.store.configSet("user.email", "config@example.com");
    const env = { GIT_AUTHOR_NAME: "Env", GIT_AUTHOR_EMAIL: "env@example.com" };

    const explicit = commit(workspace.context, workspace.repo, {
      message: "explicit",
      author: { name: "Explicit", email: "explicit@example.com" },
      env,
      allowEmpty: true,
    }).oid;
    expect(workspace.repo.readCommit(explicit).author).toMatchObject({
      name: "Explicit",
      email: "explicit@example.com",
    });

    const fromEnv = commit(workspace.context, workspace.repo, {
      message: "env",
      env,
      allowEmpty: true,
    }).oid;
    expect(workspace.repo.readCommit(fromEnv).author.name).toBe("Env");

    const fromConfig = commit(workspace.context, workspace.repo, {
      message: "config",
      allowEmpty: true,
    }).oid;
    expect(workspace.repo.readCommit(fromConfig).author.name).toBe("Config");

    workspace.repo.store.configUnset("user.name");
    workspace.repo.store.configUnset("user.email");
    const fromDefault = commit(workspace.context, workspace.repo, {
      message: "default",
      allowEmpty: true,
    }).oid;
    expect(workspace.repo.readCommit(fromDefault).author.name).toBe("Default");
  });

  it("falls back to the author for the committer, and honours GIT_COMMITTER_*", () => {
    const workspace = makeRepo("/");
    const author = { name: "Author", email: "author@example.com" };

    const shared = commit(workspace.context, workspace.repo, {
      message: "shared",
      author,
      allowEmpty: true,
    }).oid;
    expect(workspace.repo.readCommit(shared).committer).toMatchObject(author);

    const split = commit(workspace.context, workspace.repo, {
      message: "split",
      author,
      env: { GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: "committer@example.com" },
      allowEmpty: true,
    }).oid;
    expect(workspace.repo.readCommit(split).committer).toMatchObject({
      name: "Committer",
      email: "committer@example.com",
    });
  });

  it("throws when nothing resolves both a name and an email", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Half");
    expect(() => commit(workspace.context, workspace.repo, { message: "nope" })).toThrow(
      /identity unknown/,
    );
    expect(() =>
      commit(workspace.context, workspace.repo, {
        message: "nope",
        env: { GIT_AUTHOR_NAME: "Half" },
      }),
    ).toThrow(/identity unknown/);
  });

  it("commits with a long configured identity", () => {
    const configuredName = `Configured ${"x".repeat(220 * 1024)}`;
    const configuredEmail = "configured@example.com";
    const prepare = (): TestRepository => {
      const workspace = makeRepo("/");
      sealCommitBaseline(workspace);
      writeWorkFile(workspace, "/a.txt", "configured\n");
      stagePath(workspace, "a.txt");
      workspace.repo.store.configSet("user.name", configuredName);
      workspace.repo.store.configSet("user.email", configuredEmail);
      return workspace;
    };

    const workspace = prepare();
    const before = publicationState(workspace);
    const histogram = new Map<string, number>();
    workspace.storage.histogram = histogram;
    workspace.storage.resetCounters();
    const result = commit(trackerOnlyContext(workspace), workspace.repo, {
      message: "configured",
    });
    const configReadStatements = [...histogram].reduce(
      (total, [query, count]) => total + (query.includes("FROM git_config") ? count : 0),
      0,
    );

    expect(result.oid).toBe(workspace.repo.head().oid);
    expect(workspace.repo.readCommit(result.oid).author.name).toBe(configuredName);
    expect(configReadStatements).toBe(2);
    expect(publicationState(workspace)).not.toEqual(before);
  });
});

describe("refusals", () => {
  it("refuses to commit an index with a conflicted path", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    writeWorkFile(workspace, "/a.txt", "one\n");
    stageAll(workspace);
    const oid = workspace.repo.store.write("blob", utf8.encode("theirs\n"));
    workspace.repo.checkout.indexPut({
      path: "a.txt",
      stage: 2,
      mode: 0o100644,
      oid,
      size: null,
      mtime: null,
      ino: null,
    });

    expect(() => commit(workspace.context, workspace.repo, { message: "conflicted" })).toThrow(
      /unmerged/,
    );
  });

  it("refuses an empty message", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    expect(() => commit(workspace.context, workspace.repo, { message: "  \n" })).toThrow(
      /message is required/,
    );
  });

  it("refuses an empty root commit like git", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    useIdentity(workspace);

    expect(() => fixture.git("commit", "-q", "-m", "empty root")).toThrow();
    expect(() => commit(workspace.context, workspace.repo, { message: "empty root" })).toThrow(
      expect.objectContaining({ code: "EEMPTYCOMMIT" }),
    );

    expect(workspace.repo.head()).toEqual({ ref: "refs/heads/main", oid: null });
    expect(workspace.repo.store.objectCount()).toBe(0);
  });

  it("refuses an unchanged index like git without changing repository state", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    const before = {
      head: repo.workspace.repo.head(),
      refs: repo.workspace.repo.store.listRefs(),
      index: repo.workspace.repo.checkout.indexEntries(),
      objects: repo.workspace.repo.store.objectCount(),
      operation: repo.workspace.repo.checkout.readOperationState(),
      paths: walkWorktree(repo.workspace.worktree, repo.workspace.repo.root),
      content: utf8Decoder.decode(repo.workspace.worktree.readFile("/a.txt")),
    };

    expect(() => repo.fixture.git("commit", "-q", "-m", "unchanged")).toThrow();
    expect(() =>
      commit(repo.workspace.context, repo.workspace.repo, { message: "unchanged" }),
    ).toThrow(expect.objectContaining({ code: "EEMPTYCOMMIT" }));

    expect(repo.workspace.repo.head()).toEqual(before.head);
    expect(repo.workspace.repo.resolveRef("refs/heads/main")).toBe(first);
    expect(repo.workspace.repo.store.listRefs()).toEqual(before.refs);
    expect(repo.workspace.repo.checkout.indexEntries()).toEqual(before.index);
    expect(repo.workspace.repo.store.objectCount()).toBe(before.objects);
    expect(repo.workspace.repo.checkout.readOperationState()).toEqual(before.operation);
    expect(walkWorktree(repo.workspace.worktree, repo.workspace.repo.root)).toEqual(before.paths);
    expect(utf8Decoder.decode(repo.workspace.worktree.readFile("/a.txt"))).toBe(before.content);
  });

  it("refuses restaged content identical to HEAD like git", () => {
    const repo = mirror();
    repo.write("a.txt", "same\n");
    repo.expectSameCommit("first");

    repo.fixture.write("a.txt", "same\n");
    repo.fixture.git("add", "-A");
    writeWorkFile(repo.workspace, "/a.txt", "same\n");
    stageAll(repo.workspace);

    expect(() => repo.fixture.git("commit", "-q", "-m", "restaged")).toThrow();
    expect(() =>
      commit(repo.workspace.context, repo.workspace.repo, { message: "restaged" }),
    ).toThrow(expect.objectContaining({ code: "EEMPTYCOMMIT" }));
  });
});

describe("tree reuse", () => {
  it("writes git's empty tree for an empty index", () => {
    const workspace = makeRepo("/");
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    expect(buildTree(workspace.repo, workspace.repo.checkout.indexEntries())).toBe(
      fixture.git("hash-object", "-t", "tree", "/dev/null"),
    );
  });

  it("rewrites only the trees on the changed path", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    writeWorkFile(workspace, "/a/b/c.txt", "c\n");
    writeWorkFile(workspace, "/a/b/d.txt", "d\n");
    writeWorkFile(workspace, "/a/e.txt", "e\n");
    writeWorkFile(workspace, "/g/h/i.txt", "i\n");
    writeWorkFile(workspace, "/f.txt", "f\n");
    stageAll(workspace);
    const first = commit(workspace.context, workspace.repo, { message: "first" }).oid;

    writeWorkFile(workspace, "/a/b/c.txt", "changed\n");
    stageAll(workspace); // writes the one new blob
    const before = workspace.repo.store.objectCount();
    const second = commit(workspace.context, workspace.repo, { message: "second" }).oid;

    // The root, "a" and "a/b" are rewritten; everything else is reused.
    expect(workspace.repo.store.objectCount() - before).toBe(4);

    const firstTree = workspace.repo.readCommit(first).tree;
    const secondTree = workspace.repo.readCommit(second).tree;
    expect(secondTree).not.toBe(firstTree);
    expect(workspace.repo.resolveTreePath(secondTree, "g/h")?.oid).toBe(
      workspace.repo.resolveTreePath(firstTree, "g/h")?.oid,
    );
    expect(workspace.repo.resolveTreePath(secondTree, "a/b")?.oid).not.toBe(
      workspace.repo.resolveTreePath(firstTree, "a/b")?.oid,
    );
  });
});

describe("bounded commit tree acceleration", () => {
  it("matches the full builder and Git across narrow tree shape changes", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    useIdentity(workspace);
    const initial: ReadonlyArray<readonly [string, string]> = [
      ["stable/keep.txt", "keep\n"],
      ["edit.txt", "before\n"],
      ["gone.txt", "gone\n"],
      ["move-old.txt", "moved\n"],
      ["file-node", "file\n"],
      ["dir-node/child.txt", "child\n"],
      ["empty-dir/only.txt", "only\n"],
      ["mode.sh", "#!/bin/sh\n"],
    ];
    for (const [path, content] of initial) {
      fixture.write(path, content);
      writeWorkFile(workspace, `/${path}`, content);
    }
    fixture.commit("base");
    stageAll(workspace);
    commit(workspace.context, workspace.repo, { message: "base" });
    sealCommitBaseline(workspace);
    const baselineTree = workspace.repo.headTree();
    if (baselineTree === null) throw new Error("fixture baseline tree is missing");

    fixture.write("edit.txt", "after\n");
    writeWorkFile(workspace, "/edit.txt", "after\n");
    stagePath(workspace, "edit.txt");

    fixture.remove("gone.txt");
    workspace.worktree.unlink("/gone.txt");
    workspace.repo.checkout.indexRemove("gone.txt");

    fixture.remove("move-old.txt").write("move-new.txt", "moved\n");
    workspace.worktree.unlink("/move-old.txt");
    writeWorkFile(workspace, "/move-new.txt", "moved\n");
    workspace.repo.checkout.indexRemove("move-old.txt");
    stagePath(workspace, "move-new.txt");

    fixture.remove("file-node").write("file-node/deep/new.txt", "new\n");
    workspace.worktree.unlink("/file-node");
    writeWorkFile(workspace, "/file-node/deep/new.txt", "new\n");
    workspace.repo.checkout.indexRemove("file-node");
    stagePath(workspace, "file-node/deep/new.txt");

    fixture.remove("dir-node").write("dir-node", "replacement\n");
    workspace.worktree.unlink("/dir-node/child.txt");
    workspace.worktree.rmdir("/dir-node");
    writeWorkFile(workspace, "/dir-node", "replacement\n");
    workspace.repo.checkout.indexRemove("dir-node/child.txt");
    stagePath(workspace, "dir-node");

    fixture.remove("empty-dir/only.txt");
    workspace.worktree.unlink("/empty-dir/only.txt");
    workspace.repo.checkout.indexRemove("empty-dir/only.txt");

    fixture.write("new/deep/root.txt", "root\n");
    writeWorkFile(workspace, "/new/deep/root.txt", "root\n");
    stagePath(workspace, "new/deep/root.txt");

    fixture.symlink("stable/keep.txt", "new-link");
    workspace.worktree.symlink("stable/keep.txt", "/new-link");
    stagePath(workspace, "new-link");

    fixture.writeExecutable("mode.sh", "#!/bin/sh\n");
    workspace.worktree.writeFiles([
      { path: "/mode.sh", bytes: utf8.encode("#!/bin/sh\n"), mode: 0o755 },
    ]);
    stagePath(workspace, "mode.sh");

    fixture.git("add", "-A");
    const expectedTree = fixture.git("write-tree");
    const fullWorkspace = makeRepo("/");
    for (const entry of workspace.repo.checkout.indexScan()) {
      fullWorkspace.repo.checkout.indexPut(entry);
    }
    const fullTree = buildTree(fullWorkspace.repo, fullWorkspace.repo.checkout.indexScan());
    expect(fullTree).toBe(expectedTree);
    const expectedStable = workspace.repo.resolveTreePath(baselineTree, "stable")?.oid;
    const expectedTreeOids = collectTreeOids(fullWorkspace, fullTree);
    const baselineTreeOids = collectTreeOids(workspace, baselineTree);
    const plannedTreeOids = [...expectedTreeOids].filter((oid) => !baselineTreeOids.has(oid));
    expect(plannedTreeOids.length).toBeGreaterThan(0);
    for (const treeOid of plannedTreeOids) {
      expect(workspace.repo.store.read(treeOid)).toBeNull();
    }

    workspace.storage.resetCounters();
    workspace.storage.histogram = new Map();
    const oid = commit(acceleratedContext(workspace), workspace.repo, { message: "shapes" }).oid;
    const tree = workspace.repo.readCommit(oid).tree;

    expect(tree).toBe(fullTree);
    expect(tree).toBe(expectedTree);
    expect(workspace.repo.resolveTreePath(tree, "stable")?.oid).toBe(expectedStable);
    for (const treeOid of expectedTreeOids) {
      expect(workspace.repo.store.read(treeOid)?.type).toBe("tree");
      expect(() => workspace.repo.readTree(treeOid)).not.toThrow();
    }
    const statements = [...workspace.storage.histogram.keys()].join("\n");
    expect(statements).not.toContain(
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id",
    );
  });

  it("builds a new root from a sealed unborn baseline", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    useIdentity(workspace);
    sealCommitBaseline(workspace);
    fixture.write("root.txt", "root\n").write("deep/new.txt", "deep\n");
    writeWorkFile(workspace, "/root.txt", "root\n");
    writeWorkFile(workspace, "/deep/new.txt", "deep\n");
    stagePath(workspace, "root.txt");
    stagePath(workspace, "deep/new.txt");
    fixture.git("add", "-A");
    const expectedTree = fixture.git("write-tree");

    const oid = commit(acceleratedContext(workspace), workspace.repo, { message: "initial" }).oid;

    expect(workspace.repo.readCommit(oid).tree).toBe(expectedTree);
  });

  it("publishes Git's empty tree for clean and worktree-only sealed unborn snapshots", () => {
    for (const worktreeDirty of [false, true]) {
      const fixture = new GitFixture().init();
      fixtures.push(fixture);
      const workspace = makeRepo("/");
      useIdentity(workspace);
      sealCommitBaseline(workspace);
      if (worktreeDirty) {
        fixture.write("untracked.txt", "untracked\n");
        writeWorkFile(workspace, "/untracked.txt", "untracked\n");
      }
      fixture.git("commit", "-q", "--allow-empty", "-m", "empty");
      const expected = fixture.git("rev-parse", "HEAD");

      const oid = commit(acceleratedContext(workspace), workspace.repo, {
        message: "empty",
        allowEmpty: true,
      }).oid;
      const tree = workspace.repo.readCommit(oid).tree;
      const object = workspace.repo.read(tree);

      expect(oid).toBe(expected);
      expect(tree).toBe(hashObject("tree", serializeTree([])));
      expect(object).toEqual({ type: "tree", data: serializeTree([]) });
    }
  });

  it("does not scan a 100-path index for one dirty path and advances the sealed baseline", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    for (let index = 0; index < 100; index++) {
      const path = `dir/file-${index.toString().padStart(3, "0")}.txt`;
      writeWorkFile(workspace, `/${path}`, `${index}\n`);
    }
    stageAll(workspace);
    commit(workspace.context, workspace.repo, { message: "base" });
    sealCommitBaseline(workspace);
    writeWorkFile(workspace, "/dir/file-050.txt", "changed\n");
    stagePath(workspace, "dir/file-050.txt");

    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();
    const oid = commit(acceleratedContext(workspace), workspace.repo, { message: "narrow" }).oid;
    const counts = {
      statements: workspace.storage.statementCount,
      rows: workspace.storage.rowCount,
    };
    const queries = [...workspace.storage.histogram.keys()].join("\n");

    expect(queries).not.toContain(
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id",
    );
    expect(queries).toContain("WITH wanted(path) AS MATERIALIZED");
    expect(queries).not.toContain("WITH wanted(path, recursive) AS MATERIALIZED");
    expect(counts.statements).toBeLessThan(1_000);
    expect(counts.rows).toBeLessThan(1_000);
    expect([
      ...(workspace.context.sparseWorkspace?.dirtyPaths(workspace.repo.checkout.checkoutId) ?? []),
    ]).toEqual([{ path: "dir/file-050.txt", flags: 3 }]);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({ available: true, baselineTreeOid: workspace.repo.readCommit(oid).tree });
    expect(workspace.repo.headTree()).toBe(workspace.repo.readCommit(oid).tree);
  });

  it("falls back only for unavailable, mismatched, incomplete, or capacity-limited snapshots", () => {
    const cases: Array<"unavailable" | "mismatched" | "incomplete" | "capacity"> = [
      "unavailable",
      "mismatched",
      "incomplete",
      "capacity",
    ];
    for (const mode of cases) {
      const workspace = makeRepo("/");
      useIdentity(workspace);
      writeWorkFile(workspace, "/a.txt", "one\n");
      stageAll(workspace);
      commit(workspace.context, workspace.repo, { message: "base" });
      sealCommitBaseline(workspace);
      writeWorkFile(workspace, "/a.txt", "two\n");
      stagePath(workspace, "a.txt");

      let source: CommitTreeSnapshotSource = createSqliteCommitTreeSnapshotSource(
        workspace.database.db,
      );
      if (mode === "unavailable") source = { snapshot: () => ({ available: false }) };
      if (mode === "capacity") {
        source = {
          snapshot: () => {
            throw new GitError("E2BIG", "injected commit snapshot capacity");
          },
        };
      }
      if (mode === "mismatched") {
        expect(
          resealIndexTracker(
            workspace.database.db,
            workspace.repo.checkout.checkoutId,
            "9".repeat(40),
            [],
          ),
        ).toBe(true);
      }
      if (mode === "incomplete") {
        invalidateIndexTracker(workspace.database.db, workspace.repo.checkout.checkoutId);
      }
      workspace.storage.histogram = new Map();
      workspace.storage.resetCounters();

      const oid = commit(acceleratedContext(workspace, source), workspace.repo, {
        message: mode,
      }).oid;

      expect(
        workspace.repo.resolveTreePath(workspace.repo.readCommit(oid).tree, "a.txt")?.oid,
      ).toBe(workspace.repo.checkout.indexGet("a.txt")?.oid);
      expect([...workspace.storage.histogram.keys()].join("\n")).toContain(
        "SELECT checkout.repo_id, typeof(entry.path) AS path_type",
      );
    }
  });

  it("falls back to the exact plan when the sparse provider is unavailable", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    writeWorkFile(workspace, "/a.txt", "one\n");
    stageAll(workspace);
    commit(workspace.context, workspace.repo, { message: "base" });
    sealCommitBaseline(workspace);
    writeWorkFile(workspace, "/a.txt", "two\n");
    stagePath(workspace, "a.txt");

    const source: CommitTreeSnapshotSource = {
      snapshot() {
        return { available: false };
      },
    };
    workspace.storage.histogram = new Map();
    expect(
      commit(acceleratedContext(workspace, source), workspace.repo, {
        message: "headroom fallback",
      }).oid,
    ).toBe(workspace.repo.head().oid);
    expect([...workspace.storage.histogram.keys()].join("\n")).toContain(
      "SELECT checkout.repo_id, typeof(entry.path) AS path_type",
    );
  });

  it("keeps the prior tracker safely usable when baseline advancement declines", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    writeWorkFile(workspace, "/a.txt", "one\n");
    stageAll(workspace);
    commit(workspace.context, workspace.repo, { message: "base" });
    sealCommitBaseline(workspace);
    const baseline = workspace.repo.headTree();
    if (baseline === null) throw new Error("fixture baseline tree is missing");
    writeWorkFile(workspace, "/a.txt", "two\n");
    stagePath(workspace, "a.txt");
    const context = acceleratedContext(workspace);
    context.indexTracker = {
      reseal: (checkoutId, baselineTreeOid, entries) =>
        resealIndexTracker(workspace.database.db, checkoutId, baselineTreeOid, entries),
      advanceBaseline: () => false,
    };

    const oid = commit(context, workspace.repo, { message: "declined" }).oid;
    const publishedTree = workspace.repo.readCommit(oid).tree;

    expect(publishedTree).not.toBe(baseline);
    expect(
      readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
    ).toEqual({ available: true, baselineTreeOid: baseline });
    expect([
      ...(workspace.context.sparseWorkspace?.dirtyPaths(workspace.repo.checkout.checkoutId) ?? []),
    ]).toEqual([{ path: "a.txt", flags: 3 }]);
    expect(eagerStatus(workspace.repo, workspace.worktree, {}, context)).toEqual([]);
  });

  it("propagates malformed tracker, index, and authenticated ancestry snapshots", () => {
    const corruptions: Array<"tracker" | "index" | "ancestry"> = ["tracker", "index", "ancestry"];
    for (const corruption of corruptions) {
      const workspace = makeRepo("/");
      useIdentity(workspace);
      writeWorkFile(workspace, "/dir/a.txt", "one\n");
      stageAll(workspace);
      commit(workspace.context, workspace.repo, { message: "base" });
      sealCommitBaseline(workspace);
      writeWorkFile(workspace, "/dir/a.txt", "two\n");
      stagePath(workspace, "dir/a.txt");
      const native = createSqliteCommitTreeSnapshotSource(workspace.database.db);
      const corrupt: CommitTreeSnapshotSource = {
        snapshot(request) {
          const result = native.snapshot(request);
          if (!result.available) return result;
          if (corruption === "tracker") {
            return {
              ...result,
              dirty: result.dirty.map((entry, ordinal) =>
                ordinal === 0 ? { ...entry, flags: 0 } : entry,
              ),
            };
          }
          if (corruption === "index") {
            return {
              ...result,
              index: result.index.map((entry, ordinal) =>
                ordinal === 0 ? { ...entry, mode: 0 } : entry,
              ),
            };
          }
          const empty = serializeTree([]);
          return {
            ...result,
            directories: result.directories.map((directory) =>
              directory.path === "dir"
                ? { ...directory, oid: hashObject("tree", empty), entries: [] }
                : directory,
            ),
          };
        },
      };
      const before = {
        head: workspace.repo.head(),
        objects: workspace.repo.store.objectCount(),
        refs: workspace.repo.store.listRefs(),
        index: workspace.repo.checkout.indexEntries(),
        tracker: readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
        dirty: [
          ...(workspace.context.sparseWorkspace?.dirtyPaths(workspace.repo.checkout.checkoutId) ??
            []),
        ],
      };

      expect(() =>
        commit(acceleratedContext(workspace, corrupt), workspace.repo, {
          message: corruption,
        }),
      ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
      expect({
        head: workspace.repo.head(),
        objects: workspace.repo.store.objectCount(),
        refs: workspace.repo.store.listRefs(),
        index: workspace.repo.checkout.indexEntries(),
        tracker: readIndexTrackerState(workspace.database.db, workspace.repo.checkout.checkoutId),
        dirty: [
          ...(workspace.context.sparseWorkspace?.dirtyPaths(workspace.repo.checkout.checkoutId) ??
            []),
        ],
      }).toEqual(before);
    }
  });
});

describe("scale", () => {
  it("commits 2,000 files across 200 directories with git's oid", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    useIdentity(workspace);

    for (let directory = 0; directory < 200; directory++) {
      for (let file = 0; file < 10; file++) {
        const path = `dir${String(directory).padStart(3, "0")}/file${String(file).padStart(2, "0")}.txt`;
        const content = `contents of ${path}\n`;
        fixture.write(path, content);
        const entry: IndexEntry = {
          path,
          stage: 0,
          mode: 0o100644,
          oid: workspace.repo.store.write("blob", utf8.encode(content)),
          size: content.length,
          mtime: 0,
          ino: 0,
        };
        workspace.repo.checkout.indexPut(entry);
      }
    }
    const theirs = fixture.commit("scale");

    workspace.storage.resetCounters();
    const ours = commit(workspace.context, workspace.repo, { message: "scale" }).oid;
    const statements = workspace.storage.statementCount;

    expect(workspace.repo.readCommit(ours).tree).toBe(fixture.git("rev-parse", "HEAD^{tree}"));
    expect(ours).toBe(theirs);
    expect(statements).toBeLessThan(1_000);
  });

  it("commits 3,293 tree and commit objects within the statement target", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    useIdentity(workspace);

    const path = `${Array.from({ length: 3291 }, () => "a").join("/")}/leaf.txt`;
    const data = utf8.encode("leaf\n");
    const blob = workspace.repo.store.write("blob", data);
    workspace.repo.checkout.indexPut({
      path,
      stage: 0,
      mode: 0o100644,
      oid: blob,
      size: data.length,
      mtime: 0,
      ino: 0,
    });

    fixture.write("leaf.txt", data);
    const fixtureBlob = fixture.git("hash-object", "-w", "leaf.txt");
    fixture.git("update-index", "--add", "--cacheinfo", "100644", fixtureBlob, path);
    const expectedTree = fixture.git("write-tree");
    const expectedCommit = fixture.git("commit-tree", expectedTree, "-m", "adversarial");

    const before = workspace.repo.store.objectCount();
    workspace.storage.resetCounters();
    const oid = commit(workspace.context, workspace.repo, { message: "adversarial" }).oid;
    const statements = workspace.storage.statementCount;

    expect(workspace.repo.readCommit(oid).tree).toBe(expectedTree);
    expect(oid).toBe(expectedCommit);
    expect(workspace.repo.store.objectCount() - before).toBe(3293);
    expect(statements).toBeLessThan(1_000);
  });
});
