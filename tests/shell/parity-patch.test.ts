// `patch` against GNU patch 2.8 through Bash. Each case runs twice on a fresh
// tree: once ending in `patch`, so its stdout, stderr, and exit status
// compare, and once followed by `cat` and `ls`, so the patched files,
// backups, and rejects compare too. Bash runs patch without a terminal, so
// every question GNU asks takes its default answer on both sides. The
// inspection ends in `echo`, because uutils `cat` and ours disagree on the
// status for several missing operands, which is not what this suite pins.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { DEFAULT_LIMITS, RetainedBudget } from "../../packages/do/src/shell/exec/context.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";
import { TIMING_GATE } from "../helpers/timing.js";

// The heap check below measures after a forced collection.
setFlagsFromString("--expose-gc");

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

const LINK_FILES: Readonly<Record<string, string>> = {
  "w/in/t.txt": "x\n",
  "w/in2/t.txt": "x\n",
  "outside/t.txt": "x\n",
};
const LINKS: ReadonlyArray<readonly [string, string]> = [
  ["w/out", "../outside"],
  ["w/back", "../w/in"],
  ["w/inl", "in"],
  ["w/in/up", "../in2"],
  ["w/leaf", "../outside/t.txt"],
];

/**
 * The parity harness seeds regular files only and the shell has no `ln` yet,
 * so this compares against GNU patch directly: both trees get the same files
 * and relative symbolic links, then run the same script under `LC_ALL=C`.
 */
async function compareWithLinks(script: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kompjutr-patch-links-"));
  try {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.makeDirectories(["/repo/w/in", "/repo/w/in2", "/repo/outside"]);
    for (const [path, text] of Object.entries(LINK_FILES)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
      fs.writeFiles([
        { path: `/repo/${path}`, bytes: new TextEncoder().encode(text), mode: 0o644 },
      ]);
    }
    for (const [path, target] of LINKS) {
      symlinkSync(target, join(directory, path));
      fs.symlink(target, `/repo/${path}`);
    }
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC", IFS: " \t\n" };
    const bash = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      cwd: directory,
      env,
    });
    const ours = await createShell({ fs, cwd: "/repo" }).exec(script, { env });
    expect(ours.stdout).toEqual(Uint8Array.from(bash.stdout));
    expect(ours.stderr).toEqual(Uint8Array.from(bash.stderr));
    expect(ours.exitCode).toBe(bash.status);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

  it.each(["patch -p1", "patch -p1 --no-backup-if-mismatch"])(
    "backs up a file deleted at an offset: %s",
    async (command) => {
      const diff = "--- a/src/b.txt\n+++ /dev/null\n@@ -2,3 +0,0 @@\n-alpha\n-beta\n-gamma\n";
      await compare(command, diff, "ls src; cat src/b.txt.orig");
    },
  );

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

  it.each([
    ["patch -p1", "modify", "out/t.txt"],
    ["patch -p1", "create", "out/new.txt"],
    ["patch -p1", "create", "out/deeper/new.txt"],
    ["patch -p1 --dry-run", "create", "out/new.txt"],
    ["patch -p1", "modify", "back/t.txt"],
    ["patch -p1", "create", "back/new.txt"],
    ["patch -p1", "modify", "inl/t.txt"],
    ["patch -p1", "create", "inl/new.txt"],
    ["patch -p1", "modify", "in/up/t.txt"],
    ["patch -p1", "create", "in/up/new.txt"],
    ["patch -p1", "modify", "leaf"],
    ["patch -p1", "fail", "out/t.txt"],
    ["patch -p1 out/t.txt", "fail", "out/t.txt"],
  ])("follows symbolic links only inside the tree: %s, %s %s", async (command, action, name) => {
    const header = action === "create" ? "--- /dev/null\n" : `--- a/${name}\n`;
    const body =
      action === "create"
        ? "@@ -0,0 +1 @@\n+y\n"
        : action === "fail"
          ? "@@ -1 +1 @@\n-q\n+y\n"
          : "@@ -1 +1 @@\n-x\n+y\n";
    const script = `cd w && ${command} <<'EOF'\n${header}+++ b/${name}\n${body}EOF\n`;
    const inspect = "ls . in in2 ../outside; cat ../outside/t.txt in/t.txt in2/t.txt; echo end\n";
    await compareWithLinks(script);
    await compareWithLinks(`${script}${inspect}`);
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
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    };
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

describe.skipIf(!REAL_BASH)("patch matches GNU patch on further forms", () => {
  const tree: ShellTree = {
    f: "x\na\nb\na\nb\nx\n",
    g: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
    h: "a\r\nb\r\n",
    "sp ace": "x\n",
  };
  it.each([
    ["an anchored end moved by fuzz", "patch", "--- f\n+++ f\n@@ -3,2 +3,2 @@\n a\n-b\n+B\n"],
    ["an anchored start", "patch", "--- f\n+++ f\n@@ -1,5 +1,5 @@\n x\n-a\n+A\n b\n a\n b\n"],
    [
      "a misordered hunk",
      "patch",
      "--- g\n+++ g\n@@ -6,1 +6,1 @@\n-f\n+F\n@@ -2,1 +2,1 @@\n-c\n+C\n",
    ],
    [
      "a hunk behind the last one",
      "patch",
      "--- g\n+++ g\n@@ -6,1 +6,1 @@\n-f\n+F\n@@ -9,1 +9,1 @@\n-f\n+X\n",
    ],
    [
      "overlapping context",
      "patch -F1",
      "--- g\n+++ g\n@@ -3,3 +3,3 @@\n c\n-d\n+D\n e\n@@ -5,3 +5,3 @@\n e\n-f\n+F\n g\n",
    ],
    ["padded missing context", "patch", "--- g\n+++ g\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n"],
    ["uneven missing context", "patch", "--- g\n+++ g\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n"],
    ["missing old lines", "patch", "--- g\n+++ g\n@@ -1,9 +1,4 @@\n a\n-b\n"],
    ["a NUL byte after a hunk", "patch", "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\0\n"],
    ["a blank context line", "patch", "--- g\n+++ g\n@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n"],
    ["an addition before context", "patch", "--- g\n+++ g\n@@ -1,2 +1,3 @@\n+top\n a\n b\n"],
    ["hunks out of order", "patch", "--- g\n+++ g\n@@ -2 +2 @@\n-b\n+B\n@@ -1 +1 @@\n-a\n+A\n"],
    ["-N quietly", "patch -s -N", "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-B\n+b\n"],
    ["-t quietly", "patch -s -t", "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-B\n+b\n"],
    [
      "-t for a missing file",
      "patch -s -t",
      "--- nowhere\n+++ nowhere\n@@ -1,2 +1,2 @@\n a\n-B\n+b\n",
    ],
    [
      "reversed rejects in one file",
      "patch -R -r all.rej",
      "--- g\n+++ g\n@@ -1,2 +1,2 @@\n a\n-q\n+Q\n@@ -5 +5 @@\n-e\n+E\n",
    ],
    ["a name ending at a blank", "patch", "--- sp ace\n+++ sp ace\n@@ -1 +1 @@\n-x\n+y\n"],
    ["a name ending at a tab", "patch", "--- sp ace\t\n+++ sp ace\t\n@@ -1 +1 @@\n-x\n+y\n"],
    ["an octal-quoted name", "patch", '--- "sp\\040ace"\n+++ "sp\\040ace"\n@@ -1 +1 @@\n-x\n+y\n'],
    [
      "two CRLF patches",
      "patch",
      "--- g\r\n+++ g\r\n@@ -1 +1 @@\r\n-a\r\n+A\r\n--- f\r\n+++ f\r\n@@ -1 +1 @@\r\n-x\r\n+X\r\n",
    ],
    ["a tab-indented patch", "patch", "\t--- g\n\t+++ g\n\t@@ -1 +1 @@\n\t-a\n\t+A\n"],
    [
      "several patches to one operand",
      "patch g",
      "--- q\n+++ q\n@@ -1 +1 @@\n-a\n+A\n--- r\n+++ r\n@@ -2 +2 @@\n-b\n+B\n",
    ],
    ["-i - and bundled options", "patch -F 1 -sp0 -i -", "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n"],
    ["abbreviated long options", "patch --forw --dry", "--- g\n+++ g\n@@ -1 +1 @@\n-A\n+a\n"],
    [
      "a git rename without hunks",
      "patch",
      "diff --git a/g b/h2\nsimilarity index 100%\nrename from g\nrename to h2\n",
    ],
    [
      "a git rename reversed after it was made",
      "patch -p1 -R",
      "diff --git a/g b/h2\nsimilarity index 90%\nrename from g\nrename to h2\n--- a/g\n+++ b/h2\n@@ -1 +1 @@\n-a\n+A\n",
    ],
    [
      "a patch to a queued rename",
      "patch -p1",
      "diff --git a/g b/h2\nsimilarity index 90%\nrename from g\nrename to h2\n--- a/g\n+++ b/h2\n@@ -1 +1 @@\n-a\n+A\ndiff --git a/h2 b/h2\n--- a/h2\n+++ b/h2\n@@ -2 +2 @@\n-b\n+B\n",
    ],
    [
      "a plain patch after a git one",
      "patch -p1",
      "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-a\n+A\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-A\n+Z\n",
    ],
    [
      "a git creation of an existing file",
      "patch -p1",
      "diff --git a/g b/g\nnew file mode 100644\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+x\n",
    ],
    ["an empty git creation", "patch -p1", "diff --git a/e b/e\nnew file mode 100755\n"],
    [
      "-E emptying a file",
      "patch -p1 -E",
      "--- a/f\n+++ b/f\n@@ -1,6 +0,0 @@\n-x\n-a\n-b\n-a\n-b\n-x\n",
    ],
    ["a heading kept in the reject", "patch", "--- g\n+++ g\n@@ -1 +1 @@ ctx\n-q\n+Q\n"],
    ["a header without its closing @@", "patch", "--- g\n+++ g\n@@ -1,2 +1,2\n a\n-b\n+B\n"],
    ["a header without +", "patch", "--- g\n+++ g\n@@ -1,2 1,2 @@\n a\n-b\n+B\n"],
    ["a header with a missing count", "patch", "--- g\n+++ g\n@@ -1, +1,2 @@\n a\n-b\n+B\n"],
    [
      "a line number too large",
      "patch",
      "--- g\n+++ g\n@@ -99999999999999999999,2 +1,2 @@\n a\n-b\n+B\n",
    ],
    ["a header with @@ attached", "patch", "--- g\n+++ g\n@@ -1,2 +1,2@@\n a\n-b\n+B\n"],
    ["a blank input line", "patch", "\n"],
    ["a quiet failed Prereq", "patch -s", "Prereq: zzz\n--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n"],
    ["an absolute name", "patch -p0", "--- /dev/null\n+++ /abs/x\n@@ -0,0 +1 @@\n+y\n"],
    [
      "a forced deletion that differs",
      "patch -p0 -f",
      "--- g\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n",
    ],
    [
      "deleting a missing file with -t",
      "patch -p0 -t",
      "--- nope\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
    ],
  ])("%s: %s", async (_, command, diff) => {
    const script = `${command} < d.diff; ls; cat -A f g h g.rej f.rej all.rej h2 e g.orig; echo end`;
    agreeWithBash(await compareWithBash(script, { tree: { ...tree, "d.diff": diff } }));
  });

  // Unified diffs of every context width against drifted targets, under each
  // answer mode, compared with the files and rejects GNU leaves.
  it.each([1, 2, 3])("applies generated diffs with seed %i", async (seed) => {
    const random = seeded(seed);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    };
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
    const directory = mkdtempSync(join(tmpdir(), "kompjutr-patch-widths-"));
    try {
      for (let round = 0; round < 30; round++) {
        const original = lines(5 + Math.floor(random() * 60));
        const edited = mutate(original, 1 + Math.floor(random() * 8));
        writeFileSync(join(directory, "a"), text(original, random() < 0.9));
        writeFileSync(join(directory, "b"), text(edited, random() < 0.9));
        const width = pick(["-U0", "-U1", "-U2", "-U3", "-U5"]);
        const diff = spawnSync("diff", [width, "--label", "a/f", "--label", "b/f", "a", "b"], {
          cwd: directory,
          env: { LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
        const drifted = random() < 0.2 ? edited : mutate(original, Math.floor(random() * 6));
        const files = { f: text(drifted, random() < 0.9), "change.diff": diff.stdout };
        const flags = pick(["-p1", "-p1 -R", "-p1 -F3", "-p1 -F0", "-p1 --dry-run", "-p1 -s"]);
        agreeWithBash(
          await compareWithBash(
            `patch ${flags} < change.diff; cat -A f; ls; cat -A f.rej f.orig; echo end`,
            { tree: files },
          ),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!REAL_BASH)("patch matches GNU patch on reviewed edge cases", () => {
  const tree: ShellTree = {
    g: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
    k: "k1\nk2\nk3\n",
    words: "alpha, beta\ngamma delta\n",
    "sub/x": "q\n",
    "outside.txt": "safe\n",
  };
  const git = (name: string, body: string): string =>
    `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n${body}`;
  it.each([
    [
      "overlapping hunks",
      "patch",
      "--- g\n+++ g\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n@@ -3,3 +3,3 @@\n c\n-d\n+D\n e\n",
    ],
    [
      "an overlap that needs fuzz",
      "patch",
      "--- g\n+++ g\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n@@ -2,4 +2,4 @@\n b\n c\n-d\n+D\n e\n",
    ],
    [
      "an overlap after two removals",
      "patch",
      "--- g\n+++ g\n@@ -2,4 +2,4 @@\n b\n-c\n-d\n+C\n+D\n e\n@@ -2,5 +2,5 @@\n b\n c\n d\n-e\n+E\n f\n",
    ],
    [
      "an overlap after an insertion",
      "patch",
      "--- g\n+++ g\n@@ -2,2 +2,3 @@\n b\n+X\n c\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n",
    ],
    [
      "an overlap onto a changed line",
      "patch",
      "--- g\n+++ g\n@@ -2,3 +2,3 @@\n b\n-c\n+C\n d\n@@ -3,2 +3,2 @@\n-c\n+X\n d\n",
    ],
    ["a CR on the --- line only", "patch", "--- g\r\n+++ g\n@@ -1 +1 @@\n-a\n+A\n"],
    ["a CR on the +++ line only", "patch", "--- g\n+++ g\r\n@@ -1 +1 @@\n-a\n+A\n"],
    ["CRLF lines under a bare hunk", "patch g", "@@ -1 +1 @@\r\n-a\r\n+A\r\n"],
    ["an existing absolute name", "patch -p0", "--- /g\n+++ /g\n@@ -1 +1 @@\n-a\n+A\n"],
    [
      "an existing name through ..",
      "patch -p0",
      "--- sub/../g\n+++ sub/../g\n@@ -1 +1 @@\n-a\n+A\n",
    ],
    ["a creation named .", "patch -p1", "--- /dev/null\n+++ b/.\n@@ -0,0 +1 @@\n+x\n"],
    [
      "a creation named as a directory",
      "patch -p1",
      "--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+x\n",
    ],
    ["a directory reversed", "patch -R", "--- sub\n+++ sub\n@@ -1 +1 @@\n-a\n+b\n"],
    [
      "a second plain patch that fails",
      "patch",
      "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n--- g\n+++ g\n@@ -3 +3 @@\n-Q\n+AA\n",
    ],
    [
      "a second git patch at an offset",
      "patch -p1",
      `${git("g", "@@ -1 +1 @@\n-a\n+A\n")}${git("g", "@@ -2 +2 @@\n-c\n+C\n")}`,
    ],
    [
      "a first git patch at an offset",
      "patch -p1",
      `${git("g", "@@ -2 +2 @@\n-a\n+A\n")}${git("g", "@@ -4 +4 @@\n-d\n+D\n")}`,
    ],
    [
      "a Prereq word followed by a comma",
      "patch",
      "Prereq: alpha\n--- words\n+++ words\n@@ -2 +2 @@\n-gamma delta\n+x\n",
    ],
    [
      "a Prereq word inside a line",
      "patch",
      "Prereq: gamma\n--- words\n+++ words\n@@ -2 +2 @@\n-gamma delta\n+x\n",
    ],
    [
      "a Prereq word ending a line",
      "patch -f",
      "Prereq: beta\n--- words\n+++ words\n@@ -2 +2 @@\n-gamma delta\n+x\n",
    ],
  ])("%s: %s", async (_, command, diff) => {
    const script = `${command} < d.diff; ls -A . sub; cat -A g g.orig g.rej words sub.rej ..rej; echo end`;
    agreeWithBash(await compareWithBash(script, { tree: { ...tree, "d.diff": diff } }));
  });

  it("stops when the backup name is a directory", async () => {
    const script = "mkdir g.orig; patch < d.diff; echo st=$?; ls -A; cat g; echo end";
    const diff = "--- g\n+++ g\n@@ -2 +2 @@\n-a\n+A\n";
    agreeWithBash(await compareWithBash(script, { tree: { ...tree, "d.diff": diff } }));
  });

  it.each(["g.rej", "all.rej"])(
    "replaces a reject file that is a symbolic link: %s",
    async (name) => {
      const option = name === "all.rej" ? " -r all.rej" : "";
      const script = `ln -s outside.txt ${name}; patch${option} < d.diff; test -L ${name} && echo link; ls; cat outside.txt ${name}; echo end`;
      const diff = "--- g\n+++ g\n@@ -1 +1 @@\n-Q\n+A\n";
      agreeWithBash(await compareWithBash(script, { tree: { ...tree, "d.diff": diff } }));
    },
  );
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

  function shell(
    files: Readonly<Record<string, string>>,
    maxRetainedBytes?: number,
    fs = createFilesystem(new TestDatabase(), { now: () => 0 }),
  ) {
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

  it("stages queued git outputs in the filesystem, not in retained memory", async () => {
    const files: Record<string, string> = {};
    let diff = "";
    for (let index = 0; index < 20; index++) {
      const name = `f${index}.txt`;
      files[name] = `head\n${"x".repeat(4096)}\n`;
      diff += `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-head\n+HEAD\n`;
    }
    // Each file fits the budget; twenty held together would not.
    const run = await shell({ ...files, "change.diff": diff }, 24 * 1024).run(
      "patch -p1 < change.diff >/dev/null; ls; head -c 5 f0.txt f19.txt",
    );
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      `change.diff\n${Array.from({ length: 20 }, (_, index) => `f${index}.txt`)
        .sort()
        .join("\n")}\n==> f0.txt <==\nHEAD\n\n==> f19.txt <==\nHEAD\n`,
    );
  });

  it("removes staged outputs when the run fails", async () => {
    const diff =
      "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/g b/g\nindex 1..2 100644\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n";
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const files = { f: "x\n", g: `x\n${"z".repeat(300)}\n`, "change.diff": diff };
    const run = await shell(files, 400, fs).run("patch -p1 < change.diff");
    expect(run.stderr).toMatch(/^kompjutr: patch target .*retained-memory limit\n$/);
    expect(run.exitCode).toBe(2);
    expect(fs.readdir("/repo").map((entry) => entry.name)).toEqual(["change.diff", "f", "g"]);
    expect(new TextDecoder().decode(fs.readFile("/repo/f"))).toBe("x\n");
  });

  it("fails loudly when the diff exceeds the retained budget", async () => {
    const diff = `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+${"y".repeat(200)}\n`;
    const run = await shell({ f: "x\n", "change.diff": diff }, 128).run(
      "cat change.diff | patch -p1; cat f",
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toMatch(/^kompjutr: patch input .*retained-memory limit\n$/);
  });

  it("keeps many large git outputs out of retained memory", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const files: Record<string, string> = {};
    let diff = "";
    const body = Array.from({ length: 2000 }, (_, line) => `line ${line}\n`).join("");
    for (let index = 0; index < 40; index++) {
      const name = `dir${index % 4}/f${index}.txt`;
      files[name] = body;
      diff += `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1000,3 +1000,3 @@\n line 998\n-line 999\n+LINE 999\n line 1000\n`;
    }
    files["change.diff"] = diff;
    const fileBytes = new TextEncoder().encode(body).length;
    // One file with its line index fits; forty held until the end would not.
    const run = await shell(files, 4 * fileBytes, fs).run("patch -p1 -s < change.diff");
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.peakRetainedBytes).toBeLessThan(4 * fileBytes);
    for (let index = 0; index < 40; index++) {
      const text = new TextDecoder().decode(fs.readFile(`/repo/dir${index % 4}/f${index}.txt`));
      expect(text.split("\n")[999]).toBe("LINE 999");
    }
    for (let dir = 0; dir < 4; dir++) {
      expect(fs.readdir(`/repo/dir${dir}`).filter((entry) => entry.name.startsWith("."))).toEqual(
        [],
      );
    }
  });

  it("stages nothing on a dry run", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const diff =
      "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/g b/g\nindex 1..2 100644\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+?\n";
    const run = await shell({ f: "x\n", g: "x\n", "change.diff": diff }, undefined, fs).run(
      "patch -p1 --dry-run < change.diff",
    );
    expect(run.stdout).toBe("checking file f\nchecking file g\n");
    expect(fs.readdir("/repo").map((entry) => entry.name)).toEqual(["change.diff", "f", "g"]);
  });

  it("finishes patching when stdout's reader stops early", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const diff = `${A_CHANGE}${B_CHANGE}`;
    const run = await shell({ ...TREE, "change.diff": diff }, undefined, fs).run(
      "patch -p1 < change.diff | head -1; cat src/b.txt",
    );
    expect(run.stdout).toBe("patching file src/a.txt\nalpha\nBETA\ngamma\n");
  });
});

describe("patch bounds and failure handling", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const gitChange = (name: string, from: string, to: string): string =>
    `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;

  function setup(
    files: Readonly<Record<string, string>>,
    limits: Partial<typeof DEFAULT_LIMITS> = {},
    cwd = "/repo",
  ) {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.makeDirectories(["/repo"]);
    for (const [path, text] of Object.entries(files)) {
      const full = path.startsWith("/") ? path : `/repo/${path}`;
      fs.makeDirectories([full.slice(0, full.lastIndexOf("/")) || "/"]);
      fs.writeFiles([{ path: full, bytes: encoder.encode(text), mode: 0o644 }]);
    }
    const shell = createShell({ fs, cwd, limits: { ...DEFAULT_LIMITS, ...limits } });
    const read = (path: string): string => decoder.decode(fs.readFile(path));
    const names = (path: string): string[] => fs.readdir(path).map((entry) => entry.name);
    return { fs, shell, read, names };
  }

  it("retains what a huge hunk really holds", async () => {
    const lines = 200_000;
    const diff = `--- f\n+++ f\n@@ -1 +1,${lines} @@\n-x\n${"+\n".repeat(lines)}`;
    const { fs, shell } = setup({ f: "x\n", "d.diff": diff });
    const gc = runInNewContext("gc");
    const write = fs.writeFileStream.bind(fs);
    let heapAtWrite = 0;
    fs.writeFileStream = (path, chunks, options) => {
      if (path === "/repo/f") heapAtWrite = process.memoryUsage().heapUsed;
      write(path, chunks, options);
    };
    gc();
    const before = process.memoryUsage().heapUsed;
    const run = await shell.run("patch < d.diff");
    expect(run.exitCode).toBe(0);
    // Hunk lines are nine bytes each, beside the diff and its line index.
    expect(run.peakRetainedBytes).toBeLessThan(diff.length + lines * 30);
    expect(heapAtWrite - before).toBeLessThan(2 * run.peakRetainedBytes);
  });

  it("publishes queued outputs and reports a fatal error after a refused rename", async () => {
    const diff = `${gitChange("f", "x", "y")}diff --git a/g b/sub\nsimilarity index 90%\nrename from g\nrename to sub\n--- a/g\n+++ b/sub\n@@ -1 +1 @@\n-a\n+A\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n?bad\n`;
    const { shell, read, names } = setup({ f: "x\n", g: "a\n", "sub/x": "q\n", "d.diff": diff });
    const run = await shell.run("patch -p1 < d.diff");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe("patch: **** malformed patch at line 20: ?bad\n\n");
    expect(read("/repo/f")).toBe("y\n");
    expect(names("/repo")).toEqual(["d.diff", "f", "g", "sub", "sub.rej"]);
  });

  // GNU patch loops and crashes renaming onto a directory; this refuses it
  // the way GNU refuses any patch to a directory.
  it("refuses a git rename onto a directory", async () => {
    const diff =
      "diff --git a/g b/sub\nsimilarity index 90%\nrename from g\nrename to sub\n--- a/g\n+++ b/sub\n@@ -1 +1 @@\n-a\n+A\n";
    const { shell, read, names } = setup({ g: "a\n", "sub/x": "q\n", "d.diff": diff });
    const run = await shell.run("patch -p1 < d.diff");
    expect(run.stdout).toBe(
      "File sub is not a regular file -- refusing to patch\n1 out of 1 hunk ignored -- saving rejects to file sub.rej\n",
    );
    expect(run.exitCode).toBe(1);
    expect(read("/repo/g")).toBe("a\n");
    expect(read("/repo/sub.rej")).toBe("--- g\n+++ sub\n@@ -1 +1 @@\n-a\n+A\n");
    expect(names("/repo")).toEqual(["d.diff", "g", "sub", "sub.rej"]);
  });

  it("patches even when stdout is never read", async () => {
    const { shell, read } = setup({ f: "x\n", g: "x\n", "d.diff": gitChange("f", "x", "y") });
    const run = await shell.run("patch -p1 < d.diff | true; patch -p1 g < d.diff | head -c 0");
    expect(run.exitCode).toBe(0);
    expect(read("/repo/f")).toBe("y\n");
    expect(read("/repo/g")).toBe("y\n");
  });

  it("removes directories a deletion empties when the working directory is /", async () => {
    const diff = "--- a/d/e/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    const { shell, names } = setup({ "/d/e/f": "x\n", "/change.diff": diff }, {}, "/");
    const run = await shell.run("patch -p1 < change.diff");
    expect(run.stdout).toBe("patching file d/e/f\n");
    expect(names("/")).toEqual(["change.diff", "repo"]);
  });

  it("keeps the staging directory out of reach of later patches", async () => {
    const diff = `${gitChange("f", "x", "y")}--- a/.patch-staging~/1\n+++ b/.patch-staging~/1\n@@ -1 +1 @@\n-y\n+EVIL\n`;
    const { shell, read, names } = setup({ f: "x\n", "d.diff": diff });
    const run = await shell.run("patch -p1 < d.diff");
    expect(run.exitCode).toBe(1);
    expect(read("/repo/f")).toBe("y\n");
    expect(names("/repo")).toEqual(["d.diff", "f"]);
  });

  it("never half-publishes or leaves staging when the operation budget runs out", async () => {
    const files: Record<string, string> = {};
    let diff = "";
    for (let index = 0; index < 30; index++) {
      files[`f${index}`] = "x\n";
      diff += gitChange(`f${index}`, "x", "y");
    }
    const probe = setup({ ...files, "d.diff": diff });
    const total = (await probe.shell.run("patch -p1 < d.diff > /dev/null")).operations;
    for (let maxOperations = 1; maxOperations < total; maxOperations++) {
      const { shell, read, names } = setup({ ...files, "d.diff": diff }, { maxOperations });
      const run = await shell.run("patch -p1 < d.diff > /dev/null");
      expect(run.stderr).toBe(`kompjutr: exceeded ${maxOperations} filesystem operations\n`);
      // Publication is one bulk copy: every target changes, or none does.
      const contents = new Set(Array.from({ length: 30 }, (_, index) => read(`/repo/f${index}`)));
      expect(contents.size).toBe(1);
      expect(names("/repo")).not.toContain(".patch-staging~");
    }
  });

  it("finds hunks through the line index instead of rescanning the file", async () => {
    const lines = 50_000;
    const context = 100;
    let diff = "--- f\n+++ f\n";
    for (let hunk = 0; hunk < 100; hunk++) {
      const at = 1 + hunk * (2 * context + 1);
      diff += `@@ -${at},${2 * context + 1} +${at},${2 * context + 1} @@\n${" a\n".repeat(context)}-b\n+c\n${" a\n".repeat(context)}`;
    }
    const { shell } = setup({ f: "a\n".repeat(lines), "d.diff": diff });
    const started = performance.now();
    const run = await shell.run("patch --dry-run < d.diff > /dev/null");
    const elapsed = performance.now() - started;
    expect(run.exitCode).toBe(1);
    // A scan per hunk and fuzz level took about 23 s here; the index takes milliseconds.
    if (TIMING_GATE) expect(elapsed).toBeLessThan(2_000);
  });

  // Every reservation a run takes is returned however patch stops.
  it.each([
    [
      "a malformed hunk",
      "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-Q\n+C\n@@ -5 +5 @@\n?bad\n",
    ],
    [
      "a malformed git hunk",
      "diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-Q\n+C\n@@ -5 +5 @@\n?bad\n",
    ],
    ["end of input inside a hunk", "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n@@ -3,1 +3,9 @@\n-c\n+C\n"],
    ["a malformed hunk after reversal", "--- g\n+++ g\n@@ -1 +1 @@\n-A\n+a\n@@ -5 +5 @@\n?bad\n"],
    ["a NUL byte after a hunk", "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\nx\0y\n"],
    ["a stray backslash line", "--- g\n+++ g\n@@ -1 +1 @@\n\\ No newline\n-a\n+A\n"],
    ["a clean run", "--- g\n+++ g\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-Q\n+C\n"],
  ])("returns every reservation after %s", async (_, diff) => {
    const held = await heldAfter({ g: "a\nb\nc\nd\ne\nf\n", "d.diff": diff }, {});
    expect(held).toEqual([]);
  });

  it("returns the line index when the hashes do not fit", async () => {
    const files = { f: "x\n".repeat(100_000), "d.diff": "--- f\n+++ f\n@@ -1 +1 @@\n-x\n+y\n" };
    expect(await heldAfter(files, { maxRetainedBytes: 700_000 })).toEqual([]);
  });

  /** Reservations taken under a `patch` label and still held after a run. */
  async function heldAfter(
    files: Readonly<Record<string, string>>,
    limits: Partial<typeof DEFAULT_LIMITS>,
  ): Promise<string[]> {
    const held = new Map<number, string>();
    const retain = RetainedBudget.prototype.retain;
    let next = 0;
    RetainedBudget.prototype.retain = function (bytes: number, label: string) {
      const release = retain.call(this, bytes, label);
      const id = next++;
      held.set(id, `${label}:${bytes}`);
      return () => {
        held.delete(id);
        release();
      };
    };
    try {
      const { shell } = setup(files, limits);
      await shell.run("patch < d.diff > /dev/null");
      return [...held.values()].filter((entry) => entry.startsWith("patch"));
    } finally {
      RetainedBudget.prototype.retain = retain;
    }
  }

  it("scans instead of indexing when the index does not fit", async () => {
    const { shell, read } = setup({
      f: `z\n${"x\n".repeat(600_000)}`,
      "d.diff": "--- f\n+++ f\n@@ -1 +1 @@\n-x\n+y\n",
    });
    const run = await shell.run("patch < d.diff");
    expect(run.stdout).toBe("patching file f\nHunk #1 succeeded at 2 (offset 1 line).\n");
    expect(read("/repo/f").slice(0, 6)).toBe("z\ny\nx\n");
  });

  it("holds messages in a few reserved buffers", async () => {
    const hunks = 60_000;
    let diff = "--- f\n+++ f\n";
    for (let hunk = 0; hunk < hunks; hunk++) diff += `@@ -${hunk + 1} +${hunk + 1} @@\n-x\n+y\n`;
    const { fs, shell } = setup({ f: `z\n${"x\n".repeat(hunks)}`, "d.diff": diff });
    const gc = runInNewContext("gc");
    const write = fs.writeFileStream.bind(fs);
    let heapAtWrite = 0;
    fs.writeFileStream = (path, chunks, options) => {
      if (path === "/repo/f") {
        gc();
        heapAtWrite = process.memoryUsage().heapUsed;
      }
      write(path, chunks, options);
    };
    gc();
    const before = process.memoryUsage().heapUsed;
    const run = await shell.run("patch < d.diff > /dev/null");
    expect(run.exitCode).toBe(0);
    expect(heapAtWrite - before).toBeLessThan(run.peakRetainedBytes);
  });

  it("finds hunks whose rarest line is common without a byte comparison per candidate", async () => {
    const lines = Array.from({ length: 50_000 }, (_, line) => (line % 100 === 99 ? "b" : "a"));
    let diff = "--- f\n+++ f\n";
    for (let hunk = 0; hunk < 20; hunk++) {
      diff += `@@ -${1 + hunk * 1000},150 +${1 + hunk * 1000},150 @@\n${" a\n".repeat(75)}-a\n+c\n${" a\n".repeat(74)}`;
    }
    const { shell } = setup({ f: `${lines.join("\n")}\n`, "d.diff": diff });
    const started = performance.now();
    const run = await shell.run("patch --dry-run < d.diff > /dev/null");
    expect(run.exitCode).toBe(1);
    // It took 6.4 s when every comparison sliced the hunk's bytes; GNU takes about 0.35 s.
    if (TIMING_GATE) expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("stops when a reject file name is a directory", async () => {
    const { shell, names } = setup({
      f: "a\nb\n",
      "f.rej/x": "",
      "d.diff": "--- f\n+++ f\n@@ -1 +1 @@\n-Q\n+A\n",
    });
    const run = await shell.run("patch --no-backup-if-mismatch < d.diff");
    // GNU names its temporary file here; the message names the reject file instead.
    expect(run.stderr).toBe("patch: **** Can't create file f.rej : Is a directory\n");
    expect(run.stdout).toBe(
      "patching file f\nHunk #1 FAILED at 1.\n1 out of 1 hunk FAILED -- saving rejects to file f.rej\n",
    );
    expect(run.exitCode).toBe(2);
    expect(names("/repo")).toEqual(["d.diff", "f", "f.rej"]);
  });

  // GNU loops on this; the queued patch stops the way a plain one does and nothing is published.
  it("stops a git patch whose backup name is a directory", async () => {
    const diff = `${gitChange("g", "x", "y")}diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3 +3 @@\n-c\n+C\n`;
    const { shell, read, names } = setup({
      f: "a\nb\nz\nc\n",
      g: "x\n",
      "f.orig/x": "",
      "d.diff": diff,
    });
    const run = await shell.run("patch -p1 < d.diff");
    expect(run.stderr).toBe("patch: **** Can't rename file f to f.orig : Is a directory\n");
    expect(run.exitCode).toBe(2);
    expect(read("/repo/f")).toBe("a\nb\nz\nc\n");
    expect(names("/repo")).toEqual(["d.diff", "f", "f.orig", "g"]);
  });

  // Divergence: GNU sometimes joins lines added after a copied final line that
  // lacks a newline ("b" + "bb" gives "bbb"); this ends that line first.
  it("ends a final line without a newline before lines added after it", async () => {
    const diff =
      "--- f\n+++ f\n@@ -1,6 +1,4 @@\n+aX\n+aX\n a\n-a\n-a\n-a\n-b\n b\n@@ -13,2 +11,4 @@\n a\n+bb\n+aX\n b\n\\ No newline at end of file\n";
    const target = "a\na\nbb\na\nba\nbX\nb\nb\naX\nb\nb\nb\nb";
    const { shell, read } = setup({ f: target, "d.diff": diff });
    const run = await shell.run("patch -F3 < d.diff > /dev/null");
    expect(run.exitCode).toBe(1);
    // GNU writes "b" + "bb" as "bbb" here.
    expect(read("/repo/f")).toBe(`${target}\nbb\naX\n`);
  });
});
