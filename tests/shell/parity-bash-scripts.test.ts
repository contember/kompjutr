// Multi-line scripts, here-documents, negation, and the small built-ins agents
// chain with them, compared with Bash. Refusals are pinned locally.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "lines.txt": "l1\nl2\nl3\n",
  "empty.txt": "",
  "sub/inner.txt": "inner\n",
};

describe("the script parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("scripts match Bash", () => {
  async function compare(source: string, env: Readonly<Record<string, string>> = {}) {
    agreeWithBash(await compareWithBash(source, { tree: TREE, env }));
  }

  it.each([
    "echo a\necho b",
    "\n\necho a\n\n",
    "false\necho ran",
    "true &&\n\necho joined",
    "false ||\necho fallback",
    "cat lines.txt |\n wc -l",
    "echo one \\\n two",
    'echo "a\\\nb" c\\\nd',
    "echo 'kept \\\n literal'",
  ])("separates statements on newlines: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "# leading\necho after",
    "echo a # trailing\necho b",
    "echo a;# glued\necho b",
    "echo a#b",
  ])("ends comments at the line end: %j", async (source) => {
    await compare(source);
  });

  it.each([
    `cat <<EOF\nplain $NAME ${"$"}{NAME}x\n\\$NAME \\\\ \\q \\\`\nEOF`,
    "cat <<'EOF'\nliteral $NAME \\q\nEOF\necho after",
    'cat <<"E F"\n$NAME\nE F',
    "cat <<\\EOF\n$NAME\nEOF",
    "cat <<-EOF\n\t\tstripped\n\tEOF",
    "cat <<EOF\njoined \\\nline\nEOF",
    "cat <<EOF\nEOF",
    "cat <<EOF\nno trailing newline\nEOF",
    "cat <<A; cat <<B\none\nA\ntwo\nB",
    "cat <<EOF | wc -l\na\nb\nEOF",
    "cat <<EOF > out.txt\nwritten\nEOF\ncat out.txt",
    "cat <<EOF >> lines.txt\nappended\nEOF\ncat lines.txt",
    "wc -l < lines.txt <<EOF\nlast wins\nEOF",
  ])("reads here-documents: %j", async (source) => {
    await compare(source, { NAME: "w  x *" });
  });

  it.each(["cat <<< word", 'cat <<< "$NAME"', "cat <<< $NAME", "wc -c <<< ''"])(
    "reads here-strings: %j",
    async (source) => {
      await compare(source, { NAME: "w  x *" });
    },
  );

  it.each([
    "! true; echo next",
    "! false && echo negated",
    "! ! true && echo double",
    "! cat missing.txt 2>/dev/null && echo absent",
    "echo !x",
  ])("negates pipelines: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "echo -e 'a\\tb\\nc'",
    "echo -e 'x\\cy'; echo z",
    "echo -ne 'a\\x41\\x4g\\0101\\q\\e\\a'",
    "echo -e -n -E 'a\\tb'",
    "echo -neE 'a\\tb'",
    "echo -x -e",
    "echo -- -n",
  ])("interprets echo options: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "tail -n +2 lines.txt",
    "tail -n+3 lines.txt",
    "tail -n +0 lines.txt",
    "tail -n +9 lines.txt",
    "cat lines.txt | tail -n +2",
    "tail -n +2 missing.txt",
    "tail -n 1 missing.txt",
  ])("starts tail at a line: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "test -f lines.txt && echo file",
    "test -d lines.txt || echo not-dir",
    "[ -d sub ] && echo dir",
    "[ -e missing ] || echo missing",
    "[ -s lines.txt ] && ! [ -s empty.txt ] && echo sizes",
    "[ -r lines.txt ] && [ -w lines.txt ] && ! [ -x lines.txt ] && [ -x sub ] && echo modes",
    "test -f lines.txt/child || echo through-file",
    "test -L lines.txt || echo not-link",
    "test; echo $STATUS_WORD",
    "test '' || echo empty",
    "test word && echo word",
    "test -f && echo one-argument",
    "test ! -f lines.txt || echo negated",
    "test ! a = b && echo negated-binary",
    "test a = a && test a != b && test a == a && echo strings",
    "test 3 -lt 10 && test ' 5 ' -eq 5 && test -2 -le -2 && test 7 -ge 7 && echo integers",
    "test -z '' && test -n x && echo lengths",
    "test '(' x ')' && echo grouped",
    "test '(' a = a ')' && echo grouped-binary",
    "[ ] || echo empty-brackets",
  ])("evaluates test expressions: %j", async (source) => {
    await compare(source, { STATUS_WORD: "done" });
  });

  it.each([
    "test a -eq 1",
    "[ a = a",
    "test -f a b",
    "test -q x",
    "echo first\n\ntest 1 -eq b",
    "cat <<E\nbody\nE\n[ x -lt y ]",
  ])("reports test diagnostics at their script line: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "printf 'ab ab\\nx\\nAb\\n' | grep -oin ab",
    "printf 'ab\\nx\\n' | grep -q ab && echo found",
    "printf 'x\\n' | grep -q ab || echo absent",
    "printf 'ab\\nx\\n' | grep -l ab",
    "printf 'l1\\nab\\nl3\\nl4\\nl5\\nab\\n' | grep -o -C1 ab",
    "printf 'l1\\nab\\nl3\\n' | rg -o -C1 ab",
    "printf 'ab ab\\nx\\n' | rg -ov ab",
    "printf 'ab\\n' | rg -q ab && echo found",
  ])("searches a pipe quietly or for the match alone: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "echo hi | tee out.txt; cat out.txt",
    "printf 'a\\nb\\n' | tee one two > /dev/null; cat one two",
    "echo more | tee -a lines.txt; cat lines.txt",
    "echo x | tee --append lines.txt > /dev/null; cat lines.txt",
    "printf '1\\n2\\n3\\n' | tee full.txt | head -1; cat full.txt",
    "tee empty.out < /dev/null; wc -c empty.out",
  ])("copies input with tee: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "wc -l lines.txt",
    "wc lines.txt",
    "wc -l lines.txt empty.txt",
    "wc lines.txt sub/inner.txt",
    "wc -cl lines.txt",
    "wc -m lines.txt",
    "printf 'a b\\n' | wc",
    "printf 'a b\\n' | wc -l",
    "printf 'a b\\n' | wc -lw",
    "printf 'a b\\n' | wc -l - lines.txt",
    "wc lines.txt missing",
    "wc -l missing",
    "wc sub",
    "wc -c < /dev/null",
  ])("counts in GNU wc's layout: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "basename /a/b/c.txt",
    "basename /a/b/c.txt .txt",
    "basename c.txt c.txt",
    "basename -s .ts x.ts y.ts",
    "basename -a a/b c/d/",
    "basename ///",
    "basename ''",
    "basename",
    "basename a b c",
    "dirname /a/b/c.txt a/b c / '' a//b// //a",
    "dirname",
    "dirname -z a b/c",
    "basename -z a/b",
    "basename -az a/b c/d",
  ])("derives path names: %j", async (source) => {
    await compare(source);
  });
});

describe("script refusals and located diagnostics", () => {
  let shell: Shell;

  beforeEach(() => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    fs.writeFiles([{ path: "/repo/lines.txt", bytes: new TextEncoder().encode("l1\n") }]);
    shell = createShell({ fs, cwd: "/repo" });
  });

  // Bash warns and uses the rest of the input as the body.
  it("refuses a here-document without its delimiter", async () => {
    const run = await shell.run("cat <<EOF\nbody");
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("kompjutr: here-document delimited by end of input (wanted 'EOF')\n");
  });

  // The host tee is uutils, which appends `(os error 2)` to the GNU text.
  it("reports a tee target it cannot open and still writes the others", async () => {
    const run = await shell.run("echo x | tee nodir/a out.txt; cat out.txt");
    expect(run.stderr).toBe("tee: nodir/a: No such file or directory\n");
    expect(run.stdout).toBe("x\nx\n");
    expect(run.exitCode).toBe(0);
    expect((await shell.run("echo x | tee nodir/a")).exitCode).toBe(1);
  });

  // Bash's result depends on the locale; the run has none.
  it("refuses echo's unicode escapes", async () => {
    const run = await shell.run("echo -e '\\u00e9'");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe("echo: the \\u escape is not supported\n");
  });

  it("reserves a here-document body against the retained limit", async () => {
    const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
    const bounded = createShell({
      fs,
      cwd: "/",
      limits: { maxOutputBytes: 1_000, maxOperations: 100, readBudget: 64, maxRetainedBytes: 64 },
    });
    const small = await bounded.run(`cat <<EOF\n${"x".repeat(40)}\nEOF`);
    expect(small.stdout).toBe(`${"x".repeat(40)}\n`);

    const large = await bounded.run(`cat <<EOF\n${"x".repeat(100)}\nEOF`);
    expect(large.exitCode).toBe(2);
    expect(large.stdout).toBe("");
    expect(large.stderr).toContain("here-document");
  });

  it.each([
    ["test -p x", "bash: line 1: test: -p is not supported\n"],
    ["test a -nt b", "bash: line 1: test: -nt is not supported\n"],
    [
      "true\ntest a = a -a b = b",
      "bash: line 2: test: expressions with more than four arguments are not supported\n",
    ],
  ])("refuses %j by name", async (source, stderr) => {
    const run = await shell.run(source);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe(stderr);
  });
});
