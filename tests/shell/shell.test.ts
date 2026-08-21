// End to end over a real SQLite-backed filesystem.

import { beforeEach, describe, expect, it } from "vitest";

import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import { createShell, type Shell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";
import { SqliteTestStorage } from "../helpers/storage.js";

const ENCODER = new TextEncoder();

function file(path: string, text: string) {
  return { path, bytes: ENCODER.encode(text) };
}

let fs: Filesystem;
let storage: SqliteTestStorage;
let shell: Shell;

beforeEach(() => {
  storage = new SqliteTestStorage();
  fs = createFilesystem(new TestDatabase(storage), { now: () => 1_700_000_000_000 });
  fs.writeFiles([
    file("/repo/README.md", "# Project\nA line about widgets.\n"),
    file("/repo/src/alpha.ts", "export const alpha = 1;\n// TODO: widgets\n"),
    file("/repo/src/beta.ts", "export const beta = 2;\nconst plain = true;\n"),
    file("/repo/src/gamma.js", "// TODO: legacy widgets\n"),
    file("/repo/src/nested/delta.ts", "export const delta = 4;\n// TODO: nested\n"),
    file("/repo/.hidden/secret.ts", "// TODO: hidden\n"),
    file("/repo/docs/guide.md", "line1\nline2\nline3\nline4\nline5\n"),
  ]);
  shell = createShell({ fs, cwd: "/repo" });
});

describe("reading", () => {
  it("cats a file", () => {
    expect(shell.run("cat README.md").stdout).toBe("# Project\nA line about widgets.\n");
  });

  it("heads and tails", () => {
    expect(shell.run("head -2 docs/guide.md").stdout).toBe("line1\nline2\n");
    expect(shell.run("tail -2 docs/guide.md").stdout).toBe("line4\nline5\n");
    expect(shell.run("head -n 1 docs/guide.md").stdout).toBe("line1\n");
  });

  it("counts", () => {
    expect(shell.run("wc -l docs/guide.md").stdout).toBe("5\n");
  });

  it("reports a missing file without crashing", () => {
    const run = shell.run("cat nope.txt");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("No such file");
    expect(run.stdout).toBe("");
  });
});

describe("listing", () => {
  it("lists a directory", () => {
    expect(shell.run("ls src").stdout.split("\n").filter(Boolean).sort()).toEqual([
      "alpha.ts",
      "beta.ts",
      "gamma.js",
      "nested",
    ]);
  });

  it("hides dotfiles unless asked", () => {
    expect(shell.run("ls").stdout).not.toContain(".hidden");
    expect(shell.run("ls -a").stdout).toContain(".hidden");
  });

  it("finds by name", () => {
    const found = shell.run("find /repo/src -name '*.ts'").stdout.split("\n").filter(Boolean);
    expect(found.sort()).toEqual([
      "/repo/src/alpha.ts",
      "/repo/src/beta.ts",
      "/repo/src/nested/delta.ts",
    ]);
  });
});

describe("grep", () => {
  it("searches one file", () => {
    expect(shell.run("grep widgets README.md").stdout).toBe("A line about widgets.\n");
  });

  it("needs -r for a directory, like GNU grep", () => {
    expect(shell.run("grep TODO src").exitCode).toBe(2);
    expect(shell.run("grep -r TODO src").exitCode).toBe(0);
  });

  it("prefixes the filename when searching several files", () => {
    const out = shell.run("grep -r TODO /repo/src").stdout.split("\n").filter(Boolean);
    expect(out).toHaveLength(3);
    expect(out.every((row) => row.startsWith("/repo/src/"))).toBe(true);
  });

  it("filters with --include", () => {
    const out = shell.run("grep -rl TODO /repo/src --include=*.ts").stdout;
    expect(out).toContain("alpha.ts");
    expect(out).toContain("delta.ts");
    expect(out).not.toContain("gamma.js");
  });

  it("searches dotfiles, unlike rg", () => {
    expect(shell.run("grep -rl TODO /repo").stdout).toContain("/repo/.hidden/secret.ts");
  });

  it("counts, inverts and numbers", () => {
    expect(shell.run("grep -c line docs/guide.md").stdout).toBe("5\n");
    expect(shell.run("grep -v line1 docs/guide.md").stdout).toBe("line2\nline3\nline4\nline5\n");
    expect(shell.run("grep -n line3 docs/guide.md").stdout).toBe("3:line3\n");
  });

  it("carries context lines", () => {
    expect(shell.run("grep -C1 line3 docs/guide.md").stdout).toBe("line2\nline3\nline4\n");
  });

  it("returns 1 when nothing matched", () => {
    expect(shell.run("grep -r nothinghere /repo/src").exitCode).toBe(1);
  });

  it("treats the pattern as BRE by default", () => {
    // `\|` is alternation in GNU BRE; a bare `|` is literal.
    expect(shell.run(String.raw`grep -c 'line1\|line2' docs/guide.md`).stdout).toBe("2\n");
    expect(shell.run("grep -c 'line1|line2' docs/guide.md").stdout).toBe("0\n");
    expect(shell.run("grep -cE 'line1|line2' docs/guide.md").stdout).toBe("2\n");
  });

  it("names a pattern construct it will not fake", () => {
    const run = shell.run("grep -E '(?=x)' README.md");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("lookaround");
  });
});

describe("rg is its own surface", () => {
  it("is recursive by default", () => {
    expect(shell.run("rg -l TODO /repo/src").exitCode).toBe(0);
  });

  it("skips dotfiles where grep does not", () => {
    expect(shell.run("rg -l TODO /repo").stdout).not.toContain(".hidden");
    expect(shell.run("rg -l --hidden TODO /repo").stdout).toContain(".hidden");
  });

  it("filters with -g and -t", () => {
    expect(shell.run("rg -l TODO -g '*.js' /repo/src").stdout.trim()).toBe("/repo/src/gamma.js");
    expect(shell.run("rg -l TODO -t ts /repo/src").stdout).not.toContain("gamma.js");
  });

  it("excludes with a ! glob", () => {
    expect(shell.run("rg -l TODO -g '!*.js' /repo/src").stdout).not.toContain("gamma.js");
  });

  it("applies smart case only with -S", () => {
    expect(shell.run("rg -c todo /repo/src").exitCode).toBe(1);
    expect(shell.run("rg -lS todo /repo/src").exitCode).toBe(0);
    // An uppercase letter in the pattern turns smart case back off.
    expect(shell.run("rg -lS TODO /repo/src").exitCode).toBe(0);
  });

  it("treats the pattern as ERE without -E", () => {
    expect(shell.run("rg -c 'line1|line2' docs/guide.md").stdout).toBe("2\n");
  });

  it("searches the working directory when given no path", () => {
    expect(shell.run("rg -l TODO").exitCode).toBe(0);
  });
});

describe("pipelines", () => {
  it("pipes into head", () => {
    expect(shell.run("cat docs/guide.md | head -2").stdout).toBe("line1\nline2\n");
  });

  it("filters a listing without a second query", () => {
    expect(shell.run("ls src | grep beta").stdout).toBe("beta.ts\n");
  });

  it("chains two greps", () => {
    expect(shell.run("cat docs/guide.md | grep line | grep 3").stdout).toBe("line3\n");
  });

  it("fuses find into a search", () => {
    const out = shell.run("find /repo/src -name '*.ts' | xargs grep -l TODO").stdout;
    expect(out).toContain("alpha.ts");
    expect(out).not.toContain("gamma.js");
  });

  it("sorts and uniques", () => {
    expect(shell.run("ls src | sort -r").stdout.split("\n")[0]).toBe("nested");
  });
});

describe("connectors and redirection", () => {
  it("short-circuits on &&", () => {
    expect(shell.run("cat nope && echo reached").stdout).toBe("");
    expect(shell.run("cat README.md > /dev/null && echo reached").exitCode).toBe(0);
  });

  it("runs the right-hand side of || only on failure", () => {
    expect(shell.run("grep -r zzz /repo/src || echo fallback").stdout).toBe("fallback\n");
  });

  it("drops stderr on request", () => {
    expect(shell.run("cat nope 2>/dev/null").stderr).toBe("");
    expect(shell.run("cat nope").stderr).not.toBe("");
  });

  it("merges stderr into stdout on 2>&1", () => {
    expect(shell.run("cat nope 2>&1").stdout).toContain("No such file");
  });

  it("writes and appends to a file", () => {
    shell.run("echo one > /repo/out.txt");
    shell.run("echo two >> /repo/out.txt");
    expect(shell.run("cat /repo/out.txt").stdout).toBe("one\ntwo\n");
  });
});

describe("writing", () => {
  it("copies, moves and removes", () => {
    expect(shell.run("cp README.md copy.md").exitCode).toBe(0);
    expect(shell.run("cat copy.md").stdout).toContain("# Project");
    expect(shell.run("mv copy.md moved.md").exitCode).toBe(0);
    expect(shell.run("cat copy.md").exitCode).toBe(1);
    expect(shell.run("rm moved.md").exitCode).toBe(0);
    expect(shell.run("cat moved.md").exitCode).toBe(1);
  });

  it("copies a tree with -r", () => {
    expect(shell.run("cp -r src /repo/backup").exitCode).toBe(0);
    expect(shell.run("cat /repo/backup/nested/delta.ts").stdout).toContain("delta");
  });

  it("refuses to remove a directory without -r", () => {
    expect(shell.run("rm src").exitCode).toBe(1);
    expect(shell.run("rm -r src").exitCode).toBe(0);
    expect(shell.run("ls src").exitCode).toBe(2);
  });

  it("makes directories", () => {
    expect(shell.run("mkdir -p /repo/a/b/c").exitCode).toBe(0);
    expect(shell.run("ls /repo/a/b").stdout).toBe("c\n");
  });
});

describe("sed ships two forms", () => {
  it("substitutes", () => {
    expect(shell.run("cat README.md | sed 's/widgets/gadgets/'").stdout).toContain("gadgets");
  });

  it("prints a line range", () => {
    expect(shell.run("sed -n 2,3p docs/guide.md").stdout).toBe("line2\nline3\n");
  });

  it("points at the container for anything else", () => {
    const run = shell.run("cat README.md | sed '/widgets/d'");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("container");
  });
});

describe("rejections", () => {
  it("names an unsupported construct", () => {
    expect(shell.run("echo $(date)").stderr).toContain("command substitution");
    expect(shell.run("for f in a b; do echo x; done").stderr).toContain("`for`");
  });

  it("reports an unknown command", () => {
    const run = shell.run("bun run build");
    expect(run.exitCode).toBe(127);
    expect(run.stderr).toContain("command not found");
  });
});
