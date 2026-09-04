# src/shell — a command is a query

`kompjutr/shell`: a bash-shaped surface over `Filesystem`. Every other virtual
shell implements a command as a loop over a tree — `readdir`, `readFile` each
hit, filter in JS — which is one statement per file. Here a command compiles to
a bounded query: `find -name` is one `glob`, `grep -rl` on a literal is one
`discoverFilesContaining`, `ls` is one `readdir`, `head -20` is one `readRange`.

`docs/reference/shell.md` is the current specification. Historical measurements
and rationale are in `docs/archive/plans/shell.md`; read §5.1 there before
"fixing" ignore-file handling.

## Pipeline

```
parse/    source → quote-aware AST with literal, glob, and parameter word parts
plan/     AST → Plan. Pure: imports nothing from src/fs/. Globs and parameters
          remain marked, never resolved here.
exec/     Plan → result. Resolves parameters from the frozen run env and globs
          through BoundedFs. Pull-based, so a consumer that stops pulling stops
          the source.
commands/ the registry: grep, rg, printf, exit, xargs, plus read/list/file/text families
```

Keep `plan/` free of filesystem imports — that is what makes every rewrite
testable without a database. Anything needing the filesystem is *marked* in the
plan and performed by the executor.

## Rules

- **`git` is not in the registry, deliberately.** Consumers inject it through
  `ShellOptions.commands`. `src/shell/` must never import `src/git/`.
- **Every filesystem call goes through `BoundedFs`.** It counts calls against
  `maxOperations` (default 10,000). Do not hand a command the raw `Filesystem` —
  the set of things a command can do to the database stays visible in one file.
- **Bounds are the executor's job, not the caller's discipline.** An agent that
  forgets `| head` must still get a bounded result. Defaults: 1 MB each for
  stdout and stderr, 10,000 operations, 1.5 MB per read statement, and 16 MiB
  of live shell-owned intermediate bytes. Expanded argv also has a 10,000-entry
  ceiling and its UTF-8 bytes use the retained budget. Reserve before retaining
  and release when ownership ends; semantic input fails rather than truncates.
- **Parameter expansion is an execution concern.** Preserve ordered word parts
  and quote context through parse and plan. Only command arguments admit named
  parameters; unquoted values use fixed default-IFS splitting and pathname
  expansion. Do not make planning depend on env or the filesystem.
- **`operations` in `RunResult` is the metric that matters.** A change that
  makes output prettier and raises the operation count is a regression.
- **A trailing `head -N` publishes a demand hint and remains a stage.** Paged
  listings size their first page from it; searches use fixed full pages after
  measurement showed that sparse matches make small discovery pages costlier.
  Do not change either policy without re-measuring.
- **`grep` and `rg` are the real flags and the real output.** Their behaviour is
  not a matter of opinion — it is pinned by differential tests against the
  installed binaries. See `tests/CLAUDE.md`.
- **Bash parity gates additions to the shell surface.** Compare admitted syntax
  and built-ins byte-for-byte against Bash. Pin an intentional divergence as an
  explicit local refusal; never weaken the comparison. See
  [ADR-0019](../../docs/decisions/0019-admit-a-bounded-posix-shell-surface.md).
