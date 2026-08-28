---
id: 0015
title: Route Git argv through one synchronous runner
status: accepted
date: 2026-08-28
---

# 0015 — Route Git argv through one synchronous runner

## Context

The public Git clients expose promise-returning methods, while an injected shell
command must return a synchronous generator. The operations needed by an agent
are already synchronous below the facade, but exposing each one directly to the
shell would duplicate argv parsing, error mapping, output accounting, and
identity handling across the native client, the Computer adapter, and pipelines.

The shell must remain independent of Git. Its command injection seam is a useful
general boundary, and importing the Git runtime into the shell would reverse the
existing dependency direction. Running a real Git process is not available in a
Durable Object and would bypass the SQLite-native runtime in any case.

## Decision

Git will own one strict synchronous argv dispatcher behind this public narrow
capability:

```ts
interface GitCliRunner {
  runCli(input: GitCliInput, options?: GitCliRunOptions): GitCliResult;
}
```

Native `Git` will implement that capability. Its promise-returning `Git.cli()`
will wrap the same dispatcher. The Computer adapter will construct the same
runner internally and wrap it without adding the runner to Computer's public
interface.

The dedicated `kompjutr/git/shell` entry may depend on shell command types and
will export `createGitCommand(runner: GitCliRunner): Command`. The shell package
will never import Git, and the root entry will not register Git implicitly. A
consumer opts in with:

```ts
new Map([["git", createGitCommand(workspace.git)]])
```

The dispatcher is an allowlist. It accepts only these local forms:

| Command | Grammar |
|---|---|
| `status` | exactly one of `--porcelain`, `--porcelain=v1`, `--short`, `-s` |
| `diff` | no operands or options |
| `log` | zero or one bounded count, zero or one bounded format, then zero or one ref or proven-linear `a..b` range |
| `rev-list` | `--count a..b` |
| `symbolic-ref` | `--short ref` |
| `add` | one or more exact or directory-prefix paths, with optional `--` |
| `commit` | exactly one `-m message` or `--message=message` |
| `rebase` | exactly `--continue` or `--abort` |

No parser accepts a valid prefix and ignores the remainder. Unknown and network
commands fail without fallback. Count values are ASCII decimal safe integers
from 0 through 50,000; `-1` is the only shorthand. Log formats accept bounded
literal UTF-8 and only `%H`, `%h`, `%P`, `%s`, `%B`, `%an`, `%ae`, `%at`, `%cn`,
`%ce`, `%ct`, `%n`, and `%%`. Log ranges fail closed unless the right tip reaches
the exclusive left commit through a single-parent chain.

`cwd` is the only invocation-directory field. It defaults to `/`, selects the
nearest checkout, and resolves path operands without permitting an escape from
that checkout. Accepted forms do not consume stdin. The dispatcher reads only
the four author and committer identity variables supported by native commit
options. It preserves `resolveIdentity()`'s complete-source precedence, including
its deliberate difference from Git's field-by-field handling of partial env
identities.

Results preserve the command-specific Git 2.54.0 stdout, stderr, and exit-code
triplet. There is no common diagnostic stream or common usage status. Expected
Git-domain refusals are returned as bounded results; unexpected programming
errors remain exceptions.

The optional public run options are exactly:

```ts
interface GitCliRunOptions {
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxCombinedOutputBytes?: number;
  readonly discardStderr?: boolean;
  readonly logLimitHint?: number;
}
```

Byte ceilings are safe integers from zero through their intrinsic maxima; the
log hint is a safe integer from zero through 50,000. Intrinsic defaults are
16 MiB stdout, 1 MiB stderr, and 16 MiB combined. Discarded stderr is neither
retained nor charged. The log hint can only tighten a missing or larger argv
count. The shell adapter derives tighter values from its output destination and
demand without reparsing argv.

## Consequences

- Native, Computer, and shell callers share one grammar and one result mapper.
- Shell pipelines stay synchronous, and Git does not become a shell dependency.
- Raw diagnostic bytes can retain Git's stream split through redirects and
  `2>&1`; the existing human-oriented shell warning path remains unchanged.
- Git's separately bounded SQL work does not appear in shell filesystem
  operation counts.
- Adding a command or spelling is a public capability change. It requires a
  bounded native operation, exact argv and output witnesses, and an explicit
  allowlist update.
- The surface intentionally does not promise arbitrary Git CLI compatibility.

## Alternatives considered

- Make every shell command asynchronous. This would change the shell execution
  model, lazy pipeline behavior, and every existing command for one adapter.
- Implement separate dispatchers in the native client, Computer adapter, and
  shell command. Their grammars, diagnostics, and limits would drift.
- Let the shell import and construct Git. This reverses the dependency boundary
  and makes generic command injection depend on repository state.
- Spawn the installed Git binary. Durable Objects have no process runtime, and
  an external repository would not operate on the SQLite-native store.
