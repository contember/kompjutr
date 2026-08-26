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
    it("one file", () => {
      agree(compare("NEEDLE", "{root}/a.ts"));
    });

    it("several files, which turns the name prefix on", () => {
      agree(compare("NEEDLE", "{root}/a.ts", "{root}/b.ts", "{root}/upper.ts"));
    });

    it("-r", () => {
      agree(compare("-r", "NEEDLE", "{root}"), { ordered: false });
    });

    it("-R", () => {
      agree(compare("-R", "NEEDLE", "{root}"), { ordered: false });
    });

    it("--recursive", () => {
      agree(compare("--recursive", "NEEDLE", "{root}"), { ordered: false });
    });

    it("searches dotfiles, which rg does not", () => {
      const parity = compare("-rl", "NEEDLE", "{root}");
      agree(parity, { ordered: false });
      expect(lines(parity.ours.stdout)).toContain("/repo/.hidden.ts");
    });

    it("--include", () => {
      agree(compare("-rl", "--include=*.ts", "NEEDLE", "{root}"), { ordered: false });
    });

    it("--exclude", () => {
      agree(compare("-rl", "--exclude=c.ts", "NEEDLE", "{root}"), { ordered: false });
    });

    it("--include matching a nested file by basename", () => {
      agree(compare("-rl", "--include=*.md", "NEEDLE", "{root}"), { ordered: false });
    });
  });

  describe("what to print", () => {
    it("-n", () => {
      agree(compare("-n", "NEEDLE", "{root}/sub/c.ts"));
    });

    it("-l", () => {
      agree(compare("-rl", "NEEDLE", "{root}"), { ordered: false });
    });

    it("-L", () => {
      agree(compare("-rL", "NEEDLE", "{root}"), { ordered: false });
    });

    it("-L exits 0 when the pattern matched, whatever it listed", () => {
      // GNU's `-L` status follows the pattern, not the listing: a run that
      // prints every file still exits 1 when nothing matched anywhere.
      const found = compare("-rL", "NEEDLE", "{root}");
      const missing = compare("-rL", "ABSENT", "{root}");
      agree(found, { ordered: false });
      agree(missing, { ordered: false });
      expect(found.ours.exitCode).toBe(0);
      expect(missing.ours.exitCode).toBe(1);
    });

    it("-c over several files, zeros included", () => {
      agree(compare("-c", "NEEDLE", "{root}/a.ts", "{root}/b.ts"));
    });

    it("-c on one file that does not match", () => {
      agree(compare("-c", "NEEDLE", "{root}/b.ts"));
    });

    it("-c recursive", () => {
      agree(compare("-rc", "NEEDLE", "{root}"), { ordered: false });
    });

    it("-h drops the name prefix", () => {
      agree(compare("-rh", "NEEDLE", "{root}"), { ordered: false });
    });

    it("-H adds it to a single file", () => {
      agree(compare("-H", "NEEDLE", "{root}/a.ts"));
    });
  });

  describe("what counts as a match", () => {
    it("-i", () => {
      agree(compare("-ril", "needle", "{root}"), { ordered: false });
    });

    it("-v", () => {
      agree(compare("-v", "NEEDLE", "{root}/a.ts"));
    });

    it("-w", () => {
      agree(compare("-w", "NEEDLE", "{root}/word.ts"));
    });

    it("-x", () => {
      agree(compare("-x", "NEEDLE", "{root}/sub/c.ts"));
    });

    it("-E", () => {
      agree(compare("-rlE", "NEED(L|X)E", "{root}"), { ordered: false });
    });

    it("-F takes a metacharacter as bytes", () => {
      agree(compare("-rlF", "NEED.E", "{root}"), { ordered: false });
    });

    it("BRE leaves + and ? literal", () => {
      agree(compare("-c", "NEED.E", "{root}/dotted.ts"));
    });

    it("-e", () => {
      agree(compare("-e", "NEEDLE", "{root}/a.ts"));
    });

    it("ORs repeated -e patterns", () => {
      agree(compare("-e", "NEEDLE", "-e", "plain", "{root}/a.ts"));
    });
  });

  describe("context lines", () => {
    it("-A", () => {
      agree(compare("-A1", "HIT", "{root}/ctx.txt"));
    });

    it("-B", () => {
      agree(compare("-B1", "HIT", "{root}/ctx.txt"));
    });

    it("-C", () => {
      agree(compare("-C1", "HIT", "{root}/ctx.txt"));
    });

    it("-C with line numbers, including the -- between groups", () => {
      const parity = compare("-n", "-C1", "HIT", "{root}/ctx.txt");
      agree(parity);
      expect(parity.ours.stdout).toContain("--\n");
    });

    it("adjacent matches inside one window stay match lines", () => {
      // `3:HIT`, not `3-HIT`: the line is a match even though the previous
      // hit's context window is what emitted it.
      const parity = compare("-n", "-C1", "HIT", "{root}/adj.txt");
      agree(parity);
      expect(parity.ours.stdout).toContain("3:HIT");
    });
  });

  describe("awkward files", () => {
    it("gives a file with no trailing newline one on the way out", () => {
      agree(compare("-n", "NEEDLE", "{root}/nonl.txt"));
    });

    it("reports a binary file on stderr and keeps stdout clean", () => {
      const parity = compare("NEEDLE", "{root}/bin.dat");
      agree(parity);
      expect(parity.ours.stdout).toBe("");
      expect(parity.ours.stderr).toBe(parity.real.stderr);
      expect(parity.ours.stderr).toBe("grep: /repo/bin.dat: binary file matches\n");
    });

    it("counts and lists a binary file like any other", () => {
      agree(compare("-c", "NEEDLE", "{root}/bin.dat"));
      agree(compare("-l", "NEEDLE", "{root}/bin.dat"));
    });
  });

  describe("failures", () => {
    it("no match exits 1", () => {
      const parity = compare("-r", "ABSENT", "{root}");
      agree(parity, { ordered: false });
      expect(parity.ours.exitCode).toBe(1);
    });

    it("a missing file is a diagnostic and exit 2", () => {
      const parity = compare("NEEDLE", "{root}/missing.ts");
      agree(parity);
      expect(parity.ours.stderr).toBe(parity.real.stderr);
      expect(parity.ours.exitCode).toBe(2);
    });

    it("a directory without -r is a diagnostic and exit 2", () => {
      const parity = compare("NEEDLE", "{root}");
      agree(parity);
      expect(parity.ours.stderr).toBe(parity.real.stderr);
    });

    it("-s silences the diagnostic but not the status", () => {
      const parity = compare("-s", "NEEDLE", "{root}/missing.ts");
      agree(parity);
      expect(parity.ours.stderr).toBe("");
      expect(parity.ours.exitCode).toBe(2);
    });
  });

  describe("the shell's own guarantee, which neither binary makes", () => {
    it("walks in sorted path order", () => {
      if (fixture === null) throw new Error("no fixture");
      const ours = lines(fixture.shell.run("grep -rl NEEDLE /repo").stdout);
      expect(ours).toEqual([...ours].sort());
    });
  });
});
