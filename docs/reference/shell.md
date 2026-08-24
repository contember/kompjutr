# Shell reference

`kompjutr/shell` is a bounded command surface over `Filesystem`. It resembles
bash where the supported agent corpus needs it, but it is not a general shell
or process runtime.

## Execution model

Commands pass through `parse → plan → execute`. Planning is pure and has no
filesystem dependency. Execution is pull-based and all filesystem access goes
through `BoundedFs`, which enforces operation and output limits.

Filesystem-oriented commands lower to bulk primitives. Literal recursive search
uses indexed content discovery; path matching uses indexed scans. A pipeline
consumer such as `head` stops upstream work when it stops pulling.

## Deliberate boundaries

- `git` is not built in. Consumers inject it through `ShellOptions.commands`.
- `grep` and `rg` have distinct flag surfaces over shared search machinery.
  Differential tests pin both against the installed binaries.
- `sed` supports substitution scripts and line-print scripts only. Other forms
  fail explicitly.
- The parser accepts only the syntax represented by its typed AST. Unsupported
  shell syntax fails instead of falling back to an external process.
- Default bounds are 1 MiB stdout, 10,000 filesystem operations, and a 1.5 MiB
  read budget per statement.

The completed design, measurements, and parity corrections remain in the
[archived shell plan](../archive/plans/shell.md). Agent-facing implementation
rules are in [`src/shell/CLAUDE.md`](../../src/shell/CLAUDE.md).
