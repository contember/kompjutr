---
id: 52
title: Match Git's default ref coverage on fetch and pull
blocked-by: []
---

# 52 — Match Git's default ref coverage on fetch and pull

**Summary.** Tier S. An ordinary `fetch()` never follows tags, and `pull()`
updates only its own upstream tracking ref. Both return success having brought
back less than `git fetch` / `git pull` would, with nothing to tell the caller
what is missing. Effort M.

## Problem

Two separate narrowings, one symptom: refs the caller would have after Git are
absent after kompjutr, and the result object reports nothing about it.

**Tags are never followed.** `fetchInto` passes `tags: options.tags ?? false`
(`src/core/ops/network.ts:171`) and the selector admits `refs/tags/*` only when
that flag is set (`src/core/ops/network.ts:110`). Git downloads tags reachable
from the refs it fetched whether or not `--tags` was given; kompjutr requires
`tags: true`. A colleague's release tag simply does not arrive.

**Pull sees one branch.** `pull()` calls `fetchInto` with
`singleBranch: options.singleBranch ?? true` and an exact `remoteRef`
(`src/core/ops/pull.ts:248`), so it only ever moves the upstream branch's
tracking ref. `git pull` runs the remote's configured
`+refs/heads/*:refs/remotes/origin/*`, so a branch the colleague created — and
any tag — lands as a side effect. After a kompjutr pull,
`refs/remotes/origin/<other>` is missing and a later `checkout` of it fails.

`docs/reference/git-support.md` marks `--tags` as a plain ✔ on `fetch` and says
nothing about either narrowing on `pull`, so the surface reads as if it matched
Git.

Both may well be deliberate — bounded work per operation is the house rule, and
following tags means extra negotiation. That is the decision this item asks for;
what is not defensible is diverging silently.

Distinct from [42](42-remote-ref-discovery-and-refspec-fetch.md), which is about
*asking* for refs outside `refs/heads/*` with refspec syntax. This item is about
what an ordinary call brings back when the caller asks for nothing special. If
42 lands first it supplies the refspec type this should express its defaults in.

## Approach / acceptance

- Follow tags reachable from the fetched refs by default, as Git does, with an
  explicit cap on how many and a stable error past it rather than a silent
  truncation. Keep `tags: false` available to opt out.
- Give `pull` the remote's configured fetch refspec by default, so every
  tracking ref its fetch covers moves; keep `singleBranch: true` reachable for a
  caller that wants today's bounded shape.
- Where a bound forces a narrower answer than Git's, say so in the result rather
  than returning a bare success.
- Update `docs/reference/git-support.md` for whatever is decided — including a
  stated narrowing, if that is the outcome.
- **Witness.** `tests/e2e/collaboration.test.ts` fetches tags with an explicit
  `tags: true` and checks out a colleague's branch through `origin/<name>`
  precisely because the defaults do not carry them. Those journeys drop their
  workarounds when this lands.

## Touch points

`src/core/ops/network.ts`, `src/core/ops/pull.ts`,
`tests/e2e/collaboration.test.ts`, `tests/clone.test.ts`, `tests/pull.test.ts`,
`docs/reference/git-support.md`.

<!-- Origin: ../archive/sprint-2026-08-26-e2e-journeys.md run log, findings 3 and 4. -->
