// The shell, unmodified, over session A's mounted view. Every command an agent
// would reach for to look around or to write must stay inside A's mounts and
// must not be able to tell B's files from files that do not exist.

import { beforeEach, describe, expect, it } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createMountedFilesystem } from "../../packages/do/src/fs/mounted/view.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { createGitCommand } from "../../packages/do/src/git-shell.js";
import { Workspace } from "../../packages/do/src/runtime/workspace.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { createGit } from "../../packages/git/src/client.js";
import { TestDatabase } from "../helpers/db.js";
import { outsideState, sessions } from "../helpers/mounted.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const W = "/home/user/workspace";
const LEAKS = /\/s\/|\/w\/|secret|NEEDLE in B|outside every mount|\/s$|\/w$/m;

let base: Filesystem;
let shell: Shell;
beforeEach(() => {
  const subject = sessions();
  base = subject.base;
  shell = createShell({ fs: subject.view, cwd: W });
});

describe("reads from session A", () => {
  it("see only A's mounts and synthetic ancestors", async () => {
    const listing = await shell.run("ls -R /");
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain("/home/user/workspace/src:\nmain.ts\nutil.ts\n");
    expect(listing.stdout).not.toMatch(LEAKS);

    const found = await shell.run("find /");
    expect(found.stdout.split("\n").slice(0, 5)).toEqual([
      "/",
      "/home",
      "/home/user",
      "/home/user/session",
      "/home/user/session/notes.txt",
    ]);
    expect(found.stdout).not.toMatch(LEAKS);

    for (const search of ["grep -r NEEDLE /", "rg NEEDLE /", "grep -rl NEEDLE /home"]) {
      const run = await shell.run(search);
      expect(run.stdout, search).toContain(`${W}/src/main.ts`);
      expect(run.stdout, search).not.toMatch(LEAKS);
    }
    expect((await shell.run("echo /*/*")).stdout).toBe("/home/user /opt/tools\n");
    expect((await shell.run("ls src/*.ts")).stdout).toBe("src/main.ts\nsrc/util.ts\n");
    expect((await shell.run("cat ../session/notes.txt")).stdout).toBe("session A notes\n");
  });

  it("cannot tell B's files from absent ones", async () => {
    const pairs: [string, string][] = [
      ["/s/b/secret.txt", "/s/b/none.txt"],
      ["/w/b/src", "/w/q/src"],
      ["/top.txt", "/none.txt"],
    ];
    for (const [hidden, absent] of pairs) {
      for (const command of ["cat", "ls", "stat", "wc -c", "head -1", "realpath -e"]) {
        const left = await shell.run(`${command} ${hidden}`);
        const right = await shell.run(`${command} ${absent}`);
        expect(left.exitCode, `${command} ${hidden}`).toBe(right.exitCode);
        expect(left.stderr.replaceAll(hidden, "X")).toBe(right.stderr.replaceAll(absent, "X"));
        expect(left.stdout).toBe("");
      }
    }
    for (const link of ["to-b-absolute", "to-b-relative", "dir-b/main.ts", "out-and-back"]) {
      const run = await shell.run(`cat ${link}`);
      expect(run.exitCode, link).toBe(1);
      expect(run.stderr).toContain("No such file or directory");
      expect(run.stdout).toBe("");
    }
    // A link that would leave the mount reads as dangling, as `ls` shows one.
    expect((await shell.run("ls dir-b")).stdout).toBe("dir-b\n");
    expect((await shell.run("ls dir-b/")).stdout).toBe("dir-b/\n");
    expect((await shell.run("ls dir-b/main.ts")).exitCode).not.toBe(0);
    expect((await shell.run("cat inside")).stdout).toContain("NEEDLE in A");
  });
});

describe("writes from session A", () => {
  it("cannot touch B or anything outside the mounts", async () => {
    const before = outsideState(base);
    const attempts = [
      "mkdir -p /s/b/x",
      "mkdir -p /w/b/src/new",
      "cp src/main.ts /w/b/src/copied.ts",
      "cp src/main.ts dir-b/copied.ts",
      "mv README.md /w/b/README.md",
      "mv README.md dir-b/README.md",
      "ln -s /w/b/src/main.ts /w/b/src/link",
      "ln src/main.ts dir-b/hard.ts",
      "touch /w/b/src/touched dir-b/touched /top.txt",
      "rm -rf /w/b /s/b /top.txt",
      "rm -f dir-b/main.ts",
      "echo hi > /w/b/src/main.ts",
      "echo hi > dir-b/main.ts",
      "echo hi >> to-b-absolute",
      "chmod 600 /top.txt",
      "rm -rf /home",
    ];
    for (const attempt of attempts) await shell.run(attempt);
    expect(outsideState(base)).toEqual(before);
    expect(base.exists("/w/a/README.md")).toBe(true);
  });

  it("works inside its own mounts and reports EROFS and EXDEV", async () => {
    expect(
      (await shell.run("mkdir -p out/deep && echo hi > out/deep/f && cat out/deep/f")).stdout,
    ).toBe("hi\n");
    expect(base.exists("/w/a/out/deep/f")).toBe(true);
    const readOnly = await shell.run("touch /opt/tools/new");
    expect(readOnly.exitCode).toBe(1);
    expect(readOnly.stderr).toMatch(/read-only file system/i);
    const cross = await shell.run("ln src/main.ts ../session/hard.ts");
    expect(cross.exitCode).toBe(1);
    expect(cross.stderr).toMatch(/EXDEV|cross-device/);
    expect(
      (await shell.run("cp src/main.ts ../session/main.ts && cat ../session/main.ts")).stdout,
    ).toContain("NEEDLE in A");
    expect((await shell.run("mv ../session/main.ts ../session/moved.ts")).exitCode).toBe(0);
  });
});

describe("with the git command injected", () => {
  it("runs the other commands unchanged", async () => {
    const workspace = new Workspace({
      storage: new SqliteTestStorage(),
      git: createGit(),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
      now: () => 1_577_836_800_000,
    });
    workspace.filesystem.mkdir("/w/a/repo", { recursive: true });
    await workspace.git.init({ dir: "/w/a/repo" });
    workspace.filesystem.writeFile("/w/a/repo/file.txt", new TextEncoder().encode("one\n"));
    const view = createMountedFilesystem(workspace.filesystem, [
      { path: W, source: "/w/a", mode: "rw" },
    ]);
    const gitShell = createShell({
      fs: view,
      cwd: `${W}/repo`,
      commands: new Map([["git", createGitCommand(workspace.git)]]),
    });
    expect((await gitShell.run("cat file.txt && ls /home/user")).stdout).toBe("one\nworkspace\n");
    const git = await gitShell.run("git status --porcelain");
    expect(typeof git.exitCode).toBe("number");
  });
});

describe("differential: a view against the same tree stored flat", () => {
  // Session A's virtual tree written as ordinary rows into a second database.
  // Every listing and search must print the same bytes over both.
  async function pair(): Promise<{ mounted: Shell; flat: Shell }> {
    const subject = sessions();
    subject.base.removeFiles(
      [
        "/w/a/to-b-absolute",
        "/w/a/to-b-relative",
        "/w/a/dir-b",
        "/w/a/out-and-back",
        "/w/a/to-session",
      ],
      { force: true },
    );
    subject.base.writeFiles([
      { path: "/w/a/src/nested/deep.ts", bytes: new TextEncoder().encode("deep NEEDLE\n") },
      { path: "/w/a/src.d/x.txt", bytes: new TextEncoder().encode("dot dir\n") },
    ]);
    const flatStorage = new SqliteTestStorage();
    const flatFs = createFilesystem(new TestDatabase(flatStorage), {
      now: () => 1_700_000_000_000,
    });
    const entries = [];
    for (const entry of subject.view.scanStream(subject.view.realpath("/"))) {
      if (entry.type === "dir") entries.push({ path: entry.path, mode: entry.mode & 0o7777 });
      else if (entry.type === "symlink")
        entries.push({ path: entry.path, target: entry.target ?? "" });
      else
        entries.push({
          path: entry.path,
          bytes: subject.view.readFile(entry.path),
          mode: entry.mode & 0o7777,
        });
    }
    flatFs.writeFiles(entries);
    return {
      mounted: createShell({ fs: subject.view, cwd: W }),
      flat: createShell({ fs: flatFs, cwd: W }),
    };
  }

  it("prints the same listings and search results", async () => {
    const { mounted, flat } = await pair();
    for (const command of [
      "find /",
      "find / -name '*.ts' -type f",
      "find /home -type d",
      "find / -path '*src*' -prune -o -print",
      "ls -R /",
      "ls / /home /home/user",
      "tree /",
      "du -a /",
      "grep -rn NEEDLE /",
      "grep -rl NEEDLE /home/user",
      "rg -n NEEDLE /",
      "rg --files /",
      "rg --files -g '*.ts' /home",
      "echo /*/*/*",
      "echo /home/*/workspace/src/*.ts",
      "ls src/*.ts src.d/*",
      "cat inside ../session/notes.txt",
      "wc -l src/main.ts ../session/notes.txt",
      "realpath inside /home/user/workspace/src/.. /home/user/workspace/../session",
    ]) {
      const left = await mounted.run(command);
      const right = await flat.run(command);
      expect({ stdout: left.stdout, stderr: left.stderr, exit: left.exitCode }, command).toEqual({
        stdout: right.stdout,
        stderr: right.stderr,
        exit: right.exitCode,
      });
    }
  });
});
