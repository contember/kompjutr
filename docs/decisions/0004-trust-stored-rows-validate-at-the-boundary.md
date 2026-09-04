---
id: 0004
title: Trust stored rows and validate at the boundary
status: accepted
date: 2026-08-30
---

# 0004 — Trust stored rows and validate at the boundary

## Context

The runtime originally declared every SQL row untrusted. Reads therefore
re-proved what writes had already guaranteed: `typeof(col)` storage-class
witnesses, `CAST(col AS BLOB)` canonical re-decoding on ordinary reads,
two-phase metadata-then-payload preflights, re-authentication of tree and commit
projections against an authoritative object, a full re-read and re-inflation of
every pack inside its publication transaction, re-hashing during pack deletion,
and JavaScript re-validation of SQL `ORDER BY` results.

The measured cost of that doctrine at `4e4f1e0`:

- The same row grammar was hand-maintained in three vocabularies — schema
  `CHECK`s, SQL audit predicates, and JS validators — and the copies drifted
  (pack-row validation had roughly ten hand copies, tree-entry validation four,
  the maintenance run-row reader five, the loose-chunk predicate five, once as a
  bare literal). Multi-operand `if` chains dominated read paths.
- Hot reads paid a second `SELECT` for the metadata preflight, and pack
  publication paid a second full inflation pass inside one synchronous
  transaction.
- The doctrine was a major driver of file growth (the store reached 12,971
  lines) and of review burden.
- The one confirmed user-visible defect found by the 2026-08-30 architecture
  review was caused by ownership-dispatch complexity, not by corruption. No
  read-time validator has ever caught a real corruption.

The threat model does not justify that price. The database is Durable Object
storage owned by the embedding application, and no other writer exists. A host
that mutates `git_*` tables out of band is in the same class as a caller passing
a dangling pointer to a C library.

## Decision

We validate at the boundary and trust the store.

**Boundaries that keep full validation:**

- Caller input — grammar, ranges, encodings. Failures are `GitError`.
- Network bytes — pack trailers, object hashes at ingest, protocol framing,
  advertisement parsing. Fetched data is genuinely untrusted.
- The schema at open — version and exact shape.
- Write time — schema `CHECK` constraints and write-path validation. They are
  the reason reads may trust rows.

**Reads trust stored rows.** A read decodes a driver value through a shared
guard (`expectText`, `expectSafeInteger`, `expectBlob`, declarative row shapes)
only because the type system cannot rule the shape out. A failed guard throws
`CorruptError`, and that is the entire extent of read-time checking. Removed
outright: SQL `typeof` witnesses, `CAST(... AS BLOB)` canonical text reads,
two-phase metadata preflights, re-authentication of derived rows against
authoritative objects, the pack publication re-read audit, deletion-time
re-hashing, and JS re-validation of SQL ordering.

**Checks that protect an algorithm are not paranoia and stay:** traversal cycle
and termination guards, compare-and-swap and revision checks, maintenance
epochs, ingest leases, provisional-state gating, the structural delta-closure
check on pack deletion, and the structural bounds of
[ADR-0005](0005-bound-real-failures-and-measure-cost.md).

**Remaining checks go through shared validators.** One small guard and decoder
kit replaces hand-rolled multi-operand conditionals; a new five-operand `typeof`
chain is the anti-pattern.

**Out-of-band mutation of the database is undefined behavior.** Corruption
detection is an explicit, opt-in audit
([backlog 17](../backlog/17-integrity-audit-and-snapshots.md)), the same
contract as `git fsck` and `PRAGMA integrity_check`.

## Consequences

- Thousands of lines of validators, audit SQL, and corruption-injection tests
  were deleted; files shrank and the store split got simpler.
- Row access is a single read, and pack publication stops re-inflating the pack,
  which directly cuts clone cost.
- A write-path bug now surfaces later — at use, or in the opt-in audit — instead
  of at the next read. Write-time `CHECK`s, the parity harnesses, and the suite
  are the compensating controls.
- `git_refs`, `git_shallow`, `git_config`, and `git_index` carry `CHECK`
  constraints for their stored grammar, types, and ranges. These anchor the
  write-time premise for the row families the trusted-read change affects most.
- An application that corrupts its own rows gets undefined results, not
  `CorruptError`. That is the documented contract.
- Corruption-injection tests survive only where they witness a boundary: ingest,
  schema open, and write `CHECK`s.

## Alternatives considered

- **Keep the doctrine.** Rejected: the measured cost is high, the duplication
  drifts, and the defect record points at complexity, not corruption.
- **Keep read-time validation behind a debug flag.** Rejected: two code paths to
  maintain, and the untested one rots. An explicit audit operation serves the
  same need without forking every read.
- **SQLite `STRICT` tables instead of `CHECK`s.** Insufficient alone — no ranges
  and no enums — and unavailable as a complete replacement on the platform
  baseline. `CHECK`s already cover the write side.
