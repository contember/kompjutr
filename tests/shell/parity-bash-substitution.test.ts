// Command substitution, assignments, export/unset, the `${NAME:-word}`
// operators, and parameters in command names and redirection targets,
// compared with Bash. The harness admits only names listed in the controlled
// environment, so a case that needs an unset or unexported name unsets it
// first. Refusals and bounds are pinned in substitution.test.ts.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "lines.txt": "l1\nl2\nl3\n",
  "a.md": "a\n",
  "b.md": "b\n",
  "sub/inner.txt": "inner\n",
  "src/index.ts": "export {};\n",
  "src/app.ts": "import './lib/util';\n",
  "src/lib/util.ts": "export const x = 1;\nexport const y = 2;\n",
  "package.json": '{"name":"demo","version":"1.2.3"}\n',
};

const NAMES = [
  "x",
  "y",
  "u",
  "v",
  "w",
  "f",
  "e",
  "a",
  "i",
  "cmd",
  "msg",
  "two",
  "out",
  "name",
  "count",
  "n",
  "files",
  "VERSION",
  "DIR",
];
const ENV: Readonly<Record<string, string>> = {
  HOME: "/home/agent",
  ...Object.fromEntries(NAMES.map((name) => [name, ""])),
};

async function compare(source: string): Promise<void> {
  agreeWithBash(await compareWithBash(source, { tree: TREE, env: ENV }));
}

describe("the substitution parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("command substitution matches Bash", () => {
  it.each([
    "echo $(echo hello)",
    'echo "$(echo hello)"',
    "echo \"$(printf 'a  b')\"",
    "echo $(printf 'a  b')",
    "printf '<%s>\\n' $(printf 'a b\\nc')",
    "printf '<%s>\\n' \"$(printf 'a b\\nc')\"",
    "echo \"$(printf 'x\\n\\n\\n')\"end",
    "echo \"$(printf '\\n\\nx')\"end",
    "printf '<%s>\\n' $(echo '*.md')",
    "printf '<%s>\\n' \"$(echo '*.md')\"",
    "printf '<%s>\\n' $(echo 'nomatch*')",
    "echo pre$(echo mid)post",
    "echo $(echo a)$(echo b)",
    "echo $(echo $(echo nested))",
    'echo "$(echo "$(echo "deep  quoted")")"',
    "echo $( echo ')' )",
    'echo "$(echo "a)b")"',
    'x=$(); echo "[$x] $?"',
    "echo $(\n  echo multi\n  echo line\n)",
    "echo $(echo a # a comment\n)",
    "echo $( (echo in a subshell) )",
    "echo $({ echo in a group; })",
    "echo $(for i in 1 2; do echo $i; done)",
    "echo $(if true; then echo yes; fi)",
    "echo $(cat lines.txt | head -2)",
  ])("expands $( … ): %j", async (source) => {
    await compare(source);
  });

  it.each([
    "echo `echo back`",
    'echo "`echo back quoted`"',
    "echo `echo a \\`echo b\\``",
    "x=value; echo `echo \\$x`",
    'echo "`echo \\"q\\"`"',
    'echo `echo \\"q\\"`',
    "echo `echo $(echo inner)`",
    "echo $(echo `echo inner`)",
    "echo `printf '%s' 'a\\\\b'`",
  ])("expands backquotes: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'x=$(cat <<EOF\nhere\nEOF\n); echo "$x"',
    "msg=\"$(cat <<'EOF'\nline one\n  line $two\nEOF\n)\"; printf '%s\\n' \"$msg\"",
    "cat <<EOF\na $(echo b) `echo c`\nEOF",
    "cat <<'EOF'\n$(echo literal)\nEOF",
    "cat <<EOF\n\\$(echo escaped)\nEOF",
    'cat <<< "$(echo hs)"',
    "cat <<< $(echo a   b)",
    "wc -l <<< \"$(printf 'a\\nb\\n')\"",
    "echo hi > $(echo out.txt); cat out.txt",
    "cat < $(echo lines.txt)",
    'for f in $(echo a b) c; do echo "<$f>"; done',
    'for f in "$(echo a b)"; do echo "<$f>"; done',
    "x=$(echo 'a  b'); echo \"$x\"; echo $x",
    "x=$(printf 'a\\n\\n'); echo \"[$x]\"",
    "echo $(printf 'a\\0b')",
    "x=$(printf 'a\\0\\n'); echo \"[$x]\"",
  ])("expands in every word context: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "echo $(echo out; echo err >&2)",
    "echo $(echo out; echo err >&2) 2>/dev/null",
    "{ echo $(echo err >&2); } 2>/dev/null",
    "( echo $(echo err >&2) ) 2>&1 | wc -c",
    'x=$(ls nope); echo "[$x] $?"',
    'echo "$(ls nope 2>&1)"',
    "echo a 2>/dev/null > $(ls nope; echo o.txt); cat o.txt",
    "echo $(echo e >&2) 2>&1 | wc -c",
    "echo $(nope)",
    "echo\necho $(nope) second line",
  ])("routes a substitution's stderr like Bash: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "false; echo $(true) $?",
    "x=$(false); echo $?",
    "x=$(exit 3) y=$?; echo $? $y",
    "$(exit 4); echo $?",
    "x=$(exit 5) true; echo $?",
    "echo $(exit 3)$?",
    "false; echo $(echo $?)",
    "x=$(false) > out.txt; echo $?",
    "set -e; x=$(false); echo no",
    "set -e; echo $(false); echo yes",
    'set -e; x=$(false; echo after); echo "$x"',
    "set -o pipefail; x=$(false | true); echo $?",
    "if x=$(false); then echo t; else echo f; fi",
    "x=$(false) || echo failed",
    'x=$(echo a; exit 2); echo "$x $?"',
  ])("sets $? like Bash: %j", async (source) => {
    await compare(source);
  });

  it.each([
    'x=$(cd sub && ls); echo "$x"; ls',
    'echo $(x=5); echo "[$x]"',
    "y=1; echo $(y=2; echo $y) $y",
    "echo $(exit 3); echo after",
    "unset w; echo $(set -u; echo $w; echo not reached); echo after $?",
    "echo $(set -e; false; echo continues)",
    'for i in 1 2; do x=$(echo a; break; echo b); echo "$x $i"; done',
    'for i in 1 2; do x=$(continue 2; echo b); echo "[$x] $i $?"; done',
    'echo piped | echo "$(cat)"',
    "echo in | cat $(echo -)",
    "echo $(break)",
  ])("runs a substitution as a subshell: %j", async (source) => {
    await compare(source);
  });
});

describe.skipIf(!REAL_BASH)("assignments match Bash", () => {
  it.each([
    "unset v; v=1; env | grep '^v='; echo \"status $? [$v]\"",
    "unset v; v=1; export v; env | grep '^v='",
    "unset v; export v=2; env | grep '^v='; export -n v; env | grep '^v='; echo \"[$v]\"",
    "unset v; v=1 env | grep '^v='; echo \"[$v]\"",
    'unset v; v=1 echo "[$v]"; echo "[$v]"',
    "x=outer; x=inner true; echo $x",
    "x=a; x+=b; echo $x; unset v; v+=c; echo $v",
    "x=*; echo \"$x\"; x='*.md'; echo $x",
    "x=a b",
    'x="a  b" y=$x; echo "$y"',
    'y=1 x=$y; echo "[$x]"',
    "unset v; a=1 v=$a env | grep '^v='",
    "unset x; x=1 y=$(echo $x) env | grep '^y='",
    "unset x; x=1 y=$(env | grep '^x=') env | grep '^y='",
    "unset x; x=1 y=$(x=2; echo $x) w=$x env | grep -E '^(w|y)=' | sort",
    `unset x; x=$(seq 1 700000); echo a | cat | cat; echo \${#x}`,
    "x=~; echo $x; y=a:~/b; echo $y",
    "x=$HOME/`echo a`; echo $x",
    'unset v; v=1 > out.txt; echo "[$v]"; cat out.txt',
    "x=1; (x=2; echo $x); echo $x",
    "x=1; x=2 | true; echo $x",
    "x=1; { x=3; }; echo $x",
    "x=1; for i in a; do x=$i; done; echo $x",
    'x=1 cd .; echo "[$x]"',
    "x=1; x=2 set -e; echo $x",
    'unset v; v=1 :; echo "[$v]"',
    'unset v; x=1 v=2 $e; echo "[$v]"',
    "unset v; v=1 x=2 env | grep -E '^(v|x)=' | sort",
    "echo a=~/x b+=~/y",
  ])("assigns: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "unset v; (export v=1); env | grep '^v='; echo $?",
    "export x=1; unset x; x=2; env | grep '^x='; echo \"$x\"",
    `unset x; env | grep '^x='; echo "[\${x-unset}]"`,
    "x=kept; export -n x; env | grep '^x='; echo \"$x\"",
    "unset v; export v; env | grep '^v='; v=1; env | grep '^v='",
    `unset v; export v; echo "\${v-unset}"`,
    "export a=1 1b c=2; echo $?; env | grep -E '^(a|c)=' | sort",
    "export 1x=2; echo $?",
    "export -z; echo $?",
    "unset -z; echo $?",
    "export -nx x; echo $?",
    "unset -v 1x; echo $?",
    "unset a-b; echo $?",
    "export -; echo $?",
    'export ""; echo $?',
    'unset -v ""; echo $?',
    "export x=1 -n; echo $?; env | grep '^x='",
    "unset x -v; echo $?",
    "export -- x=2; env | grep '^x='",
    `unset -- x; echo "\${x-gone}"`,
    "x=1; export x+=2; echo $x",
    "unset v; v=1 v+=2 env | grep '^v='",
    'y="a  b"; export x=$y; echo "$x"',
    'export x=*; echo "$x"',
    "export x=~/a; echo $x",
    "y=\"p=1 q=2\"; export $y; env | grep -E '^(p|q)=' | sort",
    'e=export; y="a  b"; $e x=$y; echo "[$x]"',
    "x=1; export -n x=2; echo $x; env | grep '^x='",
    "type export unset",
  ])("exports and unsets: %j", async (source) => {
    await compare(source);
  });
});

describe.skipIf(!REAL_BASH)(
  "parameters in command names and redirection targets match Bash",
  () => {
    it.each([
      "cmd=echo; $cmd a b",
      'cmd="echo -n"; $cmd a b; echo',
      "e=; $e echo x",
      "e=; $e; echo $?",
      "e=; $e > made.txt; ls made.txt",
      "$(echo nope); echo $?",
      "$(echo echo) sub",
      'cmd=echo; "$cmd" quoted',
      'cmd="echo a"; "$cmd"; echo $?',
      "cmd=ls; $cmd sub",
      "cmd='cat lines.txt'; $cmd | wc -l",
    ])("names the command: %j", async (source) => {
      await compare(source);
    });

    it.each([
      "f=out.txt; echo hi > $f; cat out.txt",
      'f=out.txt; echo a >> "$f"; echo b >> "$f"; cat $f',
      "f=out.txt; { echo grouped; } > $f; cat $f",
      'f="a b"; cat < $f; echo $?',
      "unset u; cat < $u; echo $?",
      "unset u; echo hi > $u; echo $?",
      'f="*.md"; echo hi > $f; echo $?',
      "f='nomatch*'; echo hi > $f; cat 'nomatch*'",
      "f='lines*'; cat < $f",
      'e=; echo > "$e"; echo $?',
      "echo x > {c,d}; echo $?",
      'f="a b"; echo hi > "$f"; cat "a b"',
      'f="a b"; echo hi 2>/dev/null > $f; echo $?',
      'f="a b"; (echo hi > $f); echo $?',
    ])("binds the target: %j", async (source) => {
      await compare(source);
    });
  },
);

describe.skipIf(!REAL_BASH)("parameter expansion operators match Bash", () => {
  it.each([
    `unset u; echo \${u:-a b} "\${u:-a b}"`,
    `unset u; printf '<%s>\\n' \${u:-a b}`,
    `unset u; printf '<%s>\\n' \${u:-*.md}`,
    `unset u; printf '<%s>\\n' "\${u:-*.md}"`,
    `unset u; printf '<%s>\\n' \${u:-'a b'}`,
    `unset u; printf '<%s>\\n' "\${u:-"a b"}"`,
    `unset u; printf '<%s>\\n' \${u:-{a,b}}`,
    `unset u; printf '<%s>\\n' \${u:-~} \${u:-~/x} \${u:-a:~}`,
    `unset u; printf '<%s>\\n' "\${u:-~}"`,
    `x=abc; echo \${#x} "\${#x}"`,
    `x=; echo \${#x}`,
    `x=héllo; echo \${#x}`,
    `x=abc; unset u; echo \${u:+$x} \${x:+alt} \${x+set} \${u+set}`,
    `unset u; echo \${u=dflt} $u`,
    `x=; echo "[\${x=a}]" "[\${x:=b}]" $x`,
    `x=; echo "[\${x-a}]" "[\${x:-b}]" "[\${x+c}]" "[\${x:+d}]"`,
    `unset u; echo \${u:?}`,
    `unset u; echo "\${u?must set}"; echo after`,
    `x=1; echo \${x:?no}`,
    `unset u; echo \${u:-a}}`,
    `unset u; echo \${u:-a\\}b}`,
    `unset u; echo "\${u:-a\\}b}"`,
    `unset u; echo "\${u:-a\\"b}"`,
    `unset u; echo \${u:-a"}"b}`,
    `unset u; echo \${u:-a'}'b}`,
    `unset u; echo \${u:-$(echo sub)}`,
    `unset u; echo "\${u:-$(echo "a  b")}"`,
    `unset u; echo \${u:-"$(echo "a  b")"}`,
    `unset u; echo \${u:-\${x:-\${y:-deep}}}`,
    `unset u; printf '<%s>\\n' \${u:='a  b'}; printf '<%s>\\n' "$u"`,
    `unset u; printf '<%s>\\n' \${u:=*.md}`,
    `unset u; printf '<%s>\\n' \${u:+'a  b'} \${u:-""} x`,
    `unset u; printf '<%s>\\n' \${u:-$(printf 'a\\nb')}`,
    `x='1 2'; printf '<%s>\\n' \${x:+$x}`,
    `unset u; echo \${u:?a  b  $HOME}`,
    `unset u; echo \${u:?"a  b"}`,
    `unset u; echo \${u:?\`echo x\`}`,
    `unset u; x=$(echo \${u:?bad}); echo "[$x] $?"`,
    `unset u; x=\${u:?bad}; echo "[$x] $?"`,
    `unset u; for i in \${u:?nolist}; do echo; done; echo after`,
    `unset u; cat <<EOF\n\${u:?inheredoc}\nEOF\necho after $?`,
    `unset u; echo hi > \${u:?intarget}; echo after $?`,
    `unset u; cat <<< \${u:?x}; echo after $?`,
    `unset u; echo hi | cat > \${u:?t}; echo after $?`,
    `unset u; (echo \${u:?in subshell}; echo in); echo after $?`,
    `unset u; x=1 \${u:?inname}; echo after`,
  ])("expands: %j", async (source) => {
    await compare(source);
  });

  it.each([
    `set -u; unset u; echo \${u:-d} \${u-e} \${u:+p} \${u+q}`,
    `set -u; unset u; echo \${#u}; echo after`,
    `set -u; unset u; echo \${u:=d}; echo $u`,
    `set -u; x=; echo "[\${x:-d}]" "[\${#x}]"`,
    "set -u; unset u; cat <<< $u; echo after $?",
    "set -u; unset u; echo hi > $u; echo after $?",
    "set -u; unset u; cat < $u; echo after $?",
    "(set -u; unset u; echo hi > $u; echo in); echo after $?",
    "set -u; unset u; x=$u; echo after",
    "set -u; unset u; x=$u true; echo after",
    "set -u; unset u; $u; echo after",
    'set -u; unset u; x=$(echo $u; echo in); echo "[$x] $?"',
    `set -u; unset x; echo \${x-fine}`,
  ])("honours set -u: %j", async (source) => {
    await compare(source);
  });
});

describe.skipIf(!REAL_BASH)("agent scripts with substitution match Bash", () => {
  it.each([
    "for f in $(find src -name '*.ts' | sort); do wc -l \"$f\"; done",
    'VERSION=$(jq -r .version package.json); echo "v$VERSION"',
    'f=src/lib/util.ts; cd "$(dirname "$f")" && ls',
    'count=$(grep -c l lines.txt); echo "count=$count"',
    'n=$(wc -l < lines.txt); echo "lines: $n"',
    'for f in $(ls src/*.ts); do echo "== $f"; head -1 "$f"; done',
    'name=$(basename src/lib/util.ts .ts); echo "$name"',
    'if [ -n "$(ls sub)" ]; then echo nonempty; fi',
    'test "$(head -1 lines.txt)" = l1 && echo match',
    'out=$(sort b.md a.md); echo "$out"',
    "files=$(ls *.md); echo $files",
    "echo \"Found $(find src -name '*.ts' | wc -l) files\"",
    'DIR=$(dirname src/lib/util.ts); mkdir -p "$DIR/new" && ls "$DIR"',
    "export NODE_ENV=production; env | grep '^NODE_ENV='",
    'out=$(grep -rl export src | sort); for f in $out; do echo "file: $f"; done',
    `x=$(cat package.json); echo "\${#x}"`,
    'if out=$(grep nope lines.txt); then echo "found $out"; else echo "none ($?)"; fi',
    `name=\${name:-default}; echo "hello $name"`,
    `: \${DIR:=build}; mkdir -p "$DIR"; ls -d "$DIR"`,
  ])("runs %j", async (source) => {
    await compare(source);
  });
});
