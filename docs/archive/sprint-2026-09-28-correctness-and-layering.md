> **OUTCOME — shipped 2026-09-28.** Ref text rejects a trailing lone high
> surrogate at its one shared check; the import-graph witness enforces Git
> peer and DO domain rules again; status prunes directories through prefix
> lookups; ops no longer query `git_refs`; relative Git path helpers and the OID
> check live in the shared kits. Commit map: WU2 → `8878756`, WU1 → `75271fa`,
> WU3 → `edfa1ab`, WU5 → `a8569ed`, WU4 → `9329dfc`; documentation → this
> closing commit. Verification: `npm test` 160 passed; typecheck and Biome
> clean; final `test:full` 3,721 passed in 17 slices, 742.9 s wall with two
> lanes under a 4 vCPU lease. Backlog closed: 80, 96, 100, 101, 104.
> Deferred: CLI `git branch` still prints the store's EINVAL message rather
> than Git's wording for an invalid name; this predates the sprint and has no
> caller asking for it.

# Sprint — Correctness and layering (2026-09-28)

**Goal.** Fix the reproduced lone-surrogate defect, restore the weakened
architecture witness, and land three small structural fixes.

**Theme.** Every item is bounded, has a direct witness, and touches Git text,
path or layer boundaries. The batch succeeds when all five backlog items are
closed, the restored witness passes on the current source, and no public result
changes except the rejection of noncanonical UTF-16.

## Refs re-verified at HEAD (2026-09-28, `51fb9b5`)

- ✔ `updateRef` accepts `refs/heads/x\uD800`; `resolveRef` with the same name
  returns `null` (temporary probe, 2026-09-28).
- ⚠ The root cause is one shared check, not missing routing. `checkRefText`
  reads `value.charCodeAt(index + 1)` past the end for a trailing high
  surrogate; `NaN` fails both range comparisons, so the unit is accepted —
  `packages/git/src/common/ref-name.ts:18-24`. Ref names, symbolic targets and
  reflog metadata already route through it — `store/refs/ref-validation.ts:11-20`,
  `store/refs/reflog.ts:212-218`. About 20 callers use it, including refspecs,
  push plans, branch upstreams, worktrees, protocol parsing, JSON pages and the
  config store.
- ✔ The existing witness covers only a lone low surrogate —
  `tests/refs.test.ts:215`. The ops config check handles the trailing case
  correctly with its own loop — `ops/refs/config.ts:132-157`.
- ✔ The import-graph witness merges `diff`, `ignore` and `protocol` into one
  `algorithm` slice and skips same-slice edges — `tests/import-graph.test.ts:34-42,152,217`.
  `gitSlice` returns `null` outside Git, so no `@kompjutr/do` domain rule runs —
  `tests/import-graph.test.ts:149,217`. The pre-extraction witness had those
  rules — `git show 6fa72a5:tests/import-graph.test.ts` lines 8-9 and 154-178.
- ✔ Current DO source respects the old domain rules: `db` imports only
  `@kompjutr/sqlite`; `fs` imports `db`, `drive`, `sqlite`; `shell` imports
  `db` and `fs`; only `runtime` imports `@kompjutr/git` and `@kompjutr/git/do-fs`.
- ✔ `hasTrackedPath` scans every retained tracked path for each prune
  decision — `ops/status/status-full.ts:245-246,263-277`. In collapse mode, the
  index prepass also retains every tracked ancestor directory in `trackedDirs`,
  capped at 30,000 — `status-full.ts:321-338`. In `all` or `no` mode with
  exclude roots, `trackedDirs` stays empty. Both prepasses retain only index
  paths, in index-scan (`comparePaths`) order — `status-full.ts:59-99,302-313`.
  Merge-stream additions (`status-full.ts:195`) never reach a prune decision:
  the walker prunes `d` before it yields anything below `d` —
  `ops/worktree/worktree-io-walk.ts:128`.
- ✔ Two ops queries name `git_refs`: `refExists` — `ops/refs/refs-branches.ts:307-316`
  (two callers, lines 34 and 260), which does not validate the name; and
  `expandRefOwned` —
  `ops/repository/repository-refs.ts:47-64`. The store ref family already reads
  single refs, but validates the name first — `store/refs/refs.ts:164-172`.
  `branchRef` and `tagRef` reject only `""` — `ops/refs/refs-branches.ts:296-304`.
- ⚠ The common path helpers are not drop-in replacements. `dirnameOf` and
  `basenameOf` normalize to absolute paths — `common/paths.ts:5-17,56-65`. The
  duplicates work on relative Git paths: `parentPath`, `basename`, `pathDepth` —
  `ops/tree/tree-build-common.ts:52-69`; a local `basenameOf` —
  `ops/status/rename-detection.ts:211-213`; and a second `pathDepth` that returns
  1, not 0, for `""` — `ops/staging/staging-rm-worktree.ts:152-158`.
- ✔ `validOid` repeats `isOid` exactly — `ops/tree/tree-build-common.ts:48-50`,
  `common/bytes.ts:40-42`. It is called from `ops/tree/tree-build-full.ts:16,117,209`.
- ✔ WU1 cannot fail a stored row. The only stored-row caller of the check is
  `store/maintenance/roots/root-contracts.ts:127`, and SQLite TEXT cannot hold
  a lone surrogate: binding replaces it with U+FFFD, which is the reproduced
  symptom. `store/core/json-pages.ts:116` receives only `JSON.stringify` output,
  which escapes lone surrogates, and `protocol/discovery.ts` receives decoded
  network bytes. Every caller keeps its error code and message, because the
  problem kind is unchanged.

## Work units

### WU1 — Reject a trailing lone high surrogate (S) — backlog 96

- **Problem.** `checkRefText` accepts a string that ends in a high surrogate.
  Storage changes the text, so the caller cannot read back what it wrote.
- **Verify first.** Add the failing public witness: `updateRef` with
  `refs/heads/x\uD800`. List every `checkRefText` and `refTextBytes` caller
  and confirm each maps `noncanonical-utf16` to a rejection before any write.
- **Scope.** Fix the check in `common/ref-name.ts`, the module that owns it.
  Keep each caller's error code and message. Do not rewrite the separate
  loops in `ops/refs/config.ts` or `ops/core/journal-input.ts`; they already
  reject this input.
- **Acceptance / witness.** Extend the rejection table at `tests/refs.test.ts:215`
  (it tests `expandRef`) with a trailing high surrogate and a lone high
  surrogate before an ASCII unit. Add separate cases: `updateRef` rejects
  `refs/heads/x\uD800`; a valid supplementary scalar in a ref name succeeds and
  reads back; a symbolic ref target and reflog metadata (reason and actor) with
  a trailing high surrogate are rejected. Each rejection leaves the ref table
  and reflog unchanged. Run
  `npx vitest run tests/refs.test.ts tests/reflog-api.test.ts tests/refspec-contract.test.ts tests/client.test.ts`.
- **Touch points.** `packages/git/src/common/ref-name.ts`, `tests/refs.test.ts`,
  `tests/reflog-api.test.ts`.

### WU2 — Restore peer and domain rules in the import-graph witness (M) — backlog 80

- **Problem.** The witness no longer enforces two documented rules: Git's
  `diff`, `ignore` and `protocol` must not import one another
  (`packages/git/src/CLAUDE.md:16-17`), and the DO domains must point down
  (`db` ← `fs` ← `shell`; `runtime` composes them and Git).
- **Verify first.** Run the current witness. Compare the pre-extraction rules
  at `6fa72a5` with the current `packages/do/src` layout (`db`, `fs`, `shell`,
  `runtime`, and the top-level `index.ts`, `git-shell.ts`, `testing.ts`).
- **Scope.**
  1. Give `diff`, `ignore` and `protocol` distinct identities with equal rank.
     Reject an edge between two of them.
  2. Restore the DO domain rules. `db` imports no domain. `fs` imports `fs` or
     `db`. `shell` imports `shell`, `fs` or `db`. `runtime` may import every DO
     domain. Top-level DO entry files may import any domain.
  3. Apply the domain rules to relative imports and to `@kompjutr/do/*`
     specifiers, mapped to their domain, including type-only edges.
     `@kompjutr/sqlite` and `@kompjutr/drive` stay under the package rule only.
     `@kompjutr/git` and `@kompjutr/git/do-fs` are allowed only from `runtime`
     and the top-level DO files.
  4. Separate the rule function from the source scan so that fixture edges can
     exercise it directly.
- **Acceptance / witness.** `npx vitest run tests/import-graph.test.ts` passes on
  the current source. New fixture cases prove allowed downward edges (for
  example `git/diff → git/common`, `do/fs → do/db`, `do/runtime → @kompjutr/git/do-fs`)
  and rejected edges (for example `git/diff → git/ignore`, `do/db → do/fs`,
  `do/fs → do/shell`, `do/shell → @kompjutr/git`, `do/fs → @kompjutr/git`, and a
  type-only `do/fs → do/shell`).
  Existing package, platform, `do-fs` and cycle checks stay unchanged.
- **Touch points.** `tests/import-graph.test.ts`.

### WU3 — Use tracked prefixes in status pruning (S) — backlog 101

- **Problem.** Each ignored or excluded directory scans every retained tracked
  path, so the cost is tracked paths × ignored directories.
- **Verify first.** Confirm that both prepasses retain index paths in
  `comparePaths` order and that no merge-stream addition precedes a prune
  decision for an ancestor of that path.
- **Scope.** Replace the linear scan in `hasTrackedPath` (used by the prune
  callback and by `prunableExcludeRoots`) with lookups over the same
  membership: the prepass index paths.
  - Collapse mode: prune `d` only when `!trackedPaths.has(d) && !trackedDirs.has(d)`;
    `trackedDirs` already holds every index ancestor.
  - `all` or `no` mode with exclude roots: a `Set` cannot be binary-searched,
    so add a sorted array that mirrors the prepass `trackedPaths`. Fill it in
    `retainStatusIndexPath`; the existing `STATUS_MAX_PATHS` check bounds it.
    Binary-search it with `comparePaths` for `d` and the `d/` prefix range.
  - Add no directory set and no new cap: a tree with fewer than 30,000 files
    can have more than 30,000 ancestor directories, and that status must keep
    passing. Do not add a scalar SQL read per path.
- **Acceptance / witness.** `npx vitest run tests/status.test.ts tests/status-sparse.test.ts`
  passes, including the prune cases at `tests/status.test.ts:1165` and `:1187`.
  Regression guards: a tracked file below an ignored directory is not pruned
  with an exclude root in `all` mode and with rename detection on. The
  collapse case without an exclude root stays covered by `:1187`. Cost
  evidence: time one status over about 20,000 tracked paths and 5,000 ignored
  directories, `all` mode with an exclude root, before and after the fix under
  `cpu-lease run -n 2 --no-smt`, and record both numbers in the run log. Add no
  test-only counting hook to source.
- **Touch points.** `packages/git/src/ops/status/status-full.ts`, `tests/status.test.ts`.

### WU4 — Move ref probes behind the store seam (S) — backlog 104

- **Problem.** Two ops functions query `git_refs` directly.
- **Verify first.** List the names the two `refExists` callers can pass after
  `branchRef` and `tagRef`, and the error each invalid name produces today.
- **Scope.** Replace `refExists` with the store read. This validates the name
  earlier: an invalid branch or tag name fails with the store's `EINVAL`
  message before any later check. Accept that change (see Decisions) and add
  a witness for it. Move the six-candidate
  expansion query into the store ref family and expose it through the store
  interface the ops code already uses. Keep the candidate order, the
  `CorruptError` for an invalid stored value, and one statement per candidate
  at most.
- **Acceptance / witness.** `npx vitest run tests/refs.test.ts tests/import-graph.test.ts tests/store-module-exports.test.ts`
  and `npm run typecheck` pass. A new case shows `branch` and `tag` rejecting an
  invalid name with `EINVAL` and without writing a ref. `git grep git_refs -- packages/git/src/ops` prints
  nothing.
- **Touch points.** `packages/git/src/ops/refs/refs-branches.ts`,
  `packages/git/src/ops/repository/repository-refs.ts`,
  `packages/git/src/store/refs/refs.ts`, the store interface that exposes it.

### WU5 — Consolidate equivalent Git path and OID helpers (S) — backlog 100

- **Problem.** Relative Git path helpers are repeated in three ops modules, and
  `validOid` repeats `isOid`.
- **Verify first.** Confirm that the rm sort (`staging-rm-worktree.ts:146`)
  receives only non-root directories, so the `""` difference cannot matter.
- **Scope.** Put one relative parent, basename and depth helper in
  `common/paths.ts`, next to the absolute helpers, with names that say they
  take relative Git paths and do not collide with `basenameOf`. Replace the copies in `tree-build-common.ts`,
  `rename-detection.ts` and `staging-rm-worktree.ts`. Replace `validOid` with
  `isOid`. Leave inline ancestor loops that do not declare a helper unchanged.
- **Acceptance / witness.** `npx vitest run tests/paths.test.ts tests/tree-build-preflight.test.ts tests/checkout-sparse.test.ts tests/commit.test.ts tests/rename-detection.test.ts tests/staging.test.ts`
  and `npm run typecheck` pass. `tests/paths.test.ts` covers the new helpers
  for `""`, a top-level name and a nested path.
- **Touch points.** `packages/git/src/common/paths.ts`,
  `packages/git/src/ops/tree/tree-build-common.ts`,
  `packages/git/src/ops/tree/tree-build-sparse.ts`,
  `packages/git/src/ops/tree/tree-build-full.ts`,
  `packages/git/src/ops/status/rename-detection.ts`,
  `packages/git/src/ops/staging/staging-rm-worktree.ts`, `tests/paths.test.ts`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Five disjoint slices; only WU1 changes accepted input | `npm test`, `npm run typecheck`, `npm run check`, then one `npm run test:full` | A focused witness fails after integration, or a full-suite failure reproduces in isolation |
| WU1 | Changes public input acceptance in a check with about 20 callers | Focused witness; independent review of the caller list and of error codes; re-review after any substantive fix | A caller needs a different error code, or a stored row with a trailing high surrogate can already exist |
| WU2 | Test-only, but it guards every future change | Focused witness; independent review that each documented rule has a positive and a negative fixture | The restored rules find a real forbidden edge in source: stop and ask before changing source |
| WU3 | Changes a hot path in status; wrong membership hides or shows files | Focused witness; independent review of prune membership in each mode | The fix needs a new cap that rejects a case that passes today |
| WU4 | Moves queries behind an existing seam and validates branch and tag names earlier | Focused witness and typecheck; independent review of the earlier validation and the moved expansion query | Result or statement count changes beyond the accepted earlier `EINVAL` |
| WU5 | Mechanical consolidation | Focused witness and typecheck; no independent review unless a helper result changes | A caller depends on the old `""` result |

## Test cadence

- **Per WU.** Run the exact acceptance witness above. No WU crosses into the
  filesystem, shell or E2E domains.
- **Routine integration.** Run `npm test` after each WU commit; keep it below
  30 seconds.
- **Sprint closure.** Run `cpu-lease run -n 4 -- npm run test:full` once, after
  final review and focused fixes. The last run took 740–757 s.
- **Failure loop.** Reproduce a full-suite failure with its exact file.
  Rerun the full suite only after the focused witness is stable.
- Run `npm run format` and `npm run check` before each commit.

## Out of scope (explicit)

- The separate text loops in `ops/refs/config.ts:132-157` and
  `ops/core/journal-input.ts:10-24`. They are correct today; merging them into
  `checkRefText` changes error messages.
- The other direct `store.db` reads in `packages/git/src/ops`. Backlog 104 names
  only `git_refs`.
- Inline ancestor loops in checkout, sparse checkout, reads and lifecycle
  (`lastIndexOf("/")` walks without a helper).
- A plan-purity rule for `do/src/shell/plan/` (no `../fs/` imports). It is
  documented but was not in the pre-extraction witness either.

## Decisions

- WU1 fixes the shared check instead of adding new routing. Every input family
  that backlog 96 names already calls it.
- WU4 accepts earlier validation of branch and tag names. The store read
  validates at the boundary (root invariant 4). Keeping an unvalidated
  existence probe in the store only to preserve a later error message is not
  worth a second read path. The project has no compatibility requirement.
- WU3 adds no directory set and no cap. The prune membership is the prepass
  index paths. Collapse mode answers from `trackedDirs`; the other modes add
  one sorted array bounded by the existing `STATUS_MAX_PATHS` check.
- WU5 adds relative Git path helpers to `common/paths.ts` instead of reusing
  `dirnameOf` and `basenameOf`, because those normalize to absolute paths.

## Sequencing

WU1 and WU4 both touch `expandRef` and `tests/refs.test.ts`, so WU4 runs after
WU1. The other WUs have disjoint write territories. WU2 first gives the rest a
stronger layer witness. Commit each WU separately.

| Order | WU | Note |
|---|---|---|
| 1 | WU2 | Stronger witness for the rest |
| 2 | WU1 | Independent review |
| 3 | WU3, WU5 | WU3 has independent review; disjoint from WU5 |
| 4 | WU4 | After WU1; independent review |

## Plan review

- **Reviewer:** independent general agent, two passes against `298aca8`.
- **Verdict:** first pass blocked; second pass approved with non-blocking
  findings, both resolved in this revision.
- **Material findings:**
  - Blocking: WU3's proposed ancestor set under `STATUS_MAX_DIRECTORIES` could
    reject a valid tree with fewer than 30,000 files but more ancestor
    directories. Replaced by lookups over the prepass index paths, with no new
    set or cap.
  - WU3's regression witness passed before the fix; added a cost witness.
  - WU4 validates branch and tag names earlier; recorded as a decision with a
    witness and an independent review.
  - WU1's table witness tests `expandRef` only; moved the success and
    `updateRef` cases out of it and sequenced WU4 after WU1. Recorded why
    stricter checking cannot fail a stored row.
  - WU2 package-specifier wording would have rejected current
    `@kompjutr/sqlite` and `@kompjutr/drive` imports; reworded.
  - WU5 was missing `tree-build-full.ts`; added.
  - Second pass: `all`/`no` mode needs a sorted array, not a lookup in an
    existing structure; worded as a bounded array. The cost witness had no
    observable counter; replaced by a leased before/after timing in the run
    log.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- WU2: the restored rules found no forbidden edge in current source. Review
  added a `@kompjutr/git/do-fs` rejection, a positive `@kompjutr/do/*` edge, a
  type-only edge routed through the rule, and a check that every DO file sits
  in a domain.
- WU1: the new witnesses failed before the fix. Review confirmed every caller
  keeps its code and message, and that SQLite stores a lone surrogate as
  U+FFFD, so no stored row can fail the stricter check. The witness moved to
  the guarded `Repository.mutateRefs`.
- WU3: a temporary mutation that ignored `trackedDirs` failed the new and the
  existing prune witnesses. Timing over 20,000 tracked paths and 5,000 ignored
  directories (`all` mode, exclude root, `cpu-lease run -n 2 --no-smt`, three
  samples after a warm-up): 1,875–2,564 ms before, 465–519 ms after. Review
  added exclude-root cases with rename detection and in `no` mode.
- WU4: review confirmed the expansion is unchanged; the store now rejects
  `HEAD`, which ops answers first. The invalid-name witness moved to its own
  block.
- WU5: rm derives only non-empty directories, so the shared `gitPathDepth("")
  = 0` changes no sort order.
