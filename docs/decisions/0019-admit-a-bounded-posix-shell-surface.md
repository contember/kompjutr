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

Named parameter expansion was the consequential boundary change. Supporting it
partially, or at parse time, would lose Bash's quote-sensitive field behaviour,
and planning happens before the run's environment snapshot exists. General Bash
compatibility remains unsuitable: substitutions, compound control flow, and
subshell behaviour require execution models this runtime does not have.

## Decision

We admit this finite surface:

- `1>&2` alongside `2>&1`, with descriptor bindings resolved left to right and
  earlier file creation and truncation effects preserved.
- `printf` with `%s`, `%%`, signed ASCII-decimal `%d`, the escapes `\n`, `\t`,
  `\r`, `\\`, and `\0`, Bash's missing-operand defaults, and format recycling.
- `exit [N]` as a run-terminating single-stage command. No operand uses the
  current status, and numeric values are reduced modulo 256.
- `$NAME` and `${NAME}` in command arguments for names matching
  `[A-Za-z_][A-Za-z0-9_]*`. Expansion reads the frozen run environment during
  execution. A quoted value remains one field; an unquoted value splits on fixed
  default-IFS whitespace and then undergoes pathname expansion; an unset name
  expands to empty.

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
[`exit`](../../tests/shell/parity-bash-exit.test.ts), and
[named expansion](../../tests/shell/parity-bash-expansion.test.ts) suites.

These forms remain rejected:

- Variable assignment, parameters in command names or redirection targets,
  `${...}` operators, positional parameters, and special parameters.
- `printf` width and precision, `%b`, `%q`, `%c`, escapes outside the admitted
  set, and non-decimal numeric spellings.
- `exit` in a multi-stage pipeline. Bash runs that command in a subshell; this
  shell has no subshell and rejects the form rather than silently changing its
  control effect.
- Command and process substitution, arithmetic, grouping and subshells, compound
  control flow, functions, here-documents, and background jobs.

Each remains rejected because its execution model or finite-cost semantics has
not been admitted and witnessed — not because broad Bash incompatibility is a
goal.

## Consequences

- Common agent-authored diagnostics, formatted output, explicit termination, and
  environment-derived arguments work without an external process runtime.
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
