---
id: 0024
title: Hold integration plans in a scoped SQL workspace and write output as ordinary objects
status: accepted
date: 2026-09-24
---

# 0024 — Hold integration plans in a scoped SQL workspace and write output as ordinary objects

## Context

Three-way integration retained its whole result in memory: plan arrays, decoded
candidate inputs, generated conflict bytes, path reservation sets and sorted
projections. A 1,000-entry materialization ceiling hid that cost rather than
bounding it, and it also refused legal work — a long valid path expands to as
many owned ancestors, and a 1,001-path merge or rebase was rejected outright.

Every applying consumer — merge, cherry-pick, revert, rebase steps, snapshot
replay — and recursive virtual bases need the same output, some of them twice,
so a plan has to be traversable more than once without recomputing text merges.

The first version (2026-09-22) also kept generated blobs and trees in private
`git_integration_*` object, chunk and tree-edge tables and copied the reachable
ones into the ordinary store at each consumer's publication point. That bought
nothing the transaction does not already give: the workspace, every generated
write and the consumer's publication run inside one `transactionSync()`, so a
fault rolls all of it back, and no other reader or maintenance step can observe
the store mid-operation.

## Decision

We will hold integration plans in a repository-qualified, uniquely identified
SQL workspace opened by `withIntegrationWorkspaceOwned`. Its creation, use and
deletion run inside one `transactionSync()` under the existing scratch
coordinator, and it never reacquires the public mutation guard. The workspace
never survives successful callback completion.

Child tables under `git_integration_*` hold ordered plan records, path
reservations and touched snapshots. All keys begin with `(repo_id,
workspace_id)` and cascade from the owner. No ordinary object, projection,
promise or maintenance query sees them.

Generated blobs and virtual-base trees are ordinary loose objects, written with
the streamed loose writer so no copy stays in the object cache. Plans carry
object identities, never `Uint8Array`s. Traversal is a replayable `BINARY`
keyset page of at most 256 records, bounded again by the existing `jsonPages`
byte policy. Candidate inputs load in bounded-prefix batches behind a fixed
reusable cache, so a shared identity may be reread rather than pinned.

The implicit 1,000-entry ceiling is removed from planning, touched-path
expansion, journal writing and reading, reconstruction and application.
Explicit caller limits keep their current semantics.

## Consequences

A 1,001-path merge or rebase and a path with 1,000 ancestors succeed and
round-trip through a cold journal. Repeated plan traversal does not repeat text
merging. Live payload is the active candidates, the fixed read window and one
output, not the whole operation.

A fault before publication leaves refs, index, worktree and objects unchanged:
the transaction rolls back every loose write, and the scratch coordinator
revalidates storage caches when the outermost scratch scope fails. A successful operation may leave
unreferenced loose objects behind — worktree-only conflict markers, a
virtual-base tree, the markers of a conflicted snapshot replay. They are
ordinary garbage: maintenance nominates them and sweeps them after its grace
period. A loose write bumps the source generation, so a maintenance run that
spans the operation restarts discovery before it deletes anything. That holds
for a conflict-only operation too: a conflicted snapshot replay writes its
marker blob and restarts in-flight maintenance discovery.

The planner is not pure: it takes the workspace capability explicitly and
returns a scoped handle. Handles and cursors are revoked on every exit, a caught
nested failure poisons the enclosing scratch transaction, and a plan handle must
never reach a durable journal, a public result or a cache. Consumers that must
return arrays — `ReplaySnapshotResult.conflicts`, conflict messages — declare
that as mandatory output.

The schema has five tables that exist only within a transaction. Journal
readers split into metadata headers plus keyset traversal, so internal
application, validation, continuation and abort must not call the materializing
public readers.

## Alternatives considered

Private scratch object tables with adoption at publication — the first version
— duplicate every published object write, add a reachability walk per consumer,
and protect against no failure the transaction does not already cover.
Deterministic recomputation re-derives the plan for each consumer, repeating
every text merge and every virtual base synthesis, and gives conflicting answers
if any input changes. A larger in-memory ceiling keeps the whole result live and
still refuses legal work.
