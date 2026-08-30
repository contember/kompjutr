import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { equalBytes, fromHex, utf8Decoder } from "../src/core/bytes.js";
import type { GitContext, InitialWorktreeWriter } from "../src/core/context.js";
import { GitError } from "../src/core/errors.js";
import { initRepository } from "../src/core/ops/init.js";
import { checkout } from "../src/core/ops/refs.js";
import type { Repository } from "../src/core/repository.js";
import { createFilesystem } from "../src/fs/filesystem.js";
import { createInitialWorktreeWriter } from "../src/fs/store/initial-write.js";
import type { Filesystem } from "../src/fs/types.js";
import {
  INDEX_DIRTY,
  initializeIndexTracker,
  iterateIndexTrackerDirty,
  readIndexTrackerState,
  resealIndexTracker,
} from "../src/sqlite/index-tracker.js";
import { PACK_BLOB_BATCH_TARGET_BYTES, SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { SqliteTestStorage } from "./helpers/storage.js";

interface InitialRepository {
  storage: SqliteTestStorage;
  db: TestDatabase;
  worktree: Filesystem;
  context: GitContext;
  repo: Repository;
}

function makeInitialRepository(
  root = "/repo",
  storage = new SqliteTestStorage(),
): InitialRepository {
  const now = (): number => 1_600_000_000_000;
  const db = new TestDatabase(storage);
  const worktree = createFilesystem(db, { now });
  const database = new SqliteGitDatabase(db, { now });
  initializeIndexTracker(db);
  const context: GitContext = {
    database,
    worktree,
    initialWorktree: createInitialWorktreeWriter(db, now, (candidate) => candidate === database),
    indexTracker: {
      reseal: (checkoutId, baselineTreeOid, entries) =>
        resealIndexTracker(db, checkoutId, baselineTreeOid, entries),
    },
    now,
    timezoneOffset: () => 0,
  };
  const repo = initRepository(context, { dir: root });
  return { storage, db, worktree, context, repo };
}

function tableCount(runtime: InitialRepository, table: string): number {
  const count = runtime.db.scalar<number>(`SELECT count(*) FROM ${table}`);
  if (count === undefined) throw new Error(`${table} count returned no row`);
  return count;
}

function observingWriter(
  writer: InitialWorktreeWriter,
  onAttempt: () => void,
  supportsDatabase: (database: SqliteGitDatabase) => boolean,
  onCommit?: () => void,
): InitialWorktreeWriter {
  return {
    supportsDatabase,
    tryRun(root, body, afterClose, reservation) {
      onAttempt();
      const result = writer.tryRun(root, body, afterClose, reservation);
      if (result.kind === "committed") onCommit?.();
      return result;
    },
  };
}

describe("initial standalone checkout", () => {
  it("writes the former 2,201-byte initial-index path without a tree-walk refusal", () => {
    const runtime = makeInitialRepository();
    const path = "p".repeat(2_201);
    const oid = "1".repeat(40);

    expect(
      runtime.repo.checkout.tryCreateInitialState((session) => {
        session.put({
          path,
          stage: 0,
          mode: 0o100644,
          oid,
          size: 1,
          mtime: null,
          ino: null,
        });
      }),
    ).toEqual({ available: true, value: undefined });
    expect(runtime.repo.checkout.indexGet(path)).toEqual({
      path,
      stage: 0,
      mode: 0o100644,
      oid,
      size: 1,
      mtime: null,
      ino: null,
      rev: null,
    });
  });

  it("atomically writes exact files, symlinks, index, HEAD, reflog, and tracker state", async () => {
    const fixture = new GitFixture().init("main");
    const readme = "hello\n";
    const script = "#!/bin/sh\necho hi\n";
    const linkTarget = "README.md";
    fixture.write("README.md", readme);
    fixture.writeExecutable("bin/run.sh", script);
    fixture.symlink(linkTarget, "readme-link");
    const gitlinkOid = fixture.commit("gitlink target");
    fixture.git("update-index", "--add", "--cacheinfo", `160000,${gitlinkOid},vendor/module`);
    fixture.git("commit", "-q", "-m", "checkout target");
    const targetTip = fixture.git("rev-parse", "HEAD");
    fixture.git("tag", "v1");
    const targetTree = fixture.git("rev-parse", "v1^{tree}");
    fixture.write("README.md", "later main\n");
    fixture.remove("bin/run.sh");
    fixture.write("later-main-only.txt", "not in target\n");
    fixture.symlink("later-main-only.txt", "readme-link");
    const laterTip = fixture.commit("advance main");
    const runtime = makeInitialRepository();

    try {
      await importFixture(fixture, runtime.repo.checkout);
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "v1" });

      expect(utf8Decoder.decode(runtime.worktree.readFile("/repo/README.md"))).toBe(readme);
      expect(utf8Decoder.decode(runtime.worktree.readFile("/repo/bin/run.sh"))).toBe(script);
      expect(runtime.worktree.readlink("/repo/readme-link")).toBe(linkTarget);
      expect(runtime.worktree.stat("/repo/README.md")?.mode).toBe(0o100644);
      expect(runtime.worktree.stat("/repo/bin/run.sh")?.mode).toBe(0o100755);
      expect(runtime.worktree.stat("/repo/readme-link")?.type).toBe("symlink");
      expect(runtime.worktree.stat("/repo/vendor/module")).toBeNull();
      expect(runtime.worktree.stat("/repo/later-main-only.txt")).toBeNull();

      const entries = runtime.repo.checkout.indexEntries();
      expect(
        entries.map((entry) => ({
          path: entry.path,
          stage: entry.stage,
          mode: entry.mode,
          oid: entry.oid,
          size: entry.size,
        })),
      ).toEqual([
        {
          path: "README.md",
          stage: 0,
          mode: 0o100644,
          oid: fixture.git("rev-parse", "v1:README.md"),
          size: new TextEncoder().encode(readme).length,
        },
        {
          path: "bin/run.sh",
          stage: 0,
          mode: 0o100755,
          oid: fixture.git("rev-parse", "v1:bin/run.sh"),
          size: new TextEncoder().encode(script).length,
        },
        {
          path: "readme-link",
          stage: 0,
          mode: 0o120000,
          oid: fixture.git("rev-parse", "v1:readme-link"),
          size: new TextEncoder().encode(linkTarget).length,
        },
      ]);
      for (const path of ["README.md", "bin/run.sh", "readme-link"]) {
        const oid = fixture.git("rev-parse", `v1:${path}`);
        const mapped = runtime.db.scalar<string>(
          "SELECT oid FROM git_blob_ids WHERE repo_id = ? AND content_id = ?",
          runtime.repo.store.repoId,
          fromHex(oid),
        );
        expect(mapped).toBe(oid);
      }
      const readmeContentId = runtime.db.scalar<unknown>(
        `SELECT node.content_id
           FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
          WHERE path.path = '/repo/README.md'`,
      );
      expect(
        readmeContentId instanceof Uint8Array &&
          equalBytes(readmeContentId, fromHex(fixture.git("rev-parse", "v1:README.md"))),
      ).toBe(true);

      expect(runtime.repo.checkout.head()).toBe(targetTip);
      expect(runtime.repo.reflog("HEAD")[0]).toMatchObject({
        oldRaw: "ref: refs/heads/main",
        newRaw: targetTip,
        oldOid: laterTip,
        newOid: targetTip,
        reason: "checkout",
      });
      expect(readIndexTrackerState(runtime.db, runtime.repo.checkout.checkoutId)).toEqual({
        available: true,
        baselineTreeOid: targetTree,
      });
      expect([...iterateIndexTrackerDirty(runtime.db, runtime.repo.checkout.checkoutId)]).toEqual([
        { path: "vendor/module", flags: INDEX_DIRTY },
      ]);
    } finally {
      fixture.dispose();
    }
  });

  it("commits through the initial path when the existing repository root is empty", async () => {
    const fixture = new GitFixture().init("main");
    fixture.write("a.txt", "a\n");
    fixture.commit("target");
    const tree = fixture.git("rev-parse", "HEAD^{tree}");
    const runtime = makeInitialRepository();

    try {
      runtime.worktree.makeDirectories(["/repo"]);
      await importFixture(fixture, runtime.repo.checkout);
      const writer = runtime.context.initialWorktree;
      if (writer === undefined) throw new Error("initial writer is missing");
      let attempts = 0;
      let commits = 0;
      runtime.context.initialWorktree = observingWriter(
        writer,
        () => attempts++,
        (database) => database === runtime.context.database,
        () => commits++,
      );

      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });

      expect(attempts).toBe(1);
      expect(commits).toBe(1);
      expect(utf8Decoder.decode(runtime.worktree.readFile("/repo/a.txt"))).toBe("a\n");
      expect(runtime.repo.checkout.indexGet("a.txt")).toMatchObject({
        stage: 0,
        oid: fixture.git("rev-parse", "HEAD:a.txt"),
        size: 2,
      });
      expect(readIndexTrackerState(runtime.db, runtime.repo.checkout.checkoutId)).toEqual({
        available: true,
        baselineTreeOid: tree,
      });
    } finally {
      fixture.dispose();
    }
  });

  it("keeps path, generic-writer, populated-root, and nonempty-index cases on legacy checkout", async () => {
    const fixture = new GitFixture().init("main");
    fixture.write("a.txt", "a\n");
    fixture.write("nested/b.txt", "b\n");
    fixture.commit("target");

    try {
      const path = makeInitialRepository();
      await importFixture(fixture, path.repo.checkout);
      const pathWriter = path.context.initialWorktree;
      if (pathWriter === undefined) throw new Error("initial writer is missing");
      let pathAttempts = 0;
      path.context.initialWorktree = observingWriter(
        pathWriter,
        () => pathAttempts++,
        (database) => database === path.context.database,
      );
      checkout(path.context, path.repo, path.worktree, { ref: "main", paths: ["a.txt"] });
      expect(pathAttempts).toBe(0);
      expect(utf8Decoder.decode(path.worktree.readFile("/repo/a.txt"))).toBe("a\n");
      expect(path.worktree.stat("/repo/nested/b.txt")).toBeNull();

      const generic = makeInitialRepository();
      await importFixture(fixture, generic.repo.checkout);
      const genericWriter = generic.context.initialWorktree;
      if (genericWriter === undefined) throw new Error("initial writer is missing");
      let genericAttempts = 0;
      generic.context.initialWorktree = observingWriter(
        genericWriter,
        () => genericAttempts++,
        () => false,
      );
      checkout(generic.context, generic.repo, generic.worktree, { ref: "main" });
      expect(genericAttempts).toBe(0);
      expect(utf8Decoder.decode(generic.worktree.readFile("/repo/nested/b.txt"))).toBe("b\n");
      expect(readIndexTrackerState(generic.db, generic.repo.checkout.checkoutId)).toEqual({
        available: false,
      });

      const populated = makeInitialRepository();
      await importFixture(fixture, populated.repo.checkout);
      populated.worktree.writeFiles([
        { path: "/repo/keep.txt", bytes: new TextEncoder().encode("keep\n") },
      ]);
      const populatedWriter = populated.context.initialWorktree;
      if (populatedWriter === undefined) throw new Error("initial writer is missing");
      let populatedAttempts = 0;
      populated.context.initialWorktree = observingWriter(
        populatedWriter,
        () => populatedAttempts++,
        (database) => database === populated.context.database,
      );
      checkout(populated.context, populated.repo, populated.worktree, { ref: "main" });
      expect(populatedAttempts).toBe(1);
      expect(utf8Decoder.decode(populated.worktree.readFile("/repo/keep.txt"))).toBe("keep\n");
      expect(utf8Decoder.decode(populated.worktree.readFile("/repo/a.txt"))).toBe("a\n");
      expect(readIndexTrackerState(populated.db, populated.repo.checkout.checkoutId)).toEqual({
        available: false,
      });

      const indexed = makeInitialRepository();
      await importFixture(fixture, indexed.repo.checkout);
      const oid = fixture.git("rev-parse", "HEAD:a.txt");
      indexed.repo.checkout.indexPut({
        path: "stale.txt",
        stage: 0,
        mode: 0o100644,
        oid,
        size: null,
        mtime: null,
        ino: null,
      });
      for (const stage of [1, 2, 3]) {
        indexed.repo.checkout.indexPut({
          path: "conflict.txt",
          stage,
          mode: 0o100644,
          oid,
          size: null,
          mtime: null,
          ino: null,
        });
      }
      const indexedWriter = indexed.context.initialWorktree;
      if (indexedWriter === undefined) throw new Error("initial writer is missing");
      let indexedAttempts = 0;
      indexed.context.initialWorktree = observingWriter(
        indexedWriter,
        () => indexedAttempts++,
        (database) => database === indexed.context.database,
      );
      checkout(indexed.context, indexed.repo, indexed.worktree, { ref: "main", force: true });
      expect(indexedAttempts).toBe(1);
      expect(indexed.repo.checkout.indexGet("stale.txt")).toBeNull();
      expect(
        indexed.repo.checkout
          .indexEntries()
          .filter((entry) => entry.path === "conflict.txt")
          .map((entry) => entry.stage),
      ).toEqual([1, 2, 3]);
      expect(utf8Decoder.decode(indexed.worktree.readFile("/repo/nested/b.txt"))).toBe("b\n");
      expect(readIndexTrackerState(indexed.db, indexed.repo.checkout.checkoutId)).toEqual({
        available: false,
      });
    } finally {
      fixture.dispose();
    }
  });

  it("keeps a late blob above the batching target on the initial checkout path", async () => {
    const fixture = new GitFixture().init("main");
    for (let index = 0; index < 1_100; index++) {
      fixture.write(`file-${String(index).padStart(4, "0")}.txt`, "same\n");
    }
    const large = randomBytes(PACK_BLOB_BATCH_TARGET_BYTES + 1);
    fixture.write("zz-large.bin", large);
    fixture.commit("late blob above batching target");
    const runtime = makeInitialRepository();

    try {
      await importFixture(fixture, runtime.repo.checkout);
      runtime.storage.resetCounters();
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });

      expect(utf8Decoder.decode(runtime.worktree.readFile("/repo/file-0000.txt"))).toBe("same\n");
      expect(equalBytes(runtime.worktree.readFile("/repo/zz-large.bin"), large)).toBe(true);
      expect(tableCount(runtime, "git_index")).toBe(1_101);
      expect(runtime.repo.checkout.indexEntries()).toHaveLength(1_101);
      expect(readIndexTrackerState(runtime.db, runtime.repo.checkout.checkoutId)).toEqual({
        available: true,
        baselineTreeOid: fixture.git("rev-parse", "HEAD^{tree}"),
      });
    } finally {
      fixture.dispose();
    }
  });

  it("rolls back worktree, index, mappings, tracker, HEAD, and reflog on a late failure", async () => {
    const fixture = new GitFixture().init("main");
    fixture.write("a.txt", "a\n");
    const tip = fixture.commit("target");
    fixture.git("tag", "v1");
    const runtime = makeInitialRepository();
    const tracker = runtime.context.indexTracker;
    if (tracker === undefined) throw new Error("index tracker is missing");
    const injected = new GitError("EIO", "injected late tracker failure");
    runtime.context.indexTracker = {
      reseal(checkoutId, baselineTreeOid, entries) {
        tracker.reseal(checkoutId, baselineTreeOid, entries);
        throw injected;
      },
    };

    try {
      await importFixture(fixture, runtime.repo.checkout);
      expect(runtime.repo.checkout.head()).toBe("ref: refs/heads/main");
      expect(runtime.repo.reflog("HEAD")).toEqual([]);

      expect(() =>
        checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "v1" }),
      ).toThrow(injected);

      expect(runtime.worktree.stat("/repo")).toBeNull();
      expect(tableCount(runtime, "git_index")).toBe(0);
      expect(tableCount(runtime, "git_blob_ids")).toBe(0);
      expect(runtime.repo.checkout.head()).toBe("ref: refs/heads/main");
      expect(runtime.repo.head()).toEqual({ ref: "refs/heads/main", oid: tip });
      expect(runtime.repo.reflog("HEAD")).toEqual([]);
      expect(readIndexTrackerState(runtime.db, runtime.repo.checkout.checkoutId)).toEqual({
        available: false,
      });
      expect([...iterateIndexTrackerDirty(runtime.db, runtime.repo.checkout.checkoutId)]).toEqual(
        [],
      );
    } finally {
      fixture.dispose();
    }
  });

  it("keeps a 24,252-file standalone checkout below 1,000 statements", async () => {
    const fixture = new GitFixture().init("main");
    for (let index = 0; index < 24_252; index++) {
      fixture.write(`file-${String(index).padStart(5, "0")}.txt`, `content-${index}\n`);
    }
    fixture.commit("synthetic scale");
    const runtime = makeInitialRepository();

    try {
      await importFixture(fixture, runtime.repo.checkout);
      runtime.storage.resetCounters();
      checkout(runtime.context, runtime.repo, runtime.worktree, { ref: "main" });
      const statements = runtime.storage.statementCount;

      expect(tableCount(runtime, "git_index")).toBe(24_252);
      expect(statements).toBeLessThan(1_000);
      expect(
        runtime.db.scalar<number>(
          `SELECT count(*)
             FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
            WHERE path.path > '/repo' AND path.path < '/repo0' AND node.type != 'dir'`,
        ),
      ).toBe(24_252);
      for (const index of [0, 12_126, 24_251]) {
        const path = `file-${String(index).padStart(5, "0")}.txt`;
        const content = `content-${index}\n`;
        const bytes = new TextEncoder().encode(content);
        const oid = fixture.git("rev-parse", `HEAD:${path}`);
        expect(utf8Decoder.decode(runtime.worktree.readFile(`/repo/${path}`))).toBe(content);
        expect(runtime.worktree.stat(`/repo/${path}`)).toMatchObject({
          type: "file",
          mode: 0o100644,
          size: bytes.length,
        });
        expect(runtime.repo.checkout.indexGet(path)).toMatchObject({
          path,
          stage: 0,
          mode: 0o100644,
          oid,
          size: bytes.length,
        });
      }
      expect(readIndexTrackerState(runtime.db, runtime.repo.checkout.checkoutId)).toEqual({
        available: true,
        baselineTreeOid: fixture.git("rev-parse", "HEAD^{tree}"),
      });
    } finally {
      fixture.dispose();
    }
  });
});
