import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { equalBytes, fromHex } from "../src/core/bytes.js";
import type { InitialWorktreeWriter } from "../src/core/context.js";
import { GitError } from "../src/core/errors.js";
import { createGit, type GitFactory } from "../src/git/client.js";
import { Workspace } from "../src/runtime/workspace.js";
import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "../src/sqlite/db.js";
import { readBlob } from "../src/sqlite/db.js";
import { WALK_TREE_SQL } from "../src/sqlite/store.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";

class RecordingStorage implements DurableObjectStorageLike {
  readonly inner = new SqliteTestStorage();
  readonly sql: SQLStorageLike;
  walkStatements = 0;
  blobReadStatements = 0;
  maxBlobReadOids = 0;

  constructor() {
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        if (query === WALK_TREE_SQL) this.walkStatements++;
        if (
          query.includes("WITH wanted(ordinal, oid) AS") &&
          query.includes("LEFT JOIN git_objects loose")
        ) {
          this.blobReadStatements++;
          const wanted = bindings[0];
          if (typeof wanted === "string") {
            this.maxBlobReadOids = Math.max(
              this.maxBlobReadOids,
              wanted.match(/[0-9a-f]{40}/g)?.length ?? 0,
            );
          }
        }
        return this.inner.sql.exec<Row>(query, ...bindings);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }

  resetCounters(): void {
    this.inner.resetCounters();
    this.walkStatements = 0;
    this.blobReadStatements = 0;
    this.maxBlobReadOids = 0;
  }
}

function makeRuntime(storage: RecordingStorage, git: GitFactory = createGit()): Workspace {
  return new Workspace({
    storage,
    git,
    now: () => 1_600_000_000_000,
    defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
  });
}

function count(workspace: Workspace, table: string): number | undefined {
  return workspace.db.scalar<number>(`SELECT count(*) FROM ${table}`);
}

describe("clone initial-state fast path", () => {
  it("matches file modes and symlink identity with one clean tree traversal", async () => {
    const fixture = new GitFixture().init();
    fixture.write("README.md", "hello\n");
    fixture.writeExecutable("bin/run.sh", "#!/bin/sh\necho hi\n");
    fixture.write("deep/note.txt", "nested\n");
    fixture.symlink("README.md", "readme-link");
    fixture.commit("initial");
    const server = await startGitServer(fixture.dir);
    const storage = new RecordingStorage();
    const workspace = makeRuntime(storage);
    const git = workspace.git;
    storage.resetCounters();

    try {
      await git.clone({ url: server.url, dir: "/repo" });

      expect(await workspace.fs.readFile("/repo/README.md", "utf8")).toBe("hello\n");
      expect(await workspace.fs.readFile("/repo/deep/note.txt", "utf8")).toBe("nested\n");
      expect(await workspace.fs.readlink("/repo/readme-link")).toBe("README.md");
      expect((workspace.filesystem.stat("/repo/bin/run.sh")?.mode ?? 0) & 0o111).not.toBe(0);
      expect(storage.walkStatements).toBe(1);
      expect(storage.maxBlobReadOids).toBeLessThanOrEqual(1_000);

      const linkOid = fixture.git("rev-parse", "HEAD:readme-link");
      const nodeId = workspace.db.scalar<unknown>(
        `SELECT node.content_id
           FROM fs_paths path JOIN fs_nodes node ON node.inode = path.inode
          WHERE path.path = '/repo/readme-link'`,
      );
      const mappedOid = workspace.db.scalar<string>(
        "SELECT oid FROM git_blob_ids WHERE repo_id = 1 AND content_id = ?",
        fromHex(linkOid),
      );
      expect(
        nodeId === undefined ? undefined : equalBytes(readBlob(nodeId), fromHex(linkOid)),
      ).toBe(true);
      expect(mappedOid).toBe(linkOid);
      expect(await git.status({ dir: "/repo" })).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("processes only the contiguous path prefix when an oid repeats after a deferred blob", async () => {
    const fixture = new GitFixture().init();
    const first = randomBytes(2 * 1024 * 1024);
    const second = randomBytes(2 * 1024 * 1024);
    fixture.write("a.bin", first);
    fixture.write("b.bin", second);
    fixture.write("c.bin", first);
    fixture.commit("duplicate oid");
    const server = await startGitServer(fixture.dir);
    const storage = new RecordingStorage();
    const workspace = makeRuntime(storage);
    const git = workspace.git;
    storage.resetCounters();

    try {
      await git.clone({ url: server.url, dir: "/repo" });

      expect(await workspace.fs.readFile("/repo/a.bin")).toEqual(first);
      expect(await workspace.fs.readFile("/repo/b.bin")).toEqual(second);
      expect(await workspace.fs.readFile("/repo/c.bin")).toEqual(first);
      expect(storage.blobReadStatements).toBe(3);
      expect(storage.walkStatements).toBe(1);
      expect(await git.status({ dir: "/repo" })).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("rolls back a late oversized batch and completes through ordinary checkout", async () => {
    const fixture = new GitFixture().init();
    for (let index = 0; index < 1_100; index++) {
      fixture.write(`file-${String(index).padStart(4, "0")}.txt`, "same\n");
    }
    const large = randomBytes(3 * 1024 * 1024 + 1);
    fixture.write("zz-large.bin", large);
    fixture.commit("late oversized blob");
    const server = await startGitServer(fixture.dir);
    const storage = new RecordingStorage();
    const workspace = makeRuntime(storage);
    const git = workspace.git;
    storage.resetCounters();

    try {
      await git.clone({ url: server.url, dir: "/repo" });

      expect(await workspace.fs.readFile("/repo/file-0000.txt", "utf8")).toBe("same\n");
      expect(await workspace.fs.readFile("/repo/zz-large.bin")).toEqual(large);
      expect(count(workspace, "git_index")).toBe(1_101);
      expect(storage.walkStatements).toBe(3);
      expect(await git.status({ dir: "/repo" })).toEqual([]);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("falls back when ineligible or path-limited and does not mask writer errors", async () => {
    const fixture = new GitFixture().init();
    fixture.write("a.txt", "a\n");
    fixture.write("b.txt", "b\n");
    fixture.commit("fallbacks");
    const server = await startGitServer(fixture.dir);

    try {
      let pathAttempts = 0;
      const pathFactory: GitFactory = (binding) => {
        const initial = binding.initialWorktree;
        if (initial === undefined) throw new Error("workspace did not bind its initial writer");
        const observed: InitialWorktreeWriter = {
          tryRun(root, body) {
            pathAttempts++;
            return initial.tryRun(root, body);
          },
        };
        return createGit()({ ...binding, initialWorktree: observed });
      };
      const pathStorage = new RecordingStorage();
      const paths = makeRuntime(pathStorage, pathFactory);
      await paths.git.clone({ url: server.url, dir: "/repo", paths: ["a.txt"] });
      expect(pathAttempts).toBe(0);
      expect(await paths.fs.readFile("/repo/a.txt", "utf8")).toBe("a\n");
      expect(paths.filesystem.stat("/repo/b.txt")).toBeNull();
      expect(pathStorage.walkStatements).toBe(2);

      const absentFactory: GitFactory = (binding) =>
        createGit()({ ...binding, initialWorktree: undefined });
      const absentStorage = new RecordingStorage();
      const absent = makeRuntime(absentStorage, absentFactory);
      await absent.git.clone({ url: server.url, dir: "/repo" });
      expect(await absent.fs.readFile("/repo/a.txt", "utf8")).toBe("a\n");
      expect(await absent.fs.readFile("/repo/b.txt", "utf8")).toBe("b\n");
      expect(absentStorage.walkStatements).toBe(2);

      let unavailableAttempts = 0;
      const unavailableFactory: GitFactory = (binding) => {
        const initial = binding.initialWorktree;
        if (initial === undefined) throw new Error("workspace did not bind its initial writer");
        const observed: InitialWorktreeWriter = {
          tryRun(root, body) {
            unavailableAttempts++;
            return initial.tryRun(root, body);
          },
        };
        return createGit()({ ...binding, initialWorktree: observed });
      };
      const unavailableStorage = new RecordingStorage();
      const unavailable = makeRuntime(unavailableStorage, unavailableFactory);
      await unavailable.fs.mkdir("/repo", { recursive: true });
      await unavailable.fs.writeFile("/repo/keep.txt", "keep\n");
      await unavailable.git.clone({ url: server.url, dir: "/repo" });
      expect(unavailableAttempts).toBe(1);
      expect(await unavailable.fs.readFile("/repo/keep.txt", "utf8")).toBe("keep\n");
      expect(await unavailable.fs.readFile("/repo/b.txt", "utf8")).toBe("b\n");
      expect(unavailableStorage.walkStatements).toBe(2);

      const injected = new GitError("EFBIG", "injected writer failure");
      const failingFactory: GitFactory = (binding) => {
        const failing: InitialWorktreeWriter = {
          tryRun() {
            throw injected;
          },
        };
        return createGit()({ ...binding, initialWorktree: failing });
      };
      const failingStorage = new RecordingStorage();
      const failing = makeRuntime(failingStorage, failingFactory);
      await expect(failing.git.clone({ url: server.url, dir: "/repo" })).rejects.toBe(injected);
      expect(count(failing, "git_repositories")).toBe(0);
      expect(failing.filesystem.stat("/repo")).toBeNull();
      expect(failingStorage.walkStatements).toBe(0);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });

  it("keeps a 24,252-file clone below 1,000 statements with 1,000-oid windows", async () => {
    const fixture = new GitFixture().init();
    for (let index = 0; index < 24_252; index++) {
      fixture.write(`file-${String(index).padStart(5, "0")}.txt`, `content-${index}\n`);
    }
    fixture.commit("synthetic scale");
    const server = await startGitServer(fixture.dir);
    const storage = new RecordingStorage();
    const workspace = makeRuntime(storage);
    const git = workspace.git;
    storage.resetCounters();

    try {
      await git.clone({ url: server.url, dir: "/repo" });

      expect(count(workspace, "git_index")).toBe(24_252);
      expect(storage.walkStatements).toBe(1);
      expect(storage.maxBlobReadOids).toBe(1_000);
      expect(storage.inner.statementCount).toBeLessThan(1_000);
    } finally {
      await server.close();
      fixture.dispose();
    }
  });
});
