---
id: 0016
title: Preflight mutating CLI output inside the transaction
status: accepted
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

The existing Git operations and filesystem writes join nested
`transactionSync()` calls when the repository and worktree use the same
database capability. A thrown outer transaction then rolls back the whole
mutation. Repository storage caches must still be revalidated after that
rollback because an operation may have observed newly written objects.

## Decision

The dispatcher will pass the resolved `GitCliRunOptions` to each command
handler. Read-only handlers may ignore them. Every mutating handler will use one
shared wrapper with this order:

1. Open an outer transaction on the selected repository database.
2. Mark the current phase, then run the existing native operation, format its
   success result, and apply `boundedGitCliResult()` as three separate phases.
3. Let every operation, formatting, or output-limit exception escape so the
   outer transaction rolls back.
4. Revalidate repository storage caches after rollback. Only an exception from
   the native-operation phase may enter command-specific Git-domain mapping.
   Formatting and preflight exceptions, including `E2BIG`, are rethrown
   unchanged. Apply the same output bounds to any mapped failure result.

Before a command that can mutate the worktree enters the wrapper, it must prove
transaction affinity by identity: `context.worktree.db === repo.store.db`.
Missing or different database capabilities fail closed before mutation. The
native Workspace and Computer adapters construct both sides over the same
database object.

The dispatcher keeps its final `boundedGitCliResult()` call as defense in depth.
The public `GitCliRunner` and `GitCliRunOptions` interfaces from ADR 0015 do not
change.

## Consequences

- A destination-specific output overflow cannot publish an index, worktree,
  ref, reflog, object, or operation-state mutation.
- Existing nested operation transactions remain the only mutation
  implementation; the CLI adds one outer rollback boundary.
- New mutating CLI handlers must use the shared wrapper and prove rollback for
  stdout, retained stderr, and combined-output overflow. With
  `discardStderr: true`, stderr is neither validated nor charged: the mutation
  commits when stdout and the resulting combined output fit.
- Worktree-mutating commands are unavailable to custom Worktree adapters that
  do not expose the selected repository database by identity.
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
