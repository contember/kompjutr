# decisions (ADR)

One file per significant architectural/product decision: `NNNN-<slug>.md`
(monotonic, never reused). Copy [`_template.md`](_template.md).

**Immutable.** Once a decision is Accepted, don't rewrite it — to change course,
write a *new* ADR and set the old one's status to `Superseded by NNNN`.

Write one when the choice (a) constrains future work, (b) rejected a real
alternative, or (c) someone will later ask "why did we do it this way?". Otherwise
a commit message suffices.

## Log

<!-- newest last; one line each: NNNN — title — status (date) -->

- [0001 — Own the standalone SQLite runtime](0001-own-the-standalone-sqlite-runtime.md) — accepted (2026-08-20)
- [0002 — Compile shell commands to bounded queries](0002-compile-shell-commands-to-bounded-queries.md) — accepted (2026-08-21)
