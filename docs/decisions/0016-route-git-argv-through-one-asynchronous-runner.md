---
id: 0016
title: Route Git argv through one asynchronous runner
status: accepted
date: 2026-08-28
---

# 0016 — Route Git argv through one asynchronous runner

## Context

The shell accepts command streams, and consumers want to type `git …` into them.
Exposing each Git operation to the shell directly would duplicate argv parsing,
error mapping, output accounting, and identity handling across every surface
that offers a command line.

The shell must also stay independent of Git. Its command injection seam is a
useful general boundary, and importing the Git runtime into the shell would
reverse the existing dependency direction
([ADR-0002](0002-organize-source-by-domain-with-bottom-up-layers.md)). Running a
real Git process is not available in a Durable Object and would bypass the
SQLite-native store in any case.

## Decision

Git owns one strict asynchronous argv dispatcher behind a narrow public
capability:

```ts
interface GitCliRunner {
  runCli(input: GitCliInput, options?: GitCliRunOptions): Promise<GitCliResult>;
}
```

Native `Git` implements it, and `Git.cli()` uses the same dispatcher rather than
a second parser or handler set.

The dedicated `kompjutr/git/shell` entry may depend on shell command types and
exports `createGitCommand(runner: GitCliRunner): Command`. The shell package
never imports Git, and the root entry does not register Git implicitly. A
consumer opts in:

```ts
new Map([["git", createGitCommand(workspace.git)]])
```

**The dispatcher is an allowlist.** No parser accepts a valid prefix and ignores
the remainder, and unknown commands fail without fallback. The admitted commands
and their exact argv, the input and output ceilings, and the identity rules are
documented in
[the Git support reference](../reference/git-support.md#strict-argv-runner);
that reference is the surface, and this decision is only the rule that there is
exactly one of it.

Four properties are load-bearing and outlive any particular grammar:

- `cwd` is the only invocation-directory field. It defaults to `/`, selects the
  nearest checkout, and resolves path operands without permitting an escape from
  that checkout.
- The dispatcher reads only the four author and committer identity variables
  that native commit options support, and preserves `resolveIdentity()`'s
  complete-source precedence — including its deliberate difference from Git's
  field-by-field handling of partial environment identities. No credential
  environment variable is admitted; network authentication arrives through
  bindings and callbacks.
- Results preserve command-specific Git 2.54.0 stdout, stderr, and exit code, and
  carry an explicit `truncated` signal. Expected Git-domain refusals are bounded
  results; unexpected programming errors remain exceptions.
- Handlers are awaitable and the dispatcher awaits them, but an outer
  `transactionSync()` callback never returns a promise and no transaction crosses
  an await boundary
  ([ADR-0017](0017-preflight-mutating-cli-output-inside-the-transaction.md)).

Caller-supplied run options may only tighten intrinsic ceilings, discard stderr,
or hint a log count. Discarded stderr is neither retained nor charged.

## Consequences

- Every caller shares one grammar, one result mapper, and one set of limits.
- Shell pipelines stay pull-based, and Git does not become a shell dependency.
- Raw diagnostic bytes retain Git's stream split through redirects and `2>&1`.
- Git's separately bounded SQL work does not appear in shell filesystem
  operation counts.
- Adding a command or a spelling is a public capability change. It requires a
  bounded native operation, exact argv and output witnesses, and an explicit
  allowlist update.
- The surface intentionally does not promise arbitrary Git CLI compatibility.

## Alternatives considered

- **Keep a second synchronous runner for local commands.** Two runner contracts
  drift as asynchronous commands are added; this is what the current single
  asynchronous dispatcher replaced.
- **Implement separate dispatchers per surface.** Their grammars, diagnostics,
  and limits would drift apart.
- **Let the shell import and construct Git.** Reverses the dependency boundary
  and makes generic command injection depend on repository state.
- **Spawn the installed Git binary.** Durable Objects have no process runtime,
  and an external repository would not operate on the SQLite-native store.
