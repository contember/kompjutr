---
id: 96
title: Memoize intermediate delta-chain entries during one packed read
blocked-by: []
---

# 96 — Memoize intermediate delta-chain entries during one packed read

**Summary.** With the object cache off or too small, reading every entry of one
long delta chain costs a quadratic number of delta applications. At the
4,095-depth cap that is about 8 million applications for one batch.

## Problem

`#readObjects` in `packages/git/src/store/pack/read/read-resolver.ts:176-387`
resolves each wanted OID separately. For each one it walks the chain towards a
base until it finds a resolved object in `result` or in the object cache
(`:333-360`), then applies every delta back up the chain (`:363-380`). An
intermediate object it builds goes only to the object cache (`:379`), never to
`result` or a local memo; `result` holds only the wanted OIDs (`:384`).

When the cache does not retain the intermediates — `objectCacheBytes: 0`,
objects above the cache's per-entry limit
(`packages/git/src/store/pack/read/read-data.ts:89-93`), or eviction under a
small cache — a batch that wants every entry of an N-long chain, requested tip
first, rebuilds the chain from its base for every entry: N(N+1)/2
applications. The batch readers (`packages/git/src/store/pack/read.ts:146-168`
and pending-delta resolution in `ingest/ingest-pending.ts:362-365`) all go
through this path. At N = 4,096
(depth 4,095, `MAX_DELTA_DEPTH` in `packages/git/src/store/pack/shared.ts:42`)
that is ~8.4 million, against 4,096 with a memo. Requested base first, the
wanted results already in `result` short-circuit the walk, so order decides the
cost.

Found in the simplification sprint's WU13 review; pre-existing, not a
regression. No production workload is known to request a whole deep chain with
the cache off.

## Approach / acceptance

Keep a per-batch memo of intermediate objects the batch resolves and consult
it in the chain walk before the object cache. Do not retain intermediates
beyond the batch. The memo holds real payload bytes, so decide and state its
bound: at most the chain being resolved, or only the entries a later wanted
OID in the same batch depends on.

Witness: a store test with one 4,096-entry chain read tip first with the object
cache off, counting delta applications (or `inflate` calls) and asserting a
linear count; the same objects and bytes as today; no statement change in
`bench:statements`.

## Touch points

`packages/git/src/store/pack/read/read-resolver.ts`, `tests/pack*.test.ts`.

<!-- Origin: sprint-2026-09-23 simplification, WU13 review run-log entry. -->
