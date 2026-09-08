---
id: 67
title: Own buffers across public Git object boundaries
blocked-by: []
---

# 67 — Own buffers across public Git object boundaries

**Summary.** High-priority correctness fix: reusing a caller buffer must not
change the content returned for an immutable Git OID.

## Problem and evidence

Scalar object writes cache the caller's `Uint8Array`. Cached reads return the
same mutable bytes, including through public `catFile()`. The batch writer
already copies its input, so the scalar and batch paths disagree.

The 2026-09-07/08 architecture review reproduced this through public APIs:
write `abc`, mutate the input after completion, then read `xbc` under the same
OID. Mutating the returned bytes changed the next read to `xyc`. Clearing caches
restored the stored content. No direct SQL mutation was involved. There is no
public borrowed-buffer contract authorizing these changes to stored objects.

## Approach / acceptance

- Establish buffer ownership at write and public read boundaries. Internal
  zero-copy paths may remain only where ownership is explicit.
- Add public `hashObject({ write: true })` and `catFile()` witnesses for input
  reuse and returned-buffer mutation after the operation completes.
- Cover warm/cold reads, loose/packed sources, batches, and stream-backed writes.
  Later reads must return the original bytes and OID after reopen as well.
- Preserve trusted ordinary reads; do not add rehashing of stored content to
  compensate for aliasing.

## Touch points

- `packages/git/src/store/objects/objects-write.ts` — scalar cache insertion.
- `packages/git/src/store/objects/objects.ts` — cached and cold read ownership.
- `packages/git/src/store/objects/objects-batch.ts` — existing input-copy twin.
- `packages/git/src/client-plumbing.ts` — public result boundary.
- `tests/plumbing-write.test.ts`, `tests/reads.test.ts`, `tests/pack.test.ts`.
