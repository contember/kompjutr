// A mounted view keeps the store's cost model. Every witness here runs the
// same call through the view and through the unwrapped filesystem and
// compares the statements each issued; a root above the mounts may cost one
// statement per mount it covers and nothing else.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createMountedFilesystem } from "../../packages/do/src/fs/mounted/view.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const ENCODER = new TextEncoder();
const W = "/home/user/workspace";

interface Fixture {
  readonly storage: SqliteTestStorage;
  readonly base: Filesystem;
  readonly view: Filesystem;
  /** The real directory behind `W`. */
  readonly source: string;
}

function fixture(source = "/w/a"): Fixture {
  const storage = new SqliteTestStorage();
  const base = createFilesystem(new TestDatabase(storage), { now: () => 1_700_000_000_000 });
  const entries = [];
  for (let index = 0; index < 150; index++) {
    const name = String(index).padStart(3, "0");
    entries.push({
      path: `${source}/src/f${name}.ts`,
      bytes: ENCODER.encode(`// ${name} NEEDLE\n`),
    });
    entries.push({ path: `${source}/docs/d${name}.md`, bytes: ENCODER.encode(`doc ${name}\n`) });
  }
  entries.push({ path: "/s/a/notes.txt", bytes: ENCODER.encode("NEEDLE notes\n") });
  base.writeFiles(entries);
  const view = createMountedFilesystem(base, [
    { path: "/home/user/session", source: "/s/a", mode: "rw" },
    { path: W, source, mode: "rw" },
  ]);
  return { storage, base, view, source };
}

/** Statements `work` issues. */
function cost(storage: SqliteTestStorage, work: () => unknown): number {
  const before = storage.statementCount;
  work();
  return storage.statementCount - before;
}

function batch(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}/src/f${String(index).padStart(3, "0")}.ts`,
  );
}

describe("a root inside one mount costs what the unwrapped call costs", () => {
  it("scan: first and continuation pages", () => {
    const { storage, base, view, source } = fixture();
    expect(cost(storage, () => view.scan(W, { limit: 100 }))).toBe(
      cost(storage, () => base.scan(source, { limit: 100 })),
    );
    const viewAfter = view.scan(W, { limit: 100 })[99]?.path;
    const baseAfter = base.scan(source, { limit: 100 })[99]?.path;
    expect(cost(storage, () => view.scan(W, { limit: 100, after: viewAfter }))).toBe(
      cost(storage, () => base.scan(source, { limit: 100, after: baseAfter })),
    );
  });

  it("stat, readFiles(100), writeFiles(100), removeFiles", () => {
    const { storage, base, view, source } = fixture();
    expect(cost(storage, () => view.stat(`${W}/src/f001.ts`))).toBe(
      cost(storage, () => base.stat(`${source}/src/f001.ts`)),
    );
    const viewRead = cost(storage, () => view.readFiles(batch(W, 100)));
    expect(viewRead).toBe(cost(storage, () => base.readFiles(batch(source, 100))));

    const writes = (prefix: string) =>
      batch(prefix, 100).map((path) => ({
        path: path.replace("/src/", "/out/"),
        bytes: ENCODER.encode("x"),
      }));
    expect(cost(storage, () => view.writeFiles(writes(W)))).toBe(
      cost(storage, () => base.writeFiles(writes(`${source}-copy`))),
    );
    expect(cost(storage, () => view.removeFiles([`${W}/out`], { recursive: true }))).toBe(
      cost(storage, () => base.removeFiles([`${source}-copy/out`], { recursive: true })),
    );
  });

  it("discoverFilesContaining and a glob page", () => {
    const { storage, base, view, source } = fixture();
    const viewRoot = view.realpath(W);
    const baseRoot = base.realpath(source);
    const needle = ENCODER.encode("NEEDLE");
    expect(cost(storage, () => view.discoverFilesContaining(viewRoot, "*.ts", needle))).toBe(1);
    expect(cost(storage, () => base.discoverFilesContaining(baseRoot, "*.ts", needle))).toBe(1);
    expect(view.discoverFilesContaining(viewRoot, "*.ts", needle).matched).toHaveLength(150);
    expect(cost(storage, () => view.globPage(`${W}/src`, `${W}/src/*.ts`))).toBe(
      cost(storage, () => base.globPage(`${source}/src`, `${source}/src/*.ts`)),
    );
  });
});

describe("a root above the mounts", () => {
  it("costs at most one statement more per covered mount", () => {
    const { storage, base, view } = fixture();
    const scanned = cost(storage, () => view.scan("/", { limit: 1_000 }));
    expect(scanned).toBeLessThanOrEqual(cost(storage, () => base.scan("/", { limit: 1_000 })) + 2);
    const needle = ENCODER.encode("NEEDLE");
    const root = view.realpath("/");
    expect(cost(storage, () => view.discoverFilesContaining(root, "*", needle))).toBe(2);
    expect(view.discoverFilesContaining(root, "*", needle).matched).toHaveLength(151);
    expect(cost(storage, () => view.globPage("/", "*.md"))).toBe(2);
  });
});

describe("a long real prefix", () => {
  const source = "/data/worktrees/0f8fad5b-d9cb-469f-a165-70867728950e";

  it("keeps a shell glob pushed down in one statement", async () => {
    const { storage, view } = fixture(source);
    expect(ENCODER.encode(`${source}/src/*.ts`).length).toBeGreaterThan(50);
    const root = view.realpath(`${W}/src`);
    let page = view.globPage(`${W}/src`, `${W}/src/*.ts`);
    expect(
      cost(storage, () => {
        page = view.globPage(`${W}/src`, `${W}/src/*.ts`);
      }),
    ).toBe(2);
    expect(root).toBe(`${W}/src`);
    expect(page.paths).toHaveLength(150);
    expect(page.next).toBeNull();
    // `docs/` sorts first under the mount; a page of ten matches proves the
    // GLOB, not a JS filter, dropped its 150 rows.
    const pushed = view.globPage(W, `${W}/src/*.ts`, { limit: 10 });
    expect(pushed.paths).toEqual(batch(W, 10));

    const shell = createShell({ fs: view, cwd: W });
    const before = storage.statementCount;
    const run = await shell.run("echo src/f00*.ts");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(
      `${Array.from({ length: 10 }, (_, index) => `src/f00${index}.ts`).join(" ")}\n`,
    );
    // One filesystem call: the glob root's resolution and one pushed-down GLOB
    // page, plus the session's cwd row.
    expect(run.operations).toBe(1);
    expect(storage.statementCount - before).toBe(3);
  });
});
