import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { diffText } from "../src/core/diff/index.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import { diff, diffSummary } from "../src/core/ops/diff.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, type TestRepository } from "./helpers/workspace.js";

const scratch = mkdtempSync(join(tmpdir(), "kompjutr-diff-"));
const fixtures: GitFixture[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const fixture of fixtures) fixture.dispose();
});

// -- the text engine ---------------------------------------------------

/** `git diff --no-index`'s hunks, with the file header stripped off. */
function gitHunks(before: string, after: string): string {
  const left = join(scratch, "before");
  const right = join(scratch, "after");
  writeFileSync(left, before);
  writeFileSync(right, after);
  let stdout = "";
  try {
    stdout = execFileSync("git", ["diff", "--no-index", "--no-color", "-U3", "--", left, right], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  } catch (error) {
    // git exits 1 when the files differ, which is the interesting case.
    if (typeof error === "object" && error !== null && "stdout" in error) {
      stdout = String(error.stdout);
    } else throw error;
  }
  const start = stdout.indexOf("@@");
  return start === -1 ? "" : stdout.slice(start);
}

/** A reproducible pseudo-random source, so a failure is always replayable. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("text diff engine", () => {
  it("places hunks and headers exactly where git does", () => {
    const cases: { name: string; before: string; after: string }[] = [
      { name: "one changed line", before: "a\nb\nc\n", after: "a\nB\nc\n" },
      { name: "append", before: "a\nb\n", after: "a\nb\nc\n" },
      { name: "prepend", before: "a\nb\n", after: "z\na\nb\n" },
      { name: "delete everything", before: "a\nb\nc\n", after: "" },
      { name: "create everything", before: "", after: "a\nb\nc\n" },
      { name: "missing final newline on the left", before: "a\nb\nc", after: "a\nb\nc\n" },
      { name: "missing final newline on the right", before: "a\nb\nc\n", after: "a\nb\nc" },
      { name: "missing final newline on both", before: "a\nb\nc", after: "a\nb\nd" },
      {
        name: "two hunks far apart",
        before: Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(""),
        after: Array.from({ length: 30 }, (_, i) =>
          i === 2 ? "changed\n" : i === 25 ? "also changed\n" : `line ${i}\n`,
        ).join(""),
      },
      {
        name: "two changes close enough to share a hunk",
        before: Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""),
        after: Array.from({ length: 20 }, (_, i) =>
          i === 5 ? "changed\n" : i === 9 ? "also changed\n" : `line ${i}\n`,
        ).join(""),
      },
      {
        name: "function context in the hunk header",
        before: "int main(void)\n{\n\tint a = 1;\n\tint b = 2;\n\tint c = 3;\n\treturn 0;\n}\n",
        after: "int main(void)\n{\n\tint a = 1;\n\tint b = 2;\n\tint c = 33;\n\treturn 0;\n}\n",
      },
      {
        name: "repeated lines force a slider decision",
        before: "{\n  a();\n}\n\n{\n  b();\n}\n",
        after: "{\n  a();\n}\n\n{\n  x();\n}\n\n{\n  b();\n}\n",
      },
      {
        name: "indented block insertion",
        before: "def f():\n    a = 1\n    return a\n\ndef g():\n    return 2\n",
        after:
          "def f():\n    a = 1\n    return a\n\ndef h():\n    return 3\n\ndef g():\n    return 2\n",
      },
      {
        name: "blank-line runs",
        before: "a\n\n\n\nb\n\n\n\nc\n",
        after: "a\n\n\n\nb\n\n\nx\n\nc\n",
      },
    ];

    for (const testCase of cases) {
      expect(diffText(testCase.before, testCase.after).hunks, testCase.name).toBe(
        gitHunks(testCase.before, testCase.after),
      );
    }
  });

  it("agrees with git over randomised edits", () => {
    const random = makeRandom(20200101);
    for (let round = 0; round < 200; round++) {
      const size = 1 + Math.floor(random() * 60);
      const alphabet = ["alpha", "beta", "", "    gamma", "\tdelta", "}", "{", "epsilon"];
      const before: string[] = [];
      for (let i = 0; i < size; i++) {
        before.push(`${alphabet[Math.floor(random() * alphabet.length)]!}\n`);
      }
      const after = [...before];
      const edits = 1 + Math.floor(random() * 9);
      for (let edit = 0; edit < edits; edit++) {
        if (after.length === 0) break;
        const at = Math.floor(random() * after.length);
        const kind = random();
        if (kind < 0.34) after.splice(at, 1);
        else if (kind < 0.67) after.splice(at, 0, `inserted ${edit}\n`);
        else after[at] = `${alphabet[Math.floor(random() * alphabet.length)]!}\n`;
      }
      const beforeText = before.join("");
      const afterText = after.join("");
      expect(diffText(beforeText, afterText).hunks, `round ${round}`).toBe(
        gitHunks(beforeText, afterText),
      );
    }
  });
});

// -- diff over a repository --------------------------------------------

interface Pair {
  fixture: GitFixture;
  workspace: TestRepository;
}

/** A file with one line changed in the middle, to give hunks some shape. */
function paragraph(marker: string): string {
  return Array.from({ length: 12 }, (_, i) => (i === 5 ? `${marker}\n` : `line ${i}\n`)).join("");
}

async function open(setup: (fixture: GitFixture) => void): Promise<Pair> {
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  // Pin the abbreviation: git otherwise sizes it from the object count.
  fixture.git("config", "core.abbrev", "7");
  setup(fixture);

  const workspace = makeRepo("/");
  await importFixture(fixture, workspace.repo.store);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.tick(60_000);
  return { fixture, workspace };
}

function writeBoth(pair: Pair, path: string, content: string | Uint8Array, mode = 0o644): void {
  pair.fixture.write(path, content);
  const bytes = typeof content === "string" ? utf8.encode(content) : content;
  pair.workspace.worktree.writeFiles([{ path: `/${path}`, bytes, mode }]);
}

function removeBoth(pair: Pair, path: string): void {
  pair.fixture.remove(path);
  pair.workspace.worktree.unlink(`/${path}`);
}

function chmodBoth(pair: Pair, path: string, mode: number): void {
  pair.fixture.chmod(path, mode);
  pair.workspace.worktree.chmod(`/${path}`, mode);
}

/** git's own bytes, untrimmed. */
function gitDiff(pair: Pair, ...args: string[]): string {
  return pair.fixture.gitBinary("diff", ...args).toString("utf8");
}

const OLD_BINARY = new Uint8Array([0, 1, 2, 3, 4, 0, 250]);
const NEW_BINARY = new Uint8Array([0, 1, 9, 3, 4, 0, 250]);

async function workingTreeFixture(): Promise<Pair> {
  const pair = await open((fixture) => {
    fixture.write("mod.txt", paragraph("original"));
    fixture.write("gone.txt", "gone\n");
    fixture.write("mode.txt", "same content\n");
    fixture.write("src/deep.txt", paragraph("deep original"));
    fixture.write("tail.txt", "a\nb\nc");
    fixture.write("bin.dat", OLD_BINARY);
    fixture.commit("first");
  });
  writeBoth(pair, "mod.txt", paragraph("changed"));
  removeBoth(pair, "gone.txt");
  chmodBoth(pair, "mode.txt", 0o755);
  writeBoth(pair, "src/deep.txt", paragraph("deep changed"));
  writeBoth(pair, "tail.txt", "a\nb\nc\n");
  writeBoth(pair, "bin.dat", NEW_BINARY);
  writeBoth(pair, "fresh.txt", "untracked, so git leaves it out\n");
  return pair;
}

describe("diff", () => {
  it("matches git diff over the working tree", async () => {
    const pair = await workingTreeFixture();
    const patch = diff(pair.workspace.repo, pair.workspace.worktree);
    expect(patch).toBe(gitDiff(pair));
    // Nothing is staged, so both spellings agree; ours is the second one.
    expect(patch).toBe(gitDiff(pair, "HEAD"));
    expect(patch).toContain("Binary files a/bin.dat and b/bin.dat differ\n");
    expect(patch).toContain("old mode 100644\nnew mode 100755\n");
    expect(patch).toContain("deleted file mode 100644\n");
    expect(patch).not.toContain("fresh.txt");
  });

  it("matches git diff with a path filter", async () => {
    const pair = await workingTreeFixture();
    expect(diff(pair.workspace.repo, pair.workspace.worktree, { paths: ["src"] })).toBe(
      gitDiff(pair, "--", "src"),
    );
    expect(diff(pair.workspace.repo, pair.workspace.worktree, { paths: ["mod.txt"] })).toBe(
      gitDiff(pair, "--", "mod.txt"),
    );
  });

  it("matches git diff against an older commit", async () => {
    const pair = await open((fixture) => {
      fixture.write("a.txt", paragraph("first"));
      fixture.commit("first");
      fixture.write("a.txt", paragraph("second"));
      fixture.write("added.txt", "added later\n");
      fixture.commit("second");
    });
    writeBoth(pair, "a.txt", paragraph("third"));
    expect(diff(pair.workspace.repo, pair.workspace.worktree, { ref: "HEAD~1" })).toBe(
      gitDiff(pair, "HEAD~1"),
    );
  });

  it("matches git diff between two commits", async () => {
    const pair = await open((fixture) => {
      fixture.write("a.txt", paragraph("first"));
      fixture.write("dropped.txt", "dropped\n");
      fixture.write("bin.dat", OLD_BINARY);
      fixture.commit("first");
      fixture.write("a.txt", paragraph("second"));
      fixture.write("added.txt", "added later\n");
      fixture.writeExecutable("script.sh", "#!/bin/sh\n");
      fixture.write("bin.dat", NEW_BINARY);
      fixture.remove("dropped.txt");
      fixture.commit("second");
    });
    expect(diff(pair.workspace.repo, pair.workspace.worktree, { ref: "HEAD~1", to: "HEAD" })).toBe(
      gitDiff(pair, "HEAD~1", "HEAD"),
    );
  });

  it("matches git diff HEAD for a staged addition", async () => {
    const pair = await open((fixture) => {
      fixture.write("a.txt", "a\n");
      fixture.commit("first");
    });
    writeBoth(pair, "staged.txt", "staged\n");
    pair.fixture.git("add", "--", "staged.txt");
    const oid = pair.workspace.repo.store.write("blob", utf8.encode("staged\n"));
    const stat = pair.workspace.worktree.stat("/staged.txt");
    if (stat === null) throw new Error("staged.txt vanished");
    pair.workspace.repo.store.indexPut({
      path: "staged.txt",
      stage: 0,
      mode: 0o100644,
      oid,
      size: stat.size,
      mtime: stat.mtime,
      ino: stat.ino,
    });
    expect(diff(pair.workspace.repo, pair.workspace.worktree)).toBe(gitDiff(pair, "HEAD"));
  });

  it("matches git diff for a deleted binary file", async () => {
    const pair = await open((fixture) => {
      fixture.write("old.dat", OLD_BINARY);
      fixture.write("keep.txt", "keep\n");
      fixture.commit("first");
    });
    removeBoth(pair, "old.dat");
    expect(diff(pair.workspace.repo, pair.workspace.worktree)).toBe(gitDiff(pair));
  });
});

describe("diffSummary", () => {
  function numstat(pair: Pair, ...args: string[]): string[] {
    const stdout = pair.fixture.gitBinary("diff", "--numstat", ...args).toString("utf8");
    return stdout.split("\n").filter((line) => line !== "");
  }

  function nameStatus(pair: Pair, ...args: string[]): string[] {
    const stdout = pair.fixture.gitBinary("diff", "--name-status", ...args).toString("utf8");
    return stdout.split("\n").filter((line) => line !== "");
  }

  it("counts the same lines git does", async () => {
    const pair = await workingTreeFixture();
    const summary = diffSummary(pair.workspace.repo, pair.workspace.worktree);
    const theirs = numstat(pair);

    expect(summary.map((entry) => entry.path)).toEqual(
      theirs.map((line) => line.split("\t")[2] ?? ""),
    );
    for (const [index, entry] of summary.entries()) {
      const [added, deleted] = theirs[index]!.split("\t");
      if (added === "-") {
        // git prints no line count for a binary file; neither do we.
        expect([entry.insertions, entry.deletions], entry.path).toEqual([0, 0]);
        continue;
      }
      expect([entry.insertions, entry.deletions], entry.path).toEqual([
        Number(added),
        Number(deleted),
      ]);
    }
    expect(summary.map((entry) => `${entry.status}\t${entry.path}`)).toEqual(nameStatus(pair));
  });

  it("counts the same lines git does between two commits", async () => {
    const pair = await open((fixture) => {
      fixture.write("a.txt", paragraph("first"));
      fixture.write("dropped.txt", "dropped\n");
      fixture.commit("first");
      fixture.write("a.txt", paragraph("second"));
      fixture.write("added.txt", "one\ntwo\nthree\n");
      fixture.remove("dropped.txt");
      fixture.commit("second");
    });
    const summary = diffSummary(pair.workspace.repo, pair.workspace.worktree, {
      ref: "HEAD~1",
      to: "HEAD",
    });
    expect(
      summary.map((entry) => `${entry.insertions}\t${entry.deletions}\t${entry.path}`),
    ).toEqual(numstat(pair, "HEAD~1", "HEAD"));
    expect(summary.map((entry) => `${entry.status}\t${entry.path}`)).toEqual(
      nameStatus(pair, "HEAD~1", "HEAD"),
    );
  });
});
