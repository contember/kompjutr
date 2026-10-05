import { describe, expect, test } from "vitest";
import { agree, type Corpus, ParityFixture, REAL_RG } from "../helpers/parity.js";

function records(output: string): unknown[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record: unknown = JSON.parse(line, (key: string, value: unknown) =>
        key === "elapsed" || key === "elapsed_total" ? undefined : value,
      );
      if (
        typeof record !== "object" ||
        record === null ||
        !("type" in record) ||
        !("data" in record)
      ) {
        throw new Error("Invalid search record");
      }
      return record;
    });
}

describe.skipIf(!REAL_RG)("rg structured matches", () => {
  const longNonUtf8Line = new Uint8Array(70_000).fill(0xff);
  longNonUtf8Line.set(new TextEncoder().encode("hello\n"), longNonUtf8Line.length - 6);
  const corpus = {
    "page.astro": "<h1>Rendered in a Worker</h1>\n<p>hello é hello</p>\nhello again\n",
    "post.md": "Příliš\nžluťoučký\nhello\n",
    "other.txt": "no match\n",
  };
  test.each([
    ["--fixed-strings", "--regexp", "hello"],
    ["--fixed-strings", "--max-count", "1", "--regexp", "hello"],
    ["--ignore-case", "--regexp", "^HELLO"],
    ["--glob", "*.astro", "--regexp", "Worker|hello"],
    ["--multiline", "--regexp", "Příliš\\s+žluťoučký"],
    ["--max-count", "0", "--regexp", "hello"],
    ["--regexp", "absent"],
  ])("matches native records for %j", async (...args) => {
    const fixture = new ParityFixture(corpus);
    try {
      const parity = await fixture.compare("rg", "--json", ...args, "--", ".");
      expect(parity.ours.exitCode).toBe(parity.real.exitCode);
      expect(parity.ours.stderr).toBe(parity.real.stderr);
      expect(records(parity.ours.stdout)).toEqual(records(parity.real.stdout));
    } finally {
      fixture.cleanup();
    }
  });
  const structuredCases: ReadonlyArray<{
    name: string;
    corpus: Corpus;
    args: readonly string[];
    path?: string;
  }> = [
    {
      name: "large non-UTF-8 JSON content",
      corpus: { "file.txt": longNonUtf8Line },
      args: ["hello"],
    },
    { name: "whitespace before a newline", corpus: { "file.txt": "foo \nbar\n" }, args: ["\\s+"] },
    { name: "a CR is not a line boundary", corpus: { "file.txt": "foo\rbar\n" }, args: ["^bar"] },
    { name: "multiline CR anchors", corpus: { "file.txt": "foo\rbar\n" }, args: ["-U", "^bar"] },
    { name: "a dot matches a CR", corpus: { "file.txt": "foo\rbar\n" }, args: ["foo.bar"] },
    { name: "an empty first line", corpus: { "file.txt": "\nfoo\n" }, args: ["^$"] },
    {
      name: "an empty first line in multiline mode",
      corpus: { "file.txt": "\nfoo\n" },
      args: ["-U", "^$"],
    },
    {
      name: "adjacent multiline matches",
      corpus: { "file.txt": "foo\nbar\nfoo\nbar\n" },
      args: ["-U", "foo\\nbar"],
    },
    {
      name: "max count groups adjacent multiline matches",
      corpus: { "file.txt": "foo\nbar\nfoo\nbar\n" },
      args: ["-U", "-m", "1", "foo\\nbar"],
    },
    {
      name: "disjoint multiline matches",
      corpus: { "file.txt": "foo\nbar\nskip\nfoo\nbar\n" },
      args: ["-U", "foo\\nbar"],
    },
    {
      name: "multiline matches ending with LF",
      corpus: { "file.txt": "foo\nbar\n" },
      args: ["-U", "foo\\n"],
    },
    {
      name: "overlapping matching lines",
      corpus: { "file.txt": "foo\nbar baz\n" },
      args: ["-U", "foo\\nbar|baz"],
    },
    {
      name: "maximum count reached at EOF",
      corpus: { "file.txt": "hello\n" },
      args: ["-m", "1", "hello"],
    },
    {
      name: "maximum count not reached",
      corpus: { "file.txt": "hello\n" },
      args: ["-m", "2", "hello"],
    },
    { name: "no-match regex statistics", corpus: { "file.txt": "other\n" }, args: ["hel+o"] },
    { name: "an empty file", corpus: { "file.txt": "" }, args: [""] },
    {
      name: "named binary JSON",
      corpus: { "file.txt": "hello\0there\n" },
      args: ["hello"],
      path: "file.txt",
    },
    {
      name: "binary JSON with matches after NUL",
      corpus: { "file.txt": "hello\nother\0\nhello\n" },
      args: ["hello"],
      path: "file.txt",
    },
    {
      name: "named binary multiline JSON",
      corpus: { "file.txt": "foo\nbar\0\n" },
      args: ["-U", "foo\\nbar"],
      path: "file.txt",
    },
    {
      name: "walked binaries are skipped",
      corpus: { "file.txt": "hello\0there\n" },
      args: ["hello"],
    },
    {
      name: "invalid UTF-8 byte offsets",
      corpus: { "file.txt": new Uint8Array([255, 104, 101, 108, 108, 111, 10]) },
      args: ["hello"],
    },
    {
      name: "invalid UTF-8 is not a Unicode dot",
      corpus: { "file.txt": new Uint8Array([255, 97, 10]) },
      args: ["."],
    },
    {
      name: "invalid UTF-8 is not a replacement character",
      corpus: { "file.txt": new Uint8Array([255, 97, 10]) },
      args: ["�"],
    },
    {
      name: "malformed multi-byte prefixes",
      corpus: {
        "file.txt": new Uint8Array([0xe2, 0x82, 104, 105, 10, 0xed, 0xa0, 0x80, 104, 105, 10]),
      },
      args: ["hi"],
    },
    { name: "valid replacement characters", corpus: { "file.txt": "�hello\n" }, args: ["�|hello"] },
    { name: "UTF-8 BOM statistics", corpus: { "file.txt": "\ufeffhello\n" }, args: ["hello"] },
    {
      name: "non-BMP byte offsets",
      corpus: { "file.txt": "😀hello é\n😀hello\n" },
      args: ["hello|é"],
    },
  ];
  test.each(structuredCases)(
    "matches all native records: $name",
    async ({ corpus, args, path }) => {
      const fixture = new ParityFixture(corpus);
      try {
        const parity = await fixture.compare("rg", "--json", ...args, "--", path ?? ".");
        expect(parity.ours.exitCode).toBe(parity.real.exitCode);
        expect(parity.ours.stderr).toBe(parity.real.stderr);
        expect(records(parity.ours.stdout)).toEqual(records(parity.real.stdout));
      } finally {
        fixture.cleanup();
      }
    },
  );
  test.each([
    ["--max-count", "1", "hello"],
    ["--multiline", "-n", "Příliš\\s+žluťoučký"],
    ["--multiline", "--files-with-matches", "Příliš\\s+žluťoučký"],
    ["--max-count", "0", "--files-with-matches", "hello"],
    ["--max-count", "0", "--quiet", "hello"],
    ["--max-count", "0", "--count", "hello"],
  ])("matches native text for %j", async (...args) => {
    const fixture = new ParityFixture(corpus);
    try {
      agree(await fixture.compare("rg", ...args, "{root}"));
    } finally {
      fixture.cleanup();
    }
  });
  test.each([
    ["-U", "-c", "foo\\nbar"],
    ["-U", "-c", "-m", "1", "foo\\nbar"],
    ["-U", "-c", "foo"],
    ["-U", "-n", "^$"],
  ])("matches native multiline text for %j", async (...args) => {
    const fixture = new ParityFixture({
      "file.txt": "\nfoo\nbar\nfoo\nbar\n",
      "binary.txt": "foo\nbar\0\n",
    });
    try {
      agree(await fixture.compare("rg", ...args, "."));
    } finally {
      fixture.cleanup();
    }
  });
  test("matches native named binary multiline text", async () => {
    const fixture = new ParityFixture({ "binary.txt": "foo\nbar\0\n" });
    try {
      agree(await fixture.compare("rg", "-U", "foo\\nbar", "binary.txt"));
    } finally {
      fixture.cleanup();
    }
  });
});
