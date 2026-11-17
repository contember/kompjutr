---
id: 126
title: Match Git on abort, rm through a symlink, and ignored status
blocked-by: []
---

# 126 — Match Git on abort, rm through a symlink, and ignored status

**Summary.** Three worktree divergences from Git. Tier S for `rm` and
`status --ignored`; B for abort, which fails loudly.

## Problem

Reproduced against git 2.54 with the differential worlds
(`tests/helpers/differential/`) unless stated.

- **Abort with an untracked file in a directory the operation created.** Commit
  `a`; `branch side`; change `a` on `main`; on `side` change `a` and add `new/b`;
  back on `main`, `merge side` (conflict); write `new/u`; `mergeAbort`. Git exits
  0, removes `new/b` and keeps `new/u`. kompjutr throws
  `ECHECKOUTFAIL: working tree path blocks merge restoration: new/u` and changes
  nothing. `cherryPick side` + `cherryPickAbort` and a conflicted revert that
  restores `new/b` + `revertAbort` fail the same way; `rebaseAbort` agrees.
  Owner: `restoreTouched()` in `ops/integration/integration-restore-owned.ts`,
  called by `resetIntegrationOwned()`. Loud.
- **`rm` through a symlinked parent.** Commit `d/f` and `real/f`; replace `d`
  with a symlink to `real`; `rm d/f`. Git exits 1:
  `error: the following file has local modifications: d/f`. kompjutr succeeds,
  stages the deletion of `d/f` and deletes the symlink `d`; `real/f` stays. With `-f`, Git
  unlinks through the symlink: `real/f` is gone, `d` stays, and status shows
  `real/f` deleted and `? d`; kompjutr again deletes `d` and keeps `real/f`.
  `rm -r d` matches the case without `-f`; `--cached` agrees. The originally
  reported shape (an untracked `link → real` alias, `rm link/f`) agrees. Owner:
  `rmCandidateUnsafe()` in `ops/staging/staging-rm.ts` treats the path beyond the
  symlink as missing, hence safe. That the prune plan in
  `ops/staging/staging-rm-worktree.ts` then deletes `d` as an emptied parent is a
  hypothesis; only the deletion was observed. Silent.
- **`status --ignored` on a wholly ignored directory.** `.gitignore` holds
  `*.log`; untracked `logs/x.log`, `mixed/y.log` and `mixed/z`. Git's
  `status --porcelain=v2 --ignored`: `? mixed/`, `! logs/`, `! mixed/y.log`.
  kompjutr's `status({ includeIgnored: true })`: `? mixed/`, `! logs/x.log`,
  `! mixed/y.log`. Owner: `shallowestIgnoredDirectory()`, used by
  `statusStreamInternal()` in `ops/status/status-full.ts`, collapses only a
  directory that is ignored itself; `sparseCollapsedUntrackedPath()` in
  `ops/status/status-sparse.ts` is the sparse twin. Silent.

## Approach / acceptance

- abort: scenarios for merge, cherry-pick and revert in
  `tests/differential/regressions-abort-reset-merge.test.ts`.
- `rm`: a scenario in a `regressions-*` file. Decide first whether `rm -f` follows
  the symlink as Git does or refuses; following it deletes a file outside the
  named path.
- `status --ignored`: a parity case against the `git` binary; neither the
  snapshot nor the strict argv runner takes `--ignored`.

## Touch points

`packages/git/src/ops/integration/integration-restore-owned.ts`,
`packages/git/src/ops/staging/staging-rm.ts`,
`packages/git/src/ops/staging/staging-rm-worktree.ts`,
`packages/git/src/ops/status/status-full.ts`,
`packages/git/src/ops/status/status-sparse.ts`,
`tests/differential/regressions-abort-reset-merge.test.ts`, `tests/status.test.ts`.

<!-- Origin: residual divergences reported while reviewing differential tester fixes, re-checked 2026-11-17. -->
