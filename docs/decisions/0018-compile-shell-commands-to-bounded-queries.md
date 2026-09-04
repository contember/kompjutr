---
id: 0018
title: Compile shell commands to bounded queries
status: accepted
date: 2026-08-21
---

# 0018 — Compile shell commands to bounded queries

## Context

A conventional virtual shell implements recursive commands as loops over
`readdir` and `readFile`. On Durable Object SQLite that becomes one or more SQL
statements per file, which is exactly the per-path cost model this project
exists to avoid ([ADR-0001](0001-own-the-standalone-sqlite-runtime.md)).

General bash compatibility would also admit syntax and commands whose cost the
runtime cannot bound at all.

## Decision

The shell is `parse → plan → execute`. The planner stays pure. The executor
lowers supported commands to bulk filesystem primitives, pulls results on
demand, and enforces operation, byte, and output limits through `BoundedFs`. Its
retained-byte budget charges real buffered payload, which is why it is in
contract under
[ADR-0005](0005-bound-real-failures-and-measure-cost.md).

The command and syntax surface stays intentionally finite. Git is injected by
consumers and creates no shell-to-Git dependency
([ADR-0016](0016-route-git-argv-through-one-asynchronous-runner.md)).

## Consequences

- Recursive search and listing scale by indexed pages rather than by file count.
- A pipeline consumer can stop upstream work without materializing the remaining
  output.
- Compatibility is differential for the supported surface, not a promise of full
  bash behaviour.
- Adding syntax or a command requires a bounded execution strategy and parity
  evidence where a real binary exists.
  [ADR-0019](0019-admit-a-bounded-posix-shell-surface.md) makes Bash parity the
  standing admission gate and records the first deliberate expansion of this
  finite surface.

## Alternatives considered

- **Embed a general JavaScript bash implementation.** Its per-path filesystem
  loops defeat the SQL cost model and expose a much larger unbounded surface.
- **Run an external shell.** Durable Objects provide no process runtime, and
  adding one would be a separate execution backend rather than this library.

The full design and measurement record is in the
[archived shell plan](../archive/plans/shell.md).
