// `awk` behaviour pinned locally: the constructs refused on purpose (loops
// without a structural bound, recursion, getline, redirection, commands, the
// clock, and mawk's random sequence), the places where the diagnostic differs
// from mawk's, and the retained-memory bound on what a program keeps.

import { describe, expect, it } from "vitest";

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const encoder = new TextEncoder();

function shellWith(files: Readonly<Record<string, string>>, maxRetainedBytes?: number): Shell {
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

const LOOPS = "has no structural bound: only `for (key in array)' loops are supported";
const GETLINE = "`getline' is not supported: input is read only by the main loop";
const REDIRECT = "output redirection is not supported: print writes to standard output only";
const PIPE = "output pipes are not supported: awk cannot run commands";

describe("awk refusals", () => {
  it.each([
    ["BEGIN { while (1) break }", `\`while' ${LOOPS}`],
    ["BEGIN { do x++; while (x < 3) }", `\`do' ${LOOPS}`],
    ["BEGIN { for (i = 0; i < 3; i++) print i }", `C-style \`for' ${LOOPS}`],
    ["BEGIN { for (;;) break }", `C-style \`for' ${LOOPS}`],
    ["BEGIN { getline }", GETLINE],
    ["BEGIN { getline x }", GETLINE],
    ['BEGIN { getline < "f.txt" }', GETLINE],
    ['BEGIN { getline line < "f.txt" }', GETLINE],
    ['BEGIN { "date" | getline }', GETLINE],
    ['BEGIN { "date" | getline now }', GETLINE],
    ['BEGIN { print "x" > "out" }', REDIRECT],
    ['BEGIN { print "x" >> "out" }', REDIRECT],
    ['BEGIN { printf "%s", "x" > "/dev/stderr" }', REDIRECT],
    ['BEGIN { print ("a", "b") > "out" }', REDIRECT],
    ['BEGIN { print "x" | "cat" }', PIPE],
    ['BEGIN { system("true") }', "`system' is not supported: awk cannot run commands"],
    ['BEGIN { close("x") }', "`close' is not supported: there are no files or pipes to close"],
    [
      "BEGIN { print rand() }",
      "`rand' is not supported: mawk's random sequence cannot be reproduced",
    ],
    ["BEGIN { srand(1) }", "`srand' is not supported: mawk's random sequence cannot be reproduced"],
    [
      "BEGIN { print systime() }",
      "`systime' is not supported: the shell's clock is not exposed to awk",
    ],
    [
      "BEGIN { print strftime() }",
      "`strftime' is not supported: the shell's clock is not exposed to awk",
    ],
    [
      "function f(n) { return n ? f(n - 1) : 0 } BEGIN { print f(3) }",
      "recursive function calls are not supported: f -> f has no structural bound",
    ],
    [
      "function a(n) { return b(n) } function b(n) { return a(n) } BEGIN { print a(1) }",
      "recursive function calls are not supported: a -> b -> a has no structural bound",
    ],
  ])("refuses %j by name", async (program, message) => {
    const run = await shellWith({ "f.txt": "x\n" }).run(`awk '${program}'`);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`awk: line 1: ${message}\n`);
    expect(run.exitCode).toBe(2);
  });

  it("refuses printf's h length modifier at run time", async () => {
    const run = await shellWith({}).run("awk 'BEGIN { printf \"a%hdb\\n\", 3 }'");
    expect(run.stdout).toBe("a");
    expect(run.stderr).toBe(
      'awk: run time error: the h length modifier is not supported in printf("a%hdb\n")\n\tFILENAME="" FNR=0 NR=0\n',
    );
    expect(run.exitCode).toBe(2);
  });

  it.each([
    ["awk -W version", "awk: -W options are not supported: -W\n"],
    ["awk -Wposix 'BEGIN{}'", "awk: -W options are not supported: -Wposix\n"],
    ["awk --version", "awk: not an option: --version\n"],
    ["awk -f - x", "awk: -f - is not supported: standard input is the data\n"],
    ["awk -f a.awk -f b.awk", "awk: more than one -f program file is not supported\n"],
    ["awk", "awk: no program given: usage: awk [-F fs] [-v var=value] 'program' [file ...]\n"],
  ])("refuses the command line %j", async (source, stderr) => {
    const run = await shellWith({ "a.awk": "{}", "b.awk": "{}" }).run(source);
    expect(run.stderr).toBe(stderr);
    expect(run.exitCode).toBe(2);
  });
});

describe("awk diagnostics that differ from mawk's", () => {
  it("reports only the first compile error, where mawk goes on to report more", async () => {
    // mawk adds "awk: line 2: missing } near end of file".
    const run = await shellWith({}).run("awk 'BEGIN{print (1'");
    expect(run.stderr).toBe("awk: line 1: missing ) near end of line\n");
    expect(run.exitCode).toBe(2);
  });

  it("visits `for (k in a)` in insertion order, where mawk visits its hash order", async () => {
    // Reproducing mawk's hash order would mean copying its GPL internals.
    const program =
      'BEGIN { a[10]; a["b"]; a[2]; a["a"]; delete a["b"]; a["b"]; split("z y", s); for (k in a) printf "%s ", k; for (k in s) printf "%s=%s ", k, s[k]; print "" }';
    const run = await shellWith({}).run(`awk '${program}'`);
    expect(run.stdout).toBe("10 2 a b 1=z 2=y \n");
  });

  it("prints a negated NaN as -nan, where mawk flips the sign bit to +nan", async () => {
    const run = await shellWith({}).run("awk 'BEGIN { x = log(-1); print x, -x }'");
    expect(run.stdout).toBe("-nan -nan\n");
  });
});

describe("awk streams and bounds what it keeps", () => {
  const lines = Array.from({ length: 40_000 }, (_, index) => `line ${index} ${"x".repeat(40)}\n`);
  const big = lines.join("");

  it("streams records: a program that keeps nothing runs under a budget smaller than its input", async () => {
    const shell = shellWith({ "big.txt": big }, 512 * 1024);
    const run = await shell.run("awk '{ n += NF } END { print n, NR }' big.txt");
    expect(run.stdout).toBe(`${3 * lines.length} ${lines.length}\n`);
    expect(run.peakRetainedBytes).toBeLessThan(big.length);
  });

  it("stops reading when the consumer stops", async () => {
    const shell = shellWith({ "big.txt": big }, 512 * 1024);
    const run = await shell.run("awk '{ print $2 }' big.txt | head -2");
    expect(run.stdout).toBe("0\n1\n");
    expect(run.exitCode).toBe(0);
  });

  it("fails with the retained-memory limit when an array grows with its input", async () => {
    const shell = shellWith({ "big.txt": big }, 512 * 1024);
    const run = await shell.run("awk '{ a[NR] = $0 } END { print length(a) }' big.txt");
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(
      /^kompjutr: awk .* exceeds the 524288-byte retained-memory limit\n$/,
    );
    expect(run.exitCode).toBe(2);
  });

  it("fails with the retained-memory limit when a string grows with its input", async () => {
    const shell = shellWith({ "big.txt": big }, 512 * 1024);
    const run = await shell.run("awk '{ s = s $0 } END { print length(s) }' big.txt");
    // Whichever reservation crosses the line first reports it: the string or the next input chunk.
    expect(run.stderr).toMatch(
      /^kompjutr: awk .* exceeds the 524288-byte retained-memory limit\n$/,
    );
    expect(run.exitCode).toBe(2);
  });

  it("fails with the retained-memory limit before building a huge printf field", async () => {
    const shell = shellWith({}, 512 * 1024);
    const run = await shell.run("awk 'BEGIN { printf \"%1000000000d\\n\", 1 }'");
    expect(run.stderr).toBe(
      "kompjutr: awk printf field exceeds the 524288-byte retained-memory limit\n",
    );
    expect(run.exitCode).toBe(2);
  });

  it("releases what it reserved once the program ends", async () => {
    const shell = shellWith({ "big.txt": big }, 4 * 1024 * 1024);
    const first = await shell.run("awk '{ a[$2] = 1 } END { print length(a) }' big.txt");
    expect(first.stdout).toBe(`${lines.length}\n`);
    const second = await shell.run("awk '{ a[$2] = 1 } END { print length(a) }' big.txt");
    expect(second.stdout).toBe(`${lines.length}\n`);
  });

  it("reads ENVIRON from the run's environment", async () => {
    const run = await shellWith({}).run("awk 'BEGIN { print ENVIRON[\"GREETING\"] + 1 }'", {
      env: { GREETING: "41" },
    });
    expect(run.stdout).toBe("42\n");
  });
});

describe("awk bounds nesting and stops fanned-out calls", () => {
  const chain = (count: number): string =>
    Array.from({ length: count }, (_, index) =>
      index === 0
        ? "function f0(x) { return x + 1 }"
        : `function f${index}(x) { return f${index - 1}(x) }`,
    ).join("\n");

  // mawk's parser stack overflows near 200 levels with this same diagnostic,
  // naming the operator; the shell caps nesting at 100 and names the operand.
  it.each([
    ["x=", `BEGIN{${"x=".repeat(1000)}1; print x}`, "x"],
    ["if(1)", `BEGIN{${"if(1)".repeat(1000)}print 1}`, "1"],
    ["^", `BEGIN{print 2${"^1".repeat(1000)}}`, "1"],
    ["?:", `BEGIN{print ${"1?".repeat(1000)}1${":0".repeat(1000)}}`, "1"],
  ])("refuses 1000 nested %s as a syntax error", async (_label, program, near) => {
    const run = await shellWith({}).run(`awk '${program}'`);
    expect(run.stderr).toBe(`awk: line 1: syntax error at or near ${near}\n`);
    expect(run.exitCode).toBe(2);
  });

  it("runs a long else-if chain, which does not nest (mawk's parser overflows on it)", async () => {
    const branches = Array.from(
      { length: 300 },
      (_, index) => `if (x == ${index}) print ${index};`,
    );
    const run = await shellWith({}).run(`awk 'BEGIN{x = 299; ${branches.join(" else ")}}'`);
    expect(run.stdout).toBe("299\n");
  });

  it("refuses a chain of calls deeper than 100", async () => {
    const run = await shellWith({}).run(`awk '${chain(1000)}\nBEGIN{print f999(1)}'`);
    expect(run.stderr).toBe(
      "awk: line 101: function calls nested more than 100 deep are not supported: a chain from f100 is 101 calls long\n",
    );
    expect(run.exitCode).toBe(2);
  });

  it("reports a regular expression nested past the stack as too large", async () => {
    const pattern = `${"(".repeat(200_000)}a${")".repeat(200_000)}`;
    const run = await shellWith({}).run("awk '{ print ($0 ~ $0) }'", { stdin: `${pattern}\n` });
    expect(run.stderr).toMatch(
      /^awk: run time error: regular expression compile failed \(resource exhaustion -- regular expression too large\)\n/,
    );
    expect(run.exitCode).toBe(2);
  });

  it("stops a call tree that fans out when the consumer stops", async () => {
    const functions = Array.from({ length: 26 }, (_, index) =>
      index === 0
        ? 'function g0() { print "x" }'
        : `function g${index}() { g${index - 1}(); g${index - 1}() }`,
    ).join("\n");
    const run = await shellWith({}).run(`awk '${functions}\nBEGIN { g25() }' | head -1`);
    expect(run.stdout).toBe("x\n");
    expect(run.exitCode).toBe(0);
  });
});

describe("awk charges field growth before allocating it", () => {
  it.each(['BEGIN { $50000000 = "x" }', "BEGIN { NF = 50000000; print NF }"])(
    "%j fails with the retained-memory limit",
    async (program) => {
      const run = await shellWith({}, 1024 * 1024).run(`awk '${program}'`);
      expect(run.stderr).toBe(
        "kompjutr: awk variables exceeds the 1048576-byte retained-memory limit\n",
      );
      expect(run.exitCode).toBe(2);
      expect(run.peakRetainedBytes).toBeLessThanOrEqual(1024 * 1024);
    },
  );

  it("assigns many fields without rebuilding $0 each time", async () => {
    const run = await shellWith({}).run(
      'awk \'BEGIN { n = split(sprintf("%100000s", ""), a, ""); for (k in a) $k = "x"; print length($0), NF }\'',
    );
    expect(run.stdout).toBe("199999 100000\n");
  });
});
