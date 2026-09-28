// `patch` against GNU patch 2.8 through Bash. Each case runs twice on a fresh
// tree: once ending in `patch`, so its stdout, stderr, and exit status
// compare, and once followed by `cat` and `ls`, so the patched files,
// backups, and rejects compare too. Bash runs patch without a terminal, so
// every question GNU asks takes its default answer on both sides. The
// inspection ends in `echo`, because uutils `cat` and ours disagree on the
// status for several missing operands, which is not what this suite pins.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { DEFAULT_LIMITS } from "../../packages/do/src/shell/exec/context.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const LINES = Array.from({ length: 30 }, (_, index) => `${index + 1}\n`).join("");

const TREE: ShellTree = {
  "src/a.txt": "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  "src/b.txt": "alpha\nbeta\ngamma\n",
  "nums.txt": LINES,
  "nonl.txt": "first\nlast",
};

async function compare(command: string, diff: string, inspect: string, tree = TREE): Promise<void> {
  const script = `${command} <<'EOF'\n${diff}EOF\n`;
  agreeWithBash(await compareWithBash(script, { tree }));
  agreeWithBash(await compareWithBash(`${script}${inspect}\necho end\n`, { tree }));
}

const A_CHANGE = `--- a/src/a.txt
+++ b/src/a.txt
@@ -2,3 +2,3 @@
 two
-three
+THREE
 four
@@ -8,3 +8,4 @@
 eight
 nine
+nine and a half
 ten
`;

const B_CHANGE = `--- a/src/b.txt
+++ b/src/b.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`;

describe("the patch parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("patch matches GNU patch", () => {
  it.each([
    ["patch -p1", A_CHANGE, "cat src/a.txt; ls src"],
    ["patch -p1", `${A_CHANGE}${B_CHANGE}`, "cat src/a.txt src/b.txt; ls src"],
    ["patch --strip=1", B_CHANGE, "cat src/b.txt"],
    ["patch -p 1 -s", `${A_CHANGE}${B_CHANGE}`, "cat src/a.txt src/b.txt"],
    ["cd src && patch -p2", A_CHANGE, "cat a.txt"],
    ["patch", B_CHANGE.replaceAll("a/src/", "").replaceAll("b/src/", "src/"), "ls src"],
    [
      "patch -p0",
      B_CHANGE.replaceAll("a/src/", "src/").replaceAll("b/src/", "src/"),
      "cat src/b.txt",
    ],
    ["patch -d src -p2", B_CHANGE, "cat src/b.txt"],
    ["patch -p1 src/b.txt", B_CHANGE, "cat src/b.txt"],
  ])("applies exactly: %s", async (command, diff, inspect) => {
    await compare(command, diff, inspect);
  });

  const shifted = `--- nums.txt
+++ nums.txt
@@ -5,7 +5,7 @@
 5
 6
 7
-8
+EIGHT
 9
 10
 11
@@ -20,7 +20,7 @@
 20
 21
 22
-23
+TWENTY-THREE
 23c
 24
 25
`;
  const offsetTree: ShellTree = {
    ...TREE,
    "nums.txt": `0a\n0b\n0c\n${LINES.replace("23\n", "23\n23b\n")}`,
  };

  it.each([
    ["patch", shifted, "cat nums.txt; ls"],
    ["patch --no-backup-if-mismatch", shifted, "ls"],
    ["patch -s", shifted, "ls"],
  ])("finds a hunk at an offset and fails another: %s", async (command, diff, inspect) => {
    await compare(command, diff, `${inspect}; cat nums.txt.rej`, offsetTree);
  });

  it.each([
    ["one line earlier", LINES.replace("2\n", "")],
    ["three lines earlier", LINES.replace("1\n2\n3\n", "")],
    ["one line later", `0\n${LINES}`],
  ])("reports offsets in both directions: %s", async (_, nums) => {
    const twice = shifted.replace(" 23c", " 23b");
    await compare(
      "patch",
      `${twice}${twice.replaceAll("EIGHT", "8!").replace("-8\n", "-EIGHT\n")}`,
      "cat nums.txt; ls",
      {
        ...TREE,
        "nums.txt": nums.replace("23\n", "23\n23b\n"),
      },
    );
  });

  const fuzzy = `--- nums.txt
+++ nums.txt
@@ -10,7 +10,7 @@
 10
 11
 12
-13
+THIRTEEN
 14
 15
 16
`;
  it.each([
    ["one context line changed at each end", { "nums.txt": LINES.replace("10\n", "X\n") }, "patch"],
    [
      "two context lines changed",
      { "nums.txt": LINES.replace("10\n", "X\n").replace("11\n", "Y\n") },
      "patch",
    ],
    ["fuzz with an offset", { "nums.txt": `0\n${LINES.replace("16\n", "Z\n")}` }, "patch"],
    [
      "fuzz limited by -F1",
      { "nums.txt": LINES.replace("10\n", "X\n").replace("11\n", "Y\n") },
      "patch -F1",
    ],
    ["fuzz refused by --fuzz=0", { "nums.txt": LINES.replace("16\n", "Z\n") }, "patch --fuzz=0"],
    [
      "too much drift",
      { "nums.txt": LINES.replace("10\n", "X\n").replace("11\n", "Y\n").replace("12\n", "W\n") },
      "patch",
    ],
  ])("applies with fuzz: %s", async (_, tree, command) => {
    await compare(command, fuzzy, "ls; cat nums.txt; cat nums.txt.rej", tree);
  });

  const applied = { ...TREE, "src/b.txt": "alpha\nBETA\ngamma\n" };
  it.each([
    "patch -p1",
    "patch -p1 -N",
    "patch -p1 --forward",
    "patch -p1 -t",
    "patch -p1 -f",
    "patch -p1 -s",
    "patch -p1 -R",
    "patch -p1 -R -t",
    "patch -p1 -R -N",
    "patch -p1 --dry-run",
    "patch -p1 -t --dry-run",
  ])("detects a reversed patch: %s", async (command) => {
    await compare(command, B_CHANGE, "cat src/b.txt; ls src; cat src/b.txt.rej", applied);
  });

  it.each([
    "patch -p1 -R",
    "patch -p1 -R -t",
    "patch -p1 -R -N",
    "patch -p1 -R -f",
    "patch -p1 -R --dry-run",
  ])("detects an unreversed patch: %s", async (command) => {
    await compare(command, B_CHANGE, "cat src/b.txt; ls src; cat src/b.txt.rej", TREE);
  });

  it.each([
    ["patch -p1 -R", applied],
    ["patch -p1 --reverse --dry-run", applied],
    ["patch -p1 --dry-run", TREE],
  ])("reverses and dry-runs: %s", async (command, tree) => {
    await compare(command, B_CHANGE, "cat src/b.txt; ls src", tree);
  });

  const gitCreateDelete = `diff --git a/new/dir/n.txt b/new/dir/n.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new/dir/n.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/b.txt b/src/b.txt
deleted file mode 100644
index 1111111..0000000
--- a/src/b.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-alpha
-beta
-gamma
`;
  const plainCreateDelete = `--- /dev/null
+++ b/created.txt
@@ -0,0 +1 @@
+made
--- a/src/b.txt	2020-01-01 00:00:00.000000000 +0000
+++ /dev/null	1970-01-01 00:00:00.000000000 +0000
@@ -1,3 +0,0 @@
-alpha
-beta
-gamma
`;
  it.each([
    ["patch -p1", gitCreateDelete],
    ["patch -p1 --dry-run", gitCreateDelete],
    ["patch -p1 -R", gitCreateDelete],
    ["patch -p1", plainCreateDelete],
    ["patch -p1 -R", plainCreateDelete],
  ])("creates and deletes files: %s", async (command, diff) => {
    await compare(command, diff, "ls; ls src; cat new/dir/n.txt created.txt");
  });

  it.each([
    [
      "git",
      "diff --git a/src/b.txt b/src/b.txt\ndeleted file mode 100644\nindex 1..0000000\n",
      "diff --git a/src/b.txt b/src/b.txt\nnew file mode 100644\nindex 0000000..2\n",
    ],
    ["plain", "", ""],
  ])("deletes and recreates one file in a %s diff", async (_, deleting, creating) => {
    const diff = `${deleting}--- a/src/b.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-alpha\n-beta\n-gamma\n${creating}--- /dev/null\n+++ b/src/b.txt\n@@ -0,0 +1 @@\n+reborn\n`;
    await compare("patch -p1", diff, "ls src; cat src/b.txt");
  });

  it("applies a patch twice and refuses to recreate or re-delete", async () => {
    await compare(
      `patch -p1 <<'EOF'\n${gitCreateDelete}EOF\npatch -p1`,
      gitCreateDelete,
      "ls; ls src; cat new/dir/n.txt",
    );
  });

  it.each([
    ["patch -p1", "src/c.txt"],
    ["patch -p1 -E", "src/c.txt"],
    ["patch -p1", "src/d.txt"],
  ])("empties or keeps a file: %s %s", async (command, file) => {
    const emptied = `--- a/${file}\n+++ b/${file}\n@@ -1 +0,0 @@\n-only\n`;
    const deleted = `--- a/${file}\n+++ /dev/null\n@@ -1 +0,0 @@\n-only\n`;
    await compare(command, file === "src/c.txt" ? emptied : deleted, "ls src; cat src/d.txt", {
      ...TREE,
      "src/c.txt": "only\n",
      "src/d.txt": "only\nmore\n",
    });
  });

  it.each([
    [
      "removes the final newline",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -2,2 +2,2 @@\n beta\n-gamma\n+gamma\n\\ No newline at end of file\n",
      "src/b.txt",
    ],
    [
      "adds a final newline",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -1,2 +1,2 @@\n first\n-last\n\\ No newline at end of file\n+last\n",
      "nonl.txt",
    ],
    [
      "changes an incomplete line",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -1,2 +1,2 @@\n first\n-last\n\\ No newline at end of file\n+LAST\n\\ No newline at end of file\n",
      "nonl.txt",
    ],
    [
      "appends after an incomplete line",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -2,0 +3 @@\n+extra\n",
      "nonl.txt",
    ],
    [
      "rejects an incomplete line",
      "--- a/nonl.txt\n+++ b/nonl.txt\n@@ -1,2 +1,2 @@\n first\n-other\n\\ No newline at end of file\n+x\n\\ No newline at end of file\n",
      "nonl.txt nonl.txt.rej",
    ],
  ])("keeps missing final newlines: %s", async (_, diff, files) => {
    await compare("patch -p1", diff, `cat -A ${files}`);
  });

  it.each([
    [
      "commentary before the header",
      `This change renames a thing.\n\nSigned-off: nobody\n${B_CHANGE}`,
    ],
    [
      "an email with a git header",
      `From 123 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] x\n\n---\n src/b.txt | 2 +-\n\ndiff --git a/src/b.txt b/src/b.txt\nindex 1..2 100644\n${B_CHANGE}-- \n2.40.0\n`,
    ],
    ["comments and trailing text", `# a comment\n${B_CHANGE}# another\ntrailing words\n`],
    ["a hunk with a function heading", B_CHANGE.replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,3 @@ fn()")],
  ])("skips text around patches: %s", async (_, diff) => {
    await compare("patch -p1", diff, "cat src/b.txt");
  });

  it.each([
    ["only garbage", "nothing to see\nhere\n"],
    ["a missing line number", "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -x +1 @@\n a\n"],
    ["a bad hunk line", "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n?beta\n"],
    [
      "a truncated hunk",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,8 +1,8 @@\n alpha\n-beta\n+BETA\n",
    ],
    [
      "chopped trailing blank context",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,4 +1,4 @@\n alpha\n-beta\n+BETA\n gamma\n",
    ],
    [
      "too many lines",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n+more\n gamma\n",
    ],
    [
      "a malformed second file after a good one",
      `${A_CHANGE}--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,2 +1,2 @@\n alpha\n!beta\n`,
    ],
    ["a header without hunks", "--- a/src/b.txt\n+++ b/src/b.txt\n"],
    ["an empty input", ""],
  ])("diagnoses malformed input: %s", async (_, diff) => {
    await compare("patch -p1", diff, "cat src/a.txt src/b.txt; ls src");
  });

  it.each([
    ["an unterminated last line", `${B_CHANGE}trailing`],
    ["an unterminated hunk line", B_CHANGE.slice(0, -1)],
    ["an unterminated header", "--- a/src/b.txt"],
    ["a NUL byte in the commentary", `note\0\n${B_CHANGE}`],
    ["a NUL byte in a hunk", B_CHANGE.replace("BETA", "BE\0TA")],
    ["CRLF line endings", B_CHANGE.replaceAll("\n", "\r\n")],
    ["an indented patch", B_CHANGE.replaceAll(/^/gm, "  ")],
  ])("reads raw input: %s", async (_, diff) => {
    const tree = { ...TREE, "change.diff": diff };
    const script = "patch -p1 < change.diff";
    agreeWithBash(await compareWithBash(script, { tree }));
    agreeWithBash(await compareWithBash(`${script}\ncat -A src/b.txt\n`, { tree }));
  });

  it.each(["patch", "patch -p2", "patch -p1 -t", "patch -p1 -f", "patch -p1 -s"])(
    "reports a file it cannot find: %s",
    async (command) => {
      const missing = `Some text\n--- a/nowhere/x.txt\n+++ b/nowhere/x.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n${B_CHANGE}`;
      await compare(command, missing, "cat src/b.txt; ls; ls src");
    },
  );

  const renames = `diff --git a/src/a.txt b/moved/a.txt
similarity index 90%
rename from src/a.txt
rename to moved/a.txt
index 1..2 100644
--- a/src/a.txt
+++ b/moved/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/src/b.txt b/copy.txt
similarity index 100%
copy from src/b.txt
copy to copy.txt
diff --git a/nonl.txt b/nonl.txt
old mode 100644
new mode 100755
`;
  it.each(["patch -p1", "patch -p1 --dry-run"])(
    "follows git renames, copies, and modes: %s",
    async (command) => {
      await compare(
        command,
        renames,
        "ls; ls src moved; cat moved/a.txt copy.txt; test -x nonl.txt && echo executable",
      );
    },
  );

  it("applies git diffs against the tree as it was", async () => {
    const twice = `diff --git a/src/b.txt b/src/b.txt\nindex 1..2 100644\n${B_CHANGE}diff --git a/src/b.txt b/src/b.txt\nindex 2..3 100644\n${B_CHANGE.replace("-beta\n+BETA", "-BETA\n+Beta")}`;
    await compare("patch -p1", twice, "cat src/b.txt; ls src");
  });

  it.each([
    [
      "quoted git names",
      'diff --git "a/sp ace.txt" "b/sp ace.txt"\nindex 1..2 100644\n--- "a/sp ace.txt"\n+++ "b/sp ace.txt"\n@@ -1 +1 @@\n-x\n+y\n',
      "cat 'sp ace.txt'",
    ],
    [
      "names with spaces before a tab",
      "--- a/sp ace.txt\t2020-01-01 00:00:00.000000000 +0000\n+++ b/sp ace.txt\t2020-01-01 00:00:00.000000000 +0000\n@@ -1 +1 @@\n-x\n+y\n",
      "cat 'sp ace.txt'",
    ],
    [
      "an Index line alone",
      "Index: src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    [
      "an insertion at the top",
      "--- a/src/b.txt\n+++ b/src/b.txt\n@@ -0,0 +1 @@\n+zero\n",
      "cat src/b.txt",
    ],
    [
      "misordered insertions",
      "--- a/nums.txt\n+++ b/nums.txt\n@@ -20,0 +21 @@\n+late\n@@ -5,0 +7 @@\n+early\n",
      "cat nums.txt.rej; cat nums.txt",
    ],
    [
      "CRLF input against an LF patch",
      "--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n",
      "cat -A crlf.txt crlf.txt.rej",
    ],
    [
      "a satisfied Prereq",
      "Prereq: alpha\n--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    [
      "a missing Prereq",
      "Prereq: omega\n--- a/src/b.txt\n+++ b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    ["a dangerous name", "--- a/../outside.txt\n+++ b/../outside.txt\n@@ -1 +1 @@\n-x\n+y\n", "ls"],
    [
      "a dangerous name to create",
      "--- /dev/null\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+new\n",
      "ls",
    ],
    [
      "an Index line with a matching name",
      "Index: b/src/b.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
      "cat src/b.txt",
    ],
    [
      "a creation into an existing file",
      "--- /dev/null\n+++ b/src/b.txt\n@@ -0,0 +1 @@\n+new\n",
      "cat src/b.txt; ls src",
    ],
    [
      "a creation into an empty file",
      "--- /dev/null\n+++ b/empty.txt\n@@ -0,0 +1 @@\n+new\n",
      "cat empty.txt; ls",
    ],
    [
      "a larger fuzz factor",
      "--- a/nums.txt\n+++ b/nums.txt\n@@ -10,7 +10,7 @@\n X\n Y\n Z\n-13\n+THIRTEEN\n 14\n 15\n 16\n",
      "cat nums.txt",
    ],
  ])("reads names and odd forms: %s", async (_, diff, inspect) => {
    const tree = {
      ...TREE,
      "sp ace.txt": "x\n",
      "crlf.txt": "a\r\nb\r\n",
      "empty.txt": "",
    };
    await compare("patch -p1", diff, inspect, tree);
    await compare("patch -p1 -F3 -t", diff, inspect, tree);
  });

  it("reports a git binary patch as GNU does", async () => {
    const binary = `diff --git a/bin.dat b/bin.dat\nindex 1..2 100644\nGIT binary patch\nliteral 3\nKcmZ?\n\nliteral 0\nHcmV?d00001\n\n${B_CHANGE}`;
    await compare("patch -p1", binary, "cat src/b.txt; ls", { ...TREE, "bin.dat": "abc" });
  });

  it.each(["patch -p1 -r all.rej", "patch -p1 --reject-file=- ", "patch -p1 -r all.rej --dry-run"])(
    "collects rejects: %s",
    async (command) => {
      const failing = `${A_CHANGE.replace("-three\n", "-trois\n")}${B_CHANGE.replace("-beta\n", "-bravo\n")}`;
      await compare(command, failing, "ls; ls src; cat all.rej");
    },
  );

  it.each([
    "patch -i change.diff -p1",
    "patch --input=change.diff --strip 1",
    "patch -p1 src/b.txt change.diff",
    "patch -p1 -i missing.diff",
    "patch -p1 -i src",
  ])("reads the patch from a file: %s", async (command) => {
    const tree = { ...TREE, "change.diff": B_CHANGE };
    agreeWithBash(await compareWithBash(`${command}\ncat src/b.txt\n`, { tree }));
    agreeWithBash(await compareWithBash(command, { tree }));
  });

  it.each([
    "patch --bogus",
    "patch -k",
    "patch --re",
    "patch --dry-run=1",
    "patch --strip",
    "patch -p",
    "patch -p x",
    "patch -p -1",
    "patch -F 1x",
    "patch -d nowhere",
    "patch -d nums.txt",
    "patch a b c",
  ])("rejects bad command lines: %s", async (command) => {
    agreeWithBash(await compareWithBash(`${command} </dev/null`, { tree: TREE }));
  });
});

describe.skipIf(!REAL_BASH)("patch matches GNU patch on generated edits", () => {
  // The diff comes from the host's GNU diff; the target drifts from its
  // original by random insertions, deletions, and changes, so offsets, fuzz,
  // reversal, and rejects all occur.
  it("applies drifted patches as GNU does", async () => {
    const random = seeded(11);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const lines = (count: number): string[] =>
      Array.from({ length: count }, () => pick(["a", "b", "c", "d", "e", "f"]));
    const mutate = (source: readonly string[], edits: number): string[] => {
      const out = [...source];
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * (out.length + 1));
        const kind = random();
        if (kind < 0.35) out.splice(at, 0, pick(["x", "y", "z"]));
        else if (kind < 0.7) out.splice(at, 1);
        else out.splice(at, 1, pick(["x", "y", "z"]));
      }
      return out;
    };
    const text = (source: readonly string[], newline: boolean): string =>
      source.length === 0 ? "" : `${source.join("\n")}${newline ? "\n" : ""}`;
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-patch-gen-"));
    try {
      for (let round = 0; round < 40; round++) {
        const original = lines(5 + Math.floor(random() * 40));
        const edited = mutate(original, 1 + Math.floor(random() * 6));
        writeFileSync(join(directory, "a"), text(original, random() < 0.9));
        writeFileSync(join(directory, "b"), text(edited, random() < 0.9));
        const diff = spawnSync("diff", ["-u", "--label", "a/f", "--label", "b/f", "a", "b"], {
          cwd: directory,
          env: { LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
        const drifted = random() < 0.2 ? edited : mutate(original, Math.floor(random() * 4));
        const tree = { f: text(drifted, random() < 0.9), "change.diff": diff.stdout };
        const flags = pick(["-p1", "-p1 -R", "-p1 -F1", "-p1 -N", "-p1 -t", "-p1 -f"]);
        agreeWithBash(await compareWithBash(`patch ${flags} < change.diff`, { tree }));
        agreeWithBash(
          await compareWithBash(
            `patch ${flags} < change.diff; cat -A f; ls; cat -A f.rej; echo end`,
            {
              tree,
            },
          ),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe("patch refusals", () => {
  const encoder = new TextEncoder();

  function shell(files: Readonly<Record<string, string>>, maxRetainedBytes?: number) {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles(
      Object.entries(files).map(([path, text]) => ({
        path: `/repo/${path}`,
        bytes: encoder.encode(text),
      })),
    );
    const limits =
      maxRetainedBytes === undefined ? undefined : { ...DEFAULT_LIMITS, maxRetainedBytes };
    return createShell({ fs, cwd: "/repo", ...(limits === undefined ? {} : { limits }) });
  }

  it.each([
    ["-b", "-b"],
    ["-o out.txt", "-o"],
    ["--output=out.txt", "--output"],
    ["-u", "-u"],
    ["-c", "-c"],
    ["--verbose", "--verbose"],
    ["--posix", "--posix"],
    ["--merge", null],
  ])("refuses %s by name", async (flag, name) => {
    const run = await shell({ f: "x\n" }).run(`patch ${flag} </dev/null`);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(
      name === null
        ? "patch: unrecognized option '--merge'\npatch: Try 'patch --help' for more information.\n"
        : `patch: option '${name}' is not supported; supported: -pN, -R, --dry-run, -N, -s, -d DIR, -f, -t, -E, --no-backup-if-mismatch, -F N, -r FILE, -i FILE\n`,
    );
  });

  it.each([
    [
      "a context diff",
      "*** f\n--- f\n***************\n*** 1 ****\n! x\n--- 1 ----\n! y\n",
      "patch",
      "context diffs",
    ],
    ["a normal diff", "1c1\n< x\n---\n> y\n", "patch f", "normal diffs"],
    ["an ed script", "1c\ny\n.\n", "patch f", "ed scripts"],
  ])("refuses %s", async (_, diff, command, kind) => {
    const run = await shell({ f: "x\n", "change.diff": diff }).run(
      `${command} < change.diff; cat f`,
    );
    expect(run.stdout).toBe("x\n");
    expect(run.stderr).toBe(`patch: ${kind} are not supported; use a unified diff\n`);
  });

  it("refuses a patch to a symbolic link", async () => {
    const diff =
      "diff --git a/l b/l\nnew file mode 120000\nindex 0000000..1\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n";
    const run = await shell({ "change.diff": diff }).run("patch -p1 < change.diff; ls");
    expect(run.stdout).toBe("change.diff\n");
    expect(run.stderr).toBe("patch: patches to symbolic links are not supported\n");
  });

  it("fails loudly when the diff exceeds the retained budget", async () => {
    const diff = `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+${"y".repeat(200)}\n`;
    const run = await shell({ f: "x\n", "change.diff": diff }, 128).run(
      "cat change.diff | patch -p1; cat f",
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/^kompjutr: patch input .*retained-memory limit\n$/);
  });
});
