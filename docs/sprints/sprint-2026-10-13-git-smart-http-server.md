# Sprint — Git Smart HTTP server in a Durable Object (2026-10-13)

**Goal.** Let an ordinary Git CLI clone, fetch, and push a SQLite-backed bare
repository served by a Durable Object over Smart HTTP.

**Theme.** Complete the server half of the existing Git transport while keeping
repository publication atomic, checkout updates explicit, and transfer memory
bounded. Milestone A is a usable push target after WU3; milestone B is the
complete remote after WU6. Preparing this sprint does not start implementation.

This plan graduates the former `ideas/git-server-inside-the-durable-object.md`.
The user selected bare remote semantics: pushes change objects and refs;
checkout changes are separate operations. The ownership decision is
[ADR-0032](../decisions/0032-serve-bare-repositories-with-explicit-checkouts.md).

## Refs re-verified at HEAD (2026-10-13)

Baseline: `a695b22`. Paths below are relative to the repository root. These are
code-reading findings, not results of running the planned witnesses.

- ⚠ Bare ownership does not exist yet. Shared-store open requires at least one
  checkout and exactly one primary, then constructs that primary:
  `packages/git/src/store/database/database-registry.ts:45`.
  Shared operations and HEAD ownership bind through the primary:
  `packages/git/src/store/repository/shared-core.ts:109`.
- ⚠ Ref mutation requires a selected checkout, checks only one expected ref,
  and does not reject updating an attached branch:
  `packages/git/src/store/refs/refs.ts:261`. Its branch-in-use check at line 303
  protects checkout attachment, not remote publication. Ref names also need a
  receive-side namespace-conflict policy (`a` versus `a/b`).
- ✔ Pack publication has a synchronous lifecycle callback inside the transaction
  that makes objects and commit projections visible:
  `packages/git/src/store/pack/ingest.ts:133`.
- ⚠ Connectivity is no longer entirely new. `PackConnectivityCheck` checks
  references at publication but supports fetch-specific shallow and promisor
  exceptions: `packages/git/src/store/pack/ingest/ingest-references-check.ts:98`.
  Receive must also check every commanded tip, including tips outside the pack.
- ⚠ Thin packs are rejected when a delta base is outside the pack:
  `packages/git/src/store/pack/ingest/ingest-pending.ts:333`. Preserve the
  self-contained stored-pack invariant; advertise receive capability `no-thin`.
- ⚠ Push limits remain 512 new commits and 100,000 objects, and the plan owns an
  object array: `packages/git/src/ops/push/push-plan-types.ts:3`.
  `packages/git/src/store/pack/full-object-stream.ts:60` separately enforces
  100,000 objects and takes an array. Neither is a full-clone planner.
  SQL statement targets are not admission limits.
- ✔ Bounded pkt-line parsing and a transition to the remaining raw byte stream
  exist: `packages/git/src/protocol/stream.ts:54`.
- ✔ Concurrent ingest already returns `EBUSY` under a renewable repository
  lease: `packages/git/src/store/pack/lifecycle/lifecycle-ingest.ts:150`.
  No synchronous mutation guard or SQLite transaction may span network awaits.
- ⚠ Current maintenance roots do not include active uploads:
  `packages/git/src/store/maintenance/roots/root-contracts.ts:72`.
  Remembering an OID in JavaScript does not keep its objects alive.
- ✔ `Workspace` is a composition, not a DurableObject class or HTTP handler:
  `packages/do/src/runtime/workspace.ts:33`.

Protocol grounding: [Git HTTP protocol](https://git-scm.com/docs/http-protocol),
[pack protocol](https://git-scm.com/docs/pack-protocol), and
[capabilities](https://git-scm.com/docs/protocol-capabilities). In particular,
HTTP negotiation is stateless and may take multiple POSTs; receive clients must
honor `no-thin`. These replace the idea's single-round and thin-ingest assumptions.

## Contract and boundaries

- SHA-1, Smart HTTP v0, `refs/heads/*` and `refs/tags/*`, including annotated
  tags. Advertise only implemented capabilities. Witness modern Git's fallback
  when it sends `Git-Protocol: version=2`; also test explicit v0.
- Receive capabilities: `report-status`, `delete-refs`, `no-thin`. Upload:
  `multi_ack_detailed`, `side-band-64k` and `symref=HEAD:...` where applicable.
  Use detailed ACK negotiation so native clients replay common haves across
  stateless requests; do not advertise `no-done` or `include-tag`. Clients that
  do not select sideband get the ordinary raw pack response. Without detailed
  ACK negotiation, send NAK for nonterminal rounds and use only the common
  closure proven by the final request, sending a full closure if necessary.
- The server binding supplies a validated repository identity, never a URL
  translated into a filesystem path. The example maps one repository to one DO;
  the engine remains repository-scoped. Cross-repository reads and writes fail.
- Authorization belongs to the outer Worker. Discovery and both POST endpoints
  independently require repository read/write permission before storage access.
  The first version has repository-wide read permission, not per-ref ACLs.
  Advertise only heads/tags and their default HEAD; never internal tracking refs.
- Serve complete repositories. Reject shallow repositories and repositories
  with unresolved promises before starting a transfer; recheck relevant state
  at publication. No implicit upstream fetch or hydration inside the server.
- Bare repositories allow zero or more ordinary checkouts and no primary
  checkout. Existing workspace repositories retain exactly one primary.
  Server default-branch metadata is repository-owned and may name an unborn
  branch; it is separate from every checkout's HEAD. Removing a bare
  repository's last checkout keeps its refs and objects.
- Wire parsing stays in `git/protocol`, orchestration in `git/ops`, and owned
  rows/publication in `git/store`. A public Git server facade assembles these;
  the DO HTTP adapter consumes public exports. Preserve the existing layer
  ranks and package graph; update their witnesses for new modules, not exceptions.

## Work units

### WU0 — Native Git protocol witnesses (effort S)

- **Problem.** Existing HTTP tests drive kompjutr as a client. A server needs
  the reverse direction, including the negotiation rounds omitted by the idea.
- **Verify first.** Read `tests/helpers/http-backend.ts`, `tests/helpers/git.ts`,
  and the protocol documents above. Capture native clone/fetch/push requests
  with fixed identity/dates and record the installed Git version.
- **Scope.** Add a streaming Node test adapter for the future server handler and
  a differential oracle backed by `git http-backend`. Use protocol fixtures to
  prove `no-thin`, empty advertisements, v0 fallback, and multi-round requests
  using the exact proposed server capabilities, including common-have replay
  without creating a second server implementation. Spawn Git asynchronously
  so it cannot block the HTTP server's event loop.
- **Acceptance / witness.** `tests/server/protocol-oracle.test.ts`: initial and
  incremental push request shapes, empty remote, deletion without a pack,
  no-new-object update, and a fetch requiring more than one negotiation round.
  Capture the terminal request after `ACK ... common` and `ACK ... ready`;
  require correct final ACK/pack framing and also exercise the no-detailed-ACK
  fallback. A trace from the native server's default capability set alone is
  insufficient evidence for our selected capability contract.
  Handwritten bytes are reserved for malformed input or capability fixtures the
  native oracle cannot emit. No copied GPL test code.
- **Touch points.** `tests/helpers/`, new `tests/server/`, existing `protocol/`
  codecs as read-only references.

### WU1 — Repository ownership without a checkout (effort L)

- **Problem.** Registry, ref mutations, reflog access, destruction, and shared
  operations depend on a primary checkout even when no files are needed.
- **Verify first.** Trace `database-registry.ts`, `database-routing.ts`,
  `database-checkout-mutations.ts`, `lifecycle.ts`, `shared-core.ts`,
  `shared-refs.ts`, and their callers before changing the ownership seam.
- **Scope.** Add an explicit bare repository lifecycle and public create/open
  operations. Establish repository-owned services independent of a selected
  checkout, including pack callbacks, reads, direct-ref reflogs, maintenance,
  and destruction. Keep checkout HEAD/index/operation journals checkout-owned.
  Store and validate a default branch separately. Support attaching and removing
  ordinary checkouts to a bare repo without inventing a dummy primary.
  Retain workspace and provisional-clone invariants and existing error semantics.
- **Acceptance / witness.** `tests/bare-repository.test.ts`: empty and populated
  cold reopen; refs/reflog/maintenance with no checkout; first attachment,
  removal of the last checkout, routing, stale handles, and explicit repository
  destruction. Run `tests/database.test.ts`, `tests/worktrees.test.ts`,
  `tests/reflog-api.test.ts`, and `tests/import-graph.test.ts` as regression gates.
- **Touch points.** Git `store/database`, `store/repository`, `store/refs`,
  `store/checkout`, `store/schema`, `ops/repository`, public exports, and DO
  composition. Update module instructions with the implemented ownership model;
  no schema migration is required in this development-only project.

### WU2 — Discovery, request decoding, and HTTP composition (effort M)

- **Problem.** Existing codecs consume server responses; no server request or
  advertisement API exists.
- **Verify first.** Compare WU0 traces with `ByteReader`, pkt-line encoders,
  ref-name/OID guards, and current error codes. Freeze the small public handler
  contract before wiring the example.
- **Scope.** Implement GET `info/refs?service=...` and POST `git-upload-pack` /
  `git-receive-pack`, correct content types and no-cache headers. Encode empty,
  unborn/default HEAD, ordered refs and peeled tags. Parse strict UTF-8 commands,
  capabilities, zero OIDs, and the pkt-line/raw-pack boundary once. Bound command
  counts and buffered frames, enforce a declared inbound pack-byte limit while
  reading (including absent/false Content-Length), and propagate cancellation.
  Name the memory/storage failure behind every limit; do not invent SQL budgets.
  Add a minimal Worker/DO example with read/write authorization on every route.
- **Acceptance / witness.** `tests/server/discovery.test.ts` and
  `tests/server/http.test.ts`: real `git ls-remote`; empty/default HEAD and tags;
  method/service/media-type errors; unauthorized discovery and direct POST;
  two repository identities; split/truncated frames; duplicate commands and
  capabilities; invalid refs/OIDs; chunked bodies and limit boundary failures.
  Disabled write service rejects before reading/indexing a pack.
- **Touch points.** New Git protocol server family, public server facade, DO
  adapter/example, `tests/server/`, `tests/public-exports.test.ts`.

### WU3 — Receive-pack and safe ref publication (effort L)

- **Problem.** Ingest publication exists, but strict receive connectivity,
  multi-command CAS, and checkout protection do not.
- **Verify first.** Trace the ingest lifecycle callback and mutation guard;
  compare native Git's per-ref success/failure and namespace conflicts.
- **Scope.** Validate the full command set, ingest provisionally, and reuse the
  existing connectivity machinery with no shallow/promisor exceptions. Validate
  every new tip and its namespace's object type, including existing-object tips.
  Before writing, evaluate expected absence/old OID, ref prefix conflicts, and
  attached-branch protection in the final publication transaction. A checkout
  attached during upload must also block its branch's update or deletion.
  Ordinary non-atomic pushes get per-ref outcomes: apply the accepted subset
  together with pack publication, then emit truthful `report-status`.
  Invalid pack/connectivity publishes nothing; if every command is rejected,
  roll back this incoming pack's publication and clean only its provisional
  owner. Never remove a published pack after yielding to another operation.
  Handle delete-only requests, zero-object packs, and legal no-pack cases from
  WU0 without pretending every push ingests objects. Preserve native bare ref
  replacement semantics; there is no separate `--force` bit on the wire.
  Reject unsupported namespaces and check namespace conflicts against existing
  refs and accepted commands using shared ref-family validation.
- **Acceptance / witness.** `tests/server/receive-pack.test.ts`: initial,
  incremental and multi-ref push, branch replacement, tag create/replace/delete,
  no-object updates, old-OID conflicts, prefix conflicts, attached branches,
  missing/wrong-type targets, broken checksums and deliberately incomplete or
  thin packs. `tests/server/receive-recovery.test.ts`: fail before publication,
  abort, lease contention/expiry, cold reopen, and disconnect after publication.
  A lost success response must not undo committed refs or cause server replay.
- **Touch points.** Git `ops` server family, `store/refs`, pack lifecycle and
  connectivity, protocol status encoders. Keep existing client transfer paths
  covered by `tests/receive-pack.test.ts`, `tests/fetch-pack-connectivity.test.ts`,
  `tests/fetch-pack-connectivity-incremental.test.ts`, and `tests/push.test.ts`.

### WU4 — Paged outbound closure and transfer retention (effort L)

- **Problem.** The outbound push plan materializes its graph; no active transfer
  is a maintenance root. Raising push limits would retain the same failure mode.
- **Verify first.** Trace push planning/writer callers and maintenance root,
  epoch, source-generation and sweep transitions. Reuse the low-level writer and
  bounded object readers; do not route a clone through `planPushObjects`.
- **Scope.** Use operation-owned SQL rows for the traversal frontier, visited
  set and deduplicated object plan. Compute the wanted closure minus proven
  common closure, including tag chains and excluding gitlink repositories.
  Count the finalized plan for the pack header, then page it in stable byte
  order through the writer. Never hold a SQL cursor or transaction across awaits.
  Pin the operation's roots in the maintenance model before planning; make
  registration/renewal/release participate in root epochs and destructive-step
  fences. Re-read physical sources as needed instead of trusting cached offsets
  across maintenance. Give each owner an expiry and bounded cleanup; resume
  after expiry fails before another object read unless ownership is renewed
  while still valid. Cancellation and cold restart reclaim only abandoned work.
  Keep network queues and read/deflate batches bounded with backpressure and
  real runtime yield points. Receive's existing metadata bounds still apply.
- **Acceptance / witness.** `tests/server/pack-plan.test.ts`: compare the exact
  object set with native Git on merges, divergent histories, shared trees,
  annotated tags and gitlinks; validate emitted packs with native Git.
  `tests/server/transfer-lifetime.test.ts`: slow reader, cancellation, ref move,
  GC, owner expiry, cold restart, and repository destruction. The large-history
  benchmark in WU6 must cross both existing push caps without raising them.
- **Touch points.** Git server ops, new repository-owned transfer tables,
  `store/maintenance`, shared pack writer/reader seams, schema and ownership docs.

### WU5 — Stateless upload-pack (effort L)

- **Problem.** Real clients negotiate over multiple requests; a single
  `want`/`have`/`done` happy path is not sufficient for fetch.
- **Verify first.** Play WU0 request traces against the parser and a small
  repository; compare ACK/NAK termination with the native server.
- **Scope.** Handle `want`, `have`, flush-ended rounds and `done`, including
  selected `multi_ack_detailed` common/ready replies and the terminal ACK before
  pack bytes, without a server-side negotiation session. Native clients must
  replay the common haves needed by the next request. Never treat a bare ACK as
  a continuation reply. Validate wants against currently advertised
  heads/tags and their advertised peeled targets, not arbitrary stored OIDs.
  Accept haves as common only when proven reachable in the served repository.
  Snapshot and retain accepted roots at each pack-producing POST. Discovery
  does not create a lease; a no-longer-allowed stale want fails for client retry.
  Once accepted, ref movement cannot change the pack's selected OIDs. Encode
  sideband only when selected, handle late errors as stream failures, and
  release readers/owners on success, failure and cancellation.
- **Acceptance / witness.** `tests/server/upload-pack.test.ts`: real Git empty
  and populated clone, default branch, branches/tags, no-op fetch, incremental
  and divergent fetch, forced v0 and modern-default fallback. Require a
  multi-round fetch with the exact advertised capability set, verify common-have
  replay and terminal framing, and run `git fsck --full` in received repositories.
  `tests/server/upload-access.test.ts`: internal refs/unadvertised OIDs,
  forged haves, stale discovery and direct POST authorization.
- **Touch points.** Protocol request/response family, server ops, DO stream
  adapter, `tests/server/` and native client helper.

### WU6 — Integration, DO qualification, and measured serving cost (effort M/L)

- **Problem.** Node correctness alone proves neither DO lifecycle behavior nor
  that full-object packs fit the runtime's memory/CPU envelope.
- **Verify first.** Read `bench/CLAUDE.md` and the current workerd harness. Select
  pinned complete fixtures; the existing full-history `blob:none` fixture alone
  cannot qualify a complete Git server.
- **Scope.** Add `tests/server/concurrency.test.ts` with deterministic barriers
  and both completion orders: receive/receive, upload/receive, upload/GC,
  receive/checkout attach, and restart around publication. Add
  `tests/server/workerd.test.ts` for a small real-Git lifecycle against the actual
  DO adapter. Add a `bench:server` runner for native and workerd send/receive,
  full clone and one-commit incremental fetch/push, with `--runtime=node|workerd`
  and `--fixture=medium|large` selecting documented pinned complete fixtures.
  Its large fixture must exceed 512 new commits and 100,000 outbound objects.
  Record transferred bytes, statements/rows, CPU, local wall time, peak memory,
  cgroup limits, longest uninterrupted CPU stretch, and cancellation cleanup.
  Read timing/CPU from the host or supported profiling/analytics, never from
  synchronous DO clock deltas. Establish measured regression baselines.
- **Acceptance / witness.** Run the entire `tests/server/` slice and existing
  network/concurrency regressions. Benchmark all four runtime/fixture pairs and
  check received refs/object closure with Git. Record the supported envelope
  and any target misses honestly: local workerd RSS is not isolate memory, and
  a local pass is not proof of production fit. Streaming/yielding does not reset
  the DO CPU allowance. If representative serving exceeds real memory/CPU
  capacity, update this plan for compressed-entry reuse or bounded deltas before
  declaring that envelope supported; never silently truncate history or impose
  a projected-statement refusal.
- **Touch points.** `tests/server/`, `bench/server/`, `package.json`, CI test
  discovery, public example, and reference docs for architecture, concurrency
  and supported Git behavior. Deployments, if later requested, go through CI.

## Review strategy

Independent reviewers inspect actual code and witnesses, not only green output.
For WU1, WU3, WU4, WU5 and integration, fix blocking findings and repeat review
of the affected scope until clean. Editorial fixes do not restart code review.
For WU2, repeat boundary review after fixes affecting parsing, authorization,
routing or limits; documentation-only fixes need only the direct check.

| Scope | Risk | Required gate and review | Escalate when |
| --- | --- | --- | --- |
| WU0 | Oracle validity and deadlocks | Exact WU0 witness; author review | A mock replaces native interoperability evidence |
| WU1 | Shared lifecycle and ownership | WU1 witnesses + independent lifecycle review | Existing workspace/clone invariants change |
| WU2 | Untrusted input and access boundary | WU2 witnesses + independent boundary review | Authorization moves into Git or repo routing changes |
| WU3 | Object/ref publication and partial success | WU3 witnesses + independent failure-path review to clean | New ingest semantics or client regressions |
| WU4 | Memory, retention and destructive GC | WU4 witnesses + independent storage review to clean | New root/source lifetime or pack format |
| WU5 | Negotiation correctness and object disclosure | WU5 witnesses + independent protocol review to clean | More capabilities, shallow/filter, or per-ref ACLs |
| WU6 / integration | Cross-WU durability and real runtime | Concurrency/workerd/native witnesses, measurements, independent integration review, then closure suite | Capacity failure, unsupported native-client behavior, or new storage/deployment architecture |

## Test cadence

All named new witnesses and `bench:server` are deliverables, not commands that
already pass at the planning baseline.

- **Per WU:** `cpu-lease run -n 2 -- npx vitest run <exact witness files above>`.
  Run only the named relevant regressions while iterating. Add `test:e2e`,
  `test:fs`, or `test:local-mounts` when lifecycle/composition edits cross those
  domains; do not rerun every slice after each edit.
- **Routine integration:** `cpu-lease run -n 4 -- npm test` (target <30 seconds,
  excluding lease wait), `cpu-lease run -n 2 -- npm run typecheck`, and
  `cpu-lease run -n 2 -- npm run check`. Use the configured formatter before
  committing and fix findings. The server slice is additional to smoke.
- **Benchmarks:** `cpu-lease run -n 2 --no-smt -- npm run bench:server --
  --runtime=node --fixture=medium`, repeated for workerd and the large fixture.
  Reserve once per invocation; do not nest leases if the runner acquires one.
  Stop if lease enforcement is unavailable. Record exact invocations and fixture
  revisions with results; compare matched settings per `bench/CLAUDE.md`.
- **Closure:** after focused fixes and final independent review,
  `cpu-lease run -n 4 -- env GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true npm run test:full`
  once, plus `cpu-lease run -n 2 -- npm run build` and
  `cpu-lease run -n 2 -- npm run package:smoke` for public exports/composition.
- **Failure loop:** reproduce a failing full-suite file or domain slice, fix it,
  and rerun full only after that witness is stable. No timing assertions in
  normal Vitest tests. Small workerd correctness stays separate from benchmarks.

## Out of scope (explicit)

- Automatic checkout updates on push, deployment hooks, or an agent workflow.
- Protocol v2, SHA-256, shallow/deepen, partial-clone filters, LFS, submodule
  hosting, arbitrary ref namespaces, signed pushes, push options and custom hooks.
- Thin receive and negotiated atomic pushes. Do not advertise these; add them
  only with their own contracts and witnesses. Non-atomic multi-ref push is in.
- Outbound delta selection or compressed-pack reuse by default. Revisit the
  [delta idea](../ideas/outbound-delta-compression.md) if WU6 proves it necessary;
  a generic compressor is not a prerequisite to the first correctness milestone.
- Multi-tenant hosting/product configuration, per-ref permissions, schema
  migrations, local Git-compatible CLI, R2 offload, and production deployment.

## Decisions

- [ADR-0032](../decisions/0032-serve-bare-repositories-with-explicit-checkouts.md)
  records bare ownership, explicit checkout updates and the Worker auth boundary.
- Keep self-contained stored packs and request non-thin pushes. Reuse strict
  ingest and transactional publication, not an alternate object store.
- Implement push first to qualify the mutation boundary independently from
  clone cost. Full-object output is the first implementation; measurement can
  make compression work a completion dependency, not an assumed optimization.
- SQL-backed upload planning and explicit retained roots replace reuse of the
  push planner. Never repurpose checkout journals or synthetic public refs as
  transport scratch space. Write the precise retention ADR with WU4's reviewed
  schema and failure witnesses, before relying on that lifetime in upload-pack.
- One repository per DO in the example is a routing choice, not a new global
  storage restriction. Existing repository isolation remains mandatory.

## Sequencing

WU0 → WU1 → WU2 → WU3 (milestone A) → WU4 → WU5 → WU6 (milestone B).
WU0 produces compatibility evidence before the ownership change. Native Git
tests accompany each WU rather than arriving only at closure. After WU1 fixes
the public contracts, WU2 codec work and WU4 closure work can proceed separately
only with disjoint files; shared schema/ref/maintenance edits stay coordinated.
Qualification harness work can start early, but WU6's verdict requires WU3–WU5.

## Plan review

- **Reviewer:** independent agent Hooke (`review_written_sprint`), 2026-10-13,
  against `a695b22`; reviewed the written plan and current source.
- **Verdict:** approved after correction and re-review; no blocking findings.
- **Material findings:** base ACK/NAK was insufficient for the proposed native
  stateless multi-round flow. The contract now includes `multi_ack_detailed`,
  exact-capability witnesses, common-have replay, terminal ACK/pack framing and
  an explicit fallback. WU2's boundary fix/re-review rule is also explicit.
  The reviewer confirmed bare lifecycle, receive publication, GC retention,
  dependencies, acceptance witnesses and test cadence. Earlier exploratory
  findings on final attached-branch checks, total-ref-rejection pack lifetime,
  namespace conflicts and receive metadata bounds are incorporated above.

## Run log

- 2026-10-14: User authorized executing the complete sprint. Baseline remains
  `a695b22`; the approved plan and ADR are the only initial working-tree changes.
  Execution uses the current branch, disjoint agent territories, independent
  reviews and explicit-path commits. WU0 starts first; WU1 seam exploration is
  read-only until its prerequisite protocol evidence is available.
- 2026-10-13: Prepared the sprint at `a695b22` from the accepted chat proposal.
  No implementation, tests or performance measurements have run for this sprint.
- 2026-10-13: Independent plan review approved after the negotiation correction.
  Documentation links, source citation locations, existing witness paths and
  `git diff --check` passed. `cpu-lease run -n 2 -- npm run check` passed
  (1,075 files); this is a repository lint/format check, not runtime evidence.
