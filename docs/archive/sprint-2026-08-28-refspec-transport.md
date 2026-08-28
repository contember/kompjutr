> **OUTCOME — shipped 2026-08-28.** Added bounded remote ref discovery,
> structured exact and wildcard fetch, one atomic exact-ref publication seam,
> bounded multi-root pack planning, ordered multi-command receive-pack, and a
> structured native push with independent tracking reconciliation. Commit map:
> plan → `24a59de`; WU0 → `47d383b`; WU1 → `480c1c9`; WU2 → `f751053`; WU3 →
> `5ed9421`; WU4 → `978bc02` with aggregate ingest budgeting in `bdf94d0`; WU5
> → `b882e5b` with shared option validation in `0544c67`; WU6 → `ca8b789`; WU7
> seams → `2175df6`, `28870b5`, and `345b27c`; closure witnesses → `7847156`,
> `3786994`, `aa27cdd`, `5616646`, `76bbee7`, and `972fc44`; closure → this
> archived record. Verification: the 132-test routine gate passed in 6.21 s;
> the complete sliced runner passed 2,674 tests with five known skips and zero
> failures in 369.49 s; its slowest slice was the 96-test E2E gate at 62.80 s.
> Typecheck, Biome, build, and diff validation passed. Independent T3 review
> approved every implementation area after affected fixes. Backlog closed: 08
> and 42. Deferred: configured textual refspecs, pruning mapped fetches,
> force-with-lease, abort signals, deepening, partial clone, SSH, credential
> helpers, and protocol v2 remain outside this sprint.

# Sprint — Refspec transport (2026-08-28)

**Goal.** Move bounded sets of arbitrary refs through Smart HTTP: discover
remote refs, fetch explicit or wildcard mappings atomically, and push one
atomic multi-ref command set with complete per-ref results.

**Theme.** Fetch and push already share one advertisement and bounded pack
pipeline, but each operation selects one branch-shaped result. One structured
refspec model establishes names, wildcard expansion, force, and destination
uniqueness; the two directions then retain their different publication and
protocol guarantees.

## Refs re-verified at HEAD (2026-08-28)

Planning was grounded at `ba3a1a8`. `✔` = confirmed live · `⚠` = drift or
missing contract found during planning.

- ✔ `FetchOptions` exposes only `ref` and `remoteRef`; `selectRefs()` resolves
  one selector or the branch advertisement and cannot map a destination
  namespace — `src/core/ops/network.ts:63`, `src/core/ops/network.ts:128`.
- ✔ Fetch already discovers once, negotiates multiple wants, ingests a complete
  provisional pack, and calls one transactional publication only after object
  and tag authentication — `src/core/ops/network.ts:477`,
  `src/core/ops/network.ts:496`, `src/core/ops/network.ts:633`.
- ⚠ The fetch publication token can fence one remote-tracking prefix and exact
  global tag candidates, but not arbitrary destinations such as
  `refs/checkpoints/*` — `src/sqlite/store.ts:322`,
  `src/sqlite/store.ts:5881`.
- ⚠ `discover()` already bounds the advertisement to 16,384 entries, 4 MiB
  retained state, and 16 MiB input, but `parseAdvertisement()` retains ref
  names and oids without validating their syntax, identity, or uniqueness —
  `src/core/protocol/remote.ts:41`, `src/core/protocol/remote.ts:189`,
  `src/core/protocol/remote.ts:261`.
- ✔ Push resolves one local branch to one remote branch and supports one force
  or deletion flag; arbitrary refs, oid sources, and command batches have no
  input shape — `src/core/ops/push.ts:21`, `src/core/ops/push.ts:148`.
- ✔ `receivePack()` serialises exactly one command, requests only
  `report-status` and optional sideband, and rejects a result unless it contains
  exactly that one ref — `src/core/protocol/receive-pack.ts:21`,
  `src/core/protocol/receive-pack.ts:74`,
  `src/core/protocol/receive-pack.ts:125`.
- ⚠ `planPushObjects()` authenticates and bounds one commit closure. It cannot
  union several roots or start from a tag, tree, blob, or explicit oid —
  `src/core/ops/push-plan.ts:134`.
- ✔ `PushResult` already carries a per-ref status record, while the current
  operation throws away that useful result when any one ref is rejected —
  `src/core/ops/kinds.ts:66`, `src/core/ops/push.ts:239`.
- ✔ The native facade forwards the core fetch and push types directly; the
  Computer adapter is a separate projection whose legacy single-branch surface
  can remain narrow — `src/git/client.ts:185`, `src/git/client.ts:229`,
  `src/compat/computer/client.ts:112`, `src/compat/computer/client.ts:304`.

## Contract frozen before implementation

WU0 verifies this contract against Git 2.54.0; it does not choose production
behavior. Any mismatch stops the sprint, amends this section and the affected
WU, and receives an independent contract-delta review before WU1 starts.

### Ref update matrix

All structured names are full `refs/...` names. A transfer wildcard contains
exactly one `*` in both source and destination. Expansion substitutes the same
byte sequence and orders results by destination with Git's UTF-8 byte order.
Duplicate destinations fail before a publication token or network POST.

| Direction and destination | Create | Update without `force` | Update with `force` | Object constraint |
|---|---|---|---|---|
| Fetch to `refs/heads/*` | allowed | commit fast-forward only | allowed | the new target must still be a commit |
| Fetch to `refs/tags/*` | allowed | same oid only | allowed | any authenticated Git object |
| Fetch to another `refs/*` | allowed | allowed | allowed | any authenticated Git object |
| Push to `refs/heads/*` | allowed | commit fast-forward only | allowed | the new target must still be a commit |
| Push to `refs/tags/*` | allowed | same oid only | allowed | any authenticated Git object |
| Push to another `refs/*` | allowed | only a commit/tag update whose peeled commit fast-forwards | allowed | a creation may target any authenticated object; tree/blob replacement needs force |

- A fetch destination under `refs/heads/*` that is checked out by any linked
  checkout fails with `EBRANCHFAIL` after discovery and expansion but before a
  publication token or upload POST. Force does not override the checkout lock.
  The publication token also fences the repository's checkout-HEAD revision;
  a checkout that attaches to a selected branch after preflight makes final
  publication fail with `ESTALEFETCH`, without moving any ref.
- An exact missing fetch source fails with `EREFNOTFOUND`. A wildcard with no
  source matches returns an empty mapped result after one discovery GET, with
  zero POSTs, no publication token, and no local mutation.
- An exact push source with no local match fails with `EREFNOTFOUND` before
  discovery and fails the whole set even when another mapping matches. Each
  wildcard with no local matches contributes no command or result row; other
  expanded mappings continue normally. Only when the complete validated set
  expands to zero destinations does push return before discovery: zero
  GET/POST and exactly `{ ok: true, error: null, unpack: { ok: true }, refs: [],
  tracking: { outcome: "not-applicable" } }`. A deletion of a missing remote ref
  is also a confirmed no-op. Creation and deletion do not require force;
  deletion has no `force` field.
- The remote decides whether its currently checked-out branch may move. A
  complete `ng` status is a confirmed result, not a client-side transport
  error.
- A non-atomic complete report may contain accepted and rejected refs. An
  atomic complete rejection leaves every remote ref unchanged. Mixed `ok` and
  `ng` statuses from a request negotiated as atomic violate the protocol and
  throw `EPUSHUNCERTAIN`.

### Exact public TypeScript surface

The native facade exports these shapes. `RemoteAuthOptions` and
`GitDirOptions` retain their current fields. `remote` and `url` are mutually
exclusive at both the type and runtime boundary; omitting both selects
`remote: "origin"`. A URL target has no configured-remote tracking effects.

```ts
export type RemoteTarget =
  | { readonly remote?: string; readonly url?: never }
  | { readonly remote?: never; readonly url: string };

export interface FetchRefspec {
  readonly source: string;
  readonly destination: string;
  readonly force?: boolean;
}

export type PushRefspec =
  | {
      readonly source: string;
      readonly destination: string;
      readonly force?: boolean;
    }
  | {
      readonly source: null;
      readonly destination: string;
      readonly force?: never;
    };

export type GitLsRemoteOptions = GitDirOptions &
  RemoteAuthOptions &
  RemoteTarget & {
    readonly patterns?: readonly string[];
  };

export interface RemoteRefView {
  readonly name: string;
  readonly oid: string;
}

export interface LsRemoteResult {
  readonly refs: readonly RemoteRefView[];
  readonly headRef: string | null;
}

export type GitFetchOptions = GitDirOptions &
  RemoteAuthOptions &
  RemoteTarget &
  (
    | {
        readonly refspecs: readonly [FetchRefspec, ...FetchRefspec[]];
        readonly depth?: never;
        readonly ref?: never;
        readonly remoteRef?: never;
        readonly singleBranch?: never;
        readonly prune?: never;
        readonly tags?: never;
      }
    | {
        readonly refspecs?: never;
        readonly ref?: string;
        readonly remoteRef?: string;
        readonly depth?: number;
        readonly singleBranch?: boolean;
        readonly prune?: boolean;
        readonly tags?: boolean;
      }
  );

export interface FetchRefUpdate {
  readonly source: string;
  readonly destination: string;
  readonly oid: string;
}

export type FetchResult =
  | {
      readonly mode: "legacy";
      readonly defaultBranch: string | null;
      readonly fetchHead: string | null;
      readonly updates: readonly [];
    }
  | {
      readonly mode: "mapped";
      readonly defaultBranch: string | null;
      readonly fetchHead: null;
      readonly updates: readonly FetchRefUpdate[];
    };

export type GitPushOptions = GitDirOptions &
  RemoteAuthOptions &
  RemoteTarget &
  {
    readonly atomic?: boolean;
    readonly pushOptions?: readonly string[];
  } &
  (
    | {
        readonly refspecs: readonly [PushRefspec, ...PushRefspec[]];
        readonly ref?: never;
        readonly remoteRef?: never;
        readonly force?: never;
        readonly delete?: never;
      }
    | {
        readonly refspecs?: never;
        readonly ref?: string;
        readonly remoteRef?: string;
        readonly force?: boolean;
        readonly delete?: boolean;
      }
  );

export interface PushRefStatus {
  readonly ref: string;
  readonly ok: boolean;
  readonly error: string | null;
}

export type PushTrackingResult =
  | { readonly outcome: "not-applicable" | "unchanged" | "updated" | "stale" | "deferred" }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string };

export interface PushResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly unpack: { readonly ok: true } | { readonly ok: false; readonly error: string };
  readonly refs: readonly PushRefStatus[];
  readonly tracking: PushTrackingResult;
}
```

Mapped fetch results are ordered by destination and always set `fetchHead` to
`null`, including one mapping. An empty wildcard returns `updates: []`.
Legacy native calls return `mode: "legacy"` and `updates: []`; the Computer
adapter continues to project only `{ defaultBranch, fetchHead }`.

Push statuses retain command order. `error` is `null` exactly when unpack and
every ref status are successful; otherwise it is the unpack error, or the first
command-order ref error. `ok` and `error` describe the confirmed remote result;
tracking has its own outcome and cannot change them. A complete unpack or ref
rejection resolves this result. An unpack failure paired with any `ok` ref, or
missing, duplicate, extra, malformed, or truncated status after POST, throws
`EPUSHUNCERTAIN`.

Expanded push destinations, including advertised same-oid updates and missing
deletions, each receive one ordered result row. No-ops are synthesized as
successful and omitted from the receive-pack command set. An all-no-op push
performs discovery but no POST; a named remote may still reconcile its branch
tracking refs from that confirmed advertisement. The one exception is a local
refspec set whose complete expansion is empty: it returns the empty successful
result before discovery because it has no destination to observe or reconcile.
All mapping, auth-header, push-option, and aggregate bounds are validated first.
Valid `atomic` and push options are vacuously successful without checking remote
capabilities because no remote operation exists; malformed or oversized local
options still fail before the zero-network return.

### Discovery and tag contract

- `lsRemote` performs one logical upload-pack discovery and no POST. Under the
  existing transport policy that logical GET has at most three physical
  attempts: the initial attempt, one retry after a transport failure, and one
  authenticated retry after a later 401. It returns validated advertisement
  order, including `HEAD` and matching peeled `refs/tags/*^{}` rows. `headRef`
  comes from exactly one
  `symref=HEAD:<canonical refs/...>` capability. Duplicate-equal symrefs are
  accepted once; conflicting or malformed symrefs fail as corrupt input. When
  both HEAD and its target row are advertised their oids must match; an absent
  target is allowed for an unborn or hidden branch.
- Its supported pattern subset is Git wildmatch without path magic: literals,
  `*`, `?`, bracket sets/ranges/negation, and backslash escaping. `*` may cross
  `/`. Accepted patterns match Git; this API rejects an unclosed bracket or
  trailing escape as `EINVAL` instead of treating malformed syntax as a
  literal. Each pattern is matched against the full ref and every suffix
  beginning immediately after `/`; a row is returned once if any pattern
  matches.
- Mapped fetch does not auto-follow or bulk-fetch tags and therefore rejects
  `tags` and `depth`. An explicitly mapped annotated tag adds both its tag oid
  and advertised peeled target to the first request. Transfer mappings expand only actual
  `refs/...` rows; `HEAD` and `refs/tags/*^{}` metadata rows never become source
  or destination mappings. A non-empty mapped fetch performs one logical
  upload-pack exchange: one initial POST and at most one byte-identical retry
  solely after a 401. A POST transport failure is never retried. Legacy fetch,
  clone, and pull retain current auto-tag behavior, including one bounded
  fallback exchange when `include-tag` omits a required annotated tag object.

### Local fetch state by outcome

| Last completed stage | Durable state allowed after failure |
|---|---|
| Input validation | none; zero GET/POST and no token |
| Discovery, expansion, checkout-lock preflight, or empty wildcard | none; one logical GET (at most three physical attempts), zero POST, and no token |
| Publication token issued, before complete pack ingest | the internal fetch generation/fence may advance; an incomplete provisional pack may remain reclaimable; no destination, shallow, reflog, or ref-root maintenance change |
| Complete pack ingest, before publication | authenticated complete objects/packs and their object-maintenance bookkeeping may remain readable/reclaimable; the fetch fence may advance; no destination, shallow, reflog, or ref-root maintenance change |
| Publication transaction fails or is stale | same allowed object residue as above; every destination, shallow boundary, reflog, and ref-root maintenance value remains at its pre-publication state |
| Publication commits | all destination refs, shallow changes, reflogs, and ref-root maintenance metadata commit together |

Every path releases the operation memory reservation. Cold reopen must expose
exactly the durable state declared in the table.

### Post-push local reconciliation

After any complete report, remote status is final for this call and is never
hidden by a later local error. For a named remote with at least one successful
`refs/heads/*` destination, one tracking publication token is acquired before
POST. After status, one receive-pack rediscovery observes post-receive-hook
targets; if that GET fails, confirmed command targets are used. Successful
branch destinations publish their tracking refs and reflogs in one transaction.
Rejected and custom destinations never enter that transaction.

- `updated` means the batch committed; `unchanged` means every selected
  tracking target already matched.
- `stale` means another local operation won the fence; no tracking or reflog
  row from this call commits.
- `deferred` means rediscovery found a changed target that is not an
  authenticated local object; tracking remains unchanged and the caller may
  fetch it.
- `failed` reports a stable local code/message after transaction rollback.
  The method still returns the confirmed remote `PushResult` and never throws
  after a complete status solely because tracking reconciliation failed.
- `not-applicable` covers explicit URLs and results with no successful branch
  destination.

### Composed budgets

Each fetch, push, or `lsRemote` call owns one root `MemoryReservation` from the
repository's shared `MemoryCoordinator`. Discovery, refspec compilation and
expansion, remote/auth option text, publication snapshots, push planning,
retained status/error text, and pack ingest/generation charge and release named
portions of that same reservation. No component creates an independent 64 MiB
allowance. Streamed wire input remains separately bounded; retained receive
status/result text is capped at 8 MiB. The existing 64 MiB operation ceiling is
therefore aggregate.

One SQL admission model covers local ref resolution, planning, both possible
outbound pack body openings (initial and 401 replay), publication snapshots,
multi-ref tracking publication, and
reflogs. Every local SQL statement in one operation decrements the same
1,000-statement budget. Push rejects a worst-case estimate, including one auth
body replay, above 1,000 before POST. Before a fetch POST, the operation reserves
the larger of final publication/reflog cost and failure-cleanup cost, then gives
ingest only `1,000 - statements already used - reserved finalization` statements.
The database gate refuses to execute statement 1,001. Exact
1,024-command/status and maximal mapped-fetch witnesses assert the complete
operation's aggregate memory high-water and SQL count, including its failure
path, never component subtotals. A separate cold reopen proves the declared
durable residue.

### Public failure codes and request certainty

| Phase / outcome | Public result |
|---|---|
| Conflicting target/selection fields, empty typed list, malformed mapping or push option, exact input duplicate destination, malformed `lsRemote` pattern | throw `EINVAL` before GET/POST |
| Push wildcard or exact/wildcard destination collision | throw `EINVAL` after local expansion but before discovery/POST |
| Fetch wildcard or exact/wildcard destination collision | throw `EINVAL` after discovery/expansion but before token/POST |
| Invalid canonical input ref or invalid expanded fetch destination | throw `EINVALIDREF` before request, or after discovery but before token/POST, respectively |
| Valid local push object whose type is forbidden at its destination | throw `EINVALIDREF` before POST |
| Authenticated fetched object whose type is forbidden at its destination | throw `EINVALIDREF` after ingest but before publication; durable residue follows the fetch failure table |
| Input/admission mapping, pattern, command, retained-memory, or shared-SQL first excess before POST | throw `E2BIG`; no ref mutation and no POST |
| Fetch protocol/ingest/publication first excess after its GET or POST | throw `E2BIG`; no ref publishes and durable residue follows the fetch failure table |
| Safe local push generation first excess before the complete body checksum | throw `E2BIG`; the incomplete request cannot move a remote ref |
| Missing configured remote / unsupported URL scheme | throw `ENOREMOTE` / `EURLSCHEME` before request |
| Missing exact local push or exact remote fetch source | throw `EREFNOTFOUND` at the phase frozen in the matrix; empty wildcards use their direction-specific successful no-op contract |
| Selected local branch is checked out | throw `EBRANCHFAIL` before token/POST |
| Branch or custom-namespace update rejected by its non-force ancestry/type rule / tag replacement without force | throw `ENONFASTFORWARD` / `ETAGFAIL` before publication or push POST |
| Missing, corrupt, or shallow local push source/closure, or non-limit local pack-body failure before the final checksum | throw `EPUSHLOCAL`; the incomplete request cannot move a remote ref |
| Requested receive-pack capability is absent | throw `EUNSUPPORTED` before POST |
| Auth callback throws or returns malformed credentials | throw `EAUTH`; fetch moves no refs, and push has not sent an authenticated POST |
| Final discovery or fetch POST transport/non-200 failure, including final 401 | throw `EHTTP`; fetch moves no refs |
| Remote upload-pack `ERR` or a complete pack missing a selected root | throw `EFETCHFAIL`; fetch moves no refs |
| Remote receive-pack discovery `ERR` | throw `EPUSHREJECTED` before POST |
| Malformed advertisement, pkt-line, pack, or authenticated object | throw `ECORRUPT`; fetch moves no refs |
| Fetch publication loses its ref/checkout fence | throw `ESTALEFETCH`; state follows the failure table |
| Final push POST returns 401 | throw `EHTTP`; the auth contract treats it as an unprocessed request and witnesses no remote ref move |
| Any other non-200 push response, POST transport/read failure, sideband fatal, impossible unpack/status combination, or incomplete/malformed status after the body may have been consumed | throw `EPUSHUNCERTAIN`; do not retry |
| Receive-pack status, sideband, or retained-result first excess after POST | throw `EPUSHUNCERTAIN` with the underlying `E2BIG` as `cause`; do not retry |
| Complete receive-pack unpack/ref report, including any `ng` | resolve the ordered `PushResult`; no rejection is converted to a thrown error |
| Post-status tracking reconciliation is stale, deferred, or fails | resolve the same confirmed remote `PushResult` with its exact `tracking` outcome |

Fetch progress/message callback failures are wrapped as `EFETCHFAIL` and move no
refs. Push progress/message callback failures after POST are
`EPUSHUNCERTAIN`. `cause` retains the original callback, transport, or local
stream error. The initial and authenticated POST bodies are byte-identical;
401 is the only condition that opens a second POST body.

## Work units

### WU0 — Pin refspec transport behavior against real Git (effort M)

- **Problem.** The frozen product contract depends on Git details that must be
  measured rather than inferred from the current one-branch implementation.
- **Verify first.** Use disposable bare origins and the installed Git binary to
  capture command exit, advertised rows, updated refs, receive-pack capability
  behavior, and the exact no-match and partial-result outcomes.
- **Scope.** Add one product-independent contract file covering every row and
  edge in the frozen ref update matrix: checked-out branches in the primary and
  a linked checkout; creations; same-oid and replacement tags; commit, tag,
  tree, and blob targets in custom namespaces; forced and non-forced updates;
  exact and wildcard no-match; deletion; duplicate destinations; `ls-remote`
  literals, `*`, `?`, bracket ranges/negation, escaping, tail matching, HEAD,
  and peeled tags; atomic and non-atomic mixed status; push options; hooks that
  change a successful target; full-oid sources; transport failure, 401 retry,
  final auth rejection, and non-200/fatal/truncated push responses. Record the
  structured API cases as test-local data, not production types.
- **Acceptance / witness.** The external Git probe passes twice and proves
  remote/local refs and exit/status output after every accepted and rejected
  command set. A mismatch amends the contract and requires independent review
  before WU1; the probe never silently defines a third behavior.
- **Touch points.** `tests/refspec-contract.test.ts`,
  `tests/helpers/git.ts`, `tests/helpers/http-backend.ts`.

### WU1 — Define and bound the structured refspec model (effort M)

- **Problem.** Ref validation is split between a branch-only receive-pack
  helper and the SQLite ref validator, while no code can distinguish exact,
  wildcard, oid-source, or deletion mappings.
- **Verify first.** Run the WU0 grammar matrix through the current branch helper
  and `requireRefName()`; enumerate where their accepted languages differ from
  Git.
- **Scope.** Implement the exact `FetchRefspec`, `PushRefspec`, and public
  result shapes above. New typed mappings require full `refs/...` names; a push
  source may instead be one full oid. Deletion and oid sources cannot be
  wildcarded. Compile each mapping once, expand in Git byte order, reject
  duplicate destinations, and validate substituted names with the existing
  canonical ref rules. Bound input and expanded mappings to 1,024 each and
  every ref/pattern to 1,024 UTF-8 bytes; charge all retained compiled and
  expanded state to the operation reservation. Establish the root transport
  memory and SQL budget plus the shared validation/error helpers used by later
  WUs. Validate advertisement rows as
  `HEAD`, a full ref, or one peeled `refs/tags/...^{}` pseudo-ref with a full
  oid. Reject malformed/duplicate rows and malformed or conflicting
  `symref=HEAD` capabilities before selection. Export only public types and
  limits, not compiled state.
- **Acceptance / witness.** Unit parity covers exact and wildcard expansion,
  non-BMP Git-byte ordering, empty matches, invalid names, wildcard placement,
  oid and deletion sources, pre-discovery exact duplicates, zero-network push
  wildcard collisions, empty-plus-nonempty push expansion, exact-missing
  failure of a mixed set, post-discovery fetch wildcard collisions, malformed
  advertisements, and every exact/first-excess bound.
- **Touch points.** `src/core/ops/refspec.ts`,
  `src/core/protocol/remote.ts`, `src/sqlite/ref-validation.ts`,
  `src/git/index.ts`, `src/index.ts`, `tests/refspec.test.ts`,
  `tests/protocol.test.ts`, `tests/public-exports.test.ts`.

### WU2 — Expose bounded remote ref discovery (effort M)

- **Problem.** `discover()` returns all upload-pack refs internally, but callers
  cannot perform `ls-remote` or select a namespace before a later operation.
- **Verify first.** Compare the WU0 pattern-tail and peeled-tag rows with the
  validated advertisement produced at HEAD.
- **Scope.** Add the exact `GitLsRemoteOptions` and `LsRemoteResult` above over
  one logical upload-pack discovery and the existing auth session. Compile the frozen
  tail-wildmatch grammar once per pattern, reject malformed input, retain each
  advertisement row at most once in wire order, and include matching HEAD and
  peeled tag rows. Allow at most 1,024 patterns of 1,024 UTF-8 bytes and return
  at most the advertisement ceiling of 16,384 validated refs; the first excess
  throws `E2BIG`, never truncates. Charge compiled/result state to the operation
  reservation and make no repository mutation.
- **Acceptance / witness.** A real Smart HTTP server matches `git ls-remote` for
  no patterns, exact/tail/wildcard patterns, HEAD, annotated/lightweight tags,
  empty results, transport retry followed by auth retry, malformed input, and
  exact limits. Request logs prove at most three physical GET attempts and no
  POST.
- **Touch points.** `src/core/ops/network.ts`,
  `src/core/protocol/remote.ts`, `src/git/client.ts`, `src/git/index.ts`,
  `src/index.ts`, `tests/ls-remote.test.ts`,
  `tests/public-exports.test.ts`.

### WU3 — Fence arbitrary exact fetch destinations (effort L)

- **Problem.** The transactional fetch publisher treats only tags as exact
  global candidates. Refspec destinations outside the one tracking prefix
  would otherwise race or publish in separate transactions.
- **Verify first.** Exercise the current publication token with one
  `refs/checkpoints/x` candidate and confirm it is rejected before any mutation.
- **Scope.** Generalise the tag-only candidate set to bounded exact ref
  candidates while retaining the existing tracking-prefix, remote HEAD, tag,
  shallow, generation, revision, memory, SQL, and reflog rules. The token
  snapshots every selected destination's raw target. One publication accepts a
  set of exact puts plus the legacy tracking/tag plan and applies all ref and
  shallow changes in its existing transaction. A candidate changed to a
  different target after discovery fails with `ESTALEFETCH`; an idempotent
  concurrent winner is accepted. Duplicate, symbolic, `HEAD`, unissued, stale,
  disposed, foreign, over-limit, or corrupt candidates fail closed. Preserve
  legacy fetch and tracking behavior unchanged. Snapshot and revalidate the
  repository checkout-HEAD revision so no selected `refs/heads/*` destination
  becomes checked out between early preflight and publication. Accept the
  owning operation reservation rather than creating a second 64 MiB allowance,
  and admit the complete candidate/ref/reflog SQL cost before publication.
- **Acceptance / witness.** A focused store test proves exact multi-namespace
  atomicity, rollback, stale and idempotent races, reflog rows, memory and SQL
  limits, token lifecycle, a concurrent checkout attachment, cold reopen, and
  unchanged legacy tracking/tag publication.
- **Touch points.** `src/sqlite/store.ts`, `src/core/repository.ts`,
  `tests/fetch-publication.test.ts`, `tests/store.test.ts`.

### WU4 — Fetch explicit and wildcard refspecs atomically (effort L)

- **Problem.** Fetch can request multiple object ids, but selection and
  publication collapse them into branch tracking plus one scalar
  `fetchHead`.
- **Verify first.** Expand the WU0 fetch mappings against one real
  advertisement and classify which Git namespaces require force for a changed
  destination.
- **Scope.** Add the exact mapped branch of `GitFetchOptions`. Reject mixing it
  with legacy selection fields and reject `tags` and `depth`; retain auth and
  progress options. Expand only against the validated advertisement;
  an absent exact source throws `EREFNOTFOUND`, while an empty wildcard is a
  one-logical-GET, zero-POST, zero-token no-op. Check every expanded local branch
  destination against every linked checkout before token/POST. Request unique
  selected oids plus explicit annotated-tag peeled targets in one logical
  upload-pack exchange with at most two 401-related physical POST attempts,
  authenticate every selected root, preflight the frozen
  namespace matrix against the publication snapshot, and atomically publish
  only after complete pack ingest. Return the exact mapped result; the Computer
  adapter projects its legacy result. Enforce the failure-state table,
  operation memory reservation, and composed SQL admission through cold reopen.
- **Acceptance / witness.** Real-server parity covers explicit and wildcard
  custom refs, non-BMP ordering, no match, tags, force/non-fast-forward,
  linked-checkout locks, destination collision, incomplete and malformed pack,
  a fetched object forbidden at its branch destination, rejected mapped
  `depth`, every failure-table stage, 1,024 mappings,
  aggregate statement/memory bounds, reflogs, publication races, retained
  object residue, and cold reopen. Request logs prove one logical mapped upload
  exchange even when `include-tag` omits tag objects, while legacy auto-tag
  fallback still permits two logical exchanges. Retry fixtures prove the
  physical GET/POST maxima and byte-identical POST bodies.
- **Touch points.** `src/core/ops/network.ts`, `src/core/ops/refspec.ts`,
  `src/sqlite/store.ts`, `src/git/client.ts`,
  `src/compat/computer/client.ts`, `tests/fetch-refspec.test.ts`,
  `tests/concurrency-fetch.test.ts`, `tests/compat.test.ts`.

### WU5 — Send and parse bounded receive-pack command sets (effort L)

- **Problem.** The wire layer emits one command and insists on one status, so
  the operation layer cannot request or observe a multi-ref transaction.
- **Verify first.** Capture WU0 receive-pack request phases and advertised
  capabilities for atomic push, deletion, sideband, and push options.
- **Scope.** Replace the single command request with an ordered command set
  capped at 1,024. Validate all old/new oids and destination refs before opening
  a POST. Put negotiated capabilities on only the first command; require
  `report-status`, `delete-refs` for any deletion, `atomic` when requested, and
  `push-options` when options are non-empty. Bound push options to 64 entries,
  1,024 UTF-8 bytes each, and 64 KiB total; reject NUL or newline. Encode the
  command, optional push-option, and pack phases exactly once per body factory
  so a 401 retry reopens a byte-identical stream. Parse one bounded status for
  every requested destination, rejecting duplicates, omissions, extras, and
  malformed unpack/status frames while preserving every valid per-ref result.
  Retain statuses in command order, charge them and copied error text to the
  root operation reservation, and reject retained result state above 8 MiB.
  Return complete unpack/ref rejections and classify incomplete or impossible
  atomic mixed status as uncertain exactly as frozen above. Preserve only the
  final-401 `EHTTP` safe case; classify every other non-200, sideband fatal,
  response-read failure, or incomplete status after POST as `EPUSHUNCERTAIN`.
- **Acceptance / witness.** Protocol tests compare captured request bytes with
  Git, cover capability absence, mixed ok/ng status, atomic rejection,
  deletion-only requests, push options, 401 replay, truncation/uncertainty,
  oversized status/sideband/result state wrapped as uncertain with an `E2BIG`
  cause, and every command/status/byte bound.
- **Touch points.** `src/core/protocol/receive-pack.ts`,
  `src/core/protocol/remote.ts`, `tests/receive-pack.test.ts`,
  `tests/protocol.test.ts`.

### WU6 — Plan one bounded pack for several push roots (effort L)

- **Problem.** The outbound planner walks one commit closure and assumes every
  source and destination is a branch.
- **Verify first.** Run current planning against a tag, tree, blob, and two
  independent commit roots; record the first unsupported or duplicated object
  path.
- **Scope.** Resolve explicit local refs, wildcard-expanded local refs, and full
  oid sources through authenticated objects. Build one deterministic union
  closure for every non-delete command: commits and their trees/parents,
  annotated tag chains and targets, complete trees, or one blob. Exclude
  advertised reachable objects only when the boundary can be proven; never
  borrow a remote claim to mask missing local data. Preflight Git's namespace
  force rules for all commands before opening the POST. Retain the existing
  512-new-commit, 100,000-object, and 16 MiB plan limits across the union rather
  than per root. Charge the maximum two pack body openings (initial and one 401
  replay) and the command-count-dependent tracking/reflog allowance to one
  pre-POST SQL estimate of at most 1,000. Use the root operation reservation
  throughout. A deletion-only set emits no pack.
- **Acceptance / witness.** Real Git accepts the generated union pack for two
  branches, lightweight and annotated tags, an arbitrary commit ref, an
  explicit tree/blob oid, force, and mixed deletion. Tests prove deterministic
  deduplication, corrupt/missing object rejection, shallow boundaries, exact
  limits, two replayable passes, and no POST on local preflight failure.
- **Touch points.** `src/core/ops/push-plan.ts`,
  `src/core/ops/refspec.ts`, `tests/push-plan.test.ts`,
  `tests/push-refspec.test.ts`.

### WU7 — Compose typed multi-ref push and checkpoint transport (effort L)

- **Problem.** Even with command and pack primitives, the public operation must
  preserve legacy branch calls, report partial remote outcomes, reconcile local
  tracking state, and prove the consumer's branch-plus-checkpoint round trip.
- **Verify first.** Re-read the WU0 result matrix and the current confirmed-
  success versus uncertain-POST tracking contract.
- **Scope.** Add the exact `GitPushOptions` and `PushResult` surfaces; preserve
  legacy single-branch input by translating it into one command. Expand local
  mappings before discovery, then discover once, validate the frozen namespace
  matrix, reserve one multi-ref tracking fence, plan one pack, and send one
  receive-pack request. A complete report resolves every command-order status,
  including unpack failure, atomic rejection, and non-atomic partial success.
  Preflight, capability, malformed, and uncertain transport outcomes still
  throw stable errors. After confirmed status, perform the one post-success
  rediscovery and all-or-none tracking publication defined above; expose
  `updated`, `unchanged`, `stale`, `deferred`, or `failed` without hiding the
  remote result. Custom refs and explicit URLs create no tracking refs. Prove
  one public workflow that lists,
  atomically pushes, deletes, and wildcard-fetches a session branch plus
  `refs/checkpoints/*`. Refresh exports, Computer legacy projection, and current
  transport/reference docs.
- **Acceptance / witness.** The consumer-shaped real-server test proves atomic
  branch-plus-checkpoint publication, batch deletion, `lsRemote`, loss and
  wildcard recovery, per-ref rejection, no local partial fetch state, tracking
  and reflog outcomes, a hook-changed target, post-status rediscovery failure,
  non-atomic partial tracking, stale/failing/deferred local reconciliation,
  auth, retry/uncertainty, and cold reopen. `tests/push.test.ts` separately
  proves the exact empty result above with zero HTTP requests, valid atomic and
  push options, local option rejection, mixed empty/non-empty continuation, and
  exact-missing failure of the whole set. Legacy push, fetch, clone, and pull
  witnesses remain green.
- **Touch points.** `src/core/ops/push.ts`, `src/core/ops/network.ts`,
  `src/core/ops/kinds.ts`, `src/git/client.ts`, `src/git/index.ts`,
  `src/index.ts`, `src/compat/computer/client.ts`,
  `tests/checkpoint-transport.test.ts`, `tests/push.test.ts`,
  `tests/client.test.ts`, `tests/compat.test.ts`,
  `tests/public-exports.test.ts`, `docs/reference/git-support.md`,
  `docs/reference/architecture.md`.

## Review strategy

The sprint changes both sides of the network protocol and one durable
multi-ref publication seam. Review follows the mutation boundary; pure grammar
and discovery do not inherit the stateful gates.

| Scope | Tier and rationale | Required gate and review | Escalate when |
|---|---|---|---|
| Sprint integration | T3 — one advertisement controls outbound commands, inbound object roots, and an atomic durable ref set | After WU7, one independent review receives the complete WU1-WU7 diff and returns separate refspec, fetch publication, receive-pack, pack-planning, facade, and checkpoint-workflow verdicts. Fix material findings and repeat only affected verdicts until clean, then run closure gates. | A remote or local ref can move before complete validation, a failure can leave an undeclared partial state, or a retry can replay an uncertain POST. |
| WU0 | T1 — external Git probes only | Run the exact witness twice; no independent implementation review when it matches the frozen contract. Any mismatch requires a plan amendment and independent contract-delta review before WU1. | Git behavior contradicts the matrix, glob, no-match, checked-out, or atomicity contract, or the probe needs product code. |
| WU1 | T2 — pure bounded grammar plus stricter untrusted advertisement validation | Run the exact witness; root-inspect name parity, wildmatch work, ordering, duplicate/symref detection, exports, and aggregate bounds. No independent review. | Validation changes stored ref acceptance or introduces another matching engine outside the declared subset. |
| WU2 | T2 — read-only GET and public projection | Run the exact witness; root-inspect auth reuse, pattern semantics, result bounds, and zero mutation. No independent review. | Discovery is cached across calls, adds another round trip, or persists remote state. |
| WU3 | T3 — generalises durable multi-ref publication and concurrency fencing | Run the exact witness, then independently review candidate authority, stale/idempotent races, atomicity, reflogs, token ownership, memory, and SQL bounds. Fix and re-review until clean. | Publication can delete candidates, widens beyond exact issued refs, or changes HEAD/checkout state. |
| WU4 | T3 — pack ingest followed by several local ref moves | Run the exact witness, then independently review selection, root authentication, force rules, all-or-nothing publication, shallow/tag interaction, failure cleanup, and races. Fix and re-review until clean. | Fetch prune, configured refspec parsing, partial publication, or a second network discovery enters scope. |
| WU5 | T3 — one POST can mutate many remote refs | Run the exact witness, then independently review framing, capability negotiation, auth replay, result completeness, limits, and uncertain-response classification. Fix and re-review until clean. | The implementation retries a non-auth POST failure or accepts an incomplete/extra status set. |
| WU6 | T3 — new multi-root object closure controls bytes sent to a mutating remote | Run the exact witness, then independently review reachability, type authentication, exclusions, deduplication, pack replayability, and global budgets. Fix and re-review until clean. | A remote advertisement can suppress an unproven local object, or limits are applied per root instead of per operation. |
| WU7 | T3 — public multi-ref mutation and cross-direction consumer composition | Run the exact witness. The sprint integration review covers result semantics, tracking reconciliation, public exports, and references; re-review an affected area after fixes. | Legacy inputs bypass the new preflight, confirmed partial success is hidden, or custom refs mutate tracking state. |

Exact focused witnesses:

```bash
# WU0
npx vitest run tests/refspec-contract.test.ts

# WU1
npx vitest run tests/refspec-contract.test.ts tests/refspec.test.ts tests/protocol.test.ts tests/public-exports.test.ts

# WU2
npx vitest run tests/ls-remote.test.ts tests/public-exports.test.ts

# WU3
npx vitest run tests/fetch-publication.test.ts tests/store.test.ts

# WU4
npx vitest run tests/fetch-refspec.test.ts tests/concurrency-fetch.test.ts tests/client.test.ts tests/compat.test.ts tests/public-exports.test.ts

# WU5
npx vitest run tests/receive-pack.test.ts tests/protocol.test.ts

# WU6
npx vitest run tests/push-plan.test.ts tests/push-refspec.test.ts

# WU7
npx vitest run tests/checkpoint-transport.test.ts tests/push.test.ts tests/client.test.ts tests/compat.test.ts tests/public-exports.test.ts
```

## Test cadence

- **Per WU.** Run only its exact focused witness while iterating. Split a new
  test file before adding timeout rather than allowing any focused command to
  exceed tens of seconds.
- **Routine integration.** Run `npm test` after WU7; keep the 128-test smoke
  gate below 30 seconds.
- **Sprint closure.** Run `npm run test:full` once after independent reviews and
  focused fixes settle. Do not use full-suite reruns as the failure loop.
- **Failure loop.** Reproduce a closure failure with its exact test file. Fix
  and stabilize that focused witness before the single exhaustive rerun.

## Out of scope (explicit)

- Parsing Git's string refspec syntax or configured `remote.<name>.fetch` /
  `remote.<name>.push` mappings. The public API is structured; legacy branch
  fields remain a translation input.
- Refspec pruning during fetch. The reference workload lists the remote and
  sends explicit bounded push deletions; existing branch `prune` remains.
- Force-with-lease, abort signals, and deepening are owned by backlog 13, 15,
  and the remainder of 38.
- Partial clone and protocol v2; existing Smart HTTP v0 and complete-object
  ingestion remain the transport.
- Mapped shallow fetch and `depth`; arbitrary-root shallow semantics belong to
  the later deepening work. Legacy fetch, clone, and pull keep current depth.
- Push certificates, signed pushes, server options outside `push-options`, SSH,
  credential helpers, and retries after an uncertain POST.
- Persisting an advertisement between separate `lsRemote`, fetch, or push
  calls. Each operation gets one fresh observation and its own auth session.

## Decisions

- The frozen contract above is normative. WU text may narrow implementation
  touch points but cannot change its state, type, ordering, or failure behavior.
- New callers use structured mappings, not Git refspec strings. The legacy
  one-branch options translate into the same validated command model.
- One wildcard on each side is the complete transfer-mapping pattern language.
  `lsRemote` uses the separately frozen Git tail-wildmatch grammar.
- One operation admits at most 1,024 input mappings and 1,024 expanded
  destinations. The remote advertisement retains its existing 16,384-row and
  4 MiB bounds.
- Fetch publication is always all-or-nothing locally. A non-atomic push may be
  partially accepted remotely; the complete `PushResult` reports that truth.
- For a non-empty command set, `atomic: true` and non-empty push options are
  requirements, not hints. Missing server capabilities fail before POST; the
  client never emulates them. A completely empty local expansion validates
  syntax and bounds, then returns before capability discovery as frozen above.
- Discovery and upload counts are logical exchanges. Physical attempts follow
  the frozen transport/auth maxima, and only 401 can reopen a POST body.
- Only confirmed successful remote branch destinations reconcile configured
  remote-tracking refs. The post-status rediscovery and non-throwing tracking
  outcome preserve the already-confirmed remote truth. Custom destinations and
  explicit URLs do not invent a local tracking namespace.
- A complete report-status is an operation result even when it contains `ng`.
  Missing or malformed status after POST is uncertain and throws.

## Sequencing

| Wave | Units | Contract |
|---|---|---|
| 0 | WU0 | Serial external behavior gate. |
| 1 | WU1 | Shared types, validators, and expansion settle first. |
| 2 | WU2 + WU3 | Read-only discovery and durable publication are behaviorally independent. |
| 3 | WU4 + WU5 | Fetch composition and receive-pack protocol use settled seams and may proceed independently. |
| 4 | WU6 | Multi-root pack planning after command shape settles. |
| 5 | WU7 | Public push plus end-to-end checkpoint transport, integration review, and closure gates. |

Each WU receives an atomic semantic commit. An unbounded expansion, malformed
advertised ref, partial local fetch publication, hidden remote partial result,
unproven object exclusion, or non-auth POST retry is a stop condition.

## Plan review

An independent reviewer checks the complete proposal against HEAD, including
grounding, WU boundaries and dependencies, acceptance witnesses, test cadence,
and whether every review gate matches its scope and blast radius. Blocking
findings are resolved before implementation.

- **Reviewer:** Singer (independent)
- **Verdict:** APPROVED / CLEAN, including the WU0 contract delta
- **Material findings:** the first pass required a frozen Git behavior matrix,
  exact TypeScript surfaces, post-push reconciliation outcomes, a fetch failure
  state table, exact tail-glob and symref validation, one composed memory/SQL
  budget, explicit one-versus-two tag POST behavior, and complete per-WU
  witnesses. The second pass confirmed those eight and required physical retry
  maxima, a complete stable-error table, one truly aggregate fetch SQL budget,
  and removal or definition of mapped depth. Those four are addressed above
  and the third pass confirmed them. The third pass then required direction- and
  phase-specific duplicate/type errors plus `EPUSHUNCERTAIN` precedence over
  response-side `E2BIG`; the fourth pass confirmed those changes and found one
  omitted zero-network push wildcard collision case. It is now explicit and
  the fifth pass approved the complete plan without remaining findings. WU0
  then proved that an empty push wildcard is a successful no-op rather than
  `EREFNOTFOUND`; the amended zero/mixed-expansion and capability contracts
  passed the mandatory independent delta review.

## Run log

<!-- Append discoveries, deviations, and blockers. Graduate durable entries to
     decisions or backlog; leave transient evidence here for the archive. -->

- 2026-08-28: Independent plan review approved the frozen contract after five
  passes. Implementation may start at WU0; any real-Git mismatch reopens the
  contract-delta gate before WU1.
- 2026-08-28: WU0 found that Git 2.54.0 treats a push wildcard with no local
  matches as success, while an exact missing source fails. The frozen contract
  now returns an empty zero-network push result, preserves matching siblings,
  and lets exact missing sources fail the whole set. The independent delta
  review approved the amendment. The five-test real-Git witness passed twice in
  1.83 seconds; WU1 may start.
- 2026-08-28: WU1 introduced the bounded structured refspec compiler, one
  aggregate transport memory/SQL budget, shared canonical ref validation, and
  strict advertisement row and HEAD-symref validation without changing stored
  ref acceptance. The exact witness passed 70 tests in 1.93 seconds; typecheck,
  Biome, and diff-check passed. Behavior-coupled facade options remain with
  WU2, WU4, and WU7, while their independent result and mapping types are now
  public.
- 2026-08-28: WU2 exposed one-shot `lsRemote` over the validated advertisement
  with bounded Git tail-wildmatch patterns, aggregate memory/SQL accounting,
  stable auth/transport errors, and no durable mutation or caching. Real Smart
  HTTP parity and request-count witnesses passed 20 tests in 2.39 seconds;
  typecheck, Biome, and diff-check passed.
- 2026-08-28: WU3 generalized the fetch publication token to exact refs while
  retaining legacy tag capacity, one atomic ref/shallow/reflog transaction, and
  the 1,000-statement ceiling. A monotonic checkout-state revision closes
  create/remove and retained-reflog ABA gaps; additive repository-owned memory
  scopes compose publication state with the caller's 64 MiB operation budget.
  The final focused gate passed 122 tests in 20.66 seconds; typecheck, Biome,
  and diff-check passed. Independent review approved candidate authority,
  races, rollback/reopen durability, legacy behavior, memory ownership, and
  SQL admission after the affected witness review returned clean.
- 2026-08-28: WU5 replaced the scalar receive-pack request with a bounded,
  ordered command set, exact command/options/pack framing, one byte-identical
  401 replay, complete ordered status parsing, and explicit safe-versus-
  uncertain POST outcomes. Request, status, and error-response retention share
  the caller-owned memory reservation; real Git witnesses cover atomic commands,
  push options, deletion-only requests, and wrapped local stream failures. The
  final focused gate passed 64 tests in 1.62 seconds; typecheck, targeted Biome,
  and diff-check passed. Independent review approved the affected certainty,
  option-validation, and aggregate high-water fixes without remaining findings.
- 2026-08-28: WU4 added explicit and wildcard mapped fetch over one validated
  advertisement and one atomic exact-ref publication, while preserving the
  legacy auto-tag fallback. Pack ingest now charges each executed SQL statement
  to the shared operation budget and reserves its lease-release cleanup; upload
  request/result memory and authenticated tag chains use the same root budget.
  Exact publication, linked-checkout fencing, namespace force rules, reflogs,
  corrupt loose shadows, 1,024 mappings, two legacy exchanges, failure reclaim,
  and cold reopen are covered. The final focused gate passed 67 tests in 14.59
  seconds; typecheck, targeted Biome, and diff-check passed. Independent
  re-review returned clean after the SQL-cleanup and peeled-target witnesses.
- 2026-08-28: WU6 replaced scalar branch planning with one deterministic,
  opaque multi-root pack plan for commits, tags, trees, blobs, and deletions.
  Only advertised OIDs authenticated inside the local commit closure suppress
  objects; 1,024 authoritative source snapshots avoid per-ref SQL reads. The
  structural plan, graph walk, and two replayable pack streams compose in one
  root memory reservation, while both pack passes and a 128-statement
  publication allowance stay below the shared 1,000-statement ceiling. The
  final focused gate passed 13 tests in 2.89 seconds; typecheck, targeted Biome,
  and diff-check passed. Independent affected re-review returned clean.
- 2026-08-28: WU7 composed the structured native push over one bounded local
  snapshot, advertisement, union pack, and ordered receive-pack command set.
  Complete remote results now resolve independently from branch-tracking
  reconciliation; the latter publishes one fenced batch or reports unchanged,
  stale, deferred, or a stable local failure. The Computer facade retains its
  legacy projection, public exports and reference docs match the frozen
  contract, and the checkpoint workflow covers atomic round trips, recovery,
  partial rejection, uncertainty, hook replacement, local races, corruption,
  memory exhaustion, and cold reopen. A real authenticated 1,024-command
  public deletion proves ordered complete statuses, fewer than 1,000 SQL
  statements, at most 64 MiB aggregate memory, idle cleanup, and exactly the
  allowed GET/GET/POST sequence. The final focused gate passed 72 tests in 5.03
  seconds; typecheck, targeted Biome, and diff-check passed. Independent T3
  review returned clean after fixes for post-status failure containment,
  no-op planner authentication, pre-request `lsRemote` callback validation,
  the aggregate boundary witness, and callback documentation precision.
