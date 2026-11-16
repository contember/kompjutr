import { describe, it } from "vitest";

import type { Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: status type changes", () => {
  it("reports a tracked file replaced by a symlink as a worktree type change", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [{ op: "symlink", path: "README.md", target: "c.bin" }],
    };
    await expectAgreement(scenario);
  });

  it("reports an added file replaced by a symlink as AT", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "write", path: "😀.txt", content: { text: "x\n" } },
        { op: "add", paths: ["😀.txt"] },
        { op: "symlink", path: "😀.txt", target: "😀.txt" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("reports a staged type change against HEAD", async () => {
    const scenario: Scenario = {
      start: "clone",
      ops: [
        { op: "symlink", path: "README.md", target: "c.bin" },
        { op: "add", paths: ["README.md"] },
      ],
    };
    await expectAgreement(scenario);
  });

  it("reports a committed symlink replaced by a file, staged and back", async () => {
    // The link resolves: `remove` cannot delete a dangling one.
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "symlink", path: "link", target: "a.txt" },
        { op: "add", paths: ["a.txt", "link"] },
        { op: "commit", message: "link" },
        { op: "remove", path: "link" },
        { op: "write", path: "link", content: { text: "x\n" } },
        { op: "add", paths: ["link"] },
        { op: "remove", path: "link" },
        { op: "symlink", path: "link", target: "a.txt" },
      ],
    };
    await expectAgreement(scenario);
  });

  it("keeps an executable-bit change a modification", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.sh", content: { text: "x\n" } },
        { op: "add", paths: ["a.sh"] },
        { op: "commit", message: "a" },
        { op: "write", path: "a.sh", content: { text: "x\n" }, executable: true },
        { op: "add", paths: ["a.sh"] },
        { op: "write", path: "a.sh", content: { text: "x\n" } },
      ],
    };
    await expectAgreement(scenario);
  });
});

describe("differential regressions: clean -d", () => {
  it("removes an untracked tree of empty directories", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "dir/sub/z.txt", content: { text: "x\n" } },
        { op: "mv", from: "dir/sub/z.txt", to: "a-b" },
        { op: "clean", directories: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("removes an empty directory beside an untracked file", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "dir/sub/z.txt", content: { text: "x\n" } },
        { op: "mv", from: "dir/sub/z.txt", to: "a-b" },
        { op: "write", path: "dir/u.txt", content: { text: "u\n" } },
        { op: "clean", directories: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("keeps a directory that holds only an ignored file", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: ".gitignore", content: { text: "*.log\n" } },
        { op: "write", path: "dir/sub/x.log", content: { text: "x\n" } },
        { op: "write", path: "dir/empty/z.txt", content: { text: "x\n" } },
        { op: "mv", from: "dir/empty/z.txt", to: "a-b" },
        { op: "clean", directories: true },
      ],
    };
    await expectAgreement(scenario);
  });
});
