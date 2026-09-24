---
id: 97
title: Bound Git output for pipe and redirect sinks by the shell's retained budget
blocked-by: []
---

# 97 — Bound Git output for pipe and redirect sinks by the shell's retained budget

**Summary.** When a Git command's stdout goes to a pipe or a redirect, the DO
shell lets the Git CLI build up to 16 MiB of output before the shell's own
retained-bytes check rejects it. A smaller configured retained budget does not
lower that allocation.

## Problem

Since `2ec772e` (the WU18 follow-up), pipe and redirect bytes are semantic
input and are never truncated. `destinationLimit`
(`packages/do/src/shell/exec/command-context.ts:87-100`) returns
`Number.MAX_SAFE_INTEGER` for them, and the Git adapter clamps that to the Git
CLI's intrinsic ceiling, `GIT_CLI_MAX_COMBINED_OUTPUT_BYTES` = 16 MiB
(`packages/do/src/git-shell.ts:94-105`,
`packages/git/src/cli/types.ts:4`). The Git CLI therefore accumulates up to
16 MiB of output. Only afterwards does the shell reserve it against
`env.fs.retained` and fail the run with exit 2, leaving a redirect target
unchanged; the mutation persists.

The shell's retained budget defaults to 16 MiB
(`packages/do/src/shell/exec/context.ts:39`) but is configurable through
`Limits.maxRetainedBytes`, and other intermediates share it. With a 1 MiB
budget, a Git command piped into another command still builds 16 MiB before
failing. Terminal sinks are not affected: they already clamp to
`env.fs.retained.available`.

## Approach / acceptance

Pass pipe and redirect sinks a Git output limit of the retained bytes still
available, not the intrinsic ceiling. When Git reaches it, a mutating command
must keep its committed mutation and the run must fail exactly as it does today
— exit 2, redirect target unchanged — never with truncated semantic bytes.
A read must fail the same way it does today; `shellLimit` in `git-shell.ts`
already maps the CLI's output `E2BIG` to a shell output limit.

Witness: in `tests/shell/bounds.test.ts`, a run with `maxRetainedBytes` of
1 MiB pipes and redirects a mutating and a reading Git command whose output
exceeds 1 MiB. Assert the existing outcomes (exit 2, unchanged redirect target,
persisted mutation) and that the Git CLI never held more than the budget, for
example through the CLI's reported output size or a counting sink.

## Touch points

`packages/do/src/shell/exec/command-context.ts`, `packages/do/src/git-shell.ts`,
`packages/git/src/cli/result.ts`, `tests/shell/bounds.test.ts`,
`docs/reference/shell.md`.

<!-- Origin: sprint-2026-09-23 simplification, WU18 follow-up (`2ec772e`) run-log entry. -->
