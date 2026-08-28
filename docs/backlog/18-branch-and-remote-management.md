---
id: 18
title: Complete branch and remote management
blocked-by: []
---

# 18 — Complete branch and remote management

**Summary.** Add the small ref and config operations needed to maintain a cloned
repository without manipulating implementation-specific config keys. Two of
them are on both consumers' first-contact path and go first.

## Problem

Branches can be created, listed, and deleted, while remotes can be added, listed,
and removed. The typed API cannot rename branches or remotes, set an upstream,
change fetch and push URLs, or remove a remote together with its tracking refs.

The project builder runs `git branch -m main` right after `init` and re-points
`origin` before pushing to a new home; the orchestrator does `remote set-url`
and `remote get-url` when a sandbox is rebuilt. Today `branch -m` is spelled as
`branch()` + `branchDelete()`, which detaches nothing but also migrates no
branch config, and URL changes go through raw `configSet`.

## Approach / acceptance

**Required subset — both consumers issue these:**

- Branch rename, including the current branch without detaching `HEAD`, with
  its `branch.<name>.*` config migrated atomically and the checkout's raw
  `HEAD` retargeted through the existing ref-mutation seam.
- Remote URL get and set as typed operations over the existing config.
- Real Git parity for current and inactive branch rename, a collision, and a
  URL change followed by a push.

**Rest — no caller yet:**

- Explicit upstream set/unset operations.
- Remote rename, separate fetch and push URLs, and explicit tracking-ref cleanup
  on removal.
- Validate collisions and ref/config names before mutation. Keep low-level
  `configSet` available without making callers use it for standard workflows.
- Real Git parity tests for upstream changes, remote rename, collision
  failures, and cleanup modes.

## Touch points

`src/core/ops/config.ts`, `src/core/ops/refs.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/refs.test.ts`, `tests/client.test.ts`

<!-- Split 2026-08-28 by consumer demand -->
