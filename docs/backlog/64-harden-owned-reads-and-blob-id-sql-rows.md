---
id: 64
title: Harden owned reads and blob-id SQL rows
blocked-by: []
---

# 64 — Harden owned reads and blob-id SQL rows

**Summary.** Reject invalid internal ownership topology earlier and strengthen
blob-id SQL row validation and allocation-order witnesses.

## Problem

`PackReadOwnership` proves repository provenance but not that operation and output
scopes share one ownership root. A same-repository caller using separate roots can
therefore fail later with a generic transfer error; no current internal caller has
that shape. Blob-id lookup and comparison also lack complete result-row
pre-admission, canonical/duplicate-row validation and exact cursor-order evidence.
These are internal hardening gaps, not supported-surface regressions.

## Approach / acceptance

Preflight a shared ownership root before SQL or allocation. Pre-admit bounded
blob-id result rows, validate returned identities against the requested page and
reject malformed, unexpected or duplicate rows before mutating results. Add exact
and first-excess witnesses that prove cursor cleanup and an idle coordinator.

## Touch points

`src/memory.ts`, `src/sqlite/packs.ts`, `src/sqlite/store.ts`,
`tests/memory.test.ts`, `tests/pack.test.ts`, `tests/store.test.ts`.

<!-- Origin: ../sprints/sprint-2026-08-29-budget-targets-and-store-split.md WU6g -->
