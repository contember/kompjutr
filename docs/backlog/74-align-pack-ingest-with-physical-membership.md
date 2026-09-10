---
id: 74
title: Align pack ingest with physical membership and cold reads
blocked-by: []
---

# 74 — Align pack ingest with physical membership and cold reads

**Summary.** Accept repeated tree occurrences and establish cold-read
admissibility before publication. These inputs need not be malformed Git data.

Physical OFS base lookup is resolved by the
[lifecycle/network sprint](../archive/sprint-2026-09-08-lifecycle-and-network-integrity.md#wu4-frozen-physical-offset-step).

## Problem and evidence

- Every physical occurrence of a nonempty tree starts projection ordinals again,
  but its source key identifies the OID and pack, not offset. Duplicate tree
  entries collide on `(source_key, ordinal)`. The review reproduced rejection of
  a duplicate-tree pack that native `git index-pack` accepted; the mechanism was
  independently checked.
- Ingest and cold reads disagree on delta admissibility: reads add a modeled
  256-byte charge absent from ingest, and immediate resolution does not establish
  the reader's depth limit. The size mismatch is statically proven. An existing
  reduced-depth test demonstrates successful ingest followed by cold-read
  refusal; production-depth publication was not runtime-tested.

## Approach / acceptance

- Deduplicate tree projection work by exact source while preserving every physical
  membership entry. Cover full/delta occurrences within and across flushes.
- Add real-Git pack parity for repeated tree occurrences within one physical pack.
- Establish one real delta-size/depth contract at ingest and read. Remove the
  modeled wrapper discrepancy rather than introducing another byte ledger.
- Every accepted fixture remains readable after cache eviction and cold reopen;
  rejected input must not publish refs or visible incomplete projections.

## Touch points

- `packages/git/src/store/pack/ingest/ingest-pending.ts`, `ingest-index.ts`,
  `ingest-inflate.ts`, `ingest-projection.ts`, `ingest-reader.ts`.
- `packages/git/src/store/pack/pack-ingest-index.ts`, `shared-delta.ts`.
- `packages/git/src/store/trees/tree-index-batch.ts`.
- `tests/pack.test.ts`, `tests/tree-index-stream.test.ts`.
