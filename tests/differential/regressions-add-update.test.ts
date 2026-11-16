// `add -u` and `commit -a` stage every path in the index, including one that
// is staged but not yet in HEAD, and never one the index lacks.

import { describe, it } from "vitest";
import type { Scenario } from "../helpers/differential/ops.js";
import { expectAgreement } from "../helpers/differential/run.js";

describe("differential regressions: add -u", () => {
  it("stages a modification of a path staged but not in HEAD", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        {
          op: "write",
          path: "spaced name.txt",
          content: {
            hex: "0091cccd061d98fc28742ba574b4f89a1e924833255442e8933b5772e4866642893f034aa78bf7",
          },
        },
        { op: "add", paths: ["."] },
        { op: "write", path: "spaced name.txt", content: { text: "x\n" } },
        { op: "addAll", update: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("removes a staged path not in HEAD once it is deleted from disk", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "commit", message: "one" },
        { op: "write", path: "new.txt", content: { text: "new\n" } },
        { op: "add", paths: ["new.txt"] },
        { op: "remove", path: "new.txt" },
        { op: "addAll", update: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("commits staged-new paths through commit -a", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "commit", message: "one" },
        { op: "write", path: "new.txt", content: { text: "new\n" } },
        { op: "write", path: "gone.txt", content: { text: "gone\n" } },
        { op: "add", paths: ["new.txt", "gone.txt"] },
        { op: "write", path: "new.txt", content: { text: "changed\n" } },
        { op: "remove", path: "gone.txt" },
        { op: "commit", message: "two", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("refuses commit -a on an unborn branch once the only staged path is deleted", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "spaced name.txt", content: { text: "x\n" } },
        { op: "addAll" },
        { op: "remove", path: "spaced name.txt" },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("commits a modification of a staged-new path on an unborn branch", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "c.bin", content: { text: "x\n" } },
        { op: "addAll" },
        {
          op: "write",
          path: "c.bin",
          content: { text: "beta\nepsilon\ndelta\nalpha\ndelta 23\n" },
        },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("commits a modification of a staged-new path after a move", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "😀.txt", content: { text: "x\n" } },
        { op: "mv", from: "😀.txt", to: "x/y" },
        { op: "addAll" },
        { op: "write", path: "x/y", content: { text: "epsilon 20\n" } },
        { op: "commit", message: "m", all: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("leaves an untracked file untracked", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "new.txt", content: { text: "new\n" } },
        { op: "add", paths: ["new.txt"] },
        { op: "write", path: "new.txt", content: { text: "changed\n" } },
        { op: "write", path: "untracked.txt", content: { text: "u\n" } },
        { op: "addAll", update: true },
      ],
    };
    await expectAgreement(scenario);
  });

  it("leaves a path removed from the index untracked even though HEAD has it", async () => {
    const scenario: Scenario = {
      start: "init",
      ops: [
        { op: "write", path: "a.txt", content: { text: "a\n" } },
        { op: "add", paths: ["a.txt"] },
        { op: "commit", message: "one" },
        { op: "rm", paths: ["a.txt"], cached: true },
        { op: "addAll", update: true },
      ],
    };
    await expectAgreement(scenario);
  });
});
