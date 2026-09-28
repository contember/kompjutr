---
id: 96
title: Reject noncanonical UTF-16 in Git caller text
blocked-by: []
---

# 96 — Reject noncanonical UTF-16 in Git caller text

**Summary.** Fix the input-acceptance defect from ARCH-27 separately from helper deduplication.

`updateRef` currently accepts a trailing unpaired high surrogate. Storage changes
the name, so lookup by the caller's original name fails. Reproduced at `d8cf1f3`
(2026-09-28): `updateRef` accepts `refs/heads/x\uD800` and `resolveRef` with the
same name returns `null`. Witness it at the public boundary, then route ref
names, symbolic targets, configuration text and reflog metadata through the
shared text check as appropriate. Retain each caller's
`GitError` code and reject before any write. Cover both surrogate halves and a
valid supplementary scalar, including a rollback witness. Check the live callers
before extending validation to another input family.

See [100](100-consolidate-equivalent-git-helpers.md) for the behavior-preserving
helper consolidation. This item intentionally changes invalid-input behavior.
