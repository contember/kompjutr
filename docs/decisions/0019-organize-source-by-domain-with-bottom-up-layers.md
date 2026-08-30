---
id: 0019
title: Organize source by domain with bottom-up layers
status: accepted
date: 2026-08-30
---

# 0019 — Organize source by domain with bottom-up layers

## Context

`src/` mixes two kinds of directory at one level: real domains (`fs/`,
`shell/`) next to implementation slices of the Git domain (`core/`, `sqlite/`,
`git/`). The 2026-08-30 architecture review measured what the flat layout
allowed to grow:

- The Git engine and its store are bidirectionally coupled at the value level
  (`sqlite/store.ts` imports journal codecs from `core/ops/*`), so the
  documented "core reaches sqlite through `SharedRepoStore`" seam is two
  concrete classes plus 34 `db.transactionSync` call sites in 13 ops files.
- Private capabilities cross the seam through WeakMap "owned" friend functions
  bound by construction order; four different binding policies on one facade
  produced a confirmed user-visible defect (object writes fail after
  `worktreeRemove`).
- Nothing bounded file growth: `store.ts` reached 12,971 lines, `packs.ts`
  5,583, `sparse-workspace.ts` 3,537.

## Decision

We will organize `src/` by domain, with layered slices inside a domain and
one-way dependencies from the bottom up.

- **Domains:** `fs/`, `shell/`, `git/`. Composition stays outside domains:
  `runtime/` (Workspace), `compat/`, and `memory.ts` (the shared memory
  kernel, importable by every domain).
- **Inside `git/`,** bottom-up: `common/` (pure primitives: bytes, sha1, zlib,
  lru, errors, streams, paths, ref-name grammar, object codecs) → `diff/`
  (LGPL xdiff port, keeps its LICENSE and SPDX headers), `ignore/`,
  `protocol/` (wire only) → `store/` (SQLite: adapter, schema, table families,
  projections, maintenance) → `ops/` (command families, `repository.ts`,
  `worktree.ts`, `context.ts`) → `client.ts` (the public facade).
- **Dependency rules:** a slice imports only slices below it. `store/` never
  imports `ops/` — persisted formats (operation journals, index entries,
  capability contracts) are defined in `store/` and imported downward by
  `ops/`. Across domains: `git` and `shell` may depend on `fs`; `fs` depends
  on neither; `shell` never imports `git`.
- **The store exposes an explicit internal API** — exported functions and
  interfaces from `store/` modules that are not re-exported by the package —
  replacing WeakMap friend dispatch. Repo-scoped operations are owned by the
  shared store, never rebound to whichever checkout was constructed last.
- **Every source file stays at or under 2,000 lines.**
- **The rules are suite witnesses, not conventions:** a static import-graph
  test enforces the layer order and a file-ceiling test enforces the line
  limit. Public package exports (`kompjutr`, `/fs`, `/git`, `/shell`,
  `/compat/computer`) are unchanged by the move.

## Consequences

- The tree explains itself: three domains, and every further cut lives inside
  its domain. "What are ops, what is the store, what depends on what" is
  answered by the directory listing.
- The move itself is mechanical (`git mv` + import rewrites) but touches every
  Git-side import; it must land as its own commit with the public-export
  witness green.
- Resolving the store↔ops cycle relocates journal codecs and shared contracts
  into `store/`; the WeakMap dispatch removal is a behavior change covered by
  a regression test.
- New files start under the ceiling or the suite fails; `packs.ts`,
  `sparse-workspace.ts`, and `staging.ts` must be split.
- `git/diff/` remains a license boundary: LGPL-2.1-or-later code never moves
  into an unmarked directory.

## Alternatives considered

- **Keep the flat layout.** Rejected: it already failed to communicate the
  structure, and the measured coupling grew under it.
- **Split into workspace packages.** Rejected: publishing and tooling overhead
  without a consumer that needs separately versioned packages; directories
  plus witness tests give the same boundaries.
- **A softer file-size guideline.** Rejected: a guideline already existed
  implicitly and produced a 12,971-line file; only an enforced ceiling changes
  behavior.
