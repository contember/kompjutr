// `tr` against uutils tr 0.2.2 through Bash. Translation, deletion, squeezing,
// complements, truncation, the SET grammar, and its diagnostics and warnings
// compare byte for byte. tr reads only stdin; a file operand is an extra
// operand, as the reference reports it.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "f.txt": "Hello, World!\n\tTabs  and   spaces 123\n",
  "bin.bin": new Uint8Array([0x00, 0x41, 0x80, 0xff, 0x0a, 0x7f, 0x61]),
};

describe("the tr parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("tr matches uutils tr", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "tr a-z A-Z < f.txt",
    "tr A-Z a-z < f.txt",
    "tr 'a-z' 'n-za-m' < f.txt",
    "tr lo 01 < f.txt",
    "tr abcde xy < f.txt",
    "tr -t abcde xy < f.txt",
    "tr --truncate-set1 lo x < f.txt",
    "tr '\\t ' '_-' < f.txt",
    "tr '\\n' ' ' < f.txt",
    "tr '\\101\\154' 'xy' < f.txt",
    "tr '\\1011' X < f.txt",
    "tr '\\q' X < f.txt",
    "tr '\\\\' / < f.txt",
    "tr a-c-z X < f.txt",
    "tr l- X < f.txt",
    "tr -- -l X < f.txt",
    "tr '[:lower:]' '[:upper:]' < f.txt",
    "tr '[:upper:]' '[:lower:]' < f.txt",
    "tr '[:upper:][:lower:]' '[:lower:][:upper:]' < f.txt",
    "tr '[:lower:]' 'A-Z' < f.txt",
    "tr '[:alpha:]' x < f.txt",
    "tr '[:digit:]' '#' < f.txt",
    "tr '[:alnum:][:blank:]' 'X_' < f.txt",
    "tr '[:punct:]' '.' < f.txt",
    "tr '[:space:]' '.' < f.txt",
    "tr '[:foo:]' x < f.txt",
    "tr '[=l=]' x < f.txt",
    "tr a-z '[X*]' < f.txt",
    "tr a-z 'ab[X*3]Y' < f.txt",
    "tr a-z '[X*010]Y' < f.txt",
    "tr -c 'a-z\\n' X < f.txt",
    "tr -C 'l' 'XY' < f.txt",
    "tr --complement l x < f.txt",
    "tr -c '[:alpha:]\\n' '#' < f.txt",
    "tr '\\000-\\377' 'x' < bin.bin",
    "tr '\\200-\\377' '?' < bin.bin",
    "printf 'abc' | tr b B",
    "printf '' | tr a b",
    "tr a b",
  ])("translates: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "tr -d l < f.txt",
    "tr -d 'a-z' < f.txt",
    "tr -d '[:punct:][:digit:][:space:]' < f.txt",
    "tr -d '' < f.txt",
    "tr --delete o < f.txt",
    "tr --del o < f.txt",
    "tr -cd 'l\\n' < f.txt",
    "tr -dc '[:alpha:]' < f.txt",
    "tr -d '\\000\\200' < bin.bin",
    "tr -s ' ' < f.txt",
    "tr -s 'l ' < f.txt",
    "tr --squeeze-repeats l < f.txt",
    "tr -s 'a-z' 'A-Z' < f.txt",
    "tr -s lo xy < f.txt",
    "tr -cs 'a-zA-Z' '\\n' < f.txt",
    "tr -ds l ' ' < f.txt",
    "tr -ds 'a-z' 'A-Z' < f.txt",
    "tr -ss ' ' < f.txt",
    "tr -dd l < f.txt",
  ])("deletes and squeezes: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "tr < f.txt",
    "tr a < f.txt",
    "tr -s < f.txt",
    "tr -ds a < f.txt",
    "tr a b c < f.txt",
    "tr -d a b < f.txt",
    "tr -d a b c < f.txt",
    "tr a b f.txt",
    "tr z-a x < f.txt",
    "tr 'a-z' '[:upper:]' < f.txt",
    "tr -t 'a-z' '[:upper:]' < f.txt",
    "tr 'a-z' '[:digit:]' < f.txt",
    "tr '[:digit:]' '[:digit:]' < f.txt",
    "tr x '[:upper:]' < f.txt",
    "tr -c '[:lower:]' '[:upper:]' < f.txt",
    "tr 'a-z' 'x[y*a]' < f.txt",
    "tr 'a-z' '[y*2][z*]x[w*]' < f.txt",
    "tr '[y*]' x < f.txt",
    "tr '[::]' x < f.txt",
    "tr '[==]' x < f.txt",
    "tr '[=ab=]' x < f.txt",
    "tr 'abc' 'x[:lower:]' < f.txt",
    "tr 'hel' '' < f.txt",
    "tr '\\400' x < f.txt",
    "tr 'a\\400bc' x < f.txt",
    "tr 'l\\' X < f.txt",
    "tr 'l\\\\' X < f.txt",
    "tr '\\' X < f.txt",
    "tr -x a b < f.txt",
    "tr --bogus a b < f.txt",
    "tr --de a < f.txt",
    "tr --delet=x a < f.txt",
  ])("fails or warns as uutils does: %j", async (source) => {
    await compare(source);
  });
});
