import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { forwardBenchmarkRequest } from "../../bench/server/forward.js";
import { GitRepository } from "../../examples/git-server/worker.js";
import { runGit, startHandlerServer } from "../helpers/server-oracle-http.js";
import {
  basicAuth,
  startWorkerdServer,
  WORKER_READ_TOKEN,
  WORKER_WRITE_TOKEN,
} from "../helpers/server-workerd.js";
import { SqliteTestStorage } from "../helpers/storage.js";

it("serves authenticated native Git from SQLite workerd and reopens its bare identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kompjutr-server-workerd-"));
  let server = await startWorkerdServer(directory);
  const auth = ["-c", `http.extraHeader=Authorization: ${basicAuth(WORKER_WRITE_TOKEN)}`];
  try {
    for (const endpoint of [
      "info/refs?service=git-upload-pack",
      "info/refs?service=git-receive-pack",
      "git-upload-pack",
      "git-receive-pack",
    ]) {
      const response = await fetch(`${server.url}/demo.git/${endpoint}`, {
        method: endpoint.startsWith("info") ? "GET" : "POST",
      });
      expect(response.status).toBe(401);
    }
    expect(
      (
        await fetch(`${server.url}/demo.git/git-receive-pack`, {
          method: "POST",
          headers: { authorization: basicAuth(WORKER_READ_TOKEN) },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${server.url}/invalid_name.git/info/refs?service=git-upload-pack`, {
          headers: { authorization: basicAuth(WORKER_READ_TOKEN) },
        })
      ).status,
    ).toBe(404);
    const source = join(directory, "source");
    await runGit(directory, ["init", "-b", "main", source]);
    await writeFile(join(source, "hello.txt"), "first\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["commit", "-m", "first"]);
    await runGit(source, [...auth, "push", `${server.url}/demo.git`, "main"]);
    await server.close();
    server = await startWorkerdServer(directory);
    const clone = join(directory, "clone");
    await runGit(directory, [...auth, "clone", `${server.url}/demo.git`, clone]);
    expect((await runGit(clone, ["symbolic-ref", "HEAD"])).stdout.toString().trim()).toBe(
      "refs/heads/main",
    );
    expect((await runGit(clone, ["rev-parse", "HEAD"])).stdout).toEqual(
      (await runGit(source, ["rev-parse", "HEAD"])).stdout,
    );
    await writeFile(join(source, "hello.txt"), "second\n");
    await runGit(source, ["commit", "-am", "second"]);
    await runGit(source, [...auth, "push", `${server.url}/demo.git`, "main"]);
    await runGit(clone, [...auth, "fetch", "origin"]);
    expect((await runGit(clone, ["rev-parse", "origin/main"])).stdout).toEqual(
      (await runGit(source, ["rev-parse", "HEAD"])).stdout,
    );
    await runGit(clone, ["fsck", "--full", "--strict"]);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves an earlier durable alarm across concurrent traffic and cold construction", async () => {
  const storage = new SqliteTestStorage();
  let alarm: number | null = Date.now() + 1_000;
  const original = alarm;
  const scheduled: number[] = [];
  const context = {
    storage: {
      sql: storage.sql,
      transactionSync: <T>(closure: () => T): T => storage.transactionSync(closure),
      getAlarm: async () => alarm,
      setAlarm: async (value: number) => {
        alarm = value;
        scheduled.push(value);
      },
    },
  };
  try {
    const first = new GitRepository(context);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        first.fetch(new Request("https://git.invalid/info/refs?service=git-upload-pack")),
      ),
    );
    const reopened = new GitRepository(context);
    await reopened.fetch(new Request("https://git.invalid/info/refs?service=git-upload-pack"));
    expect(reopened.repoId).toBe(first.repoId);
    expect(alarm).toBe(original);
    expect(scheduled).toEqual([]);
  } finally {
    storage.db.close();
  }
});

it("forwards native chunked pushes through the benchmark proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kompjutr-chunked-workerd-"));
  const worker = await startWorkerdServer(directory);
  let chunked = false;
  const proxy = await startHandlerServer((request) => {
    if (request.headers.get("transfer-encoding") === "chunked") chunked = true;
    return fetch(forwardBenchmarkRequest(request, worker.url));
  });
  try {
    const source = join(directory, "source");
    await runGit(directory, ["init", "-b", "main", source]);
    await writeFile(join(source, "blob"), Buffer.alloc(128 * 1024, 120));
    await runGit(source, ["add", "blob"]);
    await runGit(source, ["commit", "-m", "chunked fixture"]);
    await runGit(source, [
      "-c",
      `http.extraHeader=Authorization: ${basicAuth(WORKER_WRITE_TOKEN)}`,
      "-c",
      "http.postBuffer=1",
      "-c",
      "pack.compression=0",
      "push",
      `${new URL(proxy.url).origin}/demo.git`,
      "main",
    ]);
    expect(chunked).toBe(true);
    expect(proxy.errors).toEqual([]);
  } finally {
    await proxy.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
