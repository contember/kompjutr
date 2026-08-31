> **OUTCOME — shipped 2026-08-31.** Native clone, fetch, and push now support
> stable cancellation; shallow repositories can deepen and unshallow with graph
> proof before publication; and legacy, multi-ref, and wildcard pushes can protect
> each destination with explicit or tracking-derived leases. Commit map: plan →
> `c178eed`; WU1 → `3f8a0d9`; WU2 → `22ec43a`; WU3 → `f68fcdb`; WU4 →
> `1171bf8`; WU5 → `57b7417`; closure fixes → `84384b1`, `c71d8e3`.
> Verification: narrow four-path safety review approved; focused witnesses passed
> WU1 132, WU2 59, WU3 242, WU4 75, WU5 65 tests; smoke passed 164 tests;
> typecheck, Biome check, and build passed. The exhaustive runner passed every
> root, protocol, pack, filesystem, and shell slice; its final E2E slice passed
> separately at 96/96 after the outer 15-minute command limit terminated the
> combined process. Backlog closed: 13, 15, 38. Deferred: full-suite scheduling
> performance → [backlog 64](../backlog/64-speed-up-full-test-suite.md); the
> sprint's explicit protocol-v2, SSH, mapped-fetch deepening, pull/ls-remote
> cancellation, and Computer API exclusions remain out of scope.

# Sprint — Deepening and network safety (2026-08-31)

**Goal.** Let shallow repositories cross their boundary later, protect leased
push destinations from stale observations, and cancel clone, fetch, and push
without publishing incomplete local state or concealing an uncertain remote result.

**Theme.** Backlog 38, 13, and 15 harden the same settled
Smart HTTP flow: discover, transfer or plan, authenticate, then publish.

## Refs re-verified at HEAD (2026-08-31)

- ⚠ Backlog touch points under `src/core/` and `src/sqlite/` are stale; current
  ownership is protocol → store → ops → client — `../../src/git/CLAUDE.md:7`.
- ✔ Legacy fetch has absolute `depth`, but no `deepen` or `unshallow`; mapped
  fetch excludes depth selection — `../../src/git/ops/network.ts:100-124`.
- ⚠ Upload-pack already emits absolute `deepen N` and parses `shallow` plus
  `unshallow`, but it lacks relative-deepen intent and strict response validation —
  `../../src/git/protocol/remote.ts:323-349`,
  `../../src/git/protocol/remote.ts:360-412`,
  `../../src/git/protocol/remote.ts:452-485`.
- ✔ Fetch publishes refs and shallow changes through one shallow-revision CAS
  transaction — `../../src/git/store/fetch-publication.ts:612-657`.
- ✔ Complete pack publication intentionally precedes ref/shallow publication;
  an interrupted pack is unreadable and a complete unreachable pack is reclaimable —
  `../../src/git/store/pack/ingest.ts:98-104`,
  `../../src/git/store/pack/ingest.ts:166-194`.
- ✔ Rebase fails closed at a shallow boundary —
  `../../src/git/ops/rebase-plan.ts:104-107`.
- ✔ Push expands multi-ref mappings, discovers before pack planning, and retains
  the advertised OID as receive-pack's request-time CAS —
  `../../src/git/ops/push.ts:404-469`.
- ✔ Receive-pack already maps failures after a POST may have been consumed to
  `EPUSHUNCERTAIN` — `../../src/git/protocol/receive-pack.ts:651-735`.
- ✔ Network options and `GitHttpRequest` have no `AbortSignal`; the default
  transport does not pass one to `fetch` —
  `../../src/git/ops/network.ts:65-72`,
  `../../src/git/protocol/transport.ts:7-21`,
  `../../src/git/protocol/transport.ts:82-108`.
- ✔ Clone already has provisional ownership and exact-owner discard —
  `../../src/git/ops/network.ts:1489-1510`,
  `../../src/git/ops/network.ts:1575-1591`.
- ⚠ Installed `@cloudflare/computer` 0.2.1 types expose none of signal,
  deepen/unshallow, or lease, so this sprint is native-API only —
  `../../package-lock.json:222-225`,
  `../../node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:265-296`,
  `../../node_modules/@cloudflare/computer/dist/shared-DDTBl1w_.d.ts:433-469`.

## Work units

### WU1 — Abortable transport, clone, and fetch (effort L)

- **Problem.** Clone and fetch cannot stop discovery, auth retry, pack ingest,
  hydration, or pre-publication work. Unfinished response streams only release
  their reader lock — `../../src/git/protocol/transport.ts:44-74`.
- **Verify first.** Add one pre-aborted transport test, then run
  `npx vitest run tests/protocol.test.ts tests/clone.test.ts tests/concurrency-clone.test.ts tests/concurrency-fetch.test.ts`.
- **Scope.** Add a validated `AbortableNetworkOptions` mixed only into clone,
  fetch, and push; keep `RemoteAuthOptions`, pull, and ls-remote unchanged. Carry
  `signal` through `GitHttpRequest`, default/custom transports, auth retry,
  upload-pack, pack ingest, and a shared signal-aware hydration seam. Cancel
  unfinished streams and release existing leases/reservations. Return stable
  `EABORTED` with `signal.reason` as cause.
- **Commit point.** Check cancellation immediately before synchronous
  `publishFetchRefs()` or `publishProvisionalClone()` begins. Once either call
  starts, it completes and the operation returns success even if the signal is
  aborted afterwards. Clone checkout cancellation is therefore observed before
  publication/checkout begins, not during its synchronous transaction.
- **Acceptance / witness.** The verify-first command covers discovery, confirmed
  401 before retry, ingest/yield, hydration, fetch-token disposal, exact-owner
  clone discard, both pre-publication checks, no post-commit `EABORTED`, stream
  cleanup, and a clean retry. Cancelled work exposes no new refs, shallow state,
  worktree, provisional clone, or incomplete pack.
- **Touch points.** `../../src/git/protocol/transport.ts`,
  `../../src/git/protocol/remote.ts`, `../../src/git/protocol/stream.ts`,
  `../../src/git/store/pack/ingest.ts`, `../../src/git/ops/network.ts`,
  `../../src/git/ops/push.ts` (type and validation seam only),
  `../../tests/protocol.test.ts`, `../../tests/clone.test.ts`,
  `../../tests/concurrency-clone.test.ts`,
  `../../tests/concurrency-fetch.test.ts`.

### WU2 — Abortable push with explicit certainty states (effort L)

- **Problem.** A naive abort wrapper could report cancellation after a remote
  mutation completed, or hide a confirmed result while local tracking reconciliation
  is cancelled — `../../src/git/ops/push.ts:404-498`.
- **Verify first.** Run
  `npx vitest run tests/receive-pack.test.ts tests/push.test.ts tests/concurrency-network.test.ts`
  after adding one abort immediately before POST and one after request consumption.
- **Scope.** Propagate WU1's signal through discovery, hydration, both pack
  preflight passes, upload, response parsing, and tracking reconciliation. Use this
  state machine: before POST invocation → `EABORTED`; POST invocation through
  complete report-status → abort/failure is `EPUSHUNCERTAIN`; confirmed 401 closes
  its body and may return `EABORTED` before retry; after complete report-status →
  return the confirmed `PushResult`. If tracking reconciliation is then aborted,
  return `tracking: { outcome: "failed", code: "EABORTED", ... }` instead of
  replacing the confirmed remote result. Never replay a cancelled POST.
- **Acceptance / witness.** The verify-first command pins every state transition,
  request/response cleanup, no tracking update without complete report-status,
  and the confirmed-result-plus-failed-tracking outcome.
- **Touch points.** `../../src/git/ops/push.ts`,
  `../../src/git/protocol/receive-pack.ts`,
  `../../tests/receive-pack.test.ts`, `../../tests/push.test.ts`,
  `../../tests/concurrency-network.test.ts`.

### WU3 — Relative deepen and full unshallow (effort L)

- **Problem.** Existing absolute-depth fetch can change shallow rows, but it
  cannot move an existing boundary by N or remove it safely —
  `../../src/git/ops/network.ts:1261-1419`.
- **Verify first.** Run
  `npx vitest run tests/protocol.test.ts tests/clone.test.ts tests/concurrency-fetch.test.ts tests/store.test.ts tests/rebase.test.ts`
  after adding a real-Git case that fails rebase before deepening and succeeds after.
- **Scope.** Add mutually exclusive legacy options `deepen` (positive safe integer)
  and `unshallow` (boolean), excluding `depth` and each other. Require `shallow` for
  boundary changes and `deepen-relative` for relative deepen. Implement unshallow
  as Git's effectively unlimited absolute depth; reject unshallow on a complete
  repository with `EINVAL` before network. Force negotiation even when tips exist.
- **Boundary proof.** Reject malformed OIDs, duplicate contradictions, and
  `unshallow` OIDs absent from the request's captured shallow set. Compute proposed
  boundary = captured boundary − validated unshallow + validated shallow. Require
  every added boundary to be an existing reachable commit. Authenticate every newly
  exposed parent edge and fetched commit root through to the proposed boundary before
  using the existing atomic shallow/ref publication and CAS.
- **Acceptance / witness.** The verify-first command proves protocol framing and
  capability failures; real-Git parity for repeated deepen, deepen on complete,
  and unshallow; malformed/contradictory responses; stale-publication races; no
  boundary movement after failed graph proof; and rebase before/after deepening.
- **Touch points.** `../../src/git/ops/network.ts`,
  `../../src/git/protocol/remote.ts`, `../../src/git/ops/repository.ts`,
  `../../src/git/store/fetch-publication.ts`, `../../tests/protocol.test.ts`,
  `../../tests/clone.test.ts`, `../../tests/concurrency-fetch.test.ts`,
  `../../tests/store.test.ts`, `../../tests/rebase.test.ts`.

### WU4 — Per-destination force-with-lease (effort L)

- **Problem.** Fresh discovery protects request-time races but lets `force: true`
  overwrite work created since the caller's earlier fetch —
  `../../src/git/ops/push.ts:226-260`.
- **Verify first.** Run
  `npx vitest run tests/push.test.ts tests/concurrency-network.test.ts tests/client.test.ts`
  after replacing the misleading current “fresh lease” title with real stale-lease
  coverage.
- **Scope.** Add at most 1,024 partial per-destination entries:
  `type PushLeaseExpectation = { expected: string | null } | { tracking: true }`
  and `leases?: Readonly<Record<string, PushLeaseExpectation>>`. Unlisted
  destinations retain current semantics; explicit `null` means expected absent.
  Normalize keys after mapping expansion and reject malformed, colliding, duplicate,
  or unused entries. Matching a lease never implies force.
- **Ordering.** Before the first await, synchronously snapshot every tracking-derived
  expectation. Permit derivation only for branch destinations on a configured named
  remote; reject explicit URLs, non-branch destinations, and missing tracking refs.
  Compare all leased destinations, including no-ops, with discovery before hydration
  or pack planning. Mismatch returns stable `ESTALELEASE` without POST. Preserve the
  discovered OID in each receive-pack command for races after discovery.
- **Acceptance / witness.** The verify-first command covers explicit OID/absence,
  tracking derivation, invalid contexts, creations, deletions, no-ops, wildcard and
  mixed multi-ref pushes, lease without force, no planning/POST when stale, a tracking
  ref changed during discovery without changing the snapshot, and a remote race after
  discovery rejected by receive-pack CAS.
- **Touch points.** `../../src/git/ops/push.ts`,
  `../../src/git/ops/refspec.ts`, `../../src/git/client.ts`,
  `../../tests/push.test.ts`, `../../tests/concurrency-network.test.ts`,
  `../../tests/client.test.ts`.

### WU5 — Public contract and integrated witness (effort M)

- **Problem.** Native exports, stable errors, compatibility claims, and the three
  safety features need one cross-feature closure witness.
- **Verify first.** Run
  `npx vitest run tests/network-safety.test.ts tests/client.test.ts tests/public-exports.test.ts tests/compat.test.ts`.
- **Scope.** Add `tests/network-safety.test.ts` using the real HTTP backend; export
  native option types; document `EABORTED`, `ESTALELEASE`, and `EPUSHUNCERTAIN`;
  update current support/concurrency reference. Keep Computer compatibility unchanged
  and typed. Delete backlog 13, 15, and 38 only at sprint closure.
- **Acceptance / witness.** The verify-first command shallow-clones, aborts and
  retries deepen, unshallows, rejects stale multi-ref leases without POST, then
  succeeds with refreshed leases. `npm run typecheck` proves native exports and
  unchanged compatibility.
- **Touch points.** `../../src/git/client.ts`, `../../src/git/index.ts`,
  `../../src/compat/computer.ts`, `../../tests/network-safety.test.ts`,
  `../../tests/client.test.ts`, `../../tests/public-exports.test.ts`,
  `../../tests/compat.test.ts`, `../reference/git-support.md`,
  `../reference/concurrency.md`, `../backlog/README.md`, `../INDEX.md`.

## Review strategy

Tests are the gate for ordinary API plumbing and parity. One independent review
covers only changed lines on these critical paths:

1. signal check → synchronous local publication → success or cleanup;
2. shallow response validation → proposed boundary → graph proof → atomic publication;
3. tracking lease snapshot before first await → discovery comparison → preserved wire CAS;
4. POST invocation/401/report-status → post-status tracking certainty.

| Scope | Required gate | Escalate when |
|---|---|---|
| Sprint integration | All WU1-WU4 witnesses, then one review of only the four paths above. Re-review only safety-path lines changed by findings. | A fix changes transaction or ownership boundaries, POST retry policy, refspec expansion, or pack visibility; add only that affected seam. |
| WU1 | Exact WU witness; no separate review. | A new transaction, ownership model, or pack-deletion path is introduced. |
| WU2 | Exact WU witness; critical certainty lines join integration review. | POST replay or deterministic state classification cannot be preserved. |
| WU3 | Exact WU witness; boundary proof/publication joins integration review. | Schema, pack publication, traversal, or shallow CAS changes. |
| WU4 | Exact WU witness; lease snapshot/comparison/CAS joins integration review. | Lease matching moves after planning or weakens non-fast-forward checks. |
| WU5 | Exact WU witness plus typecheck; no review. | Compatibility needs casts, untyped forwarding, or peer API changes. |

## Test cadence

- Run each WU's exact witness while iterating. Use real `git http-backend` for
  success/parity and mocks only for schedules or malformed transport.
- Run `npm test` after each WU; keep the routine smoke gate under 30 seconds.
- After narrow review fixes, rerun affected focused files and `npm test`.
- At closure run `npm run typecheck`, `npm run check`, and `npm run build`, then
  `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true npm run test:full` once.
- Reproduce full-suite failures in their exact file before rerunning the full suite.

## Out of scope (explicit)

- Protocol v2, SSH, submodules, new timeout/retry policy, and outbound deltas.
- Mapped-fetch deepening; mapped fetch already excludes absolute depth.
- Pull, ls-remote, local-only commands, shell, filesystem, and maintenance cancellation.
- Changing pack/ref transaction ownership or eagerly deleting complete unreachable packs.
- Persisted/server leases or leases that imply force.
- New Computer compatibility options before its typed interface supports them.

## Decisions

- Lease maps are partial and keyed by normalized destination; expected absence is
  explicit, and tracking expectations are snapshotted before discovery.
- Confirmed cancellation is `EABORTED`; possible receive-pack completion remains
  `EPUSHUNCERTAIN`; complete report-status is never hidden by later tracking failure.
- Cancellation stops being observable when synchronous local publication starts.
- Graph proof precedes shallow/ref publication; complete unreachable packs remain
  maintenance-owned recovery state.
- Unshallow uses protocol v0's unlimited absolute depth, not an invented capability.

## Sequencing

1. WU1 settles transport, hydration, and local cancellation commit points.
2. WU2 follows WU1; WU3 can run in parallel with WU2.
3. WU4 follows WU2 so push behavior has one owner at a time.
4. WU5 follows WU3 and WU4, then integrates the public contract and witness.
5. Run the narrow safety review, focused fixes, and closure gates.

Keep WU commits separate. Land any genuinely shared type seam before parallel work.

## Plan review

- **Reviewer:** independent general agent against HEAD `537b26c`
- **Verdict:** approved after two focused follow-ups
- **Material findings:** First pass required exact cancellation commit/certainty
  states, pre-discovery lease snapshots, complete proposed-boundary proof, shared
  hydration sequencing, native-only signal scope, an executable integration witness,
  corrected relative links, and four narrowly reviewed precursor paths. All are
  incorporated above. Follow-up also serialized the two `push.ts` owners and
  grounded the native-only compatibility claim in the installed type declarations.

## Run log

- The exhaustive gate exposed a pre-sprint store-export witness omission and two
  Biome failures. Commit `c71d8e3` restored the baseline before the gate rerun.
- The combined exhaustive command exceeded its outer 15-minute limit in the final
  E2E slice after every earlier slice passed. The exact remaining E2E slice then
  passed 96/96. Full-suite scheduling work graduated to
  [backlog 64](../backlog/64-speed-up-full-test-suite.md).
