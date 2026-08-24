---
id: 18
title: Complete branch and remote management
blocked-by: []
---

# 18 — Complete branch and remote management

**Summary.** Add the small ref and config operations needed to maintain a cloned
repository without manipulating implementation-specific config keys.

## Problem

Branches can be created, listed, and deleted, while remotes can be added, listed,
and removed. The typed API cannot rename branches or remotes, set an upstream,
change fetch and push URLs, or remove a remote together with its tracking refs.

## Approach / acceptance

- Add branch rename and explicit upstream set/unset operations. Rename the current
  branch without detaching HEAD and migrate its branch config atomically.
- Add remote rename and URL update operations, including separate fetch and push
  URLs and explicit tracking-ref cleanup on removal.
- Validate collisions and ref/config names before mutation. Keep low-level
  `configSet` available without making callers use it for standard workflows.
- Add real Git parity tests for current and inactive branch rename, upstream
  changes, remote rename, URL changes, collision failures, and cleanup modes.

## Touch points

`src/core/ops/config.ts`, `src/core/ops/refs.ts`, `src/git/client.ts`,
`src/compat/computer/client.ts`, `tests/refs.test.ts`, `tests/client.test.ts`
