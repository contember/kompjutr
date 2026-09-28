<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

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
  `algorithm` slice and skips same-slice edges — `tests/import-graph.test.ts:34-42,152,211`.
  `gitSlice` returns `null` outside Git, so no `@kompjutr/do` domain rule runs —
  `tests/import-graph.test.ts:149,211`. The pre-extraction witness had those
  rules — `git show 6fa72a5:tests/import-graph.test.ts` lines 8-9 and 154-178.
- ✔ Current DO source respects the old domain rules: `db` imports only
  `@kompjutr/sqlite`; `fs` imports `db`, `drive`, `sqlite`; `shell` imports
  `db` and `fs`; only `runtime` imports `@kompjutr/git` and `@kompjutr/git/do-fs`.
- ✔ `hasTrackedPath` scans every retained tracked path for each prune
  decision — `ops/status/status-full.ts:245-246,263-277`. In collapse mode, the
  index prepass also retains every tracked ancestor directory in `trackedDirs`,
  capped at 30,000 — `status-full.ts:321-338`. Paths also enter `trackedPaths`
  in the rename prepass and in the merge stream — `status-full.ts:195,340-345`.
- ✔ Two ops queries name `git_refs`: `refExists` — `ops/refs/refs-branches.ts:307-316`
  (two callers, lines 34 and 260); and `expandRefOwned` —
  `ops/repository/repository-refs.ts:47-64`. The store ref family already reads
  single refs — `store/refs/refs.ts:164-172`.
- ⚠ The common path helpers are not drop-in replacements. `dirnameOf` and
  `basenameOf` normalize to absolute paths — `common/paths.ts:5-17,56-65`. The
  duplicates work on relative Git paths: `parentPath`, `basename`, `pathDepth` —
  `ops/tree/tree-build-common.ts:52-69`; a local `basenameOf` —
  `ops/status/rename-detection.ts:211-213`; and a second `pathDepth` that returns
  1, not 0, for `""` — `ops/staging/staging-rm-worktree.ts:152-158`.
- ✔ `validOid` repeats `isOid` exactly — `ops/tree/tree-build-common.ts:48-50`,
  `common/bytes.ts:40-42`.

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
- **Acceptance / witness.** Extend the table at `tests/refs.test.ts:215` with
  a trailing high surrogate, a lone high surrogate before an ASCII unit, and a
  valid supplementary scalar that must still succeed. Add public witnesses for
  a symbolic ref target and reflog metadata (reason and actor). Each rejection
  leaves the ref table and reflog unchanged. Run
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
     `db`. `shell` imports `shell`, `fs` or `db`, and never `@kompjutr/git`.
     `runtime` may import every DO domain, `@kompjutr/git` and
     `@kompjutr/git/do-fs`. Top-level DO entry files may import any domain.
  3. Check domain rules for relative imports and for `@kompjutr/*` package
     specifiers, including type-only edges.
  4. Separate the rule function from the source scan so that fixture edges can
     exercise it directly.
- **Acceptance / witness.** `npx vitest run tests/import-graph.test.ts` passes on
  the current source. New fixture cases prove allowed downward edges (for
  example `git/diff → git/common`, `do/fs → do/db`, `do/runtime → @kompjutr/git/do-fs`)
  and rejected edges (for example `git/diff → git/ignore`, `do/db → do/fs`,
  `do/fs → do/shell`, `do/shell → @kompjutr/git`, and a type-only `do/fs → do/shell`).
  Existing package, platform, `do-fs` and cycle checks stay unchanged.
- **Touch points.** `tests/import-graph.test.ts`.

### WU3 — Use tracked prefixes in status pruning (S) — backlog 101

- **Problem.** Each ignored or excluded directory scans every retained tracked
  path, so the cost is tracked paths × ignored directories.
- **Verify first.** For each mode (collapse, `all` or `no` with exclude roots,
  rename prepass), list which paths are in `trackedPaths` when a prune
  decision runs, and whether their ancestors are in `trackedDirs` at that point.
- **Scope.** Replace the linear scan with an exact path lookup plus a
  tracked-ancestor lookup that has the same membership as today. Reuse
  `trackedDirs` where it already holds every ancestor. Where it does not, keep
  ancestor directories next to `trackedPaths` under the existing
  `STATUS_MAX_DIRECTORIES` cap. Do not add a scalar SQL read per path.
- **Acceptance / witness.** `npx vitest run tests/status.test.ts tests/status-sparse.test.ts`
  passes, including the prune cases at `tests/status.test.ts:1165` and `:1187`.
  Add a witness in which a tracked file is a descendant of an ignored
  directory: without an exclude root, with an exclude root in `all` mode, and
  with rename detection on. The directory must not be pruned in any of them.
- **Touch points.** `packages/git/src/ops/status/status-full.ts`, `tests/status.test.ts`.

### WU4 — Move ref probes behind the store seam (S) — backlog 104

- **Problem.** Two ops functions query `git_refs` directly.
- **Verify first.** Confirm that `refExists` and `getRef(name) !== null` have
  the same result and error behavior for every name the two callers pass.
- **Scope.** Replace `refExists` with the store read. Move the six-candidate
  expansion query into the store ref family and expose it through the store
  interface the ops code already uses. Keep the candidate order, the
  `CorruptError` for an invalid stored value, and one statement per candidate
  at most.
- **Acceptance / witness.** `npx vitest run tests/refs.test.ts tests/import-graph.test.ts tests/store-module-exports.test.ts`
  and `npm run typecheck` pass. `git grep git_refs -- packages/git/src/ops` prints
  nothing.
- **Touch points.** `packages/git/src/ops/refs/refs-branches.ts`,
  `packages/git/src/ops/repository/repository-refs.ts`,
  `packages/git/src/store/refs/refs.ts`, the store interface that exposes it.

### WU5 — Consolidate equivalent Git path and OID helpers (S) — backlog 100

- **Problem.** Relative Git path helpers are repeated in three ops modules, and
  `validOid` repeats `isOid`.
- **Verify first.** Confirm that the rm caller never passes `""` to its
  `pathDepth`, or keep its current result for `""` explicitly.
- **Scope.** Put one relative parent, basename and depth helper in
  `common/paths.ts`, next to the absolute helpers, with names that say they
  take relative Git paths. Replace the copies in `tree-build-common.ts`,
  `rename-detection.ts` and `staging-rm-worktree.ts`. Replace `validOid` with
  `isOid`. Leave inline ancestor loops that do not declare a helper unchanged.
- **Acceptance / witness.** `npx vitest run tests/paths.test.ts tests/tree-build-preflight.test.ts tests/checkout-sparse.test.ts tests/commit.test.ts tests/rename-detection.test.ts tests/staging.test.ts`
  and `npm run typecheck` pass. `tests/paths.test.ts` covers the new helpers
  for `""`, a top-level name and a nested path.
- **Touch points.** `packages/git/src/common/paths.ts`,
  `packages/git/src/ops/tree/tree-build-common.ts`,
  `packages/git/src/ops/tree/tree-build-sparse.ts`,
  `packages/git/src/ops/status/rename-detection.ts`,
  `packages/git/src/ops/staging/staging-rm-worktree.ts`, `tests/paths.test.ts`.

## Review strategy

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | Five disjoint slices; only WU1 changes accepted input | `npm test`, `npm run typecheck`, `npm run check`, then one `npm run test:full` | A focused witness fails after integration, or a full-suite failure reproduces in isolation |
| WU1 | Changes public input acceptance in a check with about 20 callers | Focused witness; independent review of the caller list and of error codes; re-review after any substantive fix | A caller needs a different error code, or a stored row with a trailing high surrogate can already exist |
| WU2 | Test-only, but it guards every future change | Focused witness; independent review that each documented rule has a positive and a negative fixture | The restored rules find a real forbidden edge in source: stop and ask before changing source |
| WU3 | Changes a hot path in status; wrong membership hides or shows files | Focused witness; independent review of prune membership in each mode | The fix needs a new cap that rejects a case that passes today |
| WU4 | Mechanical move behind an existing seam | Focused witness and typecheck; no independent review unless behavior changes | Result, error or statement count changes |
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
- WU5 adds relative Git path helpers to `common/paths.ts` instead of reusing
  `dirnameOf` and `basenameOf`, because those normalize to absolute paths.

## Sequencing

All five WUs have disjoint write territories and can run in parallel. WU2
first gives the other WUs a stronger layer witness, so run it first when the
work is sequential. Commit each WU separately.

| Order | WU | Note |
|---|---|---|
| 1 | WU2 | Stronger witness for the rest |
| 2 | WU1 | Independent review |
| 3 | WU3 | Independent review |
| 4 | WU4, WU5 | Mechanical |

## Plan review

- **Reviewer:** pending
- **Verdict:** pending
- **Material findings:** pending

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->
