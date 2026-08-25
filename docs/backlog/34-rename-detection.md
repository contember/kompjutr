---
id: 34
title: Detect renames in status and diff
blocked-by: []
---

# 34 — Detect renames in status and diff

**Summary.** Tier S (silent divergence). Git detects renames by default in both
`status` and `diff`; kompjutr reports every rename as a delete plus an add.

## Problem

`DiffSummaryEntry.status` is `"A" | "M" | "D"` (`src/core/ops/kinds.ts`) and the
patch writer in `src/core/ops/diff.ts` emits `deleted file` / `new file` headers
with no `similarity index`, `rename from` or `rename to` lines. Status has no
`R` code. Because `diff.renames` and `status.renames` default to true in Git,
this is a divergence from Git's *default* output, not from an opt-in flag — any
consumer comparing porcelain output against real Git sees a mismatch on the
single most common refactoring operation.

The cost model is the reason it is missing: naive similarity detection is a
pairwise comparison over the whole change set.

## Approach / acceptance

- Start with exact-oid pairing: an added path and a deleted path sharing one blob
  oid is a 100% rename. This covers pure moves, needs no content reads, and stays
  inside a bounded map over the change set.
- Cap the candidate set explicitly and fall back to add/delete output — never a
  partial or truncated pairing — when the cap is exceeded.
- Emit `R` in status and `similarity index` / `rename from` / `rename to` in the
  patch; add a `renames` option and honour `diff.renames` / `status.renames`.
- Leave inexact (similarity-scored) detection out of this item; record the cost
  model for it if the exact pass proves insufficient.
- Real Git parity tests for pure move, move plus edit (which stays add/delete
  under exact-only detection), swap, move into a new directory, and the cap
  fallback.

## Touch points

`src/core/ops/diff.ts`, `src/core/ops/diff-internal.ts`, `src/core/ops/kinds.ts`,
`src/core/ops/status-rows.ts`, `tests/diff.test.ts`, `tests/status.test.ts`,
`docs/reference/git-support.md`
