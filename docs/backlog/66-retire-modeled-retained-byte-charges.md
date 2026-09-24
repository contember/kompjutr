---
id: 66
title: Retire the status and rm modeled byte charges
blocked-by: []
---

# 66 — Retire the status and rm modeled byte charges

**Summary.** Status and `rm` still charge a hand-computed estimate of a
JavaScript object's footprint against a byte ceiling. Replace each charge with
a structural cap that names the failure it prevents, or delete it where a cap
already bounds the structure.

## Problem

[ADR-0005](../decisions/0005-bound-real-failures-and-measure-cost.md) admits a
byte budget only when it charges bytes the operation actually holds. The push,
rename-detection and diff-summary charges were removed on 2026-09-24. Two sites
remain:

| Site | Modeled constants | Structural cap already present |
|---|---|---|
| `packages/git/src/ops/status/status-full.ts`, `status-clean.ts` | `SET_ENTRY_BYTES = 48` | **none** — `STATUS_RETAINED_BYTES` is the only bound on the tracked-path set |
| `packages/git/src/ops/staging/staging-rm.ts`, `staging-rm-worktree.ts` | `RM_CANDIDATE_FIXED_BYTES`, `RM_SPEC_FIXED_BYTES`, `RM_EXECUTION_HEADROOM_BYTES`, `RM_DIRECTORY_FIXED_BYTES`, `RM_ARRAY_ENTRY_BYTES`, and `structuralStringBytes` (`48 + len*2`) against `ADD_RETAINED_BYTES` (`staging-add-stage.ts`) | 50,000-row stream caps and a 10,000-pathspec cap; nobody has checked that these bound the directory set |

`RM_REMOVE_BINDING_BYTES` bounds a real JSON binding payload and stays.

## Approach / acceptance

**Status** needs a structural cap first — a path count naming the failure it
prevents — and the byte charge is removed only once the cap is in place and
witnessed. **`rm`**: confirm which count cap bounds each charged structure, add
one where none does, then delete the charges.

Acceptance: no `_BYTES` constant under `packages/git/src/ops/` stands for a
JavaScript object rather than real payload; the existing memory benchmark
scenarios stay under the sub-100 MiB target with the charges removed; status
and `rm` keep their refusal behaviour at the structural caps, witnessed by their
existing suites.

## Touch points

`packages/git/src/ops/status/status-full.ts`, `status-clean.ts`,
`packages/git/src/ops/staging/staging-rm*.ts`, `staging-add-stage.ts`, their
tests, and `docs/reference/architecture.md`.

<!-- Origin: the 2026-09-04 ADR rewrite, which found the ledger removal in ADR-0005 was only partial. -->
