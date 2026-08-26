---
id: 51
title: Relocate every distinct-type merge conflict, not only file/directory
blocked-by: []
---

# 51 — Relocate every distinct-type merge conflict, not only file/directory

**Summary.** Tier S. When the two sides put different *object types* at one path
— a symlink against a regular file — Git splits the path and materialises both,
while kompjutr keeps one entry and writes only one side into the working tree.
The other side is reachable in the index but never appears on disk. Effort M.

## Problem

`projectMergePlan` relocates only when `entry.conflict === "file/directory"`
(`src/core/ops/merge-projection.ts:158`); every other conflict kind falls
through to the ordinary projection.

For a symlink-versus-file conflict Git records the symlink at the path (stage 3)
and relocates the regular file to `<path>~HEAD` (stage 2), materialising both.
kompjutr keeps a single unmerged entry carrying both modes at stages 2 and 3 and
writes ours into the working tree:

```
git:       index  lnk, lnk~HEAD          worktree  lnk -> target.txt, lnk~HEAD (file)
kompjutr:  index  lnk                    worktree  lnk (file)

git:       u UA … 000000 000000 120000 120000 … lnk
           u AU … 000000 100644 000000 100644 … lnk~HEAD
kompjutr:  u AA … 000000 100644 120000 100644 … lnk
```

Nothing warns, and the merge reports a normal conflict. A caller that resolves
by editing the working tree sees only one of the two candidates, so the other
side can be lost without anyone noticing it was there.

Git's relocation is not specific to add/add: it applies to a distinct-types
conflict with a merge base too, where `<path>~HEAD` then carries stages 1 and 2.
`docs/reference/git-support.md` promises relocation for file/directory only, so
this reads as an unimplemented case rather than a regression — but the
documented promise is narrower than what a caller resolving conflicts needs.

## Approach / acceptance

- Extend the relocation pass to every conflict whose sides disagree on mode
  class (regular file, symlink, gitlink), reusing the existing
  collision-checked `~<label>` path allocation and its bounds rather than
  adding a second scheme.
- Preserve Git's stage assignment for both the primary and the relocated path,
  in the base-present and base-absent shapes.
- Decide and record what `mergeAbort` and the replay commands owe a relocated
  path here — the file/directory case already fails closed on a structural
  blocker, and the new kinds must not be looser.
- **Witness.** `tests/e2e/conflicts.test.ts` pins the divergence with an
  `it.fails` on the symlink-versus-file journey, whose resolution tail
  (`add lnk`, `rm lnk~HEAD`, `mergeContinue`) is written and currently
  unreachable. When this lands, the `.fails` comes off and the tail runs.

## Touch points

`src/core/ops/merge-projection.ts`, `src/core/ops/merge-apply.ts`,
`tests/e2e/conflicts.test.ts`, `tests/merge-projection.test.ts`,
`docs/reference/git-support.md`.

<!-- Origin: ../archive/sprint-2026-08-26-e2e-journeys.md run log, finding 2. -->
