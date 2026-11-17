---
id: 125
title: Match Git on branch, reflog and push edge cases
blocked-by: []
---

# 125 — Match Git on branch, reflog and push edge cases

**Summary.** Five ref and push cases where kompjutr answers differently from Git.
Tier S for the silent ones (reflog, upstream push, ambiguous start point); B for
the push lease, which fails loudly, and the tracking message, which changes no
state.

## Problem

Reproduced against git 2.54 with the differential worlds
(`tests/helpers/differential/`). A cloned world's origin has `main` and
`feature`.

- **Reflog of a branch rename.** (a) Commit on `main`, then
  `branchRename main → main`: Git adds
  `Branch: renamed refs/heads/main to refs/heads/main` to the `HEAD` and `main`
  reflogs; kompjutr adds nothing. `git-support.md` documents this one as
  intentional. (b) Rename the unborn `main` to `trunk`, then commit: Git's `HEAD`
  and `trunk` reflogs hold only `commit (initial)`; kompjutr's `HEAD` reflog also
  holds a `branch: rename` row (`ref: refs/heads/main` → `ref: refs/heads/trunk`,
  both OIDs null), which the same doc sentence says it does not write. Owner:
  `branchRenameOwned()` in `ops/refs/refs-branches.ts` (the early return for
  `source === destination`; `mutateRefsOwned` with only `head` for an unborn
  source). Silent.
- **Push without a ref to a differently named upstream.** `checkout -b topic
  origin/feature`, commit, `push`. Git (`push.default=simple`) exits 128:
  `fatal: The upstream branch of your current branch does not match the name of
  your current branch.` kompjutr exits 0 and moves origin's `feature`; a typed
  `push({ remote: "origin" })` does the same. Documented in `git-support.md`.
  Owner: `targetBranch()` in `ops/push/push-options.ts`. Silent.
- **Push lease with a missing tracking ref.** A peer pushes `newb` to origin
  without a fetch here; `checkout -b newb`;
  `push --force-with-lease=newb origin newb`. Git exits 1:
  `! [rejected] newb -> newb (stale info)`. kompjutr exits 128:
  `fatal: tracking ref not found for push lease: refs/remotes/origin/newb`. With
  a branch origin lacks (`checkout -b topic`, same push), Git exits 0 and creates
  it; kompjutr fails the same way. Git takes a missing tracking ref as "expect the
  remote ref absent". Owner: `snapshotPushLeases()` in `ops/push/push-options.ts`
  (`EREFNOTFOUND`), rendered by `cli/network/network-output.ts`. Loud.
- **Branch tracking message.** `branch f origin/feature` and
  `checkout -b g origin/feature`: Git prints
  `branch 'f' set up to track 'origin/feature'.` on stdout; kompjutr prints
  nothing there, though it records the same upstream. Owner: the `branch` and
  `checkout -b` handlers in `cli/write/write-refs.ts`; `startPointUpstream()` in
  `ops/refs/branch-upstream.ts` decides the upstream but does not report it.
  Output only: the recorded state is the same.
- **Ambiguous start point.** `branch origin/main origin/feature`, then
  `branch x origin/main`. Git exits 128:
  `warning: refname 'origin/main' is ambiguous.` /
  `fatal: ambiguous object name: 'origin/main'`. kompjutr exits 0 and starts `x`
  at the local `origin/main` (the `feature` tip), the first match, as `revParse`
  does. `rev-parse origin/main` agrees on the OID; Git only warns. Owner:
  `branch()` in `ops/refs/refs-branches.ts` (`repo.revParse(startPoint)`) and
  `startPointUpstream()`, both through `store.expandRefName()`. Silent.

## Approach / acceptance

- reflog: decide whether (a) stays intentional; either way make (b) and the doc
  agree. A parity case compares which reflogs gain a row, and its endpoints.
- upstream push and push lease: parity cases against the `git` binary; the
  `push` op always names a ref and has no lease.
- tracking message: a parity case on the strict argv runner's stdout.
- ambiguous start point: a scenario in
  `tests/differential/regressions-branch-upstream.test.ts` (cloned world,
  `branch origin/main origin/feature`, then `branch x origin/main`).

## Touch points

`packages/git/src/ops/refs/refs-branches.ts`,
`packages/git/src/ops/refs/branch-upstream.ts`,
`packages/git/src/ops/push/push-options.ts`,
`packages/git/src/cli/write/write-refs.ts`,
`packages/git/src/cli/network/network-output.ts`,
`docs/reference/git-support.md`, `tests/local/git-parity.test.ts`,
`tests/differential/regressions-branch-upstream.test.ts`.

<!-- Origin: residual divergences reported while reviewing differential tester fixes, re-checked 2026-11-17. -->
