---
id: 63
title: Accept caller-supplied stdin and env for a shell run
blocked-by: []
---

# 63 — Accept caller-supplied stdin and env for a shell run

**Summary.** Surface, not parity. `run(source)` takes a source string and
nothing else, so a consumer cannot give a command its stdin or its environment.
Both are inputs the agent-session orchestrator's shell tool already carries, and
[61](61-git-shell-command-and-argv-entry.md) assumes env reaches a command.
Small: neither touches a deliberate parser boundary.

## Problem

- `src/shell/index.ts` — `Shell.run(source)` and `Shell.exec(source)` take one
  argument. `ShellOptions` carries `fs`, `sessionId`, `cwd`, `commands` and
  `limits`, all of which are per-session; there is no per-run seam at all.
- `src/shell/exec/context.ts:275` — `CommandContext.stdin` already exists as
  `ByteStream | null`, documented as "the previous stage, or null when this
  command is first". What a command reads from is there; what is missing is a
  way for the caller to seed the first stage.
- `src/shell/exec/context.ts:268` — `CommandContext` has no `env` field.
  [61](61-git-shell-command-and-argv-entry.md) states that identity defaults
  "read `env` the way `commit()` does", which no injected command can do today.
  61 does not list this as a dependency and its touch points do not include the
  context; whichever of the two ships first has to add it.
- The workaround for stdin is a temp file and a `<` redirect — `cat < in.txt`
  works today. It costs a write, plus a path the caller has to name, own and
  clean up on every invocation, in a session whose filesystem is shared.

Deliberately **not** in scope, recorded here so the item is not widened later:

- Parameter expansion (`$FOO`) and descriptor duplication (`1>&2`) are stated
  boundaries in [`../reference/shell.md`](../reference/shell.md). `env` here is
  a value an injected command reads, never something the parser expands.
- `exit`, `printf` and `sleep` are absent. They surfaced only as the vehicles a
  consumer's port-conformance suite happens to use, not from a command line an
  agent wrote, so there is no corpus evidence for them and the clauses that used
  them are testable without them — a failing command exits non-zero without
  `exit`.
- Run timeouts. The shell is synchronous; `maxOperations` and
  `maxRetainedBytes` are what bound a run here, and a caller that wants a wall
  clock owns it.

## Approach / acceptance

- `run` and `exec` take an optional second argument carrying `stdin`
  (`Uint8Array | string`) and `env` (`Record<string, string>`). Both absent is
  today's behaviour exactly.
- `stdin` seeds the first stage's existing `ByteStream`. Later pipeline stages
  are unaffected. Define and test the collision with `< file` on the same stage
  rather than leaving it to whichever code path runs last.
- `env` reaches `CommandContext` as a readonly record. No built-in reads it and
  the parser never expands it, so the boundary above stands; it exists for
  injected commands.
- Bound `stdin` bytes and the env entry count and byte size before the run, and
  fail closed like every other input ceiling.
- Witness: supplied stdin through `cat` equals `cat < file` byte for byte, and
  again through a pipeline; oversized stdin and oversized env fail closed; an
  injected command reads an env value it was given; a run supplying neither is
  unchanged, including its `operations` count.

## Touch points

`src/shell/index.ts`, `src/shell/exec/context.ts`, `src/shell/exec/execute.ts`,
`src/shell/session.ts`, `tests/shell/`, `docs/reference/shell.md`

<!-- Origin: consumer adapter integration, 2026-08-28 — the orchestrator's platform shell port carries stdin and env per run; kompjutr's run() carries neither. -->
