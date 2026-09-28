// `jq` behaviour pinned locally: the forms refused on purpose (loops without a
// structural bound, recursion, modules, options and builtins outside the
// admitted surface, regex constructs JavaScript cannot reproduce), the
// retained-memory bound on what a program builds, and the documented
// diagnostic divergence (bison's error recovery).

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function shellWith(files: Readonly<Record<string, string>> = {}, maxRetainedBytes?: number): Shell {
  const fs = createFilesystem(new TestDatabase(), { now: () => 0 });
  fs.writeFiles([
    { path: "/repo", mode: 0o755 },
    ...Object.entries(files).map(([name, text]) => ({
      path: `/repo/${name}`,
      bytes: encoder.encode(text),
      mode: 0o644,
    })),
  ]);
  return createShell({
    fs,
    cwd: "/repo",
    ...(maxRetainedBytes === undefined
      ? {}
      : {
          limits: {
            maxOutputBytes: 1_000_000,
            maxOperations: 10_000,
            readBudget: 64 * 1024,
            maxRetainedBytes,
          },
        }),
  });
}

async function run(
  source: string,
  files: Readonly<Record<string, string>> = {},
  maxRetainedBytes?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await shellWith(files, maxRetainedBytes).exec(source);
  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    exitCode: result.exitCode,
  };
}

const UNREACHABLE = "with a bound it can never reach is not supported";

describe("jq refusals", () => {
  it.each([
    ["jq -C .", "jq: option --color-output is not supported"],
    ["jq --seq .", "jq: option --seq is not supported"],
    ["jq --stream .", "jq: option --stream is not supported"],
    ["jq -f prog.jq", "jq: option --from-file is not supported"],
    ["jq --slurpfile x a.json .", "jq: option --slurpfile is not supported"],
    ["jq --rawfile x a.json .", "jq: option --rawfile is not supported"],
    ["jq --raw-output0 .", "jq: option --raw-output0 is not supported"],
    ["jq --unbuffered .", "jq: option --unbuffered is not supported"],
    ["jq -n '$__loc__'", "jq: $__loc__ is not supported"],
    ["jq -n '{$__loc__}'", "jq: $__loc__ is not supported"],
    ["jq -n 'import \"a\" as a; .'", "jq: modules (import, include, module) are not supported"],
    ["jq -n 'include \"a\"; .'", "jq: modules (import, include, module) are not supported"],
    ["jq -n '. as [$a] ?// $a | $a'", "jq: destructuring alternatives (?//) are not supported"],
    ["jq -n 'while(. < 3; . + 1)'", "jq: while/2 is not supported"],
    ["jq -n 'until(. > 3; . + 1)'", "jq: until/2 is not supported"],
    ["jq -n '[limit(3; repeat(1))]'", "jq: repeat/1 is not supported"],
    ["jq -n 'input_line_number'", "jq: input_line_number/0 is not supported"],
    ["jq -n '[1] | walk(.)'", "jq: walk/1 is not supported"],
    ["jq -n '2 | IN(1, 2)'", "jq: IN/1 is not supported"],
    ["jq -n '{} | tostream'", "jq: tostream/0 is not supported"],
    ["jq -n '[[1],[2]] | combinations'", "jq: combinations/0 is not supported"],
    ["jq -n 'halt_error'", "jq: halt_error/0 is not supported"],
    ["jq -n '1 | significand'", "jq: significand/0 is not supported"],
    ["jq -n 'def f: f; f'", "jq: recursive function f/0 is not supported"],
    ["jq -n 'def f: def g: f; g; f'", "jq: recursive function f/0 is not supported"],
    ["jq -n 'def f(x): f(x); f(1)'", "jq: recursive function f/1 is not supported"],
    [
      "jq -n '0 | recurse(. + 1)'",
      "jq: recurse(f) is supported only when f is a chain of .key, .[n], and .[] steps",
    ],
    [
      "jq -n '[1] | recurse(.[1:])'",
      "jq: recurse(f) is supported only when f is a chain of .key, .[n], and .[] steps",
    ],
    [
      "jq -n '{\"a\":null} | [recurse(.a)]'",
      "jq: recurse(f) that maps null to null never terminates and is not supported",
    ],
    ["jq -n '[range(infinite)]'", `jq: range ${UNREACHABLE}`],
    ["jq -n 'range(nan)'", `jq: range ${UNREACHABLE}`],
    ["jq -n '[limit(3; range(infinite))]'", `jq: range ${UNREACHABLE}`],
    ["jq -n 'range(0; infinite; 1)'", `jq: range/3 ${UNREACHABLE}`],
    ['jq -n \'range("a"; "b"; "c")\'', "jq: range/3 over non-numbers is not supported"],
    ["jq -n '@base32 \"\\(1)\"'", "jq: @base32 is not supported"],
    ["jq -n '\"a\" | @urid'", "jq: @urid is not supported"],
    ['jq -n \'"a" | test("a++")\'', "jq: possessive regex quantifiers are not supported"],
    ['jq -n \'"a" | test("a**")\'', "jq: repeated regex quantifiers are not supported"],
    ['jq -n \'"a" | test("(?>a)")\'', "jq: regex group (?> is not supported"],
    ['jq -n \'"a" | test("(?i)A")\'', "jq: regex group (?i is not supported"],
    ['jq -n \'"a" | test("\\\\h")\'', "jq: regex escape \\h is not supported"],
    ['jq -n \'"a" | test("a\\\\K")\'', "jq: regex escape \\K is not supported"],
    ['jq -n \'"a" | test("[a[b]]")\'', "jq: nested regex character classes are not supported"],
    [
      'jq -n \'"a" | test("[a-z&&b]")\'',
      "jq: regex character class intersection (&&) is not supported",
    ],
    ['jq -n \'"a" | test("[[:punct:]]")\'', "jq: POSIX bracket [:punct:] is not supported"],
    [
      'jq -n \'"a" | test("[ ]a"; "x")\'',
      "jq: whitespace inside a regex character class with the x flag is not supported",
    ],
    ['jq -n \'"a" | test("a"; "l")\'', "jq: the l (longest match) regex flag is not supported"],
    [
      'jq -n \'"aaa" | [match("a*?"; "gn")]\'',
      "jq: the n regex flag with a lazy quantifier or an alternation is not supported",
    ],
    [
      'jq -n \'"ß" | test("SS"; "i")\'',
      "jq: case-insensitive matching of characters with multi-character case folds is not supported",
    ],
    ["jq -n '0 | strftime(\"%Q\")'", "jq: strftime conversion %Q is not supported"],
    ['jq -n \'"1" | strptime("%Q")\'', "jq: strptime conversion %Q is not supported"],
    ["jq -n '1e20 | gmtime'", "jq: gmtime beyond the JavaScript date range is not supported"],
  ])("%s", async (source, message) => {
    const result = await run(source, { "a.json": "{}\n", "prog.jq": ".\n" });
    expect(result).toEqual({ stdout: "", stderr: `${message}\n`, exitCode: 2 });
  });

  it("refuses a range that stops advancing only when it gets there", async () => {
    const result = await run("jq -n 'range(9007199254740991; 9007199254740994)'");
    expect(result).toEqual({
      stdout: "9007199254740991\n9007199254740992\n",
      stderr: `jq: range ${UNREACHABLE}\n`,
      exitCode: 2,
    });
  });
});

describe("jq bounds", () => {
  const LIMIT = /^kompjutr: jq value exceeds the 16777216-byte retained-memory limit\n$/;

  it.each([
    "jq -n '[range(100000000)] | length'",
    "jq -n '\"x\" * 100000000'",
    "jq -n 'reduce range(40) as $i (\"x\"; . + .) | length'",
    "jq -n '[] | .[500000000] = 1'",
    "jq -n '[range(20) as $i | [range(1000000)]] | length'",
  ])("fails with the retained-memory limit: %s", async (source) => {
    const result = await run(source);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(LIMIT);
    expect(result.exitCode).toBe(2);
  });

  it("reserves each input while it is processed", async () => {
    const big = `[${'"xxxxxxxxxxxxxxxx",'.repeat(20_000)}1]\n`;
    const result = await run("jq length big.json", { "big.json": big }, 256 * 1024);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/retained-memory limit/);
    expect(result.exitCode).toBe(2);
    expect(await run("jq length big.json", { "big.json": big })).toEqual({
      stdout: "20001\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("streams a stream of inputs without holding earlier ones", async () => {
    const lines = `${'{"k":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n'.repeat(20_000)}`;
    const result = await run("jq -c .k lines.json | tail -1", { "lines.json": lines }, 256 * 1024);
    expect(result).toEqual({
      stdout: '"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n',
      stderr: "",
      exitCode: 0,
    });
  });

  it("accumulates in a reduce without copying the state each step", async () => {
    const result = await run(
      "jq -n 'reduce range(200000) as $i ([]; . + [$i]) | length, (reduce range(50000) as $i ({}; .[\"k\\($i)\"] = $i) | length)'",
    );
    expect(result).toEqual({ stdout: "200000\n50000\n", stderr: "", exitCode: 0 });
  });
});

describe("jq diagnostic divergence", () => {
  // Bison recovers from some syntax errors and reports a second diagnostic
  // ("Possibly unterminated 'if' statement"); this parser stops at the first.
  it("reports an unterminated if once", async () => {
    const result = await run("jq -n 'if 1 then 2'");
    expect(result).toEqual({
      stdout: "",
      stderr:
        "jq: error: syntax error, unexpected end of file at <top-level>, line 1, column 11:\n" +
        "    if 1 then 2\n" +
        "              ^\n" +
        "jq: 1 compile error\n",
      exitCode: 3,
    });
  });
});
