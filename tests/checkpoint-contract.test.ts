import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitFixture } from "./helpers/git.js";

const ZERO_OID = "0".repeat(40);

describe("real Git checkpoint contract", () => {
  it("pins typed peeling, path resolution, and quiet absence", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("root.txt", "first\n").write("dir/file.txt", "nested\n");
      const first = fixture.commit("first");
      fixture.write("root.txt", "second\n");
      fixture.commit("second");
      fixture.write("root.txt", "third\n");
      const third = fixture.commit("third");
      fixture.git("tag", "-a", "v1", "-m", "v1", third);
      fixture.git("tag", "light", third);

      const tag = fixture.git("rev-parse", "v1");
      expect(fixture.git("rev-parse", "v1^{}")).toBe(third);
      expect(fixture.git("rev-parse", "v1^{commit}")).toBe(third);
      expect(fixture.git("rev-parse", "v1^{tree}")).toBe(
        fixture.git("rev-parse", `${third}^{tree}`),
      );
      expect(fixture.git("rev-parse", "v1^{tag}")).toBe(tag);
      expect(fixture.git("rev-parse", "light^{}")).toBe(third);
      expect(fixture.git("rev-parse", "light^{commit}")).toBe(third);
      expect(fixture.git("rev-parse", "v1^{}~2^{tree}")).toBe(
        fixture.git("rev-parse", `${first}^{tree}`),
      );

      const directory = fixture.git("rev-parse", "HEAD:dir");
      const file = fixture.git("rev-parse", "HEAD:dir/file.txt");
      expect(fixture.git("cat-file", "-t", directory)).toBe("tree");
      expect(fixture.git("cat-file", "-t", file)).toBe("blob");
      expect(fixture.git("ls-tree", "HEAD", "dir")).toContain(`tree ${directory}\tdir`);
      expect(fixture.git("ls-tree", "HEAD", "dir/file.txt")).toContain(
        `blob ${file}\tdir/file.txt`,
      );

      const phantom = "f".repeat(40);
      expect(fixture.gitResult("rev-parse", "--verify", "--quiet", phantom)).toEqual({
        status: 0,
        stdout: phantom,
        stderr: "",
      });
      for (const expression of ["missing", `${phantom}^{}`, "HEAD:absent.txt"]) {
        expect(fixture.gitResult("rev-parse", "--verify", "--quiet", expression)).toEqual({
          status: 1,
          stdout: "",
          stderr: "",
        });
      }
      const mismatch = fixture.gitResult("rev-parse", "--verify", "--quiet", "HEAD^{blob}");
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toBe("");
      expect(mismatch.stderr).toContain("expected blob type");
      expect(fixture.gitResult("rev-parse", "--verify", "HEAD^{bogus}").status).not.toBe(0);
      expect(fixture.gitResult("rev-parse", "--verify", "light^{tag}").status).not.toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it("pins expected-old ref updates, deletion, and symbolic boundaries", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("tracked.txt", "base\n");
      const base = fixture.commit("base");
      fixture.write("tracked.txt", "next\n");
      const next = fixture.commit("next");
      const probe = "refs/heads/probe";

      expect(fixture.gitResult("update-ref", probe, base, ZERO_OID).status).toBe(0);
      expect(fixture.git("rev-parse", probe)).toBe(base);
      expect(fixture.gitResult("update-ref", probe, next, ZERO_OID).status).not.toBe(0);
      expect(fixture.git("rev-parse", probe)).toBe(base);
      expect(fixture.gitResult("update-ref", probe, next, base).status).toBe(0);
      expect(fixture.git("rev-parse", probe)).toBe(next);

      expect(fixture.gitResult("update-ref", "-d", probe, base).status).not.toBe(0);
      expect(fixture.git("rev-parse", probe)).toBe(next);
      expect(fixture.gitResult("update-ref", "-d", probe, next).status).toBe(0);
      expect(fixture.gitResult("show-ref", "--verify", "--quiet", probe).status).toBe(1);
      expect(fixture.gitResult("update-ref", "-d", probe).status).toBe(0);

      fixture.git("update-ref", "refs/heads/main", base);
      expect(fixture.gitResult("update-ref", "HEAD", next, base).status).toBe(0);
      expect(fixture.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(next);
      expect(fixture.gitResult("update-ref", "--no-deref", "HEAD", base).status).toBe(0);
      expect(fixture.gitResult("symbolic-ref", "--quiet", "HEAD").status).toBe(1);
      expect(fixture.git("rev-parse", "HEAD")).toBe(base);

      fixture.git("symbolic-ref", "refs/heads/alias", "refs/heads/main");
      expect(fixture.gitResult("update-ref", "refs/heads/alias", base, next).status).toBe(0);
      expect(fixture.git("symbolic-ref", "refs/heads/alias")).toBe("refs/heads/main");
      expect(fixture.git("rev-parse", "refs/heads/main")).toBe(base);
      expect(fixture.gitResult("update-ref", "--no-deref", "refs/heads/alias", next).status).toBe(
        0,
      );
      expect(fixture.gitResult("symbolic-ref", "--quiet", "refs/heads/alias").status).toBe(1);
      expect(fixture.git("rev-parse", "refs/heads/alias")).toBe(next);
    } finally {
      fixture.dispose();
    }
  });

  it("pins all merge bases and recursive gitlink output", () => {
    const fixture = new GitFixture().init();
    try {
      fixture.write("base.txt", "base\n");
      const base = fixture.commit("base");

      fixture.git("checkout", "-q", "-b", "left", base);
      fixture.write("left.txt", "left\n");
      const left = fixture.commit("left");

      fixture.git("checkout", "-q", "-b", "right", base);
      fixture.write("nested/right.txt", "right\n");
      const right = fixture.commit("right");

      const leftTree = fixture.git("rev-parse", `${left}^{tree}`);
      const rightTree = fixture.git("rev-parse", `${right}^{tree}`);
      const leftMerge = fixture.gitInput(
        "left merge\n",
        "commit-tree",
        leftTree,
        "-p",
        left,
        "-p",
        right,
      );
      const rightMerge = fixture.gitInput(
        "right merge\n",
        "commit-tree",
        rightTree,
        "-p",
        right,
        "-p",
        left,
      );
      expect(fixture.git("merge-base", "--all", leftMerge, rightMerge).split("\n").sort()).toEqual(
        [left, right].sort(),
      );

      const emptyTree = fixture.writeObject("tree", new Uint8Array(0));
      const unrelated = fixture.gitInput("unrelated\n", "commit-tree", emptyTree);
      expect(fixture.gitResult("merge-base", "--all", leftMerge, unrelated)).toEqual({
        status: 1,
        stdout: "",
        stderr: "",
      });

      const scratchIndex = join(fixture.dir, "recursive.index");
      const environment = { GIT_INDEX_FILE: scratchIndex };
      fixture.gitWithEnv(environment, "read-tree", right);
      fixture.gitWithEnv(
        environment,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${left},vendor/module`,
      );
      const tree = fixture.gitWithEnv(environment, "write-tree");
      const rows = fixture.git("ls-tree", "-r", "--full-tree", tree).split("\n");
      expect(rows).toContain(`160000 commit ${left}\tvendor/module`);
      expect(rows.some((row) => row.endsWith("\tnested/right.txt"))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("pins clean and conflicted index-only snapshot replay", () => {
    const fixture = new GitFixture().init();
    try {
      fixture
        .write("local.txt", "base local\n")
        .write("upstream.txt", "base upstream\n")
        .write("conflict.txt", "base conflict\n");
      const base = fixture.commit("base");

      fixture.git("checkout", "-q", "-b", "snapshot-clean", base);
      fixture.write("local.txt", "snapshot local\n");
      const snapshotClean = fixture.commit("snapshot clean");
      fixture.git("checkout", "-q", "-b", "tip-clean", base);
      fixture.write("upstream.txt", "tip upstream\n");
      const tipClean = fixture.commit("tip clean");

      const cleanIndex = join(fixture.dir, "snapshot-clean.index");
      const cleanEnvironment = { GIT_INDEX_FILE: cleanIndex };
      fixture.gitWithEnv(cleanEnvironment, "read-tree", tipClean);
      const cleanPatch = fixture.gitBinary("diff", "--binary", "--full-index", base, snapshotClean);
      expect(
        fixture.gitInputResultWithEnv(
          cleanPatch.toString("utf8"),
          cleanEnvironment,
          "apply",
          "--3way",
          "--cached",
        ).status,
      ).toBe(0);
      const cleanTree = fixture.gitWithEnv(cleanEnvironment, "write-tree");
      expect(fixture.git("rev-parse", `${cleanTree}:local.txt`)).toBe(
        fixture.git("rev-parse", `${snapshotClean}:local.txt`),
      );
      expect(fixture.git("rev-parse", `${cleanTree}:upstream.txt`)).toBe(
        fixture.git("rev-parse", `${tipClean}:upstream.txt`),
      );
      expect(readFileSync(join(fixture.dir, "local.txt"), "utf8")).toBe("base local\n");

      fixture.git("checkout", "-q", "-b", "snapshot-conflict", base);
      fixture.write("conflict.txt", "snapshot conflict\n");
      const snapshotConflict = fixture.commit("snapshot conflict");
      fixture.git("checkout", "-q", "-b", "tip-conflict", base);
      fixture.write("conflict.txt", "tip conflict\n");
      const tipConflict = fixture.commit("tip conflict");

      const conflictIndex = join(fixture.dir, "snapshot-conflict.index");
      const conflictEnvironment = { GIT_INDEX_FILE: conflictIndex };
      fixture.gitWithEnv(conflictEnvironment, "read-tree", tipConflict);
      const conflictPatch = fixture.gitBinary(
        "diff",
        "--binary",
        "--full-index",
        base,
        snapshotConflict,
      );
      expect(
        fixture.gitInputResultWithEnv(
          conflictPatch.toString("utf8"),
          conflictEnvironment,
          "apply",
          "--3way",
          "--cached",
        ).status,
      ).not.toBe(0);

      const stages = fixture
        .gitWithEnv(conflictEnvironment, "ls-files", "--stage", "conflict.txt")
        .split("\n")
        .map((row) => row.split(/[ \t]/u));
      expect(stages).toEqual([
        ["100644", fixture.git("rev-parse", `${base}:conflict.txt`), "1", "conflict.txt"],
        ["100644", fixture.git("rev-parse", `${tipConflict}:conflict.txt`), "2", "conflict.txt"],
        [
          "100644",
          fixture.git("rev-parse", `${snapshotConflict}:conflict.txt`),
          "3",
          "conflict.txt",
        ],
      ]);
    } finally {
      fixture.dispose();
    }
  });
});
