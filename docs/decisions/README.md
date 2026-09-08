# decisions (ADR)

One file per significant architectural or product decision: `NNNN-<slug>.md`
(monotonic, never reused). Copy [`_template.md`](_template.md).

**Living records.** An ADR describes the decision as it stands. When a decision
changes, rewrite the ADR in place to the new truth (git holds the history);
delete an ADR whose subject no longer exists. Keep numbers stable — other docs
reference them.

Write one when the choice (a) constrains future work, (b) rejected a real
alternative, or (c) someone will later ask "why did we do it this way?".
Otherwise a commit message suffices.

An ADR holds the *why*. When it needs a catalogue — an argv grammar, an error
code table, an ownership matrix — it links to `reference/` instead of copying it,
so the two cannot drift.

## Log

<!-- newest last; one line each: NNNN — title — status (date) -->

**Foundations**

- [0001 — Own the standalone SQLite runtime](0001-own-the-standalone-sqlite-runtime.md) — accepted (2026-08-20)
- [0002 — Organize source by domain with bottom-up layers](0002-organize-source-by-domain-with-bottom-up-layers.md) — accepted (2026-08-30)
- [0003 — Split the shared Git store from checkouts](0003-split-the-shared-git-store-from-checkouts.md) — accepted (2026-08-26)
- [0020 — Publish runtime boundaries as scoped packages](0020-publish-runtime-boundaries-as-scoped-packages.md) — accepted (2026-09-07)

**Cross-cutting invariants**

- [0004 — Trust stored rows and validate at the boundary](0004-trust-stored-rows-validate-at-the-boundary.md) — accepted (2026-08-30)
- [0005 — Bound real failures and measure cost](0005-bound-real-failures-and-measure-cost.md) — accepted (2026-08-29)
- [0006 — Own local Git mutations with SQLite transactions](0006-own-local-git-mutations-with-sqlite-transactions.md) — accepted (2026-09-02)
- [0007 — Require well-formed UTF-8 paths](0007-require-well-formed-utf8-paths.md) — accepted (2026-08-26)
- [0021 — Recover local worktree mutations with an undo journal](0021-recover-local-worktree-mutations-with-an-undo-journal.md) — accepted (2026-09-07)

**Storage**

- [0008 — Enforce SQLite foreign keys at the store boundary](0008-enforce-sqlite-foreign-keys-at-the-store-boundary.md) — accepted (2026-08-25)
- [0009 — Choose the persisted Git storage formats](0009-persisted-git-storage-formats.md) — accepted (2026-08-26)

**Git domain**

- [0010 — Port xdiff for text merge](0010-port-xdiff-for-text-merge.md) — accepted (2026-08-24)
- [0011 — Retain bounded deleted-ref history](0011-retain-bounded-deleted-ref-history.md) — accepted (2026-08-26)
- [0012 — Run maintenance as resumable generations](0012-run-maintenance-as-resumable-generations.md) — accepted (2026-08-27)
- [0013 — Publish clones through provisional ownership](0013-publish-clones-through-provisional-ownership.md) — accepted (2026-08-28)
- [0014 — Make an optionless clone complete](0014-make-an-optionless-clone-complete.md) — accepted (2026-08-28)
- [0015 — Model partial-clone blobs as durable promises](0015-model-partial-clone-blobs-as-durable-promises.md) — accepted (2026-08-31)

**Command surfaces**

- [0016 — Route Git argv through one asynchronous runner](0016-route-git-argv-through-one-asynchronous-runner.md) — accepted (2026-08-28)
- [0017 — Preflight mutating CLI output inside the transaction](0017-preflight-mutating-cli-output-inside-the-transaction.md) — accepted (2026-08-28)
- [0018 — Compile shell commands to bounded queries](0018-compile-shell-commands-to-bounded-queries.md) — accepted (2026-08-21)
- [0019 — Admit a bounded POSIX shell surface](0019-admit-a-bounded-posix-shell-surface.md) — accepted (2026-09-01)

## Renumbered on 2026-09-04

The set was rewritten against HEAD and renumbered once, before the first
production release. Numbers are stable again from here.

**A citation in `archive/` or `specs/` predates this table.** Those folders are
not edited after they are archived or frozen, so an old `ADR-NNNN` there means
the *old* number. Decode it here:

| Old | New | Note |
|---|---|---|
| 0001 | 0001 | |
| 0002 | 0018 | |
| 0003 | 0010 | |
| 0004 | 0008 | |
| 0005 | 0009 | merged |
| 0006 | 0009 | merged |
| 0007 | 0009 | merged |
| 0008 | 0011 | |
| 0009 | 0003 | |
| 0010 | 0007 | widened to both domains |
| 0011 | — | never existed |
| 0012 | 0012 | |
| 0013 | 0013 | |
| 0014 | 0014 | |
| 0015 | 0016 | |
| 0016 | 0017 | |
| 0017 | 0005 | rule narrowed to match the code |
| 0018 | 0004 | |
| 0019 | 0002 | |
| 0020 | 0015 | |
| 0021 | 0019 | |
| 0022 | 0006 | |
