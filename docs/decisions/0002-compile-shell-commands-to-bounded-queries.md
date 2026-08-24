---
id: 0002
title: Compile shell commands to bounded queries
status: accepted
date: 2026-08-21
---

# 0002 — Compile shell commands to bounded queries

## Context

A conventional virtual shell implements recursive commands as loops over
`readdir` and `readFile`. On Durable Object SQLite that becomes one or more SQL
statements per file. General bash compatibility would also admit syntax and
commands that cannot be bounded by the runtime.

## Decision

We will implement the shell as `parse → plan → execute`. The planner remains
pure. The executor lowers supported commands to bulk filesystem primitives,
pulls results on demand, and enforces operation, byte, and output limits through
`BoundedFs`. The command and syntax surface stays intentionally finite. Git is
injected by consumers and does not create a shell-to-Git dependency.

## Consequences

- Recursive search and listing scale by indexed pages rather than file count.
- Pipeline consumers can stop upstream work without materializing the remaining
  output.
- Compatibility is differential for the supported surface, not a promise of
  full bash behavior.
- Adding syntax or a command requires a bounded execution strategy and parity
  evidence where a real binary exists.

## Alternatives considered

- Embed a general JavaScript bash implementation. Its per-path filesystem loops
  defeat the SQL cost model and expose a much larger unbounded surface.
- Run an external shell. Durable Objects do not provide a process runtime, and
  adding one would be a separate execution backend rather than this library.

The full design and measurement record is in the
[archived shell plan](../archive/plans/shell.md).
