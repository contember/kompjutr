import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { LocalWorkspace } from "@kompjutr/local";
import { describe, expect, it } from "vitest";
import { openRepository } from "../../packages/git/src/ops/core/context.js";
import { dirtyPathStream } from "../../packages/git/src/ops/worktree/worktree-io.js";
import { GitFixture } from "../helpers/git.js";
import { startGitServer } from "../helpers/http-backend.js";
import { localFixture } from "./helpers.js";

const FIXED_TIME = 1_577_836_800_000;
const IDENTITY = { name: "Fixture", email: "fixture@example.com" };

function writeBoth(
  workspace: LocalWorkspace,
  mirror: GitFixture,
  path: string,
  content: string,
): void {
  const host = join(workspace.root, path);
  mkdirSync(join(host, ".."), { recursive: true });
  writeFileSync(host, content);
  mirror.write(path, content);
}

async function compare(workspace: LocalWorkspace, mirror: GitFixture): Promise<void> {
  const status = await workspace.git.runCli({ argv: ["status", "--porcelain=v2"], cwd: "/" });
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toBe(mirror.git("status", "--porcelain=v2"));
  expect(await workspace.git.revParse({ ref: "HEAD" })).toBe(mirror.git("rev-parse", "HEAD"));
}

describe("LocalWorkspace Git parity", () => {
  it("cleans an empty directory at the 1,000-row scan boundary", async () => {
    const fixture = localFixture();
    const mirror = new GitFixture().init();
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    try {
      await workspace.git.init();
      writeBoth(workspace, mirror, "base.txt", "base\n");
      await workspace.git.add({ paths: ["base.txt"] });
      await workspace.git.commit({ message: "base" });
      mirror.git("add", "--", "base.txt");
      mirror.git("commit", "-q", "-m", "base");
      for (let index = 0; index < 998; index++) {
        writeBoth(workspace, mirror, `a-${String(index).padStart(3, "0")}`, "untracked");
      }
      writeBoth(workspace, mirror, "z.txt", "untracked");
      mkdirSync(join(workspace.root, "z"));
      mkdirSync(join(mirror.dir, "z"));
      await workspace.git.clean({ directories: true });
      mirror.git("clean", "-q", "-f", "-d");
      expect(existsSync(join(workspace.root, "z"))).toBe(existsSync(join(mirror.dir, "z")));
      await compare(workspace, mirror);
    } finally {
      workspace.close();
      mirror.dispose();
      fixture.dispose();
    }
  });

  it("prunes a nested repository through a symlinked parent root", async () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "real/nested"), { recursive: true });
    symlinkSync("real", join(fixture.root, "alias"));
    writeFileSync(join(fixture.root, "real/visible.txt"), "visible\n");
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    try {
      await workspace.git.init({ dir: "/alias" });
      await workspace.git.add({ dir: "/alias", paths: ["visible.txt"] });
      await workspace.git.commit({ dir: "/alias", message: "visible" });
      await workspace.git.init({ dir: "/alias/nested" });
      const context = {
        database: workspace.gitDatabase,
        worktree: workspace.drive,
        now: () => FIXED_TIME,
        timezoneOffset: () => 0,
      };
      const repo = openRepository(context, "/alias");
      const invalid = Buffer.concat([
        Buffer.from(`${fixture.root}/real/nested/`),
        Buffer.from([0xff]),
      ]);
      closeSync(openSync(invalid, "w"));
      expect([
        ...dirtyPathStream(repo, workspace.drive, undefined, undefined, ["/alias/nested"]),
      ]).toEqual([]);
      await expect(workspace.git.status({ dir: "/alias" })).resolves.toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("retains stale-stat outer files inside a nested repository", async () => {
    const fixture = localFixture();
    mkdirSync(join(fixture.root, "nested"));
    writeFileSync(join(fixture.root, "nested/tracked.txt"), "tracked\n");
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    try {
      await workspace.git.init();
      await workspace.git.add({ paths: ["nested/tracked.txt"] });
      await workspace.git.commit({ message: "track nested file" });
      await workspace.git.init({ dir: "/nested" });
      await expect(workspace.git.status()).resolves.toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });

  it("matches Git when checkout replaces a prefixed empty directory", async () => {
    const fixture = localFixture();
    const mirror = new GitFixture().init();
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    try {
      await workspace.git.init();
      writeBoth(workspace, mirror, "base.txt", "base\n");
      await workspace.git.add({ paths: ["base.txt"] });
      await workspace.git.commit({ message: "base" });
      mirror.git("add", "--", "base.txt");
      mirror.git("commit", "-q", "-m", "base");

      await workspace.git.branch({ name: "file", checkout: true });
      mirror.git("checkout", "-q", "-b", "file");
      writeBoth(workspace, mirror, "a", "tracked\n");
      await workspace.git.add({ paths: ["a"] });
      await workspace.git.commit({ message: "add a" });
      mirror.git("add", "--", "a");
      mirror.git("commit", "-q", "-m", "add a");

      await workspace.git.checkout({ ref: "main" });
      mirror.git("checkout", "-q", "main");
      mkdirSync(join(workspace.root, "a"));
      mkdirSync(join(mirror.dir, "a"));
      writeBoth(workspace, mirror, "a.txt", "untracked\n");

      await workspace.git.checkout({ ref: "file", force: true });
      mirror.git("checkout", "-q", "-f", "file");
      expect(readFileSync(join(workspace.root, "a.txt"), "utf8")).toBe(
        readFileSync(join(mirror.dir, "a.txt"), "utf8"),
      );
      rmSync(join(workspace.root, "a.txt"));
      rmSync(join(mirror.dir, "a.txt"));
      await compare(workspace, mirror);
      expect(readFileSync(join(workspace.root, "a"), "utf8")).toBe("tracked\n");
    } finally {
      workspace.close();
      mirror.dispose();
      fixture.dispose();
    }
  });

  it("matches a real full-history clone into the virtual root", async () => {
    const source = new GitFixture().init();
    source.write("README.md", "seed\n").commit("seed");
    source.write("src/index.ts", "export const value = 1;\n").commit("second");
    const bare = new GitFixture();
    bare.git("clone", "--bare", "-q", source.dir, ".");
    const mirror = new GitFixture();
    const fixture = localFixture();
    const server = await startGitServer(bare.dir);
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    try {
      await workspace.git.clone({
        url: server.url,
        dir: "/",
        depth: 0,
        singleBranch: false,
        noTags: false,
      });
      mirror.git("clone", "-q", bare.dir, ".");
      await compare(workspace, mirror);
      expect(readFileSync(join(fixture.root, "src/index.ts"), "utf8")).toBe(
        "export const value = 1;\n",
      );
    } finally {
      workspace.close();
      await server.close();
      source.dispose();
      bare.dispose();
      mirror.dispose();
      fixture.dispose();
    }
  });

  it("matches real Git through local mutation and integration workflows", async () => {
    const fixture = localFixture();
    const mirror = new GitFixture().init();
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    const linkedMirror = `${mirror.dir}-linked`;
    try {
      await workspace.git.init();
      writeBoth(workspace, mirror, "base.txt", "base\n");
      await workspace.git.add({ paths: ["base.txt"] });
      const base = await workspace.git.commit({ message: "base" });
      mirror.git("add", "--", "base.txt");
      mirror.git("commit", "-q", "-m", "base");
      expect(base.oid).toBe(mirror.git("rev-parse", "HEAD"));
      await compare(workspace, mirror);

      await workspace.git.branch({ name: "feature", checkout: true });
      mirror.git("checkout", "-q", "-b", "feature");
      writeBoth(workspace, mirror, "feature.txt", "feature\n");
      await workspace.git.add({ paths: ["feature.txt"] });
      await workspace.git.commit({ message: "feature" });
      mirror.git("add", "--", "feature.txt");
      mirror.git("commit", "-q", "-m", "feature");
      await workspace.git.checkout({ ref: "main" });
      mirror.git("checkout", "-q", "main");
      writeBoth(workspace, mirror, "main.txt", "main\n");
      await workspace.git.add({ paths: ["main.txt"] });
      await workspace.git.commit({ message: "main" });
      mirror.git("add", "--", "main.txt");
      mirror.git("commit", "-q", "-m", "main");
      await workspace.git.merge({
        theirs: "feature",
        fastForward: false,
        message: "merge feature",
      });
      mirror.git("merge", "-q", "--no-ff", "-m", "merge feature", "feature");
      await compare(workspace, mirror);

      await workspace.git.branch({ name: "pick", checkout: true });
      mirror.git("checkout", "-q", "-b", "pick");
      writeBoth(workspace, mirror, "picked.txt", "picked\n");
      await workspace.git.add({ paths: ["picked.txt"] });
      const picked = await workspace.git.commit({ message: "picked" });
      mirror.git("add", "--", "picked.txt");
      mirror.git("commit", "-q", "-m", "picked");
      expect(picked.oid).toBe(mirror.git("rev-parse", "HEAD"));
      await workspace.git.checkout({ ref: "main" });
      mirror.git("checkout", "-q", "main");
      await workspace.git.cherryPick({ source: "pick" });
      mirror.git("cherry-pick", "pick");
      await compare(workspace, mirror);
      await workspace.git.revert({ source: "HEAD" });
      mirror.git("revert", "--no-edit", "HEAD");
      await compare(workspace, mirror);

      await workspace.git.branch({ name: "replay", checkout: true });
      mirror.git("checkout", "-q", "-b", "replay");
      writeBoth(workspace, mirror, "replay.txt", "replay\n");
      await workspace.git.add({ paths: ["replay.txt"] });
      await workspace.git.commit({ message: "replay" });
      mirror.git("add", "--", "replay.txt");
      mirror.git("commit", "-q", "-m", "replay");
      await workspace.git.checkout({ ref: "main" });
      mirror.git("checkout", "-q", "main");
      writeBoth(workspace, mirror, "main-2.txt", "main two\n");
      await workspace.git.add({ paths: ["main-2.txt"] });
      await workspace.git.commit({ message: "main two" });
      mirror.git("add", "--", "main-2.txt");
      mirror.git("commit", "-q", "-m", "main two");
      await workspace.git.checkout({ ref: "replay" });
      mirror.git("checkout", "-q", "replay");
      await workspace.git.rebase({ upstream: "main" });
      mirror.git("rebase", "-q", "main");
      await compare(workspace, mirror);

      writeBoth(workspace, mirror, "replay.txt", "dirty\n");
      await workspace.git.reset({ hard: true });
      mirror.git("reset", "-q", "--hard");
      writeBoth(workspace, mirror, "untracked/entry.txt", "untracked\n");
      await workspace.git.clean({ directories: true });
      mirror.git("clean", "-q", "-f", "-d");
      await compare(workspace, mirror);

      await workspace.git.worktreeAdd({
        root: "/linked",
        target: { kind: "detached", startPoint: "HEAD" },
      });
      mirror.git("worktree", "add", "-q", "--detach", linkedMirror, "HEAD");
      expect(await workspace.git.revParse({ dir: "/linked", ref: "HEAD" })).toBe(
        new GitFixture(linkedMirror).git("rev-parse", "HEAD"),
      );
      expect(readFileSync(join(fixture.root, "linked/base.txt"), "utf8")).toBe("base\n");
      await workspace.git.worktreeRemove({ root: "/linked" });
      mirror.git("worktree", "remove", linkedMirror);
      expect(workspace.drive.stat("/linked")).toBeNull();
    } finally {
      workspace.close();
      mirror.dispose();
      rmSync(linkedMirror, { force: true, recursive: true });
      fixture.dispose();
    }
  });
  it("treats every symlinked .gitignore as absent, exactly as Git does", async () => {
    const topologies = {
      "in-root": "sub/rules",
      dangling: "nowhere/rules",
      escaping: "../outside/rules",
    };
    for (const [name, target] of Object.entries(topologies)) {
      const fixture = localFixture();
      const mirrorRoot = join(fixture.base, "mirror");
      mkdirSync(mirrorRoot);
      mkdirSync(join(fixture.base, "outside"));
      writeFileSync(join(fixture.base, "outside", "rules"), "ignored.txt\n");
      const mirror = new GitFixture(mirrorRoot).init();
      const workspace = fixture.workspace({
        now: () => FIXED_TIME,
        timezoneOffset: () => 0,
        defaultGitIdentity: IDENTITY,
      });
      try {
        await workspace.git.init();
        for (const dir of [workspace.root, mirror.dir]) {
          mkdirSync(join(dir, "sub"));
          writeFileSync(join(dir, "sub", "rules"), "ignored.txt\n");
          writeFileSync(join(dir, "ignored.txt"), "ignored\n");
          writeFileSync(join(dir, "visible.txt"), "visible\n");
          symlinkSync(target, join(dir, ".gitignore"));
        }
        const status = await workspace.git.runCli({ argv: ["status", "--porcelain=v2"], cwd: "/" });
        expect(status.exitCode, `${name} status`).toBe(0);
        expect(status.stdout.trimEnd()).toBe(mirror.git("status", "--porcelain=v2"));
        await workspace.git.add({ paths: ["."] });
        mirror.git("add", "--", ".");
        const staged = await workspace.git.runCli({
          argv: ["status", "--porcelain=v2"],
          cwd: "/",
        });
        expect(staged.stdout.trimEnd()).toBe(mirror.git("status", "--porcelain=v2"));
      } finally {
        workspace.close();
        mirror.dispose();
        fixture.dispose();
      }
    }
  });

  it("rebases a symlink change the way Git does", async () => {
    const fixture = localFixture();
    const mirror = new GitFixture().init();
    const workspace = fixture.workspace({
      now: () => FIXED_TIME,
      timezoneOffset: () => 0,
      defaultGitIdentity: IDENTITY,
    });
    const linkBoth = (target: string): void => {
      for (const dir of [workspace.root, mirror.dir]) {
        rmSync(join(dir, "link"), { force: true });
        symlinkSync(target, join(dir, "link"));
      }
    };
    try {
      await workspace.git.init();
      writeBoth(workspace, mirror, "base.txt", "base\n");
      linkBoth("base.txt");
      await workspace.git.add({ paths: ["."] });
      await workspace.git.commit({ message: "base" });
      mirror.git("add", "--", ".");
      mirror.git("commit", "-q", "-m", "base");

      await workspace.git.branch({ name: "feature", checkout: true });
      mirror.git("checkout", "-q", "-b", "feature");
      writeBoth(workspace, mirror, "feature.txt", "feature\n");
      linkBoth("feature.txt");
      await workspace.git.add({ paths: ["."] });
      await workspace.git.commit({ message: "relink" });
      mirror.git("add", "--", ".");
      mirror.git("commit", "-q", "-m", "relink");

      await workspace.git.checkout({ ref: "main" });
      mirror.git("checkout", "-q", "main");
      writeBoth(workspace, mirror, "main.txt", "main\n");
      await workspace.git.add({ paths: ["main.txt"] });
      await workspace.git.commit({ message: "main" });
      mirror.git("add", "--", "main.txt");
      mirror.git("commit", "-q", "-m", "main");

      await workspace.git.checkout({ ref: "feature" });
      mirror.git("checkout", "-q", "feature");
      await workspace.git.rebase({ upstream: "main" });
      mirror.git("rebase", "-q", "main");
      expect(readlinkSync(join(workspace.root, "link"))).toBe(
        readlinkSync(join(mirror.dir, "link")),
      );
      await compare(workspace, mirror);
    } finally {
      workspace.close();
      mirror.dispose();
      fixture.dispose();
    }
  });
});
