import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  boundedGitCliResult,
  createGitCliRunner,
  GIT_CLI_MAX_ARGV_BYTES,
  GIT_CLI_MAX_ARGV_ENTRIES,
  GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
  GIT_CLI_MAX_COMMIT_MESSAGE_BYTES,
  GIT_CLI_MAX_CWD_BYTES,
  GIT_CLI_MAX_ENV_BYTES,
  GIT_CLI_MAX_ENV_ENTRIES,
  GIT_CLI_MAX_LOG_COUNT,
  GIT_CLI_MAX_LOG_FORMAT_BYTES,
  GIT_CLI_MAX_STDERR_BYTES,
  GIT_CLI_MAX_STDIN_BYTES,
  GIT_CLI_MAX_STDOUT_BYTES,
  type GitCliHandlers,
  type GitCliResult,
  gitCliResult,
  type ParsedGitCliCommand,
  parseGitCliCommand,
  parseGitCliInput,
  type ResolvedGitCliRunOptions,
  resolveGitCliRunOptions,
  validateGitCliInput,
} from "../src/git/cli/index.js";

const ENCODER = new TextEncoder();

describe("git argv grammar", () => {
  it.each([
    [["status", "--porcelain"], { kind: "status", format: "porcelain-v1" }],
    [["status", "--porcelain=v1"], { kind: "status", format: "porcelain-v1" }],
    [["status", "--short"], { kind: "status", format: "short" }],
    [["status", "-s"], { kind: "status", format: "short" }],
    [["diff"], { kind: "diff" }],
    [["log"], { kind: "log", count: undefined, format: { kind: "default" }, revision: undefined }],
    [
      ["log", "-1", "--oneline", "HEAD"],
      {
        kind: "log",
        count: 1,
        format: { kind: "oneline" },
        revision: { kind: "ref", ref: "HEAD" },
      },
    ],
    [
      ["log", "-n", "0002", "--format=%H%n%an%%", "base..tip"],
      {
        kind: "log",
        count: 2,
        format: { kind: "template", template: "%H%n%an%%" },
        revision: { kind: "range", left: "base", right: "tip" },
      },
    ],
    [
      ["log", "--max-count=0", "--format="],
      { kind: "log", count: 0, format: { kind: "template", template: "" }, revision: undefined },
    ],
    [["rev-list", "--count", "main..HEAD"], { kind: "rev-list", left: "main", right: "HEAD" }],
    [["symbolic-ref", "--short", "HEAD"], { kind: "symbolic-ref", ref: "HEAD" }],
    [["add", "a", "dir/file"], { kind: "add", paths: ["a", "dir/file"] }],
    [["add", "--", "-literal"], { kind: "add", paths: ["-literal"] }],
    [["commit", "-m", "message"], { kind: "commit", message: "message" }],
    [["commit", "--message="], { kind: "commit", message: "" }],
    [["rebase", "--continue"], { kind: "rebase", action: "continue" }],
    [["rebase", "--abort"], { kind: "rebase", action: "abort" }],
  ])("accepts %j without a partial parse", (argv, expected) => {
    expect(parsed(argv)).toEqual(expected);
  });

  it.each([
    ["plain status", ["status"]],
    ["status extra operand", ["status", "--short", "path"]],
    ["status v2", ["status", "--porcelain=v2"]],
    ["diff operand", ["diff", "HEAD"]],
    ["diff separator", ["diff", "--"]],
    ["joined count", ["log", "-n1"]],
    ["duplicate count", ["log", "-1", "-n", "1"]],
    ["duplicate format", ["log", "--oneline", "--format=%H"]],
    ["option after revision", ["log", "HEAD", "--oneline"]],
    ["two revisions", ["log", "HEAD", "main"]],
    ["symmetric range", ["log", "a...b"]],
    ["rev-list enumeration", ["rev-list", "HEAD"]],
    ["rev-list symmetric range", ["rev-list", "--count", "a...b"]],
    ["symbolic-ref write", ["symbolic-ref", "HEAD", "refs/heads/main"]],
    ["add without path", ["add"]],
    ["add option", ["add", "--all"]],
    ["add glob", ["add", "*.ts"]],
    ["add leading-colon pathspec", ["add", ":file"]],
    ["add exclude shorthand", ["add", ":!file"]],
    ["add caret exclude shorthand", ["add", ":^file"]],
    ["add root shorthand", ["add", ":/"]],
    ["add long-form magic", ["add", ":(glob)file"]],
    ["add magic after separator", ["add", "--", ":file"]],
    ["commit separated long message", ["commit", "--message", "message"]],
    ["commit duplicate", ["commit", "-m", "a", "-m", "b"]],
    ["rebase start", ["rebase", "main"]],
    ["rebase extra", ["rebase", "--abort", "extra"]],
  ])("rejects %s", (_name, argv) => {
    expect(rejected(argv).exitCode).not.toBe(0);
  });

  it("accepts the full format allowlist and rejects every other placeholder", () => {
    expect(parsed(["log", "--format=%H%h%P%s%B%an%ae%at%cn%ce%ct%n%%"])).toMatchObject({
      kind: "log",
    });
    for (const template of ["%", "%x00", "%ad", "%N", "%a", "%q"]) {
      expect(() => parsed(["log", `--format=${template}`])).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it.each(["0", "00", "1", "50000"])("accepts decimal log count %s", (value) => {
    expect(parsed(["log", "-n", value])).toMatchObject({ kind: "log", count: Number(value) });
  });

  it.each(["", "+1", "-1", " 1", "1 ", "1.0", "0x10", "50001"])(
    "rejects non-admitted log count %j",
    (value) => {
      expect(rejected(["log", "-n", value])).toEqual({
        stdout: "",
        stderr: `fatal: '${value}': not an integer\n`,
        exitCode: 128,
      });
    },
  );

  it("pins unknown and network command framing", () => {
    expect(rejected([])).toEqual({
      stdout: "",
      stderr: "git: no command specified\n",
      exitCode: 1,
    });
    expect(rejected(["frobnicate"])).toEqual({
      stdout: "",
      stderr: "git: 'frobnicate' is not a git command. See 'git --help'.\n",
      exitCode: 1,
    });
    expect(rejected(["push"])).toEqual({
      stdout: "",
      stderr:
        "fatal: No configured push destination.\n" +
        "Either specify the URL from the command-line or configure a remote repository using\n" +
        "\n" +
        "    git remote add <name> <url>\n" +
        "\n" +
        "and then push using the remote name\n" +
        "\n" +
        "    git push <name>\n",
      exitCode: 128,
    });
    for (const command of ["fetch", "pull", "clone", "ls-remote"]) {
      expect(rejected([command])).toEqual({
        stdout: "",
        stderr: `fatal: network command '${command}' is not supported\n`,
        exitCode: 128,
      });
    }
  });

  it.each([
    [
      "status",
      1_249,
      "742609d57c5b33e9deaf00bf6e6ce8e0b53b9fb041d57391fc9c855b31014fd8",
      "error: unknown option `definitely-unknown'\nusage: git status",
    ],
    [
      "diff",
      1_648,
      "61c6eaf4dfe10da6bc6c3b4ab6c3b7b0a907fd91881b5f62f47ec0dcadd4bab7",
      "error: invalid option: --definitely-unknown\nusage: git diff",
    ],
    [
      "rev-list",
      791,
      "24ade3f32e031747510716b2457ceeed97229ee28eef7c39a8cad014e2574beb",
      "usage: git rev-list",
    ],
    [
      "symbolic-ref",
      482,
      "5877f8c3325fdfa792f978cd8c418f481ac2633e99eeb7eaf3f97abff0eb07bd",
      "error: unknown option `definitely-unknown'\nusage: git symbolic-ref",
    ],
    [
      "add",
      1_676,
      "eb915d729dc063b6519916ad41f0de7d213a20816e54061cd177f9f2e319801f",
      "error: unknown option `definitely-unknown'\nusage: git add",
    ],
    [
      "commit",
      3_594,
      "f2f8aca47d4a2605fcbddd53d62878b5a35c3e3863862230e1f2f4969a244762",
      "error: unknown option `definitely-unknown'\nusage: git commit",
    ],
    [
      "rebase",
      3_470,
      "b06007a7e1e649983a5b8318ae8b9d527ca5f238f6b2742a11bf51810235d6ba",
      "error: unknown option `definitely-unknown'\nusage: git rebase",
    ],
  ])("pins the complete %s unknown-option usage block", (command, bytes, hash, prefix) => {
    const result = rejected([command, "--definitely-unknown"]);
    expect(result).toMatchObject({ stdout: "", exitCode: 129 });
    expect(result.stderr.startsWith(prefix)).toBe(true);
    expect(ENCODER.encode(result.stderr).byteLength).toBe(bytes);
    expect(createHash("sha256").update(result.stderr).digest("hex")).toBe(hash);
  });

  it("keeps log and missing commit-message framing command-specific", () => {
    expect(rejected(["log", "--graph"])).toEqual({
      stdout: "",
      stderr: "fatal: unrecognized argument: --graph\n",
      exitCode: 128,
    });
    expect(rejected(["commit", "-m"])).toEqual({
      stdout: "",
      stderr: "error: switch `m' requires a value\n",
      exitCode: 129,
    });
  });
});

describe("git CLI runtime validation and bounds", () => {
  it("pins exact and first-excess argv bounds", () => {
    expect(
      validateGitCliInput({ argv: Array(GIT_CLI_MAX_ARGV_ENTRIES).fill("") }).argv,
    ).toHaveLength(GIT_CLI_MAX_ARGV_ENTRIES);
    expect(() =>
      validateGitCliInput({ argv: Array(GIT_CLI_MAX_ARGV_ENTRIES + 1).fill("") }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(validateGitCliInput({ argv: ["x".repeat(GIT_CLI_MAX_ARGV_BYTES)] }).argv).toHaveLength(
      1,
    );
    expect(() =>
      validateGitCliInput({ argv: ["x".repeat(GIT_CLI_MAX_ARGV_BYTES + 1)] }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("pins exact and first-excess cwd, stdin, and env byte bounds", () => {
    const exactCwd = `/${"x".repeat(GIT_CLI_MAX_CWD_BYTES - 1)}`;
    expect(validateGitCliInput({ argv: [], cwd: exactCwd }).cwd).toBe(exactCwd);
    expect(() => validateGitCliInput({ argv: [], cwd: `${exactCwd}x` })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(
      validateGitCliInput({ argv: [], stdin: "x".repeat(GIT_CLI_MAX_STDIN_BYTES) }).stdin,
    ).toHaveLength(GIT_CLI_MAX_STDIN_BYTES);
    expect(() =>
      validateGitCliInput({ argv: [], stdin: "x".repeat(GIT_CLI_MAX_STDIN_BYTES + 1) }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));

    const exactEnv = { K: "x".repeat(GIT_CLI_MAX_ENV_BYTES - 1) };
    expect(validateGitCliInput({ argv: [], env: exactEnv }).env).toEqual({
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    });
    expect(() => validateGitCliInput({ argv: [], env: { K: `${exactEnv.K}x` } })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    const entries: Array<readonly [string, string]> = [];
    for (let index = 0; index < GIT_CLI_MAX_ENV_ENTRIES; index++) entries.push([`K${index}`, ""]);
    expect(validateGitCliInput({ argv: [], env: Object.fromEntries(entries) }).env).toBeDefined();
    entries.push(["overflow", ""]);
    expect(() => validateGitCliInput({ argv: [], env: Object.fromEntries(entries) })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("accounts multibyte UTF-8 at exact and first-excess input bounds", () => {
    const exactCwd = `/${"é".repeat((GIT_CLI_MAX_CWD_BYTES - 2) / 2)}x`;
    expect(ENCODER.encode(exactCwd)).toHaveLength(GIT_CLI_MAX_CWD_BYTES);
    expect(validateGitCliInput({ argv: [], cwd: exactCwd }).cwd).toBe(exactCwd);
    expect(() => validateGitCliInput({ argv: [], cwd: `${exactCwd}x` })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const exactEnvValue = `${"é".repeat((GIT_CLI_MAX_ENV_BYTES - 2) / 2)}x`;
    expect(ENCODER.encode(`K${exactEnvValue}`)).toHaveLength(GIT_CLI_MAX_ENV_BYTES);
    expect(validateGitCliInput({ argv: [], env: { K: exactEnvValue } }).env).toBeDefined();
    expect(() => validateGitCliInput({ argv: [], env: { K: `${exactEnvValue}x` } })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const exactStdin = "é".repeat(GIT_CLI_MAX_STDIN_BYTES / 2);
    expect(ENCODER.encode(exactStdin)).toHaveLength(GIT_CLI_MAX_STDIN_BYTES);
    expect(validateGitCliInput({ argv: [], stdin: exactStdin }).stdin).toBe(exactStdin);
    expect(() => validateGitCliInput({ argv: [], stdin: `${exactStdin}x` })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("pins commit-message and format bounds independently of aggregate argv", () => {
    expect(parsed(["commit", "-m", "x".repeat(GIT_CLI_MAX_COMMIT_MESSAGE_BYTES)])).toMatchObject({
      kind: "commit",
    });
    expect(() =>
      parsed(["commit", "-m", "x".repeat(GIT_CLI_MAX_COMMIT_MESSAGE_BYTES + 1)]),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(parsed(["log", `--format=${"x".repeat(GIT_CLI_MAX_LOG_FORMAT_BYTES)}`])).toMatchObject({
      kind: "log",
    });
    expect(() =>
      parsed(["log", `--format=${"x".repeat(GIT_CLI_MAX_LOG_FORMAT_BYTES + 1)}`]),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("accounts multibyte commit messages and formats at exact and first excess", () => {
    const exactMessage = "é".repeat(GIT_CLI_MAX_COMMIT_MESSAGE_BYTES / 2);
    expect(parsed(["commit", "-m", exactMessage])).toMatchObject({ kind: "commit" });
    expect(() => parsed(["commit", "-m", `${exactMessage}x`])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const exactFormat = "é".repeat(GIT_CLI_MAX_LOG_FORMAT_BYTES / 2);
    expect(parsed(["log", `--format=${exactFormat}`])).toMatchObject({ kind: "log" });
    expect(() => parsed(["log", `--format=${exactFormat}x`])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("accepts NUL only in ignored stdin and output-compatible strings", () => {
    expect(validateGitCliInput({ argv: [], stdin: "before\0after" }).stdin).toBe("before\0after");
    for (const input of [
      { argv: ["bad\0argument"] },
      { argv: [], cwd: "/bad\0cwd" },
      { argv: [], env: { "BAD\0NAME": "value" } },
      { argv: [], env: { BAD: "bad\0value" } },
    ]) {
      expect(() => validateGitCliInput(input)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
    expect(() => parsed(["commit", "-m", "bad\0message"])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => parsed(["log", "--format=bad\0format"])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );

    expect(
      boundedGitCliResult(
        gitCliResult("out\0put", "err\0or", 0),
        resolveGitCliRunOptions({
          maxStdoutBytes: 7,
          maxStderrBytes: 6,
          maxCombinedOutputBytes: 13,
        }),
      ),
    ).toEqual({ stdout: "out\0put", stderr: "err\0or", exitCode: 0 });
  });

  it("rejects malformed UTF-16 in every retained text class", () => {
    const malformed = String.fromCharCode(0xd800);
    for (const input of [
      { argv: [malformed] },
      { argv: [], cwd: `/${malformed}` },
      { argv: [], env: { [malformed]: "value" } },
      { argv: [], env: { K: malformed } },
      { argv: [], stdin: malformed },
    ]) {
      expect(() => validateGitCliInput(input)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
    expect(() => parsed(["commit", "-m", malformed])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => parsed(["log", `--format=${malformed}`])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    const options = resolveGitCliRunOptions({
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
      maxCombinedOutputBytes: 10,
    });
    expect(() => boundedGitCliResult(gitCliResult(malformed, "", 0), options)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => boundedGitCliResult(gitCliResult("", malformed, 0), options)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it.each([
    null,
    [],
    {},
    { argv: "status" },
    { argv: [1] },
    { argv: [], dir: "/" },
    { argv: [], cwd: "relative" },
    { argv: [], cwd: 1 },
    { argv: [], env: [] },
    { argv: [], env: { BAD: 1 } },
    { argv: [], env: { "BAD=NAME": "x" } },
    { argv: [], stdin: 1 },
    { argv: ["bad\0argument"] },
    { argv: [String.fromCharCode(0xd800)] },
  ])("rejects invalid runtime input shape %#", (input) => {
    expect(() => validateGitCliInput(input)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("rejects inherited input fields", () => {
    for (const input of [
      recordWithPrototype({ argv: [] }, {}),
      recordWithPrototype({ cwd: "/inherited" }, { argv: [] }),
      recordWithPrototype({ dir: "/inherited" }, { argv: [] }),
      recordWithPrototype({ unknown: true }, { argv: [] }),
    ]) {
      expect(() => validateGitCliInput(input)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it("rejects inherited environment fields", () => {
    for (const env of [
      recordWithPrototype({ GIT_AUTHOR_NAME: "Inherited" }, {}),
      recordWithPrototype({ UNKNOWN: "inherited" }, {}),
    ]) {
      expect(() => validateGitCliInput({ argv: [], env })).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it("accepts null-prototype input and environment records", () => {
    const env = recordWithPrototype(null, {
      GIT_AUTHOR_NAME: "Author",
      UNUSED: "ignored",
    });
    const input = recordWithPrototype(null, {
      argv: ["commit", "-m", "message"],
      cwd: "/repo",
      env,
      stdin: "ignored",
    });

    expect(validateGitCliInput(input)).toEqual({
      argv: ["commit", "-m", "message"],
      cwd: "/repo",
      env: {
        GIT_AUTHOR_NAME: "Author",
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      },
      stdin: "ignored",
    });
  });

  it("retains only the four recognized bounded environment entries", () => {
    const parsedInput = parseGitCliInput({
      argv: ["commit", "-m", "m"],
      env: {
        GIT_AUTHOR_NAME: "Author",
        GIT_AUTHOR_EMAIL: "author@example.test",
        GIT_COMMITTER_NAME: "Committer",
        GIT_COMMITTER_EMAIL: "committer@example.test",
        IGNORED: "value",
      },
      stdin: "ignored\0bytes",
    });
    expect(parsedInput).toMatchObject({
      ok: true,
      invocation: {
        cwd: "/",
        env: {
          GIT_AUTHOR_NAME: "Author",
          GIT_AUTHOR_EMAIL: "author@example.test",
          GIT_COMMITTER_NAME: "Committer",
          GIT_COMMITTER_EMAIL: "committer@example.test",
        },
      },
    });
  });

  it("runtime-validates every run option at its intrinsic bound", () => {
    expect(
      resolveGitCliRunOptions({
        maxStdoutBytes: GIT_CLI_MAX_STDOUT_BYTES,
        maxStderrBytes: GIT_CLI_MAX_STDERR_BYTES,
        maxCombinedOutputBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
        discardStderr: true,
        logLimitHint: GIT_CLI_MAX_LOG_COUNT,
      }),
    ).toEqual({
      maxStdoutBytes: GIT_CLI_MAX_STDOUT_BYTES,
      maxStderrBytes: GIT_CLI_MAX_STDERR_BYTES,
      maxCombinedOutputBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
      discardStderr: true,
      logLimitHint: GIT_CLI_MAX_LOG_COUNT,
    });
    for (const options of [
      null,
      [],
      { unknown: true },
      { maxStdoutBytes: -1 },
      { maxStdoutBytes: 1.5 },
      { maxStdoutBytes: GIT_CLI_MAX_STDOUT_BYTES + 1 },
      { maxStderrBytes: GIT_CLI_MAX_STDERR_BYTES + 1 },
      { maxCombinedOutputBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES + 1 },
      { discardStderr: 1 },
      { logLimitHint: GIT_CLI_MAX_LOG_COUNT + 1 },
    ]) {
      expect(() => resolveGitCliRunOptions(options)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it.each([
    ["maxStdoutBytes", GIT_CLI_MAX_STDOUT_BYTES],
    ["maxStderrBytes", GIT_CLI_MAX_STDERR_BYTES],
    ["maxCombinedOutputBytes", GIT_CLI_MAX_COMBINED_OUTPUT_BYTES],
    ["logLimitHint", GIT_CLI_MAX_LOG_COUNT],
  ])("pins zero, exact, first-excess, and fraction for %s", (field, maximum) => {
    expect(resolveGitCliRunOptions({ [field]: 0 })).toMatchObject({ [field]: 0 });
    expect(resolveGitCliRunOptions({ [field]: maximum })).toMatchObject({ [field]: maximum });
    expect(() => resolveGitCliRunOptions({ [field]: maximum + 1 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => resolveGitCliRunOptions({ [field]: 0.5 })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("accepts both discardStderr booleans and rejects non-booleans", () => {
    expect(resolveGitCliRunOptions({ discardStderr: false }).discardStderr).toBe(false);
    expect(resolveGitCliRunOptions({ discardStderr: true }).discardStderr).toBe(true);
    for (const value of [0, 1, "false", null]) {
      expect(() => resolveGitCliRunOptions({ discardStderr: value })).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it("rejects inherited run options and accepts a null-prototype options record", () => {
    for (const options of [
      recordWithPrototype({ maxStdoutBytes: 1 }, {}),
      recordWithPrototype({ unknown: true }, {}),
    ]) {
      expect(() => resolveGitCliRunOptions(options)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }

    expect(
      resolveGitCliRunOptions(
        recordWithPrototype(null, { maxStdoutBytes: 1, discardStderr: true }),
      ),
    ).toMatchObject({ maxStdoutBytes: 1, discardStderr: true });
  });
});

describe("git CLI result accounting and dispatch", () => {
  it("preflights stdout, stderr, and the combined ceiling", () => {
    const options = resolveGitCliRunOptions({
      maxStdoutBytes: 3,
      maxStderrBytes: 3,
      maxCombinedOutputBytes: 5,
    });
    expect(boundedGitCliResult(gitCliResult("abc", "de", 7), options)).toEqual({
      stdout: "abc",
      stderr: "de",
      exitCode: 7,
    });
    expect(() => boundedGitCliResult(gitCliResult("abcd", "", 1), options)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => boundedGitCliResult(gitCliResult("", "abcd", 1), options)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => boundedGitCliResult(gitCliResult("abc", "def", 1), options)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("accounts multibyte output at exact and first-excess byte ceilings", () => {
    expect(
      boundedGitCliResult(
        gitCliResult("é", "x", 0),
        resolveGitCliRunOptions({
          maxStdoutBytes: 2,
          maxStderrBytes: 1,
          maxCombinedOutputBytes: 3,
        }),
      ),
    ).toEqual({ stdout: "é", stderr: "x", exitCode: 0 });
    expect(() =>
      boundedGitCliResult(gitCliResult("é", "", 0), resolveGitCliRunOptions({ maxStdoutBytes: 1 })),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() =>
      boundedGitCliResult(gitCliResult("", "é", 0), resolveGitCliRunOptions({ maxStderrBytes: 1 })),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() =>
      boundedGitCliResult(
        gitCliResult("é", "é", 0),
        resolveGitCliRunOptions({ maxCombinedOutputBytes: 3 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("does not retain or charge discarded stderr", () => {
    const result = boundedGitCliResult(
      gitCliResult("abc", "diagnostic larger than every configured bound", 128),
      resolveGitCliRunOptions({
        maxStdoutBytes: 3,
        maxStderrBytes: 0,
        maxCombinedOutputBytes: 3,
        discardStderr: true,
      }),
    );
    expect(result).toEqual({ stdout: "abc", stderr: "", exitCode: 128 });

    const malformed = String.fromCharCode(0xd800);
    expect(
      boundedGitCliResult(
        gitCliResult("é", `unaccounted-é-${malformed}`, 1),
        resolveGitCliRunOptions({
          maxStdoutBytes: 2,
          maxStderrBytes: 0,
          maxCombinedOutputBytes: 2,
          discardStderr: true,
        }),
      ),
    ).toEqual({ stdout: "é", stderr: "", exitCode: 1 });
  });

  it("validates result runtime shapes and exit status", () => {
    expect(() => Reflect.apply(gitCliResult, undefined, [1, "", 0])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => Reflect.apply(gitCliResult, undefined, ["", 1, 0])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    for (const exitCode of [-1, 1.5, 256]) {
      expect(() => gitCliResult("", "", exitCode)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });

  it("passes cwd/env once, tightens log count by hint, and ignores stdin", () => {
    let seenCwd = "";
    let seenCount: number | undefined;
    const runner = createGitCliRunner({
      log(invocation, _options) {
        seenCwd = invocation.cwd;
        seenCount = invocation.command.count;
        return gitCliResult(invocation.env.GIT_AUTHOR_NAME ?? "", "", 0);
      },
    });
    expect(
      runner.runCli(
        {
          argv: ["log", "-n", "20"],
          cwd: "/repo/nested",
          env: { GIT_AUTHOR_NAME: "A", UNUSED: "ignored" },
          stdin: "ignored",
        },
        { logLimitHint: 3 },
      ),
    ).toEqual({ stdout: "A", stderr: "", exitCode: 0 });
    expect(seenCwd).toBe("/repo/nested");
    expect(seenCount).toBe(3);
    runner.runCli({ argv: ["log", "-n", "2"] }, { logLimitHint: 3 });
    expect(seenCount).toBe(2);
  });

  it("passes exact resolved defaults and overrides to every handler", () => {
    const seen: Array<{ command: string; options: ResolvedGitCliRunOptions }> = [];
    function record(command: string, options: ResolvedGitCliRunOptions): GitCliResult {
      seen.push({ command, options });
      return gitCliResult("", "", 0);
    }
    const runner = createGitCliRunner({
      status(_invocation, options) {
        return record("status", options);
      },
      diff(_invocation, options) {
        return record("diff", options);
      },
      log(_invocation, options) {
        return record("log", options);
      },
      revList(_invocation, options) {
        return record("rev-list", options);
      },
      symbolicRef(_invocation, options) {
        return record("symbolic-ref", options);
      },
      add(_invocation, options) {
        return record("add", options);
      },
      commit(_invocation, options) {
        return record("commit", options);
      },
      rebase(_invocation, options) {
        return record("rebase", options);
      },
    });
    const commands = [
      ["status", "--porcelain"],
      ["diff"],
      ["log"],
      ["rev-list", "--count", "main..HEAD"],
      ["symbolic-ref", "--short", "HEAD"],
      ["add", "file"],
      ["commit", "-m", "message"],
      ["rebase", "--abort"],
    ];
    const defaults = resolveGitCliRunOptions(undefined);
    for (const argv of commands) runner.runCli({ argv });
    expect(seen).toEqual(
      commands.map((argv) => ({
        command: argv[0],
        options: defaults,
      })),
    );

    const overrides = {
      maxStdoutBytes: 7,
      maxStderrBytes: 8,
      maxCombinedOutputBytes: 9,
      discardStderr: true,
      logLimitHint: 2,
    };
    const resolvedOverrides = resolveGitCliRunOptions(overrides);
    for (const argv of commands) runner.runCli({ argv }, overrides);
    expect(seen.slice(commands.length)).toEqual(
      commands.map((argv) => ({
        command: argv[0],
        options: resolvedOverrides,
      })),
    );

    const calls = seen.length;
    for (const argv of [
      ["status"],
      ["diff", "--"],
      ["log", "-n", "bad"],
      ["rev-list", "HEAD"],
      ["symbolic-ref", "HEAD"],
      ["add", ":file"],
      ["commit", "-m"],
      ["rebase", "--skip"],
      ["push"],
      ["unknown"],
    ]) {
      runner.runCli({ argv });
    }
    expect(seen).toHaveLength(calls);
  });

  it("freezes handler options and preserves the caller ceiling", () => {
    let frozen = false;
    let changed = true;
    const runner = createGitCliRunner({
      status(_invocation, options) {
        frozen = Object.isFrozen(options);
        changed = Reflect.set(options, "maxStdoutBytes", 2);
        return gitCliResult("xx", "", 0);
      },
    });
    expect(() =>
      runner.runCli(
        { argv: ["status", "--porcelain"] },
        { maxStdoutBytes: 1, maxCombinedOutputBytes: 1 },
      ),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(frozen).toBe(true);
    expect(changed).toBe(false);
  });

  it("returns every parser refusal without invoking an operation", () => {
    let calls = 0;
    const handlers: GitCliHandlers = {
      status(_invocation, _options) {
        calls++;
        return gitCliResult("unexpected", "", 0);
      },
      add(_invocation, _options) {
        calls++;
        return gitCliResult("unexpected", "", 0);
      },
    };
    const runner = createGitCliRunner(handlers);
    expect(runner.runCli({ argv: ["status", "--short", "extra"] }).exitCode).toBe(129);
    for (const argv of [
      ["add", ":file"],
      ["add", ":!file"],
      ["add", ":^file"],
      ["add", ":/"],
      ["add", ":(glob)file"],
      ["add", "--", ":file"],
    ]) {
      expect(runner.runCli({ argv }).exitCode).toBe(129);
    }
    expect(runner.runCli({ argv: ["push"] }).exitCode).toBe(128);
    expect(runner.runCli({ argv: ["unknown"] }).exitCode).toBe(1);
    expect(calls).toBe(0);
  });

  it("keeps missing handlers as unexpected programming errors", () => {
    const runner = createGitCliRunner({});
    expect(() => runner.runCli({ argv: ["diff"] })).toThrowError(
      "missing git CLI handler for diff",
    );
  });

  it("runtime-validates the public runner despite its static input type", () => {
    const runner = createGitCliRunner({});
    expect(() => Reflect.apply(runner.runCli, runner, [{ argv: [], dir: "/" }])).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() =>
      Reflect.apply(runner.runCli, runner, [{ argv: ["diff"] }, { maxStdoutBytes: "1" }]),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });
});

function parsed(argv: readonly string[]): ParsedGitCliCommand {
  const result = parseGitCliCommand(argv);
  if (!result.ok) throw new Error(`expected accepted argv, received ${result.result.stderr}`);
  return result.invocation.command;
}

function rejected(argv: readonly string[]): GitCliResult {
  const result = parseGitCliCommand(argv);
  if (result.ok)
    throw new Error(`expected rejected argv, received ${result.invocation.command.kind}`);
  return result.result;
}

function recordWithPrototype(
  prototype: object | null,
  properties: Readonly<Record<string, unknown>>,
): unknown {
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(properties)) {
    descriptors[key] = { value, enumerable: true, configurable: true, writable: true };
  }
  return Object.create(prototype, descriptors);
}
