> **OUTCOME — shipped 2026-08-27.** Branch deletion now proves merged
> reachability against the configured upstream or active HEAD, guards every
> checkout, and publishes through compare-and-delete. Status now has exact Git
> quoting and NUL framing, rejects non-UTF-8 tree names, preserves cached-removal
> rows, and keeps normal untracked collapsing sparse. Regular-file/symlink
> conflicts materialise both sides, while fetch and pull use Git-compatible head
> and tag coverage. Commit map: plan → `efc98e9`; WU0 → `d42f4f6`; WU1 →
> `342f74f`; WU2 framing → `12c29dc`; WU2 sparse rows → `12e89d9`; WU3 →
> `17d2c43`; WU4 → `7a6c2b3`; WU5 tests → `943c283`; WU5 reference →
> `34885e3`. Verification: CPU-leased full suite — 117 files, 2,084 passed,
> 5 skipped; CPU-leased typecheck, Biome check, and build; docs lint. Backlog
> closed: 33, 45, 50–53, and 55. Deferred: gitlink conflict materialisation,
> byte-preserving paths, general fetch refspecs, status performance items 54,
> 56, and 57, deployment, publication, and production probes.

# Sprint — Git boundary correctness (2026-08-26)

**Goal.** Make destructive refs, status output, conflict materialisation, and
network defaults safe and predictably Git-compatible at the public boundary.

**Theme.** These are the remaining silent-success gaps found by the differential
journeys: each operation currently returns a plausible success while deleting
too much, reporting too little, materialising too little, or fetching too little.
The sprint closes those gaps without adding submodule or byte-path architecture.

## Refs re-verified at HEAD (2026-08-26)

- ✔ `branchDelete()` checks existence and only the active checkout before
  deleting; it has no merged proof or force option — `src/core/ops/refs.ts:65`.
- ⚠ Safe Git deletion prefers a resolvable configured upstream over HEAD and
  refuses a branch attached to any checkout even with force. The bounded merge
  base walk and bounded checkout listing already exist —
  `src/core/ops/merge-base.ts:323`, `src/sqlite/store.ts:2149`.
- ✔ The status formatters interpolate raw string paths into newline-delimited
  records — `src/core/ops/status.ts:657`.
- ⚠ The public path model is `string`, and tree parsing currently replaces
  invalid UTF-8 bytes silently. Byte-exact non-UTF-8 output therefore needs a
  different architecture — `src/core/ops/kinds.ts:30`, `src/core/objects.ts:410`.
- ✔ Full and sparse status both assume a HEAD path cannot also be untracked,
  contradicting the row builder after a cached removal —
  `src/core/ops/status.ts:380`, `src/core/ops/status-sparse.ts:174`,
  `src/core/ops/status-rows.ts:237`.
- ✔ Sparse status falls back to the full path for every reportable untracked
  file under normal collapsing — `src/core/ops/status-sparse.ts:180`.
- ⚠ Distinct regular-file/symlink conflicts need the existing relocation
  lifecycle, but gitlinks need directory materialisation and different dirty
  semantics that do not exist — `src/core/ops/merge-projection.ts:146`,
  `src/core/ops/merge-apply.ts`.
- ⚠ Plain `fetch()` already covers all advertised heads. The live network gaps
  are default tag auto-follow and `pull()` forcing a one-ref fetch —
  `src/core/ops/network.ts:83`, `src/core/ops/pull.ts:244`.
- ✔ The support reference omits the virtual init root and ignored explicit-add
  compatibility behaviour, and incorrectly says plain annotated-tag rev-parse
  peels — `docs/reference/git-support.md:64`,
  `docs/reference/git-support.md:274`.

## Work units

### WU0 — Freeze shared seams (effort S)

- **Problem.** The status unit and branch unit share upstream/configuration code,
  while multiple witnesses need the same E2E adapters and status exports.
- **Verify first.** Run the current formatter, branch, and E2E helper tests before
  moving code.
- **Scope.** Extract the pure status formatters behind unchanged re-exports;
  expose one bounded branch-upstream resolver; add only the adapter options that
  later witnesses need. No semantic behaviour changes.
- **Acceptance / witness.** Existing status, refs, pull, and E2E helper tests pass;
  typecheck proves the frozen public signatures.
- **Touch points.** `src/core/ops/status.ts`, new focused core modules,
  `src/index.ts`, `src/git/index.ts`, `tests/helpers/e2e.ts`, focused tests.

### WU1 — Safe branch deletion (#33, effort M)

- **Problem.** The safe spelling currently deletes an unmerged branch and sees
  only the active checkout.
- **Verify first.** Pin the existing unsafe result and real Git's upstream,
  detached, shallow, and linked-worktree behaviour.
- **Scope.** Add `force?: boolean`; guard every checkout; use configured upstream
  when resolvable and HEAD otherwise; prove reachability with the bounded merge
  base walk; use compare-and-delete publication.
- **Acceptance / witness.** Unit and differential tests cover merged, unmerged,
  forced, upstream-preferred, detached, unborn, shallow, over-budget, and linked
  checkout cases. Force never bypasses the checkout guard.
- **Touch points.** `src/core/ops/refs.ts`, `tests/refs.test.ts`,
  `tests/worktrees.test.ts`.

### WU2 — Framing-safe and sparse truthful status (#45, #50, #55, effort L)

- **Problem.** Hostile valid UTF-8 paths break text framing; invalid UTF-8 loses
  identity silently; cached removal loses its untracked row; normal untracked
  collapsing defeats sparse status.
- **Verify first.** Compare formatter bytes to real Git and pin cached-removal
  full/sparse output before changing the pipeline.
- **Scope.** Add Git-compatible quoting and NUL framing; make valid UTF-8 the
  fail-closed Git-path envelope; add `untrackedFiles: "no"`; allow an ordinary
  deletion and untracked/ignored row for one path; hydrate bounded ancestor facts
  so normal collapsing remains sparse.
- **Acceptance / witness.** Git parity for v1, v2, short, quoting on/off, rename
  framing, and `-z`; loose, packed, and corrupted tree-name validation; full and
  sparse cached-removal parity for `no`, `normal`, `all`, and ignored paths;
  statement count stays flat over bounded untracked candidates.
- **Touch points.** Status/objects/tree-walk/sparse-workspace core and SQLite
  modules; formatter, status, sparse, client, tree, pack, and public API tests.

### WU3 — Materialise regular-file/symlink conflicts (#51, effort M)

- **Problem.** A distinct regular-file/symlink conflict keeps only one physical
  candidate even though both index sides exist.
- **Verify first.** Pin both orientations and base-present/base-absent stage
  layouts against real Git.
- **Scope.** Reuse bounded collision allocation; keep the symlink at the logical
  path and relocate the regular file; attach base stage to its mode class; reuse
  existing merge, replay, abort, and rebase ownership.
- **Acceptance / witness.** Projection tests cover all shapes, mode-only conflict,
  collision bounds, and explicit gitlink refusal. The existing E2E conflict loses
  `.fails`; cold abort/replay/rebase witnesses prove lifecycle ownership.
- **Touch points.** `src/core/ops/merge-projection.ts` and focused merge,
  replay, rebase, and E2E conflict tests.

### WU4 — Git-compatible fetch and pull coverage (#52, effort L)

- **Problem.** Default fetch omits reachable tags, and pull fetches only its
  integration ref instead of the configured remote coverage.
- **Verify first.** Retain plain-fetch all-head coverage and pin explicit-ref
  fetch as tagless, matching real Git.
- **Scope.** Separate transfer/tracking coverage from the one result/integration
  ref; make tags tri-state; auto-follow reachable tags for default/configured
  fetches; make ordinary pull update canonical tracking refs while integrating
  only its upstream; reject noncanonical configured refspecs for now; preserve
  fail-closed advertisement and object bounds.
- **Acceptance / witness.** Real-HTTP and differential tests cover lightweight
  and annotated tags, unreachable/conflicting tags, `tags` tri-state, pull side
  branches, explicit selectors, `singleBranch`, configuration drift, and no ref
  publication on bounds failure.
- **Touch points.** `src/core/ops/network.ts`, `src/core/ops/pull.ts`, network,
  clone, pull, and collaboration tests.

### WU5 — Differential closure and public contract (#53, effort S)

- **Problem.** Shared E2E journeys and the support reference still pin or hide
  the corrected behaviour.
- **Verify first.** Run every affected journey before removing an expected
  failure or workaround.
- **Scope.** Land shared E2E witness changes; document init-root, ignored-add,
  annotated-tag, UTF-8, branch-delete, conflict, and network contracts; close
  consumed backlog items and archive this sprint.
- **Acceptance / witness.** All affected differential journeys pass against real
  Git where parity is promised; `reads` proves raw annotated tag versus `^0`;
  docs lint is clean.
- **Touch points.** `tests/e2e/solo-workflow.test.ts`,
  `tests/e2e/conflicts.test.ts`, `tests/e2e/collaboration.test.ts`,
  `tests/reads.test.ts`, `docs/reference/git-support.md`, docs indexes and backlog.

## Out of scope (explicit)

- Gitlink/submodule conflict materialisation needs a worktree directory model and
  new status/dirty semantics — [58](../backlog/58-materialize-gitlink-conflicts.md).
- Byte-preserving arbitrary Git paths need a byte-path public representation —
  [59](../backlog/59-byte-preserving-git-paths.md).
- General fetch refspec parsing remains [42](../backlog/42-remote-ref-discovery-and-refspec-fetch.md).
- Ignored-tree pruning, commit tracker reseal, and full-status prepass reduction
  remain [54](../backlog/54-prune-ignored-directories-in-status-walk.md),
  [56](../backlog/56-reseal-index-tracker-on-commit.md), and
  [57](../backlog/57-single-prepass-in-full-status.md).
- Deployment, publishing, and production probes are not part of this sprint.

## Decisions

- Git paths are valid UTF-8 strings at the public boundary; invalid tree names
  fail closed — [ADR-0010](../decisions/0010-require-valid-utf8-git-paths.md).
- Safe branch deletion uses a resolvable configured upstream instead of HEAD;
  force bypasses reachability only, never checkout ownership.
- Default/configured fetch shapes auto-follow reachable tags. Explicit ref
  selection is tagless unless `tags: true`, matching Git.
- Pull separates fetch coverage from the single upstream it integrates. A
  present noncanonical fetch refspec fails `EUNSUPPORTED` until #42 lands.
- Gitlinks stay explicitly unsupported in distinct-type projection this sprint.

## Sequencing

| Wave | Units | Parallelism |
|---|---|---|
| 0 | WU0 shared seams | one implementer, then leader verification and commit |
| 1 | WU1, WU3, WU4 | three disjoint implementers |
| 2 | WU2 | one implementer after seams; reviews of wave 1 run in parallel |
| 3 | WU5 and integrated gates | sequential integration and closure |

Each implementation receives an independent review from an agent that did not
write it. The leader runs and judges every gate and creates every commit.

## Run log

- The user approved the UTF-8-only and no-gitlink boundaries before execution.
- #55 joined #50 because both otherwise rewrite the same sparse untracked path.
- Independent reviews caught and closed branch-delete publication races,
  untrusted-row validation gaps, conflict lifecycle witness gaps, status budget
  gaps, and tag-authentication edge cases before integration.
- WU1 added one shared compare-and-delete store seam so the merged proof and ref
  deletion remain in the same SQLite transaction.
- Concurrent additions initially reused committed IDs 58 and 59. Those IDs stay
  stable; the new bounded-add and subtree-reuse items use 61 and 62 instead.
- The final CPU-leased full suite, typecheck, Biome check, build, and docs lint
  all passed before archive.
