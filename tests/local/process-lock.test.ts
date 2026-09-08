import { type ChildProcess, spawn } from "node:child_process";

import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`lock holder exited before ready: ${code ?? signal ?? "unknown"}`)),
    );
    child.once("message", (message) => {
      if (message !== "ready") reject(new Error("lock holder sent an unexpected message"));
      else resolve();
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

function contender(root: string, state: string, recovery: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./bench/register.mjs",
      "tests/local/lock-contender.ts",
      root,
      state,
      recovery,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
}

function nextMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", resolve);
  });
}

describe("LocalWorkspace process locking", () => {
  it("rejects another process and reclaims its lock after a kill", async () => {
    const fixture = localFixture();
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        "./bench/register.mjs",
        "tests/local/lock-holder.ts",
        fixture.root,
        fixture.state,
        fixture.recovery,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    try {
      await waitForReady(child);
      expect(() => fixture.workspace()).toThrowError(expect.objectContaining({ code: "EBUSY" }));
      const exited = waitForExit(child);
      child.kill("SIGKILL");
      await exited;
      fixture.workspace().close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fixture.dispose();
    }
  });

  it("allows only one of two contenders after a killed owner", async () => {
    const fixture = localFixture();
    const owner = contender(fixture.root, fixture.state, fixture.recovery);
    const children: ChildProcess[] = [owner];
    try {
      expect(await nextMessage(owner)).toBe("ready");
      const exited = waitForExit(owner);
      owner.kill("SIGKILL");
      await exited;

      const left = contender(fixture.root, fixture.state, fixture.recovery);
      const right = contender(fixture.root, fixture.state, fixture.recovery);
      children.push(left, right);
      const messages = await Promise.all([nextMessage(left), nextMessage(right)]);
      expect(messages.toSorted()).toEqual(["busy", "ready"]);
      const winner = messages[0] === "ready" ? left : right;
      winner.send?.("close");
      await waitForExit(winner);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      fixture.dispose();
    }
  });
});
