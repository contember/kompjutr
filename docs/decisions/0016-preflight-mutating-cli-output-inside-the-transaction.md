---
id: 0016
title: Preflight mutating CLI output inside the transaction
status: proposed
date: 2026-08-28
---

# 0016 — Preflight mutating CLI output inside the transaction

## Context

ADR 0015 requires the synchronous Git argv runner to enforce caller-supplied
stdout, stderr, and combined-output ceilings before it returns a result. The
initial kernel validated those ceilings after a command handler returned. That
is sufficient for reads, but not for mutations: `commit` or
`rebase --continue` could publish durable state and then fail with `E2BIG` while
the caller observed no successful command result.

The existing Git operations and filesystem writes already join nested
`transactionSync()` calls. A thrown outer transaction therefore rolls back the
whole mutation. Repository storage caches must still be revalidated after that
rollback because formatting may have observed newly written objects.

## Decision

The dispatcher will pass the resolved `GitCliRunOptions` to each command
handler. Read-only handlers may ignore them. Every mutating handler will use one
shared wrapper with this order:

1. Open an outer transaction on the selected repository database.
2. Run the existing native operation and format its success result.
3. Apply `boundedGitCliResult()` inside that transaction.
4. Let every operation, formatting, or output-limit exception escape so the
   outer transaction rolls back.
5. Revalidate repository storage caches after rollback, then map an expected
   Git-domain failure outside the transaction and apply the same output bounds
   to that failure result. Unexpected exceptions remain exceptions.

The dispatcher keeps its final `boundedGitCliResult()` call as defense in depth.
The public `GitCliRunner` and `GitCliRunOptions` interfaces from ADR 0015 do not
change.

## Consequences

- A destination-specific output overflow cannot publish an index, worktree,
  ref, reflog, object, or operation-state mutation.
- Existing nested operation transactions remain the only mutation
  implementation; the CLI adds one outer rollback boundary.
- New mutating CLI handlers must use the shared wrapper and prove rollback for
  stdout, stderr, combined, and discarded-stderr configurations.
- Handler implementations receive resolved ceilings even when they only read.
  The narrow public runner capability remains unchanged.

## Alternatives considered

- Validate only after dispatch. This leaves durable mutations visible after an
  `E2BIG` failure.
- Estimate success output before mutation. Commit and rebase output depends on
  the resulting object and lifecycle state, so an estimate can drift from the
  formatted bytes.
- Inject a transaction into the generic runner. The selected repository and
  its cache-revalidation seam are resolved by the handler from `cwd`; moving
  that ownership into the parser kernel would couple it to repository storage.
