---
id: 103
title: Share reflog append and retention plumbing
blocked-by: []
---

# 103 — Share reflog append and retention plumbing

**Summary.** Resolve ARCH-36 while keeping direct-ref and checkout-HEAD
reflogs separately owned.

Compare append and retention paths in `store/refs/reflog.ts`,
`store/checkout/checkout.ts`, and `store/refs/refs.ts`. Share the common
mechanism without merging table ownership or foreign keys. `tests/refs.test.ts`
must preserve both writers, retention, and valid endpoint-equal HEAD entries.
