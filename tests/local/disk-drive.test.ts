import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
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

describe("DiskDrive", () => {
  it("rejects malformed low-level spill paths", () => {
    const fixture = localFixture();
    mkdirSync(fixture.state);
    mkdirSync(fixture.recovery);
    const mapper = new PathMapper(fixture.root);
    for (const host of [`${fixture.root}/bad\0path`, `${fixture.root}/bad\uD800path`]) {
      expect(() => mapper.virtual(host)).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    }
    expect(() => new RecoveryCoordinator(mapper, `${fixture.recovery}/bad\uD800path`)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    const recovery = new RecoveryCoordinator(mapper, fixture.recovery);
    const database = new NodeSqliteDatabase(join(fixture.state, "state.sqlite"));
    try {
      for (const spillDirectory of [
        `${fixture.state}/bad\0spill`,
        `${fixture.state}/bad\uD800spill`,
      ]) {
        expect(
          () =>
            new DiskDrive({
              root: fixture.root,
              spillDirectory,
              mutationScope: recovery,
              observations: new ObservationClock(database),
              recovery,
            }),
        ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
      }
    } finally {
      database.close();
      fixture.dispose();
    }
  });

  it("maps virtual root reads, symlinks, and bulk mutations", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "input.txt"), "input");
    symlinkSync("input.txt", join(fixture.root, "link"));
    const workspace = fixture.workspace();
    try {
      expect(workspace.drive.readFile("/input.txt")).toEqual(encoder.encode("input"));
      expect(workspace.drive.stat("/link")?.type).toBe("symlink");
      expect(workspace.drive.readlink("/link")).toBe("input.txt");
      workspace.database.transactionSync(() => {
        workspace.drive.makeDirectories(["/dir"]);
        workspace.drive.writeFiles([
          { path: "/dir/file.txt", bytes: encoder.encode("written"), mode: 0o755 },
          { path: "/dir/symlink", target: "file.txt" },
        ]);
      });
      expect(readFileSync(join(fixture.root, "dir/file.txt"), "utf8")).toBe("written");
      expect(readlinkSync(join(fixture.root, "dir/symlink"))).toBe("file.txt");
      expect(workspace.drive.stat("/dir/file.txt")?.mode ?? 0).toSatisfy(
        (mode: number) => (mode & 0o111) !== 0,
      );
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("rejects lexical and symbolic-link escapes", () => {
    const fixture = localFixture();
    const outside = join(fixture.base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "secret");
    symlinkSync(outside, join(fixture.root, "escape"));
    mkdirSync(join(fixture.root, "inside"));
    symlinkSync(join(fixture.root, "inside"), join(fixture.root, "absolute-inside"));
    symlinkSync(outside, join(fixture.root, "inside/nested-escape"));
    const workspace = fixture.workspace();
    try {
      expect(() => workspace.drive.realpath("/../../inside")).toThrowError(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => workspace.drive.stat("/bad\0path")).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
      expect(() => workspace.drive.readFile("/escape/secret")).toThrowError(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => workspace.drive.readFile("/absolute-inside/nested-escape/secret")).toThrowError(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() =>
        workspace.database.transactionSync(() =>
          workspace.drive.writeFile("/", encoder.encode("replacement")),
        ),
      ).toThrowError(expect.objectContaining({ code: "EPERM" }));
      expect(() =>
        workspace.database.transactionSync(() => workspace.drive.symlink("bad\0target", "/link")),
      ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("rejects a relative symlink target that climbs above the virtual root", () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "a"));
    writeFileSync(join(fixture.root, "outside"), "incorrectly clamped");
    writeFileSync(join(fixture.base, "outside"), "host outside");
    symlinkSync("../../outside", join(fixture.root, "a/link"));
    const workspace = fixture.workspace();
    try {
      expect(() => workspace.drive.readFile("/a/link")).toThrowError(
        expect.objectContaining({ code: "EACCES" }),
      );
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("follows final symlinks for scalar writes and creates dangling targets", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "target"), "old");
    symlinkSync("target", join(fixture.root, "link"));
    symlinkSync("created-target", join(fixture.root, "dangling"));
    const workspace = fixture.workspace();
    try {
      workspace.database.transactionSync(() => {
        workspace.drive.writeFile("/link", encoder.encode("new"));
        workspace.drive.createFile("/dangling", 0o644);
      });
      expect(readlinkSync(join(fixture.root, "link"))).toBe("target");
      expect(readFileSync(join(fixture.root, "target"), "utf8")).toBe("new");
      expect(readlinkSync(join(fixture.root, "dangling"))).toBe("created-target");
      expect(readFileSync(join(fixture.root, "created-target"), "utf8")).toBe("");
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("uses write payload budgets for batching rather than rejecting valid work", () => {
    const fixture = localFixture();
    const workspace = fixture.workspace();
    try {
      workspace.database.transactionSync(() =>
        workspace.drive.writeFiles(
          [
            { path: "/one", bytes: encoder.encode("one") },
            { path: "/two", bytes: encoder.encode("two") },
          ],
          { payloadBudget: 1 },
        ),
      );
      expect(readFileSync(join(fixture.root, "one"), "utf8")).toBe("one");
      expect(readFileSync(join(fixture.root, "two"), "utf8")).toBe("two");
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("fails a stale handle before an ancestor symlink can redirect its read", () => {
    const fixture = localFixture();
    const outside = join(fixture.base, "outside");
    mkdirSync(join(fixture.root, "directory"));
    mkdirSync(outside);
    writeFileSync(join(fixture.root, "directory/file.txt"), "inside");
    writeFileSync(join(outside, "file.txt"), "outside");
    const workspace = fixture.workspace();
    try {
      const page = workspace.drive.discoverFiles(
        workspace.drive.realpath("/"),
        "/directory/file.txt",
      );
      expect(page.handles).toHaveLength(1);
      rmSync(join(fixture.root, "directory"), { recursive: true });
      symlinkSync(outside, join(fixture.root, "directory"));
      expect(() => workspace.drive.readFileHandles(page.handles)).toThrowError(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("outside");
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("keeps one opened file identity throughout a streaming read", () => {
    const fixture = localFixture();
    const original = new Uint8Array(192 * 1024).fill(1);
    const replacement = new Uint8Array(original.length).fill(2);
    writeFileSync(join(fixture.root, "large.bin"), original);
    const workspace = fixture.workspace();
    try {
      const stat = workspace.drive.stat("/large.bin");
      expect(stat).not.toBeNull();
      if (stat === null) throw new Error("large file stat is missing");
      const stream = workspace.drive.readFileStream("/large.bin", stat)[Symbol.iterator]();
      const first = stream.next();
      expect(first.done).toBe(false);
      if (first.done === true) throw new Error("stream ended before the first chunk");
      writeFileSync(join(fixture.root, "replacement.bin"), replacement);
      renameSync(join(fixture.root, "replacement.bin"), join(fixture.root, "large.bin"));
      const chunks = [first.value];
      for (;;) {
        const next = stream.next();
        if (next.done === true) break;
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      expect(bytes).toEqual(original);
      expect(new Uint8Array(readFileSync(join(fixture.root, "large.bin")))).toEqual(replacement);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("restores all disk effects when the SQLite transaction fails", () => {
    const fixture = localFixture();
    writeFileSync(join(fixture.root, "existing.txt"), "old");
    const workspace = fixture.workspace();
    try {
      expect(() =>
        workspace.database.transactionSync(() => {
          workspace.drive.writeFile("/existing.txt", encoder.encode("new"));
          workspace.drive.writeFile("/created.txt", encoder.encode("created"));
          throw new Error("late failure");
        }),
      ).toThrow("late failure");
      expect(readFileSync(join(fixture.root, "existing.txt"), "utf8")).toBe("old");
      expect(workspace.drive.stat("/created.txt")).toBeNull();
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });
});
