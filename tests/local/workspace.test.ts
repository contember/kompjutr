import { existsSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LocalWorkspace } from "@kompjutr/local";
import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

describe("LocalWorkspace", () => {
  it("locks one root across different state and recovery configurations", () => {
    const fixture = localFixture();
    const first = fixture.workspace();
    const alternate = (): LocalWorkspace =>
      new LocalWorkspace({
        root: fixture.root,
        stateDirectory: join(fixture.base, "other-state"),
        recoveryDirectory: join(fixture.base, "other-recovery"),
      });
    try {
      expect(alternate).toThrowError(expect.objectContaining({ code: "EBUSY" }));
      first.close();
      expect(alternate).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      fixture.workspace().close();
    } finally {
      first.close();
      fixture.dispose();
    }
  });

  it("verifies recovery ownership before scanning pending entries", () => {
    const fixture = localFixture();
    fixture.workspace().close();
    writeFileSync(join(fixture.recovery, "unexpected"), "must remain untouched");
    const otherRoot = join(fixture.base, "other-root");
    mkdirSync(otherRoot);
    try {
      expect(
        () =>
          new LocalWorkspace({
            root: otherRoot,
            stateDirectory: join(fixture.base, "other-state"),
            recoveryDirectory: fixture.recovery,
          }),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(existsSync(join(fixture.recovery, "unexpected"))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("retains the root lock when close is attempted inside a transaction", () => {
    const fixture = localFixture();
    const workspace = fixture.workspace();
    try {
      workspace.database.transactionSync(() => {
        expect(() => workspace.close()).toThrowError(expect.objectContaining({ code: "EBUSY" }));
        expect(() => fixture.workspace()).toThrowError(expect.objectContaining({ code: "EBUSY" }));
      });
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("persists Git state outside the worktree across close and reopen", async () => {
    const fixture = localFixture();
    let workspace = fixture.workspace({
      defaultGitIdentity: { name: "Local Test", email: "local@example.test" },
    });
    await workspace.git.init();
    writeFileSync(join(fixture.root, "file.txt"), "first\n");
    await workspace.git.add({ paths: ["file.txt"] });
    const committed = await workspace.git.commit({ message: "initial" });
    workspace.close();

    workspace = fixture.workspace();
    try {
      expect(await workspace.git.revParse({ ref: "HEAD" })).toBe(committed.oid);
      expect(await workspace.git.status()).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("rehashes same-size edits even when the host timestamp is restored", async () => {
    const fixture = localFixture();
    const workspace = fixture.workspace({
      defaultGitIdentity: { name: "Local Test", email: "local@example.test" },
    });
    try {
      await workspace.git.init();
      const path = join(fixture.root, "file.txt");
      writeFileSync(path, "first\n");
      await workspace.git.add({ paths: ["file.txt"] });
      await workspace.git.commit({ message: "initial" });
      const before = statSync(path);
      writeFileSync(path, "other\n");
      utimesSync(path, before.atime, before.mtime);
      expect(await workspace.git.status()).toEqual([
        { path: "file.txt", index: " ", worktree: "M" },
      ]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("holds the process lock for its lifetime", () => {
    const fixture = localFixture();
    const workspace = fixture.workspace();
    try {
      expect(() => fixture.workspace()).toThrowError(expect.objectContaining({ code: "EBUSY" }));
    } finally {
      workspace.close();
    }
    fixture.workspace().close();
    fixture.dispose();
  });

  it("rejects state and recovery paths inside the worktree before creating them", () => {
    const fixture = localFixture();
    const state = join(fixture.root, "state");
    const recovery = join(fixture.root, "recovery");
    try {
      expect(() => new LocalWorkspace({ root: fixture.root, stateDirectory: state })).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(existsSync(state)).toBe(false);
      expect(
        () =>
          new LocalWorkspace({
            root: fixture.root,
            stateDirectory: fixture.state,
            recoveryDirectory: recovery,
          }),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(existsSync(recovery)).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects an external state path whose existing ancestor is a symlink", () => {
    const fixture = localFixture();
    const target = join(fixture.base, "state-target");
    const alias = join(fixture.base, "state-alias");
    mkdirSync(target);
    symlinkSync(target, alias);
    const state = join(alias, "nested");
    try {
      expect(() => new LocalWorkspace({ root: fixture.root, stateDirectory: state })).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(existsSync(join(target, "nested"))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects persisted state reopened with another root or recovery directory", () => {
    const fixture = localFixture();
    fixture.workspace().close();
    const otherRoot = join(fixture.base, "other-root");
    const otherRecovery = join(fixture.base, "other-recovery");
    mkdirSync(otherRoot);
    try {
      expect(
        () =>
          new LocalWorkspace({
            root: otherRoot,
            stateDirectory: fixture.state,
            recoveryDirectory: fixture.recovery,
          }),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      expect(
        () =>
          new LocalWorkspace({
            root: fixture.root,
            stateDirectory: fixture.state,
            recoveryDirectory: otherRecovery,
          }),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    } finally {
      fixture.dispose();
    }
  });
});
