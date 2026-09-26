---
id: 96
title: Reject noncanonical UTF-16 in Git caller text
blocked-by: []
---

# 96 — Reject noncanonical UTF-16 in Git caller text

**Summary.** Fix the input-acceptance defect from ARCH-27 separately from helper deduplication.

`updateRef` currently accepts a trailing unpaired high surrogate. Storage changes
the name, so lookup by the caller's original name fails. Reproduce at the public
boundary, then route ref names, symbolic targets, configuration text and reflog
metadata through the shared text check as appropriate. Retain each caller's
`GitError` code and reject before any write. Cover both surrogate halves and a
valid supplementary scalar, including a rollback witness. Check the live callers
before extending validation to another input family.

See [65](65-git-sqlite-architecture-review.md) for the remaining behavior-preserving
helper consolidation. This item intentionally changes invalid-input behavior.
