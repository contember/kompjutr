# backlog

Decided work items ("issues") not yet scheduled into a sprint. One self-contained
file per item: `NN-<slug>.md` (zero-padded, **folder-local** sequence — don't
renumber, gaps are fine). Copy [`_template.md`](_template.md).

**No `status:` field** — an item is alive because it lives here. It leaves by being
**deleted** on ship (default; git holds the record) or moved to `../archive/` if it
documents something a future reader needs. Dependencies go in frontmatter:
`blocked-by: [./NN-other.md]`.

Add scope sub-folders (`security/`, `perf/`, …) only once the flat list gets
unwieldy; numbers stay folder-local.

## Git parity tiers

Ranking of the gaps recorded in
[`../reference/git-support.md`](../reference/git-support.md). Tier is severity,
not effort: a wrong answer outranks a missing one.

- **S — silent divergence.** kompjutr returns a plausible result where Git
  returns a different one or refuses. Nothing warns the caller.
  [93](93-refuse-abort-over-unstaged-edits.md)
- **A — blocks a common workflow, loudly.** None filed.
- **B — real gap, narrower audience or a workaround exists.**
  [91](91-overwrite-ignored-untracked-files.md) ·
  [92](92-summarize-cli-commits-past-the-row-cap.md)
- **No caller yet.** Stash, plumbing reads, branch and remote management, glob
  pathspecs, rebase extensions, interactive rebase, rebase merges, gitlink
  conflicts, outbound delta compression and byte-preserving paths live in
  [`../ideas/`](../ideas/README.md). One graduates here when a consumer issues it.
- **C — deliberately out of scope.** Not filed: `bisect`, `blame`, `describe`,
  `shortlog`, `grep`, `archive`, `bundle`, `am`/`format-patch`, submodules,
  notes, hooks, signing, credential helpers, LFS, `.gitattributes` filters,
  config scopes, `clean -x`, SSH transport. Reopen a case for one only with a
  concrete workload behind it. Textual `apply` is not filed because local
  snapshot replay serves the current workload.

## Consumer demand

Two internal consumers define what "usable" means. Both run Git today as a
shell binary inside a container sandbox; kompjutr replaces that once the sandbox
is a Durable Object. Neither is wired to this package yet, so their call sites —
not this backlog — are the acceptance test. Their names stay out of this public
repository.

- **The agent-session orchestrator** — the
  [reference workload](../reference/git-support.md#the-reference-workload):
  clone, one checkout per session, a snapshot of uncommitted work after every
  agent turn, checkpoint refs mirrored to the remote, publish by fast-forward,
  rebase onto the trunk, restore after a sandbox loss. A second orchestrator
  issues a strict subset of the same calls (no checkpoints, no throwaway index).
- **The project builder** — a smaller shape: blobless clone by branch, `init`,
  `branch -m`, `add <path>`, `commit --allow-empty`, `remote remove` + `add`,
  `push origin <branch> [--force]`, and
  `ls-files --cached --others --exclude-standard -- '<dir>/*-<hash>.svg'`.

Coverage of the calls that decide whether Phase 1 is usable:

| Call | Issued by | Item |
|---|---|---|
| a full-history clone that later runs `merge-base`, `rebase`, `rev-list --count` | both | Served: optionless clone is complete, while explicit shallow clones can deepen and unshallow later |
| `branch -m`, `remote set-url` | both | Served by typed native operations; the rest is the [branch and remote management idea](../ideas/branch-and-remote-management.md) |
| `ls-files --cached --others --exclude-standard -- '<dir>/*-<hash>.svg'` | builder | Served by native cached/untracked selection and repository `.gitignore` filtering; mutating globs are the [glob pathspecs idea](../ideas/glob-pathspecs.md) |
| `clone --filter=blob:none` | both | Served by native filtered clone/fetch, durable promises, and bounded lazy backfill (ADR-0015) |
| `git status --porcelain \| wc -l`, `git log --oneline \| head`, `add` + `rebase --continue` — the agent inside the checkout, as shell commands | both (agent side) | Served by the strict awaitable runner, bounded per-run stdin/env, and the explicit `@kompjutr/do/git-shell` adapter |

Everything else both consumers issue is served, or routes through another
spelling listed under
[reference workload coverage](../reference/git-support.md#reference-workload-coverage).

## Sprint plan

The default sequencing at the current HEAD, not scheduling state — a sprint
exists once its file lands in [`../sprints/`](../sprints/). Every scheduled item
belongs to exactly one sprint.

**Phase 1** package work is complete. The real adapter now reruns its workflow as
the integration gate; everything after it is re-planned from that result.

The 2026-09-24 backlog review removed items that would re-add the machinery the
[simplification sprint](../archive/sprint-2026-09-23-simplification.md)
deleted: defences against unmeasured inputs, guards against API misuse, and
dedicated work toward the ADR-0005 statement *target*, which `bench:statements
--check` keeps reporting. An item here needs a reproduced defect, a measured
cost, or a removal.

| Order | Items | Why |
|---|---|---|
| 1 | [93](93-refuse-abort-over-unstaged-edits.md), [94](94-validate-the-rebase-committer-at-entry.md), [91](91-overwrite-ignored-untracked-files.md) | Reproduced correctness and parity defects; 93 loses user edits. |
| 2 | [66](66-retire-modeled-retained-byte-charges.md), [92](92-summarize-cli-commits-past-the-row-cap.md), [65](65-git-sqlite-architecture-review.md), [79](79-bound-materialized-status-and-config-reads.md) | Removals: modeled byte ledgers, the CLI summary cap, duplicate tables, twins and validators. |
| 3 | [84](84-read-integration-worktree-inputs-once.md), [95](95-reduce-the-nextjs-rebase-step-peak.md), [86](86-bound-sparse-selected-add-and-workerd-clone-peaks.md) | Measured repeated passes and memory peaks. |
| — | [64](64-speed-up-full-test-suite.md), [80](80-restore-import-graph-domain-guarantees.md) | Tooling. |

## Items

- [64 — Speed up the exhaustive test suite](64-speed-up-full-test-suite.md)
- [65 — Resolve verified Git SQLite architecture review findings](65-git-sqlite-architecture-review.md)
- [66 — Retire modeled retained-byte charges](66-retire-modeled-retained-byte-charges.md)
- [79 — Read scalar config values with one row](79-bound-materialized-status-and-config-reads.md)
- [80 — Restore peer and domain rules in the import-graph witness](80-restore-import-graph-domain-guarantees.md)
- [84 — Read integration worktree inputs once](84-read-integration-worktree-inputs-once.md)
- [86 — Bound the sparse-selected-add and Next.js clone memory peaks](86-bound-sparse-selected-add-and-workerd-clone-peaks.md)
- [91 — Overwrite ignored untracked files on checkout, merge and rebase](91-overwrite-ignored-untracked-files.md)
- [92 — Summarize a CLI commit that changes more than 50,000 files](92-summarize-cli-commits-past-the-row-cap.md)
- [93 — Refuse merge and replay abort over unstaged edits](93-refuse-abort-over-unstaged-edits.md)
- [94 — Validate the rebase committer option at the entry point](94-validate-the-rebase-committer-at-entry.md)
- [95 — Reduce the Next.js rebase step's full-tree passes and peak](95-reduce-the-nextjs-rebase-step-peak.md)
