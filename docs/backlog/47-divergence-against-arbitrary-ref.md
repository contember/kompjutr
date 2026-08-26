---
id: 47
title: Count divergence against an arbitrary ref
blocked-by: []
---

# 47 — Count divergence against an arbitrary ref

**Summary.** Tier A. `ahead`/`behind` are reachable only through the checked-out
branch's configured upstream, so "how far is HEAD ahead of `main`" has no bounded
answer.

## Problem

`countAheadBehind()` (`src/core/ops/merge-base.ts:252`) is already the bounded
read this needs: it walks the reachable graph under an explicit SQL-statement
ceiling and reports `ahead`, `behind`, `commits` and `retainedBytes`. Nothing
public reaches it with a caller-chosen pair.

The only public path is `statusReport({ branch: true })`, and `statusBranch()`
(`src/core/ops/status.ts:129`) narrows it twice: it requires a symbolic HEAD, and
it resolves the other side from `branch.<name>.remote`/`branch.<name>.merge`. A
caller asking about a local branch, a tag, a tracking ref that is not the
configured upstream, or a detached HEAD gets nothing back.

The workaround is worse than a refusal. `git rev-list --count <base>..HEAD` has
no equivalent, so a caller reconstructs it from two `log()` calls and a set
difference — and `log()` without `depth` materialises every reachable commit into
a parsed `CommitView[]` (`src/core/ops/reads.ts:66`). Two whole histories in
memory is the unbounded allocation the operation budget exists to prevent, and
the caller has no way to observe that it happened. This is the shape a real
consumer already ships: the `git-status` plugin in
[roj](https://github.com/contember/roj) counts commits ahead of a base branch
name on every refresh.

## Approach / acceptance

- Add a bounded public divergence read taking two revisions the caller names,
  resolved through the existing `revParse` rules — branch, tag, tracking ref,
  full or abbreviated OID, `~`/`^` suffixes — returning at least `ahead` and
  `behind`.
- Reuse `countAheadBehind()` unchanged. Keep its statement ceiling and its
  retained-bytes accounting; exceeding either fails closed with a stable code
  rather than returning a partial count.
- Report shallow and unrelated histories explicitly instead of a number that
  silently means something else. `selectMergeBases()` already distinguishes both.
- Real Git parity against `rev-list --left-right --count <a>...<b>` for identical
  refs, a pure fast-forward in each direction, divergence, an unborn or empty
  side, multiple merge bases, a tag on either side, a detached HEAD, a shallow
  boundary, and unrelated histories.
- A statement-count witness pinning the ceiling on a deep history.

Item [39](39-plumbing-read-surface.md) promises `revList` and `mergeBase` as part
of a wider plumbing surface. This is the narrow slice a consumer needs now and
can land first; 39 may subsume it later without changing the shape.

## Touch points

`src/core/ops/merge-base.ts`, `src/git/client.ts`, `src/git/index.ts`,
`src/index.ts`, `tests/`, `docs/reference/git-support.md`

<!-- Origin: migration assessment of roj's platform adapter onto kompjutr, 2026-08-26. -->
