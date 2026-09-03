# Git SQLite architecture review verification triage

## Purpose

The 2026-09-02 Git-in-SQLite architecture review reported these additional
claims without an adversarial verification pass, or left a material premise
unsettled. They are hypotheses, not accepted defects. Verify a claim at current
HEAD before graduating it to the backlog or deleting it.

The report's compact ranges were not cardinality-consistent: `ARCH-41...46`
contained nine claims and `CORR-31...41` contained more than eleven. This file
keeps explicit IDs where the report assigned them and uses descriptive names for
the remaining compact claims rather than inventing identifiers.

Verified open work is canonical in
[`../backlog/65-git-sqlite-architecture-review.md`](../backlog/65-git-sqlite-architecture-review.md).
The report's explicitly dismissed claims are not retained here.

## Subsumed claims

These claims need no separate backlog item. Verification can strengthen the
acceptance witness of the listed verified finding.

| Claims | Candidate owner | Verification needed |
|---|---|---|
| CORR-14 | Backlog 65, ARCH-32 | Reproduce malformed OID or path data through a supported scratch-index writer; do not revive the dismissed stronger trust-premise claim. |
| CORR-18 | Backlog 65, ARCH-18 | Establish a correctness consequence distinct from the verified whole-ref-table materialization cost. |
| CORR-19 / TEST-2 | Backlog 65, ARCH-6 | Define a narrow source witness for forbidden read-time authentication that does not flag schema checks or boundary validation. |
| CORR-20 | Backlog 65, ARCH-17 | Classify sparse accounting as mutable ledger, structural cap, or result cap under ADR-0017. |
| DOCS-2 / part of DOCS-3 / compact reflog-root cap claim | Backlog 65, ARCH-19 | Confirm which constants disappear with the duplicate root stream and which still bound public materialization. |
| DOCS-6 and compact `*Owned` claims | Backlog 65, ARCH-24/ARCH-25 | Inventory remaining wrappers, WeakMaps, and callerless exports before mechanical removal. |
| DOCS-7 and compact local-helper claims | Backlog 65, ARCH-27 | Attach exact helper call sites and divergent inputs to the shared-kit cleanup. |
| Compact repeated journal-root reads | Backlog 65, ARCH-5/CORR-6 | Measure whether root paging adds a distinct cost after journal read-time authentication is removed. |

## Correctness candidates

| Claims | Hypothesis | Graduation check |
|---|---|---|
| CORR-15 | The ordinary index accepts paths that initial-state insertion rejects and later reports as corruption. | Drive a non-canonical path through a supported writer and reproduce the later failure; otherwise dismiss under existing boundary validation. |
| CORR-16 | Restart-state tables persist combinations not protected by write checks. | Audit every relevant column against schema checks and all writers, then reproduce a supported write that stores unreadable state. |
| CORR-17 | A journal that fails object validation has no usable continue, skip, or abort path. | Prove supported execution can create the state and test every recovery method; out-of-band mutation is insufficient under ADR-0018. |
| CORR-21 / CORR-22 | Expired provisional repositories can leak permanently and block `createRepository`. | Simulate cold expiry without owner takeover, enumerate reclaim paths, and decide whether creation or maintenance owns reclamation. |
| CORR-23 | Mapped fetch refuses 1,025 destinations while legacy fetch admits 16,384. | Reproduce the boundary, identify the real retained-state owner, and decide whether the limits should match. |
| CORR-24 | Clone and fetch do not validate `depth` consistently. | Exercise zero, negative, fractional, infinite, and unsafe values through both public APIs and require stable errors. |
| CORR-25 | Smart HTTP discovery redirects are not carried to the service POST. | Test a server where POST succeeds only at the redirected base and compare with real Git. |
| CORR-26 / DOCS-1 / TEST-1 | `branchList` and `tagList` use UTF-16 sorting instead of Git byte order. | Compare astral and BMP ref names with real Git and add a call-site witness for forbidden path ordering. |
| CORR-27 | Tree ingest does not establish sortedness before projection. | Ingest a validly hashed unsorted tree and determine whether Git accepts it and whether traversal invariants fail. |
| CORR-28 | Sparse checkout issues two scalar probes per candidate directory. | Measure statement growth and identify a set-based emptiness or removal primitive. |
| CORR-29 | Literal add can reject a directory when a sibling sorts between it and its subtree. | Reproduce files, directories, and sibling-prefix boundaries against real Git. |
| Pack membership digests | Per-entry membership digests are computed but never compared. | Trace altered indexed rows through publication; either consume the digests or remove the unused hashing and its claims. |
| Short or missing chunks | Cached packed reads can zero-fill a short range and loose chunk reads can return truncated content. | Inject short and missing rows and require every read surface to fail consistently with `ECORRUPT`. |
| Legacy tree modes | Modes such as `100664` abort ingest although Git may warn and canonicalize. | Build the object with real Git and compare clone, checkout, and `fsck` before choosing rejection or normalization. |
| Branch-rename reflog | Branch rename may leave history under the old reflog name. | Compare old and new reflog visibility after rename with real Git. |
| Put/delete overlap | A ref named in both puts and deletes may silently resolve as a put. | Exercise all overlap forms and define rejection or precedence in the public batch contract. |
| Zero inode in sparse reads | `git_index.ino` admits zero while a sparse reader may classify zero as corruption. | Persist zero through supported filesystem metadata and run sparse paths after cold reopen. |
| Shallow error taxonomy | `ShallowTable.set` may report invalid caller OIDs as `CorruptError`. | Reach the path from public depth operations and require a stable caller-input error. |
| Missing operation gitlinks | Journal gitlink OIDs may be mandatory roots while index gitlinks are optional. | Create an operation over an absent gitlink and establish maintenance and recovery semantics. |
| Clean sibling ordering | Ignored-subtree state may reset at an interleaving sibling prefix. | Build the ordering fixture and compare clean selection with Git before any deletion. |
| Join equality | `joinSorted` and `joinSorted3` use different equality definitions. | Find reachable distinct strings that compare equal, or prove boundary validation makes the difference unreachable. |
| Upload-pack sideband | Fetch may accept malformed sideband frames rejected by the push-side parser. | Differentially test empty frames, invalid bands, malformed UTF-8, missing flushes, and trailing packets. |
| Tracking reconciliation | Similar target-authentication failures may map to `deferred` and `failed` inconsistently. | Exercise each error code and define retryable versus terminal outcomes. |

## Architecture and cost candidates

| Claim | Hypothesis | Graduation check |
|---|---|---|
| ARCH-41 dead estimators | Four JSON/ref sizing exports and the `jsonPages` label are unused. | Check package exports and tests, then remove only confirmed dead members; the report dismissed the broader counter-removal claim. |
| Store facade boundary | `store/index.ts` claims to be the consumer seam while ops deep-imports store modules. | Inventory imports and decide whether the facade is a binding boundary, compatibility surface, or obsolete. |
| Duplicate index batching | `IndexMutationBuffer` independently duplicates `jsonPages`. | Compare framing, oversize-row, ordering, and flush behavior before unifying. |
| Shallow enumeration | `ShallowTable.read()` materializes every shallow OID with no explicit limit. | Establish reachable cardinality and caller needs, then page it or tie a cap to a real failure. |
| OID schema coverage | OID grammar checks are inconsistent across OID-bearing join columns. | Generate a complete column/writer matrix and find values a supported writer can persist. |
| Provisional error consistency | Hidden provisional state appears as `EBUSY` through one entry point and `ENOTFOUND` through another. | Define whether endpoint-specific errors are intentional and add public contract tests. |
| Reflog query limit | `readRefLog` may fetch all 1,024 retained rows before applying caller limits in JavaScript. | Demonstrate an equivalent SQL-level page that preserves retention and cursor semantics. |
| Shared-store cache publication | `openShared` caches a shared store before primary checkout binding completes. | Force a supported post-cache failure and show whether a later open observes poisoned state. |
| Dead checkout-root branch | The `stored` branch of `requireCheckoutRoot` may be unreachable. | Trace all callers and decoders before removal. |
| `write-tree` retained OIDs | Plumbing retains one required OID per index row before authentication. | Measure high-water by index cardinality and test whether batched authentication preserves all-before-write behavior. |
| Tracking fence wiring | Concurrency docs may describe a tracking-publication token with no production caller. | Trace the exact ops call chain and wire, remove, or narrow the documented guarantee. |

## Documentation candidates

| Claims | Check before editing |
|---|---|
| DOCS-3 | Identify the real owner of each structural cap; do not delete `MAX_REFLOG_STATE_ROWS` if it still bounds a public materialized result. |
| DOCS-4 | Compare every README implementation-status claim with current reference and archived sprint outcomes. |
| DOCS-5 | Compare the `src/git/store/CLAUDE.md` map with current ownership-bearing modules, without turning it into a file inventory. |
| DOCS-8 | Decide whether root invariant 4 and ADR-0018 govern all domains or only the Git store before changing filesystem checks. |
| DOCS-9 | Reconcile ADR-0014's old statement that fetch cannot deepen a clone with shipped deepen and unshallow support. |
| DOCS-10 | Establish which synchronous APIs return `EPROMISED` and which asynchronous operations hydrate before documenting it. |
| DOCS-11 / DOCS-12 | Re-check the headers of `shared.ts`, `database.ts`, and `operations.ts` against current ownership. |
| DOCS-13 | Inventory obsolete `src/core/` and `src/sqlite/` paths in living docs; do not rewrite historical archive records merely for age. |
| DOCS-14 | Find a reproducible artifact for the exact 54,423,552-byte memory claim or replace the unsupported precision. |
| DOCS-15 | Reconcile `docs/INDEX.md` calling the trusted-domain spec an active target while no sprint is active. |
| Stale schema-version wording | Determine whether any persisted compatibility requirement remains before removing the `schema v5` contract text. |

## Test candidates

| Claims | Verification needed |
|---|---|
| TEST-3 | Add a platform-shaped witness that production code delegates transactions and never sends transaction SQL through `sql.exec`. |
| TEST-4 | Enforce the documented production `node:` import allowlist without flagging allowed compatibility facades. |
| TEST-5 | Publish shallow-only fetch state and witness the exact maintenance root-epoch transition and restart. |
| TEST-7 | Inventory promised-blob hydration races and add a deterministic lease-contention/cold-reopen witness if existing owner tests do not cover them. |
| Nested rollback | Verify caught inner-failure semantics with Miniflare/workerd or the real Durable Object adapter; hand-written test storage currently flattens nesting. |

## Graduation

A claim graduates only after its premise is reproduced or established from all
supported writers and callers, its impact is separated from already verified
work, and a concrete acceptance witness is known. Delete claims that verification
refutes; do not preserve them as historical findings.

<!-- Origin: external Git-in-SQLite architecture review, 2026-09-02. -->
