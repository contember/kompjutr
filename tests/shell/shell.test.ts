// End to end over a real SQLite-backed filesystem.
import { beforeEach, describe, expect, it } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import { encode } from "../../src/shell/exec/bytes.js";
import { type Command, createShell, type Shell } from "../../src/shell/index.js";
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
  fs = createFilesystem(new TestDatabase(storage), { now: () => 1700000000000 });
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
  it("cats a file", async () => {
    expect((await shell.run("cat README.md")).stdout).toBe("# Project\nA line about widgets.\n");
  });
  it("heads and tails", async () => {
    expect((await shell.run("head -2 docs/guide.md")).stdout).toBe("line1\nline2\n");
    expect((await shell.run("tail -2 docs/guide.md")).stdout).toBe("line4\nline5\n");
    expect((await shell.run("head -n 1 docs/guide.md")).stdout).toBe("line1\n");
  });
  it("counts", async () => {
    expect((await shell.run("wc -l docs/guide.md")).stdout).toBe("5\n");
    fs.writeFiles([file("/repo/unicode.txt", "é x\n")]);
    expect((await shell.run("wc -m unicode.txt")).stdout.trim()).toBe("4");
    expect((await shell.run("wc -cm unicode.txt")).stdout.trim().split(/\s+/)).toEqual(["4", "5"]);
  });
  it("heads each file independently and controls headings", async () => {
    expect((await shell.run("head -1 README.md docs/guide.md")).stdout).toBe(
      "==> README.md <==\n# Project\n\n==> docs/guide.md <==\nline1\n",
    );
    expect((await shell.run("head -q -1 README.md docs/guide.md")).stdout).toBe(
      "# Project\nline1\n",
    );
    expect((await shell.run("head -v -1 README.md")).stdout).toBe("==> README.md <==\n# Project\n");
  });
  it("reports a missing file without crashing", async () => {
    const run = await shell.run("cat nope.txt");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("No such file");
    expect(run.stdout).toBe("");
  });
});
describe("listing", () => {
  it("lists a directory", async () => {
    expect((await shell.run("ls src")).stdout.split("\n").filter(Boolean).sort()).toEqual([
      "alpha.ts",
      "beta.ts",
      "gamma.js",
      "nested",
    ]);
  });
  it("hides dotfiles unless asked", async () => {
    expect((await shell.run("ls")).stdout).not.toContain(".hidden");
    expect((await shell.run("ls -a")).stdout).toContain(".hidden");
  });
  it("finds by name", async () => {
    const found = (await shell.run("find /repo/src -name '*.ts'")).stdout
      .split("\n")
      .filter(Boolean);
    expect(found.sort()).toEqual([
      "/repo/src/alpha.ts",
      "/repo/src/beta.ts",
      "/repo/src/nested/delta.ts",
    ]);
  });
  it("renders long listings from bulk metadata", async () => {
    const run = await shell.run("ls -l src");
    expect(run.stdout).toContain("alpha.ts");
    expect(run.stdout).toContain("nested");
    expect(run.operations).toBeLessThanOrEqual(2);
  });
  it("renders recursive groups including an empty directory", async () => {
    fs.mkdir("/repo/src/empty");
    expect((await shell.run("ls -R src")).stdout).toBe(
      "/repo/src:\nalpha.ts\nbeta.ts\nempty\ngamma.js\nnested\n\n" +
        "/repo/src/empty:\n\n/repo/src/nested:\ndelta.ts\n",
    );
  });
  it("prunes hidden recursive groups unless requested", async () => {
    const hidden = (await shell.run("ls -R /repo")).stdout;
    expect(hidden).not.toContain(".hidden");
    expect(hidden).not.toContain("secret.ts");
    expect((await shell.run("ls -Ra /repo")).stdout).toContain("/repo/.hidden:\nsecret.ts\n");
  });
});
describe("grep", () => {
  it("searches one file", async () => {
    expect((await shell.run("grep widgets README.md")).stdout).toBe("A line about widgets.\n");
  });
  it("needs -r for a directory, like GNU grep", async () => {
    expect((await shell.run("grep TODO src")).exitCode).toBe(2);
    expect((await shell.run("grep -r TODO src")).exitCode).toBe(0);
  });
  it("prefixes the filename when searching several files", async () => {
    const out = (await shell.run("grep -r TODO /repo/src")).stdout.split("\n").filter(Boolean);
    expect(out).toHaveLength(3);
    expect(out.every((row) => row.startsWith("/repo/src/"))).toBe(true);
  });
  it("filters with --include", async () => {
    const out = (await shell.run("grep -rl TODO /repo/src --include=*.ts")).stdout;
    expect(out).toContain("alpha.ts");
    expect(out).toContain("delta.ts");
    expect(out).not.toContain("gamma.js");
  });
  it("searches dotfiles, unlike rg", async () => {
    expect((await shell.run("grep -rl TODO /repo")).stdout).toContain("/repo/.hidden/secret.ts");
  });
  it("counts, inverts and numbers", async () => {
    expect((await shell.run("grep -c line docs/guide.md")).stdout).toBe("5\n");
    expect((await shell.run("grep -v line1 docs/guide.md")).stdout).toBe(
      "line2\nline3\nline4\nline5\n",
    );
    expect((await shell.run("grep -n line3 docs/guide.md")).stdout).toBe("3:line3\n");
  });
  it("carries context lines", async () => {
    expect((await shell.run("grep -C1 line3 docs/guide.md")).stdout).toBe("line2\nline3\nline4\n");
  });
  it("returns 1 when nothing matched", async () => {
    expect((await shell.run("grep -r nothinghere /repo/src")).exitCode).toBe(1);
  });
  it("treats the pattern as BRE by default", async () => {
    // `\|` is alternation in GNU BRE; a bare `|` is literal.
    expect((await shell.run(String.raw`grep -c 'line1\|line2' docs/guide.md`)).stdout).toBe("2\n");
    expect((await shell.run("grep -c 'line1|line2' docs/guide.md")).stdout).toBe("0\n");
    expect((await shell.run("grep -cE 'line1|line2' docs/guide.md")).stdout).toBe("2\n");
  });
  it("ORs repeated grep patterns in files and stdin", async () => {
    expect((await shell.run("grep -e line1 -e line3 docs/guide.md")).stdout).toBe("line1\nline3\n");
    expect((await shell.run("cat docs/guide.md | grep -e line2 -e line4")).stdout).toBe(
      "line2\nline4\n",
    );
  });
  it("names a pattern construct it will not fake", async () => {
    const run = await shell.run("grep -E '(?=x)' README.md");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("lookaround");
  });
});
describe("rg is its own surface", () => {
  it("is recursive by default", async () => {
    expect((await shell.run("rg -l TODO /repo/src")).exitCode).toBe(0);
  });
  it("skips dotfiles where grep does not", async () => {
    expect((await shell.run("rg -l TODO /repo")).stdout).not.toContain(".hidden");
    expect((await shell.run("rg -l --hidden TODO /repo")).stdout).toContain(".hidden");
  });
  it("filters with -g and -t", async () => {
    expect((await shell.run("rg -l TODO -g '*.js' /repo/src")).stdout.trim()).toBe(
      "/repo/src/gamma.js",
    );
    expect((await shell.run("rg -l TODO -t ts /repo/src")).stdout).not.toContain("gamma.js");
  });
  it("excludes with a ! glob", async () => {
    expect((await shell.run("rg -l TODO -g '!*.js' /repo/src")).stdout).not.toContain("gamma.js");
  });
  it("applies smart case only with -S", async () => {
    expect((await shell.run("rg -c todo /repo/src")).exitCode).toBe(1);
    expect((await shell.run("rg -lS todo /repo/src")).exitCode).toBe(0);
    // An uppercase letter in the pattern turns smart case back off.
    expect((await shell.run("rg -lS TODO /repo/src")).exitCode).toBe(0);
  });
  it("treats the pattern as ERE without -E", async () => {
    expect((await shell.run("rg -c 'line1|line2' docs/guide.md")).stdout).toBe("2\n");
  });
  it("ORs repeated rg patterns in files and stdin", async () => {
    expect((await shell.run("rg -e line1 -e line3 docs/guide.md")).stdout).toBe("line1\nline3\n");
    expect((await shell.run("cat docs/guide.md | rg -e line2 -e line4")).stdout).toBe(
      "line2\nline4\n",
    );
  });
  it("searches the working directory when given no path", async () => {
    expect((await shell.run("rg -l TODO")).exitCode).toBe(0);
  });
});
describe("pipelines", () => {
  it("pipes into head", async () => {
    expect((await shell.run("cat docs/guide.md | head -2")).stdout).toBe("line1\nline2\n");
  });
  it("filters a listing without a second query", async () => {
    expect((await shell.run("ls src | grep beta")).stdout).toBe("beta.ts\n");
  });
  it("chains two greps", async () => {
    expect((await shell.run("cat docs/guide.md | grep line | grep 3")).stdout).toBe("line3\n");
  });
  it("fuses find into a search", async () => {
    const out = (await shell.run("find /repo/src -name '*.ts' | xargs grep -l TODO")).stdout;
    expect(out).toContain("alpha.ts");
    expect(out).not.toContain("gamma.js");
  });
  it("sorts and uniques", async () => {
    expect((await shell.run("ls src | sort -r")).stdout.split("\n")[0]).toBe("nested");
  });
  it("sorts text by UTF-8 bytes instead of UTF-16 code units", async () => {
    fs.writeFiles([file("/repo/order.txt", "𐀀\n\n")]);
    expect((await shell.run("sort order.txt")).stdout).toBe("\n𐀀\n");
  });
});
describe("connectors and redirection", () => {
  it("short-circuits on &&", async () => {
    expect((await shell.run("cat nope && echo reached")).stdout).toBe("");
    expect((await shell.run("cat README.md > /dev/null && echo reached")).exitCode).toBe(0);
  });
  it("runs the right-hand side of || only on failure", async () => {
    expect((await shell.run("grep -r zzz /repo/src || echo fallback")).stdout).toBe("fallback\n");
  });
  it("evaluates mixed AND-OR lists left to right", async () => {
    expect(await shell.run("false && echo no || echo yes")).toMatchObject({
      stdout: "yes\n",
      exitCode: 0,
    });
    expect(await shell.run("true || echo no && echo yes")).toMatchObject({
      stdout: "yes\n",
      exitCode: 0,
    });
  });
  it("continues after a skipped pipeline at a semicolon", async () => {
    expect(await shell.run("false && echo no; echo final")).toMatchObject({
      stdout: "final\n",
      exitCode: 0,
    });
    expect(await shell.run("true || echo no; echo final")).toMatchObject({
      stdout: "final\n",
      exitCode: 0,
    });
  });
  it("drops stderr on request", async () => {
    expect((await shell.run("cat nope 2>/dev/null")).stderr).toBe("");
    expect((await shell.run("cat nope")).stderr).not.toBe("");
  });
  it("merges stderr into stdout on 2>&1", async () => {
    expect((await shell.run("cat nope 2>&1")).stdout).toContain("No such file");
  });
  it("merges stderr before the downstream stage", async () => {
    const run = await shell.run("cat no1 no2 2>&1 | head -1");
    expect(run.stdout).toContain("no1");
    expect(run.stdout).not.toContain("no2");
    expect(run.stderr).toBe("");
  });
  it("preserves merged stream order from an injected command", async () => {
    const alternating: Command = (context) => ({
      stdout: (function* () {
        context.warn("before");
        yield encode("stdout\n");
        context.warn("after");
      })(),
      status: () => 0,
    });
    const injected = createShell({
      fs,
      cwd: "/repo",
      commands: new Map([["alternating", alternating]]),
    });
    expect((await injected.run("alternating 2>&1")).stdout).toBe(
      "alternating: before\nstdout\nalternating: after\n",
    );
  });
  it("writes and appends to a file", async () => {
    await shell.run("echo one > /repo/out.txt");
    await shell.run("echo two >> /repo/out.txt");
    expect((await shell.run("cat /repo/out.txt")).stdout).toBe("one\ntwo\n");
  });
  it("applies stdout redirection to an intermediate stage", async () => {
    expect((await shell.run("echo piped > /repo/intermediate.txt | cat")).stdout).toBe("");
    expect((await shell.run("cat /repo/intermediate.txt")).stdout).toBe("piped\n");
    expect((await shell.run("echo appended >> /repo/intermediate.txt | cat")).stdout).toBe("");
    expect((await shell.run("cat /repo/intermediate.txt")).stdout).toBe("piped\nappended\n");
  });
});
describe("writing", () => {
  it("copies, moves and removes", async () => {
    expect((await shell.run("cp README.md copy.md")).exitCode).toBe(0);
    expect((await shell.run("cat copy.md")).stdout).toContain("# Project");
    expect((await shell.run("mv copy.md moved.md")).exitCode).toBe(0);
    expect((await shell.run("cat copy.md")).exitCode).toBe(1);
    expect((await shell.run("rm moved.md")).exitCode).toBe(0);
    expect((await shell.run("cat moved.md")).exitCode).toBe(1);
  });
  it("copies a tree with -r", async () => {
    expect((await shell.run("cp -r src /repo/backup")).exitCode).toBe(0);
    expect((await shell.run("cat /repo/backup/nested/delta.ts")).stdout).toContain("delta");
  });
  it("refuses to remove a directory without -r", async () => {
    expect((await shell.run("rm src")).exitCode).toBe(1);
    expect((await shell.run("rm -r src")).exitCode).toBe(0);
    expect((await shell.run("ls src")).exitCode).toBe(2);
  });
  it("makes directories", async () => {
    expect((await shell.run("mkdir -p /repo/a/b/c")).exitCode).toBe(0);
    expect((await shell.run("ls /repo/a/b")).stdout).toBe("c\n");
  });
  it("touches files, directories, and symlink targets without reading content", async () => {
    let current = 2000;
    const touchFs = createFilesystem(new TestDatabase(), { now: () => current });
    const contentId = new Uint8Array([9, 8, 7]);
    touchFs.writeFiles([
      { path: "/repo/file", bytes: ENCODER.encode("content"), mtime: 1000, contentId },
      { path: "/repo/directory", mtime: 1000 },
      { path: "/repo/link", target: "/repo/file", mtime: 1000 },
    ]);
    const guarded: Filesystem = {
      ...touchFs,
      readFile: () => {
        throw new Error("touch read content");
      },
      readFiles: () => {
        throw new Error("touch read content");
      },
    };
    const touchShell = createShell({ fs: guarded, cwd: "/repo" });
    current = 3000;
    expect((await touchShell.run("touch file directory link missing")).exitCode).toBe(0);
    expect(touchFs.stat("/repo/file")).toMatchObject({ mtime: 3000, contentId });
    expect(touchFs.stat("/repo/directory")?.mtime).toBe(3000);
    expect(touchFs.stat("/repo/link")?.mtime).toBe(1000);
    expect(touchFs.stat("/repo/missing")).toMatchObject({ type: "file", size: 0 });
    expect((await touchShell.run("touch -h file")).exitCode).toBe(2);
  });
});
describe("sed ships two forms", () => {
  it("substitutes", async () => {
    expect((await shell.run("cat README.md | sed 's/widgets/gadgets/'")).stdout).toContain(
      "gadgets",
    );
  });
  it("prints a line range", async () => {
    expect((await shell.run("sed -n 2,3p docs/guide.md")).stdout).toBe("line2\nline3\n");
    expect((await shell.run("sed 2p docs/guide.md")).stdout).toBe(
      "line1\nline2\nline2\nline3\nline4\nline5\n",
    );
  });
  it("points at the container for anything else", async () => {
    const run = await shell.run("cat README.md | sed '/widgets/d'");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("container");
  });
});
describe("rejections", () => {
  it("names an unsupported construct", async () => {
    expect((await shell.run("echo $(date)")).stderr).toContain("command substitution");
    expect((await shell.run("for f in a b; do echo x; done")).stderr).toContain("`for`");
  });
  it("reports an unknown command", async () => {
    const run = await shell.run("bun run build");
    expect(run.exitCode).toBe(127);
    expect(run.stderr).toContain("command not found");
  });
  it.each([
    "ls -h",
    "ls -t",
    "ls -r",
    "ls -S",
    "cp -p README.md copy.md",
    "cp -v README.md copy.md",
    "rm -v README.md",
    "mkdir -v made",
    "mkdir -m 700 made",
    "xargs -t echo",
  ])("rejects a previously ignored flag: %s", async (source) => {
    expect(await shell.run(source)).toMatchObject({ exitCode: 2, stdout: "" });
  });
  it.each(["wc --unknown", "sort --unknown", "uniq --unknown"])(
    "returns usage errors instead of throwing: %s",
    async (source) => {
      expect(await shell.run(source)).toMatchObject({ exitCode: 2, stdout: "" });
    },
  );
  it("returns expected lazy filesystem failures", async () => {
    const run = await shell.run("uniq src");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("EISDIR");
  });
  it("does not hide arbitrary injected-command exceptions", async () => {
    const broken: Command = () => {
      throw new Error("injected defect");
    };
    const injected = createShell({ fs, cwd: "/repo", commands: new Map([["broken", broken]]) });
    await expect(injected.run("broken")).rejects.toThrow("injected defect");
  });
});
