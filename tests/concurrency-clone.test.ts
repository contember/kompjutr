import { describe, expect, it } from "vitest";
import { createFilesystem } from "../src/fs/filesystem.js";
import { createGit } from "../src/git/client.js";
import { concat, utf8 } from "../src/git/common/bytes.js";
import { hashObject, serializeTree } from "../src/git/common/objects.js";
import { checkoutTree } from "../src/git/ops/checkout.js";
import type { GitContext } from "../src/git/ops/context.js";
import { nestedRoots, openRepository } from "../src/git/ops/context.js";
import { initRepository } from "../src/git/ops/init.js";
import { clone } from "../src/git/ops/network.js";
import { Repository } from "../src/git/ops/repository.js";
import type { Worktree } from "../src/git/ops/worktree.js";
import {
  type CheckoutStore,
  PROVISIONAL_CLONE_LEASE_MS,
  SqliteGitDatabase,
} from "../src/git/store/index.js";
import { initializeIndexTracker } from "../src/git/store/index-tracker.js";
import { PackWriter } from "../src/git/store/pack/writer.js";
import { Workspace } from "../src/runtime/workspace.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { awaitBarrierEntry, oneShotBarrier } from "./helpers/interleaving.js";
import { SqliteTestStorage } from "./helpers/storage.js";
import { makeWorkspace, type TestWorkspace, writeWorkFile } from "./helpers/workspace.js";

function noCleanup(): undefined {
  return undefined;
}

interface WorktreeFixture {
  readonly worktree: TestWorkspace["worktree"];
}

function trackedCleanup(workspace: WorktreeFixture): (store: CheckoutStore) => undefined {
  return (store) => {
    checkoutTree(new Repository(store), workspace.worktree, null);
    return undefined;
  };
}

interface ColdWorkspace extends WorktreeFixture {
  readonly database: SqliteGitDatabase;
  readonly context: GitContext;
}

function reopenWorkspace(workspace: TestWorkspace): ColdWorkspace {
  const db = new TestDatabase(workspace.storage);
  const now = workspace.context.now;
  const worktree = createFilesystem(db, { now });
  const database = new SqliteGitDatabase(db, { now });
  initializeIndexTracker(db);
  return {
    database,
    worktree,
    context: {
      database,
      worktree,
      now,
      timezoneOffset: workspace.context.timezoneOffset,
    },
  };
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function oneBlobPack(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(1);
  writer.object("blob", bytes);
  writer.finish();
  return concat(chunks);
}

function materializeFile(
  store: CheckoutStore,
  workspace: WorktreeFixture,
  name: string,
  text: string,
) {
  const bytes = utf8.encode(text);
  const blobOid = store.write("blob", bytes);
  const treeOid = store.write("tree", serializeTree([{ mode: "100644", name, oid: blobOid }]));
  checkoutTree(new Repository(store), workspace.worktree, treeOid);
  return { blobOid, treeOid };
}

function injectProvisionalSecondary(
  workspace: TestWorkspace,
  store: CheckoutStore,
  repoId: number,
  root: string,
): number {
  const lastCheckoutId = workspace.database.db.scalar<number>(
    "SELECT last_checkout_id FROM git_identity_control WHERE singleton = 1",
  );
  if (lastCheckoutId === undefined) throw new Error("identity control is missing");
  const checkoutId = lastCheckoutId + 1;
  const bytes = utf8.encode("orphan checkout\n");
  const oid = store.write("blob", bytes);
  workspace.database.db.run(
    "UPDATE git_identity_control SET last_checkout_id = ? WHERE singleton = 1",
    checkoutId,
  );
  workspace.database.db.run(
    `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
     VALUES (?, ?, ?, 'ref: refs/heads/injected', 0)`,
    checkoutId,
    repoId,
    root,
  );
  workspace.database.db.run(
    `INSERT INTO git_index (checkout_id, path, stage, mode, oid, size)
     VALUES (?, 'orphan.txt', 0, 33188, ?, ?)`,
    checkoutId,
    oid,
    bytes.length,
  );
  writeWorkFile(workspace, `${root}/orphan.txt`, "orphan checkout\n");
  return checkoutId;
}

describe("provisional clone publication", () => {
  it("fences the real clone flow at every durable publication checkpoint", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "checkpoint clone\n");
    fixture.commit("checkpoint clone");
    const server = await startGitServer(fixture.dir);
    const storage = new SqliteTestStorage();
    const reservation = oneShotBarrier("clone provisional reservation");
    const completePack = oneShotBarrier("clone complete pack publication");
    const refs = oneShotBarrier("clone ref publication");
    const worktree = oneShotBarrier("before clone worktree publication");
    let clock = 90_000;
    let inspectCheckpoint: (() => Promise<void>) | undefined;
    const runtime = new Workspace({
      storage,
      git: createGit(),
      now: () => clock,
      yieldNow: async () => {
        if (inspectCheckpoint === undefined) {
          throw new Error("clone checkpoint inspector is not installed");
        }
        await inspectCheckpoint();
      },
    });
    let stage = 0;
    let repoId: number | null = null;
    inspectCheckpoint = async () => {
      if (repoId === null) {
        repoId =
          runtime.db.scalar<number>(
            `SELECT checkout.repo_id FROM git_checkouts checkout WHERE checkout.root = '/repo'`,
          ) ?? null;
      }
      if (repoId === null) return;
      if (stage === 0) {
        stage = 1;
        await reservation.wait();
        return;
      }
      const complete = runtime.db.scalar<number>(
        `SELECT COUNT(*) FROM git_pack_meta
          WHERE repo_id = ? AND state = 'complete'`,
        repoId,
      );
      if (stage === 1 && complete !== undefined && complete > 0) {
        stage = 2;
        await completePack.wait();
        return;
      }
      const localRef = runtime.db.scalar<number>(
        `SELECT COUNT(*) FROM git_refs WHERE repo_id = ? AND name = 'refs/heads/main'`,
        repoId,
      );
      if (stage === 2 && localRef === 1) {
        stage = 3;
        await refs.wait();
        return;
      }
      if (stage === 3) {
        stage = 4;
        await worktree.wait();
      }
    };

    const cloning = runtime.git.clone({ url: server.url, dir: "/repo" });
    try {
      await awaitBarrierEntry(reservation, cloning);
      expect(
        runtime.db.one(
          `SELECT lifecycle, clone_generation, clone_expires_ms
             FROM git_repositories WHERE id = ?`,
          repoId,
        ),
      ).toEqual({
        lifecycle: "provisional",
        clone_generation: 1,
        clone_expires_ms: clock + PROVISIONAL_CLONE_LEASE_MS,
      });
      await expect(runtime.git.status({ dir: "/repo" })).rejects.toMatchObject({
        code: "ENOTAREPO",
      });
      await expect(runtime.git.clone({ url: server.url, dir: "/repo" })).rejects.toMatchObject({
        code: "EBUSY",
      });
      await runtime.git.clone({ url: server.url, dir: "/other" });
      await expect(runtime.git.status({ dir: "/other" })).resolves.toEqual([]);
      reservation.release();

      await awaitBarrierEntry(completePack, cloning);
      expect(
        runtime.db.scalar<number>(
          `SELECT COUNT(*) FROM git_pack_meta
            WHERE repo_id = ? AND state = 'complete'`,
          repoId,
        ),
      ).toBeGreaterThan(0);
      expect(
        runtime.db.scalar<number>("SELECT COUNT(*) FROM git_refs WHERE repo_id = ?", repoId),
      ).toBe(0);
      await expect(runtime.git.status({ dir: "/repo" })).rejects.toMatchObject({
        code: "ENOTAREPO",
      });
      completePack.release();

      await awaitBarrierEntry(refs, cloning);
      expect(
        runtime.db.scalar<number>(
          `SELECT COUNT(*) FROM git_refs
            WHERE repo_id = ? AND name = 'refs/heads/main'`,
          repoId,
        ),
      ).toBe(1);
      expect(runtime.filesystem.stat("/repo/README.md")).toBeNull();
      await expect(runtime.git.status({ dir: "/repo" })).rejects.toMatchObject({
        code: "ENOTAREPO",
      });
      refs.release();

      await awaitBarrierEntry(worktree, cloning);
      expect(runtime.filesystem.stat("/repo/README.md")).toBeNull();
      expect(
        runtime.db.scalar<number>("SELECT COUNT(*) FROM git_index WHERE checkout_id = 1"),
      ).toBe(0);
      await expect(runtime.git.status({ dir: "/repo" })).rejects.toMatchObject({
        code: "ENOTAREPO",
      });
      runtime.filesystem.writeFiles([
        { path: "/repo/untracked.txt", bytes: utf8.encode("caller content\n") },
      ]);
      fixture.remove("README.md");
      fixture.write("current.txt", "changed remote\n");
      fixture.commit("changed while first clone was paused");
      clock += PROVISIONAL_CLONE_LEASE_MS;
      const cold = new Workspace({ storage, git: createGit(), now: () => clock });
      await cold.git.clone({ url: server.url, dir: "/repo" });
      expect(cold.filesystem.stat("/repo/README.md")).toBeNull();
      expect(cold.filesystem.readFile("/repo/current.txt")).toEqual(
        utf8.encode("changed remote\n"),
      );
      expect(cold.filesystem.readFile("/repo/untracked.txt")).toEqual(
        utf8.encode("caller content\n"),
      );
      const replacement = cold.db.one<{
        repo_id: number;
        lifecycle: string;
        clone_generation: number | null;
        clone_expires_ms: number | null;
      }>(
        `SELECT repository.id AS repo_id, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms
           FROM git_repositories repository
           JOIN git_checkouts checkout ON checkout.repo_id = repository.id
          WHERE checkout.root = '/repo'`,
      );
      expect(replacement).toEqual({
        repo_id: expect.any(Number),
        lifecycle: "ready",
        clone_generation: null,
        clone_expires_ms: null,
      });
      expect(replacement?.repo_id).toBeGreaterThan(repoId ?? 0);
      worktree.release();
      await expect(cloning).rejects.toMatchObject({ code: "ESTALE" });
      const expectedStatus = [{ path: "untracked.txt", index: " ", worktree: "?" }];
      await expect(cold.git.status({ dir: "/repo" })).resolves.toEqual(expectedStatus);
      const reopened = new Workspace({ storage, git: createGit(), now: () => clock });
      await expect(reopened.git.status({ dir: "/repo" })).resolves.toEqual(expectedStatus);
    } finally {
      reservation.release();
      completePack.release();
      refs.release();
      worktree.release();
      await server.close();
      fixture.dispose();
    }
  });

  it("keeps reservation, complete pack, refs, and worktree private until the ready CAS", async () => {
    const workspace = makeWorkspace({ startTime: 10_000 });
    const owner = workspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );

    expect(workspace.database.checkoutAt("/repo")).toBeNull();
    expect(workspace.database.findCheckout("/repo/file.txt")).toBeNull();
    expect(workspace.database.listRoutingCheckouts()).toEqual([]);
    expect(workspace.database.listRoutingRoots()).toEqual(["/repo"]);
    expect(() => workspace.database.openShared(owner.checkout.repoId)).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
    expect(() => workspace.database.openCheckout(owner.checkout)).toThrowError(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );

    workspace.storage.resetCounters();
    const packed = utf8.encode("packed checkpoint\n");
    const ingest = await owner.store.packs.ingest(oneChunk(oneBlobPack(packed)));
    expect(
      owner.store.db.scalar<string>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        owner.checkout.repoId,
        ingest.packId,
      ),
    ).toBe("complete");
    expect(workspace.database.checkoutAt("/repo")).toBeNull();

    const materialized = utf8.encode("materialized\n");
    const blobOid = owner.store.write("blob", materialized);
    const treeOid = owner.store.write(
      "tree",
      serializeTree([{ mode: "100644", name: "file.txt", oid: blobOid }]),
    );
    owner.store.setRef("refs/heads/main", treeOid);
    expect(workspace.database.checkoutAt("/repo")).toBeNull();
    expect(workspace.worktree.stat("/repo/file.txt")).toBeNull();
    const published = workspace.database.publishProvisionalClone(
      owner,
      workspace.context.now(),
      (store) => {
        checkoutTree(new Repository(store), workspace.worktree, treeOid);
        return undefined;
      },
    );
    expect(workspace.database.checkoutAt("/repo")).toEqual(published);
    expect(workspace.database.findCheckout("/repo/file.txt")?.repoId).toBe(published.repoId);
    expect(workspace.worktree.readFile("/repo/file.txt")).toEqual(materialized);
    expect(workspace.storage.statementCount).toBeLessThan(1_000);
    expect(() => owner.store.configSet("after.publish", "forbidden")).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() =>
      workspace.database.discardProvisionalClone(
        owner,
        workspace.context.now(),
        trackedCleanup(workspace),
      ),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(() =>
      workspace.database.publishProvisionalClone(owner, workspace.context.now()),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(workspace.worktree.readFile("/repo/file.txt")).toEqual(materialized);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_index WHERE checkout_id = ? AND path = 'file.txt'",
        published.id,
      ),
    ).toBe(1);

    const cold = reopenWorkspace(workspace);
    expect(cold.database.checkoutAt("/repo")?.repoId).toBe(published.repoId);
  });

  it("revalidates a rolled-back prepare cache before a second publication attempt", () => {
    const workspace = makeWorkspace({ startTime: 15_000 });
    const owner = workspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );
    const bytes = utf8.encode("rolled-back prepare object\n");
    const oid = hashObject("blob", bytes);
    const retry = new Error("retry with fallback preparation");

    expect(() =>
      workspace.database.publishProvisionalClone(owner, workspace.context.now(), (store) => {
        expect(store.write("blob", bytes)).toBe(oid);
        expect(store.read(oid)?.data).toEqual(bytes);
        throw retry;
      }),
    ).toThrow(retry);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
        owner.checkout.repoId,
        oid,
      ),
    ).toBe(0);
    expect(owner.store.has(oid)).toBe(false);
    expect(owner.store.read(oid)).toBeNull();

    const published = workspace.database.publishProvisionalClone(owner, workspace.context.now());
    expect(workspace.database.checkoutAt("/repo")?.repoId).toBe(published.repoId);
  });

  it("uses a provisional nested root as a routing barrier and fences same-root overlap", () => {
    const workspace = makeWorkspace({ startTime: 20_000 });
    const parent = initRepository(workspace.context, { dir: "/parent" });
    const nested = workspace.database.beginProvisionalClone(
      "/parent/nested",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );

    expect(workspace.database.findCheckout("/parent/file.txt")?.repoId).toBe(parent.store.repoId);
    expect(workspace.database.findCheckout("/parent/nested/file.txt")).toBeNull();
    expect(() => openRepository(workspace.context, "/parent/nested/file.txt")).toThrowError(
      expect.objectContaining({ code: "ENOTAREPO" }),
    );
    expect(nestedRoots(workspace.context, "/parent")).toEqual(["/parent/nested"]);
    expect(() =>
      workspace.database.beginProvisionalClone(
        "/parent/nested",
        "ref: refs/heads/main",
        workspace.context.now(),
        noCleanup,
      ),
    ).toThrowError(expect.objectContaining({ code: "EBUSY" }));

    const other = workspace.database.beginProvisionalClone(
      "/other",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );
    expect(workspace.database.listRoutingRoots()).toEqual(["/other", "/parent", "/parent/nested"]);
    workspace.database.discardProvisionalClone(nested, workspace.context.now(), noCleanup);
    workspace.database.discardProvisionalClone(other, workspace.context.now(), noCleanup);
  });

  it("takes over at exact expiry, removes obsolete tracked files, and preserves untracked files", () => {
    const workspace = makeWorkspace({ startTime: 30_000 });
    const cleanup = trackedCleanup(workspace);
    const old = workspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      workspace.context.now(),
      cleanup,
    );
    const oldObject = materializeFile(old.store, workspace, "obsolete.txt", "old remote\n");
    writeWorkFile(workspace, "/repo/untracked.txt", "caller content\n");

    workspace.tick(PROVISIONAL_CLONE_LEASE_MS);
    const cold = reopenWorkspace(workspace);
    const coldCleanup = trackedCleanup(cold);
    const replacement = cold.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      cold.context.now(),
      coldCleanup,
    );

    expect(replacement.checkout.repoId).toBeGreaterThan(old.checkout.repoId);
    expect(replacement.checkout.id).toBeGreaterThan(old.checkout.id);
    expect(replacement.generation).toBeGreaterThan(old.generation);
    expect(workspace.worktree.stat("/repo/obsolete.txt")).toBeNull();
    expect(workspace.worktree.readFile("/repo/untracked.txt")).toEqual(
      utf8.encode("caller content\n"),
    );
    expect(old.store.read(oldObject.blobOid)?.data).toEqual(utf8.encode("old remote\n"));
    expect(old.store.has(oldObject.blobOid)).toBe(false);
    expect(() =>
      workspace.database.renewProvisionalClone(old, workspace.context.now()),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(() => old.store.read(oldObject.blobOid)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => old.store.has(oldObject.blobOid)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => old.store.configSet("stale.owner", "forbidden")).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() =>
      workspace.database.discardProvisionalClone(old, workspace.context.now(), cleanup),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));

    materializeFile(replacement.store, cold, "current.txt", "new remote\n");
    const published = cold.database.publishProvisionalClone(replacement, cold.context.now());
    expect(cold.database.checkoutAt("/repo")?.repoId).toBe(published.repoId);
    expect(cold.worktree.stat("/repo/obsolete.txt")).toBeNull();
    expect(cold.worktree.readFile("/repo/current.txt")).toEqual(utf8.encode("new remote\n"));
    expect(cold.worktree.readFile("/repo/untracked.txt")).toEqual(utf8.encode("caller content\n"));
  });

  it("rolls a failed expired-owner cleanup back and permits a later cold retry", () => {
    const workspace = makeWorkspace({ startTime: 40_000 });
    const owner = workspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );
    materializeFile(owner.store, workspace, "rollback.txt", "must survive rollback\n");
    workspace.tick(PROVISIONAL_CLONE_LEASE_MS);
    const injected = new Error("injected exact cleanup failure");
    const firstCold = reopenWorkspace(workspace);
    const removeTracked = trackedCleanup(firstCold);
    expect(() =>
      firstCold.database.beginProvisionalClone(
        "/repo",
        "ref: refs/heads/main",
        firstCold.context.now(),
        (store) => {
          removeTracked(store);
          throw injected;
        },
      ),
    ).toThrow(injected);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT id FROM git_repositories WHERE clone_generation = ?",
        owner.generation,
      ),
    ).toBe(owner.checkout.repoId);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_index WHERE checkout_id = ? AND path = 'rollback.txt'",
        owner.checkout.id,
      ),
    ).toBe(1);
    expect(workspace.worktree.readFile("/repo/rollback.txt")).toEqual(
      utf8.encode("must survive rollback\n"),
    );

    const secondCold = reopenWorkspace(workspace);
    const secondCleanup = trackedCleanup(secondCold);
    const replacement = secondCold.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      secondCold.context.now(),
      secondCleanup,
    );
    expect(replacement.generation).toBeGreaterThan(owner.generation);
    expect(secondCold.worktree.stat("/repo/rollback.txt")).toBeNull();
    secondCold.database.discardProvisionalClone(
      replacement,
      secondCold.context.now(),
      secondCleanup,
    );
  });

  it("rolls a faulty fallback write back before a changed-remote cold retry", async () => {
    const fixture = new GitFixture().init();
    fixture.write("obsolete.txt", "first remote\n");
    fixture.commit("first remote");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ startTime: 42_000 });
    writeWorkFile(workspace, "/repo/untracked.txt", "caller content\n");
    const injected = new Error("after durable fallback write");
    let failed = false;
    const faultyWorktree: Worktree = {
      ...workspace.worktree,
      writeFiles(entries, options) {
        workspace.worktree.writeFiles(entries, options);
        if (!failed) {
          failed = true;
          throw injected;
        }
      },
    };
    const faultyContext: GitContext = { ...workspace.context, worktree: faultyWorktree };

    try {
      await expect(clone(faultyContext, { url: server.url, dir: "/repo" })).rejects.toBe(injected);
      expect(failed).toBe(true);
      expect(workspace.worktree.stat("/repo/obsolete.txt")).toBeNull();
      expect(workspace.worktree.readFile("/repo/untracked.txt")).toEqual(
        utf8.encode("caller content\n"),
      );
      expect(workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_index")).toBe(0);
      expect(workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_repositories")).toBe(0);

      fixture.remove("obsolete.txt");
      fixture.write("current.txt", "changed remote\n");
      fixture.commit("changed remote");
      const cold = reopenWorkspace(workspace);
      await clone(cold.context, { url: server.url, dir: "/repo" });
      expect(cold.worktree.stat("/repo/obsolete.txt")).toBeNull();
      expect(cold.worktree.readFile("/repo/current.txt")).toEqual(utf8.encode("changed remote\n"));
      expect(cold.worktree.readFile("/repo/untracked.txt")).toEqual(
        utf8.encode("caller content\n"),
      );
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("fails closed when fallback worktree transaction identity is unavailable", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "must not publish\n");
    fixture.commit("unproven worktree database");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ startTime: 43_000 });
    const { db: _ignoredDatabase, ...unprovenWorktree } = workspace.worktree;
    const context: GitContext = { ...workspace.context, worktree: unprovenWorktree };

    try {
      await expect(clone(context, { url: server.url, dir: "/repo" })).rejects.toMatchObject({
        code: "EUNSUPPORTED",
      });
      expect(workspace.worktree.stat("/repo/file.txt")).toBeNull();
      expect(workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_repositories")).toBe(0);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rejects caller-owned target and structural collisions without changing them", async () => {
    const fixture = new GitFixture().init();
    fixture.write("file.txt", "remote file\n");
    fixture.write("dir/nested.txt", "remote nested\n");
    fixture.commit("collision remote");
    const server = await startGitServer(fixture.dir);
    const workspace = makeWorkspace({ startTime: 44_000 });
    writeWorkFile(workspace, "/same/file.txt", "caller file\n");
    writeWorkFile(workspace, "/structural/dir", "caller structural leaf\n");
    writeWorkFile(workspace, "/descendant/file.txt/untracked.txt", "caller descendant\n");

    try {
      await expect(
        clone(workspace.context, { url: server.url, dir: "/same" }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(
        clone(workspace.context, { url: server.url, dir: "/structural" }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(
        clone(workspace.context, { url: server.url, dir: "/descendant" }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(workspace.worktree.readFile("/same/file.txt")).toEqual(utf8.encode("caller file\n"));
      expect(workspace.worktree.readFile("/structural/dir")).toEqual(
        utf8.encode("caller structural leaf\n"),
      );
      expect(workspace.worktree.readFile("/descendant/file.txt/untracked.txt")).toEqual(
        utf8.encode("caller descendant\n"),
      );
      expect(workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_repositories")).toBe(0);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("revokes storage caches after a live discard cleanup rolls back", () => {
    const workspace = makeWorkspace({ startTime: 45_000 });
    const owner = workspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );
    const bytes = utf8.encode("rolled back object\n");
    const oid = hashObject("blob", bytes);
    const injected = new Error("injected live discard failure");

    expect(() =>
      workspace.database.discardProvisionalClone(owner, workspace.context.now(), (store) => {
        expect(store.write("blob", bytes)).toBe(oid);
        expect(store.read(oid)?.data).toEqual(bytes);
        throw injected;
      }),
    ).toThrow(injected);
    expect(
      workspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_objects WHERE repo_id = ? AND oid = ?",
        owner.checkout.repoId,
        oid,
      ),
    ).toBe(0);
    expect(() => owner.store.has(oid)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => owner.store.read(oid)).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() => owner.store.configSet("revoked.owner", "forbidden")).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
  });

  it("allows an issued exact owner to discard at expiry and rejects copied tokens", () => {
    const workspace = makeWorkspace({ startTime: 47_000 });
    const cleanup = trackedCleanup(workspace);
    const owner = workspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      workspace.context.now(),
      cleanup,
    );
    materializeFile(owner.store, workspace, "expired.txt", "expired clone\n");
    const copiedOwner = Object.freeze({
      checkout: owner.checkout,
      generation: owner.generation,
      store: owner.store,
    });
    expect(() =>
      workspace.database.discardProvisionalClone(copiedOwner, workspace.context.now(), cleanup),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(() => owner.store.configSet("legitimate.owner", "still active")).not.toThrow();

    workspace.tick(PROVISIONAL_CLONE_LEASE_MS);
    expect(() =>
      workspace.database.renewProvisionalClone(owner, workspace.context.now()),
    ).toThrowError(expect.objectContaining({ code: "ESTALE" }));
    expect(() => owner.store.has("0000000000000000000000000000000000000000")).toThrowError(
      expect.objectContaining({ code: "EWORKTREENOTFOUND" }),
    );
    expect(() =>
      workspace.database.discardProvisionalClone(owner, workspace.context.now(), cleanup),
    ).not.toThrow();
    expect(workspace.database.db.scalar<number>("SELECT COUNT(*) FROM git_repositories")).toBe(0);
    expect(workspace.worktree.stat("/repo/expired.txt")).toBeNull();
  });

  it("fails closed before publishing or taking over a provisional repository with a secondary", () => {
    const publishWorkspace = makeWorkspace({ startTime: 48_000 });
    const publishOwner = publishWorkspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      publishWorkspace.context.now(),
      noCleanup,
    );
    const publishSecondary = injectProvisionalSecondary(
      publishWorkspace,
      publishOwner.store,
      publishOwner.checkout.repoId,
      "/injected",
    );
    expect(() => publishWorkspace.database.checkoutAt("/repo")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => publishWorkspace.database.findCheckout("/injected/orphan.txt")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => publishWorkspace.database.listRoutingCheckouts()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => publishWorkspace.database.listRoutingRoots()).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() => publishWorkspace.database.openCheckout(publishOwner.checkout)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );
    expect(() =>
      publishWorkspace.database.publishProvisionalClone(
        publishOwner,
        publishWorkspace.context.now(),
      ),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(
      publishWorkspace.database.db.one(
        "SELECT lifecycle, clone_generation FROM git_repositories WHERE id = ?",
        publishOwner.checkout.repoId,
      ),
    ).toEqual({ lifecycle: "provisional", clone_generation: publishOwner.generation });
    expect(
      publishWorkspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_checkouts WHERE id = ?",
        publishSecondary,
      ),
    ).toBe(1);
    expect(publishWorkspace.worktree.readFile("/injected/orphan.txt")).toEqual(
      utf8.encode("orphan checkout\n"),
    );

    const takeoverWorkspace = makeWorkspace({ startTime: 49_000 });
    const takeoverOwner = takeoverWorkspace.database.beginProvisionalClone(
      "/repo",
      "ref: refs/heads/main",
      takeoverWorkspace.context.now(),
      noCleanup,
    );
    const takeoverSecondary = injectProvisionalSecondary(
      takeoverWorkspace,
      takeoverOwner.store,
      takeoverOwner.checkout.repoId,
      "/other",
    );
    takeoverWorkspace.tick(PROVISIONAL_CLONE_LEASE_MS);
    expect(() =>
      takeoverWorkspace.database.beginProvisionalClone(
        "/repo",
        "ref: refs/heads/main",
        takeoverWorkspace.context.now(),
        trackedCleanup(takeoverWorkspace),
      ),
    ).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(
      takeoverWorkspace.database.db.one(
        "SELECT lifecycle, clone_generation FROM git_repositories WHERE id = ?",
        takeoverOwner.checkout.repoId,
      ),
    ).toEqual({ lifecycle: "provisional", clone_generation: takeoverOwner.generation });
    expect(
      takeoverWorkspace.database.db.scalar<number>(
        "SELECT COUNT(*) FROM git_checkouts WHERE id = ?",
        takeoverSecondary,
      ),
    ).toBe(1);
    expect(takeoverWorkspace.worktree.readFile("/other/orphan.txt")).toEqual(
      utf8.encode("orphan checkout\n"),
    );
  });

  it("never reuses repository, checkout, or clone identities", () => {
    const workspace = makeWorkspace({ startTime: 50_000 });
    const first = workspace.database.beginProvisionalClone(
      "/first",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );
    workspace.database.discardProvisionalClone(first, workspace.context.now(), noCleanup);
    const second = workspace.database.beginProvisionalClone(
      "/second",
      "ref: refs/heads/main",
      workspace.context.now(),
      noCleanup,
    );
    expect(second.checkout.repoId).toBeGreaterThan(first.checkout.repoId);
    expect(second.checkout.id).toBeGreaterThan(first.checkout.id);
    expect(second.generation).toBeGreaterThan(first.generation);
    workspace.database.discardProvisionalClone(second, workspace.context.now(), noCleanup);

    const ready = workspace.database.createRepository("/ready", "ref: refs/heads/main");
    workspace.database.destroyRepository(ready.repoId);
    const replacement = workspace.database.createRepository("/replacement", "ref: refs/heads/main");
    expect(replacement.repoId).toBeGreaterThan(ready.repoId);
    expect(replacement.id).toBeGreaterThan(ready.id);
  });

  it("fails closed on trailing controls, malformed lifecycle rows, and exhausted counters", () => {
    const identityCounters: Array<"last_repo_id" | "last_checkout_id"> = [
      "last_repo_id",
      "last_checkout_id",
    ];
    for (const counter of identityCounters) {
      const db = new TestDatabase();
      const database = new SqliteGitDatabase(db);
      database.createRepository("/repo", "ref: refs/heads/main");
      db.run(`UPDATE git_identity_control SET ${counter} = 0 WHERE singleton = 1`);
      expect(() => new SqliteGitDatabase(db)).toThrowError(
        expect.objectContaining({ code: "ECORRUPT" }),
      );
    }

    const cloneDb = new TestDatabase();
    const cloneDatabase = new SqliteGitDatabase(cloneDb);
    cloneDatabase.beginProvisionalClone("/repo", "ref: refs/heads/main", 60_000, noCleanup);
    cloneDb.run("UPDATE git_identity_control SET last_clone_generation = 0 WHERE singleton = 1");
    expect(() => new SqliteGitDatabase(cloneDb)).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );

    const lifecycleDb = new TestDatabase();
    const lifecycleDatabase = new SqliteGitDatabase(lifecycleDb);
    lifecycleDatabase.createRepository("/repo", "ref: refs/heads/main");
    lifecycleDb.run("PRAGMA ignore_check_constraints = ON");
    lifecycleDb.run("UPDATE git_repositories SET lifecycle = 'broken' WHERE id = 1");
    expect(() => lifecycleDatabase.findCheckout("/repo/file.txt")).toThrowError(
      expect.objectContaining({ code: "ECORRUPT" }),
    );

    const exhaustedDb = new TestDatabase();
    const exhausted = new SqliteGitDatabase(exhaustedDb);
    exhaustedDb.run(
      `UPDATE git_identity_control
          SET last_repo_id = ?, last_checkout_id = ?, last_clone_generation = ?
        WHERE singleton = 1`,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => exhausted.createRepository("/repo", "ref: refs/heads/main")).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() =>
      exhausted.beginProvisionalClone("/clone", "ref: refs/heads/main", 70_000, noCleanup),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    const cloneExhaustedDb = new TestDatabase();
    const cloneExhausted = new SqliteGitDatabase(cloneExhaustedDb);
    cloneExhaustedDb.run(
      `UPDATE git_identity_control SET last_clone_generation = ? WHERE singleton = 1`,
      Number.MAX_SAFE_INTEGER,
    );
    expect(() =>
      cloneExhausted.beginProvisionalClone("/clone", "ref: refs/heads/main", 80_000, noCleanup),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
});
