> **OUTCOME — shipped 2026-08-26.** A journey layer now sits above the
> per-operation suite: `tests/helpers/e2e.ts` plays a bounded action DSL against
> kompjutr and the `git` binary at once and compares the whole public repository
> state after every step, and six journey files exercise it. Commit map: WU1 →
> `10a4fd7`, WU2 → `db50ef6` (with harness corrections `696379d` and `b681001`),
> WU3 → `0aa9f8a`. Verification: `npx vitest run tests/e2e/` → 94 passed across 7
> files; full suite 1868 passed, the only 2 failures belonging to the concurrent
> reflog sprint (`pull.test.ts`, `reflog-api.test.ts`); `tsc --noEmit` and
> `biome check` clean. Backlog closed: none — this sprint consumed no backlog
> item. Deferred: the six divergences the journeys uncovered are **pinned in the
> tests but not fixed**, and need triage before any become work (see below).

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

- **The harness had three defects of its own**, all found by running journeys
  rather than by review, and all fixed in the seam: `--delete` paired with a
  colon refspec (git rejects the combination), a `ref` without a `remoteRef`
  silently pushing the checked-out branch instead, and `pull` mirrored as
  `git merge <ref>` — which labels a conflict hunk with the ref name, where
  real `git pull` merges the fetched commit and labels it with the OID, as
  kompjutr does. Transient; the commits hold the record.

- **The mid-rebase relaxation had to widen once.** Masking porcelain v2's two
  HEAD-derived *fields* was not enough: a whole ordinary row can be
  HEAD-derived, since a path held by the branch tip but not the new base shows
  as deleted on one side and is absent on the other. While a rebase is pending
  only unmerged, untracked and ignored rows are compared now. Worktree bytes,
  index paths, refs and the pending operation stayed under full comparison, so
  no coverage was lost — only rows that cannot be compared between the two
  designs. → recorded in `../../tests/CLAUDE.md`.

- **Six divergences from Git surfaced. None is fixed; each is pinned by a test
  that turns red when kompjutr changes.** They need triage — two look like
  defects, three like undocumented deliberate narrowings, one like reference
  drift:

  | # | Finding | Reads as |
  |---|---|---|
  | 1 | `status` drops the untracked row left by `rm --cached`: git reports the path twice (`1 D.` and `? path`), kompjutr once. `status.ts` ("a tracked path is never also untracked") and `status-rows.ts` ("the file, if any, shows up as untracked instead") contradict each other. | defect |
  | 2 | A symlink-versus-file conflict is not relocated. Git splits the path (`lnk` stage 3, `lnk~HEAD` stage 2); `projectMergePlan` relocates only `file/directory`. | unimplemented case |
  | 3 | `fetch` never auto-follows tags reachable from fetched refs; `tags: true` is required. | narrowing, undocumented |
  | 4 | `pull` updates only its own upstream tracking ref — `singleBranch ?? true` plus an exact `remoteRef`, where `git pull` runs the full `+refs/heads/*` refspec. | narrowing, undocumented |
  | 5 | `add` of an explicitly named ignored path succeeds silently; git exits 1. Intent is stated in `staging.ts`, not in the reference. | narrowing, undocumented |
  | 6 | The `revParse` row claims annotated tags peel to their commit. They do not — and not peeling is what matches `git rev-parse`. | reference drift |

  Findings 3–6 are documentation work on
  [`../reference/git-support.md`](../reference/git-support.md); 1 and 2 are
  candidate backlog items. Left un-filed deliberately: whether a narrowing is a
  gap or a decision is not the test suite's call to make.

