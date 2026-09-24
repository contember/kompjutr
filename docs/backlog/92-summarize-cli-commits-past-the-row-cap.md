---
id: 92
title: Summarize a CLI commit that changes more than 50,000 files
blocked-by: []
---

# 92 — Summarize a CLI commit that changes more than 50,000 files

**Summary.** `git commit` through the CLI runner fails with `E2BIG` and rolls
the commit back when it changes more than 50,000 files. The typed `commit`
accepts the same change, and Git succeeds. Parity tier B: loud, and only above
50,000 changed paths.

## Problem

The CLI commit summary materializes the whole diff summary before it prints:
`summarizeCommit` calls `diffSummaryBounded` with
`maxRows: SUMMARY_MAX_ROWS = 50_000` and `maxRetainedBytes: DIFF_REPOSITORY_BYTES`
(`packages/git/src/cli/write/write-summary.ts:16,88-94`). Row 50,001 throws
`E2BIG` (`packages/git/src/ops/diff/diff-summary.ts:43-45`). The summary is
formatted inside the mutation guard (`runMutation`,
`packages/git/src/cli/write/write-runtime.ts:30`), so the refusal rolls back the
commit it was describing. The typed `commit` does not format a summary and
succeeds. A root commit takes `summarizeRoot`, which has no row cap.

The rows are retained only to find rename endpoints: `summaryFromDiffRows`
collects the renamed paths, then streams every other path from
`walkTreeDiff` into bounded output. Git does not retain an unbounded rename
candidate set either: past `diff.renameLimit` it skips inexact rename detection,
warns, and still prints the summary.

The simplification sprint's WU18 made mutating CLI output commit first and
truncate at terminal sinks, but this refusal happens before any output exists.

## Approach / acceptance

Stream the summary instead of materializing it. Run rename detection only when
the candidate count is within a rename limit that matches Git's default and
reported behaviour; past it, report adds and deletes and emit Git's warning.
Remove the 50,000-row materialization cap from this path; the output keeps its
existing terminal truncation.

Witness: a CLI commit that changes 50,001 files succeeds, persists, and matches
`git commit`'s exit status, first line, and shortstat line; a commit with a
rename below the limit still prints the rename line; the existing
`tests/git-cli-write.test.ts` summary cases stay green.

## Touch points

`packages/git/src/cli/write/write-summary.ts`,
`packages/git/src/ops/diff/diff-summary.ts`, `packages/git/src/ops/diff/`
rename detection, `tests/git-cli-write.test.ts`. Retiring the modeled
`maxRetainedBytes` charge on the same call is
[backlog 66](66-retire-modeled-retained-byte-charges.md).

<!-- Origin: sprint-2026-09-23 simplification, WU18 review run-log entry. -->
