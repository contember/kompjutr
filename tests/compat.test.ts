import { Workspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { ComputerWorktree, createSqliteGitClient } from "../src/compat/computer.js";
import { createGit } from "../src/git/client.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

describe("Computer client operation interlocks", () => {
  it("keeps Computer rm cached-only, recursive, and unconditional", async () => {
    const storage = new SqliteTestStorage();
    const workspace = new Workspace({
      storage,
      git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    });
    await workspace.git.init({});
    await workspace.fs.mkdir("/dir", { recursive: true });
    await workspace.fs.writeFile("/dir/a.txt", "one\n");
    await workspace.fs.writeFile("/dir/b.txt", "two\n");
    await workspace.git.add({ paths: ["dir"] });
    await workspace.fs.writeFile("/dir/a.txt", "staged\n");
    await workspace.git.add({ paths: ["dir/a.txt"] });
    await workspace.fs.writeFile("/dir/a.txt", "working tree\n");

    await expect(workspace.git.rm({ paths: ["dir"] })).resolves.toBeUndefined();

    await expect(workspace.git.lsFiles()).resolves.toEqual([]);
    await expect(workspace.fs.readFile("/dir/a.txt", "utf8")).resolves.toBe("working tree\n");
    await expect(workspace.fs.readFile("/dir/b.txt", "utf8")).resolves.toBe("two\n");
  });

  it("blocks commit during replay and clears any operation on hard reset", async () => {
    const storage = new SqliteTestStorage();
    const workspace = new Workspace({
      storage,
      git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    });
    await workspace.git.init({});
    await workspace.fs.writeFile("/file.txt", "base\n");
    await workspace.git.add({ paths: ["file.txt"] });
    const original = await workspace.git.commit({ message: "base" });
    const database = new SqliteGitDatabase(new TestDatabase(storage));
    const repository = database.find("/");
    if (repository === null) throw new Error("repository is missing");
    const store = database.open(repository);
    store.writeOperationState(
      {
        kind: "revert",
        originalHeadRef: "refs/heads/main",
        originalHeadOid: original.oid,
        phase: "empty",
        emptyReason: "source",
        sourceOid: original.oid,
        selectedParentOid: null,
        mainline: null,
        currentLabel: "HEAD",
        incomingLabel: original.oid.slice(0, 7),
        message: "Revert base\n",
        author: null,
        committer: null,
      },
      [],
    );

    await expect(workspace.git.commit({ message: "must not bypass replay" })).rejects.toMatchObject(
      { code: "EOPACTIVE" },
    );
    await workspace.git.reset({ hard: true });
    expect(store.readOperationState()).toBeNull();
  });

  it("hard reset removes native rebase modify-delete conflict content", async () => {
    const storage = new SqliteTestStorage();
    const workspace = new Workspace({
      storage,
      git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    });
    const git = workspace.git;
    await git.init({});
    await workspace.fs.writeFile("/deleted.txt", "base\n");
    await git.add({ paths: ["deleted.txt"] });
    await git.commit({ message: "base" });
    await git.branch({ name: "upstream" });
    await git.checkout({ ref: "upstream" });
    await workspace.fs.writeFile("/deleted.txt", "upstream\n");
    await git.add({ paths: ["deleted.txt"] });
    await git.commit({ message: "upstream modifies" });
    await git.checkout({ ref: "main" });
    await workspace.fs.rm("/deleted.txt");
    await git.add({ paths: ["deleted.txt"] });
    const original = await git.commit({ message: "current deletes" });

    const database = new SqliteGitDatabase(new TestDatabase(storage));
    const worktree = new ComputerWorktree(workspace.provider());
    const native = createGit()({
      database,
      worktree,
      now: () => 1_600_000_000_000,
      timezoneOffset: () => 0,
      defaultIdentity: { name: "Agent", email: "agent@example.com" },
    });
    await expect(native.rebase({ upstream: "upstream" })).resolves.toMatchObject({
      outcome: "conflicted",
    });
    const repository = database.find("/");
    if (repository === null) throw new Error("repository is missing");
    const store = database.open(repository);
    expect(store.hasConflicts()).toBe(true);
    expect(worktree.stat("/deleted.txt")).not.toBeNull();

    await git.reset({ hard: true });

    await expect(git.revParse({ ref: "HEAD" })).resolves.toBe(original.oid);
    expect(store.indexEntries()).toEqual([]);
    expect(store.hasConflicts()).toBe(false);
    expect(worktree.stat("/deleted.txt")).toBeNull();
    expect(store.readOperationState()).toBeNull();
  });
});
