---
id: 0028
title: Confine mounted views and fail closed
status: accepted
date: 2026-10-07
---

# 0028 — Confine mounted views and fail closed

## Context

Hosts that run several agent sessions over one workspace need each session to
see only its own directories, through the same `Filesystem` and the same shell.
The store keeps one path namespace, so isolation must be a view over it. Two
things make this a real choice:

- A kernel bind mount follows symlinks in the namespace it is mounted into. A
  view that did so would let a session plant a relative or absolute link to
  another session's files and read or write through it.
- The view must not change the cost model ([ADR-0005](0005-bound-real-failures-and-measure-cost.md)).
  A view that resolved twice, or resolved per path in a batch, or dropped GLOB
  pushdown when a long real prefix exceeds the 50-byte cap, would turn the
  bulk API back into a per-path one.

## Decision

We will implement the view inside the filesystem layer and confine every
resolution to the source of the mount it starts in. The store's resolver takes
an optional confinement root; leaving it is a breach, and a breach reads as an
absent path. Paths outside every mount are absent without a statement, and
synthetic ancestor directories answer from the mount table. Errors are
rewritten to quote virtual paths. Rename and hard link across mounts fail with
`EXDEV`, writes to read-only mounts and synthetic directories with `EROFS`.

The view reuses the store's batch resolution and pages: one confined resolution
per call or batch, one store statement per covered mount, and GLOB patterns
rewritten per mount so they stay pushed down.

The exact rules are in [`reference/architecture.md`](../reference/architecture.md#mounted-views).

## Consequences

- From inside a view, files outside it cannot be told from files that do not
  exist, and no symlink leads out.
- Absolute and cross-mount symlinks that would work under a bind mount read
  as dangling. A mount at `/` resolves absolute targets from its source.
- Single-path operations and batch writes take an injected resolver; a new
  operation that resolves on its own bypasses confinement.
- Git is not confined. An injected `git` command binds the real filesystem.

## Alternatives considered

- **Wrap the public `Filesystem` from outside the package.** It cannot confine
  symlink expansion without resolving twice, and producing `RealPath` values
  would need casts.
- **Follow symlinks in virtual space, as a bind mount does.** Cross-mount
  resolution would have to re-enter the view per expansion, and every rule
  added to keep it safe is a rule that can be wrong. Failing closed has one
  rule.
- **Check the final real path only.** A walk that leaves the source and comes
  back would still reveal whether paths outside exist.
