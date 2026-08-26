// The persistent working directory, and the one thing that makes it worth a
// row rather than a field: it has to survive a Durable Object eviction.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import { createShell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

function workspace(): Filesystem {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  fs.writeFiles([
    { path: "/repo/src/alpha.ts", bytes: ENCODER.encode("alpha\n") },
    { path: "/repo/README.md", bytes: ENCODER.encode("readme\n") },
  ]);
  return fs;
}

describe("cwd persists", () => {
  it("carries across calls, so the cd prefix is not needed", () => {
    const shell = createShell({ fs: workspace(), cwd: "/repo" });
    expect(shell.run("cd src").exitCode).toBe(0);
    expect(shell.cwd()).toBe("/repo/src");
    // The point of the whole thing: the next call is already there.
    expect(shell.run("ls").stdout).toBe("alpha.ts\n");
    expect(shell.run("pwd").stdout).toBe("/repo/src\n");
  });

  it("survives an eviction", () => {
    const fs = workspace();
    const first = createShell({ fs, sessionId: "agent-1", cwd: "/repo" });
    first.run("cd src");

    // Everything in memory is gone; only the database is left.
    const revived = createShell({ fs, sessionId: "agent-1", cwd: "/repo" });
    expect(revived.cwd()).toBe("/repo/src");
    expect(revived.run("cat alpha.ts").stdout).toBe("alpha\n");
  });

  it("keeps sessions apart", () => {
    const fs = workspace();
    const one = createShell({ fs, sessionId: "agent-1", cwd: "/repo" });
    const two = createShell({ fs, sessionId: "agent-2", cwd: "/repo" });
    one.run("cd src");
    expect(one.cwd()).toBe("/repo/src");
    expect(two.cwd()).toBe("/repo");
  });

  it("refuses to persist a directory that is not there", () => {
    const shell = createShell({ fs: workspace(), cwd: "/repo" });
    expect(shell.run("cd nowhere").exitCode).toBe(1);
    expect(shell.cwd()).toBe("/repo");
    // A file is not a directory.
    expect(shell.run("cd README.md").exitCode).toBe(1);
    expect(shell.cwd()).toBe("/repo");
  });

  it("normalises the path it stores", () => {
    const shell = createShell({ fs: workspace(), cwd: "/repo" });
    shell.run("cd ./src/../src");
    expect(shell.cwd()).toBe("/repo/src");
    shell.run("cd ..");
    expect(shell.cwd()).toBe("/repo");
  });

  it("leaves cwd alone when a && chain fails before the cd", () => {
    const shell = createShell({ fs: workspace(), cwd: "/repo" });
    expect(shell.run("cat nowhere && cd src").exitCode).toBe(1);
    expect(shell.cwd()).toBe("/repo");
  });

  it("changes cwd only when a mixed list selects cd", () => {
    const shell = createShell({ fs: workspace(), cwd: "/repo" });
    expect(shell.run("true || cd src; pwd").stdout).toBe("/repo\n");
    expect(shell.cwd()).toBe("/repo");

    expect(shell.run("false && cd src || cd src; pwd").stdout).toBe("/repo/src\n");
    expect(shell.cwd()).toBe("/repo/src");
  });

  it("still honours an explicit cd prefix", () => {
    // Agents will keep writing it out of habit; it has to keep working.
    const shell = createShell({ fs: workspace(), cwd: "/" });
    expect(shell.run("cd /repo/src && ls").stdout).toBe("alpha.ts\n");
    expect(shell.cwd()).toBe("/repo/src");
  });
});
