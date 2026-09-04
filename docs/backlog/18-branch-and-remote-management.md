---
id: 18
title: Complete remaining branch and remote management
blocked-by: []
---

# 18 — Complete remaining branch and remote management

**Summary.** Add the typed upstream and remote lifecycle operations that have no
current consumer. Branch rename and single fetch-URL get/set are already served.

## Problem

The native API can rename current and inactive branches atomically, including
their exact `branch.<name>.*` config, and can get or replace one remote fetch
URL. It still requires raw config access for upstream changes and has no typed
remote rename, separate push-URL management, or tracking-ref cleanup on remove.

## Approach / acceptance

- Explicit upstream set/unset operations.
- Remote rename, separate fetch and push URLs, and explicit tracking-ref cleanup
  on removal.
- Validate collisions and ref/config names before mutation. Keep low-level
  `configSet` available without making callers use it for standard workflows.
- Real Git parity tests for upstream changes, remote rename, collision
  failures, and cleanup modes.

## Touch points

`src/core/ops/config.ts`, `src/core/ops/refs.ts`, `src/git/client.ts`,
`tests/refs.test.ts`, `tests/client.test.ts`

<!-- Required first-contact subset shipped 2026-08-28; this file retains only the no-caller remainder. -->
