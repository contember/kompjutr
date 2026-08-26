---
id: 55
title: Make shell redirections stage-local
blocked-by: []
---

# 55 — Make shell redirections stage-local

**Summary.** Silent correctness divergence. Redirections are parsed per command,
but stderr merging and stdout files do not participate in that command's
pipeline stream.

## Problem

`CommandContext.warn()` sends `2>&1` diagnostics directly to the final output
sink (`src/shell/exec/execute.ts:158-163`). A downstream stage therefore cannot
filter or bound them. For example, `cat no1 no2 2>&1 | head -1` prints both
diagnostics instead of one.

Stdout redirection has the mirror problem. `runPipeline()` records a file target
only when it belongs to the last pipeline command
(`src/shell/exec/execute.ts:118-124`). In `echo hi >out | cat`, the redirection is
silently ignored, `cat` receives `hi`, and `out` is not created.

The observed agent shape `command 2>&1 | tail -N` depends on stage-local stream
semantics, especially for injected process commands.

## Approach / acceptance

- Model stdout and stderr routing per planned command. `2>&1` must merge into
  that stage's stdout before the next stage consumes it.
- Apply `>` and `>>` at the command where they occur. A redirected stage sends
  no stdout to the following pipe unless another supported descriptor supplies
  it.
- Preserve stdout/stderr ordering for an injected command that alternates both
  streams. If the current `warn()` side channel cannot represent that order,
  change the command result contract rather than approximating it.
- Keep `2>/dev/null`, final-stage redirects, ambiguous redirect errors, exit
  status, and lazy downstream cancellation correct.
- Add differential Bash witnesses for intermediate overwrite/append redirects,
  `2>&1 | head`, `2>/dev/null | ...`, and a final redirected pipeline.

## Touch points

`src/shell/exec/context.ts`, `src/shell/exec/execute.ts`,
`src/shell/plan/types.ts`, `src/shell/plan/plan.ts`, `tests/shell/plan.test.ts`,
`tests/shell/shell.test.ts`, shell parity helpers

<!-- Origin: shell implementation audit, 2026-08-26. -->
