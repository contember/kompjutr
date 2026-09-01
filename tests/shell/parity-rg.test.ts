// `rg` against real ripgrep, one case per shipped flag.
//
// rg is not an alias for `grep` and this suite is where that stops being an
// assertion in a comment. The divergences in docs/archive/plans/shell.md §5.1 are
// each pinned here as a *difference from grep's answer on the same corpus*,
// so aliasing the two would fail loudly rather than quietly returning the
// wrong set of files.
import { afterAll, describe, expect, it } from "vitest";
import { agree, lines, ParityFixture, REAL_RG } from "../helpers/parity.js";

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
  ".hidden.ts": "NEEDLE in a dotfile\n",
  "bin.dat": new Uint8Array([78, 69, 69, 68, 76, 69, 0, 116, 97, 105, 108, 10]),
};
const fixture = REAL_RG ? new ParityFixture(CORPUS) : null;
afterAll(() => {
  fixture?.cleanup();
});
describe("the parity suite has something to compare against", () => {
  it("found ripgrep", () => {
    expect(REAL_RG).toBe(true);
  });
});
describe.skipIf(!REAL_RG)("rg matches ripgrep", () => {
  function compare(...argv: string[]): ReturnType<ParityFixture["compare"]> {
    if (fixture === null) throw new Error("no fixture");
    return fixture.compare("rg", ...argv);
  }
  describe("the defaults that differ from grep", () => {
    it("searches recursively with no -r", async () => {
      agree(await compare("-l", "NEEDLE", "{root}"));
    });
    it("skips dotfiles", async () => {
      const parity = await compare("-l", "NEEDLE", "{root}");
      agree(parity);
      expect(lines(parity.ours.stdout)).not.toContain("/repo/.hidden.ts");
    });
    it("--hidden brings them back", async () => {
      const parity = await compare("--hidden", "-l", "NEEDLE", "{root}");
      agree(parity);
      expect(lines(parity.ours.stdout)).toContain("/repo/.hidden.ts");
    });
    it("is ERE, so + is an operator with no -E", async () => {
      agree(await compare("-l", "NEEDLE+", "{root}"));
    });
    it("-c lists only files that matched, where grep prints zeros", async () => {
      const parity = await compare("-c", "NEEDLE", "{root}");
      agree(parity);
      expect(parity.ours.stdout).not.toContain(":0");
    });
  });
  describe("selecting what to search", () => {
    it("-g", async () => {
      agree(await compare("-l", "-g", "*.ts", "NEEDLE", "{root}"));
    });
    it("-g with a ! prefix excludes", async () => {
      agree(await compare("-l", "-g", "!*.md", "NEEDLE", "{root}"));
    });
    it("--glob", async () => {
      agree(await compare("-l", "--glob=*.md", "NEEDLE", "{root}"));
    });
    it("-t", async () => {
      agree(await compare("-l", "-t", "ts", "NEEDLE", "{root}"));
    });
    it("--type", async () => {
      agree(await compare("-l", "--type=md", "NEEDLE", "{root}"));
    });
    it("one explicit file gets no name prefix", async () => {
      agree(await compare("NEEDLE", "{root}/a.ts"));
    });
  });
  describe("what to print", () => {
    it("-n", async () => {
      agree(await compare("-n", "NEEDLE", "{root}/sub/c.ts"));
    });
    it("-N", async () => {
      agree(await compare("-N", "NEEDLE", "{root}/sub/c.ts"));
    });
    it("-l", async () => {
      agree(await compare("-l", "NEEDLE", "{root}"));
    });
    it("--files-with-matches", async () => {
      agree(await compare("--files-with-matches", "NEEDLE", "{root}"));
    });
    it("--no-filename", async () => {
      agree(await compare("--no-filename", "NEEDLE", "{root}"));
    });
    it("--with-filename", async () => {
      agree(await compare("--with-filename", "NEEDLE", "{root}/a.ts"));
    });
    it("--no-heading is already the piped shape", async () => {
      agree(await compare("--no-heading", "-n", "NEEDLE", "{root}/a.ts"));
    });
  });
  describe("what counts as a match", () => {
    it("-i", async () => {
      agree(await compare("-i", "-l", "needle", "{root}"));
    });
    it("-S is insensitive on a lowercase pattern", async () => {
      agree(await compare("-S", "-l", "needle", "{root}"));
    });
    it("-S is sensitive once the pattern carries an uppercase letter", async () => {
      agree(await compare("-S", "-l", "Needle", "{root}"));
    });
    it("-s forces sensitivity back on", async () => {
      agree(await compare("-s", "-l", "needle", "{root}"));
    });
    it("-v", async () => {
      agree(await compare("-v", "NEEDLE", "{root}/a.ts"));
    });
    it("-F", async () => {
      agree(await compare("-F", "-l", "NEED.E", "{root}"));
    });
    it("-w", async () => {
      agree(await compare("-w", "NEEDLE", "{root}/word.ts"));
    });
    it("-x", async () => {
      agree(await compare("-x", "NEEDLE", "{root}/sub/c.ts"));
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
      agree(await compare("-A", "1", "HIT", "{root}/ctx.txt"));
    });
    it("-B", async () => {
      agree(await compare("-B", "1", "HIT", "{root}/ctx.txt"));
    });
    it("-C with line numbers", async () => {
      agree(await compare("-n", "-C", "1", "HIT", "{root}/ctx.txt"));
    });
    it("adjacent matches inside one window stay match lines", async () => {
      const parity = await compare("-n", "-C", "1", "HIT", "{root}/adj.txt");
      agree(parity);
      expect(parity.ours.stdout).toContain("3:HIT");
    });
  });
  describe("awkward files", () => {
    it("reports a binary file on stdout, where grep uses stderr", async () => {
      const parity = await compare("NEEDLE", "{root}/bin.dat");
      agree(parity);
      expect(parity.ours.stdout).toContain("binary file matches");
      expect(parity.ours.stderr).toBe("");
    });
    it("names the binary file when more than one is searched", async () => {
      agree(await compare("NEEDLE", "{root}/a.ts", "{root}/bin.dat"));
    });
  });
  describe("failures", () => {
    it("no match exits 1", async () => {
      const parity = await compare("-l", "ABSENT", "{root}");
      agree(parity);
      expect(parity.ours.exitCode).toBe(1);
    });
  });
});
