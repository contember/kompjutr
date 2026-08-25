// Every oid here is checked against the real git binary. The fixture pins
// the identity and both dates, so the same content has to hash to the same
// commit on both sides — anything less would only prove we agree with
// ourselves.

import { afterEach, describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { type Person, serializeCommit } from "../src/core/objects.js";
import {
  commit,
  commitIndex,
  resolveIdentity,
  writeUnpublishedCommit,
} from "../src/core/ops/commit.js";
import { log } from "../src/core/ops/reads.js";
import { buildTree } from "../src/core/ops/tree-build.js";
import { hashWorktreePath, indexEntryFor, walkWorktree } from "../src/core/ops/worktree-io.js";
import type { IndexEntry } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";

/** The identity `GitFixture` commits with. */
const FIXTURE_IDENTITY = { name: "Fixture", email: "fixture@example.com" };

/**
 * SQL statements one 2,000-file commit costs. Deterministic; see the scale
 * test. The trees and commit share one bounded object batch and cache write.
 */
const SCALE_STATEMENTS = 14;

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
  workspace.repo.store.indexClear();
  for (const relative of paths) {
    const hashed = hashWorktreePath(workspace.repo, workspace.worktree, relative);
    if (hashed === null) throw new Error(`cannot stage ${relative}`);
    workspace.repo.store.indexPut(indexEntryFor(relative, hashed));
  }
}

interface Mirror {
  fixture: GitFixture;
  workspace: TestRepository;
  write(path: string, content: string): Mirror;
  writeExecutable(path: string, content: string): Mirror;
  symlink(target: string, path: string): Mirror;
  remove(path: string): Mirror;
  /** Commit the same content on both sides and assert the tree and the commit agree. */
  expectSameCommit(message: string, extra?: string[]): string;
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
    expectSameCommit(message, extra = []) {
      fixture.git("add", "-A");
      fixture.git("commit", "-q", "-m", message, ...extra);
      const theirs = fixture.git("rev-parse", "HEAD");
      stageAll(workspace);
      const ours = commit(workspace.context, workspace.repo, { message }).oid;
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

  it("hashes an empty commit with the parent's tree", () => {
    const repo = mirror();
    repo.write("only.txt", "only\n");
    const first = repo.expectSameCommit("first");
    const second = repo.expectSameCommit("empty", ["--allow-empty"]);
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
  it("writes an authoritative commit without changing any ref", () => {
    const repo = mirror();
    repo.write("a.txt", "one\n");
    const first = repo.expectSameCommit("first");
    repo.write("a.txt", "rewritten\n");
    stageAll(repo.workspace);
    const before = {
      head: repo.workspace.repo.store.head(),
      refs: repo.workspace.repo.store.listRefs(),
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

    expect(repo.workspace.repo.store.head()).toBe(before.head);
    expect(repo.workspace.repo.store.listRefs()).toEqual(before.refs);
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
      repo.workspace.repo.store.indexGet("a.txt", 0)?.oid,
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
    const published = commitIndex(repo.workspace.repo, { ...options, expectedHead });

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

    expect(() =>
      commitIndex(repo.workspace.repo, {
        message: "stale",
        parent: [first],
        identities: resolveIdentity(repo.workspace.context, repo.workspace.repo, {}),
        expectedHead,
      }),
    ).toThrow(expect.objectContaining({ code: "ESTALEHEAD" }));
    expect(repo.workspace.repo.store.objectCount()).toBe(before);
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
    }).oid;
    expect(workspace.repo.readCommit(explicit).author).toMatchObject({
      name: "Explicit",
      email: "explicit@example.com",
    });

    const fromEnv = commit(workspace.context, workspace.repo, { message: "env", env }).oid;
    expect(workspace.repo.readCommit(fromEnv).author.name).toBe("Env");

    const fromConfig = commit(workspace.context, workspace.repo, { message: "config" }).oid;
    expect(workspace.repo.readCommit(fromConfig).author.name).toBe("Config");

    workspace.repo.store.configUnset("user.name");
    workspace.repo.store.configUnset("user.email");
    const fromDefault = commit(workspace.context, workspace.repo, { message: "default" }).oid;
    expect(workspace.repo.readCommit(fromDefault).author.name).toBe("Default");
  });

  it("falls back to the author for the committer, and honours GIT_COMMITTER_*", () => {
    const workspace = makeRepo("/");
    const author = { name: "Author", email: "author@example.com" };

    const shared = commit(workspace.context, workspace.repo, { message: "shared", author }).oid;
    expect(workspace.repo.readCommit(shared).committer).toMatchObject(author);

    const split = commit(workspace.context, workspace.repo, {
      message: "split",
      author,
      env: { GIT_COMMITTER_NAME: "Committer", GIT_COMMITTER_EMAIL: "committer@example.com" },
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
});

describe("refusals", () => {
  it("refuses to commit an index with a conflicted path", () => {
    const workspace = makeRepo("/");
    useIdentity(workspace);
    writeWorkFile(workspace, "/a.txt", "one\n");
    stageAll(workspace);
    const oid = workspace.repo.store.write("blob", utf8.encode("theirs\n"));
    workspace.repo.store.indexPut({
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
});

describe("tree reuse", () => {
  it("writes git's empty tree for an empty index", () => {
    const workspace = makeRepo("/");
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    expect(buildTree(workspace.repo, workspace.repo.store.indexEntries())).toBe(
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
        workspace.repo.store.indexPut(entry);
      }
    }
    const theirs = fixture.commit("scale");

    workspace.storage.resetCounters();
    const ours = commit(workspace.context, workspace.repo, { message: "scale" }).oid;
    const statements = workspace.storage.statementCount;

    expect(workspace.repo.readCommit(ours).tree).toBe(fixture.git("rev-parse", "HEAD^{tree}"));
    expect(ours).toBe(theirs);
    // Deterministic: 201 trees and the commit share one bounded flush.
    expect(statements).toBe(SCALE_STATEMENTS);
  });

  it("commits 3,293 tree and commit objects within 15 statements", () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    const workspace = makeRepo("/");
    useIdentity(workspace);

    const path = `${Array.from({ length: 3291 }, () => "a").join("/")}/leaf.txt`;
    const data = utf8.encode("leaf\n");
    const blob = workspace.repo.store.write("blob", data);
    workspace.repo.store.indexPut({
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
    expect(statements).toBe(15);
  });
});
