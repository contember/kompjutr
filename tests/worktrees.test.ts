import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { MODE_FILE, serializeCommit, serializeTree } from "../src/core/objects.js";
import type { ReplayStateMetadata } from "../src/core/ops/operation-state.js";
import { operationRefLogMetadata } from "../src/core/ops/ref-log.js";
import { branchDelete } from "../src/core/ops/refs.js";
import {
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "../src/core/ops/worktrees.js";
import { Repository } from "../src/core/repository.js";
import { createGit, type Git } from "../src/git/client.js";
import { Workspace } from "../src/runtime/workspace.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import {
  makeRepo,
  type TestRepository,
  type TestWorkspace,
  writeWorkFile,
} from "./helpers/workspace.js";

const PERSON = {
  name: "Worktree",
  email: "worktree@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};
const IDENTITY = { name: PERSON.name, email: PERSON.email };

interface WrittenCommit {
  oid: string;
  tree: string;
  blob: string;
}

function writeCommit(
  workspace: TestRepository,
  content: string,
  parents: readonly string[] = [],
): WrittenCommit {
  const blob = workspace.repo.store.write("blob", utf8.encode(content));
  const tree = workspace.repo.store.write(
    "tree",
    serializeTree([{ mode: MODE_FILE, name: "file.txt", oid: blob }]),
  );
  const oid = workspace.repo.store.write(
    "commit",
    serializeCommit({
      tree,
      parent: [...parents],
      author: PERSON,
      committer: PERSON,
      message: `${content.trim()}\n`,
    }),
  );
  return { oid, tree, blob };
}

function seedMain(workspace: TestRepository): WrittenCommit {
  const commit = writeCommit(workspace, "base\n");
  workspace.repo.store.setRef("refs/heads/main", commit.oid);
  return commit;
}

function bindGit(workspace: TestWorkspace, database = workspace.database): Git {
  const exactRootStates = workspace.context.exactRootStates;
  if (exactRootStates === undefined)
    throw new Error("test workspace has no exact root state source");
  return createGit()({
    database,
    worktree: workspace.worktree,
    exactRootStates,
    now: workspace.context.now,
    timezoneOffset: workspace.context.timezoneOffset,
    defaultIdentity: IDENTITY,
  });
}

function repositoryAt(workspace: TestWorkspace, root: string): Repository {
  const row = workspace.database.checkoutAt(root);
  if (row === null) throw new Error(`checkout is missing: ${root}`);
  return new Repository(workspace.database.openCheckout(row));
}

function busyState(oid: string): ReplayStateMetadata {
  return {
    kind: "cherry-pick",
    originalHeadRef: "refs/heads/main",
    originalHeadOid: oid,
    phase: "empty",
    emptyReason: "result",
    sourceOid: oid,
    selectedParentOid: null,
    mainline: null,
    currentLabel: "HEAD",
    incomingLabel: oid.slice(0, 7),
    message: "busy\n",
    author: null,
    committer: null,
  };
}

function realGitWorktreeRoots(fixture: GitFixture): string[] {
  return fixture
    .git("worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

describe("worktree add", () => {
  it("prevents deleting a branch attached to another checkout even with force", () => {
    const workspace = makeRepo("/");
    const base = seedMain(workspace);
    workspace.repo.store.setRef("refs/heads/feature", base.oid);
    worktreeAdd(workspace.context, workspace.repo, {
      root: "/feature",
      target: { kind: "existing-branch", name: "feature" },
    });

    for (const force of [false, true]) {
      expect(() =>
        branchDelete(workspace.context, workspace.repo, { name: "feature", force }),
      ).toThrowError(expect.objectContaining({ code: "EBRANCHFAIL" }));
      expect(workspace.repo.store.getRef("refs/heads/feature")).toBe(base.oid);
    }
  });

  it("creates new, detached, explicit-start, and existing-branch checkouts", async () => {
    const now = 1_700_000_000_000;
    const workspace = makeRepo("/", { startTime: now, now: () => now });
    const base = seedMain(workspace);
    const tip = writeCommit(workspace, "tip\n", [base.oid]);
    workspace.repo.store.setRef("refs/heads/main", tip.oid);
    workspace.repo.store.setRef("refs/heads/free", base.oid);
    const git = bindGit(workspace);

    const current = await git.worktreeAdd({
      root: "/current",
      target: { kind: "new-branch", name: "current" },
    });
    const explicit = await git.worktreeAdd({
      root: "/explicit",
      target: { kind: "new-branch", name: "explicit", startPoint: base.oid },
    });
    const detached = await git.worktreeAdd({
      root: "/detached",
      target: { kind: "detached", startPoint: base.oid },
    });
    const existing = await git.worktreeAdd({
      root: "/existing",
      target: { kind: "existing-branch", name: "free" },
    });

    expect(current).toMatchObject({
      root: "/current",
      head: "ref: refs/heads/current",
      isPrimary: false,
      state: "present",
    });
    expect(explicit.head).toBe("ref: refs/heads/explicit");
    expect(detached.head).toBe(base.oid);
    expect(existing.head).toBe("ref: refs/heads/free");
    expect(Object.isFrozen(current)).toBe(true);
    expect(workspace.repo.store.getRef("refs/heads/current")).toBe(tip.oid);
    expect(workspace.repo.store.getRef("refs/heads/explicit")).toBe(base.oid);
    expect(new TextDecoder().decode(workspace.worktree.readFile("/current/file.txt"))).toBe(
      "tip\n",
    );
    expect(new TextDecoder().decode(workspace.worktree.readFile("/explicit/file.txt"))).toBe(
      "base\n",
    );
    expect(repositoryAt(workspace, "/current").reflog("HEAD")[0]).toMatchObject({
      oldRaw: tip.oid,
      newRaw: "ref: refs/heads/current",
      reason: "checkout",
    });
  });

  it("enforces branch existence, short names, and attached ownership including unborn refs", () => {
    const workspace = makeRepo("/");
    const commit = writeCommit(workspace, "start\n");
    workspace.repo.store.setRef("refs/heads/start", commit.oid);

    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/missing",
        target: { kind: "existing-branch", name: "missing" },
      }),
    ).toThrowError(expect.objectContaining({ code: "ENOTFOUND" }));
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/full-name",
        target: { kind: "new-branch", name: "refs/heads/full", startPoint: commit.oid },
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVALIDREF" }));
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/oversized-branch",
        target: {
          kind: "new-branch",
          name: "x".repeat(1_014),
          startPoint: commit.oid,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/owned-unborn",
        target: { kind: "new-branch", name: "main", startPoint: commit.oid },
      }),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHINUSE" }));
    expect(workspace.repo.store.getRef("refs/heads/main")).toBeNull();
    expect(workspace.database.checkoutAt("/owned-unborn")).toBeNull();
    expect(workspace.worktree.stat("/owned-unborn")).toBeNull();

    workspace.repo.store.setRef("refs/heads/main", commit.oid);
    workspace.repo.store.setRef("refs/heads/not-commit", commit.blob);
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/already-exists",
        target: { kind: "new-branch", name: "main", startPoint: commit.oid },
      }),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHFAIL" }));
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/owned",
        target: { kind: "existing-branch", name: "main" },
      }),
    ).toThrowError(expect.objectContaining({ code: "EBRANCHINUSE" }));
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/not-commit",
        target: { kind: "existing-branch", name: "not-commit" },
      }),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(workspace.worktree.stat("/owned")).toBeNull();
    expect(workspace.worktree.stat("/not-commit")).toBeNull();
  });

  it("accepts missing and empty roots but rejects registered, nonempty, and aliased roots", () => {
    const workspace = makeRepo("/");
    const commit = seedMain(workspace);

    workspace.worktree.makeDirectories(["/empty", "/nonempty", "/real"]);
    writeWorkFile(workspace, "/nonempty/file", "occupied\n");
    workspace.worktree.symlink("/real", "/alias");
    expect(
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/empty",
        target: { kind: "detached", startPoint: commit.oid },
      }).state,
    ).toBe("present");
    expect(
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/missing",
        target: { kind: "detached", startPoint: commit.oid },
      }).state,
    ).toBe("present");

    for (const root of ["/empty", "/nonempty", "/alias", "/alias/child"]) {
      expect(() =>
        worktreeAdd(workspace.context, workspace.repo, {
          root,
          target: { kind: "detached", startPoint: commit.oid },
        }),
      ).toThrowError(expect.objectContaining({ code: "EWORKTREEEXISTS" }));
    }
    expect(workspace.database.checkoutAt("/nonempty")).toBeNull();
    expect(workspace.database.checkoutAt("/alias")).toBeNull();
    expect(workspace.database.checkoutAt("/alias/child")).toBeNull();
  });

  it("rolls back the root, branch, checkout, index, and reflog when tracker reseal fails", () => {
    const failures: readonly ("throw" | "false")[] = ["throw", "false"];
    for (const failure of failures) {
      const workspace = makeRepo("/");
      seedMain(workspace);
      workspace.context.indexTracker = {
        reseal() {
          if (failure === "throw") throw new Error("injected reseal failure");
          return false;
        },
      };
      const root = `/rollback-${failure}`;
      const branch = `rollback-${failure}`;

      expect(() =>
        worktreeAdd(workspace.context, workspace.repo, {
          root,
          target: { kind: "new-branch", name: branch },
        }),
      ).toThrowError(
        failure === "throw"
          ? "injected reseal failure"
          : expect.objectContaining({ code: "ECORRUPT" }),
      );
      expect(workspace.worktree.stat(root)).toBeNull();
      expect(workspace.database.checkoutAt(root)).toBeNull();
      expect(workspace.repo.store.getRef(`refs/heads/${branch}`)).toBeNull();
      expect(workspace.database.db.scalar<number>("SELECT count(*) FROM git_checkouts")).toBe(1);
      expect(workspace.database.db.scalar<number>("SELECT count(*) FROM git_index")).toBe(0);
      expect(workspace.repo.reflog(`refs/heads/${branch}`)).toEqual([]);
    }
  });

  it("bounds roots before normalization", () => {
    const workspace = makeRepo("/");
    const commit = seedMain(workspace);
    const oversized = `/${"x".repeat(4_096)}`;

    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: oversized,
        target: { kind: "detached", startPoint: commit.oid },
      }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() =>
      worktreeRemove(workspace.context, workspace.repo, { root: oversized, force: true }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
});

describe("worktree list and checkout sharing", () => {
  it("wires exact-root lifecycle support through the public runtime", async () => {
    const runtime = new Workspace({
      storage: new SqliteTestStorage(),
      git: createGit(),
      defaultGitIdentity: IDENTITY,
    });
    await runtime.git.init({ dir: "/runtime" });
    runtime.filesystem.writeFiles([{ path: "/runtime/file.txt", bytes: utf8.encode("runtime\n") }]);
    await runtime.git.add({ dir: "/runtime", paths: ["file.txt"] });
    await runtime.git.commit({ dir: "/runtime", message: "runtime" });

    const created = await runtime.git.worktreeAdd({
      dir: "/runtime",
      root: "/runtime-linked",
      target: { kind: "new-branch", name: "runtime-linked" },
    });
    expect(created.root).toBe("/runtime-linked");
    await expect(runtime.git.worktreeList({ dir: "/runtime-linked" })).resolves.toEqual([
      expect.objectContaining({ root: "/runtime", isPrimary: true, state: "present" }),
      expect.objectContaining({ root: "/runtime-linked", isPrimary: false, state: "present" }),
    ]);
  });

  it("freezes byte-ordered results, routes from any checkout, and survives a cold reopen", async () => {
    const workspace = makeRepo("/");
    seedMain(workspace);
    const git = bindGit(workspace);
    await git.worktreeAdd({ root: "/z", target: { kind: "new-branch", name: "z" } });
    await git.worktreeAdd({ root: "/a", target: { kind: "new-branch", name: "a" } });

    const listed = await git.worktreeList({ dir: "/z" });
    expect(listed.map((item) => item.root)).toEqual(["/", "/a", "/z"]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.every(Object.isFrozen)).toBe(true);
    const cold = bindGit(workspace, new SqliteGitDatabase(workspace.database.db));
    await expect(cold.worktreeList({ dir: "/a" })).resolves.toEqual(listed);
  });

  it("shares objects and refs while keeping worktree and index state isolated", async () => {
    const workspace = makeRepo("/");
    const base = seedMain(workspace);
    const git = bindGit(workspace);
    await git.worktreeAdd({ root: "/one", target: { kind: "new-branch", name: "one" } });
    await git.worktreeAdd({ root: "/two", target: { kind: "new-branch", name: "two" } });

    writeWorkFile(workspace, "/one/file.txt", "one\n");
    await git.add({ dir: "/one", paths: ["file.txt"] });
    const changed = await git.commit({ dir: "/one", message: "one" });
    const one = repositoryAt(workspace, "/one");
    const two = repositoryAt(workspace, "/two");

    expect(two.store).toBe(one.store);
    expect(two.has(changed.oid)).toBe(true);
    expect(two.store.getRef("refs/heads/one")).toBe(changed.oid);
    expect(two.checkout.indexGet("file.txt")?.oid).toBe(base.blob);
    expect(new TextDecoder().decode(workspace.worktree.readFile("/two/file.txt"))).toBe("base\n");
    await expect(git.status({ dir: "/two" })).resolves.toEqual([]);
  });

  it("fails list and prune without an exact-root state source", () => {
    const workspace = makeRepo("/");
    expect(() =>
      worktreeList({ ...workspace.context, exactRootStates: undefined }, workspace.repo),
    ).toThrowError(expect.objectContaining({ code: "EUNSUPPORTED" }));
    expect(() =>
      worktreePrune({ ...workspace.context, exactRootStates: undefined }, workspace.repo),
    ).toThrowError(expect.objectContaining({ code: "EUNSUPPORTED" }));
  });
});

describe("worktree remove", () => {
  it("removes a clean detached checkout and its private history but retains shared objects", () => {
    const workspace = makeRepo("/");
    const base = seedMain(workspace);
    const unique = writeCommit(workspace, "unique\n", [base.oid]);
    const later = writeCommit(workspace, "unique\n", [unique.oid]);
    const created = worktreeAdd(workspace.context, workspace.repo, {
      root: "/detached-unique",
      target: { kind: "detached", startPoint: unique.oid },
    });
    const detached = repositoryAt(workspace, created.root);
    detached.mutateRefs(
      { head: later.oid },
      operationRefLogMetadata(workspace.context, detached, "checkout"),
    );
    expect(
      workspace.database.db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE checkout_id = ?",
        created.checkoutId,
      ),
    ).toBe(1);

    worktreeRemove(workspace.context, workspace.repo, { root: created.root });

    expect(workspace.database.checkoutAt(created.root)).toBeNull();
    expect(
      workspace.database.db.scalar<number>(
        "SELECT count(*) FROM git_checkout_reflog_entries WHERE checkout_id = ?",
        created.checkoutId,
      ),
    ).toBe(0);
    expect(workspace.repo.has(unique.oid)).toBe(true);
    expect(workspace.repo.has(later.oid)).toBe(true);
  });

  it("removes a clean checkout and rejects modified, staged, and untracked roots without force", async () => {
    const mutations: readonly ("clean" | "modified" | "staged" | "untracked")[] = [
      "clean",
      "modified",
      "staged",
      "untracked",
    ];
    for (const mutation of mutations) {
      const workspace = makeRepo("/");
      seedMain(workspace);
      const git = bindGit(workspace);
      await git.worktreeAdd({ root: "/target", target: { kind: "new-branch", name: "target" } });
      if (mutation === "modified" || mutation === "staged") {
        writeWorkFile(workspace, "/target/file.txt", `${mutation}\n`);
      }
      if (mutation === "staged") await git.add({ dir: "/target", paths: ["file.txt"] });
      if (mutation === "untracked") writeWorkFile(workspace, "/target/untracked.txt", "new\n");

      if (mutation === "clean") {
        await expect(git.worktreeRemove({ root: "/target" })).resolves.toBeUndefined();
        expect(workspace.database.checkoutAt("/target")).toBeNull();
        expect(workspace.worktree.stat("/target")).toBeNull();
      } else {
        await expect(git.worktreeRemove({ root: "/target" })).rejects.toMatchObject({
          code: "EWORKTREEDIRTY",
        });
        expect(workspace.database.checkoutAt("/target")).not.toBeNull();
        expect(workspace.worktree.stat("/target")).not.toBeNull();
        await expect(git.worktreeRemove({ root: "/target", force: true })).resolves.toBeUndefined();
        expect(workspace.database.checkoutAt("/target")).toBeNull();
      }
    }
  });

  it("rejects unknown and primary roots and never lets force bypass a live operation", async () => {
    const workspace = makeRepo("/");
    const commit = seedMain(workspace);
    const git = bindGit(workspace);
    await git.worktreeAdd({ root: "/busy", target: { kind: "new-branch", name: "busy" } });
    const busy = repositoryAt(workspace, "/busy");
    busy.checkout.writeOperationState(busyState(commit.oid), []);

    for (const force of [false, true]) {
      await expect(git.worktreeRemove({ root: "/busy", force })).rejects.toMatchObject({
        code: "EWORKTREEBUSY",
      });
    }
    await expect(git.worktreeRemove({ root: "/unknown", force: true })).rejects.toMatchObject({
      code: "EWORKTREENOTFOUND",
    });
    await expect(git.worktreeRemove({ root: "/", force: true })).rejects.toMatchObject({
      code: "EPRIMARYWORKTREE",
    });
    expect(workspace.database.checkoutAt("/busy")).not.toBeNull();
    expect(workspace.worktree.stat("/busy")).not.toBeNull();
  });
});

describe("worktree prune", () => {
  it("atomically rejects a busy missing checkout, skips primary, and is idempotent", async () => {
    const workspace = makeRepo("/");
    const commit = seedMain(workspace);
    const git = bindGit(workspace);
    await git.worktreeAdd({ root: "/missing-a", target: { kind: "new-branch", name: "a" } });
    await git.worktreeAdd({ root: "/missing-b", target: { kind: "new-branch", name: "b" } });
    workspace.worktree.removeFiles(["/missing-a", "/missing-b"], { recursive: true });
    const busy = repositoryAt(workspace, "/missing-b");
    busy.checkout.writeOperationState(busyState(commit.oid), []);

    await expect(git.worktreePrune()).rejects.toMatchObject({ code: "EWORKTREEBUSY" });
    expect(workspace.database.checkoutAt("/missing-a")).not.toBeNull();
    expect(workspace.database.checkoutAt("/missing-b")).not.toBeNull();
    busy.checkout.clearOperationState();

    const removed = await git.worktreePrune();
    expect(removed.map((item) => item.root)).toEqual(["/missing-a", "/missing-b"]);
    expect(removed.every((item) => item.state === "missing" && !item.isPrimary)).toBe(true);
    expect(Object.isFrozen(removed)).toBe(true);
    expect(removed.every(Object.isFrozen)).toBe(true);
    await expect(git.worktreePrune()).resolves.toEqual([]);
    expect(workspace.database.checkoutAt("/")).not.toBeNull();
  });

  it("treats a nested checkout as parent dirt and prunes it after forced parent removal", async () => {
    const workspace = makeRepo("/");
    seedMain(workspace);
    const git = bindGit(workspace);
    await git.worktreeAdd({ root: "/parent", target: { kind: "new-branch", name: "parent" } });
    await git.worktreeAdd({
      root: "/parent/nested",
      target: { kind: "new-branch", name: "nested" },
    });

    await expect(git.worktreeRemove({ root: "/parent" })).rejects.toMatchObject({
      code: "EWORKTREEDIRTY",
    });
    await git.worktreeRemove({ root: "/parent", force: true });
    expect(workspace.database.checkoutAt("/parent")).toBeNull();
    expect(workspace.database.checkoutAt("/parent/nested")).not.toBeNull();
    expect(workspace.worktree.stat("/parent/nested")).toBeNull();
    await expect(git.worktreePrune()).resolves.toEqual([
      expect.objectContaining({ root: "/parent/nested", state: "missing" }),
    ]);
  });

  it("lists and prunes the 1,024-checkout ceiling within the statement target", () => {
    const workspace = makeRepo("/");
    const commit = seedMain(workspace);
    workspace.database.db.run(
      `WITH RECURSIVE sequence(id) AS (
         VALUES (2) UNION ALL SELECT id + 1 FROM sequence WHERE id < 1024
       )
       INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
       SELECT id, ?, '/missing-' || printf('%04d', id), ?, 0 FROM sequence`,
      workspace.repo.store.repoId,
      "1".repeat(40),
    );
    workspace.database.db.run(
      "UPDATE git_identity_control SET last_checkout_id = 1024 WHERE singleton = 1",
    );
    workspace.storage.resetCounters();
    const listed = worktreeList(workspace.context, workspace.repo);
    expect(listed).toHaveLength(1_024);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(() =>
      worktreeAdd(workspace.context, workspace.repo, {
        root: "/first-over-limit",
        target: { kind: "detached", startPoint: commit.oid },
      }),
    ).toThrowError(expect.objectContaining({ code: "EWORKTREELIMIT" }));
    expect(workspace.worktree.stat("/first-over-limit")).toBeNull();

    workspace.storage.resetCounters();
    const pruned = worktreePrune(workspace.context, workspace.repo);
    expect(pruned).toHaveLength(1_023);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(workspace.database.listCheckouts(workspace.repo.store.repoId)).toHaveLength(1);
  });
});

describe("real Git worktree controls", () => {
  it("pins default, explicit, detached, owned-branch, and root-state add controls", () => {
    const fixture = new GitFixture().init();
    const base = fixture.write("file.txt", "base\n").commit("base");
    fixture.git("branch", "free-missing", base);
    fixture.git("branch", "free-empty", base);
    fixture.git("branch", "free-nonempty", base);
    const tip = fixture.write("file.txt", "tip\n").commit("tip");
    const roots = {
      defaultHead: `${fixture.dir}-default-head`,
      explicit: `${fixture.dir}-explicit`,
      detached: `${fixture.dir}-detached`,
      existingMissing: `${fixture.dir}-existing-missing`,
      existingEmpty: `${fixture.dir}-existing-empty`,
      existingNonempty: `${fixture.dir}-existing-nonempty`,
      owned: `${fixture.dir}-owned`,
    };
    const cleanup = Object.values(roots);
    try {
      fixture.git("worktree", "add", "-b", "default-head", roots.defaultHead);
      fixture.git("worktree", "add", "-b", "explicit", roots.explicit, base);
      fixture.git("worktree", "add", "--detach", roots.detached, base);
      fixture.git("worktree", "add", roots.existingMissing, "free-missing");
      mkdirSync(roots.existingEmpty);
      fixture.git("worktree", "add", roots.existingEmpty, "free-empty");
      mkdirSync(roots.existingNonempty);
      writeFileSync(join(roots.existingNonempty, "occupied.txt"), "occupied\n");

      expect(fixture.git("-C", roots.defaultHead, "rev-parse", "HEAD")).toBe(tip);
      expect(fixture.git("-C", roots.defaultHead, "symbolic-ref", "--short", "HEAD")).toBe(
        "default-head",
      );
      expect(fixture.git("-C", roots.explicit, "rev-parse", "HEAD")).toBe(base);
      expect(fixture.git("-C", roots.explicit, "symbolic-ref", "--short", "HEAD")).toBe("explicit");
      expect(fixture.git("-C", roots.detached, "rev-parse", "HEAD")).toBe(base);
      expect(fixture.git("-C", roots.detached, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(fixture.git("-C", roots.existingMissing, "symbolic-ref", "--short", "HEAD")).toBe(
        "free-missing",
      );
      expect(fixture.git("-C", roots.existingEmpty, "symbolic-ref", "--short", "HEAD")).toBe(
        "free-empty",
      );
      expect(() =>
        fixture.git("worktree", "add", roots.existingNonempty, "free-nonempty"),
      ).toThrow();
      expect(existsSync(join(roots.existingNonempty, "occupied.txt"))).toBe(true);
      expect(() => fixture.git("worktree", "add", roots.owned, "main")).toThrow();
      expect(existsSync(roots.owned)).toBe(false);
      expect(() => fixture.git("worktree", "add", "--detach", roots.defaultHead, base)).toThrow();

      expect(realGitWorktreeRoots(fixture)).toEqual(
        expect.arrayContaining([
          fixture.dir,
          roots.defaultHead,
          roots.explicit,
          roots.detached,
          roots.existingMissing,
          roots.existingEmpty,
        ]),
      );
      expect(realGitWorktreeRoots(fixture)).not.toContain(roots.existingNonempty);
    } finally {
      for (const root of cleanup) rmSync(root, { recursive: true, force: true });
      fixture.dispose();
    }
  });

  it("pins clean, dirty, forced, live-operation, repeated, and prune controls", () => {
    const fixture = new GitFixture().init();
    const base = fixture.write("file.txt", "base\n").commit("base");
    fixture.git("branch", "operation", base);
    const tip = fixture.write("file.txt", "main\n").commit("main");
    fixture.git("branch", "clean", tip);
    fixture.git("branch", "dirty", tip);
    const roots = {
      clean: `${fixture.dir}-clean`,
      dirty: `${fixture.dir}-dirty`,
      operation: `${fixture.dir}-operation`,
      missing: `${fixture.dir}-missing`,
    };
    const cleanup = Object.values(roots);
    try {
      fixture.git("worktree", "add", roots.clean, "clean");
      expect(realGitWorktreeRoots(fixture)).toContain(roots.clean);
      fixture.git("worktree", "remove", roots.clean);
      expect(existsSync(roots.clean)).toBe(false);
      expect(realGitWorktreeRoots(fixture)).not.toContain(roots.clean);
      expect(() => fixture.git("worktree", "remove", roots.clean)).toThrow();

      fixture.git("worktree", "add", roots.dirty, "dirty");
      writeFileSync(join(roots.dirty, "file.txt"), "dirty\n");
      expect(() => fixture.git("worktree", "remove", roots.dirty)).toThrow();
      expect(existsSync(roots.dirty)).toBe(true);
      expect(realGitWorktreeRoots(fixture)).toContain(roots.dirty);
      fixture.git("worktree", "remove", "--force", roots.dirty);
      expect(existsSync(roots.dirty)).toBe(false);
      expect(realGitWorktreeRoots(fixture)).not.toContain(roots.dirty);

      fixture.git("worktree", "add", roots.operation, "operation");
      writeFileSync(join(roots.operation, "file.txt"), "operation\n");
      fixture.git("-C", roots.operation, "add", "file.txt");
      fixture.git("-C", roots.operation, "commit", "-m", "operation");
      expect(() => fixture.git("-C", roots.operation, "cherry-pick", tip)).toThrow();
      expect(() => fixture.git("worktree", "remove", roots.operation)).toThrow();
      expect(existsSync(roots.operation)).toBe(true);
      fixture.git("worktree", "remove", "--force", roots.operation);
      expect(existsSync(roots.operation)).toBe(false);
      expect(realGitWorktreeRoots(fixture)).not.toContain(roots.operation);

      fixture.git("worktree", "add", "--detach", roots.missing, tip);
      rmSync(roots.missing, { recursive: true, force: true });
      expect(realGitWorktreeRoots(fixture)).toContain(roots.missing);
      fixture.git("worktree", "prune");
      expect(realGitWorktreeRoots(fixture)).not.toContain(roots.missing);
      expect(fixture.git("worktree", "prune")).toBe("");
      expect(realGitWorktreeRoots(fixture)).toEqual([fixture.dir]);
    } finally {
      for (const root of cleanup) rmSync(root, { recursive: true, force: true });
      fixture.dispose();
    }
  });
});
