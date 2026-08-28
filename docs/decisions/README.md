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
- [0003 — Port xdiff for text merge](0003-port-xdiff-text-merge.md) — accepted (2026-08-24)
- [0004 — Enforce SQLite foreign keys at the Git store boundary](0004-foreign-key-enforcement.md) — accepted (2026-08-25)
- [0005 — Keep persisted OIDs as hexadecimal text](0005-keep-oid-columns-as-text.md) — accepted (2026-08-25)
- [0006 — Keep content identities opaque and bound the Git blob cache](0006-keep-content-identities-opaque-and-bound-the-cache.md) — accepted (2026-08-26)
- [0007 — Key parsed trees by source surrogate](0007-key-parsed-trees-by-source-surrogate.md) — accepted (2026-08-26)
- [0008 — Retain bounded deleted-ref history](0008-retain-deleted-ref-history.md) — accepted (2026-08-26)
- [0009 — Split the shared Git store from checkouts](0009-split-shared-store-from-checkouts.md) — accepted (2026-08-26)
- [0010 — Require valid UTF-8 Git paths](0010-require-valid-utf8-git-paths.md) — accepted (2026-08-26)
- [0012 — Run maintenance as resumable generations](0012-run-maintenance-as-resumable-generations.md) — accepted (2026-08-27)
- [0013 — Publish clones through provisional ownership](0013-publish-clones-through-provisional-ownership.md) — accepted (2026-08-28)
- [0014 — Make an optionless clone complete](0014-default-clone-is-complete.md) — accepted (2026-08-28)
- [0015 — Route Git argv through one synchronous runner](0015-route-git-argv-through-one-synchronous-runner.md) — accepted (2026-08-28)
