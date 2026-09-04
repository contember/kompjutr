---
id: 0001
title: Own the standalone SQLite runtime
status: accepted
date: 2026-08-20
---

# 0001 — Own the standalone SQLite runtime

## Context

The original implementation adapted Git to a filesystem owned by
`@cloudflare/computer`. Reads could bypass its public API, but writes still paid
per-path costs and had to reason around an invisible write-back buffer. Git
index materialization also exhausted the Durable Object memory budget on modest
repositories.

Two runtimes owning one working tree also split responsibility for durability
and cost. Neither side could state a complete consistency or cost contract on
its own, because either could change rows the other believed it owned.

## Decision

We own the filesystem, Git store, and workspace runtime over one Durable Object
SQLite database. Paths, file content, Git objects, refs, the index, and packs
are rows in that database. Bulk, paged, and streaming operations are the
first-class API.

No file under `src/` imports `@cloudflare/computer`, and
`tests/import-graph.test.ts` enforces that. Exactly two deliberate contact
points remain:

- `src/fs/import.ts` — a one-time, in-database migration that reads Computer's
  v5 `vfs_*` tables and moves a working tree into `fs_*`. It is the only
  production module that reads `vfs_*`, and it requires an explicit caller
  acknowledgement that the provider is quiescent, because pending file
  descriptor buffers are invisible to SQLite.
- The test suite, where Computer is an independent oracle and fixture.

## Consequences

- Every operation is built on bulk, paged primitives whose cost is measured in
  `bench/` ([ADR-0005](0005-bound-real-failures-and-measure-cost.md)) instead of
  degrading per path.
- The runtime needs no `.git` directory and no external filesystem
  implementation.
- The project owns POSIX semantics, schema shape, pack storage, and the
  corresponding conformance burden.
- An existing Computer working tree gets a one-way migration, not a
  compatibility mode. Nothing in the runtime adapts its storage model to
  Computer's API.
- `@cloudflare/computer` is a development dependency. Removing it would cost the
  independent test oracle and the import path, not a shipped feature.

## Alternatives considered

- Keep optimizing behind Computer's public filesystem API. This cannot remove
  per-path write costs or the hidden-buffer trust boundary.
- Write directly to Computer's private `vfs_*` tables at runtime. This couples
  the project to an internal schema and still leaves ownership split across two
  runtimes.
- Ship a permanent compatibility adapter beside the native surface. This was
  built and then removed. It duplicated the argv and workspace surfaces, every
  native change had to be mirrored into it, and no consumer of this package
  needed it. The migration path above covers the real requirement.

The full design record is in the
[archived standalone plan](../archive/plans/standalone-runtime.md).
