---
id: 126
title: Match Git on abort, rm, ignored status, and guard the index and drive contracts
blocked-by: []
---

# 126 — Match Git on abort, rm, ignored status, and guard the index and drive contracts

**Summary.** Three worktree divergences from Git, a drive contract the two
compositions read differently, and a missing write-path check on the index.
Tier S for `rm` and `status --ignored`; B for abort, the drive default, and the
index check.

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
  unstages `d/f` and deletes the symlink `d`; `real/f` stays. With `-f`, Git
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
- **Drive `removeFiles` default `force`.** `removeFiles(["/missing"])` without
  options returns on the DO filesystem (`options.force ?? true` in
  `packages/do/src/fs/store/remove.ts`) and throws `ENOENT` on the local
  `DiskDrive` (`options.force === true` in
  `packages/local/src/drive/disk-drive.ts`). `RemoveOptions` in
  `packages/drive/src/index.ts` names no default. By reading, Git callers that
  omit `force` (`apply-prune.ts`, `checkout-structure.ts`,
  `sparse-checkout-apply.ts`) would skip a missing path on DO and fail locally.
  Not a Git divergence.
- **Index writer accepts a file and a path below it.** Not a divergence: a
  defensive check. `indexApply()` in `store/indexes/index-table-store.ts` takes a
  put of `a` while `a/b` is indexed, and `buildTreeInBatch()` in
  `ops/tree/tree-build-full.ts` then writes a tree with a blob and a tree both
  named `a`. `git fsck` rejects such a tree (`duplicateEntries`, checked with a
  hand-made tree). An upstream bug would publish it instead of failing.

## Approach / acceptance

- abort: scenarios for merge, cherry-pick and revert in
  `tests/differential/regressions-abort-reset-merge.test.ts`.
- `rm`: a scenario in a `regressions-*` file. Decide first whether `rm -f` follows
  the symlink as Git does or refuses; following it deletes a file outside the
  named path.
- `status --ignored`: a parity case against the `git` binary; neither the
  snapshot nor the strict argv runner takes `--ignored`.
- drive default: pick one, document it on `RemoveOptions.force` after reading the
  callers that omit it, and run one contract case over both drives.
- index check: fail with a stable code when one index or tree would hold a path
  and a path below it, in the write path (ADR-0004), streaming and without an
  extra pass.

## Touch points

`packages/git/src/ops/integration/integration-restore-owned.ts`,
`packages/git/src/ops/staging/staging-rm.ts`,
`packages/git/src/ops/staging/staging-rm-worktree.ts`,
`packages/git/src/ops/status/status-full.ts`,
`packages/git/src/ops/status/status-sparse.ts`,
`packages/git/src/store/indexes/index-table-store.ts`,
`packages/git/src/ops/tree/tree-build-full.ts`, `packages/drive/src/index.ts`,
`packages/do/src/fs/store/remove.ts`, `packages/local/src/drive/disk-drive.ts`,
`tests/differential/regressions-abort-reset-merge.test.ts`, `tests/status.test.ts`,
`tests/local/disk-drive.test.ts`, `tests/fs/filesystem.test.ts`.

<!-- Origin: residual divergences reported while reviewing differential tester fixes, re-checked 2026-11-17. -->
