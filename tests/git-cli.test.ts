import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundedGitCliResult,
  createGitCliRunner,
  GIT_CLI_MAX_ARGV_ENTRIES,
  GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
  GIT_CLI_MAX_ENV_ENTRIES,
  GIT_CLI_MAX_LOG_COUNT,
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
    [["status"], { kind: "status", format: "default" }],
    [["status", "--porcelain"], { kind: "status", format: "porcelain-v1" }],
    [["status", "--porcelain=v1"], { kind: "status", format: "porcelain-v1" }],
    [["status", "--short"], { kind: "status", format: "short" }],
    [["status", "-s"], { kind: "status", format: "short" }],
    [
      ["status", "--porcelain=v2", "--branch", "--", "src", "README.md"],
      {
        kind: "status",
        format: "porcelain-v2",
        branch: true,
        paths: ["src", "README.md"],
      },
    ],
    [["rev-parse", "HEAD^0"], { kind: "rev-parse", revision: "HEAD^0" }],
    [
      ["rev-parse", "--quiet", "--verify", "main"],
      { kind: "rev-parse", revision: "main", verify: true, quiet: true },
    ],
    [["rev-parse", "--show-toplevel"], { kind: "rev-parse", showToplevel: true }],
    [["branch", "--show-current"], { kind: "branch", action: "show-current" }],
    [["branch", "--list"], { kind: "branch", action: "list" }],
    [["ls-files"], { kind: "ls-files" }],
    [
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"],
      {
        kind: "ls-files",
        cached: true,
        others: true,
        excludeStandard: true,
        paths: ["src"],
      },
    ],
    [["diff"], { kind: "diff" }],
    [["diff", "HEAD"], { kind: "diff", ref: "HEAD" }],
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
    ["duplicate status format", ["status", "--short", "--porcelain=v2"]],
    ["status glob", ["status", "--", "*.ts"]],
    ["rev-parse missing revision", ["rev-parse", "--verify"]],
    ["rev-parse quiet without verify", ["rev-parse", "--quiet", "HEAD"]],
    ["rev-parse extra revision", ["rev-parse", "HEAD", "main"]],
    ["branch without selector", ["branch"]],
    ["branch extra operand", ["branch", "--list", "main"]],
    ["ls-files exclude without others", ["ls-files", "--exclude-standard"]],
    ["ls-files glob", ["ls-files", "--", "*.ts"]],
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
  it.each([
    [["status"], "eagerStatus + formatCliStatus"],
    [["status", "--porcelain=v2"], "eagerStatus + formatPorcelainV2"],
    [["rev-parse", "HEAD"], "Repository.tryRevParse"],
    [["rev-parse", "--show-toplevel"], "Repository.root"],
    [["branch", "--show-current"], "currentBranch"],
    [["branch", "--list"], "branchList"],
    [["ls-files", "--cached"], "lsFilesWithWorktree"],
    [["ls-files", "--others", "--exclude-standard"], "lsFilesWithWorktree"],
  ])("accepts the pinned WU3 form %j via %s", (argv, _native) => {
    expect(parseGitCliCommand(argv).ok).toBe(true);
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
        truncated: false,
      });
    },
  );
  it("pins unknown and network command framing", () => {
    expect(rejected([])).toEqual({
      stdout: "",
      stderr: "git: no command specified\n",
      exitCode: 1,
      truncated: false,
    });
    expect(rejected(["frobnicate"])).toEqual({
      stdout: "",
      stderr: "git: 'frobnicate' is not a git command. See 'git --help'.\n",
      exitCode: 1,
      truncated: false,
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
      truncated: false,
    });
    for (const command of ["fetch", "pull", "clone", "ls-remote"]) {
      expect(rejected([command])).toEqual({
        stdout: "",
        stderr: `fatal: network command '${command}' is not supported\n`,
        exitCode: 128,
        truncated: false,
      });
    }
  });
  it.each([
    [
      "status",
      1249,
      "742609d57c5b33e9deaf00bf6e6ce8e0b53b9fb041d57391fc9c855b31014fd8",
      "error: unknown option `definitely-unknown'\nusage: git status",
    ],
    [
      "diff",
      1648,
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
      1676,
      "eb915d729dc063b6519916ad41f0de7d213a20816e54061cd177f9f2e319801f",
      "error: unknown option `definitely-unknown'\nusage: git add",
    ],
    [
      "commit",
      3594,
      "f2f8aca47d4a2605fcbddd53d62878b5a35c3e3863862230e1f2f4969a244762",
      "error: unknown option `definitely-unknown'\nusage: git commit",
    ],
    [
      "rebase",
      3470,
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
      truncated: false,
    });
    expect(rejected(["commit", "-m"])).toEqual({
      stdout: "",
      stderr: "error: switch `m' requires a value\n",
      exitCode: 129,
      truncated: false,
    });
  });
});
describe("git CLI runtime validation and bounds", () => {
  it("keeps argv cardinality structural without a byte-component refusal", async () => {
    expect(
      validateGitCliInput({ argv: Array(GIT_CLI_MAX_ARGV_ENTRIES).fill("") }).argv,
    ).toHaveLength(GIT_CLI_MAX_ARGV_ENTRIES);
    expect(() =>
      validateGitCliInput({ argv: Array(GIT_CLI_MAX_ARGV_ENTRIES + 1).fill("") }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    const argument = "x".repeat(1024 * 1024 + 1);
    expect(validateGitCliInput({ argv: [argument] }).argv).toEqual([argument]);
    expect((await createGitCliRunner({}).runCli({ argv: [argument] })).exitCode).toBe(1);
  });
  it("rejects argv mutation after capturing its checked length", async () => {
    let calls = 0;
    const runner = createGitCliRunner({
      status() {
        calls++;
        return gitCliResult("", "", 0);
      },
    });
    const argv = ["status", "--porcelain"];
    Object.defineProperty(argv, 0, {
      configurable: true,
      get() {
        argv.push(...Array(GIT_CLI_MAX_ARGV_ENTRIES).fill("extra"));
        return "status";
      },
    });
    await expect(runner.runCli({ argv })).rejects.toThrowError(
      expect.objectContaining({
        code: "EINVAL",
        message: "git CLI argv changed during validation",
      }),
    );
    expect(calls).toBe(0);
  });
  it("accepts cwd, stdin, and env crossing their former component thresholds", async () => {
    const cwd = `/${"x".repeat(4 * 1024)}`;
    const stdin = "x".repeat(1024 * 1024 + 1);
    const env = { K: "x".repeat(1024 * 1024 + 1) };
    expect(validateGitCliInput({ argv: [], cwd, stdin, env })).toEqual({
      argv: [],
      cwd,
      env: {
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
      },
      stdin,
    });
    expect(
      await createGitCliRunner({
        status(invocation) {
          return gitCliResult(invocation.cwd, "", 0);
        },
      }).runCli({ argv: ["status", "--porcelain"], cwd, stdin, env }),
    ).toEqual({ stdout: cwd, stderr: "", exitCode: 0, truncated: false });
    const entries: Array<readonly [string, string]> = [];
    for (let index = 0; index < GIT_CLI_MAX_ENV_ENTRIES; index++) entries.push([`K${index}`, ""]);
    expect(validateGitCliInput({ argv: [], env: Object.fromEntries(entries) }).env).toBeDefined();
    entries.push(["overflow", ""]);
    expect(() => validateGitCliInput({ argv: [], env: Object.fromEntries(entries) })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });
  it("accepts commit messages and log formats crossing their former component thresholds", async () => {
    const message = "é".repeat((1024 * 1024) / 2 + 1);
    const format = "é".repeat((64 * 1024) / 2 + 1);
    expect(parsed(["commit", "-m", message])).toMatchObject({ kind: "commit", message });
    expect(parsed(["log", `--format=${format}`])).toMatchObject({
      kind: "log",
      format: { kind: "template", template: format },
    });
    const runner = createGitCliRunner({
      commit(invocation) {
        return gitCliResult(String(invocation.command.message.length), "", 0);
      },
      log(invocation) {
        const retained = invocation.command.format;
        return gitCliResult(
          retained.kind === "template" ? String(retained.template.length) : "",
          "",
          0,
        );
      },
    });
    expect((await runner.runCli({ argv: ["commit", "-m", message] })).exitCode).toBe(0);
    expect((await runner.runCli({ argv: ["log", `--format=${format}`] })).exitCode).toBe(0);
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
    ).toEqual({ stdout: "out\0put", stderr: "err\0or", exitCode: 0, truncated: false });
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
        maxStdoutBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
        maxStderrBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
        maxCombinedOutputBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
        discardStderr: true,
        logLimitHint: GIT_CLI_MAX_LOG_COUNT,
      }),
    ).toEqual({
      maxStdoutBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
      maxStderrBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
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
      { maxStdoutBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES + 1 },
      { maxStderrBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES + 1 },
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
    ["maxStdoutBytes", GIT_CLI_MAX_COMBINED_OUTPUT_BYTES],
    ["maxStderrBytes", GIT_CLI_MAX_COMBINED_OUTPUT_BYTES],
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
describe("git CLI result bounds and dispatch", () => {
  it("does not return a discarded huge parser diagnostic", async () => {
    const command = "x".repeat(GIT_CLI_MAX_COMBINED_OUTPUT_BYTES + 1);
    const runner = createGitCliRunner({});
    expect(
      await runner.runCli(
        { argv: [command] },
        {
          discardStderr: true,
          maxStdoutBytes: 0,
          maxStderrBytes: 0,
          maxCombinedOutputBytes: 0,
        },
      ),
    ).toEqual({ stdout: "", stderr: "", exitCode: 1, truncated: false });
    await expect(
      runner.runCli({ argv: [command] }, { maxCombinedOutputBytes: 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
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
      truncated: false,
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
  it("snapshots mutable handler result fields once and returns a fresh plain result", () => {
    const reads = { stdout: 0, stderr: 0, exitCode: 0, truncated: 0 };
    let stdout = "first stdout";
    let stderr = "first stderr";
    let exitCode = 7;
    const source: GitCliResult = { stdout: "", stderr: "", exitCode: 0, truncated: false };
    Object.defineProperties(source, {
      stdout: {
        get() {
          reads.stdout++;
          const snapshot = stdout;
          stdout = "later stdout";
          return snapshot;
        },
      },
      stderr: {
        get() {
          reads.stderr++;
          const snapshot = stderr;
          stderr = "later stderr";
          return snapshot;
        },
      },
      exitCode: {
        get() {
          reads.exitCode++;
          const snapshot = exitCode;
          exitCode = 9;
          return snapshot;
        },
      },
      truncated: {
        get() {
          reads.truncated++;
          return false;
        },
      },
    });
    const checked = boundedGitCliResult(source, resolveGitCliRunOptions(undefined));
    const snapshotReads = { ...reads };
    expect(checked).toEqual({
      stdout: "first stdout",
      stderr: "first stderr",
      exitCode: 7,
      truncated: false,
    });
    expect(checked).not.toBe(source);
    expect(Object.getPrototypeOf(checked)).toBe(Object.prototype);
    expect(snapshotReads).toEqual({ stdout: 1, stderr: 1, exitCode: 1, truncated: 1 });
  });
  it.each([
    ["direct", ["unknown-command"]],
    ["sliced", ["status", "--unknown-option"]],
  ])(
    "preserves stderr then combined diagnostic precedence for %s diagnostics",
    async (_name, argv) => {
      const runner = createGitCliRunner({});
      await expect(
        runner.runCli({ argv }, { maxStderrBytes: 2, maxCombinedOutputBytes: 1 }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "E2BIG",
          message: "git CLI stderr exceeds 2 bytes",
        }),
      );
      await expect(
        runner.runCli(
          { argv },
          { maxStderrBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES, maxCombinedOutputBytes: 1 },
        ),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "E2BIG",
          message: "git CLI combined output exceeds 1 bytes",
        }),
      );
    },
  );
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
    ).toEqual({ stdout: "é", stderr: "x", exitCode: 0, truncated: false });
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
  it("accepts exact combined stdout and stderr and rejects the first excess", async () => {
    const stdout = "o".repeat(GIT_CLI_MAX_COMBINED_OUTPUT_BYTES / 2);
    const stderr = "e".repeat(GIT_CLI_MAX_COMBINED_OUTPUT_BYTES / 2);
    let excess = false;
    const runner = createGitCliRunner({
      status() {
        return gitCliResult(stdout, excess ? `${stderr}x` : stderr, 0);
      },
    });
    expect(await runner.runCli({ argv: ["status", "--porcelain"] })).toEqual({
      stdout,
      stderr,
      exitCode: 0,
      truncated: false,
    });
    excess = true;
    await expect(runner.runCli({ argv: ["status", "--porcelain"] })).rejects.toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });
  it("propagates parser, handler, and output errors", async () => {
    const runner = createGitCliRunner({
      status() {
        throw new Error("handler failed");
      },
    });
    expect((await runner.runCli({ argv: ["unknown"] })).exitCode).toBe(1);
    await expect(runner.runCli({ argv: [String.fromCharCode(0xd800)] })).rejects.toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    await expect(runner.runCli({ argv: ["status", "--porcelain"] })).rejects.toThrow(
      "handler failed",
    );
    const outputRunner = createGitCliRunner({
      status() {
        return gitCliResult("xx", "", 0);
      },
    });
    await expect(
      outputRunner.runCli({ argv: ["status", "--porcelain"] }, { maxStdoutBytes: 1 }),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    const slicedOutputRunner = createGitCliRunner({
      commit() {
        return gitCliResult("output", "", 0);
      },
    });
    await expect(
      slicedOutputRunner.runCli(
        { argv: ["commit", `--message=${"x".repeat(4096)}`] },
        { maxStdoutBytes: 1 },
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
  it("does not return or UTF-8 validate discarded stderr", async () => {
    const result = boundedGitCliResult(
      gitCliResult("abc", "diagnostic larger than every configured bound", 128),
      resolveGitCliRunOptions({
        maxStdoutBytes: 3,
        maxStderrBytes: 0,
        maxCombinedOutputBytes: 3,
        discardStderr: true,
      }),
    );
    expect(result).toEqual({ stdout: "abc", stderr: "", exitCode: 128, truncated: false });
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
    ).toEqual({ stdout: "é", stderr: "", exitCode: 1, truncated: false });
    const injectedStderr = "diagnostic".repeat(1000);
    const runner = createGitCliRunner({
      status() {
        return gitCliResult("", injectedStderr, 1);
      },
    });
    expect(
      await runner.runCli(
        { argv: ["status", "--porcelain"] },
        { discardStderr: true, maxStderrBytes: 0 },
      ),
    ).toEqual({ stdout: "", stderr: "", exitCode: 1, truncated: false });
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
  it("passes cwd/env once, tightens log count by hint, and ignores stdin", async () => {
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
      await runner.runCli(
        {
          argv: ["log", "-n", "20"],
          cwd: "/repo/nested",
          env: { GIT_AUTHOR_NAME: "A", UNUSED: "ignored" },
          stdin: "ignored",
        },
        { logLimitHint: 3 },
      ),
    ).toEqual({ stdout: "A", stderr: "", exitCode: 0, truncated: false });
    expect(seenCwd).toBe("/repo/nested");
    expect(seenCount).toBe(3);
    await runner.runCli({ argv: ["log", "-n", "2"] }, { logLimitHint: 3 });
    expect(seenCount).toBe(2);
  });
  it("passes exact resolved defaults and overrides to every handler", async () => {
    const seen: Array<{
      command: string;
      options: ResolvedGitCliRunOptions;
    }> = [];
    function record(command: string, options: ResolvedGitCliRunOptions): GitCliResult {
      seen.push({ command, options });
      return gitCliResult("", "", 0);
    }
    const runner = createGitCliRunner({
      status(_invocation, options) {
        return record("status", options);
      },
      revParse(_invocation, options) {
        return record("rev-parse", options);
      },
      branch(_invocation, options) {
        return record("branch", options);
      },
      lsFiles(_invocation, options) {
        return record("ls-files", options);
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
      ["rev-parse", "HEAD"],
      ["branch", "--show-current"],
      ["ls-files"],
      ["diff"],
      ["log"],
      ["rev-list", "--count", "main..HEAD"],
      ["symbolic-ref", "--short", "HEAD"],
      ["add", "file"],
      ["commit", "-m", "message"],
      ["rebase", "--abort"],
    ];
    const defaults = resolveGitCliRunOptions(undefined);
    for (const argv of commands) await runner.runCli({ argv });
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
    for (const argv of commands) await runner.runCli({ argv }, overrides);
    expect(seen.slice(commands.length)).toEqual(
      commands.map((argv) => ({
        command: argv[0],
        options: resolvedOverrides,
      })),
    );
    const calls = seen.length;
    for (const argv of [
      ["status", "--short", "--porcelain=v2"],
      ["rev-parse", "--quiet", "HEAD"],
      ["branch"],
      ["ls-files", "--exclude-standard"],
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
      await runner.runCli({ argv });
    }
    expect(seen).toHaveLength(calls);
  });
  it("freezes handler options and preserves the caller ceiling", async () => {
    let frozen = false;
    let changed = true;
    const runner = createGitCliRunner({
      status(_invocation, options) {
        frozen = Object.isFrozen(options);
        changed = Reflect.set(options, "maxStdoutBytes", 2);
        return gitCliResult("xx", "", 0);
      },
    });
    await expect(
      runner.runCli(
        { argv: ["status", "--porcelain"] },
        { maxStdoutBytes: 1, maxCombinedOutputBytes: 1 },
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(frozen).toBe(true);
    expect(changed).toBe(false);
  });
  it("returns every parser refusal without invoking an operation", async () => {
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
    expect((await runner.runCli({ argv: ["status", "--short", "--porcelain=v2"] })).exitCode).toBe(
      129,
    );
    for (const argv of [
      ["add", ":file"],
      ["add", ":!file"],
      ["add", ":^file"],
      ["add", ":/"],
      ["add", ":(glob)file"],
      ["add", "--", ":file"],
    ]) {
      expect((await runner.runCli({ argv })).exitCode).toBe(129);
    }
    expect((await runner.runCli({ argv: ["push"] })).exitCode).toBe(128);
    expect((await runner.runCli({ argv: ["unknown"] })).exitCode).toBe(1);
    expect(calls).toBe(0);
  });
  it("keeps missing handlers as unexpected programming errors", async () => {
    const runner = createGitCliRunner({});
    await expect(runner.runCli({ argv: ["diff"] })).rejects.toThrowError(
      "missing git CLI handler for diff",
    );
  });
  it("runtime-validates the public runner despite its static input type", async () => {
    const runner = createGitCliRunner({});
    await expect(
      Reflect.apply(runner.runCli, runner, [{ argv: [], dir: "/" }]),
    ).rejects.toThrowError(expect.objectContaining({ code: "EINVAL" }));
    await expect(
      Reflect.apply(runner.runCli, runner, [{ argv: ["diff"] }, { maxStdoutBytes: "1" }]),
    ).rejects.toThrowError(expect.objectContaining({ code: "EINVAL" }));
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
