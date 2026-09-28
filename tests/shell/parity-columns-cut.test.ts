// `cut` against uutils cut 0.2.2 through Bash. Byte and field lists, the
// delimiter forms, `--complement`, `--output-delimiter`, `-z`, and uutils'
// clap and usage diagnostics compare byte for byte.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "f.txt": "a:b:c\nd:e\nnodelim\n",
  "tab.txt": "one\ttwo\tthree\nsolo\n",
  "nonl.txt": "a:b",
  "csv.txt": "id,name,age\n1,ann,30\n2,bob,41\n",
  "ws.txt": "a  b\t c\n  lead\n",
  "utf.txt": "héllo:wörld\n",
  "sub/x.txt": "x:y\n",
};

describe("the cut parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("cut matches uutils cut", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "cut -b 1 f.txt",
    "cut -b 2-3 f.txt",
    "cut -b -2 f.txt",
    "cut -b 3- f.txt",
    "cut -b 1,3 f.txt",
    "cut -b 1,3-4,6- f.txt",
    "cut -c 2-3 f.txt",
    "cut -c 1-2 utf.txt",
    "cut -b 2- --complement f.txt",
    "cut -b 1,3 --output-delimiter=_ f.txt",
    "cut -b 1-2,4- --output-delimiter=_ f.txt",
    "cut -b 1,2 --output-delimiter=_ f.txt",
    "cut -b 99 f.txt",
    "cut -b '1 3' f.txt",
    "cut -b +2 f.txt",
    "cut --bytes=1 f.txt",
    "cut --byte 1 f.txt",
    "cut --characters=2 f.txt",
    "cut -b1 nonl.txt",
  ])("selects bytes: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "cut -f 2 tab.txt",
    "cut -f 1,3 tab.txt",
    "cut -f 2- tab.txt",
    "cut -s -f 2 tab.txt",
    "cut -d : -f 2 f.txt",
    "cut -d: -f1 f.txt",
    "cut -d: -f 2 -s f.txt",
    "cut -sf1 -d: f.txt",
    "cut -d , -f 2,3 csv.txt",
    "cut -d , -f -2 csv.txt",
    "cut -d , -f 3,1 csv.txt",
    "cut -d , -f 1-2,3 csv.txt",
    "cut -d , -f 2 --complement csv.txt",
    "cut -d , -f 1,3 --output-delimiter=' | ' csv.txt",
    "cut -d , -f 1- --output-delimiter=: csv.txt",
    "cut -d : -f 2,1 --complement f.txt",
    "cut -d : -f 5 f.txt",
    "cut -d : -f 1,5 f.txt",
    "cut -d: -f1-2,3 nonl.txt",
    "cut -d: -f1-2,3 --output-delimiter=_ nonl.txt",
    "cut -d: -f2,3 nonl.txt",
    "cut -d: -f1 nonl.txt",
    "cut -d '' -f 1 f.txt",
    "cut -d= -f1 f.txt",
    "cut -d ö -f 1 utf.txt",
    "cut -d - -f1 f.txt",
    "cut -d: -d, -f1 csv.txt",
    "cut --delimiter=: --fields=2 f.txt",
    "cut --field=1 -d: f.txt",
    "cut --complemen -f 1 -d: f.txt",
    "cut -w -f 2 ws.txt",
    "cut -w -f 1,3 --output-delimiter=, ws.txt",
    "cut -f 1 -d: f.txt f.txt",
    "cut -f 1 -d: sub/x.txt f.txt",
  ])("selects fields: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "printf 'a:b\\nc:d\\n' | cut -d: -f2",
    "printf 'a:b\\nc:d\\n' | cut -d: -f2 -",
    "printf 'a:b\\nc:d\\n' | cut -d: -f2 - f.txt -",
    "printf 'x:y' | cut -d: -f1",
    "printf 'nod' | cut -d: -f1",
    "printf 'ab' | cut -b1",
    "printf '' | cut -b1",
    "printf '\\n\\n' | cut -d: -f1",
    "printf 'a:b\\0c:d\\0' | cut -z -d: -f2",
    "printf 'a:b\\nc\\0d:e' | cut -z -d: -f1",
    "printf 'ab\\0cd' | cut -z -b 1",
    "cut -d: -f1 < f.txt",
  ])("reads stdin: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "cut f.txt",
    "cut -f 0 f.txt",
    "cut -f 3-2 f.txt",
    "cut -b 0- f.txt",
    "cut -b 1-0 f.txt",
    "cut -f -0 f.txt",
    "cut -f - f.txt",
    "cut -f a f.txt",
    "cut -f '' f.txt",
    "cut -f 1,,2 f.txt",
    "cut -f 1--2 f.txt",
    "cut -f 99999999999999999999 f.txt",
    "cut -f 1 -f 2 f.txt",
    "cut -f 1 -b 1 f.txt",
    "cut -d :: -f 1 f.txt",
    "cut -b 1 -d : f.txt",
    "cut -b 1 -s f.txt",
    "cut -b 1 -w f.txt",
    "cut -d : -w -f 1 f.txt",
    "cut -f 1 missing.txt",
    "cut -d: -f1 missing.txt f.txt",
    "cut -d: -f1 sub f.txt",
    "cut -f 1 -d : -- -x",
    "cut -x f.txt",
    "cut -sx f.txt",
    "cut --bogus f.txt",
    "cut --fieldz=1 f.txt",
    "cut --c 1 f.txt",
    "cut -s=1 f.txt",
    "cut --complement=x -f1 f.txt",
    "cut -f",
    "cut --output-delimiter -f1 f.txt",
    "cut -f 1 missing.txt 2>/dev/null || echo failed",
  ])("fails as uutils does: %j", async (source) => {
    await compare(source);
  });
});
