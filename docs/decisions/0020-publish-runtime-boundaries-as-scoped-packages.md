---
id: 0020
title: Publish runtime boundaries as scoped packages
status: accepted
date: 2026-09-07
---

# 0020 — Publish runtime boundaries as scoped packages

## Context

Git already consumes a structural SQLite interface, but its drive types and a
few optimized reads still import the concrete SQLite filesystem. Adding a local
disk worktree must not put Node imports in Worker graphs or route the existing
Durable Object path through a lowest-common-denominator adapter.

The former single-package choice assumed no independently useful consumer. The
local runtime creates that consumer and makes package boundaries useful as
executable dependency and platform boundaries.

## Decision

We publish five lockstep-versioned packages under `@kompjutr`: `sqlite`, `drive`,
`git`, `do`, and `local`. The unscoped `kompjutr` facade is removed.

`@kompjutr/git` depends only on the SQLite and drive contracts plus `pako`.
Git-side SQL that deliberately joins `git_*` with the Durable Object filesystem
stays in the separately imported `@kompjutr/git/do-fs` subpath.
`@kompjutr/do` owns and composes the concrete filesystem, shell, adapter, and
Workspace. `@kompjutr/local` owns every unsupported Node platform import.

The complete ownership and export map is frozen in
[`scoped-packages-and-local-runtime.md`](../specs/scoped-packages-and-local-runtime.md).

## Consequences

- Consumers can install Git, the DO runtime, or the Unix local runtime without
  loading another platform's implementation.
- Five artifacts ship from one tag and pin exact internal versions. Independent
  release cadences are deferred until compatibility pressure justifies them.
- Package manifests and packed artifacts, not source folders alone, become part
  of the import-graph gate.
- The DO-specific Git subpath is intentionally coupled to the exact lockstep Git
  version. Ordinary Git consumers never import it.
- The release pipeline becomes topological and requires npm ownership and OIDC
  trusted-publisher setup for the `@kompjutr` scope.

## Alternatives considered

- A separate sixth DO/Git integration package would make ownership purer, but it
  would publish broad tracker and sparse-store internals before another
  integration needs them.
- Combining SQLite, drive, and Git into one core package would simplify release,
  but it would hide the platform and ownership boundaries this split must
  enforce.
- Export subpaths from one package are not independently installable and cannot
  keep Node-only dependencies out of a consumer's package graph.
