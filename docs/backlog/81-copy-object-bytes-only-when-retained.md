---
id: 81
title: Copy object bytes only when a cache actually retains them
blocked-by: []
---

# 81 — Copy object bytes only when a cache actually retains them

**Summary.** Ownership copies at the object boundaries run unconditionally, so
the two copies that make an OID immutable are pure waste whenever the byte-
budgeted cache refuses the entry. Effort S–M, cost only — correctness is settled.

## Problem

`ByteLru.set()` drops any entry larger than a quarter of its budget
(`packages/git/src/common/lru.ts:50`); with the 8 MiB default object cache that
is everything over 2 MiB. Two sites copy before that decision is known:

- `packages/git/src/store/objects/objects-write.ts` copies `data` as an argument
  to `objects.set()`, which then discards it. A 10 MiB scalar write allocates
  10 MiB of immediate garbage.
- `packages/git/src/client-plumbing.ts` copies every `catFile()` result. For an
  object the cache refused, the store's buffer was already unaliased, so the copy
  is provably unnecessary — and `MAX_OBJECT_BYTES` is 48 MiB, so `catFile` of a
  large blob now peaks near 96 MiB against ADR-0005's <100 MiB per-operation
  target.

The boundary cannot tell a retained buffer from a fresh one, because a cold read
also caches the instance it returns (`objects.ts:293`, `pack/read/read-resolver.ts:385,441`).
Copying always is therefore the correct rule today, not an oversight —
[ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md) and
the ownership rule from `sprint-2026-09-08-public-api-correctness` stand.

## Approach / acceptance

Move ownership into the cache: let the insertion decide, so a copy happens only
when the entry is retained, and let a read report whether the buffer it returns
is cache-aliased. Then the public boundary copies only what it must.

- Measure first, in `bench/` — peak bytes for `catFile` of a large blob and for a
  scalar write above the entry limit, before and after. A cost item without a
  measurement is not done.
- No public caller may observe a buffer the store still owns; the existing
  ownership witnesses must keep passing unchanged.

## Touch points

- `packages/git/src/common/lru.ts`, `packages/git/src/store/objects/objects.ts`,
  `objects-write.ts`, `packages/git/src/client-plumbing.ts`.
- `bench/` peak-memory scenario; `tests/client.test.ts` ownership witnesses.

<!-- Origin: independent review of WU2 in ../archive/sprint-2026-09-08-public-api-correctness.md. -->
