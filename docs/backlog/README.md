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
  [36](36-glob-pathspecs.md) ·
  [37](37-history-reads-patch-and-paths.md) ·
  [38](38-clone-depth-and-deepening.md) ·
  [39](39-plumbing-read-surface.md) ·
  [41](41-partial-clone.md) ·
  [42](42-remote-ref-discovery-and-refspec-fetch.md) ·
  [43](43-index-and-object-write-plumbing.md) ·
  [44](44-patch-interchange.md) ·
  [46](46-rev-parse-revision-syntax.md) ·
  [06](06-stash-operations.md) ·
  [08](08-extend-push-refspecs.md) ·
  [18](18-branch-and-remote-management.md) ·
  [28](28-pull-rebase.md)
- **B — real gap, narrower audience or a workaround exists.**
  [13](13-force-with-lease.md) ·
  [25](25-rebase-targets-and-roots.md) ·
  [26](26-interactive-rebase.md) ·
  [27](27-rebase-merges.md) ·
  [29](29-rebase-update-refs.md)
- **C — deliberately out of scope.** Not filed: `bisect`, `blame`, `describe`,
  `shortlog`, `grep`, `archive`, `bundle`, `am`/`format-patch`, submodules,
  notes, hooks, signing, credential helpers, LFS, `.gitattributes` filters,
  config scopes, `clean -x`, SSH transport. Reopen a case for one only with a
  concrete workload behind it. `apply` and `ls-remote` have concrete demand from
  the [reference workload](../reference/git-support.md#reference-workload-coverage)
  and are tracked in [44](44-patch-interchange.md) and
  [42](42-remote-ref-discovery-and-refspec-fetch.md).
- **Not a parity gap.** [60](60-consolidate-limits-and-split-store.md) is
  cleanup: no new behaviour, no new surface.

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

What they issue that the surface still lacks, and the item that closes it:

| Call | Issued by | Item |
|---|---|---|
| `read-tree` / `write-tree` / `commit-tree` under a throwaway index | orchestrator | [43](43-index-and-object-write-plumbing.md) — active sprint |
| `diff --binary --full-index <snap>^1 <snap>` → `apply --3way --cached` → `write-tree` | orchestrator | [44](44-patch-interchange.md) — re-scoped to an index-only three-way replay; the patch format is deferred |
| `update-ref <ref> <new> <old>`, `merge-base`, `ls-tree -r` | orchestrator | [39](39-plumbing-read-surface.md) — required subset |
| `rev-parse <rev>^{tree}`, `<rev>^{commit}`, `<rev>:<path>`, `--verify --quiet` | orchestrator | [46](46-rev-parse-revision-syntax.md) |
| `ls-remote`, `fetch origin '+refs/checkpoints/*:refs/checkpoints/*'` | orchestrator | [42](42-remote-ref-discovery-and-refspec-fetch.md) |
| one atomic push of a branch plus a `refs/checkpoints/*` ref; batch delete of mirror refs | orchestrator | [08](08-extend-push-refspecs.md) |
| a full-history clone that later runs `merge-base`, `rebase`, `rev-list --count` | both | [38](38-clone-depth-and-deepening.md) — the default only; deepening is deferred |
| `branch -m`, `remote set-url` | both | [18](18-branch-and-remote-management.md) — required subset |
| `ls-files -- '<dir>/*-<hash>.svg'` | builder | [36](36-glob-pathspecs.md) |
| `clone --filter=blob:none` | both | [41](41-partial-clone.md) — scale, not a correctness gate; `depth: 0` serves the workflow today |

Everything else both consumers issue is served, or routes through another
spelling listed under
[reference workload coverage](../reference/git-support.md#reference-workload-coverage).

**Open decision, not filed.** Inside the sandbox the agent runs `git` as a
shell command — `status --short`, `add`, `commit -m`, `log`, `diff`,
`rebase --continue`. `cli()` throws `EUNSUPPORTED` and `kompjutr/shell` has no
Git command. Someone owns an argv-to-typed adapter for that subset — this
package or the consumer — before an agent can work inside a Durable Object
checkout. Decide before the integration gate; file it where it lands.

## Sprint plan

The default sequencing at the current HEAD, not scheduling state — a sprint
exists once its file lands in [`../sprints/`](../sprints/). Every scheduled item
belongs to exactly one sprint. A sprint is *normal* (roughly four to six work
units) or *long* (roughly seven to ten); an item whose acceptance scope exceeds
one work unit is split at the WU level inside its own sprint, never across two.
A blocked item must not move ahead of its blocker.

**Phase 1** closes every row of the table above and ends at an integration gate:
one consumer adapter runs its real workflow against the package, and everything
below the gate is re-planned from what that run finds. **Phase 2** is production
scale. **Phase 3** is Git parity that no consumer issues; it stays filed and
unscheduled until a caller appears.

| # | Sprint | Items | Length | Why here |
|---|---|---|---|---|
| **Phase 1 — a consumer can run** | | | | |
| 1 | Index and object write plumbing | [43](43-index-and-object-write-plumbing.md) | normal | Active. The snapshot of uncommitted work after every agent turn. |
| 2 | Snapshot replay and guarded refs | [44](44-patch-interchange.md), [39](39-plumbing-read-surface.md) (required subset), [46](46-rev-parse-revision-syntax.md) | normal | The rest of the checkpoint cycle: replay the snapshot tree onto the rebased tip through the scratch index from 43, publish the result with compare-and-swap, and resolve the peel and path spellings the probes use. |
| 3 | Refspec transport | [42](42-remote-ref-discovery-and-refspec-fetch.md), [08](08-extend-push-refspecs.md) | long | Checkpoint refs out (atomic multi-ref push, batch delete) and back in (`ls-remote`, wildcard fetch). One seam unit defines the refspec type for both. |
| 4 | First-contact defaults | [38](38-clone-depth-and-deepening.md) (default + ADR), [18](18-branch-and-remote-management.md) (required subset), [36](36-glob-pathspecs.md) | normal | Small items both consumers hit on first use: a full clone by default, `branch -m`, a glob pathspec for `lsFiles`. |
| — | **Integration gate** | — | — | Not a sprint. Wire one consumer adapter (the adapter lives in the consumer) and run its real workflow end to end. Re-plan Phase 2 and 3 from the result. |
| **Cleanup** | | | | |
| 5 | Limits and store consolidation | [60](60-consolidate-limits-and-split-store.md) | long | Before Phase 2 adds a promisor state to every read path: derive per-operation limits from the two global budgets, split `store.ts` by table family, change no behaviour. |
| **Phase 2 — production scale** | | | | |
| 6 | Partial clone | [41](41-partial-clone.md) | long | Blobless clone is what both consumers run today. Needs an ADR and a promisor object state that every read path honours. |
| 7 | Deepening and network safety | [38](38-clone-depth-and-deepening.md) (deepen/unshallow), [13](13-force-with-lease.md), [15](15-abortable-network-operations.md) | long | Hardening after the transport contracts settle: cross a shallow boundary later, protect remote refs, cancel without leaving local state behind. |
| 8 | Integrity audit and snapshots | [17](17-integrity-audit-and-snapshots.md) | long | After 41 settles the storage shapes it audits. |
| **Phase 3 — parity without a caller (unscheduled)** | | | | |
| — | Stash | [06](06-stash-operations.md) | normal | No consumer stashes; checkpoints cover "save and restore". |
| — | Everyday reads | [35](35-staged-diff.md), [37](37-history-reads-patch-and-paths.md) | long | Staged diff and log path filters; both consumers route through `diffSummary({ ref })` and `log` with a stop oid today. |
| — | Rebase extensions | [25](25-rebase-targets-and-roots.md), [28](28-pull-rebase.md), [29](29-rebase-update-refs.md) | long | Both consumers issue `rebase <upstream>` and nothing else. |
| — | Interactive rebase | [26](26-interactive-rebase.md) | long | |
| — | Rebase merge topology | [27](27-rebase-merges.md) | long | |
| — | Branch and remote management, rest | [18](18-branch-and-remote-management.md) (rest) | normal | Upstream set/unset, remote rename, separate push URLs. |
| — | Gitlink conflicts, delta compression, byte paths | [58](58-materialize-gitlink-conflicts.md), [09](09-outbound-delta-compression.md), [59](59-byte-preserving-git-paths.md) | — | Fail closed today; widen only with a concrete workload. |

Do not merge 26 and 27 into one sprint. They are two independent extra-large
units over the same files, and a long sprint does not make that safe.

## Items

- [06 — Implement stash operations](06-stash-operations.md)
- [08 — Extend push refspec support](08-extend-push-refspecs.md)
- [09 — Add outbound delta compression](09-outbound-delta-compression.md)
- [13 — Add force-with-lease push](13-force-with-lease.md)
- [15 — Make network operations abortable](15-abortable-network-operations.md)
- [17 — Add repository integrity audit and snapshots](17-integrity-audit-and-snapshots.md)
- [18 — Complete branch and remote management](18-branch-and-remote-management.md)
- [25 — Add explicit rebase targets and roots](25-rebase-targets-and-roots.md)
- [26 — Add programmable interactive rebase](26-interactive-rebase.md)
- [27 — Replay merge topology during rebase](27-rebase-merges.md)
- [28 — Compose pull with native rebase](28-pull-rebase.md)
- [29 — Update dependent refs after rebase](29-rebase-update-refs.md)
- [35 — Add a staged diff mode](35-staged-diff.md)
- [36 — Support glob pathspecs](36-glob-pathspecs.md)
- [37 — Complete history reads — patch output for `show`, path filter for `log`](37-history-reads-patch-and-paths.md)
- [38 — Align clone depth with Git and allow deepening](38-clone-depth-and-deepening.md)
- [39 — Complete the plumbing read surface](39-plumbing-read-surface.md)
- [41 — Add partial clone with lazy blob backfill](41-partial-clone.md)
- [42 — Add remote ref discovery and refspec fetch](42-remote-ref-discovery-and-refspec-fetch.md)
- [43 — Add index and object write plumbing](43-index-and-object-write-plumbing.md)
- [44 — Replay a snapshot onto a new tip; patch interchange deferred](44-patch-interchange.md)
- [46 — Complete `rev-parse` revision syntax](46-rev-parse-revision-syntax.md)
- [58 — Materialize gitlink distinct-type conflicts](58-materialize-gitlink-conflicts.md)
- [59 — Add byte-preserving Git paths](59-byte-preserving-git-paths.md)
- [60 — Consolidate operation limits and split the store](60-consolidate-limits-and-split-store.md)
