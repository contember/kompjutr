import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProcessLock } from "@kompjutr/local";
import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

describe("ProcessLock", () => {
  it("rejects malformed low-level lock identities before opening SQLite", () => {
    const fixture = localFixture();
    mkdirSync(fixture.state, { recursive: true });
    expect(() =>
      ProcessLock.acquire(join(fixture.state, "lock.sqlite"), {
        root: `${fixture.root}/bad\uD800root`,
        stateDirectory: fixture.state,
        recoveryDirectory: fixture.recovery,
      }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    fixture.dispose();
  });

  it("rejects a second live owner and releases for the next owner", () => {
    const fixture = localFixture();
    mkdirSync(fixture.state, { recursive: true });
    const path = join(fixture.state, "lock.sqlite");
    const identity = {
      root: fixture.root,
      stateDirectory: fixture.state,
      recoveryDirectory: fixture.recovery,
    };
    const first = ProcessLock.acquire(path, identity);
    try {
      expect(() => ProcessLock.acquire(path, identity)).toThrowError(
        expect.objectContaining({ code: "EBUSY" }),
      );
    } finally {
      first.close();
    }
    ProcessLock.acquire(path, identity).close();
    fixture.dispose();
  });

  it("rejects a symbolic-link lock database", () => {
    const fixture = localFixture();
    mkdirSync(fixture.state, { recursive: true });
    const outside = join(fixture.base, "outside.sqlite");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(fixture.state, "lock.sqlite"));
    expect(() =>
      ProcessLock.acquire(join(fixture.state, "lock.sqlite"), {
        root: fixture.root,
        stateDirectory: fixture.state,
        recoveryDirectory: fixture.recovery,
      }),
    ).toThrowError(expect.objectContaining({ code: "EACCES" }));
    fixture.dispose();
  });
});
