---
id: 60
title: Eliminate silently accepted shell command divergences
blocked-by: []
---

# 60 — Eliminate silently accepted shell command divergences

**Summary.** Silent correctness divergence. Several accepted flags are ignored
or only partly implemented, and some expected command errors escape the public
`RunResult` contract as exceptions.

## Problem

The shell's design says unsupported input fails explicitly, but current flag
tables admit behavior the commands do not implement:

- `ls` accepts `-h`, `-t`, `-r`, and `-S` without applying them;
- `cp` accepts `-p` and `-v`, `rm` accepts `-v`, and `mkdir` accepts `-m` and
  `-v` without their observable behavior;
- `head` accepts `-q` and `-v` but never emits or suppresses multi-file headers;
- `xargs -t` / `--verbose` is an explicit no-op;
- `wc -m` falls through to the default three-column output rather than counting
  characters.

Repeated `-e` / `--regexp` occurrences in both `grep` and `rg` overwrite one
`pattern` variable, so only the last pattern matches
(`src/shell/commands/grep.ts:137-166`, `src/shell/commands/rg.ts:163-208`). Real
commands OR the patterns. The existing parity suite covers one `-e`, not more
than one.

`wc`, `sort`, and `uniq` also let expected `UsageError`s escape from
`shell.run()` because they do not convert parser failures into an exit-2 command
result. Finally, `sort` compares decoded strings with JavaScript `<` / `>`, so
path lines above the BMP can disagree with filesystem and Git byte order
(`src/shell/commands/text.ts:86-95`).

## Approach / acceptance

- Inventory every accepted flag. Implement only behavior justified by the
  supported workload; reject every remaining flag with exit 2. No accepted flag
  may be a silent no-op.
- Support repeated search patterns as an OR in both file and stdin modes, with
  GNU grep and ripgrep differential tests. Keep SQL content pushdown only where
  the complete pattern set can be represented without changing the answer.
- Convert expected usage and filesystem failures from every built-in into a
  stable `RunResult`; programming defects and arbitrary injected-command throws
  remain distinguishable.
- Give text `sort` an explicit byte-order contract compatible with path order,
  including non-BMP differential fixtures. Never order possible paths with
  JavaScript UTF-16 comparison.
- Extend the differential harness beyond isolated `grep`/`rg` cases to every
  supported command/flag shape named here. Compare stdout, stderr, exit status,
  and resulting filesystem state where the command mutates it.
- Publish the exact command and flag matrix, plus deliberate divergences, in
  `docs/reference/shell.md`.

## Touch points

`src/shell/commands/flags.ts`, `src/shell/commands/files.ts`,
`src/shell/commands/list.ts`, `src/shell/commands/read.ts`,
`src/shell/commands/text.ts`, `src/shell/commands/xargs.ts`,
`src/shell/commands/grep.ts`, `src/shell/commands/rg.ts`, shell parity helpers,
`tests/shell/`, `docs/reference/shell.md`

<!-- Origin: shell implementation audit, 2026-08-26. -->
