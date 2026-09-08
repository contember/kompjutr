import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  DiskDrive,
  NodeSqliteDatabase,
  ObservationClock,
  PathMapper,
  RecoveryCoordinator,
} from "@kompjutr/local";
import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

const encoder = new TextEncoder();

describe("local recovery transactions", () => {
  it("makes a caught journal action limit failure abort the outer transaction", () => {
    const fixture = localFixture();
    mkdirSync(fixture.state);
    mkdirSync(fixture.recovery);
    const recovery = new RecoveryCoordinator(new PathMapper(fixture.root), fixture.recovery, {
      journalActionLimit: 2,
    });
    const database = new NodeSqliteDatabase(join(fixture.state, "state.sqlite"), {
      mutationScope: recovery,
      recovery,
      root: fixture.root,
      recoveryDirectory: fixture.recovery,
    });
    const drive = new DiskDrive({
      root: fixture.root,
      spillDirectory: join(fixture.state, "spills"),
      mutationScope: recovery,
      observations: new ObservationClock(database),
      recovery,
    });
    writeFileSync(join(fixture.root, "one"), "old one");
    writeFileSync(join(fixture.root, "two"), "old two");
    try {
      database.run("CREATE TABLE marker (value TEXT NOT NULL)");
      expect(() =>
        database.transactionSync(() => {
          try {
            drive.writeFiles([
              { path: "/one", bytes: encoder.encode("new one") },
              { path: "/two", bytes: encoder.encode("new two") },
            ]);
          } catch {}
          database.run("INSERT INTO marker VALUES ('must roll back')");
        }),
      ).toThrowError(expect.objectContaining({ code: "ERECOVERY" }));
      expect(readFileSync(join(fixture.root, "one"), "utf8")).toBe("old one");
      expect(readFileSync(join(fixture.root, "two"), "utf8")).toBe("old two");
      expect(database.scalar("SELECT COUNT(*) FROM marker")).toBe(0);
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      drive.close();
      database.close();
      fixture.dispose();
    }
  });

  it("forces rollback when a caught drive failure follows a durable effect", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    let injected = false;
    const workspace = fixture.workspace({
      recoveryCheckpoint(checkpoint) {
        if (!injected && checkpoint === "backup-destination-synced") {
          injected = true;
          throw new Error("injected drive failure");
        }
      },
    });
    try {
      workspace.database.run("CREATE TABLE marker (value TEXT NOT NULL)");
      expect(() =>
        workspace.database.transactionSync(() => {
          try {
            workspace.drive.writeFile("/tracked.txt", encoder.encode("new"));
          } catch {}
          workspace.database.run("INSERT INTO marker VALUES ('must roll back')");
        }),
      ).toThrowError(expect.objectContaining({ code: "ERECOVERY" }));
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(workspace.database.scalar("SELECT COUNT(*) FROM marker")).toBe(0);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("rolls back late disk and database failures together", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    const workspace = fixture.workspace();
    try {
      workspace.database.run("CREATE TABLE marker (value TEXT NOT NULL)");
      expect(() =>
        workspace.database.transactionSync(() => {
          workspace.drive.writeFile("/tracked.txt", encoder.encode("new"));
          workspace.drive.writeFile("/created.txt", encoder.encode("created"));
          workspace.database.run("INSERT INTO marker VALUES ('new')");
          throw new Error("fail after every write class");
        }),
      ).toThrow("fail after every write class");
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(workspace.drive.stat("/created.txt")).toBeNull();
      expect(workspace.database.scalar("SELECT COUNT(*) FROM marker")).toBe(0);
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("settles reported commit errors from the reopened generation", () => {
    const outcomes: readonly {
      checkpoint: "before-commit" | "after-commit";
      expected: string;
      rows: number;
    }[] = [
      { checkpoint: "before-commit", expected: "old", rows: 0 },
      { checkpoint: "after-commit", expected: "new", rows: 1 },
    ];
    for (const outcome of outcomes) {
      const fixture = localFixture();
      writeFileSync(join(fixture.root, "tracked.txt"), "old");
      let fired = false;
      let armed = false;
      const workspace = fixture.workspace({
        recoveryCheckpoint(checkpoint) {
          if (armed && !fired && checkpoint === outcome.checkpoint) {
            fired = true;
            throw new Error(`reported ${checkpoint}`);
          }
        },
      });
      armed = true;
      try {
        workspace.database.run("CREATE TABLE marker (value TEXT NOT NULL)");
        expect(() =>
          workspace.database.transactionSync(() => {
            workspace.drive.writeFile("/tracked.txt", encoder.encode("new"));
            workspace.database.run("INSERT INTO marker VALUES ('new')");
          }),
        ).toThrow(`reported ${outcome.checkpoint}`);
        expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe(outcome.expected);
        expect(workspace.database.scalar("SELECT COUNT(*) FROM marker")).toBe(outcome.rows);
        expect(readdirSync(fixture.recovery)).toEqual([]);
      } finally {
        workspace.close();
        fixture.dispose();
      }
    }
  });

  it("preserves the journal and poisons both owners when classification fails", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    let classifying = false;
    const workspace = fixture.workspace({
      recoveryCheckpoint(checkpoint) {
        if (checkpoint === "before-commit") {
          classifying = true;
          throw new Error("reported commit failure");
        }
        if (classifying && checkpoint === "backup-restored") {
          throw new Error("classification failed");
        }
      },
    });
    workspace.database.run("CREATE TABLE marker (value TEXT NOT NULL)");
    expect(() =>
      workspace.database.transactionSync(() => {
        workspace.drive.writeFile("/tracked.txt", encoder.encode("new"));
        workspace.database.run("INSERT INTO marker VALUES ('new')");
      }),
    ).toThrow("classification failed");
    expect(() => workspace.database.run("SELECT 1")).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    expect(() => workspace.drive.writeFile("/tracked.txt", encoder.encode("other"))).toThrowError(
      expect.objectContaining({ code: "ERECOVERY" }),
    );
    expect(readdirSync(fixture.recovery)).toHaveLength(1);
    workspace.close();

    const reopened = fixture.workspace();
    try {
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(reopened.database.scalar("SELECT COUNT(*) FROM marker")).toBe(0);
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      reopened.close();
      fixture.dispose();
    }
  });

  it("rolls back every disk mutation shape in reverse order", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "removed/nested"), { recursive: true });
    writeFileSync(join(fixture.root, "removed/nested/file.txt"), "kept");
    writeFileSync(join(fixture.root, "patched.txt"), "abcdef");
    chmodSync(join(fixture.root, "patched.txt"), 0o644);
    const workspace = fixture.workspace();
    try {
      expect(() =>
        workspace.database.transactionSync(() => {
          workspace.drive.writeRange("/patched.txt", encoder.encode("XY"), 2);
          workspace.drive.chmod("/patched.txt", 0o755);
          workspace.drive.writeFiles([
            { path: "/created", mode: 0o755 },
            { path: "/created/file.txt", bytes: encoder.encode("created") },
            { path: "/created/link", target: "file.txt" },
          ]);
          workspace.drive.makeDirectories(["/implicit/deep"]);
          workspace.drive.removeFiles(["/removed"], { recursive: true });
          throw new Error("rollback every shape");
        }),
      ).toThrow("rollback every shape");
      expect(readFileSync(join(fixture.root, "patched.txt"), "utf8")).toBe("abcdef");
      expect(lstatSync(join(fixture.root, "patched.txt")).mode & 0o777).toBe(0o644);
      expect(readFileSync(join(fixture.root, "removed/nested/file.txt"), "utf8")).toBe("kept");
      expect(workspace.drive.stat("/created")).toBeNull();
      expect(workspace.drive.stat("/implicit")).toBeNull();
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("restores a temporary parent before cleaning transaction artifacts", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a"));
    mkdirSync(join(fixture.root, "target"));
    writeFileSync(join(fixture.root, "a/file"), "old");
    const workspace = fixture.workspace();
    try {
      expect(() =>
        workspace.database.transactionSync(() => {
          workspace.drive.writeFile("/a/file", encoder.encode("new"));
          workspace.drive.removeFiles(["/a"], { recursive: true });
          workspace.drive.symlink("target", "/a");
          throw new Error("rollback replaced parent");
        }),
      ).toThrow("rollback replaced parent");
      expect(lstatSync(join(fixture.root, "a")).isDirectory()).toBe(true);
      expect(readFileSync(join(fixture.root, "a/file"), "utf8")).toBe("old");
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("commits a replacement of a temporary parent without following it during cleanup", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a"));
    mkdirSync(join(fixture.root, "target"));
    writeFileSync(join(fixture.root, "a/file"), "old");
    const workspace = fixture.workspace();
    try {
      workspace.database.transactionSync(() => {
        workspace.drive.writeFile("/a/file", encoder.encode("new"));
        workspace.drive.removeFiles(["/a"], { recursive: true });
        workspace.drive.symlink("target", "/a");
      });
      expect(lstatSync(join(fixture.root, "a")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(fixture.root, "a"))).toBe("target");
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("commits every disk mutation shape with the SQLite generation", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "patched.txt"), "abcdef");
    const workspace = fixture.workspace();
    try {
      const before = workspace.database.recoveryGeneration();
      workspace.database.transactionSync(() => {
        workspace.drive.writeRange("/patched.txt", encoder.encode("XY"), 2);
        workspace.drive.chmod("/patched.txt", 0o755);
        workspace.drive.writeFiles([
          { path: "/created", mode: 0o755 },
          { path: "/created/file.txt", bytes: encoder.encode("created") },
          { path: "/created/link", target: "file.txt" },
        ]);
      });
      expect(readFileSync(join(fixture.root, "patched.txt"), "utf8")).toBe("abXYef");
      expect(lstatSync(join(fixture.root, "patched.txt")).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(fixture.root, "created/file.txt"), "utf8")).toBe("created");
      expect(readlinkSync(join(fixture.root, "created/link"))).toBe("file.txt");
      expect(workspace.database.recoveryGeneration()).toBe(before + 1);
      expect(readdirSync(fixture.recovery)).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });
});
