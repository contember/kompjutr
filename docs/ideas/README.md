# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

- [`git-server-inside-the-durable-object.md`](git-server-inside-the-durable-object.md)
  — answer Smart HTTP from the Durable Object so a `git` client can clone,
  fetch, and push against it.
- [`local-git-compatible-binary.md`](local-git-compatible-binary.md)
  — wrap the local argv runner as a Git-compatible command, discover SQLite
  through `.git`, support linked-worktree pointers, and import existing repos.
- [`offload-large-objects-to-r2.md`](offload-large-objects-to-r2.md) — keep
  objects above the materialisation ceiling in R2 keyed by OID instead of
  refusing them at `add` and ingest.
- [`git-sqlite-architecture-review-triage.md`](git-sqlite-architecture-review-triage.md)
  — verify or dismiss the unresolved hypotheses from the 2026-09-02 storage
  architecture review before they enter the backlog.
- [`resolve-filesystem-paths-incrementally.md`](resolve-filesystem-paths-incrementally.md)
  — the filesystem path planner rebuilds every ancestor prefix, so one resolve
  costs `O(components²)`; a 1,000-component merge abort spends 8.6 s of 10 s there.
- Git parity without a caller — each graduates to `../backlog/` when a consumer
  issues it:
  [`stash-operations.md`](stash-operations.md) ·
  [`plumbing-read-surface.md`](plumbing-read-surface.md) ·
  [`branch-and-remote-management.md`](branch-and-remote-management.md) ·
  [`glob-pathspecs.md`](glob-pathspecs.md) ·
  [`rebase-targets-and-roots.md`](rebase-targets-and-roots.md) ·
  [`rebase-update-refs.md`](rebase-update-refs.md) ·
  [`interactive-rebase.md`](interactive-rebase.md) ·
  [`rebase-merges.md`](rebase-merges.md) ·
  [`materialize-gitlink-conflicts.md`](materialize-gitlink-conflicts.md) ·
  [`outbound-delta-compression.md`](outbound-delta-compression.md) ·
  [`byte-preserving-git-paths.md`](byte-preserving-git-paths.md).
