> **OUTCOME — shipped 2026-09-26.** Status and clean use structural limits for
> retained paths; `rm` uses bounded multi-pass planning instead of modeled
> object charges. Pure forwarding store wrappers and a duplicate text guard
> were removed. Commit map: WU1 → `2bb0c88`, HEAD-path follow-up → `4ab2ecd`;
> WU2 → `d0a50c1`; WU3 → `4a90e84`; documentation → this closing commit.
> Verification: status and sparse status 112 passed; staging 54 passed; smoke
> 160 passed; typecheck and Biome clean; final `test:full` 3,695 passed in 17
> slices, 740.4 s wall with two lanes under a 4 vCPU lease. An earlier full run
> had one temporary Git-fixture failure; its exact test passed in isolation.
> Backlog closed: 66. Deferred: caller-text validation in 96, checkout charges
> in 97, remaining architecture slices in 98–104, and eager status result
> memory in 105. No <100 MiB measurement is claimed for status, clean, or rm.

# Sprint — Retire modeled charges and pure forwarding twins (2026-09-26)

**Goal.** Bound retained status and rm structures by their actual cardinality, and remove the first behavior-preserving duplicates from backlog 65.

## Refs re-verified at HEAD (2026-09-26)

- ✔ Status retains tracked paths and directory prefixes against a modeled byte charge — `packages/git/src/ops/status/status-full.ts:333-378`; `clean` has the same pattern — `status-clean.ts:108-175`.
- ✔ The index path is capped at 8 KiB — `packages/git/src/store/schema/schema-constants.ts:3`; status streams full index rows — `status-full.ts:327`.
- ✔ `rm` caps pathspecs at 10,000 and each source stream at 50,000 rows, but does not cap the derived directory set — `staging-rm.ts:199-242`, `staging-rm-worktree.ts:15-45,96-156`.
- ✔ `readShallowOwned` and `configGetOwned` are forwarding-only functions — `packages/git/src/store/refs/shallow.ts:8-14`, `refs/config.ts:24-33`; `requireMergeText` duplicates the stored-text guard with its exact message shape — `operations/operations-merge.ts:112-115`, `common/rows.ts:118-121`.
- ⚠ The UTF-8 defect in ARCH-27 changes caller input acceptance, so it needs its own witness and review; it is not part of a validator-only cleanup — `docs/backlog/65-git-sqlite-architecture-review.md:45-55`.

## Work units

### WU1 — Status and clean retained sets (M)

- **Problem.** Only modeled bytes bound tracked paths and directory sets.
- **Verify first.** Re-run the existing status scale and retained-cap tests.
- **Scope.** Count distinct retained paths and directory prefixes before insertion. Bound clean's staged index, untracked result, snapshot arrays, protected set, and returned entries as one finite operation; its directory-removal traversal sees only paths admitted by the snapshot. Reject untracked worktree paths above the existing 8 KiB index-path limit before retention, including in the collapsed status stream. The count and per-path caps bound cardinality and string length, not a guaranteed <100 MiB peak for pathological near-limit names.
- **Acceptance / witness.** The 24,252-path scale case still passes; count-boundary and oversized-untracked-path tests fail with `E2BIG` before retention, including a collapsed directory containing many files and dry-run/removal parity. Run `npx vitest run tests/status.test.ts`.
- **Touch points.** `packages/git/src/ops/status/`, `tests/status.test.ts`, reference and ADR-0005.

### WU2 — rm retained structures (M)

- **Problem.** Candidate counts follow the 50,000-row cap, but directory prefixes can multiply and are only byte-charged today.
- **Verify first.** Re-run rm's pathspec and large-index tests; inspect path bounds and iterator behavior.
- **Scope.** Give derived directories a count cap; remove modeled candidate, pathspec, directory and array charges. Keep the actual filesystem JSON binding limit. Bound normalized pathspecs by the store's 8 KiB index path limit. Preflight pathspecs and safety on separate bounded stream passes, then remove through bounded index pages and a single worktree cursor, so the operation never retains all selected path strings or symlink targets.
- **Acceptance / witness.** `npx vitest run tests/staging.test.ts` exercises pathspec and directory caps, large-index rm, long symlink targets across hash windows, conflict stages across index pages, and error atomicity; no rm modeled charge remains.
- **Touch points.** `packages/git/src/ops/staging/staging-rm*.ts`, `tests/staging.test.ts`.

### WU3 — First pure duplicates in 65 (S)

- **Problem.** Two functions merely forward to an already accessible store method; the stored-text validator repeats the shared guard.
- **Verify first.** Check every caller of those wrappers and compare error messages for the text guard.
- **Scope.** Remove forwarding functions and update callers; use the shared text guard without changing diagnostics. Split remaining 65 findings into small follow-ups, with UTF-8 validation separate.
- **Acceptance / witness.** `npx vitest run tests/merge-base.test.ts tests/refs.test.ts tests/store.test.ts tests/store-module-exports.test.ts`, then `npm run typecheck`; remaining backlog names distinct acceptance witnesses. Preserve direct (uncached) shallow reads and validated config reads.
- **Touch points.** `packages/git/src/store/{refs,operations,index.ts}`, `packages/git/src/ops/{repository,merge}`, `docs/backlog/65-git-sqlite-architecture-review.md`.

## Review strategy

| Scope | Required gate and review | Escalate when |
|---|---|---|
| WU1 | Independent review of all retained clean/status collections and focused status suite | A count cap rejects the 24,252-file fixture or fails to bound a collection |
| WU2 | Independent review of directory bound and mutation atomicity, focused staging suite | A path-size limit below the stored-index limit or changed mutation safety is needed |
| WU3 | Focused caller audit and relevant suites; independent review if behavior changes | A validator changes error taxonomy or input acceptance |
| Integration | `npm test` (<30 s target), `npm run typecheck`, `npm run check`, then one `npm run test:full`; rereview WU1/WU2 after substantive bound fixes | A failing focused witness or a measured regression |

## Test cadence

Run each focused witness after its WU, `npm test` after integration, then one exhaustive suite at closure. The current `bench/memory-protocol.ts` has no status, clean, or rm scenario: do not claim it measures these changes. Add direct memory evidence as a separate benchmark follow-up if the representative target is in doubt. Format and lint before commits.

## Out of scope

ARCH-27's lone-surrogate input fix, remaining 65 refactors, and modeled charges outside status/rm remain separate work. The <100 MiB goal is a representative-operation target, not a worst-case guarantee for 8 KiB names.

## Decisions

Keep the JSON removal binding limit because it measures serialized payload, unlike the removed object estimates.

## Sequencing

WU1 and WU2 precede WU3 integration; the count limits must be reviewed before removing either byte charge.

## Plan review

- **Reviewer:** independent general agent, three passes against HEAD
- **Verdict:** approved
- **Material findings:** Added clean's uncapped collections and the 8 KiB untracked-path bound, narrowed memory claims to representative targets, and corrected the focused test files. Earlier blocking reviews were resolved before implementation.

## Run log

- WU1: the 24,252-file status case and the first-excess tracked path passed. A collapsed directory with 30,001 untracked files fails both dry-run and removal before mutation. Worktree paths over 8 KiB fail only when visible; hidden paths do not block ordinary status.
- WU2: the former 16 MiB rm workload now succeeds. The 10,001st derived directory and the 10,001st pathspec fail before mutation; the JSON removal binding stays in place.
- WU3: removed the shallow/config forwarding functions and reused `expectText` for merge journal text. Split the remaining findings into [96](../backlog/96-validate-git-caller-utf8-at-boundaries.md) and 98–104, mapped in [65](../backlog/65-git-sqlite-architecture-review.md), with independent witnesses. Kept uncached shallow and validated config methods. The default Vitest forks pool produced an `onTaskUpdate` timeout in the large store test despite all assertions passing; the project full-suite runner uses threads for that slice.
- Independent review found the optional sparse reseal seed could retain unbounded untracked paths. Added a 50,000-path seed cap and disabled reseal for oversized paths; status reporting remains unaffected. Re-review: no findings. Existing memory benchmark scenarios do not cover status/clean/rm; no <100 MiB claim is made for this change.
- Source inspection found modeled checkout charges outside 66's named sites. Recorded as [97](../backlog/97-audit-checkout-modeled-byte-charges.md), without expanding this sprint.
- After the first successful full suite, independent review exposed a valid near-8-KiB-path `rm` set whose 50,000-row count still permitted an isolate-sized retained candidate array. The user approved a multi-pass streaming planner and batched symlink hashing. `tests/staging.test.ts` passed; independent review found no defect, and a focused conflict-page witness was added. Re-run the closure suite because the planner changed after its first run.
- The second full suite passed after the `rm` planner change (751.0 s, two lanes). A subsequent review found that a long HEAD-only path could enter a status row in `all`/`no` modes or the rename classifier before the tracked-path guard. Guarded both retention points; all six mode/rename combinations pass the new witness. `tests/status.test.ts` and `tests/status-sparse.test.ts` passed (112 tests), and independent re-review found no defect.
- A proposed 30,000-row cap on eager status results failed an existing 32,001-row sparse reseal witness. Reverted the proposal to preserve valid input; the user chose a separate measurement and policy follow-up in [105](../backlog/105-measure-eager-status-result-memory.md). The internal tracked-path snapshot and clean collections remain structurally bounded, but eager result memory has no measured <100 MiB claim.
- One full-suite run failed in the unrelated real-Git OFS-delta fixture when `git rev-list --all --objects` could not read a parent object in its temporary repository. The exact test passed on immediate isolated reproduction. The final full suite passed (3,695 tests, 740.4 s); no source change was made for the transient fixture failure.
