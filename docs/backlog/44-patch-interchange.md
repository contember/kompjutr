---
id: 44
title: Replay a snapshot onto a new tip — index-only three-way; patch interchange deferred
blocked-by: []
---

# 44 — Replay a snapshot onto a new tip

**Summary.** Tier A. The orchestrator moves uncommitted work onto a rebased
tip. Its shell spelling is a patch round-trip; here the same result is one
tree-level three-way replay through a scratch index. The textual patch half is
deferred until a patch has to cross a process boundary.

## Problem

The reference workload's checkpoint cycle ends with:

```sh
git diff --binary --full-index <snap>^1 <snap> > patch
GIT_INDEX_FILE=tmp git read-tree <newTip>
GIT_INDEX_FILE=tmp git apply --3way --cached patch
GIT_INDEX_FILE=tmp git write-tree                 # -> merged tree
git read-tree --reset -u <merged tree>
```

Every input is already an object in the same store: the snapshot commit
`<snap>`, its first parent, and the new tip. The patch file exists only because
a shell has no other way to carry a tree delta between two commands. kompjutr
has no such boundary, and it already has the bounded three-way engine
(`src/core/ops/integration.ts`, `src/core/ops/merge-apply.ts`,
[ADR-0003](../decisions/0003-port-xdiff-text-merge.md)) and, after
the shipped [index and object write plumbing sprint](../archive/sprint-2026-08-28-index-and-object-write-plumbing.md),
a scratch index that `readTree` seeds and `writeTree` serialises.

The earlier scope of this item — `--binary` and `--full-index` in the patch
writer plus a patch parser and `apply()` — reproduced the shell's transport,
not the workload's need. It is kept below as deferred scope.

## Approach / acceptance

- Add one operation over the scratch index from 43: seed the index from
  `<newTip>`, integrate `base = <snap>^1` and `theirs = <snap>` through the
  existing three-way engine with index-only output, and return the merged tree
  oid. No worktree write; the caller applies the tree with
  `readTree({ update: true })` or commits it with `commitTree`.
- A conflict reports index stages 1–3 exactly as `merge()` does, so resolution
  has one shape. Whether a conflicted scratch index can outlive the callback
  follows 43's scoping rule; if it cannot, the operation returns the conflict
  set and writes nothing.
- Gitlink entries have no three-way meaning here (the orchestrator probes for
  them first with `ls-tree -r`, see [39](39-plumbing-read-surface.md)); fail
  closed with a stable code.
- Bound source rows, plan entries, blob reads and SQL under the existing
  integration limits; a replay past a limit writes nothing.
- Real Git parity: the same `<snap>^1` / `<snap>` / `<newTip>` triple through
  real `git apply --3way --cached` and through kompjutr yields the same tree
  oid for clean text, binary, mode, rename, add and delete cases, and the same
  conflict set otherwise.

## Deferred — textual patch interchange

Needed only once a patch must leave the process: a human, another repository,
a file on disk. Filed here so it is not lost; do not schedule it without such a
caller.

- `--binary` (Git's literal/delta base85 form) and `--full-index` in the patch
  writer. Acceptance is external: real `git apply` accepts the output for text,
  binary, rename, mode change, new file and deleted file.
- A bounded patch parser and `apply()` with three-way and index-only modes over
  the same engine. Bound patch bytes, file count and hunk count; a patch past a
  limit is refused before anything is written. A `Subproject commit` hunk fails
  closed with its own code.

## Touch points

`src/core/ops/plumbing.ts`, `src/core/ops/integration.ts`,
`src/core/ops/merge-apply.ts`, `src/git/client.ts`,
`tests/plumbing-write.test.ts`, `tests/merge-apply.test.ts`,
`tests/git-upstream-parity.test.ts`, `docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage; re-scoped 2026-08-28 from the orchestrator's call sites -->
