---
id: 102
title: Consolidate equivalent store validators
blocked-by: []
---

# 102 — Consolidate equivalent store validators

**Summary.** Resolve the remaining ARCH-34 duplicates without changing what
stored rows or caller input are accepted.

The first slice made `requireMergeText` use `common/rows.ts`'s `expectText` with
the same diagnostic. Audit remaining validators in
`packages/git/src/store/operations/` and `store/refs/ref-validation.ts`
individually. Share only equivalent checks; keep `GitError` for caller mistakes
and `CorruptError` for stored-row shape failures. Witness with affected journal,
ref and store suites, including error codes and messages. Do not fold the
input-changing UTF-8 fix from [96](96-validate-git-caller-utf8-at-boundaries.md)
into this cleanup.
