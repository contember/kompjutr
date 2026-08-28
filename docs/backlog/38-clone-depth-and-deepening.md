---
id: 38
title: Deepen and unshallow repositories
blocked-by: []
---

# 38 — Deepen and unshallow repositories

**Summary.** Tier A. An explicit shallow clone is supported, but nothing can
deepen or unshallow it afterwards. Optionless clone already follows Git's
complete-history, all-branches, normal-tag default.

## Problem

`clone()` now defaults to complete history and keeps a positive `depth` as the
explicit shallow opt-in. `FetchOptions` has `depth` but no `--deepen` or
`--unshallow`, so `git_shallow` can only ever be written by the initial fetch.
Merge, rebase and log all fail closed at the boundary (`ESHALLOW`,
"cannot determine rebase base across a shallow boundary"), and the only remedy
is to clone again.

## Approach / acceptance

- Add `deepen` and `unshallow` to fetch, negotiating the corresponding
  `upload-pack` capabilities and rejecting a request the server does not advertise.
- Update `git_shallow` atomically with the pack ingest, and revalidate the commit
  graph after the boundary moves; a partially deepened history must not become
  readable.
- Real Git parity tests for deepen by N, full unshallow, deepen on an already
  complete repository, a server without the capability, and a rebase that crossed
  a boundary before deepening and succeeds after.

## Touch points

`src/core/ops/network.ts`, `src/core/protocol/`, `src/sqlite/store.ts`,
`src/git/client.ts`, `tests/clone.test.ts`, `tests/protocol.test.ts`, `tests/rebase.test.ts`,
`docs/decisions/`, `docs/reference/git-support.md`

<!-- Git-compatible default shipped 2026-08-28; this file retains only deepening. -->
