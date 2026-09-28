// `sort` against uutils sort through Bash: keys, separators, the numeric,
// human and version orders, stability, uniqueness, check mode, NUL records,
// `-o`, and uutils' diagnostics. Orderings uutils takes from a locale, a
// random source, or an external merge are refused locally.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "s.txt": "b 2 x\na 10 y\nc 1 z\nA 2 w\n",
  "csv.txt": "pear,3,green\napple,10,red\nfig,3,purple\nkiwi,,brown\nbanana,2,yellow\n",
  "ws.txt": "  b\t2\na  10\n\tc 1\n d   3\n",
  "num.txt":
    "3\n-1.5\n-.5\n0\n.5\n0.50\n10\n2\n007\n-0\n\nabc\n1e3\n 2\n\t7\n1,000\n99999999999999999999\n",
  "plus.txt": "+5\n3\n7\n+10\n",
  "human.txt": "1K\n2M\n-1K\n0K\n1k\n1024\n1.5K\n1G\nK\n 3M\n1E\n1T\n-2M\n512\n",
  "ver.txt":
    "a1\na10\na2\na\n1.10\n1.9\n1.9a\n1.9~rc\n1.9.1\nfoo.1.txt\nfoo.10.txt\nfoo.2.txt\nx~\nx\n.a\n..\n.\na.tar.gz\na-1.tar.gz\na.tgz\n001\n01\n1\n",
  "text.txt": "b\nB\n_\na\n a\nA_b\na-b\nab\na b\né\n~\n",
  "dup.txt": "b 1\na 1\nb 2\na 1\nc 1\nB 1\n",
  "sorted.txt": "a\nb\nb\nc\n",
  "nonl.txt": "z\ny",
  "nul.bin": "b\u0000a\nx\u0000c\u0000",
  "fields.txt": "x:3:b:9\ny:1:a\nz:2:c:1\nw:1:b:7\n",
  "dir/f.txt": "q\np\n",
};

describe("the sort options parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("sort options match uutils sort", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "sort -k2 s.txt",
    "sort -k2n s.txt",
    "sort -k2,2n s.txt",
    "sort -k 2,2n s.txt",
    "sort -k2 -n s.txt",
    "sort -k2,2n -k1,1r s.txt",
    "sort -k2,2nr -k1,1 s.txt",
    "sort -k3 s.txt",
    "sort -k3,3r s.txt",
    "sort -k1.2 s.txt",
    "sort -k2.2,2.2 s.txt",
    "sort -k1,1f s.txt",
    "sort -k9 s.txt",
    "sort --key=2n s.txt",
    "sort --key 2n s.txt",
    "sort -k=2n s.txt",
    "sort -r -k2,2 s.txt",
    "sort -n -k2,2r s.txt",
    "sort -k2,2 -k1 s.txt",
    "sort -k1.1,1.1 -k2n s.txt",
    "sort -k2b ws.txt",
    "sort -k2 ws.txt",
    "sort -b -k2 ws.txt",
    "sort -k2,2bn ws.txt",
    "sort -k1.2b ws.txt",
    "sort -k1,1.2b ws.txt",
    "sort -k2n ws.txt",
    "sort -k1 ws.txt",
    "sort -b ws.txt",
  ])("orders by key: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -t, -k2 csv.txt",
    "sort -t, -k2n csv.txt",
    "sort -t, -k2,2n -k1,1 csv.txt",
    "sort -t, -k2,2nr csv.txt",
    "sort -t , -k3 csv.txt",
    "sort -t: -k3,3 -k4n fields.txt",
    "sort -t: -k2,2n -s fields.txt",
    "sort -t: -k4 fields.txt",
    "sort -t: -k2.1,2.1 fields.txt",
    "sort -t: -k1.2,3.0 fields.txt",
    "sort -t: -k2,3 fields.txt",
    "sort --field-separator=: -k2 fields.txt",
    "sort -t: -t, -k2n csv.txt",
    "sort -t ' ' -k2n s.txt",
  ])("splits on a separator: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -n num.txt",
    "sort -rn num.txt",
    "sort -n -s num.txt",
    "sort -nu num.txt",
    "sort -n plus.txt",
    "sort -n -r plus.txt",
    "sort -k1n plus.txt",
    "printf '0\\n-0\\n' | sort -n -s",
    "printf '1.50\\n1.5\\n1.500\\n' | sort -n -s",
    "printf '5\\n-\\n-5\\n' | sort -n",
    "sort -h human.txt",
    "sort -hr human.txt",
    "sort -h -s human.txt",
    "sort -k1h human.txt",
    "sort -V ver.txt",
    "sort -Vr ver.txt",
    "sort -V -s ver.txt",
    "sort -k1V ver.txt",
    "sort --version-sort ver.txt",
    "sort --human-numeric-sort human.txt",
  ])("orders numbers and versions: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort text.txt",
    "sort -f text.txt",
    "sort -d text.txt",
    "sort -df text.txt",
    "sort -fs text.txt",
    "sort -fu text.txt",
    "sort -r text.txt",
    "sort -k1,1d text.txt",
    "sort -Vf text.txt",
    "sort -dV text.txt",
    "sort -fn num.txt",
  ])("folds and filters text: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -u dup.txt",
    "sort -s -k2,2 dup.txt",
    "sort --stable -k2,2 dup.txt",
    "sort -u -k2,2 dup.txt",
    "sort -u -k1,1 dup.txt",
    "sort -uf -k1,1 dup.txt",
    "sort -s -k1,1f dup.txt",
    "sort -us -k2,2 dup.txt",
    "sort -ur -k1,1 dup.txt",
  ])("stabilizes and deduplicates: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -c sorted.txt",
    "sort -c s.txt",
    "sort -C s.txt",
    "sort -C sorted.txt",
    "sort -cu sorted.txt",
    "sort -c -k2,2n s.txt",
    "sort --check=silent s.txt",
    "sort --check=quiet s.txt",
    "sort --check=diagnose-first s.txt",
    "sort --check s.txt",
    "sort -c --check=silent s.txt",
    "printf 'b\\na\\n' | sort -c",
    "printf 'b\\na\\n' | sort -c -",
    "printf 'a\\nb\\n' | sort -c",
    "sort -c nonl.txt",
    "sort -cz nul.bin",
    "sort -c missing.txt",
    "sort -c dir",
  ])("checks order: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -z nul.bin",
    "sort -zr nul.bin",
    "printf 'b\\0a\\0' | sort -z",
    "sort nonl.txt",
    "sort nonl.txt s.txt",
    "printf 'q\\n' | sort - nonl.txt",
    "printf 'q\\n' | sort nonl.txt -",
    "sort -- s.txt",
  ])("reads records: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -o out.txt s.txt; cat out.txt",
    "sort -o s.txt s.txt; cat s.txt",
    "sort -n -o num.txt num.txt; cat num.txt",
    "sort -r s.txt -o s.txt; cat s.txt",
    "sort --output=out.txt s.txt nonl.txt; cat out.txt",
    "sort -o nodir/x s.txt",
    "sort -o dir s.txt",
    "sort -o a -o b s.txt",
  ])("writes -o: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort missing.txt",
    "sort s.txt missing.txt",
    "sort dir",
    "sort -x s.txt",
    "sort --unknown s.txt",
    "sort --foo=bar s.txt",
    "sort --num=3 s.txt",
    "sort --revers s.txt",
    "sort --st s.txt",
    "sort --c s.txt",
    "sort --s s.txt",
    "sort --h s.txt",
    "sort -k",
    "sort -t",
    "sort -o",
    "sort -k -n s.txt",
    "sort -k2 -t",
    "sort --stable=1 s.txt",
    "sort --check=foo s.txt",
    "sort -cC s.txt",
    "sort -Cc s.txt",
    "sort -c -o x s.txt",
    "sort -o x -C s.txt",
    "sort -nV s.txt",
    "sort -Vn s.txt",
    "sort -dn s.txt",
    "sort -nh s.txt",
    "sort -hV s.txt",
    "sort -dh s.txt",
    "sort -c s.txt s.txt",
    "sort -t '' s.txt",
    "sort -t ab s.txt",
    "sort -t é s.txt",
  ])("diagnoses usage: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "sort -k s.txt",
    "sort -k 0 s.txt",
    "sort -k a s.txt",
    "sort -k '' s.txt",
    "sort -k 1, s.txt",
    "sort -k ,2 s.txt",
    "sort -k 1. s.txt",
    "sort -k 1,0 s.txt",
    "sort -k 1,0.0 s.txt",
    "sort -k 1.0 s.txt",
    "sort -k 1.0b s.txt",
    "sort -k 2.x s.txt",
    "sort -k 2q s.txt",
    "sort -k 1..2 s.txt",
    "sort -k 1n.2 s.txt",
    "sort -k 1,2n.3 s.txt",
    "sort -k 1,-2 s.txt",
    "sort -k 1.-1 s.txt",
    "sort -k 1_ s.txt",
    "sort -k 1+ s.txt",
    "sort -k ' 1' s.txt",
    "sort -k '1, 2' s.txt",
    "sort -k 1é s.txt",
    "sort -k 1.99999999999999999999999 s.txt",
    "sort -k 1nh s.txt",
    "sort -k 1hn s.txt",
    "sort -k 1Vh s.txt",
    "sort -k 1dn s.txt",
    "sort -k 1nd s.txt",
    "sort -k 1dh s.txt",
    "sort -k 1dfn s.txt",
    "sort -k 1n,2h s.txt",
    "sort -k 1n,2V s.txt",
    "sort -k 1d,2n s.txt",
    "sort -k 1c s.txt",
    "sort -k 1,x s.txt",
    "sort -k 1.1a s.txt",
    "sort -kn s.txt",
    "sort -k 1,2.0 s.txt",
    "sort -k 99999999999999999999999 s.txt",
    "sort -k +1 s.txt",
    "sort -k 1,+2 s.txt",
    "sort -k 1bb s.txt",
    "sort -k 1Vd s.txt",
    "sort -k 1fn s.txt",
  ])("parses KEYDEF: %j", async (source) => {
    await compare(source);
  });
});

describe("sort refuses what it does not implement", () => {
  it.each([
    ["sort -g s.txt", "sort: -g is not supported\n"],
    ["sort -M s.txt", "sort: -M is not supported\n"],
    ["sort -R s.txt", "sort: -R is not supported\n"],
    ["sort -i s.txt", "sort: -i is not supported\n"],
    ["sort -m s.txt", "sort: -m is not supported\n"],
    ["sort -S 1M s.txt", "sort: -S is not supported\n"],
    ["sort --debug s.txt", "sort: --debug is not supported\n"],
    ["sort --sort=numeric s.txt", "sort: --sort is not supported\n"],
    ["sort --help", "sort: --help is not supported\n"],
    ["sort -k1g s.txt", "sort: key '1g': the 'g' ordering option is not supported\n"],
    ["sort -k1M s.txt", "sort: key '1M': the 'M' ordering option is not supported\n"],
    ["sort -k1,2,3 s.txt", "sort: key '1,2,3': a third position is not supported\n"],
    [
      "sort -k1.2.3 s.txt",
      "sort: key '1.2.3': more than FIELD.CHAR in a position is not supported\n",
    ],
  ])("%s", async (source, stderr) => {
    const fs = createFilesystem(new TestDatabase());
    fs.writeFiles([
      { path: "/repo", mode: 0o755 },
      { path: "/repo/s.txt", bytes: new TextEncoder().encode("b\na\n") },
    ]);
    const shell = createShell({ fs, cwd: "/repo" });
    const run = await shell.run(source);
    expect(run).toMatchObject({ exitCode: 2, stdout: "", stderr });
  });
});

describe("sort records cross read chunks", () => {
  it.each([
    "sort -t: -k2,2n -k1 fields.txt",
    "sort -n num.txt",
    "sort -V ver.txt",
    "sort nonl.txt s.txt",
    "sort -z nul.bin",
    "sort -c s.txt",
    "sort -cz nul.bin",
    "sort -C sorted.txt",
  ])("orders %s the same with a 3-byte read budget", async (source) => {
    const run = async (readBudget: number) => {
      const fs = createFilesystem(new TestDatabase());
      fs.writeFiles([
        { path: "/repo", mode: 0o755 },
        ...Object.entries(TREE).map(([relative, content]) => ({
          path: `/repo/${relative}`,
          bytes: typeof content === "string" ? new TextEncoder().encode(content) : content,
        })),
      ]);
      const limits = { maxOutputBytes: 1_000_000, maxOperations: 10_000, readBudget };
      const shell = createShell({ fs, cwd: "/repo", limits });
      const { stdout, stderr, exitCode } = await shell.exec(source);
      return { stdout, stderr, exitCode };
    };
    expect(await run(3)).toEqual(await run(1_500_000));
  });
});
