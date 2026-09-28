import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  comparePaths,
  gitBasename,
  gitParentPath,
  gitPathDepth,
  isCanonicalAbsolutePath,
  isCanonicalGitPath,
  isNestedPath,
  isPathRoot,
  joinPath,
  lowerBoundPath,
  normalizePath,
  relativePath,
  splitPath,
} from "../packages/git/src/common/paths.js";

describe("git path kit", () => {
  it("normalizes, joins, splits, and walks ancestors", () => {
    expect(normalizePath("repo/./src/../test.ts")).toBe("/repo/test.ts");
    expect(joinPath("/repo/", "packages/do/src/index.ts")).toBe("/repo/packages/do/src/index.ts");
    expect(splitPath("/repo/packages/do/src/index.ts")).toEqual([
      "repo",
      "packages",
      "do",
      "src",
      "index.ts",
    ]);
    expect(relativePath("/repo/packages/do/src", "/repo/packages/do/src/index.ts")).toBe(
      "index.ts",
    );
    expect(relativePath("/repo/packages/do/src", "/repo/README.md")).toBe("../../../README.md");
    expect(relativePath("/repo/packages/do/src", "/repo/packages/do/src")).toBe(".");
    expect(ancestorsOf("/repo/packages/do/src/index.ts")).toEqual([
      "/repo/packages/do/src",
      "/repo/packages/do",
      "/repo/packages",
      "/repo",
      "/",
    ]);
  });

  it("checks canonical paths and component boundaries", () => {
    expect(isCanonicalAbsolutePath("/repo/nested")).toBe(true);
    expect(isCanonicalAbsolutePath("/repo/../nested")).toBe(false);
    expect(isCanonicalGitPath("repo/nested")).toBe(true);
    expect(isCanonicalGitPath("repo//nested")).toBe(false);
    expect(isPathRoot("/repo", "/repo/nested/file")).toBe(true);
    expect(isPathRoot("/repo", "/repository/file")).toBe(false);
    expect(isNestedPath("/repo", "/repo/nested")).toBe(true);
    expect(isNestedPath("/repo", "/repo")).toBe(false);
  });

  it("walks relative Git paths from the root", () => {
    expect(["", "top", "a/b/c.txt"].map(gitParentPath)).toEqual(["", "", "a/b"]);
    expect(["", "top", "a/b/c.txt"].map(gitBasename)).toEqual(["", "top", "c.txt"]);
    expect(["", "top", "a/b/c.txt"].map(gitPathDepth)).toEqual([0, 1, 3]);
  });

  it("finds the lower bound in Git byte order", () => {
    const ordered = ["a", "a/b", "a\uffff", "a\u{1F600}", "b"];
    expect([...ordered].sort(comparePaths)).toEqual(ordered);
    expect(lowerBoundPath(ordered, "a/")).toBe(1);
    expect(lowerBoundPath(ordered, "a\u{1F600}")).toBe(3);
    expect(lowerBoundPath(ordered, "c")).toBe(5);
    expect(lowerBoundPath([], "a")).toBe(0);
  });

  it("re-exports Git's UTF-8 byte ordering", () => {
    expect(comparePaths("\u{10000}", "\u{e000}")).toBeGreaterThan(0);
  });
});
