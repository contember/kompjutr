---
id: 56
title: Fail closed on shell path-expansion limits
blocked-by: []
---

# 56 — Fail closed on shell path-expansion limits

**Summary.** Structural-limit violation. Shell glob expansion and the fast
`find -name` path silently truncate bounded result sets.

## Problem

Argument glob expansion calls `fs.glob(..., { limit: 10_000 })` and treats the
returned array as complete (`src/shell/exec/execute.ts:215-237`). A fixture with
10,001 matching files makes `echo *.txt | wc -w` report 10,000 with exit 0. The
caller cannot distinguish that answer from a complete result.

The indexed `find -name` path similarly materializes at most 100,000 paths in
one `fs.glob()` result and then returns
(`src/shell/commands/list.ts:153-162`). It both truncates and prevents a
downstream `head` from stopping the query before the full array is allocated.

The long-pattern fallback pages `scan()`, but retains every match before command
execution and has no path-count or retained-byte ceiling. These behaviors
violate the project's rule to fail closed at a structural limit and never
truncate silently.

## Approach / acceptance

- Give glob discovery a paged or cap-plus-one contract that can prove whether a
  result is complete. Do not infer completeness from a full page.
- Argument expansion may retain a bounded argv. When its path-count or path-byte
  cap is exceeded, fail with a stable `E2BIG`-shaped shell error before invoking
  the command.
- Stream `find -name` discovery in path order so a downstream limiter stops
  further pages. An unbounded consumer either reaches the real end or fails at
  an explicit operation/output ceiling; it never stops at an invisible row cap.
- The SQLite GLOB narrowing and the scan fallback must produce the same answer
  and the same overflow behavior, including Unicode paths and patterns above the
  platform's 50-byte GLOB limit.
- Add a 10,001-match argument-expansion witness, a `find` fixture beyond its old
  100,000-row cap, a long-pattern fallback witness, and operation-count checks
  with and without `| head`.

## Touch points

`src/fs/types.ts`, `src/fs/filesystem.ts`, `src/fs/store/scan.ts`,
`src/shell/exec/context.ts`, `src/shell/exec/execute.ts`,
`src/shell/commands/list.ts`, `tests/fs/scan.test.ts`, `tests/shell/bounds.test.ts`,
`tests/shell/cost.test.ts`

<!-- Origin: shell implementation audit, 2026-08-26. -->
