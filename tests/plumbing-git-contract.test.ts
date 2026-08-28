import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitFixture } from "./helpers/git.js";

describe("Git tree and commit plumbing contract", () => {
  it("treats a missing alternate index as empty and round-trips populated tree modes", () => {
    const fixture = new GitFixture().init();
    try {
      const emptyTree = fixture.writeObject("tree", new Uint8Array(0));
      const emptyIndex = join(fixture.dir, "empty.index");
      const scratchIndex = join(fixture.dir, "scratch.index");

      expect(fixture.gitWithEnv({ GIT_INDEX_FILE: emptyIndex }, "write-tree")).toBe(emptyTree);
      fixture.gitWithEnv({ GIT_INDEX_FILE: emptyIndex }, "read-tree", "--empty");
      expect(fixture.gitWithEnv({ GIT_INDEX_FILE: emptyIndex }, "write-tree")).toBe(emptyTree);

      fixture
        .write("plain.txt", "plain\n")
        .writeExecutable("bin/run", "#!/bin/sh\n")
        .symlink("../plain.txt", "links/plain");
      const base = fixture.commit("base");
      const baseTree = fixture.git("rev-parse", `${base}^{tree}`);
      fixture.gitWithEnv({ GIT_INDEX_FILE: scratchIndex }, "read-tree", base);
      expect(fixture.gitWithEnv({ GIT_INDEX_FILE: scratchIndex }, "write-tree")).toBe(baseTree);

      fixture.gitWithEnv(
        { GIT_INDEX_FILE: scratchIndex },
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${base},vendor/module`,
      );
      const staged = fixture.gitWithEnv({ GIT_INDEX_FILE: scratchIndex }, "ls-files", "--stage");
      expect(staged).toContain(`160000 ${base} 0\tvendor/module`);
      const tree = fixture.gitWithEnv({ GIT_INDEX_FILE: scratchIndex }, "write-tree");
      const listing = fixture.git("ls-tree", "-r", tree);
      expect(listing).toContain("100755 blob");
      expect(listing).toContain("120000 blob");
      expect(listing).toContain(`160000 commit ${base}\tvendor/module`);
    } finally {
      fixture.dispose();
    }
  });

  it("refuses write-tree when an alternate index contains unmerged stages", () => {
    const fixture = new GitFixture().init();
    try {
      const scratchIndex = join(fixture.dir, "conflict.index");
      const environment = { GIT_INDEX_FILE: scratchIndex };
      const ancestor = fixture.gitInput("ancestor\n", "hash-object", "-w", "--stdin");
      const ours = fixture.gitInput("ours\n", "hash-object", "-w", "--stdin");
      const theirs = fixture.gitInput("theirs\n", "hash-object", "-w", "--stdin");
      fixture.gitWithEnv(environment, "read-tree", "--empty");
      fixture.gitInputWithEnv(
        [
          `100644 ${ancestor} 1\tconflict.txt`,
          `100644 ${ours} 2\tconflict.txt`,
          `100644 ${theirs} 3\tconflict.txt`,
          "",
        ].join("\n"),
        environment,
        "update-index",
        "--index-info",
      );

      expect(() => fixture.gitWithEnv(environment, "write-tree")).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it("pins reset-with-update behavior for read-tree", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("tracked.txt", "base\n");
      fixture.commit("base");
      fixture.write("tracked.txt", "dirty\n");

      expect(() => fixture.git("read-tree", "-u")).toThrow();
      fixture.git("read-tree", "--reset", "-u", "HEAD");
      expect(readFileSync(join(fixture.dir, "tracked.txt"), "utf8")).toBe("base\n");
    } finally {
      fixture.dispose();
    }
  });

  it("preserves exact messages and validates zero, one, and two-parent commits", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("tracked.txt", "base\n");
      const base = fixture.commit("base");
      const tree = fixture.git("rev-parse", `${base}^{tree}`);
      const exactMessage = "  leading\n\ntrailing  ";
      const root = fixture.gitInput(exactMessage, "commit-tree", tree);
      const rootBody = Buffer.from(fixture.catFile(root)).toString("utf8");
      expect(rootBody.slice(rootBody.indexOf("\n\n") + 2)).toBe(exactMessage);

      const child = fixture.gitInput("child\n", "commit-tree", tree, "-p", root);
      const merge = fixture.gitInput("merge\n", "commit-tree", tree, "-p", root, "-p", child);
      const mergeParents = fixture
        .git("cat-file", "-p", merge)
        .split("\n")
        .filter((line) => line.startsWith("parent "));
      expect(mergeParents).toEqual([`parent ${root}`, `parent ${child}`]);

      const duplicate = fixture.gitInput(
        "duplicate\n",
        "commit-tree",
        tree,
        "-p",
        root,
        "-p",
        root,
      );
      expect(
        fixture
          .git("cat-file", "-p", duplicate)
          .split("\n")
          .filter((line) => line.startsWith("parent ")),
      ).toEqual([`parent ${root}`]);

      const blob = fixture.gitInput("blob\n", "hash-object", "-w", "--stdin");
      expect(() => fixture.gitInput("invalid\n", "commit-tree", blob)).toThrow();
      expect(() => fixture.gitInput("invalid\n", "commit-tree", "f".repeat(40))).toThrow();
      expect(() => fixture.gitInput("invalid\n", "commit-tree", tree, "-p", blob)).toThrow();
    } finally {
      fixture.dispose();
    }
  });
});
