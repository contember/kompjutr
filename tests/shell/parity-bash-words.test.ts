// Word-level expansions compared with Bash: tilde, braces as words, brace
// expansion, and the `&>` redirections. Refusals and bounds are pinned locally.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { createShell, DEFAULT_LIMITS, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";
import { TIMING_GATE } from "../helpers/timing.js";

const TREE: ShellTree = {
  "a.ts": "alpha\n",
  "b.ts": "beta\n",
  "notes.md": "",
  "sub/c.ts": "",
  "sub/d.md": "",
};

const HOME = { HOME: "/home/tester" };

async function compare(source: string, env: Readonly<Record<string, string>> = HOME) {
  agreeWithBash(await compareWithBash(source, { tree: TREE, env }));
}

describe.skipIf(!REAL_BASH)("tilde expansion matches Bash", () => {
  it("expands a bare tilde and a tilde before a slash to HOME", async () => {
    await compare(`printf '<%s>\\n' ~ ~/x ~/ ~// ~/"a b" ~/a:b`);
  });

  it("keeps a quoted, escaped, or non-leading tilde literal", async () => {
    await compare(`printf '<%s>\\n' "~" \\~ '~' x~ ~"/x" ~\\/x ~"" ~"":~ x:~ --a=~/x`);
  });

  it("expands after = and : in an assignment-shaped argument", async () => {
    await compare(`printf '<%s>\\n' a=~/x a=~ a=b:~/x a=~:~ a=:~ a=~/:~ A_1=~`);
    await compare(`printf '<%s>\\n' a=${"$"}X:~ a="x":~`, { ...HOME, X: "1 2" });
  });

  it("does not treat a non-assignment or quoted tilde as an assignment value", async () => {
    await compare(`printf '<%s>\\n' 1a=~ a=x~ a=b=~ "a"=~ a\\=~ a=~\\: a=~"" a=~:""~ a=~"x"`);
  });

  it("neither splits nor pathname-expands the value of HOME", async () => {
    await compare(`printf '<%s>\\n' ~ ~/x`, { HOME: "*.ts two" });
    await compare(`printf '<%s>\\n' ~ ~/x before`, { HOME: "" });
  });

  it("expands a tilde in a here-string but not in a here-document", async () => {
    await compare("cat <<< ~; cat <<< ~/x; cat <<< a=~; cat <<< '~'");
    await compare("cat <<E\n~ ~/x\nE");
  });

  it("expands a tilde in a redirection target", async () => {
    await compare("echo x > ~/o; cat o; echo y >> ~/o; cat < ~/o", { HOME: "." });
    await compare("echo x > a=~; cat a=.", { HOME: "." });
  });
});

describe.skipIf(!REAL_BASH)("braces as words match Bash", () => {
  it("keeps braces that do not form an expansion literal", async () => {
    await compare(`printf '<%s>\\n' } { {} {a} a{b {a,b a{b,c {{}} {},a} x }`);
    await compare("echo }; echo {; echo {} x");
  });

  it("passes {} through to xargs -I", async () => {
    await compare("printf 'a\\nb\\n' | xargs -I{} echo {}.x");
    await compare("printf 'a\\nb\\n' | xargs -I {} echo [{}]");
  });
});

describe.skipIf(!REAL_BASH)("brace expansion matches Bash", () => {
  it("expands comma alternatives with preamble and postamble", async () => {
    await compare(`printf '<%s>\\n' pre{a,b}post {a,b}{c,d} {a,{b,c}} a{b}c{d,e}`);
    await compare(`printf '<%s>\\n' {a{b,c}} {a}{b,c} {{a,b} {a,b}} {a,b}}c }{a,b} {a,b}{`);
  });

  it("drops empty unquoted alternatives and keeps quoted ones", async () => {
    await compare(`printf '<%s>\\n' {,} x{,}y {a,} {,a,} {"",a} x{'',}y`);
  });

  it("honours quoting inside and around braces", async () => {
    await compare(`printf '<%s>\\n' {a,"b c"} "{a,b}" '{a,b}' {a\\,b} {a,b}\\} {"a",b}`);
    await compare(`printf '<%s>\\n' {a"b,c"d,e} {\\{,b} {a,b\\} {a,\\}} {"a,b"} {a,b"}"}`);
  });

  it("expands integer sequences", async () => {
    await compare(`printf '<%s>\\n' {1..5} {5..1} {-3..3} {-1..-3} {1..1} {1..10..3} {10..1..-3}`);
    await compare(`printf '<%s>\\n' {1..3..0} {1..3..-1} {1..3..+2} {3..-2..2} {+1..3} {1..+3}`);
  });

  it("zero-pads sequences like Bash", async () => {
    await compare(`printf '<%s>\\n' {01..10} {-05..5..3} {001..1} {-01..1} {1..-01} {00..0}`);
    await compare(`printf '<%s>\\n' {-3..-01} {-0..3} {0..-0} {+01..3} {+01..03} {01..+3}`);
    await compare(`printf '<%s>\\n' {-0..03} {01..-100} {1..10..03}`);
    await compare(`printf '%s\\n' {01..100} | tail -3`);
  });

  it("expands character sequences", async () => {
    await compare(`printf '<%s>\\n' {a..e} {e..a} {a..e..2} {a..e..-2} {a..c..0} {A..C} {a..a}`);
  });

  it("stays within intmax_t and leaves an out-of-range sequence literal", async () => {
    await compare(`printf '<%s>\\n' {9223372036854775806..9223372036854775807}`);
    await compare(`printf '<%s>\\n' {-9223372036854775808..-9223372036854775807}`);
    await compare(`printf '<%s>\\n' {1..3..9223372036854775807} {1..9223372036854775808}`);
    await compare(`printf '<%s>\\n' {a..c..-9999999999999999999}`);
  });

  it("leaves a malformed sequence literal", async () => {
    await compare(`printf '<%s>\\n' {aa..b} {1..a} {a..9} {-..a} {1.2..3} {0x1..3} {1..3..a}`);
    await compare(`printf '<%s>\\n' {1..3..} {..3} {1..} {"1"..3} {1..3"}"} {a..\\}} {\\a..c}`);
  });

  it("mixes sequences and alternatives", async () => {
    await compare(`printf '<%s>\\n' {a..c}{1..2} {{1..3},x} {1..3,x} {x,1..3} a{1..3}b {1..3}{`);
  });

  it("expands braces before parameters and pathnames", async () => {
    await compare(
      `printf '<%s>\\n' {${"$"}X,b} ${"$"}{X}{a,b} {a,b}${"$"}X {a..c}${"$"}X "{${"$"}X,b}"`,
      {
        X: "1 2",
      },
    );
    await compare(`printf '<%s>\\n' *.{ts,md} {a,b}.ts {1..3}* {*,b} {[a,b]} sub/{c,d}.*`);
  });

  it("expands braces before tildes", async () => {
    await compare(`printf '<%s>\\n' {~,x} {a,~} x{~,b} {~/x,y} ~/{a,b} ~{/a,/b} ~/{a,b}~`);
    await compare(`printf '<%s>\\n' a{=~,b} {a=~,b} a={~,b} {a,b}=~`);
  });

  it("expands braces in a redirection target", async () => {
    await compare("echo x > {o}; cat {o}; echo y > {a..a}; cat a");
  });

  it("does not expand braces in here-strings or here-documents", async () => {
    await compare("cat <<< {a,b}; cat <<E\n{a,b} {1..3}\nE");
  });
});

describe.skipIf(!REAL_BASH)("&> redirections match Bash", () => {
  it("sends stdout and stderr to one file", async () => {
    await compare("echo hi &> /dev/null; echo done");
    await compare("echo hi &> out; cat out");
    await compare("cat nope &> out; cat out");
    await compare("echo a &> out; cat nope &>> out; echo b &>> out; cat out");
  });

  it("reads >&file as &>file", async () => {
    await compare("echo hi >& out; cat out; cat nope >&out; cat out");
  });
});

describe("word expansion refusals and bounds", () => {
  let fs: Filesystem;
  let shell: Shell;

  beforeEach(() => {
    fs = createFilesystem(new TestDatabase());
    shell = createShell({ fs, cwd: "/repo" });
  });

  async function refused(
    source: string,
    message: string,
    env: Readonly<Record<string, string>> = HOME,
  ): Promise<void> {
    const run = await shell.run(source, { env });
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain(message);
  }

  it.each([
    ["echo ~user", "`~user`"],
    ["echo ~root/x", "`~root`"],
    ["echo ~+", "`~+`"],
    ["echo ~-", "`~-`"],
    ["echo ~*", "`~*`"],
    ["echo ~$HOME", "`~$HOME`"],
    ["echo a=~root", "`~root`"],
    ["echo ~{a,b}", "`~a`"],
    ["echo ~:x", "`~:x`"],
    ["echo ~=", "`~=`"],
    ["echo ~$HOME/x", "`~$HOME`"],
  ])("refuses the named tilde prefix in %s", async (source, prefix) => {
    await refused(source, `tilde expansion of ${prefix}`);
  });

  it("refuses a tilde when HOME is not in the run env", async () => {
    await refused("echo ~", "HOME", {});
    await refused("echo a=~/x", "HOME", {});
    await refused("cat <<< ~", "HOME", {});
    expect(await shell.run("echo '~' x~", { env: {} })).toMatchObject({
      stdout: "~ x~\n",
      exitCode: 0,
    });
  });

  it.each([
    ["{", "command group"],
    ["}", "command group"],
    ["{ echo x; }", "command group"],
    ["echo x; } ", "command group"],
    ["{echo,x}", "brace expansion in command names"],
    ["~/bin/tool", "tilde expansion in command names"],
    ["echo $HOME{a,b}", "brace expansion after an unbraced parameter"],
    ["echo $HOME{}", "brace expansion after an unbraced parameter"],
    ["echo {$,a}HOME", "literal `$`"],
    ["echo {a..Z}", "across letter cases"],
    ["echo ls &", "background execution"],
    ["echo x 1>&out", "not a descriptor"],
    ["echo x >&-", "not a descriptor"],
  ])("refuses %s", async (source, message) => {
    await refused(source, message);
  });

  it("refuses brace expansion nested past the stack bound", async () => {
    await refused(`echo ${"{a,".repeat(65)}b${"}".repeat(65)}`, "nested deeper than 64");
    const nested = await shell.run(`echo ${"{a,".repeat(64)}b${"}".repeat(64)}`);
    expect(nested.exitCode).toBe(0);
  });

  it("refuses an ambiguous brace-expanded redirection target", async () => {
    await refused("echo x > {c,d}", "ambiguous redirect");
  });

  it("stops a huge sequence at the argv ceiling without materialising it", async () => {
    const started = Date.now();
    const run = await shell.run("true {1..100000000}");
    expect(run).toMatchObject({ stdout: "", exitCode: 2, operations: 0 });
    expect(run.stderr).toContain("E2BIG: expanded argv exceeds 10000 entries");
    if (TIMING_GATE) expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("counts generated words that expand to nothing", async () => {
    const run = await shell.run(`true ${"{,,,,,,,,,}".repeat(5)}`);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("E2BIG");
    expect((await shell.run(`true ${"{,,,,,,,,,}".repeat(4)}`)).exitCode).toBe(0);
  });

  it("admits a sequence at the argv ceiling", async () => {
    const run = await shell.run("echo {1..10000} | wc -w");
    expect(run).toMatchObject({ stdout: "10000\n", exitCode: 0 });
    expect((await shell.run("true {1..10001}")).stderr).toContain("E2BIG");
  });

  it("charges brace-generated words to the retained-byte bound", async () => {
    const limited = createShell({
      fs,
      cwd: "/repo",
      sessionId: "limited",
      limits: { ...DEFAULT_LIMITS, maxRetainedBytes: 100 },
    });
    const run = await limited.run("true {1000..1100}");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("retained-memory limit");
  });

  it("parses thousands of unmatched braces in linear time", async () => {
    const started = Date.now();
    const run = await shell.run(`echo ${"{".repeat(50_000)}x${"}".repeat(50_000)} | wc -c`);
    expect(run).toMatchObject({ stdout: "100002\n", exitCode: 0 });
    if (TIMING_GATE) expect(Date.now() - started).toBeLessThan(5_000);
  });
});
