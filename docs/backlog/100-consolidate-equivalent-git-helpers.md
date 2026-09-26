---
id: 100
title: Consolidate equivalent Git path and OID helpers
blocked-by: []
---

# 100 — Consolidate equivalent Git path and OID helpers

**Summary.** Resolve the behavior-preserving part of ARCH-27, one helper family
per change.

Recheck duplicate basename, depth, path and OID helpers in
`packages/git/src/ops/` against `common/paths.ts` and `common/bytes.ts`.
Consolidate only equivalent implementations; preserve caller-vs-corruption
errors and valid-path output. Each slice needs its affected path/store/operation
suite and typecheck. The input-changing lone-surrogate fix belongs to
[96](96-validate-git-caller-utf8-at-boundaries.md), not this item.
