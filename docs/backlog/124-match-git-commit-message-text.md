---
id: 124
title: Match Git's commit message text in merge, rebase and cherry-pick
blocked-by: []
---

# 124 — Match Git's commit message text in merge, rebase and cherry-pick

**Summary.** Four cases where kompjutr stores a different commit message from
Git's, so the OIDs differ, or refuses one Git commits. Tier S for all except the
empty-message cherry-pick, which fails loudly (B).

## Problem

Reproduced against git 2.54 with the differential worlds
(`tests/helpers/differential/`), fixed identity and time on both sides.

- **Default merge message.** In a cloned world, a typed `merge({ theirs })`
  without `message` against `git merge --no-edit`:

  | `theirs` | Git | kompjutr |
  |---|---|---|
  | `origin/feature` | `Merge remote-tracking branch 'origin/feature'` | `Merge branch 'origin/feature'` |
  | tag `v1` | `Merge tag 'v1'` | `Merge branch 'v1'` |
  | `feature` into `topic` | `Merge branch 'feature' into topic` | `Merge branch 'feature'` |
  | `feature~0` | `Merge branch 'feature'` | `Merge branch 'feature~0'` |

  `feature` into `main` agrees. Owner: `defaultMessage()` and its call
  (`supplied ?? defaultMessage(nextLabel)`) in `ops/merge/merge.ts`. Silent.
- **Rebase continue keeps `#` lines.** Commit `a` on `main`, change it on both
  `main` and `side`, commit `side` with `-m "side subject\n\n# hash line\nbody"`,
  `rebase main` on `side`, resolve, `add a`, continue. Git (`rebase --continue`
  through the editor) stores `side subject\n\nbody`; kompjutr keeps the `#` line.
  Owner: `rebaseContinue()` in `ops/rebase/rebase.ts` writes `source.message`
  verbatim; `continueReplay()` in `ops/replay/replay-lifecycle.ts` already uses
  `strip` for cherry-pick and revert. Silent.
- **Cherry-pick of a source with an empty message.** Source made with
  `git commit --allow-empty-message -m ""`, then a clean `cherry-pick`. Git exits 0
  and commits with the empty message; kompjutr throws
  `EMSG: commit message is required` and commits nothing. After a conflict and
  continue, both refuse. Owner: `startReplay()` in `ops/replay/replay-lifecycle.ts`
  commits with `mode: "exact"`, and `storedMessage()` in
  `ops/repository/commit.ts` refuses a blank message in every mode. Loud.
- **`merge --continue` keeps `#` lines.** A conflicted merge, with no message or
  with `-m "m subject\n\n# hash line\nbody"`, resolved and continued through the
  argv `merge --continue` or a typed `mergeContinue({})`. Git's
  `merge --continue` stores `Merge branch 'side'` and `m subject\n\nbody`.
  kompjutr keeps the `#` lines, including its own `# Conflicts:\n#\ta` block,
  which is what `git commit --no-edit` stores (same OIDs). Owner:
  `mergeContinue()` in `ops/merge/merge.ts`
  (`mode: "clean"` for `options.message ?? journal.state.message`). Silent.

Already fixed: a revert subject with a trailing CR (#21), an NBSP-only `commit -m` and the `--no-edit` Conflicts lines on a
continued cherry-pick or revert agree with Git.

## Approach / acceptance

Take each message from Git's rules, not from a reading of them:

- rebase continue: a scenario in
  `tests/differential/regressions-message-cleanup.test.ts`;
- the other three: parity cases against the `git` binary. The ops cannot express
  them: `merge` and `mergeContinue` always pass a message, and `commit` cleans
  every message it makes, so no source can hold an empty message.

## Touch points

`packages/git/src/ops/merge/merge.ts`, `packages/git/src/ops/rebase/rebase.ts`,
`packages/git/src/ops/replay/replay-lifecycle.ts`,
`packages/git/src/ops/repository/commit.ts`,
`tests/differential/regressions-message-cleanup.test.ts`,
`tests/local/git-parity.test.ts`.

<!-- Origin: residual divergences reported while reviewing differential tester fixes, re-checked 2026-11-17. -->
