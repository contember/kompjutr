---
id: 0018
title: Trust stored rows and validate at the boundary
status: accepted
date: 2026-08-30
---

# 0018 — Trust stored rows and validate at the boundary

## Context

Root invariant 4 declared every SQL row untrusted. Reads therefore re-proved
what writes had already guaranteed: `typeof(col)` storage-class witnesses and
`CAST(col AS BLOB)` canonical re-decoding on ordinary reads, two-phase
metadata-then-payload preflights, re-authentication of tree and commit
projections against an authoritative object, a full re-read and re-inflation of
every pack inside its publication transaction, re-hashing during pack deletion,
and JavaScript re-validation of SQL `ORDER BY` results.

The measured costs of that doctrine at `4e4f1e0`:

- The same row grammar is hand-maintained in three vocabularies — schema
  `CHECK`s, SQL audit predicates, and JS validators — with the copies drifting
  (pack-row validation ~10 hand copies, tree-entry validation 4, the
  maintenance run-row reader 5, the loose-chunk predicate 5, once as a bare
  literal). Multi-operand `if` chains dominate read paths.
- Hot reads pay a second `SELECT` for the metadata preflight; pack publication
  pays a second full inflation pass inside one synchronous transaction.
- The doctrine is a major driver of file growth (`store.ts` reached 12,971
  lines) and review burden.
- The one confirmed user-visible defect found by the 2026-08-30 architecture
  review was caused by ownership-dispatch complexity, not by corruption. No
  read-time validator has caught a real corruption to date.

The threat model does not justify the price. The database is Durable Object
storage owned by the embedding application; no other writer exists. A host
application that mutates `git_*` tables out of band is in the same class as a
caller passing a dangling pointer to a C library.

## Decision

We will validate at the boundary and trust the store.

**Boundaries that keep full validation:**

- Caller input — grammar, ranges, encodings; failures are `GitError`.
- Network bytes — pack trailers, object hashes at ingest, protocol framing,
  advertisement parsing. Fetched data is genuinely untrusted.
- The schema at open — version and exact shape validation stays.
- Write time — schema `CHECK` constraints and write-path validation stay; they
  are the reason reads may trust rows.

**Reads trust stored rows.** A read decodes the driver value through a shared
guard (`expectText`, `expectSafeInteger`, `expectBlob`, declarative row
shapes) only because the type system cannot rule the shape out; a failed guard
throws `CorruptError`, and that is the entire extent of read-time checking.
Removed outright: SQL `typeof` witnesses, `CAST(... AS BLOB)` canonical text
reads, two-phase metadata preflights, re-authentication of derived rows against
authoritative objects, the pack publication re-read audit, deletion-time
re-hashing, and JS re-validation of SQL ordering.

**Checks that protect an algorithm are not paranoia and stay:** traversal cycle
and termination guards, CAS and revision checks, maintenance epochs, ingest
leases, provisional-state gating, the structural delta-closure check on pack
deletion, and the structural caps of the memory model (ADR-0017).

**Remaining checks go through shared validators.** One small guard/decoder kit
replaces hand-rolled multi-operand conditionals; a new five-operand `typeof`
chain is the anti-pattern.

**Out-of-band mutation of the database is undefined behavior.** Corruption
detection becomes an explicit, opt-in audit
([backlog 17](../backlog/17-integrity-audit-and-snapshots.md)), the same
contract as `git fsck` and `PRAGMA integrity_check`.

## Consequences

- Thousands of lines of validators, audit SQL, and corruption-injection tests
  are deleted; files shrink and the store split gets simpler.
- Single-read row access; pack publication stops re-inflating the pack, which
  directly cuts clone cost.
- A kompjutr write-path bug now surfaces later — at use, or in the opt-in
  audit — instead of at the next read. Write-time `CHECK`s, the parity
  harnesses, and the suite are the compensating controls.
- An application that corrupts its own rows gets undefined results, not
  `CorruptError`. This is the documented contract.
- Root invariant 4 is rewritten; module trust-rule docs follow in the
  implementing sprint. Corruption-injection tests survive only where they
  witness a boundary (ingest, schema open, write `CHECK`s).

## Alternatives considered

- **Keep the doctrine.** Rejected: the measured cost is high, the duplication
  is drifting, and the defect record points at complexity, not corruption.
- **Keep read-time validation behind a debug flag.** Rejected: two code paths
  to maintain, and the untested path rots; an explicit audit op serves the
  same need without forking every read.
- **SQLite `STRICT` tables instead of `CHECK`s.** Insufficient alone (no
  ranges, no enums) and unavailable as a complete replacement on the platform
  baseline; `CHECK`s already cover the write side.
