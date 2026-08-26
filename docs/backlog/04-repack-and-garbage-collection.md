---
id: 04
title: Add incremental repack and garbage collection
blocked-by: []
---

# 04 — Add incremental repack and garbage collection

**Summary.** Bound storage growth in long-lived repositories by packing loose
objects and reclaiming unreachable data through resumable maintenance.

## Problem

Locally created objects remain in `git_objects`; `src/sqlite/schema.ts` explicitly
leaves repacking for future work. Pack cleanup only handles incomplete ingestion.
Repeated commits, fetches, force pushes, and deleted refs can therefore retain
loose or unreachable data indefinitely.

## Approach / acceptance

- Walk reachability from every authoritative root, including refs, retained
  reflog entries, index entries, shallow boundaries, and active operation state.
- Repack loose reachable objects into validated pack and index rows without
  invalidating derived commit and tree data.
- Reclaim unreachable loose objects and packs only after the reflog retention
  window and a conservative collection grace period have both expired.
- Make maintenance incremental and resumable so each invocation stays below the
  operation budgets; interruption at any boundary must leave a readable repo.
- Add crash-boundary, corruption, concurrent-state, large-history, and storage
  reclamation tests.

## Touch points

`src/core/pack/`, `src/core/repository.ts`, `src/sqlite/schema.ts`,
`src/sqlite/store.ts`, migrations, `tests/`
