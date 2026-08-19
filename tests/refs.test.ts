import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { utf8, utf8Decoder } from "../src/core/bytes.js";
import {
  configGet,
  configSet,
  remoteAdd,
  remoteList,
  remoteRemove,
} from "../src/core/ops/config.js";
import { initRepository } from "../src/core/ops/init.js";
import type { RemoteView } from "../src/core/ops/kinds.js";
import { catFile, hashObject, repoRoot, symbolicRef, updateRef } from "../src/core/ops/plumbing.js";
import {
  branch,
  branchDelete,
  branchList,
  checkout,
  currentBranch,
  switchBranch,
  tag,
  tagDelete,
  tagList,
} from "../src/core/ops/refs.js";
import { walkWorktree } from "../src/core/ops/worktree-io.js";
import { joinPath } from "../src/core/paths.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import {
  makeRepo,
  makeWorkspace,
  type TestRepository,
  writeWorkFile,
} from "./helpers/workspace.js";

/**
 * Two branches whose trees differ by an added, a deleted and a modified
 * file, plus a directory that only one of them has — so a branch switch
 * has to write, remove and prune.
 */
function buildFixture(): GitFixture {
  const fixture = new GitFixture().init("main");
  fixture.write("common.txt", "same\n");
  fixture.write("modified.txt", "base\n");
  fixture.write("deleted.txt", "gone later\n");
  fixture.write("dir/nested.txt", "nested\n");
  fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "side");
  fixture.write("modified.txt", "side\n");
  fixture.remove("deleted.txt");
  fixture.write("extra/side.txt", "extra\n");
  fixture.commit("side work");
  fixture.git("checkout", "-q", "main");
  fixture.write("modified.txt", "main\n");
  fixture.write("only/main.txt", "only\n");
  fixture.commit("main work");
  fixture.git("tag", "v1");
  return fixture;
}

let fixture: GitFixture;
let ws: TestRepository;

beforeEach(async () => {
  fixture = buildFixture();
  ws = makeRepo("/");
  await importFixture(fixture, ws.repo.store);
});

afterEach(() => fixture.dispose());

/** Every file in the fixture's working tree, `.git` aside. */
function diskTree(dir: string, prefix = "", out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) diskTree(join(dir, entry.name), path, out);
    else out.set(path, readFileSync(join(dir, entry.name), "utf8"));
  }
  return out;
}

function ourTree(): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of walkWorktree(ws.worktree, ws.repo.root)) {
    out.set(path, utf8Decoder.decode(ws.worktree.readFile(joinPath(ws.repo.root, path))));
  }
  return out;
}

function sorted(tree: Map<string, string>): [string, string][] {
  return [...tree].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The whole working tree, ours against git's. */
function expectSameTree(): void {
  expect(sorted(ourTree())).toEqual(sorted(diskTree(fixture.dir)));
}

function indexPaths(): string[] {
  return ws.repo.store.indexEntries().map((entry) => entry.path);
}

function lines(output: string): string[] {
  return output === "" ? [] : output.split("\n");
}

interface GitRun {
  ok: boolean;
  output: string;
}

/** `GitFixture.git` throws on a non-zero exit; failures are the point here. */
function runGit(...args: string[]): GitRun {
  try {
    return { ok: true, output: fixture.git(...args) };
  } catch (error) {
    return { ok: false, output: stderrOf(error) };
  }
}

function stderrOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string") return stderr;
  }
  return String(error);
}

function parseRemotes(output: string): RemoteView[] {
  const urls = new Map<string, string>();
  for (const line of lines(output)) {
    const [name, rest] = line.split("\t");
    if (name === undefined || rest === undefined) continue;
    urls.set(name, rest.replace(/ \((fetch|push)\)$/, ""));
  }
  return [...urls].map(([name, url]) => ({ name, url }));
}

describe("branch", () => {
  it("creates a branch at HEAD and at a start point", () => {
    branch(ws.repo, { name: "feature" });
    branch(ws.repo, { name: "from-side", startPoint: "side" });
    fixture.git("branch", "feature");
    fixture.git("branch", "from-side", "side");

    expect(ws.repo.resolveRef("refs/heads/feature")).toBe(fixture.git("rev-parse", "feature"));
    expect(ws.repo.resolveRef("refs/heads/from-side")).toBe(fixture.git("rev-parse", "from-side"));
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
  });

  it("points HEAD at the new branch when asked, without touching the tree", () => {
    branch(ws.repo, { name: "feature", startPoint: "side", checkout: true });
    expect(ws.repo.head().ref).toBe("refs/heads/feature");
    expect(indexPaths()).toEqual([]);
  });

  it("deletes a branch but refuses to delete the checked-out one", () => {
    branch(ws.repo, { name: "feature" });
    fixture.git("branch", "feature");

    branchDelete(ws.repo, { name: "feature" });
    fixture.git("branch", "-d", "feature");
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));

    expect(() => branchDelete(ws.repo, { name: "main" })).toThrow(/checked out/);
    expect(runGit("branch", "-d", "main").ok).toBe(false);
    expect(branchList(ws.repo)).toContain("main");

    expect(() => branchDelete(ws.repo, { name: "nope" })).toThrow(/not found/);
    expect(runGit("branch", "-d", "nope").ok).toBe(false);
  });

  it("overwrites an existing branch only with force", () => {
    branch(ws.repo, { name: "dup", startPoint: "side" });
    fixture.git("branch", "dup", "side");
    expect(() => branch(ws.repo, { name: "dup", startPoint: "main" })).toThrow(/already exists/);
    expect(runGit("branch", "dup", "main").ok).toBe(false);
    expect(ws.repo.resolveRef("refs/heads/dup")).toBe(fixture.git("rev-parse", "side"));

    branch(ws.repo, { name: "dup", startPoint: "main", force: true });
    fixture.git("branch", "-f", "dup", "main");
    expect(ws.repo.resolveRef("refs/heads/dup")).toBe(fixture.git("rev-parse", "dup"));
  });
});

describe("currentBranch", () => {
  it("reports the short name by default and the full ref with fullname", () => {
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    expect(currentBranch(ws.repo, { fullname: true })).toBe(fixture.git("symbolic-ref", "HEAD"));
    expect(symbolicRef(ws.repo)).toBe("refs/heads/main");
  });

  it("is undefined on a detached HEAD", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    checkout(ws.context, ws.repo, ws.worktree, { ref: "v1" });
    fixture.git("checkout", "-q", "v1");

    expect(currentBranch(ws.repo)).toBeUndefined();
    expect(symbolicRef(ws.repo)).toBeUndefined();
    expect(runGit("symbolic-ref", "HEAD").ok).toBe(false);
  });
});

describe("tag", () => {
  it("creates, lists and deletes lightweight tags", () => {
    tag(ws.repo, { name: "v2" });
    tag(ws.repo, { name: "old", object: "side" });
    fixture.git("tag", "v2");
    fixture.git("tag", "old", "side");

    expect(tagList(ws.repo)).toEqual(lines(fixture.git("tag", "-l")));
    expect(ws.repo.resolveRef("refs/tags/v2")).toBe(fixture.git("rev-parse", "v2"));
    expect(ws.repo.resolveRef("refs/tags/old")).toBe(fixture.git("rev-parse", "old"));
    expect(ws.repo.typeOf(ws.repo.resolveRef("refs/tags/v2") ?? "")).toBe("commit");

    tagDelete(ws.repo, { name: "v2" });
    fixture.git("tag", "-d", "v2");
    expect(tagList(ws.repo)).toEqual(lines(fixture.git("tag", "-l")));
    expect(() => tagDelete(ws.repo, { name: "v2" })).toThrow(/not found/);
    expect(runGit("tag", "-d", "v2").ok).toBe(false);
  });

  it("overwrites an existing tag only with force", () => {
    expect(() => tag(ws.repo, { name: "v1", object: "side" })).toThrow(/already exists/);
    expect(runGit("tag", "v1", "side").ok).toBe(false);

    tag(ws.repo, { name: "v1", object: "side", force: true });
    fixture.git("tag", "-f", "v1", "side");
    expect(ws.repo.resolveRef("refs/tags/v1")).toBe(fixture.git("rev-parse", "v1"));
  });
});

describe("checkout", () => {
  it("materialises a branch and then reconciles the tree across a switch", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    expectSameTree();
    expect(indexPaths()).toEqual(lines(fixture.git("ls-files")));

    checkout(ws.context, ws.repo, ws.worktree, { ref: "side" });
    fixture.git("checkout", "-q", "side");

    expectSameTree();
    expect(indexPaths()).toEqual(lines(fixture.git("ls-files")));
    expect(ws.repo.head().ref).toBe("refs/heads/side");
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    // The added file arrived, the deleted one went, and the directory that
    // held it was pruned.
    expect(ourTree().get("extra/side.txt")).toBe("extra\n");
    expect(ws.worktree.stat("/deleted.txt")).toBeNull();
    expect(ws.worktree.stat("/only")).toBeNull();
  });

  it("updates only the given paths and leaves HEAD alone", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "side" });
    fixture.git("checkout", "-q", "side");

    checkout(ws.context, ws.repo, ws.worktree, { ref: "main", paths: ["modified.txt"] });
    fixture.git("checkout", "main", "--", "modified.txt");

    expectSameTree();
    expect(ws.repo.head().ref).toBe("refs/heads/side");
    expect(currentBranch(ws.repo)).toBe(fixture.git("branch", "--show-current"));
    expect(indexPaths()).toEqual(lines(fixture.git("ls-files")));
    expect(ws.repo.store.indexGet("modified.txt")?.oid).toBe(
      fixture.git("rev-parse", "main:modified.txt"),
    );
  });

  it("refuses to overwrite local changes without force", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    writeWorkFile(ws, "/modified.txt", "locally changed content\n");
    fixture.write("modified.txt", "locally changed content\n");

    expect(() => checkout(ws.context, ws.repo, ws.worktree, { ref: "side" })).toThrow(
      /modified\.txt/,
    );
    expect(runGit("checkout", "side").ok).toBe(false);
    expect(ws.repo.head().ref).toBe("refs/heads/main");

    checkout(ws.context, ws.repo, ws.worktree, { ref: "side", force: true });
    fixture.git("checkout", "-f", "-q", "side");
    expectSameTree();
    expect(ws.repo.head().ref).toBe("refs/heads/side");
  });

  it("carries on when a file the checkout rewrites was deleted locally", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });
    ws.worktree.unlink("/modified.txt");
    fixture.remove("modified.txt");

    checkout(ws.context, ws.repo, ws.worktree, { ref: "side" });
    expect(runGit("checkout", "side").ok).toBe(true);
    expectSameTree();
    expect(ourTree().get("modified.txt")).toBe("side\n");
  });

  it("detaches HEAD on a tag or a raw oid", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });

    checkout(ws.context, ws.repo, ws.worktree, { ref: "v1" });
    fixture.git("checkout", "-q", "v1");
    expect(ws.repo.head()).toEqual({ ref: null, oid: fixture.git("rev-parse", "main") });
    expect(runGit("symbolic-ref", "HEAD").ok).toBe(false);

    const sideOid = fixture.git("rev-parse", "side");
    checkout(ws.context, ws.repo, ws.worktree, { ref: sideOid });
    fixture.git("checkout", "-q", sideOid);
    expect(ws.repo.head()).toEqual({ ref: null, oid: sideOid });
    expect(currentBranch(ws.repo)).toBeUndefined();
    expectSameTree();
  });
});

describe("switch", () => {
  it("moves HEAD, and creates the branch first with create", () => {
    checkout(ws.context, ws.repo, ws.worktree, { ref: "main" });

    switchBranch(ws.context, ws.repo, ws.worktree, { name: "side" });
    fixture.git("switch", "-q", "side");
    expect(ws.repo.head().ref).toBe("refs/heads/side");
    expectSameTree();

    switchBranch(ws.context, ws.repo, ws.worktree, {
      name: "topic",
      create: true,
      startPoint: "main",
    });
    fixture.git("switch", "-q", "-c", "topic", "main");
    expect(ws.repo.head().ref).toBe("refs/heads/topic");
    expect(branchList(ws.repo)).toEqual(lines(fixture.git("branch", "--format=%(refname:short)")));
    expectSameTree();

    expect(() =>
      switchBranch(ws.context, ws.repo, ws.worktree, { name: "topic", create: true }),
    ).toThrow(/already exists/);
  });
});

describe("config", () => {
  it("gets, sets, appends and unsets", () => {
    configSet(ws.repo, { path: "user.email", value: "author@example.com" });
    fixture.git("config", "user.email", "author@example.com");
    expect(configGet(ws.repo, { path: "user.email" })).toBe(fixture.git("config", "user.email"));

    configSet(ws.repo, { path: "kompjutr.item", value: "one", append: true });
    configSet(ws.repo, { path: "kompjutr.item", value: "two", append: true });
    fixture.git("config", "--add", "kompjutr.item", "one");
    fixture.git("config", "--add", "kompjutr.item", "two");
    expect(configGet(ws.repo, { path: "kompjutr.item", all: true })).toEqual(
      lines(fixture.git("config", "--get-all", "kompjutr.item")),
    );
    // `--get` reports the last value of a multi-valued key.
    expect(configGet(ws.repo, { path: "kompjutr.item" })).toBe(
      fixture.git("config", "--get", "kompjutr.item"),
    );

    configSet(ws.repo, { path: "kompjutr.flag", value: false });
    expect(configGet(ws.repo, { path: "kompjutr.flag" })).toBe("false");

    configSet(ws.repo, { path: "user.email", value: undefined });
    fixture.git("config", "--unset", "user.email");
    expect(configGet(ws.repo, { path: "user.email" })).toBeUndefined();
    expect(runGit("config", "--get", "user.email").ok).toBe(false);
  });

  it("reports a missing key as undefined", () => {
    expect(configGet(ws.repo, { path: "nothing.here" })).toBeUndefined();
    expect(configGet(ws.repo, { path: "nothing.here", all: true })).toEqual([]);
    expect(runGit("config", "--get", "nothing.here").ok).toBe(false);
  });
});

describe("remotes", () => {
  it("round-trips remotes and matches git remote -v", () => {
    remoteAdd(ws.repo, { name: "origin", url: "https://example.com/one.git" });
    remoteAdd(ws.repo, { name: "upstream", url: "https://example.com/two.git" });
    fixture.git("remote", "add", "origin", "https://example.com/one.git");
    fixture.git("remote", "add", "upstream", "https://example.com/two.git");

    expect(remoteList(ws.repo)).toEqual(parseRemotes(fixture.git("remote", "-v")));
    expect(configGet(ws.repo, { path: "remote.origin.fetch" })).toBe(
      fixture.git("config", "--get", "remote.origin.fetch"),
    );

    expect(() =>
      remoteAdd(ws.repo, { name: "origin", url: "https://example.com/three.git" }),
    ).toThrow(/already exists/);
    expect(runGit("remote", "add", "origin", "https://example.com/three.git").ok).toBe(false);

    remoteAdd(ws.repo, { name: "origin", url: "https://example.com/three.git", force: true });
    fixture.git("remote", "set-url", "origin", "https://example.com/three.git");
    expect(remoteList(ws.repo)).toEqual(parseRemotes(fixture.git("remote", "-v")));

    remoteRemove(ws.repo, { name: "origin" });
    fixture.git("remote", "remove", "origin");
    expect(remoteList(ws.repo)).toEqual(parseRemotes(fixture.git("remote", "-v")));
    expect(configGet(ws.repo, { path: "remote.origin.fetch" })).toBeUndefined();
    expect(() => remoteRemove(ws.repo, { name: "origin" })).toThrow(/no such remote/);
    expect(runGit("remote", "remove", "origin").ok).toBe(false);
  });
});

describe("plumbing", () => {
  it("hashes a blob the way git hash-object does", () => {
    const content = "hello from the fixture\n";
    fixture.write("hash-me.txt", content);
    const expected = fixture.git("hash-object", "hash-me.txt");

    expect(hashObject(ws.repo, { content })).toBe(expected);
    expect(hashObject(ws.repo, { content: utf8.encode(content) })).toBe(expected);
    expect(ws.repo.has(expected)).toBe(false);

    expect(hashObject(ws.repo, { content, write: true })).toBe(
      fixture.git("hash-object", "-w", "hash-me.txt"),
    );
    expect(utf8Decoder.decode(ws.repo.readBlob(expected))).toBe(content);
  });

  it("reads objects back, by oid, by filepath and by shorthand", () => {
    const commit = fixture.git("rev-parse", "main");
    const blob = fixture.git("rev-parse", "main:common.txt");

    expect(utf8Decoder.decode(catFile(ws.repo, { oid: blob }).bytes)).toBe("same\n");
    expect(catFile(ws.repo, { oid: commit, filepath: "common.txt" }).oid).toBe(blob);
    const shorthand = catFile(ws.repo, { oid: `${commit}:common.txt` });
    expect(shorthand.oid).toBe(blob);
    expect(utf8Decoder.decode(shorthand.bytes)).toBe(utf8Decoder.decode(fixture.catFile(blob)));
  });

  it("writes refs and symbolic refs", () => {
    const sideOid = fixture.git("rev-parse", "side");
    const mainOid = fixture.git("rev-parse", "main");

    updateRef(ws.repo, { ref: "refs/heads/fresh", value: sideOid });
    fixture.git("update-ref", "refs/heads/fresh", sideOid);
    expect(ws.repo.resolveRef("refs/heads/fresh")).toBe(fixture.git("rev-parse", "fresh"));

    // A ref name resolves like a revision does.
    updateRef(ws.repo, { ref: "refs/heads/named", value: "main" });
    expect(ws.repo.resolveRef("refs/heads/named")).toBe(mainOid);

    expect(() => updateRef(ws.repo, { ref: "refs/heads/fresh", value: mainOid })).toThrow(
      /already exists/,
    );
    updateRef(ws.repo, { ref: "refs/heads/fresh", value: mainOid, force: true });
    expect(ws.repo.resolveRef("refs/heads/fresh")).toBe(mainOid);

    updateRef(ws.repo, { ref: "refs/heads/alias", value: "refs/heads/side", symbolic: true });
    expect(ws.repo.resolveRef("refs/heads/alias")).toBe(sideOid);

    updateRef(ws.repo, { ref: "HEAD", value: "refs/heads/side", symbolic: true, force: true });
    fixture.git("symbolic-ref", "HEAD", "refs/heads/side");
    expect(symbolicRef(ws.repo)).toBe(fixture.git("symbolic-ref", "HEAD"));
  });

  it("finds the repository root and refuses outside one", () => {
    const other = makeWorkspace();
    initRepository(other.context, { dir: "/work" });

    expect(repoRoot(other.context, { dir: "/work/src/deep" })).toBe("/work");
    expect(repoRoot(ws.context, { dir: "/anywhere" })).toBe("/");
    expect(() => repoRoot(other.context, { dir: "/elsewhere" })).toThrow(/not a git repository/);
  });
});
