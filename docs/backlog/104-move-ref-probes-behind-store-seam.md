---
id: 104
title: Move ref probes behind the store seam
blocked-by: []
---

# 104 — Move ref probes behind the store seam

**Summary.** Resolve ARCH-40: ref expansion and one ref probe in ops name
`git_refs` directly.

Move those queries into the store ref family, preserving their bounded result
and error behavior. Touch `packages/git/src/ops/repository/repository.ts`,
`ops/refs/refs.ts`, and `store/refs/refs.ts`. Witness with `tests/refs.test.ts`
and the import-graph suite; no ops query should name `git_refs` afterward.
