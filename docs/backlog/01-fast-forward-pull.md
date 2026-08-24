---
id: 01
title: Implement fast-forward pull
blocked-by: []
---

# 01 — Implement fast-forward pull

**Summary.** Add the smallest safe `pull`: fetch the configured upstream and
fast-forward the current branch without creating a merge commit.

## Problem

`Git.pull()` is an explicit unsupported-operation stub in `src/git/client.ts`
and the compatibility client. Callers must currently compose fetch, ref updates,
and checkout themselves, which cannot preserve pull's safety guarantees.

## Approach / acceptance

- Resolve the current attached branch and its configured upstream, with explicit
  overrides only where the existing fetch API already supports them.
- Fetch first, then distinguish up-to-date, local-ahead, fast-forward, and
  diverged histories with a bounded commit walk.
- Update the branch, index, and worktree atomically on a fast-forward while
  preserving checkout's dirty and untracked-file protections.
- Return stable errors for detached HEAD, missing upstream, non-fast-forward
  history, and unsafe worktree changes. Do not silently merge or reset.
- Add parity tests against real Git for every history shape and worktree safety
  case, plus statement-budget coverage.

## Touch points

`src/git/client.ts`, `src/compat/computer/client.ts`, `src/core/ops/network.ts`,
`src/core/ops/refs.ts`, `src/core/repository.ts`, `tests/`
