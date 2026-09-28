---
id: 111
title: Bound interpreter CPU and regex backtracking in the shell
---

# 111 — Bound interpreter CPU and regex backtracking in the shell

**Summary.** Finite shell programs can still hold a Worker's CPU for minutes;
decide the bound that names that failure. Cost, needs a decision.

## Problem

ADR-0027 bounds loops structurally, but some finite work is still large:

- `jq`: `reduce range(1e7) as $i (0; .+1)` takes 14 s (jq: 2.1 s), so
  `range(1e9)` would take about 23 minutes. `[range(20000)] as $a | $a - $a`
  is quadratic (17.5 s).
- `awk`: 26 functions that each call the previous twice run 2^25 calls in
  16 s with no input; nested `for (k in a)` over a 60,000-element `split` is
  3.6e9 iterations.
- `grep`, `rg`, `sed`, and `find` still match with JavaScript `RegExp`, which
  backtracks without limit. `jq` and `awk` moved to linear-time matchers in the
  2026-09-28 shell sprint; check the others with `(a*)*b` on 40 `a`s.

The real failure is the isolate's CPU-time limit. ADR-0005 admits a cap only
when it names that failure.

## Approach / acceptance

Decide between a run-wide evaluation-step budget (charged by the interpreters
and the loop runner, one constant, named after the CPU limit) and a wall-clock
deadline checked at yield points. Put regex matching for every command on a
linear-time engine or refuse nested unbounded quantifiers. Acceptance: each
input above fails with exit 2 and a named limit, or finishes in bounded time.

## Touch points

`packages/do/src/shell/commands/{jq,awk,search,sed,find}/`, `exec/arguments.ts`
(the loop budget), ADR-0027.

<!-- Origin: sprint-2026-09-28-shell-surface-expansion run log (jq and awk reviews). -->
