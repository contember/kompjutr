import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGitCommand } from "../packages/do/src/git-shell.js";
import { createShell } from "../packages/do/src/shell/index.js";
import type { GitCliRunner } from "../packages/git/src/cli/types.js";
import {
  expectHydratedExactly,
  type Harness,
  partialClone,
  repositoryState,
} from "./helpers/promisor.js";

/** Native Git's exact stdout, untrimmed. */
function nativeShow(h: Harness, spec: string): string {
  return execFileSync("git", ["show", spec], { cwd: h.fixture.dir, encoding: "utf8" });
}

function agentShell(h: Harness, runner: GitCliRunner) {
  return createShell({
    fs: h.workspace.worktree,
    cwd: "/work",
    commands: new Map([["git", createGitCommand(runner)]]),
  });
}

describe("git show <rev>:<path> in a blobless clone", () => {
  it("fetches an omitted blob and prints it as Git does", async () => {
    const h = await partialClone();
    const postsBefore = h.posts();

    const shown = await h.git.runCli({ argv: ["show", `${h.base}:old.txt`], cwd: "/work" });

    expect(shown).toEqual({
      stdout: nativeShow(h, `${h.base}:old.txt`),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    expect(h.posts() - postsBefore).toBe(1);
    expectHydratedExactly(h, ["old"]);
  });

  it("fetches an omitted blob through the agent shell", async () => {
    const h = await partialClone();
    const shell = agentShell(h, h.git);

    const result = await shell.run(`git show origin/topic:shared.txt`);

    expect(result).toMatchObject({
      stdout: nativeShow(h, "topic:shared.txt"),
      stderr: "",
      exitCode: 0,
    });
    expectHydratedExactly(h, ["topicShared"]);
  });

  it("lists a tree without fetching any blob", async () => {
    const h = await partialClone();

    const shown = await h.git.runCli({ argv: ["show", `${h.base}:`], cwd: "/work" });

    expect(shown.stdout).toBe(nativeShow(h, `${h.base}:`));
    expect(shown.exitCode).toBe(0);
    expectHydratedExactly(h, []);
  });

  it("reports a failed fetch as fatal with exit 128 and changes nothing", async () => {
    const h = await partialClone();
    const before = await repositoryState(h);
    const shell = agentShell(h, h.offline);

    const result = await shell.run(`git show ${h.base}:old.txt`);

    expect(result).toMatchObject({
      stdout: "",
      stderr: "fatal: could not fetch from promisor remote: promisor remote is unreachable\n",
      exitCode: 128,
    });
    expect(h.offlineRequests()).toBeGreaterThan(0);
    expect(await repositoryState(h)).toEqual(before);
  });

  it("refuses a blob that is not UTF-8 instead of corrupting it", async () => {
    const h = await partialClone();
    h.workspace.worktree.writeFile("/work/binary.bin", new Uint8Array([0xff, 0x00, 0xfe]));
    expect(await h.git.runCli({ argv: ["add", "binary.bin"], cwd: "/work" })).toMatchObject({
      exitCode: 0,
    });

    expect(await h.git.runCli({ argv: ["commit", "-m", "binary"], cwd: "/work" })).toMatchObject({
      exitCode: 0,
    });

    expect(await h.git.runCli({ argv: ["show", "HEAD:binary.bin"], cwd: "/work" })).toEqual({
      stdout: "",
      stderr: "fatal: HEAD:binary.bin is not UTF-8 text\n",
      truncated: false,
      exitCode: 128,
    });
  });
});
