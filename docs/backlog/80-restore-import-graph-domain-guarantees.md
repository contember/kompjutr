---
id: 80
title: Restore peer and domain rules in the import-graph witness
blocked-by: []
---

# 80 — Restore peer and domain rules in the import-graph witness

**Summary.** Restore an executable architecture guarantee weakened by the package
extraction. This is a test-coverage defect, not an observed production import bug.

## Problem and evidence

The import-graph test maps `diff`, `ignore`, and `protocol` to one `algorithm`
slice and accepts same-slice edges before checking ranks. Their independence is
still required by the Git module instructions.

Non-Git slices return null and bypass the internal-domain check. Package-level
rules therefore permit acyclic forbidden edges between DO database, filesystem,
shell, and runtime modules. The cycle test does not replace direction rules and
also excludes type-only edges.

The review independently compared the prior witness and confirmed the lost
checks. Inspected current source imports respect these boundaries. No runtime
failure or forbidden source edge is claimed.

## Approach / acceptance

- Keep distinct Git peer identities at equal rank and reject cross-peer imports.
- Restore DO internal-domain checks for relative and package-specifier imports,
  while preserving the accepted `git/do-fs` integration graph.
- Add small positive and negative fixtures proving both allowed downward edges
  and rejected peer/domain edges, including type-only dependencies.
- Preserve existing package/platform and cycle checks. Do not redesign runtime
  boundaries as part of repairing their witness.

## Touch points

- `tests/import-graph.test.ts`.
- `packages/git/src/CLAUDE.md`, `packages/do/src/fs/CLAUDE.md`,
  `packages/do/src/shell/CLAUDE.md` — existing rules to enforce.
