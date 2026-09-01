// The shapes come from the 614-line agent corpus behind docs/archive/plans/shell.md;
// the payloads do not. The corpus itself carries client data and this package
// is public, so each case here reproduces an observed *shape* with neutral
// content. Coverage against the real corpus is checked out of tree: 608 of
// 614 parse, 6 are rejected by name, none crash.

import { describe, expect, it } from "vitest";

import { hasGlob, ShellSyntaxError, wordText } from "../../src/shell/parse/ast.js";
import { parse } from "../../src/shell/parse/parser.js";

function commands(source: string): string[][] {
  const script = parse(source);
  const out: string[][] = [];
  for (const statement of script.statements) {
    for (const command of statement.pipeline.commands) {
      out.push(command.words.map(wordText));
    }
  }
  return out;
}

function rejects(source: string): ShellSyntaxError {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof ShellSyntaxError) return error;
    throw error;
  }
  throw new Error(`expected ${source} to be rejected`);
}

describe("words and quoting", () => {
  it("parses a plain command", () => {
    expect(commands("ls -la /repo/src")).toEqual([["ls", "-la", "/repo/src"]]);
  });

  it("keeps a quoted pipe inside the word", () => {
    // The trap: `grep -E "a|b"` is one command, not a pipeline. Splitting on
    // a quoted operator silently truncates the pattern.
    expect(commands('grep -E "alpha|beta" file.txt')).toEqual([
      ["grep", "-E", "alpha|beta", "file.txt"],
    ]);
    expect(parse('grep -E "a|b"').statements[0]?.pipeline.commands).toHaveLength(1);
  });

  it("keeps quoted operators of every kind inside the word", () => {
    expect(commands('grep "a&&b;c>d" f')).toEqual([["grep", "a&&b;c>d", "f"]]);
    expect(commands("grep 'a|b' f")).toEqual([["grep", "a|b", "f"]]);
  });

  it("preserves a backslash that double quotes do not consume", () => {
    // `grep "a\.b"` must reach the engine with the escape intact.
    expect(commands('grep "a\\.b" f')).toEqual([["grep", "a\\.b", "f"]]);
    // The four bash does consume.
    expect(commands('echo "a\\"b"')).toEqual([["echo", 'a"b']]);
  });

  it("treats single quotes as fully literal", () => {
    expect(commands("echo 'a\\nb$c'")).toEqual([["echo", "a\\nb$c"]]);
  });

  it("records an unquoted escape as its own part", () => {
    const word = parse("grep a\\ b").statements[0]?.pipeline.commands[0]?.words[1];
    expect(word?.parts.map((part) => part.kind)).toEqual(["Literal", "Escaped", "Literal"]);
    expect(wordText(word!)).toBe("a b");
  });

  it("marks unquoted globs and leaves quoted ones literal", () => {
    const glob = parse("ls *.ts").statements[0]?.pipeline.commands[0]?.words[1];
    expect(hasGlob(glob!)).toBe(true);
    const quoted = parse('ls "*.ts"').statements[0]?.pipeline.commands[0]?.words[1];
    expect(hasGlob(quoted!)).toBe(false);
  });

  it("reads a character class as one glob part", () => {
    const word = parse("ls file[0-9].txt").statements[0]?.pipeline.commands[0]?.words[1];
    expect(word?.parts.map((part) => (part.kind === "Parameter" ? part.name : part.value))).toEqual(
      ["file", "[0-9]", ".txt"],
    );
    // An unclosed `[` is an ordinary character, as in bash.
    expect(hasGlob(parse("ls a[b").statements[0]!.pipeline.commands[0]!.words[1]!)).toBe(false);
  });

  it("preserves named parameters in order with quote context", () => {
    const word = parse(`echo pre$ONE-"\${TWO}"-'$THREE'-\\$FOUR`).statements[0]?.pipeline
      .commands[0]?.words[1];
    expect(word?.parts).toEqual([
      { kind: "Literal", value: "pre" },
      { kind: "Parameter", name: "ONE", quoted: false },
      { kind: "Literal", value: "-" },
      { kind: "Parameter", name: "TWO", quoted: true },
      { kind: "Literal", value: "-" },
      { kind: "SingleQuoted", value: "$THREE" },
      { kind: "Literal", value: "-" },
      { kind: "Escaped", value: "$" },
      { kind: "Literal", value: "FOUR" },
    ]);
  });
});

describe("pipelines and connectors", () => {
  it("parses the corpus's most common shape", () => {
    expect(commands("grep -rn pattern . | head -20")).toEqual([
      ["grep", "-rn", "pattern", "."],
      ["head", "-20"],
    ]);
  });

  it("parses a four-stage pipeline", () => {
    expect(commands("find . -name '*.ts' | xargs grep -l x | sort | head")).toHaveLength(4);
  });

  it("carries the connector on the statement it follows", () => {
    const script = parse("cd /repo && ls");
    expect(script.statements).toHaveLength(2);
    expect(script.statements[0]?.connector).toBe("&&");
    expect(script.statements[1]?.connector).toBeNull();
  });

  it("treats a trailing semicolon as the end, not a promise", () => {
    const script = parse("ls;");
    expect(script.statements).toHaveLength(1);
    expect(script.statements[0]?.connector).toBeNull();
  });

  it("parses `||` as a connector, not two pipes", () => {
    expect(parse("grep x f || true").statements[0]?.connector).toBe("||");
  });
});

describe("redirections", () => {
  it("parses the corpus's second most common shape", () => {
    const command = parse("grep -r x . 2>/dev/null").statements[0]?.pipeline.commands[0];
    expect(command?.words.map(wordText)).toEqual(["grep", "-r", "x", "."]);
    expect(command?.redirections).toHaveLength(1);
    const redirection = command?.redirections[0];
    expect(redirection?.fd).toBe(2);
    expect(redirection?.op).toBe(">");
  });

  it("parses `2>&1` as a descriptor duplication", () => {
    const command = parse("bun run build 2>&1").statements[0]?.pipeline.commands[0];
    const redirection = command?.redirections[0];
    expect(redirection).toMatchObject({ fd: 2, op: ">&", targetFd: 1 });
  });

  it("combines a duplication with a pipe", () => {
    const script = parse("bun run build 2>&1 | tail -20");
    expect(script.statements[0]?.pipeline.commands).toHaveLength(2);
    expect(script.statements[0]?.pipeline.commands[0]?.redirections).toHaveLength(1);
  });

  it("defaults the descriptor by operator", () => {
    expect(parse("ls > out").statements[0]?.pipeline.commands[0]?.redirections[0]?.fd).toBe(1);
    expect(parse("cat < in").statements[0]?.pipeline.commands[0]?.redirections[0]?.fd).toBe(0);
  });

  it("only reads a descriptor when it touches the operator", () => {
    // `echo 2 > x` prints "2"; `echo 2> x` redirects stderr.
    expect(commands("echo 2 > x")).toEqual([["echo", "2"]]);
    expect(parse("echo 2> x").statements[0]?.pipeline.commands[0]?.redirections[0]?.fd).toBe(2);
  });

  it("parses append", () => {
    expect(parse("echo x >> log").statements[0]?.pipeline.commands[0]?.redirections[0]?.op).toBe(
      ">>",
    );
  });
});

describe("rejections name the construct", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["echo $(date)", "command substitution"],
    ["echo `date`", "command substitution"],
    ["echo $((1+1))", "arithmetic expansion"],
    ["echo $1", "parameter expansion"],
    ["echo $@", "parameter expansion"],
    ["echo $*", "parameter expansion"],
    ["echo $#", "parameter expansion"],
    ["echo $?", "parameter expansion"],
    ["echo $!", "parameter expansion"],
    ["echo $-", "parameter expansion"],
    ["echo $$", "parameter expansion"],
    ['echo "$*"', "parameter expansion"],
    ['echo "$#"', "parameter expansion"],
    ['echo "$!"', "parameter expansion"],
    ['echo "$-"', "parameter expansion"],
    [`echo \${HOME:-fallback}`, "parameter expansion operator"],
    ["diff <(ls a) <(ls b)", "process substitution"],
    ["cat <<EOF", "here-document"],
    ["[[ -f x ]]", "conditional expression"],
    ["for f in a b; do echo x; done", "`for`"],
    ["if true; then ls; fi", "`if`"],
    ["while true; do ls; done", "`while`"],
    ["ls &", "background execution"],
    ["(ls)", "subshell"],
    ["{ ls; }", "command group"],
  ];

  for (const [source, construct] of cases) {
    it(`rejects ${source}`, () => {
      const error = rejects(source);
      expect(error.construct).toBe(construct);
      // The message has to be usable by whoever reads the stderr.
      expect(error.message).toContain(construct);
    });
  }

  it("does not mistake a lone $ for an expansion", () => {
    expect(commands("grep 'a$' f")).toEqual([["grep", "a$", "f"]]);
    expect(commands("echo 100$")).toEqual([["echo", "100$"]]);
  });
});

describe("malformed input", () => {
  it("reports an unterminated quote at its opening offset", () => {
    expect(rejects('grep "abc').construct).toBe("quote");
    expect(rejects("grep 'abc").construct).toBe("quote");
    expect(rejects('grep "abc').offset).toBe(5);
  });

  it("reports a trailing backslash", () => {
    expect(rejects("echo a\\").construct).toBe("escape");
  });

  it("reports a pipeline stage with no command", () => {
    expect(rejects("ls | | wc").construct).toBe("command");
    expect(rejects("| ls").construct).toBe("command");
  });

  it("reports a redirection with no target", () => {
    expect(rejects("ls >").construct).toBe("redirection");
    expect(rejects("ls >& x").construct).toBe("redirection");
  });

  it("parses an empty script as no statements", () => {
    expect(parse("").statements).toEqual([]);
    expect(parse("   ").statements).toEqual([]);
  });

  it("drops a trailing comment", () => {
    expect(commands("ls -la # list them")).toEqual([["ls", "-la"]]);
    // A `#` inside a word is not a comment.
    expect(commands("grep a#b f")).toEqual([["grep", "a#b", "f"]]);
  });
});
