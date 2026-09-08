---
id: 0002
title: Organize source by domain with bottom-up layers
status: accepted
date: 2026-08-30
---

# 0002 — Organize source by domain with bottom-up layers

## Context

The Durable Object filesystem and Git store use the same SQLite database, while
the local runtime combines the Git store with a disk worktree. A storage adapter
placed inside either domain would force unrelated consumers to depend on it.
Git also contains several kinds of code with different dependency needs: pure
primitives, independent algorithms and wire codecs, persistence, command
operations, and public surfaces.

A flat source layout expresses none of that. It does not prevent a store module
from reaching back into an operation, and it does not stop a file from growing
until nobody reviews it as a whole.

## Decision

We organize source into behavior packages over shared SQLite and drive contracts.

- `@kompjutr/sqlite` sits below every domain. It owns structural SQL interfaces,
  SQLite error normalization, and shared routing limits. Runtime adapters live
  in their platform packages.
- `@kompjutr/drive` owns the minimal filesystem vocabulary and capabilities Git
  consumes.
- `@kompjutr/git` owns the Git domain. `@kompjutr/do` and `@kompjutr/local`
  compose it with their platform storage and worktree implementations.
- Git uses bottom-up slices: `common` → `diff | ignore | protocol` → `store` →
  `ops` → surface. The surface is `client.ts`, `cli/`, and the entrypoints.
- `store/` owns persisted formats and explicit internal capabilities. It never
  imports `ops/`.
- `diff/` remains an LGPL-2.1-or-later boundary with its own license and SPDX
  headers.

`tests/import-graph.test.ts` enforces the dependency rules exactly, including
package-manifest edges and platform builtins:

1. SQLite and drive import no behavior or runtime package.
2. Git imports only SQLite, drive, and its declared compression dependency.
3. The DO and local packages may compose lower packages but never import each
   other.
4. Node-only modules remain unreachable from Worker-facing entries.
5. A Git slice may import its own slice or a lower-ranked one. `common` is
   rank 0; `diff`, `ignore`, and `protocol` are independent rank-1 peers;
   `store` is rank 2; `ops` is rank 3; everything else under `git/` is the
   rank-4 surface.
6. `packages/git/src/store` may not import `packages/git/src/ops`.
7. No file under `packages/*/src` may import `@cloudflare/computer`
   ([ADR-0001](0001-own-the-standalone-sqlite-runtime.md)).

The witness covers relative imports, exports, dynamic imports, and import
types. `tests/file-ceiling.test.ts` enforces the size rules: 500 lines per
file, 20 direct TypeScript files per directory, and a 173-line symbol ceiling
set at the 99.5th percentile of the measured distribution, with the long
procedures past it named individually rather than raising the bar for
everyone. `tests/public-exports.test.ts` protects the published entrypoints.

## Consequences

- The package tree states ownership: two shared contracts, one Git domain, two
  platform compositions, and explicit layers inside Git.
- Filesystem code shares SQLite and drive vocabulary without depending on Git.
- Persisted journal codecs and store contracts live below operations, so a
  store-to-ops value cycle cannot return.
- Internal table-family APIs are explicit without becoming package exports.
- Five independently installable artifacts use one lockstep release unit
  ([ADR-0020](0020-publish-runtime-boundaries-as-scoped-packages.md)).
- A new file that violates dependency direction or a size ceiling fails the
  suite rather than the review.
- The symbol ceiling is a ratchet: a grandfathered procedure that shrinks below
  it may not be re-listed.

## Alternatives considered

- **Put the database adapter in Git.** Rejected: the filesystem uses the same
  adapter and must not depend on Git.
- **Duplicate adapters per domain.** Rejected: transaction behavior, row
  normalization, SQLite error handling, and routing limits are shared policy.
- **Keep domains in one published package.** Rejected after the local runtime was
  accepted: installable platform isolation and a reusable Git engine now justify
  the publication overhead.
- **Use guidelines without tests.** Rejected: dependency cycles and oversized
  files are easy to reintroduce when the rule is not executable.
