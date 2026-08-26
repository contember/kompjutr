---
id: 54
title: Execute shell AND-OR lists correctly
blocked-by: []
---

# 54 — Execute shell AND-OR lists correctly

**Summary.** Silent correctness divergence. The parser accepts Bash-shaped
`&&`, `||`, and `;` lists, but the executor stops the complete script where it
should skip only one pipeline.

## Problem

`execute()` runs one planned pipeline and then breaks out of the complete step
loop when an `&&` condition fails or an `||` condition succeeds
(`src/shell/exec/execute.ts:51-67`). That is sufficient for the two-command
`cd dir && command` shape, but it is not AND-OR list evaluation.

Current examples:

- `false && echo no || echo yes` prints nothing and exits 1 instead of printing
  `yes` and exiting 0.
- `false && echo no; echo final` never reaches `echo final`.
- `true || echo no; echo final` never reaches `echo final`.

The input is accepted and produces a plausible result, so this is worse than an
explicitly unsupported construct.

## Approach / acceptance

- Evaluate the flat list left to right. A connector decides whether the next
  pipeline runs; it does not terminate every later semicolon-separated list.
- Preserve the status of the last pipeline that actually ran.
- State-changing commands such as `cd` must affect the session only when their
  pipeline is selected.
- Add differential witnesses against real Bash for the three examples above,
  longer mixed lists, pipeline statuses on either side, and trailing `;`.
- Keep compound commands, grouping, `set -e`, and `pipefail` out of scope. The
  parser must continue rejecting syntax outside its typed AST.

## Touch points

`src/shell/exec/execute.ts`, `src/shell/plan/types.ts`,
`tests/shell/shell.test.ts`, `tests/shell/session.test.ts`, shell parity helpers

<!-- Origin: shell implementation audit, 2026-08-26. -->
