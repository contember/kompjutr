import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  comparePaths,
  isCanonicalAbsolutePath,
  isCanonicalGitPath,
  isNestedPath,
  isPathRoot,
  joinPath,
  normalizePath,
  relativePath,
  splitPath,
} from "../src/git/common/paths.js";

describe("git path kit", () => {
  it("normalizes, joins, splits, and walks ancestors", () => {
    expect(normalizePath("repo/./src/../test.ts")).toBe("/repo/test.ts");
    expect(joinPath("/repo/", "src/index.ts")).toBe("/repo/src/index.ts");
    expect(splitPath("/repo/src/index.ts")).toEqual(["repo", "src", "index.ts"]);
    expect(relativePath("/repo/src", "/repo/src/index.ts")).toBe("index.ts");
    expect(relativePath("/repo/src", "/repo/README.md")).toBe("../README.md");
    expect(relativePath("/repo/src", "/repo/src")).toBe(".");
    expect(ancestorsOf("/repo/src/index.ts")).toEqual(["/repo/src", "/repo", "/"]);
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

  it("re-exports Git's UTF-8 byte ordering", () => {
    expect(comparePaths("\u{10000}", "\u{e000}")).toBeGreaterThan(0);
  });
});
