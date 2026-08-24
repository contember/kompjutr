import { Workspace } from "@cloudflare/computer";
import { afterAll, describe, expect, it } from "vitest";

import { createSqliteGitClient } from "../src/compat/computer.js";
import { GitFixture } from "./helpers/git.js";
import { type GitServerOptions, startGitServer } from "./helpers/http-backend.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };
const fixtures: GitFixture[] = [];

afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

function remoteFixture(): GitFixture {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write("README.md", "initial\n");
  fixture.commit("initial");
  fixture.git("config", "receive.denyCurrentBranch", "updateInstead");
  return fixture;
}

function workspace(): Workspace {
  return new Workspace({
    storage: new SqliteTestStorage(),
    git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
    defaultGitIdentity: IDENTITY,
  });
}

async function localCommit(ws: Workspace, content: string, message: string): Promise<string> {
  await ws.fs.writeFile("/README.md", content);
  await ws.git.add({ paths: ["README.md"] });
  return (await ws.git.commit({ message })).oid;
}

describe("push", () => {
  it("updates a branch, records its tracking ref and makes the retry a no-op", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(`${fixture.dir}/.git`);
    try {
      const ws = workspace();
      await ws.git.clone({ url: server.url, dir: "/" });
      const oid = await localCommit(ws, "updated\n", "update");

      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "main")).toBe(oid);
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(oid);

      const posts = server.requests.filter((request) => request.method === "POST").length;
      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(posts);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-fast-forward before POST and force updates with a fresh lease", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const ws = workspace();
      await ws.git.clone({ url: server.url, dir: "/" });
      const local = await localCommit(ws, "local\n", "local");

      fixture.write("README.md", "remote\n");
      fixture.commit("remote");
      const postsBefore = server.requests.filter((request) => request.method === "POST").length;
      await expect(ws.git.push({})).rejects.toMatchObject({ code: "ENONFASTFORWARD" });
      expect(server.requests.filter((request) => request.method === "POST")).toHaveLength(
        postsBefore,
      );

      await expect(ws.git.push({ force: true })).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "main")).toBe(local);
    } finally {
      await server.close();
    }
  });

  it("creates and deletes a remote branch", async () => {
    const fixture = remoteFixture();
    const server = await startGitServer(fixture.dir);
    try {
      const ws = workspace();
      await ws.git.clone({ url: server.url, dir: "/" });
      await ws.fs.mkdir("/src", { recursive: true });
      await ws.fs.writeFile("/src/topic.ts", "export const topic = true;\n");
      await ws.git.add({ paths: ["src/topic.ts"] });
      const oid = (await ws.git.commit({ message: "topic" })).oid;

      await expect(ws.git.push({ remoteRef: "topic" })).resolves.toMatchObject({ ok: true });
      expect(fixture.git("rev-parse", "refs/heads/topic")).toBe(oid);
      expect(fixture.git("show", "refs/heads/topic:src/topic.ts")).toBe(
        "export const topic = true;",
      );
      await expect(ws.git.push({ remoteRef: "topic", delete: true })).resolves.toMatchObject({
        ok: true,
      });
      expect(fixture.git("branch", "--list", "topic")).toBe("");
    } finally {
      await server.close();
    }
  });

  it("keeps tracking state unchanged when the success response is lost", async () => {
    const fixture = remoteFixture();
    const old = fixture.git("rev-parse", "main");
    const serverOptions: GitServerOptions = {};
    const server = await startGitServer(fixture.dir, serverOptions);
    try {
      const ws = workspace();
      await ws.git.clone({ url: server.url, dir: "/" });
      const local = await localCommit(ws, "uncertain\n", "uncertain");
      serverOptions.truncatePostAfter = 1;

      await expect(ws.git.push({})).rejects.toMatchObject({ code: "EPUSHUNCERTAIN" });
      expect(fixture.git("rev-parse", "main")).toBe(local);
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(old);

      await expect(ws.git.push({})).resolves.toMatchObject({ ok: true });
      expect(await ws.git.revParse({ ref: "refs/remotes/origin/main" })).toBe(local);
    } finally {
      await server.close();
    }
  });
});
