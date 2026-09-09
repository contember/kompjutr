<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — lifecycle and network integrity (2026-09-08)

**Goal.** Stop maintenance from deleting objects that are still reachable, and
stop fetch from publishing refs over an object graph it never proved complete.

**Theme.** Three units share one contract: nothing is deleted or published until
the physical bytes it depends on are proven present. WU1 owns the promise-to-
physical transition, WU2 owns pack dependencies across ingest, promotion, and
sweep, WU3 owns the network boundary. They belong in one sprint because each one
alone can make a repository look corrupt while every individual operation reports
success.

Consumes backlog [71](../backlog/71-invalidate-maintenance-on-promise-fulfillment.md),
[72](../backlog/72-preserve-pack-dependencies-during-lifecycle.md), and
[73](../backlog/73-validate-fetch-connectivity-and-publication.md).

## Refs re-verified at HEAD (2026-09-08)

`✔` = confirmed live · `⚠` = drift/nuance caught. This planning pass verified code
statically; it did not rerun the prior runtime observations recorded in the
backlog. Each unit first establishes permanent deterministic witnesses under its
declared verify-first gate.

- ✔ Marking skips an edge whose target is a missing promised blob —
  `packages/git/src/store/maintenance/reachability/reachability-publish.ts:87`.
- ✔ Loose publication removes the promise through a trigger —
  `packages/git/src/store/schema/schema-object-statements.ts:45-52`; complete pack
  publication deletes it directly — `packages/git/src/store/pack/packs.ts:233`.
- ✔ Neither promise-fulfillment path advances the maintenance root epoch. The bump
  has one implementation (`packages/git/src/store/maintenance/control.ts:60-75`);
  examples of callers include
  checkout mutations (`database-checkout-mutations.ts:219,277,356`), shallow
  (`refs/shallow.ts:103`), fetch publication (`fetch/fetch-publication.ts:421`),
  and the index tracker (`do-fs/indexes/index-tracker.ts:269,306,359,395,406`).
- ✔ The sweep grace period is 14 days — `GC_GRACE_MS = 1_209_600_000`,
  `packages/git/src/store/maintenance/sweep/sweep-contracts.ts:3`, applied at
  `sweep/sweep-shared.ts:87-94`.
- ✔ Pack deletion authenticates surviving delta bases for *complete* children
  only — `packages/git/src/store/pack/lifecycle/lifecycle-delete.ts:196-199`.
- ✔ Ingest deletes a pending row once its delta is flushed —
  `packages/git/src/store/pack/ingest/ingest-pending.ts:312`.
- ✔ Pack sweep always selects the lowest surviving `pack_id` —
  `ORDER BY pack_id LIMIT 2`, `sweep/sweep-packs.ts:77,139` — so a blocked
  candidate is re-selected on every run.
- ✔ Mapped fetch validates root type and hash and peels tags; there is no
  connectivity walk anywhere in `packages/git/src/ops/network/` —
  `network-fetch-mapped.ts:248-250`.
- ✔ Publication preflight compares namespace generation, revision, shallow
  revision, and checkout revision — never physical availability —
  `packages/git/src/store/fetch/fetch-publication-preflight.ts:19-60`.
- ✔ Legacy fetch awaits a checkpoint immediately before ref publication —
  `packages/git/src/ops/network/network-fetch-legacy.ts:208`.
- ✔ The sideband reader returns on EOF exactly as on flush and forwards an
  unknown band as a message — `packages/git/src/protocol/upload-pack.ts:251-266`.
- ⚠ Backlog 72's first two mechanisms were observed through *direct store*
  deletion, and its probe failed in its own cleanup (`db.storage.close` is not a
  function). Treat them as store-level observations, not as proof that ordinary
  maintenance destroys reachable history.
- ⚠ Backlog 71's end-to-end journey (HTTP partial clone → `catFile()` hydration →
  sweep) was never run; that connection is traced statically. Backlog 71 does
  record loose and packed reproductions using supported writers and cold public
  maintenance. Re-establish those observations as permanent witnesses.
- ⚠ Backlog 73's legacy fetch/maintenance interleaving is a static schedule. A
  normal mapped transfer with a fresh fallback pack is a different witness and
  does not establish it.

## Work units

### WU1 — Invalidate maintenance marks when promised blobs become physical (effort M–L)

- **Problem.** A tree that names a missing promised blob is marked without that
  edge (`reachability-publish.ts:87`). When the blob is later published, the
  promise disappears (`schema-object-statements.ts:45-52`, `packs.ts:233`) but the
  root epoch does not move, so an unfinished generation keeps a reachability view
  in which the now-physical blob is unreachable. After the 14-day grace
  (`sweep-contracts.ts:3`) the sweep deletes it — local bytes and the automatic
  promise-based recovery are both gone.
- **Verify first.** Build the deterministic schedule with an injected clock:
  in two isolated repositories, reference the tree and mark while the blob is
  absent; fulfill the promise through loose publication in one and packed
  publication in the other. Leave the generation unfinished, classify the newly
  physical object, and resume after its classification age exceeds the grace.
  Record the maintenance phase and clock at each step. Record whether
  the blob is actually deleted for each storage variant *before* changing code. If
  a variant does not reproduce, narrow the claim in the run log.
- **Scope.** 1) Atomically invalidate the stale reachability generation when
  physical publication fulfills a promise, for both loose and packed writes.
  2) Confirm the next destructive action restarts or incorporates the newly
  physical leaves before deleting anything. 3) Keep the normal grace-period
  collection of genuinely unreachable objects. Do not make every promise a
  maintenance root.
- **Acceptance / witness.** `npx vitest run tests/maintenance-sweep.test.ts tests/promisor-store.test.ts`
  — the loose and packed schedules above keep the blob, HEAD stays readable, cold
  reopen agrees, and an unreachable object is still collected after the grace.
  Add the partial-clone → hydration → maintenance journey if the verify-first step
  shows the publication path is reachable that way.
- **Touch points.** `packages/git/src/store/maintenance/reachability/reachability-publish.ts`,
  `packages/git/src/store/maintenance/control.ts`,
  `packages/git/src/store/maintenance/sweep/`,
  `packages/git/src/store/pack/packs.ts`,
  `packages/git/src/store/schema/schema-object-statements.ts`,
  `packages/git/src/ops/network/network-promisor.ts`,
  `tests/maintenance-sweep.test.ts`, `tests/promisor-store.test.ts`.

### WU2 — Preserve pack dependencies across ingest, promotion, and sweep (effort L)

- **Problem.** Three mechanisms, one contract. Deletion protects the bases of
  complete children only (`lifecycle-delete.ts:196-199`), so a resolved-but-
  flushed pending child (`ingest-pending.ts:312`) can lose its base and publish
  complete with an unreadable cold read. Canonical promotion after a deletion can
  produce an `A↔B` delta cycle. And pack sweep re-selects the lowest `pack_id`
  (`sweep-packs.ts:77,139`), so one `EBUSY` candidate starves every later one.
- **Verify first.** Before any fix, establish for each mechanism whether a
  *public* schedule reaches it — deterministic fetch plus maintenance for the
  first two, repeated public maintenance for the third. Record the answer in the
  run log. A mechanism that only reproduces through direct store deletion keeps
  the narrower claim and a store-level witness.
- **Scope.** 1) Protect the dependencies of unresolved *and* resolved pending
  entries, without changing ingest ownership, expiry, or cleanup. 2) Make
  publication and canonical promotion preserve a terminating physical dependency
  path — metadata and ownership validation only, never re-authentication of
  stored bytes ([ADR-0004](../decisions/0004-trust-stored-rows-validate-at-the-boundary.md)).
  3) Stop dependency-blocked candidates from starving unrelated work: process dead
  dependencies in a safe order or a bounded group, and retain bases that surviving
  mixed packs still need.
- **Acceptance / witness.** `npx vitest run tests/concurrency-pack.test.ts tests/concurrency-maintenance.test.ts tests/maintenance-sweep.test.ts tests/pack.test.ts`
  — the thin-delta schedule, the three-pack cycle, a self-referential alternative,
  and the blocked-lowest-id sweep all keep every reachable object readable after
  cache eviction and cold reopen; repeated maintenance makes progress past a
  blocked candidate. In the sweep witness, assert that later eligible dead packs
  are actually removed, the required base survives, and the generation finishes
  within a fixture-derived bound on calls. Also cover an entirely dead base/child
  pair so skipping blocked packs cannot silently turn into permanent retention.
- **Touch points.** `packages/git/src/store/pack/ingest/ingest-pending.ts`,
  `packages/git/src/store/pack/lifecycle/lifecycle-delete.ts`,
  `lifecycle-ingest.ts`, `packages/git/src/store/maintenance/sweep/sweep-packs.ts`,
  `tests/concurrency-pack.test.ts`, `tests/concurrency-maintenance.test.ts`,
  `tests/maintenance-sweep.test.ts`, `tests/pack.test.ts`.

### WU3 — Validate fetched connectivity and final publication (effort L)

- **Problem.** Root type and hash checks plus pack membership
  (`network-fetch-mapped.ts:248-250`) do not establish commit, tree, or blob
  connectivity, so a remote that omits a parent produces a successful `clone()`
  with a HEAD whose history is missing. Separately, publication preflight compares
  snapshots, not physical availability (`fetch-publication-preflight.ts:19-60`),
  while legacy fetch awaits a checkpoint just before publishing
  (`network-fetch-legacy.ts:208`). The sideband reader also accepts frames real Git
  rejects (`protocol/upload-pack.ts:251-266`).
- **Verify first.** Reproduce the incomplete-graph clone against a faulty test
  remote. Then attempt the legacy fetch/maintenance interleaving. If it does not
  reproduce, identify the existing invariant that prevents it and witness that
  protection without adding another mechanism. An unresolved schedule is a blocker
  to investigate, not a mandate to introduce ownership. Before changing
  connectivity code, capture the cost baseline described below.
- **Scope.** 1) Reject an incomplete graph before ref publication, for clone,
  fetch, and unmaterialized fetched branches. 2) Explicitly allow declared shallow
  boundaries, absent gitlinks, and durable `blob:none` promises
  ([ADR-0015](../decisions/0015-model-partial-clone-blobs-as-durable-promises.md)).
  3) Use bounded metadata walks and batches; do not re-hash trusted local objects
  (ADR-0004) and do not invent a projected-work refusal
  ([ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md)).
  4) Prove object lifetime across the validation/publication seam; retain existing
  protection when sufficient, otherwise prefer the smallest effective final check.
  New ownership requires demonstrated necessity and approval.
  5) Make sideband framing differential: empty
  packets, unknown bands, and EOF without termination. Trailing bytes after flush
  are out of scope.
- **Acceptance / witness.** `npx vitest run tests/clone.test.ts tests/fetch-refspec.test.ts tests/concurrency-fetch.test.ts tests/protocol.test.ts`
  — a response missing a parent, a tree, or a non-promised blob is rejected before
  any ref moves; previous refs and checkout state survive every rejection; shallow,
  gitlink, and promise cases still succeed; large valid transfers still stream.
  The witness matrix must include:
  - Legacy and mapped fetch, clone, and a fetched branch that is not checked out.
    Include tag roots and verify the declared shallow boundary exempts parent
    edges only, not the boundary commit's tree or blobs.
  - For legacy and mapped publication separately: validate, pause at
    `before-ref-publication`, advance eligible public maintenance, then resume.
    Either publication succeeds with the complete graph readable after cold
    reopen, or it rejects with refs, shallow state, and checkout state unchanged.
    The legacy fixture reuses an aged unreferenced pack without a new transfer;
    a fresh mapped fallback pack does not stand in for that reproduction.
  - If the original lifetime schedule cannot reproduce, a deterministic witness
    must exercise the existing protection at that seam. A demonstrated existing
    guarantee needs no runtime change; record an unresolved result as a blocker.
  - Differential native-Git fixtures for empty sideband packets, unknown bands,
    and EOF without required termination, plus valid flush and progress frames.
    Compare acceptance/rejection, not exact error text; rejected responses leave
    publication state unchanged.
- **Touch points.** `packages/git/src/ops/network/network-fetch-mapped.ts`,
  `network-fetch-legacy.ts`, `network-tags.ts`, `network-checkpoint.ts`,
  `packages/git/src/store/fetch/fetch-publication-preflight.ts`,
  `packages/git/src/protocol/upload-pack.ts`, `tests/clone.test.ts`,
  `tests/fetch-refspec.test.ts`, `tests/concurrency-fetch.test.ts`,
  `tests/protocol.test.ts`.

### WU3 cost witness — required before/after evidence

- Extend an existing benchmark harness first, reusing its fixture, HTTP backend,
  and measurement helpers. Record the selected files and exact command before
  the runtime fix, prefixed with `cpu-lease run -n 2 --`. A separate runner is
  justified only if it is the smallest solution, not a required deliverable.
  WU3 owns benchmark-only changes; preserve existing runner behavior.
- Before the validation fix, run that harness against the unchanged runtime;
  rerun the identical harness after the fix. Record the runtime commits, fixture
  revision, commands, and results in the run log. Use the existing Next.js fixture
  for a large clone, then an unchanged fetch and a fetch of one new commit with
  one changed file. Exercise legacy and mapped fetch separately with equivalent
  repository state; do not compare their different transfer strategies as a
  before/after result.
- Report SQL statements, returned-row counts, and process peak-memory evidence
  using the existing local instrumentation. `tests/helpers/storage.ts` counts
  cursor yields, not SQLite rows scanned: label this metric **rows returned** and
  do not claim it measures scan work. Review query shape and plans for scan cost.
  Report baseline RSS, peak-reset success, peak RSS, and peak minus baseline;
  preserve the distinction between process RSS and isolate memory evidence.
  Local elapsed time is supplementary. Keep
  setup outside operation measurements and verify the resulting refs and graph.
  If the helpers cannot measure a required metric, resolve that gap before the
  runtime fix rather than substituting an unlabelled proxy.
- The reviewer must account for the added traversal cost, including unchanged
  fetch. Unbounded retained queues/sets, per-object SQL in place of batches, or
  unexplained baseline regressions block acceptance. The 1,000-statement and
  100-MiB targets are reported, not converted into runtime refusal limits. Record
  and resolve target misses explicitly before accepting WU3.

## Review strategy

### Approved expansion — default ingest and measured memory (WU4)

The user expanded execution after the default mapped benchmark failed and the
REF_DELTA experiment ran away (approximately 30 GiB reported by the user; the
captured process log only establishes exit 137). Transport substitutions are no
longer an acceptable completion path. WU3 waits for the necessary ingest repair.

- **Verify first.** Reduce the default repeated-pack failure to a native-Git-valid
  physical-offset witness, and independently identify the allocation/retention
  mechanism behind the REF_DELTA runaway. Do not infer an OOM cause solely from
  exit 137. Use fixed-size fixtures and enforced cgroup limits before increasing
  input size; record the actual limit and measured high-water.
- **Scope.** Repair the demonstrated physical-membership and memory mechanisms
  needed for default clone and repeated legacy/mapped fetch. Backlog 74 and any
  necessary packed-read retention seam from backlog 63 are now eligible only for
  evidence-backed changes; unrelated findings are not pulled in automatically.
  The exact write territory and design require independent step review before
  WU4 runtime edits. WU2's lifecycle territory remains serialized if it overlaps.
- **Acceptance.** Native-Git-valid OFS_DELTA and REF_DELTA inputs ingest and remain
  readable after cache eviction and cold reopen, including repeated physical
  bases owned canonically by an older pack. Default Next.js clone, unchanged
  fetch, and one-file fetch complete for both modes. Restore the original cost
  criteria for these measured workflows: at most 1,000 SQL statements and below
  100 MiB process peak above the same-run baseline. Do not close with unexplained
  growth, a transport workaround, or a recorded target miss instead of a fix.
  These are measurement gates, never runtime projected-work refusals.
- **Review/gates.** Independent review to clean of the reduced witness, runtime
  repair, query plans, and memory evidence; leader reruns focused witnesses and
  capped before/after measurements. The exact commands and files are frozen after
  qualification. Integration and full-suite closure remain mandatory.
- **Diagnostic containment.** Every potentially large reproduction runs in a
  verified cgroup with swap disabled. The execution wrapper
  `/tmp/opencode/kompjutr-capped-run.sh` sets and reads back the current CPU lease's
  `memory.max` (default 1 GiB) and `memory.swap.max` (zero); test suites with large
  fixture overhead may use an explicit 4 GiB cap. A diagnostic cap is distinct
  from the 100 MiB operation target and cannot substitute for memory measurement.

#### WU4 frozen physical-offset step

- **Grounding:** `ingest/ingest-pending.ts` resolves an OFS base using a
  `(repo_id, pack_id, offset)` join against canonical `git_pack_objects`.
  `PackObjectBatch.flush()` stores all resolved physical occurrences in
  `git_pack_entries`, whose primary key already matches that coordinate. An
  older canonical owner plus 8,192 resolved offset insertions evicts the incoming
  base from the two-window cache; the canonical join then misses it.
- **Write territory:** the single deferred-base join in
  `packages/git/src/store/pack/ingest/ingest-pending.ts`, and
  `tests/pack-physical-membership.test.ts`. No schema, index, ownership, or
  canonical-by-OID reader change.
- **Implementation contract:** resolve the physical coordinate through
  `git_pack_entries`; retain the existing canonical-by-OID resolution after the
  OID has been found.
- **Witness:** `cpu-lease run -n 2 -- bash /tmp/opencode/kompjutr-capped-run.sh npx vitest run tests/pack-physical-membership.test.ts`.
  Native Git accepts all three fixtures. The pre-fix runtime passes with 8,190
  intervening blobs and an older owner, and with 8,191 blobs without an older
  owner; it fails only with 8,191 blobs plus an older owner. The incoming pack
  is 171,000 bytes. All three must pass with matching cold target bytes.
- **Next gate:** retry the unchanged default mapped benchmark under the cap,
  then resume WU3. Duplicate-tree projection and depth/admissibility findings
  remain separate unless demonstrated as another blocker.
- **Memory finding disposition:** the reported approximately 30 GiB came from a
  benchmark-only header-grouping diagnostic introduced during qualification.
  SQLite sorter records included the entire chunk BLOB per entry: 30,613 entries
  amplified 43,497,257 pack bytes into 31,779,725,438 sorter bytes. A capped
  128-entry sample confirmed the amplification. The diagnostic was removed;
  both abandoned databases show completed ingest, clone refs, and 24,252 index
  entries. This is not evidence of a runtime ingest leak. Default-operation cost
  and memory criteria still require measurement and resolution before closure.

| Scope | Risk / rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | WU1 and WU2 both change what maintenance may delete; WU3 changes what fetch may publish. A wrong combination deletes reachable data silently | `npm test` plus `npx vitest run tests/maintenance-sweep.test.ts tests/concurrency-pack.test.ts tests/concurrency-maintenance.test.ts tests/clone.test.ts`; independent integration review after the last WU, repeated after any fix that touches deletion order | Any unit widens what may be deleted, or two units edit the same sweep file |
| WU1 | Fundamental. Failure mode is silent local data loss with no automatic recovery | Independent review to clean; the reviewer re-runs the injected-clock schedule for both storage variants | The fix needs a schema change, or the verify-first step cannot reproduce either variant |
| WU2 | Fundamental and extra-large. Three mechanisms over ingest, promotion, and sweep, with concurrency schedules | Independent review to clean, per mechanism; a mechanism without a public reproduction ships with a store-level witness and an explicit narrower claim | A single mechanism grows past its own witness — split it out into its own unit rather than widening this one |
| WU3 | Fundamental. Adds a new validation pass to every fetch, so both correctness and cost are in play | Independent review to clean; reviewer checks no stored object is re-hashed, bounded streaming traversal, both publication-seam witnesses, and the mandatory before/after cost report | Ownership needs changes in pack lifecycle or maintenance, or cost cannot be accounted for within the declared scope: stop and resolve the shared seam before proceeding |

## Test cadence

- **Per WU.** Run the exact acceptance witness above, plus `npm run test:e2e`
  for WU3 because it crosses the network transport. Run `npm run typecheck` and
  `npm run check` before accepting each WU. Any review fix reruns its affected
  witness; semantic fixes return to the independent reviewer until clean.
- **Routine integration.** `npm test` after each WU lands; keep it under 30 s.
- **Sprint closure.** `npm run test:full` once, after the last review and its
  focused fixes have settled, plus `npm run typecheck` and `npm run check` on the
  integrated tree.
- **Failure loop.** Reproduce a full-suite failure with its exact file or slice,
  stabilize it, then rerun the full suite. Concurrency witnesses that fail
  intermittently are treated as findings, not as flakes, until proven otherwise.
- **Resources.** Prefix CPU-bound test/check commands with
  `cpu-lease run -n 4 --`; use the two-core command above for the cost witness.
  If leases or required benchmark instrumentation are unavailable, stop and report
  the blocker. Do not claim an unleased measurement as evidence.

## Out of scope (explicit)

- Backlog 67–70 — shipped as
  [sprint-2026-09-08-public-api-correctness](../archive/sprint-2026-09-08-public-api-correctness.md).
- Unrelated portions of [74](../backlog/74-align-pack-ingest-with-physical-membership.md)
  and [63](../backlog/63-bound-packed-dependency-graph-traversal.md) remain out of
  scope; WU4 consumes only the demonstrated default-ingest and memory blockers.
  WU2 must not leave a traversal that grows worse than the current one.
- [65](../backlog/65-git-sqlite-architecture-review.md), ARCH-16 cursors and
  ARCH-9 pending projections: adjacent to WU1 and WU2 but separately owned.
- Trailing bytes after a sideband flush, and any general storage normalization
  experiment (65, ARCH-22).

## Decisions

1. **Fulfilling a promise invalidates the stale reachability generation**, rather
   than promoting every promise to a maintenance root. Roots-for-promises would
   keep unreachable promised blobs alive forever.
2. **Dependency protection is metadata and ownership validation.** Re-reading or
   re-hashing stored bytes to decide what is safe to delete contradicts ADR-0004
   and is rejected.
3. **Connectivity validation runs on bounded metadata walks**, batched and
   streaming, with shallow boundaries, gitlinks, and durable promises as declared
   exceptions. A projected-work refusal is rejected under ADR-0005.
4. **Verify-first is a gate, not a formality.** A mechanism that reproduces only
   through direct store manipulation keeps the narrower claim in its backlog
   record and ships with a store-level witness. Out-of-band database mutation is
   undefined behavior, so it can never be the sole justification for a fix.

## Sequencing

### WU4 frozen clone-heartbeat cost step

The safe query histogram on the in-progress WU3 runtime records 2,520 SQL
statements, including 708 mutation-guard acquisitions and 708 releases. Clone
checkpoints enter that guard even when their lease is not due for renewal.

- Add the existing renewal-window comparison before guard acquisition in
  `network-clone.ts`'s `heartbeat`. Keep `heartbeatOwned` and its guarded due
  check unchanged. Actual renewal and readiness publication retain exact-owner
  validation and their existing guards. No new ownership seam is introduced.
- Preserve the strict `>` comparison, so renewal is due at equality. The added
  clock sample is observable; clock callbacks already run outside the guard at
  reservation. Do not claim identical callback counts or guard context.
- First capture non-due guard counts with a streamed real-Git clone and a fixed
  clock. After the change, prove that those heartbeat guard pairs disappear,
  while HEAD, files, status, and cold reopen match. Exercise just-before and
  exact renewal-window boundaries and retain the real expiry/takeover witness.
- Territory: `ops/network/network-clone.ts` and a dedicated focused clone
  heartbeat test. Gate: that test, `concurrency-clone.test.ts`, `clone.test.ts`,
  independent implementation review, typecheck, lint, and smoke.
- Step review `ses_f7a6c41f5ffektyzGL6Luqw3yP`: ready. This is only an evidenced
  reduction; even subtracting all observed guard pairs leaves 1,104 statements
  in that runtime state. Final integrated SQL and memory measurements remain
  mandatory. Memory allocation ownership is not yet established.

### WU2 approved bounded-sweep continuation

The user approved extending the existing cursor fields for `sweep-packs` after
independent review found unbounded candidate analysis in one call. No new table
or ownership mechanism is needed.

- `cursor_ordinal` records the last examined pack ID in the current pass;
  `cursor_text` is null or a fixed retry marker indicating that a deletion in
  this pass may have unblocked earlier candidates. `cursor_checkout_id` stays
  null and `root_source` stays `done`.
- Examine at most the existing sweep `pageRows` candidates per call, in pack-ID
  order using a keyset predicate and bounded SQL page. Keep the existing
  prospective dependency check and at most one destructive pack action per call.
  Persist skipped-candidate progress atomically with any deletion and counters.
- At end of a pass with deletions, clear the cursor/marker and start another
  bounded pass. Finish only after a pass makes no deletion. This reconsiders
  newly unblocked earlier packs without rechecking every low-ID blocker before
  each later deletion.
- Update the shared phase-specific cursor validation and settled-roots check
  explicitly for `sweep-packs`; keep every other phase's shape unchanged. Root
  epoch drift and phase exit clear the continuation fields. Validate cold resume
  and phase transitions under the existing transaction contract.
- The additional witness uses more than two pages of independent blocked bases
  retained by mixed live packs, followed by collectible packs. Assert bounded
  candidate checks in every public call, progress across cold reopen, eventual
  collection and completion, retry of newly unblocked earlier packs, and restart
  after root-epoch drift. Preserve all full/delta fallback and unsafe-cycle tests.
- Territory expands to maintenance `roots/`, `state/`, and `sweep/` only as needed
  for this phase contract, plus focused maintenance tests. Independent step
  review precedes implementation; the revised WU2 still requires review-to-clean.

| Order | Unit | Parallel with | Why |
|---|---|---|---|
| 1 | WU1 | WU3 | Establishes what a generation means before WU2 changes selection inside the same sweep files |
| 2 | WU2 | WU3 | Shares `store/maintenance/sweep/` with WU1; serialize to keep the witnesses attributable |
| — | WU3 | WU1 and WU2 after seam review | Starts in `ops/network/`, `store/fetch/`, `protocol/`, and its focused benchmark; ownership changes may cross into lifecycle |

Two agents at most: one on the WU1 → WU2 chain, one on WU3. Do not run WU1 and
WU2 concurrently even though their fixes look separable — both change deletion
eligibility, and a combined failure is hard to attribute.

Before parallel implementation, WU3 records its selected lifetime mechanism and
write territory. If it needs pack lifecycle or maintenance edits, land that shared
seam with its witness and independent review first, or serialize the affected
work with WU1/WU2. File separation alone does not establish semantic independence.

Each unit records the pre-fix result, implementation, exact witness results, and
independent review verdict before its atomic commit. A failed verify-first step
must distinguish an unreproduced defect from a broken fixture. WU1 cannot proceed
without at least one reproduced storage variant; WU2 may retain a valid store-API
witness with a narrower claim. WU3 must reproduce incomplete-graph acceptance and
prove its final lifetime guarantee even if the historical interleaving remains
unproven. Escalations and architectural changes require approval before coding.

## Plan review

An independent reviewer checked this proposal against runtime HEAD
`920ac0b346b44918b4a2905202e6e0bb1be87918`, including grounding, dependencies,
acceptance witnesses, benchmark feasibility, and review/test gates.

- **Reviewer:** independent general agent, session
  `ses_f7e8cc706ffeWLy1lDhXygi24S`, 2026-09-08.
- **Verdict:** ready after corrections and independent re-review. Implementation
  may begin under the per-unit verify-first gates.
- **Material findings resolved:** distinguish local returned-row counts from
  SQLite scan work; assign memory-helper territory and specify memory evidence;
  correct the incomplete epoch-caller list and WU1's prior reproduction status;
  align the run log with permitted narrower verify-first results.
- **Evidence boundary:** static plan/code review only. Runtime reproductions,
  cost baselines, tests, and implementation reviews remain execution gates.
- **Approved execution refinement:** user approved removing mandatory new
  ownership and a mandatory new benchmark runner; prefer demonstrated existing
  protection and existing measurement infrastructure.
- **Expansion gate:** the user subsequently approved fixing ingest and its memory
  failure rather than changing benchmark inputs. WU4's frozen physical-offset
  step was independently reviewed by `ses_f7e271569ffewnPw0zEEiSXg1F`: ready,
  no findings. Runtime edits may proceed inside that exact territory. Additional
  performance repairs require evidence and their own frozen step/review.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-09-08 — Planning verified every mechanism statically at HEAD; no unit has a
  new runtime reproduction from this planning pass. Prior observations remain in
  backlog 71–73. Each WU records its verify-first result under its declared gate
  before its fix lands, including permitted store-level or unproven claims.
- 2026-09-08 — User approved full execution, independent reviews, and atomic
  per-unit commits on the current branch. No push. WU1 precedes WU2; WU3's
  lifetime seam is qualified before concurrent runtime edits.
- 2026-09-08 — Initial smoke gate: `cpu-lease run -n 4 -- npm test`, 159 tests
  across 14 files passed in 16.92 s. An early typecheck encountered unfinished
  witness helpers; it is not an acceptance result and will be rerun on frozen WUs.
- 2026-09-08 — WU3 verify-first reproduced incomplete-graph clone (native Git
  rejects the missing parent) and legacy publication after public maintenance
  deletes the sole reused aged pack, with zero transfer POSTs. Leader approved
  final synchronous connectivity validation inside the existing mutation guard;
  no new ownership or maintenance seam. Benchmark extension uses the existing
  Next.js runner with isolated legacy/mapped modes, before runtime edits.
- 2026-09-08 — Leader-authored WU2 cycle witnesses in `tests/pack.test.ts` fail
  before lifecycle changes for both three-pack and self-referential promotion:
  deletion succeeds and cold reads report `cyclic delta chain`. Command:
  `cpu-lease run -n 2 -- npx vitest run tests/pack.test.ts -t 'canonical promotion cycle' --reporter=dot`.
  Evidence remains store-API level; no arbitrary SQL mutation was used.
- 2026-09-08 — WU1 reproduced both storage variants and the real HTTP partial
  clone → historical `catFile()` → cold maintenance journey before changing
  runtime code. Atomic promise consumption now advances the epoch only on actual
  fulfillment, for all loose writers and complete pack publication; no schema or
  sweep change. Independent reviewer `ses_f7e6133f7ffeqBjbsmNjODZnta`: clean,
  reran 29 tests. Leader reran the same 29 tests (3.92 s), typecheck, and smoke
  (159 tests, 16.40 s); formatting gate was temporarily held by WU3's active
  benchmark edits. → ADR-0012 and `reference/concurrency.md` for the invariant.
- 2026-09-08 — WU1 committed as `008169e` after the global formatting gate passed.
- 2026-09-08 — WU3's pre-fix Next.js mapped baseline failed during repeated pack
  ingest (`cannot resolve 367 delta object(s): missing base`), before publication.
  User approved reducing the failure and, only if causal, a benchmark-only
  REF_DELTA configuration applied identically before/after; backlog 74 stays out
  of runtime scope. Both comparable baselines must use the frozen WU1 code.
- 2026-09-08 — WU2's stronger sweep witness exposed an optimistic alternative-pack
  exemption in candidate selection: presence alone does not prove a terminating
  promotion. Leader retained dependency-safe ordering and rejected root-cursor
  reuse or new durable ownership. The unchanged witness gates this correction.
- 2026-09-08 — REF_DELTA qualification failed before clone completion (one timeout,
  then exit 137). The user reported approximately 30 GiB memory growth, rejected
  the proposed no-delta benchmark, and required fixing ingest and meeting the
  original criteria. WU4 added; WU3 paused. The leader verified a 1 GiB/no-swap
  diagnostic cgroup wrapper before further reproductions. No 30 GiB process
  remained in the subsequent process snapshot; the source of growth is unproven.
- 2026-09-08 — WU2 leader gate passed: 148 tests / four files in 79.46 s under
  a verified 4 GiB/no-swap cgroup, with two Vitest threads. Independent review
  `ses_f7e2f32b6ffe4PB9CgnsIpPjrD` requested a correction: mutually dependent packs
  can have an acyclic object graph and a safe fallback yet both be skipped.
  The fix round must reproduce that graph and preserve safe full and delta
  fallback collection without weakening the existing blocked-pack witnesses.
- 2026-09-08 — WU4 qualification `ses_f7e69d15effejFJStEUr3Bv2hJ`: the physical
  lookup witness gives two passes and one expected pre-fix failure under 1 GiB.
  The 30 GiB amplification was traced to the added diagnostic sorter, not to
  ingest; removed that query and all REF_DELTA request rewriting. Retained
  databases establish that clone completed before the diagnostic ran. The
  original exit 137 alone did not establish an OOM kill. Frozen WU4 step above.
- 2026-09-09 — User approved WU2 bounded continuation using the existing cursor
  fields. The prior full/delta retention finding is fixed, but re-review found
  repeated unbounded per-candidate analyses; the approved step above replaces
  that loop with cold-resumable bounded passes.
- 2026-09-09 — WU4 physical-offset implementation independently reviewed clean
  by `ses_f7e271569ffewnPw0zEEiSXg1F`. Leader verified all three native-Git
  controls (3.36 s), typecheck, lint (789 files), and smoke (159 tests, 16.12 s).
  Runtime change is one physical-table join; no benchmark transport workaround.
- 2026-09-09 — WU2 continuation step and implementation reviewed clean by
  `ses_f7e2f32b6ffe4PB9CgnsIpPjrD`; independent witnesses: 12 tests / two files.
  Leader gate: 156 tests / five files (84.52 s), typecheck passed, all 13 WU2
  files passed Biome, roots 15 tests (2.09 s), smoke 159 tests / 14 files
  (25.89 s). Heavy gates used a
  verified 4 GiB/no-swap cgroup. WU3 helper formatting was settled and global
  lint passed (795 files) before commit. → ADR-0012 and
  `reference/concurrency.md` for durable continuation and dependency behavior.
- 2026-09-09 — After `cf2e6fb`, both unchanged default-transport Next.js workflows
  passed under a verified 1 GiB/no-swap cap. Clone: 2,374 SQL, 79,268 returned
  rows; process peak above baseline 146.88 MiB (mapped), 141.61 MiB (legacy).
  Unchanged/one-file fetch: mapped 275/283 SQL, legacy 25/71 SQL. WU3 resumed;
  clone SQL and memory misses remain blocking acceptance criteria.
- 2026-09-09 — Temporary pass-through memory instrumentation sampled the initial
  writer and bounded SQL high-water records under the verified 1 GiB cap.
  On the in-progress heartbeat/WU3 runtime it observed 990 SQL statements,
  including five guard pairs. RSS was 184,307,712 bytes at baseline,
  320,864,256 before materialization, and peaked at 338,841,600 during writes.
  Most growth preceded checkout, across pack parsing and deferred resolution;
  this localizes the phase but does not establish a retained allocation owner.
  These instrumented results are diagnostic, not the final acceptance benchmark.
- 2026-09-09 — WU2 committed as `284c092` after independent review and leader
  verification. WU4 heartbeat implementation reviewed clean by
  `ses_f7a6c41f5ffektyzGL6Luqw3yP`; verify-first real-clone guard counts fell
  from 27 to five pairs with 11 checkpoint yields unchanged. Leader exact gate:
  76 tests / three files (53.57 s), smoke 159 tests / 14 files (25.86 s),
  typecheck and global lint (795 files) passed under the verified memory cap.
