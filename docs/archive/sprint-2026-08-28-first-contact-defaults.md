> **OUTCOME — shipped 2026-08-28.** Optionless clone now fetches complete
> history, all branches, and normal tag coverage; explicit shallow and selection
> options remain opt-in. Native callers gained atomic branch rename, bounded
> typed remote URL access, and bounded default-glob filtering for tracked
> `lsFiles()` index/ref reads. Commit map: plan → `3cc78f2`; WU1 → `e1bbec6`;
> WU3 → `3b05a89`; WU4 → `4121ff7`; WU2 → `a7dbee7`; facade integration →
> `bdbb237`; remote bounds and facade validation → `5bec3c6` and `16d369d`;
> closure isolation witnesses → `9a09bc1` and `2cc3c28`; closure → this
> archived record. Verification: the routine gate passed 139 tests in 5.27 s;
> the complete sliced runner passed 2,721 tests with five known skips and zero
> failures, with its slowest 96-test E2E slice at 64.94 s. Typecheck, Biome,
> build, and diff validation passed. Independent T3 integration review approved
> the final implementation after affected fixes. Deferred: untracked and
> standard-ignore `lsFiles()` modes, mutating glob pathspecs, deepening,
> upstream and remaining remote lifecycle management, partial clone, SSH,
> abort signals, and force-with-lease.

# Sprint — First-contact defaults (2026-08-28)

**Goal.** Make the first operations issued by a real consumer behave like Git
without raw config access or a hidden shallow-history trap.

**Theme.** This sprint closes the small mismatches encountered immediately after
`init()` or `clone()`: complete clone defaults, branch rename, typed remote URL
access, and bounded glob selection for `lsFiles()`.

## Refs re-verified at HEAD (2026-08-28)

- ✔ An optionless clone still forces `depth: 1`, one branch, and no tags —
  `src/core/ops/network.ts:1473-1483`; the parity witness pins that old default at
  `tests/clone.test.ts:533-555`.
- ✔ Explicit `depth: 0` already negotiates complete history, so the default can
  change without adding a transport or storage shape —
  `src/core/ops/network.ts:1473-1484`, `tests/clone.test.ts:487-504`.
- ✔ Branch creation/deletion already publish refs and selected-checkout `HEAD`
  through the atomic ref-mutation seam, but there is no rename operation —
  `src/core/ops/refs.ts:37-129`, `src/core/repository.ts:339-341`.
- ✔ Branch config is ordinary relational config and supports multi-valued keys;
  existing reads materialize their result, and no bounded section move exists —
  `src/core/ops/config.ts:11-83`, `src/sqlite/store.ts:7484-7585`.
- ✔ Remotes expose add/remove/list only. Callers must currently spell URL access
  as raw `configGet`/`configSet` — `src/core/ops/config.ts:45-83`,
  `src/git/client.ts:580-593`.
- ⚠ A bounded exact/prefix pathspec compiler now exists at HEAD, so backlog 36's
  claim that only scalar matching exists has drifted. It still has no wildcard
  states, and `lsFiles()` accepts no path selector —
  `src/core/ops/worktree-io.ts:37-157`, `src/core/ops/staging.ts:1670-1682`,
  `src/git/client.ts:313-315`.
- ⚠ The ignore engine already compiles byte-oriented `*`, `?`, classes, and
  `**` with explicit structural limits, but its slash-sensitive anchored and
  basename rules are not Git's default pathspec rules. WU4 may reuse its
  lower-level byte matcher machinery, not its ignore-pattern semantics —
  `src/core/ignore/pattern.ts:612-732`, `src/core/ignore/index.ts:19-35`.
- ✔ The scheduled scope is explicitly the clone default, branch/remote required
  subset, and an `lsFiles()` glob. Deepening and the remaining management and
  mutating-pathspec surface stay separate — `docs/backlog/README.md:107-124`.

## Work units

### WU1 — Git-compatible clone defaults and ADR (effort S)

- **Problem.** Omitting clone selection options silently creates an incomplete,
  single-branch, tagless repository (`src/core/ops/network.ts:1473-1483`).
- **Verify first.** Run the existing default and explicit-depth witnesses in
  `tests/clone.test.ts`; confirm that only the option fallback differs.
- **Scope.** Default to complete history, all advertised branches, and normal tag
  following. Preserve explicit `depth`, `singleBranch`, and `noTags`. Document
  the choice and Workers cost consequence in ADR 0014 and the Git support map.
- **Acceptance / witness.** A real Smart HTTP clone with no selection options has
  the same history, remote branches, tags, `mergeBase`, and divergence result as
  real Git. Separate witnesses prove `depth: 1`, `singleBranch: true`, and
  `noTags: true` each retain its current opt-in behavior. Run
  `npx vitest run tests/clone.test.ts -t "default|full history|shallow"`.
- **Touch points.** `src/core/ops/network.ts`, `tests/clone.test.ts`,
  `docs/decisions/0014-default-clone-is-complete.md`,
  `docs/decisions/README.md`, `docs/reference/git-support.md`.

### WU2 — Atomic branch rename (effort M)

- **Problem.** Native callers can only approximate rename as create plus delete,
  which cannot atomically preserve symbolic `HEAD` or `branch.<name>.*` config —
  `src/core/ops/refs.ts:37-129`.
- **Verify first.** Compare real Git for `branch -m <new>` and
  `branch -m <old> <new>`, including an attached branch and destination collision.
- **Scope.** Add `branchRename({ oldName?, newName })` to the native API. Omitted
  `oldName` means the selected checkout's current branch. In one transaction,
  conditionally move the direct ref, retarget selected symbolic `HEAD`, and move
  every bounded multi-valued `branch.<old>.*` config row while preserving its
  sequence. Add an exact store helper that validates and buffers at most 1,024
  rows and 1 MiB of path/value text before mutation, then moves the section in
  the caller's transaction; over-bound input fails with `E2BIG`. Refuse a
  detached HEAD, missing source, occupied destination ref, any pre-existing
  `branch.<new>.*` config, invalid names, an inactive source attached to another
  checkout, corrupt stored config, or active operation. Preserve ref and checkout
  reflog causality through the existing mutation seam.
- **Acceptance / witness.** Differential tests cover current and inactive rename,
  config preservation, collision/missing/detached failures, linked-worktree
  ownership, destination config, exact bound failures, and rollback with no
  partial ref/config/HEAD state. Run
  `npx vitest run tests/refs.test.ts tests/client.test.ts -t "branch rename"`.
- **Touch points.** `src/sqlite/store.ts`, `src/core/ops/refs.ts`,
  `src/git/client.ts`, `tests/store.test.ts`, `tests/refs.test.ts`, `tests/client.test.ts`,
  `docs/reference/git-support.md`.

### WU3 — Typed remote URL get/set (effort S)

- **Problem.** Standard remote URL changes still require callers to know the
  internal `remote.<name>.url` config key (`src/core/ops/config.ts:45-83`).
- **Verify first.** Pin real Git behavior for get, set, and a missing remote.
- **Scope.** Add native `remoteGetUrl({ name })` and
  `remoteSetUrl({ name, url })`. Operate only on the existing fetch URL; reject a
  missing remote. Do not add push URLs, remote rename, or compat-only extensions.
- **Acceptance / witness.** A typed get returns the configured URL; set changes
  the URL used by the next fetch and by push when no separate
  `remote.<name>.pushurl` overrides it; missing remotes fail without creating a
  partial section. Run
  `npx vitest run tests/refs.test.ts tests/client.test.ts -t "remote URL"`.
- **Touch points.** `src/core/ops/config.ts`, `src/git/client.ts`,
  `tests/refs.test.ts`, `tests/client.test.ts`,
  `docs/reference/git-support.md`.

### WU4 — Bounded glob pathspecs for `lsFiles()` (effort M)

- **Problem.** `lsFiles()` always materializes every index/tree path and exposes
  no path selector (`src/core/ops/staging.ts:1670-1682`,
  `src/core/ops/reads.ts:156-160`, `src/git/client.ts:313-315`).
- **Verify first.** Ask real Git for `*.ext`, `dir/*.ext`, `dir/**`,
  `root-*.svg`, `a?x`, character classes, and a pattern matching nothing. Pin
  byte-order results, including wildcard matches that cross `/`.
- **Scope.** Add native `lsFiles({ paths })` for the index and the existing
  `{ ref }` extension. Reuse and parameterize the ignore engine's lower-level
  byte matcher machinery for default Git pathspec `*`, `?`, classes, and `**`;
  do not reuse ignore anchoring, basename, negation, or slash rules. Retain an
  indexed literal/prefix scan path. Bound input patterns, wildcard structure,
  rows inspected, matcher work, and retained result bytes; fail closed with
  stable `E2BIG`. Reject a leading `/` and every leading-`:` short or long magic
  form, including `:!`, `:^`, `:/`, and `:(...)`; bare leading `!` and `^` remain
  literal path characters. Do not silently reinterpret rejected syntax. Keep
  path order and conflict-stage deduplication.
- **Acceptance / witness.** Differential tests match real `git ls-files --` for
  `*.ts`, `dir/*.ts` including a nested positive, `dir/**`, `root-*.svg` with a
  nested same-basename negative, `a?x` across `/`, classes, literals, multiple
  patterns, bare `!file`/`^file` literals, and no matches. Direct limit witnesses
  prove over-bound patterns, scan rows, work, and result bytes fail rather than
  truncate. Run
  `npx vitest run tests/pathspec.test.ts tests/client.test.ts -t "ls-files|pathspec"`.
- **Touch points.** `src/core/ops/pathspec.ts` (new),
  `src/core/ignore/pattern.ts`, `src/core/ops/worktree-io.ts`, `src/core/ops/staging.ts`,
  `src/core/ops/reads.ts`, `src/git/client.ts`, `tests/pathspec.test.ts` (new),
  `tests/client.test.ts`, `docs/reference/git-support.md`.

## Review strategy

The labels below summarize the gate; the concrete witness and escalation rule
are binding.

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration (T3) | Four public defaults/operations meet in the native facade and support map. | After all WUs, one independent reviewer checks the frozen integrated diff for API coherence, exact deferrals, atomicity, bounds, and cross-WU regressions. Run `npm test`; fixes to public contracts, ref/config mutation, or bounds return to that reviewer until clean. | Any fix changes another WU's contract, a storage seam, or the sprint scope. |
| WU1 (T2) | Small code delta, but a public network default changes cost and reachable history. | Exact witness plus one independent review of defaults, explicit overrides, ADR, and parity evidence. One fix pass; re-review only if negotiation, shallow publication, or the declared default changes. | Transport negotiation, stored shallow state, or clone publication changes. |
| WU2 (T3) | One operation changes a ref, symbolic HEAD, reflogs, and multi-valued config atomically across linked checkouts. | Exact differential/rollback/bounds witness and independent review-to-clean of the frozen WU diff, including the planned exact config-section store helper. Every mutation or ownership fix is re-reviewed. | A schema change, a generalized config API, more than one checkout HEAD mutation, force rename, or a new concurrency policy is needed. |
| WU3 (T1) | Two typed wrappers over one existing config key with no new storage shape. | Exact direct witness is sufficient; no dedicated reviewer. The integration reviewer checks only facade consistency and deferral accuracy. | Multi-valued URLs, push URLs, remote creation/rename, schema work, or raw-key behavior changes. |
| WU4 (T3) | Untrusted wildcard programs can turn an indexed read into a broad traversal or unbounded retained result. | Differential and direct limit witnesses plus independent review-to-clean of matcher semantics, literal fast path, scan/work/result caps, and unsupported magic. Every bounds or matching fix is re-reviewed. | Any mutating command adopts globs, an ignore semantic must change, or SQL/tree traversal changes. |

## Test cadence

- **Per WU.** Run the exact `-t` witness above, then the touched complete test
  file only after the focused witness is stable. Do not run the exhaustive suite.
- **Routine integration.** Run `npm test`; its current witness is 132 tests in
  about 6 seconds and must remain below 30 seconds.
- **Sprint closure.** Run `npm run test:full` once under `cpu-lease` after all
  independent review and focused fixes settle, followed by typecheck, Biome, and
  build.
- **Failure loop.** Reproduce a closure failure with its exact file or domain
  slice. Rerun the full suite only after the focused witness is stable.

## Out of scope (explicit)

- `fetch --deepen` and `--unshallow` remain in
  [backlog 38](../backlog/38-clone-depth-and-deepening.md).
- Upstream management, remote rename, separate push URLs, and tracking-ref
  cleanup remain in
  [backlog 18](../backlog/18-branch-and-remote-management.md).
- Glob pathspecs for add/rm/reset/checkout/clean/diff/status remain in
  [backlog 36](../backlog/36-glob-pathspecs.md); this sprint closes only tracked
  index/ref glob filtering for `lsFiles()`.
- `lsFiles --others --exclude-standard` selection also remains in backlog 36.
  The sprint closes the bounded pathspec part of the builder call, not its
  untracked/ignore modes.
- Pathspec magic (`:(exclude)`, `:(icase)`, attributes, top/literal aliases),
  partial clone, SSH, abort signals, and force-with-lease are unchanged.
- `@cloudflare/computer` receives the corrected clone default because it shares
  `cloneOp`; its fixed interface is not extended with native-only methods or
  `lsFiles.paths`.

## Decisions

- Omitted clone selection options mean Git's complete default. An explicit
  positive `depth` remains the opt-in cost control. → ADR 0014 in WU1.
- Branch rename has no force mode in this sprint; an occupied destination fails.
- Remote URL methods address the fetch URL only.
- `lsFiles()` supports the declared default Git wildcard subset but rejects a
  leading `/` and all leading-`:` pathspec magic; bare `!` and `^` remain
  literals. Mutating command semantics remain untouched until their separate
  follow-up.

## Sequencing

1. WU1, the WU2 core operation, and the WU4 matcher/read seam may be implemented
   in parallel because their initial territories are disjoint.
2. WU2 facade wiring lands after the core rename contract freezes.
3. WU3 then owns the shared config/facade files.
4. WU4 facade wiring lands last, followed by the routine integration gate.
5. Independent WU reviews run on frozen diffs; the integration review starts
   only after their dispositions are committed.

Single-tree isolation is used. Agents may read any file but write only their
declared territory. Shared `src/git/client.ts`, `tests/client.test.ts`, and
`docs/reference/git-support.md` changes are sequenced, not edited concurrently.

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
whether the review strategy is proportionate to each WU and integrated risk.

- **Reviewer:** Beauvoir (`first_contact_plan_review`)
- **Verdict:** approved
- **Material findings:** Initial review blocked implementation because WU4 mixed
  ignore and default Git pathspec semantics, and WU2 required an unscheduled
  bounded config move. The plan now specifies slash-crossing default pathspec
  witnesses and explicit magic rejection, and schedules an exact bounded store
  helper with deterministic destination-config failure. Re-review also corrected
  short-form magic so bare `!`/`^` remain literals; no blocker remains.

## Run log

- 2026-08-28 — Sprint grounded at `df78ef9`; no implementation started before
  plan review.
- 2026-08-28 — Initial plan review blocked WU2 and WU4; proposal corrected and
  returned for review before implementation.
- 2026-08-28 — Beauvoir approved the corrected plan; implementation may start.
- 2026-08-28 — WU1 landed as `e1bbec6`; its independent review was clean after
  preserving explicit single-branch tag auto-follow, and the complete clone
  file passed 38/38 in 23 seconds.
- 2026-08-28 — Initial T3 reviews returned WU2 for exact dotted config-section
  bounds and validation, and WU4 for bounded derived-tree traversal plus stricter
  runtime/pathspec semantics. Both work units entered their required fix and
  re-review loop before facade integration.
- 2026-08-28 — WU3 landed as `3b05a89`; its T1 witness proves typed remote URL
  get/set, the next fetch target, push fallback, and fail-closed missing or
  multi-valued URL handling.
- 2026-08-28 — WU4 landed as `4121ff7` after review-to-clean. The final gate
  proved the deepest legal derived-tree path in 9 SQL statements and an index
  worst case of 903 statements, with pathspec and ignore isolation clean.
- 2026-08-28 — WU2 landed as `a7dbee7` after review-to-clean. Its final gate
  passed 20 focused rename/config-section witnesses and approved exact dotted
  sections, indexed bounded updates, strict stored UTF-8, and atomic rollback.
- 2026-08-28 — Native facade integration landed as `bdbb237`; complete client
  and public-export files passed 44/44, then the routine smoke suite passed
  139/139 in 5.3 seconds.
- 2026-08-28 — Integration review found that the builder's full `ls-files`
  command also needs untracked and standard-ignore modes. Backlog 36 and the
  Phase 1 schedule were re-scoped instead of overstating WU4's tracked-path
  result.
- 2026-08-28 — Remote URL access was hardened in `5bec3c6` and `16d369d` with
  bounded metadata-first reads, byte-exact stored UTF-8 validation, explicit
  name/value caps, runtime facade-option validation, and public limit witnesses.
- 2026-08-28 — The final T3 integration review was clean. Its independent gates
  passed 78 cross-WU tests and 11 remote/store/export bounds tests; no material
  finding remained.
- 2026-08-28 — The first closure run exposed two push checkpoint tests that
  implicitly depended on the old single-branch clone default. `9a09bc1` made
  that test intent explicit and the complete checkpoint file passed 8/8.
- 2026-08-28 — The second closure run exposed protocol's 100 ms timing witness
  running beside heavy clone and concurrency files. `2cc3c28` moved that file
  to a one-worker full-suite slice without weakening its threshold; the isolated
  protocol file passed 42/42.
- 2026-08-28 — The final sliced full suite passed 2,721 tests with five known
  skips and no failures. The routine suite passed 139/139 in 5.27 seconds;
  typecheck, Biome, build, and diff validation also passed.
- 2026-08-28 — The agent-docs structure lint retained its pre-existing hard
  finding for tracked `docs/AGENTS.md`; this sprint did not modify that unrelated
  root file.
