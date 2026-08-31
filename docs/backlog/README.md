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
  returns a different one or refuses. Nothing warns the caller. No current item.
- **A — blocks a common workflow, loudly.** The call fails or the capability is
  absent; no data is at risk.
  [35](35-staged-diff.md) ·
  [37](37-history-reads-patch-and-paths.md) ·
  [38](38-clone-depth-and-deepening.md) ·
  [39](39-plumbing-read-surface.md) ·
  [06](06-stash-operations.md) ·
  [18](18-branch-and-remote-management.md) ·
  [28](28-pull-rebase.md)
- **B — real gap, narrower audience or a workaround exists.**
  [13](13-force-with-lease.md) ·
  [36](36-glob-pathspecs.md) ·
  [25](25-rebase-targets-and-roots.md) ·
  [26](26-interactive-rebase.md) ·
  [27](27-rebase-merges.md) ·
  [29](29-rebase-update-refs.md)
- **C — deliberately out of scope.** Not filed: `bisect`, `blame`, `describe`,
  `shortlog`, `grep`, `archive`, `bundle`, `am`/`format-patch`, submodules,
  notes, hooks, signing, credential helpers, LFS, `.gitattributes` filters,
  config scopes, `clean -x`, SSH transport. Reopen a case for one only with a
  concrete workload behind it. Textual `apply` is not filed because local
  snapshot replay serves the current workload.
- **Not a parity gap.** [63](63-bound-packed-dependency-graph-traversal.md)
  retains non-regression scaling found while closing the budget sprint.

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
| a full-history clone that later runs `merge-base`, `rebase`, `rev-list --count` | both | Served: optionless clone is complete; [38](38-clone-depth-and-deepening.md) now retains only explicit shallow deepening |
| `branch -m`, `remote set-url` | both | Served by typed native operations; [18](18-branch-and-remote-management.md) now retains only no-caller management |
| `ls-files --cached --others --exclude-standard -- '<dir>/*-<hash>.svg'` | builder | Served by native cached/untracked selection and repository `.gitignore` filtering; [36](36-glob-pathspecs.md) now retains mutating globs only |
| `clone --filter=blob:none` | both | Served by native filtered clone/fetch, durable promises, and bounded lazy backfill (ADR-0020) |
| `git status --porcelain \| wc -l`, `git log --oneline \| head`, `add` + `rebase --continue` — the agent inside the checkout, as shell commands | both (agent side) | Served by the strict synchronous runner, bounded per-run stdin/env, and the explicit `kompjutr/git/shell` adapter |

Everything else both consumers issue is served, or routes through another
spelling listed under
[reference workload coverage](../reference/git-support.md#reference-workload-coverage).

## Sprint plan

The default sequencing at the current HEAD, not scheduling state — a sprint
exists once its file lands in [`../sprints/`](../sprints/). Every scheduled item
belongs to exactly one sprint. A sprint is *normal* (roughly four to six work
units) or *long* (roughly seven to ten); an item whose acceptance scope exceeds
one work unit is split at the WU level inside its own sprint, never across two.
A blocked item must not move ahead of its blocker.

**Phase 1** package work is complete. The real adapter now reruns its workflow as
the integration gate. Everything below the gate is re-planned from that result.
**Phase 2** is production scale; partial clone shipped directly outside a sprint.
**Phase 3** is Git parity that no consumer issues; it stays filed and unscheduled
until a caller appears.

| # | Sprint | Items | Length | Why here |
|---|---|---|---|---|
| **Phase 1 — a consumer can run** | | | | |
| — | **Integration gate** | — | — | Not a sprint. Wire one consumer adapter (the adapter lives in the consumer) and run its real workflow end to end. Re-plan Phase 2 and 3 from the result. |
| **Phase 2 — production scale** | | | | |
| 1 | Deepening and network safety | [38](38-clone-depth-and-deepening.md) (deepen/unshallow), [13](13-force-with-lease.md), [15](15-abortable-network-operations.md) | long | Hardening after the transport contracts settle: cross a shallow boundary later, protect remote refs, cancel without leaving local state behind. |
| 2 | Integrity audit and snapshots | [17](17-integrity-audit-and-snapshots.md) | long | Audit the settled physical, shallow, and promisor storage shapes. |
| **Phase 3 — parity without a caller (unscheduled)** | | | | |
| — | Stash | [06](06-stash-operations.md) | normal | No consumer stashes; checkpoints cover "save and restore". |
| — | Everyday reads | [35](35-staged-diff.md), [37](37-history-reads-patch-and-paths.md) | long | Staged diff and log path filters; both consumers route through `diffSummary({ ref })` and `log` with a stop oid today. |
| — | Plumbing reads | [39](39-plumbing-read-surface.md) | normal | Type/size probes, tree/blob filters, ref enumeration, and general commit enumeration have no current caller. |
| — | Mutating glob pathspecs | [36](36-glob-pathspecs.md) | normal | Read selection is served; no consumer currently issues glob-shaped add/rm/reset/checkout/clean/diff/status mutations. |
| — | Rebase extensions | [25](25-rebase-targets-and-roots.md), [28](28-pull-rebase.md), [29](29-rebase-update-refs.md) | long | Both consumers issue `rebase <upstream>` and nothing else. |
| — | Interactive rebase | [26](26-interactive-rebase.md) | long | |
| — | Rebase merge topology | [27](27-rebase-merges.md) | long | |
| — | Branch and remote management, rest | [18](18-branch-and-remote-management.md) (rest) | normal | Upstream set/unset, remote rename, separate push URLs. |
| — | Gitlink conflicts, delta compression, byte paths | [58](58-materialize-gitlink-conflicts.md), [09](09-outbound-delta-compression.md), [59](59-byte-preserving-git-paths.md) | — | Fail closed today; widen only with a concrete workload. |

Do not merge 26 and 27 into one sprint. They are two independent extra-large
units over the same files, and a long sprint does not make that safe.

## Items

- [06 — Implement stash operations](06-stash-operations.md)
- [09 — Add outbound delta compression](09-outbound-delta-compression.md)
- [13 — Add force-with-lease push](13-force-with-lease.md)
- [15 — Make network operations abortable](15-abortable-network-operations.md)
- [17 — Add repository integrity audit and snapshots](17-integrity-audit-and-snapshots.md)
- [18 — Complete remaining branch and remote management](18-branch-and-remote-management.md)
- [25 — Add explicit rebase targets and roots](25-rebase-targets-and-roots.md)
- [26 — Add programmable interactive rebase](26-interactive-rebase.md)
- [27 — Replay merge topology during rebase](27-rebase-merges.md)
- [28 — Compose pull with native rebase](28-pull-rebase.md)
- [29 — Update dependent refs after rebase](29-rebase-update-refs.md)
- [35 — Add a staged diff mode](35-staged-diff.md)
- [36 — Add mutating glob pathspecs](36-glob-pathspecs.md)
- [37 — Complete history reads — patch output for `show`, path filter for `log`](37-history-reads-patch-and-paths.md)
- [38 — Deepen and unshallow repositories](38-clone-depth-and-deepening.md)
- [39 — Complete the remaining plumbing reads](39-plumbing-read-surface.md)
- [58 — Materialize gitlink distinct-type conflicts](58-materialize-gitlink-conflicts.md)
- [59 — Add byte-preserving Git paths](59-byte-preserving-git-paths.md)
- [63 — Bound packed dependency graph traversal](63-bound-packed-dependency-graph-traversal.md)
