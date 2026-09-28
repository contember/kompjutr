// Exit matches Bash exactly, including in a multi-stage pipeline, where each
// stage is its own shell and `exit` ends only that stage.

import { describe, expect, it } from "vitest";

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
    "echo first\nexit foo",
    "cat <<E\nbody\nE\nexit 1 2",
    "echo a \\\n b; exit foo",
  ])("matches operand and current-status behavior: %s", async (source) => {
    agreeWithBash(await compareWithBash(source));
  });

  it.each(["exit 0 && echo unreachable", "exit 7 || echo unreachable", "exit 4; echo unreachable"])(
    "skips every later list connector: %s",
    async (source) => {
      agreeWithBash(await compareWithBash(source));
    },
  );

  it.each([
    "exit | cat; echo after",
    "true | exit; echo after",
    "echo a | exit 3; echo after",
    "exit 5 | cat",
    "echo x | exit foo; echo after",
  ])("ends only its own stage in a pipeline: %s", async (source) => {
    agreeWithBash(await compareWithBash(source));
  });
});
