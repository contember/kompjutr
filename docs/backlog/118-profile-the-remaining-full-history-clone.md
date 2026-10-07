---
id: 118
title: Attribute the remaining full-history clone time
blocked-by: []
---

# 118 — Attribute the remaining full-history clone time

**Summary.** After the 2026-10-07 sprint the Next.js full-history `blob:none`
clone takes 197.0 s (from 428.8 s). Nothing yet says where those 197 s go, so
the next optimization, including any native or Rust/Wasm work, has no basis.
Effort: M to attribute.

## Problem

The sprint's closure measurement records only the totals: 197.0 s,
6,414 statements and 537,989 rows returned. The 2026-10-06 phase and CPU
breakdown in the proposal (`docs/ideas/full-history-import-performance.md`
at `a438a1b`, deleted when the sprint shipped) predates the sprint, and its harness scripts no longer exist.

Candidates the sprint recorded but did not measure:

- The connectivity commit branch plans `SCAN` over all of `git_commits` for
  each hop and root page (at HEAD before and after the sprint).
- The proposal's §6 duplicate work: commit rehash in `PackCommitIndex`, delta
  header re-inflation, chunk-pool churn, initial-checkout window replanning,
  materialized large-object streams, and DO writer copies.
- Temp B-tree memory of the set-based connectivity query on 30,347 commits.
- Native `node:crypto` SHA-1, which a 2026-10-06 workerd probe measured as
  4–5× faster than the TypeScript hasher on inputs of 4 KiB and more.

## Approach / acceptance

Rebuild a phase-marked, leased CPU profile of the full-history clone in fresh
persistence. Report phase wall time, statements, rows returned and native rows
read, plus CPU self time by stack. Then file one item per region that the
profile ranks, and decide on native or Wasm work from that ranking.

## Touch points

A diagnostic harness under `bench/` or a scratch directory; no product code.

<!-- Origin: sprint-2026-10-07-full-history-performance closure re-profile. -->
