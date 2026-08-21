# src/shell — a command is a query

`kompjutr/shell`: a bash-shaped surface over `Filesystem`. Every other virtual
shell implements a command as a loop over a tree — `readdir`, `readFile` each
hit, filter in JS — which is one statement per file. Here a command compiles to
a bounded query: `find -name` is one `glob`, `grep -rl` on a literal is one
`discoverFilesContaining`, `ls` is one `readdir`, `head -20` is one `readRange`.

`docs/plans/shell.md` is the specification, including the deliberate
divergences from real bash. Read §5.1 before "fixing" ignore-file handling.

## Pipeline

```
parse/    source → AST (11 node kinds; the corpus uses no more)
plan/     AST → Plan. Pure: imports nothing from src/fs/. A glob is carried
          as a pattern and marked, never resolved here.
exec/     Plan → result. Pull-based, so a consumer that stops pulling stops
          the source. All filesystem access goes through BoundedFs.
commands/ the registry: grep, rg, xargs, plus read/list/file/text families
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
  forgets `| head` must still get a bounded result. Defaults: 1 MB stdout,
  10,000 operations, 1.5 MB read budget per statement.
- **`operations` in `RunResult` is the metric that matters.** A change that
  makes output prettier and raises the operation count is a regression.
- **A trailing `head -N` is a demand hint, not a stage.** Sources seed at
  `2 * limitHint`; a fixed page costs a second round trip once match density
  drops below 2/3. Do not change the seeding factor without re-measuring.
- **`grep` and `rg` are the real flags and the real output.** Their behaviour is
  not a matter of opinion — it is pinned by differential tests against the
  installed binaries. See `tests/CLAUDE.md`.
