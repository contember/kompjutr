---
id: 31
title: Report unmerged paths in `status` and expose its full option set
blocked-by: []
---

# 31 — Report unmerged paths in `status` and expose its full option set

**Summary.** Tier S (silent divergence). During a conflict `status` reports a
plain modification, and the client facade cannot reach half of `StatusOptions`.

## Problem

`statusStream` skips every entry whose `stage !== 0`
(`src/core/ops/status.ts:213`, `:308`, `:368`), so a conflicted path is folded
into the stage-0 view and surfaces as `M`. Git reports `UU`, `AA`, `DD`, `AU`,
`UA`, `DU`, `UD` and emits `u` rows in porcelain v2. A caller inspecting a
conflicted repository therefore gets a plausible but wrong answer, and the only
reliable conflict signal today is `store.readOperationState()`.

Separately, `Git.status()` in `src/git/client.ts` accepts `dir` alone, so
`StatusOptions.paths`, `includeIgnored` and `untrackedFiles` — all implemented
in `src/core/ops/status-rows.ts` — are unreachable from the public client.

`StatusEntry` is a frozen seam shared with the Computer compatibility client,
so the code set has to grow compatibly rather than change shape.

## Approach / acceptance

- Extend the status row types with the unmerged code pairs and emit porcelain
  v2 `u` rows with the three stage oids; keep the existing `" " A M D` values
  valid for compatibility callers.
- Thread `paths`, `includeIgnored` and `untrackedFiles` through `Git.status()`
  and the compat client, keeping the merge-join cost model and the bounded
  retained-state cap.
- Add the `--branch` header rows (`# branch.oid`, `# branch.head`,
  `# branch.upstream`, `# branch.ab`) behind an explicit option.
- Real Git parity tests for every conflict shape produced by merge,
  cherry-pick, revert and rebase, plus path-filtered and `--ignored` runs.

## Touch points

`src/core/ops/status.ts`, `src/core/ops/status-rows.ts`, `src/core/ops/kinds.ts`,
`src/git/client.ts`, `src/compat/computer/client.ts`, `tests/status.test.ts`,
`docs/reference/git-support.md`
