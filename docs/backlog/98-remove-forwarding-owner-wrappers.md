---
id: 98
title: Remove forwarding owner wrappers
blocked-by: []
---

# 98 — Remove forwarding owner wrappers

**Summary.** Resolve ARCH-24/25 one wrapper family at a time after a caller audit.

The first slice removed the `readShallowOwned` and unused `configGetOwned`
forwarders. Inspect remaining `*Owned` functions and WeakMap dispatch at HEAD.
Remove a function only when it adds no guard, lifetime check, ownership boundary
or behavior. Keep the authorized mutation composition and delayed iterator
checks. Each small change needs its direct caller suite,
`tests/store-module-exports.test.ts`, and typecheck; public error semantics
must remain unchanged. Touch points: `packages/git/src/store/` and
`packages/git/src/ops/repository/`.
