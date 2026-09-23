---
id: 0017
title: Commit mutating CLI commands, then truncate their output
status: accepted
date: 2026-09-23
---

# 0017 — Commit mutating CLI commands, then truncate their output

## Context

[ADR-0016](0016-route-git-argv-through-one-asynchronous-runner.md) requires the
argv runner to enforce caller-supplied stdout, stderr, and combined-output
ceilings before it returns a result. For a mutation, an output ceiling can meet
a completed operation in two ways: fail the command with `E2BIG` and roll the
mutation back, or keep the mutation and return less output.

The first policy needed its own machinery. Every mutating handler tracked a
phase so that only operation errors were mapped; formatting charged a modeled
retained-byte budget and failed on it; diagnostics were pre-counted; network
commands split into pre- and post-publication and pre- and post-invocation
cases with different rules. Rolling back for a presentation limit also
discarded work the caller asked for, and it could never apply to network side
effects, so the CLI had two policies.

## Decision

Every mutating CLI command, local or network, commits its outcome and then
fits its output to the destination. Lost bytes set `truncated: true`. Output
size never fails a mutating command.

A local mutating handler uses one shared synchronous wrapper
(`packages/git/src/cli/write/write-runtime.ts`):

1. Open an outer mutation guard transaction on the selected repository database.
2. Run the native operation and format its result inside that transaction.
   Any exception rolls the whole mutation back.
3. After rollback, revalidate repository storage caches, then map expected
   Git-domain refusals to a command-specific result.
4. Cut the success or failure result with `boundedPublishedGitCliResult`:
   stdout first, then stderr within the combined ceiling, at UTF-8 boundaries.

Formatters write into per-stream truncating buffers
(`packages/git/src/cli/write/write-output.ts`), so retained output never
exceeds the stream ceiling. Memory for a commit summary is bounded by the diff
summary row cap and by those buffers, not by a byte model.

Before a command that can mutate the worktree enters the wrapper, it proves
transaction affinity through opaque scope identity. A missing or different
scope fails closed before any mutation.

Network argv follows the same policy. `init` and mutating `remote` forms commit
in a local transaction, clone, fetch, and pull publish, and push invokes
receive-pack regardless of output ceilings; each returns bounded stderr with
`truncated` recording loss. `EABORTED`, `EPUSHUNCERTAIN`, confirmed report
status, and tracking reconciliation keep their native meanings.

Read commands have nothing to commit and still fail the first output excess
with `E2BIG`.

## Consequences

- A mutating command's result always describes a durable outcome. `truncated`
  means only that output was shortened; it never means the operation was
  undone. `EPUSHUNCERTAIN` still means receive-pack was invoked without a safely
  retained final status.
- One wrapper and one truncation function cover every mutating handler. There
  is no phase tracking, output preflight, or modeled summary budget.
- A formatting failure, such as the diff summary row cap, still rolls back the
  mutation, because formatting runs inside the transaction.
- With `discardStderr`, stderr is neither retained nor reported as truncated.
- A caller that needs complete output must raise its ceilings; it cannot use
  a small ceiling as a dry run.
- Worktree-mutating commands are unavailable when the repository and worktree do
  not expose the same opaque mutation scope.
- A promise-returning runner does not make local transaction ownership
  asynchronous; no transaction spans an await.

## Alternatives considered

- **Preflight output inside the transaction and roll back on overflow.** The
  prior decision. It needed phase tracking and a modeled retained-byte budget,
  discarded requested work for a presentation limit, and could not cover
  network side effects, so network commands followed a second policy.
- **Format after the transaction commits.** A formatting failure would then
  surface as an error for a mutation that already persisted.
- **Validate only after dispatch without truncating.** Leaves durable mutations
  visible behind an `E2BIG` failure.
