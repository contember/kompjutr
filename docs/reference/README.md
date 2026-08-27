# reference

How the system works **now** — architecture, conventions, runbooks. Flat files,
`kebab-case.md`.

Rules (see [`../CLAUDE.md`](../CLAUDE.md)): describe the current state only — no
status updates, no TODOs (file those in `../backlog/`), no design rationale (that's
a `../decisions/` ADR). Update reference in the **same change** that alters
behaviour.

<!-- index the reference docs here, one line each -->

- [`architecture.md`](architecture.md) — runtime boundaries, storage model, invariants, and limits.
- [`benchmark-current.md`](benchmark-current.md) — current native Next.js workflow snapshot.
- [`git-support.md`](git-support.md) — per-command checklist of the supported Git surface and its options.
- [`oid-encoding-measurement.md`](oid-encoding-measurement.md) — reproducible TEXT-versus-BLOB OID evidence.
- [`production-probe.md`](production-probe.md) — authenticated production Durable Object probe runbook and current witness.
- [`release.md`](release.md) — CI gates, package smoke checks, and the tag-driven release process.
- [`shell.md`](shell.md) — supported shell model, semantics, and deliberate boundaries.
