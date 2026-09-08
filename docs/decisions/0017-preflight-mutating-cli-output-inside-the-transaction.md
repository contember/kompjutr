---
id: 0017
title: Preflight mutating CLI output inside the transaction
status: accepted
date: 2026-08-28
---

# 0017 — Preflight mutating CLI output inside the transaction

## Context

[ADR-0016](0016-route-git-argv-through-one-asynchronous-runner.md) requires the
argv runner to enforce caller-supplied stdout, stderr, and combined-output
ceilings before it returns a result. The initial kernel validated those ceilings
after a command handler returned. That is sufficient for reads, but not for
mutations: `commit` or `rebase --continue` could publish durable state and then
fail with `E2BIG` while the caller observed no successful command result.

Git operations and filesystem writes join nested `transactionSync()` calls when
the repository and worktree share one opaque mutation scope, so a thrown outer
transaction rolls back the whole mutation. Repository storage caches must still
be revalidated after that rollback, because an operation may have observed newly
written objects.

## Decision

The dispatcher passes the resolved run options to each awaitable handler, and
every local mutating handler uses one shared synchronous wrapper in this order:

1. Open an outer transaction on the selected repository database.
2. Mark the current phase, then run the native operation, format its success
   result, and apply the output preflight as three separate phases.
3. Let every operation, formatting, or output-limit exception escape, so the
   outer transaction rolls back.
4. Revalidate repository storage caches after rollback. Only an exception from
   the native-operation phase may enter command-specific Git-domain mapping;
   formatting and preflight exceptions, `E2BIG` included, are rethrown
   unchanged. The same output bounds apply to any mapped failure result.

Before a command that can mutate the worktree enters the wrapper, it must prove
transaction affinity through opaque scope identity
(`packages/git/src/cli/write/write-runtime.ts`). A missing or different scope
fails closed before any mutation.

The dispatcher awaits the handler only after the local transaction callback has
returned, and keeps its own final bounding call as defense in depth.

Network argv uses a different policy, because no transaction can roll back an
HTTP side effect or an already-published fetch. Four boundaries are explicit:

1. Local-only `init` and mutating `remote` forms retain transactional preflight.
2. Read-only `ls-remote`, and clone, fetch, and pull before publication, may fail
   with `E2BIG` because no durable command outcome must be reported.
3. Clone, fetch, and pull after local publication return bounded bytes with
   `truncated: true`. Output limits never replace success, conflict, or a later
   integration failure.
4. Push may fail known output preflight before receive-pack invocation. After
   invocation, native transport certainty is authoritative: confirmed status,
   `EPUSHUNCERTAIN`, and tracking reconciliation are preserved, with output
   truncation recorded separately.

## Consequences

- A destination-specific `E2BIG` from a local-only command, or from a network
  command before publication, cannot publish an index, worktree, ref, reflog,
  object, or operation-state mutation.
- Existing nested operation transactions remain the only mutation
  implementation; the CLI adds one outer rollback boundary.
- A new local mutating handler must use the shared wrapper and prove rollback for
  stdout, retained stderr, and combined-output overflow. With `discardStderr`,
  stderr is neither validated nor charged, so the mutation commits when stdout
  and the resulting combined output fit.
- Worktree-mutating commands are unavailable when the repository and worktree do
  not expose the same opaque mutation scope.
- Handlers receive resolved ceilings even when they only read. The narrow public
  runner capability is unchanged.
- A promise-returning runner does not make local transaction ownership
  asynchronous; no transaction spans an await.
- A caller can distinguish presentation loss from operation uncertainty.
  `truncated` means only that output was bounded; `EPUSHUNCERTAIN` still means
  receive-pack was invoked without a safely retained final status.

## Alternatives considered

- **Validate only after dispatch.** Leaves durable mutations visible after an
  `E2BIG` failure.
- **Estimate success output before mutating.** Commit and rebase output depends
  on the resulting object and lifecycle state, so an estimate drifts from the
  formatted bytes.
- **Inject a transaction into the generic runner.** The selected repository and
  its cache-revalidation seam are resolved by the handler from `cwd`; moving that
  ownership into the parser kernel would couple it to repository storage.
