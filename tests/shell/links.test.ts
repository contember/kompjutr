// Local pins for the link family where Bash parity cannot see: absolute
// output (the parity sides live under different roots), modes observed
// through the filesystem, the fixed umask, refusals, and `chmod -R` cost.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import type { Filesystem, WriteEntry } from "../../packages/do/src/fs/types.js";
import { createShell, type RunResult } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();

function project(extra: readonly WriteEntry[] = []): Filesystem {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1_700_000_000_000 });
  fs.writeFiles([
    { path: "/repo/a.txt", bytes: ENCODER.encode("alpha\n"), mode: 0o644 },
    { path: "/repo/d/s/f.txt", bytes: ENCODER.encode("deep\n"), mode: 0o644 },
    ...extra,
  ]);
  fs.symlink("a.txt", "/repo/l");
  fs.symlink("d/s", "/repo/ls");
  fs.symlink("missing", "/repo/dangling");
  return fs;
}

function run(fs: Filesystem, source: string): Promise<RunResult> {
  return createShell({ fs, cwd: "/repo" }).run(source);
}

function modeOf(fs: Filesystem, path: string): string {
  return ((fs.statTarget(path)?.mode ?? 0) & 0o7777).toString(8).padStart(4, "0");
}

describe("absolute resolution", () => {
  it("readlink -f, -e, and -m resolve every link", async () => {
    const fs = project();
    const out = await run(fs, "readlink -f l ls/.. dangling; readlink -m nowhere/x/../y a.txt/x");
    expect(out.stdout).toBe(
      "/repo/a.txt\n/repo/d\n/repo/missing\n/repo/nowhere/y\n/repo/a.txt/x\n",
    );
    expect(out.exitCode).toBe(0);
    expect((await run(fs, 'readlink -e ls/f.txt ""')).stdout).toBe("/repo/d/s/f.txt\n/repo\n");
  });

  it("-m keeps resolving links met after a missing component", async () => {
    const out = await run(project(), "readlink -m nowhere/../ls/x");
    expect(out.stdout).toBe("/repo/d/s/x\n");
  });

  it("realpath resolves, strips, and relativises", async () => {
    const fs = project();
    expect((await run(fs, "realpath l ls dangling")).stdout).toBe(
      "/repo/a.txt\n/repo/d/s\n/repo/missing\n",
    );
    expect((await run(fs, "realpath -s l ls/..")).stdout).toBe("/repo/l\n/repo\n");
    expect((await run(fs, "realpath --relative-to=d/s / a.txt")).stdout).toBe(
      "../../..\n../../a.txt\n",
    );
    expect((await run(fs, "realpath --relative-base=d a.txt d/s")).stdout).toBe("/repo/a.txt\ns\n");
    expect((await run(fs, "realpath --relative-to=d --relative-base=d/s d/s a.txt")).stdout).toBe(
      "/repo/d/s\n/repo/a.txt\n",
    );
  });

  it("ln -r spells an absolute target from the link's directory", async () => {
    const fs = project();
    const out = await run(fs, "ln -srv /repo/d/s/f.txt d/rel");
    expect(out.stdout).toBe("'d/rel' -> 's/f.txt'\n");
    expect(fs.readlink("/repo/d/rel")).toBe("s/f.txt");
  });

  it("rmdir -p climbs an absolute operand until a parent is not empty", async () => {
    const fs = project();
    fs.makeDirectories(["/repo/x/y/z"]);
    const out = await run(fs, "rmdir -pv /repo/x/y/z");
    expect(out.stdout).toBe(
      "rmdir: removing directory, '/repo/x/y/z'\nrmdir: removing directory, '/repo/x/y'\n" +
        "rmdir: removing directory, '/repo/x'\nrmdir: removing directory, '/repo'\n",
    );
    expect(out.stderr).toBe("rmdir: failed to remove '/repo': Directory not empty\n");
    expect(fs.stat("/repo/x")).toBeNull();
  });
});

describe("links and modes in the filesystem", () => {
  it("ln creates symlinks and hard links the store can see", async () => {
    const fs = project();
    expect((await run(fs, "ln a.txt h && ln -s d/s/f.txt sl")).exitCode).toBe(0);
    expect(fs.stat("/repo/h")?.ino).toBe(fs.stat("/repo/a.txt")?.ino);
    expect(fs.stat("/repo/a.txt")?.nlink).toBe(2);
    expect(fs.stat("/repo/sl")?.target).toBe("d/s/f.txt");
  });

  it("chmod writes octal and symbolic modes, following a named link", async () => {
    const fs = project();
    await run(fs, "chmod 750 a.txt && chmod g-x,o+r l && chmod u+s,+t d/s/f.txt");
    expect(modeOf(fs, "/repo/a.txt")).toBe("0744");
    expect(modeOf(fs, "/repo/d/s/f.txt")).toBe("5644");
    expect(fs.stat("/repo/l")?.type).toBe("symlink");
  });

  it("chmod -R changes the tree and leaves inner links alone", async () => {
    const fs = project();
    fs.symlink("../../a.txt", "/repo/d/s/up");
    await run(fs, "chmod -R go= d");
    expect(modeOf(fs, "/repo/d")).toBe("0700");
    expect(modeOf(fs, "/repo/d/s")).toBe("0700");
    expect(modeOf(fs, "/repo/d/s/f.txt")).toBe("0600");
    expect(modeOf(fs, "/repo/a.txt")).toBe("0644");
  });
});

describe("chmod applies the fixed umask 022", () => {
  it("masks who-less + and - but not an explicit who", async () => {
    const fs = project();
    const out = await run(fs, "chmod 444 a.txt && chmod -v +w a.txt && chmod -v a+w a.txt");
    expect(out.stdout).toBe(
      "mode of 'a.txt' changed from 0444 (r--r--r--) to 0644 (rw-r--r--)\n" +
        "mode of 'a.txt' changed from 0644 (rw-r--r--) to 0666 (rw-rw-rw-)\n",
    );
    expect(modeOf(fs, "/repo/a.txt")).toBe("0666");
  });

  it("reports a mode option the umask blocked, as GNU does", async () => {
    const fs = project();
    const out = await run(fs, "chmod 666 a.txt && chmod -w a.txt");
    expect(out.stderr).toBe("chmod: a.txt: new permissions are r--rw-rw-, not r--r--r--\n");
    expect(out.exitCode).toBe(1);
    expect(modeOf(fs, "/repo/a.txt")).toBe("0466");
  });
});

describe("refusals", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["ln -t d a.txt", "ln: -t is not supported\n"],
    ["ln -b a.txt b", "ln: -b is not supported\n"],
    ["ln --backup a.txt b", "ln: --backup is not supported\n"],
    ["ln -i a.txt b", "ln: -i is not supported\n"],
    ["ln -L a.txt b", "ln: -L is not supported\n"],
    ["ln --bogus a.txt b", "ln: unrecognized option '--bogus'\n"],
    ["ln l hard", "ln: hard links to symbolic links are not supported\n"],
    ["chmod -f 644 a.txt", "chmod: -f is not supported\n"],
    ["chmod --reference=a.txt l", "chmod: --reference is not supported\n"],
    ["chmod --preserve-root 644 a.txt", "chmod: --preserve-root is not supported\n"],
    ["chmod -h 644 l", "chmod: -h is not supported\n"],
    ["chmod --no 644 a.txt", "chmod: option '--no' is ambiguous\n"],
    ["realpath -L a.txt", "realpath: -L is not supported\n"],
    ["realpath --physical a.txt", "realpath: --physical is not supported\n"],
    ["readlink --canon l", "readlink: unrecognized option '--canon'\n"],
  ];
  for (const [source, stderr] of cases) {
    it(source, async () => {
      const out = await run(project(), source);
      expect(out.stderr).toBe(stderr);
      expect(out.exitCode).toBe(2);
    });
  }

  it("a refused hard link leaves no link behind", async () => {
    const fs = project();
    await run(fs, "ln l hard");
    expect(fs.stat("/repo/hard")).toBeNull();
  });
});

describe("chmod -R cost", () => {
  const FILES = 200;
  const DIRECTORIES = 11;
  const tree = (mode: number): WriteEntry[] =>
    Array.from({ length: FILES }, (_, index) => ({
      path: `/repo/t/d${index % 10}/f${index}.txt`,
      bytes: ENCODER.encode("x\n"),
      mode,
    }));

  it("an unchanged tree costs pages, not files", async () => {
    const fs = project(tree(0o644));
    fs.makeDirectories(["/repo/t"]);
    const out = await run(fs, "chmod -R u+rw t");
    expect(out.exitCode).toBe(0);
    expect(out.operations).toBeLessThanOrEqual(5);
  });

  // No bulk chmod seam exists on BoundedFs, so a changed entry costs one call;
  // the listing itself stays one scan per 1,000 entries.
  it("a changing tree costs one call per changed entry plus pages", async () => {
    const fs = project(tree(0o644));
    const out = await run(fs, "chmod -R 600 t");
    expect(out.exitCode).toBe(0);
    expect(out.operations).toBeLessThanOrEqual(FILES + DIRECTORIES + 5);
    expect(modeOf(fs, "/repo/t/d3/f13.txt")).toBe("0600");
  });
});
