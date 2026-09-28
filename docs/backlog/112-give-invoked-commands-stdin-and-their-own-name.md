---
id: 112
title: Give invoked commands stdin and their own diagnostic name
---

# 112 — Give invoked commands stdin and their own diagnostic name

**Summary.** The `invoke` seam labels a sub-command's diagnostics with the
caller's name and gives it no stdin. Tier B.

## Problem

- `find . -exec cat missing ';'` prints `find: missing: …`; GNU prints
  `cat: missing: …`. `xargs` and `env CMD` have the same defect, because the
  sub-context reuses the outer `warn` (`exec/command-context.ts`).
- `invoke` passes `stdin: null`, so `env CMD` is refused when the stage has
  stdin (`commands/system/env.ts`), and `command NAME ARGS` is refused.
- `ARGUMENT_COUNT_MAX` in `exec/arguments.ts` is not exported, so
  `commands/find/exec.ts` repeats the 10,000 value.

## Approach / acceptance

Let `InvokeOptions` carry stdin and bind `warn` to the invoked name. Admit
`env CMD` with stdin and `command NAME ARGS`. Parity cases for the three
diagnostics above.

## Touch points

`exec/context.ts`, `exec/command-context.ts`, `commands/{xargs.ts,find/,system/env.ts,lookup/type.ts}`.

<!-- Origin: sprint-2026-09-28-shell-surface-expansion run log (C5, C6). -->
