import { describe, expect, it } from "vitest";

import {
  type AsyncFilesystem,
  createGit,
  type Filesystem,
  type ProcessEvent,
  type ProcessHandle,
  type ProcessHost,
  type ProcessResult,
  Workspace,
} from "../src/index.js";
import { SqliteTestStorage } from "./helpers/storage.js";

const IDENTITY = { name: "Agent", email: "agent@example.com" };

type AsyncMethodsPresent =
  Exclude<keyof Omit<Filesystem, "db" | "withReadScope">, keyof AsyncFilesystem> extends never
    ? true
    : false;
type AsyncDatabaseHidden = "db" extends keyof AsyncFilesystem ? false : true;
const asyncMethodsPresent: AsyncMethodsPresent = true;
const asyncDatabaseHidden: AsyncDatabaseHidden = true;

class FakeProcessHandle extends ReadableStream<ProcessEvent> implements ProcessHandle {
  readonly id = "process-1";
  killed: string | undefined;

  constructor() {
    super({
      start(controller) {
        controller.close();
      },
    });
  }

  async result(): Promise<ProcessResult> {
    return {
      status: "completed",
      exitCode: 0,
      stdout: new Uint8Array([111, 107]),
      stderr: new Uint8Array(0),
    };
  }

  async kill(signal?: string): Promise<void> {
    this.killed = signal;
  }

  [Symbol.dispose](): void {}
}

describe("Workspace", () => {
  it("shares one database across the native filesystem and Git client", async () => {
    const storage = new SqliteTestStorage();
    const workspace = new Workspace({
      storage,
      git: createGit(),
      now: () => 1_600_000_000_000,
      defaultGitIdentity: IDENTITY,
    });

    expect(workspace.filesystem.db).toBe(workspace.db);
    expect(workspace.git).toBe(workspace.git);
    await workspace.git.init({ dir: "/" });
    await workspace.fs.writeFile("/README.md", "# demo\n");
    await workspace.fs.mkdir("/src", { recursive: true });
    await workspace.fs.writeFile("/src/a.ts", "export const a = 1;\n");

    expect(await workspace.git.status()).toEqual([
      { path: "README.md", index: " ", worktree: "?" },
      { path: "src/", index: " ", worktree: "?" },
    ]);
    await workspace.git.add({ paths: ["."], all: true });
    const first = await workspace.git.commit({ message: "first" });
    expect(await workspace.git.status()).toEqual([]);

    await workspace.fs.writeFile("/src/a.ts", "export const a = 20;\n");
    expect(await workspace.git.diff()).toContain("-export const a = 1;");
    await workspace.git.add({ paths: ["src/a.ts"] });
    await workspace.git.commit({ message: "second" });
    expect((await workspace.git.log()).map((entry) => entry.message.trim())).toEqual([
      "second",
      "first",
    ]);

    const object = await workspace.git.catFile({ oid: first.oid });
    expect(Object.keys(object).sort()).toEqual(["bytes", "oid"]);
    expect(object.oid).toBe(first.oid);
    expect(await workspace.git.hashObject({ content: "hello" })).toMatch(/^[0-9a-f]{40}$/);
    await workspace.git.configSet({ path: "test.value", value: "one" });
    expect(await workspace.git.configGet({ path: "test.value" })).toBe("one");
    expect(workspace.db.scalar<number>("SELECT COUNT(*) FROM git_repositories")).toBe(1);
    expect(asyncMethodsPresent).toBe(true);
    expect(asyncDatabaseHidden).toBe(true);
  });

  it("fails clearly when Git or exec is not configured", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    expect(() => workspace.git).toThrow(/Workspace git is not configured/);
    expect(() => workspace.exec("echo ok")).toThrow(/Workspace exec is not configured/);
  });

  it("forwards exec to the configured process host", async () => {
    const calls: string[] = [];
    const handle = new FakeProcessHandle();
    const host: ProcessHost = {
      async exec(command, options) {
        calls.push(`${command}:${options?.cwd ?? "/"}`);
        return handle;
      },
    };
    const workspace = new Workspace({ storage: new SqliteTestStorage(), processHost: host });

    expect(await workspace.exec("echo ok", { cwd: "/repo" })).toBe(handle);
    expect(calls).toEqual(["echo ok:/repo"]);
    expect(await handle.result()).toMatchObject({ status: "completed", exitCode: 0 });
  });
});
