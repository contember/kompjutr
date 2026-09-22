# ADR-0024 — Own integration output in a scoped SQL workspace

## Status

Accepted (2026-09-22).

## Context

Three-way integration retained its whole result in memory: plan arrays, decoded
candidate inputs, generated conflict bytes, path reservation sets and sorted
projections. A 1,000-entry materialization ceiling hid that cost rather than
bounding it, and it also refused legal work — a long valid path expands to as
many owned ancestors, and a 1,001-path merge or rebase was rejected outright.
Raising the ceiling would have made the retention worse.

Every applying consumer — merge, cherry-pick, revert, rebase steps, snapshot
replay — and every validating consumer — journal ownership reconstruction,
recursive virtual bases — needed the same output, some of them twice, so a plan
had to be traversable more than once without recomputing text merges.

## Decision

We will hold integration output in a repository-qualified, uniquely identified
SQL workspace opened by `withIntegrationWorkspaceOwned`. Its creation, use and
deletion run inside one `transactionSync()` under the existing scratch
coordinator, and it never reacquires the public mutation guard. The workspace
never survives successful callback completion.

Child tables under `git_integration_*` hold scratch object metadata and chunks,
parsed virtual tree edges, ordered plan records, path reservations and touched
snapshots. All keys begin with `(repo_id, workspace_id)` and cascade from the
owner. No ordinary object, projection, promise or maintenance query sees them.

Plans carry object identities and scoped content references, never
`Uint8Array`s. Traversal is a replayable `BINARY` keyset page of at most 256
records, bounded again by the existing `jsonPages` byte policy. Candidate inputs
load in bounded-prefix batches behind a fixed reusable cache, so a shared
identity may be reread rather than pinned.

Generated objects become ordinary objects only where a consumer publishes:
adoption walks scratch-backed OIDs reachable from published index stages, trees
and commits inside that consumer's existing publication transaction.
Validation-only consumers adopt nothing. Worktree-only bytes are copied straight
from scratch.

The implicit 1,000-entry ceiling is removed from planning, touched-path
expansion, journal writing and reading, reconstruction and application.
Explicit caller limits keep their current semantics.

## Consequences

A 1,001-path merge or rebase and a path with 1,000 ancestors now succeed and
round-trip through a cold journal. Repeated plan traversal no longer repeats
text merging. Live payload is the active candidates, the fixed read window and
one output, not the whole operation.

The planner is no longer pure: it takes the workspace capability explicitly and
returns a scoped handle. Handles and cursors are revoked on every exit, a caught
nested failure poisons the enclosing scratch transaction, and a scoped reference
must never reach a durable journal, a public result or a cache. Consumers that
must return arrays — `ReplaySnapshotResult.conflicts`, conflict messages — now
declare that as mandatory output rather than hiding it.

The schema grows eight tables that exist only within a transaction. Journal
readers split into metadata headers plus keyset traversal, so internal
application, validation, continuation and abort must not call the materializing
public readers.

## Alternatives

Deterministic recomputation re-derives the plan for each consumer, repeating
every text merge and every virtual base synthesis, and gives conflicting answers
if any input changes. Publishing generated output as ordinary objects up front
makes provisional bytes visible to reads, promises and maintenance, and needs a
new cleanup path for every failure. A larger in-memory ceiling keeps the whole
result live and still refuses legal work.
