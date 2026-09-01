// Starter parity for the Bash-shaped surface already claimed by the shell.

import { describe, expect, it } from "vitest";

import { agreeWithBash, compareWithBash, REAL_BASH } from "../helpers/shell-parity.js";

const TREE = {
  "message.bin": new Uint8Array([
    0, 102, 105, 114, 115, 116, 10, 255, 115, 101, 99, 111, 110, 100, 10,
  ]),
};

describe("the shell parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("shell matches Bash", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it("echoes arguments", async () => {
    await compare("echo hello from parity");
  });

  it("cats seeded bytes", async () => {
    await compare("cat message.bin");
  });

  it("merges stderr into stdout with 2>&1", async () => {
    await compare("rm missing 2>&1");
  });

  it("drops stderr with 2>/dev/null", async () => {
    await compare("rm missing 2>/dev/null");
  });

  it("does not carry cwd or filesystem mutations into another comparison", async () => {
    await compare("mkdir changed; cd changed; echo transient > file");
    await compare("cat changed/file 2>/dev/null");
  });
});
