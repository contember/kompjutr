import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { LocalWorkspace, type RecoveryCheckpoint } from "@kompjutr/local";
import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

function crash(
  root: string,
  state: string,
  recovery: string,
  checkpoint: RecoveryCheckpoint,
  targetPath?: string,
  mutation?: "write" | "delete",
): void {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./bench/register.mjs",
      "tests/local/crash-worker.ts",
      root,
      state,
      recovery,
      checkpoint,
      ...(targetPath === undefined ? [] : [targetPath]),
      ...(mutation === undefined ? [] : [mutation]),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe("SIGKILL");
}

function crashRecovery(
  root: string,
  state: string,
  recovery: string,
  checkpoint: RecoveryCheckpoint,
): void {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./bench/register.mjs",
      "tests/local/recovery-kill-worker.ts",
      root,
      state,
      recovery,
      checkpoint,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe("SIGKILL");
}

function crashGitCheckout(
  root: string,
  state: string,
  recovery: string,
  checkpoint: RecoveryCheckpoint,
  ref: string,
): void {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./bench/register.mjs",
      "tests/local/git-crash-worker.ts",
      root,
      state,
      recovery,
      checkpoint,
      ref,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe("SIGKILL");
}

function crashTopology(
  root: string,
  state: string,
  recovery: string,
  checkpoint: RecoveryCheckpoint,
): void {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./bench/register.mjs",
      "tests/local/topology-crash-worker.ts",
      root,
      state,
      recovery,
      checkpoint,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe("SIGKILL");
}

function crashBetweenApplicationFrames(root: string, state: string, recovery: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./bench/register.mjs",
      "tests/local/application-frame-crash-worker.ts",
      root,
      state,
      recovery,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe("SIGKILL");
}

describe("local crash recovery", () => {
  it("does not let another root consume a pending recovery transaction", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    crash(fixture.root, fixture.state, fixture.recovery, "replacement-renamed");
    const otherRoot = join(fixture.base, "other-root");
    mkdirSync(otherRoot);
    expect(
      () =>
        new LocalWorkspace({
          root: otherRoot,
          stateDirectory: join(fixture.base, "other-state"),
          recoveryDirectory: fixture.recovery,
        }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    const reopened = fixture.workspace();
    try {
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      reopened.close();
      fixture.dispose();
    }
  });

  it("keeps a crashed root bound to its original state and recovery directories", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    crash(fixture.root, fixture.state, fixture.recovery, "replacement-renamed");
    expect(
      () =>
        new LocalWorkspace({
          root: fixture.root,
          stateDirectory: join(fixture.base, "other-state"),
          recoveryDirectory: join(fixture.base, "other-recovery"),
        }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    const reopened = fixture.workspace();
    try {
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      reopened.close();
      fixture.dispose();
    }
  });

  it("settles a killed replacement of a temporary parent", () => {
    const cases: readonly { checkpoint: RecoveryCheckpoint; committed: boolean }[] = [
      { checkpoint: "before-commit", committed: false },
      { checkpoint: "after-commit", committed: true },
    ];
    for (const { checkpoint, committed } of cases) {
      const fixture = localFixture();
      mkdirSync(join(fixture.root, "a"));
      mkdirSync(join(fixture.root, "target"));
      writeFileSync(join(fixture.root, "a/file"), "old");
      crashTopology(fixture.root, fixture.state, fixture.recovery, checkpoint);
      const workspace = fixture.workspace();
      try {
        expect(lstatSync(join(fixture.root, "a")).isSymbolicLink(), checkpoint).toBe(committed);
        if (committed) expect(readlinkSync(join(fixture.root, "a"))).toBe("target");
        else expect(readFileSync(join(fixture.root, "a/file"), "utf8")).toBe("old");
        expect(workspace.database.scalar("SELECT COUNT(*) FROM topology_marker"), checkpoint).toBe(
          committed ? 1 : 0,
        );
        expect(readdirSync(fixture.recovery), checkpoint).toEqual([]);
      } finally {
        workspace.close();
        fixture.dispose();
      }
    }
  });

  it("settles a killed checkout through the coupled Git mutation seam", async () => {
    const cases: readonly {
      checkpoint: RecoveryCheckpoint;
      expectedRef: string;
      expectedContent: string;
    }[] = [
      { checkpoint: "replacement-renamed", expectedRef: "main", expectedContent: "main\n" },
      { checkpoint: "after-commit", expectedRef: "feature", expectedContent: "feature\n" },
    ];
    for (const { checkpoint, expectedRef, expectedContent } of cases) {
      const fixture = localFixture();
      const workspace = fixture.workspace({
        defaultGitIdentity: { name: "Crash", email: "crash@example.test" },
        now: () => 1_577_836_800_000,
        timezoneOffset: () => 0,
      });
      await workspace.git.init();
      writeFileSync(join(fixture.root, "tracked.txt"), "main\n");
      await workspace.git.add({ paths: ["tracked.txt"] });
      await workspace.git.commit({ message: "main" });
      await workspace.git.branch({ name: "feature", checkout: true });
      writeFileSync(join(fixture.root, "tracked.txt"), "feature\n");
      await workspace.git.add({ paths: ["tracked.txt"] });
      await workspace.git.commit({ message: "feature" });
      await workspace.git.checkout({ ref: "main" });
      workspace.close();

      crashGitCheckout(fixture.root, fixture.state, fixture.recovery, checkpoint, "feature");
      const reopened = fixture.workspace();
      try {
        expect(await reopened.git.currentBranch(), checkpoint).toBe(expectedRef);
        expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8"), checkpoint).toBe(
          expectedContent,
        );
        expect(readdirSync(fixture.recovery), checkpoint).toEqual([]);
      } finally {
        reopened.close();
        fixture.dispose();
      }
    }
  });

  it("rolls back a killed pre-publication mutation on reopen", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    crash(fixture.root, fixture.state, fixture.recovery, "replacement-renamed");
    const workspace = fixture.workspace();
    try {
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(workspace.drive.stat("/created.txt")).toBeNull();
      expect(workspace.drive.stat("/created-directory")).toBeNull();
      expect(workspace.database.scalar("SELECT COUNT(*) FROM crash_marker")).toBe(0);
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("rolls forward a killed post-publication cleanup on reopen", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    crash(fixture.root, fixture.state, fixture.recovery, "after-commit");
    const workspace = fixture.workspace();
    try {
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("new");
      expect(readFileSync(join(fixture.root, "created.txt"), "utf8")).toBe("created");
      expect(readFileSync(join(fixture.root, "created-directory/entry.txt"), "utf8")).toBe(
        "nested",
      );
      expect(workspace.database.scalar("SELECT COUNT(*) FROM crash_marker")).toBe(1);
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("settles killed deletion before and after SQLite publication", () => {
    const cases: readonly {
      checkpoint: RecoveryCheckpoint;
      deleted: boolean;
    }[] = [
      { checkpoint: "backup-moved", deleted: false },
      { checkpoint: "after-commit", deleted: true },
    ];
    for (const { checkpoint, deleted } of cases) {
      const fixture = localFixture();
      writeFileSync(join(fixture.root, "removed.txt"), "old");
      crash(fixture.root, fixture.state, fixture.recovery, checkpoint, "/removed.txt", "delete");
      const workspace = fixture.workspace();
      try {
        expect(workspace.drive.stat("/removed.txt") === null, checkpoint).toBe(deleted);
        expect(workspace.database.scalar("SELECT COUNT(*) FROM crash_marker"), checkpoint).toBe(
          deleted ? 1 : 0,
        );
        expect(readdirSync(fixture.recovery), checkpoint).toEqual([]);
      } finally {
        workspace.close();
        fixture.dispose();
      }
    }
  });

  it("restarts rollback after kills during each settlement shape", () => {
    const cases: readonly {
      forward: RecoveryCheckpoint;
      recovery: RecoveryCheckpoint;
    }[] = [
      { forward: "probe-placed", recovery: "probe-cleaned" },
      { forward: "replacement-synced", recovery: "temporary-cleaned" },
      { forward: "generation-written", recovery: "created-path-removed" },
      { forward: "replacement-renamed", recovery: "backup-restored" },
      { forward: "generation-written", recovery: "journal-unlinked" },
      { forward: "generation-written", recovery: "transaction-removed" },
    ];
    for (const item of cases) {
      const fixture = localFixture();
      writeFileSync(join(fixture.root, "tracked.txt"), "old");
      crash(fixture.root, fixture.state, fixture.recovery, item.forward);
      crashRecovery(fixture.root, fixture.state, fixture.recovery, item.recovery);
      const workspace = fixture.workspace();
      try {
        expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8"), item.recovery).toBe("old");
        expect(workspace.drive.stat("/created.txt"), item.recovery).toBeNull();
        expect(workspace.drive.stat("/created-directory"), item.recovery).toBeNull();
        expect(workspace.database.scalar("SELECT COUNT(*) FROM crash_marker"), item.recovery).toBe(
          0,
        );
        expect(readdirSync(fixture.recovery), item.recovery).toEqual([]);
      } finally {
        workspace.close();
        fixture.dispose();
      }
    }
  });

  it("ignores a torn final frame but fails closed on a complete bad checksum", () => {
    const initial = localFixture();
    const initialDirectory = join(initial.recovery, "tx-01234567-89ab-cdef-0123-456789abcdef");
    mkdirSync(initialDirectory, { recursive: true });
    writeFileSync(join(initialDirectory, "journal"), new Uint8Array([0, 0, 0]));
    const initialRecovered = initial.workspace();
    initialRecovered.close();
    expect(readdirSync(initial.recovery)).toEqual([]);
    initial.dispose();

    const torn = localFixture();
    writeFileSync(join(torn.root, "tracked.txt"), "old");
    crash(torn.root, torn.state, torn.recovery, "replacement-renamed");
    const tornDirectory = join(torn.recovery, readdirSync(torn.recovery)[0] ?? "");
    const tornJournal = join(tornDirectory, "journal");
    const append = openSync(tornJournal, "a");
    writeSync(append, new Uint8Array([0, 0, 0]));
    closeSync(append);
    const recovered = torn.workspace();
    recovered.close();
    expect(readFileSync(join(torn.root, "tracked.txt"), "utf8")).toBe("old");
    torn.dispose();

    const corrupt = localFixture();
    writeFileSync(join(corrupt.root, "tracked.txt"), "old");
    crash(corrupt.root, corrupt.state, corrupt.recovery, "replacement-renamed");
    const transaction = join(corrupt.recovery, readdirSync(corrupt.recovery)[0] ?? "");
    const journal = join(transaction, "journal");
    const fd = openSync(journal, "r+");
    const end = statSync(journal).size - 1;
    const byte = new Uint8Array(1);
    byte[0] = readFileSync(journal)[end] ?? 0;
    byte[0] = (byte[0] ?? 0) ^ 0xff;
    writeSync(fd, byte, 0, 1, end);
    closeSync(fd);
    expect(() => corrupt.workspace()).toThrowError(expect.objectContaining({ code: "ECORRUPT" }));
    expect(readdirSync(corrupt.recovery)).not.toEqual([]);
    corrupt.dispose();
  });

  it("syncs every application frame before moving the first backup", () => {
    const fixture = localFixture();
    const paths = Array.from({ length: 6 }, (_, index) => `tracked-${index}-${"x".repeat(80)}`);
    for (const path of paths) writeFileSync(join(fixture.root, path), "old");
    crashBetweenApplicationFrames(fixture.root, fixture.state, fixture.recovery);
    for (const path of paths) {
      expect(readFileSync(join(fixture.root, path), "utf8")).toBe("old");
    }
    const workspace = fixture.workspace();
    try {
      for (const path of paths) {
        expect(readFileSync(join(fixture.root, path), "utf8")).toBe("old");
      }
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("settles every durability-transition kill point to the old or new generation", () => {
    const checkpoints: readonly RecoveryCheckpoint[] = [
      "journal-created",
      "probe-intent",
      "probe-placed",
      "probe-returned",
      "probe-cleaned",
      "application-frame-synced",
      "application-intent",
      "backup-destination-synced",
      "backup-moved",
      "temporary-intent",
      "parent-created",
      "replacement-synced",
      "replacement-renamed",
      "generation-written",
      "before-commit",
      "after-commit",
      "backup-cleaned",
      "journal-unlinked",
      "transaction-removed",
    ];
    const committed = new Set<RecoveryCheckpoint>([
      "after-commit",
      "backup-cleaned",
      "journal-unlinked",
      "transaction-removed",
    ]);
    for (const checkpoint of checkpoints) {
      const fixture = localFixture();
      writeFileSync(join(fixture.root, "tracked.txt"), "old");
      crash(fixture.root, fixture.state, fixture.recovery, checkpoint);
      const workspace = fixture.workspace();
      try {
        const isCommitted = committed.has(checkpoint);
        expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8"), checkpoint).toBe(
          isCommitted ? "new" : "old",
        );
        expect(workspace.drive.stat("/created.txt") !== null, checkpoint).toBe(isCommitted);
        expect(workspace.drive.stat("/created-directory/entry.txt") !== null, checkpoint).toBe(
          isCommitted,
        );
        expect(workspace.database.scalar("SELECT COUNT(*) FROM crash_marker"), checkpoint).toBe(
          isCommitted ? 1 : 0,
        );
        expect(readdirSync(fixture.recovery), checkpoint).toEqual([]);
      } finally {
        workspace.close();
        fixture.dispose();
      }
    }
  });

  it("fails closed when an ancestor becomes an escaping symlink before recovery", () => {
    const fixture = localFixture();
    const outside = join(fixture.base, "outside");
    mkdirSync(join(fixture.root, "directory"));
    mkdirSync(outside);
    writeFileSync(join(fixture.root, "directory/tracked.txt"), "old");
    writeFileSync(join(outside, "tracked.txt"), "outside");
    crash(
      fixture.root,
      fixture.state,
      fixture.recovery,
      "replacement-renamed",
      "/directory/tracked.txt",
    );
    rmSync(join(fixture.root, "directory"), { recursive: true });
    symlinkSync(outside, join(fixture.root, "directory"));
    try {
      expect(() => fixture.workspace()).toThrowError(expect.objectContaining({ code: "EACCES" }));
      expect(readFileSync(join(outside, "tracked.txt"), "utf8")).toBe("outside");
      expect(readdirSync(fixture.recovery)).not.toEqual([]);
    } finally {
      fixture.dispose();
    }
  });
});
