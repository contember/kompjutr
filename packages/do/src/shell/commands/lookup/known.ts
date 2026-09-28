// What a command name resolves to, for `which`, `type`, and `command -v`.
//
// There is no PATH: every command is a registry entry. A registered name that
// Bash implements as a builtin is a builtin; any other registered name is a
// file at /usr/bin/<name>, the path `which` has always printed. Names only an
// injected `ShellOptions.commands` supplies are not visible here.

/** Names the registry holds. Filled in by the registry at load. */
const KNOWN = new Set<string>();

export function registerKnownCommands(names: Iterable<string>): void {
  for (const name of names) KNOWN.add(name);
}

export function isKnown(name: string): boolean {
  return KNOWN.has(name);
}

// Bash 5.2's builtins; only the registered ones are reported.
const BASH_BUILTINS = new Set([
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "bind",
  "break",
  "builtin",
  "caller",
  "cd",
  "command",
  "compgen",
  "complete",
  "compopt",
  "continue",
  "declare",
  "dirs",
  "disown",
  "echo",
  "enable",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "getopts",
  "hash",
  "help",
  "history",
  "jobs",
  "kill",
  "let",
  "local",
  "logout",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "shopt",
  "source",
  "suspend",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]);

/** Builtins that also ship as a coreutils binary, so `type -P` finds a file. */
const ALSO_FILES = new Set(["[", "echo", "false", "kill", "printf", "pwd", "test", "true"]);

// The parser's reserved words. `[[`, `time`, and `coproc` are Bash keywords
// the parser does not know, so they are not reported as keywords.
const KEYWORDS = new Set([
  "!",
  "{",
  "}",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
]);

// Builtins the executor runs itself (exec/compound/builtins.ts); they are
// never registry entries, so the registry cannot report them.
const EXECUTOR_BUILTINS = new Set(["set", "break", "continue", "export", "unset"]);

export type Resolution =
  | { readonly kind: "keyword" }
  | { readonly kind: "builtin" }
  | { readonly kind: "file"; readonly path: string };

/** Keyword, then builtin, then file — Bash's order. `forcePath` looks for a file only. */
export function resolveName(name: string, forcePath: boolean): Resolution | null {
  if (!forcePath && KEYWORDS.has(name)) return { kind: "keyword" };
  if (EXECUTOR_BUILTINS.has(name)) return forcePath ? null : { kind: "builtin" };
  if (!KNOWN.has(name)) return null;
  const builtin = BASH_BUILTINS.has(name);
  if (!forcePath && builtin) return { kind: "builtin" };
  if (builtin && !ALSO_FILES.has(name)) return null;
  return { kind: "file", path: `/usr/bin/${name}` };
}
