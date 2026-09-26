---
id: 99
title: Simplify redundant checkout store reads
blocked-by: []
---

# 99 — Simplify redundant checkout store reads

**Summary.** Resolve ARCH-26 by removing only eager synchronous read forwards
whose shared-repository counterpart has identical behavior.

Audit `packages/git/src/store/checkout/checkout.ts` and
`packages/git/src/store/repository/shared.ts` one read family at a time. Keep
checkout lifetime checks at iterator start and batch flush, and preserve
authorized mutation composition. Witness with `tests/store.test.ts`, checkout
lifecycle tests, and a delayed-iterator failure case where applicable. Do not
replace a guarded wrapper merely because its method body looks short.
