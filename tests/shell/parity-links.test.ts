// `ln`, `rmdir`, `readlink`, and `realpath` against uutils 0.2.2, and
// `chmod` against GNU coreutils 9.5, through Bash. The seed holds regular
// files only, so each script builds its own links and directories. Absolute
// output differs by construction (a temp dir against /repo) and is pinned by
// tests/shell/links.test.ts; here only relative output is compared. No script
// clears a directory's write bit: the harness could not remove its temp tree.
// GNU chmod -R reports in readdir order, so verbose recursive cases walk
// directories with a single child.

import { describe, it } from "vitest";

import { agreeWithBash, compareWithBash, type ShellTree } from "../helpers/shell-parity.js";

const TREE: ShellTree = {
  "a.txt": "alpha\n",
  "b.txt": "beta\n",
  "d/s/f.txt": "deep\n",
  "d/g.txt": "gamma\n",
  "e/keep.txt": "keep\n",
};

async function agrees(source: string): Promise<void> {
  agreeWithBash(await compareWithBash(source, { tree: TREE }));
}

const LN: readonly string[] = [
  "ln -s a.txt l && readlink l && cat l",
  "ln -s a.txt l; ln -s a.txt l",
  'ln -sv a.txt ""',
  "ln -s b.txt a.txt",
  "ln a.txt h && cat h && ln a.txt h",
  "ln missing h",
  "ln d h",
  "ln -s missing dangling && readlink dangling && cat dangling",
  "ln -sv a.txt v",
  "ln -v a.txt hv",
  "ln -sf b.txt a.txt; readlink a.txt; cat a.txt",
  "ln -sfv a.txt a.txt",
  "ln -f a.txt a.txt",
  "ln -fv a.txt b.txt && cat b.txt",
  "ln -sv a.txt b.txt d && readlink d/a.txt d/b.txt",
  "ln -v a.txt d/ && cat d/a.txt",
  "ln -sv a.txt b.txt nowhere",
  "cd d && ln -sv ../a.txt && readlink a.txt",
  "ln a.txt",
  "ln -sT a.txt d",
  "ln -sTv a.txt t && readlink t",
  "ln -T a.txt b.txt c",
  "ln -sT a.txt",
  "ln -s d ld && ln -s a.txt ld && readlink d/a.txt",
  "ln -s d ld && ln -sfnv b.txt ld && readlink ld && ls d",
  "ln -s d ld && ln -sn z ld && ls d",
  "ln -sfT a.txt d",
  "ln -s a.txt nowhere/x",
  "ln a.txt nowhere/x",
  "ln -s a.txt a.txt/x",
  "ln a.txt a.txt/x",
  'ln -s a.txt ""',
  'ln -s "" empty',
  "ln -srv a.txt d/s/x && readlink d/s/x && cat d/s/x",
  "ln -srv d/s e && readlink e/s",
  "ln -srv nowhere/x e/n && readlink e/n",
  "ln -s d/s ls && ln -srv ls/../a.txt e/y && readlink e/y",
  "ln -r a.txt rel",
  "ln -s -- -x dash && readlink dash",
  "ln --symbolic --verbose a.txt long && ln --sym --verb b.txt long2",
  "ln",
  "ln -s",
  "ln -sx a.txt l",
];

const RMDIR: readonly string[] = [
  "mkdir -p x/y && rmdir x/y && ls x",
  "rmdir d",
  "rmdir nowhere",
  "rmdir a.txt",
  "ln -s d ld && rmdir ld",
  "ln -s d ld && rmdir ld/",
  "rmdir --ignore-fail-on-non-empty d && echo ok",
  "mkdir -p x/y/z && rmdir -pv x/y/z; ls",
  "mkdir -p x/y/z && touch x/f && rmdir -pv x/y/z",
  "mkdir -p x/y && touch x/f && rmdir -p --ignore-fail-on-non-empty x/y && ls x",
  "mkdir -p x/y && rmdir -p x/y/",
  "mkdir -p x/y && rmdir -p ./x/y",
  "mkdir x && rmdir -v x nowhere d",
  "rmdir .",
  "mkdir x && rmdir x/.",
  "mkdir x && rmdir x/..",
  "rmdir nowhere/..",
  "rmdir",
  "rmdir -x d",
];

const READLINK: readonly string[] = [
  "ln -s a.txt l && ln -s l ll && ln -s d ld && readlink l ll ld",
  "readlink a.txt",
  "readlink -v a.txt",
  "readlink nowhere; readlink -v nowhere",
  "readlink -v a.txt/x",
  "ln -s a.txt l && readlink -v a.txt l",
  "ln -s a.txt l && readlink -q a.txt; readlink -qv a.txt",
  "ln -s a.txt l && readlink -n l",
  "ln -s a.txt l && readlink -n l l",
  "ln -s a.txt l && readlink -z l l",
  "ln -s a.txt l && readlink -nz l",
  "readlink",
  "readlink -f",
  "readlink -x a.txt",
  "readlink -f nowhere/x || echo failed",
  "readlink -fv nowhere/x a.txt",
  "readlink -fv a.txt/x",
  "readlink -fv a.txt/",
  "ln -s b c && ln -s c b && readlink -fv b",
  "ln -s missing dangling && readlink -ev dangling",
  "ln -s b c && ln -s c b && readlink -mv b",
  'readlink ""; readlink -v ""',
];

const REALPATH: readonly string[] = [
  "realpath nowhere/x",
  "realpath a.txt/x",
  "realpath -e nowhere",
  "ln -s b c && ln -s c b && realpath b",
  "realpath -q nowhere/x a.txt/x || echo failed",
  "realpath -s nowhere/x a.txt/x",
  "ln -s a.txt l && realpath --relative-to=d l d/s d a.txt",
  "ln -s a.txt l && ln -s d ld && realpath --relative-to d/s l ld/s/.. e",
  "ln -s missing dangling && realpath --relative-to=d dangling nowhere/x",
  "realpath -m --relative-to=d nowhere/x/../y a.txt/x a.txt/../q",
  "ln -s a.txt l && realpath -s --relative-to=. l d/s/.. nowhere/../e",
  "ln -s a.txt l && realpath -sm --relative-to=. l nowhere/x",
  "realpath --relative-base=d d/s d/g.txt d",
  "realpath -q --relative-to=nowhere/x a.txt",
  "realpath -qe nowhere || echo failed",
  "realpath --relative-base=. --relative-to=d a.txt d/s .",
  "realpath --relative-to=nowhere a.txt",
  "realpath --relative-to=nowhere/x a.txt",
  "realpath -z --relative-to=. a.txt d",
  "realpath",
  'realpath ""',
  'realpath a.txt ""',
  "realpath -x a.txt",
];

const CHMOD: readonly string[] = [
  "chmod -v 755 a.txt; chmod -v 755 a.txt",
  "chmod -c 700 a.txt b.txt; chmod -c 700 a.txt",
  "chmod -v u+x,go-r a.txt",
  "chmod -v +x a.txt",
  "chmod -v a=r a.txt",
  "chmod -v u=rwx,g=rx,o= a.txt",
  "chmod -v =x a.txt",
  "chmod -v u+s,o+t a.txt",
  "chmod -v 4755 a.txt; chmod -v 0644 a.txt",
  "chmod -v g=u a.txt; chmod -v ug=o a.txt",
  "chmod -v u+X a.txt; chmod -v a+X d",
  "chmod -v u=g+x a.txt",
  "chmod -v 7 a.txt",
  "chmod -v 00644 a.txt",
  "chmod -v =0 a.txt; chmod -v +0 a.txt",
  "chmod -v a+rwx,u-w,+t a.txt",
  "chmod -v -x a.txt; chmod -v -rwx b.txt",
  "chmod -v -- -r a.txt",
  "chmod 755 a.txt -v -R d/s",
  "chmod --verbose 700 a.txt; chmod --changes 755 a.txt; chmod --verb 711 a.txt",
  "chmod 2755 d && chmod -v 755 d && chmod -v 00755 d",
  "chmod -v g+s d && chmod -v a=rwx d && chmod -v =755 d",
  "chmod -Rv 700 d/s",
  "chmod -R 700 d && test -x d/g.txt && echo executable",
  "chmod -Rc u+x d/s",
  "ln -s ../a.txt d/s/l && chmod -Rv 700 d/s",
  "ln -s d/s ls && chmod -Rv 711 ls",
  "ln -s a.txt l && chmod -v 600 l && test -w a.txt && echo writable",
  "ln -s missing dangling && chmod -v 644 dangling",
  "chmod 644 nowhere a.txt; chmod -v 644 nowhere/x a.txt/x",
  "chmod 999 a.txt",
  "chmod q+x a.txt",
  'chmod "" a.txt',
  "chmod , a.txt",
  "chmod u a.txt",
  "chmod -v u+ a.txt",
  "chmod 12345 a.txt",
  "chmod 644,u+x a.txt",
  "chmod 644",
  "chmod",
  "chmod -R",
  "chmod -z a.txt",
  "chmod -vz a.txt",
  "chmod --bogus a.txt",
];

describe("ln against uutils", () => {
  for (const source of LN) it(source, () => agrees(source));
});

describe("rmdir against uutils", () => {
  for (const source of RMDIR) it(source, () => agrees(source));
});

describe("readlink against uutils", () => {
  for (const source of READLINK) it(source, () => agrees(source));
});

describe("realpath against uutils", () => {
  for (const source of REALPATH) it(source, () => agrees(source));
});

describe("chmod against GNU coreutils", () => {
  for (const source of CHMOD) it(source, () => agrees(source));
});
