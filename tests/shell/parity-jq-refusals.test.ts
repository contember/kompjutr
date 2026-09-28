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
    ["jq --unbuffered .", "jq: option --unbuffered is not supported"],
    ["jq -n 'import \"a\" as a; .'", "jq: modules (import, include, module) are not supported"],
    ["jq -n 'include \"a\"; .'", "jq: modules (import, include, module) are not supported"],
    ["jq -n '. as [$a] ?// $a | $a'", "jq: destructuring alternatives (?//) are not supported"],
    ["jq -n 'while(. < 3; . + 1)'", "jq: while/2 is not supported"],
    ["jq -n 'until(. > 3; . + 1)'", "jq: until/2 is not supported"],
    ["jq -n '[limit(3; repeat(1))]'", "jq: repeat/1 is not supported"],
    ["jq -n 'input_line_number'", "jq: input_line_number/0 is not supported"],
    ["jq -n '[[1],[2]] | combinations'", "jq: combinations/0 is not supported"],
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
    ['jq -n \'"a" | test("a++")\'', "jq: possessive regex quantifiers are not supported"],
    ['jq -n \'"a" | test("(?>a)")\'', "jq: regex group (?> is not supported"],
    ['jq -n \'"a" | test("x(?i)a")\'', "jq: regex group (?i is not supported"],
    ['jq -n \'"a" | test("(?i:a)")\'', "jq: regex group (?i is not supported"],
    ['jq -n \'"a" | test("(?m)a")\'', "jq: regex group (?m is not supported"],
    ['jq -n \'"abc" | test("(?=b)")\'', "jq: regex lookaround is not supported"],
    ['jq -n \'"abc" | test("(?<!b)c")\'', "jq: regex lookaround is not supported"],
    ['jq -n \'"aa" | test("(a)\\\\1")\'', "jq: regex backreferences are not supported"],
    ['jq -n \'"aa" | test("(?<x>a)\\\\k<x>")\'', "jq: regex backreferences are not supported"],
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

describe("jq regex matching is linear", () => {
  // Oniguruma backtracks and gives up after its retry limit with
  // "Regex failure: retry-limit-in-match over" (exit 5). JavaScript's RegExp
  // has no limit, so these patterns would never finish. The Pike VM here
  // returns the actual result instead: a documented divergence, since whether
  // Oniguruma hits its limit depends on the input, not on the pattern.
  it.each([
    [`jq -n '"${"a".repeat(34)}" | test("(a*)*b")'`, "false\n"],
    [`jq -n '"-" * 3000 | sub("(-+)+x"; "") | length'`, "3000\n"],
    [`jq -n '"${"a".repeat(80)}!" | test("^(a|aa)+$")'`, "false\n"],
    [`jq -n '"a" * 100000 | test("(a|aa)+b"), ([match("(a*)*"; "g")] | length)'`, "false\n2\n"],
    [`jq -n '"x" * 20000 | [match("(x+x+)+y|(.*.*.*)z?"; "g")] | length'`, "2\n"],
  ])("%s", async (source, stdout) => {
    expect(await run(source)).toEqual({ stdout, stderr: "", exitCode: 0 });
  });

  it("charges the compiled program against the retained-memory limit", async () => {
    const result = await run(`jq -n '"a" | test("(a{1000}){1000}")'`);
    expect(result.stderr).toMatch(
      /^kompjutr: jq value exceeds the 16777216-byte retained-memory limit\n$/,
    );
    expect(result.exitCode).toBe(2);
  });
});

describe("jq deep nesting", () => {
  // Input values and walks over them use explicit stacks (parity cases in
  // parity-jq-structure.test.ts). What still recurses — the program parser —
  // maps V8's stack overflow to a refusal instead of escaping shell.exec.
  const LIMIT =
    "jq: the program or value exceeds a JavaScript engine limit (Maximum call stack size exceeded)\n";
  it.each([
    `jq -n '${"(".repeat(20000)}1${")".repeat(20000)}'`,
    `jq -n '${"[".repeat(20000)}${"]".repeat(20000)}'`,
  ])("refuses a program nested 20,000 levels deep", async (source) => {
    expect(await run(source)).toEqual({ stdout: "", stderr: LIMIT, exitCode: 2 });
  });

  it("walks 9,999-deep input without the JavaScript stack", async () => {
    const deep = `${"[".repeat(9999)}${"]".repeat(9999)}\n`;
    const result = await run(
      "jq -c '([..] | length), (flatten | length), (. == .), contains(.), (walk(.) | length)' deep.json",
      { "deep.json": deep },
    );
    expect(result).toEqual({ stdout: "9999\n0\ntrue\ntrue\n1\n", stderr: "", exitCode: 0 });
  });

  it("charges tostream's paths, which grow with the square of the depth", async () => {
    const deep = `${"[".repeat(9999)}${"]".repeat(9999)}\n`;
    const result = await run("jq -c '[tostream] | length' deep.json", { "deep.json": deep });
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/retained-memory limit/);
    expect(result.exitCode).toBe(2);
  });
});

describe("jq input accounting", () => {
  it("parses a 5 MB package-lock.json under the default budget", async () => {
    const packages: Record<string, unknown> = {};
    for (let index = 0; index < 10_500; index++) {
      packages[`node_modules/@scope/package-name-${index}`] = {
        version: `1.${index % 50}.${index % 7}`,
        resolved: `https://registry.npmjs.org/@scope/package-name-${index}/-/package-name-${index}-1.0.0.tgz`,
        integrity: `sha512-${"x".repeat(86)}==`,
        dev: index % 3 === 0,
        license: "MIT",
        dependencies: { [`dep-${index % 100}`]: "^2.0.0", [`dep-${(index + 1) % 100}`]: "~1.2.3" },
        engines: { node: ">=14" },
      };
    }
    const text = JSON.stringify({ name: "app", lockfileVersion: 3, packages }, null, 2);
    expect(text.length).toBeGreaterThan(5_000_000);
    const result = await run(
      "jq '.packages | length, ([.[] | select(.dev)] | length)' package-lock.json",
      { "package-lock.json": `${text}\n` },
    );
    expect(result).toEqual({ stdout: "10500\n3500\n", stderr: "", exitCode: 0 });
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
