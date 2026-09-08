// Exit matches Bash exactly except in multi-stage pipelines. Bash forks there;
// this shell has no subshells and reports an explicit local usage error instead.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { agreeWithBash, compareWithBash, REAL_BASH } from "../helpers/shell-parity.js";

describe("the exit parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("exit matches Bash", () => {
  it.each([
    "exit",
    "exit 300",
    "exit -1",
    "exit foo",
    "exit 1 2; echo reachable",
    "false; exit; echo unreachable",
  ])("matches operand and current-status behavior: %s", async (source) => {
    agreeWithBash(await compareWithBash(source));
  });

  it.each(["exit 0 && echo unreachable", "exit 7 || echo unreachable", "exit 4; echo unreachable"])(
    "skips every later list connector: %s",
    async (source) => {
      agreeWithBash(await compareWithBash(source));
    },
  );
});

describe("exit rejects multi-stage pipelines locally", () => {
  let shell: Shell;

  beforeEach(() => {
    const fs = createFilesystem(new TestDatabase());
    fs.mkdir("/repo");
    shell = createShell({ fs, cwd: "/repo" });
  });

  it.each(["exit | cat", "true | exit"])("reports a usage error: %s", async (source) => {
    expect(await shell.run(source)).toMatchObject({
      stdout: "",
      stderr: "exit: only supported as a single-stage pipeline\n",
      exitCode: 2,
    });
  });
});
