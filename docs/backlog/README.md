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
  [109](109-keep-parent-directory-when-replacing-its-only-child.md).
- **A — blocks a common workflow, loudly.**
  [108](108-local-checkout-removes-missing-paths.md).
- **B — real gap, narrower audience or a workaround exists.** None filed.
- **No caller yet.** Stash, plumbing reads, branch and remote management,
  rebase extensions, interactive rebase, rebase merges, gitlink
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
| `ls-files --cached --others --exclude-standard -- '<dir>/*-<hash>.svg'` | builder | Served by native cached/untracked selection and repository `.gitignore` filtering; default globs also select paths in add, rm, reset, checkout/restore, clean, status, and diff |
| `clone --filter=blob:none` | both | Served by native filtered clone/fetch, durable promises, and bounded lazy backfill (ADR-0015) |
| `git status --porcelain \| wc -l`, `git log --oneline \| head`, `add` + `rebase --continue` — the agent inside the checkout, as shell commands | both (agent side) | Served by the strict awaitable runner, bounded per-run stdin/env, and the explicit `@kompjutr/do/git-shell` adapter |

Everything else both consumers issue is served, or routes through another
spelling listed under
[reference workload coverage](../reference/git-support.md#reference-workload-coverage).

## Sprint plan

The default sequencing at the current HEAD, not scheduling state — a sprint
exists once its file lands in [`../sprints/`](../sprints/). Every scheduled item
belongs to exactly one sprint.

**Phase 1** package work is complete. The real adapter reruns its workflow as the
integration gate; everything after it is re-planned from that result. On
2026-09-24 it passed in-process against the scoped packages and found no
kompjutr defect or missing API.

The 2026-09-24 backlog review removed items that would re-add the machinery the
[simplification sprint](../archive/sprint-2026-09-23-simplification.md)
deleted: defences against unmeasured inputs, guards against API misuse, and
dedicated work toward the ADR-0005 statement *target*, which `bench:statements
--check` keeps reporting. An item here needs a reproduced defect, a measured
cost, or a removal.

The 2026-09-28 triage re-checked every item at `d8cf1f3`. It deleted 64 (the
full-suite runner already runs slices concurrently and reports timings), the 65
umbrella, and 98, 99, 102 and 103: what remained there were capability seams,
the `IndexStore` interface implementation, a finished audit, and look-alike SQL
over different reflog tables. It moved 84 and 105 to
[`../ideas/`](../ideas/README.md): neither has a failure behind it.

The 2026-09-28 [memory and cost sprint](../archive/sprint-2026-09-28-memory-and-cost.md)
closed 86, 95 and 97, and filed 106–109 from its findings. Its closure review
filed 110 (a bimodal sparse add peak), which is now closed: four allocation fixes
keep the peak at or below 75.4 MiB in ten runs at `25d07ea`.

| Order | Items | Why |
|---|---|---|
| 1 | [108](108-local-checkout-removes-missing-paths.md) | Tier A: local `reset --hard` fails with `ENOENT` when a tracked path is already gone. It blocks a common workflow. |
| 2 | [109](109-keep-parent-directory-when-replacing-its-only-child.md) | Tier S, but narrow: only a directory's mode changes when its only child changes type. |
| 3 | [107](107-bound-shared-integration-step-passes.md) | Cost: the shared integration step still makes full-tree passes for every rebase, merge, cherry-pick and revert step. |
| 4 | [106](106-reduce-the-workerd-clone-external-memory.md) | Memory: the workerd clone holds 4.5–7.7× its pack in V8 external memory. Attribute it first, then decide whether a production probe is needed. |

## Items

- [106 — Reduce the workerd clone's external memory](106-reduce-the-workerd-clone-external-memory.md)
- [107 — Bound the shared integration step's full-tree passes](107-bound-shared-integration-step-passes.md)
- [108 — Let local checkout remove paths that are already gone](108-local-checkout-removes-missing-paths.md)
- [109 — Keep a directory whose only child changes type](109-keep-parent-directory-when-replacing-its-only-child.md)
