import { afterAll, describe, expect, it } from "vitest";

import { loadIgnoreMatcher } from "../src/core/ignore/index.js";
import { GitFixture } from "./helpers/git.js";
import { makeRepo, writeWorkFile } from "./helpers/workspace.js";

/**
 * Every case is checked against `git check-ignore`, so the oracle is git
 * itself rather than a reading of gitignore(5).
 */
const CASES: { name: string; files: Record<string, string>; paths: string[] }[] = [
  {
    name: "plain names and extensions",
    files: { ".gitignore": "*.log\nbuild\ntemp.txt\n" },
    paths: ["a.log", "deep/b.log", "build", "build/out.js", "temp.txt", "keep.txt", "logs/a.txt"],
  },
  {
    name: "anchoring",
    files: { ".gitignore": "/root-only.txt\ndocs/notes.md\nanywhere.txt\n" },
    paths: [
      "root-only.txt",
      "sub/root-only.txt",
      "docs/notes.md",
      "sub/docs/notes.md",
      "anywhere.txt",
      "sub/anywhere.txt",
    ],
  },
  {
    name: "directory-only patterns",
    files: { ".gitignore": "cache/\n" },
    paths: ["cache", "cache/x.txt", "cache.txt", "sub/cache/y.txt"],
  },
  {
    name: "negation",
    files: { ".gitignore": "*.log\n!keep.log\ndist/\n!dist/important.txt\n" },
    paths: ["a.log", "keep.log", "dist/important.txt", "dist/other.txt"],
  },
  {
    name: "double star",
    files: { ".gitignore": "**/node_modules\nsrc/**/generated\nvendor/**\n" },
    paths: [
      "node_modules",
      "a/b/node_modules",
      "src/generated",
      "src/a/b/generated",
      "vendor/x/y.txt",
      "src/keep.ts",
    ],
  },
  {
    name: "character classes and question marks",
    files: { ".gitignore": "file?.txt\n*.[oa]\n[!x]ignored.txt\n" },
    paths: [
      "file1.txt",
      "file10.txt",
      "main.o",
      "main.a",
      "main.c",
      "yignored.txt",
      "xignored.txt",
    ],
  },
  {
    name: "nested gitignore overrides its parent",
    files: {
      ".gitignore": "*.txt\n",
      "sub/.gitignore": "!allowed.txt\n",
      "other/.gitignore": "*.md\n",
    },
    paths: ["a.txt", "sub/a.txt", "sub/allowed.txt", "other/b.md", "b.md"],
  },
  {
    name: "comments, blanks and escapes",
    files: { ".gitignore": "# a comment\n\n\\#hash.txt\ntrailing   \n" },
    paths: ["#hash.txt", "trailing", "a comment"],
  },
];

const fixtures: GitFixture[] = [];
afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

describe("gitignore", () => {
  for (const testCase of CASES) {
    it(`matches git check-ignore: ${testCase.name}`, () => {
      const fixture = new GitFixture().init();
      fixtures.push(fixture);
      const workspace = makeRepo("/");

      for (const [path, contents] of Object.entries(testCase.files)) {
        fixture.write(path, contents);
        writeWorkFile(workspace, `/${path}`, contents);
      }
      // A path that another path sits under is a directory on both sides;
      // check-ignore classifies directories differently from files.
      for (const path of testCase.paths) {
        const isDirectory = testCase.paths.some((other) => other.startsWith(`${path}/`));
        if (isDirectory) {
          fixture.write(`${path}/.keep`, "");
          workspace.worktree.mkdirp(`/${path}`);
          continue;
        }
        fixture.write(path, "x\n");
        writeWorkFile(workspace, `/${path}`, "x\n");
      }

      const matcher = loadIgnoreMatcher(workspace.worktree, "/");
      for (const path of testCase.paths) {
        const isDirectory = workspace.worktree.stat(`/${path}`)?.type === "directory";
        let expected: boolean;
        try {
          fixture.git("check-ignore", "-q", "--no-index", path);
          expected = true;
        } catch {
          expected = false;
        }
        expect(matcher.ignores(path, isDirectory), `${testCase.name}: ${path}`).toBe(expected);
      }
    });
  }

  it("reads one .gitignore per directory, not one per query", () => {
    const workspace = makeRepo("/");
    writeWorkFile(workspace, "/.gitignore", "*.log\n");
    const matcher = loadIgnoreMatcher(workspace.worktree, "/");
    matcher.ignores("a.log", false);
    workspace.storage.resetCounters();
    for (let i = 0; i < 50; i++) matcher.ignores(`file${i}.log`, false);
    expect(workspace.storage.statementCount).toBe(0);
  });
});
