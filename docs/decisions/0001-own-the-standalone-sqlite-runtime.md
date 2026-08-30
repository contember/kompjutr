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

## Decision

We will own the filesystem, Git store, and workspace runtime over one Durable
Object SQLite database. Paths, file content, Git objects, refs, the index, and
packs are rows in that database. Bulk, paged, and budgeted operations are the
first-class API. Compatibility with `@cloudflare/computer` stays isolated in
`src/compat/` and does not shape the native storage model.

## Consequences

- Every operation can be built on bulk, paged primitives whose cost is
  measured in `bench/` (ADR-0017) instead of degrading per path.
- The runtime needs no `.git` directory or external filesystem implementation.
- The project owns POSIX semantics, schema migration, pack storage, and the
  corresponding conformance burden.
- Compatibility remains possible, but it is an adapter rather than an
  architectural dependency.

## Alternatives considered

- Continue optimizing behind Computer's public filesystem API. This cannot
  remove per-path write costs or the hidden-buffer trust boundary.
- Write directly to Computer's private `vfs_*` tables. This couples the project
  to an internal schema and still leaves ownership split across two runtimes.

The full design record is in the
[archived standalone plan](../archive/plans/standalone-runtime.md).
