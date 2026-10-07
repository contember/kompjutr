// A mounted view isolates one session's namespace from everything else in the
// workspace. The property under test is indistinguishability: from inside the
// view, another session's files must look exactly like files that do not
// exist, through every read, every write, and every symlink.

import { describe, expect, it } from "vitest";

import { createMountedFilesystem } from "../../packages/do/src/fs/mounted/view.js";
import { comparePaths } from "../../packages/do/src/fs/path.js";
import type { Filesystem, ScanEntry } from "../../packages/do/src/fs/types.js";
import { outsideState, sessions } from "../helpers/mounted.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const NEEDLE = ENCODER.encode("NEEDLE");

function text(value: string): Uint8Array {
  return ENCODER.encode(value);
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

function errorOf(work: () => unknown): Error {
  try {
    work();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected an error");
}

const W = "/home/user/workspace";

describe("the namespace a view shows", () => {
  it("lists only synthetic ancestors and mounts", () => {
    const { view } = sessions();
    expect(view.readdir("/")).toEqual([
      { name: "home", type: "dir" },
      { name: "opt", type: "dir" },
    ]);
    expect(view.readdir("/home/user").map((entry) => entry.name)).toEqual(["session", "workspace"]);
    expect(view.readdir(W).map((entry) => entry.name)).toEqual([
      "README.md",
      "dir-b",
      "inside",
      "out-and-back",
      "src",
      "to-b-absolute",
      "to-b-relative",
      "to-session",
    ]);
    expect(view.stat("/home")).toMatchObject({ type: "dir", mode: 0o40555 });
    expect(view.stat(W)?.ino).toBe(sessionsBaseIno("/w/a"));
  });

  it("reports hidden paths exactly as absent ones", () => {
    const { view } = sessions();
    const pairs: [string, string][] = [
      ["/s/b/secret.txt", "/s/b/nothing.txt"],
      ["/w/b", "/w/c"],
      ["/top.txt", "/bottom.txt"],
      ["/s", "/q"],
    ];
    for (const [hidden, absent] of pairs) {
      expect(view.stat(hidden)).toBeNull();
      expect(view.statTarget(hidden)).toBeNull();
      expect(view.exists(hidden)).toBe(false);
      expect(view.realpath(hidden)).toBe(hidden);
      const left = errorOf(() => view.readFile(hidden));
      const right = errorOf(() => view.readFile(absent));
      expect(left.message.replace(hidden, "X")).toBe(right.message.replace(absent, "X"));
      expect(codeOf(() => view.readdir(hidden))).toBe(codeOf(() => view.readdir(absent)));
      expect(view.readFiles([hidden]).files.size).toBe(0);
    }
  });

  it("climbs out of a mount with `..` as a bind mount does", () => {
    const { view } = sessions();
    expect(DECODER.decode(view.readFile(`${W}/../session/notes.txt`))).toBe("session A notes\n");
    expect(view.realpath(`${W}/src/../..`)).toBe("/home/user");
    expect(view.stat(`${W}/../../../s/b/secret.txt`)).toBeNull();
    expect(view.realpath(`${W}/../../../s/b`)).toBe("/s/b");
  });

  it("quotes only virtual paths in errors", () => {
    const { view } = sessions();
    const error = errorOf(() => view.readFile(`${W}/src`));
    expect(error.message).toContain(`${W}/src`);
    expect(error.message).not.toContain("/w/a");
    const nested = errorOf(() => view.writeFiles([{ path: `${W}/README.md/x`, bytes: text("") }]));
    expect(nested.message).not.toContain("/w/a");
  });
});

function sessionsBaseIno(path: string): number | undefined {
  return sessions().base.stat(path)?.ino;
}

describe("symlinks fail closed", () => {
  it("follows a link that stays inside its mount", () => {
    const { view } = sessions();
    expect(DECODER.decode(view.readFile(`${W}/inside`))).toContain("NEEDLE in A");
    expect(view.realpath(`${W}/inside`)).toBe(`${W}/src/main.ts`);
  });

  it("refuses absolute, climbing, and cross-mount targets for reads and traversal", () => {
    const { view } = sessions();
    for (const link of ["to-b-absolute", "to-b-relative", "out-and-back", "to-session"]) {
      const path = `${W}/${link}`;
      expect(view.stat(path)?.type).toBe("symlink");
      expect(view.statTarget(path)).toBeNull();
      expect(codeOf(() => view.readFile(path))).toBe("ENOENT");
      expect(codeOf(() => view.realpath(path))).toBe("ENOENT");
      expect(view.readFiles([path]).files.size).toBe(0);
    }
    expect(codeOf(() => view.readdir(`${W}/dir-b`))).toBe("ENOENT");
    expect(codeOf(() => view.readFile(`${W}/dir-b/main.ts`))).toBe("ENOENT");
    expect(view.scan(`${W}/dir-b`, { limit: 100 })).toEqual([]);
    expect(view.glob(`${W}/dir-b`, `${W}/dir-b/*`)).toEqual([]);
  });

  it("refuses a write through a symlinked parent or final link that leaves the mount", () => {
    const { base, view } = sessions();
    const before = outsideState(base);
    expect(codeOf(() => view.writeFile(`${W}/dir-b/new.ts`, text("x")))).toBe("ENOENT");
    expect(codeOf(() => view.writeFile(`${W}/to-b-relative`, text("x")))).toBe("ENOENT");
    expect(codeOf(() => view.writeFiles([{ path: `${W}/dir-b/new.ts`, bytes: text("x") }]))).toBe(
      "ENOENT",
    );
    expect(codeOf(() => view.makeDirectories([`${W}/dir-b/sub`]))).toBe("ENOENT");
    expect(codeOf(() => view.mkdir(`${W}/dir-b/sub`))).toBe("ENOENT");
    expect(codeOf(() => view.touchFiles([`${W}/to-b-absolute`]))).toBe("ENOENT");
    expect(codeOf(() => view.writeFileStream(`${W}/to-b-absolute`, [text("x")]))).toBe("ENOENT");
    expect(
      codeOf(() => view.copyFiles([{ source: `${W}/README.md`, destination: `${W}/dir-b/r` }])),
    ).toBe("ENOENT");
    expect(codeOf(() => view.rename(`${W}/README.md`, `${W}/dir-b/README.md`))).toBe("ENOENT");
    expect(codeOf(() => view.removeFiles([`${W}/dir-b/main.ts`]))).toBe("ENOENT");
    view.removeFiles([`${W}/dir-b/main.ts`], { force: true });
    expect(outsideState(base)).toEqual(before);
  });

  it("stores a target written through the view verbatim", () => {
    const { base, view } = sessions();
    view.symlink("/w/b/src/main.ts", `${W}/planted`);
    expect(view.readlink(`${W}/planted`)).toBe("/w/b/src/main.ts");
    expect(view.statTarget(`${W}/planted`)).toBeNull();
    expect(base.readlink("/w/a/planted")).toBe("/w/b/src/main.ts");
  });
});

function paths(entries: Iterable<ScanEntry>): string[] {
  return [...entries].map((entry) => entry.path);
}

describe("bulk reads see one session", () => {
  it("streams the whole namespace in path order", () => {
    const { view } = sessions();
    const all = paths(view.scanStream(view.realpath("/")));
    expect(all.slice(0, 4)).toEqual([
      "/home",
      "/home/user",
      "/home/user/session",
      "/home/user/session/notes.txt",
    ]);
    expect(all).toContain(`${W}/src/main.ts`);
    expect(all).toContain("/opt/tools/bin/tool");
    expect(all.some((path) => path.startsWith("/s") || path.startsWith("/w"))).toBe(false);
    expect(all).toEqual([...all].sort(comparePaths));
  });

  it("finds content only in its own mounts", () => {
    const { view } = sessions();
    const page = view.discoverFilesContaining(view.realpath("/"), "*", NEEDLE);
    expect(page.matched.map((handle) => handle.path)).toEqual([`${W}/src/main.ts`]);
    const read = view.readFileHandles(page.matched);
    expect([...read.files.keys()]).toEqual([`${W}/src/main.ts`]);
    const inside = view.discoverFiles(view.realpath(W), `${W}/src/*.ts`);
    expect(inside.handles.map((handle) => handle.path)).toEqual([
      `${W}/src/main.ts`,
      `${W}/src/util.ts`,
    ]);
  });

  it("globs and lists without crossing into another session", () => {
    const { view } = sessions();
    expect(view.glob("/", "*main.ts")).toEqual([`${W}/src/main.ts`]);
    expect(view.glob("/", "/home/?ser")).toEqual(["/home/user"]);
    const everything = view.glob("/", "/*");
    expect(everything).toContain(`${W}/src/util.ts`);
    expect(everything.some((path) => path.startsWith("/s") || path.startsWith("/w"))).toBe(false);
    expect(view.globPage("/home", "/home/user/*", { limit: 1 })).toEqual({
      paths: ["/home/user/session"],
      next: "/home/user/session",
    });
    const listed = view.listEntries("/", { recursive: true });
    const directories = [...new Set(listed.items.map((item) => item.directory))];
    expect(directories).toEqual([
      "/",
      "/home",
      "/home/user",
      "/home/user/session",
      W,
      `${W}/src`,
      "/opt",
      "/opt/tools",
      "/opt/tools/bin",
    ]);
    const read = view.readFiles([
      `${W}/README.md`,
      "/w/b/src/main.ts",
      `${W}/../../../w/b/src/main.ts`,
    ]);
    expect([...read.files.keys()]).toEqual([`${W}/README.md`]);
  });
});

describe("mutations", () => {
  it("reject every mutating method on a read-only mount with EROFS", () => {
    const { base, view } = sessions();
    const before = paths(base.scanStream(base.realpath("/tools")));
    const T = "/opt/tools";
    const attempts: Record<string, () => unknown> = {
      writeFile: () => view.writeFile(`${T}/bin/tool`, text("x")),
      createFile: () => view.createFile(`${T}/new`, 0o644),
      writeRange: () => view.writeRange(`${T}/bin/tool`, text("x"), 0),
      truncate: () => view.truncate(`${T}/bin/tool`, 0),
      mkdir: () => view.mkdir(`${T}/new`),
      mkdirRecursive: () => view.mkdir(`${T}/bin`, { recursive: true }),
      symlink: () => view.symlink("bin", `${T}/link`),
      link: () => view.link(`${T}/bin/tool`, `${T}/hard`),
      unlink: () => view.unlink(`${T}/bin/tool`),
      rmdir: () => view.rmdir(`${T}/bin`),
      rm: () => view.rm(`${T}/bin`, { recursive: true }),
      rename: () => view.rename(`${T}/bin/tool`, `${T}/bin/moved`),
      chmod: () => view.chmod(`${T}/bin/tool`, 0o600),
      writeFiles: () => view.writeFiles([{ path: `${T}/x`, bytes: text("x") }]),
      copyFiles: () => view.copyFiles([{ source: `${W}/README.md`, destination: `${T}/r` }]),
      touchFiles: () => view.touchFiles([`${T}/bin/tool`]),
      writeFileStream: () => view.writeFileStream(`${T}/bin/tool`, [text("x")]),
      makeDirectories: () => view.makeDirectories([`${T}/bin/deeper`]),
      removeFiles: () => view.removeFiles([`${T}/bin/tool`]),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      expect(codeOf(attempt), name).toBe("EROFS");
    }
    expect(paths(base.scanStream(base.realpath("/tools")))).toEqual(before);
    expect(DECODER.decode(view.readFile(`${T}/bin/tool`))).toBe("#!/bin/sh\n");
  });

  it("refuses rename and hard link across mounts with EXDEV but copies", () => {
    const { base, view } = sessions();
    expect(codeOf(() => view.rename(`${W}/README.md`, "/home/user/session/README.md"))).toBe(
      "EXDEV",
    );
    expect(codeOf(() => view.link(`${W}/README.md`, "/home/user/session/README.md"))).toBe("EXDEV");
    view.copyFiles([{ source: `${W}/README.md`, destination: "/home/user/session/README.md" }]);
    expect(DECODER.decode(base.readFile("/s/a/README.md"))).toBe("# A\n");
    view.rename(`${W}/README.md`, `${W}/README.txt`);
    expect(base.exists("/w/a/README.txt")).toBe(true);
  });

  it("refuses writes into synthetic directories and removal of mount roots", () => {
    const { base, view } = sessions();
    const before = outsideState(base);
    expect(codeOf(() => view.writeFile("/home/x", text("x")))).toBe("EROFS");
    expect(codeOf(() => view.mkdir("/s"))).toBe("EROFS");
    expect(codeOf(() => view.mkdir("/q"))).toBe("EROFS");
    expect(codeOf(() => view.makeDirectories(["/s/b/x"]))).toBe("EROFS");
    expect(codeOf(() => view.makeDirectories(["/q/b/x"]))).toBe("EROFS");
    expect(codeOf(() => view.rm("/home", { recursive: true }))).toBe("EROFS");
    expect(codeOf(() => view.rm(W, { recursive: true }))).toBe("EBUSY");
    expect(codeOf(() => view.removeFiles([W], { recursive: true }))).toBe("EBUSY");
    expect(codeOf(() => view.rename(W, "/home/user/elsewhere"))).toBe("EBUSY");
    expect(codeOf(() => view.writeFiles([{ path: "/w/b/src/main.ts", bytes: text("x") }]))).toBe(
      "EROFS",
    );
    view.removeFiles(["/s/b", "/w/b"], { recursive: true, force: true });
    view.rm("/w/b", { recursive: true, force: true });
    view.makeDirectories(["/home/user", W]);
    view.mkdir("/home", { recursive: true });
    expect(outsideState(base)).toEqual(before);
  });

  it("writes land in the mount's source", () => {
    const { base, view } = sessions();
    view.writeFiles([{ path: `${W}/new/deep/file.ts`, bytes: text("new") }]);
    view.touchFiles([`${W}/touched`]);
    view.writeFileStream("/home/user/session/log", [text("a"), text("b")]);
    view.mkdir(`${W}/made`);
    expect(DECODER.decode(base.readFile("/w/a/new/deep/file.ts"))).toBe("new");
    expect(base.exists("/w/a/touched")).toBe(true);
    expect(DECODER.decode(base.readFile("/s/a/log"))).toBe("ab");
    expect(base.stat("/w/a/made")?.type).toBe("dir");
    view.removeFiles([`${W}/new`], { recursive: true });
    expect(base.exists("/w/a/new")).toBe(false);
  });
});

describe("construction", () => {
  it("rejects overlapping, non-canonical, and missing mounts", () => {
    const { base } = sessions();
    const open = (mounts: Parameters<typeof createMountedFilesystem>[1]) => () =>
      createMountedFilesystem(base, mounts);
    expect(
      codeOf(
        open([
          { path: "/a", source: "/s/a", mode: "rw" },
          { path: "/a/b", source: "/w/a", mode: "rw" },
        ]),
      ),
    ).toBe("EINVAL");
    expect(
      codeOf(
        open([
          { path: "/a", source: "/s/a", mode: "rw" },
          { path: "/a", source: "/w/a", mode: "ro" },
        ]),
      ),
    ).toBe("EINVAL");
    expect(codeOf(open([{ path: "a", source: "/s/a", mode: "rw" }]))).toBe("EINVAL");
    expect(codeOf(open([{ path: "/a", source: "/s/a/../b", mode: "rw" }]))).toBe("EINVAL");
    expect(codeOf(open([{ path: "/a", source: "/missing", mode: "rw" }]))).toBe("ENOENT");
    expect(codeOf(open([{ path: "/a", source: "/top.txt", mode: "rw" }]))).toBe("ENOTDIR");
    expect(codeOf(open([{ path: "/a", source: "/w/a/dir-b", mode: "rw" }]))).toBe("EINVAL");
    expect(codeOf(() => createMountedFilesystem(sessions().view, []))).toBe("EINVAL");
  });
});

describe("keyset pages above the mounts", () => {
  it("concatenate to one full page for every page size", () => {
    const { view } = sessions();
    const full = view.scan("/", { limit: 1_000 });
    const fullGlob = view.globPage("/", "*").paths;
    const fullList = view.listEntries("/", { recursive: true }).items;
    const fullFiles = view.scan("/", { limit: 1_000, filesOnly: true });
    for (let limit = 1; limit <= 4; limit++) {
      const scanned: ScanEntry[] = [];
      for (;;) {
        const after = scanned[scanned.length - 1]?.path;
        const page = view.scan("/", after === undefined ? { limit } : { limit, after });
        scanned.push(...page);
        if (page.length < limit) break;
      }
      expect(scanned, `scan ${limit}`).toEqual(full);

      const files: ScanEntry[] = [];
      for (;;) {
        const after = files[files.length - 1]?.path;
        const page = view.scan("/", { limit, filesOnly: true, after });
        files.push(...page);
        if (page.length < limit) break;
      }
      expect(files, `filesOnly ${limit}`).toEqual(fullFiles);

      const globbed: string[] = [];
      let next: string | null | undefined;
      do {
        const page = view.globPage("/", "*", { limit, after: next ?? undefined });
        globbed.push(...page.paths);
        next = page.next;
      } while (next !== null);
      expect(globbed, `glob ${limit}`).toEqual(fullGlob);

      const listed = [];
      let cursor: ReturnType<Filesystem["listEntries"]>["next"] | undefined;
      do {
        const page = view.listEntries("/", { recursive: true, limit, after: cursor ?? undefined });
        listed.push(...page.items);
        cursor = page.next;
      } while (cursor !== null);
      expect(listed, `list ${limit}`).toEqual(fullList);
    }
  });

  it("resumes past a pruned subtree", () => {
    const { view } = sessions();
    const pruned = paths(
      view.scanStream(view.realpath("/"), { pruneDirectory: (path) => path === "/home/user" }),
    );
    expect(pruned).toEqual([
      "/home",
      "/home/user",
      "/opt",
      "/opt/tools",
      "/opt/tools/bin",
      "/opt/tools/bin/tool",
    ]);
    const page = view.scan("/", { limit: 10, afterSubtree: "/home" });
    expect(page.map((entry) => entry.path)).toEqual([
      "/opt",
      "/opt/tools",
      "/opt/tools/bin",
      "/opt/tools/bin/tool",
    ]);
  });
});
