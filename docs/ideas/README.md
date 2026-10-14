# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

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
  — canonical paths already use sliced prefixes; measure repeated prefix joins
  in the remaining noncanonical and symlink component walk.
- [`read-integration-worktree-inputs-once.md`](read-integration-worktree-inputs-once.md)
  — remeasure repeated content reads during conflicted integration; the old
  eight-read fixture overlaps the shared-pass work in backlog 107.
- [`shell-bounded-loops-and-arithmetic.md`](shell-bounded-loops-and-arithmetic.md)
  — `while read`, arithmetic expansion, bounded awk C-style `for`, and larger
  `jq` inputs, each waiting for a bound that names a real failure.
- [`measure-eager-status-result-memory.md`](measure-eager-status-result-memory.md)
  — `status()` materializes its whole result; measure it before deciding on an
  API or count boundary.
- Git parity without a caller — each graduates to `../backlog/` when a consumer
  issues it:
  [`stash-operations.md`](stash-operations.md) ·
  [`plumbing-read-surface.md`](plumbing-read-surface.md) ·
  [`branch-and-remote-management.md`](branch-and-remote-management.md) ·
  [`rebase-targets-and-roots.md`](rebase-targets-and-roots.md) ·
  [`rebase-update-refs.md`](rebase-update-refs.md) ·
  [`interactive-rebase.md`](interactive-rebase.md) ·
  [`rebase-merges.md`](rebase-merges.md) ·
  [`materialize-gitlink-conflicts.md`](materialize-gitlink-conflicts.md) ·
  [`outbound-delta-compression.md`](outbound-delta-compression.md) ·
  [`byte-preserving-git-paths.md`](byte-preserving-git-paths.md).
