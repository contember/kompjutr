// ADR-0030: a walk may project trees while another walk's cursor is open.
// Status and a three-way merge run over unprojected trees with a fault in a
// closure, on the Node adapter and inside a real workerd Durable Object.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../packages/do/src/db/db.js";
import { NodeSqliteDatabase } from "../packages/local/src/sqlite/database.js";
import { GitFixture } from "./helpers/git.js";
import {
  ClosureFaultDatabase,
  type InterleavingInput,
  type InterleavingResult,
  runInterleaving,
} from "./helpers/projection-interleaving.js";
import { SqliteTestStorage } from "./helpers/storage.js";

let fixture: GitFixture;
let input: InterleavingInput;
let expected: { porcelain: string; mergeTree: string };

beforeAll(() => {
  fixture = new GitFixture().init();
  fixture.write("README.md", "readme\n");
  fixture.write("src/lib/a.txt", "a0\n");
  fixture.write("src/app/b.txt", "b0\n");
  fixture.write("docs/c.txt", "c0\n");
  fixture.commit("base");
  fixture.git("checkout", "-q", "-b", "topic");
  fixture.write("src/lib/a.txt", "a-topic\n");
  fixture.write("src/lib/new/n.txt", "new\n");
  fixture.commit("topic");
  fixture.git("checkout", "-q", "main");
  fixture.write("src/app/b.txt", "b-main\n");
  fixture.commit("main");
  const refs = fixture
    .git("show-ref")
    .split("\n")
    .map((line) => {
      const [target, name] = line.split(" ");
      if (target === undefined || name === undefined) throw new Error("invalid show-ref line");
      return { name, target };
    });
  const dirty = { path: "docs/c.txt", text: "dirty\n" };
  input = { pack: fixture.packAll(), refs, theirs: "topic", dirty };

  fixture.write(dirty.path, dirty.text);
  const porcelain = fixture.gitBinary("status", "--porcelain", "--untracked-files=no");
  fixture.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=f@example.com",
    "merge",
    "-q",
    "--no-edit",
    "topic",
  );
  expected = {
    porcelain: porcelain.toString("utf8"),
    mergeTree: fixture.git("rev-parse", "HEAD^{tree}"),
  };
});

afterAll(() => fixture.dispose());

function expectScenario(result: InterleavingResult): void {
  // The fault surfaces as itself; the open cursor of the first stream is never reused.
  expect(result.statusFault).toBe("injected closure fault 1");
  expect(result.statusFaultRows).toBe(0);
  expect(result.porcelain).toBe(expected.porcelain);
  expect(result.mergeFault).toBe("injected closure fault 2");
  expect(result.rowsAfterMergeFault).toBe(result.rowsBeforeMergeFault);
  expect(result.mergeTree).toBe(expected.mergeTree);
  expect(result.unclosedSubtrees).toBe(0);
}

async function runOnMiniflare(): Promise<unknown> {
  const bundled = await build({
    entryPoints: [join(import.meta.dirname, "helpers/projection-interleaving-worker.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers", "node:*"],
  });
  const script = bundled.outputFiles[0]?.text;
  if (script === undefined) throw new Error("esbuild produced no worker");
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-15",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { PROBE: { className: "InterleavingProbe", useSQLite: true } },
      script,
    }),
  );
  try {
    const response = await miniflare.dispatchFetch("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ ...input, pack: Buffer.from(input.pack).toString("base64") }),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`worker failed: ${text}`);
    const result: unknown = JSON.parse(text);
    return result;
  } finally {
    await miniflare.dispose();
  }
}

async function runOnStorageDouble(): Promise<InterleavingResult> {
  const storage = new SqliteTestStorage();
  try {
    return await runInterleaving(new ClosureFaultDatabase(new Database(storage)), input);
  } finally {
    storage.db.close();
  }
}

/** The worker's JSON, checked field by field. */
function parseResult(value: unknown): InterleavingResult {
  if (typeof value !== "object" || value === null)
    throw new Error("worker result is not an object");
  const text = (key: string): string => {
    const field = Reflect.get(value, key);
    if (typeof field !== "string") throw new Error(`worker result ${key} is not text`);
    return field;
  };
  const count = (key: string): number => {
    const field = Reflect.get(value, key);
    if (typeof field !== "number") throw new Error(`worker result ${key} is not a number`);
    return field;
  };
  return {
    statusFault: text("statusFault"),
    statusFaultRows: count("statusFaultRows"),
    porcelain: text("porcelain"),
    mergeFault: text("mergeFault"),
    rowsBeforeMergeFault: count("rowsBeforeMergeFault"),
    rowsAfterMergeFault: count("rowsAfterMergeFault"),
    mergeTree: text("mergeTree"),
    unclosedSubtrees: count("unclosedSubtrees"),
  };
}

describe("on-demand projection under interleaved walks", () => {
  it("fails closed and matches git on the Durable Object storage double", async () => {
    expectScenario(await runOnStorageDouble());
  });

  it("fails closed without a stale cursor on the local node:sqlite adapter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-interleaving-"));
    const local = new NodeSqliteDatabase(join(directory, "state.sqlite"));
    try {
      const result = await runInterleaving(new ClosureFaultDatabase(local), input);
      expectScenario(result);
      expect(result).toEqual(await runOnStorageDouble());
    } finally {
      local.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("behaves identically inside a workerd Durable Object", async () => {
    const workerd = parseResult(await runOnMiniflare());
    expectScenario(workerd);
    expect(workerd).toEqual(await runOnStorageDouble());
  }, 60_000);
});
