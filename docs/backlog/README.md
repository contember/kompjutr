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
  [33](33-branch-delete-merged-check.md) ·
  [45](45-framing-safe-porcelain-output.md) ·
  [50](50-untracked-row-after-cached-removal.md) ·
  [51](51-relocate-distinct-type-conflicts.md) ·
  [52](52-default-ref-coverage-on-fetch-and-pull.md)
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

## Shell correctness and query shape

`kompjutr/shell` deliberately supports a bounded Bash-shaped subset. General
Bash features remain out of scope without a concrete workload; the items below
cover inputs the current surface already accepts or query shapes it already
claims to bound.

- **Silent correctness divergences:**
  [54](54-shell-and-or-lists.md),
  [55](55-stage-local-shell-redirections.md),
  [56](56-fail-closed-shell-path-expansion.md), and
  [60](60-truthful-shell-command-surface.md). These return a plausible wrong
  result or let an expected command error escape `RunResult`, so take them
  before adding commands or flags.
- **Missing set-based filesystem shapes:**
  [49](49-set-based-copy.md),
  [58](58-metadata-only-bulk-touch.md), and
  [59](59-set-based-shell-listing.md). They replace whole-tree retention,
  content rewrites, or per-row queries in existing commands.
- **Whole-pipeline safety boundary:**
  [57](57-bound-shell-retained-memory.md), after 49 and 56 remove their known
  materialization paths.

Recommended shell order: land 54 first because it is small and independent;
design 55's stage stream contract; close 56 before expanding path-oriented
commands; take 49, 58, and 59 independently; then finish 57 across every
remaining materializing stage. Execute 60 as small command-scoped corrections
behind one differential parity harness, not as one cross-module rewrite. Split
57 into retained-memory work units before scheduling it.

## Recommended Git implementation order

This is the default priority at the current HEAD, not scheduling state. Items in
the same phase may run in parallel, but a blocked item must not move ahead of its
blocker. Re-evaluate the order after each phase as production evidence arrives.

1. **Harden destructive maintenance:**
   [33](33-branch-delete-merged-check.md), then
   [04](04-repack-and-garbage-collection.md). Both now consume the bounded
   recovery and active-root contracts.
2. **Qualify the production runtime:** [10](10-worktree-wall-time.md),
   [11](11-production-do-regression-probe.md), and
   [16](16-concurrent-and-restart-conformance.md). Treat each as its own large
   work unit; the production probe is now unblocked by the verified CI/release
   seam.
3. **Close the reference-workload gaps.** These come from the only production
   workload documented end to end
   ([coverage](../reference/git-support.md#reference-workload-coverage)), so they
   are evidence rather than guesswork: [45](45-framing-safe-porcelain-output.md)
   first (it is tier S), then [43](43-index-and-object-write-plumbing.md) and
   [44](44-patch-interchange.md), then
   [42](42-remote-ref-discovery-and-refspec-fetch.md) with
   [08](08-extend-push-refspecs.md) (shared refspec type),
   [41](41-partial-clone.md) alongside [38](38-clone-depth-and-deepening.md)
   (both touch the clone contract).
4. **Add the highest-return daily workflows:**
   [28](28-pull-rebase.md),
   [35](35-staged-diff.md), [36](36-glob-pathspecs.md),
   [37](37-history-reads-patch-and-paths.md), [13](13-force-with-lease.md),
   [15](15-abortable-network-operations.md), and [06](06-stash-operations.md).
5. **Broaden management and diagnostic surfaces:**
   [18](18-branch-and-remote-management.md),
   [25](25-rebase-targets-and-roots.md),
   [39](39-plumbing-read-surface.md), [46](46-rev-parse-revision-syntax.md), and
   [17](17-integrity-audit-and-snapshots.md).
6. **Defer until a concrete workload justifies them:**
   [09](09-outbound-delta-compression.md), [26](26-interactive-rebase.md),
   [27](27-rebase-merges.md), and [29](29-rebase-update-refs.md).

Outside the phases: [50](50-untracked-row-after-cached-removal.md),
[51](51-relocate-distinct-type-conflicts.md),
[52](52-default-ref-coverage-on-fetch-and-pull.md) and
[53](53-record-undocumented-narrowings.md) are corrections rather than
capabilities — the end-to-end journeys caught them against the git binary. By
the tier rule above a wrong answer outranks a missing one, so take them early:
50 and 53 are small and independent, 51 wants the merge projection quiet around
it, and 52 needs a decision on whether its two narrowings are gaps or contracts
before it is work at all.

Before scheduling them, split 04, 16, 17, and 39 into smaller work units
with independent witnesses. Their current acceptance scopes are larger than one
focused sprint.

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
- [33 — Enforce the merged check on branch deletion](33-branch-delete-merged-check.md)
- [35 — Add a staged diff mode](35-staged-diff.md)
- [36 — Support glob pathspecs](36-glob-pathspecs.md)
- [37 — Complete history reads — patch output for `show`, path filter for `log`](37-history-reads-patch-and-paths.md)
- [38 — Align clone depth with Git and allow deepening](38-clone-depth-and-deepening.md)
- [39 — Complete the plumbing read surface](39-plumbing-read-surface.md)
- [41 — Add partial clone with lazy blob backfill](41-partial-clone.md)
- [42 — Add remote ref discovery and refspec fetch](42-remote-ref-discovery-and-refspec-fetch.md)
- [43 — Add index and object write plumbing](43-index-and-object-write-plumbing.md)
- [44 — Add patch interchange — apply, and appliable diff output](44-patch-interchange.md)
- [45 — Make porcelain output framing-safe](45-framing-safe-porcelain-output.md)
- [46 — Complete `rev-parse` revision syntax](46-rev-parse-revision-syntax.md)
- [49 — Copy a set of paths as one operation](49-set-based-copy.md)
- [50 — Report the untracked file a cached removal leaves behind](50-untracked-row-after-cached-removal.md)
- [51 — Relocate every distinct-type merge conflict, not only file/directory](51-relocate-distinct-type-conflicts.md)
- [52 — Match Git's default ref coverage on fetch and pull](52-default-ref-coverage-on-fetch-and-pull.md)
- [53 — Record the narrowings the Git support reference does not state](53-record-undocumented-narrowings.md)
- [54 — Execute shell AND-OR lists correctly](54-shell-and-or-lists.md)
- [55 — Make shell redirections stage-local](55-stage-local-shell-redirections.md)
- [56 — Fail closed on shell path-expansion limits](56-fail-closed-shell-path-expansion.md)
- [57 — Bound retained memory across shell pipelines](57-bound-shell-retained-memory.md)
- [58 — Add metadata-only bulk timestamp updates](58-metadata-only-bulk-touch.md)
- [59 — Make long and recursive shell listings set-based](59-set-based-shell-listing.md)
- [60 — Eliminate silently accepted shell command divergences](60-truthful-shell-command-surface.md)
