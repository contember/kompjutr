// `grep` against GNU grep, one case per shipped flag.
//
// The point of running the real binary is that it answers questions I would
// otherwise have to guess at, and it has already corrected several guesses:
// `-L`'s exit status follows the pattern, not the listing; a binary notice
// goes to stderr; the second of two adjacent matches is a match line, not a
// context line. Each of those was written the other way first.
import { afterAll, describe, expect, it } from "vitest";
import { agree, lines, ParityFixture, REAL_GREP } from "../helpers/parity.js";

const CORPUS = {
  "a.ts": "one\nNEEDLE here\ntwo\n",
  "b.ts": "nothing to see\n",
  "sub/c.ts": "NEEDLE\nNEEDLE twice\n",
  "sub/deep/d.md": "a NEEDLE inside markdown\n",
  "upper.ts": "needle in lower case\n",
  "word.ts": "NEEDLES plural\nNEEDLE alone\n",
  "dotted.ts": "NEED.E has a literal dot\n",
  "ctx.txt": "l1\nl2\nHIT one\nl4\nl5\nl6\nl7\nHIT two\nl9\n",
  "adj.txt": "a\nHIT\nHIT\nb\n",
  "nonl.txt": "NEEDLE with no trailing newline",
  ".hidden.ts": "NEEDLE in a dotfile\n",
  "bin.dat": new Uint8Array([78, 69, 69, 68, 76, 69, 0, 116, 97, 105, 108, 10]),
};
const fixture = REAL_GREP ? new ParityFixture(CORPUS) : null;
afterAll(() => {
  fixture?.cleanup();
});
/** Present so a missing GNU grep is a visible skip, not a silent pass. */
describe("the parity suite has something to compare against", () => {
  it("found GNU grep", () => {
    expect(REAL_GREP).toBe(true);
  });
});
describe.skipIf(!REAL_GREP)("grep matches GNU grep", () => {
  function compare(...argv: string[]): ReturnType<ParityFixture["compare"]> {
    if (fixture === null) throw new Error("no fixture");
    return fixture.compare("grep", ...argv);
  }
  describe("selecting what to search", () => {
    it("one file", async () => {
      agree(await compare("NEEDLE", "{root}/a.ts"));
    });
    it("several files, which turns the name prefix on", async () => {
      agree(await compare("NEEDLE", "{root}/a.ts", "{root}/b.ts", "{root}/upper.ts"));
    });
    it("-r", async () => {
      agree(await compare("-r", "NEEDLE", "{root}"), { ordered: false });
    });
    it("-R", async () => {
      agree(await compare("-R", "NEEDLE", "{root}"), { ordered: false });
    });
    it("--recursive", async () => {
      agree(await compare("--recursive", "NEEDLE", "{root}"), { ordered: false });
    });
    it("searches dotfiles, which rg does not", async () => {
      const parity = await compare("-rl", "NEEDLE", "{root}");
      agree(parity, { ordered: false });
      expect(lines(parity.ours.stdout)).toContain("/repo/.hidden.ts");
    });
    it("--include", async () => {
      agree(await compare("-rl", "--include=*.ts", "NEEDLE", "{root}"), { ordered: false });
    });
    it("--exclude", async () => {
      agree(await compare("-rl", "--exclude=c.ts", "NEEDLE", "{root}"), { ordered: false });
    });
    it("--include matching a nested file by basename", async () => {
      agree(await compare("-rl", "--include=*.md", "NEEDLE", "{root}"), { ordered: false });
    });
  });
  describe("what to print", () => {
    it("-n", async () => {
      agree(await compare("-n", "NEEDLE", "{root}/sub/c.ts"));
    });
    it("-l", async () => {
      agree(await compare("-rl", "NEEDLE", "{root}"), { ordered: false });
    });
    it("-L", async () => {
      agree(await compare("-rL", "NEEDLE", "{root}"), { ordered: false });
    });
    it("-L exits 0 when the pattern matched, whatever it listed", async () => {
      // GNU's `-L` status follows the pattern, not the listing: a run that
      // prints every file still exits 1 when nothing matched anywhere.
      const found = await compare("-rL", "NEEDLE", "{root}");
      const missing = await compare("-rL", "ABSENT", "{root}");
      agree(found, { ordered: false });
      agree(missing, { ordered: false });
      expect(found.ours.exitCode).toBe(0);
      expect(missing.ours.exitCode).toBe(1);
    });
    it("-c over several files, zeros included", async () => {
      agree(await compare("-c", "NEEDLE", "{root}/a.ts", "{root}/b.ts"));
    });
    it("-c on one file that does not match", async () => {
      agree(await compare("-c", "NEEDLE", "{root}/b.ts"));
    });
    it("-c recursive", async () => {
      agree(await compare("-rc", "NEEDLE", "{root}"), { ordered: false });
    });
    it("-h drops the name prefix", async () => {
      agree(await compare("-rh", "NEEDLE", "{root}"), { ordered: false });
    });
    it("-H adds it to a single file", async () => {
      agree(await compare("-H", "NEEDLE", "{root}/a.ts"));
    });
  });
  describe("what counts as a match", () => {
    it("-i", async () => {
      agree(await compare("-ril", "needle", "{root}"), { ordered: false });
    });
    it("-v", async () => {
      agree(await compare("-v", "NEEDLE", "{root}/a.ts"));
    });
    it("-w", async () => {
      agree(await compare("-w", "NEEDLE", "{root}/word.ts"));
    });
    it("-x", async () => {
      agree(await compare("-x", "NEEDLE", "{root}/sub/c.ts"));
    });
    it("-E", async () => {
      agree(await compare("-rlE", "NEED(L|X)E", "{root}"), { ordered: false });
    });
    it("-F takes a metacharacter as bytes", async () => {
      agree(await compare("-rlF", "NEED.E", "{root}"), { ordered: false });
    });
    it("BRE leaves + and ? literal", async () => {
      agree(await compare("-c", "NEED.E", "{root}/dotted.ts"));
    });
    it("-e", async () => {
      agree(await compare("-e", "NEEDLE", "{root}/a.ts"));
    });
    it("ORs repeated -e patterns", async () => {
      agree(await compare("-e", "NEEDLE", "-e", "plain", "{root}/a.ts"));
    });
  });
  describe("context lines", () => {
    it("-A", async () => {
      agree(await compare("-A1", "HIT", "{root}/ctx.txt"));
    });
    it("-B", async () => {
      agree(await compare("-B1", "HIT", "{root}/ctx.txt"));
    });
    it("-C", async () => {
      agree(await compare("-C1", "HIT", "{root}/ctx.txt"));
    });
    it("-C with line numbers, including the -- between groups", async () => {
      const parity = await compare("-n", "-C1", "HIT", "{root}/ctx.txt");
      agree(parity);
      expect(parity.ours.stdout).toContain("--\n");
    });
    it("adjacent matches inside one window stay match lines", async () => {
      // `3:HIT`, not `3-HIT`: the line is a match even though the previous
      // hit's context window is what emitted it.
      const parity = await compare("-n", "-C1", "HIT", "{root}/adj.txt");
      agree(parity);
      expect(parity.ours.stdout).toContain("3:HIT");
    });
  });
  describe("awkward files", () => {
    it("gives a file with no trailing newline one on the way out", async () => {
      agree(await compare("-n", "NEEDLE", "{root}/nonl.txt"));
    });
    it("reports a binary file on stderr and keeps stdout clean", async () => {
      const parity = await compare("NEEDLE", "{root}/bin.dat");
      agree(parity);
      expect(parity.ours.stdout).toBe("");
      expect(parity.ours.stderr).toBe(parity.real.stderr);
      expect(parity.ours.stderr).toBe("grep: /repo/bin.dat: binary file matches\n");
    });
    it("counts and lists a binary file like any other", async () => {
      agree(await compare("-c", "NEEDLE", "{root}/bin.dat"));
      agree(await compare("-l", "NEEDLE", "{root}/bin.dat"));
    });
  });
  describe("failures", () => {
    it("no match exits 1", async () => {
      const parity = await compare("-r", "ABSENT", "{root}");
      agree(parity, { ordered: false });
      expect(parity.ours.exitCode).toBe(1);
    });
    it("a missing file is a diagnostic and exit 2", async () => {
      const parity = await compare("NEEDLE", "{root}/missing.ts");
      agree(parity);
      expect(parity.ours.stderr).toBe(parity.real.stderr);
      expect(parity.ours.exitCode).toBe(2);
    });
    it("a directory without -r is a diagnostic and exit 2", async () => {
      const parity = await compare("NEEDLE", "{root}");
      agree(parity);
      expect(parity.ours.stderr).toBe(parity.real.stderr);
    });
    it("-s silences the diagnostic but not the status", async () => {
      const parity = await compare("-s", "NEEDLE", "{root}/missing.ts");
      agree(parity);
      expect(parity.ours.stderr).toBe("");
      expect(parity.ours.exitCode).toBe(2);
    });
  });
  describe("the shell's own guarantee, which neither binary makes", () => {
    it("walks in sorted path order", async () => {
      if (fixture === null) throw new Error("no fixture");
      const ours = lines((await fixture.shell.run("grep -rl NEEDLE /repo")).stdout);
      expect(ours).toEqual([...ours].sort());
    });
  });
});
