---
id: 57
title: Bound retained memory across shell pipelines
blocked-by: [./49-set-based-copy.md, ./56-fail-closed-shell-path-expansion.md]
---

# 57 — Bound retained memory across shell pipelines

**Summary.** Safety gap. The final stdout and filesystem-call counts are bounded,
but several intermediate streams can allocate independently of both limits.

## Problem

`maxOutputBytes` is enforced only when the final stream reaches `Sink`. It does
not bound data retained before that point. Known materialization sites include:

- all input and every parsed item/group in `xargs`
  (`src/shell/commands/xargs.ts:69-95`);
- all decoded lines and sorted output in `sort`
  (`src/shell/commands/text.ts:86-101`);
- every output chunk plus the complete existing file for `>` / `>>`
  (`src/shell/exec/execute.ts:248-256`);
- every named file in a multi-file `cat` before the first byte is yielded
  (`src/shell/commands/read.ts:31-48`);
- an exponentially growing range in `head` or `tail` when one line spans most
  of a large file (`src/shell/commands/read.ts:247-303`);
- the unbounded stderr chunk array in the executor.

A small final result such as `sort huge | head -1` can therefore retain the
complete upstream input. One filesystem call can also assemble much more than
the per-statement `readBudget`, so `maxOperations` is not a memory model.

## Approach / acceptance

- Define one explicit retained-byte budget for shell-owned state, with a stable
  fail-closed error. Every materializing stage reserves against it before
  allocating; stdout truncation remains a separate result behavior.
- Bound stderr as well as stdout. Decide and document whether their public caps
  are separate or share one output allowance.
- Make blocking stages such as `sort` and the non-fused `xargs` path either stay
  within the budget or fail before crossing it. Do not silently truncate their
  semantic input.
- Stream or page file redirects without retaining old and new complete content
  together. A limit failure must not leave a partial destination mutation.
- Keep long single lines bounded in `head`, `tail`, `grep`, `sed`, and `uniq`;
  line-oriented code needs a byte cap in addition to a line-count cap.
- Add modeled retained-memory tests for every named site and a combined pipeline
  witness below the project's 100 MiB operation ceiling.
- Split this item into independent implementation work units before scheduling;
  it intentionally records the complete shell memory boundary.

## Touch points

`src/shell/exec/bytes.ts`, `src/shell/exec/context.ts`,
`src/shell/exec/execute.ts`, `src/shell/commands/read.ts`,
`src/shell/commands/text.ts`, `src/shell/commands/xargs.ts`, filesystem ranged
write primitives, `tests/shell/bounds.test.ts`, `tests/shell/cost.test.ts`

<!-- Origin: shell implementation audit, 2026-08-26. -->
