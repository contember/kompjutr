# ADR-0023 — Validate canonical pack dependencies at source changes

## Status

Accepted (2026-09-21).

## Context

A format-valid physical pack can change the effective canonical OID graph into
a cycle or extend previously published dependents beyond the cold-read depth
limit. Validating only incoming physical chains or promoted fallback roots does
not protect those older dependents. Loose copies do not remove physical packed
dependencies.

## Decision

Validate the affected canonical graph inside the existing publication/deletion
transaction, before publication callbacks. Complete canonical packed sources
take precedence over loose terminals for this graph. Pending sources and
promises cannot satisfy a published dependency. Every chain preserves type,
terminates and has at most 50,000 delta edges.

Read `git_pack_objects` directly through indexed forward/reverse queries. Keep
affected closure, memoized depths and active paths in repository/operation-owned
transaction-local SQL scratch. JavaScript pages are bounded to 4,096 records,
matching the pack read graph page; witnesses that must cross a page boundary
pass a smaller page explicitly rather than relying on the production value.
Delete scratch before callbacks; nested mutations validate with separate owners.

Deletion captures all old canonical OIDs, promotes fallbacks excluding the whole
deletion batch, preserves physical/pending-base authentication before removal,
then validates the final graph once. Missing changed OIDs remain reverse seeds;
only source-less starting roots can be skipped after reverse closure completes.

## Consequences

Rejected source changes roll back atomically. Ordinary reads do not gain a new
revalidation pass. SQL scratch grows with affected work rather than unrelated
repository size; native SQL work and statement counts still require measurement.
The statement target is not runtime admission.

Membership audit and non-replacing canonical insertion guarantee a complete
canonical owner for every complete physical occurrence. Tests cover that
invariant rather than manufacturing a pending owner hiding a complete fallback.
Pending cleanup still uses the shared validated deletion seam.

## Alternatives

Whole-repository validation repeats unrelated work. A mirrored persistent graph
or durable depth certificates add synchronization and invalidation ownership.
Graph-sized JavaScript sets retain metadata proportional to repository history.
Transaction-local affected traversal avoids those costs and ownership boundaries.
