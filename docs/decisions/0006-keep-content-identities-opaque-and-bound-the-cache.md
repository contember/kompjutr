---
id: 0006
title: Keep content identities opaque and bound the Git blob cache
status: accepted
date: 2026-08-26
---

# 0006 — Keep content identities opaque and bound the Git blob cache

## Context

The filesystem exposes `contentId` as an opaque writer-minted identity. Git uses
`git_blob_ids` to map that identity to a blob OID and avoid reading unchanged
file bodies. Checkout normally writes the blob OID bytes as the identity, but
imports and external filesystem users may choose a different representation.
Treating every identity as a Git OID would therefore couple the filesystem layer
to Git and make the existing public boundary false.

The mapping is only a cache: every consumer can recover from a miss by hashing
the authoritative file bytes. Before schema v12, however, its rows had no bound
or eviction lifecycle. Long-lived repositories could retain identities for
files that had been overwritten or removed, and caller-sized batches could
amplify retained memory.

## Decision

We will keep filesystem content identities opaque and keep `git_blob_ids` as a
disposable per-repository cache. Git must never infer an object ID from the
identity bytes.

Each repository retains at most 65,536 mappings. A cacheable identity is at most
256 bytes, which bounds stored identity payload at 16 MiB. Lookups and updates
run in bounded pages. Writers publish each
bounded page as one generation and transactionally evict older generations. If
an update contains more mappings than the cache can retain, its newest pages
survive. Oversized identities and evicted mappings are cache misses; the caller
hashes the file bytes and produces the same Git-visible result.

## Consequences

- The filesystem remains Git-agnostic and external writers may retain their own
  stable identity format.
- Cache storage and update memory have explicit structural limits.
- Current mappings normally retain the zero-body-read fast path, while older or
  oversized identities may require a file read and hash.
- Eviction may affect performance but cannot affect correctness.
- Every new mapping writer must use the shared generational update path; direct
  unbounded writes are outside the storage contract.

## Alternatives considered

- Define `contentId` as the raw blob OID and drop `git_blob_ids`. This removes
  the indirection but breaks the filesystem abstraction and invalidates foreign
  identities already permitted by the API.
- Prune only identities no longer referenced by `fs_nodes`. This preserves the
  abstraction but still leaves live repositories with an unbounded cache and
  requires a potentially large reachability sweep.
- Fail an otherwise valid clone when it produces more cache mappings than the
  cap. The mapping is optional, so rejecting the Git operation would turn a
  performance optimization into a correctness dependency.
