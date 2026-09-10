> **OUTCOME — shipped 2026-09-10.** Promise fulfillment invalidates stale
> maintenance marks; pack dependencies survive pending ingest, promotion, and
> resumable sweep; fetch validates all selected connectivity inside final guarded
> publication. Default transport works with physical OFS membership. Decoder and
> allocation fixes preserve byte ownership and native-Git rejection semantics.
> Independent unit and integration reviews are clean. Full suite: **3,649 passed**,
> five existing ignore skips, **1,372.6 s**, one lane, two leased vCPUs, verified
> 4 GiB/no swap. Typecheck, lint, and smoke (159/14) passed. Final default clone
> runs: **990 SQL / 145,773 returned rows**, **126.06 and 140.23 MiB** added peak.
> Both fetch modes passed. The user explicitly revised this witness's memory gate
> from <100 to **<160 MiB**; the original gate was not met. No forced GC, heap
> tuning, cache change, or transport workaround is included in acceptance.
> Backlogs **71–73 consumed**; **74** retains repeated-tree and cold-read
> admissibility work; general dependency scaling (**63**) remains separate.

## Commit map

| Unit | Commits |
| --- | --- |
| Plan review | `398f7a2` |
| WU1 promise fulfillment | `008169e` |
| WU2 dependency preservation and resumable sweep | `284c092` |
| WU3 connectivity, framing, metadata lookup, network witness | `3fc7965` |
| WU4 physical offsets and clone heartbeat | `cf2e6fb`, `bc9bd3f` |
| WU4 strict zlib and native overflow diagnosis | `b6c9dbb`, `a03eb01` |
| WU4 checksum, ingest targets, complete-input inflation | `8f66785`, `7b1cfd8`, `1f63421` |

Curated results and measurement limits are in
[the benchmark snapshot](../reference/benchmark-current.md#default-network-clone-and-fetch--2026-09-10).
The run log below retains rejected experiments, superseded criteria, and failed
verification attempts as historical evidence; the outcome above governs closure.

# Sprint — lifecycle and network integrity (2026-09-08)

**Goal.** Stop maintenance from deleting objects that are still reachable, and
stop fetch from publishing refs over an object graph it never proved complete.

**Theme.** Three units share one contract: nothing is deleted or published until
the physical bytes it depends on are proven present. WU1 owns the promise-to-
physical transition, WU2 owns pack dependencies across ingest, promotion, and
sweep, WU3 owns the network boundary. They belong in one sprint because each one
alone can make a repository look corrupt while every individual operation reports
success.

Consumed backlogs 71 (promise fulfillment), 72 (pack dependencies), and
73 (fetch connectivity and publication). Their completed contracts are retained
in the work units below; the backlog files were deleted at closure.

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
   fetch, and one-file fetch complete for both modes. The user-approved closure
   criteria are at most 1,000 SQL statements and below 160 MiB process peak above
   the same-run baseline. This replaces the original 100 MiB criterion for these
   workflows only. Preserve default transport, cache settings, and baseline;
   forced GC and allocator/heap tuning are not acceptance measurements.
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
   from the operation target and cannot substitute for memory measurement.

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

### Approved closure criterion amendment — 2026-09-10

The user approved <160 MiB reset process peak above same-run baseline for the
default Next.js clone/fetch witness, replacing <100 MiB. The earlier experiment
sections and run log retain their original criteria as history; this amendment
governs closure. SQL remains at most 1,000. No production-isolate memory claim
follows from local RSS. GC diagnostics and old-space tuning are excluded from
acceptance; the default runner, fixture, transport, and cache settings remain.
The final implementation integration review is clean. Retain the four reviewed
allocation changes together: checksum copying, uncached-blob streaming, prefix
selection, and complete-input native inflation. Their final composition meets
the amended gate; individual paired measurements do not establish fixed savings.
Final integration review, both network modes, full tests, commits, and document
closure are still required. Historical evidence found no comparable passing
100 MiB clone; diagnostics showed delayed collection and allocator retention.

### WU4 approved complete-input native inflation experiment

The user explicitly approved changing the complete-input read decoder after
attribution reconciled all 20,043 checkout exact inflations to `#inflateBytes()`:
16,309 full objects and 3,734 delta-instruction streams. No checkout exact target
came from incremental stored reads. The method also serves 215 ingest reads.
Checkout cumulatively allocated 109,366,881 bytes of exact targets and
140,140,656 bytes of pako state; neither total predicts retained memory savings.

- Territory: `pack/read/read-data.ts`, specifically `#inflateBytes()`, and
  focused regression tests. Use existing `inflatePrefix(input, expectedSize)`
  instead of constructing an incremental decoder for a complete input buffer.
- Preserve the expected-size guard, reject null/incomplete results, require
  exact output length and consumption of the entire compressed input, and
  preserve corruption classification and cause. Return owned native output.
  Incremental stored reads, SQL, cache policy, and public APIs stay as they are.
- Witness full and delta reads, zero output, truncation, malformed Adler,
  gzip/raw wrappers, trailing input, and source/output ownership independently.
  Native pooled output is an explicit memory-retention risk to measure.
- Independent step review precedes implementation; implementation review and
  leader gates precede acceptance. Compare fresh original-runner before/after
  measurements with other candidates constant under the existing lease/cgroup
  limits. Require material reset-peak improvement, semantic pass, SQL at most
  1,000, and report CPU. Remove this experiment if allocation reduction alone
  improves. The original <100 MiB acceptance criterion remains mandatory.

### WU4 strict zlib decoder correction

Verify-first `tests/pack-zlib-format.test.ts` demonstrates a 1,024-byte blob
wrapped in 29 bytes of gzip inside a correctly checksummed pack. Native Git and
the native prefix path reject it; uncached streaming accepts it. The checksum's
leading zero prevents pako's gzip-member retry from masking the acceptance bug.
Both incremental wrappers independently accept isolated gzip today.

- All production consumers require RFC 1950 zlib: pack entries/instructions,
  tree projections, and loose objects marked `zlib`. Raw loose storage has a
  separate path. There is no gzip consumer contract to preserve.
- Add explicit `windowBits: 15` to the pako constructors in `common/zlib.ts`
  for `InflateInto` and `InflateStream`. Preserve chunk sizes, ownership,
  callbacks, completion checks, and selection. No API or architectural change.
- Convert verify-only gzip acceptance assertions to rejection regressions.
  Cover the native prefix and uncached streaming paths, both wrappers, raw
  deflate/gzip/truncation rejection, and valid zlib windows 9 and 15. Both current
  writers must remain readable one input byte at a time, including empty data.
- Scope is that shared decoder file and `tests/pack-zlib-format.test.ts`.
  Independent step review precedes edits; implementation review, focused
  wrapper/pack/loose/maintenance consumers, typecheck, lint, and leader smoke
  precede acceptance. The pre-fix 17-test qualification passing records the bug,
  not a corrected runtime. No further performance experiment runs before this
  correction is independently clean.

### WU4 prefix-attempt selection experiment

**Format blocker resolved in `b6c9dbb`; adjusted step reviewed ready.**
The original step review demonstrated native zlib rejects
gzip while the existing pako incremental wrappers autodetect and accept it.
Skipping the native attempt can therefore broaden malformed-pack acceptance.
The same concern applies to the retained uncached-full-blob experiment. A
native-Git malformed-pack witness and reviewed zlib-only decoder correction are
required before further performance work; no prefix heuristic is implemented.

The original bounded probe observed 36 incomplete native prefix attempts which
allocated full outputs before falling back to exact incremental inflation.
Every such entry had declared output larger than the available compressed
window, but 66 successful native attempts also met that condition. This is a
selection heuristic, not evidence that a stream crosses a physical boundary.
Uncached-full-blob streaming already removes three of those failed attempts;
qualification of the remaining selection must keep that change constant.

- For otherwise buffered entries, attempt native prefix inflation only when
  the available window is at least the declared output size. Otherwise select
  the existing exact incremental fallback immediately. Keep its size, consumed
  length, hash, and malformed-input checks; no input is rejected by this choice.
- Change only `ingest-inflate.ts` plus a focused selection witness. Empty input
  still fails through existing checks. Preserve streamed full blobs, all object
  types, source ownership, physical offset resolution, and public options.
- Wrap only incremental decoder push failures in `CorruptError`, preserving
  the native path's stable `ECORRUPT` classification. Keep reader SQL calls
  outside that catch. A damaged Adler-32 with a recomputed valid pack checksum
  must be rejected by native Git and ingest, with `ECORRUPT` and no publication.
- Verify both native-success and native-incomplete inputs selected by this
  heuristic, including highly compressible valid input, delta instructions,
  raw size mismatch, and prefix retry across a physical row. Report the CPU
  tradeoff rather than calling the condition a compressed-boundary proof.
- Independent step review precedes edits. Compare a fresh original-runner pair
  with checksum and uncached-full-blob changes identical on both sides. Require
  correct results, SQL at most 1,000, and material reset-peak improvement. If
  allocation alone improves, remove only this experiment's edits. One justified
  variance-check pair is the maximum repeat; no search for a passing sample.

### WU4 uncached full-blob streaming experiment

Qualification identified four full blobs above the existing 2 MiB cache-entry
limit but below the 8 MiB buffered-entry limit. Their buffered payloads have no
consumer beyond hashing: blob projection uses metadata and cache insertion
rejects their sizes. Native attempts allocate 12,731,949 bytes; three incomplete
attempts then allocate another 10,149,306 bytes as exact fallback targets.
These overlapping-stage allocations are not predicted RSS savings.

- Pass the existing validated `cacheEntryLimit` from `PackIndexer` to its
  `PackIngestInflater`. For full blobs whose `entrySize` exceeds that limit,
  select the existing non-materializing streamed path. Keep the existing
  buffered-size decision for trees, commits, tags, and delta instructions.
- Reuse incremental object hashing, compressed digest, consumed-length checks,
  and `streamedOid`/null-data publication. This adds no read interface, new
  cache-admission model, data cap, or ownership mechanism. Do not duplicate the
  LRU's independent budget-based admission calculation.
- Verify streamed blobs remain valid bases for subsequent OFS/REF deltas,
  including deferred resolution, cold reads, exact-limit behavior, source
  boundaries, checksum/size failures, and a smaller configured entry limit.
- Territory: `pack/ingest/ingest-index.ts`, `ingest-inflate.ts`, and a dedicated
  focused regression file. Independent step review precedes implementation;
  source/test review and leader verification precede any acceptance.
- Measure one fresh unchanged-runner before/after pair under the existing
  lease/cgroup gates, keeping checksum changes identical on both sides. Correct
  results and SQL at most 1,000 are required. A material reset-peak reduction
  must accompany the removal of unused full outputs; allocation volume alone
  does not pass. Remaining peak above 100 MiB still blocks closure.

### WU4 checksum lookbehind copy experiment

Numeric allocation/ownership instrumentation found 663 temporary checksum
concatenations totaling 43,381,528 bytes. At pre-checkout, caches owned only
12,546,536 bytes of unique backing stores, with no active entry or pool owner;
this rules out a large hidden cache multiplier in that run, not delayed GC.

- In `pack/ingest/ingest-write.ts`, when an incoming slice has at least 20
  bytes, hash the previous owned tail and then the incoming prefix directly.
  Retain an owned copy of only its last 20 bytes. For shorter input, the existing
  join is bounded to at most 39 bytes and preserves partial-tail behavior.
- Keep `Sha1.update()` synchronous consumption, the owned lookbehind, required
  row ownership copies, source slicing, size/checksum validation, aborts,
  heartbeat, and SQL writes unchanged. No interface or architecture change.
- Independent step review precedes implementation. Focused witnesses cover
  native-valid packs, every trailer split, tiny/empty chunks, reused source
  views, checksum rejection, and minimum-length rejection. Reuse the existing
  public Buffer-ownership regression; add only missing checksum witnesses.
- Verify allocation reduction and the unchanged default clone benchmark under
  the existing lease/cgroup gates. Correctness and SQL must remain unchanged;
  acceptance requires material improvement in reset process peak above baseline,
  not only fewer copied bytes. If falsified, remove only this experiment's edits.
  The final 100 MiB gate remains mandatory.
- Source territory is `ingest-write.ts` and a dedicated checksum regression test
  if needed. Independent implementation review and leader gates precede commit.

### WU4 approved synchronous ingest read-ahead experiment

**Rejected after measurement.** Clone SQL fell from 990 to 959 with unchanged
145,773 returned rows and passing semantic verification. Added peak RSS changed
from 135.43 to 128.68 MiB in legacy mode, and from 145.26 to 148.65 MiB in mapped
mode. The fixed diagnostic remained at 143.14 MiB. These individual runs do not
establish reproducible improvement; reduced cursor allocation churn alone does
not pass the frozen gate. All three source edits were removed, with an empty
combined diff; no test file was created. Evidence and the rejected patch remain
under `/tmp/opencode/kompjutr-read-ahead-*`.

The user approved sequential initial pack reads. Grounding narrowed that
experiment to synchronous cache-sized cursor pages: no SQL cursor survives a
return to the parser, caller callback, projection write, or await.

- Add internal `readRawForIngest(packId, offset, length)` forwarding in
  `pack/read.ts`, implemented in `pack/read/read-data.ts`. Switch only the
  initial `PackReader` callback in `pack/ingest/ingest-index.ts`. Share existing
  range validation and cross-chunk assembly rather than duplicating them.
- On a cache miss, derive the numeric sequence interval from the existing
  chunk-cache capacity (four 1 MiB rows by default). Synchronously exhaust an
  indexed `db.iterate()` query ordered by physical sequence. Decode row shape
  with the shared kit and insert owned returned bytes directly into the existing
  generation-qualified LRU. No page array, second cache, or mutable ingest mode.
- Respect the LRU's per-entry admission rule (one quarter of its budget).
  If it cannot admit a full chunk, use the existing single-row path. Use returned
  sequence numbers, not row positions, and preserve the requested missing-chunk
  error and actual final-row length. Do not add stored-byte authentication.
- Exhaust every page before returning; iterator failure closes through existing
  adapter cleanup. Only ordinary cache entries survive. Keep epoch/cache
  invalidation, post-yield abort/renewal, projections, deferred reads, and outer
  ingest cleanup unchanged. Backward prefix-inflate retries remain supported.
- Dedicated `tests/pack-ingest-read-ahead.test.ts` witnesses owned bytes across
  eviction, page-boundary reads, prefix fallback, more than 1,024 entries, final
  partial rows, buffered/streamed projections, deferred deltas, cold reads,
  low-cache fallback, and zero live page cursors at callback/abort/takeover
  boundaries. Decode/iteration failure must close the cursor.
- First measure the approved experiment on the unchanged original diagnostic
  and benchmark, preserving before artifacts. Require correct results, SQL
  at most 1,000, and material reduction in reset process peak above baseline.
  Allocation reduction alone fails the experiment; remove only its edits if
  falsified. Remaining memory above 100 MiB still blocks acceptance.
- Independent step review precedes implementation. Holding a whole-scan cursor
  across awaits is a separate design decision and is not part of this step.

### WU3 reviewed lookup-growth correction

Independent review `ses_f7a5b3e46ffe31Cjc9uey8emSu` found one blocker: each
connectivity batch's existing `objectInfo()` aggregation can scan all loose
chunks by repository, introducing B × L visits for B batches and L loose chunks.
The packed benchmark cannot expose this scan.

- Make the existing chunk aggregation in `store/objects/objects-query.ts`
  wanted-OID-driven, with explicit repository/OID indexed probes. Preserve the
  returned metadata contract, validation, source precedence, and batch sizes.
  No new API, schema, ownership, or graph state is needed.
- Materialize only OID, sequence, and `length(data)` metadata before grouping.
  Step review found the join-only variant carries whole chunk BLOBs through a
  GROUP BY sorter. Verify full EXPLAIN bytecode as well as the indexed lookup
  plan; sorter records must contain metadata rather than payloads.
- First witness the current plan on populated loose storage; then require
  repository/OID probes and verify mixed loose/packed metadata and unchanged
  fetch over multiple connectivity pages. Record rows returned separately from
  actual scan-plan evidence. Reuse existing object metadata tests.
- This narrow query correction extends WU3 territory to that one store file and
  a focused lookup-growth test. Step review precedes edits; implementation gets
  the formal WU3 fix-round re-review and leader verification.

### WU4 frozen inline-delta pool experiment

**Rejected after measurement.** Pool allocation fell from 236,716,032 to
10,616,832 bytes, but reset process peak above baseline changed from 132.88 to
151.20 MiB. Both clones verified successfully with 990 SQL under the same
two-core lease and 1 GiB/no-swap cap. One pair does not establish a reproducible
regression; it provides no evidence to retain the candidate. Only the three
experiment edits were removed; no runtime or test changes remain. Evidence:
`/tmp/opencode/kompjutr-pool-{before,after}.out`.

Bounded ownership instrumentation measured 225.75 MiB of cumulative pool
allocation/disposal before checkout, with only 3.75 MiB simultaneously allocated
and 3,246 disposals. This is allocation churn evidence, not proof of the RSS
failure's cause (`/tmp/opencode/kompjutr-owner-profile-counted.out`).

- In `pack/ingest/ingest-index.ts`, keep every inline target release in its
  `finally`, but dispose the idle pool at the existing 1,024-entry boundary
  before yielding instead of after each target. Preserve outer final cleanup;
  dispose the final partial batch before entering pending resolution.
- Retain existing pool capacity, delta working-set limits, cache ownership,
  transport, and SQL batches. No new pool or cross-operation lifetime is added.
- Review the step before editing. Verify sequential inline delta targets remain
  independent after reuse, including cold reads and abort/error cleanup; rerun
  physical membership and existing inline/deferred delta witnesses.
- Compare the same bounded ownership diagnostic and unchanged default benchmark
  before/after. Require unchanged semantic results and SQL, reduced allocation
  volume, and reduced process peak above baseline. If only allocation volume
  improves, reject this candidate as the material memory repair and remove only
  this experiment's edits. Neither forced GC nor altered baseline/cache settings
  counts as acceptance evidence.
- Territory is `ingest-index.ts` and a dedicated focused regression file.
  Independent implementation review and leader gates precede any commit.
- Step review `ses_f7a6c41f5ffektyzGL6Luqw3yP`: ready. Cache and projection
  consumers copy or synchronously consume target bytes before release. Free
  chunks are reusable in allocation preflight; effective inline bounds come
  from existing delta limits and one live target, not a separate small pool cap.

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
- 2026-09-09 — WU3 implementation reached independent review. Leader exact gate
  passed 189 tests / six files (70.48 s), including existing commit-iterator
  callers; typecheck and global lint (797 files) passed. Agent default-transport
  after measurements: clone 990 SQL and about 144.8 MiB added RSS in each mode;
  fetch 47/112 SQL legacy and 297/324 mapped, all below 100 MiB. Raw evidence is
  in `bench/results/wu3-connectivity-cost.md`. The clone reduction includes
  `bc9bd3f`; it is not attributed solely to WU3.
- 2026-09-09 — Further read-only memory qualification found glibc free arena
  space increased by 63.48 MiB before checkout, alongside 39.23 MiB allocated
  arena and 23.79 MiB V8 physical-heap increases. These counters are not an
  additive RSS partition. Native inflate engines had closed handles; backing
  stores totaled 84,305,807 bytes cumulatively, not simultaneously retained.
  WeakRef survival counts were rejected because same-job retention biases them.
  Allocation-family attribution remains open; allocator retention does not waive
  the process-peak target. Evidence: `/tmp/opencode/kompjutr-arena-profile.out`
  and `/tmp/opencode/kompjutr-zlib-owner-profile.out`.
- 2026-09-09 — WU3 independent review found one loose-chunk scan amplification;
  formal fix round uses the reviewed wanted-driven, metadata-only aggregation
  above. The join-only draft was rejected before implementation because EXPLAIN
  showed whole BLOBs entering the GROUP BY sorter. Leader E2E gate on the prior
  WU3 runtime passed 96 tests / eight files (71.05 s) under the verified 4 GiB
  cap; the query correction still requires focused verification and re-review.
- 2026-09-09 — Bounded allocation-family probes observed arena expansion during
  native inflate (15.57–19.54 MiB), SQLite pack-BLOB cursor reads (18.78–27.86
  MiB), pool acquisition (12.21–13.01 MiB), and other ingest work. These are
  allocation-boundary observations, not retained-owner totals. The final run
  verified clone with 990 workload SQL and 126.82 MiB added process peak; the
  memory target still fails. The batched pack-read plan has no temporary B-tree.
  Next qualification separates cursor-local SQLite storage from returned JS
  BLOB backing without GC. Evidence: `/tmp/opencode/kompjutr-family-*.out`.
- 2026-09-09 — Cursor qualification confirmed each individual 1 MiB pack read
  allocates approximately 2 MiB: a SQLite temporary plus an owned JS copy.
  Completion releases the SQLite allocation while retained JS bytes remain
  valid. A three-row sequential control reuses the temporary across rows;
  returned buffers remain distinct and hash correctly after completion. Matching
  Node v24.4.0 source confirms the intentional owned copy and reset behavior.
  A sequential initial pack-scan cursor is now an evidenced experiment, but it
  changes ingest traversal/read plumbing and awaits user approval. It must
  improve actual process peak, not only allocation volume; no implementation is
  authorized yet. Evidence: `/tmp/opencode/kompjutr-cursor-{profile,control}.out`.
- 2026-09-09 — WU3 lookup fix reached re-review. Leader verified 112 tests /
  five files (65.59 s), plus six loose-object tests (2.05 s). The first command
  included a nonexistent `objects.test.ts` filter; the actual loose-object file
  was then run explicitly. Global lint passed (803 files) after formatting the
  gitignored proof artifact. Indexed wanted-OID probes and metadata-only sorter
  records are covered by populated-loose bytecode and 4,097-file fetch witnesses.
- 2026-09-09 — WU3 formal fix-round re-review by
  `ses_f7a5b3e46ffe31Cjc9uey8emSu` is clean; independent 86-test gate passed.
  Leader typecheck passed and smoke passed 159 tests / 14 files (24.96 s).
  Correctness and lookup-growth gates are settled; memory acceptance remains
  open. The user explicitly approved the sequential initial pack-cursor
  experiment. Cursor/buffer lifetime grounding and independent step review
  precede implementation; the same peak-memory falsifier applies.
- 2026-09-09 — Leader pre-cursor legacy benchmark passed clone and both fetch
  phases under the verified two-core/1 GiB/no-swap scope. Clone: 990 SQL,
  145,773 returned rows, baseline 180,027,392 bytes, reset peak 322,039,808 bytes
  (142,012,416 bytes added; above target). Unchanged/one-file fetch: 47/112 SQL.
  Preserved `bench/results/wu4-cursor-before-legacy.json` before experimentation.
- 2026-09-09 — Matching mapped baseline also passed all operations: clone
  990 SQL, 145,773 returned rows, baseline 174,981,120 bytes, reset peak
  327,294,976 bytes (152,313,856 bytes added; above target). Fetch: 297/324 SQL.
  Preserved `bench/results/wu4-cursor-before-mapped.json`.
- 2026-09-09 — Fresh assessment corrected interpretation: the scenario mode
  changes fetch only; both labeled clone measurements execute the same clone
  call. Their differences are run-to-run variation, not clone-mode behavior.
  Temporary owner/family drivers use extra instrumentation and a different
  baseline sampling sequence, so only the original runner establishes the
  acceptance metric. Its memory failure remains confirmed. Global allocator
  changes observed inside a wrapper do not identify fragmentation ownership.
- 2026-09-09 — A capped, two-core `perf` capability probe failed before running
  its Node target: no permission to read syscall trace events under
  `/sys/kernel/tracing`. No global permissions or security settings were
  changed. A bounded privileged profiler capability test now requires approval;
  no new runtime optimization is justified by the current attribution evidence.
- 2026-09-09 — User approved limited sudo for the profiler capability test and,
  only if stack attribution is usable, one bounded clone capture. The workload
  remains an ordinary-user Node process under the verified lease/memory cap;
  sudo applies only to perf. No global permission/security changes are allowed.
- 2026-09-09 — After the user requested continuation, `sudo -n perf version`
  still required interactive authentication. The user's terminal credential
  cache is unavailable to the agent invocation. Preparation moved to a bounded
  capability script for execution in the user's terminal; only perf may run
  privileged, and no profiler capture or runtime change has started.
- 2026-09-09 — Profiler-script preparation incorrectly treated the preference
  for `/tmp/opencode` as a prohibition on perf's internal `/tmp/perf-XXXXXX`
  file. The leader removed that self-imposed restriction. Agent-owned scripts
  and results remain under `/tmp/opencode`; native perf temporary-file handling
  is permitted within the already approved profiler scope.
- 2026-09-09 — User-run profiler capability attached successfully, but recorded
  824 lost events (884 saved samples, 7,638,748 output bytes). It is incomplete
  and supplies no allocation-attribution conclusion. The capture's 64-page
  per-thread rings were increased to 1,024 pages; workload, time, output-byte,
  record-count, and common 1 GiB/no-swap limits remain enforced. All nine
  unprivileged collector/coordination tests passed after the change. A new
  user-run capability capture is required before profiling clone.
- 2026-09-09 — The repeated user-run capability capture is complete: 1,226
  samples, 2,070 records, 10,520,996 bytes, zero lost/throttled events and no new
  threads. Leader inspected proof stacks for Node backing stores, SQLite, zlib,
  and V8. Artifact: `kompjutr-perf-capability.v9awWYyK/run-mm3fq3on` under
  `/tmp/opencode`. Preparation of the already approved single clone capture
  proceeds with the qualified collector. Virtual-memory growth remains distinct
  from RSS and does not itself identify fragmentation ownership.
- 2026-09-09 — The user-run clone capture completed with zero lost/throttled
  events, 1,446 samples, stable threads, and passing semantic verification
  (990 SQL / 145,773 rows). Only the initial 30-second offline decode timed out.
  Leader decoded the preserved data successfully under the two-core/1 GiB cap
  with a 180-second offline deadline and unchanged output limits; no new clone
  or sudo was needed. All 1,446 samples paired successfully. Pre-materialization
  positive brk requests group as buffer backing 108,449,792 bytes, SQLite
  18,542,592 bytes, and zlib 1,654,784 bytes; V8 accessible anonymous mappings
  total 61,042,688 bytes. These gross requests are not retained bytes or RSS.
  Full-stack subfamily review is pending. Evidence:
  `/tmp/opencode/kompjutr-perf-clone.HeRUQ83X/run-v3nxhbf1/offline-kfqj3wrn`.
- 2026-09-09 — Independent raw/offline review confirms 1,446 samples form 723
  complete syscall pairs, not 1,446 calls. The pre-materialization backing
  bucket includes 75,550,720 bytes of positive brk growth through typed-array
  constructors, 20,443,136 through SQLite-to-JS BLOB copies, and 12,079,104
  through libuv read backing. Those are call-site expansion observations, not
  retained sizes. Most constructor stacks end in V8 builtins before reaching
  the decode depth cap, leaving the application origin unresolved. The owned
  SQLite copy remains required. Next diagnostic tracks numeric allocation origin
  and explicit ownership transfers at JS seams without retaining buffers or
  relying on WeakRef/finalization timing. No runtime fix is justified yet.
  Evidence: `/tmp/opencode/kompjutr-perf-review.{json,out,py}`.
- 2026-09-09 — Numeric ownership tracing reconciled 618 cache-owned backings
  totaling 12,546,536 bytes before checkout; no entry scope or pool still owned
  buffers. This does not establish physical reclamation after logical release.
  It measured 43,381,528 bytes in 663 checksum concatenations, motivating the
  narrow checksum experiment above. Step review by
  `ses_f7a6c41f5ffektyzGL6Luqw3yP` is ready: synchronous SHA consumption permits
  split updates, while tail and row ownership copies remain mandatory. Evidence:
  `/tmp/opencode/kompjutr-logical-profile-reconciled.out`.
- 2026-09-09 — Checksum experiment implementation reviewed clean by
  `ses_f7a6c41f5ffektyzGL6Luqw3yP`. Leader verified all 31 checksum witnesses and
  three existing reused-Buffer witnesses (34 tests, 2.53 s). The allocation
  probe records 43,381,528 bytes / 663 checksum joins reduced to 21 bytes / one
  short-input join, with required row copies unchanged. Two uninstrumented
  pairs observed 151.45→147.64 and 144.86→137.43 MiB added peak RSS; the modest
  reductions do not yet establish material memory qualification. Code remains
  uncommitted pending the leader's performance judgment and remaining gates.
- 2026-09-09 — Leader's unchanged checksum-candidate benchmark verified all
  phases. Clone remained 990 SQL / 145,773 rows, baseline 182,644,736 bytes and
  reset peak 323,051,520 bytes (140,406,784 bytes added; still above target).
  Further qualification is read-only: quantify failed prefix-inflate output
  allocations and full blob outputs that cannot enter the object cache before
  proposing another runtime change. No streaming-path modification is approved
  by those hypotheses alone.
- 2026-09-09 — Uncached-full-blob streaming experiment implemented after clean
  step review. Its fresh original-runner pair held checksum changes constant:
  151.3164→130.7773 MiB added peak, with 990 SQL / 145,773 rows and verified
  results. One pair is not a reproducibility claim. The four blobs now return
  null data with no native prefix attempt or exact fallback target, eliminating
  22,881,255 bytes of full-target allocations without predicting net RSS savings.
  Agent witnesses: eight new, 31 checksum, seven existing pack tests; typecheck
  and scoped lint passed. Independent implementation review and leader gates are
  running; overall 100 MiB acceptance is still open.
- 2026-09-09 — Leader verified 42 tests across checksum, uncached streaming,
  and physical membership (10.59 s). Its original benchmark passed with
  990 SQL / 145,773 rows, baseline 177,106,944 bytes and peak 317,005,824 bytes.
  Subsequent prefix-step review found a format gap missed by the prior clean
  streaming review: default pako accepts gzip while native prefix inflation
  rejects it. The retained streaming candidate is not accepted until that
  newly exposed malformed-input path is qualified and corrected. Native-Git
  verify-first work is in progress; the prefix experiment remains blocked.
- 2026-09-09 — Actual-pack qualification confirmed the gzip regression using
  a 1,024-byte blob, 29-byte gzip stream, and zero-leading valid pack checksum.
  All production incremental consumers require RFC 1950 zlib. The reviewed
  correction now sets `windowBits: 15` in both pako wrappers. Agent verification
  passed 80 focused tests, typecheck, and scoped lint. Leader verification and
  independent implementation review are running; performance work remains
  paused until the format correction is clean.
- 2026-09-09 — Strict zlib correction committed as `b6c9dbb` after clean
  independent static review and leader verification: 76 focused tests (12.87 s),
  four maintenance-header witnesses (8.65 s), typecheck, global lint (808 files),
  and smoke (159 tests / 14 files, 27.35 s). The reviewer's independent execution
  timed out waiting for a CPU lease before Vitest started; runtime evidence is
  the completed leader gate. Prefix selection still requires renewed step review.
- 2026-09-09 — Renewed prefix review required preserving `ECORRUPT` when
  malformed Adler-32 data bypasses native inflation. The adjusted decoder-push
  catch was reviewed ready; reader SQL remains outside it. Implementation's
  fresh original-runner pair measured 136.3828→112.7539 MiB added peak with
  unchanged 990 SQL / 145,773 rows and semantic pass. Clone wall time increased
  10.3% in this single pair. The diagnostic observed 98 redirected entries and
  30,511 remaining successful native attempts; allocation counts are not net
  RSS savings. Agent gates passed 77 focused tests, typecheck, and scoped lint.
  Independent implementation review and leader verification are in progress.
  The <100 MiB criterion remains unmet.
- 2026-09-09 — Prefix implementation reviewed clean; independent execution
  passed 38 tests (6.29 s), leader passed 77 tests (13.00 s). The leader's
  original benchmark did not reproduce the 112.75 MiB observation: baseline
  178,753,536 bytes, reset peak 316,874,752 bytes, added 138,121,216 bytes
  (131.72 MiB), 990 SQL / 145,773 rows, all clone/fetch semantics passed.
  The candidate's memory benefit is not yet reliably established. A bounded
  diagnostic now localizes the peak on the current runtime before choosing any
  further change; earlier phase attribution predates these experiments.
- 2026-09-09 — Current instrumented phase localization passed semantics at
  990 SQL. Pre-checkout peak was 102.05 MiB above its diagnostic baseline;
  checkout raised it by 16.96 MiB to 119.02 MiB. These are not acceptance
  measurements. Cache ownership remained about 12.5 MB with no active entry or
  pool owners at phase boundaries. Checkout created 20,043 exact targets totaling
  109,366,881 bytes and 140,140,656 bytes of pako state arrays cumulatively.
  Bounded read-only attribution now distinguishes complete-input inflation from
  incremental stored reads before proposing any read-path change. Reclamation
  and net RSS effects remain unknown. Evidence:
  `/tmp/opencode/kompjutr-current-phase-owners.out`.
- 2026-09-09 — Complete-input attribution reconciled all 20,043 checkout exact
  inflations to `PackDataReader.#inflateBytes()`; incremental stored reads
  contributed none. The user approved the narrow native-decoder experiment and
  independent step review was ready. Two original-runner pairs with other
  candidates fixed measured 140.13→126.84 and 142.71→121.37 MiB added peak.
  All four runs passed semantics at 990 SQL / 145,773 rows; CPU totals decreased
  slightly while clone wall time was mixed. Agent gates passed 91 focused tests,
  typecheck, and scoped lint. Implementation review and leader tests are pending.
  No after-run meets <100 MiB. Evidence:
  `/tmp/opencode/kompjutr-complete-native-{before,after}{,-repeat}.out`.
- 2026-09-09 — The user asked which commit worsened memory. No causal commit
  has been established: the saved pre-WU3 clone already measured 141.61 MiB
  above baseline. Historical evidence inspection is now looking for comparable
  good/bad revisions before proposing a bisect. Allocation attribution on the
  current runtime does not establish historical regression causality.
- 2026-09-09 — Complete-input native decoding reviewed clean; reviewer ran
  14 tests (2.10 s), leader ran 91 tests across six files (16.93 s). Leader's
  original benchmark passed all phases: clone 990 SQL / 145,773 rows, baseline
  168,681,472 bytes, reset peak 303,149,056 bytes, added 134,467,584 bytes
  (128.24 MiB). This still fails the memory gate. Historical baseline inspection
  remains in progress; no further optimization has been started.
- 2026-09-09 — Historical inspection found no comparable passing clone under
  100 MiB. Older workflow evidence records 245.6 MiB at `a531efa` and seven
  228.11–253.39 MiB runs at `d0c059ce`; setup differences prevent attributing
  changes to runtime commits. There is no established good/bad bisect interval.
- 2026-09-09 — The user explicitly approved a separate forced-GC diagnostic
  to test delayed collection. At most two current-runtime diagnostic clones
  compare identical boundary instrumentation with and without `--expose-gc`
  interventions before and after checkout. Record heap, ArrayBuffers, external,
  current RSS, and reset peak separately; peak cannot decrease after GC.
  Existing CPU lease and 1 GiB/no-swap limits, fixture, transport, and cache
  settings remain required. Forced GC is authorized only for this diagnostic,
  never production or acceptance evidence. No allocator trimming or tuning.
- 2026-09-09 — Forced-GC diagnostics released JS heap and, after checkout,
  about 27.3 MiB of ArrayBuffers without a proportional RSS decrease; glibc
  free-arena bytes increased. This supports delayed collection plus allocator
  retention, not a retained-object leak diagnosis or a production GC remedy.
  The user-requested `--max-old-space-size=128` run passed semantics at 990 SQL
  but measured 146.80 MiB added peak. Neither diagnostic passes the original
  100 MiB gate or serves as default-runner acceptance evidence.
- 2026-09-10 — Final integration review by `ses_f7a6c41f5ffektyzGL6Luqw3yP`
  is clean. Default closure runs passed all clone/fetch phases: clone added peaks
  126.06/140.23 MiB, 990 SQL / 145,773 rows; legacy fetch 47/112 SQL, mapped
  fetch 297/324. Typecheck, global lint (810 files), and smoke (159 tests / 14
  files, 16.37 s) passed. Runtime units committed as `8f66785`, `7b1cfd8`,
  `1f63421`, and `3fc7965`.
- 2026-09-10 — The initial full-suite run with four leased CPUs/two lanes hit
  the verified 4 GiB cgroup limit before any slice output completed. The unit
  journal reports `oom-kill`, 4G peak; exit 143 alone was not the evidence.
  `availableParallelism()` correctly returned four, so this was two concurrent
  slices sharing the cap, not an affinity bug. Retry uses the existing
  `TEST_FULL_LANES=1` control with two leased CPUs and the same 4 GiB/no-swap cap.
- 2026-09-10 — The serial full-suite run completed all slices in 1,287.9 s.
  Two pack witnesses failed: native complete-input overflow lost the established
  `exceeds its indexed size` diagnosis and became generic invalid-zlib text.
  Both still rejected input, but the regression requires correction rather than
  weakening assertions. All other slices passed. Narrow reproduction and a
  reviewed native error-code mapping are in progress before the full rerun.
- 2026-09-10 — The two failing pack witnesses were reproduced unchanged, then
  corrected by mapping only native `ERR_BUFFER_TOO_LARGE` to the indexed-size
  corruption diagnosis with its cause preserved. The helper's one-byte minimum
  for a zero declaration is checked explicitly. Damaged Adler retains its
  invalid-zlib diagnosis and `Z_DATA_ERROR` cause. Agent verification passed
  both original witnesses and all 14 complete-input tests, typecheck, and scoped
  lint. Leader's affected-slice run and independent review are pending.
- 2026-09-10 — Overflow correction reviewed clean and committed as `a03eb01`.
  Leader's complete affected groups passed 60 tests (36.51 s), global lint passed.
  The final full suite then passed all 17 slices: 3,649 tests, five existing
  ignore skips, 1,372.6 s. Pack name filters cover all 108 pack tests across five
  slices; their other reported skips are slice selection, not disabled tests.
  Command: `TEST_FULL_LANES=1 GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true npm run
  test:full` under two leased vCPUs and the verified 4 GiB/no-swap wrapper.
  Evidence: `/tmp/opencode/kompjutr-final-full-fixed.out`. The earlier OOM and
  two-test failure were resolved; neither was counted as a passing run.
