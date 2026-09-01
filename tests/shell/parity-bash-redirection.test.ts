// Byte-exact Bash parity for ordered descriptor binding. File probes use `cat`
// in the same isolated run, so existence, truncation, and content are compared.

import { describe, expect, it } from "vitest";

import { agreeWithBash, compareWithBash, REAL_BASH } from "../helpers/shell-parity.js";

describe("the redirection parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("ordered descriptor bindings match Bash", () => {
  async function compare(
    source: string,
    tree: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree }));
  }

  it("routes stdout to the diagnostic sink", async () => {
    await compare("echo out 1>&2");
  });

  it("does not send diagnostic-routed stdout into a pipeline", async () => {
    await compare("echo out 1>&2 | cat");
  });

  it.each(["1>&2 2>/dev/null", "2>/dev/null 1>&2", "2>&1 1>&2", "1>&2 2>&1"])(
    "resolves left to right: %s",
    async (redirections) => {
      await compare(`echo out ${redirections}; rm missing ${redirections}`);
    },
  );

  it("creates an overwritten stdout target", async () => {
    await compare("echo out >created 1>&2; cat created");
  });

  it("truncates an overwritten stdout target", async () => {
    await compare("echo out >file 1>&2; cat file", { file: "stale bytes\n" });
  });

  it("writes bytes when the file binding is last", async () => {
    await compare("echo out 1>&2 >file; cat file", { file: "stale bytes\n" });
  });
});
