import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { GitFixture } from "../../tests/helpers/git.js";
import { type GitServer, startGitServer } from "../../tests/helpers/http-backend.js";
import { createRuntime } from "./runtime.js";
import {
  type ApiRequest,
  diffSchema,
  errorSchema,
  fileSchema,
  historySchema,
  metricsSchema,
  okSchema,
  searchSchema,
  shellSchema,
  stateSchema,
  treeSchema,
} from "./shared/protocol.js";

let runtime: Miniflare;
let origin: GitServer;
let fixture: GitFixture;
let directory: string;
let historicalCommit: string;

function openRuntime() {
  return createRuntime({
    scriptPath: fileURLToPath(new URL("./dist/worker.mjs", import.meta.url)),
    persistPath: join(directory, "storage"),
    originUrl: origin.url,
    filter: "blob:none",
  });
}

function post(input: object) {
  return runtime.dispatchFetch("http://playground/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function call<T>(input: ApiRequest, schema: z.ZodType<T>): Promise<T> {
  const response = await post(input);
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return z.object({ data: schema, metrics: metricsSchema }).parse(payload).data;
}

beforeAll(async () => {
  directory = mkdtempSync("/tmp/opencode/kompjutr-playground-");
  fixture = new GitFixture(join(directory, "origin"));
  mkdirSync(fixture.dir);
  fixture
    .init()
    .write("historical.txt", "historical contents\n")
    .write("README.md", "# Original\n")
    .write("src/index.ts", "export const answer = 42;\n");
  fixture.write("binary.dat", new Uint8Array([0, 255, 1]));
  for (let index = 0; index < 105; index++) {
    fixture.write(`many/file-${String(index).padStart(3, "0")}.txt`, "pagination witness\n");
  }
  historicalCommit = fixture.commit("Initial fixture");
  fixture.remove("historical.txt");
  fixture.commit("Remove historical file");
  for (let index = 1; index < 25; index++) {
    fixture.git("commit", "--allow-empty", "-q", "-m", `Upstream commit ${index}`);
  }
  fixture.git("config", "uploadpack.allowFilter", "true");
  origin = await startGitServer(join(fixture.dir, ".git"));
  runtime = openRuntime();
});

afterAll(async () => {
  await runtime?.dispose();
  await origin?.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

it("shares editor changes, native Git, shell, checkout, and state across a cold restart", async () => {
  expect((await call({ action: "state" }, stateSchema)).ready).toBe(false);
  const cloned = await call({ action: "clone" }, stateSchema);
  expect(cloned.head).toBe(fixture.git("rev-parse", "HEAD"));
  expect(cloned.files).toBe(fixture.git("ls-files").split("\n").length);
  const upstream = fixture.git("rev-list", "--first-parent", "HEAD").split("\n");
  const history = await call({ action: "history" }, historySchema);
  expect(history.commits.map((commit) => commit.oid)).toEqual(upstream.slice(0, 20));
  expect(history.next).toBe(upstream[20]);
  if (history.next === null) throw new Error("Missing history continuation");
  const older = await call({ action: "history", ref: history.next }, historySchema);
  expect(older.commits.map((commit) => commit.oid)).toEqual(upstream.slice(20));
  expect(older.next).toBeNull();
  const original = await call({ action: "file", path: "README.md" }, fileSchema);
  expect(original.text).toBe(`${fixture.git("show", "HEAD:README.md")}\n`);
  expect(
    (await call({ action: "shell", source: "git switch -c demo" }, shellSchema)).exitCode,
  ).toBe(0);
  fixture.git("switch", "-c", "demo");

  const saved = await call(
    { action: "save", path: "README.md", text: "# Changed\n", version: original.version },
    fileSchema,
  );
  fixture.write("README.md", saved.text);
  expect((await call({ action: "state" }, stateSchema)).filesystemRevision).toBeGreaterThan(
    cloned.filesystemRevision,
  );
  const diff = await call({ action: "diff", path: "README.md", staged: false }, diffSchema);
  expect(diff.patch.trimEnd()).toBe(fixture.git("diff", "--", "README.md"));
  expect((await call({ action: "shell", source: "cat README.md" }, shellSchema)).stdout).toBe(
    saved.text,
  );
  const beforeStaging = await call({ action: "state" }, stateSchema);
  await call({ action: "stage", path: "README.md" }, okSchema);
  fixture.git("add", "README.md");
  expect((await call({ action: "state" }, stateSchema)).filesystemRevision).toBe(
    beforeStaging.filesystemRevision,
  );
  expect(
    (await call({ action: "diff", path: "README.md", staged: true }, diffSchema)).patch.trimEnd(),
  ).toBe(fixture.git("diff", "--cached", "--", "README.md"));
  await call({ action: "commit", message: "Editor commit" }, okSchema);
  expect((await call({ action: "state" }, stateSchema)).changes).toEqual([]);
  expect((await call({ action: "history" }, historySchema)).commits[0]?.message.trim()).toBe(
    "Editor commit",
  );

  await call({ action: "checkout", branch: "main" }, okSchema);
  fixture.git("switch", "main");
  expect((await call({ action: "file", path: "README.md" }, fileSchema)).text).toBe(
    `${fixture.git("show", "HEAD:README.md")}\n`,
  );
  await call({ action: "checkout", branch: "demo" }, okSchema);
  await call({ action: "shell", source: "cd src" }, shellSchema);
  await runtime.dispose();
  const originPort = Number(new URL(origin.url).port);
  await origin.close();
  origin = await startGitServer(join(fixture.dir, ".git"), { port: originPort });
  runtime = openRuntime();
  expect((await call({ action: "state" }, stateSchema)).branch).toBe("demo");
  expect((await call({ action: "state" }, stateSchema)).cwd).toBe("/repo/src");
  expect((await call({ action: "file", path: "README.md" }, fileSchema)).text).toBe(saved.text);
  await call({ action: "shell", source: "cd /repo" }, shellSchema);
  const historical = await call(
    { action: "shell", source: `git show ${historicalCommit}` },
    shellSchema,
  );
  expect(historical.exitCode).toBe(0);
  expect(historical.stdout).toBe(`${fixture.git("show", "--format=medium", historicalCommit)}\n`);
});

it("rejects a stale editor save instead of overwriting terminal changes", async () => {
  const document = await call({ action: "file", path: "README.md" }, fileSchema);
  const result = await call(
    { action: "shell", source: "printf 'terminal edit\\n' > README.md" },
    shellSchema,
  );
  expect(result.exitCode).toBe(0);
  const response = await post({
    action: "save",
    path: "README.md",
    text: "lost update",
    version: document.version,
  });
  expect(response.status).toBe(409);
  expect(errorSchema.parse(await response.json()).code).toBe("ESTALE");
  expect((await call({ action: "file", path: "README.md" }, fileSchema)).text).toBe(
    "terminal edit\n",
  );
});

it("pages directory and native content search results without losing paths", async () => {
  const first = await call({ action: "tree", path: "many" }, treeSchema);
  expect(first.entries).toHaveLength(100);
  expect(first.next).not.toBeNull();
  if (first.next === null) throw new Error("Missing directory continuation");
  const second = await call({ action: "tree", path: "many", after: first.next }, treeSchema);
  const expected = fixture.git("ls-files", "many").split("\n");
  expect([...first.entries, ...second.entries].map((entry) => entry.path)).toEqual(expected);
  expect(second.next).toBeNull();

  const search = await call({ action: "search", query: "pagination witness" }, searchSchema);
  expect(search.hits).toHaveLength(100);
  if (search.next === null) throw new Error("Missing search continuation");
  const remainder = await call(
    { action: "search", query: "pagination witness", after: search.next },
    searchSchema,
  );
  expect([...search.hits, ...remainder.hits].map((hit) => hit.path)).toEqual(expected);
  expect(remainder.next).toBeNull();
});

it("rejects malformed requests, path escapes, binary editing, and failed shell commands", async () => {
  for (const input of [
    { action: "unknown" },
    { action: "file", path: "../outside" },
    { action: "file", path: "binary.dat" },
  ]) {
    const response = await post(input);
    expect(response.status).toBe(400);
    expect(errorSchema.parse(await response.json()).error).not.toBe("");
  }
  const failed = await call({ action: "shell", source: "git nonexistent" }, shellSchema);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stderr).not.toBe("");
});
