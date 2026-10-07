---
id: 121
title: Prune the parent closure walk in incremental fetch connectivity
blocked-by: []
---

# 121 — Prune the parent closure walk in incremental fetch connectivity

**Summary.** A one-commit incremental fetch on full-history Next.js takes 3.2 s.
Most of it walks the parent's whole root-tree closure, about 31k rows. Effort: S–M.

## Problem

`ExternalReferenceCheck` (`store/pack/ingest/ingest-references-external.ts`)
proves that an external tree lies in a proven commit's closure. It does this
by walking that closure until every pending tree is seen. A new commit's
unchanged subtrees are all external, so the walk usually covers the parent's
whole tree.

## Approach / acceptance

Diff the new commit's root tree against the proven parent's root tree, and
walk only the paths where they differ. A subtree that is equal at the same path
is proven without visiting it. Keep the full walk for external trees outside
that diff.

Witness: the WU3 incremental fetch measurement drops well below 1 s. Every
case in `tests/fetch-pack-connectivity-incremental.test.ts` passes, and its
cost row falls.

## Touch points

`store/pack/ingest/ingest-references-external.ts`, its tests, and the
`fetch.reachability-*` rows in `bench/statements.ts`.

<!-- Origin: sprint-2026-10-07-fast-fresh-clone WU3 run log. -->
