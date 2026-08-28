---
id: 38
title: Align clone depth with Git and allow deepening
blocked-by: []
---

# 38 — Align clone depth with Git and allow deepening

**Summary.** Tier A. `clone()` is shallow, single-branch and tagless by default,
and nothing can deepen the result afterwards. The default is a first-contact
footgun for both consumers and goes first; deepening waits.

## Problem

`clone()` in `src/core/ops/network.ts` defaults to `depth: 1`,
`singleBranch: true` and `noTags: true` — the inverse of Git's defaults. The
option types do not signal this; a caller who omits `depth` gets a repository
that looks complete until an operation crosses the shallow boundary.

Both consumers clone the full commit graph (blobless or not) and then run
`merge-base`, `rebase <upstream>`, `rev-list --count` and `worktree add -b
<name> origin/<branch>` across it. Under the current default every one of those
fails at the boundary on first use.

There is then no way out. `FetchOptions` has `depth` but no `--deepen` or
`--unshallow`, so `git_shallow` can only ever be written by the initial fetch.
Merge, rebase and log all fail closed at the boundary (`ESHALLOW`,
"cannot determine rebase base across a shallow boundary"), and the only remedy
is to clone again.

## Approach / acceptance

**Required now — the default:**

- Decide the default deliberately and write it down as an ADR. The consumer
  evidence points to Git's default (full history); the Workers cost model is
  the argument for staying shallow. Either way the option types state the
  choice and the reference doc records it.
- Real Git parity: a clone with no options followed by `mergeBase`, `rebase`
  and `divergence` against the fetched trunk behaves as real Git does.

**Later — deepening:**

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

<!-- Split 2026-08-28 by consumer demand -->
