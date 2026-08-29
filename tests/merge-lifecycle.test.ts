import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { utf8, utf8Decoder } from "../src/core/bytes.js";
import type { GitContext } from "../src/core/context.js";
import { MODE_FILE, serializeCommit, serializeTree } from "../src/core/objects.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { merge, mergeAbort, mergeContinue } from "../src/core/ops/merge.js";
import { operationRefLogMetadata } from "../src/core/ops/ref-log.js";
import { add } from "../src/core/ops/staging.js";
import { Repository } from "../src/core/repository.js";
import { createGit, type Git } from "../src/git/client.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository, writeWorkFile } from "./helpers/workspace.js";
import { CountingWorktree } from "./helpers/worktree.js";

const IDENTITY = { name: "Fixture", email: "fixture@example.com" };
const fixtures: GitFixture[] = [];

interface History {
  fixture: GitFixture;
  base: string;
  current: string;
  incoming: string;
}

type DistinctPathKind = "absent" | "regular" | "symlink";

interface DistinctTypeScenario {
  name: string;
  base: DistinctPathKind;
  current: "regular" | "symlink";
  incoming: "regular" | "symlink";
  relocation: string;
  relocationPurpose: "current-relocation" | "incoming-relocation";
}

const DEFAULT_DISTINCT_TYPE_SCENARIO: DistinctTypeScenario = {
  name: "base absent, current regular, incoming symlink",
  base: "absent",
  current: "regular",
  incoming: "symlink",
  relocation: "lnk~HEAD",
  relocationPurpose: "current-relocation",
};

const DISTINCT_TYPE_SCENARIOS: readonly DistinctTypeScenario[] = [
  DEFAULT_DISTINCT_TYPE_SCENARIO,
  {
    name: "base absent, current symlink, incoming regular",
    base: "absent",
    current: "symlink",
    incoming: "regular",
    relocation: "lnk~topic",
    relocationPurpose: "incoming-relocation",
  },
  {
    name: "regular base, current regular, incoming symlink",
    base: "regular",
    current: "regular",
    incoming: "symlink",
    relocation: "lnk~HEAD",
    relocationPurpose: "current-relocation",
  },
  {
    name: "symlink base, current symlink, incoming regular",
    base: "symlink",
    current: "symlink",
    incoming: "regular",
    relocation: "lnk~topic",
    relocationPurpose: "incoming-relocation",
  },
];

interface CrissCrossHistory extends History {
  bestBases: readonly [string, string];
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function newFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  return fixture;
}

function cleanDivergence(): History {
  const fixture = newFixture();
  fixture.write("base.txt", "base\n");
  fixture.write("sentinel.txt", "sentinel\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic");
  fixture.write("topic.txt", "topic\n");
  const incoming = fixture.commit("topic");
  fixture.git("checkout", "-q", "main");
  fixture.write("main.txt", "main\n");
  const current = fixture.commit("main");
  return { fixture, base, current, incoming };
}

function conflictingDivergence(): History {
  const fixture = newFixture();
  fixture.write("conflict.txt", "base\n");
  fixture.write("sentinel.txt", "sentinel\n");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic");
  fixture.write("conflict.txt", "incoming\n");
  const incoming = fixture.commit("topic");
  fixture.git("checkout", "-q", "main");
  fixture.write("conflict.txt", "current\n");
  const current = fixture.commit("main");
  return { fixture, base, current, incoming };
}

function writeDistinctPath(fixture: GitFixture, kind: DistinctPathKind, version: string): void {
  fixture.remove("lnk");
  if (kind === "regular") fixture.write("lnk", `${version} file\n`);
  if (kind === "symlink") fixture.symlink(`${version}-target.txt`, "lnk");
}

function distinctTypeDivergence(
  scenario: DistinctTypeScenario = DEFAULT_DISTINCT_TYPE_SCENARIO,
): History {
  const fixture = newFixture();
  fixture.write("base-target.txt", "base target\n");
  fixture.write("current-target.txt", "current target\n");
  fixture.write("incoming-target.txt", "incoming target\n");
  writeDistinctPath(fixture, scenario.base, "base");
  const base = fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic");
  writeDistinctPath(fixture, scenario.incoming, "incoming");
  const incoming = fixture.commit(`topic ${scenario.incoming}`);
  fixture.git("checkout", "-q", "main");
  writeDistinctPath(fixture, scenario.current, "current");
  const current = fixture.commit(`main ${scenario.current}`);
  return { fixture, base, current, incoming };
}

function crissCrossDivergence(stableDirectories = 0): CrissCrossHistory {
  const fixture = newFixture();
  fixture.write("conflict.txt", "base\n");
  for (let ordinal = 0; ordinal < stableDirectories; ordinal++) {
    fixture.write(`d${ordinal.toString().padStart(3, "0")}/file.txt`, `${ordinal}\n`);
  }
  const base = fixture.commit("base");

  fixture.git("checkout", "-q", "-b", "side-a");
  fixture.write("conflict.txt", "a1\n");
  const a1 = fixture.commit("A1");

  fixture.git("checkout", "-q", "-b", "side-b", base);
  fixture.write("conflict.txt", "b1\n");
  const b1 = fixture.commit("B1");

  fixture.git("checkout", "-q", "side-a");
  expect(() => fixture.git("merge", "--no-edit", b1)).toThrow();
  fixture.write("conflict.txt", "a1+b1\n");
  fixture.commit("merge B1 into A1");

  fixture.git("checkout", "-q", "side-b");
  expect(() => fixture.git("merge", "--no-edit", a1)).toThrow();
  fixture.write("conflict.txt", "b1+a1\n");
  fixture.commit("merge A1 into B1");

  fixture.git("checkout", "-q", "side-a");
  fixture.write("conflict.txt", "a2\n");
  const current = fixture.commit("A2");
  fixture.git("checkout", "-q", "side-b");
  fixture.write("conflict.txt", "b2\n");
  const incoming = fixture.commit("B2");
  fixture.git("checkout", "-q", "side-a");

  return { fixture, base, current, incoming, bestBases: [a1, b1] };
}

async function clonedFrom(fixture: GitFixture): Promise<TestRepository> {
  const workspace = makeRepo("/", { now: () => 1_577_836_800_000 });
  await importFixture(fixture, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.repo.store.configSet("user.name", IDENTITY.name);
  workspace.repo.store.configSet("user.email", IDENTITY.email);
  return workspace;
}

function textAt(workspace: TestRepository, path: string): string | null {
  if (workspace.worktree.stat(`/${path}`) === null) return null;
  return utf8Decoder.decode(workspace.worktree.readFile(`/${path}`));
}

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

function reopen(workspace: TestRepository): { context: GitContext; repo: Repository } {
  const database = new SqliteGitDatabase(new TestDatabase(workspace.storage), {
    now: workspace.context.now,
  });
  const row = database.findCheckout("/");
  if (row === null) throw new Error("reopened repository is missing");
  return {
    context: { ...workspace.context, database },
    repo: new Repository(database.openCheckout(row)),
  };
}

function nativeGit(workspace: TestRepository): Git {
  return createGit()({
    database: workspace.database,
    worktree: workspace.worktree,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
  });
}

function snapshot(workspace: TestRepository): {
  refs: ReturnType<TestRepository["repo"]["store"]["listRefs"]>;
  index: ReturnType<TestRepository["repo"]["checkout"]["indexEntries"]>;
  objects: number;
  conflict: string | null;
  sentinel: string | null;
  reflogEntries: number;
  reflogOrdinal: number;
} {
  return {
    refs: workspace.repo.store.listRefs(),
    index: workspace.repo.checkout.indexEntries(),
    objects: workspace.repo.store.objectCount(),
    conflict: textAt(workspace, "conflict.txt"),
    sentinel: textAt(workspace, "sentinel.txt"),
    reflogEntries:
      workspace.repo.store.db.scalar<number>(
        "SELECT count(*) FROM git_reflog_entries WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ) ?? -1,
    reflogOrdinal:
      workspace.repo.store.db.scalar<number>(
        "SELECT next_ordinal FROM git_reflog_state WHERE repo_id = ?",
        workspace.repo.store.repoId,
      ) ?? -1,
  };
}

describe("merge lifecycle", () => {
  it("returns already-merged without mutating refs, index, objects, or worktree", async () => {
    const fixture = newFixture();
    fixture.write("base.txt", "base\n");
    fixture.commit("base");
    fixture.git("branch", "topic");
    fixture.write("main.txt", "main\n");
    const current = fixture.commit("main");
    const workspace = await clonedFrom(fixture);
    const before = snapshot(workspace);
    workspace.storage.histogram = new Map();
    workspace.storage.resetCounters();

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, {
        theirs: "topic",
        ours: "HEAD",
      }),
    ).toEqual({ oid: current, alreadyMerged: true });

    expect(snapshot(workspace)).toEqual(before);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(
      [...(workspace.storage.histogram?.keys() ?? [])].filter((query) =>
        /^(?:INSERT|UPDATE|DELETE|REPLACE)/.test(query),
      ),
    ).toEqual([]);
  });

  it("fast-forwards while preserving unrelated staged, dirty, and untracked changes", async () => {
    const fixture = newFixture();
    fixture.write("sentinel.txt", "sentinel\n");
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("topic.txt", "topic\n");
    const incoming = fixture.commit("topic");
    fixture.git("checkout", "-q", "main");
    const workspace = await clonedFrom(fixture);
    expect(workspace.repo.head().oid).toBe(base);
    writeWorkFile(workspace, "/sentinel.txt", "dirty sentinel\n");
    writeWorkFile(workspace, "/staged.txt", "staged\n");
    add(workspace.repo, workspace.worktree, { paths: ["staged.txt"] });
    const staged = workspace.repo.checkout.indexGet("staged.txt");
    writeWorkFile(workspace, "/untracked.txt", "untracked\n");

    await expect(nativeGit(workspace).merge({ theirs: "topic", commit: false })).resolves.toEqual({
      oid: incoming,
      fastForward: true,
    });

    expect(workspace.repo.head().oid).toBe(incoming);
    expect(textAt(workspace, "topic.txt")).toBe("topic\n");
    expect(textAt(workspace, "sentinel.txt")).toBe("dirty sentinel\n");
    expect(textAt(workspace, "staged.txt")).toBe("staged\n");
    expect(textAt(workspace, "untracked.txt")).toBe("untracked\n");
    expect(workspace.repo.checkout.indexGet("staged.txt")).toEqual(staged);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    const named = workspace.repo.store.reflog("refs/heads/main")[0];
    const head = workspace.repo.checkout.reflog("HEAD")[0];
    expect(named).toMatchObject({
      oldOid: base,
      newOid: incoming,
      actor: IDENTITY,
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
      reason: "merge: fast-forward",
    });
    expect(head).toMatchObject({
      oldOid: base,
      newOid: incoming,
      actor: IDENTITY,
      reason: "merge: fast-forward",
    });
    if (named === undefined || head === undefined)
      throw new Error("fast-forward reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("selects pull publication reasons through the typed merge origin", async () => {
    const fastForwardFixture = newFixture();
    fastForwardFixture.write("base.txt", "base\n");
    fastForwardFixture.commit("base");
    fastForwardFixture.git("checkout", "-q", "-b", "topic");
    fastForwardFixture.write("topic.txt", "topic\n");
    fastForwardFixture.commit("topic");
    fastForwardFixture.git("checkout", "-q", "main");
    const fastForward = await clonedFrom(fastForwardFixture);

    merge(
      fastForward.context,
      fastForward.repo,
      fastForward.worktree,
      { theirs: "topic" },
      { origin: "pull" },
    );
    expect(fastForward.repo.store.reflog("refs/heads/main")[0]?.reason).toBe("pull: fast-forward");

    const history = cleanDivergence();
    const committed = await clonedFrom(history.fixture);
    const result = merge(
      committed.context,
      committed.repo,
      committed.worktree,
      { theirs: "topic" },
      { origin: "pull" },
    );
    if (result.oid === undefined) throw new Error("pull-selected merge returned no commit");
    expect(committed.repo.store.reflog("refs/heads/main")[0]).toMatchObject({
      oldOid: history.current,
      newOid: result.oid,
      actor: IDENTITY,
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
      reason: "pull: merge",
    });
  });

  it("refuses a fast-forward while the index has unrelated unresolved stages", async () => {
    const fixture = newFixture();
    fixture.write("sentinel.txt", "sentinel\n");
    const current = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("topic.txt", "topic\n");
    fixture.commit("topic");
    fixture.git("checkout", "-q", "main");
    const workspace = await clonedFrom(fixture);
    const sentinel = workspace.repo.checkout.indexGet("sentinel.txt");
    if (sentinel === null) throw new Error("missing sentinel index entry");
    workspace.repo.checkout.indexRemove("sentinel.txt");
    workspace.repo.checkout.indexPut({ ...sentinel, stage: 1 });
    workspace.repo.checkout.indexPut({ ...sentinel, stage: 2 });
    const before = snapshot(workspace);

    expect(() =>
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toThrowError(expect.objectContaining({ code: "EUNMERGED" }));

    expect(snapshot(workspace)).toEqual(before);
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);
  });

  it("hashes a dirty file past the former range-read cap and reports the real blocker", async () => {
    const fixture = newFixture();
    fixture.write("guard.txt", "base\n");
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("guard.txt", "incoming\n");
    fixture.commit("topic");
    fixture.git("checkout", "-q", "main");
    const workspace = await clonedFrom(fixture);
    const dirty = "x".repeat(4 * 1024 * 1024 + 1);
    writeWorkFile(workspace, "/guard.txt", dirty);
    const worktree = new CountingWorktree(workspace.worktree);
    expect(() =>
      merge(workspace.context, workspace.repo, worktree, { theirs: "topic" }),
    ).toThrowError(expect.objectContaining({ code: "ECHECKOUTFAIL" }));

    expect(worktree.rangeReads).toBe(65);
    expect(workspace.repo.head().oid).toBe(base);
    expect(textAt(workspace, "guard.txt")).toBe(dirty);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("creates the same clean divergent merge commit with current then incoming parents", async () => {
    const history = cleanDivergence();
    const workspace = await clonedFrom(history.fixture);

    const result = merge(workspace.context, workspace.repo, workspace.worktree, {
      theirs: "topic",
    });
    history.fixture.git("merge", "--no-ff", "-m", "Merge branch 'topic'", "topic");
    const expected = history.fixture.git("rev-parse", "HEAD");

    expect(result).toEqual({ oid: expected });
    expect(workspace.repo.readCommit(expected).parent).toEqual([history.current, history.incoming]);
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(history.fixture));
    expect(textAt(workspace, "main.txt")).toBe("main\n");
    expect(textAt(workspace, "topic.txt")).toBe("topic\n");
    const named = workspace.repo.store.reflog("refs/heads/main")[0];
    const head = workspace.repo.checkout.reflog("HEAD")[0];
    expect(named).toMatchObject({
      oldOid: history.current,
      newOid: expected,
      actor: IDENTITY,
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
      reason: "merge: commit",
    });
    expect(head).toMatchObject({
      oldOid: history.current,
      newOid: expected,
      reason: "merge: commit",
    });
    if (named === undefined || head === undefined) throw new Error("merge reflog is missing");
    expect(head.ordinal).toBe(named.ordinal + 1);
  });

  it("rolls back a clean merge when publication fails after the ref mutation", async () => {
    const history = cleanDivergence();
    const workspace = await clonedFrom(history.fixture);
    const before = snapshot(workspace);
    const originalUpdate = workspace.repo.mutateRefs.bind(workspace.repo);
    workspace.repo.mutateRefs = (mutation, metadata) => {
      originalUpdate(mutation, metadata);
      throw new Error("late merge publication fault");
    };

    expect(() =>
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toThrow("late merge publication fault");

    expect(snapshot(workspace)).toEqual(before);
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);
  });

  it("reads a configured reflog identity and skips config for an explicit actor", () => {
    const workspace = makeRepo("/");
    workspace.repo.store.configSet("user.name", "Configured");
    workspace.repo.store.configSet("user.email", "configured@example.com");
    workspace.storage.resetCounters();

    expect(
      operationRefLogMetadata(workspace.context, workspace.repo, "merge: fast-forward").actor,
    ).toEqual({
      name: "Configured",
      email: "configured@example.com",
    });
    workspace.storage.resetCounters();
    expect(
      operationRefLogMetadata(workspace.context, workspace.repo, "merge: fast-forward", {
        identity: { name: "Explicit", email: "explicit@example.com" },
      }).actor,
    ).toEqual({ name: "Explicit", email: "explicit@example.com" });
    expect(workspace.storage.statementCount).toBe(0);
  });

  it("rejects angle brackets in an optional reflog actor", () => {
    const workspace = makeRepo("/");

    expect(
      operationRefLogMetadata(workspace.context, workspace.repo, "merge: fast-forward", {
        identity: { name: "Invalid <Actor", email: "invalid>actor@example.com" },
      }).actor,
    ).toBeNull();
  });

  it("persists a no-commit merge across reopen and continues with ordered parents", async () => {
    const history = cleanDivergence();
    const workspace = await clonedFrom(history.fixture);

    expect(
      merge(
        workspace.context,
        workspace.repo,
        workspace.worktree,
        { theirs: "topic", commit: false },
        { origin: "pull" },
      ),
    ).toEqual({ pendingCommit: true });
    expect(workspace.repo.head().oid).toBe(history.current);
    expect(workspace.repo.checkout.requireMergeState().state.phase).toBe("ready");
    expect(textAt(workspace, "topic.txt")).toBe("topic\n");
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);

    const cold = reopen(workspace);
    const result = mergeContinue(cold.context, cold.repo);

    if (result.oid === undefined) throw new Error("merge continuation returned no oid");
    expect(cold.repo.readCommit(result.oid).parent).toEqual([history.current, history.incoming]);
    expect(cold.repo.checkout.readMergeState()).toBeNull();
    expect(cold.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: history.current,
        newOid: result.oid,
        actor: IDENTITY,
        timestamp: 1_577_836_800,
        timezoneOffset: 0,
        reason: "pull: merge",
      }),
    ]);
  });

  it("rejects before publishing a pending merge that exceeds the continuation index bound", () => {
    const workspace = makeRepo("/");
    const blob = workspace.repo.store.write("blob", utf8.encode("same\n"));
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      mode: MODE_FILE,
      name: `f${String(index).padStart(5, "0")}`,
      oid: blob,
    }));
    const currentTree = workspace.repo.store.write("tree", serializeTree(entries));
    const incomingTree = workspace.repo.store.write(
      "tree",
      serializeTree([...entries, { mode: MODE_FILE, name: "z-added", oid: blob }]),
    );
    const person = {
      name: IDENTITY.name,
      email: IDENTITY.email,
      timestamp: 1_577_836_800,
      timezoneOffset: 0,
    };
    const current = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree: currentTree,
        parent: [],
        author: person,
        committer: person,
        message: "current\n",
      }),
    );
    const incoming = workspace.repo.store.write(
      "commit",
      serializeCommit({
        tree: incomingTree,
        parent: [current],
        author: person,
        committer: person,
        message: "incoming\n",
      }),
    );
    workspace.repo.store.setRef("refs/heads/main", current);
    workspace.repo.store.setRef("refs/heads/topic", incoming);
    workspace.repo.checkout.indexReplace(
      entries.map((entry) => ({
        path: entry.name,
        stage: 0,
        mode: 0o100644,
        oid: entry.oid,
        size: null,
        mtime: null,
        ino: null,
        rev: null,
      })),
    );

    expect(() =>
      merge(workspace.context, workspace.repo, workspace.worktree, {
        theirs: "topic",
        fastForward: false,
        commit: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.repo.head().oid).toBe(current);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.repo.checkout.indexGet("z-added")).toBeNull();
  });

  it("lets ordinary public commit finalize a pending merge exactly once", async () => {
    const history = cleanDivergence();
    const workspace = await clonedFrom(history.fixture);
    const git = nativeGit(workspace);

    await expect(git.merge({ theirs: "topic", commit: false })).resolves.toEqual({
      pendingCommit: true,
    });
    const committed = await nativeGit(workspace).commit({ message: "finish merge" });

    expect(workspace.repo.readCommit(committed.oid).parent).toEqual([
      history.current,
      history.incoming,
    ]);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    await expect(git.mergeContinue()).rejects.toMatchObject({ code: "ENOMERGE" });
    await expect(git.mergeAbort()).rejects.toMatchObject({ code: "ENOMERGE" });
  });

  it("bounds final merge identities, messages, and revision inputs", async () => {
    const history = cleanDivergence();
    const workspace = await clonedFrom(history.fixture);
    const before = snapshot(workspace);

    expect(() =>
      merge(workspace.context, workspace.repo, workspace.worktree, {
        theirs: "topic",
        env: {
          GIT_AUTHOR_NAME: "x".repeat(1_025),
          GIT_AUTHOR_EMAIL: "author@example.com",
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(snapshot(workspace)).toEqual(before);

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, {
        theirs: "topic",
        commit: false,
      }),
    ).toEqual({ pendingCommit: true });
    expect(() =>
      mergeContinue(workspace.context, workspace.repo, {
        message: "x".repeat(1024 * 1024 + 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(workspace.repo.checkout.readMergeState()).not.toBeNull();

    mergeAbort(workspace.repo, workspace.worktree);
    expect(() =>
      merge(workspace.context, workspace.repo, workspace.worktree, {
        theirs: "x".repeat(1_025),
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("fails input guards atomically and can force a merge commit over a fast-forward", async () => {
    const divergent = cleanDivergence();
    const guarded = await clonedFrom(divergent.fixture);
    const guardedGit = nativeGit(guarded);
    const beforeWrongOurs = snapshot(guarded);

    await expect(guardedGit.merge({ theirs: "topic", ours: "topic" })).rejects.toMatchObject({
      code: "EWRONGHEAD",
    });
    await expect(
      guardedGit.merge({ theirs: "topic", fastForwardOnly: true }),
    ).rejects.toMatchObject({ code: "ENONFF" });
    expect(snapshot(guarded)).toEqual(beforeWrongOurs);

    await guardedGit.checkout({ ref: divergent.current });
    const beforeDetached = snapshot(guarded);
    await expect(guardedGit.merge({ theirs: "topic" })).rejects.toMatchObject({
      code: "EDETACHED",
    });
    expect(snapshot(guarded)).toEqual(beforeDetached);

    const fixture = newFixture();
    fixture.write("base.txt", "base\n");
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("topic.txt", "topic\n");
    const incoming = fixture.commit("topic");
    fixture.git("checkout", "-q", "main");
    const forced = await clonedFrom(fixture);

    const result = await nativeGit(forced).merge({ theirs: "topic", fastForward: false });
    if (result.oid === undefined) throw new Error("forced merge returned no oid");
    expect(forced.repo.readCommit(result.oid).parent).toEqual([base, incoming]);
    expect(forced.repo.head().oid).toBe(result.oid);
    expect(forced.repo.checkout.readMergeState()).toBeNull();
  });

  it("matches Git conflict markers and stages, then continues after add", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);

    expect(() => history.fixture.git("merge", "topic")).toThrow();
    const gitMarkers = readFileSync(join(history.fixture.dir, "conflict.txt"), "utf8");
    const result = merge(workspace.context, workspace.repo, workspace.worktree, {
      theirs: "topic",
    });

    expect(result).toEqual({ conflicted: true, pendingCommit: true });
    expect(textAt(workspace, "conflict.txt")).toBe(gitMarkers);
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(history.fixture));
    expect(workspace.repo.checkout.requireMergeState().state.phase).toBe("conflicted");
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([]);
    expect(workspace.repo.checkout.reflog("HEAD")).toEqual([]);

    writeWorkFile(workspace, "/conflict.txt", "resolved\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"] });
    history.fixture.write("conflict.txt", "resolved\n");
    history.fixture.git("add", "conflict.txt");
    history.fixture.git("commit", "-q", "--no-edit");

    const continued = mergeContinue(workspace.context, workspace.repo);
    const expected = history.fixture.git("rev-parse", "HEAD");
    expect(continued).toEqual({ oid: expected });
    const commit = workspace.repo.readCommit(expected);
    expect(commit.parent).toEqual([history.current, history.incoming]);
    expect(commit.tree).toBe(history.fixture.git("rev-parse", `${expected}^{tree}`));
    expect(commit.message).toBe(`${history.fixture.git("log", "-1", "--format=%B", expected)}\n`);
    expect(indexLines(workspace.repo)).toEqual(gitIndexLines(history.fixture));
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.repo.store.reflog("refs/heads/main")).toEqual([
      expect.objectContaining({
        oldOid: history.current,
        newOid: expected,
        actor: IDENTITY,
        timestamp: 1_577_836_800,
        timezoneOffset: 0,
        reason: "merge: commit",
      }),
    ]);
  });

  it.each(DISTINCT_TYPE_SCENARIOS)(
    "matches Git's $name distinct-type stages and aborts cold",
    async (scenario) => {
      const history = distinctTypeDivergence(scenario);
      const workspace = await clonedFrom(history.fixture);
      const beforeIndex = workspace.repo.checkout.indexEntries();

      expect(() => history.fixture.git("merge", "topic")).toThrow();
      expect(
        merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
      ).toEqual({ conflicted: true, pendingCommit: true });
      expect(indexLines(workspace.repo)).toEqual(gitIndexLines(history.fixture));
      expect(workspace.worktree.readlink("/lnk")).toBe(
        readlinkSync(join(history.fixture.dir, "lnk")),
      );
      expect(textAt(workspace, scenario.relocation)).toBe(
        readFileSync(join(history.fixture.dir, scenario.relocation), "utf8"),
      );
      expect(workspace.repo.checkout.requireMergeState().touched).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "lnk", logicalPath: "lnk", purpose: "primary" }),
          expect.objectContaining({
            path: scenario.relocation,
            logicalPath: "lnk",
            purpose: scenario.relocationPurpose,
            worktree: { kind: "absent" },
          }),
        ]),
      );

      const cold = reopen(workspace);
      mergeAbort(cold.repo, workspace.worktree);

      expect(cold.repo.head().oid).toBe(history.current);
      expect(cold.repo.checkout.indexEntries()).toEqual(beforeIndex);
      if (scenario.current === "regular") {
        expect(textAt(workspace, "lnk")).toBe("current file\n");
      } else {
        expect(workspace.worktree.readlink("/lnk")).toBe("current-target.txt");
      }
      expect(workspace.worktree.stat(`/${scenario.relocation}`)).toBeNull();
      expect(cold.repo.checkout.readMergeState()).toBeNull();
    },
  );

  it("preserves a distinct-type merge when abort would remove an outside descendant", async () => {
    const history = distinctTypeDivergence();
    const workspace = await clonedFrom(history.fixture);

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    workspace.worktree.removeFiles(["/lnk~HEAD"]);
    writeWorkFile(workspace, "/lnk~HEAD/outside.txt", "outside\n");
    const cold = reopen(workspace);

    expect(() => mergeAbort(cold.repo, workspace.worktree)).toThrow(
      expect.objectContaining({ code: "ECHECKOUTFAIL" }),
    );
    expect(textAt(workspace, "lnk~HEAD/outside.txt")).toBe("outside\n");
    expect(cold.repo.checkout.readMergeState()).not.toBeNull();
    expect(cold.repo.head().oid).toBe(history.current);
  });

  it("refuses a gitlink distinct-type conflict atomically", async () => {
    const fixture = newFixture();
    fixture.write("base.txt", "base\n");
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.git("update-index", "--add", "--cacheinfo", `160000,${base},lnk`);
    fixture.git("commit", "-q", "-m", "topic gitlink");
    fixture.git("checkout", "-q", "main");
    fixture.remove("lnk");
    fixture.write("lnk", "current file\n");
    fixture.commit("main file");
    const workspace = await clonedFrom(fixture);
    const before = snapshot(workspace);
    const beforeIndex = workspace.repo.checkout.indexEntries();

    expect(() =>
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toThrow(expect.objectContaining({ code: "EUNSUPPORTED" }));

    expect(snapshot(workspace)).toEqual(before);
    expect(workspace.repo.checkout.indexEntries()).toEqual(beforeIndex);
    expect(textAt(workspace, "lnk")).toBe("current file\n");
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("aborts with exact index and owned-path restoration while preserving sentinels", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);
    writeWorkFile(workspace, "/sentinel.txt", "dirty sentinel\n");
    writeWorkFile(workspace, "/untracked.txt", "untracked sentinel\n");
    const beforeIndex = workspace.repo.checkout.indexEntries();

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    expect(textAt(workspace, "conflict.txt")).not.toBe("current\n");

    mergeAbort(workspace.repo, workspace.worktree);

    expect(workspace.repo.head().oid).toBe(history.current);
    expect(workspace.repo.checkout.indexEntries()).toEqual(beforeIndex);
    expect(textAt(workspace, "conflict.txt")).toBe("current\n");
    expect(textAt(workspace, "sentinel.txt")).toBe("dirty sentinel\n");
    expect(textAt(workspace, "untracked.txt")).toBe("untracked sentinel\n");
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("restores an originally missing tracked conflict path on abort", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);
    workspace.worktree.unlink("/conflict.txt");
    const originalIndex = workspace.repo.checkout.indexGet("conflict.txt");

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    expect(workspace.repo.checkout.requireMergeState().touched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "conflict.txt", worktree: { kind: "absent" } }),
      ]),
    );

    mergeAbort(workspace.repo, workspace.worktree);

    expect(textAt(workspace, "conflict.txt")).toBeNull();
    expect(workspace.repo.checkout.indexGet("conflict.txt")).toEqual(originalIndex);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("rejects a journal path retarget before abort can delete unrelated content", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);
    writeWorkFile(workspace, "/sentinel.txt", "unrelated\n");

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    workspace.database.db.run(
      `UPDATE git_operation_touched
          SET path = 'sentinel.txt', logical_path = 'sentinel.txt'
        WHERE checkout_id = ? AND path = 'conflict.txt'`,
      workspace.repo.store.repoId,
    );

    expect(() => mergeAbort(workspace.repo, workspace.worktree)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(textAt(workspace, "sentinel.txt")).toBe("unrelated\n");
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_operation_state WHERE checkout_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(1);
  });

  it("rejects a type-valid snapshot retarget before abort restores it", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    const incoming = workspace.repo.checkout.indexGet("conflict.txt", 3);
    if (incoming === null) throw new Error("expected incoming conflict stage");
    workspace.database.db.run(
      `UPDATE git_operation_touched
          SET worktree_oid = ?
        WHERE checkout_id = ? AND path = 'conflict.txt'`,
      incoming.oid,
      workspace.repo.store.repoId,
    );

    expect(() => mergeAbort(workspace.repo, workspace.worktree)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_operation_state WHERE checkout_id = ?",
        workspace.repo.store.repoId,
      ),
    ).toBe(1);
  });

  it("rejects substituting another valid incoming parent after conflict resolution", async () => {
    const fixture = newFixture();
    fixture.write("conflict.txt", "base\n");
    const base = fixture.commit("base");
    fixture.git("checkout", "-q", "-b", "topic");
    fixture.write("conflict.txt", "incoming\n");
    const incoming = fixture.commit("incoming");
    fixture.git("checkout", "-q", "-b", "alternate", base);
    fixture.write("conflict.txt", "substituted\n");
    const alternate = fixture.commit("alternate");
    fixture.git("checkout", "-q", "main");
    fixture.write("conflict.txt", "current\n");
    const current = fixture.commit("current");
    const workspace = await clonedFrom(fixture);

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "topic" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    writeWorkFile(workspace, "/conflict.txt", "resolved\n");
    add(workspace.repo, workspace.worktree, { paths: ["conflict.txt"] });
    workspace.database.db.run(
      "UPDATE git_operation_state SET incoming_parent_oid = ? WHERE checkout_id = ?",
      alternate,
      workspace.repo.store.repoId,
    );

    expect(() => mergeContinue(workspace.context, workspace.repo)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(workspace.repo.head().oid).toBe(current);
    const persisted = workspace.database.db.scalar<string>(
      "SELECT incoming_parent_oid FROM git_operation_state WHERE checkout_id = ?",
      workspace.repo.store.repoId,
    );
    expect(persisted).toBe(alternate);
    expect(persisted).not.toBe(incoming);
  });

  it("rolls a compatibility conflict back atomically", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);
    const before = snapshot(workspace);

    expect(() =>
      merge(
        workspace.context,
        workspace.repo,
        workspace.worktree,
        { theirs: "topic" },
        { persistConflicts: false },
      ),
    ).toThrowError(expect.objectContaining({ code: "EMERGEFAIL" }));

    expect(snapshot(workspace)).toEqual(before);
    expect(workspace.repo.checkout.readMergeState()).toBeNull();
  });

  it("enforces public interlocks and lets hard reset clear an active merge", async () => {
    const history = conflictingDivergence();
    const workspace = await clonedFrom(history.fixture);
    const git = nativeGit(workspace);

    await expect(git.merge({ theirs: "topic" })).resolves.toEqual({
      conflicted: true,
      pendingCommit: true,
    });
    await expect(git.merge({ theirs: "topic" })).rejects.toMatchObject({ code: "EMERGEACTIVE" });
    await expect(git.checkout({ ref: "topic" })).rejects.toMatchObject({
      code: "EMERGEACTIVE",
    });
    await expect(
      git.updateRef({ ref: "refs/heads/other", value: history.incoming }),
    ).rejects.toMatchObject({ code: "EMERGEACTIVE" });
    await expect(git.reset({})).rejects.toMatchObject({ code: "EMERGEACTIVE" });
    await expect(
      git.branch({ name: "main", startPoint: "topic", force: true }),
    ).rejects.toMatchObject({ code: "EMERGEACTIVE" });

    await git.reset({ hard: true });

    expect(workspace.repo.checkout.readMergeState()).toBeNull();
    expect(workspace.repo.head().oid).toBe(history.current);
    expect(textAt(workspace, "conflict.txt")).toBe("current\n");
    expect(workspace.repo.checkout.hasConflicts()).toBe(false);
  });

  it("matches Git when multiple best bases require a synthetic virtual ancestor", async () => {
    const history = crissCrossDivergence(116);
    expect(
      new Set(history.fixture.git("merge-base", "--all", "side-a", "side-b").split("\n")),
    ).toEqual(new Set(history.bestBases));
    const workspace = await clonedFrom(history.fixture);

    expect(() => history.fixture.git("merge", "side-b")).toThrow();
    const expectedIndex = gitIndexLines(history.fixture);
    const expectedWorktree = readFileSync(join(history.fixture.dir, "conflict.txt"), "utf8");
    const expectedBase = history.fixture.git("show", ":1:conflict.txt");

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "side-b" }),
    ).toEqual({ conflicted: true, pendingCommit: true });

    expect(indexLines(workspace.repo)).toEqual(expectedIndex);
    expect(textAt(workspace, "conflict.txt")).toBe(expectedWorktree);
    const stageOne = workspace.repo.checkout.indexGet("conflict.txt", 1);
    if (stageOne === null) throw new Error("virtual merge produced no stage-one base");
    const synthetic = workspace.repo.read(stageOne.oid);
    expect(synthetic.type).toBe("blob");
    expect(utf8Decoder.decode(synthetic.data)).toBe(`${expectedBase}\n`);
    expect(utf8Decoder.decode(synthetic.data)).toBe(
      "<<<<<<<<< Temporary merge branch 1\n" +
        "b1\n" +
        "=========\n" +
        "a1\n" +
        ">>>>>>>>> Temporary merge branch 2\n",
    );
    expect(workspace.repo.store.objectInfo([stageOne.oid])).toEqual([
      expect.objectContaining({ oid: stageOne.oid, source: "loose", type: "blob" }),
    ]);
  });

  it("aborts recursive merge recovery past the former first-excess model", async () => {
    const history = crissCrossDivergence(81);
    const workspace = await clonedFrom(history.fixture);

    expect(() => history.fixture.git("merge", "side-b")).toThrow();
    history.fixture.git("merge", "--abort");
    const expectedIndex = gitIndexLines(history.fixture);
    const expectedConflict = readFileSync(join(history.fixture.dir, "conflict.txt"), "utf8");

    expect(
      merge(workspace.context, workspace.repo, workspace.worktree, { theirs: "side-b" }),
    ).toEqual({ conflicted: true, pendingCommit: true });
    const cold = reopen(workspace);

    mergeAbort(cold.repo, workspace.worktree);

    expect(cold.repo.head()).toEqual({ ref: "refs/heads/side-a", oid: history.current });
    expect(cold.repo.checkout.readMergeState()).toBeNull();
    expect(indexLines(cold.repo)).toEqual(expectedIndex);
    expect(textAt(workspace, "conflict.txt")).toBe(expectedConflict);
    expect(workspace.worktree.scan("/", { filesOnly: true, limit: 200 })).toHaveLength(82);
  });
});
