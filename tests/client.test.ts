// The acceptance test for the whole experiment: a real Computer Workspace
// configured with `createSqliteGitClient()`, driven only through
// `workspace.git`, with no Computer fork anywhere.

import { Workspace } from "@cloudflare/computer";
import { afterAll, describe, expect, it } from "vitest";

import { createSqliteGitClient } from "../src/compat/computer.js";
import { GitFixture } from "./helpers/git.js";
import { startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };

function makeWorkspace(): { workspace: Workspace; storage: SqliteTestStorage } {
  const storage = new SqliteTestStorage();
  const workspace = new Workspace({
    storage,
    git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
    defaultGitIdentity: IDENTITY,
  });
  return { workspace, storage };
}

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

describe("createSqliteGitClient", () => {
  it("drives a full local cycle through workspace.git", async () => {
    const { workspace, storage } = makeWorkspace();
    const git = workspace.git;

    await git.init({ dir: "/" });
    expect(await git.currentBranch()).toBe("main");

    await workspace.fs.writeFile("/README.md", "# demo\n");
    await workspace.fs.mkdir("/src", { recursive: true });
    await workspace.fs.writeFile("/src/a.ts", "export const a = 1;\n");

    // Exactly the interface's shape, with nothing extra riding along.
    expect(await git.status()).toEqual([
      { path: "README.md", index: " ", worktree: "?" },
      { path: "src/", index: " ", worktree: "?" },
    ]);

    await git.add({ paths: ["."], all: true });
    const { oid } = await git.commit({ message: "first" });
    expect(await git.revParse({ ref: "HEAD" })).toBe(oid);
    expect(await git.status()).toEqual([]);

    await workspace.fs.writeFile("/src/a.ts", "export const a = 2;\n");
    expect(await git.status()).toEqual([{ path: "src/a.ts", index: " ", worktree: "M" }]);
    expect(await git.diff()).toContain("-export const a = 1;");
    expect(await git.diffSummary()).toEqual([
      { path: "src/a.ts", status: "M", insertions: 1, deletions: 1 },
    ]);

    await git.add({ paths: ["src/a.ts"] });
    const second = await git.commit({ message: "second" });
    expect((await git.log()).map((entry) => entry.message.trim())).toEqual(["second", "first"]);
    expect((await git.show({ ref: "HEAD" })).oid).toBe(second.oid);
    expect(await git.lsFiles()).toEqual(["README.md", "src/a.ts"]);

    await git.branch({ name: "topic" });
    expect(await git.branchList()).toEqual(["main", "topic"]);
    await git.checkout({ ref: "topic" });
    expect(await git.currentBranch()).toBe("topic");

    // Nothing about this repository lives on disk.
    const paths = await workspace.fs.ls("/");
    expect(paths.some((path) => path.includes(".git"))).toBe(false);
    const tables = storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name);
    expect(tables).toContain("git_repositories");
    expect(tables).toContain("git_index");
  });

  it("uses the workspace's default identity when nothing else supplies one", async () => {
    const { workspace } = makeWorkspace();
    await workspace.git.init({});
    await workspace.fs.writeFile("/a.txt", "a\n");
    await workspace.git.add({ paths: ["a.txt"] });
    const { oid } = await workspace.git.commit({ message: "identity" });
    const view = await workspace.git.show({ ref: oid });
    expect(view.author).toMatchObject(IDENTITY);
  });

  it("clones a remote and reports structured progress", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "# remote\n");
    fixture.write("lib/index.ts", "export const x = 1;\n");
    fixture.commit("remote work");

    const server = await startGitServer(fixture.dir);
    try {
      const { workspace } = makeWorkspace();
      const phases: string[] = [];
      const messages: string[] = [];
      await workspace.git.clone({
        url: server.url,
        dir: "/",
        onProgress: (event) => phases.push(event.phase),
        onMessage: (message) => messages.push(message),
      });

      expect(await workspace.fs.readFile("/README.md", "utf8")).toBe("# remote\n");
      expect(await workspace.git.revParse({ ref: "HEAD" })).toBe(fixture.git("rev-parse", "HEAD"));
      expect(await workspace.git.lsFiles()).toEqual(["README.md", "lib/index.ts"]);
      // The remote said something, and it parsed into a phase rather than
      // arriving only as free text.
      expect(messages.length).toBeGreaterThan(0);
      expect(phases.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("pushes a committed change through Smart HTTP", async () => {
    const fixture = new GitFixture().init();
    fixtures.push(fixture);
    fixture.write("README.md", "before\n");
    fixture.commit("initial");
    fixture.git("config", "receive.denyCurrentBranch", "updateInstead");

    const server = await startGitServer(fixture.dir);
    try {
      const { workspace } = makeWorkspace();
      await workspace.git.clone({ url: server.url, dir: "/" });
      await workspace.fs.writeFile("/README.md", "after\n");
      await workspace.git.add({ paths: ["README.md"] });
      const local = await workspace.git.commit({ message: "local change" });

      const result = await workspace.git.push({});
      expect(result).toEqual({
        ok: true,
        error: null,
        refs: { "refs/heads/main": { ok: true } },
      });
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(local.oid);
      expect(fixture.git("show", "HEAD:README.md")).toBe("after");
    } finally {
      await server.close();
    }
  });

  it("satisfies the interface for what it does not implement yet", async () => {
    const { workspace } = makeWorkspace();
    await workspace.git.init({});
    for (const call of [
      () => workspace.git.pull({}),
      () => workspace.git.merge({ theirs: "main" }),
      () => workspace.git.stashPush({}),
      () => workspace.git.cli({ argv: ["status"] }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "EUNSUPPORTED" });
    }
  });
});
