---
id: 74
title: Align pack ingest with cold reads
blocked-by: []
---

# 74 — Align pack ingest with cold reads

**Summary.** Establish cold-read admissibility before publication. These inputs
need not be malformed Git data.

Physical OFS base lookup is resolved by the
[lifecycle/network sprint](../archive/sprint-2026-09-08-lifecycle-and-network-integrity.md#wu4-frozen-physical-offset-step).

## Problem and evidence

- Ingest and cold reads disagree on delta admissibility: reads add a modeled
  256-byte charge absent from ingest, and immediate resolution does not establish
  the reader's depth limit. The size mismatch is statically proven. An existing
  reduced-depth test demonstrates successful ingest followed by cold-read
  refusal; production-depth publication was not runtime-tested.

## Approach / acceptance

- Establish one real delta-size/depth contract at ingest and read. Remove the
  modeled wrapper discrepancy rather than introducing another byte ledger.
- Validate the effective canonical graph, including previously published
  dependents affected when a loose terminal gains a packed source. Physical
  pack depth alone does not establish cold-read depth or exclude canonical cycles.
- Every accepted fixture remains readable after cache eviction and cold reopen;
  rejected input must not publish refs or visible incomplete projections.

## Touch points

- `packages/git/src/store/pack/ingest/`, `shared-delta.ts`, `read/`, `lifecycle/`.
- `tests/pack.test.ts`, `tests/pack-cold-admission.test.ts` (planned).
