# Sprint — end-to-end journeys (2026-08-26)

**Goal.** Add a journey layer to the suite: realistic multi-step Git workflows
played through the public surface against a real remote, with every step
checked against the `git` binary.

**Theme.** Coverage at HEAD is dense per operation and thin between them.
`merge-lifecycle`, `rebase-restart`, `pull` and `push` each prove their own
command in isolation, but nothing plays the sequence a developer actually
performs — clone, diverge, fetch, integrate, resolve, push — and nothing checks
that the *whole* repository state still matches Git after each move. A defect
that only appears when two correct operations meet has no test that can see it.
The batch succeeds when a journey can be written as a list of steps and the
suite, not the author, decides whether kompjutr behaved like Git.

## Refs re-verified at HEAD (2026-08-26)

- ✔ `helpers/git-parity.ts` compares whole public state, but its action union
  covers local commands only — no merge, rebase, replay, or network op —
  `tests/helpers/git-parity.ts:36`.
- ✔ `helpers/http-backend.ts` serves a real repository through
  `git http-backend`, and `push.test.ts` already pushes into it —
  `tests/helpers/http-backend.ts:56`.
- ✔ Only two test files combine the served remote with integration
  (`pull.test.ts`, `client.test.ts`), and both do so at single points.
- ✔ Smart HTTP over `http(s)` is the only transport; a local-path remote throws
  `EURLSCHEME`, so "local pull/push" means a locally served origin —
  `docs/reference/git-support.md`, Remotes and network.
- ✔ `GitFixture` pins `GIT_*_DATE` and identity, and `makeWorkspace` starts its
  clock at the same instant, so both sides hash a given commit identically —
  `tests/helpers/git.ts:21`, `tests/helpers/workspace.ts:38`.
- ⚠ Mid-rebase the two designs place HEAD differently on purpose: Git detaches
  onto the new base, kompjutr keeps the branch at its original OID while the
  journal owns unpublished results — `docs/reference/git-support.md`,
  `git rebase`. Any whole-state comparison has to account for it.

## Work units

### WU1 — the differential journey harness (effort L)

- **Problem.** No harness can express a journey. `git-parity.ts` stops at local
  commands and has no remote, no second actor, and no notion of a conflicted
  outcome.
- **Verify first.** Confirm both sides hash an identical commit to the same OID,
  and that `formatPorcelainV2` output can be compared to `git status
  --porcelain=v2` verbatim.
- **Scope.** `tests/helpers/e2e.ts`: a bounded action DSL covering worktree,
  index, refs, integration and network operations; three outcome kinds
  (`clean` / `conflicted` / `failed`); a whole-state snapshot compared after
  every step; a private bare origin per side so pushes never race; a colleague
  clone per side for injected work; a `reopen` step modelling Durable Object
  eviction; a `custom` escape hatch so journeys never need to edit the seam.
- **Acceptance / witness.** `tests/e2e/harness.test.ts` plays a clone, a commit,
  a conflicting merge through resolution, a push, and a colleague's work
  arriving through pull — all green with no journey-side assertions about Git.
- **Touch points.** `tests/helpers/e2e.ts`, `tests/e2e/harness.test.ts`.

### WU2 — journey files (effort L)

- **Problem.** The harness proves nothing on its own.
- **Verify first.** Each area's support boundary in
  `docs/reference/git-support.md` before writing a case for a flag.
- **Scope.** Six files under `tests/e2e/`, disjoint by subject:
  `solo-workflow` (one developer, no remote), `collaboration` (fetch/pull/push
  happy paths, two actors), `conflicts` (the conflict matrix through merge,
  cherry-pick and revert), `rebase` (replay, conflict, continue/skip/abort,
  refusals), `recovery` (a cold reopen inside every long operation),
  `push-lifecycle` (the life of a pushed ref, including rejection and force).
- **Acceptance / witness.** Every file green under `npx vitest run tests/e2e/`,
  with `tsc --noEmit` and `biome check` clean.
- **Touch points.** `tests/e2e/*.test.ts`.

### WU3 — record the layer (effort S)

- **Problem.** A harness nobody knows about gets bypassed.
- **Scope.** `tests/CLAUDE.md` gains the e2e entry and the rule that a journey
  never asserts Git behaviour it could ask for; the narrowed mid-rebase
  comparison is stated where a future author will look for it.
- **Acceptance / witness.** The file names `helpers/e2e.ts` and `e2e/`, and
  states the one relaxed comparison and why.
- **Touch points.** `tests/CLAUDE.md`.

## Out of scope (explicit)

- **Widening the harness to unsupported Git.** Partial clone, wildcard
  refspecs, `worktree`, `apply` and `ls-remote` stay gaps; they are already
  ranked in `../backlog/README.md`. Journeys test the surface that exists.
- **Replacing per-operation tests.** The journey layer sits above them. Nothing
  in `tests/*.test.ts` is consolidated or deleted.
- **Authentication journeys.** `tests/push.test.ts` already drives 401 and
  `onAuth` against the served backend.
- **Performance.** Cost assertions stay where the suite already makes them.

## Decisions

- **Differential-first, not assertion-based.** A journey states the steps; the
  `git` binary decides the expected state. This follows the existing rule in
  `tests/CLAUDE.md` and is why conflict marker bytes and porcelain v2 rows are
  compared rather than transcribed.
- **One bare origin per side, not one shared.** Two implementations pushing to
  one remote would race and the second push would be rejected for reasons that
  have nothing to do with correctness. Colleague work is injected into both
  origins through identical real-git peers, keeping them in lockstep.
- **The mid-rebase relaxation is narrow and stated.** Only HEAD, the current
  branch, the log and porcelain v2's two HEAD-derived fields are dropped, only
  while a rebase is pending. Refs, index stages, conflict bytes and the pending
  operation are still compared throughout, and full comparison resumes on
  completion or abort. Widening it would hide real defects.

## Sequencing

WU1 is the seam and lands first — every journey file depends on its API. WU2's
six files are independent of each other and run in parallel. WU3 follows WU2,
since it records what actually shipped.

## Run log

<!-- Append as you work. -->
