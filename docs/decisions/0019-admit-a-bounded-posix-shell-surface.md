---
id: 0019
title: Admit a bounded POSIX shell surface
status: accepted
date: 2026-09-01
---

# 0019 — Admit a bounded POSIX shell surface

## Context

The shell deliberately started with a finite grammar and commands that compile
to bounded filesystem work
([ADR-0018](0018-compile-shell-commands-to-bounded-queries.md)). Common
agent-authored command lines nevertheless use `printf`, `exit`, `1>&2`, and named
environment parameters. Rejecting all four kept the implementation small but
excluded ordinary scripts without protecting any specific runtime limit.

Agents also send multi-line command lines, write files through
here-documents, and guard steps with `test`/`[` and `!`. A newline read as a
blank joined statements silently, so `rm -r build` followed by `ls` on the next
line removed `ls` as well.

Named parameter expansion was the consequential boundary change. Supporting it
partially, or at parse time, would lose Bash's quote-sensitive field behaviour,
and planning happens before the run's environment snapshot exists. General Bash
compatibility remains unsuitable: substitutions, compound control flow, and
subshell behaviour require execution models this runtime does not have.

## Decision

We admit this finite surface:

- `1>&2` alongside `2>&1`, and `2>`/`2>>` to a file, with descriptor bindings
  resolved left to right and earlier file creation and truncation effects
  preserved. File-bound diagnostics are held against the retained budget and
  published when the stage settles.
- `printf` with `%s`, `%%`, signed ASCII-decimal `%d`, the escapes `\n`, `\t`,
  `\r`, `\\`, and `\0`, Bash's missing-operand defaults, and format recycling.
- `exit [N]` as a run-terminating single-stage command. No operand uses the
  current status, and numeric values are reduced modulo 256.
- `$NAME` and `${NAME}` in command arguments for names matching
  `[A-Za-z_][A-Za-z0-9_]*`. Expansion reads the frozen run environment during
  execution. A quoted value remains one field; an unquoted value splits on fixed
  default-IFS whitespace and then undergoes pathname expansion; an unset name
  expands to empty.
- Newlines as statement separators, `#` comments to the end of a line, and
  backslash-newline line continuation outside single quotes.
- Here-documents (`<<`, `<<-`) and here-strings (`<<<`) on descriptor 0. A
  quoted delimiter keeps the body literal; an unquoted one admits the named
  parameters above and Bash's `\$`, `` \` ``, `\\`, and backslash-newline
  escapes. The body is one field: no splitting and no pathname expansion. Its
  bytes are reserved against the retained budget while the stage reads them.
- `! pipeline`, which inverts the pipeline status.
- `test` and `[` with POSIX argument-count dispatch, the file tests `-e`, `-f`,
  `-d`, `-s`, `-L`, `-h`, `-r`, `-w`, `-x`, the string tests `-n`, `-z`, `=`,
  `==`, `!=`, the integer comparisons, `!`, and parentheses around a whole
  expression. Each file test is one stat.
- `echo` with Bash's `-n`, `-e`, and `-E` option words and its `-e` escapes.
- `tail -n +N`, and `basename` and `dirname` with GNU options.
- `find`'s expression language: several starting points, name, path, and
  type tests, depth limits, `-prune`, `-print0`, and `!`, `-a`, `-o` with
  parentheses. Pruned and too-deep subtrees are skipped by resuming the scan.
- `grep` and `rg` `-o` and `-q`, each following its own binary around `-o`.
- `tee`, which holds its file bytes against the retained budget and publishes
  each file once, and `wc` in GNU's per-operand layout.
- A `sed` script language without hold space, branches, or file commands:
  `s`, `p`, `d`, `q`, `=`, `a`, `i`, `c`, and blocks over line, `$`, regex,
  and range addresses, with `-i` publishing each file once.

Expansion stays unresolved through parse and plan, so planning stays pure.
Generated fields and pathname matches share the 10,000-entry argv ceiling and the
run's retained-byte budget.

**Bash parity is the standing admission gate** for future shell syntax and
commands. Each admitted form must compare stdout bytes, stderr bytes, and exit
status against GNU Bash under declared controlled dimensions. An intentional
divergence must be an explicit refusal pinned by a local test; it must never be
hidden by weakening or normalizing the differential comparison. The evidence for
this admission is the [baseline](../../tests/shell/parity-bash.test.ts),
[ordered redirection](../../tests/shell/parity-bash-redirection.test.ts),
[`printf`](../../tests/shell/parity-bash-printf.test.ts),
[`exit`](../../tests/shell/parity-bash-exit.test.ts),
[named expansion](../../tests/shell/parity-bash-expansion.test.ts),
[script](../../tests/shell/parity-bash-scripts.test.ts),
[path](../../tests/shell/parity-bash-paths.test.ts), and
[sed](../../tests/shell/parity-bash-sed.test.ts) suites.

These forms remain rejected:

- Variable assignment, parameters in command names or file redirection targets,
  `${...}` operators, positional parameters, and special parameters.
- `printf` width and precision, `%b`, `%q`, `%c`, escapes outside the admitted
  set, and non-decimal numeric spellings.
- A here-document without its delimiter line. Bash warns and uses the rest of
  the input; this shell refuses rather than run a command with a body the
  caller may not have meant.
- `echo -e` `\u` and `\U` escapes, whose Bash output depends on the locale.
- `test` with more than four arguments outside parentheses, `-a`/`-o`
  precedence, `-nt`, `-ot`, `-ef`, `<`, `>`, and file tests with no meaning
  here (`-p`, `-S`, `-t`, and the like). Diagnostics from `test` and `[` omit
  Bash's `bash: line N:` prefix because the shell does not track script lines.
- `exit` in a multi-stage pipeline. Bash runs that command in a subshell; this
  shell has no subshell and rejects the form rather than silently changing its
  control effect.
- Command and process substitution, arithmetic, grouping and subshells, compound
  control flow, functions, and background jobs.

Each remains rejected because its execution model or finite-cost semantics has
not been admitted and witnessed — not because broad Bash incompatibility is a
goal.

## Consequences

- Common agent-authored diagnostics, formatted output, explicit termination,
  environment-derived arguments, multi-line scripts, here-document file writes,
  and `test` guards work without an external process runtime.
- Quote-sensitive expansion and ordered descriptor binding add executor state,
  but do not make planning environment- or filesystem-dependent.
- The surface is still intentionally incomplete. A caller receives an explicit
  error for unsupported syntax instead of an accidental literal or a silent Bash
  divergence.
- A future addition must satisfy both this parity gate and ADR-0018's bounded
  execution requirement.

## Alternatives considered

- **Keep rejecting all expansion.** Lost because named environment arguments are
  common and already fit the frozen, bounded run-input model.
- **Expand parameters during parsing or planning.** Lost because the run
  environment is unavailable there, and quote-sensitive splitting and globbing
  belong to execution.
- **Expand without field splitting or pathname expansion.** Lost because it
  creates a permanent silent divergence on ordinary unquoted Bash arguments.
- **Admit complete POSIX or Bash behaviour.** Lost because substitutions,
  subshells, and compound control flow have no bounded execution design here.
