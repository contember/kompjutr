---
id: 53
title: Record the narrowings the Git support reference does not state
blocked-by: []
---

# 53 — Record the narrowings the Git support reference does not state

**Summary.** Three behaviours differ from Git by design, are explained in the
code, and are absent from `docs/reference/git-support.md` — plus one row that
claims behaviour the code does not have. The reference is the contract callers
read; where it is silent, it reads as "same as Git". Effort S.

## Problem

Each of these was found by running a journey against the git binary, not by
reading the code. None is a defect — the divergence is deliberate every time —
but a caller has no way to learn it short of hitting it.

**`add` of an explicitly named ignored path succeeds.** Git exits 1 with
*"The following paths are ignored by one of your .gitignore files"*; kompjutr
skips the path and reports success, leaving an identical index. The intent is
stated at `src/core/ops/staging.ts:826` — it matches isomorphic-git and is
therefore what the Computer facade promises. The `git add` table only says
*"A pathspec that matches nothing throws `PathspecNotFoundError`"*, so the
reference reads as if `force` were required to make this succeed.

**`init()` does not materialise the repository root.** `src/core/ops/init.ts:1`
is explicit — *"There is no directory to make"* — a repository is a row plus
refs and config. Real git's worktree root always exists afterwards, so a caller
that walks the root of a freshly initialised repository gets `ENOENT` until
something writes into the tree. The `git init` table does not mention it.

**Annotated tags do not peel in `revParse`.** The `git rev-parse` table says
*"annotated tags peel to their commit"*. `#resolveBase`
(`src/core/repository.ts:376`) returns `resolveRef(base)` unpeeled, so
`revParse("v1")` on an annotated tag yields the tag object — which is exactly
what `git rev-parse v1` yields, so the code is right and the row is wrong.
Peeling does happen where it should: `#parent` peels before walking, and
`branch()` and `checkout()` peel their start points. The row conflates the two.

## Approach / acceptance

- Add the `add` ignored-path case to the `git add` table, naming the compat
  reason so the next reader does not file it as a bug.
- Add the absent worktree root to the `git init` table, next to the existing
  note that every repository is effectively bare.
- Correct the `git rev-parse` row: `revParse` matches `git rev-parse` and does
  not peel; say where peeling does happen instead.
- **Acceptance.** Each of the three claims is checked against the git binary in
  the same change, not asserted from a reading — `tests/e2e/solo-workflow.test.ts`
  already exercises the first two differentially.

If [52](52-default-ref-coverage-on-fetch-and-pull.md) resolves its narrowings as
deliberate rather than as work, its outcome belongs in the same pass.

## Touch points

`docs/reference/git-support.md`.

<!-- Origin: ../archive/sprint-2026-08-26-e2e-journeys.md run log, findings 5 and 6. -->
