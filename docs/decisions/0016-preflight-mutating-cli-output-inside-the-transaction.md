---
id: 0016
title: Preflight mutating CLI output inside the transaction
status: accepted
date: 2026-08-28
---

# 0016 — Preflight mutating CLI output inside the transaction

## Context

ADR 0015 requires the asynchronous Git argv runner to enforce caller-supplied
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

The dispatcher passes the resolved `GitCliRunOptions` to each awaitable command
handler. Every local mutating handler uses one shared synchronous wrapper with
this order:

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

The dispatcher awaits the handler only after any local transaction callback has
returned. The transaction callback performs mutation, formatting, and preflight
without an await. The dispatcher then keeps its final `boundedGitCliResult()`
call as defense in depth.

Network argv uses a different policy because no transaction can roll back an
HTTP side effect or an already-published fetch. Four boundaries are explicit:

1. Local-only `init` and mutating `remote` forms retain transactional preflight.
2. Read-only `ls-remote`, and clone/fetch/pull before publication, may fail with
   `E2BIG` because no durable command outcome must be reported.
3. Clone/fetch/pull after local publication return bounded bytes with
   `truncated: true`; output limits do not replace success, conflict, or later
   integration failure.
4. Push may fail known output preflight before receive-pack invocation. After
   invocation, native transport certainty is authoritative: confirmed status,
   `EPUSHUNCERTAIN`, and tracking reconciliation are preserved, with output
   truncation recorded separately.

Network authentication is supplied by binding headers and callbacks. The argv
environment is not a credential source.

## Consequences

- A destination-specific `E2BIG` from a local-only command or a network command
  before publication cannot publish an index, worktree, ref, reflog, object, or
  operation-state mutation.
- Existing nested operation transactions remain the only mutation
  implementation; the CLI adds one outer rollback boundary.
- New local mutating CLI handlers must use the shared wrapper and prove rollback
  for stdout, retained stderr, and combined-output overflow. With
  `discardStderr: true`, stderr is neither validated nor charged: the mutation
  commits when stdout and the resulting combined output fit.
- Worktree-mutating commands are unavailable to custom Worktree adapters that
  do not expose the selected repository database by identity.
- Handler implementations receive resolved ceilings even when they only read.
  The narrow public runner capability remains unchanged.
- Making the runner promise-returning does not make local transaction ownership
  asynchronous; no transaction spans an await.
- A caller can distinguish presentation loss from operation uncertainty.
  `truncated` means only that output was bounded; `EPUSHUNCERTAIN` still means
  receive-pack was invoked without a safely retained final status.

## Alternatives considered

- Validate only after dispatch. This leaves durable mutations visible after an
  `E2BIG` failure.
- Estimate success output before mutation. Commit and rebase output depends on
  the resulting object and lifecycle state, so an estimate can drift from the
  formatted bytes.
- Inject a transaction into the generic runner. The selected repository and
  its cache-revalidation seam are resolved by the handler from `cwd`; moving
  that ownership into the parser kernel would couple it to repository storage.
