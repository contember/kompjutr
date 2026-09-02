# ideas

Research, proposals, half-formed thoughts — **no commitment**. One file per idea,
`kebab-case.md`.

An idea has exactly two exits: it **graduates** (becomes a `../backlog/` item or
gets pulled into a `../sprints/` plan) or it's **deleted**. It is never a place for
decided work or status.

<!-- index the ideas here, one line each -->

- [`local-sqlite-git-runtime.md`](local-sqlite-git-runtime.md) — keep Git state
  in SQLite while materialising a local working tree on disk.
- [`git-server-inside-the-durable-object.md`](git-server-inside-the-durable-object.md)
  — answer Smart HTTP from the Durable Object so a `git` client can clone,
  fetch, and push against it.
- [`offload-large-objects-to-r2.md`](offload-large-objects-to-r2.md) — keep
  objects above the materialisation ceiling in R2 keyed by OID instead of
  refusing them at `add` and ingest.
- [`git-sqlite-architecture-review-triage.md`](git-sqlite-architecture-review-triage.md)
  — verify or dismiss the unresolved hypotheses from the 2026-09-02 storage
  architecture review before they enter the backlog.
