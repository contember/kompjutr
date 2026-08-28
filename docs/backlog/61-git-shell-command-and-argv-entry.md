---
id: 61
title: Provide git as a synchronous shell command and the argv entry point
blocked-by: []
---

# 61 — Provide git as a synchronous shell command and the argv entry point

**Summary.** Tier A. An agent inside a Durable Object checkout runs `git` as a
shell command, often in a pipeline. `kompjutr/shell` has no `git`, `Git.cli()`
throws `EUNSUPPORTED`, and a consumer cannot fill the gap itself: the shell is
synchronous, the public `Git` façade is async, and the synchronous ops
underneath are internal. kompjutr owns the adapter.

## Problem

- `src/shell/exec/context.ts:302` — `Command = (context) => CommandResult` over
  `ByteStream = Generator<Uint8Array>`; nothing in `src/shell/` is async. The
  documented route "consumers inject `git` through `ShellOptions.commands`"
  cannot be walked with the public API, and no test walks it.
- `src/git/client.ts:599` and `src/compat/computer/client.ts:323` — `cli()`
  throws. The Computer contract is already declared:
  `{ argv, cwd?, env?, stdin? }` → `{ stdout, stderr, exitCode }`.
- The agent-side subset across both consumers is small and local:
  `status --porcelain|--short`, `add <paths>`, `commit -m`,
  `log [-1] [--format=…] [<a>..<b>]`, `diff`, `rebase --continue|--abort`,
  `rev-list --count <a>..HEAD`, `symbolic-ref --short <ref>`. Models write
  these in pipelines (`git diff | head -100`, `git status --porcelain | wc -l`),
  so a dispatcher that sits in front of the shell is not enough.

## Approach / acceptance

- One synchronous argv dispatcher in `src/git/` over the existing sync ops and
  formatters (`formatPorcelainV1`, `formatShort`, `diff()`, `CommitView`). It
  parses only the subset above; any other subcommand, unknown option, or
  network subcommand (`fetch`, `push`, `pull`, `clone`, `ls-remote`) fails
  closed with Git-shaped stderr and Git's exit code. No fallback, no partial
  parse.
- `Git.cli()` and the Computer compat `cli()` call the dispatcher and return
  `{ stdout, stderr, exitCode }` per the declared contract. Identity defaults
  read `env` the way `commit()` does.
- A shell `Command` factory in a new export entry (`kompjutr/git/shell` or
  similar) wraps the same dispatcher so a consumer registers it with
  `ShellOptions.commands` in one line. Stdout streams as a `ByteStream`, stderr
  goes through `warn()`, the exit status is the command's status. Pipelines,
  `&&`/`||`, and redirects work unchanged.
- Layering: `src/git/` may import the `Command` and `CommandContext` types from
  `src/shell/`; `src/shell/` still never imports `src/git/`. Record it as an
  ADR. The command does not go through `BoundedFs` — Git has its own statement
  and byte bounds — so `RunResult.operations` does not count Git's SQL;
  document that in `docs/reference/shell.md`.
- Bound argv count and bytes, message bytes, and stdout bytes before running;
  output past the shell's stdout limit fails closed like any other command.
- Witness: differential tests against the installed `git` for each
  subcommand's stdout, stderr, and exit code on the same repository state,
  including a conflicted rebase resolved with `add` + `rebase --continue`; one
  shell test per pipeline shape (`git status --porcelain | wc -l`,
  `git log --oneline | head -3`, `git diff > out.patch`); a refused `git push`
  and an unknown flag; `Git.cli()`, the compat `cli()`, and the shell command
  return the same bytes.

## Touch points

`src/git/cli.ts` (new), `src/git/shell.ts` (new entry), `src/git/client.ts`,
`src/compat/computer/client.ts`, `src/index.ts`, `package.json` (exports),
`tests/git-cli.test.ts` (new), `tests/shell*.test.ts`, `docs/decisions/`,
`docs/reference/shell.md`, `docs/reference/git-support.md`

<!-- Origin: backlog review 2026-08-28 — decided: kompjutr owns the adapter, not the consumer -->
