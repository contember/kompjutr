---
id: 0027
title: Widen the shell to compound syntax and text tools
status: accepted
date: 2026-09-28
---

# 0027 — Widen the shell to compound syntax and text tools

## Context

[ADR-0019](0019-admit-a-bounded-posix-shell-surface.md) admitted a finite
surface and kept substitution, compound control flow, and assignment rejected
until each had a bounded execution design. A probe of common agent command
lines found three kinds of gap:

- Silent or misleading word handling: `~` stayed literal with status 0, a bare
  `{}` failed as a command group (breaking `xargs -I{}`), and `&>` failed as
  background execution.
- Rejected syntax that agents write constantly: `$( … )`, `for … in`, `if`,
  `( cd x && … )`, `NAME=value cmd`, `$?`.
- Missing tools: `cut`, `tr`, `sort -k`, `ln`, `chmod`, `du`, `tree`, `patch`,
  `jq`, `awk`, `find -exec`, and others.

The parity gate compares against the binaries on the test host. That host
ships uutils coreutils 0.2.2, mawk 1.3.4, jq 1.8.1, and GNU patch 2.8.

## Decision

We widen the admitted surface. Each form stays under ADR-0019's parity gate and
ADR-0018's bounded execution:

- Words: `~` and `~/…` expand from the run's `HOME`; `~user` is refused. A bare
  `{}`, `{`, or `}` that is not a group delimiter is an ordinary word. Brace
  expansion (`{a,b}`, `{1..3}`) generates fields under the argv ceiling.
  `&>` and `&>>` bind stdout and stderr to one file.
- Compound commands: `( … )` runs with its own cwd and environment copy;
  `{ …; }` groups with shared redirections; `if/elif/else/fi`; and
  `for NAME in WORDS; do … done`. `while`, `until`, `case`, and functions stay
  rejected: only `for … in` has a structural bound, the expanded word list.
  Nested loops multiply that bound, so all iterations of one run share a
  budget equal to the argv ceiling (10,000), and nesting stops at 64 levels,
  the depth that keeps the recursive executor off the JavaScript stack limit.
- Every stage of a multi-stage pipeline runs as a subshell copy, as in Bash:
  a `cd` or assignment inside a stage does not reach the caller.
- `$?`, `set -e`, and `set -o pipefail`.
- Command substitution `$( … )` and backquotes. The inner output is retained
  against `maxRetainedBytes` and shares the run's operation budget.
- `NAME=value`, `NAME=value cmd`, `export`, and `unset`, over a per-run
  environment copied from the frozen snapshot.
- New commands and options, each listed in
  [the shell reference](../reference/shell.md).
- Interpreters without unbounded loops: `awk` has no `while`, `do`, or C-style
  `for`; `jq` has no `while`, `until`, or unbounded `range`/`repeat`.
- `sleep` waits for real, capped so one run stays inside one request. `date`
  reads `ShellOptions.now`. `mktemp` names come from `crypto.getRandomValues`.
- **The parity reference is the installed toolchain.** Tests compare against
  whatever `bash` finds on PATH; for coreutils that is uutils, for `awk` mawk.
- Two divergences are deliberate. `jq` regexes run on a linear-time VM, so
  where Oniguruma gives up at its retry limit, `jq` here returns the real
  result. `awk`'s `for (k in a)` visits keys in insertion order, not mawk's
  hash order; scripts that depend on hash order are already unportable.
- **Clean room for GPL tools.** Implementations of GNU tools (bash, coreutils,
  patch, diffutils) and of mawk come only from observable behaviour, manuals,
  and our own tests, never from their sources. MIT-licensed code (uutils, jq)
  may be adapted and is credited in `LICENSE`.

## Consequences

- The shell accepts most single-shot agent scripts without a rewrite.
- Executor state grows: a mutable per-run environment, a subshell cwd, and the
  last status now travel through execution. Planning stays pure.
- Parity pins uutils and mawk output. Moving the test host to GNU coreutils or
  gawk can move expectations; the fix is to re-pin, not to normalize.
- Interpreter CPU is bounded by input size and program shape, not by a step
  count or a deadline; [backlog 111](../backlog/111-bound-interpreter-cpu-and-regex-backtracking.md)
  holds the open decision.
- Evidence: the parity suites under `tests/shell/` named `parity-bash-words`,
  `parity-bash-compound`, `parity-bash-substitution`, `parity-columns-*`,
  `parity-options-*`, `parity-links`, `parity-tree`, `parity-system`,
  `parity-find`, `parity-bash-diff-recursive`, `parity-patch`, `parity-jq*`,
  and `parity-awk*`, with their local companions for refusals and cost.

## Alternatives considered

- **Keep ADR-0019's boundary.** Lost: the rejected forms are the most common
  failures in the agent probe, and each now has a bounded design.
- **Admit `while` with a step budget.** Lost: a step count is an invented
  currency (ADR-0005) unless it names a real failure; `for … in` covers the
  common case without one.
- **Compare against GNU coreutils through a PATH shim.** Lost: the user chose
  the installed toolchain as the reference.
