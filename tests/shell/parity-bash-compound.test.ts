// Compound commands, `$?`, and `set -e`/`-u`/`-o pipefail`, compared with Bash.
// Loop variables are passed in the controlled environment because the harness
// admits only explicit names; a name Bash already exports stays exported when
// a loop assigns it. Refusals and the loop iteration limit are pinned in
// compound.test.ts.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "lines.txt": "l1\nl2\nl3\n",
  "sub/inner.txt": "inner\n",
  "sub/other.txt": "other\n",
  "b.md": "b\n",
  "a.md": "a\n",
};

const LOOP_ENV = { i: "outer", x: "outer", a: "", b: "", f: "", n: "" };

async function compare(source: string): Promise<void> {
  agreeWithBash(await compareWithBash(source, { tree: TREE, env: LOOP_ENV }));
}

describe("the compound parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("compound commands match Bash", () => {
  it.each([
    "(echo a; echo b)",
    "(cd sub && ls); ls",
    "(cd sub); ls",
    "(exit 3); echo $?",
    "(exit 3; echo no); echo after $?",
    "(false); echo $?",
    "(echo out; echo err >&2) 2>/dev/null",
    "(echo a; echo b) > out.txt; cat out.txt",
    "(echo out; echo err >&2) 2>&1 | sort",
    "(cd sub && ls) | wc -l",
    "( (echo nested; exit 4); echo $? )",
    "(\n  echo multi\n  exit 2\n)\necho $?",
    "(for i in 1 2; do echo $i; done); echo $i",
  ])("runs subshells: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "{ echo a; echo b; }",
    "{ cd sub; }; ls",
    "{ echo b; echo a; } | sort",
    "{ echo a; echo err >&2; } 2>/dev/null",
    "{ echo one; echo two; } > out.txt; cat out.txt",
    "{ echo a; echo err >&2; echo b; } 2>&1 | cat",
    "{ echo x; } >> lines.txt; cat lines.txt",
    "{ exit 4; }; echo no",
    "{ false; }; echo $?",
    "{ echo }; }",
    "{\necho multi\n}",
    "{ cd sub; } | cat; ls",
    "{ { echo deep; }; }",
    "{ cat; } < lines.txt",
    "{ head -1; cat; } < lines.txt",
    "{ head -c 2; cat; } < lines.txt",
    "cat lines.txt | { head -1; cat; }",
    "{ echo a; echo b; echo c; } | head -1",
    "{ echo a; echo b; } | { cat; echo c; }",
    "cat lines.txt | for i in 1; do cat; done",
    "cat lines.txt | if true; then cat; fi",
    "(cat) < lines.txt",
    "echo x | (cat; echo y)",
    "{ cat <<E\nbody\nE\n} | wc -l",
    "{ echo a; } | { cat; } | { cat; } | wc -c",
  ])("runs groups: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "if true; then echo yes; fi",
    "if false; then echo yes; fi; echo $?",
    "if false; then echo yes; else echo no; fi",
    "if false; then echo 1; elif true; then echo 2; else echo 3; fi",
    "if false; then echo 1; elif false; then echo 2; else echo 3; fi",
    "if false; then :; fi",
    "if test -f lines.txt; then cat lines.txt; fi",
    "if [ -d missing ]; then echo dir; else echo none; fi",
    "if true; then false; fi; echo $?",
    "if false; then true; else echo $?; fi",
    "false; if true; then echo $?; fi",
    "if ! grep -q zz lines.txt; then echo absent; fi",
    "if grep -q l2 lines.txt && [ -f b.md ]; then echo both; fi",
    "if true\nthen\n  echo lines\nfi",
    "if true; then echo a; fi | tr a b",
    "if true; then echo out; echo err >&2; fi 2>/dev/null",
    "if true; then if false; then echo x; else echo nested; fi; fi",
    "if (exit 3); then echo t; else echo $?; fi",
    "if { false; echo in; }; then echo t; fi",
  ])("runs if: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "for i in 1 2 3; do echo $i; done",
    "for i in a b; do echo $i; done; echo after $i",
    "for i in; do echo x; done; echo $?",
    "for i in {1..3}; do echo n$i; done",
    "for f in *.md; do cat $f; done",
    "for f in sub/*.txt; do echo $f; done | sort -r",
    "for i in 'a b' c; do echo \"<$i>\"; done",
    "for x in $i; do echo $x; done",
    "for i in 1 2\ndo\n  echo $i\ndone",
    "for i in 1 2; do echo $i; done > out.txt; cat out.txt",
    "for i in 1 2 3; do echo $i; done | head -1",
    "for a in 1 2; do for b in x y; do echo $a$b; done; done",
    "for i in 1 2 3; do if [ $i = 2 ]; then continue; fi; echo $i; done",
    "for i in 1 2 3; do if [ $i = 2 ]; then break; fi; echo $i; done; echo $?",
    "for a in 1 2; do for b in x y; do continue 2; echo no; done; echo no2; done; echo $a$b",
    "for a in 1 2; do for b in x y; do break 2; done; done; echo $a$b",
    "for a in 1 2; do for b in x y; do break 5; done; done; echo $a$b $?",
    "for i in 1 2; do { break; }; echo no; done; echo $i",
    "for i in 1 2; do break | cat; echo $i; done",
    "for i in 1 2; do (break); echo $i; done",
    "for i in 1 2; do { break; echo no; } | cat; echo $i; done",
    "for i in 1; do break 0; echo in; done; echo $?",
    "for i in 1 2; do continue 0; echo in; done; echo $?",
    "for i in 1; do break -1; done; echo $?",
    "for i in 1; do break ' 1 '; done; echo $?",
    "for i in 1; do break 2 3; echo in; done; echo no",
    "for i in 1; do continue x; done; echo no",
    "break; echo $?",
    "continue 2; echo $?",
    "false; for i in a; do true; done; echo $?",
    "for i in a; do false; break; done; echo $?",
    "for i in 1; do (exit 4); done; echo $?",
    "for i in 1 2; do exit 3; done; echo no",
    "for i in a b; do echo $i; done | { cat; echo end; }",
    "for i in 1 2; do cat <<E\nline $i\nE\ndone",
    'for i in x; do cat <<< "$i"; done',
  ])("runs for loops: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "false; echo $?",
    `true; echo ${"$"}{?}`,
    'false; echo "s=$?"',
    "false; echo $?; echo $?",
    "! true; echo $?",
    "false | true; echo $?",
    "true | false; echo $?",
    "false && true; echo $?",
    "false || true; echo $?",
    "cat missing.txt 2>/dev/null; echo $?",
    "false; cat <<E\nstatus $?\nE",
    "false; cat <<< $?",
    "false; (echo $?)",
    "false; { echo $?; }",
    "false; echo $? | cat",
    "exit 7 | cat; echo $?",
    "true $?; echo $?",
  ])("expands the last status: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "set -e; false; echo no",
    "set -e; true; echo yes",
    "set -e; true && false; echo no",
    "set -e; false && true; echo reached",
    "set -e; false || false; echo no",
    "set -e; false || true; echo reached",
    "set -e; ! true; echo reached",
    "set -e; if false; then :; fi; echo reached $?",
    "set -e; if false; then :; elif false; then :; else false; fi; echo no",
    "set -e; { false && true; }; echo reached",
    "set -e; (false && true); echo no",
    "set -e; ! { false; echo x; }; echo after",
    "set -e; { false; echo in; } || echo x",
    "set -e; (false; echo in) || echo x",
    "set -e; if { false; echo in; }; then echo t; fi",
    "set -e; for i in 1; do false && true; done; echo reached",
    "set -e; for i in a; do false; echo no; done",
    "set -e; (exit 3); echo no",
    "set -e; { (false); echo no; }; echo no2",
    "set -e; false | true; echo reached",
    "set -e; { false; echo no; } | cat; echo reached $?",
    "(set -e; false; echo no); echo $?",
    "set -e; set +e; false; echo reached",
    "set -o errexit; false; echo no",
    "set -e\necho one\nfalse\necho no",
    "set -e; cat missing.txt 2>/dev/null; echo no",
  ])("follows set -e: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "set -o pipefail; false | true; echo $?",
    "set -o pipefail; true | false | true; echo $?",
    "set -o pipefail; (exit 2) | (exit 3) | true; echo $?",
    "set -o pipefail; true | true; echo $?",
    "set -o pipefail; set +o pipefail; false | true; echo $?",
    "set -eo pipefail; false | true; echo no",
    "set -euo pipefail; echo ok | cat",
    "set -e -o pipefail +e; false | true; echo $?",
    "set -oe pipefail; false | true; echo no",
    "set -o pipefail | cat; false | true; echo $?",
    "set -o pipefail; cat missing.txt 2>/dev/null | wc -l; echo $?",
    "set -o badname; echo $?",
  ])("follows set -o pipefail: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "echo if then else elif fi for in do done { } '(' '!'",
    "echo for; echo done",
    "echo a | xargs echo if",
    "true && { echo grouped; }",
    "false || (echo sub)",
    "! { false; }; echo $?",
  ])("recognizes keywords only in command position: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "for i in 1\ndo\n  test 1 -eq x\ndone",
    "if true\nthen\n  test 1 -eq x\nfi",
    "{\ntest 1 -eq x\n}",
    "(\ntest 1 -eq x\n)",
    "echo 1\nif true; then\n  exit foo\nfi",
    "for i in 1 2; do\n  echo $i\n  [ 1 -lt y ]\ndone",
    "if false; then\n  :\nelse\n  exit bad\nfi",
  ])("reports builtin diagnostics at their line: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "set -e; for i in 1; do true; done > nodir/x; echo no",
    "set -e; { true; } > nodir/x; echo no",
    "set -e; if true; then true; fi > nodir/x; echo no",
    "set -e; (true) > nodir/x; echo no",
    "{ echo a; } > nodir/x; echo $?",
    "echo a > nodir/x; echo $?",
    "echo a 2> nodir/e; echo $?",
    "echo a > lines.txt/x; echo $?",
    "for x in 1; do echo x; done > nodir/x || echo failed",
    "cat lines.txt | { cat; } > nodir/y; echo $?",
    "set -e; { false && true; } > out.txt; echo reached",
  ])("exits on a failed compound redirection under set -e: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "if true; then :; fi; echo $?",
    ": a b > made.txt; ls made.txt; echo $?",
    "for i in 1 2; do :; done; echo $?",
    "set -e; :; echo ok",
    "false; :; echo $?",
    ": | cat; echo $?",
    "type :",
    "command -v :",
    "type set break continue",
    "type -t : set",
  ])("runs the null command: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "nosuch; echo $?",
    "nosuch 2>/dev/null; echo $?",
    "{ nosuch; } 2>/dev/null; echo $?",
    "nosuch | cat; echo $?",
    "nosuch 2>&1 | cat",
    "echo x | nosuch; echo $?",
    "nosuch > out.txt; cat out.txt; echo $?",
    "set -e; nosuch; echo no",
    "set -o pipefail; nosuch | cat; echo $?",
    "echo a\nnosuch arg\necho b",
    "for i in 1; do nosuch; done 2> err.txt; cat err.txt",
  ])("reports a missing command as Bash does: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "printf 'l1\\nl2\\nl3\\n' | { head -1; head -1; }",
    "cat lines.txt | for x in 1 2; do head -1; done",
    "cat lines.txt | { cat > copy.txt; }; cat copy.txt",
  ])("shares a pipe among a body's readers: %j", async (source) => {
    await compare(source);
  });
});
