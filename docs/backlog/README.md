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
  [06](06-stash-operations.md) ·
  [18](18-branch-and-remote-management.md) ·
  [28](28-pull-rebase.md)
- **B — real gap, narrower audience or a workaround exists.**
  [08](08-extend-push-refspecs.md) ·
  [13](13-force-with-lease.md) ·
  [25](25-rebase-targets-and-roots.md) ·
  [26](26-interactive-rebase.md) ·
  [27](27-rebase-merges.md) ·
  [29](29-rebase-update-refs.md) ·
  [46](46-rev-parse-revision-syntax.md)
- **C — deliberately out of scope.** Not filed: `bisect`, `blame`, `describe`,
  `shortlog`, `grep`, `archive`, `bundle`, `am`/`format-patch`, submodules,
  notes, hooks, signing, credential helpers, LFS, `.gitattributes` filters,
  config scopes, `clean -x`, SSH transport. Reopen a case for one only with a
  concrete workload behind it. `apply` and `ls-remote` have concrete demand from
  the [reference workload](../reference/git-support.md#reference-workload-coverage)
  and are tracked in [44](44-patch-interchange.md) and
  [42](42-remote-ref-discovery-and-refspec-fetch.md).

## Sprint plan

The default sequencing at the current HEAD, not scheduling state — a sprint
exists once its file lands in [`../sprints/`](../sprints/). Every item belongs to
exactly one sprint. A sprint is *normal* (roughly four to six work units) or
*long* (roughly seven to ten); an item whose acceptance scope exceeds one work
unit is split at the WU level inside its own sprint, never across two. A blocked
item must not move ahead of its blocker. Re-evaluate after each sprint as
production evidence arrives.

| # | Sprint | Items | Length | Why here |
|---|---|---|---|---|
| — | Worktree performance and budget — **active** | 10, 54, 56, 57, 60, 61, 62 | — | Produces the release-candidate baseline sprint 2 measures, and the compiled matcher seam sprint 8 reuses. |
| 1 | Repack and garbage collection | [04](04-repack-and-garbage-collection.md) | long | Storage growth is unbounded in a long-lived repository. Destructive maintenance wants its own gate before anything builds on it. |
| 2 | Production Durable Object probe | [11](11-production-do-regression-probe.md) | normal | Consumes the active sprint's baseline while it is still current, and proves the performance claim in the real runtime rather than in Node. |
| 3 | Concurrency and restart conformance | [16](16-concurrent-and-restart-conformance.md) | long | Last piece of production qualification. Protects every later sprint and may introduce an operation epoch or lock. |
| 4 | Index and object write plumbing | [43](43-index-and-object-write-plumbing.md) | normal | First reference-workload gap: a scratch index plus `readTree`, `writeTree` and `commitTree` over the existing bounded tree builder. |
| 5 | Patch interchange | [44](44-patch-interchange.md) | long | Two halves — `--binary` and `--full-index` in the writer, then a new parser and `apply --3way` over the existing three-way engine. |
| 6 | Refspec transport | [42](42-remote-ref-discovery-and-refspec-fetch.md), [08](08-extend-push-refspecs.md) | long | Fetch and push share the refspec type and its validation, so one sprint defines it in a seam unit first. |
| 7 | Clone shape | [38](38-clone-depth-and-deepening.md), [41](41-partial-clone.md) | long | Both change the clone contract and both need an ADR. 41 additionally introduces a promisor object state every read path must honour. |
| 8 | Everyday reads and pathspecs | [35](35-staged-diff.md), [37](37-history-reads-patch-and-paths.md), [36](36-glob-pathspecs.md) | normal | 36 reuses the compiled matcher seam from the active sprint. 35 and 37 are read-only and add no storage. |
| 9 | Network safety and stash | [13](13-force-with-lease.md), [15](15-abortable-network-operations.md), [06](06-stash-operations.md) | long | 13 and 15 are both network-operation safety. 06 joins them because it reuses the same merge engine and operation journal. |
| 10 | Rebase extensions I | [25](25-rebase-targets-and-roots.md), [28](28-pull-rebase.md), [29](29-rebase-update-refs.md) | long | All three write to the planner and the lifecycle, so they cannot run in parallel. Sequential work units in one sprint is the correct shape. |
| 11 | Management and plumbing reads | [18](18-branch-and-remote-management.md), [46](46-rev-parse-revision-syntax.md), [39](39-plumbing-read-surface.md) | long | 39 decomposes into about seven small units; 18 and 46 fill the sprint. Nothing here adds storage. |
| 12 | Integrity audit and snapshots | [17](17-integrity-audit-and-snapshots.md) | long | Two units of work — a bounded audit and a versioned snapshot format. Follows 04 and 16, which settle what counts as authoritative. |
| 13 | Interactive rebase | [26](26-interactive-rebase.md) | long | Builds on the explicit targets from sprint 10. Bounded todo model plus the autosquash transform. |
| 14 | Rebase merge topology | [27](27-rebase-merges.md) | long | Hardest of the rebase family; last, because it needs the journal settled by sprints 10 and 13. |
| 15 | Gitlink conflicts | [58](58-materialize-gitlink-conflicts.md) | normal | No dependencies. Can move earlier into any slot that opens up. |
| 16 | Byte-preserving paths | [59](59-byte-preserving-git-paths.md) | long | Touches every path-bearing surface. Any earlier position would force each later sprint to migrate underneath it. |
| — | Unscheduled | [09](09-outbound-delta-compression.md) | — | Deferred until a concrete workload justifies it. |

Sprints 1 to 3 add no new Git capability; they are three sprints of runtime
investment. The one defensible reordering is to move sprint 4 ahead of sprint 1
— it is evidence-backed from the reference workload and touches nothing sprints
1 to 3 change.

Do not merge 26 and 27 into one sprint. They are two independent extra-large
units over the same files, and a long sprint does not make that safe.

## Items

- [04 — Add incremental repack and garbage collection](04-repack-and-garbage-collection.md)
- [06 — Implement stash operations](06-stash-operations.md)
- [08 — Extend push refspec support](08-extend-push-refspecs.md)
- [09 — Add outbound delta compression](09-outbound-delta-compression.md)
- [10 — Close worktree wall-time gaps](10-worktree-wall-time.md)
- [11 — Add a production Durable Object regression probe](11-production-do-regression-probe.md)
- [13 — Add force-with-lease push](13-force-with-lease.md)
- [15 — Make network operations abortable](15-abortable-network-operations.md)
- [16 — Verify concurrent and interrupted operations](16-concurrent-and-restart-conformance.md)
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
- [44 — Add patch interchange — apply, and appliable diff output](44-patch-interchange.md)
- [46 — Complete `rev-parse` revision syntax](46-rev-parse-revision-syntax.md)
- [54 — Prune ignored directories from the full status walk](54-prune-ignored-directories-in-status-walk.md)
- [56 — Move the index tracker baseline on commit](56-reseal-index-tracker-on-commit.md)
- [57 — Stream HEAD and the index once in the full status prepass](57-single-prepass-in-full-status.md)
- [58 — Materialize gitlink distinct-type conflicts](58-materialize-gitlink-conflicts.md)
- [59 — Add byte-preserving Git paths](59-byte-preserving-git-paths.md)
- [60 — Force-checkout benchmark phases measure a no-op](60-force-checkout-benchmark-measures-a-no-op.md)
- [61 — Bound `add` for explicit pathspecs](61-bounded-add-for-explicit-pathspecs.md)
- [62 — Reuse unchanged HEAD subtrees when commit builds its tree](62-reuse-head-subtrees-on-commit.md)
