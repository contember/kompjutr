// `nl` (uutils 0.2.2) and `rev` (util-linux 2.41) through Bash. Numbering
// styles, formats, widths, separators, section delimiters, and both tools'
// diagnostics compare byte for byte; `rev` runs in the C locale, where a byte
// above 0x7f stops it.

import { describe, expect, it } from "vitest";

import {
  agreeWithBash,
  compareWithBash,
  REAL_BASH,
  type ShellTree,
} from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "e.txt": "a\n\nb\n",
  "blank.txt": "x\n\n\n\n\ny\n",
  "nonl.txt": "last",
  "sections.txt": "pre\n\\:\\:\\:\nhead\n\\:\\:\nbody\n\n\\:\nfoot\n",
  "custom.txt": "a\nxyxy\nb\nx:\nc\n",
  "utf.txt": "héllo\n",
  "bad.bin": new Uint8Array([0x61, 0x62, 0x0a, 0x68, 0xc3, 0x78, 0x0a, 0x63, 0x0a]),
  "ctl.bin": new Uint8Array([0x7f, 0x01, 0x61, 0x00, 0x62, 0x0d, 0x0a]),
  "z.bin": new Uint8Array([0x61, 0x62, 0x00, 0x63, 0x0a, 0x64, 0x00, 0x65]),
};

describe("the nl and rev parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("nl matches uutils nl", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "nl e.txt",
    "nl -b a e.txt",
    "nl -ba e.txt",
    "nl -b t e.txt",
    "nl -b n e.txt",
    "nl --body-numbering=a e.txt",
    "nl -n ln e.txt",
    "nl -n rn e.txt",
    "nl -n rz e.txt",
    "nl -n=ln e.txt",
    "nl -n rz -w 3 e.txt",
    "nl -w 1 blank.txt",
    "nl -w 30 -n rz e.txt",
    "nl -s ': ' e.txt",
    "nl -s '' e.txt",
    "nl -v 10 e.txt",
    "nl -v 10 -i 5 e.txt",
    "nl -v +5 e.txt",
    "nl -v=5 e.txt",
    "nl -v-3 -n rz e.txt",
    "nl -v-3 -n ln e.txt",
    "nl -v=-3 e.txt",
    "nl -i=-1 e.txt",
    "nl --line-increment=-2 -v 3 e.txt",
    "nl -b a -l 2 blank.txt",
    "nl -b a -l 3 blank.txt",
    "nl -b a -l 0 blank.txt",
    "nl -v 9223372036854775807 e.txt",
    "nl nonl.txt",
    "nl utf.txt",
    "nl bad.bin",
    "nl e.txt e.txt",
    "nl e.txt - e.txt < nonl.txt",
    "nl - - < e.txt",
    "printf 'x\\ny\\n' | nl",
    "printf '' | nl",
    "nl sections.txt",
    "nl -h a -f a sections.txt",
    "nl -h t -b n -f a sections.txt",
    "nl -p sections.txt",
    "nl -d xy custom.txt",
    "nl -d x custom.txt",
    "nl -d '' sections.txt",
  ])("numbers: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "nl -b x e.txt",
    "nl -b '' e.txt",
    "nl -b x -h y -w 0 e.txt",
    "nl -w 0 e.txt",
    "nl -n xx e.txt",
    "nl -n '' e.txt",
    "nl -n",
    "nl -n -p e.txt",
    "nl -w",
    "nl -w -p e.txt",
    "nl -w -x e.txt",
    "nl -w -- e.txt",
    "nl -w abc e.txt",
    "nl -w=-1 e.txt",
    "nl -i abc e.txt",
    "nl -i + e.txt",
    "nl -v - e.txt",
    "nl -v '' e.txt",
    "nl -l=-1 e.txt",
    "nl -v 9223372036854775808 e.txt",
    "nl -v=-9223372036854775809 e.txt",
    "nl -v 12345678901234567890123 e.txt",
    "nl -w 3 -w 4 e.txt",
    "nl -w abc -w 3 e.txt",
    "nl -b a -b t e.txt",
    "nl -x e.txt",
    "nl --bogus e.txt",
    "nl missing.txt e.txt",
    "nl e.txt missing.txt e.txt",
    "nl . e.txt",
  ])("fails as uutils does: %j", async (source) => {
    await compare(source);
  });
});

describe.skipIf(!REAL_BASH)("rev matches util-linux rev", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source, { tree: TREE }));
  }

  it.each([
    "rev e.txt",
    "rev nonl.txt",
    "rev e.txt nonl.txt e.txt",
    "rev ctl.bin",
    "rev -0 z.bin",
    "rev --zero z.bin",
    "rev --ze z.bin",
    "rev -- e.txt",
    "rev e.txt -0",
    "printf 'abc\\ndef' | rev",
    "printf '' | rev",
    "printf '\\n\\n' | rev",
    "rev < e.txt",
    "rev",
    "rev utf.txt",
    "rev bad.bin e.txt",
    "rev e.txt missing.txt e.txt",
    "rev e.txt . e.txt",
    "rev -",
    "rev -x e.txt",
    "rev -0x e.txt",
    "rev --foo e.txt",
    "rev --zero=1 e.txt",
  ])("reverses: %j", async (source) => {
    await compare(source);
  });
});
