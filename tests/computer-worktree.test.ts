import { Workspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { ComputerWorktree } from "../src/computer/worktree.js";
import { SqliteTestStorage } from "./helpers/storage.js";

describe("ComputerWorktree compatibility", () => {
  it("scans canonical paths beneath a symlinked root", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.mkdirSync("/target", { recursive: true });
    provider.writeFileSync("/target/f", "x");
    provider.symlinkSync("/target", "/alias");
    const worktree = new ComputerWorktree(provider);

    expect(worktree.scan("/alias", { limit: 1 }).map((entry) => entry.path)).toEqual(["/target/f"]);
  });

  it("stats only the candidate consumed by a limited flat scan", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    for (let index = 0; index < 100; index++) {
      provider.writeFileSync(`/f${String(index).padStart(3, "0")}`, "x");
    }

    class CountingWorktree extends ComputerWorktree {
      stats = 0;

      override stat(path: string) {
        this.stats++;
        return super.stat(path);
      }
    }

    const worktree = new CountingWorktree(provider);
    expect(worktree.scan("/", { limit: 1 }).map((entry) => entry.path)).toEqual(["/f000"]);
    expect(worktree.stats).toBeLessThanOrEqual(2);
  });

  it("does not resolve every flat symlink before honoring the limit", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.writeFileSync("/target", "x");
    for (let index = 0; index < 100; index++) {
      provider.symlinkSync("/target", `/link${String(index).padStart(3, "0")}`);
    }

    class CountingWorktree extends ComputerWorktree {
      stats = 0;

      override stat(path: string) {
        this.stats++;
        return super.stat(path);
      }
    }

    const worktree = new CountingWorktree(provider);
    expect(worktree.scan("/", { limit: 1 }).map((entry) => entry.path)).toEqual(["/link000"]);
    expect(worktree.stats).toBeLessThanOrEqual(2);
  });

  it("checks a file before consuming a following dot-dot component", () => {
    const workspace = new Workspace({ storage: new SqliteTestStorage() });
    const provider = workspace.provider();
    provider.writeFileSync("/file", "x");
    provider.mkdirSync("/target", { recursive: true });
    provider.writeFileSync("/target/f", "x");
    const worktree = new ComputerWorktree(provider);

    expect(() => worktree.scan("/file/../target", { limit: 1 })).toThrowError(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});
